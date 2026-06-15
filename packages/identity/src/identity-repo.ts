import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  AgentStatus,
  AuditEvent,
  CapabilityProfile,
  Delegation,
  IdentityBinding,
  IdentityBindingState,
  Platform,
  RbacRole,
  ServiceUser,
  Tier,
} from '@tasca/domain';

/** A pool or a single checked-out connection — both expose `.query`. */
export type Queryable = Pool | PoolClient;

export interface NewAgentInput {
  name: string;
  model: string;
  vendor?: string;
  avatarUrl?: string;
  status?: AgentStatus;
  rbacRoleId?: string;
  humanOfRecordUserId?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  avatarUrl: string | null;
  vendor: string;
  model: string;
  /** Instructions/definition (Anthropic agent.md markdown). Threaded into the run as the
   *  agent's `--append-system-prompt` persona by coordination's dispatch path (issue 362). */
  description: string | null;
  status: AgentStatus;
  rbacRoleId: string | null;
  humanOfRecordUserId: string | null;
  version: number;
}

/** What an agent looks like with its anchoring service-user, freshly created. */
export interface CreatedAgent {
  agent: AgentRecord;
  serviceUser: ServiceUser;
}

/**
 * Outcome of a versioned agent write (pause/resume/edit-profile). Optimistic
 * concurrency rides the agent row's `version`: a write that presents a stale
 * version loses to whoever bumped it first and learns the `currentVersion` so the
 * UI can reconcile to truth instead of silently overwriting. `ok` carries the new
 * version; `not_found` → 404; `version_conflict` → 409 (the caller re-reads truth).
 */
export type AgentWriteOutcome =
  | { ok: true; version: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number };

/** The editable slice of a capability profile (the agent-edit form). The tier-range and specialty
 *  fields are OPTIONAL: when omitted the existing values are preserved (so callers that only edit
 *  the original three keep working unchanged). Specialties are validated against the @tasca/domain
 *  taxonomy at the API boundary before they reach here.
 *
 *  The identity fields (name/vendor/model/avatarUrl/description) are also OPTIONAL and edited under
 *  the SAME agent-version CAS, atomically with the capability columns. Preserve-if-absent: an omitted
 *  field is left unchanged. The NOT-NULL columns (name/vendor/model) can only be set, never cleared;
 *  the nullable ones (avatarUrl/description) accept an explicit null/'' to CLEAR vs omission to preserve.
 *  `description` is the agent's instructions/definition (agent.md markdown) — threaded into the run
 *  as the agent's `--append-system-prompt` persona by coordination's dispatch path (issue 362). */
export interface CapabilityProfilePatch {
  maxTier: CapabilityProfile['maxTier'];
  concurrencyLimit: number | null;
  costCeiling: number | null;
  tiersCovered?: CapabilityProfile['tiersCovered'];
  languageSpecialties?: string[];
  frameworkSpecialties?: string[];
  name?: string;
  vendor?: 'claude' | 'openai' | 'local';
  model?: string;
  avatarUrl?: string | null;
  description?: string | null;
}

/**
 * Read-side projection: an agent joined to its capability profile. The profile
 * is `null` when none has been set yet (so the UI shows an honest empty/"—"
 * rather than fabricated capability numbers).
 */
export interface AgentWithProfile {
  agent: AgentRecord;
  profile: CapabilityProfile | null;
}

export interface BindIdentityInput {
  agentId: string;
  platform: Platform;
  externalId: string;
  externalHandle?: string;
  /** Pointer into the secret store — never the secret. Per-binding. */
  credentialRef?: string;
  state?: IdentityBindingState;
}

/**
 * Raw-`pg` repository for the agent-identity primitive — mirrors the
 * PgClaimRepository style (constructor takes a pool or single connection; plain
 * SQL; rows mapped to domain types).
 *
 * Boundary: this package imports ONLY @tasca/domain (+ pg). No routing, no
 * adapters, no coordination, no execution / native build.
 */
