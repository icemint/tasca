# Tasca — Stack Decision (v1.0)

**Status:** Decided. **Owner:** Dennis. **Date:** 2026-06-06.
**Decision:** **TypeScript / Node everywhere** — web, coordination, and execution — in one monorepo, one type system, one runtime, with shared types and **no codegen / `ts-rs` boundary**. **No Python** in the Stage 1–2 platform.

**Companion docs:** [`Tasca-Spike-Emdash-De-Electron-v1.0.md`](Tasca-Spike-Emdash-De-Electron-v1.0.md) · [`Tasca-Stage1-Scaffold-Proposal-v1.0.md`](Tasca-Stage1-Scaffold-Proposal-v1.0.md) · [`Tasca-PRD-v1.0-FINAL.md`](Tasca-PRD-v1.0-FINAL.md).

---

## The question

All-TypeScript/Node vs. a split stack (TypeScript frontend + **Python** backend). The split-stack case rests almost entirely on one thing: would Python's ML ecosystem materially help the **routing engine** (the tier classifier) in the near term? The bar set by the owner: a *concrete near-term (Stage 1–2) need* — **"don't add a language for a maybe."**

## The call

A six-architect panel evaluated the question from independent lenses. **Unanimous, high-confidence: TS-everywhere. Zero concrete near-term Python needs were found.**

| Lens | Vote | Concrete Python need? | Confidence |
|---|---|---|---|
| Execution ↔ coordination boundary | TS-everywhere | none | high |
| Routing engine / tier classifier | TS-everywhere | none | high |
| Shared types & DX | TS-everywhere | none | high |
| Adapters & SDK ecosystem | TS-everywhere | none | high |
| Ops / hiring / maintenance | TS-everywhere | none | high |
| Risk & reversibility | TS-everywhere | none | high |

## Why (synthesis of the panel)

1. **The execution core is fixed TS/Node and is the busiest boundary in the system.** The execution layer is a fork of **Emdash** (TypeScript/Node: PTY-spawned CLI agents, worktree pooling, SQLite/Drizzle). Coordination must continuously spawn, monitor, restart, and read/write the *same* run + task + claim state. A Python coordination layer would put an IPC/RPC + serialization + codegen boundary on exactly that hot path. TS-everywhere lets coordination call into the execution module in-process with shared types.

2. **The routing "ML" is not ML.** PRD §3.2 / §8 define tier estimation as **string/regex heuristics** (length, reasoning verbs, file/dir scope, labels) **+ one lightweight LLM *classifier call*** (a budgeted, cached request to a hosted vendor model returning `{tier, confidence}`) **+ an atomic CAS claim** (a conditional DB write). None of it is numerical ML — no training, no inference, no numpy/torch/sklearn/embeddings. It is webhook I/O, JSON, HTTP-to-a-vendor, and DB transactions — all TS-native strengths. The one Python-suggestive phrase, *"mis-tier signals retrain the classifier,"* means prompt/few-shot/threshold tuning (and at most a vendor-side fine-tune, still an API call) — explicitly **not** an in-house training pipeline.

3. **One type system, end to end.** Domain models (agents, identities, capability profiles, tasks, runs, routing decisions) are authored once and consumed by execution, coordination, **and** the already-TypeScript web console. A second language means a parallel set of models and a serialization contract that drifts every time the forked Emdash schema changes — the very schema Tasca does not control upstream and must rebase.

4. **The adapter/SDK ecosystem favors TS where the work is hardest.** Agent identity is the load-bearing part of every adapter (PRD §5): GitHub's **Octokit** (App JWTs, installation tokens, webhook HMAC) is first-party TS; Linear's `@linear/sdk` (`actor=app`, `AgentSessionEvent`) is TypeScript-first. HMAC-SHA-256 webhook verification (Shortcut/GitHub) is a wash (Node `crypto.timingSafeEqual`). No Python advantage; several disadvantages.

5. **One runtime is a real velocity + ops multiplier** for a small team across Stages 1–5: one package manager, one test runner, one typecheck/lint lane, one CI matrix, one on-call story — versus two of each plus an FFI/IPC contract to maintain. Splitting the atomic-claim/coordination path across a language boundary is the worst place to add an operational seam.

## When we would revisit (the bar)

Add Python **only** when a *concrete* in-house ML need appears that the hosted-LLM path genuinely cannot serve — e.g. a **custom-trained tier classifier** on numerical features, an **embeddings/retrieval** pipeline, or **eval infrastructure at scale**. That is, by the PRD's own staging, **post-Stage-2 at the earliest**, and only with evidence in hand. A hypothetical "we might want ML someday" does **not** clear the bar.

## How we keep that door cheap (reversibility)

The decision is low-regret because adding Python later is cheap *if* we build the seam now — which the scaffold already does:

- The classifier sits **behind a narrow port**: `estimateTier(task) → {tier, confidence}` (a `LlmClassifierPort` in `@tasca/routing`). A Python micro-service can be swapped in behind that interface later **without touching** the CAS claim, concurrency, escalation, or the coordination↔execution seam.
- **Capture labeled mis-tier data from day one** — the escalation breaker already produces it — so any future model migration starts with a ready dataset, not a cold start.
- A future Python service, if ever needed, lives **outside** the core as an isolated worker behind a typed HTTP/JSON contract. It never re-enters the hot coordination/execution path.

Starting TS and adding an isolated Python service later is far cheaper and lower-regret than starting split-stack and carrying a language boundary through every layer for capabilities Stage 1–2 never uses.

## Consequences

- **Stack (fixed for Stage 1–2):** TypeScript strict, Node 22 LTS, ESM; pnpm workspaces + Turborepo; Zod at every trust boundary; **Postgres** (Drizzle) for the coordination store; **SQLite/Drizzle** carried inside the Emdash fork for execution-local state.
- **No second language** enters the core. Any future ML work is an isolated service behind a port, gated on a concrete need.
- Proceed to the **de-Electron Emdash spike** and the **Stage 1 scaffold** (companion docs) on this basis.

---
*Resolved (owner, 2026-06-06): the execution-fork package is **`@tasca/execution`** (`packages/execution/`) — `execution-core` dropped.*
