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
// Testable core (structural repo + resolved input); the CLI shell opens the Pool.

import { TIERS, type CapabilityProfile, type Tier } from '@tasca/domain';

/** The subset of PgIdentityRepository this needs — lets tests inject a fake. */
export interface ProvisioningRepo {
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
  }): Promise<{ externalId: string; externalHandle: string | null; state: string }>;
}

// Fields are populated from process.env (string | undefined), so each explicitly
// allows undefined (exactOptionalPropertyTypes is on).
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
  /** Vendor for a created agent (default 'claude'). */
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
 * account. Validates inputs before any write. Throws on a missing/invalid id, a
 * non-existent agentId, or an existing agent with no capability profile (which the
 * routing directory skips → it would never be dispatched).
 */
export async function provisionGitHubAgent(
  repo: ProvisioningRepo,
  input: ProvisionGitHubAgentInput
): Promise<ProvisionResult> {
  const githubUserId = input.githubUserId?.trim();
  if (!githubUserId || !NUMERIC.test(githubUserId)) {
    throw new Error('githubUserId is required and must be the NUMERIC GitHub user id (e.g. 21088825)');
  }
  const githubLogin = input.githubLogin?.trim() || undefined;

  let agentId = input.agentId?.trim();
  let created = false;

  if (!agentId) {
    const name = input.agentName?.trim();
    const model = input.model?.trim();
    if (!name || !model) {
      throw new Error('agentName and model are required when no agentId is given (creating a new agent)');
    }
    const maxTier = (input.maxTier?.trim() || 'ultra') as Tier;
    if (!TIERS.includes(maxTier)) {
      throw new Error(`maxTier must be one of: ${TIERS.join(', ')}`);
    }
    const createInput = input.vendor?.trim()
      ? { name, model, vendor: input.vendor.trim() }
      : { name, model };
    const c = await repo.createAgent(createInput);
    agentId = c.agent.id;
    await repo.setCapabilityProfile(defaultProfile(agentId, maxTier));
    created = true;
  } else {
    if (!(await repo.getServiceUser(agentId))) {
      throw new Error(`no agent found with id ${agentId}`);
    }
    if (!(await repo.getCapabilityProfile(agentId))) {
      throw new Error(
        `agent ${agentId} has no capability profile — routing would skip it. ` +
          'Set one first, or omit agentId to create a fresh agent with a default profile.'
      );
    }
  }

  const binding = await repo.upsertBinding({
    agentId,
    platform: 'github',
    externalId: githubUserId,
    ...(githubLogin ? { externalHandle: githubLogin } : {}),
    state: 'active',
  });

  return {
    agentId,
    created,
    binding: {
      externalId: binding.externalId,
      externalHandle: binding.externalHandle,
      state: binding.state,
    },
  };
}