export class PgIdentityRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Run `fn` inside a single transaction, passing it a repository scoped to the
   * transaction's connection. Use this to make a multi-write flow atomic — e.g.
   * a binding write + its audit append must commit together or not at all, so a
   * credential change can never land without its audit row.
   *
   *   - If `this.db` is a Pool, check out a client, BEGIN, run
   *     `fn(new PgIdentityRepository(client))`, COMMIT (ROLLBACK + rethrow on
   *     error), and always release the client.
   *   - If `this.db` is already a PoolClient, we are nested inside a caller's
   *     transaction: just `return fn(this)` and reuse that transaction (no
   *     nested BEGIN/COMMIT — the outermost call owns the boundary).
   */
  async withTransaction<T>(fn: (repo: PgIdentityRepository) => Promise<T>): Promise<T> {
    if (!isPool(this.db)) {
      // Already inside a transaction (PoolClient) — reuse the caller's tx.
      return fn(this);
    }
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgIdentityRepository(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Create an agent together with its 1:1 service_user, generating a stable
   * internal `principal_id`. The agent starts with an EMPTY identity-binding set
   * — bindings are attached later per platform (see bindShortcutIdentity()).
   *
   * The two inserts are wrapped in a transaction so an agent can never exist
   * without its anchoring principal.
   */
  async createAgent(input: NewAgentInput): Promise<CreatedAgent> {
    const agentId = randomUUID();
    const serviceUserId = randomUUID();
    // The stable internal principal. Generated once, never rotated, independent
    // of any external platform credential.
    const principalId = `prn_${randomUUID()}`;

    const ownsTx = isPool(this.db);
    const client: Queryable = ownsTx ? await (this.db as Pool).connect() : this.db;
    try {
      if (ownsTx) await client.query('BEGIN');
      const agentRes = await client.query<AgentRow>(
        `INSERT INTO agent (id, name, avatar_url, vendor, model, status, rbac_role_id, human_of_record_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, name, avatar_url, vendor, model, description, status, rbac_role_id, human_of_record_user_id, version`,
        [
          agentId,
          input.name,
          input.avatarUrl ?? null,
          input.vendor ?? 'claude',
          input.model,
          input.status ?? 'active',
          input.rbacRoleId ?? null,
          input.humanOfRecordUserId ?? null,
        ]
      );
      await client.query(
        `INSERT INTO service_user (id, agent_id, principal_id) VALUES ($1,$2,$3)`,
        [serviceUserId, agentId, principalId]
      );
      if (ownsTx) await client.query('COMMIT');

      return {
        agent: mapAgent(agentRes.rows[0]!),
        serviceUser: { id: serviceUserId, agentId, principalId },
      };
    } catch (err) {
      if (ownsTx) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (ownsTx) (client as PoolClient).release();
    }
  }

  /**
   * Read-side: list agents joined to their capability profile, ordered by name.
   * `status` filters the roster (default: all). This is the read API's agent
   * source — query-only, projects existing columns, invents nothing.
   */
  async listAgentsWithProfiles(status?: AgentStatus): Promise<AgentWithProfile[]> {
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE a.status = $1`;
    }
    const res = await this.db.query<AgentWithProfileRow>(
      `SELECT a.id, a.name, a.avatar_url, a.vendor, a.model, a.description, a.status,
              a.rbac_role_id, a.human_of_record_user_id, a.version,
              cp.max_tier, cp.tiers_covered, cp.language_specialties, cp.framework_specialties,
              cp.concurrency_limit, cp.cost_ceiling, cp.avg_latency_ms, cp.success_rate
         FROM agent a
         LEFT JOIN capability_profile cp ON cp.agent_id = a.id
         ${where}
        ORDER BY a.name ASC, a.id ASC`,
      params
    );
    return res.rows.map(mapAgentWithProfile);
  }

  /** Read-side: a single agent joined to its capability profile, or null. */
  async getAgentWithProfile(agentId: string): Promise<AgentWithProfile | null> {
    const res = await this.db.query<AgentWithProfileRow>(
      `SELECT a.id, a.name, a.avatar_url, a.vendor, a.model, a.description, a.status,
              a.rbac_role_id, a.human_of_record_user_id, a.version,
              cp.max_tier, cp.tiers_covered, cp.language_specialties, cp.framework_specialties,
              cp.concurrency_limit, cp.cost_ceiling, cp.avg_latency_ms, cp.success_rate
         FROM agent a
         LEFT JOIN capability_profile cp ON cp.agent_id = a.id
        WHERE a.id = $1`,
      [agentId]
    );
    const row = res.rows[0];
    return row ? mapAgentWithProfile(row) : null;
  }

  async getServiceUser(agentId: string): Promise<ServiceUser | null> {
    const res = await this.db.query<{ id: string; agent_id: string; principal_id: string }>(
      `SELECT id, agent_id, principal_id FROM service_user WHERE agent_id = $1`,
      [agentId]
    );
    const row = res.rows[0];
    return row ? { id: row.id, agentId: row.agent_id, principalId: row.principal_id } : null;
  }

  // ── RBAC roles ──────────────────────────────────────────────────────────────

  async upsertRole(role: RbacRole): Promise<RbacRole> {
    await this.db.query(
      `INSERT INTO rbac_role (id, name, permissions, downstream_scopes)
       VALUES ($1,$2,$3::jsonb,$4::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             permissions = EXCLUDED.permissions,
             downstream_scopes = EXCLUDED.downstream_scopes`,
      [role.id, role.name, JSON.stringify(role.permissions), JSON.stringify(role.downstreamScopes)]
    );
    return role;
  }

  // ── Capability profile ───────────────────────────────────────────────────────

  async setCapabilityProfile(profile: CapabilityProfile): Promise<void> {
    await this.db.query(
      `INSERT INTO capability_profile
         (agent_id, max_tier, tiers_covered, language_specialties, framework_specialties,
          concurrency_limit, cost_ceiling, avg_latency_ms, success_rate, updated_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9, now())
       ON CONFLICT (agent_id) DO UPDATE SET
         max_tier = EXCLUDED.max_tier,
         tiers_covered = EXCLUDED.tiers_covered,
         language_specialties = EXCLUDED.language_specialties,
         framework_specialties = EXCLUDED.framework_specialties,
         concurrency_limit = EXCLUDED.concurrency_limit,
         cost_ceiling = EXCLUDED.cost_ceiling,
         avg_latency_ms = EXCLUDED.avg_latency_ms,
         success_rate = EXCLUDED.success_rate,
         updated_at = now()`,
      [
        profile.agentId,
        profile.maxTier,
        JSON.stringify(profile.tiersCovered),
        JSON.stringify(profile.languageSpecialties),
        JSON.stringify(profile.frameworkSpecialties),
        profile.concurrencyLimit,
        profile.costCeiling,
        profile.avgLatencyMs,
        profile.successRate,
      ]
    );
  }

  async getCapabilityProfile(agentId: string): Promise<CapabilityProfile | null> {
    const res = await this.db.query<CapabilityProfileRow>(
      `SELECT agent_id, max_tier, tiers_covered, language_specialties, framework_specialties,
              concurrency_limit, cost_ceiling, avg_latency_ms, success_rate
         FROM capability_profile WHERE agent_id = $1`,
      [agentId]
    );
    const row = res.rows[0];
    return row ? mapCapabilityProfile(row) : null;
  }

  /** Resolve why a versioned write matched no row: missing agent vs stale version. */
  private async agentWriteMiss(agentId: string): Promise<AgentWriteOutcome> {
    const cur = await this.db.query<{ version: number }>(
      `SELECT version FROM agent WHERE id = $1`,
      [agentId]
    );
    if (cur.rowCount === 0) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'version_conflict', currentVersion: cur.rows[0]!.version };
  }

  /**
   * Set an agent's lifecycle status (pause/resume/retire) under optimistic
   * concurrency: the UPDATE only applies at the expected `version` and bumps it, so
   * a concurrent writer's stale attempt loses and gets `version_conflict`.
   */
  async setAgentStatus(
    agentId: string,
    status: AgentStatus,
    expectedVersion: number
  ): Promise<AgentWriteOutcome> {
    const res = await this.db.query<{ version: number }>(
      `UPDATE agent SET status = $2, version = version + 1
        WHERE id = $1 AND version = $3
      RETURNING version`,
      [agentId, status, expectedVersion]
    );
    if (res.rowCount === 1) return { ok: true, version: res.rows[0]!.version };
    return this.agentWriteMiss(agentId);
  }

  /**
   * Edit the agent's capability profile under optimistic concurrency. Atomic: the
   * agent-row version CAS and the profile update commit together (or neither), so a
   * stale edit never half-applies. `version_conflict` when someone edited first.
   */
  async updateCapabilityProfile(
    agentId: string,
    patch: CapabilityProfilePatch,
    expectedVersion: number
  ): Promise<AgentWriteOutcome> {
    return this.withTransaction(async (repo) => {
      // The agent-row UPDATE carries BOTH the version CAS and the editable identity columns, so a
      // stale version touches neither the agent row nor (below) the profile. Preserve-if-absent:
      //   - name/vendor/model are NOT NULL → COALESCE($n, col): an omitted field passes null and is
      //     preserved (they can never be cleared).
      //   - avatar_url/description are nullable → a provided-FLAG distinguishes "set/clear" from
      //     "preserve": CASE WHEN $flag THEN $value ELSE col END. $flag = (patch.X !== undefined),
      //     $value = patch.X ?? null, so a present null/'' clears while omission preserves.
      const cas = await repo.db.query<{ version: number }>(
        `UPDATE agent SET
           version = version + 1,
           name = COALESCE($3, name),
           vendor = COALESCE($4, vendor),
           model = COALESCE($5, model),
           avatar_url = CASE WHEN $6 THEN $7 ELSE avatar_url END,
           description = CASE WHEN $8 THEN $9 ELSE description END
         WHERE id = $1 AND version = $2 RETURNING version`,
        [
          agentId,
          expectedVersion,
          patch.name ?? null,
          patch.vendor ?? null,
          patch.model ?? null,
          patch.avatarUrl !== undefined,
          patch.avatarUrl ?? null,
          patch.description !== undefined,
          patch.description ?? null,
        ]
      );
      if (cas.rowCount !== 1) return repo.agentWriteMiss(agentId);
      // UPSERT, not UPDATE: an agent can exist with no capability_profile row yet
      // (createAgent doesn't seed one; the read path LEFT JOINs and shows "—"). A
      // plain UPDATE would silently match 0 rows and let us report a FALSE success —
      // a write that lies. The upsert makes the edit always land. concurrency_limit
      // is NOT NULL (default 1) → COALESCE a null patch to the existing value (or 1
      // on insert); cost_ceiling is nullable (NULL = "no cap", read back as 0).
      // tiers_covered / language_specialties / framework_specialties are jsonb. A null param means
      // "not edited" → COALESCE keeps the existing value (or the '[]' default on insert), so the
      // three original fields can still be edited alone without wiping specialties.
      const tiersCovered = patch.tiersCovered === undefined ? null : JSON.stringify(patch.tiersCovered);
      const languages = patch.languageSpecialties === undefined ? null : JSON.stringify(patch.languageSpecialties);
      const frameworks = patch.frameworkSpecialties === undefined ? null : JSON.stringify(patch.frameworkSpecialties);
      await repo.db.query(
        `INSERT INTO capability_profile
           (agent_id, max_tier, tiers_covered, language_specialties, framework_specialties, concurrency_limit, cost_ceiling, updated_at)
         VALUES ($1, $2, COALESCE($5::jsonb, '[]'::jsonb), COALESCE($6::jsonb, '[]'::jsonb), COALESCE($7::jsonb, '[]'::jsonb), COALESCE($3, 1), $4, now())
         ON CONFLICT (agent_id) DO UPDATE SET
           max_tier = $2,
           tiers_covered = COALESCE($5::jsonb, capability_profile.tiers_covered),
           language_specialties = COALESCE($6::jsonb, capability_profile.language_specialties),
           framework_specialties = COALESCE($7::jsonb, capability_profile.framework_specialties),
           concurrency_limit = COALESCE($3, capability_profile.concurrency_limit),
           cost_ceiling = $4,
           updated_at = now()`,
        [agentId, patch.maxTier, patch.concurrencyLimit, patch.costCeiling, tiersCovered, languages, frameworks]
      );
      return { ok: true, version: cas.rows[0]!.version };
    });
  }

  // ── Identity bindings (per-platform CRUD) ────────────────────────────────────

  /**
   * Create or replace the agent's binding for a platform. `(agent_id, platform)`
   * is unique, so re-binding the same platform overwrites the previous row's
   * external id/handle/credential_ref/state. Note: this is on the `agent`/
   * `binding` side only — the `service_user.principal_id` is untouched.
   */
  async upsertBinding(input: BindIdentityInput): Promise<IdentityBinding> {
    const id = randomUUID();
    const res = await this.db.query<IdentityBindingRow>(
      `INSERT INTO identity_binding
         (id, agent_id, platform, external_id, external_handle, credential_ref, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, platform) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         external_handle = EXCLUDED.external_handle,
         credential_ref = EXCLUDED.credential_ref,
         state = EXCLUDED.state
       RETURNING id, agent_id, platform, external_id, external_handle, credential_ref, state`,
      [
        id,
        input.agentId,
        input.platform,
        input.externalId,
        input.externalHandle ?? null,
        input.credentialRef ?? null,
        input.state ?? 'provisioned',
      ]
    );
    return mapBinding(res.rows[0]!);
  }

  async listBindings(agentId: string): Promise<IdentityBinding[]> {
    const res = await this.db.query<IdentityBindingRow>(
      `SELECT id, agent_id, platform, external_id, external_handle, credential_ref, state
         FROM identity_binding WHERE agent_id = $1 ORDER BY platform`,
      [agentId]
    );
    return res.rows.map(mapBinding);
  }

  /**
   * Lock the binding row for `(agentId, platform)` with `SELECT … FOR UPDATE`,
   * returning it (or null if none exists). Only meaningful INSIDE a transaction
   * (call via `withTransaction`): the row lock is held until the surrounding tx
   * commits/rolls back, so concurrent rotations serialize on it — the second
   * rotation blocks until the first commits, then proceeds on the updated row.
   * Outside a transaction the lock is released immediately and buys nothing.
   */
  async lockBinding(agentId: string, platform: Platform): Promise<IdentityBinding | null> {
    const res = await this.db.query<IdentityBindingRow>(
      `SELECT id, agent_id, platform, external_id, external_handle, credential_ref, state
         FROM identity_binding WHERE agent_id = $1 AND platform = $2
         FOR UPDATE`,
      [agentId, platform]
    );
    const row = res.rows[0];
    return row ? mapBinding(row) : null;
  }

  async getBinding(agentId: string, platform: Platform): Promise<IdentityBinding | null> {
    const res = await this.db.query<IdentityBindingRow>(
      `SELECT id, agent_id, platform, external_id, external_handle, credential_ref, state
         FROM identity_binding WHERE agent_id = $1 AND platform = $2`,
      [agentId, platform]
    );
    const row = res.rows[0];
    return row ? mapBinding(row) : null;
  }

  /**
   * Find the ACTIVE binding for a platform's external id, if any. The UNIQUE
   * constraint is (agent_id, platform), NOT (platform, external_id), so the same
   * external account *could* be bound to two agents — callers (e.g. provisioning)
   * use this to detect/prevent that ambiguity and to make re-provisioning
   * idempotent on the external account rather than on a remembered agent id.
   */
  async getActiveBindingByExternalId(
    platform: Platform,
    externalId: string
  ): Promise<IdentityBinding | null> {
    const res = await this.db.query<IdentityBindingRow>(
      `SELECT id, agent_id, platform, external_id, external_handle, credential_ref, state
         FROM identity_binding
        WHERE platform = $1 AND external_id = $2 AND state = 'active'
        LIMIT 1`,
      [platform, externalId]
    );
    const row = res.rows[0];
    return row ? mapBinding(row) : null;
  }

  /**
   * Rotate ONLY the per-binding `credential_ref` (and optionally state) for a
   * platform. This is the external-credential rotation seam: the secret pointer
   * changes, the agent's stable `principal_id` does not. Returns the updated
   * binding, or null if no binding exists for that platform.
   */
  async rotateCredentialRef(
    agentId: string,
    platform: Platform,
    newCredentialRef: string,
    state?: IdentityBindingState
  ): Promise<IdentityBinding | null> {
    const res = await this.db.query<IdentityBindingRow>(
      `UPDATE identity_binding
          SET credential_ref = $3,
              state = COALESCE($4, state)
        WHERE agent_id = $1 AND platform = $2
      RETURNING id, agent_id, platform, external_id, external_handle, credential_ref, state`,
      [agentId, platform, newCredentialRef, state ?? null]
    );
    const row = res.rows[0];
    return row ? mapBinding(row) : null;
  }

  async revokeBinding(agentId: string, platform: Platform): Promise<void> {
    await this.db.query(
      `UPDATE identity_binding SET state = 'revoked' WHERE agent_id = $1 AND platform = $2`,
      [agentId, platform]
    );
  }

  // ── Delegation ───────────────────────────────────────────────────────────────

  async setDelegation(delegation: Delegation): Promise<void> {
    await this.db.query(
      `INSERT INTO delegation (agent_id, on_behalf_of_user_id, attribution_label)
       VALUES ($1,$2,$3)
       ON CONFLICT (agent_id) DO UPDATE SET
         on_behalf_of_user_id = EXCLUDED.on_behalf_of_user_id,
         attribution_label = EXCLUDED.attribution_label`,
      [delegation.agentId, delegation.onBehalfOfUserId, delegation.attributionLabel]
    );
  }

  /**
   * Read the agent's delegation (human-of-record + attribution label), or null
   * when none is set. The write-back reporter uses `attributionLabel` as the
   * operator-configured attribution trailer on the issue comment.
   */
  async getDelegation(agentId: string): Promise<Delegation | null> {
    const res = await this.db.query<DelegationRow>(
      `SELECT agent_id, on_behalf_of_user_id, attribution_label
         FROM delegation WHERE agent_id = $1`,
      [agentId]
    );
    const row = res.rows[0];
    return row
      ? {
          agentId: row.agent_id,
          onBehalfOfUserId: row.on_behalf_of_user_id,
          attributionLabel: row.attribution_label,
        }
      : null;
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

  /**
   * Append a privileged-action record. Attribution is to the stable
   * `principalId`, never to an external credential — so the audit trail stays
   * continuous across token rotation.
   */
  async appendAuditEvent(input: {
    principalId: string;
    agentId: string;
    action: string;
    target?: string;
    platform?: Platform;
    payload?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    const id = randomUUID();
    const res = await this.db.query<AuditEventRow>(
      `INSERT INTO audit_event (id, principal_id, agent_id, action, target, platform, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING id, principal_id, agent_id, action, target, platform, payload, at`,
      [
        id,
        input.principalId,
        input.agentId,
        input.action,
        input.target ?? null,
        input.platform ?? null,
        JSON.stringify(input.payload ?? {}),
      ]
    );
    return mapAuditEvent(res.rows[0]!);
  }

  async listAuditEvents(principalId: string): Promise<AuditEvent[]> {
    const res = await this.db.query<AuditEventRow>(
      `SELECT id, principal_id, agent_id, action, target, platform, payload, at
         FROM audit_event WHERE principal_id = $1 ORDER BY at ASC, id ASC`,
      [principalId]
    );
    return res.rows.map(mapAuditEvent);
  }
}

// ── Row mappers ────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  name: string;
  avatar_url: string | null;
  vendor: string;
  model: string;
  description: string | null;
  status: string;
  rbac_role_id: string | null;
  human_of_record_user_id: string | null;
  version: number;
}

interface CapabilityProfileRow {
  agent_id: string;
  max_tier: string;
  tiers_covered: Tier[];
  language_specialties: string[];
  framework_specialties: string[];
  concurrency_limit: number;
  cost_ceiling: string | number | null;
  avg_latency_ms: number | null;
  success_rate: string | number | null;
}

interface IdentityBindingRow {
  id: string;
  agent_id: string;
  platform: string;
  external_id: string;
  external_handle: string | null;
  credential_ref: string | null;
  state: string;
}

interface DelegationRow {
  agent_id: string;
  on_behalf_of_user_id: string;
  attribution_label: string;
}

interface AuditEventRow {
  id: string;
  principal_id: string;
  agent_id: string;
  action: string;
  target: string | null;
  platform: string | null;
  payload: Record<string, unknown>;
  at: Date;
}

function isPool(db: Queryable): db is Pool {
  // Discriminate by `release()`: a checked-out PoolClient has it, a Pool does not.
  // (`connect()` is NOT a valid discriminator — pg's PoolClient is a Client, which
  // also exposes connect(), so the old check misclassified a client as a Pool and
  // broke the nested-tx reuse branch.) Used to decide tx ownership.
  return typeof (db as { release?: unknown }).release !== 'function';
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar_url,
    vendor: row.vendor,
    model: row.model,
    description: row.description,
    status: row.status as AgentStatus,
    rbacRoleId: row.rbac_role_id,
    humanOfRecordUserId: row.human_of_record_user_id,
    version: row.version,
  };
}

/** `numeric` comes back from pg as a string; coerce to number (null-safe). */
function toNum(v: string | number | null): number | null {
  return v === null ? null : typeof v === 'number' ? v : Number(v);
}

function mapCapabilityProfile(row: CapabilityProfileRow): CapabilityProfile {
  return {
    agentId: row.agent_id,
    maxTier: row.max_tier as Tier,
    tiersCovered: row.tiers_covered,
    languageSpecialties: row.language_specialties,
    frameworkSpecialties: row.framework_specialties,
    concurrencyLimit: row.concurrency_limit,
    costCeiling: toNum(row.cost_ceiling) ?? 0,
    avgLatencyMs: row.avg_latency_ms,
    successRate: toNum(row.success_rate),
  };
}

interface AgentWithProfileRow extends AgentRow {
  // capability_profile columns (all nullable via the LEFT JOIN)
  max_tier: string | null;
  tiers_covered: Tier[] | null;
  language_specialties: string[] | null;
  framework_specialties: string[] | null;
  concurrency_limit: number | null;
  cost_ceiling: string | number | null;
  avg_latency_ms: number | null;
  success_rate: string | number | null;
}

function mapAgentWithProfile(row: AgentWithProfileRow): AgentWithProfile {
  const profile: CapabilityProfile | null =
    row.max_tier === null
      ? null
      : {
          agentId: row.id,
          maxTier: row.max_tier as Tier,
          tiersCovered: row.tiers_covered ?? [],
          languageSpecialties: row.language_specialties ?? [],
          frameworkSpecialties: row.framework_specialties ?? [],
          concurrencyLimit: row.concurrency_limit ?? 0,
          costCeiling: toNum(row.cost_ceiling) ?? 0,
          avgLatencyMs: row.avg_latency_ms,
          successRate: toNum(row.success_rate),
        };
  return { agent: mapAgent(row), profile };
}

function mapBinding(row: IdentityBindingRow): IdentityBinding {
  return {
    id: row.id,
    agentId: row.agent_id,
    platform: row.platform as Platform,
    externalId: row.external_id,
    externalHandle: row.external_handle,
    credentialRef: row.credential_ref,
    state: row.state as IdentityBindingState,
  };
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    principalId: row.principal_id,
    agentId: row.agent_id,
    action: row.action,
    target: row.target,
    platform: row.platform as Platform | null,
    payload: row.payload,
    at: row.at,
  };
}
