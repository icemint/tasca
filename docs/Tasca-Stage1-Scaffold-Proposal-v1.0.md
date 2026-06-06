# Tasca — Stage 1 Scaffold Proposal (v1.0)

**Status:** Proposal for build. **Owner:** Dennis.
**Companion docs:** `Tasca-PRD-v1.0-FINAL.md` (what it does — source of truth), `Tasca-Design-Brief-v1.0.md` (how it looks).
**Scope:** Stage 1 only — *Foundation + Shortcut + Claude* (PRD §8). Plan-only; no code in this document.

**Decided stack (fixed):** TypeScript/Node **everywhere** — web + coordination + execution — in one monorepo, one type system, one runtime, shared types with **no codegen / ts-rs boundary**. SQLite/Drizzle carried in from the Emdash fork for execution-local state; **Postgres** for the coordination/cloud store. No second language: the routing engine's Stage 1–2 needs (heuristics + one lightweight LLM classifier call) do not clear the "concrete near-term Python ML" bar, so we do not add Python. Revisit only when a concrete in-house ML training/serving need appears (not before).

---

## 0. Stage 1 goal & the one advance benchmark

Everything below serves a single end-to-end proof (PRD §9.1):

> A Shortcut Story assigned to **"Elvis"** (a Claude-backed agent with a native Shortcut agent-user identity) is **routed** by the tier/capability engine, executed in an **isolated git worktree** by **Claude Code**, opens a **PR**, and **reports status back** to the Shortcut Story (comment + state change + PR link) — reliably, in one project, under the agent's native identity.

Stage 1 deliberately builds **one vendor (Claude), one adapter (Shortcut), one happy path**, with the seams (vendor registry, adapter interface, capability matching) shaped so Stages 2–5 slot in without re-architecting.

---

## 1. Monorepo / repo structure

### 1.1 Tooling baseline
- **Monorepo manager:** pnpm workspaces + **Turborepo** (task graph, caching). The existing `app/` and `website/` already use pnpm — consistent.
- **Language:** TypeScript strict mode, `"moduleResolution": "bundler"`, ESM throughout. One root `tsconfig.base.json`; each package extends it. Path aliases (`@tasca/*`) resolve to workspace packages — **types flow by import, never by codegen.**
- **Runtime:** Node 22 LTS. The execution package inherits Emdash's native-module constraints (`better-sqlite3`, `node-pty`) so the whole repo pins one Node ABI.
- **Lint/format:** ESLint + Prettier at root. **Boundaries enforced** via `eslint-plugin-boundaries` (or `dependency-cruiser`) so the dependency arrows below cannot be violated silently.
- **Validation:** **Zod** as the single runtime-validation + type-inference tool, used at every trust boundary (webhook payloads, env config, LLM classifier output, cross-package DTOs). Zod schemas live in `@tasca/contracts` and are the source of truth — TS types are `z.infer`red from them.

### 1.2 Layout

