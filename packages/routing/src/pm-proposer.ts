// PM-assistant proposer (advisory, Wave-3 W3-S1). The PM-assistant SUGGESTS — it never
// routes. A routing proposal names an agent the engine would be a good fit; accepting it
// re-routes through the normal claim (the deterministic engine + atomic claim stay the
// binding source of truth). The port is injected + fail-soft: any failure (throw, timeout,
// malformed output) degrades to NO proposal — a proposer outage must never touch the
// routing loop.

import type { CapabilityProfile, AgentState, TierEstimate } from '@tasca/domain';
import {
  RoutingProposalSchema,
  TriageProposalSchema,
  DecompositionProposalSchema,
  type RoutingProposal,
  type TriageProposal,
  type DecompositionProposal,
} from '@tasca/contracts';
import { estimateTier, type TaskInput, type EstimateTierOptions } from './tier';
import { matchCapability, type MatchCandidate } from './match';
import type { LlmClassifierPort } from './ports';

/** A hired agent the proposer may suggest — the match inputs plus the display name (the
 *  proposal names the agent; accept resolves that name back to a HIRED id, fail-closed). */
export interface RoutingCandidate {
  agentId: string;
  name: string;
  profile: CapabilityProfile;
  state: AgentState;
  activeCount: number;
}

export interface ProposeRoutingInput {
  task: TaskInput;
  estimate: TierEstimate;
  candidates: RoutingCandidate[];
}

export interface ProposeTriageInput {
  task: TaskInput;
}

export interface ProposeDecompositionInput {
  task: TaskInput;
}

/** An injectable LLM decomposer — splits a parent task into child tasks. There is NO deterministic
 *  fallback (a split needs a model), so without one the decomposition kind yields no suggestion. */
export interface DecomposerPort {
  decompose(input: TaskInput): Promise<DecompositionProposal | null>;
}

/** The proposer seam. routing = deterministic (match-based); triage = the tier engine (LLM-backed
 *  when a classifier is injected); decomposition = an injected LLM decomposer (none → no suggestion).
 *  standup arrives in 1d. Each returns null when it has no suggestion. */
export interface PmProposerPort {
  proposeRouting(input: ProposeRoutingInput): Promise<RoutingProposal | null>;
  proposeTriage(input: ProposeTriageInput): Promise<TriageProposal | null>;
  proposeDecomposition(input: ProposeDecompositionInput): Promise<DecompositionProposal | null>;
}

/** Injected language models for the LLM-backed kinds. Both optional — an absent model means that
 *  kind yields no suggestion (the assistant is inert for it, never errors). */
export interface PmProposerConfig {
  classifier?: LlmClassifierPort;
  decomposer?: DecomposerPort;
}

/**
 * The default PM proposer.
 *  - routing: rank the hired candidates with the SAME engine the binding path uses
 *    (matchCapability) and propose the top eligible agent — deterministic, no I/O, always
 *    available, a suggestion that mirrors what the engine would do.
 *  - triage: the tier engine (estimateTier) surfaced as a suggestion. LLM-backed when a
 *    classifier is injected (and budgeted/skipped on a high-confidence heuristic prior), else
 *    heuristic-only. estimateTier is itself fail-soft — a classifier timeout/5xx/malformed
 *    output degrades to the heuristic prior, never throws — so a proposer outage can't reach
 *    the routing loop.
 * Both return null for an honest "no suggestion", never a guess.
 */
export class DefaultPmProposer implements PmProposerPort {
  constructor(private readonly cfg: PmProposerConfig = {}) {}

