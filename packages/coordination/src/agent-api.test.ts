import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  agentApiHandler,
  defaultTierForModel,
  tiersUpTo,
  type AgentApiDeps,
  type AgentCreator,
  type CreateAgentOutcome,
  type CreateAgentRequest,
} from './agent-api';
import type { RoleReader, OrgRole } from './membership';

// ── fakes (real state, no mocking framework) ─────────────────────────────────

/** A creator that records the call + returns a scripted outcome (the default = a successful create). */
class FakeCreator implements AgentCreator {
  calls: Array<{ orgId: string; req: CreateAgentRequest }> = [];
  next: CreateAgentOutcome | ((req: CreateAgentRequest) => CreateAgentOutcome) | null = null;

  async create(orgId: string, req: CreateAgentRequest): Promise<CreateAgentOutcome> {
    this.calls.push({ orgId, req });
    if (this.next === null) {
      return {
        ok: true,
        agent: { id: 'agent-new', name: req.name, vendor: req.vendor, model: req.model, maxTier: req.maxTier },
      };
    }
    return typeof this.next === 'function' ? this.next(req) : this.next;
  }
}

/** A membership reader with a settable active org + caller role (the tenant boundary + the gate). */
class FakeMembership implements RoleReader {
  activeOrg: string | null = 'org_default';
  role: OrgRole | null = 'member';
  async getActiveOrg() {
    return this.activeOrg;
  }
  async getRole() {
    return this.role;
  }
}

function fakeReq(
  method: string,
  url: string,
  opts: { headers?: Record<string, string | string[]>; body?: string } = {}
): IncomingMessage {
  const body = opts.body;
  return {
    method,
    url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8');
    },
  } as unknown as IncomingMessage;
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
const csrf = (extra: Record<string, string | string[]> = {}) => ({ cookie: `tasca_csrf=${TOK}`, 'x-csrf-token': TOK, ...extra });

function deps(over: Partial<AgentApiDeps> & { creator?: FakeCreator; membership?: FakeMembership } = {}): AgentApiDeps {
  return {
    creator: over.creator ?? new FakeCreator(),
    membership: over.membership ?? new FakeMembership(),
    verifySession: over.verifySession ?? (() => ({ userId: 'u1' })),
    ...(over.allowUnauthenticated !== undefined ? { allowUnauthenticated: over.allowUnauthenticated } : {}),
    ...(over.logger ? { logger: over.logger } : {}),
  };
}

async function run(d: AgentApiDeps, req: IncomingMessage) {
  const { captured, res } = fakeRes();
  const owned = await agentApiHandler(req, res, d);
  return { owned, ...captured, json: captured.body ? JSON.parse(captured.body) : undefined };
}

const post = (body: unknown, headers = csrf()) =>
  fakeReq('POST', '/api/agents', { headers, body: JSON.stringify(body) });

// ── pure helpers (no I/O) ────────────────────────────────────────────────────

describe('defaultTierForModel — the model→tier default table', () => {
  it.each([
    ['claude', 'claude-opus-4-8', 'ultra'],
    ['claude', 'claude-3-5-Sonnet', 'hard'],
    ['claude', 'claude-haiku-4-5', 'low'],
    ['openai', 'o1-preview', 'hard'],
    ['openai', 'gpt-4o', 'hard'],
    ['openai', 'gpt-4o-mini', 'low'],
    ['openai', 'gpt-3.5-turbo', 'low'],
    ['openai', 'some-future-model', 'medium'],
    ['local', 'qwen-2.5-coder', 'medium'],
    ['claude', 'unknown-claude', 'medium'],
  ] as const)('%s / %s → %s', (vendor, model, tier) => {
    expect(defaultTierForModel(vendor, model)).toBe(tier);
  });
});

describe('tiersUpTo — the eligibility ladder', () => {
  it('ultra covers all five tiers', () => {
    expect(tiersUpTo('ultra')).toEqual(['basic', 'low', 'medium', 'hard', 'ultra']);
  });
  it('low covers [basic, low]', () => {
    expect(tiersUpTo('low')).toEqual(['basic', 'low']);
  });
  it('basic covers only [basic]', () => {
    expect(tiersUpTo('basic')).toEqual(['basic']);
  });
  it('medium covers [basic, low, medium]', () => {
    expect(tiersUpTo('medium')).toEqual(['basic', 'low', 'medium']);
  });
});

// ── routing + gating ─────────────────────────────────────────────────────────

describe('agentApiHandler — routing + ownership', () => {
  it('does not own non-matching paths/methods', async () => {
    expect((await run(deps(), fakeReq('GET', '/api/agents'))).owned).toBe(false); // GET = read API
    expect((await run(deps(), fakeReq('POST', '/api/tasks'))).owned).toBe(false);
  });
});

