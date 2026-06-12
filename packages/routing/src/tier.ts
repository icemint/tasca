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
  // languages
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'php',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'swift', 'kt', 'kts', 'scala', 'ex',
  'exs', 'erl', 'clj', 'lua', 'dart', 'mm', 'pl', 'groovy', 'vue', 'svelte', 'astro',
  // web / styles / markup
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml', 'svg',
  // config / data / infra
  'json', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'cfg', 'properties',
  'gradle', 'tf', 'proto', 'graphql', 'gql', 'lock', 'dockerfile',
  // scripts / docs
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'md', 'mdx', 'rst', 'txt',
];
// A single filename-ish token ending in a known extension: anchored, with the
// path structure `name(/or.name)*` so there is NO unbounded quantifier overlapping
// the trailing `.ext` — this avoids the quadratic backtracking the naive
// `[\w./-]+\.(ext)` suffers on long path-like input. Tested PER whitespace token
// (see heuristics) so any backtracking is bounded to one short token — ReDoS-safe
// on untrusted webhook text. (Single-letter exts like `c`/`h` are kept; the prose
// cases `e.g.`/`i.e.`/`v1.2` are still excluded — `g`/`e`/`2` aren't in the set.)
const FILE_MENTION_RE = new RegExp(`^[\\w-]+(?:[./][\\w-]+)*\\.(?:${FILE_EXTENSIONS.join('|')})$`);

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
  // Count file mentions per whitespace token (strip surrounding punctuation so
  // `(src/foo.ts),` still matches). Testing the anchored regex against one short
  // token at a time keeps it linear — no quadratic backtracking over long text.
  const fileMentions = text.split(/\s+/).reduce((n, raw) => {
    const tok = raw.replace(/^[^\w]+|[^\w]+$/g, '');
    return tok && FILE_MENTION_RE.test(tok) ? n + 1 : n;
  }, 0);
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
  /** Notified when the classifier was CALLED but did not contribute (threw, or returned malformed
   *  output) and the estimate degraded to the heuristic. The degrade is intentional fail-soft, but it
   *  must not be SILENT — a misconfigured classifier (e.g. a bad model id 404ing every call) otherwise
   *  looks like everything is fine while the paid feature is fully broken + writes no usage. The caller
   *  logs it; estimateTier stays pure (no logger). */
  onClassifierError?: (err: unknown) => void;
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
  } catch (err) {
    // LOUD: a thrown classifier call (timeout/5xx/404/bad-key) is not silent. The callback is
    // caller-supplied — guard it so a throwing logger can never break this function's fail-soft contract.
    try {
      opts.onClassifierError?.(err);
    } catch {
      /* best-effort observability; must not break the routing decision */
    }
    return priorEstimate;
  }

  // The static port type does not constrain real model output — validate at this
  // trust boundary and reject/fallback on malformed output (scaffold §3).
  const parsed = ClassifierOutputSchema.safeParse(raw);
  if (!parsed.success) {
    try {
      opts.onClassifierError?.(new Error('classifier returned malformed output')); // LOUD: not silent
    } catch {
      /* best-effort observability; must not break the routing decision */
    }
    return priorEstimate;
  }
  return { tier: parsed.data.tier, confidence: parsed.data.confidence, signals, classifierUsed: true };
}
