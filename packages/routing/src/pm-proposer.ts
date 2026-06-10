// PM-assistant proposer (advisory, Wave-3 W3-S1). The PM-assistant SUGGESTS — it never
// routes. A routing proposal names an agent the engine would be a good fit; accepting it
// re-routes through the normal claim (the deterministic engine + atomic claim stay the
// binding source of truth). The port is injected + fail-soft: any failure (throw, timeout,
// malformed output) degrades to NO proposal — a proposer outage must never touch the
// routing loop.

import type { CapabilityProfile, AgentState, TierEstimate } from '@tasca/domain';
import { RoutingProposalSchema, type RoutingProposal } from '@tasca/contracts';
import type { TaskInput } from './tier';
import { matchCapability, type MatchCandidate } from './match';

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

/** The proposer seam. A deterministic match-based default ships now; LLM-backed proposers
 *  (for the language-heavy kinds — triage/decomposition/standup) arrive in later sub-slices.
 *  Returns null when it has no suggestion (e.g. no eligible candidate). */
export interface PmProposerPort {
  proposeRouting(input: ProposeRoutingInput): Promise<RoutingProposal | null>;
}

/**
 * The default routing proposer: rank the hired candidates with the SAME engine the binding
 * path uses (matchCapability), and propose the top eligible agent with a plain-English
 * rationale. Deterministic, no I/O, always available — a routing suggestion that mirrors
 * what the engine would do, framed for a non-technical PM. Returns null when nothing is
 * eligible (an honest "no suggestion", never a guess).
 */
export class DeterministicRoutingProposer implements PmProposerPort {
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
}

/**
 * Fail-soft wrapper around a PmProposerPort: validate the output at the trust boundary
 * (a lying/LLM impl is rejected), bound the call with a timeout, and degrade ANY failure
 * to null. Routing is never on this path, so a proposer outage is invisible to the engine.
 */
export async function proposeRoutingFailSoft(
  port: PmProposerPort,
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
