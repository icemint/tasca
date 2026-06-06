// The coordination persistence seam. The orchestration loop reads/writes the
// coordination store through this interface; the Postgres impl below is the
// composition-root wiring, and tests inject an in-memory fake.
//
// CAS-claim persistence is NOT here — it rides @tasca/routing's ClaimPort
// (PgClaimRepository). This store owns the surrounding task lifecycle rows.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CapabilityMatch, Task, TaskStatus, TierEstimate } from '@tasca/domain';

/** A pool or a single checked-out connection — both expose `.query`. */
export type Queryable = Pool | PoolClient;

export interface CreateTaskInput {
  externalStoryId: string;
  platform: 'shortcut' | 'github' | 'linear';
  repoRef?: string | null;
}

export interface RecordWebhookResult {
  /** True when this insert created the ledger row (first delivery of this id). */
  fresh: boolean;
  /**
   * True when a row for this (platform, externalEventId) already exists AND it is
   * `processed` — i.e. orchestration durably completed for it, so a redelivery is
   * a genuine duplicate and must be dropped. A row that exists but is still
   * `received` (a prior attempt recorded the event then crashed before finishing)
   * is NOT alreadyProcessed: redelivery should re-drive it.
   */
  alreadyProcessed: boolean;
}

/**
 * The coordination store seam. Every method maps onto a §7 table; the loop
 * depends only on this interface so it is unit-testable with an in-memory fake.
 */
export interface CoordinationStore {
  /**
   * Idempotency ledger: record an inbound event as `received`. `fresh:true` when
   * this delivery created the row; `alreadyProcessed:true` when an existing row is
   * already `processed` (a true duplicate to drop). An existing-but-`received` row
   * returns `{fresh:false, alreadyProcessed:false}` so a crashed prior attempt is
   * re-driven on redelivery.
   */
  recordWebhookEvent(input: {
    platform: 'shortcut' | 'github' | 'linear';
    externalEventId: string;
    payload?: unknown;
  }): Promise<RecordWebhookResult>;

  /** Flip a ledger row to `processed` once orchestration has durably completed. */
  markWebhookProcessed(input: {
    platform: 'shortcut' | 'github' | 'linear';
    externalEventId: string;
  }): Promise<void>;

  /**
   * Get-or-create the task for a source story. A task is identified by
   * (platform, external_story_id): the first delivery creates it at status
   * `routable`, version 0; a later delivery / re-assignment returns the EXISTING
   * row as-is (whatever its current status, version, failure_count). This is what
   * lets a re-assigned story re-drive the same task and accumulate failures.
   */
  getOrCreateTask(input: CreateTaskInput): Promise<Task>;

  getTask(taskId: string): Promise<Task | null>;

  /** Persist the inspectable tier estimate onto the task. */
  setTierEstimate(taskId: string, estimate: TierEstimate): Promise<void>;

  /** Move a task to a new status, incrementing its version. */
  setStatus(taskId: string, status: TaskStatus): Promise<void>;

  /**
   * Return a task to a re-claimable state after a failed attempt below the
   * breaker threshold: status `routable`, `claimed_by` cleared, version bumped so
   * the next CAS uses a fresh expected version. Without this the failed task would
   * be stranded (the CAS only claims `routable` rows) and the breaker's retry
   * outcome would be unreachable.
   */
  resetForRetry(taskId: string): Promise<void>;

  /** Increment and return the task's failure_count (failure path). */
  incrementFailureCount(taskId: string): Promise<number>;

  /** Persist the routing decision (estimate + candidates + winner) for the inspector. */
  recordRoutingDecision(input: {
    taskId: string;
    tierEstimate: TierEstimate;
    candidates: CapabilityMatch[];
    winnerAgentId: string | null;
  }): Promise<void>;

  /** Persist the PR a run opened and link it to the task. */
  recordPullRequest(input: { taskId: string; url: string }): Promise<void>;
}

interface TaskRow {
  id: string;
  external_story_id: string;
  platform: string;
  status: string;
  version: number;
  claimed_by: string | null;
  failure_count: number;
  repo_ref: string | null;
  tier_estimate: TierEstimate | null;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    externalStoryId: row.external_story_id,
    platform: row.platform as Task['platform'],
    status: row.status as TaskStatus,
    version: row.version,
    claimedBy: row.claimed_by,
    failureCount: row.failure_count,
    repoRef: row.repo_ref,
    tierEstimate: row.tier_estimate,
  };
}

/**
 * Postgres implementation of the coordination store (raw `pg`, mirrors the
 * PgClaimRepository / PgIdentityRepository style). Constructor takes a pool or a
 * single connection.
 */
