import type { Tier, TierFeatures, TierEstimate } from '@tasca/domain';
import { TIERS } from '@tasca/domain';
import type { LlmClassifierPort } from './ports';

const REASONING_VERBS = [
  'design',
  'investigate',
  'refactor',
  'architect',
  'analyze',
  'debug',
  'optimize',
  'migrate',
];

export interface TaskInput {
  title: string;
  body: string;
  labels?: string[];
}

/** Cheap, deterministic feature extraction — no I/O. */
export function heuristics(task: TaskInput): TierFeatures {
  const text = `${task.title}\n${task.body}`.toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const hasReasoningVerb = REASONING_VERBS.some((v) => new RegExp(`\\b${v}`).test(text));
  const fileMentions = (text.match(/[\w./-]+\.[a-z]{1,5}\b/g) ?? []).length;
  const scopeHint: TierFeatures['scopeHint'] =
    fileMentions === 0 ? 'unknown' : fileMentions <= 1 ? 'single-file' : 'multi-file';
  return { wordCount, hasReasoningVerb, scopeHint, labelTier: labelToTier(task.labels ?? []) };
}

function labelToTier(labels: string[]): Tier | null {
  for (const l of labels) {
    const m = l.toLowerCase().match(/tier[:/-]?(basic|low|medium|hard|ultra)/);
    if (m && TIERS.includes(m[1] as Tier)) return m[1] as Tier;
  }
  return null;
}

/** Coarse heuristic prior + confidence, before any LLM call. */
export function heuristicPrior(f: TierFeatures): { tier: Tier; confidence: number } {
  if (f.labelTier) return { tier: f.labelTier, confidence: 0.9 }; // explicit label ⇒ high confidence
  let score = 0;
  if (f.wordCount > 40) score += 1;
  if (f.wordCount > 120) score += 1;
  if (f.hasReasoningVerb) score += 1;
  if (f.scopeHint === 'multi-file') score += 1;
  const tier = TIERS[Math.min(score, TIERS.length - 1)]!;
  const confidence = f.wordCount < 6 ? 0.3 : 0.55;
  return { tier, confidence };
}

export interface EstimateTierOptions {
  classifier?: LlmClassifierPort;
  /** Skip the LLM call when the heuristic prior is at least this confident (cost control). */
  classifierConfidenceThreshold?: number;
}

/**
 * Tier estimate = heuristics + (optionally) one budgeted LLM classifier call.
 * The classifier is skipped when the heuristic prior is high-confidence
 * (e.g. an explicit tier label), keeping the call off the hot path / budgeted.
 */
export async function estimateTier(
  task: TaskInput,
  opts: EstimateTierOptions = {}
): Promise<TierEstimate> {
  const signals = heuristics(task);
  const prior = heuristicPrior(signals);
  const threshold = opts.classifierConfidenceThreshold ?? 0.8;

  if (!opts.classifier || prior.confidence >= threshold) {
    return { tier: prior.tier, confidence: prior.confidence, signals, classifierUsed: false };
  }
  const c = await opts.classifier.classify({ title: task.title, body: task.body, features: signals });
  return { tier: c.tier, confidence: c.confidence, signals, classifierUsed: true };
}
