import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Task, TierEstimate } from '@tasca/domain';
import { proposalApiHandler, type ProposalApiDeps } from './proposal-api';
import { currentUsageContext } from './usage-context';
import type { Proposal, CreateProposalInput, ProposalWriteOutcome } from './store';
import type { OrgRole } from './membership';
import type { HiredAgent } from './roster';
import type { MatchCandidate } from '@tasca/routing';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

const ESTIMATE: TierEstimate = {
  tier: 'medium',
  confidence: 0.8,
  signals: { wordCount: 10, hasReasoningVerb: false, scopeHint: 'unknown', labelTier: null },
  classifierUsed: false,
};

function fakeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    externalStoryId: 'sc-1',
    title: null,
    platform: 'shortcut',
    status: 'routable',
    version: 3,
    claimedBy: null,
    failureCount: 0,
    repoRef: 'acme/api',
    tierEstimate: ESTIMATE,
    lastError: null,
    preferredAgentId: null,
    emCleared: false,
    emClarificationRound: 0,
    ...over,
  };
}

class FakeProposalStore {
  tasks = new Map<string, Task>();
  proposals = new Map<string, Proposal>();
  created: CreateProposalInput[] = [];
  accepted: Array<{ id: string; agentId: string }> = [];
  triaged: Array<{ id: string; tier: string }> = [];
  dismissed: string[] = [];
  nextAccept: ProposalWriteOutcome = { ok: true };
  nextTriage: ProposalWriteOutcome = { ok: true };
  nextDismiss: ProposalWriteOutcome = { ok: true };

  async getTask(_orgId: string, taskId: string) {
    return this.tasks.get(taskId) ?? null;
  }
  statusCounts: Record<string, number> = {};
  async getTaskStatusCounts() {
    return this.statusCounts;
  }
  async listProposals() {
    return [...this.proposals.values()];
  }
  async getProposal(_orgId: string, id: string) {
    return this.proposals.get(id) ?? null;
  }
  async createProposal(_orgId: string, input: CreateProposalInput): Promise<Proposal> {
    this.created.push(input);
    const p: Proposal = {
      id: 'p-new',
      kind: input.kind,
      targetTaskId: input.targetTaskId,
      targetVersion: input.targetVersion,
      payload: input.payload,
      status: 'pending',
      version: 0,
      createdAt: '2026-01-01T00:00:00Z',
    };
    this.proposals.set(p.id, p);
    return p;
  }
  async dismissProposal(_orgId: string, id: string): Promise<ProposalWriteOutcome> {
    this.dismissed.push(id);
    return this.nextDismiss;
  }
  async acceptRoutingProposal(_orgId: string, id: string, agentId: string): Promise<ProposalWriteOutcome> {
    this.accepted.push({ id, agentId });
    return this.nextAccept;
  }
  async acceptTriageProposal(_orgId: string, id: string, tier: string): Promise<ProposalWriteOutcome> {
    this.triaged.push({ id, tier });
    return this.nextTriage;
  }
  decomposed: Array<{ id: string; count: number }> = [];
  nextDecomp: ProposalWriteOutcome = { ok: true };
  async acceptDecompositionProposal(_orgId: string, id: string, children: Array<{ title: string; body: string }>): Promise<ProposalWriteOutcome> {
    this.decomposed.push({ id, count: children.length });
    return this.nextDecomp;
  }
}

class FakeMembership {
  activeOrg: string | null = 'org_default';
  role: OrgRole | null = 'member';
  async getActiveOrg() {
    return this.activeOrg;
  }
  async getRole() {
    return this.role;
  }
}

class FakeRoster {
  hired: HiredAgent[] = [];
  async findHiredAgentByName(_orgId: string, name: string) {
    return this.hired.find((h) => h.name.toLowerCase() === name.toLowerCase())?.agentId ?? null;
  }
  async listHired() {
    return this.hired;
  }
  async hire() {
    return 'ok' as const;
  }
  async unhire() {
    return true;
  }
  async hiredAgentIds() {
    return this.hired.map((h) => h.agentId);
  }
  async isHired() {
    return false;
  }
}

