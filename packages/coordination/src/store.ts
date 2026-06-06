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
  /** False when this (platform, externalEventId) was already recorded. */
  fresh: boolean;
}

/**
 * The coordination store seam. Every method maps onto a §7 table; the loop
 * depends only on this interface so it is unit-testable with an in-memory fake.
 */
export interface CoordinationStore {
  /** Idempotency gate: record an inbound event; `fresh:false` if already seen. */
  recordWebhookEvent(input: {
    platform: 'shortcut' | 'github' | 'linear';
    externalEventId: string;
    payload?: unknown;
  }): Promise<RecordWebhookResult>;

  /** Persist a new task at status `routable`, version 0. */
  createTask(input: CreateTaskInput): Promise<Task>;

  getTask(taskId: string): Promise<Task | null>;

  /** Persist the inspectable tier estimate onto the task. */
  setTierEstimate(taskId: string, estimate: TierEstimate): Promise<void>;

  /** Move a task to a new status, incrementing its version. */
  setStatus(taskId: string, status: TaskStatus): Promise<void>;

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
    // ON CONFLICT DO NOTHING + RETURNING: a fresh insert returns a row, a
    // duplicate (same platform + event id) returns none — the idempotency gate.
    const res = await this.db.query(
      `INSERT INTO webhook_event (id, platform, external_event_id, payload)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (platform, external_event_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), input.platform, input.externalEventId, JSON.stringify(input.payload ?? {})]
    );
    return { fresh: res.rowCount === 1 };
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const res = await this.db.query<TaskRow>(
      `INSERT INTO task (id, external_story_id, platform, status, version, failure_count, repo_ref)
       VALUES ($1,$2,$3,'routable',0,0,$4)
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
