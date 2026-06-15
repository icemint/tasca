import { describe, it, expect } from 'vitest';
import { createRequestHandler, type CoordinationServerDeps } from './server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import {
  ConnectionCredentialResolver,
  sealVendorKey,
  type SealedCredential,
  type SealedConnectionCredentialReader,
  type ConnectionCredentialKind,
} from './vendor-credential';
import type { AdapterEvent, TaskAssignedEvent } from '@tasca/contracts';
import type { Task, TaskStatus, TierEstimate } from '@tasca/domain';
import type { CoordinationStore, TaskWriteOutcome, Proposal, CreateProposalInput, ProposalWriteOutcome, TaskOrigin } from './store';
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

  // A connected workspace (slice 5c): returns the bound org. The webhook tests exercise the
  // connected happy path; an unconnected github workspace (null) would fail closed (its own test).
  connectionOrg: string | null = 'org_default';
  async getOrgForConnection(_platform: Task['platform'], _workspaceId: string) {
    return this.connectionOrg;
  }
  async getOrgForTask(_taskId: string) {
    return 'org_default';
  }
  async recordWebhookEvent(_orgId: string, input: { platform: string; externalEventId: string }) {
    const key = `${input.platform}:${input.externalEventId}`;
    const existing = this.ledger.get(key);
    if (existing === undefined) {
      this.ledger.set(key, 'received');
      return { fresh: true, alreadyProcessed: false };
    }
    return { fresh: false, alreadyProcessed: existing === 'processed' };
  }
  async markWebhookProcessed(_orgId: string, input: { platform: string; externalEventId: string }) {
    this.ledger.set(`${input.platform}:${input.externalEventId}`, 'processed');
  }
  createdTaskOrgs: string[] = []; // the org each task was created under (regression: connection-scoped → connection's org)
  async getOrCreateTask(orgId: string, input: { externalStoryId: string; platform: Task['platform']; repoRef?: string | null }): Promise<Task> {
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new Error('db blip mid-orchestration');
    }
    const key = `${input.platform}:${input.externalStoryId}`;
    this.createdTaskOrgs.push(orgId);
    const existing = this.tasksByStory.get(key);
    if (existing) return existing;
    this.createdTasks += 1;
    const task: Task = {
      id: randomUUID(),
      externalStoryId: input.externalStoryId,
      title: null,
      platform: input.platform,
      status: 'routable',
      version: 0,
      claimedBy: null,
      failureCount: 0,
      repoRef: input.repoRef ?? null,
      tierEstimate: null,
      lastError: null,
      preferredAgentId: null,
      emCleared: false,
      emClarificationRound: 0,
    };
    this.tasksByStory.set(key, task);
    return task;
  }
  async getOrCreateProject() { return 'proj_x'; }
  async listProjects() { return []; }
  async getActiveProject() { return null; }
  async setActiveProject(): Promise<'ok' | 'not_found'> { return 'ok'; }
  async clearActiveProject(): Promise<void> {}
  async createManager(): Promise<{ managerId: string }> { return { managerId: 'mgr_x' }; }
  async getManager() { return null; }
  async listManagers() { return []; }
  async setManagerShortcutIdentity(): Promise<void> {}
  async setProjectManager(): Promise<'ok' | 'not_found'> { return 'ok'; }
  async getManagerForProject(): Promise<string | null> { return null; }
  async getTask() { return null; }
  async getTaskOrigin(): Promise<TaskOrigin | null> { return null; }
  async setTierEstimate(_org: string, _id: string, _e: TierEstimate) {}
  async setTaskTitle(_org: string, _id: string, _title: string) {}
  async setStatus(_org: string, _id: string, _s: TaskStatus) {}
  async recordFailureAndTransition(_org: string, _id: string, threshold: number) {
    return { failureCount: 1, tripped: 1 >= threshold };
  }
  async recordRunnerFailure(_org: string, _id: string, threshold: number) {
    return { acted: true, failureCount: 1, tripped: 1 >= threshold };
  }
  async recordRoutingDecision() {}
  async recordPullRequest() {}
  async markPullRequestMerged() {}
  async getTaskIdByPullRequestUrl() { return null; }
  async escalateTask(): Promise<TaskWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async overrideTierEstimate(): Promise<TaskWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async reassignTask(): Promise<TaskWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async interruptTask(): Promise<TaskWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async forceResetTask(): Promise<TaskWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async failNoCapacity(): Promise<boolean> { return false; }
  async retireNoChanges(): Promise<boolean> { return false; }
  async upsertGitHubInstallation() {}
  async getInstallationIdForOwner() { return null; }
  async updateInstallationByAccount() { return false; }
  async revokeInstallationByAccount() { return false; }
  async upsertShortcutConnection() { return { connectionId: 'conn_x' }; }
  // Connection-scoped intake (slice SC-1): null = unknown/revoked connection (404). Set a value to
  // route a delivery to that connection's org + repo.
  shortcutConnection: { orgId: string; repoRef: string | null } | null = null;
  async getShortcutConnectionById(_connectionId: string) { return this.shortcutConnection; }
  async projectExistsInOrg() { return true; }
  taskFor(platform: string, externalStoryId: string) {
    return this.tasksByStory.get(`${platform}:${externalStoryId}`);
  }
  async retireUnroutable() { return false; }
  async markEmCleared() {}
  async parkAwaitingClarification() { return false; }
  async updateBlockReason() { return false; }
  // EM reply-resume (slice 3): a settable parked task lets the connection-route test exercise the resume
  // path; awaitClarificationCalls / resumeCalls record the org-scoped calls the handler made.
  parkedTask: Task | null = null;
  awaitClarificationCalls: Array<{ orgId: string; externalStoryId: string }> = [];
  resumeCalls: string[] = [];
  async getAwaitingClarificationTask(orgId: string, _platform: Task['platform'], externalStoryId: string) {
    this.awaitClarificationCalls.push({ orgId, externalStoryId });
    return this.parkedTask;
  }
  async resumeFromClarification(_orgId: string, taskId: string) {
    this.resumeCalls.push(taskId);
    return this.parkedTask?.id === taskId;
  }
  // read-side (unused by the webhook/intake tests)
  async listTasks() { return []; }
  async getTaskStatusCounts() { return {}; }
  async recordUsage() {}
  async getUsage() { return { inputTokens: 0, outputTokens: 0, bySource: {} }; }
  async getRoutingDecisionForTask() { return null; }
  async listRoutingDecisions() { return []; }
  async listPullRequestsForTask(_orgId: string, _taskId: string) { return []; }
  async listConnections() { return []; }
  async listProposals() { return []; }
  async getProposal() { return null; }
  async createProposal(_orgId: string, input: CreateProposalInput): Promise<Proposal> {
    return { id: 'p', kind: input.kind, targetTaskId: input.targetTaskId, targetVersion: input.targetVersion, payload: input.payload, status: 'pending', version: 0, createdAt: '2026-01-01T00:00:00Z' };
  }
  async dismissProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async acceptRoutingProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async acceptTriageProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
  async acceptDecompositionProposal(): Promise<ProposalWriteOutcome> { return { ok: false, reason: 'not_found' }; }
}

