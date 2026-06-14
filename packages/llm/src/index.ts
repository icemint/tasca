// @tasca/llm — the concrete Anthropic-backed implementations of coordination's injected, fail-soft
// LLM ports: the routing tier CLASSIFIER (LlmClassifierPort — used by the routing engine's
// estimateTier AND the triage proposer) and the DECOMPOSER (DecomposerPort — used by the decomposition
// proposer). One thin client (raw fetch to the Anthropic Messages API — no SDK, a leaf depending only
// on domain + contracts), three consumers.
//
// This package only FILLS the ports. The fail-soft contracts live at the CONSUMERS, already proven:
// estimateTier catches a classifier throw / Zod-rejects malformed output → the heuristic prior (routing
// never blocks); proposeTriageFailSoft / proposeDecompositionFailSoft catch + validate → null (the
// proposers never block). So an Anthropic outage / slow / garbage response DEGRADES, never stalls — the
// client just throws and the consumer's boundary handles it.

import type { Tier, TierFeatures, LlmClassifierPort } from '@tasca/domain';
import type { DecomposerPort, DecompositionProposal } from '@tasca/contracts';

/**
 * The current Anthropic reasoning model the Engineering Manager (EM) runs on. The EM reasons about
 * story requirements (a heavier task than the routing CLASSIFIER's tier guess), so it points at Sonnet
 * — deliberately a stronger model than the classifier's Haiku. This is THE single upgrade point for the
 * manager's model: bump this one constant to move the EM to a newer model; the classifier keeps its own
 * (`coordinationLlm.model`, default Haiku) and is unaffected.
 */
export const LATEST_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

/** The per-call usage a model returned (input/output tokens), plus the response id used as the
 *  idempotency key so a retried report can't double-count. */
export interface CallUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The Anthropic response id — a stable idempotency key for the usage record. */
  idempotencyKey: string;
}

/** Where the client REPORTS per-call usage. The recorder (coordination) supplies the org/task/source
 *  from its own per-request context — the client knows none of that, it just reports what the call
 *  cost. Fire-and-forget (void): metering must NEVER block or fail an LLM call. */
export interface UsageSink {
  record(usage: CallUsage): void;
}

/** A fetch-like transport (injectable for tests; defaults to global fetch). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface AnthropicChatConfig {
  apiKey: string;
  model: string;
  /** Anthropic Messages API base (override for tests). Default https://api.anthropic.com */
  baseUrl?: string;
  /** Per-call timeout (ms). Default 8000. A timeout rejects → the consumer degrades. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * A minimal NON-streaming Anthropic Messages client. `complete` returns the response's first text
 * block. Throws on non-200, network error, timeout, or a body with no text — the caller (a port impl)
 * lets that propagate to the consumer's fail-soft boundary. No retries: a retry storm against a model
 * API would be its own outage amplifier; the consumers already have a safe fallback.
 */
export class AnthropicChat {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: FetchLike;

  constructor(private readonly cfg: AnthropicChatConfig) {
    this.baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    this.timeoutMs = cfg.timeoutMs ?? 8000;
    this.doFetch = cfg.fetch ?? ((url, init) => globalThis.fetch(url, init as RequestInit));
  }

  async complete(input: { system?: string; prompt: string; maxTokens: number }): Promise<CompletionResult> {
    const body = JSON.stringify({
      model: this.cfg.model,
      max_tokens: input.maxTokens,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: 'user', content: input.prompt }],
    });
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Race the request against a timeout that BOTH aborts the real fetch AND rejects — so a transport
    // that ignores the abort signal still can't hang the caller (the consumer then degrades).
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error('anthropic: timeout'));
      }, this.timeoutMs);
    });
    const request = this.doFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: ctrl.signal,
    });
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer!);
    }
    // Include the model + status in the error so a degraded-to-heuristic log is self-diagnosing
    // (e.g. `anthropic 404 (model=claude-haiku-4-5)` immediately points at a bad model id).
    if (!res.ok) throw new Error(`anthropic ${res.status} (model=${this.cfg.model})`);
    const raw = await res.text();
    const parsed = JSON.parse(raw) as {
      id?: string;
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = parsed.content?.find((b) => b.type === 'text')?.text;
    if (typeof text !== 'string' || text.length === 0) throw new Error('anthropic: no text content');
    // Surface the usage + id for metering. A response always carries them; if absent, usage is null
    // and the caller simply doesn't meter that call (the call itself still succeeds). The response `id`
    // is the metering idempotency key: this client does NOT retry, and orchestration runs each call
    // once (webhook-idempotent / on-demand), so every distinct LLM call has a distinct id — a concurrent
    // re-report of the SAME response dedups (ON CONFLICT), and two different calls never collide on an id.
    const usage =
      parsed.id && typeof parsed.usage?.input_tokens === 'number' && typeof parsed.usage?.output_tokens === 'number'
        ? { model: this.cfg.model, inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens, idempotencyKey: parsed.id }
        : null;
    return { text, usage };
  }
}

