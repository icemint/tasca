// The composition root (scaffold §1.3: coordination is the only package that may
// import everything). createCoordination wires the PROVEN concrete impls — the
// Postgres store, the routing CAS repo, an identity-backed agent directory +
// audit sink, and the execution port — and leaves the ADAPTER seams
// (StatusReporter, WebhookVerifier) and the classifier as injected dependencies,
// because @tasca/adapters is built on a sibling branch and wired in LATER.

import type { Pool } from 'pg';
import { PgClaimRepository, PgDispatchQueue } from '@tasca/db';
import { PgIdentityRepository } from '@tasca/identity';
import type { ExecutionPort } from '@tasca/execution';
import type { Task } from '@tasca/domain';
import { DefaultPmProposer, type LlmClassifierPort } from '@tasca/routing';
import { AnthropicChat, AnthropicClassifier, AnthropicEmReviewer, LATEST_ANTHROPIC_MODEL } from '@tasca/llm';
import { serveAnthropicProxy, type AgentUsageSink } from '@tasca/anthropic-proxy';
import { makeUsageSink } from './usage-context';
import { PgCoordinationStore } from './store';
import { PgOrgMembershipRepo } from './membership';
import { PgGitHubInstallStateRepo, type InstallAccountResolver } from './github-connect';
import { VendorKeyResolver, ManagerCredentialResolver, type VendorValidator, type AgentCredentialResolver, type ConnectionCredentialResolver } from './vendor-credential';
import { makeEmReviewGate } from './em-review-gate';
import type { ShortcutWriteBack } from './shortcut-status-reporter';
import { PgOrgRosterRepo, type OrgRosterRepo } from './roster';
import { PgAgentCreator } from './agent-creator';
import type { StatusReporter, WebhookVerifier, Logger } from './ports';
import type { AgentDirectory, AuditSink, TaskContentSource, RepoProvisioner } from './orchestrate';
import { createCoordinationServer, type CoordinationServerDeps } from './server';
import { makeReaper, type Reaper } from './reaper';
import type { SessionInfo } from './read-api';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Concrete dependencies the host supplies at the composition root. The Postgres
 * pool and execution port are real; status/verifier are the adapter seams (real
 * Shortcut adapter wired here later); content + classifier are platform-specific.
 */
