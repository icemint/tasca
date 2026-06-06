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
    await pool.query('TRUNCATE pull_request, routing_decision, webhook_event, task CASCADE');
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
      const task = await store.createTask({ externalStoryId: 'sc-race', platform: 'shortcut', repoRef: '/r' });

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

  it('idempotent webhook intake: same event id twice → one webhook_event row, one task', async () => {
    const first = await store.recordWebhookEvent({ platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    const second = await store.recordWebhookEvent({ platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);

    // Only the fresh delivery would proceed to createTask in the server path.
    if (first.fresh) await store.createTask({ externalStoryId: 'sc-x', platform: 'shortcut' });

    const rows = await pool.query('SELECT count(*)::int AS c FROM webhook_event WHERE external_event_id=$1', ['evt-x']);
    expect(rows.rows[0].c).toBe(1);
    const tasks = await pool.query('SELECT count(*)::int AS c FROM task WHERE external_story_id=$1', ['sc-x']);
    expect(tasks.rows[0].c).toBe(1);
  });
});