class FakeDirectory {
  candidates: MatchCandidate[] = [];
  async listCandidates() {
    return this.candidates;
  }
}

function fakeReq(
  method: string,
  url: string,
  opts: { headers?: Record<string, string | string[]>; body?: string } = {}
): IncomingMessage {
  const body = opts.body;
  const req = {
    method,
    url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

function fakeRes(): { captured: { statusCode: number; body: string }; res: ServerResponse } {
  const captured = { statusCode: 0, body: '' };
  const res = {
    setHeader() {},
    writeHead(code: number) {
      captured.statusCode = code;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  };
  return { captured, res: res as unknown as ServerResponse };
}

const TOK = 'a'.repeat(64);
const csrf = (extra: Record<string, string | string[]> = {}) => ({
  cookie: `tasca_csrf=${TOK}`,
  'x-csrf-token': TOK,
  ...extra,
});

interface Fakes {
  store: FakeProposalStore;
  membership: FakeMembership;
  roster: FakeRoster;
  directory: FakeDirectory;
}

function deps(f: Fakes, over: Partial<ProposalApiDeps> = {}): ProposalApiDeps {
  return {
    store: f.store,
    membership: f.membership as unknown as ProposalApiDeps['membership'],
    roster: f.roster as unknown as ProposalApiDeps['roster'],
    directory: f.directory,
    proposer: {
      async proposeRouting() {
        return { agentName: 'Mona', why: 'best fit for a medium task', confidence: 0.8 };
      },
      async proposeTriage() {
        return { tier: 'hard' as const, why: 'reasoning language + multi-file scope', confidence: 0.72 };
      },
      async proposeDecomposition() {
        return { children: [{ title: 'schema migration', body: '' }, { title: 'recon engine', body: '' }], why: 'splits cleanly' };
      },
    },
    content: { async fetch() { return { title: 'Refactor auth', body: 'redesign the token flow' }; } },
    enabled: true,
    verifySession: () => ({ userId: 'u1' }),
    ...over,
  };
}

function newFakes(): Fakes {
  return { store: new FakeProposalStore(), membership: new FakeMembership(), roster: new FakeRoster(), directory: new FakeDirectory() };
}

async function run(d: ProposalApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await proposalApiHandler(req, res, d);
  return { owned, ...captured };
}

describe('proposalApiHandler — routing + gates', () => {
  it('does not own non-proposal paths', async () => {
    const f = newFakes();
    expect((await run(deps(f), fakeReq('GET', '/api/tasks'))).owned).toBe(false);
    expect((await run(deps(f), fakeReq('PUT', '/api/proposals'))).owned).toBe(false);
  });

  it('401 without a valid session', async () => {
    const f = newFakes();
    const r = await run(deps(f, { verifySession: () => null }), fakeReq('GET', '/api/proposals'));
    expect(r.statusCode).toBe(401);
  });

  it('503 when no verifier is wired and not explicitly opened', async () => {
    const f = newFakes();
    const d = deps(f);
    delete (d as { verifySession?: unknown }).verifySession;
    const r = await run(d, fakeReq('GET', '/api/proposals'));
    expect(r.statusCode).toBe(503);
  });

  it('FAIL-CLOSED: a verified user with NO membership → 403, no read', async () => {
    const f = newFakes();
    f.membership.activeOrg = null;
    const r = await run(deps(f), fakeReq('GET', '/api/proposals'));
    expect(r.statusCode).toBe(403);
  });

  it('role gate: getRole null → 403', async () => {
    const f = newFakes();
    f.membership.role = null;
    const r = await run(deps(f), fakeReq('GET', '/api/proposals'));
    expect(r.statusCode).toBe(403);
  });
});

describe('GET /api/proposals — list + enabled flag', () => {
  it('returns pending proposals and the enabled flag', async () => {
    const f = newFakes();
    f.store.proposals.set('p1', {
      id: 'p1', kind: 'routing', targetTaskId: 't1', targetVersion: 3,
      payload: { agentName: 'Mona', why: 'x', confidence: 0.8 }, status: 'pending', version: 0, createdAt: '2026-01-01T00:00:00Z',
    });
    const r = await run(deps(f, { enabled: false }), fakeReq('GET', '/api/proposals'));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.enabled).toBe(false); // drives the off-state
    expect(body.proposals).toHaveLength(1);
  });
});

describe('POST /api/proposals/generate — flag-gated, on-demand', () => {
  it('FLAG-OFF refuses generation SERVER-SIDE (403), no proposal created', async () => {
    const f = newFakes();
    const r = await run(
      deps(f, { enabled: false }),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1' }) })
    );
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'the PM assistant is not enabled', code: 'pm_disabled' });
    expect(f.store.created).toEqual([]);
  });

  it('generate without CSRF → 403', async () => {
    const f = newFakes();
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { body: JSON.stringify({ taskId: 't1' }) }));
    expect(r.statusCode).toBe(403);
    expect(f.store.created).toEqual([]);
  });

  it('flag-on, task with an estimate + a hired candidate → persists a routing proposal', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    f.roster.hired = [{ agentId: 'agent-mona', name: 'Mona', status: 'active' }];
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1' }) }));
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.proposal.kind).toBe('routing');
    expect(body.proposal.targetVersion).toBe(3); // fenced to the task version at generation
    expect(f.store.created).toHaveLength(1);
  });

  it('a task with NO tier estimate → 200 proposal:null (honest no suggestion)', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask({ tierEstimate: null }));
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1' }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).proposal).toBeNull();
    expect(f.store.created).toEqual([]);
  });

  it('a FAIL-SOFT proposer (throws) → 200 proposal:null, never an error', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    f.roster.hired = [{ agentId: 'agent-mona', name: 'Mona', status: 'active' }];
    const throwing = {
      async proposeRouting() { throw new Error('LLM down'); },
      async proposeTriage() { throw new Error('LLM down'); },
      async proposeDecomposition() { throw new Error('LLM down'); },
    };
    const r = await run(deps(f, { proposer: throwing }), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1' }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).proposal).toBeNull();
  });

  it('generate for a missing task → 404', async () => {
    const f = newFakes();
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 'ghost' }) }));
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /api/proposals/:id/accept — routes through the binding method, fail-closed', () => {
  const routingProposal = (over: Partial<Proposal> = {}): Proposal => ({
    id: 'p1', kind: 'routing', targetTaskId: 't1', targetVersion: 3,
    payload: { agentName: 'Mona', why: 'x', confidence: 0.8 }, status: 'pending', version: 0, createdAt: '2026-01-01T00:00:00Z', ...over,
  });

  it('a proposed HIRED agent → resolves to its id and calls the binding accept (200)', async () => {
    const f = newFakes();
    f.store.proposals.set('p1', routingProposal());
    f.roster.hired = [{ agentId: 'agent-mona', name: 'Mona', status: 'active' }];
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/p1/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(f.store.accepted).toEqual([{ id: 'p1', agentId: 'agent-mona' }]);
  });

  it('FAIL-CLOSED: a proposed UNHIRED agent → 409 agent_not_hired, binding NEVER called', async () => {
    const f = newFakes();
    f.store.proposals.set('p1', routingProposal());
    f.roster.hired = []; // Mona is not hired
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/p1/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('agent_not_hired');
    expect(f.store.accepted).toEqual([]); // never routed to an unhired agent
  });

  it('accept maps the binding conflict outcome to 409', async () => {
    const f = newFakes();
    f.store.proposals.set('p1', routingProposal());
    f.roster.hired = [{ agentId: 'agent-mona', name: 'Mona', status: 'active' }];
    f.store.nextAccept = { ok: false, reason: 'conflict' };
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/p1/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('conflict');
  });

  it('accept of a missing proposal → 404', async () => {
    const f = newFakes();
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/ghost/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(404);
  });

  it('accept without CSRF → 403, binding never called', async () => {
    const f = newFakes();
    f.store.proposals.set('p1', routingProposal());
    f.roster.hired = [{ agentId: 'agent-mona', name: 'Mona', status: 'active' }];
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/p1/accept'));
    expect(r.statusCode).toBe(403);
    expect(f.store.accepted).toEqual([]);
  });
});

