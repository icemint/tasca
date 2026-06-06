import { describe, it, expect } from 'vitest';
import { createRequestHandler, type CoordinationServerDeps } from './server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AdapterEvent } from '@tasca/contracts';
import type { Task, TaskStatus, TierEstimate } from '@tasca/domain';
import type { CoordinationStore } from './store';
import type { WebhookVerifier, RawWebhook, VerifiedWebhook, StatusReporter, Logger } from './ports';
import type {
  AgentDirectory,
  AuditSink,
  TaskContentSource,
} from './orchestrate';
import type { ExecutionPort, AgentProcessHandle } from '@tasca/execution';

// Minimal store: counts distinct tasks (get-or-create by story) + a webhook
// processing-ledger. `failCreateOnce` simulates a crash mid-orchestration.
class CountingStore implements CoordinationStore {
  createdTasks = 0;
  failCreateOnce = false;
  private ledger = new Map<string, 'received' | 'processed'>();
  private tasksByStory = new Map<string, Task>();

  ledgerStatus(platform: string, externalEventId: string) {
    return this.ledger.get(`${platform}:${externalEventId}`);
  }

  async recordWebhookEvent(input: { platform: string; externalEventId: string }) {
    const key = `${input.platform}:${input.externalEventId}`;
    const existing = this.ledger.get(key);
    if (existing === undefined) {
      this.ledger.set(key, 'received');
      return { fresh: true, alreadyProcessed: false };
    }
    return { fresh: false, alreadyProcessed: existing === 'processed' };
  }
  async markWebhookProcessed(input: { platform: string; externalEventId: string }) {
    this.ledger.set(`${input.platform}:${input.externalEventId}`, 'processed');
  }
  async getOrCreateTask(input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }): Promise<Task> {
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new Error('db blip mid-orchestration');
    }
    const key = `${input.platform}:${input.externalStoryId}`;
    const existing = this.tasksByStory.get(key);
    if (existing) return existing;
    this.createdTasks += 1;
    const task: Task = {
      id: randomUUID(),
      externalStoryId: input.externalStoryId,
      platform: input.platform,
      status: 'routable',
      version: 0,
      claimedBy: null,
      failureCount: 0,
      repoRef: input.repoRef ?? null,
      tierEstimate: null,
    };
    this.tasksByStory.set(key, task);
    return task;
  }
  async getTask() { return null; }
  async setTierEstimate(_id: string, _e: TierEstimate) {}
  async setStatus(_id: string, _s: TaskStatus) {}
  async resetForRetry(_id: string) {}
  async incrementFailureCount() { return 1; }
  async recordRoutingDecision() {}
  async recordPullRequest() {}
  // read-side (unused by the webhook/intake tests)
  async listTasks() { return []; }
  async getRoutingDecisionForTask() { return null; }
  async listRoutingDecisions() { return []; }
  async listPullRequestsForTask() { return []; }
  async listConnections() { return []; }
}

const noopExecution: ExecutionPort = {
  async initDb() {},
  async reserveWorktree() { return { path: '/tmp', branch: 'b', repoPath: '/r' }; },
  spawnAgent(): AgentProcessHandle {
    return { pid: 1, onData() {}, onExit(l) { queueMicrotask(() => l(0)); }, onError() {}, kill() {} };
  },
  async openPr() { return { url: 'https://example/pr/1' }; },
  async close() {},
};

const noopStatus: StatusReporter = { async postStatus() {} };
const noopAudit: AuditSink = { async record() {} };
const noopContent: TaskContentSource = { async fetch() { return { title: 't', body: 'b' }; } };
// No eligible agents → orchestration stops at no_candidate (fine for intake tests).
const emptyDirectory: AgentDirectory = {
  async listCandidates() { return []; },
  async principalIdFor() { return null; },
};

function verifierFor(eventId: string): WebhookVerifier {
  const event: AdapterEvent = {
    type: 'task.assigned',
    platform: 'shortcut',
    externalStoryId: 'sc-1',
    agentExternalId: 'sc-agent',
  };
  return {
    verify(raw: RawWebhook): VerifiedWebhook | null {
      if (raw.headers['x-bad'] === '1') return null; // simulate a bad signature
      return { platform: 'shortcut', externalEventId: eventId, payload: {} };
    },
    parse(_v: VerifiedWebhook): AdapterEvent[] {
      return [event];
    },
  };
}

