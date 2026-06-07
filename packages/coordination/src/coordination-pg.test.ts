import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgClaimRepository, TASK_TABLE_DDL } from '@tasca/db';
import { PgIdentityRepository, IDENTITY_SCHEMA_DDL } from '@tasca/identity';
import type { CapabilityProfile } from '@tasca/domain';
import type { AdapterEvent } from '@tasca/contracts';
import type {
  AgentProcessHandle,
  ExecutionPort,
  OpenPrResult,
  Worktree,
} from '@tasca/execution';
import type { MatchCandidate } from '@tasca/routing';
import { PgCoordinationStore } from './store';
import { COORDINATION_SCHEMA_DDL } from './schema';
import { orchestrateTaskAssigned, type OrchestrationDeps, type AgentDirectory, type AuditSink, type TaskContentSource } from './orchestrate';
import type { StatusReporter, StatusUpdate } from './ports';

// DB-backed proofs (mirrors claim-cas.test.ts / identity-repo.test.ts). Runs only
// when DATABASE_URL points at a Postgres; skipped otherwise. CI provides one.
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function waitForWaiters(pool: Pool, gateKey: number, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND NOT granted`,
      [gateKey]
    );
    if ((r.rows[0]?.c ?? 0) >= n) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${n} advisory-lock waiters`);
}

const okExecution: ExecutionPort = {
  async initDb() {},
  async reserveWorktree(input): Promise<Worktree> {
    return { path: `/tmp/${input.taskLabel}`, branch: `tasca/${input.taskLabel}`, repoPath: input.repoPath };
  },
  spawnAgent(): AgentProcessHandle {
    return { pid: 1, onData() {}, onExit(l) { queueMicrotask(() => l(0)); }, onError() {}, kill() {} };
  },
  killAgent() {},
  async openPr(): Promise<OpenPrResult> {
    return { url: 'https://github.com/icemint/tasca/pull/7' };
  },
  async close() {},
};

const content: TaskContentSource = { async fetch() { return { title: 'Build it', body: 'task body' }; } };