```
tasca/                                # existing repo root
├─ apps/
│  ├─ web/                            # ← existing app/ (Astro + design system) relocated here
│  └─ marketing/                      # ← existing website/ relocated here
├─ packages/
│  ├─ domain/                         # @tasca/domain      — pure domain models & types (no I/O)
│  ├─ contracts/                      # @tasca/contracts   — Zod schemas + inferred DTOs (API, webhooks, events)
│  ├─ coordination/                   # @tasca/coordination — the coordination SERVER (API + webhooks + routing + persistence)
│  ├─ routing/                        # @tasca/routing     — the routing ENGINE (tier est. + matching + claim + breaker)
│  ├─ execution/                      # @tasca/execution   — Emdash FORK, headless execution module
│  ├─ adapters/                       # @tasca/adapters    — adapter interface + Shortcut adapter (GitHub/Linear later)
│  ├─ identity/                       # @tasca/identity    — Devin-modeled agent-identity primitive (service-user/RBAC/profile)
│  ├─ db/                             # @tasca/db          — Postgres schema (Drizzle), migrations, repositories
│  └─ config/                         # @tasca/config      — typed env/config loader (incl. carried-over OAuth creds)
├─ docs/                              # this proposal, PRD, design brief, legal
├─ scripts/
├─ turbo.json
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

> **Migration note:** `app/` → `apps/web/`, `website/` → `apps/marketing/`. The `design-system/` tokens/assets feed `apps/web` (and `apps/marketing`) as today; no redesign here — Stage 1 reuses what exists.

### 1.3 Package responsibilities & boundaries

| Package | Owns | May import | Must NOT import |
|---|---|---|---|
| `@tasca/domain` | Pure types & domain entities (Agent, AgentIdentity, CapabilityProfile, Task, WorkOrder, Tier, AgentState, RoutingDecision). No I/O, no Node APIs. | (nothing internal) | everything else |
| `@tasca/contracts` | Zod schemas for all wire/event payloads; inferred DTOs; the **AdapterEvent** and **internal event-bus** shapes. | `@tasca/domain` | server/runtime pkgs |
| `@tasca/config` | Typed, validated env/config (Zod). Loads OAuth creds (§5), DB URLs, vendor keys, Shortcut secrets, Emdash flags. | `@tasca/contracts` | server/runtime pkgs |
| `@tasca/db` | Postgres Drizzle schema + migrations + repository functions. The coordination store. | `@tasca/domain`, `@tasca/config` | `routing`, `adapters`, `execution`, `coordination` (deps point inward) |
| `@tasca/identity` | Agent-identity primitive: service-user, RBAC role, capability profile binding, delegation/attribution, identity-binding records. | `@tasca/domain`, `@tasca/contracts`, `@tasca/db` | `coordination`, `adapters`, `execution` |
| `@tasca/routing` | Tier estimation, capability matching, atomic single-claim (CAS), concurrency limits, escalation breaker. **Pure-ish:** takes a port for persistence + a port for the classifier LLM. | `@tasca/domain`, `@tasca/contracts` | `coordination`, `adapters`, `execution` (it exposes interfaces they call) |
| `@tasca/adapters` | The `PlatformAdapter` interface + the **Shortcut** implementation (provisioning, webhook intake/verify, status-back). | `@tasca/domain`, `@tasca/contracts`, `@tasca/identity` (for identity bindings), `@tasca/config` | `routing` internals, `execution` |
| `@tasca/execution` | The **Emdash fork** as a headless module: worktree pool, PTY-spawn of Claude Code, run lifecycle, PR creation, SQLite/Drizzle local store. Exposes a clean `ExecutionPort`. | `@tasca/domain`, `@tasca/contracts`, `@tasca/config` | `routing`, `adapters`, `coordination` |
| `@tasca/coordination` | The **server**. HTTP API + webhook endpoints, the orchestration loop that wires adapter events → routing → execution → status-back, the event bus, scheduling. Composition root. | **all** packages | (it's the top of the graph) |
| `apps/web` | Operator console (roster, routing inspector, connections). Talks to `@tasca/coordination` HTTP API; shares types via `@tasca/contracts`. | `@tasca/contracts`, `@tasca/domain` (types only) | server-internal pkgs |
| `apps/marketing` | Marketing site. | (standalone) | everything |

**Dependency rule (enforced in lint):** arrows point inward toward `domain`/`contracts`. `coordination` is the only composition root that may import everything; `routing`/`execution`/`adapters` never import each other directly — they meet only in `coordination` and communicate through interfaces defined in `contracts`/`domain`. This is what lets Stage 2 add the GitHub adapter and Stage 3 add vendors without touching the engine.

---

## 2. The agent-identity primitive (Devin-modeled)

`@tasca/identity`. This is the internal abstraction that PRD §3.1 demands: every Tasca agent is a **service user** (never a fake human), with an RBAC role, a capability profile, and delegation/attribution — and it maps cleanly onto each platform's native identity (Shortcut agent-user in Stage 1; GitHub App, Linear `actor=app` later).

### 2.1 Conceptual model

```
Agent ("Elvis")
 ├─ ServiceUser         # the internal credential-bearing principal (NOT a human account)
 ├─ RbacRole            # least-privilege role: what this agent may do in Tasca + downstream scopes
 ├─ CapabilityProfile   # vendor/model, tiers, specialties, max tier, concurrency, cost ceiling, success history
 ├─ Delegation          # human-of-record / attribution (Devin create_as_user_id analogue)
 └─ IdentityBinding[]   # one per platform: maps the agent to its NATIVE identity there
       └─ (Stage 1) ShortcutIdentityBinding → Shortcut agent-user id + Shortcut-Token (service-scoped)