export interface CompletionResult {
  text: string;
  /** Per-call usage for metering, or null if the response didn't carry it (the call still succeeded). */
  usage: CallUsage | null;
}

/** Extract the first JSON object from model text — models wrap JSON in prose / ```json fences.
 *  Throws if no parseable object is found (the consumer's fail-soft boundary handles it). */
export function extractJson(text: string): unknown {
  const fenced = text.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('llm: no JSON object in response');
  return JSON.parse(fenced.slice(start, end + 1));
}

const CLASSIFIER_SYSTEM =
  'You are a task-tier classifier for a software-engineering workforce. Tiers from easiest to hardest: ' +
  'basic, low, medium, hard, ultra. Respond with ONLY a JSON object: {"tier": <one tier>, "confidence": <0..1>}. ' +
  'No prose.';

/** LlmClassifierPort over AnthropicChat. The routing engine (estimateTier) Zod-validates the output
 *  (ClassifierOutputSchema) and falls back to the heuristic prior on a throw or malformed result, so a
 *  bad tier here is safe — it degrades the routing decision to heuristics, never breaks it. */
export class AnthropicClassifier implements LlmClassifierPort {
  constructor(
    private readonly chat: AnthropicChat,
    /** Optional usage sink — reports this call's tokens for per-task metering. Absent → no metering
     *  (e.g. the dev smoke harness). Reporting is fire-and-forget; it never affects the classify result. */
    private readonly sink?: UsageSink
  ) {}

  async classify(input: { title: string; body: string; features: TierFeatures }): Promise<{ tier: Tier; confidence: number }> {
    const { text, usage } = await this.chat.complete({
      system: CLASSIFIER_SYSTEM,
      prompt: `Title: ${input.title}\n\nBody: ${input.body}\n\nHeuristic signals: ${JSON.stringify(input.features)}`,
      maxTokens: 64,
    });
    if (usage) this.sink?.record(usage); // meter BEFORE parsing — a parse failure must not lose the spend
    const obj = extractJson(text) as { tier?: unknown; confidence?: unknown };
    // Returned loosely; estimateTier's ClassifierOutputSchema.safeParse is the trust boundary.
    return { tier: obj.tier as Tier, confidence: Number(obj.confidence) };
  }
}

/** The Engineering Manager's clarity judgment on a story (EM v1 slice 2): is it clear enough to build,
 *  and if not, the specific clarifying questions to ask. `questions` is empty when `clear`. */
export interface EmClarityReview {
  clear: boolean;
  questions: string[];
}

/** One comment in a story's clarification thread (EM v1 slice 3): an author label + the comment text.
 *  The EM re-review sees these (its own questions + the human's answer) so a satisfactory reply can clear
 *  the story, instead of re-judging the unchanged title/body and looping to the cap. */
export interface ClarificationComment {
  author?: string;
  text: string;
}

/** The EM clarity-judge port — given a story's title+body AND the clarification thread so far, decide
 *  whether requirements are clear enough to implement. `thread` is empty on the first review (no comments
 *  yet → judge on the story alone, unchanged behavior); after a reply it carries the Q&A so the judge can
 *  clear. The consumer (coordination's emReviewGate) wraps the call so ANY throw fails OPEN (skip →
 *  proceed): the EM must never block the pipeline. */
export interface EmReviewerPort {
  review(input: { title: string; body: string; thread?: ClarificationComment[] }): Promise<EmClarityReview>;
}

const EM_REVIEWER_SYSTEM =
  'You are an engineering manager reviewing a story before an engineer starts. Judge whether the ' +
  'requirements are clear enough to implement without guessing, given the story AND any clarification ' +
  'thread (your earlier questions and the answers so far). A satisfactory answer to your questions makes ' +
  'the story clear. Respond with ONLY a JSON object: {"clear": <boolean>, "questions": [<string>]}. If ' +
  'the story is clear, set "clear" true and "questions" to []. If not, set "clear" false and list 1 to 4 ' +
  'specific clarifying questions. No prose.';

