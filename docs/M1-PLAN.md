# M1 · Routing core — Architect Analysis

> **Status:** PHASE 1 (read-only architect analysis). Maps the M1 backend against the live code + PRD §4–5/§6/§13. Feeds PHASE 2 (tickets) and PHASE 3 (implement → architect→senior-swe→9-agent panel→merge). **No deploy until milestone review.**

**Goal.** Land the capability-aware routing core: per-issue complexity tiers, a local Agent pool with atomic concurrency claims, sprint scoping, the assignment engine at the verified `start_workspace` seam, the per-tier required-field gate, and the ts-rs regeneration that unblocks the deferred UI (#104–107, #109).

---

## 0. The load-bearing fact: **two databases**

Every M1 decision flows from this. The repo has two backends with separate schemas, migrations, and type-generation:

| | **Local host** (`crates/db`, SQLite) | **Remote cloud** (`crates/remote` + `crates/api-types`, Postgres + Electric) |
|---|---|---|
| Owns | `tasks`, `workspaces`, `sessions`, `execution_processes` | `issues`, `organization_members`, `users`, `projects`, `project_statuses`, `pull_requests` |
| Migrations | `crates/db/migrations/*.sql` (BLOB PK, `datetime('now')`) | `crates/remote/migrations/*.sql` (UUID, `gen_random_uuid()`, `CREATE TYPE … ENUM`, `electric_sync_table()`) |
| Rust models | `crates/db/src/models/*.rs` | `crates/api-types/src/*.rs` |
| ts-rs output | `shared/types.ts` (via `generate_types` bin → `pnpm run generate-types`) | `shared/remote-types.ts` (via `remote-generate-types` bin → `pnpm run remote:generate-types`) |
| Drives | the agent-execution host (relay) | the **web UI** (remote-web, via Electric shapes + `shared/remote-types.ts`) |
| sqlx cache | `crates/db/.sqlx` (`pnpm run prepare-db`) | `crates/remote/.sqlx` (`pnpm run remote:prepare-db`) |
| CI checks | `generate-types:check`, `prepare-db:check`, `SQLX_OFFLINE=true cargo nextest` | `remote:generate-types:check`, `remote:prepare-db:check` |

**Consequence for M1:** `complexity_tier` is added to **both** sides (PRD §4.1). The **assignment engine runs local** (the `start_workspace` seam is SQLite-side). The **UI flag-flips depend on the *remote* types** (`shared/remote-types.ts`), produced by the remote-issues, sprints, and synthetic-member tickets — **not** by the local Agent model. Keep the dependency direction straight or the UI flips won't unblock.

---

## 1. Scope → live-code map

Authoritative entity pattern (verified): **migration → `api-types`/`db` struct (`#[derive(…, TS, sqlx::FromRow)]`, enum dual-pattern `sqlx::Type`+`serde`+`ts`) → repo (`crates/remote/src/db/*` or `crates/db/src/models/*`) → route (`MutationBuilder`) → ts-rs export → Electric shape (`shapes.rs` + `shape_routes.rs` fallback)**. Template to mirror: `pull_requests` (migration `20260316000000` → `api-types/src/…` → `db/pull_requests.rs` → `routes/pull_requests.rs` → `PROJECT_PULL_REQUESTS_SHAPE`).

### 1.1 `complexity_tier` (PRD §4.1)
- **Local:** add `complexity_tier`/`tier_source`/`tier_confidence` to `tasks` (migration) + `Task` struct `crates/db/src/models/task.rs:24-33`; new `ComplexityTier`/`TierSource` enums modeled on `TaskStatus` (`task.rs:8-21`); extend every `query_as!` SELECT (`find_all :37-45`, `find_by_id :47-57`) with `as "col!: Type"` casts; add `Task::set_tier`.
- **Remote:** same three columns on `issues` (Postgres enum or TEXT+CHECK); fields on `Issue`/`CreateIssueRequest`/`UpdateIssueRequest` (`api-types/src/issue.rs:20-40`); update every `query_as!` site in `crates/remote/src/db/issues.rs` (e.g. INSERT `:349`); **Electric publication refresh** required since `issues` is in the publication (`20260114000000_electric_sync_tables.sql`) — re-`electric_sync_table('public','issues')` after the `ALTER`.
- Tiers: `basic|low|medium|hard|ultra`, default `medium`. `tier_source`: `manual|assistant|classifier`, default `manual` (§13.4: v1 manual + PM-assistant suggestion; auto-classifier is v2).

### 1.2 `Agent` entity (PRD §4.2, §13.3) — **local**
- New SQLite migration: `agents(id, org_id NULL, name, executor_profile, base_url NULL, credential_ref NULL, max_complexity_tier, min_complexity_tier DEFAULT 'basic', availability DEFAULT 'free' CHECK IN (free,busy,offline,paused), concurrency_limit INT DEFAULT 1, active_sessions INT DEFAULT 0, sandbox_profile NULL, timestamps)`.
- New model `crates/db/src/models/agent.rs` + `pub mod agent;` (`models/mod.rs` currently 16 modules, none for agents). Methods: `find_available_for_tier`, **`claim`** (atomic conditional `UPDATE … SET active_sessions = active_sessions + 1 WHERE active_sessions < concurrency_limit AND availability='free' RETURNING …`), `release`. `concurrency_limit` is UI-settable, default `1` (single-GPU serialization is documented, not enforced by hardware).

### 1.3 Agent-as-assignee (PRD §4.2) — synthetic remote user
- Each Agent ⇒ a synthetic `users` row + member row flagged `member_kind='agent'` / `is_system`, so `issue_assignees(issue_id,user_id)` and `activity.assignee_user_id` joins are reused **verbatim** — no parallel `agent_assignees` table. The flag firewalls agents from human auth flows + member-list UIs. The engine's "issue is unassigned" predicate counts agent assignees.
- **⚠️ Open question (resolve in PHASE 3 architect step for this ticket):** `issue_assignees`/`users` are **remote** (Postgres, what the board UI reads via Electric), but the ROADMAP titles this ticket "(local)". The assignment engine is local and needs the unassigned/tier state. The **spike (§1.6 / ROADMAP ticket 6)** must pin the local↔remote linkage and sync path before this ships. See §4 Risks.

### 1.4 Sprints (PRD §4.3, §13.2)
- `sprints(id, project_id, name, starts_at, ends_at, state)` table + additive `sprint_id UUID NULL` on **tasks (local)** and **issues (remote)**. `Sprint::active_for_project(project_id)` accessor. `NULL sprint_id` = no-filter (backward compatible). The engine restricts pickup to the active sprint ⇒ hard dependency for the engine.

### 1.5 Assignment engine (PRD §5) — new leaf crate
- `crates/assignment-engine/` — **deps: `db`, `executors` only** (a *leaf* consumed by `services`). Do **not** add `services` as a dep (the PRD §5.2 prose lists it, but that would create the `services → assignment-engine → services` cycle the same sentence warns against; the spine is `services → {db, executors}`). Add to root `Cargo.toml` `[workspace].members`.
- Pure `decide(task, agent_pool, sprint, relationships) -> AssignmentDecision` with **no DB side effects**. Variants (never a silent `None`): `Assigned{agent, executor_config}`, `Queued{AllBusy}`, `NoCapableAgent`, `Blocked`, `ManualOverride{executor_config, warn}`. Eligibility (§5.1): `min_tier ≤ tier ≤ max_tier AND availability=free AND active_sessions<concurrency_limit AND unassigned AND not blocked-by-open AND in active sprint`. `claim`/`release` + Session writes happen in the **caller**.

### 1.6 The seam (PRD §5.2, §13.8) — **`container.rs:1003`, before `Session::create` at `:1019`**
- Verified: `ContainerService::start_workspace(&self, workspace, executor_config, prompt)` at `crates/services/src/services/container.rs:1003`; `Session::create` at **`:1019`** (`crates/db/src/models/session.rs:145`). The originally-drafted `:1063` is **wrong** — it's the setup-script error handler, *after* the session already exists and is bound to the executor choice (too late, wrong layer).
- Trigger path: `POST /api/workspaces/start` → `create_and_start_workspace` (`crates/server/src/routes/workspaces/create.rs:212`, executor client-supplied `:300`) → `deployment.container().start_workspace(...)`. Task resolved via `workspace.task_id: Option<Uuid>` (`workspace.rs:44`) / `parent_workspace_id` / `linked_issue` (`create.rs:253`).
- **Spike first (ROADMAP ticket 6, doc-only):** the task FK was removed (`20260217120312`); confirm the exact seam→Task→tier path and whether `start_workspace`'s signature needs to change, and what branch-per-attempt (post-`20251216142123`) makes "unassigned"/"in-flight" mean. May surface a signature change. **No code in the spike.**
- Wiring (ROADMAP ticket 9): just before `:1019` — `Assigned` ⇒ override `executor_config` + `Agent::claim()`; `ManualOverride` ⇒ keep client config, audit-tag; `Queued/NoCapableAgent/Blocked` ⇒ non-execution result that flips ticket state, never starts a session. **Backward compat: zero Agent rows ⇒ byte-for-byte upstream.** Failed start releases the agent (cleanup `container.rs:1184-1209`); release point for re-dispatch is `finalize_task` `container.rs:226` (covers interrupted/failed, not just clean completion).

### 1.7 Executor env injection (PRD §5.1)
- `ExecutorConfig` (`executors/src/executors/profile.rs:124-144`) has **no** env/base_url field — injection is per-CodingAgent `CmdOverrides.env`. Map `Agent.base_url`+`credential_ref` → `ANTHROPIC_BASE_URL`+`ANTHROPIC_API_KEY` in the resolved profile's env at assignment time, keeping `disable_api_key=false` (so the key survives `claude.rs:645-648`; Qwen identical `qwen.rs:36`/`env.rs:118`). **Interim:** `credential_ref` → a secret store that's Phase-2; document the Phase-1 stopgap (env/config) for cloud-agent keys.

### 1.8 Per-tier required-field gate (PRD §6.1)
- `validate_required_fields(tier, fields)` → missing-field checklist per the §6.1 table (basic: title+exact files+IO contract+acceptance gate+edge cases; low: +modules+constrained tools; medium: +design note; hard: +human plan; ultra: human+cloud only). Gates the start path; `start_workspace` rejects with the checklist when unmet. Tier-raise-after-fill retains satisfied fields, prompts only newly-required (§6.3).
- **Storage decision (default, per ROADMAP): reuse a JSONB blob.** Remote issues already have `extension_metadata`; add an equivalent JSON field to local `tasks` rather than typed columns. (Surfaced here because it's a real schema decision — confirm at the ticket's architect step.)

### 1.9 Per-tier prompt templates (PRD §6.2) — scaffold
- Versioned, per-org-overridable per-tier system-prompt wrappers; injected by wrapping the ticket prompt (assembled before `start_workspace`, passed as `String` `container.rs:1007`) with the tier template at the seam. basic/low cap `max_turns` + constrain tools; save-time warning when a template names a tool the agent lacks (§6.3, warn at save not runtime). Phase-1 scaffold; PM-assistant (Phase 3) fills fields.

### 1.10 ts-rs → UI unblock
- The remote tickets (§1.1 remote `issues`, §1.3 synthetic member_kind, §1.4 remote `sprints`/`sprint_id`) regenerate **`shared/remote-types.ts`**, which unblocks the deferred UI: **#104** (board tier badge/filter + agent-assignee), **#105** (TierPicker + required-fields checklist), **#106** (AssigneePicker agent-vs-human), **#107** (Sprint selector), **#109** (activity timeline). Flip ticket **#117** turns the M1 flags on once these endpoints return real data. The local Agent model (`shared/types.ts`) feeds the engine, not the UI directly.

---

## 2. Dependency DAG (13 backend + 5 UI + 1 flip)

```
T1 tasks.complexity_tier (mig, local) ──┬─ T2 Task model + enums + query_as! ──┬─ T3 remote issues tier + Issue type ──┐
                                        │                                     ├─ T6 spike: seam→tier linkage (doc) ──┐ │
                                        ├─ T4 Agent entity + claim/release ───┼─ T7 synthetic agent-as-member ───┐  │ │
                                        │                                     ├─ T11 base_url/credential env inj │  │ │
                                        └─ T5 sprints + sprint_id ────────────┴─ T8 assignment-engine decide() ─┤  │ │
                                                                                                                 └─ T9 wire engine @ seam ─ T10 escalation/edge-cases
                                        T2 ── T12 required-field gate ── T13 per-tier prompt templates (also dep T9)

UI (depend on T3/T5/T7 → shared/remote-types.ts): #104, #105, #106, #107, #109   →   #117 flip M1 flags (last)
```

**Build order (respecting deps):** T1 → T2 → {T3, T4, T5, T6, T12} → {T7, T11, T8} → T9 → {T10, T13} → {#104,#105,#106,#107,#109} → #117.

---

## 3. §13 locked-decisions cross-ref
- **§13.2 sprints = entity** → §1.4 (first-class `sprints` table). ✓
- **§13.3 concurrency UI-settable, default 1** → §1.2 (`concurrency_limit` field; single-GPU documented). ✓
- **§13.4 manual + PM-assistant tiering** → §1.1 (`tier_source` manual default; classifier deferred v2). ✓
- **§13.5 human-gated escalation** → §1.6 / T10 (no auto tier-bump; `needs_attention` + one-click). ✓
- **§13.6 new code in new crates** → §1.5 (`crates/assignment-engine` leaf; minimal edit to the one upstream file `container.rs`). ✓
- **§13.1 sandbox = Phase 5**, **§13.8 spike** → §1.6 (spike is the gate before wiring; `sandbox_profile` column is added now but unused until Phase 5).

---

## 4. Risks & open decisions (surface now, resolve at each ticket's architect step)
1. **Local↔remote assignee/tier sync (highest).** The engine is local; assignees/tier the UI shows are remote. T6 spike must establish how the local engine reads the authoritative unassigned/tier/sprint state (sync vs. local mirror) and whether "(local)" in T7 is right or the synthetic member must be remote. Could change T7/T9 shape. **If the spike shows the engine needs a remote round-trip that doesn't exist, that's a §4.1 stop — surface before building T8/T9.**
2. **Electric publication refresh** on `issues` after adding tier columns — must re-`electric_sync_table` or the shape stops streaming (T3 acceptance gate).
3. **`services → assignment-engine` cycle.** Engine must stay a `db`+`executors` leaf; verify no workspace cycle (T8/T9 acceptance).
4. **Validation-field storage** (§1.8): JSONB reuse vs typed columns — confirm at T12 architect step.
5. **`start_workspace` signature change** may be forced by T6 (task resolution at the seam) — keep T9 flexible.
6. **sqlx offline cache** must be regenerated for **both** DBs on every schema ticket (`prepare-db` / `remote:prepare-db`), or CI's `prepare-db:check` fails.

---

## 5. Process
Each ticket: **architect → senior-swe → 9-agent adversarial panel → merge on approve + green CI.** Stop on panel reject or a §4.1 plan-wrong discovery (esp. risk #1). No AI mentions in any commit/PR/branch/tag (CLAUDE.md §3). CI green throughout; **no deploy until you review the milestone, then we deploy together** (the new build→deploy→verify→next cadence).