```

### 2.2 Data model (Postgres, conceptual columns)

- **`agent`** — `id`, `name` ("Elvis"), `avatar_url`, `vendor` (`claude` in Stage 1), `model`, `status` (`active|paused|retired`), `human_of_record_user_id` (delegation; nullable Stage 1, required for tools that demand it later), `created_at`, `version` (optimistic-lock counter).
- **`service_user`** — `id`, `agent_id` (1:1), `principal_id` (internal stable id used for audit attribution), `created_at`. The agent's internal "who did this" anchor; **stable across platform-credential rotation** (mirrors the Shortcut warning that a `Shortcut-Token` dies if the creating user is removed — so the *internal* principal must not depend on any one external credential).
- **`rbac_role`** — `id`, `name`, `permissions` (jsonb: internal capabilities like `task.claim`, `pr.create`, `status.post`), `downstream_scopes` (jsonb: least-privilege scopes to request per platform). Agents reference a role; roles are reusable.
- **`capability_profile`** — `agent_id` (1:1), `max_tier` (enum basic→ultra), `tiers_covered` (array), `language_specialties` (array), `framework_specialties` (array), `context_window`, `concurrency_limit`, `cost_ceiling`, `avg_latency_ms`, `success_rate` (measured; seeded null), `updated_at`.
- **`identity_binding`** — `id`, `agent_id`, `platform` (`shortcut|github|linear`), `external_id` (e.g. Shortcut agent-user id), `external_handle` (mentionable @name), `credential_ref` (pointer to secret store, **not** the secret), `state` (`provisioned|active|revoked`), `provisioned_at`. One row per platform the agent is deployed into.
- **`delegation`** — `agent_id`, `on_behalf_of_user_id`, `attribution_label`. Drives "agent acted as / on behalf of" in audit + status-back text.
- **`audit_event`** — `id`, `principal_id` (service_user), `agent_id`, `action`, `target` (task/story/PR), `platform`, `payload` (jsonb), `at`. Every privileged action an agent takes is recorded here (PRD §11 security).

### 2.3 How it maps to a Shortcut agent-user (Stage 1)

1. Tasca admin connects a Shortcut workspace (Connections screen, design brief C7).
2. `@tasca/adapters` (Shortcut) provisions/links a **Shortcut Agent User** (via the Shortcut Agent API — *exact creation surface confirmed with the Shortcut team in kickoff per PRD §10*). If programmatic creation isn't yet available, the flow falls back to "admin configures the agent user, Tasca links it by id."
3. The returned Shortcut agent-user id + service-scoped `Shortcut-Token` are stored: id/handle on `identity_binding`, token in the secret store with only `credential_ref` persisted.
4. The agent's internal `service_user.principal_id` is bound to that `identity_binding`. From then on, every status-back, comment, and state change Tasca posts is attributed to **Elvis's native Shortcut identity**, while internal audit attributes it to the stable `principal_id`.

This keeps the **internal primitive stable** even if the external Shortcut token must be rotated/re-provisioned, and gives Stages 2–3 a place to hang GitHub-App and Linear-`actor=app` bindings with zero model change.

---

## 3. The routing engine

`@tasca/routing` — the crown jewel (PRD §3.2). Built as **pure modules behind ports** so it has no direct DB/LLM/HTTP dependency; the coordination server injects adapters. This makes it unit-testable in isolation and is why it stays a clean TS package rather than ever needing a separate ML service in Stage 1–2.

### 3.1 Module map

```
@tasca/routing
 ├─ tier/
 │   ├─ heuristics.ts        # length, reasoning verbs, file/dir scope, labels → tier signal + features
 │   ├─ classifier.ts        # lightweight LLM call → { tier, confidence }, behind LlmClassifierPort
 │   └─ estimateTier.ts      # combine heuristics + classifier → TierEstimate { tier, confidence, signals }
 ├─ match/
 │   └─ matchCapability.ts   # TierEstimate + eligible agents → ranked candidates (CapabilityMatch[])
 ├─ claim/
 │   └─ atomicClaim.ts       # CAS single-claim against persistence port; exactly-one winner
 ├─ limits/
 │   └─ concurrency.ts       # per-agent + per-project limits; same-repo serialization gate
 ├─ escalation/
 │   └─ breaker.ts           # failure counter → breaker (N=2) → re-tier or needs_attention
 └─ ports.ts                 # interfaces the server implements (persistence, classifier, clock, metrics)
