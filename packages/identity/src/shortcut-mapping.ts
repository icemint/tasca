import type { IdentityBinding } from '@tasca/domain';
import type { PgIdentityRepository } from './identity-repo';

/**
 * The Shortcut-agent-user mapping (scaffold §2.3).
 *
 * Binds an agent's internal principal to its NATIVE Shortcut identity: a
 * Shortcut agent-user id + a per-binding `credentialRef` (a pointer to where the
 * service-scoped Shortcut-Token lives in the secret store — the secret itself is
 * NEVER stored in Postgres). After this, every status-back / comment / state
 * change Tasca posts is attributed to the agent's native Shortcut identity,
 * while internal audit attributes it to the stable `principalId`.
 *
 * THE SEAM (scaffold §4.3(e) — the one genuine open question).
 * Shortcut's `Shortcut-Token` is user- and workspace-specific, and it is not yet
 * confirmed whether a workspace yields one token per agent-user or a single
 * workspace service-token that "acts-as" a chosen agent-user per call. Because
 * `credentialRef` is **per-binding**, both shapes are absorbed here without any
 * model change:
 *
 *   - one-token-per-agent: each agent's binding points at its own secret.
 *   - one-workspace-token acting-as: every agent's binding points at the SAME
 *     shared secret ref; the agent's distinct identity is the `externalId`
 *     (agent-user id) the caller acts-as. The acting-as target is the binding's
 *     `externalId`, resolved at call time by the adapter.
 *
 * Either way the internal `service_user.principal_id` is stable, so whichever
 * shape Shortcut confirms is a binding-layer detail, not a re-architecture. When
 * the external token must be rotated or re-provisioned, call
 * `rotateShortcutCredential()` — the `principalId` is untouched and the audit
 * trail stays continuous.
 */

export interface ShortcutBindingInput {
  agentId: string;
  /** The native Shortcut agent-user id. */
  shortcutAgentUserId: string;
  /** Mentionable @handle in Shortcut. */
  handle?: string;
  /** Pointer to the service-scoped Shortcut-Token in the secret store. */
  credentialRef: string;
}

/**
 * Bind (or re-bind) an agent's principal to a Shortcut agent-user, then record
 * the action in the audit trail under the agent's stable principal.
 */
export async function bindShortcutIdentity(
  repo: PgIdentityRepository,
  input: ShortcutBindingInput
): Promise<IdentityBinding> {
  const serviceUser = await repo.getServiceUser(input.agentId);
  if (!serviceUser) {
    throw new Error(`no service_user for agent ${input.agentId}; create the agent first`);
  }

  const binding = await repo.upsertBinding({
    agentId: input.agentId,
    platform: 'shortcut',
    externalId: input.shortcutAgentUserId,
    ...(input.handle !== undefined ? { externalHandle: input.handle } : {}),
    credentialRef: input.credentialRef,
    state: 'active',
  });

  await repo.appendAuditEvent({
    principalId: serviceUser.principalId,
    agentId: input.agentId,
    action: 'identity.binding.shortcut.bound',
    target: input.shortcutAgentUserId,
    platform: 'shortcut',
    // Record only the binding id — never the credential_ref pointer (it reveals
    // secret-store locations in the broadly-readable, append-only audit table).
    payload: { bindingId: binding.id },
  });

  return binding;
}

/**
 * Rotate the Shortcut token pointer for an agent (token re-provisioned / dead
 * creating-user). Only `credentialRef` (and optionally state) change; the agent
 * keeps the SAME `principalId`. Audited under that stable principal.
 */
export async function rotateShortcutCredential(
  repo: PgIdentityRepository,
  agentId: string,
  newCredentialRef: string
): Promise<IdentityBinding> {
  const serviceUser = await repo.getServiceUser(agentId);
  if (!serviceUser) {
    throw new Error(`no service_user for agent ${agentId}`);
  }

  const binding = await repo.rotateCredentialRef(agentId, 'shortcut', newCredentialRef, 'active');
  if (!binding) {
    throw new Error(`no shortcut binding for agent ${agentId} to rotate`);
  }

  await repo.appendAuditEvent({
    principalId: serviceUser.principalId,
    agentId,
    action: 'identity.binding.shortcut.credential_rotated',
    target: binding.externalId,
    platform: 'shortcut',
    // Mark that a rotation happened — never the new credential_ref pointer itself.
    payload: { bindingId: binding.id, rotated: true },
  });

  return binding;
}