const noopExecution: ExecutionPort = {
  async initDb() {},
  async reserveWorktree() { return { path: '/tmp', branch: 'b', repoPath: '/r' }; },
  spawnAgent(): AgentProcessHandle {
    return { pid: 1, onData() {}, onExit(l) { queueMicrotask(() => l(0)); }, onError() {}, kill() {} };
  },
  killAgent() {},
  async openPr() { return { url: 'https://example/pr/1' }; },
  async commitAgentWork() { return { changed: true }; },
  async close() {},
};

const noopStatus: StatusReporter = { async postStatus() {} };
const noopAudit: AuditSink = { async record() {} };
const noopContent: TaskContentSource = { async fetch() { return { title: 't', body: 'b' }; } };
// No eligible agents → orchestration stops at no_candidate (fine for intake tests).
const emptyDirectory: AgentDirectory = {
  async listCandidates() { return []; },
  async findHiredAgentByName() { return null; },
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
  authHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  connection?: { resolver: ConnectionCredentialResolver; registeredShortcutIds: ReadonlySet<string> }
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
    ...(connection
      ? {
          connectionCredentialResolver: connection.resolver,
          registeredShortcutIds: connection.registeredShortcutIds,
        }
      : {}),
  };
}

// ── Connection-scoped Shortcut intake helpers (slice SC-1) ───────────────────
const CONN_MASTER = randomBytes(32);
const CONN_WEBHOOK_SECRET = 'connection-webhook-secret-do-not-leak';
const SC_AGENT_ID = 'sc-agent-uuid';

