import { describe, it, expect } from 'vitest';
import { TIERS, type CapabilityProfile } from '@tasca/domain';
import {
  provisionGitHubAgent,
  type ProvisioningRepo,
  type ProvisionGitHubAgentInput,
} from './github-agent-provisioning';

/** A recording fake of the provisioning subset of PgIdentityRepository. */
function makeRepo(opts: {
  existingAgentIds?: Set<string>;
  profiledAgentIds?: Set<string>;
  activeByExternalId?: Map<string, string>; // externalId → agentId
} = {}) {
  const calls = {
    createAgent: [] as Array<{ name: string; model: string; vendor?: string }>,
    setProfile: [] as CapabilityProfile[],
    upsertBinding: [] as Array<{ agentId: string; externalId: string; externalHandle?: string; state: string }>,
    audit: [] as Array<{ principalId: string; agentId: string; action: string }>,
  };
  const repo: ProvisioningRepo = {
    async withTransaction(fn) {
      return fn(repo); // tests don't need a real tx boundary
    },
    async getActiveBindingByExternalId(_platform, externalId) {
      const agentId = opts.activeByExternalId?.get(externalId);
      return agentId ? { agentId } : null;
    },
    async createAgent(input) {
      calls.createAgent.push(input);
      return { agent: { id: 'agent-new' }, serviceUser: { principalId: 'prn_new' } };
    },
    async getServiceUser(agentId) {
      // created agent + any pre-existing agent resolve a principal
      if (agentId === 'agent-new' || opts.existingAgentIds?.has(agentId)) {
        return { principalId: `prn_${agentId}` };
      }
      return null;
    },
    async getCapabilityProfile(agentId) {
      return opts.profiledAgentIds?.has(agentId)
        ? ({ agentId, maxTier: 'ultra', tiersCovered: [], languageSpecialties: [], frameworkSpecialties: [], concurrencyLimit: 1, costCeiling: 1, successRate: null, avgLatencyMs: null } as CapabilityProfile)
        : null;
    },
    async setCapabilityProfile(profile) {
      calls.setProfile.push(profile);
    },
    async upsertBinding(input) {
      calls.upsertBinding.push(input);
      return { id: 'binding-1', externalId: input.externalId, externalHandle: input.externalHandle ?? null, state: input.state };
    },
    async appendAuditEvent(input) {
      calls.audit.push({ principalId: input.principalId, agentId: input.agentId, action: input.action });
      return undefined;
    },
  };
  return { repo, calls };
}

const base: ProvisionGitHubAgentInput = { githubUserId: '21088825', agentName: 'Elvis', model: 'claude-sonnet' };