/** The EM block-explanation port (EM v1 slice 4): rephrase a raw internal blocker reason into ONE calm,
 *  operator-facing sentence. Best-effort by contract — the consumer (coordination's emBlockExplainer)
 *  wraps the call so ANY throw is swallowed and the RAW reason is kept. */
export interface EmBlockExplainerPort {
  explainBlock(input: { rawReason: string; title: string }): Promise<string>;
}

const EM_BLOCK_EXPLAINER_SYSTEM =
  'You are an engineering manager. A task is blocked and needs a human operator. Rewrite the internal ' +
  'blocker reason as ONE clear, calm sentence the operator can act on. Plain text only — no JSON, no ' +
  'preamble, no quotes, just the one sentence.';

/** EmBlockExplainerPort over AnthropicChat — runs on the LATEST Anthropic model (the EM's model). The
 *  consumer swallows any throw and keeps the raw reason, so a bad model id / outage / empty response just
 *  leaves the original text. `maxTokens` is small (one sentence). The model text is trimmed; the consumer
 *  bounds its length. */
export class AnthropicEmReviewer implements EmReviewerPort, EmBlockExplainerPort {
  constructor(
    private readonly chat: AnthropicChat,
    /** Optional usage sink — meters this call's tokens (the gate runs it under source='manager'). */
    private readonly sink?: UsageSink
  ) {}

  async review(input: { title: string; body: string; thread?: ClarificationComment[] }): Promise<EmClarityReview> {
    // The clarification thread (the EM's questions + the human's answers) is appended only when present, so
    // the first review (no comments) judges on the story alone exactly as before. Each comment is rendered
    // author-prefixed when the author is known, so the judge can tell its own questions from the reply.
    const thread = input.thread ?? [];
    const threadBlock =
      thread.length > 0
        ? `\n\nClarification thread so far:\n${thread
            .map((c) => (c.author ? `${c.author}: ${c.text}` : c.text))
            .join('\n')}`
        : '';
    const { text, usage } = await this.chat.complete({
      system: EM_REVIEWER_SYSTEM,
      prompt: `Story:\nTitle: ${input.title}\n\nBody: ${input.body}${threadBlock}`,
      maxTokens: 512,
    });
    if (usage) this.sink?.record(usage); // meter BEFORE parsing — a parse failure must not lose the spend
    const obj = extractJson(text) as { clear?: unknown; questions?: unknown };
    // A non-boolean `clear` defaults to clear=true (proceed): an ambiguous judgment must not strand the
    // task. Questions are only meaningful when NOT clear; normalize to a string list, capped at 4.
    const clear = obj.clear === false ? false : true;
    const questions = clear
      ? []
      : (Array.isArray(obj.questions) ? obj.questions : [])
          .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
          .slice(0, 4);
    // An unclear verdict with no usable questions degrades to clear (nothing actionable to ask).
    if (!clear && questions.length === 0) return { clear: true, questions: [] };
    return { clear, questions };
  }

  async explainBlock(input: { rawReason: string; title: string }): Promise<string> {
    const { text, usage } = await this.chat.complete({
      system: EM_BLOCK_EXPLAINER_SYSTEM,
      prompt: `Internal blocker reason: ${input.rawReason}\n\nTask: ${input.title}`,
      maxTokens: 120,
    });
    if (usage) this.sink?.record(usage); // meter the spend regardless of how the text is used downstream
    return text.trim();
  }
}

const DECOMPOSER_SYSTEM =
  'You split a software-engineering task into 2 to 6 smaller, independently-routable subtasks. ' +
  'Respond with ONLY a JSON object: {"children": [{"title": string, "body": string}], "why": string}. No prose.';

/** DecomposerPort over AnthropicChat. The decomposition proposer (proposeDecompositionFailSoft)
 *  Zod-validates the output (DecompositionProposalSchema) and returns null on a throw or malformed
 *  result, so a bad split here is safe — it yields no suggestion, never a bad task creation. */
export class AnthropicDecomposer implements DecomposerPort {
  constructor(
    private readonly chat: AnthropicChat,
    private readonly sink?: UsageSink
  ) {}

  async decompose(input: { title: string; body: string }): Promise<DecompositionProposal | null> {
    const { text, usage } = await this.chat.complete({
      system: DECOMPOSER_SYSTEM,
      prompt: `Title: ${input.title}\n\nBody: ${input.body}`,
      maxTokens: 1024,
    });
    if (usage) this.sink?.record(usage);
    return extractJson(text) as DecompositionProposal;
  }
}