export interface CreateCoordinationDeps {
  pool: Pool;
  execution: ExecutionPort;
  status: StatusReporter;
  verifier: WebhookVerifier;
  /** Optional GitHub webhook verifier (POST /webhooks/github); absent → 404. */
  githubVerifier?: WebhookVerifier;
  /** Optional GitHub install-event handler (records account→installation); absent → not called. */
  githubInstallationHandler?: (rawBody: string) => Promise<void>;
  /** Optional GitHub PR-merge handler (auto-advances the linked task to `done`); absent → not called. */
  githubMergeHandler?: (rawBody: string) => Promise<void>;
  /** Optional auth handler (GET/POST /api/auth/*); absent → those paths 404. */
  authHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  content: TaskContentSource;
  /** Coordination LLM (BYOK, slice 3.5-A.2a). When `enabled` AND the vault master key is present, the
   *  routing tier classifier resolves each org's OWN vault key per task and runs on it (no server key);
   *  absent/disabled → heuristic routing. `model` defaults to the current Haiku id. */
  coordinationLlm?: { enabled: boolean; model?: string };
  /** Optional repo provisioner (clone-on-dispatch); absent → repoRef used as-is. */
  provisioner?: RepoProvisioner;
  /** Enable split dispatch: enqueue jobs for an agent-runner (no in-process fallback —
   *  if no runner claims, the task is retired to needs_attention). Default OFF (always
   *  in-process, the no-queue/dev mode) until runners are deployed. */
  dispatchQueueEnabled?: boolean;
  /** BYOK vendor credentials (slice 3.5-A): the env-held master key (null → write surface 503s) + the
   *  validate-on-input probe. Absent → the credential API is not wired. */
  vendorCredential?: { masterKey: Buffer | null; validator: VendorValidator };
  /** Per-agent platform identity (slice SC-3): the env-held master key (null → the set surface 503s).
   *  Wires POST /api/orgs/:orgId/agents/:agentId/identity/shortcut and shares the AgentCredentialResolver
   *  the host's Shortcut status reporter reads (so a set busts the reporter's cache on this node).
   *  Absent → the agent-identity API is not wired. */
  agentCredential?: { masterKey: Buffer | null; resolver: AgentCredentialResolver };
  /** Per-connection secrets (slice SC-1): the env-held master key (null → the set surface 503s) + the
   *  shared ConnectionCredentialResolver. Wires POST /api/orgs/:orgId/connections/shortcut (admin-gated,
   *  write-only set of a workspace→project binding + its sealed secrets) AND the connection-scoped
   *  webhook route POST /webhooks/shortcut/:connectionId (which resolves the connection's webhook secret
   *  via the same resolver, so a set busts its cache here). `registeredShortcutIds` is the boot-time
   *  Shortcut binding snapshot the per-request verifier uses. Absent → neither surface is wired. */
  connectionCredential?: {
    masterKey: Buffer | null;
    resolver: ConnectionCredentialResolver;
    registeredShortcutIds: ReadonlySet<string>;
  };
  /** Engineering Manager admin API (EM v1 slice 1): the env-held master key (null → the identity/seal
   *  surface 503s). Wires POST /api/orgs/:orgId/managers, .../managers/:managerId/identity/shortcut,
   *  .../projects/:projectId/manager (all admin-gated; the identity route is write-only). Absent → the
   *  manager API is not wired. Gated on the same master-key presence as the other credential surfaces. */
  managerCredential?: { masterKey: Buffer | null };
  /**
   * The EM (Engineering Manager) requirements gate (EM v1 slice 2). When `enabled` AND the vault master
   * key is present, the orchestration loop runs a pre-dispatch clarity review: the EM for the task's
   * project LLM-judges whether a story is clear enough to build, posting clarifying questions AS ITSELF
   * (via `shortcut.postStoryComment`, under its own vault token) and parking the task when not. FAIL-OPEN
   * by construction — no manager / no key / LLM error all skip the review and proceed. `model` defaults
   * to the latest Anthropic model (LATEST_ANTHROPIC_MODEL). Absent / disabled / no master key → no gate.
   */
  emGate?: { enabled: boolean; model?: string; shortcut: ShortcutWriteBack; masterKey: Buffer | null };
  /** Window to wait (polling) for a runner to claim before retiring the task to
   *  needs_attention. Default 30000ms. */
  runnerWaitMs?: number;
  /** Poll interval while waiting for a runner claim. Default 500ms. */
  runnerPollMs?: number;
  breakerThreshold?: number;
  perProjectLimit?: number;
  agentTimeoutMs?: number;
  /** Structured logger for post-ack failures; defaults to `console` in the server. */
  logger?: Logger;
  /**
   * Optional session verifier for the read-only app API. Injected by the host when
   * the Auth track is wired; absent → the read API allows in non-prod and fails
   * closed in prod (coordination never hard-depends on @tasca/auth).
   */
  verifySession?: (req: IncomingMessage) => Promise<SessionInfo | null> | SessionInfo | null;
  /**
   * GitHub connect (slice 5c): the App bits the connect callback needs — the App client (to resolve
   * an installation's account) + the App slug (for the install URL). Injected by the host only when
   * the GitHub App env is present. Absent → the connect routes are not wired (404).
   */
  githubConnect?: { appClient: InstallAccountResolver; appSlug: string };
  /** PM-assistant (slice W3-S1): when true, the assistant view renders its on-state and proposal
   *  GENERATION is allowed; default false (off-state first, per the design). Listing/accepting/
   *  dismissing existing proposals is unaffected by the flag. */
  pmAssistantEnabled?: boolean;
  /** Single-tenant edition (slice 3.5-B.1): when true the org-multiplicity routes (list/create/switch
   *  org) 404. Set from singleTenantEnabled() at the host; default false (multi-tenant). */
  singleTenant?: boolean;
  /** Org invites (slice 3.5-B.3.1): the app origin the accept link is built against (the OAuth redirect
   *  base / app origin). Absent → the invite API is not wired (those paths 404). */
  inviteAcceptBaseUrl?: string;
}

