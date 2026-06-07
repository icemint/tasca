import type { Tier, TierFeatures, TierEstimate } from '@tasca/domain';
import { TIERS } from '@tasca/domain';
import { ClassifierOutputSchema } from '@tasca/contracts';
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

// Known code/config file extensions. A bare `.<ext>` only counts as a file
// mention when `<ext>` is in this set — this excludes prose abbreviations like
// `e.g.` (g), `i.e.` (e) and version strings like `v1.2` (2), which used to
// inflate the scope hint by +1 tier on ordinary English. Residual accepted:
// `node.js` (ext `js`) still counts — this is a path-separator-or-known-ext
// heuristic that favors precision over the prose cases, not a path validator.
const FILE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'py',
  'go',
  'rs',
  'java',
  'rb',
  'php',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'swift',
  'kt',
  'css',
  'scss',
  'html',
  'sql',
  'sh',
  'yaml',
  'yml',
  'toml',
  'md',
];
// e.g. `\b[\w./-]+\.(ts|tsx|...)\b` — a filename-ish token ending in a known ext.
const FILE_MENTION_RE = new RegExp(`\\b[\\w./-]+\\.(?:${FILE_EXTENSIONS.join('|')})\\b`, 'g');

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
  const fileMentions = (text.match(FILE_MENTION_RE) ?? []).length;
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

  // Fallback used whenever we skip, error, or reject the classifier.
  const priorEstimate: TierEstimate = {
    tier: prior.tier,
    confidence: prior.confidence,
    signals,
    classifierUsed: false,
  };

  // High-confidence heuristic (e.g. explicit label) → skip the budgeted LLM call.
  if (!opts.classifier || prior.confidence >= threshold) {
    return priorEstimate;
  }

  // The classifier is a remote LLM call: a rejection (timeout / 5xx / rate-limit)
  // is expected, not exceptional — degrade to the heuristic prior, never crash
  // the routing decision.
  let raw: unknown;
  try {
    raw = await opts.classifier.classify({ title: task.title, body: task.body, features: signals });
  } catch {
    return priorEstimate;
  }

  // The static port type does not constrain real model output — validate at this
  // trust boundary and reject/fallback on malformed output (scaffold §3).
  const parsed = ClassifierOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return priorEstimate;
  }
  return { tier: parsed.data.tier, confidence: parsed.data.confidence, signals, classifierUsed: true };
}
