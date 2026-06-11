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

  async complete(input: { system?: string; prompt: string; maxTokens: number }): Promise<string> {
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
    if (!res.ok) throw new Error(`anthropic ${res.status}`);
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }> };
    const text = parsed.content?.find((b) => b.type === 'text')?.text;
    if (typeof text !== 'string' || text.length === 0) throw new Error('anthropic: no text content');
    return text;
  }
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
  constructor(private readonly chat: AnthropicChat) {}

  async classify(input: { title: string; body: string; features: TierFeatures }): Promise<{ tier: Tier; confidence: number }> {
    const text = await this.chat.complete({
      system: CLASSIFIER_SYSTEM,
      prompt: `Title: ${input.title}\n\nBody: ${input.body}\n\nHeuristic signals: ${JSON.stringify(input.features)}`,
      maxTokens: 64,
    });
    const obj = extractJson(text) as { tier?: unknown; confidence?: unknown };
    // Returned loosely; estimateTier's ClassifierOutputSchema.safeParse is the trust boundary.
    return { tier: obj.tier as Tier, confidence: Number(obj.confidence) };
  }
}

const DECOMPOSER_SYSTEM =
  'You split a software-engineering task into 2 to 6 smaller, independently-routable subtasks. ' +
  'Respond with ONLY a JSON object: {"children": [{"title": string, "body": string}], "why": string}. No prose.';

/** DecomposerPort over AnthropicChat. The decomposition proposer (proposeDecompositionFailSoft)
 *  Zod-validates the output (DecompositionProposalSchema) and returns null on a throw or malformed
 *  result, so a bad split here is safe — it yields no suggestion, never a bad task creation. */
export class AnthropicDecomposer implements DecomposerPort {
  constructor(private readonly chat: AnthropicChat) {}

  async decompose(input: { title: string; body: string }): Promise<DecompositionProposal | null> {
    const text = await this.chat.complete({
      system: DECOMPOSER_SYSTEM,
      prompt: `Title: ${input.title}\n\nBody: ${input.body}`,
      maxTokens: 1024,
    });
    return extractJson(text) as DecompositionProposal;
  }
}