```

### 3.2 Interfaces (shapes, not code)

- **`estimateTier(task) → TierEstimate`**
  - `heuristics(task)` extracts cheap features: token/word length, presence of reasoning verbs ("design", "investigate", "refactor"), file/dir scope hints, Shortcut labels → a coarse prior + a feature vector.
  - `classifier(task, features)` makes **one** budgeted, cached LLM call (Claude small model in Stage 1) returning `{ tier, confidence }`, validated by a Zod schema (reject/fallback on malformed output). **Off the hot path / budgeted:** cache by content hash; skip the call entirely when heuristics are high-confidence and cheap (configurable threshold) to control cost.
  - Result: `TierEstimate { tier: Tier, confidence: number, signals: {...}, classifierUsed: boolean }` — persisted so the **routing decision is inspectable** (design brief C5).
- **`matchCapability(estimate, candidates) → CapabilityMatch[]`**
  - Filter agents whose `max_tier ≥ estimate.tier` and whose specialties/state allow the work; rank by success_rate, cost, latency, current load. Stage 1 has one agent (Elvis) but the function is N-agent from day one.
- **`atomicClaim(taskId, agentId, expectedVersion) → ClaimResult`**
  - **CAS** conditional write on the task's `(status, version)`: `UPDATE task SET status='claimed', claimed_by=:agent, version=version+1 WHERE id=:task AND status='routable' AND version=:expected`. Affected-rows = 1 ⇒ win; 0 ⇒ lose and re-query. Guarantees **exactly one agent per task**, no double-claim (PRD §3.2).
- **`concurrency`**
  - Before claim, check `count(active tasks for agent) < concurrency_limit` and per-project limit; **same-repo serialization** ensures no two worktrees collide on one repo (a per-repo lock/slot). These are advisory pre-checks; the CAS claim is the hard guarantee.
- **`breaker(taskId)`** (escalation / mis-tier recovery)
  - On execution failure, increment a failure counter on the task. At **N=2** (configurable) the breaker trips → either **re-tier** (escalate to a higher-capability agent — no eligible one in Stage 1 single-agent world) or transition the task to **`needs_attention`** for human review. Mis-tier signals are logged for later classifier improvement (no in-house retraining pipeline in Stage 1 — just captured).

### 3.3 Task status machine (the state CAS operates on)

```
ingested → routable → claimed → executing → in_review (PR open) → done
                         │            │
                         └────────────┴──► failed ──(breaker N=2)──► needs_attention