/** A reader that returns the sealed webhook secret for any connection (the resolver opens it). */
function connReaderFor(secret: string | null): SealedConnectionCredentialReader {
  const sealed: SealedCredential | null = secret === null ? null : sealVendorKey(secret, CONN_MASTER);
  return {
    async getSealedConnectionCredential(_org: string, _conn: string, _kind: ConnectionCredentialKind) {
      return sealed;
    },
  };
}

/** A real signed Shortcut delivery: an `update` action adding SC_AGENT_ID as a story owner → one
 *  task.assigned event for story `storyId`. Signed with `secret` so the real ShortcutAdapter verifies. */
function signedShortcutReq(connectionId: string, storyId: string, secret: string, eventId: string): IncomingMessage {
  const body = JSON.stringify({
    id: eventId,
    changed_at: '2026-06-14T00:00:00Z',
    member_id: 'human-actor',
    primary_id: storyId,
    actions: [{ id: storyId, entity_type: 'story', action: 'update', changes: { owner_ids: { adds: [SC_AGENT_ID] } } }],
  });
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return fakeReq('POST', `/webhooks/shortcut/${connectionId}`, body, { 'payload-signature': signature });
}

/** A real signed Shortcut delivery: a story-comment CREATE → one task.clarification_reply (EM v1 slice 3).
 *  The real Shortcut shape: the comment-create action carries the commenter as author_id; the parent
 *  story is the companion story-update action's id (the envelope primary_id is the COMMENT id). */
function signedShortcutCommentReq(connectionId: string, storyId: string, secret: string, eventId: string, commenter: string): IncomingMessage {
  const body = JSON.stringify({
    id: eventId,
    changed_at: '2026-06-14T00:00:00Z',
    member_id: commenter,
    primary_id: 'comment-1', // the envelope primary_id is the comment id, not the story
    actions: [
      { id: 'comment-1', entity_type: 'story-comment', action: 'create', author_id: commenter },
      { id: storyId, entity_type: 'story', action: 'update', changes: { comment_ids: { adds: ['comment-1'] } } },
    ],
  });
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return fakeReq('POST', `/webhooks/shortcut/${connectionId}`, body, { 'payload-signature': signature });
}

