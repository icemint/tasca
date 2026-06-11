// Dev smoke harness for the real LLM consumers (NOT a test — run manually with a key). Exercises the
// concrete Anthropic-backed ports against representative sample issues and prints, per task:
//   - the HEURISTIC tier (what estimateTier gave before the classifier was wired) vs the LLM tier +
//     confidence (so you can judge whether the classifier's tiers are sane),
//   - a real triage proposal (tier + rationale),
//   - a real decomposition (child subtasks).
//
// This is the first run against the real Anthropic API in-environment — a cheap de-risk before
// building S2/S3 on the assumption these work. It makes the SAME calls production makes when
// TASCA_LLM=on; the cost is a handful of small completions.
//
// Run:  ANTHROPIC_API_KEY=sk-... [TASCA_LLM_MODEL=claude-...] tsx packages/coordination/src/llm-smoke.ts

import { estimateTier, DefaultPmProposer } from '@tasca/routing';
import { AnthropicChat, AnthropicClassifier, AnthropicDecomposer } from '@tasca/llm';

interface Sample {
  label: string;
  title: string;
  body: string;
}

// Varied complexity, on purpose — a trivial fix → a large decomposable feature.
const SAMPLES: Sample[] = [
  { label: 'typo', title: 'Fix typo in the README', body: 'The word "recieve" should be "receive" in the install section.' },
  { label: 'small feature', title: 'Add a --json flag to `tasca list`', body: 'The list command should support machine-readable JSON output alongside the table.' },
  { label: 'refactor', title: 'Refactor the auth middleware for multiple providers', body: 'Today the middleware hard-codes one OAuth provider. Generalize it to support GitHub and Google across the request pipeline, touching the session layer and several routes.' },
  { label: 'incident', title: 'Checkout returns 500 under load', body: 'Under concurrent traffic the payment service intermittently 500s. Investigate the race between the reservation and capture steps and fix it. Production impact.' },
  { label: 'large feature', title: 'Billing reconciliation v2', body: 'Rebuild reconciliation: a schema migration for the ledger, a new reconciliation engine that matches charges to invoices, and an exportable report. Multi-week.' },
];

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required. Run with a staging/dev key.');
    process.exit(2);
  }
  const model = process.env.TASCA_LLM_MODEL ?? 'claude-haiku-4-5-20251001';
  console.log(`# LLM smoke — model: ${model}\n`);

  const chat = new AnthropicChat({ apiKey, model });
  const classifier = new AnthropicClassifier(chat);
  const decomposer = new AnthropicDecomposer(chat);
  const proposer = new DefaultPmProposer({ classifier, decomposer });

  for (const s of SAMPLES) {
    const task = { title: s.title, body: s.body };
    console.log(`\n══════ [${s.label}] ${s.title}`);

    // Heuristic vs LLM tier. classifierConfidenceThreshold: 2 forces the LLM call (so we always see
    // its opinion); production keeps the default 0.8 (skip when the heuristic prior is confident).
    const heuristic = await estimateTier(task, {});
    let llm: Awaited<ReturnType<typeof estimateTier>> | { error: string };
    try {
      llm = await estimateTier(task, { classifier, classifierConfidenceThreshold: 2 });
    } catch (e) {
      llm = { error: e instanceof Error ? e.message : String(e) };
    }
    console.log(`  tier  heuristic=${heuristic.tier} (conf ${heuristic.confidence.toFixed(2)})`);
    if ('error' in llm) console.log(`        LLM=ERROR ${llm.error} → would degrade to heuristic`);
    else console.log(`        LLM=${llm.tier} (conf ${llm.confidence.toFixed(2)}, used=${llm.classifierUsed})`);

    // Triage proposal (uses the classifier via estimateTier under the hood).
    const triage = await proposer.proposeTriage({ task });
    console.log(`  triage  ${triage ? `tier=${triage.tier} (conf ${triage.confidence.toFixed(2)}) — ${triage.why}` : '(no suggestion)'}`);

    // Decomposition (LLM decomposer).
    let decomp: Awaited<ReturnType<typeof proposer.proposeDecomposition>> | { error: string };
    try {
      decomp = await proposer.proposeDecomposition({ task });
    } catch (e) {
      decomp = { error: e instanceof Error ? e.message : String(e) };
    }
    if (decomp && 'error' in decomp) console.log(`  decomp  ERROR ${decomp.error} → proposer returns null`);
    else if (!decomp) console.log('  decomp  (no suggestion)');
    else {
      console.log(`  decomp  ${decomp.children.length} children — ${decomp.why}`);
      decomp.children.forEach((c, i) => console.log(`            ${i + 1}. ${c.title}`));
    }
  }
  console.log('\n# done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
