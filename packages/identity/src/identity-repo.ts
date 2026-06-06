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
         RETURNING id, name, avatar_url, vendor, model, status, rbac_role_id, human_of_record_user_id, version`,
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
  // PoolClient has no `connect()`; Pool does. Used to decide tx ownership.
  return typeof (db as Pool).connect === 'function';
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: row.avatar_url,
    vendor: row.vendor,
    model: row.model,
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
