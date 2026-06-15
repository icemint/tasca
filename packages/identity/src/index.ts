// @tasca/identity — the Devin-modeled agent-identity primitive (scaffold §2):
// every agent is a service-user (never a fake human) with a stable internal
// principal_id, an RBAC role, a capability profile, delegation/attribution, and
// per-platform identity bindings + an append-only audit trail. Shared entity
// types live in @tasca/domain; this package owns the Postgres schema, the raw-pg
// repository, and the Shortcut-agent-user mapping flow.
//
// Boundary: imports ONLY @tasca/domain (+ pg). Never routing/adapters/
// coordination/execution; no heavy native/execution build.

export {
  RBAC_ROLE_TABLE_DDL,
  AGENT_TABLE_DDL,
  SERVICE_USER_TABLE_DDL,
  CAPABILITY_PROFILE_TABLE_DDL,
  IDENTITY_BINDING_TABLE_DDL,
  DELEGATION_TABLE_DDL,
  AUDIT_EVENT_TABLE_DDL,
  AGENT_DESCRIPTION_DDL,
  IDENTITY_SCHEMA_DDL,
} from './schema';

export { PgIdentityRepository } from './identity-repo';
export type {
  Queryable,
  NewAgentInput,
  AgentRecord,
  CreatedAgent,
  AgentWithProfile,
  AgentWriteOutcome,
  CapabilityProfilePatch,
  BindIdentityInput,
} from './identity-repo';

export { bindShortcutIdentity, rotateShortcutCredential } from './shortcut-mapping';
export type { ShortcutBindingInput } from './shortcut-mapping';