// Build a fake req/res pair driving the handler.
function fakeReq(method: string, url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  (req as { method: string }).method = method;
  (req as { url: string }).url = url;
  (req as { headers: Record<string, string> }).headers = headers;
  (req as { destroy: () => void }).destroy = () => {};
  // Emit the body only once an `end` listener is attached — readRawBody may register its listeners
  // after one or more awaits (the connection-scoped route resolves the connection + secret first), so a
  // fixed queueMicrotask would fire before the listeners exist and the read would hang. Driving off
  // 'newListener' makes the stream deliver regardless of how many awaits precede readRawBody.
  let emitted = false;
  emitter.on('newListener', (event) => {
    if (event !== 'end' || emitted) return;
    emitted = true;
    queueMicrotask(() => {
      if (body) emitter.emit('data', Buffer.from(body));
      emitter.emit('end');
    });
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

  it('GET /version → 200 with the baked build SHA (the CD deploy gate verifies the live container against this)', async () => {
    const prev = process.env.TASCA_GIT_SHA;
    process.env.TASCA_GIT_SHA = 'abc1234';
    try {
      const store = new CountingStore();
      const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
      const res = fakeRes();
      await handle(fakeReq('GET', '/version', ''), res.res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('abc1234');
    } finally {
      if (prev === undefined) delete process.env.TASCA_GIT_SHA;
      else process.env.TASCA_GIT_SHA = prev;
    }
  });

  it('GET /version → "unknown" when no build SHA is baked in (local/dev image)', async () => {
    const prev = process.env.TASCA_GIT_SHA;
    delete process.env.TASCA_GIT_SHA;
    try {
      const store = new CountingStore();
      const handle = createRequestHandler(makeServerDeps(store, verifierFor('e1'), (w) => void w()));
      const res = fakeRes();
      await handle(fakeReq('GET', '/version', ''), res.res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('unknown');
    } finally {
      if (prev !== undefined) process.env.TASCA_GIT_SHA = prev;
    }
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

  it('drops a malformed adapter event via AdapterEventSchema — never orchestrated', async () => {
    // A verifier that emits a schema-invalid event (empty externalStoryId). The
    // server must validate at the boundary and drop it before getOrCreateTask.
    const store = new CountingStore();
    const work: Array<() => Promise<void>> = [];
    const badVerifier: WebhookVerifier = {
      verify: () => ({ platform: 'shortcut', externalEventId: 'evt-bad', payload: {} }),
      parse: () => [
        { type: 'task.assigned', platform: 'shortcut', externalStoryId: '', agentExternalId: 'a' } as AdapterEvent,
      ],
    };
    const handle = createRequestHandler(makeServerDeps(store, badVerifier, (w) => work.push(w)));
    const r = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-bad"}'), r.res);
    expect(r.statusCode).toBe(202); // accepted (fast-ack), but the event is dropped
    for (const w of work) await w();
    await flush();
    expect(store.createdTasks).toBe(0); // malformed → never reached getOrCreateTask
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

  it('FAIL-CLOSED: a github webhook for an UNCONNECTED workspace is dropped (202, no ledger, no orchestration)', async () => {
    const store = new CountingStore();
    store.connectionOrg = null; // the github workspace has no platform_connection
    const work: Array<() => Promise<void>> = [];
    const ghEvent: AdapterEvent = {
      type: 'task.assigned', platform: 'github', externalStoryId: 'stranger/repo#1', agentExternalId: '5550001',
    };
    const ghVerifier: WebhookVerifier = {
      verify: () => ({ platform: 'github', externalEventId: 'gh-unbound-1', payload: {} }),
      parse: () => [ghEvent],
    };
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('sc-x'), (w) => work.push(w), undefined, ghVerifier));
    const r = fakeRes();
    await handle(fakeReq('POST', '/webhooks/github', '{"x":1}'), r.res);
    expect(r.statusCode).toBe(202); // acked so GitHub doesn't retry-storm
    expect(work).toHaveLength(0); // nothing scheduled — not orchestrated
    expect(store.createdTasks).toBe(0); // no task in the default org
    expect(store.ledgerStatus('github', 'gh-unbound-1')).toBeUndefined(); // no ledger row
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

  it('default scheduler (no runAsync injected): a rejected post-ack run still 202s, is logged, and never escapes as unhandledRejection', async () => {
    // Exercises the DEFAULT queueMicrotask scheduler + its last-resort `.catch`.
    // The store throws inside the post-ack work; the request must still ack 202,
    // the failure must be logged via the injected logger, and no unhandledRejection
    // may escape the process.
    const store = new CountingStore();
    store.failCreateOnce = true; // getOrCreateTask throws inside the post-ack work
    const errors: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const logger: Logger = { error: (msg, ctx) => errors.push({ msg, ...(ctx ? { ctx } : {}) }) };

    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.once('unhandledRejection', onUnhandled);
    try {
      // No runAsync passed → the default scheduler is used.
      const handle = createRequestHandler({
        store,
        claim: { async tryClaim() { return { won: false, newVersion: null }; } },
        execution: noopExecution,
        status: noopStatus,
        directory: emptyDirectory,
        audit: noopAudit,
        content: noopContent,
        verifier: verifierFor('evt-default-sched'),
        logger,
      });
      const r = fakeRes();
      await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-default-sched"}'), r.res);
      expect(r.statusCode).toBe(202); // ack is independent of the post-ack work

      // Let the queued microtask (and its `.catch`) run to completion.
      await flush();
      await flush();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toBeUndefined(); // the rejection was caught, not leaked
    // The failure was observed at the boundary, with the throwing run logged.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.msg.includes('orchestration failed after ack'))).toBe(true);
    // The orchestration never completed, so the ledger stayed `received`.
    expect(store.ledgerStatus('shortcut', 'evt-default-sched')).toBe('received');
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

describe('connection-scoped Shortcut intake (slice SC-1)', () => {
  const ids = new Set([SC_AGENT_ID]);

  it('valid connection + signature → 202; the task gets the connection’s org + repo (repo-link)', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: 'eltexsoft/widget-api' };
    const work: Array<() => Promise<void>> = [];
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('unused'), (w) => work.push(w), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    await handle(signedShortcutReq('conn-1', 'story-42', CONN_WEBHOOK_SECRET, 'evt-sc1'), r.res);
    expect(r.statusCode).toBe(202);
    expect(work).toHaveLength(1);
    for (const w of work) await w();
    await flush();

    expect(store.createdTasks).toBe(1);
    const task = store.taskFor('shortcut', 'story-42');
    expect(task).toBeDefined();
    // repo-link: the connection's project repo_ref is stamped onto the task (Shortcut carries none).
    expect(task!.repoRef).toBe('eltexsoft/widget-api');
    // org-link (regression): the TASK is created under the CONNECTION's org, NOT the grandfather
    // default tenant. A Shortcut event carries no workspace, so orchestrate must NOT re-resolve the
    // org from the event (which would fall to org_default and orphan the task from the org's roster) —
    // it uses the edge-resolved connection org that the ledger row also used.
    expect(store.createdTaskOrgs).toEqual(['org-eltexsoft']);
    expect(store.ledgerStatus('shortcut', 'evt-sc1')).toBe('processed');
  });

  it('an Unassigned-project connection (null repo) → task repoRef stays null (no crash)', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: null };
    const work: Array<() => Promise<void>> = [];
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('unused'), (w) => work.push(w), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    await handle(signedShortcutReq('conn-1', 'story-7', CONN_WEBHOOK_SECRET, 'evt-sc-null'), r.res);
    expect(r.statusCode).toBe(202);
    for (const w of work) await w();
    await flush();
    expect(store.taskFor('shortcut', 'story-7')!.repoRef).toBeNull();
  });

  it('unknown / revoked connection → 404, no task, never the default tenant', async () => {
    const store = new CountingStore();
    store.shortcutConnection = null; // getShortcutConnectionById resolves nothing
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('unused'), (w) => void w(), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    await handle(signedShortcutReq('conn-unknown', 'story-1', CONN_WEBHOOK_SECRET, 'evt-x'), r.res);
    expect(r.statusCode).toBe(404);
    expect(store.createdTasks).toBe(0);
  });

  it('bad signature → 401 (fail closed), no task', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: 'eltexsoft/widget-api' };
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('unused'), (w) => void w(), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    // Signed with the WRONG secret → the per-connection verifier rejects.
    await handle(signedShortcutReq('conn-1', 'story-1', 'the-wrong-secret', 'evt-bad'), r.res);
    expect(r.statusCode).toBe(401);
    expect(store.createdTasks).toBe(0);
  });

  it('connection with NO sealed webhook secret → 401 (fail closed)', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: 'eltexsoft/widget-api' };
    const resolver = new ConnectionCredentialResolver(connReaderFor(null), CONN_MASTER); // no secret stored
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('unused'), (w) => void w(), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    await handle(signedShortcutReq('conn-1', 'story-1', CONN_WEBHOOK_SECRET, 'evt-nosecret'), r.res);
    expect(r.statusCode).toBe(401);
    expect(store.createdTasks).toBe(0);
  });

  it('connection surface unconfigured (no resolver) → 404 (route not wired)', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: 'eltexsoft/widget-api' };
    const handle = createRequestHandler(makeServerDeps(store, verifierFor('unused'), (w) => void w()));
    const r = fakeRes();
    await handle(signedShortcutReq('conn-1', 'story-1', CONN_WEBHOOK_SECRET, 'evt-unwired'), r.res);
    expect(r.statusCode).toBe(404);
    expect(store.createdTasks).toBe(0);
  });

  it('the legacy /webhooks/shortcut env-secret route is unchanged (still verifies via the injected verifier)', async () => {
    const store = new CountingStore();
    const work: Array<() => Promise<void>> = [];
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('evt-legacy'), (w) => work.push(w), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    await handle(fakeReq('POST', '/webhooks/shortcut', '{"id":"evt-legacy"}'), r.res);
    expect(r.statusCode).toBe(202); // the stub verifier still owns the legacy exact path
    for (const w of work) await w();
    await flush();
    expect(store.createdTasks).toBe(1);
  });

  it('stamps the connection id + repoHint onto the event that reaches content.fetch (slice SC-2)', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: 'eltexsoft/widget-api' };
    const work: Array<() => Promise<void>> = [];
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    // Capture the event the content source is handed — it must carry the connection id (so the shortcut
    // content source can resolve the read token) AND the connection's repoHint, stamped post-parse.
    const seen: TaskAssignedEvent[] = [];
    const capturingContent: TaskContentSource = {
      async fetch(event) {
        seen.push(event);
        return { title: event.externalStoryId, body: '' };
      },
    };
    const deps = makeServerDeps(store, verifierFor('unused'), (w) => work.push(w), undefined, undefined, undefined, {
      resolver,
      registeredShortcutIds: ids,
    });
    const handle = createRequestHandler({ ...deps, content: capturingContent });
    const r = fakeRes();
    await handle(signedShortcutReq('conn-1', 'story-42', CONN_WEBHOOK_SECRET, 'evt-stamp'), r.res);
    expect(r.statusCode).toBe(202);
    for (const w of work) await w();
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.shortcutConnectionId).toBe('conn-1');
    expect(seen[0]!.repoHint).toBe('eltexsoft/widget-api');
  });

  it('a story-comment reply on the connection route → routes to the EM resume handler (slice 3)', async () => {
    const store = new CountingStore();
    store.shortcutConnection = { orgId: 'org-eltexsoft', repoRef: 'eltexsoft/widget-api' };
    // Seed the parked task the handler resolves + resumes (the connection org owns it).
    store.parkedTask = {
      id: 'task-parked',
      externalStoryId: 'story-99',
      title: null,
      platform: 'shortcut',
      status: 'awaiting_clarification',
      version: 1,
      claimedBy: null,
      failureCount: 0,
      repoRef: 'eltexsoft/widget-api',
      tierEstimate: null,
      lastError: null,
      preferredAgentId: null,
      emCleared: false,
      emClarificationRound: 1,
    };
    const work: Array<() => Promise<void>> = [];
    const resolver = new ConnectionCredentialResolver(connReaderFor(CONN_WEBHOOK_SECRET), CONN_MASTER);
    const handle = createRequestHandler(
      makeServerDeps(store, verifierFor('unused'), (w) => work.push(w), undefined, undefined, undefined, {
        resolver,
        registeredShortcutIds: ids,
      })
    );
    const r = fakeRes();
    await handle(signedShortcutCommentReq('conn-1', 'story-99', CONN_WEBHOOK_SECRET, 'evt-reply', 'human-actor'), r.res);
    expect(r.statusCode).toBe(202);
    for (const w of work) await w();
    await flush();
    // The resume handler ran, org-scoped to the connection's org, and resumed the parked task. (No
    // orchestrateTaskAssigned was driven via the assigned path — the reply routes to the resume handler.)
    expect(store.awaitClarificationCalls).toEqual([{ orgId: 'org-eltexsoft', externalStoryId: 'story-99' }]);
    expect(store.resumeCalls).toEqual(['task-parked']);
  });
});