/**
 * An AgentDirectory backed by @tasca/identity capability profiles, scoped to the org's ROSTER
 * (slice 5d). listCandidates returns ONLY the agents the org has hired (org_agent) — a global agent
 * the org hasn't hired is structurally absent, so routing can never pick it. The activeCount / live
 * state default to idle/0 (the routing functions take them as inputs; the host can refine later).
 */
class IdentityAgentDirectory implements AgentDirectory {
  constructor(
    private readonly identity: PgIdentityRepository,
    private readonly roster: OrgRosterRepo
  ) {}

  async listCandidates(orgId: string, _task: Task) {
    const out = [];
    for (const agentId of await this.roster.hiredAgentIds(orgId)) {
      const profile = await this.identity.getCapabilityProfile(agentId);
      if (!profile) continue;
      out.push({ profile, state: 'idle' as const, activeCount: 0 });
    }
    return out;
  }

  async findHiredAgentByName(orgId: string, name: string): Promise<string | null> {
    return this.roster.findHiredAgentByName(orgId, name);
  }

  async principalIdFor(agentId: string): Promise<string | null> {
    const su = await this.identity.getServiceUser(agentId);
    return su?.principalId ?? null;
  }
}

/** An AuditSink backed by the @tasca/identity append-only audit trail. */
class IdentityAuditSink implements AuditSink {
  constructor(private readonly identity: PgIdentityRepository) {}
  async record(input: {
    principalId: string;
    agentId: string;
    action: string;
    target?: string;
    platform?: 'shortcut' | 'github' | 'linear';
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.identity.appendAuditEvent({
      principalId: input.principalId,
      agentId: input.agentId,
      action: input.action,
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
  }
}

export interface Coordination {
  /** The assembled deps, ready to drive orchestration or the HTTP server. */
  deps: CoordinationServerDeps;
  /** Create (not start) the node:http server bound to these deps. */
  createServer(): ReturnType<typeof createCoordinationServer>;
  /** The split-dispatch reaper — present ONLY when the dispatch queue is enabled. The
   *  host starts/stops it: it finalizes runner-completed jobs + sweeps dead claims. */
  reaper?: Reaper;
}

/**
 * Wire the coordination root. The host registers which agents are on the roster
 * (`agentIds`) so the directory can surface their profiles; everything else is
 * assembled from the proven packages.
 */
export function createCoordination(
  input: CreateCoordinationDeps & { agentIds: string[] }
): Coordination {
  const store = new PgCoordinationStore(input.pool);
  const claim = new PgClaimRepository(input.pool);
  // The membership repo (slice 4 + 5a). Backs resolveOrg (the active org → tenant boundary) AND the
  // org-management API (list/create/switch + the login-time ensurePersonalOrg).
  const membership = new PgOrgMembershipRepo(input.pool);
  // The org roster (slice 5d): which agents each org has hired. Backs the org-scoped routing
  // candidate filter AND the hire/unhire API.
  const roster = new PgOrgRosterRepo(input.pool);
  const identity = new PgIdentityRepository(input.pool);
  const directory = new IdentityAgentDirectory(identity, roster);
  const audit = new IdentityAuditSink(identity);
  // One queue instance shared by the dispatch path (enqueue/cancel) and the reaper
  // (sweep/finalize) so they operate on the same table wiring.
  const dispatchQueue = input.dispatchQueueEnabled ? new PgDispatchQueue(input.pool) : undefined;

  // BYOK (slice 3.5-A): one shared resolver — decrypts an org's (= the instance's) vault key for the
  // credential API (cache-bust) AND the per-org classifier below. Built only when the master key is set.
  const vendorResolver = input.vendorCredential
    ? new VendorKeyResolver(store, input.vendorCredential.masterKey)
    : undefined;
  // BYOK classifier (slice 3.5-A.2a): the tier classifier resolves the org's OWN vault key per task and
  // runs on it — NO server key. No key → null → heuristic routing. Enabled by the coordination-LLM flag
  // AND the presence of a resolver (master key). The usage sink meters each call (org-scoped, per-task).
  const coordinationUsageSink = makeUsageSink(store, input.logger);
  const coordinationModel = input.coordinationLlm?.model ?? 'claude-haiku-4-5-20251001';
  const classifierFor =
    input.coordinationLlm?.enabled && vendorResolver
      ? async (orgId: string): Promise<LlmClassifierPort | null> => {
          const key = await vendorResolver.resolve(orgId, 'anthropic');
          if (!key) return null;
          return new AnthropicClassifier(new AnthropicChat({ apiKey: key, model: coordinationModel }), coordinationUsageSink);
        }
      : undefined;

  // The EM (Engineering Manager) requirements gate (EM v1 slice 2). Wired only when enabled AND a vendor
  // resolver exists (the vault master key is set): both the org vault key (the EM's LLM) and the manager's
  // Shortcut token (to post AS the EM) need the master key. The gate is FAIL-OPEN by construction — no
  // manager / no key / LLM error all skip the review and proceed; it never blocks dispatch. The EM runs on
  // the LATEST Anthropic model (deliberately stronger than the classifier's Haiku); its spend meters as
  // source='manager' via the shared coordination usage sink (the gate sets the ambient usage context).
  const emReviewGate =
    input.emGate?.enabled && vendorResolver
      ? makeEmReviewGate({
          store,
          managerCredentials: new ManagerCredentialResolver(store, input.emGate.masterKey),
          vendorKeyFor: (orgId: string) => vendorResolver.resolve(orgId, 'anthropic'),
          reviewerFor: (apiKey: string) =>
            new AnthropicEmReviewer(
              new AnthropicChat({ apiKey, model: input.emGate!.model ?? LATEST_ANTHROPIC_MODEL }),
              coordinationUsageSink
            ),
          shortcut: input.emGate.shortcut,
          ...(input.logger !== undefined ? { logger: input.logger } : {}),
        })
      : undefined;

  // BYOK agent execution (slice 3.5-A.2b): the in-process agent runs on the ORG'S OWN vault key — never a
  // server key (there is none). The orchestration loop, before each spawn, resolves the org key (null →
  // fail closed, no spawn) and starts an EPHEMERAL per-task proxy baked with that key + the {org,task} for
  // metering; the agent reaches Anthropic only through that proxy (its ANTHROPIC_BASE_URL), so the real key
  // never enters the prompt-injectable agent's env. Built only when the resolver (master key) is present.
  //  - agentVendorResolver: resolve the org's Anthropic vault key (null → no key configured).
  //  - agentUsageSink: write each agent call as usage_event{source:'agent'}. Same fire-and-forget +
  //    error-log shape as the coordination usage sink (a meter failure never breaks/delays the agent's
  //    stream); CAS-idempotent on the Anthropic response id in the store.
  //  - startAgentProxy: start a per-task loopback proxy (port 0 → OS-assigned) and return its base url +
  //    a close() the loop calls in finally. A PER-TASK instance, not the shared bridge, so concurrent
  //    in-process dispatches never race a shared setContext.
  const agentUsageSink: AgentUsageSink = {
    record(e): void {
      void store
        .recordUsage(e.orgId, {
          taskId: e.taskId,
          source: 'agent',
          model: e.model,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          idempotencyKey: e.idempotencyKey,
        })
        .catch((err: unknown) => input.logger?.error?.('anthropic-proxy: agent usage record failed', { err: String(err) }));
    },
  };
  const agentVendorResolver = vendorResolver
    ? (orgId: string): Promise<string | null> => vendorResolver.resolve(orgId, 'anthropic')
    : undefined;
  const startAgentProxy = vendorResolver
    ? async (opts: { apiKey: string; usageContext: { orgId: string; taskId: string } }): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
        const handle = await serveAnthropicProxy({
          tcpPort: 0,
          tcpHost: '127.0.0.1',
          apiKey: opts.apiKey,
          usageContext: opts.usageContext,
          usageSink: agentUsageSink,
          ...(input.logger !== undefined ? { logger: input.logger } : {}),
        });
        return { baseUrl: `http://127.0.0.1:${handle.address!.port}`, close: () => handle.close() };
      }
    : undefined;

  const deps: CoordinationServerDeps = {
    store,
    claim,
    execution: input.execution,
    status: input.status,
    verifier: input.verifier,
    directory,
    audit,
    content: input.content,
    readApi: {
      store,
      identity,
      membership,
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // The human write-API shares the read API's session verifier; when no verifier
    // is wired it fails closed (503), same posture as the read side. Mutations are
    // additionally CSRF-gated (double-submit) inside the handler.
    writeApi: {
      store,
      identity,
      membership,
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // The org-management API (slice 5a): list/create/switch orgs. Same session posture; not
    // org-scoped (it operates on the membership layer that decides the active org).
    orgApi: {
      membership,
      roster,
      ...(input.singleTenant !== undefined ? { singleTenant: input.singleTenant } : {}),
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // The create-agent API (slice Wizard-A): the user-facing roster create flow. Mints a named agent +
    // capability profile and auto-hires it into the caller's active org, ATOMICALLY (PgAgentCreator owns
    // the tx). Member+ gated; CSRF on the POST. Same session posture as the org API.
    agentApi: {
      creator: new PgAgentCreator(input.pool),
      membership,
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // The project API (slice Project-A): list the active org's projects + switch the active project
    // (store-validated in-org). Same session posture as the org API; NOT single-tenant-gated.
    projectApi: {
      store,
      membership,
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // BYOK vendor-credential API (slice 3.5-A) — wired only when the vendor-credential bits (master key
    // presence + validator) are supplied. The resolver (org-key injection seam + ~60s cache) is built
    // over the same store; consumers (per-org classifier) wire to it in the next sub-slice.
    ...(input.vendorCredential
      ? {
          vendorCredentialApi: {
            store,
            resolver: vendorResolver!,
            validator: input.vendorCredential.validator,
            masterKey: input.vendorCredential.masterKey,
            membership,
            // Governance audit trail (slice 3.5-A.2c.1): the same store implements GovernanceAuditSink.
            audit: store,
            ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
            ...(input.logger !== undefined ? { logger: input.logger } : {}),
          },
        }
      : {}),
    // The per-agent identity API (slice SC-3) — wired only when the agent-credential bits (master key
    // presence + the shared resolver) are supplied. Admin-gated, CSRF, write-only set of an agent's
    // Shortcut Agent-User token; upserts the identity_binding projection + governance-audits the set.
    ...(input.agentCredential
      ? {
          agentIdentityApi: {
            store,
            resolver: input.agentCredential.resolver,
            identity,
            roster,
            masterKey: input.agentCredential.masterKey,
            membership,
            // Governance audit trail: the same store implements GovernanceAuditSink.
            audit: store,
            ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
            ...(input.logger !== undefined ? { logger: input.logger } : {}),
          },
        }
      : {}),
    // The connection set API (slice SC-1) — wired only when the connection-credential bits (master key
    // presence + the shared resolver) are supplied. Admin-gated, CSRF, write-only set of a Shortcut
    // workspace→project binding + its sealed secrets; governance-audits the set.
    ...(input.connectionCredential
      ? {
          connectionApi: {
            store,
            resolver: input.connectionCredential.resolver,
            masterKey: input.connectionCredential.masterKey,
            membership,
            // Governance audit trail: the same store implements GovernanceAuditSink.
            audit: store,
            ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
            ...(input.logger !== undefined ? { logger: input.logger } : {}),
          },
          // The connection-scoped webhook route reads the SAME resolver (cache-busted on a set) + the
          // boot-time Shortcut binding snapshot to build per-request verifiers.
          connectionCredentialResolver: input.connectionCredential.resolver,
          registeredShortcutIds: input.connectionCredential.registeredShortcutIds,
        }
      : {}),
    // The Engineering Manager admin API (EM v1 slice 1) — wired only when the manager-credential bits
    // (master key presence) are supplied. Admin-gated; the identity route is write-only (seals the EM's
    // Shortcut token, never returns it); governance-audits each op. The store implements ManagerApiStore.
    ...(input.managerCredential
      ? {
          managerApi: {
            store,
            masterKey: input.managerCredential.masterKey,
            membership,
            // Governance audit trail: the same store implements GovernanceAuditSink.
            audit: store,
            ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
            ...(input.logger !== undefined ? { logger: input.logger } : {}),
          },
        }
      : {}),
    // The PM-assistant API (slice W3-S1) — advisory proposals. Accept routes through the store's
    // CAS-guarded binding method; the deterministic match-based proposer ships now (LLM-backed
    // proposers for the language kinds arrive in later sub-slices). Generation is flag-gated.
    proposalApi: {
      store,
      membership,
      roster,
      directory,
      content: input.content,
      // routing = deterministic match; triage = the tier engine (heuristic-only here); decomposition =
      // no suggestion. Under BYOK (3.5-A.2a) the server holds no key, so the PM-assistant LLM proposers
      // degrade to heuristic/no-suggestion until they are wired to the per-org vault key (follow-up).
      proposer: new DefaultPmProposer({}),
      enabled: input.pmAssistantEnabled === true,
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // The org-invite API (slice 3.5-B.3.1) — wired only when an accept base URL is supplied (the app
    // origin). Admin-gated create/list/revoke + an authenticated possession-based accept; the store seals
    // each invite as a hashed-at-rest single-use token.
    ...(input.inviteAcceptBaseUrl
      ? {
          inviteApi: {
            store,
            membership,
            acceptBaseUrl: input.inviteAcceptBaseUrl,
            ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
            ...(input.logger !== undefined ? { logger: input.logger } : {}),
          },
        }
      : {}),
    // The GitHub connect API (slice 5c) — wired only when the App bits are supplied. Binds a
    // customer's GitHub install to their org via the secure begin→callback flow.
    ...(input.githubConnect
      ? {
          connectApi: {
            installState: new PgGitHubInstallStateRepo(input.pool),
            membership,
            store,
            appClient: input.githubConnect.appClient,
            appSlug: input.githubConnect.appSlug,
            ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
            ...(input.logger !== undefined ? { logger: input.logger } : {}),
          },
        }
      : {}),
    ...(input.githubVerifier !== undefined ? { githubVerifier: input.githubVerifier } : {}),
    ...(input.githubInstallationHandler !== undefined
      ? { githubInstallationHandler: input.githubInstallationHandler }
      : {}),
    ...(input.githubMergeHandler !== undefined
      ? { githubMergeHandler: input.githubMergeHandler }
      : {}),
    ...(input.authHandler !== undefined ? { authHandler: input.authHandler } : {}),
    ...(classifierFor ? { classifierFor } : {}),
    ...(emReviewGate ? { emReviewGate } : {}),
    ...(agentVendorResolver ? { agentVendorResolver } : {}),
    ...(startAgentProxy ? { startAgentProxy } : {}),
    ...(input.provisioner !== undefined ? { provisioner: input.provisioner } : {}),
    ...(dispatchQueue ? { dispatchQueue } : {}),
    ...(input.runnerWaitMs !== undefined ? { runnerWaitMs: input.runnerWaitMs } : {}),
    ...(input.runnerPollMs !== undefined ? { runnerPollMs: input.runnerPollMs } : {}),
    ...(input.breakerThreshold !== undefined ? { breakerThreshold: input.breakerThreshold } : {}),
    ...(input.perProjectLimit !== undefined ? { perProjectLimit: input.perProjectLimit } : {}),
    ...(input.agentTimeoutMs !== undefined ? { agentTimeoutMs: input.agentTimeoutMs } : {}),
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  };

  const reaper = dispatchQueue
    ? makeReaper({
        queue: dispatchQueue,
        store,
        status: input.status,
        audit,
        principalIdFor: (agentId) => directory.principalIdFor(agentId),
        ...(input.breakerThreshold !== undefined ? { breakerThreshold: input.breakerThreshold } : {}),
        ...(input.logger !== undefined ? { logger: input.logger } : {}),
      })
    : undefined;

  return {
    deps,
    createServer: () => createCoordinationServer(deps),
    ...(reaper ? { reaper } : {}),
  };
}
