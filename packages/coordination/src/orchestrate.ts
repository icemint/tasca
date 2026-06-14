// The orchestration loop — the heart of @tasca/coordination (scaffold §6).
//
// Given an AdapterEvent{task.assigned}, run the forward path against injected
// ports/services, realizing the §6 step→package mapping:
//
//   ingest + persist task (routable, v0)        [store]                 §6.4
//     → estimateTier (heuristics + classifier)  [@tasca/routing]        §6.5
//     → persist routing decision                [store]                 §6.5
//     → matchCapability over eligible agents    [@tasca/routing]        §6.6
//     → canDispatch concurrency gate            [@tasca/routing]        §6.7
//     → atomicClaim (CAS)                        [@tasca/routing + db]   §6.8
//     → on win: dispatch reserveWorktree+spawn  [@tasca/execution]      §6.9-10
//     → openPr                                   [@tasca/execution]      §6.11
//     → status-back                              [StatusReporter port]   §6.12
//     → persist pull_request + audit_event       [store + identity]      §6.11-13
//   On execution failure: failure_count++ → breaker(n) → at N → needs_attention §6.14
//
// Everything I/O is a port; this module is pure composition. Tests inject fakes;
// the composition root (createCoordination) injects the real Postgres/exec impls.

import { createHash } from 'node:crypto';
import {
  estimateTier,
  matchCapability,
  canDispatch,
  atomicClaim,
  type MatchCandidate,
  type TaskInput,
  type ClaimPort,
  type LlmClassifierPort,
} from '@tasca/routing';
import type { AdapterEvent } from '@tasca/contracts';
import type { Task, TaskStatus } from '@tasca/domain';
import type { DispatchQueue } from '@tasca/db';
import { ExecutionError, type ExecutionPort } from '@tasca/execution';
import type { CoordinationStore } from './store';
import type { StatusReporter, Logger } from './ports';
import { withUsageContext } from './usage-context';
import { DEFAULT_ORG_ID } from './resolve-org';

/**
 * Supplies the routing candidates (capability profile + live state + active
 * count) for an event. The composition root implements this over
 * @tasca/identity (profiles) + the store (active counts); tests fake it.
 */
export interface AgentDirectory {
  /** The org's HIRED agents eligible for a task, as routing MatchCandidates (slice 5d). Scoped to
   *  `orgId` (the task's org): routing only ever considers agents the org has hired — a global agent
   *  the org hasn't hired is structurally absent here, so it can never be routed to. */
  listCandidates(orgId: string, task: Task): Promise<MatchCandidate[]>;
  /** Resolve an `agent:<name>` label to a HIRED agent's id for `orgId`, or null when the org hasn't
   *  hired an agent by that name (slice 5d). null → the caller fails closed (never routes to an
   *  unhired agent); the label is a preference within the hired set, not a bypass of it. */
  findHiredAgentByName(orgId: string, name: string): Promise<string | null>;
  /** The agent's stable audit principal id (for audit_event attribution). */
  principalIdFor(agentId: string): Promise<string | null>;
}

/** The narrow slice of OrchestrationDeps the finalize seam needs — also what the reaper
 *  (which finalizes a runner-completed job out of band) supplies. */
export interface FinalizeDeps {
  store: CoordinationStore;
  status: StatusReporter;
  audit: AuditSink;
  logger?: Logger;
}

/** The event fields finalize/audit actually read — so a caller (e.g. the reaper) that
 *  only has the dispatch payload can finalize without fabricating a whole AdapterEvent. */
export interface FinalizeEvent {
  platform: AdapterEvent['platform'];
  externalStoryId: string;
}

