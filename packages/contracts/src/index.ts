import { z } from 'zod';
import { TIERS } from '@tasca/domain';

// @tasca/contracts — Zod schemas at every trust boundary; TS types are inferred
// from them (schema is the source of truth). Stage-1 slice: the classifier I/O
// the routing engine validates (reject/fallback on malformed LLM output).

export const TierSchema = z.enum(TIERS);

export const ClassifierOutputSchema = z.object({
  tier: TierSchema,
  confidence: z.number().min(0).max(1),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

/** Normalized inbound platform event (adapters emit this; coordination consumes it). */
export const AdapterEventSchema = z.object({
  type: z.literal('task.assigned'),
  platform: z.enum(['shortcut', 'github', 'linear']),
  externalStoryId: z.string().min(1),
  agentExternalId: z.string().min(1),
  repoHint: z.string().optional(),
});
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;