describe('agentApiHandler — auth + CSRF gates', () => {
  it('401 without a valid session', async () => {
    const r = await run(deps({ verifySession: () => null }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(401);
  });

  it('503 when no verifier is wired and not explicitly opened', async () => {
    const creator = new FakeCreator();
    const r = await run(
      { creator, membership: new FakeMembership() },
      post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' })
    );
    expect(r.statusCode).toBe(503);
    expect(creator.calls).toEqual([]);
  });

  it('403 with no active-org membership — nothing created', async () => {
    const creator = new FakeCreator();
    const m = new FakeMembership();
    m.activeOrg = null;
    const r = await run(deps({ creator, membership: m }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(403);
    expect(creator.calls).toEqual([]);
  });

  it('POST without CSRF → 403, nothing created', async () => {
    const creator = new FakeCreator();
    const r = await run(deps({ creator }), fakeReq('POST', '/api/agents', { body: JSON.stringify({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }) }));
    expect(r.statusCode).toBe(403);
    expect(creator.calls).toEqual([]);
  });
});

describe('agentApiHandler — member+ gate (NOT admin)', () => {
  it('a MEMBER (the lowest role) CAN create (200) — create is member+, not admin-gated', async () => {
    const m = new FakeMembership();
    m.role = 'member';
    const creator = new FakeCreator();
    const r = await run(deps({ creator, membership: m }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(200);
    expect(creator.calls).toHaveLength(1);
  });

  it('a non-member (role null) → 403, nothing created', async () => {
    const m = new FakeMembership();
    m.role = null;
    const creator = new FakeCreator();
    const r = await run(deps({ creator, membership: m }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(403);
    expect(creator.calls).toEqual([]);
  });
});

describe('agentApiHandler — validation (400, nothing created)', () => {
  const bad: Array<[string, unknown]> = [
    ['empty name', { name: '   ', vendor: 'claude', model: 'm' }],
    ['too-long name', { name: 'a'.repeat(81), vendor: 'claude', model: 'm' }],
    ['bad vendor', { name: 'Elvis', vendor: 'anthropic', model: 'm' }],
    ['empty model', { name: 'Elvis', vendor: 'claude', model: '  ' }],
    ['too-long model', { name: 'Elvis', vendor: 'claude', model: 'a'.repeat(121) }],
    ['bad maxTier', { name: 'Elvis', vendor: 'claude', model: 'm', maxTier: 'godlike' }],
    ['non-url avatar', { name: 'Elvis', vendor: 'claude', model: 'm', avatarUrl: 'not a url' }],
  ];
  it.each(bad)('%s → 400, creator never called', async (_label, body) => {
    const creator = new FakeCreator();
    const r = await run(deps({ creator }), post(body));
    expect(r.statusCode).toBe(400);
    expect(creator.calls).toEqual([]);
  });

  it('an http(s) avatar URL is accepted', async () => {
    const creator = new FakeCreator();
    const r = await run(deps({ creator }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8', avatarUrl: 'https://cdn.example/a.png' }));
    expect(r.statusCode).toBe(200);
    expect(creator.calls[0]!.req.avatarUrl).toBe('https://cdn.example/a.png');
  });
});

describe('agentApiHandler — tier derivation vs override', () => {
  it('no maxTier → the model-derived default tier reaches the creator', async () => {
    const creator = new FakeCreator();
    const r = await run(deps({ creator }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(200);
    expect(creator.calls[0]!.req.maxTier).toBe('ultra'); // opus → ultra
    expect(r.json.maxTier).toBe('ultra');
  });

  it('an explicit maxTier OVERRIDES the derived default', async () => {
    const creator = new FakeCreator();
    const r = await run(deps({ creator }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8', maxTier: 'low' }));
    expect(r.statusCode).toBe(200);
    expect(creator.calls[0]!.req.maxTier).toBe('low'); // override beats opus→ultra
    expect(r.json.maxTier).toBe('low');
  });
});

describe('agentApiHandler — auto-hire targets the caller’s OWN active org', () => {
  it('the creator is called with the caller’s active org, never another', async () => {
    const creator = new FakeCreator();
    const m = new FakeMembership();
    m.activeOrg = 'org-caller';
    await run(deps({ creator, membership: m }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(creator.calls[0]!.orgId).toBe('org-caller');
  });
});

describe('agentApiHandler — creator outcomes', () => {
  it('returns 200 with {id,name,vendor,model,maxTier} on success', async () => {
    const r = await run(deps(), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ id: 'agent-new', name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8', maxTier: 'ultra' });
  });

  it('a hire not_found (vanished org) maps to 403', async () => {
    const creator = new FakeCreator();
    creator.next = { ok: false, reason: 'not_found' };
    const r = await run(deps({ creator }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(403);
  });

  it('a creator throw maps to 500 (logged)', async () => {
    const logged: string[] = [];
    const logger = { error: (m: string) => logged.push(m) };
    const creator = new FakeCreator();
    creator.next = () => {
      throw new Error('db down');
    };
    const r = await run(deps({ creator, logger }), post({ name: 'Elvis', vendor: 'claude', model: 'claude-opus-4-8' }));
    expect(r.statusCode).toBe(500);
    expect(logged.some((m) => m.includes('create failed'))).toBe(true);
  });
});