  async proposeRouting(input: ProposeRoutingInput): Promise<RoutingProposal | null> {
    const byId = new Map(input.candidates.map((c) => [c.agentId, c]));
    const candidates: MatchCandidate[] = input.candidates.map((c) => ({
      profile: c.profile,
      state: c.state,
      activeCount: c.activeCount,
    }));
    const ranked = matchCapability(input.estimate, candidates);
    const top = ranked.find((m) => m.eligible);
    if (!top) return null;
    const agent = byId.get(top.agentId);
    if (!agent) return null;
    const why =
      `Best fit for an estimated ${input.estimate.tier}-tier task: ${agent.name} covers the tier ` +
      `and is available, with the highest capability score (${top.score.toFixed(2)}) among the hired agents.`;
    return { agentName: agent.name, why, confidence: Math.max(0, Math.min(1, top.score)) };
  }

  async proposeTriage(input: ProposeTriageInput): Promise<TriageProposal | null> {
    const opts: EstimateTierOptions = this.cfg.classifier ? { classifier: this.cfg.classifier } : {};
    const est = await estimateTier(input.task, opts);
    return { tier: est.tier, why: triageWhy(est), confidence: est.confidence };
  }

  async proposeDecomposition(input: ProposeDecompositionInput): Promise<DecompositionProposal | null> {
    // No deterministic fallback — a split needs a model. Without a decomposer wired, no suggestion.
    if (!this.cfg.decomposer) return null;
    return this.cfg.decomposer.decompose(input.task);
  }
}

/** A plain-English rationale from the tier estimate's signals — the "why" a PM reads. */
function triageWhy(est: TierEstimate): string {
  const s = est.signals;
  const bits: string[] = [`~${s.wordCount} words`];
  if (s.hasReasoningVerb) bits.push('reasoning/design language');
  if (s.scopeHint !== 'unknown') bits.push(`${s.scopeHint} scope`);
  if (s.labelTier) bits.push(`an explicit ${s.labelTier} label`);
  const basis = est.classifierUsed ? 'the classifier + heuristics' : 'heuristics';
  return `Estimated ${est.tier} from ${basis} (${bits.join(', ')}). Confirm before it re-tiers the task.`;
}

/**
 * Fail-soft wrapper around a PmProposerPort: validate the output at the trust boundary
 * (a lying/LLM impl is rejected), bound the call with a timeout, and degrade ANY failure
 * to null. Routing is never on this path, so a proposer outage is invisible to the engine.
 */
export async function proposeRoutingFailSoft(
  port: Pick<PmProposerPort, 'proposeRouting'>,
  input: ProposeRoutingInput,
  opts: { timeoutMs?: number } = {}
): Promise<RoutingProposal | null> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  let raw: RoutingProposal | null;
  try {
    raw = await withTimeout(port.proposeRouting(input), timeoutMs);
  } catch {
    return null; // throw / timeout → no proposal
  }
  if (raw === null) return null;
  const parsed = RoutingProposalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null; // malformed → no proposal
}

/** Fail-soft wrapper around a triage proposer call — same contract as the routing one: validate
 *  at the trust boundary, bound with a timeout, degrade ANY failure to null. The tier engine is
 *  advisory here, so an outage is invisible to the routing loop. */
export async function proposeTriageFailSoft(
  port: Pick<PmProposerPort, 'proposeTriage'>,
  input: ProposeTriageInput,
  opts: { timeoutMs?: number } = {}
): Promise<TriageProposal | null> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  let raw: TriageProposal | null;
  try {
    raw = await withTimeout(port.proposeTriage(input), timeoutMs);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = TriageProposalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Fail-soft wrapper around a decomposition proposer call — validate at the boundary, bound with a
 *  timeout, degrade ANY failure to null. The decomposer is an LLM, so a timeout/throw/malformed
 *  split → no proposal, never an error and never a task write. */
export async function proposeDecompositionFailSoft(
  port: Pick<PmProposerPort, 'proposeDecomposition'>,
  input: ProposeDecompositionInput,
  opts: { timeoutMs?: number } = {}
): Promise<DecompositionProposal | null> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  let raw: DecompositionProposal | null;
  try {
    raw = await withTimeout(port.proposeDecomposition(input), timeoutMs);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = DecompositionProposalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proposer timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
