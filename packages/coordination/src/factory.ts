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
import type { LlmClassifierPort } from '@tasca/routing';
import { PgCoordinationStore } from './store';
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
  /** Optional auth handler (GET/POST /api/auth/*); absent → those paths 404. */
  authHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  content: TaskContentSource;
  classifier?: LlmClassifierPort;
  /** Optional repo provisioner (clone-on-dispatch); absent → repoRef used as-is. */
  provisioner?: RepoProvisioner;
  /** Enable split dispatch: enqueue jobs for an agent-runner, with in-process fallback.
   *  Default OFF (always in-process) until runners are deployed. */
  dispatchQueueEnabled?: boolean;
  /** Window to wait for a runner to claim before the in-process fallback. */
  dispatchFallbackMs?: number;
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
}

/**
 * An AgentDirectory backed by @tasca/identity capability profiles. Stage-1
 * single-agent: it surfaces the agents the host registered. The activeCount /
 * live state are coordination concerns; here they default to idle/0 and the host
 * can refine later (the routing functions already take them as inputs).
 */
class IdentityAgentDirectory implements AgentDirectory {
  constructor(
    private readonly identity: PgIdentityRepository,
    private readonly agentIds: string[]
  ) {}

  async listCandidates(_task: Task) {
    const out = [];
    for (const agentId of this.agentIds) {
      const profile = await this.identity.getCapabilityProfile(agentId);
      if (!profile) continue;
      out.push({ profile, state: 'idle' as const, activeCount: 0 });
    }
    return out;
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
  const identity = new PgIdentityRepository(input.pool);
  const directory = new IdentityAgentDirectory(identity, input.agentIds);
  const audit = new IdentityAuditSink(identity);
  // One queue instance shared by the dispatch path (enqueue/cancel) and the reaper
  // (sweep/finalize) so they operate on the same table wiring.
  const dispatchQueue = input.dispatchQueueEnabled ? new PgDispatchQueue(input.pool) : undefined;

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
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    // The human write-API shares the read API's session verifier; when no verifier
    // is wired it fails closed (503), same posture as the read side. Mutations are
    // additionally CSRF-gated (double-submit) inside the handler.
    writeApi: {
      store,
      identity,
      ...(input.verifySession !== undefined ? { verifySession: input.verifySession } : {}),
      ...(input.logger !== undefined ? { logger: input.logger } : {}),
    },
    ...(input.githubVerifier !== undefined ? { githubVerifier: input.githubVerifier } : {}),
    ...(input.githubInstallationHandler !== undefined
      ? { githubInstallationHandler: input.githubInstallationHandler }
      : {}),
    ...(input.authHandler !== undefined ? { authHandler: input.authHandler } : {}),
    ...(input.classifier !== undefined ? { classifier: input.classifier } : {}),
    ...(input.provisioner !== undefined ? { provisioner: input.provisioner } : {}),
    ...(dispatchQueue ? { dispatchQueue } : {}),
    ...(input.dispatchFallbackMs !== undefined ? { dispatchFallbackMs: input.dispatchFallbackMs } : {}),
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
