import { describe, it, expect } from 'vitest';
import type { CapabilityProfile } from '@tasca/domain';
import {
  provisionGitHubAgent,
  type ProvisioningRepo,
  type ProvisionGitHubAgentInput,
} from './github-agent-provisioning';

/** A recording fake of the provisioning subset of PgIdentityRepository. */
function makeRepo(opts: {
  existingAgentIds?: Set<string>;
  profiledAgentIds?: Set<string>;
} = {}) {
  const calls = {
    createAgent: [] as Array<{ name: string; model: string; vendor?: string }>,
    setProfile: [] as CapabilityProfile[],
    upsertBinding: [] as Array<{ agentId: string; externalId: string; externalHandle?: string; state: string }>,
  };
  const repo: ProvisioningRepo = {
    async createAgent(input) {
      calls.createAgent.push(input);
      return { agent: { id: 'agent-new' }, serviceUser: { principalId: 'prn_x' } };
    },
    async getServiceUser(agentId) {
      return opts.existingAgentIds?.has(agentId) ? { principalId: 'prn_existing' } : null;
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
      return { externalId: input.externalId, externalHandle: input.externalHandle ?? null, state: input.state };
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

  it('creates an agent + default profile + active github binding', async () => {
    const { repo, calls } = makeRepo();
    const res = await provisionGitHubAgent(repo, { ...base, githubLogin: 'tasca-elvis' });
    expect(res.created).toBe(true);
    expect(res.agentId).toBe('agent-new');
    expect(calls.createAgent).toEqual([{ name: 'Elvis', model: 'claude-sonnet' }]);
    expect(calls.setProfile[0]!.maxTier).toBe('ultra');
    expect(calls.setProfile[0]!.tiersCovered).toContain('basic');
    expect(calls.upsertBinding).toEqual([
      { agentId: 'agent-new', platform: 'github', externalId: '21088825', externalHandle: 'tasca-elvis', state: 'active' },
    ]);
    expect(res.binding.state).toBe('active');
  });

  it('requires name + model when creating', async () => {
    const { repo } = makeRepo();
    await expect(provisionGitHubAgent(repo, { githubUserId: '1' })).rejects.toThrow(/agentName and model are required/);
  });

  it('rejects an invalid maxTier', async () => {
    const { repo } = makeRepo();
    await expect(provisionGitHubAgent(repo, { ...base, maxTier: 'godlike' })).rejects.toThrow(/maxTier must be one of/);
  });

  it('binds to an existing agent that has a profile (no new agent)', async () => {
    const { repo, calls } = makeRepo({ existingAgentIds: new Set(['agent-1']), profiledAgentIds: new Set(['agent-1']) });
    const res = await provisionGitHubAgent(repo, { githubUserId: '999', agentId: 'agent-1' });
    expect(res.created).toBe(false);
    expect(res.agentId).toBe('agent-1');
    expect(calls.createAgent).toHaveLength(0);
    expect(calls.upsertBinding[0]!.agentId).toBe('agent-1');
  });

  it('throws when the given agentId does not exist (no binding written)', async () => {
    const { repo, calls } = makeRepo();
    await expect(provisionGitHubAgent(repo, { githubUserId: '999', agentId: 'ghost' })).rejects.toThrow(/no agent found/);
    expect(calls.upsertBinding).toHaveLength(0);
  });

  it('refuses to bind an existing agent with no capability profile (would be unroutable)', async () => {
    const { repo, calls } = makeRepo({ existingAgentIds: new Set(['agent-2']) }); // exists but no profile
    await expect(provisionGitHubAgent(repo, { githubUserId: '999', agentId: 'agent-2' })).rejects.toThrow(/no capability profile/);
    expect(calls.upsertBinding).toHaveLength(0);
  });
});
