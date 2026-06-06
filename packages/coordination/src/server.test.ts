import { describe, it, expect } from 'vitest';
import { createRequestHandler, type CoordinationServerDeps } from './server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AdapterEvent } from '@tasca/contracts';
import type { Task, TaskStatus, TierEstimate } from '@tasca/domain';
import type { CoordinationStore } from './store';
import type { WebhookVerifier, RawWebhook, VerifiedWebhook, StatusReporter } from './ports';
import type {
  AgentDirectory,
  AuditSink,
  TaskContentSource,
} from './orchestrate';
import type { ExecutionPort, AgentProcessHandle } from '@tasca/execution';

// Minimal store that counts task creations + enforces webhook idempotency.
class CountingStore implements CoordinationStore {
  createdTasks = 0;
  private seen = new Set<string>();
  async recordWebhookEvent(input: { platform: string; externalEventId: string }) {
    const key = `${input.platform}:${input.externalEventId}`;
    if (this.seen.has(key)) return { fresh: false };
    this.seen.add(key);
    return { fresh: true };
  }
  async createTask(input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }): Promise<Task> {
    this.createdTasks += 1;
    return {
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
  }
  async getTask() { return null; }
  async setTierEstimate(_id: string, _e: TierEstimate) {}
  async setStatus(_id: string, _s: TaskStatus) {}
  async incrementFailureCount() { return 1; }
  async recordRoutingDecision() {}
  async recordPullRequest() {}
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

function makeServerDeps(store: CoordinationStore, verifier: WebhookVerifier, run: (w: () => Promise<void>) => void): CoordinationServerDeps {
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

  it('idempotent intake: the same event id twice creates exactly one task', async () => {
    const store = new CountingStore();
    const work: Array<() => Promise<void>> = [];
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('evt-dup'), (w) => work.push(w)));

    const r1 = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-dup"}'), r1.res);
    expect(r1.statusCode).toBe(202);

    const r2 = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-dup"}'), r2.res);
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toBe('duplicate');

    // Drain the one scheduled orchestration; the duplicate scheduled nothing.
    expect(work).toHaveLength(1);
    for (const w of work) await w();
    await flush();

    expect(store.createdTasks).toBe(1);
  });

  it('unknown route → 404', async () => {
    const store = new CountingStore();
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
    const res = fakeRes();
    await handle(fakeReq('GET', '/nope', ''), res.res);
    expect(res.statusCode).toBe(404);
  });
});