describe('provisionGitHubAgent', () => {
  it('rejects a missing githubUserId before any write', async () => {
    const { repo, calls } = makeRepo();
    await expect(provisionGitHubAgent(repo, { ...base, githubUserId: undefined })).rejects.toThrow(/numeric GitHub user id/i);
    expect(calls.createAgent).toHaveLength(0);
    expect(calls.upsertBinding).toHaveLength(0);
  });

  it('rejects a non-numeric githubUserId (login passed by mistake)', async () => {
    const { repo, calls } = makeRepo();
    await expect(provisionGitHubAgent(repo, { ...base, githubUserId: 'roadhero' })).rejects.toThrow(/numeric/i);
    expect(calls.upsertBinding).toHaveLength(0);
  });

  it('rejects an unknown vendor before any write', async () => {
    const { repo, calls } = makeRepo();
    await expect(provisionGitHubAgent(repo, { ...base, vendor: 'anthropic' })).rejects.toThrow(/vendor must be one of/);
    expect(calls.createAgent).toHaveLength(0);
  });

  it('rejects an invalid maxTier before any write', async () => {
    const { repo, calls } = makeRepo();
    await expect(provisionGitHubAgent(repo, { ...base, maxTier: 'godlike' })).rejects.toThrow(/maxTier must be one of/);
    expect(calls.createAgent).toHaveLength(0);
  });

  it('creates an agent + full-tier default profile + active binding + audit row', async () => {
    const { repo, calls } = makeRepo();
    const res = await provisionGitHubAgent(repo, { ...base, githubLogin: 'tasca-elvis' });
    expect(res).toMatchObject({ created: true, agentId: 'agent-new' });
    expect(calls.createAgent).toEqual([{ name: 'Elvis', model: 'claude-sonnet' }]);
    // routability invariant: exactly one profile, covering ALL tiers
    expect(calls.setProfile).toHaveLength(1);
    expect(calls.setProfile[0]!.agentId).toBe('agent-new');
    expect(calls.setProfile[0]!.maxTier).toBe('ultra');
    expect(calls.setProfile[0]!.tiersCovered).toEqual([...TIERS]);
    expect(calls.setProfile[0]!.concurrencyLimit).toBe(4);
    expect(calls.upsertBinding).toEqual([
      { agentId: 'agent-new', platform: 'github', externalId: '21088825', externalHandle: 'tasca-elvis', state: 'active' },
    ]);
    expect(calls.audit).toEqual([
      { principalId: 'prn_agent-new', agentId: 'agent-new', action: 'identity.binding.github.bound' },
    ]);
  });

  it('threads a custom maxTier into the created profile', async () => {
    const { repo, calls } = makeRepo();
    await provisionGitHubAgent(repo, { ...base, maxTier: 'medium' });
    expect(calls.setProfile[0]!.maxTier).toBe('medium');
  });

  it('passes a valid vendor through to createAgent', async () => {
    const { repo, calls } = makeRepo();
    await provisionGitHubAgent(repo, { ...base, vendor: 'openai' });
    expect(calls.createAgent[0]).toEqual({ name: 'Elvis', model: 'claude-sonnet', vendor: 'openai' });
  });

  it('requires name + model when creating', async () => {
    const { repo } = makeRepo();
    await expect(provisionGitHubAgent(repo, { githubUserId: '1' })).rejects.toThrow(/agentName and model are required/);
  });

  it('binds to an existing agent that has a profile (no new agent)', async () => {
    const { repo, calls } = makeRepo({ existingAgentIds: new Set(['agent-1']), profiledAgentIds: new Set(['agent-1']) });
    const res = await provisionGitHubAgent(repo, { githubUserId: '999', agentId: 'agent-1' });
    expect(res.created).toBe(false);
    expect(calls.createAgent).toHaveLength(0);
    expect(calls.upsertBinding[0]!.agentId).toBe('agent-1');
    expect(calls.audit[0]!.agentId).toBe('agent-1');
  });

  it('throws when the given agentId does not exist (no binding written)', async () => {
    const { repo, calls } = makeRepo();
    await expect(provisionGitHubAgent(repo, { githubUserId: '999', agentId: 'ghost' })).rejects.toThrow(/no agent found/);
    expect(calls.upsertBinding).toHaveLength(0);
  });

  it('refuses to bind an existing agent with no capability profile (would be unroutable)', async () => {
    const { repo, calls } = makeRepo({ existingAgentIds: new Set(['agent-2']) });
    await expect(provisionGitHubAgent(repo, { githubUserId: '999', agentId: 'agent-2' })).rejects.toThrow(/no capability profile/);
    expect(calls.upsertBinding).toHaveLength(0);
  });

  it('is idempotent on the github account: a re-run reuses the bound agent, never creates a duplicate', async () => {
    // external id 21088825 already actively bound to agent-1.
    const { repo, calls } = makeRepo({ activeByExternalId: new Map([['21088825', 'agent-1']]) });
    const res = await provisionGitHubAgent(repo, base); // no agentId given
    expect(res).toMatchObject({ created: false, agentId: 'agent-1' });
    expect(calls.createAgent).toHaveLength(0); // did NOT mint a second agent
    expect(calls.upsertBinding[0]!.agentId).toBe('agent-1');
  });

  it('rejects binding an already-bound github account to a DIFFERENT agent (ambiguous routing)', async () => {
    const { repo, calls } = makeRepo({
      activeByExternalId: new Map([['21088825', 'agent-1']]),
      existingAgentIds: new Set(['agent-2']),
      profiledAgentIds: new Set(['agent-2']),
    });
    await expect(provisionGitHubAgent(repo, { githubUserId: '21088825', agentId: 'agent-2' })).rejects.toThrow(
      /already an active binding for agent agent-1/
    );
    expect(calls.upsertBinding).toHaveLength(0);
  });
});