run('coordination (Postgres) — persistence + exactly-one dispatch', () => {
  let pool: Pool;
  let store: PgCoordinationStore;
  let identity: PgIdentityRepository;
  let agentId: string;
  let principalId: string;

  // This file shares the database with the identity / claim-CAS suites, which run
  // in parallel and TRUNCATE the same unqualified tables (agent, task, …) → cross
  // -file deadlocks. Isolate into a dedicated schema via search_path on a pool of
  // our own, so every unqualified DDL/DML here lands in `coordination_test` and
  // never races another file. Every pooled connection sets the path on connect.
  const SCHEMA = 'coordination_test';

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();

    // `options: -c search_path` is applied by the server at connection startup —
    // before any query runs on the socket — so there is no SET/first-query race.
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    for (const ddl of IDENTITY_SCHEMA_DDL) await pool.query(ddl);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
    store = new PgCoordinationStore(pool);
    identity = new PgIdentityRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE pull_request, routing_decision, webhook_event, platform_connection, task CASCADE');
    await pool.query('TRUNCATE audit_event, identity_binding, delegation, capability_profile, service_user, agent, rbac_role CASCADE');
    const created = await identity.createAgent({ name: 'Elvis', model: 'claude-sonnet', vendor: 'claude' });
    agentId = created.agent.id;
    principalId = created.serviceUser.principalId;
    const profile: CapabilityProfile = {
      agentId,
      maxTier: 'ultra',
      tiersCovered: ['basic', 'low', 'medium', 'hard', 'ultra'],
      languageSpecialties: ['typescript'],
      frameworkSpecialties: [],
      concurrencyLimit: 4,
      costCeiling: 100,
      successRate: 0.9,
      avgLatencyMs: 1000,
    };
    await identity.setCapabilityProfile(profile);
  });

  function directory(): AgentDirectory {
    return {
      async listCandidates(): Promise<MatchCandidate[]> {
        const profile = await identity.getCapabilityProfile(agentId);
        return profile ? [{ profile, state: 'idle', activeCount: 0 }] : [];
      },
      async principalIdFor(id: string) {
        const su = await identity.getServiceUser(id);
        return su?.principalId ?? null;
      },
    };
  }

  const auditSink: AuditSink = {
    async record(input) {
      await identity.appendAuditEvent({
        principalId: input.principalId,
        agentId: input.agentId,
        action: input.action,
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      });
    },
  };

  const status: StatusReporter & { updates: StatusUpdate[] } = {
    updates: [],
    async postStatus(u) { this.updates.push(u); },
  };

  const EVENT: AdapterEvent = {
    type: 'task.assigned',
    platform: 'shortcut',
    externalStoryId: 'sc-story-pg',
    agentExternalId: 'sc-agent',
    repoHint: '/repos/demo',
  };

  it('full happy path persists task/decision/pr/audit against real Postgres', async () => {
    status.updates = [];
    const deps: OrchestrationDeps = {
      store,
      claim: new PgClaimRepository(pool),
      execution: okExecution,
      status,
      directory: directory(),
      audit: auditSink,
      content,
    };
    const outcome = await orchestrateTaskAssigned(EVENT, deps);
    expect(outcome.kind).toBe('dispatched');
    if (outcome.kind !== 'dispatched') return;

    const task = await store.getTask(outcome.taskId);
    expect(task?.status).toBe('in_review');
    expect(task?.claimedBy).toBe(agentId);
    expect(task?.tierEstimate).not.toBeNull();

    const decisions = await pool.query('SELECT * FROM routing_decision WHERE task_id=$1', [outcome.taskId]);
    expect(decisions.rowCount).toBe(1);
    expect(decisions.rows[0].winner_agent_id).toBe(agentId);

    const prs = await pool.query('SELECT url FROM pull_request WHERE task_id=$1', [outcome.taskId]);
    expect(prs.rows[0].url).toBe(outcome.prUrl);

    const audits = await identity.listAuditEvents(principalId);
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['task.claim', 'pr.create', 'status.post']));
  });

  it('exactly one dispatch when N events race a single task (real CAS)', async () => {
    // Create ONE task, then race N atomic claims against it through the real
    // PgClaimRepository — exactly one wins (the dispatch guarantee, §6.8).
    const N = 25;
    const GATE = 553311;
    const racePool = new Pool({ connectionString: url, max: N + 4, options: `-c search_path=${SCHEMA}` });
    try {
      const task = await store.getOrCreateTask({ externalStoryId: 'sc-race', platform: 'shortcut', repoRef: '/r' });

      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      const workers = Array.from({ length: N }, (_, i) =>
        (async () => {
          const client = await racePool.connect();
          try {
            await client.query('SELECT pg_advisory_lock_shared($1)', [GATE]);
            return await new PgClaimRepository(client).tryClaim(task.id, `agent-${i}`, 0);
          } finally {
            await client.query('SELECT pg_advisory_unlock_shared($1)', [GATE]).catch(() => {});
            client.release();
          }
        })()
      );

      await waitForWaiters(racePool, GATE, N);
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE]);
      gate.release();

      const results = await Promise.all(workers);
      expect(results.filter((r) => r.won).length).toBe(1);

      const persisted = await store.getTask(task.id);
      expect(persisted?.status).toBe('claimed');
      expect(persisted?.version).toBe(1);
    } finally {
      await racePool.end();
    }
  });

  it('webhook ledger: a received-but-unprocessed redelivery is not a duplicate; a processed one is', async () => {
    const first = await store.recordWebhookEvent({ platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(first).toEqual({ fresh: true, alreadyProcessed: false });
    // Redelivery while still `received` (prior attempt not finished) → re-drivable.
    const second = await store.recordWebhookEvent({ platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(second).toEqual({ fresh: false, alreadyProcessed: false });

    // Once processed, a redelivery is a true duplicate.
    await store.markWebhookProcessed({ platform: 'shortcut', externalEventId: 'evt-x' });
    const third = await store.recordWebhookEvent({ platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(third).toEqual({ fresh: false, alreadyProcessed: true });

    // Exactly one ledger row regardless of redelivery count.
    const rows = await pool.query('SELECT count(*)::int AS c FROM webhook_event WHERE external_event_id=$1', ['evt-x']);
    expect(rows.rows[0].c).toBe(1);
  });

  it('github installation: upsert records the account→installation, lookup resolves it by owner', async () => {
    expect(await store.getInstallationIdForOwner('icemint')).toBeNull();

    await store.upsertGitHubInstallation({ workspaceId: 'icemint', installationId: '7700' });
    expect(await store.getInstallationIdForOwner('icemint')).toBe('7700');

    // Re-installing updates the id in place (one connection per owner).
    await store.upsertGitHubInstallation({ workspaceId: 'icemint', installationId: '8800' });
    expect(await store.getInstallationIdForOwner('icemint')).toBe('8800');
    const rows = await pool.query(
      `SELECT count(*)::int AS c FROM platform_connection WHERE platform='github' AND workspace_id=$1`,
      ['icemint']
    );
    expect(rows.rows[0].c).toBe(1);

    // An owner with no install resolves to null (honest, not a fabricated id).
    expect(await store.getInstallationIdForOwner('someone-else')).toBeNull();
  });

  it('getDelegation: returns the attribution label, or null when unset', async () => {
    expect(await identity.getDelegation(agentId)).toBeNull();
    await identity.setDelegation({
      agentId,
      onBehalfOfUserId: 'user-1',
      attributionLabel: 'On behalf of the platform team',
    });
    const d = await identity.getDelegation(agentId);
    expect(d?.attributionLabel).toBe('On behalf of the platform team');
  });

  it('get-or-create: two deliveries for the same story yield ONE task row', async () => {
    const a = await store.getOrCreateTask({ externalStoryId: 'sc-dup', platform: 'shortcut' });
    const b = await store.getOrCreateTask({ externalStoryId: 'sc-dup', platform: 'shortcut' });
    expect(b.id).toBe(a.id);
    const tasks = await pool.query('SELECT count(*)::int AS c FROM task WHERE external_story_id=$1', ['sc-dup']);
    expect(tasks.rows[0].c).toBe(1);
  });

  it('recordFailureAndTransition: one atomic UPDATE resets below threshold, trips at threshold', async () => {
    // Seed a claimed task so we can prove the reset clears claimed_by below the
    // threshold and retains it on the trip — all in a single statement.
    const task = await store.getOrCreateTask({ externalStoryId: 'sc-atomic', platform: 'shortcut', repoRef: '/r' });
    await pool.query(`UPDATE task SET status='claimed', claimed_by=$2 WHERE id=$1`, [task.id, agentId]);

    // Below threshold (N=2): one failure → routable, claim cleared, count = 1.
    const first = await store.recordFailureAndTransition(task.id, 2);
    expect(first).toEqual({ failureCount: 1, tripped: false });
    const afterFirst = await store.getTask(task.id);
    expect(afterFirst?.status).toBe('routable');
    expect(afterFirst?.claimedBy).toBeNull();
    expect(afterFirst?.failureCount).toBe(1);

    // Re-claim, then a second failure reaches the threshold → needs_attention,
    // claim RETAINED for the human, count = 2.
    await pool.query(`UPDATE task SET status='claimed', claimed_by=$2 WHERE id=$1`, [task.id, agentId]);
    const second = await store.recordFailureAndTransition(task.id, 2);
    expect(second).toEqual({ failureCount: 2, tripped: true });
    const afterSecond = await store.getTask(task.id);
    expect(afterSecond?.status).toBe('needs_attention');
    expect(afterSecond?.claimedBy).toBe(agentId);
    expect(afterSecond?.failureCount).toBe(2);
  });

  it('auto-recover: a failed attempt resets the SAME task to routable and re-wins the CAS (real Postgres)', async () => {
    // The headline §6.14 fix. First delivery fails in execution (spawn exit 1) →
    // task reset to routable, claim cleared, failure_count 1. Re-delivering the
    // SAME story re-drives the SAME row, succeeds, and dispatches.
    const failingExec: ExecutionPort = {
      ...okExecution,
      spawnAgent(): AgentProcessHandle {
        return { pid: 1, onData() {}, onExit(l) { queueMicrotask(() => l(1)); }, onError() {}, kill() {} };
      },
    };
    const base = { store, claim: new PgClaimRepository(pool), status, directory: directory(), audit: auditSink, content };

    const first = await orchestrateTaskAssigned(EVENT, { ...base, execution: failingExec });
    expect(first.kind).toBe('failed');
    if (first.kind !== 'failed') return;

    const reset = await store.getTask(first.taskId);
    expect(reset?.status).toBe('routable');
    expect(reset?.claimedBy).toBeNull();
    expect(reset?.failureCount).toBe(1);

    const second = await orchestrateTaskAssigned(EVENT, { ...base, execution: okExecution });
    expect(second.kind).toBe('dispatched');
    if (second.kind !== 'dispatched') return;
    expect(second.taskId).toBe(first.taskId); // same row re-driven, not a new task

    const tasks = await pool.query('SELECT count(*)::int AS c FROM task WHERE external_story_id=$1', [EVENT.externalStoryId]);
    expect(tasks.rows[0].c).toBe(1);
  });

  it('existing-PR re-finalize advances claimed→executing→in_review (not stranded in claimed)', async () => {
    // A prior attempt recorded a PR but the task is re-drivable (routable). The
    // re-claim lands the row in `claimed`; the existing-PR branch must finalize it
    // all the way to in_review. Regression guard: once setStatus enforces
    // transitions, finalize's setStatus('in_review') is illegal from `claimed`, so
    // without the branch's explicit claimed→executing move the task strands in
    // `claimed`. openPr THROWS to also prove dispatch is skipped (no second PR).
    const noDispatchExec: ExecutionPort = {
      ...okExecution,
      async openPr(): Promise<OpenPrResult> {
        throw new Error('openPr must not be called on the existing-PR path');
      },
    };
    const task = await store.getOrCreateTask({
      externalStoryId: EVENT.externalStoryId,
      platform: EVENT.platform,
    });
    await store.recordPullRequest({ taskId: task.id, url: 'https://github.com/icemint/tasca/pull/99' });

    const base = { store, claim: new PgClaimRepository(pool), status, directory: directory(), audit: auditSink, content };
    const outcome = await orchestrateTaskAssigned(EVENT, { ...base, execution: noDispatchExec });

    expect(outcome.kind).toBe('dispatched');
    const after = await store.getTask(task.id);
    expect(after?.status).toBe('in_review'); // reached in_review, not stranded in claimed
    const prs = await pool.query('SELECT count(*)::int AS c FROM pull_request WHERE task_id=$1', [task.id]);
    expect(prs.rows[0].c).toBe(1); // dispatch skipped — no second PR opened
  });
});

// setStatus enforces the domain transition rules (TASK_TRANSITIONS) atomically at
// the write boundary. Own schema so unqualified TRUNCATE/DDL can't race the suites
// above (same pattern as the main block).
run('coordination (Postgres) — setStatus transition guard', () => {
  const SCHEMA = 'coordination_setstatus_test';
  let pool: Pool;
  let store: PgCoordinationStore;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
    store = new PgCoordinationStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE pull_request, routing_decision, webhook_event, platform_connection, task CASCADE');
  });

  // A fresh task starts `routable`. The CAS claim (routable→claimed) rides the
  // ClaimPort, so here we set up `claimed` directly to exercise the setStatus edges
  // the dispatch loop actually drives (claimed→executing→in_review).
  async function newClaimedTask(): Promise<string> {
    const task = await store.getOrCreateTask({ externalStoryId: 'acme/widgets#1', platform: 'github' });
    await pool.query('UPDATE task SET status = $2 WHERE id = $1', [task.id, 'claimed']);
    return task.id;
  }

  it('allows the legal dispatch edges claimed→executing→in_review', async () => {
    const id = await newClaimedTask();
    await store.setStatus(id, 'executing');
    await store.setStatus(id, 'in_review');
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id]);
    expect(r.rows[0]!.status).toBe('in_review');
  });

  it('rejects an illegal transition (routable→in_review) and leaves the row unchanged', async () => {
    const task = await store.getOrCreateTask({ externalStoryId: 'acme/widgets#2', platform: 'github' });
    await expect(store.setStatus(task.id, 'in_review')).rejects.toThrow(
      /illegal transition routable -> in_review/
    );
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [task.id]);
    expect(r.rows[0]!.status).toBe('routable'); // unchanged
  });

  it('allows the routable self-loop (pre-claim failure reset) but not a generic identity', async () => {
    // routable→routable IS a TASK_TRANSITIONS self-loop (the §6.14 reset), so it
    // succeeds — driven by the map, not a blanket identity allowance.
    const task = await store.getOrCreateTask({ externalStoryId: 'acme/widgets#3', platform: 'github' });
    const before = await pool.query<{ version: number }>('SELECT version FROM task WHERE id=$1', [task.id]);
    await store.setStatus(task.id, 'routable');
    const after = await pool.query<{ status: string; version: number }>(
      'SELECT status, version FROM task WHERE id=$1',
      [task.id]
    );
    expect(after.rows[0]!.status).toBe('routable');
    expect(after.rows[0]!.version).toBe(before.rows[0]!.version + 1);
  });

  it('treats `done` as terminal: a done task rejects every onward transition incl. itself', async () => {
    const id = await newClaimedTask();
    await store.setStatus(id, 'executing');
    await store.setStatus(id, 'in_review');
    await store.setStatus(id, 'done'); // in_review→done is the one legal edge into done
    // done has no outgoing edges and no self-loop → nothing onward is permitted.
    await expect(store.setStatus(id, 'routable')).rejects.toThrow(/illegal transition done -> routable/);
    await expect(store.setStatus(id, 'done')).rejects.toThrow(/illegal transition done -> done/);
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id]);
    expect(r.rows[0]!.status).toBe('done'); // frozen
  });

  it('rejects skipping a step (executing→done) and leaves the row unchanged', async () => {
    const id = await newClaimedTask();
    await store.setStatus(id, 'executing');
    await expect(store.setStatus(id, 'done')).rejects.toThrow(/illegal transition executing -> done/);
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id]);
    expect(r.rows[0]!.status).toBe('executing');
  });

  it('throws "not found" for a missing task', async () => {
    await expect(
      store.setStatus('00000000-0000-0000-0000-000000000000', 'executing')
    ).rejects.toThrow(/not found/);
  });
});