```
`version` increments on every transition; all claims/escalations are CAS against `(status, version)`.

---

## 4. The Shortcut adapter

`@tasca/adapters` — `PlatformAdapter` interface + Shortcut implementation. The interface is defined now so GitHub/Linear are pure additions later.

### 4.1 `PlatformAdapter` interface (the seam)

```
interface PlatformAdapter {
  platform: 'shortcut' | 'github' | 'linear'
  provisionIdentity(agent, workspaceConn): Promise<IdentityBinding>
  verifyWebhook(rawBody, headers): VerifiedEvent | Reject     // signature check
  parseEvent(verified): AdapterEvent[]                        // → normalized internal events
  postStatus(binding, update): Promise<void>                  // comment + state + PR link
}
```
All adapters emit the **same** normalized `AdapterEvent` (defined in `@tasca/contracts`) so the coordination loop is platform-agnostic.

### 4.2 Shortcut implementation (Stage 1)

- **Agent-user provisioning** (`provisionIdentity`): create/link the Shortcut **Agent User** via the Agent API; store id/handle on `identity_binding`, service-scoped `Shortcut-Token` in the secret store. *Provision under a stable service identity* so the token doesn't die when an individual is removed (PRD §5.1). **Gated on the kickoff confirmation** of the exact creation surface (PRD §10).
- **Assignment intake** (`verifyWebhook` + `parseEvent`): Shortcut **outgoing webhook** endpoint in `@tasca/coordination`. Verify **HMAC-SHA-256** over the raw body against the `Payload-Signature` header using the workspace webhook secret (constant-time compare; reject on mismatch). Parse `actions[]`:
  - Story `owner_ids` gains Elvis's agent-user id ⇒ **assignment** event.
  - Agent @mentioned in a comment ⇒ **mention** event (Stage 1 may treat as assignment-intent).
  - Emit normalized `AdapterEvent { type:'task.assigned', platform:'shortcut', externalStoryId, agentExternalId, repoHint? }`.
  - **Idempotency:** dedupe by Shortcut event id; webhook handler is fast-ack (verify + enqueue, then 200) so heavy work happens off the request thread.
- **Status-back** (`postStatus`): under Elvis's agent identity — (1) post a **comment** on the Story (progress / PR opened / blocked), (2) update the Story **workflow state** (e.g. → In Review), (3) attach/link the **PR URL**. Driven by execution lifecycle events from `@tasca/execution`.

### 4.3 Open confirmations (carry from PRD §5.1 / §10, resolve in kickoff before building intake)
(a) programmatic agent-user creation surface; (b) the exact "assigned to agent" webhook payload; (c) Agent API SDK timeline. Until confirmed, build against a thin Shortcut client wrapper with the payload shape behind a Zod schema so a contract change is a one-file edit.

---

## 5. Auth — carry over OAuth config only

Per the steer: **carry over ONLY the existing OAuth credentials/config; everything else greenfield.**

- **What carries over (as configuration, not code):** the existing **GitHub** and **Google** OAuth **client id / client secret / redirect URIs**. These were the operator-login credentials from before the pivot. They are loaded by `@tasca/config` from env (validated via Zod), never hardcoded, never committed.
  - `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