function makeServerDeps(
  store: CoordinationStore,
  verifier: WebhookVerifier,
  run: (w: () => Promise<void>) => void,
  logger?: Logger,
  githubVerifier?: WebhookVerifier,
  authHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
): CoordinationServerDeps {
  return {
    store,
    claim: { async tryClaim() { return { won: false, newVersion: null }; } },
    execution: noopExecution,
    status: noopStatus,
    directory: emptyDirectory,
    audit: noopAudit,
    content: noopContent,
    verifier,
    runAsync: run,
    ...(logger ? { logger } : {}),
    ...(githubVerifier ? { githubVerifier } : {}),
    ...(authHandler ? { authHandler } : {}),
  };
}

// Build a fake req/res pair driving the handler.
function fakeReq(method: string, url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method: string }).method = method;
  (req as { url: string }).url = url;
  (req as { headers: Record<string, string> }).headers = headers;
  (req as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

interface CapturedRes {
  statusCode: number;
  body: string;
  res: ServerResponse;
}
function fakeRes(): CapturedRes {
  const captured: CapturedRes = { statusCode: 0, body: '', res: undefined as unknown as ServerResponse };
  const res = {
    headersSent: false,
    writeHead(code: number) {
      captured.statusCode = code;
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  } as unknown as ServerResponse;
  captured.res = res;
  return captured;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('coordination HTTP entry (node:http handler)', () => {
  it('GET /healthz → 200 ok', async () => {
    const store = new CountingStore();
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
    const res = fakeRes();
    await handle(fakeReq('GET', '/healthz', ''), res.res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('rejects an unverifiable webhook with 401 and creates no task', async () => {
    const store = new CountingStore();
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
    const res = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{}', { 'x-bad': '1' }), res.res);
    expect(res.statusCode).toBe(401);
    expect(store.createdTasks).toBe(0);
  });

  it('redelivery of a PROCESSED event → 200 duplicate, schedules no new work', async () => {
    const store = new CountingStore();
    const work: Array<() => Promise<void>> = [];
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('evt-dup'), (w) => work.push(w)));

    const r1 = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-dup"}'), r1.res);
    expect(r1.statusCode).toBe(202);
    // Drain → orchestration runs → ledger flips to processed.
    expect(work).toHaveLength(1);
    for (const w of work) await w();
    await flush();
    expect(store.ledgerStatus('shortcut', 'evt-dup')).toBe('processed');

    work.length = 0;
    const r2 = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-dup"}'), r2.res);
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toBe('duplicate');
    expect(work).toHaveLength(0); // no re-drive of an already-processed event
    expect(store.createdTasks).toBe(1);
  });

  it('two deliveries for the same story before processing → both proceed, get-or-create yields ONE task', async () => {
    // Distinct event ids, same story (a re-assignment delivered twice). Neither is
    // "processed" yet, so both re-drive — exactly-one-task is guaranteed by
    // get-or-create + the CAS, not by the webhook ledger.
    const store = new CountingStore();
    const work: Array<() => Promise<void>> = [];
    const handle1 = createRequestHandler(makeServerDeps(store, verifierFor('evt-a'), (w) => work.push(w)));
    const handle2 = createRequestHandler(makeServerDeps(store, verifierFor('evt-b'), (w) => work.push(w)));

    const r1 = fakeRes();
    await handle1(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-a"}'), r1.res);
    const r2 = fakeRes();
    await handle2(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-b"}'), r2.res);
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);

    expect(work).toHaveLength(2);
    for (const w of work) await w();
    await flush();
    expect(store.createdTasks).toBe(1);
  });

  it('crash before task creation leaves the ledger received → redelivery re-drives and creates the task', async () => {
    // must-fix #2 regression: a post-record failure must NOT silently consume the
    // event id. The first attempt throws (db blip) before the task is created;
    // the ledger stays `received`; a redelivery of the SAME event id re-drives.
    const store = new CountingStore();
    store.failCreateOnce = true;
    const errors: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const logger: Logger = { error: (msg, ctx) => errors.push({ msg, ...(ctx ? { ctx } : {}) }) };
    const work: Array<() => Promise<void>> = [];
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('evt-crash'), (w) => work.push(w), logger));

    const r1 = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-crash"}'), r1.res);
    expect(r1.statusCode).toBe(202);
    for (const w of work) await w(); // first orchestration throws
    await flush();

    // Failure was observable, and the ledger was NOT advanced to processed.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.ctx).toMatchObject({ externalEventId: 'evt-crash' });
    expect(store.ledgerStatus('shortcut', 'evt-crash')).toBe('received');
    expect(store.createdTasks).toBe(0);

    // Redelivery is NOT treated as a duplicate (it never processed) → re-drives.
    work.length = 0;
    const r2 = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-crash"}'), r2.res);
    expect(r2.statusCode).toBe(202);
    expect(work).toHaveLength(1);
    for (const w of work) await w();
    await flush();
    expect(store.createdTasks).toBe(1);
    expect(store.ledgerStatus('shortcut', 'evt-crash')).toBe('processed');
  });

  it('unknown route → 404', async () => {
    const store = new CountingStore();
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
    const res = fakeRes();
    await handle(fakeReq('GET', '/nope', ''), res.res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /webhooks/github → 404 when no github verifier is configured', async () => {
    const store = new CountingStore();
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
    const res = fakeRes();
    await handle(fakeReq('POST', '/webhooks/github', '{}'), res.res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /webhooks/github → 202 + orchestrates when a github verifier is wired', async () => {
    const store = new CountingStore();
    const work: Array<() => Promise<void>> = [];
    const ghEvent: AdapterEvent = {
      type: 'task.assigned', platform: 'github', externalStoryId: 'icemint/demo#42', agentExternalId: '5550001',
    };
    const ghVerifier: WebhookVerifier = {
      verify: (raw) => (raw.headers['x-bad'] === '1'
        ? null
        : { platform: 'github', externalEventId: 'gh-delivery-1', payload: {} }),
      parse: () => [ghEvent],
    };
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('sc-1'), (w) => work.push(w), undefined, ghVerifier)
    );

    const r = fakeRes();
    await handle(fakeReq('POST', '/webhooks/github', '{"x":1}'), r.res);
    expect(r.statusCode).toBe(202);
    expect(work).toHaveLength(1);
    for (const w of work) await w();
    await flush();
    expect(store.createdTasks).toBe(1);
    expect(store.ledgerStatus('github', 'gh-delivery-1')).toBe('processed');
  });

  it('GET /api/auth/* → 404 when no auth handler is wired (flag OFF)', async () => {
    const store = new CountingStore();
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
    const res = fakeRes();
    await handle(fakeReq('GET', '/api/auth/me', ''), res.res);
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/auth/* → consults an injected auth handler when wired', async () => {
    const store = new CountingStore();
    let consultedUrl: string | undefined;
    const authHandler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      consultedUrl = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"authenticated":false}');
      return true;
    };
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('e1'), (w) => void w(), undefined, undefined, authHandler)
    );
    const res = fakeRes();
    await handle(fakeReq('GET', '/api/auth/me', ''), res.res);
    expect(consultedUrl).toBe('/api/auth/me');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"authenticated":false}');
  });

  it('falls through to 404 when the auth handler declines (returns false)', async () => {
    const store = new CountingStore();
    const declining = async (): Promise<boolean> => false;
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('e1'), (w) => void w(), undefined, undefined, declining)
    );
    const res = fakeRes();
    await handle(fakeReq('GET', '/some/other/path', ''), res.res);
    expect(res.statusCode).toBe(404);
  });

  it('POST /webhooks/github → 401 on a bad signature', async () => {
    const store = new CountingStore();
    const ghVerifier: WebhookVerifier = {
      verify: (raw) => (raw.headers['x-bad'] === '1' ? null : { platform: 'github', externalEventId: 'g', payload: {} }),
      parse: () => [],
    };
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('sc-1'), (w) => void w(), undefined, ghVerifier)
    );
    const res = fakeRes();
    await handle(fakeReq('POST', '/webhooks/github', '{}', { 'x-bad': '1' }), res.res);
    expect(res.statusCode).toBe(401);
    expect(store.createdTasks).toBe(0);
  });
});
