// @tasca/coordination — the composition root + orchestration loop (scaffold
// §1.3, §6, build step 7). Wires the proven packages (routing, execution-types,
// identity, db) behind injected ports; the Shortcut adapter (StatusReporter /
// WebhookVerifier seams) is wired in LATER.

// The orchestration loop (the heart).
export {
  orchestrateTaskAssigned,
  type OrchestrationDeps,
  type OrchestrationOutcome,
  type AgentDirectory,
  type AuditSink,
  type TaskContentSource,
} from './orchestrate';

// The injected seams.
export type {
  StatusReporter,
  StatusUpdate,
  WebhookVerifier,
  RawWebhook,
  VerifiedWebhook,
  ClaimPort,
  LlmClassifierPort,
  ExecutionPort,
} from './ports';

// The coordination store (seam + Postgres impl).
export {
  PgCoordinationStore,
  type CoordinationStore,
  type CreateTaskInput,
  type RecordWebhookResult,
  type Queryable,
} from './store';

// The thin HTTP entry.
export {
  createCoordinationServer,
  createRequestHandler,
  type CoordinationServerDeps,
} from './server';

// The composition root.
export {
  createCoordination,
  type Coordination,
  type CreateCoordinationDeps,
} from './factory';

// The coordination-store DDL (scaffold §7).
export {
  COORDINATION_SCHEMA_DDL,
  TASK_COORDINATION_COLUMNS_DDL,
  PLATFORM_CONNECTION_TABLE_DDL,
  WEBHOOK_EVENT_TABLE_DDL,
  ROUTING_DECISION_TABLE_DDL,
  PULL_REQUEST_TABLE_DDL,
} from './schema';