- **Scope of this OAuth:** operator/human **login to the Tasca console** (design brief C1 — "Account creation (OAuth — GitHub/Google)"). This is distinct from per-platform **agent-identity** provisioning (Shortcut agent-user token, future GitHub App), which is §2/§4 and is greenfield.
- **Greenfield (built fresh in Stage 1):** the session/auth implementation itself — a minimal OAuth login flow + session in `@tasca/coordination`, an `org` / `user` / `membership` model in `@tasca/db`, RBAC for human operators (admin-gated settings per design brief C8). No legacy auth code is reused; only the credential values move.
- **Secrets:** OAuth secrets, Shortcut tokens, and vendor (Anthropic) keys all go through one secret-store abstraction in `@tasca/config`; the DB stores only `credential_ref`s. (Execution package keeps Emdash's keychain replaced by this same headless secrets backend per PRD §4 de-Electron work.)

---

## 6. End-to-end Stage-1 happy path mapped onto the modules

> Story assigned to **Elvis** → route → worktree → Claude Code → PR → status back.

| # | Step | Package(s) | Detail |
|---|---|---|---|
| 1 | Admin connects Shortcut workspace; provisions Elvis's agent-user | `apps/web` → `coordination` → `adapters` (Shortcut) → `identity` → `db` | `IdentityBinding` row written; token in secret store. |
| 2 | A human assigns a Story to Elvis (`owner_ids`) in Shortcut | (external) | — |
| 3 | Shortcut fires outgoing webhook → Tasca | `coordination` (webhook endpoint) → `adapters.verifyWebhook` | **HMAC-SHA-256** verified against `Payload-Signature`; fast-ack 200; event enqueued. |
| 4 | Normalize + persist as a Task | `adapters.parseEvent` → `coordination` → `db` | `AdapterEvent{task.assigned}` → `task` row, status `ingested→routable`, `version=0`. |
| 5 | Estimate tier | `routing.estimateTier` (`heuristics` + `classifier` via port) | One budgeted/cached Claude classifier call; `TierEstimate` persisted (inspectable). |
| 6 | Match capability | `routing.matchCapability` | Elvis eligible (`max_tier ≥ tier`, idle, specialties OK) → candidate. |
| 7 | Concurrency + same-repo gate | `routing.concurrency` | Under per-agent/per-project limit; repo slot free. |
| 8 | **Atomic claim (CAS)** | `routing.atomicClaim` → `db` | `status routable→claimed`, `version→1`, exactly-one winner. |
| 9 | Dispatch to execution | `coordination` → `execution.ExecutionPort` | Hand off task + repo + branch intent; status `claimed→executing`. |
| 10 | Worktree + Claude Code | `execution` (Emdash fork) | Reserve isolated **git worktree** from pool; **PTY-spawn Claude Code**; agent works the change. |
| 11 | Open PR | `execution` | PR created (Stage 1 acceptable: under operator GitHub credentials / Emdash's PR-creation path; native GitHub-App identity is Stage 2). PR URL emitted. |
| 12 | Status back to Shortcut | `coordination` → `adapters.postStatus` (Shortcut) | As Elvis: comment ("PR opened"), Story state → In Review, **PR link** attached. Task `executing→in_review`. |
| 13 | Audit each privileged action | `identity.audit_event` | Provision, claim, PR-create, status-post all recorded under Elvis's `principal_id`. |
| 14 | Failure path | `routing.breaker` | On execution failure: counter++; at **N=2** → `needs_attention` (no higher-tier agent in single-agent Stage 1); mis-tier signal logged. |

The web console (`apps/web`) observes all of this via the coordination API: roster shows Elvis idle→working→awaiting/shipped; the **routing inspector** (design brief C5) renders the persisted `TierEstimate` + claim + match so the decision is inspectable.

---

## 7. Data store choice + key tables

**Coordination store: Postgres** (cloud, the coordination layer's source of truth — agents, tasks, routing decisions, identities, audit). Chosen for concurrency-safe CAS (row-level locking / conditional updates), jsonb for flexible profile/event payloads, and multi-tenant org scoping. Accessed via **Drizzle** in `@tasca/db`.

**Execution-local store: SQLite/Drizzle** — carried in from the Emdash fork (`@tasca/execution`), for worktree/run/session state local to the executor. Not the coordination source of truth; the coordination layer mirrors what it needs (PR URL, run status) into Postgres via execution lifecycle events. Keeps the Emdash fork's internals intact (low rebase cost) while Postgres owns cross-agent coordination.

### Key Postgres tables (Stage 1)
- **Identity/roster:** `org`, `user`, `membership`, `agent`, `service_user`, `rbac_role`, `capability_profile`, `identity_binding`, `delegation`.
- **Connections:** `platform_connection` (workspace-level Shortcut connection, webhook secret ref, health), `webhook_event` (raw inbound, for idempotency/dedupe + replay).
- **Routing/work:** `task` (with `status`, `version` for CAS, `claimed_by`, `tier_estimate` jsonb, `failure_count`, `repo_ref`, `external_story_id`, `platform`), `routing_decision` (persisted `TierEstimate` + candidates + winner — the inspector's data), `pull_request` (url, state, links task ↔ PR).
- **Ops/audit:** `audit_event`, `cost_event` (per-task vendor spend toward `cost_ceiling`).

CAS guarantee lives on `task.(status, version)`; `webhook_event` + Shortcut event id gives idempotent intake.

---

## 8. Ordered build sequence with checkpoints

Each checkpoint is a demoable, testable increment. Routing is invested in early (PRD §9.4); the Emdash de-Electron spike is timeboxed (PRD §9.2) and front-loaded because it's the biggest unknown.

1. **Monorepo skeleton.** pnpm workspaces + Turbo; relocate `app/`→`apps/web`, `website/`→`apps/marketing`; create empty `packages/*`; root tsconfig + lint boundaries + Zod baseline.
   - **Checkpoint:** `pnpm -w build` green; boundary lint fails on an intentional illegal import (proves enforcement); web + marketing still build.
2. **Domain + contracts + config + db.** Model `@tasca/domain` types; `@tasca/contracts` Zod schemas (AdapterEvent, webhook payloads, classifier output); `@tasca/config` env loader incl. **carried-over OAuth creds** (§5); Postgres schema + migrations in `@tasca/db` for §7 tables.
   - **Checkpoint:** migrations apply to a clean Postgres; config loader rejects missing/invalid env; round-trip a `task` repository in a test.
3. **Identity primitive.** `@tasca/identity`: service-user/RBAC/profile/binding/delegation/audit; admin RBAC for human operators; minimal OAuth login (GitHub/Google) + session in `coordination` using carried creds.
   - **Checkpoint:** operator logs in via Google/GitHub; an agent ("Elvis") + capability profile created and persisted with a stable `principal_id` and an empty `identity_binding`.
4. **Routing engine (pure, ports-mocked).** `@tasca/routing`: heuristics, classifier (behind port), `estimateTier`, `matchCapability`, `atomicClaim` (CAS), concurrency, breaker (N=2).
   - **Checkpoint:** unit tests prove **exactly-one-claim** under concurrent attempts (CAS), breaker trips at N=2 → `needs_attention`, tier estimate persists for inspection. **No platform/LLM needed** (ports mocked).
5. **Emdash fork → headless execution (timeboxed ~2–3 wks).** Fork into `@tasca/execution`; de-Electron (headless secrets, non-Electron PTY transport, rebuild native DB, headless bootstrap); expose `ExecutionPort`; verify worktree-pool + PTY-spawn **Claude Code** + PR creation headlessly.
   - **Checkpoint:** from a Node test harness, dispatch a trivial task → worktree reserved → Claude Code runs → PR opened. **Fallback (PRD §9.2):** if spike overruns, reimplement only worktree+PTY and pin the fork.
6. **Shortcut adapter.** `PlatformAdapter` interface + Shortcut impl: provisioning, `verifyWebhook` (HMAC-SHA-256), `parseEvent`, `postStatus`. Webhook endpoint + idempotent intake in `coordination`. **(Gate: kickoff confirmation of Agent API surface, PRD §10.)**
   - **Checkpoint:** a real Shortcut Story assigned to Elvis lands a verified webhook → normalized `task.assigned`; a manual `postStatus` posts a comment + state change + PR link as Elvis.
7. **Wire the coordination loop (end-to-end).** `coordination` composes adapter event → routing (estimate/match/claim) → execution dispatch → status-back; persist `routing_decision`, `pull_request`, `audit_event`, `cost_event`; emit lifecycle events to the web API.
   - **Checkpoint (THE advance benchmark, PRD §9.1):** Story assigned to Elvis in one project → routed → worktree → Claude Code → PR → comment+state+PR-link back to Shortcut, end-to-end, reliably; failure path lands `needs_attention`.
8. **Console surfacing (Stage-1 slice).** `apps/web`: Roster (Elvis idle/working/awaiting/shipped), Connections (Shortcut health), and the **routing inspector** rendering the persisted decision. Honest empty/loading/error states (design brief E3).
   - **Checkpoint:** operator watches a live run progress on the roster and inspects *why* it routed to Elvis; demo-ready Stage 1.

**Exit criteria for Stage 1:** checkpoint 7 passes repeatably under load (no double-claim, no worktree collision), checkpoint 8 makes it observable, and the seams (PlatformAdapter, vendor-agnostic capability profile, ports on routing) are in place so Stage 2 (GitHub App + escalation across multiple agents) is additive.
