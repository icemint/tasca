import { describe, it, expect } from 'vitest';
import {
  TIERS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  isValidTransition,
  tierRank,
  tierAtLeast,
  type ClaimOutcome,
  type ClaimResult,
  type TaskStatus,
} from './index';

describe('tier rank (derived from TIERS order)', () => {
  it('ranks each tier by its position in TIERS', () => {
    TIERS.forEach((t, i) => expect(tierRank(t)).toBe(i));
  });

  it('tierAtLeast follows the derived order', () => {
    expect(tierAtLeast('ultra', 'basic')).toBe(true);
    expect(tierAtLeast('medium', 'medium')).toBe(true);
    expect(tierAtLeast('basic', 'ultra')).toBe(false);
  });
});

describe('task status transitions', () => {
  it('permits the documented edges and rejects illegal ones', () => {
    expect(isValidTransition('ingested', 'routable')).toBe(true);
    expect(isValidTransition('routable', 'claimed')).toBe(true);
    expect(isValidTransition('claimed', 'executing')).toBe(true);
    expect(isValidTransition('executing', 'in_review')).toBe(true);
    expect(isValidTransition('executing', 'routable')).toBe(true); // retry reset
    expect(isValidTransition('claimed', 'needs_attention')).toBe(true); // breaker trip
    expect(isValidTransition('needs_attention', 'routable')).toBe(true); // manual re-drive
    // pre-claim failure path (a throw before the CAS, task still routable):
    expect(isValidTransition('routable', 'needs_attention')).toBe(true); // pre-claim breaker trip
    expect(isValidTransition('routable', 'routable')).toBe(true); // pre-claim retry reset (version bump)
    // EM requirements gate (EM v1 slice 2): park unclear → awaiting_clarification, then reply-resume
    // (→routable) or loop-cap escalation (→needs_attention).
    expect(isValidTransition('routable', 'awaiting_clarification')).toBe(true); // EM parks an unclear story
    expect(isValidTransition('awaiting_clarification', 'routable')).toBe(true); // human reply re-drives it
    expect(isValidTransition('awaiting_clarification', 'needs_attention')).toBe(true); // loop-cap → operator
    // illegal:
    expect(isValidTransition('awaiting_clarification', 'claimed')).toBe(false); // can't claim a parked task
    expect(isValidTransition('done', 'awaiting_clarification')).toBe(false); // terminal stays terminal
    expect(isValidTransition('done', 'routable')).toBe(false); // terminal
    expect(isValidTransition('routable', 'done')).toBe(false); // skips the machine
    expect(isValidTransition('ingested', 'claimed')).toBe(false);
  });

  it('is internally consistent: every key + target is a real TaskStatus, done is terminal', () => {
    const statuses = new Set<TaskStatus>(TASK_STATUSES);
    expect(new Set(Object.keys(TASK_TRANSITIONS))).toEqual(statuses);
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const t of targets) expect(statuses.has(t)).toBe(true);
    }
    expect(TASK_TRANSITIONS.done).toEqual([]);
  });
});

describe('claim type collapse', () => {
  it('ClaimResult and ClaimOutcome are the same shape (alias)', () => {
    // Compile-time: each is assignable to the other. Runtime: a value satisfies both.
    const outcome: ClaimOutcome = { won: false, newVersion: null, found: true, currentStatus: 'claimed', currentVersion: 1 };
    const result: ClaimResult = outcome;
    const back: ClaimOutcome = result;
    expect(back.currentStatus).toBe('claimed');
  });
});