export class PgCoordinationStore implements CoordinationStore {
  constructor(private readonly db: Queryable) {}

  async recordWebhookEvent(input: {
    platform: 'shortcut' | 'github' | 'linear';
    externalEventId: string;
    payload?: unknown;
  }): Promise<RecordWebhookResult> {
    // Insert the ledger row as `received`. ON CONFLICT DO NOTHING means a fresh
    // delivery returns a row (rowCount 1); a redelivery returns none. For a
    // redelivery we must distinguish a genuine duplicate (existing row already
    // `processed`) from a crashed prior attempt (`received`) — so we read the
    // existing status and re-drive only the latter.
    const inserted = await this.db.query(
      `INSERT INTO webhook_event (id, platform, external_event_id, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'received')
       ON CONFLICT (platform, external_event_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), input.platform, input.externalEventId, JSON.stringify(input.payload ?? {})]
    );
    if (inserted.rowCount === 1) {
      return { fresh: true, alreadyProcessed: false };
    }
    const existing = await this.db.query<{ status: string }>(
      `SELECT status FROM webhook_event WHERE platform = $1 AND external_event_id = $2`,
      [input.platform, input.externalEventId]
    );
    return { fresh: false, alreadyProcessed: existing.rows[0]?.status === 'processed' };
  }

  async markWebhookProcessed(input: {
    platform: 'shortcut' | 'github' | 'linear';
    externalEventId: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE webhook_event SET status = 'processed', processed_at = now()
        WHERE platform = $1 AND external_event_id = $2`,
      [input.platform, input.externalEventId]
    );
  }

  async getOrCreateTask(input: CreateTaskInput): Promise<Task> {
    // Get-or-create on (platform, external_story_id). The no-op DO UPDATE makes
    // RETURNING fire on conflict too, so we always get the live row back — a new
    // one on first delivery, the existing one (with its accumulated version /
    // failure_count / status) on re-delivery.
    const res = await this.db.query<TaskRow>(
      `INSERT INTO task (id, external_story_id, platform, status, version, failure_count, repo_ref)
       VALUES ($1,$2,$3,'routable',0,0,$4)
       ON CONFLICT (platform, external_story_id)
         DO UPDATE SET external_story_id = EXCLUDED.external_story_id
       RETURNING id, external_story_id, platform, status, version, claimed_by, failure_count, repo_ref, tier_estimate`,
      [randomUUID(), input.externalStoryId, input.platform, input.repoRef ?? null]
    );
    return mapTask(res.rows[0]!);
  }

  async getTask(taskId: string): Promise<Task | null> {
    const res = await this.db.query<TaskRow>(
      `SELECT id, external_story_id, platform, status, version, claimed_by, failure_count, repo_ref, tier_estimate
         FROM task WHERE id = $1`,
      [taskId]
    );
    const row = res.rows[0];
    return row ? mapTask(row) : null;
  }

  async setTierEstimate(taskId: string, estimate: TierEstimate): Promise<void> {
    await this.db.query(
      `UPDATE task SET tier_estimate = $2::jsonb, updated_at = now() WHERE id = $1`,
      [taskId, JSON.stringify(estimate)]
    );
  }

  async setStatus(taskId: string, status: TaskStatus): Promise<void> {
    await this.db.query(
      `UPDATE task SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [taskId, status]
    );
  }

  async resetForRetry(taskId: string): Promise<void> {
    await this.db.query(
      `UPDATE task SET status = 'routable', claimed_by = NULL, version = version + 1, updated_at = now()
        WHERE id = $1`,
      [taskId]
    );
  }

  async incrementFailureCount(taskId: string): Promise<number> {
    const res = await this.db.query<{ failure_count: number }>(
      `UPDATE task SET failure_count = failure_count + 1, updated_at = now()
        WHERE id = $1 RETURNING failure_count`,
      [taskId]
    );
    return res.rows[0]!.failure_count;
  }

  async recordRoutingDecision(input: {
    taskId: string;
    tierEstimate: TierEstimate;
    candidates: CapabilityMatch[];
    winnerAgentId: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO routing_decision (id, task_id, tier_estimate, candidates, winner_agent_id)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)`,
      [
        randomUUID(),
        input.taskId,
        JSON.stringify(input.tierEstimate),
        JSON.stringify(input.candidates),
        input.winnerAgentId,
      ]
    );
  }

  async recordPullRequest(input: { taskId: string; url: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO pull_request (id, task_id, url) VALUES ($1,$2,$3)`,
      [randomUUID(), input.taskId, input.url]
    );
  }
}