/** Append-only audit seam (the @tasca/identity audit trail). */
export interface AuditSink {
  record(input: {
    principalId: string;
    agentId: string;
    action: string;
    target?: string;
    platform?: 'shortcut' | 'github' | 'linear';
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

/** Resolves the task's title/body/labels for tier estimation from the event. */
export interface TaskContentSource {
  fetch(event: AdapterEvent): Promise<TaskInput>;
}

/** A provisioned local checkout: the filesystem path + the repo's default branch. */
export interface ProvisionedRepo {
  /** Local clone path, for reserveWorktree's repoPath. */
  path: string;
  /** The clone's default branch (e.g. `main`) — passed as the worktree base ref so
   *  reserveWorktree branches off `origin/<defaultBranch>` instead of looking up
   *  per-project settings the headless flow never created. */
  defaultBranch: string;
}

/**
 * Ensures a local checkout of a repo (identified by an `owner/repo` ref) exists
 * with an authenticated `origin`, returning its path + default branch so
 * reserveWorktree can take a worktree from it. Throws on failure (no installation,
 * clone error) — the forward-path catch treats that like any dispatch failure.
 */
export interface RepoProvisioner {
  ensureLocalRepo(repoRef: string): Promise<ProvisionedRepo>;
  /**
   * Create an isolated worktree for one task off the provisioned local clone,
   * returning its path + branch + base ref. The provisioner owns worktree creation
   * (rather than ExecutionPort.reserveWorktree) because the clone's origin is
   * tokenless — the vendored worktree path would `git fetch origin` + push, which a
   * tokenless origin can't authenticate. Branches off `origin/<defaultBranch>`.
   */
  createWorktree(
    repoRef: string,
    taskLabel: string
  ): Promise<{ path: string; branch: string; baseRef: string }>;
  /** A current installation token for the repo's owner — used to auth `gh pr create`
   *  AND the env-auth'd `git push` in open-pr (the tokenless origin can't auth it). */
  tokenForRepo(repoRef: string): Promise<string>;
  /**
   * Reclaim a worktree created by createWorktree: remove the worktree dir + its
   * branch + prune stale admin entries. Best-effort (never throws) — called once a
   * dispatch terminates (success OR failure) so re-drives don't accumulate worktrees
   * and branches without bound under the worker's repos dir.
   */
  removeWorktree(repoRef: string, worktreePath: string, branch: string): Promise<void>;
}

export interface OrchestrationDeps {
  store: CoordinationStore;
  claim: ClaimPort;
  execution: ExecutionPort;
  status: StatusReporter;
  directory: AgentDirectory;
  audit: AuditSink;
  content: TaskContentSource;
  /** Resolve the tier classifier for an org, on the org's OWN vault key (BYOK, slice 3.5-A.2a). Returns
   *  null when the org has no key (→ heuristic routing). Absent → no LLM classifier at all (heuristic). */
  classifierFor?: (orgId: string) => Promise<LlmClassifierPort | null>;
  /** Resolve the org's OWN Anthropic vault key for an agent run (BYOK agent execution, slice 3.5-A.2b).
   *  null → the org has NO key → the in-process spawn FAILS CLOSED (needs_attention, no agent). Present
   *  ONLY with startAgentProxy (both come from the credential vault wiring); absent (tests / fakes) →
   *  the agent spawns without a proxy and no key is injected. */
  agentVendorResolver?: (orgId: string) => Promise<string | null>;
  /** Start an EPHEMERAL per-task Anthropic proxy baked with the resolved org key + the {org,task} for
   *  metering, returning its base url (the agent's ANTHROPIC_BASE_URL) + a close() torn down after the
   *  run. A PER-TASK instance (no shared-context race under concurrent in-process dispatch). Present ONLY
   *  with agentVendorResolver. */
  startAgentProxy?: (opts: { apiKey: string; usageContext: { orgId: string; taskId: string } }) => Promise<{ baseUrl: string; close: () => Promise<void> }>;
  /** Resolves a GitHub `owner/repo` slug to a local clone path before dispatch.
   *  Absent → repoRef is used as-is (Stage-1 single-checkout / test behavior). */
  provisioner?: RepoProvisioner;
  /**
   * The dispatch queue (the coordination→execution split). When wired, a dispatch is
   * ENQUEUED for an agent-runner; coordination waits (polling) for a runner to claim it.
   * If none claims within `runnerWaitMs`, the task is retired to `needs_attention` with a
   * "no execution capacity" reason — NEVER run in-process (the hardened boundary holds).
   * Absent → no queue: the agent runs in-process (Stage-1 single-process / test mode).
   */
  dispatchQueue?: DispatchQueue;
  /** How long to wait (polling) for a runner to claim before retiring the task to
   *  needs_attention. Default 30000ms — long enough to absorb a runner redeploy, short
   *  enough that a real outage escalates visibly. Override via TASCA_RUNNER_WAIT_MS. */
  runnerWaitMs?: number;
  /** Poll interval while waiting for a runner claim. Default 500ms. */
  runnerPollMs?: number;
  /** Breaker threshold; defaults to 2 (scaffold §3.2). */
  breakerThreshold?: number;
  /** Per-project concurrency limit for the dispatch gate. */
  perProjectLimit?: number;
  /** Max wall-clock for one agent run before it's killed + the task fails; default 600000ms. */
  agentTimeoutMs?: number;
  /** Structured logger; used to surface best-effort finalize failures (never throws). */
  logger?: Logger;
}

/** Default agent-run timeout (10 min) — a hung agent is killed so the breaker fires. */
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
/** Above this prompt length the issue body is capped (see buildClaudeCommand); we log it. */
const PROMPT_TRUNCATE_THRESHOLD = 60_000;
/** Default window to wait (polling) for an agent-runner to claim an enqueued job before
 *  the task is retired to needs_attention. 30s absorbs a routine runner redeploy (cached
 *  image + Node boot + first claim poll, ~10–25s) while escalating a real outage fast. */
const DEFAULT_RUNNER_WAIT_MS = 30_000;
/** Default poll interval while waiting for a runner to claim. */
const DEFAULT_RUNNER_POLL_MS = 500;

/** What coordination enqueues for an agent-runner — everything the runner needs to
 *  execute the task. Mirrors @tasca/agent-runner's DispatchPayload (jsonb on the wire). */
export interface DispatchPayload {
  taskId: string;
  /** The task's org — carried in the payload (like taskId) so the runner can stamp per-task/per-org
   *  attribution onto the agent's model calls for metering (slice W3-S4b). */
  orgId: string;
  repoRef: string;
  platform: AdapterEvent['platform'];
  externalStoryId: string;
  agentId: string;
  prompt: string;
  headBranch: string;
  /** The projection-model PR body (precomputed like headBranch so the runner doesn't re-derive it):
   *  GitHub `Closes #N`, Shortcut `[sc-<id>]`, else absent. See prBodyReference. */
  prBody?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Build the agent's prompt from the real story content. Shared by the enqueued
 *  payload and the in-process path so a runner and the fallback run the SAME task. */
function buildAgentPrompt(content: { title: string; body: string }): string {
  return (
    'You are an autonomous software engineer working in a fresh checkout of this repository. ' +
    'Implement the task below: make the necessary code changes and commit them with a clear message. ' +
    'Make only the changes the task requires.\n\n' +
    `Task: ${content.title}\n\n${content.body}`
  );
}

export type OrchestrationOutcome =
  | { kind: 'dispatched'; taskId: string; agentId: string; prUrl: string }
  | { kind: 'lost_claim'; taskId: string; agentId: string }
  | { kind: 'no_candidate'; taskId: string }
  | { kind: 'not_routable'; taskId: string; status: TaskStatus }
  | { kind: 'needs_attention'; taskId: string; failureCount: number }
  | { kind: 'failed'; taskId: string; failureCount: number }
  // The agent ran but committed nothing (deterministic no-op) → retired to needs_attention WITHOUT
  // the breaker (no re-route, no retry-burn). Distinct from `failed` so it reads honestly.
  | { kind: 'no_changes'; taskId: string }
  // No agent-runner claimed the enqueued job within the wait bound → retired to
  // needs_attention with a "no execution capacity" reason (the breaker is untouched).
  | { kind: 'no_capacity'; taskId: string; agentId: string }
  // An operator cancel/reassign took the job mid-wait (the job is `cancelled`); the
  // canceller owns the task's post-cancel state, so orchestration just bows out.
  | { kind: 'preempted'; taskId: string; agentId: string }
  // A GitHub work event for an UNCONNECTED workspace (slice 5c): the App is installed but not bound
  // to an org, so we FAIL CLOSED — no task, no agent run, never the default tenant. The customer
  // completes Connect to bind the workspace's org. No taskId (nothing was created).
  | { kind: 'unconnected'; taskId: null; platform: AdapterEvent['platform']; workspace: string | null }
  // The org has hired NO agents (slice 5d) → the task is retired to needs_attention ("no agents
  // hired"). Fail-closed honesty, never a default agent.
  | { kind: 'no_roster'; taskId: string }
  // The org has no Anthropic vault key (BYOK agent execution, slice 3.5-A.2b) → the agent CANNOT run
  // on a server key (there is none), so the task is retired to needs_attention BEFORE any spawn.
  | { kind: 'no_agent_key'; taskId: string }
  // The vault key RESOLVE itself threw (a transient credential-store read fault, distinct from a clean
  // "no key configured") → the task is retired to needs_attention with no breaker burn (slice 3.5-A.2b).
  | { kind: 'key_unavailable'; taskId: string }
  // An `agent:<name>` label named an agent the org has NOT hired (slice 5d) → needs_attention. The
  // label is a preference within the hired set, not a bypass — so an unhired name fails closed.
  | { kind: 'agent_not_hired'; taskId: string };

/**
 * Resolve the org a webhook event acts in (slice 5c). A CONNECTED workspace resolves to its real
 * org (including a grandfathered org_default for pre-5c installs). An UNCONNECTED workspace:
 *  - GitHub REQUIRES a connection → returns null (the caller FAILS CLOSED — never the default org;
 *    an installed-but-unbound account must not have its work run in someone else's tenant).
 *  - Platforms without a connect flow yet (shortcut/linear) → the documented single-tenant
 *    grandfather DEFAULT_ORG_ID, removed when those platforms get their own connect flow.
 */
/** Extract the agent name from an `agent:<name>` label (case-insensitive; first match wins), or
 *  null. The assignment-intake override signal (slice 5d). */
export function agentLabel(labels: string[] | undefined): string | null {
  for (const l of labels ?? []) {
    const m = /^agent:(.+)$/i.exec(l.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

export async function resolveWebhookOrg(
  store: Pick<CoordinationStore, 'getOrgForConnection'>,
  platform: AdapterEvent['platform'],
  workspace: string | null
): Promise<string | null> {
  const org = await store.getOrgForConnection(platform, workspace ?? '');
  if (org !== null) return org;
  return platform === 'github' ? null : DEFAULT_ORG_ID;
}

/**
 * The workspace an event belongs to (for resolving its org via a platform_connection).
 * GitHub: the account/owner login (the `owner` of `owner/repo` — from repoHint, else the
 * `owner/repo#n` story id). Shortcut/Linear carry no workspace in the event yet (their
 * connection mapping arrives with onboarding, slice 5), so they resolve to null → the
 * webhook edge uses the default org. Exported so the server's ledger edge derives the same
 * workspace as the orchestration path, keeping a delivery's ledger + tasks on one org.
 */
export function workspaceForEvent(
  event: Pick<AdapterEvent, 'platform' | 'externalStoryId' | 'repoHint'>
): string | null {
  if (event.platform !== 'github') return null;
  const fromHint = event.repoHint?.split('/')[0];
  if (fromHint) return fromHint;
  const m = /^([^/#]+)\//.exec(event.externalStoryId);
  return m ? m[1]! : null;
}

/**
 * Run the forward path for one task.assigned event. Returns a structured
 * outcome so the caller (HTTP entry / tests) can assert on what happened.
 */
export async function orchestrateTaskAssigned(
  event: AdapterEvent,
  deps: OrchestrationDeps
): Promise<OrchestrationOutcome> {
  const breakerThreshold = deps.breakerThreshold ?? 2;
  const perProjectLimit = deps.perProjectLimit ?? 1;
  const agentTimeoutMs = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

  // Resolve the org this event acts in (the webhook EDGE) from the workspace's connection. A
  // GitHub event for an UNCONNECTED workspace fails CLOSED (slice 5c) — the App is installed but
  // not bound to an org, so it must not run in the default tenant. Other platforms keep the
  // grandfather default. Past this point every store call carries an explicit, real org.
  const orgId = await resolveWebhookOrg(deps.store, event.platform, workspaceForEvent(event));
  if (orgId === null) {
    deps.logger?.info?.('coordination: github event for an unconnected workspace — fail closed', {
      platform: event.platform,
      externalStoryId: event.externalStoryId,
    });
    return { kind: 'unconnected', taskId: null, platform: event.platform, workspace: workspaceForEvent(event) };
  }

  // §6.4 — ingest: get-or-create the task for this story (routable, v0 on first
  // delivery; the existing row on re-delivery / re-assignment). Re-driving the
  // same row is what lets failure_count accumulate toward the breaker (§6.14).
  const repoRef = event.repoHint ?? null;
  const task = await deps.store.getOrCreateTask(orgId, {
    externalStoryId: event.externalStoryId,
    platform: event.platform,
    repoRef,
  });

  // Only a `routable` task is drivable. A re-delivery of a story that is already
  // in-flight (claimed/executing/in_review), resolved (done), or escalated
  // (needs_attention) must NOT be re-driven — return its current state before
  // doing any tier estimation or writing a spurious routing_decision. Auto-recover
  // re-drives go through the failure path, which resets the task to `routable`.
  if (task.status !== 'routable') {
    return { kind: 'not_routable', taskId: task.id, status: task.status };
  }

  // The whole forward path is guarded so a failure of ANY phase — routing/content
  // (pre-claim) as well as execution (post-claim) — feeds the breaker (§6.14).
  // Without this, a persistent pre-claim failure (e.g. a broken content source or
  // a throwing classifier) would strand the task at `routable` forever, never
  // counted and never escalated. `no_candidate`/`lost_claim` are normal outcomes,
  // not errors, so they `return` and bypass the catch.
  let winnerAgentId: string | null = null;
  let principalId: string | null = null;
  // Set only on the provisioner path, so the finally can reclaim the worktree +
  // branch the provisioner created once the dispatch terminates (success OR failure)
  // — without it, every dispatch and every re-drive leaks a worktree under reposDir.
  let provisionedWorktree: { path: string; branch: string } | undefined;
  try {
    // §6.5 — estimate tier (heuristics + one budgeted/cached classifier call),
    // then persist it (inspectable). CONTENT PRECEDENCE (slice W3-S1c): a decomposition CHILD is a
    // Tasca-internal task with NO platform story — it carries its own content. Use the stored content
    // for a synthetic child; a NORMAL task (no stored content) fetches from its platform adapter.
    const origin = await deps.store.getTaskOrigin(orgId, task.id);
    const content: TaskInput = origin?.content ?? (await deps.content.fetch(event));
    // Attribute the classifier's LLM call (if any) to this task/org (slice W3-S4a). estimateTier may
    // call the classifier; the usage context tags its spend as source='classifier' for this task.
    // BYOK (slice 3.5-A.2a): the classifier resolves THIS org's (= the instance's) own vault key per
    // task and runs on it — no server key. No key configured → null → heuristic routing (fail-soft).
    const classifier = deps.classifierFor ? await deps.classifierFor(orgId) : null;
    const estimate = await withUsageContext({ orgId, taskId: task.id, source: 'classifier' }, () =>
      estimateTier(
        content,
        classifier
          ? {
              classifier,
              // The classifier degrades to heuristic on failure (fail-soft) — but LOUDLY: a misconfigured
              // classifier (bad model id, bad key, endpoint) otherwise silently disables the paid feature
              // AND writes no usage_event, looking healthy. Surfaced at error level so it can't hide.
              onClassifierError: (err) =>
                deps.logger?.error('coordination: tier classifier call FAILED — degraded to heuristic (UNMETERED)', {
                  taskId: task.id,
                  err: err instanceof Error ? err.message : String(err),
                }),
            }
          : {}
      )
    );
    await deps.store.setTierEstimate(orgId, task.id, estimate);

    // §6.6 — match capability over the org's HIRED agents (slice 5d). The candidate set is
    // org-scoped: routing only ever considers agents this org hired.
    const taskForMatch: Task = { ...task, tierEstimate: estimate };
    const candidates = await deps.directory.listCandidates(orgId, taskForMatch);

    // §5d — EMPTY ROSTER: the org has hired no agents → fail closed honestly (needs_attention with a
    // reason), never a crash or a default agent.
    if (candidates.length === 0) {
      await deps.store.recordRoutingDecision(orgId, {
        taskId: task.id,
        tierEstimate: estimate,
        candidates: [],
        winnerAgentId: null,
      });
      await deps.store.retireUnroutable(orgId, task.id, 'no agents hired');
      deps.logger?.info?.('coordination: org has hired no agents — task → needs_attention', { taskId: task.id });
      return { kind: 'no_roster', taskId: task.id };
    }

    const ranked = matchCapability(estimate, candidates);

    // §5d + W3-S1 — ASSIGNMENT INTAKE: a routing PREFERENCE picks a specific agent; otherwise the
    // routing engine (the crown jewel) picks the top eligible candidate. Two preference sources, in
    // precedence order: (1) the Tasca-side `preferred_agent_id` — an accepted PM-assistant routing
    // proposal, already a resolved agent id; (2) the platform `agent:<name>` label (5d), resolved by
    // name. Either way the preference is WITHIN the hired set — a preferred/labeled agent the org has
    // NOT hired fails closed (needs_attention), never a route to an unhired agent. The deterministic
    // engine + atomic claim still dispose; the preference only biases which hired agent wins.
    const labelName = agentLabel(content.labels);
    let winnerId: string | null = null;
    let unhiredPreference = false;
    let requestedAgent: string | null = null;
    if (task.preferredAgentId) {
      // (1) accepted PM-assistant routing proposal — a resolved hired agent id at accept time.
      requestedAgent = task.preferredAgentId;
      if (candidates.some((c) => c.profile.agentId === task.preferredAgentId)) {
        winnerId = task.preferredAgentId;
      } else {
        unhiredPreference = true; // unhired since accept → fail closed (never route elsewhere silently)
      }
    } else if (labelName) {
      // (2) platform `agent:<name>` label — resolve by name within the hired set.
      requestedAgent = labelName;
      const namedId = await deps.directory.findHiredAgentByName(orgId, labelName);
      if (namedId && candidates.some((c) => c.profile.agentId === namedId)) {
        winnerId = namedId; // labeled a HIRED agent → override the routing pick
      } else {
        unhiredPreference = true; // labeled an agent the org hasn't hired → fail closed below
      }
    } else {
      winnerId = ranked.find((m) => m.eligible)?.agentId ?? null;
    }

    await deps.store.recordRoutingDecision(orgId, {
      taskId: task.id,
      tierEstimate: estimate,
      candidates: ranked,
      winnerAgentId: winnerId,
    });

    if (unhiredPreference) {
      await deps.store.retireUnroutable(orgId, task.id, `requested agent '${requestedAgent}' is not hired`);
      deps.logger?.info?.('coordination: requested agent not hired — task → needs_attention', { taskId: task.id, requested: requestedAgent });
      return { kind: 'agent_not_hired', taskId: task.id };
    }
    if (winnerId === null) {
      return { kind: 'no_candidate', taskId: task.id };
    }

    const winner = { agentId: winnerId };
    const winningCandidate = candidates.find((c) => c.profile.agentId === winner.agentId)!;

    // §6.7 — concurrency + same-repo gate (advisory pre-claim early-out).
    const gate = canDispatch(
      winningCandidate.profile,
      {
        perAgentActive: winningCandidate.activeCount,
        perProjectActive: winningCandidate.activeCount,
        repoBusy: false,
      },
      { perProjectLimit }
    );
    if (!gate.ok) {
      return { kind: 'no_candidate', taskId: task.id };
    }

    // §6.8 — atomic claim (CAS). The conditional write is the hard exactly-one
    // guarantee; on loss another worker already owns the task.
    const claim = await atomicClaim(deps.claim, orgId, task.id, winner.agentId, task.version);
    if (!claim.won) {
      // Surface WHY the CAS missed (lost race vs stale version vs gone) for ops.
      deps.logger?.info?.('coordination: claim lost', {
        taskId: task.id,
        agentId: winner.agentId,
        found: claim.found,
        currentStatus: claim.currentStatus ?? null,
        currentVersion: claim.currentVersion ?? null,
      });
      return { kind: 'lost_claim', taskId: task.id, agentId: winner.agentId };
    }

    // Past the claim: this worker owns the task — record who, for failure audit.
    winnerAgentId = winner.agentId;
    principalId = await deps.directory.principalIdFor(winner.agentId);
    await audit(deps, principalId, winner.agentId, event, {
      action: 'task.claim',
      target: task.id,
      payload: { tier: estimate.tier },
    });

    // Idempotency guard: a prior attempt may have opened + recorded a PR, then
    // failed a later (finalize) step before the loop returned, leaving the task
    // re-drivable. Re-running the agent + opening a SECOND PR on a real customer
    // repo is the worst outcome — so if a PR is already recorded, skip dispatch
    // entirely and re-finalize (best-effort) against the existing PR.
    const existingPrs = await deps.store.listPullRequestsForTask(orgId, task.id);
    if (existingPrs.length > 0) {
      const prUrl = existingPrs[0]!.url;
      // The row was just re-claimed (claimed). Mirror the normal path's
      // claimed→executing move before finalizing — finalize advances
      // executing→in_review, and the write-path guard rejects claimed→in_review,
      // which would otherwise (silently, via finalize's best-effort wrapper) strand
      // the task in `claimed` with an open PR.
      await deps.store.setStatus(orgId, task.id, 'executing');
      await finalizeDispatch(deps, orgId, task.id, event, winner.agentId, principalId, prUrl);
      return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl };
    }

    // §6.9-13 — dispatch → worktree + agent → PR → status-back.
    await deps.store.setStatus(orgId, task.id, 'executing');

    // The agent prompt (shared by the enqueued payload + the in-process path so a
    // runner and the fallback run the SAME task). content is the real story body.
    const prompt = buildAgentPrompt(content);
    if (prompt.length > PROMPT_TRUNCATE_THRESHOLD) {
      deps.logger?.info?.('coordination: agent prompt truncated to fit', {
        taskId: task.id,
        promptChars: prompt.length,
        capChars: PROMPT_TRUNCATE_THRESHOLD,
      });
    }

    // SPLIT DISPATCH (when a queue is wired): enqueue the job for an agent-runner and WAIT
    // (polling) for a runner to claim it. The hardened boundary HOLDS — there is no longer
    // an in-process fallback: if no runner claims within the wait bound, the task is retired
    // to needs_attention with an honest "no execution capacity" reason (visible + actionable),
    // NEVER run in-process co-located with the master key. `cancel` stays the race-safe hinge
    // at the timeout boundary.
    if (deps.dispatchQueue && repoRef) {
      const payload: DispatchPayload = {
        taskId: task.id,
        orgId,
        repoRef,
        platform: event.platform,
        externalStoryId: event.externalStoryId,
        agentId: winner.agentId,
        prompt,
        headBranch: deterministicHeadBranch(event.platform, event.externalStoryId),
        ...(prBodyReference(event) ? { prBody: prBodyReference(event)! } : {}),
      };
      const { id: jobId } = await deps.dispatchQueue.enqueue({
        orgId,
        taskId: task.id,
        payload: payload as unknown as Record<string, unknown>,
      });
      const waitMs = deps.runnerWaitMs ?? DEFAULT_RUNNER_WAIT_MS;
      const pollMs = deps.runnerPollMs ?? DEFAULT_RUNNER_POLL_MS;
      const claim = await awaitRunnerClaim(deps.dispatchQueue, jobId, waitMs, pollMs);
      if (claim === 'claimed') {
        // A runner owns the task; the reaper finalizes on completion (PR url unknown here).
        deps.logger?.info?.('coordination: dispatched to an agent-runner', { taskId: task.id, jobId });
        return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: '(runner)' };
      }
      if (claim === 'preempted') {
        // An operator cancel/reassign flipped the job to `cancelled` mid-wait; the canceller
        // owns the task's post-cancel state. Bow out — never claim 'dispatched' for it.
        deps.logger?.info?.('coordination: dispatch preempted by an operator cancel/reassign', { taskId: task.id, jobId });
        return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
      }
      // claim === 'timeout': the job is still queued past the bound. cancel() decides it
      // atomically — true ⇒ we deleted a still-queued job (genuinely no runner); false ⇒
      // a runner or operator took it in the last gap, so defer to its true status.
      const removed = await deps.dispatchQueue.cancel(jobId);
      if (!removed) {
        const st = await deps.dispatchQueue.jobStatus(jobId);
        if (st === 'cancelled' || st === null) {
          return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
        }
        deps.logger?.info?.('coordination: a runner claimed at the wait boundary', { taskId: task.id, jobId });
        return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: '(runner)' };
      }
      // Genuinely no execution capacity. Retire to needs_attention WITHOUT the breaker —
      // a runner outage is infra-unavailability, not an agent failure, so it must not burn
      // the task's retry budget. The reason is recorded in last_error for the operator.
      const reason = `no execution capacity: no agent-runner claimed within ${waitMs}ms`;
      const acted = await deps.store.failNoCapacity(orgId, task.id, reason);
      if (!acted) {
        // The guard missed: an operator cancel/reassign moved the task out of executing
        // during the wait. They own it — don't claim a no_capacity we didn't apply.
        deps.logger?.info?.('coordination: no-capacity retire skipped; task already moved (operator)', { taskId: task.id, jobId });
        return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
      }
      deps.logger?.error('coordination: no runner claimed within the wait bound; task → needs_attention (no execution capacity)', {
        taskId: task.id,
        jobId,
        waitMs,
      });
      return { kind: 'no_capacity', taskId: task.id, agentId: winner.agentId };
    }

    // NO-QUEUE MODE ONLY (deps.dispatchQueue absent, or no repoRef to dispatch): run the
    // agent IN-PROCESS. This is the Stage-1 single-process / test execution path, NOT a
    // production fallback — when the queue is wired, the branch above always returns.
    // Provision a worktree for the agent run. A GitHub event's repoHint is an
    // `owner/repo` slug, not a local path. With a provisioner we ensure the
    // (tokenless-origin) local clone exists, then have the PROVISIONER create the
    // worktree — NOT ExecutionPort.reserveWorktree, whose vendored path would
    // `git fetch origin` + pushOnCreate against an origin we can no longer
    // authenticate. The provisioner branches off `origin/<defaultBranch>` and
    // returns that as the base ref. Without a provisioner (Stage-1 single-checkout /
    // tests) we keep reserveWorktree, repoRef used as-is and no base-ref override.
    let worktree: { path: string; branch: string };
    let baseRef: string | undefined;
    if (repoRef && deps.provisioner) {
      await deps.provisioner.ensureLocalRepo(repoRef);
      const created = await deps.provisioner.createWorktree(repoRef, event.externalStoryId);
      worktree = created;
      baseRef = created.baseRef;
      provisionedWorktree = { path: created.path, branch: created.branch };
    } else {
      worktree = await deps.execution.reserveWorktree({
        repoPath: repoRef ?? '.',
        taskLabel: event.externalStoryId,
        projectId: event.externalStoryId,
      });
    }

    // BYOK agent execution (slice 3.5-A.2b): the in-process agent runs on the ORG'S OWN vault key — never
    // a server key (there is none). When the vault wiring is present (prod), resolve the org's Anthropic
    // key BEFORE the spawn. A null key FAILS CLOSED — retire to needs_attention with an actionable reason
    // (no breaker, no spawn), mirroring retireNoChanges. With a key, start an EPHEMERAL per-task proxy
    // baked with it + the {org,task} for metering, point the agent at it via a per-task ANTHROPIC_BASE_URL,
    // and tear it down after the run (always, in finally). A per-task proxy instance avoids the shared
    // bridge's setContext race under concurrent in-process dispatch. Without the wiring (tests / fakes),
    // the agent spawns with no proxy and no key injected (the fake execution port ignores env).
    let agentProxy: { baseUrl: string; close: () => Promise<void> } | undefined;
    if (deps.agentVendorResolver && deps.startAgentProxy) {
      let orgKey: string | null;
      try {
        orgKey = await deps.agentVendorResolver(orgId);
      } catch (err) {
        // A THROW here is a transient credential-store read fault (the vault reader's pg read is
        // unguarded — only the decrypt itself fails closed to null), NOT a config issue and NOT an agent
        // failure. Divert it to the SAME no-breaker terminal as the no-key branch: do NOT fall through to
        // the outer catch, which would bump failure_count, re-drive the identical task, and surface a
        // misleading 'task.failed'. The agent never ran (this precedes startAgentProxy + spawn), so
        // fail-closed safety holds; the operator re-drives once the store is back.
        const reason = 'credential service unavailable — retry when restored';
        deps.logger?.error?.('coordination: vendor key resolve failed — agent fail-closed, task → needs_attention', {
          taskId: task.id,
          err: String(err),
        });
        const acted = await deps.store.retireNoChanges(orgId, task.id, reason);
        if (!acted) {
          return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
        }
        return { kind: 'key_unavailable', taskId: task.id };
      }
      if (orgKey === null) {
        const reason = 'no API key configured — ask an admin';
        deps.logger?.info?.('coordination: org has no Anthropic key — agent fail-closed, task → needs_attention', {
          taskId: task.id,
        });
        const acted = await deps.store.retireNoChanges(orgId, task.id, reason);
        if (!acted) {
          deps.logger?.info?.('coordination: no-key retire skipped — task already moved (operator owns it)', {
            taskId: task.id,
          });
          return { kind: 'preempted', taskId: task.id, agentId: winner.agentId };
        }
        return { kind: 'no_agent_key', taskId: task.id };
      }
      agentProxy = await deps.startAgentProxy({ apiKey: orgKey, usageContext: { orgId, taskId: task.id } });
    }

    // §6.10 — spawn the agent over a PTY; await its exit before opening the PR. The
    // prompt was built above (shared with the enqueued payload). The body is
    // attacker-controlled; it reaches the shell only through the POSIX-quoted claude
    // command the factory builds from `prompt`. When a per-task proxy is running, the
    // agent reaches Anthropic ONLY through it (ANTHROPIC_BASE_URL) — the real key is
    // injected proxy-side and never enters the agent env.
    let agentRun;
    try {
      agentRun = await runAgentToCompletion(
        deps.execution,
        {
          id: task.id,
          cwd: worktree.path,
          prompt,
          ...(agentProxy ? { env: { ANTHROPIC_BASE_URL: agentProxy.baseUrl } } : {}),
        },
        agentTimeoutMs
      );
    } finally {
      // Tear down the per-task proxy on EVERY path (success, throw, timeout) so it never lingers. Best-
      // effort: a close failure is logged, never masks the agent's real outcome (or a thrown error).
      if (agentProxy) {
        await agentProxy.close().catch((err: unknown) =>
          deps.logger?.error?.('coordination: per-task anthropic proxy close failed', {
            taskId: task.id,
            err: String(err),
          })
        );
      }
    }
    // Always surface what the agent did — its exit code + output tail — so a
    // no-diff run (below) is diagnosable: did it edit nothing, hit an auth error,
    // run in the wrong place, find no usable tools?
    deps.logger?.info?.('coordination: agent run complete', {
      taskId: task.id,
      exitCode: agentRun.exitCode,
      outputChars: agentRun.outputTail.length,
      outputTail: agentRun.outputTail,
    });

    // Verify a real change landed BEFORE opening a PR — never open an empty PR.
    // Stage + commit whatever the agent left, then check the worktree HEAD is
    // ahead of the base. `baseRef` is only set on the provisioner path; on the
    // no-provisioner path it's undefined, so pass '' (commitAgentWork then bases
    // `changed` on whether this call committed, not a rev-list count).
    const work = await deps.execution.commitAgentWork({
      cwd: worktree.path,
      message: `Tasca: ${event.externalStoryId}`,
      baseRef: baseRef ?? '',
    });
    if (!work.changed) {
      throw new ExecutionError(
        'no-changes',
        `agent run produced no committed changes for ${event.externalStoryId}`
      );
    }

    // §6.11 — open the PR, then record it. recordPullRequest is the durable proof
    // the deliverable exists; everything after it is best-effort finalize that must
    // NOT throw (a throw here would drive the failure reset → re-drive → duplicate PR).
    //
    // The PR head is a DETERMINISTIC branch derived from the story, NOT the
    // worktree's local branch (which carries a random per-attempt suffix). So if a
    // re-drive ever reaches openPr again (e.g. recordPullRequest failed to commit
    // before the row landed), it pushes to the SAME head and `gh pr create` returns
    // the existing PR instead of opening a second one on the customer repo.
    // `gh pr create` (inside openPr) needs its own token — the worktree origin
    // authenticates the git push, but gh doesn't read that. Obtain a current
    // installation token for the owner (the App client returns its cached one while
    // still valid); absent provisioner → gh falls back to ambient auth.
    const prToken =
      repoRef && deps.provisioner ? await deps.provisioner.tokenForRepo(repoRef) : undefined;
    const pr = await deps.execution.openPr({
      cwd: worktree.path,
      branch: worktree.branch,
      headBranch: deterministicHeadBranch(event.platform, event.externalStoryId),
      title: `Tasca: ${event.externalStoryId}`,
      // PROJECTION model (roadmap D8): Tasca never writes issue/story state — the platform's own
      // integration does the transition off the PR. GitHub: a `Closes #N` link + native PR-merge→close.
      // Shortcut: a `[sc-<id>]` story reference (belt-and-suspenders to the sc-<id> branch token) +
      // the operator's Shortcut GitHub Event Handler that auto-moves the story on PR association.
      ...(prBodyReference(event) ? { body: prBodyReference(event)! } : {}),
      ...(prToken ? { token: prToken } : {}),
    });
    await deps.store.recordPullRequest(orgId, { taskId: task.id, url: pr.url });

    // §6.12 — finalize (audit + status-back + in_review): best-effort, never throws.
    await finalizeDispatch(deps, orgId, task.id, event, winner.agentId, principalId, pr.url);

    return { kind: 'dispatched', taskId: task.id, agentId: winner.agentId, prUrl: pr.url };
  } catch (err) {
    // §6.14a — NO-CHANGES is a DETERMINISTIC no-op, not a failure: the agent ran fine but had nothing
    // to commit (e.g. the issue was already resolved / a no-op). Re-running yields the same result, so
    // terminate to needs_attention with a clear reason WITHOUT the breaker — never re-route and burn N
    // identical agent runs before the breaker trips. (The agent run + no-diff were already logged above.)
    if (err instanceof ExecutionError && err.kind === 'no-changes') {
      const reason = 'agent ran but produced no committed changes — nothing to do (no retry)';
      deps.logger?.info?.('coordination: dispatch produced no changes — retiring to needs_attention (no breaker)', {
        taskId: task.id,
      });
      // The retire is guarded to executing/claimed — if an operator cancel/reassign moved the task
      // during the agent run, it returns false and OWNS the post-state. Defer (preempted), and do NOT
      // emit a task.no_changes audit for a retire that did not happen (mirrors the failNoCapacity path).
      const acted = await deps.store.retireNoChanges(orgId, task.id, reason);
      if (!acted) {
        deps.logger?.info?.('coordination: no-changes retire skipped — task already moved (operator owns it)', {
          taskId: task.id,
        });
        return { kind: 'preempted', taskId: task.id, agentId: winnerAgentId ?? '(unassigned)' };
      }
      await audit(deps, principalId, winnerAgentId ?? '(unassigned)', event, {
        action: 'task.no_changes',
        target: task.id,
        payload: { reason },
      });
      return { kind: 'no_changes', taskId: task.id };
    }

    // §6.14 — failure path (any phase): record the failure and transition in ONE
    // atomic UPDATE. At/over the threshold the task trips to needs_attention
    // (human-gated); below it the SAME row is reset to routable (claim cleared,
    // version bumped) so a re-delivery / re-assignment re-claims it and the next
    // failure increments the same counter — the breaker trips because the row is
    // re-driven, not replaced. Folding the increment + transition into one write
    // removes the crash window that could strand the task between them.
    const { failureCount, tripped } = await deps.store.recordFailureAndTransition(
      orgId,
      task.id,
      breakerThreshold
    );
    const outcome = tripped ? 'needs_attention' : 'retry';

    // Surface WHY at the boundary (stdout), not only in the audit row: the error
    // message carries the failing stage (provisioner / reserveWorktree / spawn /
    // openPr), and an ExecutionError adds a typed `stage`. Without this a "failed"
    // outcome is undiagnosable from logs.
    deps.logger?.error('coordination: dispatch failed', {
      taskId: task.id,
      agentId: winnerAgentId ?? null,
      failureCount,
      outcome,
      stage: err instanceof ExecutionError ? err.kind : undefined,
      error: err instanceof Error ? err.message : String(err),
    });

    // Best-effort audit: a pre-claim failure has no claimed agent/principal, so
    // `audit` is skipped (principalId null); a post-claim failure attributes to
    // the owning agent. The server boundary logs every failure regardless.
    await audit(deps, principalId, winnerAgentId ?? '(unassigned)', event, {
      action: 'task.failed',
      target: task.id,
      payload: {
        failureCount,
        outcome,
        error: err instanceof Error ? err.message : String(err),
      },
    });

    if (tripped) {
      return { kind: 'needs_attention', taskId: task.id, failureCount };
    }
    return { kind: 'failed', taskId: task.id, failureCount };
  } finally {
    // Reclaim the provisioner-created worktree + branch on EVERY terminal path
    // (success, failure, re-drive) so they don't accumulate without bound. Only the
    // provisioner path sets this; reserveWorktree (no-provisioner) is unaffected.
    // removeWorktree is best-effort and never throws, so it can't disturb the outcome.
    if (provisionedWorktree && repoRef && deps.provisioner) {
      await deps.provisioner.removeWorktree(
        repoRef,
        provisionedWorktree.path,
        provisionedWorktree.branch
      );
    }
  }
}

/** The projection-model PR-body reference (roadmap D8) — Tasca never writes story/issue state; the
 *  platform's own integration transitions it off the PR. GitHub (externalStoryId `owner/repo#N`): a
 *  `Closes #N` link drives the native merge→issue-close. Shortcut (externalStoryId = bare story id): a
 *  `[sc-<id>]` story reference that its GitHub integration links on (in addition to the sc-<id> branch
 *  token), with the actual move done by the operator-configured Shortcut GitHub Event Handler. Linear
 *  and other platforms → null until they land. */
function prBodyReference(event: { platform: string; externalStoryId: string }): string | null {
  if (event.platform === 'github') {
    const m = /#(\d+)$/.exec(event.externalStoryId);
    return m ? `Closes #${m[1]}` : null;
  }
  if (event.platform === 'shortcut') {
    return `[sc-${event.externalStoryId}]`;
  }
  return null;
}

/**
 * A stable PR head branch for a story, identical across re-drives so a repeated
 * `openPr` reuses (and is recognized against) the same head — and INJECTIVE so two
 * different stories never collide onto one head (a collision would make story B
 * adopt story A's PR and get none of its own). The readable slug is for humans;
 * the appended short hash of the RAW id guarantees uniqueness even when the slug
 * is lossy (the GitHub id `owner/repo#number` sanitizes to a legal ref, but
 * `owner/repo#42` and `owner-repo#42` would otherwise both slug to the same thing).
 * Starts with a letter so it satisfies the open-pr SAFE_REF guard.
 */
function deterministicHeadBranch(platform: string, externalStoryId: string): string {
  const hash = createHash('sha256').update(externalStoryId).digest('hex').slice(0, 8);
  // Shortcut's GitHub integration links a PR to its story by an `sc-<id>` token in the branch name
  // (its convention is [owner]/sc-<id>/[name]); without that token the story never links and never
  // auto-moves. A Shortcut externalStoryId is the bare numeric story id, so `sc-<id>` is exactly the
  // token Shortcut scans for. The hash keeps the branch unique + deterministic (same as below).
  if (platform === 'shortcut' && /^\d+$/.test(externalStoryId)) {
    return `tasca/sc-${externalStoryId}-${hash}`;
  }
  const slug = externalStoryId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return `tasca/${slug || 'task'}-${hash}`;
}

/**
 * Spawn the agent over the PTY and resolve when it exits cleanly; reject on a
 * non-zero exit or a real transport error. This is what turns the streaming
 * ExecutionPort.spawnAgent into an awaitable run step.
 *
 * EIO/EPIPE on the PTY master fd during child teardown is a benign Linux race
 * (the slave closes before the final read settles); treat it as success and rely
 * on the on-disk commit (verified by commitAgentWork) as the source of truth.
 * Any other onError is a real failure.
 */
/** What an agent run produced: its exit code (null on a benign EIO/EPIPE teardown)
 *  and the tail of its terminal output — captured so a no-diff / failed run is
 *  diagnosable (did the agent edit nothing, hit an auth error, find no tools?). */
interface AgentRunResult {
  exitCode: number | null;
  outputTail: string;
}

/** Poll the dispatch queue for a runner to claim `jobId`, up to `waitMs`. Returns:
 *  - 'claimed'   — a runner took it (status left 'queued' for a runner state),
 *  - 'preempted' — an operator cancel/reassign flipped it to 'cancelled' (or it's gone),
 *  - 'timeout'   — still 'queued' after the bound (no runner claimed).
 *  The first poll is immediate, so a fast claim returns without waiting the full bound. */
async function awaitRunnerClaim(
  queue: DispatchQueue,
  jobId: string,
  waitMs: number,
  pollMs: number
): Promise<'claimed' | 'preempted' | 'timeout'> {
  const interval = Math.max(1, pollMs);
  const polls = Math.max(1, Math.ceil(waitMs / interval));
  for (let i = 0; i < polls; i++) {
    const st = await queue.jobStatus(jobId);
    if (st === null || st === 'cancelled') return 'preempted';
    if (st !== 'queued') return 'claimed';
    if (i < polls - 1) await sleep(interval);
  }
  return 'timeout';
}

/** Cap on captured agent output; we keep only the last of a long run for the log. */
const AGENT_OUTPUT_TAIL_CHARS = 4000;

function runAgentToCompletion(
  execution: ExecutionPort,
  input: { id: string; cwd: string; prompt: string; env?: Record<string, string> },
  timeoutMs: number
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const handle = execution.spawnAgent(input);
    // Capture the agent's terminal output (the PTY merges stdout+stderr) so a run
    // is not a black box: keep only the tail to bound memory + the log line.
    let output = '';
    handle.onData((chunk) => {
      output += chunk;
      if (output.length > AGENT_OUTPUT_TAIL_CHARS) output = output.slice(-AGENT_OUTPUT_TAIL_CHARS);
    });
    const tail = (): string => output.slice(-1000);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // A hung agent (never exits, never errors) would otherwise leave the task in
    // `executing` forever — the breaker only fires on a throw — and leak the PTY +
    // worktree + concurrency slot. Kill it and fail so the catch records it.
    const timer = setTimeout(() => {
      finish(() => {
        try {
          execution.killAgent(input.id);
        } catch {
          // best-effort reap; we're failing the run regardless
        }
        reject(new ExecutionError('spawn', `agent run timed out after ${timeoutMs}ms; output: ${tail()}`));
      });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    handle.onError((err) => {
      const code = (err as { code?: string }).code;
      // EIO/EPIPE on the PTY master during child teardown is a benign Linux race;
      // treat it as success and let commitAgentWork be the source of truth.
      if (code === 'EIO' || code === 'EPIPE') finish(() => resolve({ exitCode: null, outputTail: output }));
      else finish(() => reject(err));
    });
    handle.onExit((code) => {
      if (code === 0) finish(() => resolve({ exitCode: 0, outputTail: output }));
      // A non-zero exit carries the output tail so the failure log shows what the
      // agent said (auth error, no tools, …), not just the bare code.
      else finish(() => reject(new ExecutionError('spawn', `agent exited with code ${code}; output: ${tail()}`)));
    });
  });
}

/**
 * Finalize a dispatched task: status-back, mark in_review, and audit — all AFTER
 * the PR is recorded. Every step is best-effort and CANNOT throw: the PR is the
 * deliverable, and propagating a finalize failure would drive the failure reset →
 * re-drive → a second agent run and a duplicate PR. A failed step is logged; a
 * left-behind status (e.g. still 'executing') is cosmetic and reconciles on a
 * later delivery, never a duplicated customer PR.
 */
export async function finalizeDispatch(
  deps: FinalizeDeps,
  orgId: string,
  taskId: string,
  event: FinalizeEvent,
  agentId: string,
  principalId: string | null,
  prUrl: string,
  // The CUSTOMER-FACING post + its audits must fire at most once. The reaper finalizes
  // at-least-once (a job can be re-leased after a crash / failed markReaped), so it
  // passes false on a re-finalize (PR already recorded) to suppress a duplicate
  // 'PR opened' comment. In-process callers (single finalize) keep the default true.
  firstFinalize = true
): Promise<void> {
  const safe = async (step: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      deps.logger?.error('finalize step failed (best-effort; PR already open)', {
        taskId,
        step,
        prUrl,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // STATUS-TO-PARENT (slice W3-S1c): a decomposition CHILD has no native platform story — its status
  // posts to the PARENT story (resolved org-scoped via the FK). A normal task posts to its own story.
  // This covers BOTH the in-process and the reaper (queue-mode) finalize paths, so a synthetic child
  // can never post to a non-existent story of its own and silently drop the update.
  const origin = await deps.store.getTaskOrigin(orgId, taskId);
  const statusStoryId = origin?.parentExternalStoryId ?? event.externalStoryId;
  const isChild = origin?.parentExternalStoryId != null;

  // setStatus is idempotent (in_review→in_review is rejected + swallowed), so it always
  // runs to reconcile a left-behind 'executing'. The post + audits are additive
  // (a second 'PR opened' comment hits the customer), so they're gated on first finalize.
  if (firstFinalize) {
    await safe('audit.pr.create', () =>
      audit(deps, principalId, agentId, event, { action: 'pr.create', target: taskId, payload: { url: prUrl } })
    );
    await safe('status.post', () =>
      deps.status.postStatus({
        platform: event.platform,
        externalStoryId: statusStoryId,
        agentId,
        // The task's org scopes the per-agent credential vault the Shortcut reporter reads (slice SC-3).
        orgId,
        state: 'in_review',
        comment: isChild ? `Subtask ${event.externalStoryId}: PR opened` : 'PR opened',
        prUrl,
      })
    );
  }
  await safe('set.in_review', () => deps.store.setStatus(orgId, taskId, 'in_review'));
  if (firstFinalize) {
    await safe('audit.status.post', () =>
      audit(deps, principalId, agentId, event, {
        action: 'status.post',
        target: taskId,
        payload: { state: 'in_review', prUrl },
      })
    );
  }
}

/** Best-effort audit append — skipped (not failed) when no principal resolves. */
async function audit(
  deps: Pick<OrchestrationDeps, 'audit'>,
  principalId: string | null,
  agentId: string,
  event: { platform: AdapterEvent['platform'] },
  entry: { action: string; target?: string; payload?: Record<string, unknown> }
): Promise<void> {
  if (!principalId) return;
  await deps.audit.record({
    principalId,
    agentId,
    platform: event.platform,
    ...entry,
  });
}
