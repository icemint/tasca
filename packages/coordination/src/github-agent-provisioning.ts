// Provision an agent's native GitHub identity binding (intake side).
//
// The worker matches an issue's numeric assignee id against active `github`
// identity_bindings (and lowercased logins for @-mentions). Nothing creates those
// bindings automatically: the App-install webhook records only the customer
// account→installation mapping (for write-back), NOT which GitHub user accounts are
// agents — that agent↔account mapping is a Tasca roster decision. So a github
// binding is provisioned by an operator with this command.
//
// IMPORTANT: the assignee must be a REAL GitHub user (a machine account added as a
// repo collaborator), NOT the `tasca[bot]` App identity — a GitHub App's bot user
// cannot be an issue assignee. `tasca[bot]` remains the write-back author (#207).
//
// Idempotency + integrity are keyed on the GITHUB ACCOUNT, not on remembering an
// agent id: identity_binding is UNIQUE(agent_id, platform), so without this the same
// external id could be active-bound to two agents (ambiguous routing) and a re-run
// without --agent-id would mint a duplicate agent. We resolve any existing active
// binding for the external id first, then create-or-resolve the agent and write the
// binding + its audit row in ONE transaction (mirrors bindShortcutIdentity).

import { TIERS, type CapabilityProfile, type Tier } from '@tasca/domain';

const VENDORS = ['claude', 'openai', 'local'] as const;

/** The subset of PgIdentityRepository this needs — lets tests inject a fake. */
export interface ProvisioningRepo {
  withTransaction<T>(fn: (tx: ProvisioningRepo) => Promise<T>): Promise<T>;
  getActiveBindingByExternalId(
    platform: 'github',
    externalId: string
  ): Promise<{ agentId: string } | null>;
  createAgent(input: { name: string; model: string; vendor?: string }): Promise<{
    agent: { id: string };
    serviceUser: { principalId: string };
  }>;
  getServiceUser(agentId: string): Promise<{ principalId: string } | null>;
  getCapabilityProfile(agentId: string): Promise<CapabilityProfile | null>;
  setCapabilityProfile(profile: CapabilityProfile): Promise<void>;
  upsertBinding(input: {
    agentId: string;
    platform: 'github';
    externalId: string;
    externalHandle?: string;
    state: 'active';
  }): Promise<{ id: string; externalId: string; externalHandle: string | null; state: string }>;
  appendAuditEvent(input: {
    principalId: string;
    agentId: string;
    action: string;
    platform?: 'github';
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface ProvisionGitHubAgentInput {
  /** Numeric GitHub user id of the assignee account (issues.assigned match). Required. */
  githubUserId?: string | undefined;
  /** GitHub login of the assignee account (@-mention match). Optional but recommended. */
  githubLogin?: string | undefined;
  /** Bind to this existing agent; if omitted, a new agent is created. */
  agentId?: string | undefined;
  /** Required when creating a new agent. */
  agentName?: string | undefined;
  /** Required when creating a new agent. */
  model?: string | undefined;
  /** Vendor for a created agent (default 'claude'); one of claude|openai|local. */
  vendor?: string | undefined;
  /** maxTier for a created agent's capability profile (default 'ultra'). */
  maxTier?: string | undefined;
}

export interface ProvisionResult {
  agentId: string;
  created: boolean;
  binding: { externalId: string; externalHandle: string | null; state: string };
}

const NUMERIC = /^\d+$/;

/** A broad default profile so a freshly created agent is routable across all tiers. */
function defaultProfile(agentId: string, maxTier: Tier): CapabilityProfile {
  return {
    agentId,
    maxTier,
    tiersCovered: [...TIERS],
    languageSpecialties: [],
    frameworkSpecialties: [],
    concurrencyLimit: 4,
    costCeiling: 100,
    successRate: null,
    avgLatencyMs: null,
  };
}

/**
 * Create-or-resolve an agent and attach an ACTIVE github binding for its assignee
 * account, with its audit row, in one transaction. Validates inputs before any
 * write. Idempotent on the github account: a re-run for an already-bound external
 * id reuses that agent; binding the same external id to a DIFFERENT agent is
 * rejected (ambiguous routing). Throws on a missing/invalid id, an unknown vendor
 * or maxTier, a non-existent agentId, or an existing agent with no capability
 * profile (which the routing directory skips → it would never be dispatched).
 */
export async function provisionGitHubAgent(
  repo: ProvisioningRepo,
  input: ProvisionGitHubAgentInput
): Promise<ProvisionResult> {
  // ── validate-before-write (cheap, branch-independent) ──
  const githubUserId = input.githubUserId?.trim();
  if (!githubUserId || !NUMERIC.test(githubUserId)) {
    throw new Error('githubUserId is required and must be the NUMERIC GitHub user id (e.g. 21088825)');
  }
  const githubLogin = input.githubLogin?.trim() || undefined;
  const requestedAgentId = input.agentId?.trim() || undefined;
  const vendor = input.vendor?.trim() || undefined;
  if (vendor && !(VENDORS as readonly string[]).includes(vendor)) {
    throw new Error(`vendor must be one of: ${VENDORS.join(', ')}`);
  }
  const maxTier = (input.maxTier?.trim() || 'ultra') as Tier;
  if (!TIERS.includes(maxTier)) {
    throw new Error(`maxTier must be one of: ${TIERS.join(', ')}`);
  }

  return repo.withTransaction(async (tx) => {
    // Resolve idempotency/collision on the GITHUB ACCOUNT first.
    const existing = await tx.getActiveBindingByExternalId('github', githubUserId);
    let agentId: string;
    let created = false;

    if (existing) {
      if (requestedAgentId && requestedAgentId !== existing.agentId) {
        throw new Error(
          `github id ${githubUserId} is already an active binding for agent ${existing.agentId}; ` +
            'revoke it before binding the account to a different agent'
        );
      }
      agentId = existing.agentId; // idempotent re-provision of the same account
    } else if (requestedAgentId) {
      if (!(await tx.getServiceUser(requestedAgentId))) {
        throw new Error(`no agent found with id ${requestedAgentId}`);
      }
      if (!(await tx.getCapabilityProfile(requestedAgentId))) {
        throw new Error(
          `agent ${requestedAgentId} has no capability profile — routing would skip it. ` +
            'Set one first, or omit agentId to create a fresh agent with a default profile.'
        );
      }
      agentId = requestedAgentId;
    } else {
      const name = input.agentName?.trim();
      const model = input.model?.trim();
      if (!name || !model) {
        throw new Error('agentName and model are required when no agentId is given (creating a new agent)');
      }
      const createInput = vendor ? { name, model, vendor } : { name, model };
      const c = await tx.createAgent(createInput);
      agentId = c.agent.id;
      await tx.setCapabilityProfile(defaultProfile(agentId, maxTier));
      created = true;
    }

    const binding = await tx.upsertBinding({
      agentId,
      platform: 'github',
      externalId: githubUserId,
      ...(githubLogin ? { externalHandle: githubLogin } : {}),
      state: 'active',
    });

    // Bind write + audit append commit together (continuous-audit-trail guarantee,
    // as bindShortcutIdentity does). principalId is the agent's stable principal.
    const serviceUser = await tx.getServiceUser(agentId);
    if (serviceUser) {
      await tx.appendAuditEvent({
        principalId: serviceUser.principalId,
        agentId,
        action: 'identity.binding.github.bound',
        platform: 'github',
        payload: { externalId: githubUserId },
      });
    }

    return {
      agentId,
      created,
      binding: {
        externalId: binding.externalId,
        externalHandle: binding.externalHandle,
        state: binding.state,
      },
    };
  });
}