describe('POST /api/proposals/:id/dismiss', () => {
  it('dismisses a pending proposal (200), no binding effect', async () => {
    const f = newFakes();
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/p1/dismiss', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(f.store.dismissed).toEqual(['p1']);
    expect(f.store.accepted).toEqual([]);
  });

  it('a duplicate dismiss (already handled) → 409 conflict', async () => {
    const f = newFakes();
    f.store.nextDismiss = { ok: false, reason: 'conflict' };
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/p1/dismiss', { headers: csrf() }));
    expect(r.statusCode).toBe(409);
  });
});

describe('triage kind (W3-S1b)', () => {
  it('generate kind=triage persists a TRIAGE proposal from the tier proposer', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask({ tierEstimate: null })); // triage does NOT need a stored estimate
    const r = await run(
      deps(f),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'triage' }) })
    );
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.proposal.kind).toBe('triage');
    expect(body.proposal.payload.tier).toBe('hard');
    expect(f.store.created[0]!.targetVersion).toBe(3); // version-fenced to the task at generation
  });

  it('FLAG-OFF refuses triage generation server-side (403), no proposal created', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const r = await run(
      deps(f, { enabled: false }),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'triage' }) })
    );
    expect(r.statusCode).toBe(403);
    expect(f.store.created).toEqual([]);
  });

  it('a content-fetch failure → 200 proposal:null (fail-soft, no write)', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const failContent = { async fetch() { throw new Error('shortcut 500'); } };
    const r = await run(
      deps(f, { content: failContent }),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'triage' }) })
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).proposal).toBeNull();
    expect(f.store.created).toEqual([]);
  });

  it('an unknown kind → 400', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const r = await run(
      deps(f),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'banana' }) })
    );
    expect(r.statusCode).toBe(400);
  });

  it('accept of a triage proposal calls acceptTriageProposal with the tier — ONLY binding path', async () => {
    const f = newFakes();
    f.store.proposals.set('pt', {
      id: 'pt', kind: 'triage', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
      createdAt: '2026-01-01T00:00:00Z', payload: { tier: 'ultra', why: 'incident', confidence: 0.8 },
    });
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/pt/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(f.store.triaged).toEqual([{ id: 'pt', tier: 'ultra' }]);
    expect(f.store.accepted).toEqual([]); // never touched the routing path
  });

  it('accept of a triage proposal maps the version-fence conflict to 409', async () => {
    const f = newFakes();
    f.store.proposals.set('pt', {
      id: 'pt', kind: 'triage', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
      createdAt: '2026-01-01T00:00:00Z', payload: { tier: 'ultra', why: 'incident', confidence: 0.8 },
    });
    f.store.nextTriage = { ok: false, reason: 'conflict' };
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/pt/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).code).toBe('conflict');
  });
});

