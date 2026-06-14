import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgClaimRepository, PgDispatchQueue, TASK_TABLE_DDL, DISPATCH_JOB_DDL } from '@tasca/db';
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
import { sealVendorKey, openVendorKey, fingerprintVendorKey } from './vendor-credential';
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
  async commitAgentWork() {
    return { changed: true };
  },
  async close() {},
};

const content: TaskContentSource = { async fetch() { return { title: 'Build it', body: 'task body' }; } };

// The default org every row backfills onto (ORG_SCOPING_DDL seeds the organization row).
// These direct store assertions act in that single org; orchestrateTaskAssigned resolves
// its own org from the (unconnected → default) workspace, so both land on the same tenant.
const ORG = 'org_default';

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
    await pool.query('TRUNCATE governance_audit_event, org_vendor_credential, usage_event, proposal, pull_request, routing_decision, webhook_event, platform_connection, task CASCADE');
    await pool.query('TRUNCATE audit_event, identity_binding, delegation, capability_profile, service_user, agent, rbac_role CASCADE');
    await pool.query(`INSERT INTO organization (id, name) VALUES ('org_other','Other') ON CONFLICT (id) DO NOTHING`);
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
      async findHiredAgentByName(_orgId: string, name: string) {
        // Resolve by NAME (case-insensitive), mirroring the real roster's JOIN on agent.name.
        const a = await identity.getAgentWithProfile(agentId);
        return a && a.agent.name.toLowerCase() === name.toLowerCase() ? agentId : null;
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

    const task = await store.getTask(ORG, outcome.taskId);
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
      const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-race', platform: 'shortcut', repoRef: '/r' });

      const gate = await racePool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [GATE]);

      const workers = Array.from({ length: N }, (_, i) =>
        (async () => {
          const client = await racePool.connect();
          try {
            await client.query('SELECT pg_advisory_lock_shared($1)', [GATE]);
            return await new PgClaimRepository(client).tryClaim(ORG, task.id, `agent-${i}`, 0);
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

      const persisted = await store.getTask(ORG, task.id);
      expect(persisted?.status).toBe('claimed');
      expect(persisted?.version).toBe(1);
    } finally {
      await racePool.end();
    }
  });

  it('webhook ledger: a received-but-unprocessed redelivery is not a duplicate; a processed one is', async () => {
    const first = await store.recordWebhookEvent(ORG, { platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(first).toEqual({ fresh: true, alreadyProcessed: false });
    // Redelivery while still `received` (prior attempt not finished) → re-drivable.
    const second = await store.recordWebhookEvent(ORG, { platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(second).toEqual({ fresh: false, alreadyProcessed: false });

    // Once processed, a redelivery is a true duplicate.
    await store.markWebhookProcessed(ORG, { platform: 'shortcut', externalEventId: 'evt-x' });
    const third = await store.recordWebhookEvent(ORG, { platform: 'shortcut', externalEventId: 'evt-x', payload: {} });
    expect(third).toEqual({ fresh: false, alreadyProcessed: true });

    // Exactly one ledger row regardless of redelivery count.
    const rows = await pool.query('SELECT count(*)::int AS c FROM webhook_event WHERE external_event_id=$1', ['evt-x']);
    expect(rows.rows[0].c).toBe(1);
  });

  it('github installation: upsert records the account→installation, lookup resolves it by owner', async () => {
    expect(await store.getInstallationIdForOwner('icemint')).toBeNull();

    await store.upsertGitHubInstallation(ORG, { workspaceId: 'icemint', installationId: '7700' });
    expect(await store.getInstallationIdForOwner('icemint')).toBe('7700');

    // Re-installing updates the id in place (one connection per owner).
    await store.upsertGitHubInstallation(ORG, { workspaceId: 'icemint', installationId: '8800' });
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
    const a = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-dup', platform: 'shortcut' });
    const b = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-dup', platform: 'shortcut' });
    expect(b.id).toBe(a.id);
    const tasks = await pool.query('SELECT count(*)::int AS c FROM task WHERE external_story_id=$1', ['sc-dup']);
    expect(tasks.rows[0].c).toBe(1);
  });

  it('recordFailureAndTransition: one atomic UPDATE resets below threshold, trips at threshold', async () => {
    // Seed a claimed task so we can prove the reset clears claimed_by below the
    // threshold and retains it on the trip — all in a single statement.
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-atomic', platform: 'shortcut', repoRef: '/r' });
    await pool.query(`UPDATE task SET status='claimed', claimed_by=$2 WHERE id=$1`, [task.id, agentId]);

    // Below threshold (N=2): one failure → routable, claim cleared, count = 1.
    const first = await store.recordFailureAndTransition(ORG, task.id, 2);
    expect(first).toEqual({ failureCount: 1, tripped: false });
    const afterFirst = await store.getTask(ORG, task.id);
    expect(afterFirst?.status).toBe('routable');
    expect(afterFirst?.claimedBy).toBeNull();
    expect(afterFirst?.failureCount).toBe(1);

    // Re-claim, then a second failure reaches the threshold → needs_attention,
    // claim RETAINED for the human, count = 2.
    await pool.query(`UPDATE task SET status='claimed', claimed_by=$2 WHERE id=$1`, [task.id, agentId]);
    const second = await store.recordFailureAndTransition(ORG, task.id, 2);
    expect(second).toEqual({ failureCount: 2, tripped: true });
    const afterSecond = await store.getTask(ORG, task.id);
    expect(afterSecond?.status).toBe('needs_attention');
    expect(afterSecond?.claimedBy).toBe(agentId);
    expect(afterSecond?.failureCount).toBe(2);
  });

  it('recordRunnerFailure: idempotent — acts once from executing, then no-ops (no breaker double-count)', async () => {
    // The reaper finalizes a runner-FAILED job at-least-once (re-leased after a crash /
    // failed markReaped). recordRunnerFailure must count the breaker exactly once.
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-runner-fail', platform: 'shortcut', repoRef: '/r' });
    await pool.query(`UPDATE task SET status='executing', claimed_by=$2 WHERE id=$1`, [task.id, agentId]);

    // First finalize: task is executing → acts, increments, transitions out of executing.
    const first = await store.recordRunnerFailure(ORG, task.id, 2);
    expect(first).toEqual({ acted: true, failureCount: 1, tripped: false });
    expect((await store.getTask(ORG, task.id))?.status).toBe('routable');

    // Re-finalize the SAME job: task no longer executing → NO-OP, count stays 1.
    const again = await store.recordRunnerFailure(ORG, task.id, 2);
    expect(again.acted).toBe(false);
    expect((await store.getTask(ORG, task.id))?.failureCount).toBe(1); // not double-counted
  });

  it('EM gate columns (EM v1 slice 2): default false/0 and round-trip through getOrCreateTask/getTask', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-em-cols', platform: 'shortcut', repoRef: '/r' });
    expect(task.emCleared).toBe(false);
    expect(task.emClarificationRound).toBe(0);
    const read = await store.getTask(ORG, task.id);
    expect(read).toMatchObject({ emCleared: false, emClarificationRound: 0 });
  });

  it('markEmCleared flips em_cleared WITHOUT changing status (orthogonal to the lifecycle), org-scoped', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-em-clear', platform: 'shortcut', repoRef: '/r' });
    await store.markEmCleared(ORG, task.id);
    const read = await store.getTask(ORG, task.id);
    expect(read?.emCleared).toBe(true);
    expect(read?.status).toBe('routable'); // status untouched
    // a foreign org cannot flip this task's flag
    await store.markEmCleared('org_other', task.id);
    expect((await store.getTask(ORG, task.id))?.emCleared).toBe(true); // still true; no cross-org write
  });

  it('parkAwaitingClarification: routable → awaiting_clarification + records the round; guarded to routable', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-em-park', platform: 'shortcut', repoRef: '/r' });
    expect(await store.parkAwaitingClarification(ORG, task.id, 1)).toBe(true);
    const parked = await store.getTask(ORG, task.id);
    expect(parked?.status).toBe('awaiting_clarification');
    expect(parked?.emClarificationRound).toBe(1);

    // a second park from awaiting_clarification (not routable) no-ops — the guard holds.
    expect(await store.parkAwaitingClarification(ORG, task.id, 2)).toBe(false);
    expect((await store.getTask(ORG, task.id))?.emClarificationRound).toBe(1); // unchanged
  });

  it('getAwaitingClarificationTask returns the parked task and is org-scoped + status-filtered (EM v1 slice 3)', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-em-await', platform: 'shortcut', repoRef: '/r' });
    // Not parked yet → no row.
    expect(await store.getAwaitingClarificationTask(ORG, 'shortcut', 'sc-em-await')).toBeNull();
    await store.parkAwaitingClarification(ORG, task.id, 1);
    const found = await store.getAwaitingClarificationTask(ORG, 'shortcut', 'sc-em-await');
    expect(found?.id).toBe(task.id);
    expect(found?.status).toBe('awaiting_clarification');
    // Cross-tenant: a different org never sees it.
    expect(await store.getAwaitingClarificationTask('org_other', 'shortcut', 'sc-em-await')).toBeNull();
  });

  it('resumeFromClarification: awaiting_clarification → routable, em_cleared + round PERSIST; guarded (EM v1 slice 3)', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-em-resume', platform: 'shortcut', repoRef: '/r' });
    await store.parkAwaitingClarification(ORG, task.id, 2);
    expect(await store.resumeFromClarification(ORG, task.id)).toBe(true);
    const resumed = await store.getTask(ORG, task.id);
    expect(resumed?.status).toBe('routable');
    expect(resumed?.emCleared).toBe(false); // the gate must re-run
    expect(resumed?.emClarificationRound).toBe(2); // the round PERSISTS so the cap still counts

    // a second resume from routable (not awaiting_clarification) no-ops — the guard holds.
    expect(await store.resumeFromClarification(ORG, task.id)).toBe(false);
    // org-scoped: a foreign org cannot resume a parked task it doesn't own.
    await store.parkAwaitingClarification(ORG, task.id, 3);
    expect(await store.resumeFromClarification('org_other', task.id)).toBe(false);
    expect((await store.getTask(ORG, task.id))?.status).toBe('awaiting_clarification');
  });

  it('updateBlockReason (EM v1 slice 4): writes last_error ONLY in a blocked status; guarded + org-scoped', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-em-block', platform: 'shortcut', repoRef: '/r' });
    // Move the task into a blocked status with a RAW reason (as a retire site would).
    await pool.query(`UPDATE task SET status='needs_attention', last_error=$2 WHERE id=$1`, [task.id, 'no execution capacity: raw']);

    // The rephrase upgrades last_error WITHOUT changing status.
    expect(await store.updateBlockReason(ORG, task.id, 'No runner picked this up — check capacity.')).toBe(true);
    const blocked = await store.getTask(ORG, task.id);
    expect(blocked?.status).toBe('needs_attention'); // status untouched
    expect(blocked?.lastError).toBe('No runner picked this up — check capacity.');

    // GUARD: a task that moved on (e.g. resumed → routable) is NOT overwritten with a stale reason.
    await pool.query(`UPDATE task SET status='routable' WHERE id=$1`, [task.id]);
    expect(await store.updateBlockReason(ORG, task.id, 'stale')).toBe(false);
    expect((await store.getTask(ORG, task.id))?.lastError).toBe('No runner picked this up — check capacity.'); // unchanged

    // ALSO fires for the `failed` blocked status.
    await pool.query(`UPDATE task SET status='failed', last_error='raw2' WHERE id=$1`, [task.id]);
    expect(await store.updateBlockReason(ORG, task.id, 'A human reason for the failure.')).toBe(true);
    expect((await store.getTask(ORG, task.id))?.lastError).toBe('A human reason for the failure.');

    // ORG-SCOPED: a foreign org cannot rephrase this task's reason.
    await pool.query(`UPDATE task SET status='needs_attention' WHERE id=$1`, [task.id]);
    expect(await store.updateBlockReason('org_other', task.id, 'cross-org')).toBe(false);
    expect((await store.getTask(ORG, task.id))?.lastError).toBe('A human reason for the failure.'); // no cross-org write
  });

  it('recordPullRequest is idempotent on (task_id, url): a re-finalize does not duplicate the PR', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-pr-idem', platform: 'shortcut', repoRef: '/r' });
    const url = 'https://github.com/icemint/tasca/pull/123';
    await store.recordPullRequest(ORG, { taskId: task.id, url });
    await store.recordPullRequest(ORG, { taskId: task.id, url }); // re-finalize
    expect(await store.listPullRequestsForTask(ORG, task.id)).toHaveLength(1);
  });

  it('getTaskIdByPullRequestUrl resolves a recorded PR cross-org by its url; null for an unknown url', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-pr-lookup', platform: 'shortcut', repoRef: '/r' });
    const url = 'https://github.com/icemint/tasca/pull/200';
    await store.recordPullRequest(ORG, { taskId: task.id, url });

    // The resolver is cross-org (no org argument): the merge webhook arrives with only the url.
    expect(await store.getTaskIdByPullRequestUrl(url)).toEqual({ orgId: ORG, taskId: task.id });
    // A PR Tasca did not open (no recorded row) resolves to null → the merge handler no-ops.
    expect(await store.getTaskIdByPullRequestUrl('https://github.com/icemint/tasca/pull/404')).toBeNull();
  });

  it('markPullRequestMerged flips state to merged ONLY within the owning org (org-scoped)', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-pr-merge', platform: 'shortcut', repoRef: '/r' });
    const url = 'https://github.com/icemint/tasca/pull/300';
    await store.recordPullRequest(ORG, { taskId: task.id, url });

    // A foreign org flipping the same url touches nothing (the org_id predicate misses).
    await store.markPullRequestMerged('org_other', url);
    expect((await store.listPullRequestsForTask(ORG, task.id))[0]!.state).toBe('open');

    // The owning org flips it to merged; idempotent on a re-mark.
    await store.markPullRequestMerged(ORG, url);
    await store.markPullRequestMerged(ORG, url);
    expect((await store.listPullRequestsForTask(ORG, task.id))[0]!.state).toBe('merged');
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

    const reset = await store.getTask(ORG, first.taskId);
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
    const task = await store.getOrCreateTask(ORG, {
      externalStoryId: EVENT.externalStoryId,
      platform: EVENT.platform,
    });
    await store.recordPullRequest(ORG, { taskId: task.id, url: 'https://github.com/icemint/tasca/pull/99' });

    const base = { store, claim: new PgClaimRepository(pool), status, directory: directory(), audit: auditSink, content };
    const outcome = await orchestrateTaskAssigned(EVENT, { ...base, execution: noDispatchExec });

    expect(outcome.kind).toBe('dispatched');
    const after = await store.getTask(ORG, task.id);
    expect(after?.status).toBe('in_review'); // reached in_review, not stranded in claimed
    const prs = await pool.query('SELECT count(*)::int AS c FROM pull_request WHERE task_id=$1', [task.id]);
    expect(prs.rows[0].c).toBe(1); // dispatch skipped — no second PR opened
  });

  // ── PM-assistant proposals (slice W3-S1) ────────────────────────────────────
  describe('PM-assistant proposals — advisory, org-scoped, CAS-guarded accept', () => {
    const routingPayload = { agentName: 'Mona', why: 'best fit', confidence: 0.8 };

    async function seedTask(): Promise<{ id: string; version: number }> {
      const t = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-prop', platform: 'shortcut' });
      return { id: t.id, version: t.version };
    }

    it('createProposal / listProposals / getProposal are org-scoped', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      expect(p.status).toBe('pending');
      expect((await store.listProposals(ORG, { status: 'pending' })).map((x) => x.id)).toEqual([p.id]);
      expect((await store.getProposal(ORG, p.id))!.kind).toBe('routing');
      // org_other sees nothing.
      expect(await store.listProposals('org_other', {})).toEqual([]);
      expect(await store.getProposal('org_other', p.id)).toBeNull();
    });

    it('acceptRoutingProposal sets the task preference + re-routes, and marks the proposal accepted', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      const outcome = await store.acceptRoutingProposal(ORG, p.id, agentId);
      expect(outcome.ok).toBe(true);
      const task = await store.getTask(ORG, taskId);
      expect(task!.preferredAgentId).toBe(agentId); // the binding preference is set
      expect(task!.status).toBe('routable'); // re-routed
      expect(task!.version).toBe(version + 1); // exactly one bump
      expect((await store.getProposal(ORG, p.id))!.status).toBe('accepted');
    });

    it('VERSION FENCE: accepting after the task moved → conflict, proposal stays pending, no preference set', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      await store.overrideTierEstimate(ORG, taskId, 'hard'); // task moves (version → version+1), still routable
      const outcome = await store.acceptRoutingProposal(ORG, p.id, agentId);
      expect(outcome).toEqual({ ok: false, reason: 'conflict' });
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending'); // rolled back — not half-applied
      expect((await store.getTask(ORG, taskId))!.preferredAgentId).toBeNull(); // binding never ran
    });

    it('DOUBLE-ACCEPT race (forced parallelism): exactly one ok, the binding runs at most once', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      const [a, b] = await Promise.all([
        store.acceptRoutingProposal(ORG, p.id, agentId),
        store.acceptRoutingProposal(ORG, p.id, agentId),
      ]);
      const oks = [a, b].filter((r) => r.ok).length;
      expect(oks).toBe(1); // exactly-one (CAS on the proposal row serializes the racers)
      const task = await store.getTask(ORG, taskId);
      expect(task!.version).toBe(version + 1); // the binding write ran AT MOST ONCE
      expect((await store.getProposal(ORG, p.id))!.status).toBe('accepted');
    });

    it('CROSS-ORG: org_other cannot accept/dismiss org_default\'s proposal → not_found (never conflict, no existence leak)', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      expect(await store.acceptRoutingProposal('org_other', p.id, agentId)).toEqual({ ok: false, reason: 'not_found' });
      expect(await store.dismissProposal('org_other', p.id)).toEqual({ ok: false, reason: 'not_found' });
      // The proposal is untouched in its real org.
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending');
      expect((await store.getTask(ORG, taskId))!.preferredAgentId).toBeNull();
    });

    it('dismiss is a CAS: pending→dismissed once; a second dismiss → conflict', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      expect(await store.dismissProposal(ORG, p.id)).toEqual({ ok: true });
      expect((await store.getProposal(ORG, p.id))!.status).toBe('dismissed');
      expect(await store.dismissProposal(ORG, p.id)).toEqual({ ok: false, reason: 'conflict' });
    });

    it('a dismissed proposal cannot then be accepted → conflict (no binding)', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      await store.dismissProposal(ORG, p.id);
      expect(await store.acceptRoutingProposal(ORG, p.id, agentId)).toEqual({ ok: false, reason: 'conflict' });
      expect((await store.getTask(ORG, taskId))!.preferredAgentId).toBeNull();
    });

    // ── triage kind (W3-S1b) — accept routes ONLY through the overrideTierEstimate write ──
    const triagePayload = { tier: 'ultra', why: 'looks like an incident', confidence: 0.8 };

    it('acceptTriageProposal applies the tier (the overrideTierEstimate write) + marks accepted', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'triage', targetTaskId: taskId, targetVersion: version, payload: triagePayload });
      expect(await store.acceptTriageProposal(ORG, p.id, 'ultra')).toEqual({ ok: true });
      const task = await store.getTask(ORG, taskId);
      expect(task!.tierEstimate!.tier).toBe('ultra'); // ONLY the tier was written
      expect(task!.status).toBe('routable'); // status untouched (no re-route — triage isn't routing)
      expect(task!.version).toBe(version + 1);
      expect((await store.getProposal(ORG, p.id))!.status).toBe('accepted');
    });

    it('VERSION FENCE: triage accept after the task moved → conflict, proposal stays pending, no tier write', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'triage', targetTaskId: taskId, targetVersion: version, payload: triagePayload });
      await pool.query(`UPDATE task SET version = version + 1 WHERE id = $1`, [taskId]); // task moves since generation
      expect(await store.acceptTriageProposal(ORG, p.id, 'ultra')).toEqual({ ok: false, reason: 'conflict' });
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending'); // rolled back
      expect((await store.getTask(ORG, taskId))!.tierEstimate).toBeNull(); // tier never written
    });

    it('DONE GUARD: triage accept on a finished task → conflict (overrideTierEstimate refuses done)', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'triage', targetTaskId: taskId, targetVersion: version, payload: triagePayload });
      await pool.query(`UPDATE task SET status = 'done' WHERE id = $1`, [taskId]); // finish it (version unchanged)
      expect(await store.acceptTriageProposal(ORG, p.id, 'ultra')).toEqual({ ok: false, reason: 'conflict' });
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending');
    });

    it('DOUBLE-ACCEPT race (triage): exactly one ok, the tier write runs at most once', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'triage', targetTaskId: taskId, targetVersion: version, payload: triagePayload });
      const [a, b] = await Promise.all([
        store.acceptTriageProposal(ORG, p.id, 'ultra'),
        store.acceptTriageProposal(ORG, p.id, 'ultra'),
      ]);
      expect([a, b].filter((r) => r.ok).length).toBe(1);
      expect((await store.getTask(ORG, taskId))!.version).toBe(version + 1); // tier write ran once
    });

    it('CROSS-ORG: org_other cannot accept org_default\'s triage proposal → not_found', async () => {
      const { id: taskId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'triage', targetTaskId: taskId, targetVersion: version, payload: triagePayload });
      expect(await store.acceptTriageProposal('org_other', p.id, 'ultra')).toEqual({ ok: false, reason: 'not_found' });
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending');
      expect((await store.getTask(ORG, taskId))!.tierEstimate).toBeNull();
    });

    it('kind discipline: acceptTriageProposal will not accept a ROUTING proposal (and vice versa)', async () => {
      const { id: taskId, version } = await seedTask();
      const routing = await store.createProposal(ORG, { kind: 'routing', targetTaskId: taskId, targetVersion: version, payload: routingPayload });
      // a triage accept on a routing proposal misses the kind='triage' CAS → conflict, no tier write
      expect(await store.acceptTriageProposal(ORG, routing.id, 'ultra')).toEqual({ ok: false, reason: 'conflict' });
      expect((await store.getProposal(ORG, routing.id))!.status).toBe('pending');
      expect((await store.getTask(ORG, taskId))!.tierEstimate).toBeNull();
    });

    // ── decomposition kind (W3-S1c) — accept routes ONLY through getOrCreateTask per child ──
    const children = [{ title: 'schema migration', body: 'add tables' }, { title: 'recon engine', body: 'the core' }];
    const decompPayload = { children, why: 'splits cleanly' };
    const childCount = (parentId: string) =>
      pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM task WHERE parent_task_id = $1`, [parentId]).then((r) => r.rows[0]!.c);

    it('acceptDecompositionProposal creates children with deterministic ids + stored content + parent link', async () => {
      const { id: parentId, version } = await seedTask(); // parent story 'sc-prop'
      const p = await store.createProposal(ORG, { kind: 'decomposition', targetTaskId: parentId, targetVersion: version, payload: decompPayload });
      expect(await store.acceptDecompositionProposal(ORG, p.id, children)).toEqual({ ok: true });
      expect(await childCount(parentId)).toBe(2);
      // children are routable Tasca tasks with deterministic synthetic story ids
      const sub0 = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-prop#sub-0', platform: 'shortcut' });
      expect(sub0.status).toBe('routable');
      // getTaskOrigin: the child carries its content + resolves the PARENT's story (status target)
      const origin = await store.getTaskOrigin(ORG, sub0.id);
      expect(origin!.content).toEqual({ title: 'schema migration', body: 'add tables' });
      expect(origin!.parentTaskId).toBe(parentId);
      expect(origin!.parentExternalStoryId).toBe('sc-prop');
      // STRUCTURAL: the PARENT is untouched (no status/claim/tier/routing write)
      const parent = await store.getTask(ORG, parentId);
      expect(parent!.status).toBe('routable');
      expect(parent!.tierEstimate).toBeNull();
      // a NORMAL task has a null origin
      expect((await store.getTaskOrigin(ORG, parentId))!.content).toBeNull();
    });

    it('DECOMPOSE-ONCE: a parent that already has children → conflict, no second split, existing content untouched', async () => {
      const { id: parentId, version } = await seedTask();
      // an already-decomposed parent (a child with its OWN content exists)
      await store.getOrCreateTask(ORG, { externalStoryId: 'sc-prop#sub-0', platform: 'shortcut', content: { title: 'existing child', body: 'live' }, parentTaskId: parentId });
      const p = await store.createProposal(ORG, { kind: 'decomposition', targetTaskId: parentId, targetVersion: version, payload: decompPayload });
      // a SECOND, DIFFERENT decomposition must NOT silently shadow the first (the deterministic ids
      // would collide and keep the first's content) — it's rejected.
      expect(await store.acceptDecompositionProposal(ORG, p.id, children)).toEqual({ ok: false, reason: 'conflict' });
      expect(await childCount(parentId)).toBe(1); // unchanged
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending');
      // the live child's content was NOT overwritten by the rejected split
      const existing = await store.getOrCreateTask(ORG, { externalStoryId: 'sc-prop#sub-0', platform: 'shortcut' });
      expect((await store.getTaskOrigin(ORG, existing.id))!.content).toEqual({ title: 'existing child', body: 'live' });
    });

    it('VERSION FENCE: decomposition accept after the parent moved → conflict, NO children, stays pending', async () => {
      const { id: parentId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'decomposition', targetTaskId: parentId, targetVersion: version, payload: decompPayload });
      await pool.query(`UPDATE task SET version = version + 1 WHERE id = $1`, [parentId]); // parent moves
      expect(await store.acceptDecompositionProposal(ORG, p.id, children)).toEqual({ ok: false, reason: 'conflict' });
      expect(await childCount(parentId)).toBe(0); // all-or-nothing — no orphan children
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending');
    });

    it('DONE GUARD: decomposition accept on a finished parent → conflict, no children', async () => {
      const { id: parentId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'decomposition', targetTaskId: parentId, targetVersion: version, payload: decompPayload });
      await pool.query(`UPDATE task SET status = 'done' WHERE id = $1`, [parentId]);
      expect(await store.acceptDecompositionProposal(ORG, p.id, children)).toEqual({ ok: false, reason: 'conflict' });
      expect(await childCount(parentId)).toBe(0);
    });

    it('DOUBLE-ACCEPT race (decomposition): exactly one ok, children created once', async () => {
      const { id: parentId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'decomposition', targetTaskId: parentId, targetVersion: version, payload: decompPayload });
      const [a, b] = await Promise.all([
        store.acceptDecompositionProposal(ORG, p.id, children),
        store.acceptDecompositionProposal(ORG, p.id, children),
      ]);
      expect([a, b].filter((r) => r.ok).length).toBe(1);
      expect(await childCount(parentId)).toBe(2); // children created once (deterministic ids + the CAS)
    });

    it('CROSS-ORG: org_other cannot accept org_default\'s decomposition → not_found, no children', async () => {
      const { id: parentId, version } = await seedTask();
      const p = await store.createProposal(ORG, { kind: 'decomposition', targetTaskId: parentId, targetVersion: version, payload: decompPayload });
      expect(await store.acceptDecompositionProposal('org_other', p.id, children)).toEqual({ ok: false, reason: 'not_found' });
      expect(await childCount(parentId)).toBe(0);
      expect((await store.getProposal(ORG, p.id))!.status).toBe('pending');
    });

    // ── standup (W3-S1d) — the read-only aggregate ──
    // ── usage metering (W3-S4a) — CAS-idempotent + org-scoped ──
    const usage = (over: Partial<{ taskId: string | null; source: 'classifier' | 'triage' | 'decomposition' | 'agent'; model: string; inputTokens: number; outputTokens: number; idempotencyKey: string }> = {}) => ({
      taskId: null, source: 'classifier' as const, model: 'haiku', inputTokens: 100, outputTokens: 10, idempotencyKey: 'msg_1', ...over,
    });

    it('recordUsage + getUsage: sums by source + total, org-scoped', async () => {
      await store.recordUsage(ORG, usage({ idempotencyKey: 'a', source: 'classifier', inputTokens: 100, outputTokens: 10 }));
      await store.recordUsage(ORG, usage({ idempotencyKey: 'b', source: 'triage', inputTokens: 200, outputTokens: 20 }));
      await store.recordUsage(ORG, usage({ idempotencyKey: 'c', source: 'classifier', inputTokens: 50, outputTokens: 5 }));
      const totals = await store.getUsage(ORG);
      expect(totals.inputTokens).toBe(350);
      expect(totals.outputTokens).toBe(35);
      expect(totals.bySource.classifier).toEqual({ inputTokens: 150, outputTokens: 15 });
      expect(totals.bySource.triage).toEqual({ inputTokens: 200, outputTokens: 20 });
    });

    it('CAS-IDEMPOTENT: re-recording the SAME idempotency_key is a no-op (no double-count)', async () => {
      await store.recordUsage(ORG, usage({ idempotencyKey: 'dup', inputTokens: 100, outputTokens: 10 }));
      await store.recordUsage(ORG, usage({ idempotencyKey: 'dup', inputTokens: 999, outputTokens: 999 })); // retry — ignored
      const totals = await store.getUsage(ORG);
      expect(totals.inputTokens).toBe(100); // counted once, the first write
      expect((await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM usage_event WHERE idempotency_key='dup'`)).rows[0]!.c).toBe(1);
    });

    it('FORCED PARALLELISM: concurrent reports of the SAME call → exactly one row (no double-count)', async () => {
      await Promise.all(Array.from({ length: 8 }, () => store.recordUsage(ORG, usage({ idempotencyKey: 'race', inputTokens: 100, outputTokens: 10 }))));
      const totals = await store.getUsage(ORG);
      expect(totals.inputTokens).toBe(100); // 8 concurrent reports, counted ONCE
      expect((await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM usage_event WHERE idempotency_key='race'`)).rows[0]!.c).toBe(1);
    });

    it('ORG-SCOPED: getUsage sums ONLY the org (a cross-org sum would be a billing leak)', async () => {
      await store.recordUsage(ORG, usage({ idempotencyKey: 'mine', inputTokens: 100, outputTokens: 10 }));
      await store.recordUsage('org_other', usage({ idempotencyKey: 'theirs', inputTokens: 5000, outputTokens: 5000 }));
      expect((await store.getUsage(ORG)).inputTokens).toBe(100); // org_other's 5000 NOT included
      expect((await store.getUsage('org_other')).inputTokens).toBe(5000);
    });

    it('getUsage filters by task (per-task spend)', async () => {
      await store.recordUsage(ORG, usage({ idempotencyKey: 't1a', taskId: 'task-1', inputTokens: 100, outputTokens: 10 }));
      await store.recordUsage(ORG, usage({ idempotencyKey: 't2a', taskId: 'task-2', inputTokens: 200, outputTokens: 20 }));
      expect((await store.getUsage(ORG, { taskId: 'task-1' })).inputTokens).toBe(100);
    });

    it('getTaskStatusCounts counts EVERY task by status and is ORG-SCOPED (no cross-tenant count)', async () => {
      // org_default: 2 routable + 1 done; org_other: 5 routable (must NOT be counted for org_default).
      // task.project_id is NOT NULL (Project-A) — resolve each org's Unassigned project for these raw inserts.
      const pDft = await store.getOrCreateProject('org_default', null);
      const pOth = await store.getOrCreateProject('org_other', null);
      await pool.query(`INSERT INTO task (id, org_id, external_story_id, platform, status, project_id) VALUES
        ('c1','org_default','s1','shortcut','routable',$1),('c2','org_default','s2','shortcut','routable',$1),
        ('c3','org_default','s3','shortcut','done',$1)`, [pDft]);
      for (let i = 0; i < 5; i++) {
        await pool.query(`INSERT INTO task (id, org_id, external_story_id, platform, status, project_id) VALUES ($1,'org_other',$2,'shortcut','routable',$3)`, [`o${i}`, `os${i}`, pOth]);
      }
      const counts = await store.getTaskStatusCounts(ORG);
      expect(counts.routable).toBe(2); // org_default only — org_other's 5 are NOT counted
      expect(counts.done).toBe(1);
      expect(counts.executing ?? 0).toBe(0);
    });
  });

  describe('BYOK vendor credentials — sealed at rest, org-scoped (slice 3.5-A)', () => {
    const MASTER = Buffer.alloc(32, 7);
    const SECRET = 'sk-ant-PG-SECRET-do-not-leak-9988776655';

    it('set → status (no key) → sealed roundtrip → delete, all org-scoped', async () => {
      const sealed = sealVendorKey(SECRET, MASTER);
      const fp = fingerprintVendorKey('anthropic', SECRET);
      await store.setVendorCredential(ORG, 'anthropic', sealed, fp, 'u1');

      // status read returns the fingerprint, NEVER the key/ciphertext
      const statuses = await store.getVendorCredentialStatuses(ORG);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({ provider: 'anthropic', status: 'active', fingerprint: fp });
      expect(JSON.stringify(statuses)).not.toContain(SECRET);

      // the sealed blob roundtrips through the master key (the only path to plaintext)
      const got = await store.getSealedVendorCredential(ORG, 'anthropic');
      expect(openVendorKey(got!, MASTER)).toBe(SECRET);

      // ORG ISOLATION: org_other sees nothing
      expect(await store.getVendorCredentialStatuses('org_other')).toEqual([]);
      expect(await store.getSealedVendorCredential('org_other', 'anthropic')).toBeNull();

      // replace (upsert) keeps one row; delete removes it
      await store.setVendorCredential(ORG, 'anthropic', sealVendorKey('sk-ant-ROT', MASTER), fingerprintVendorKey('anthropic', 'sk-ant-ROT'), 'u1');
      expect(await store.getVendorCredentialStatuses(ORG)).toHaveLength(1);
      expect(await store.deleteVendorCredential(ORG, 'anthropic')).toBe(true);
      expect(await store.getVendorCredentialStatuses(ORG)).toEqual([]);
      expect(await store.deleteVendorCredential(ORG, 'anthropic')).toBe(false);
    });
  });

  describe('governance audit trail — append-only, org-scoped (slice 3.5-A.2c.1)', () => {
    it('list returns only the org, newest-first', async () => {
      await store.recordGovernanceAudit(ORG, { actorUserId: 'u1', action: 'credential.set', target: 'anthropic', payload: { fingerprint: 'fp1', status: 'active' } });
      await store.recordGovernanceAudit(ORG, { actorUserId: 'u1', action: 'credential.delete', target: 'anthropic', payload: {} });
      await store.recordGovernanceAudit('org_other', { actorUserId: 'u9', action: 'credential.set', target: 'anthropic', payload: { fingerprint: 'fpX', status: 'active' } });

      const events = await store.listGovernanceAudit(ORG);
      expect(events).toHaveLength(2); // org_other's row is NOT included
      expect(events.map((e) => e.action)).toEqual(['credential.delete', 'credential.set']); // newest-first
      expect(events[0]).toMatchObject({ actorUserId: 'u1', action: 'credential.delete', target: 'anthropic', payload: {} });
      expect(events[1]).toMatchObject({ action: 'credential.set', payload: { fingerprint: 'fp1', status: 'active' } });
      expect(await store.listGovernanceAudit('org_other')).toHaveLength(1);
    });

    it('APPEND-ONLY: a raw UPDATE / DELETE is a no-op (the trail cannot be rewritten or erased)', async () => {
      await store.recordGovernanceAudit(ORG, { actorUserId: 'u1', action: 'credential.set', target: 'anthropic', payload: { fingerprint: 'fp1', status: 'active' } });
      const [before] = await store.listGovernanceAudit(ORG);

      // The UPDATE/DELETE rules turn these into silent no-ops.
      await pool.query(`UPDATE governance_audit_event SET action = 'tampered', actor_user_id = 'attacker' WHERE org_id = $1`, [ORG]);
      await pool.query(`DELETE FROM governance_audit_event WHERE org_id = $1`, [ORG]);

      const after = await store.listGovernanceAudit(ORG);
      expect(after).toHaveLength(1); // still present (DELETE was a no-op)
      expect(after[0]).toMatchObject({ id: before!.id, action: 'credential.set', actorUserId: 'u1' }); // unchanged (UPDATE was a no-op)
    });

    it('list clamps an oversized limit and defaults to 50', async () => {
      for (let i = 0; i < 60; i++) {
        await store.recordGovernanceAudit(ORG, { actorUserId: 'u1', action: 'credential.set', target: 'anthropic', payload: { fingerprint: `fp${i}`, status: 'active' } });
      }
      expect(await store.listGovernanceAudit(ORG)).toHaveLength(50); // default limit
      expect((await store.listGovernanceAudit(ORG, { limit: 10 })).length).toBe(10);
      expect((await store.listGovernanceAudit(ORG, { limit: 9999 })).length).toBe(60); // clamped to ≤200, capped by row count
    });
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
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'acme/widgets#1', platform: 'github' });
    await pool.query('UPDATE task SET status = $2 WHERE id = $1', [task.id, 'claimed']);
    return task.id;
  }

  it('allows the legal dispatch edges claimed→executing→in_review', async () => {
    const id = await newClaimedTask();
    await store.setStatus(ORG, id, 'executing');
    await store.setStatus(ORG, id, 'in_review');
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id]);
    expect(r.rows[0]!.status).toBe('in_review');
  });

  it('rejects an illegal transition (routable→in_review) and leaves the row unchanged', async () => {
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'acme/widgets#2', platform: 'github' });
    await expect(store.setStatus(ORG, task.id, 'in_review')).rejects.toThrow(
      /illegal transition routable -> in_review/
    );
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [task.id]);
    expect(r.rows[0]!.status).toBe('routable'); // unchanged
  });

  it('allows the routable self-loop (pre-claim failure reset) but not a generic identity', async () => {
    // routable→routable IS a TASK_TRANSITIONS self-loop (the §6.14 reset), so it
    // succeeds — driven by the map, not a blanket identity allowance.
    const task = await store.getOrCreateTask(ORG, { externalStoryId: 'acme/widgets#3', platform: 'github' });
    const before = await pool.query<{ version: number }>('SELECT version FROM task WHERE id=$1', [task.id]);
    await store.setStatus(ORG, task.id, 'routable');
    const after = await pool.query<{ status: string; version: number }>(
      'SELECT status, version FROM task WHERE id=$1',
      [task.id]
    );
    expect(after.rows[0]!.status).toBe('routable');
    expect(after.rows[0]!.version).toBe(before.rows[0]!.version + 1);
  });

  it('treats `done` as terminal: a done task rejects every onward transition incl. itself', async () => {
    const id = await newClaimedTask();
    await store.setStatus(ORG, id, 'executing');
    await store.setStatus(ORG, id, 'in_review');
    await store.setStatus(ORG, id, 'done'); // in_review→done is the one legal edge into done
    // done has no outgoing edges and no self-loop → nothing onward is permitted.
    await expect(store.setStatus(ORG, id, 'routable')).rejects.toThrow(/illegal transition done -> routable/);
    await expect(store.setStatus(ORG, id, 'done')).rejects.toThrow(/illegal transition done -> done/);
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id]);
    expect(r.rows[0]!.status).toBe('done'); // frozen
  });

  it('rejects skipping a step (executing→done) and leaves the row unchanged', async () => {
    const id = await newClaimedTask();
    await store.setStatus(ORG, id, 'executing');
    await expect(store.setStatus(ORG, id, 'done')).rejects.toThrow(/illegal transition executing -> done/);
    const r = await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id]);
    expect(r.rows[0]!.status).toBe('executing');
  });

  it('throws "not found" for a missing task', async () => {
    await expect(
      store.setStatus(ORG, '00000000-0000-0000-0000-000000000000', 'executing')
    ).rejects.toThrow(/not found/);
  });
});

// Human write-API store methods (escalate / re-tier / reassign): admin overrides
// that bypass TASK_TRANSITIONS with their own explicit state guards, bump version,
// and return a typed outcome. Own schema (same isolation pattern).
run('coordination (Postgres) — human write-API interventions', () => {
  const SCHEMA = 'coordination_writeapi_test';
  let pool: Pool;
  let store: PgCoordinationStore;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: url });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    await pool.query(TASK_TABLE_DDL);
    await pool.query(DISPATCH_JOB_DDL);
    for (const ddl of COORDINATION_SCHEMA_DDL) await pool.query(ddl);
    store = new PgCoordinationStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE pull_request, routing_decision, webhook_event, platform_connection, task, dispatch_job CASCADE');
  });

  const at = async (status: string): Promise<{ id: string; version: number }> => {
    const t = await store.getOrCreateTask(ORG, { externalStoryId: `acme/widgets#${status}`, platform: 'github' });
    await pool.query('UPDATE task SET status=$2 WHERE id=$1', [t.id, status]);
    const r = await pool.query<{ version: number }>('SELECT version FROM task WHERE id=$1', [t.id]);
    return { id: t.id, version: r.rows[0]!.version };
  };
  const statusOf = async (id: string) =>
    (await pool.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [id])).rows[0]!.status;
  const versionOf = async (id: string) =>
    (await pool.query<{ version: number }>('SELECT version FROM task WHERE id=$1', [id])).rows[0]!.version;
  // Enqueue (and optionally claim / drive to publishing) a dispatch job for a task, so the
  // cancel-coupled path has a real live job to act on. The queue is built lazily — `pool` is
  // assigned in beforeAll, after this describe body runs.
  const dispatchFor = async (taskId: string, to: 'queued' | 'claimed' | 'publishing'): Promise<void> => {
    const queue = new PgDispatchQueue(pool);
    await queue.enqueue({ orgId: ORG, taskId, payload: {} });
    if (to === 'queued') return;
    const job = await queue.claimNext('runner-1', 30);
    if (to === 'publishing') await queue.beginPublish(job!.id, job!.fence);
  };
  const jobStatusFor = async (taskId: string) =>
    (await pool.query<{ status: string }>('SELECT status FROM dispatch_job WHERE task_id=$1', [taskId])).rows[0]?.status;

  it('escalateTask forces needs_attention from a live status and bumps version', async () => {
    const { id, version } = await at('executing');
    const out = await store.escalateTask(ORG, id);
    expect(out).toEqual({ ok: true, status: 'needs_attention' });
    expect(await statusOf(id)).toBe('needs_attention');
    expect(await versionOf(id)).toBe(version + 1);
  });

  it('escalateTask is a conflict on a done task (terminal) and a 404 when missing', async () => {
    const { id } = await at('done');
    expect(await store.escalateTask(ORG, id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await statusOf(id)).toBe('done'); // unchanged
    expect(await store.escalateTask(ORG, '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('escalateTask is an idempotent conflict on an already-needs_attention task (no spurious version bump)', async () => {
    const { id, version } = await at('needs_attention');
    expect(await store.escalateTask(ORG, id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await versionOf(id)).toBe(version); // unchanged — no needless CAS-busting bump
  });

  it('overrideTierEstimate sets only the tier, preserving the rest of the estimate', async () => {
    const t = await store.getOrCreateTask(ORG, { externalStoryId: 'acme/widgets#tier', platform: 'github' });
    await store.setTierEstimate(ORG, t.id, { tier: 'low', confidence: 0.7, signals: { wordCount: 5, hasReasoningVerb: false, scopeHint: 'unknown', labelTier: null }, classifierUsed: true });
    const out = await store.overrideTierEstimate(ORG, t.id, 'hard');
    expect(out.ok).toBe(true);
    const row = await pool.query<{ tier_estimate: { tier: string; confidence: number; classifierUsed: boolean } }>('SELECT tier_estimate FROM task WHERE id=$1', [t.id]);
    expect(row.rows[0]!.tier_estimate.tier).toBe('hard');
    expect(row.rows[0]!.tier_estimate.confidence).toBe(0.7); // preserved
  });

  it('overrideTierEstimate seeds a minimal estimate when none existed', async () => {
    const t = await store.getOrCreateTask(ORG, { externalStoryId: 'acme/widgets#tier2', platform: 'github' });
    await store.overrideTierEstimate(ORG, t.id, 'ultra');
    const got = await store.getTask(ORG, t.id);
    expect(got!.tierEstimate!.tier).toBe('ultra');
  });

  it('reassignTask releases the claim → routable with failures reset, from a non-executing status', async () => {
    const { id } = await at('needs_attention');
    await pool.query('UPDATE task SET claimed_by=$2, failure_count=2 WHERE id=$1', [id, 'agent-x']);
    const out = await store.reassignTask(ORG, id);
    expect(out).toEqual({ ok: true, status: 'routable' });
    const row = await pool.query<{ status: string; claimed_by: string | null; failure_count: number }>('SELECT status, claimed_by, failure_count FROM task WHERE id=$1', [id]);
    expect(row.rows[0]).toMatchObject({ status: 'routable', claimed_by: null, failure_count: 0 });
  });

  it('reassignTask on an EXECUTING task cancels the live (claimed) job atomically, then re-routes', async () => {
    const { id, version } = await at('executing');
    await dispatchFor(id, 'claimed');
    expect(await store.reassignTask(ORG, id)).toEqual({ ok: true, status: 'routable' });
    expect(await statusOf(id)).toBe('routable');
    expect(await versionOf(id)).toBe(version + 1);
    expect(await jobStatusFor(id)).toBe('cancelled'); // the runner job was signalled → cancelled
  });

  it('reassignTask cancels a still-queued job (no runner claimed yet) and re-routes', async () => {
    const { id } = await at('executing');
    await dispatchFor(id, 'queued');
    expect(await store.reassignTask(ORG, id)).toEqual({ ok: true, status: 'routable' });
    expect(await jobStatusFor(id)).toBe('cancelled');
  });

  it('reassignTask is too_late once the runner is publishing (point of no return) — task UNTOUCHED', async () => {
    const { id, version } = await at('executing');
    await dispatchFor(id, 'publishing');
    expect(await store.reassignTask(ORG, id)).toEqual({ ok: false, reason: 'too_late' });
    expect(await statusOf(id)).toBe('executing'); // the run is finishing; not orphaned, not re-routed
    expect(await versionOf(id)).toBe(version); // no spurious bump
    expect(await jobStatusFor(id)).toBe('publishing'); // the runner keeps its row
  });

  it('reassignTask on an executing task running IN-PROCESS (no runner job) → no_inflight, untouched', async () => {
    const { id, version } = await at('executing');
    expect(await store.reassignTask(ORG, id)).toEqual({ ok: false, reason: 'no_inflight' });
    expect(await statusOf(id)).toBe('executing');
    expect(await versionOf(id)).toBe(version);
  });

  it('interruptTask halts a live (claimed) run → needs_attention and cancels the job', async () => {
    const { id, version } = await at('executing');
    await dispatchFor(id, 'claimed');
    expect(await store.interruptTask(ORG, id)).toEqual({ ok: true, status: 'needs_attention' });
    expect(await statusOf(id)).toBe('needs_attention');
    expect(await versionOf(id)).toBe(version + 1);
    expect(await jobStatusFor(id)).toBe('cancelled');
  });

  it('interruptTask is too_late on a publishing run (task untouched), and a conflict when nothing is executing', async () => {
    const { id, version } = await at('executing');
    await dispatchFor(id, 'publishing');
    expect(await store.interruptTask(ORG, id)).toEqual({ ok: false, reason: 'too_late' });
    expect(await statusOf(id)).toBe('executing');

    expect(await versionOf(id)).toBe(version); // the publishing task was untouched

    const c = await at('claimed'); // not executing → nothing live to interrupt
    expect(await store.interruptTask(ORG, c.id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await statusOf(c.id)).toBe('claimed');
    expect(await versionOf(c.id)).toBe(c.version);
  });

  it('a double interrupt is idempotent: the first cancels + flags, the second is a benign conflict no-op', async () => {
    const { id } = await at('executing');
    await dispatchFor(id, 'claimed');
    expect(await store.interruptTask(ORG, id)).toEqual({ ok: true, status: 'needs_attention' });
    // Second click: the job is already cancelled (no active job) and the task is no longer
    // executing → conflict (nothing live to interrupt), and the task is left untouched.
    expect(await store.interruptTask(ORG, id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await statusOf(id)).toBe('needs_attention');
  });

  it('forceResetTask clears a stuck IN-PROCESS executing task (the dead end interrupt/reassign cannot touch) → needs_attention, claim released', async () => {
    // The exact stuck shape: executing, claimed by an agent, no runner job → interrupt + reassign
    // both dead-end with no_inflight (see the two tests above). force-reset is the escape hatch.
    const { id, version } = await at('executing');
    await pool.query('UPDATE task SET claimed_by=$2, failure_count=2 WHERE id=$1', [id, 'elvis']);
    expect(await store.interruptTask(ORG, id)).toEqual({ ok: false, reason: 'no_inflight' }); // the dead end
    expect(await store.forceResetTask(ORG, id)).toEqual({ ok: true, status: 'needs_attention' });
    const row = await pool.query<{ status: string; claimed_by: string | null; failure_count: number; last_error: string | null }>(
      'SELECT status, claimed_by, failure_count, last_error FROM task WHERE id=$1',
      [id]
    );
    // claimed_by cleared is what un-pins the agent (its "working" pill is derived purely from claimed_by).
    expect(row.rows[0]).toMatchObject({ status: 'needs_attention', claimed_by: null, failure_count: 0 });
    expect(row.rows[0]!.last_error).toContain('force-reset');
    expect(await versionOf(id)).toBe(version + 1);
  });

  it('forceResetTask also clears a stuck CLAIMED task (never started)', async () => {
    const { id } = await at('claimed');
    await pool.query('UPDATE task SET claimed_by=$2 WHERE id=$1', [id, 'elvis']);
    expect(await store.forceResetTask(ORG, id)).toEqual({ ok: true, status: 'needs_attention' });
    const row = await pool.query<{ status: string; claimed_by: string | null }>('SELECT status, claimed_by FROM task WHERE id=$1', [id]);
    expect(row.rows[0]).toMatchObject({ status: 'needs_attention', claimed_by: null });
  });

  it('forceResetTask is idempotent: a second call on the now-needs_attention task → conflict, no spurious version bump', async () => {
    const { id } = await at('executing');
    expect(await store.forceResetTask(ORG, id)).toEqual({ ok: true, status: 'needs_attention' });
    const v = await versionOf(id);
    expect(await store.forceResetTask(ORG, id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await versionOf(id)).toBe(v); // unchanged — only executing/claimed are resettable
  });

  it('forceResetTask refuses a task that is not executing/claimed (done/in_review/routable) and 404s when missing', async () => {
    const done = await at('done');
    expect(await store.forceResetTask(ORG, done.id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await statusOf(done.id)).toBe('done');
    const review = await at('in_review');
    expect(await store.forceResetTask(ORG, review.id)).toEqual({ ok: false, reason: 'conflict' });
    expect(await store.forceResetTask(ORG, '00000000-0000-0000-0000-000000000000')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('forceResetTask is tenant-scoped: another org cannot reset this org’s task (→ not_found)', async () => {
    const { id } = await at('executing');
    expect(await store.forceResetTask('00000000-0000-0000-0000-0000000000ff', id)).toEqual({ ok: false, reason: 'not_found' });
    expect(await statusOf(id)).toBe('executing'); // untouched by the wrong-tenant call
  });

  it('failNoCapacity: executing → needs_attention with the reason, failure_count UNTOUCHED (not the breaker)', async () => {
    const { id, version } = await at('executing');
    await pool.query('UPDATE task SET failure_count=1 WHERE id=$1', [id]); // a prior real failure
    expect(await store.failNoCapacity(ORG, id, 'no execution capacity: no agent-runner claimed within 30000ms')).toBe(true);
    const row = await pool.query<{ status: string; last_error: string; failure_count: number; version: number }>(
      'SELECT status, last_error, failure_count, version FROM task WHERE id=$1',
      [id]
    );
    expect(row.rows[0]).toMatchObject({ status: 'needs_attention', failure_count: 1 }); // budget NOT burned
    expect(row.rows[0]!.last_error).toContain('no execution capacity');
    expect(row.rows[0]!.version).toBe(version + 1);
  });

  it('failNoCapacity is guarded: a no-op once the task is no longer executing/claimed (operator already moved it)', async () => {
    const { id } = await at('routable'); // e.g. an operator reassigned it during the wait
    expect(await store.failNoCapacity(ORG, id, 'no execution capacity')).toBe(false);
    expect(await statusOf(id)).toBe('routable'); // untouched — never fights the operator
  });
});