describe('decomposition kind (W3-S1c)', () => {
  it('generate kind=decomposition persists a DECOMPOSITION proposal from the LLM decomposer', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const r = await run(
      deps(f),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'decomposition' }) })
    );
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.proposal.kind).toBe('decomposition');
    expect(body.proposal.payload.children).toHaveLength(2);
  });

  it('FLAG-OFF refuses decomposition generation server-side (403)', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const r = await run(
      deps(f, { enabled: false }),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'decomposition' }) })
    );
    expect(r.statusCode).toBe(403);
    expect(f.store.created).toEqual([]);
  });

  it('a content-fetch failure → 200 proposal:null (the LLM never sees content, no write)', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const r = await run(
      deps(f, { content: { async fetch() { throw new Error('no story'); } } }),
      fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'decomposition' }) })
    );
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).proposal).toBeNull();
  });

  it('accept of a decomposition proposal calls acceptDecompositionProposal with the children — ONLY binding path', async () => {
    const f = newFakes();
    f.store.proposals.set('pd', {
      id: 'pd', kind: 'decomposition', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
      createdAt: '2026-01-01T00:00:00Z', payload: { children: [{ title: 'a', body: '' }, { title: 'b', body: '' }], why: 'split' },
    });
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/pd/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(200);
    expect(f.store.decomposed).toEqual([{ id: 'pd', count: 2 }]);
    expect(f.store.accepted).toEqual([]); // never touched routing
    expect(f.store.triaged).toEqual([]); // never touched triage
  });

  it('a malformed decomposition payload (empty children) → 409', async () => {
    const f = newFakes();
    f.store.proposals.set('pd', {
      id: 'pd', kind: 'decomposition', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
      createdAt: '2026-01-01T00:00:00Z', payload: { children: [], why: 'x' },
    });
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/pd/accept', { headers: csrf() }));
    expect(r.statusCode).toBe(409);
    expect(f.store.decomposed).toEqual([]);
  });
});

describe('usage context (W3-S4a) — the proposer call is attributed to the task/source', () => {
  function capturingProposer(captured: { ctx?: ReturnType<typeof currentUsageContext> }) {
    return {
      async proposeRouting() { return null; },
      async proposeTriage() { captured.ctx = currentUsageContext(); return { tier: 'hard' as const, why: 'x', confidence: 0.8 }; },
      async proposeDecomposition() { captured.ctx = currentUsageContext(); return { children: [{ title: 'a', body: '' }], why: 'x' }; },
    };
  }

  it('triage generation runs the proposer inside the usage context (source=triage)', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const captured: { ctx?: ReturnType<typeof currentUsageContext> } = {};
    await run(deps(f, { proposer: capturingProposer(captured) }), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'triage' }) }));
    expect(captured.ctx).toEqual({ orgId: 'org_default', taskId: 't1', source: 'triage' });
  });

  it('decomposition generation runs the proposer inside the usage context (source=decomposition)', async () => {
    const f = newFakes();
    f.store.tasks.set('t1', fakeTask());
    const captured: { ctx?: ReturnType<typeof currentUsageContext> } = {};
    await run(deps(f, { proposer: capturingProposer(captured) }), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ taskId: 't1', kind: 'decomposition' }) }));
    expect(captured.ctx).toEqual({ orgId: 'org_default', taskId: 't1', source: 'decomposition' });
  });
});

describe('standup kind (W3-S1d) — READ-ONLY, org-wide, no write', () => {
  it('generate kind=standup returns a summary of the org task states and persists NOTHING', async () => {
    const f = newFakes();
    f.store.statusCounts = { in_review: 1, done: 1, executing: 1, needs_attention: 1, failed: 1, routable: 1 };
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ kind: 'standup' }) }));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).standup).toEqual({ shipped: 2, inFlight: 1, needsYou: 2, queued: 1, total: 6 });
    // READ-ONLY: a standup creates no proposal + touches no binding write
    expect(f.store.created).toEqual([]);
    expect(f.store.accepted).toEqual([]);
    expect(f.store.triaged).toEqual([]);
    expect(f.store.decomposed).toEqual([]);
  });

  it('counts EVERY task (an aggregate, no pagination) — a large org is never under-counted', async () => {
    const f = newFakes();
    f.store.statusCounts = { done: 5000, needs_attention: 300 }; // far beyond any list cap
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ kind: 'standup' }) }));
    expect(JSON.parse(r.body).standup).toEqual({ shipped: 5000, inFlight: 0, needsYou: 300, queued: 0, total: 5300 });
  });

  it('standup needs NO taskId (it is org-wide)', async () => {
    const f = newFakes();
    const r = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ kind: 'standup' }) }));
    expect(r.statusCode).toBe(200); // not a 400 'taskId is required'
    expect(JSON.parse(r.body).standup.total).toBe(0);
  });

  it('FLAG-OFF refuses standup generation server-side (403)', async () => {
    const f = newFakes();
    const r = await run(deps(f, { enabled: false }), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ kind: 'standup' }) }));
    expect(r.statusCode).toBe(403);
  });

  it('standup requires CSRF + a session (no anonymous read of org task state)', async () => {
    const f = newFakes();
    const noCsrf = await run(deps(f), fakeReq('POST', '/api/proposals/generate', { body: JSON.stringify({ kind: 'standup' }) }));
    expect(noCsrf.statusCode).toBe(403);
    const noSession = await run(deps(f, { verifySession: () => null }), fakeReq('POST', '/api/proposals/generate', { headers: csrf(), body: JSON.stringify({ kind: 'standup' }) }));
    expect(noSession.statusCode).toBe(401);
  });
});
