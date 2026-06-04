# Tasca — Roadmap & Statement of Work

> Derived from [`docs/PRD.md`](PRD.md) by a 3×Architect + 3×SWE + DevOps review of the PRD against the current codebase. **Phase 0 severance + rebrand is ✅ complete**; **M1 · Routing core is ✅ complete, merged & deployed** (#8–#20, #143; UI tail #104/#105/#107/#117 + per-org flags #156/#157) — engine test-verified, cloud-half live-verified on `app.tasca.dev`, a live host-routing test deferred (see the M1 close-out). Remaining SoW below covers M2–M5 plus the M1 UI tail. Issues are tracked in GitHub milestones M0–M5 and M-AppUI.

## Milestones

| Milestone | PRD phase | Issues | Est. |
|---|---|---|---|
| **M0 · CI/CD & release foundation** | Phase 0 (CI/CD) | 6 | ~8 pts |
| **M1 · Routing core** ✅ *done — deployed; engine test-verified, host-routing deferred* | Phase 1 | 14 | ~31 pts |
| **M2 · Team + multi-user auth** | Phase 2 | 12 | ~22 pts |
| **M3 · PM-assistant** | Phase 3 | 9 | ~26 pts |
| **M4 · GitHub PR↔ticket automation** | Phase 4 | 14 | ~30 pts |
| **M5 · External clients + sandbox** | Phase 5 | 6 | ~20 pts |

**Total: 60 issues.** (Estimate points: S=1, M=2, L=4, XL=8 — relative sizing, not days.)


## M0 · CI/CD & release foundation

### `M` · `devops` — Author secret-free PR-validation CI workflow (.github/workflows/ci.yml)

## Context
The repo's `.github/` is empty — upstream BloopAI workflows were deleted (bbb50a450, cd788264e). Re-author the deleted `test.yml` against non-BloopAI sources as a single secret-free PR-validation workflow.

Key re-authoring decisions (from the deleted refs + current manifests):
- Replace `BloopAI/sccache-action@main` with `mozilla-actions/sccache-action@v0.0.6`.
- Inline the deleted setup-node composite: `pnpm/action-setup@v4` (pnpm@10.13.1 per `package.json:68`) + `actions/setup-node@v4` (node 22, `cache: pnpm`).
- Inline cargo-checks-common-setup: `dtolnay/rust-toolchain` pinned to `nightly-2025-12-04` (`rust-toolchain.toml:2`) + `Swatinem/rust-cache@v2`.
- DROP the `webfactory/ssh-agent` step + `VK_PRIVATE_DEPLOY_KEY` + fork-gating `if`: the private billing crate is severed (`crates/remote/Cargo.toml:16 vk-billing = []`), so remote checks run with zero secrets.
- Use `tasca-tauri` as the excluded tauri package.
- Commands map to package.json scripts: lint, the `*:check` typechecks, `cargo check --workspace` + `cargo check --manifest-path crates/remote/Cargo.toml`, `cargo nextest run --workspace --exclude tasca-tauri`, and sqlx offline via `prepare-db:check` + `remote:prepare-db:check`.
- Do NOT include Tauri-bundle, `mlugg/setup-zig`, or any deploy/publish job (deferred).

## Acceptance criteria
- [ ] `.github/workflows/ci.yml` exists with three jobs: frontend, backend, backend-remote
- [ ] Opening a PR triggers all three jobs; they pass on clean main with no repo secrets
- [ ] No reference to BloopAI, setup-zig, ssh-agent, VK_PRIVATE_DEPLOY_KEY, R2, or deploy secrets
- [ ] fmt/clippy (`--exclude tasca-tauri -D warnings`)/check/generate-types:check/remote:generate-types:check/prepare-db:check/remote:prepare-db:check/nextest all run
- [ ] Frontend job runs lint, the four `*:check` typechecks, and builds local-web + remote-web

## Depends on
none

## Estimate
M

### `S` · `devops` — Add optional Tauri compile-check job (apt webkit deps)

## Context
The deleted `test.yml` had a `tauri-checks` job. It is excluded from the fast secret-free CI because it needs `libwebkit2gtk-4.1-dev` and friends and is slow. Add it as a separate job (or `tauri.yml`) so the Tauri crate still gets compile coverage. Compile-only — no signing/bundling, no secrets. Reuse the backend job's toolchain/sccache/rust-cache setup with shared-key `tauri-checks`.

## Acceptance criteria
- [ ] Job installs the webkit apt deps then runs `cargo fmt --manifest-path crates/tauri-app/Cargo.toml -- --check`, clippy `-D warnings`, and `cargo check -p tasca-tauri`
- [ ] Job requires no secrets
- [ ] Job is path-filtered to run only when `crates/tauri-app/**` or shared backend crates change

## Depends on
Author secret-free PR-validation CI workflow (.github/workflows/ci.yml)

## Estimate
S

### `S` · `devops` — Add path-filtering + concurrency to CI to cut redundant runs

## Context
The minimal ci.yml ships always-run jobs for correctness-first simplicity. As a follow-up, port the deleted `dorny/paths-filter` `changes` job (filters preserved at bbb50a450~1) so docs-only or frontend-only PRs skip the full Rust matrix. Keep the `needs.changes.result == 'skipped'` fallback so push-to-main runs everything. Optimization, not a correctness gate — do after ci.yml is green.

## Acceptance criteria
- [ ] A `changes` job using `dorny/paths-filter@v3` (SHA-pinned) gates frontend, backend, backend-remote, tauri
- [ ] A frontend-only PR skips the Rust jobs; a Rust-only PR skips the frontend build
- [ ] push to main runs all jobs (skipped-fallback works)
- [ ] Required-check job names stay stable so branch protection isn't broken

## Depends on
Author secret-free PR-validation CI workflow (.github/workflows/ci.yml)

## Estimate
S

### `S` · `devops` — Add .github/dependabot.yml for cargo (×3), npm, and github-actions

## Context
No dependabot config exists. Three cargo entries are required because the root workspace `exclude`s `crates/remote` and `crates/relay-tunnel`, each with its own Cargo.lock. One npm entry at `/` covers the whole pnpm workspace (Dependabot reads pnpm-lock natively). One github-actions entry keeps CI action pins current. Weekly Monday schedule, minor/patch grouped per ecosystem, vite major ignored (deliberate vite^7 pin).

## Acceptance criteria
- [ ] `.github/dependabot.yml` has 5 entries: cargo at `/`, `/crates/remote`, `/crates/relay-tunnel`; npm at `/`; github-actions at `/`
- [ ] Dependabot validates the file with no schema errors
- [ ] Minor/patch PRs are grouped per ecosystem
- [ ] vite major-version updates are ignored

## Depends on
none

## Estimate
S

### `M` · `docs` — Document pre-1.0 semver + version-coordination + release-tag policy

## Context
Versions are inconsistent across surfaces: root/npx-cli/most crates/tauri.conf/local-web = 0.1.44; `crates/remote` = 0.1.27; `crates/server-info` = 0.1.36; `crates/relay-tunnel` = 0.1.7; `web-core` = 0.1.18; ui/remote-web = 0.1.0. Write `docs/RELEASING.md` establishing the policy. Per the version-convergence decision, RECOMMEND converging the lockstep app set and keeping remote/relay-tunnel independently versioned.

## Acceptance criteria
- [ ] States the pre-1.0 rule: `0.MINOR` = breaking, `0.x.PATCH` = backward-compatible
- [ ] Enumerates every version-bearing file and classifies each as lockstep-app vs independently-versioned
- [ ] Defines `v<version>` tags for the app and namespaced tags (`remote-v…`, `relay-tunnel-v…`) for independent components
- [ ] Includes a bump checklist (or `scripts/bump-version.mjs` plan) covering all lockstep files
- [ ] CHANGELOG.md stays Keep-a-Changelog; GitHub Release bodies follow the human-friendly convention

## Depends on
none

## Estimate
M

### `S` · `docs` — Document branch-protection ruleset requiring CI checks on main

## Context
Branch protection can't be applied from code — document it as an operator runbook (`docs/REPO-SETTINGS.md`) so the owner can enable it in GitHub Settings. Required checks must use the verbatim ci.yml job names or merges block on a non-existent check.

## Acceptance criteria
- [ ] Runbook lists the exact branch-protection/ruleset settings for `main` (PR required, ≥1 review, dismiss stale, up-to-date branches, restrict force-push/delete, conversation resolution)
- [ ] Names required status checks using the verbatim ci.yml job names
- [ ] Calls out the path-filter skipped-vs-success caveat and the names-must-match gotcha
- [ ] Explicit that this is a manual GitHub-settings step, signed commits deferred

## Depends on
Author secret-free PR-validation CI workflow (.github/workflows/ci.yml)

## Estimate
S


## M1 · Routing core

> **Status: backend ✅ COMPLETE & MERGED (panel-approved).** All backend tickets below (#8–#20) are closed, plus #143 (persist workspace→issue link; resolve tier from the linked Issue at the seam — the change that makes the engine fire). **Implementation note vs. the original spike framing:** tier is resolved from the linked **remote Issue** and denormalized onto the Workspace (`Workspace::assignment_context` / `set_assignment_context`) — the local `tasks` table is legacy/dead (no writes; Electric syncs Issues to the frontend PGlite) and `workspace.task_id` is never populated. The verified seam on `main` is `ContainerService::start_workspace` (`crates/services/src/services/container.rs:1079`) with `Session::create` at `:1156`; the engine call fires before it. `SERVER_ENCRYPTION_KEY` / envelope encryption is **not** built (M3); provider tokens are currently encrypted under the JWT secret.
>
> **M1 app-UI tail (milestone `M-AppUI`): ✅ COMPLETE.** #104 board tier badge + filter (PR #149); #105 TierPicker (#153); #107 Sprint selector + its Electric shape (#154) — all flag-gated; #117 enables `tiers`+`sprints` in the **local-web dev build only** via `packages/local-web/.env.development` (prod stays default-off — verified via Vite `loadEnv`) (#155). Per-org feature flags shipped as the **production rollout lever** (#156/#157): `organizations.feature_flags` JSONB + admin-guarded `PATCH /v1/organizations/{id}/flags` + `OrgFlagsProvider` (precedence **org > env > default-off**). #106 agent-assignee picker / #109 activity timeline ⏭ DEFERRED to M3 (synthetic agent-as-member is M3, #14/#114).
>
> **Deploy review close-out (2026-06-04):** M1 is deployed to `app.tasca.dev` (Coolify, SHA-pinned image; CD now self-verifies the rollout after the `read`-scoped token fix, #122; fail-closed flip tracked in #160). **The assignment engine is verified by tests, not exercised on a live host:** it runs host-side (`crates/server::create_and_start_workspace` + `crates/services::ContainerService::start_workspace`); the cloud server (`crates/remote` = `tasca-app`) has **no** assignment engine and **no** agents table, and agents live in the host's local SQLite (`crates/db/models/agent.rs`). A live host-routing test (Assigned-not-`ManualOverride`, `needs_attention` on failure, `no_capable_agent` over-tier — PRD §5.5) is **deferred** to when there's a host workflow (#159). **The cloud half IS live-verified:** a tiered issue created via `POST /v1/issues` persists with `complexity_tier`+`tier_source` (txid-committed) and is served back + Electric-syncs. **Known gap:** sprint *creation* has no cloud API (only the #107 shape + selector shipped), so `issues.sprint_id` can't be populated on prod until a sprint-create path exists (#158).

### `S` · `db` — ✅ #8 — Add complexity_tier columns to local tasks table (additive migration)

## Context
`crates/db/src/models/task.rs:23-33` has an 8-field Task with no tiering, and no tier migration exists in `crates/db/migrations/`. Add an additive SQLite migration per PRD 4.1. SQLx auto-discovers migrations; the DEFAULT keeps existing rows valid.

Add `complexity_tier TEXT NOT NULL DEFAULT 'medium' CHECK (… IN ('basic','low','medium','hard','ultra'))`, `tier_source TEXT NOT NULL DEFAULT 'manual' CHECK (… IN ('manual','assistant','classifier'))`, and `tier_confidence REAL NULL`. Run `pnpm run prepare-db` to refresh `crates/db/.sqlx`.

## Acceptance criteria
- [ ] Migration adds the three columns with both CHECK constraints
- [ ] Fresh DB and migrated existing DB both pass auto-migrate on `DBService::new()`
- [ ] Pre-existing task rows default to `medium`/`manual`
- [ ] `crates/db/.sqlx` regenerated; `cargo check --workspace` passes

## Depends on
none

## Estimate
S

### `S` · `backend` — ✅ #9 — Surface complexity_tier on the local Task model and all query_as! sites

## Context
The Task struct (`task.rs:24-33`) and its `query_as!` statements (`find_all :37-45`, `find_by_id :47-57`) select explicit column lists that won't compile against the new tier columns.

Add `complexity_tier` (new `ComplexityTier` enum), `tier_source` (`TierSource` enum), and `tier_confidence: Option<f64>` to Task; define both enums modeled on the existing `TaskStatus` enum (`task.rs:8-21`) with `sqlx::Type` + ts-rs + serde renames. Extend every SELECT column list with the `as "col!: Type"` casts. Add a `Task::set_tier` helper for manual overrides.

## Acceptance criteria
- [ ] Task carries `complexity_tier`, `tier_source`, `tier_confidence`
- [ ] `ComplexityTier`/`TierSource` derive `sqlx::Type`, Serialize/Deserialize, TS, EnumString/Display
- [ ] `find_all` and `find_by_id` compile against the new schema
- [ ] `Task::set_tier(pool, id, tier, source, confidence)` persists an override
- [ ] `pnpm run generate-types` emits the new enums to `shared/types.ts`

## Depends on
Add complexity_tier columns to local tasks table (additive migration)

## Estimate
S

### `M` · `db` — ✅ #10 — Add complexity_tier fields to remote issues table and Issue API type

## Context
Remote issues live in Postgres. `crates/api-types/src/issue.rs:20-40` (Issue, shared local+remote via ts-rs) has no tier field, and `crates/remote/src/db/issues.rs` uses compile-time `query_as!` with explicit column lists (e.g. INSERT at :349).

Add a remote migration adding the same three tier columns (Postgres enum or TEXT+CHECK), add the fields to `Issue` plus `CreateIssueRequest`/`UpdateIssueRequest`, and update every SELECT/INSERT/UPDATE column list in `issues.rs`. **Confirm the safe Electric sequence** before shipping: if `issues` is in the publication (`20260114000000_electric_sync_tables.sql`), adding columns needs a publication refresh via `electric_sync_table()`. Run `pnpm run remote:prepare-db`.

## Acceptance criteria
- [ ] Remote migration adds the three tier columns with the same constraint domain as local
- [ ] Issue + Create/Update request structs carry tier fields
- [ ] All `query_as!` sites in `issues.rs` compile; `crates/remote/.sqlx` regenerated
- [ ] Electric `issues` shape still streams after the publication refresh
- [ ] `pnpm run remote:generate-types` reflects the new fields

## Depends on
Surface complexity_tier on the local Task model and all query_as! sites

## Estimate
M

### `M` · `db` — ✅ #11 — Create Agent entity migration and local Agent model (claim/release)

## Context
No agent concept exists in the local DB (`models/mod.rs` lists 16 modules, none for agents). Add a migration per PRD 4.2: `agents(id, org_id NULL, name, executor_profile, base_url NULL, credential_ref NULL, max_complexity_tier, min_complexity_tier DEFAULT 'basic', availability DEFAULT 'free' CHECK in (free,busy,offline,paused), concurrency_limit INT DEFAULT 1, active_sessions INT DEFAULT 0, sandbox_profile NULL, timestamps)`.

Add `crates/db/src/models/agent.rs` with `find_available_for_tier`, `claim`, `release`, and `pub mod agent;`. `claim()` MUST use an atomic conditional UPDATE (PRD 5.4: `SET active_sessions = active_sessions + 1 WHERE active_sessions < concurrency_limit AND availability='free' RETURNING`) so concurrent dispatchers cannot over-claim the single-GPU local agent.

## Acceptance criteria
- [ ] Migration creates the full column set with CHECK on availability and tier bounds
- [ ] `find_available_for_tier`, `claim` (atomic conditional UPDATE), `release` exist
- [ ] `claim` returns false/None when `active_sessions >= concurrency_limit` (loser path); concurrency race test passes
- [ ] `pub mod agent;` added; `cargo check --workspace` passes; Agent exported to `shared/types.ts`

## Depends on
Add complexity_tier columns to local tasks table (additive migration)

## Estimate
M

### `M` · `db` — ✅ #12 — Add sprints table and sprint_id scoping

> **Note:** the `sprints` table exists in both DBs (#139), but the sprints Electric SHAPE is **not** published yet — deferred to #107 (Sprint selector).

## Context
No sprints exist. PRD 4.3 makes sprints first-class for assignment scoping. Add a `sprints(id, project_id, name, starts_at, ends_at, state)` table and an additive `sprint_id UUID NULL` on tasks (local) and issues (remote), with a Sprint model exposing the active sprint per project. The engine restricts pickup to the active sprint, so this is a hard dependency. Treat `NULL sprint_id` as no-filter for backward compatibility.

**Note:** confirm the §13.8 spike on `parent_workspace_id` / branch-per-attempt semantics (post-refactor 20251216142123) before tying sprint scoping to task pickup.

## Acceptance criteria
- [ ] `sprints` table created (locally, and remotely if remote scoping is needed) with a `state` column
- [ ] `sprint_id NULL` added to tasks and issues additively
- [ ] `Sprint::active_for_project(project_id)` accessor exists
- [ ] Existing rows remain valid with `sprint_id NULL`; `cargo check` passes

## Depends on
Add complexity_tier columns to local tasks table (additive migration)

## Estimate
M

### `S` · `backend` — ✅ #13 — Spike: resolve Task/tier linkage at start_workspace (corrected seam)

> **Outcome:** the implemented linkage resolves tier from the **linked remote Issue** denormalized onto the Workspace (`assignment_context`), not via `workspace.task_id` (never populated) — see #143.

## Context
PRD 5.2 cites `container.rs:1063`, but the verified seam is `start_workspace(workspace, executor_config, prompt)` at `crates/services/src/services/container.rs:1079`, with `Session::create` at **:1156**. The task FK was removed (20260217120312). Document how the engine resolves a Task and its `complexity_tier` at the seam — via `workspace.task_id` (Option<Uuid>, `workspace.rs:44`), `parent_workspace_id`, or `linked_issue` (`create.rs:253`) — and whether branch-per-attempt changes what "unassigned"/"in-flight" mean. Documentation only; may surface a needed `start_workspace` signature change.

## Acceptance criteria
- [ ] A documented, verified path from the seam to the Task and its tier
- [ ] Decision on whether a `start_workspace` signature change is needed, recorded
- [ ] §13.8 branch-per-attempt impact on "unassigned"/"in-flight" documented
- [ ] No code change in this issue

## Depends on
Surface complexity_tier on the local Task model and all query_as! sites

## Estimate
S

### `M` · `backend` — ⏭ DEFERRED to M3 (#14) — Model agents as org members of type agent for the assignee picker (local)

> **Not part of shipped M1.** This is GitHub issue #14 in milestone **M3 · PM-assistant** (synthetic agent-as-member, with #114). M1 routing fires without it.

## Context
PRD 4.2 requires agents to appear in the assignee picker by being modeled as an org member of type `agent`, reusing `issue_assignees`. **Decision (default): synthetic-user representation** — each Agent gets a synthetic users row + member row flagged `agent`/`is_system` so existing `issue_assignees.user_id` / `activity.assignee_user_id` joins work unchanged, with the flag excluding agents from human auth/member-list UIs. This issue feeds the engine's `unassigned` predicate.

## Acceptance criteria
- [ ] Representation chosen (synthetic agent-as-member) and documented
- [ ] An agent can be set/cleared as a ticket assignee through existing assignee APIs
- [ ] The engine's "issue is unassigned" check accounts for agent assignees
- [ ] Synthetic agent users are firewalled from human auth flows and member-list UIs; no regression to human assignee paths

## Depends on
Create Agent entity migration and local Agent model (claim/release)

## Estimate
M

### `L` · `backend` — ✅ #15 — Scaffold crates/assignment-engine with a pure decide() and eligibility predicate

## Context
No assignment intelligence exists today; executor choice is client-supplied (`executor_config` from the HTTP request, `crates/server/src/routes/workspaces/create.rs:300`). Add `crates/assignment-engine/` (deps: db, executors) exposing a side-effect-free `decide()`: given a Task (tier, sprint, blocked-by, assignee state) and the agent pool, return `AssignmentDecision` — `Assigned{agent, executor_config}`, `Queued{AllBusy}`, `NoCapableAgent`, `Blocked`, or `ManualOverride{executor_config, warn}`.

Eligibility (PRD 5.1): `min_tier <= tier <= max_tier AND availability=free AND active_sessions<concurrency_limit AND unassigned AND not blocked AND in active sprint`. Resolve `executor_profile` to a concrete config + base_url/credential. `claim()`/`release()` and Session writes happen in the caller. Add to `[workspace].members`.

## Acceptance criteria
- [ ] Crate builds and is added to workspace members
- [ ] `AssignmentDecision` covers all 5 variants per PRD 5.1/5.4 — never a silent `None`
- [ ] `decide()` is pure over (task, agent pool, sprint, relationships) with table-driven tests across 5 tiers × {free,busy,offline,paused}
- [ ] Eligibility predicate matches PRD 5.1 exactly
- [ ] No DB side effects inside `decide()`

## Depends on
Create Agent entity migration and local Agent model (claim/release); Add sprints table and sprint_id scoping

## Estimate
L

### `L` · `backend` — ✅ #16 — Wire the assignment engine into start_workspace before Session::create

> **As shipped:** wired in `ContainerService::start_workspace` (`crates/services/src/services/container.rs:1079`) before `Session::create` (`:1156`); the impure helper is `services::services::assignment::{context_for_workspace, claim_assignment}` → `ClaimOutcome::{Assigned,Queue,Upstream}`, with atomic `Agent::claim` and exactly-once release via `Session::take_claimed_agent` in `finalize_task`. (Original ':1003/:1019' line numbers were pre-merge estimates.)

## Context
The corrected seam: `start_workspace` is at `crates/services/src/services/container.rs:1079`; `Session::create` runs at **:1156** with `executor: Some(executor_config.executor.to_string())`. Just before :1156, resolve `Task::find_by_id`, call `decide()`, and:
- **Assigned** → override `executor_config` (executor + inject base_url/credential into the resolved CodingAgent's `CmdOverrides.env`) and call `Agent::claim()`
- **ManualOverride** → keep client config, tag the attempt for audit
- **Queued/NoCapableAgent/Blocked** → return a non-execution result that flips the ticket to ready/no_capable_agent/needs_attention; never start a session

Backward compat: when no Agent rows exist, fall through to the client config exactly as upstream. Integrate with start-failure cleanup (`container.rs:1184-1209`) so a failed start releases the agent. Confirm `services → assignment-engine → db/executors` introduces no workspace dependency cycle.

## Acceptance criteria
- [ ] Single insertion point before :1156 (one upstream-file edit)
- [ ] When a capable Agent exists, the session uses the agent's config + base_url/credential, not the client's; `claim()` is atomic, loser re-queries
- [ ] Zero Agent rows ⇒ byte-for-byte upstream behavior
- [ ] Queued/NoCapableAgent/Blocked set the documented ticket state, never silently start or drop
- [ ] Failed start releases the claimed agent; decision <200ms p95 excluding inference

## Depends on
Scaffold crates/assignment-engine with a pure decide() and eligibility predicate; Model agents as org members of type agent for the assignee picker (local); Spike: resolve Task/tier linkage at start_workspace (corrected seam)

## Estimate
L

### `L` · `backend` — ✅ #17 — Implement escalation + edge-case state transitions on assignment/attempt failure

> **As shipped:** human-gated, no auto tier-bump; deferred-start + agent-release FIFO re-dispatch. `escalate_workspace_tier` writes the tier to the **remote Issue first** (remote-authoritative), then syncs local + clears attention (idempotent/self-healing on partial failure); remote audit `AuditAction::IssueEscalateTier`. Operational/attention state (`dispatch_state`, `needs_attention`, `attention_reason`, `interrupted`) lives on the **Workspace** (off-struct accessors), not the dead tasks table.

## Context
PRD 5.3/5.4 require human-gated escalation (no auto tier-bump in v1) and explicit handling of: no eligible agent (ticket stays todo, flagged `no_capable_agent`, notify leads); all-capable-busy (queue ready, FIFO by priority then sort_order, picked up on agent-release event); agent-offline-mid-run (Session `interrupted`, worktree preserved, ticket `needs_attention`, resumable not silent-retry); tier-downgrade-after-start (in-flight unaffected); manual-override-vs-ceiling (allowed, warns, audit-tagged).

Build the agent-release event hook that re-runs the queue (reuse `finalize_task` `container.rs:226` as the release point, covering interrupted/failed sessions, not just clean completion), the failure recorder flipping to `needs_attention` with a reason, and the one-click escalate-to-tier+1/reassign-to-cloud backend action. No silent no-ops.

## Acceptance criteria
- [ ] Executor error / validation-gate fail / max-turn exhaustion ⇒ `needs_attention` with a recorded reason; no auto tier-bump
- [ ] Agent release triggers FIFO (priority, then sort_order) re-dispatch of queued-ready tickets
- [ ] Agent offline mid-run marks Session `interrupted`, preserves worktree, ticket `needs_attention`
- [ ] Manual override outside the tier ceiling is allowed, warns, audit-tagged
- [ ] Integration test proves zero silent no-ops across the tier × availability matrix (PRD 5.5)

## Depends on
Wire the assignment engine into start_workspace before Session::create

## Estimate
L

### `M` · `backend` — ✅ #18 — Inject Ollama/cloud base_url + credential env for ClaudeCode and QwenCode

## Context
`crates/executors/src/executors/claude.rs:640-642` merges `CmdOverrides.env` over the runtime env, and :645-648 removes `ANTHROPIC_API_KEY` only when `disable_api_key=true`. Qwen applies env identically (`qwen.rs:36`, `with_profile` in `env.rs:118`). Note `ExecutorConfig` (`profile.rs:124-144`) has NO env/base_url field — injection is per-CodingAgent `CmdOverrides.env`.

Translate an Agent's `base_url` + `credential_ref` into the resolved profile's `CmdOverrides.env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`) at assignment time, keeping `disable_api_key=false` so the key survives. Add a helper mapping `Agent.executor_profile` + `base_url` into a concrete CodingAgent with env populated.

**Interim:** `credential_ref` points at a secret store not built until Phase 2 — document the Phase-1 stopgap source (env/config) for cloud-agent keys.

## Acceptance criteria
- [ ] An agent with `base_url` produces a ClaudeCode/QwenCode whose env contains `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
- [ ] `disable_api_key` stays false on Ollama-pointed agents (key not removed at claude.rs:645)
- [ ] A local Ollama run (Qwen via base_url) spawns and reaches the endpoint
- [ ] Cloud-agent key source documented; Phase-1 stopgap noted

## Depends on
Create Agent entity migration and local Agent model (claim/release)

## Estimate
M

### `M` · `backend` — ✅ #19 — Build per-tier required-field validation gate for ticket start

> **As shipped:** `assignment_engine::validation`, enforced in `create_and_start_workspace` only when agents are configured.

## Context
PRD 6.1 defines escalating required fields per tier (basic: title + exact files + IO contract + acceptance gate + edge cases; low: + affected modules + constrained tools; medium: + design note; hard: + human plan; ultra: human+cloud only). No validation exists. Build `validate_required_fields(tier, fields)` in/beside `crates/assignment-engine` returning the missing-field checklist, and gate the start path so `start_workspace` rejects with a checklist when fields are absent.

**Decision (default): reuse a JSONB blob.** Remote issues already have `extension_metadata`; add an equivalent JSON field to local tasks rather than typed columns. Tier-raise-after-fill retains satisfied fields and prompts only newly-required ones (6.3).

## Acceptance criteria
- [ ] `validate_required_fields(tier, fields)` returns the exact missing-field checklist per the PRD 6.1 table
- [ ] Start is blocked with a clear missing-field list when requirements are unmet
- [ ] Raising tier after fill retains satisfied fields, prompts only newly-required ones
- [ ] Storage location decided (JSONB reuse) and documented
- [ ] Unit tests cover all five tiers including ultra = human+cloud-only

## Depends on
Surface complexity_tier on the local Task model and all query_as! sites

## Estimate
M

### `L` · `backend` — ✅ #20 — Scaffold versioned per-tier prompt templates injected via the executor prompt

### M1 app-UI tail (milestone `M-AppUI`)

- ✅ **#104** — Board tier badge + filter (flag-gated `tiers`; live in `packages/web-core/src/features/kanban/ui/KanbanContainer.tsx`).
- ⏳ **#105** — Issue Drawer TierPicker + RequiredFieldsChecklist (`flag.tiers`) — PENDING.
- ⏳ **#107** — Issue Drawer Sprint selector (`flag.sprints`) — PENDING (needs the sprints Electric shape, deferred from #12).
- ⏳ **#117** — Flip M1 app-UI flags when routing-core schema lands — PENDING.
- ⏭ **#106** — Issue Drawer AssigneePicker (agent vs human) — DEFERRED to M3 (needs synthetic agent-as-member #14).
- ⏭ **#109** — Activity timeline (agent/assistant actors) — DEFERRED to M3.


> **As shipped:** `services::services::prompt_templates`, wrapped at the seam; `--max-turns` applied only for ClaudeCode.

## Context
PRD 6.2 requires editable, versioned, per-org per-tier system-prompt wrappers that constrain tool surface, cap `max_turns`, and forbid open-ended planning for low/basic tiers, injected via the executor prompt (assembled before `start_workspace` and passed as a plain String, `container.rs:1007`).

Build a prompt-template store (defaults + per-org override), a renderer wrapping the ticket prompt with the tier template at the assignment seam, and a save-time warning when a template references a tool the agent lacks (6.3, warn at save not runtime). For basic/low, surface `max_turns` into the resolved CodingAgent config. Phase-1 scaffolding; the PM-assistant (Phase 3) fills the fields.

## Acceptance criteria
- [ ] Per-tier default templates exist and are versioned; per-org override supported
- [ ] The ticket prompt is wrapped with the tier template at the seam before Session::create
- [ ] basic/low templates cap turns and constrain the tool surface
- [ ] Saving a template referencing a missing tool warns at save time
- [ ] Template versioning lets an org pin/upgrade independently

## Depends on
Wire the assignment engine into start_workspace before Session::create; Build per-tier required-field validation gate for ticket start

## Estimate
L


## M2 · Team + multi-user auth

### `S` · `db` — Add password + lifecycle columns to users (additive migration)

## Context
`crates/remote/migrations/20251001000000_shared_tasks_activity.sql:22` users has only id/email/name/username/timestamps — no credential or lockout state, and local login compares a single plaintext env secret (`auth/local.rs:50-54`). Add an additive migration adding `password_hash TEXT NULL` (argon2id PHC), `email_verified BOOLEAN NOT NULL DEFAULT false`, `failed_attempts INT NOT NULL DEFAULT 0`, `locked_until TIMESTAMPTZ NULL`, `password_updated_at TIMESTAMPTZ NULL`. Keep nullable/defaulted so OAuth-only and env-secret users are unaffected. Do NOT add these columns to any Electric publication.

## Acceptance criteria
- [ ] Migration adds the five columns with safe defaults; `remote:prepare-db` succeeds
- [ ] Existing rows migrate without manual backfill; OAuth + env-secret login still work
- [ ] Credential columns excluded from Electric publications (not client-readable)
- [ ] `password_hash` never serialized into `api_types::User` (verified by a type/test assertion)

## Depends on
none

## Estimate
S

### `M` · `security` — Add argon2id hashing module and credential repository methods

## Context
No argon2/bcrypt dependency exists (`crates/remote/Cargo.toml` has only aes-gcm/secrecy). Add the `argon2` crate and `crates/remote/src/auth/password.rs` with `hash_password(&str)` and `verify_password(hash, candidate)` using argon2id (m=19456, t=2, p=1). Extend `UserRepository` (`db/users.rs`) with `set_password_hash`, `fetch_credential_state`, `bump_failed_attempts`, `reset_failed_attempts`, `set_locked_until`, `set_email_verified`. Primitive layer; routes consume it later.

## Acceptance criteria
- [ ] `argon2` added with documented argon2id params
- [ ] `hash_password` produces `$argon2id$` strings; `verify_password` round-trips and rejects wrong passwords
- [ ] UserRepository gains the hash get/set + lockout-counter mutators
- [ ] Unit tests cover hash/verify round-trip and a known-wrong-password rejection

## Depends on
Add password + lifecycle columns to users (additive migration)

## Estimate
M

### `M` · `security` — Replace plaintext env login with per-user argon2id verification (keep env bootstrap)

## Context
`crates/remote/src/auth/local.rs:50-55` does `payload.password != local_auth.password().expose_secret()` — single-tenant plaintext compare. Rework `login()`: look up the user by normalized email; if `password_hash` exists, verify via the argon2 module. The env secret (`config.rs:332-365`) is retained ONLY as a bootstrap that seeds the first owner account's hash on first successful login, then is no longer authoritative. Keep the existing `upsert_user` + `ensure_personal_org` + session/JWT flow (`local.rs:57-122`) intact downstream.

## Acceptance criteria
- [ ] Users with a stored hash authenticate via `verify_password`; no plaintext compare remains once a hash exists
- [ ] Env-secret bootstrap still logs in the operator and seeds a hash on first login (gated, documented precedence)
- [ ] Token issuance, session creation, personal-org bootstrap unchanged for successful logins
- [ ] Unit tests cover correct-password, wrong-password, unknown-email, and the bootstrap-precedence path

## Depends on
Add argon2id hashing module and credential repository methods

## Estimate
M

### `S` · `security` — Add account lockout after N failed login attempts

## Context
No lockout exists. Using `users.failed_attempts`/`locked_until`, increment on each invalid result in `local::login`, set `locked_until = now()+backoff` after N failures (config-driven, default 10), and short-circuit before hash verification with a `Locked` error while `locked_until` is in the future. Reset on success. Return a generic error to avoid enumeration; log lockouts server-side.

## Acceptance criteria
- [ ] After N configurable failures the account is locked until `locked_until`; further attempts short-circuit before hashing
- [ ] Successful login resets `failed_attempts` and clears `locked_until`
- [ ] Lockout responses don't leak whether the email exists
- [ ] Integration test drives N+1 failures → lockout, then asserts auto-unlock after the window

## Depends on
Replace plaintext env login with per-user argon2id verification (keep env bootstrap)

## Estimate
S

### `M` · `security` — Add rate limiting to /auth/local/login, /tokens/refresh, and OAuth callback

## Context
No rate limiting exists (no governor in deps; routes merged plainly at `routes/mod.rs:104-136`). Add a limiter on the public auth routes: `/auth/local/login` (`oauth.rs:34`), `/tokens/refresh` (`tokens.rs:24`), `/oauth/{provider}/callback` (`oauth.rs:36`), keyed on client IP (trust only the configured proxy's `X-Forwarded-For`) plus a per-email dimension for login.

**Decision (default):** DB-backed durable counters for the per-account login path (aligns with persisted `locked_until`), in-memory `tower_governor` per-IP for OAuth/refresh. Return 429 with Retry-After; env-configurable.

## Acceptance criteria
- [ ] Login, refresh, and OAuth callback return 429 + Retry-After once the per-window limit is exceeded
- [ ] Login keys on IP and submitted email; limits configurable via env with documented defaults
- [ ] Legitimate refresh traffic (120s access TTL ⇒ frequent refresh) is not throttled — verified by a refresh-loop test
- [ ] Login rate-limit state survives the relevant scope and is covered by tests

## Depends on
none

## Estimate
M

### `M` · `backend` — Build email verification flow (tokenized, expiring, hashed)

## Context
`email_verified` is added by the credentials migration but no verification flow exists. Add an `auth_email_tokens` table (or reuse the `oauth_handoff_tokens` pattern, `20251120121307`) storing a **hash** of a single-use token + expiry + user_id + kind. Add `POST /auth/local/verify/request` and `POST /auth/local/verify/confirm` merged into `oauth::public_router` (`routes/mod.rs:105`). Delivery uses the existing Loops integration (env-gated, no-op without a key; template IDs repointed per CUTOUT §8a). On confirm set `email_verified=true` and emit an audit event.

## Acceptance criteria
- [ ] Request stores a hashed, expiring, single-use token and (if Loops configured) sends an email
- [ ] Confirm validates token+expiry, sets `email_verified=true`, consumes the token (idempotent on already-verified)
- [ ] Expired or reused tokens are rejected
- [ ] Flow degrades gracefully (admin-driven verification) when no email provider is configured; request/confirm emit audit events

## Depends on
Add password + lifecycle columns to users (additive migration)

## Estimate
M

### `M` · `backend` — Build password reset flow (tokenized, expiring, session-revoking)

## Context
No password reset exists. Reuse the email-token table to add `POST /auth/local/reset/request` (always 200 to avoid enumeration) and `POST /auth/local/reset/confirm` that validates the token, sets a new argon2id hash via the password module, then revokes all sessions via `AuthSessionRepository::revoke_all_user_sessions` (`db/auth.rs:225`). Rate-limit the request endpoint. Emit audit events.

## Acceptance criteria
- [ ] Reset request returns 200 regardless of whether the email exists
- [ ] Confirm validates token+expiry, sets a new argon2id hash, revokes all existing sessions; old password no longer authenticates
- [ ] Reset endpoints are covered by the auth rate limiter
- [ ] Reset confirm emits an audit event

## Depends on
Add argon2id hashing module and credential repository methods; Build email verification flow (tokenized, expiring, hashed); Add rate limiting to /auth/local/login, /tokens/refresh, and OAuth callback

## Estimate
M

### `M` · `backend` — Handle OAuth/local email collision with an explicit account-link flow

## Context
OAuth identity (`auth/handoff.rs:441`) keys on `provider_user_id` and mints a new user (`Uuid::new_v4`) when no `oauth_account` matches, while `upsert_user` keys on id — so an OAuth login whose email already belongs to a local user would create a SECOND row (and trip the `users.email` UNIQUE constraint). In `upsert_identity`, if `fetch_user_by_email` returns an existing user with no `oauth_account` for this provider, **link** by attaching the `oauth_account` to the existing user_id rather than creating a new one (PRD §7.2: link, not silent merge). Require the provider's `email_verified` before linking (account-takeover guard).

## Acceptance criteria
- [ ] OAuth login with an email matching an existing local user links instead of creating a duplicate
- [ ] `users.email` UNIQUE is never violated by the OAuth path
- [ ] Linking only proceeds when the provider email is verified; linking is audited and the profile lists both providers/local
- [ ] Tests cover local-then-OAuth and OAuth-then-second-provider collision cases

## Depends on
Replace plaintext env login with per-user argon2id verification (keep env bootstrap)

## Estimate
M

### `S` · `security` — Verify and harden provider-token-at-rest encryption

## Context
Contrary to the PRD's framing, provider tokens ARE already encrypted at rest: `oauth_token_validator.rs` persists AES-256-GCM ciphertext into `oauth_accounts.encrypted_provider_tokens` (migration 20260226000000) via `jwt.rs encrypt_provider_tokens/decrypt_provider_tokens` (`jwt.rs:256-302`), keyed by `derive_key()` off `VIBEKANBAN_REMOTE_JWT_SECRET`. `tokens.rs:157` only migrates legacy refresh-claim blobs lazily.

This issue: (a) test round-trip + tamper-rejection and that the stored column is ciphertext; (b) audit every write path (`handoff.rs upsert_identity`, `oauth_accounts.rs:198`) to confirm tokens are always encrypted and never logged; (c) record the **keying decision** — see the dedicated-encryption-key decision; recommend moving off the JWT secret so JWT rotation doesn't orphan tokens.

## Acceptance criteria
- [ ] Tests assert encrypt→decrypt round-trips and a single-bit ciphertext mutation fails
- [ ] Audit confirms no path logs/stores decrypted provider tokens; legacy `provider_tokens_blob` claim migrated to DB-only
- [ ] Persisted column asserted to be ciphertext (not decodable plaintext JSON)
- [ ] Keying decision documented (and migration if a dedicated key is chosen); finding recorded that PRD §7 encryption was already satisfied

## Depends on
none

## Estimate
S

### `S` · `db` — Extend member_role enum to owner/admin/member/guest

## Context
The Postgres `member_role` enum is only `('admin','member')` (`20251001000000_shared_tasks_activity.sql:33`) and `MemberRole` in `crates/api-types/src/organization_member.rs:12` mirrors it. PRD §3 needs `owner` (billing/key/delete-org) and `guest` (propose-only). Add an additive migration using `ALTER TYPE member_role ADD VALUE IF NOT EXISTS 'owner'`/`'guest'` — isolate `ADD VALUE` from other DDL (it can't be used in the same transaction). Extend the ts-rs enum, thread `owner ⊇ admin ⊇ member ⊇ guest` through `assert_admin`/route authz. Backfill org creators to `owner` in a follow-up data step.

## Acceptance criteria
- [ ] Enum + ts-rs `MemberRole` include owner and guest; `remote:generate-types` regenerated
- [ ] Authz helpers treat owner as a superset of admin; guest is recognized but grants no admin capability
- [ ] Existing admin/member rows unaffected; migration handles `ADD VALUE` transaction constraints
- [ ] Owner-only capability (org Anthropic key, delete org) enforceable by a single role check for Phase 3

## Depends on
none

## Estimate
S

### `L` · `frontend` — Build auth-lifecycle frontend (register, verify, reset, lockout, account-link)

## Context
`packages/remote-web/src/pages/LoginPage.tsx` only does env-secret login + OAuth buttons; no register/verify/reset UI and no lockout/rate-limit messaging. Build password-credential lifecycle screens consuming the new endpoints, reusing the web-core auth hooks (`shared/hooks/auth/useAuthMutations.ts`, `useAuth.ts`) and `@vibe/ui` primitives. Scope to remote-web — local desktop mode has no app-user auth (DISCOVERY §2.3). Wire reset/verify deep-link routes in TanStack Router to match the email link URLs.

## Acceptance criteria
- [ ] Users can register with email+password, see a verification-pending state, and complete verification via the emailed link
- [ ] Forgot-password and reset-with-token flows work end-to-end
- [ ] Lockout (423) and rate-limit (429) render distinct, non-enumerating messages
- [ ] Email-collision renders an explicit link-account prompt; mutations live in web-core hooks; `pnpm run check`/`lint` pass

## Depends on
Build password reset flow (tokenized, expiring, session-revoking); Add account lockout after N failed login attempts; Handle OAuth/local email collision with an explicit account-link flow

## Estimate
L

### `M` · `testing` — Auth security test matrix: hashing, lockout, rate-limit, reset, reuse, collision

## Context
PRD §7.3 demands verified success criteria: 0 plaintext credentials at rest, rate-limited login, passing lockout/reset/verify E2E. Add integration tests in `crates/remote` using injectable clocks/config for determinism.

## Acceptance criteria
- [ ] Asserts no plaintext password-compare path remains for hashed users (argon2id present)
- [ ] Proves 429 on login flood and 423/lockout after threshold with auto-clear
- [ ] Proves reset revokes all sessions (`db/auth.rs:225`) and the old password fails
- [ ] Covers verify-token expiry/reuse rejection, OAuth email-collision link, and preserved refresh-reuse detection (`TokenReuseDetected`, `db/auth.rs:138`)

## Depends on
Add account lockout after N failed login attempts; Add rate limiting to /auth/local/login, /tokens/refresh, and OAuth callback; Build password reset flow (tokenized, expiring, session-revoking); Handle OAuth/local email collision with an explicit account-link flow

## Estimate
M


## M3 · PM-assistant

### `L` · `db` — Create remote Agent entity and model it as an agent org-member

## Context
PRD §4.2/§3 require an Agent entity appearing in the assignee picker as an org member of type `agent`, reusing `issue_assignees`. Add a remote migration for an `agents` table (id, org_id FK, name, executor_profile, base_url NULL, credential_ref NULL, min/max_complexity_tier, availability, concurrency_limit, active_sessions, sandbox_profile NULL, timestamps) and `crates/remote/src/db/agents.rs` (`find_available_for_tier`/`claim`/`release`).

**Decision (default): synthetic agent-as-user** — give each Agent a synthetic users row + `organization_member` row with the `agent` role (requires the role enum to include `agent`) so `issue_assignees.user_id` and `activity.assignee_user_id` work unchanged, with an `is_system`/agent flag excluding them from human auth flows. `claim` uses an atomic conditional UPDATE (`active_sessions < concurrency_limit`).

## Acceptance criteria
- [ ] `agents` table + AgentRepository (`find_available_for_tier`/`claim`/`release`) created additively
- [ ] An agent is representable as an assignee so `issue_assignees` references it with no join-schema change; ts-rs Agent generated
- [ ] `claim` uses an atomic conditional UPDATE (race test passes)
- [ ] member_role includes `agent`; agents are firewalled from password/OAuth/login paths

## Depends on
Extend member_role enum to owner/admin/member/guest

## Estimate
L

### `M` · `security` — Build org-level encrypted Anthropic API key store

## Context
No Anthropic key storage exists. Add a migration for `organization_ai_keys` (org_id PK/FK, `encrypted_api_key`, `key_added_by`, `key_last_validated TIMESTAMPTZ NULL`, `key_status` enum {valid,invalid,unvalidated}, timestamps) and a repository. Encrypt reusing the AES-256-GCM helper, **keyed off a dedicated `SERVER_ENCRYPTION_KEY`** (see decision), not the JWT secret. Owner/admin-gated set/rotate/clear routes that never return plaintext (masked suffix + status only).

Per §8.2 enforce Console API key shape (`sk-ant-api03-*`) and reject subscription/OAuth tokens — no "Connect Anthropic account" path. Clearing the key disables the assistant (banner) without deleting org data.

## Acceptance criteria
- [ ] Key stored only as AES-256-GCM ciphertext; set/rotate/clear restricted to owner/admin and record `key_added_by`
- [ ] GET never returns plaintext — only masked form + `key_status` + `key_last_validated`
- [ ] Keys not matching `sk-ant-api03-` are rejected; no subscription-OAuth code path or UI affordance
- [ ] Encryption keyed off the dedicated server key (decision honored)

## Depends on
Extend member_role enum to owner/admin/member/guest; Verify and harden provider-token-at-rest encryption

## Estimate
M

### `M` · `backend` — Build Anthropic Messages API client with key validation

## Context
No Anthropic client exists. Add a module (e.g. `crates/remote/src/pm_assistant/anthropic.rs`) wrapping reqwest (rustls already present) to call `POST https://api.anthropic.com/v1/messages` with the org's decrypted key, `anthropic-version` header, and a **configurable** model id. Provide `validate_key()` (a cheap minimal call updating `key_status`/`key_last_validated`, run on set/rotate) and a blocking/streaming `message()`. Map 401/429/timeout to typed errors for graceful degradation (§8.3). The key must never be logged.

## Acceptance criteria
- [ ] `validate_key` issues a minimal Messages request and distinguishes valid/invalid/rate-limited, updating `key_status` + `key_last_validated`
- [ ] `message()` sends prompts and returns structured responses; auth/rate-limit/timeout are typed
- [ ] No request/response log path includes the API key
- [ ] Unit tests use a mocked HTTP layer (no live Anthropic calls in CI); model id is config-driven

## Depends on
Build org-level encrypted Anthropic API key store

## Estimate
M

### `L` · `backend` — Implement PM-assistant decompose + tier-suggest with §6.1 validation

## Context
Build assistant capabilities on the Messages client: (a) `decompose()` turns a vague issue into tier-appropriate subtasks carrying the §6.1 required fields; (b) `tier_suggest()` returns `complexity_tier` with `tier_source='assistant'` + `tier_confidence` (Phase 1 owns the column). Decomposition output MUST pass the per-tier §6.1 validation or be rejected back to the assistant. Proposed subtasks are DRAFTS requiring human confirm before entering the board (§8.3) — no silent ticket creation. Tier suggestions are always human-overridable and the override is recorded. Org-scoped service with structured tool-call output validated server-side.

## Acceptance criteria
- [ ] Decompose returns drafts each satisfying §6.1 required fields for their tier, or is rejected with the missing-field checklist
- [ ] tier-suggest sets `tier_source='assistant'` + confidence and is always human-overridable; overrides persisted/audited
- [ ] No assistant-proposed ticket enters the board without explicit human confirmation
- [ ] Assistant degrades to manual decomposition/tiering when the org key is invalid/rate-limited (§8.3)

## Depends on
Build Anthropic Messages API client with key validation; Build per-tier required-field validation gate for ticket start

## Estimate
L

### `L` · `backend` — Wire PM-assistant orchestration over the org-scoped MCP task API

## Context
The MCP task server (`crates/mcp/`) is an HTTP client over the VK API exposing org/project/issue/assignee/tag tools (`tools/mod.rs`) and resolves org/project scope from context (`resolve_organization_id`, `tools/mod.rs:267`). Implement the `orchestrate` capability ("what's ready/unassigned", "which agent fits") as assistant tool-use over these tools, scoped strictly to the caller's org. Add read tools for unassigned/ready issues and agent availability/tier from the agents table (`find_available_for_tier`), without expanding the write surface beyond draft creation. Enforce org scoping server-side; route writes through audited API paths only.

## Acceptance criteria
- [ ] Orchestrate answers ready/unassigned/agent-fit queries via org-scoped MCP tools
- [ ] All assistant tool calls are org-scoped; cross-org access is rejected (test)
- [ ] Agent-fit uses `Agent.find_available_for_tier` and respects tier ceilings
- [ ] No assistant path mutates the board outside the draft-confirm/audited flow; assistant actor carries an org-scoped identity, not an unscoped service token

## Depends on
Implement PM-assistant decompose + tier-suggest with §6.1 validation; Create remote Agent entity and model it as an agent org-member

## Estimate
L

### `M` · `backend` — Add PM-assistant and agent actor audit-timeline logging

## Context
PRD §8.1/§8.4/§11 require every assistant and agent action in the timeline. Audit infra exists (`crates/remote/src/audit/mod.rs`) but `AuditAction` only covers Auth/Member (`audit/mod.rs:6-18`). The `activity` table is project-scoped/partitioned (`project_id NOT NULL`).

**Decision (default): add a separate org-level `audit_log` table** (id, org_id FK, actor_kind {human,agent,assistant}, actor_id, event_type, payload JSONB, created_at) rather than relax the partitioned activity table. Extend `AuditAction` with assistant/agent variants (AssistantDecompose/TierSuggest/Orchestrate, AgentAssigned/Claimed/Released) and emit them. Org key never in any payload.

## Acceptance criteria
- [ ] Every assistant board-affecting action emits an audit event before/with the action
- [ ] Audit records distinguish human/agent/assistant actors uniformly; agent assign/claim/release logged with the agent actor id
- [ ] Org-scoped events with no project are representable (org-level audit path)
- [ ] Org Anthropic key never appears in audit payloads

## Depends on
Wire PM-assistant orchestration over the org-scoped MCP task API; Build org-level encrypted Anthropic API key store

## Estimate
M

### `L` · `frontend` — Build PM-assistant chat UI with draft-confirm and degraded states

## Context
No assistant UI exists. Build an org-scoped chat panel under `packages/web-core/src/features/` that drives decompose/tier/orchestrate, renders proposed subtasks as DRAFT cards requiring explicit human confirm before the board (§8.3), shows tier suggestions as overridable, and renders a degraded banner when the org has no valid Anthropic key (§7.2/§8.3, manual flows still usable). Stream Messages responses through a **server-side SSE proxy** so the org key stays server-side (see decision). Reuse `@vibe/ui` and existing query patterns.

## Acceptance criteria
- [ ] Chat lets a user request decomposition/tiering/orchestration scoped to the active org
- [ ] Proposed subtasks appear as drafts requiring explicit confirm-to-create (no one-click-to-board)
- [ ] Tier suggestions are clearly overridable from the UI
- [ ] Missing/invalid key shows the disabled banner and disables assistant actions while manual flows remain; `pnpm run check`/`lint` pass

## Depends on
Wire PM-assistant orchestration over the org-scoped MCP task API

## Estimate
L

### `M` · `frontend` — Add agent picker and complexity-tier UI to the issue surface

## Context
Agents must appear in the assignee picker as `agent` members (§4.2, reusing `issue_assignees`) and issues need a tier control. Extend the assignee picker to list Agent members with availability/max-tier badges, and add a `complexity_tier` selector on the issue detail (basic/low/medium/hard/ultra) reflecting `tier_source` (manual/assistant) + confidence. Add an owner/admin org-settings screen to enter/rotate/validate the Anthropic key, showing only masked value + status + `key_last_validated`. Keep human vs agent assignees visually distinct. Hide the tier selector behind a flag if the Phase-1 field isn't merged.

## Acceptance criteria
- [ ] Agents render in the picker as a distinct member type with availability + max-tier indicators
- [ ] Issue detail exposes a `complexity_tier` selector showing source and confidence
- [ ] Assigning an agent uses the existing `issue_assignees` API unchanged
- [ ] Owner/admin key settings set/rotate/validate without ever displaying the key; non-admins blocked; `pnpm run check`/`lint` pass

## Depends on
Create remote Agent entity and model it as an agent org-member; Build Anthropic Messages API client with key validation

## Estimate
M

### `M` · `testing` — PM-assistant test suite: key validation, audit guarantee, decomposition validity, key-never-logged

## Context
PRD §8.4 success criteria: the assistant never writes to the board without an audit entry; the org key is never logged or exposed; decomposition always passes §6.1 (or is rejected). Anthropic calls mocked in CI (zero-egress posture).

## Acceptance criteria
- [ ] Mocked-endpoint tests cover valid/invalid/rate-limited key validation
- [ ] Proves no assistant board write occurs without a corresponding audit event
- [ ] Asserts decomposition output passes §6.1 validation or is rejected back to the model
- [ ] Greps assistant logs/audit/API responses to confirm the org key never appears; the no-valid-key path disables the assistant while manual flows work

## Depends on
Wire PM-assistant orchestration over the org-scoped MCP task API; Add PM-assistant and agent actor audit-timeline logging

## Estimate
M


## M4 · GitHub PR↔ticket automation

### `M` · `db` — Add system_category to project_statuses for a deterministic state machine

## Context
Remote issue status is free-form rows (`project_statuses`, `20260112000000_remote-projects.sql:30`) referenced by `issues.status_id` (:62) with no fixed category — so the §9.3 transitions have no canonical target and name-based lookup is string-fragile. **Decision (default): add a status_category column.** Add an additive migration adding `system_category TEXT CHECK (… IN ('backlog','todo','ready_for_development','in_progress','in_review','ready_to_merge','done','cancelled','needs_attention'))`, plus a seeding/backfill routine (on project creation + retroactively) ensuring one row per category. Webhook transitions resolve `status_id` by `(project_id, system_category)`. Custom statuses preserved (additive only).

## Acceptance criteria
- [ ] Migration adds `system_category` with a CHECK, defaulting existing rows to NULL
- [ ] Seeding/backfill guarantees every project has resolvable rows for ready_for_development, in_review, ready_to_merge, done, cancelled, needs_attention
- [ ] A helper resolves `(project_id, system_category) → status_id` and errors explicitly (never silently no-ops) when missing
- [ ] Custom user statuses preserved; `remote:prepare-db` + `remote:check` pass

## Depends on
none

## Estimate
M

### `S` · `db` — Extend pull_requests with review_state, head/base branches, auto_moved_at

## Context
Remote `pull_requests` (`20260112000000_remote-projects.sql:266`) has url/number/status/merged_at/merge_commit_sha/target_branch_name/issue_id/workspace_id and a `pull_request_issues` join (`20260316000000`). It lacks the §4.5 review-automation fields. Add an additive migration adding `review_state TEXT NULL CHECK (… IN ('awaiting_review','changes_requested','approved','merged'))`, `auto_moved_at TIMESTAMPTZ NULL`, `head_branch TEXT NULL`, `base_branch TEXT NULL`. Update the PullRequest repository + api-types and regenerate remote types.

**Decision (default): review_state is stored** (written on each transition) per §4.5, with the reconciliation poller as the drift guard.

## Acceptance criteria
- [ ] Migration adds the four nullable columns; existing rows backfill to NULL without breaking Electric sync
- [ ] PullRequest repository reads/writes the new fields
- [ ] api-types/remote-types regenerated; `remote:generate-types:check` clean
- [ ] Existing pull_request Electric shapes still load

## Depends on
none

## Estimate
S

### `S` · `db` — Add github_webhook_deliveries idempotency ledger keyed on X-GitHub-Delivery

## Context
The webhook handler (`crates/remote/src/routes/github_app.rs:609`) verifies signature but drops `X-GitHub-Delivery` and has no dedupe — §9.4/§11 require idempotent, replay-safe processing. Add a migration creating `github_webhook_deliveries (delivery_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TIMESTAMPTZ DEFAULT now(), processed_at TIMESTAMPTZ NULL, result TEXT NULL)` plus a repo method (`db/github_app.rs`) for insert-if-absent (`ON CONFLICT DO NOTHING` returning whether new), transaction-friendly so it runs inside the handler tx.

## Acceptance criteria
- [ ] Inserting the same `delivery_id` twice returns "already seen" on the second call
- [ ] Records `event_type` and `received_at` for audit even for unhandled events
- [ ] Repo method is transaction-friendly
- [ ] Missing/empty `X-GitHub-Delivery` handled gracefully (logged, never panics)

## Depends on
none

## Estimate
S

### `S` · `db` — Add ready_for_development and needs_attention to local TaskStatus enum

## Context
Local `TaskStatus` (`crates/db/src/models/task.rs:14`) is `Todo/InProgress/InReview/Done/Cancelled` — no `ready_for_development` or `needs_attention` (the §9.3 target + §5.3/§10 escalation states). Add an additive SQLite migration expanding the task_status domain and extend the Rust enum with `ReadyForDevelopment` and `NeedsAttention` (serde/strum lowercase-with-underscore renames matching the stored representation exactly). Audit frontend consumers (`shared/types.ts`) and add board columns. Keep upstream variants intact.

## Acceptance criteria
- [ ] `TaskStatus` gains `ReadyForDevelopment` + `NeedsAttention` with matching DB CHECK/domain
- [ ] Additive migration applies cleanly; `prepare-db` succeeds
- [ ] `generate-types` regenerates `shared/types.ts`; `pnpm run check` passes
- [ ] Existing tasks with legacy statuses unaffected

## Depends on
none

## Estimate
S

### `M` · `backend` — Connect Projects to GitHub repos via existing github_app_installations

## Context
GitHub App installs are per-org (`github_app_installations`; repos synced with `review_enabled`, `github_app.rs:343`) but there's no Project↔repo binding; §9.1 requires each Project to connect to one or more validated repos with a re-auth flow. Add an additive migration `project_github_repos (project_id, installation_id, github_repo_id, repo_full_name, default_base_branch, created_at)` with a unique `(project_id, github_repo_id)`, plus admin-gated endpoints to list installation repos (`service.rs:190`) and attach/detach. The webhook linker resolves the target project via this binding. A GET status endpoint reports connected/suspended/needs-reauth (`suspended_at`, :840) and links to a fresh install URL (:124).

## Acceptance criteria
- [ ] Migration adds `project_github_repos` with the unique constraint
- [ ] Admin-gated endpoints attach/detach repos and report connection health (connected/suspended/expired → needs_reauth + install URL)
- [ ] Webhook handlers resolve project from `(installation_id, github_repo_id)`
- [ ] Attaching a repo outside the org's installation is rejected; required scopes (contents, PRs, checks, webhooks) documented and checked

## Depends on
none

## Estimate
M

### `M` · `backend` — Auto-link PRs to tickets via branch convention and PR-body backlink

## Context
§9.2 requires PRs on a ticket's worktree branch to auto-populate `pull_request_issues`. The join exists (`20260316000000`) but is only filled from the legacy `issue_id` column; nothing parses webhook PR payloads. Build a linker that, on `pull_request` events, derives the issue from (a) the head branch matching the **Tasca** branch convention `<prefix>/<issue-simple-id>/…` (NOT `icemint/…` — see branch-prefix decision) and (b) a PR-body backlink token, resolves via `simple_id` within the installation's org/project, and upserts a `pull_requests` row + `pull_request_issues` join (`ON CONFLICT` no-op). Reuse `get_pr_details` (`github_app/service.rs:420`) for head/base refs. Support manual link/unlink endpoints (org-membership enforced).

## Acceptance criteria
- [ ] On `pull_request.opened`, a PR whose head branch matches the convention links to the correct issue; a `pull_requests` row is upserted with head/base_branch
- [ ] PR-body backlink parsed as a fallback link source; multiple issues per PR all link
- [ ] Manual link/unlink endpoints exist and enforce org membership; linking is idempotent
- [ ] An unresolvable branch/PR is recorded and logged, never silently dropped

## Depends on
Extend pull_requests with review_state, head/base branches, auto_moved_at; Connect Projects to GitHub repos via existing github_app_installations

## Estimate
M

### `M` · `backend` — Parse and dispatch pull_request_review and non-opened pull_request webhook events

## Context
`handle_webhook` (`github_app.rs:653`) matches only installation/pull_request/issue_comment and silently OKs everything else (:658); `handle_pull_request_event` (:939) returns early for any action != `opened` (:946) and only fires the (severed) R2 review. Add a `"pull_request_review"` arm and a handler extracting action/`review.state` (approved|changes_requested|commented)/PR number/repo/installation (mirroring :950-975), and extend the pull_request handler for `ready_for_review`, `converted_to_draft`, `closed` (merged true/false), `reopened`, reading `draft`/`merged`. Route each into the state machine via the linked-issue resolver. Keep fully decoupled from R2/PrReviewService.

## Acceptance criteria
- [ ] `handle_webhook` dispatches `pull_request_review` and non-opened `pull_request` actions; signature check still gates the new arm (:626)
- [ ] `changes_requested` is routed to the state machine; non-required `commented` reviews are logged/acked 200 without transition
- [ ] Opened-non-draft → review-start; draft does not; closed+merged → merged; closed+unmerged → todo/cancelled
- [ ] No call path reaches the R2 review worker; unit tests feed captured fixtures and assert the handlers are invoked

## Depends on
Implement PR-event → ticket-status state machine (event-sourced on aggregate PR state)

## Estimate
M

### `L` · `backend` — Implement PR-event → ticket-status state machine (event-sourced on aggregate PR state)

## Context
Extend the name-based workflow machine (`crates/remote/src/db/issues.rs:523`, `IssueWorkflowSignal{ReviewStarted,WorkMerged}`) into the full §9.3 table, resolving targets via the **`(project_id, system_category)` mapper** (not by name). Map: PR opened non-draft → in_review/awaiting_review; changes_requested → ready_for_development/changes_requested + re-notify; approved → approved (optionally ready_to_merge); merged → done/merged + close worktree; closed-unmerged → todo/cancelled. Set `review_state` + `auto_moved_at` on each transition. Decisions MUST be a pure function of **aggregate** PR state across all linked PRs (any changes_requested → ready_for_development; all merged → done) so out-of-order webhooks converge (§9.4). Generalize the existing all-merged aggregate (:534); short-circuit when already at target (:552). Resolve linked issues from `(repo, pr_number)` via the `pull_request_issues` join. Every transition writes an activity-timeline entry attributed to the github-app actor.

## Acceptance criteria
- [ ] changes_requested on any linked PR → ready_for_development + `review_state=changes_requested`, `auto_moved_at=now`, re-notify
- [ ] Replaying an event is a no-op (already-at-target short-circuit)
- [ ] Merge-before-review converges to the merged terminal state (aggregate, order-independent)
- [ ] Targets resolved via system_category, not name; every transition is audited; transitions complete <5s p95 in the test harness

## Depends on
Add system_category to project_statuses for a deterministic state machine; Extend pull_requests with review_state, head/base branches, auto_moved_at; Auto-link PRs to tickets via branch convention and PR-body backlink

## Estimate
L

### `S` · `backend` — Wire delivery-id idempotency + audit into the webhook handler

## Context
`handle_webhook` (`github_app.rs:609`) processes every delivery with no dedupe. After signature verification (:626) and before dispatch (:653), read `X-GitHub-Delivery`, insert into `github_webhook_deliveries` (`ON CONFLICT DO NOTHING`); if it already existed and was processed, ack 200 and skip. Mark `processed_at`/`result` only **after** side effects commit (so a mid-processing crash retry isn't swallowed). Satisfies §9.4 (idempotent) + §11 (no silent drops: even ignored events recorded).

## Acceptance criteria
- [ ] Replaying an identical `delivery_id` is a no-op returning 200 (duplicate-webhook test)
- [ ] Every received delivery is recorded with `event_type`/`received_at` even when unhandled
- [ ] Signature-failed requests still rejected 401 and not recorded as processed
- [ ] `processed_at` set only after side effects commit

## Depends on
Add github_webhook_deliveries idempotency ledger keyed on X-GitHub-Delivery

## Estimate
S

### `M` · `backend` — Handle force-push / branch-deleted → stale PR link + needs_attention

## Context
§9.4 requires: force-push / branch deleted → mark PR link stale, ticket → `needs_attention` (never silently left in_review). The webhook ignores `pull_request` synchronize and `delete` events. On `synchronize` record the new head sha; on a `delete` matching a linked PR head branch (or PR closed with deleted head), mark the `pull_request_issues` link stale and signal the ticket to `needs_attention` (resolved via the system_category mapper) with an audit entry. Reuse the linked-issue resolver.

## Acceptance criteria
- [ ] Deleting the PR head branch flags the link stale and moves the ticket off in_review to needs_attention
- [ ] A force-push updates the recorded head sha without spuriously changing ticket status
- [ ] The action is audited

## Depends on
Implement PR-event → ticket-status state machine (event-sourced on aggregate PR state)

## Estimate
M

### `L` · `backend` — Build remote PR-state reconciliation poller driving ticket status

## Context
`PrMonitorService` (`crates/services/src/services/pr_monitor.rs`) is local/SQLite-only, generic over the local ContainerService, polls every 60s (:68) but only flips Merged→archive (:148-163) and exposes merge status only (`get_pr_status`). §9.4 needs a periodic poll to catch missed/duplicated webhooks including reviews.

**Decision (default): author a remote-native poller** (not generalize the local trait). Spawn it on `crates/remote` startup at a configurable interval (default 60s); list open `pull_requests` rows, fetch live state via the installation token (`get_pr_details` + a new reviews/state call), and feed the SAME idempotent state machine so poll and webhook converge.

## Acceptance criteria
- [ ] A reconciliation task runs on remote startup at a configurable interval
- [ ] Each open PR's live state is applied idempotently (no double transitions vs the webhook path), proven by a drop-the-webhook test
- [ ] A missed-webhook review (changes_requested) reaches ready_for_development within one cycle
- [ ] A force-pushed/deleted branch marks the link stale → needs_attention; one bad PR doesn't stall the sweep (logged, loop continues, paginated/backed-off)

## Depends on
Implement PR-event → ticket-status state machine (event-sourced on aggregate PR state); Handle force-push / branch-deleted → stale PR link + needs_attention

## Estimate
L

### `M` · `security` — Gate review-comment re-dispatch behind per-project toggle, off for external-touch tickets

## Context
§9.3 allows changes_requested to optionally re-dispatch to the agent with review comments injected as a follow-up prompt, but §10 mandates this is OFF by default and FORCE-disabled for tickets with external/guest comments (prompt-injection containment). Add a per-project `review_redispatch_enabled BOOLEAN DEFAULT FALSE` (additive). In the changes_requested arm, only enqueue a follow-up (reuse container.rs's follow-up spawn) when the toggle is on AND the ticket has zero external/guest-authored comments. Review text is injected as quoted **untrusted** content, never a trusted instruction. The follow-up must run under the supervised/sandbox path from M5, not the permissive default.

## Acceptance criteria
- [ ] Per-project toggle exists, defaults false
- [ ] Re-dispatch fires only when toggle is on and the ticket has zero external/guest comments
- [ ] Review-comment text injected as quoted untrusted content; a ticket with any external comment never auto-re-dispatches
- [ ] The dispatch-vs-skip decision is audited; follow-up runs under the supervised executor

## Depends on
Implement PR-event → ticket-status state machine (event-sourced on aggregate PR state); Gate execution behind internal trust tier (guest = propose-only)

## Estimate
M

### `L` · `testing` — Integration-test the webhook state machine for idempotency and out-of-order delivery

## Context
§9.5/§11 require validated idempotent, order-independent transitions and zero orphaned tickets. Build a harness posting signed fixtures (correct HMAC via `verify_webhook_signature`) through `handle_webhook` against an ephemeral Postgres: opened/changes_requested/approved/merged/closed plus duplicate and out-of-order replays.

## Acceptance criteria
- [ ] Fixtures cover opened, changes_requested, approved, merged, closed-unmerged, duplicate, out-of-order
- [ ] Duplicate deliveries produce exactly one transition (idempotency)
- [ ] Merge-before-review yields the correct merged final state; multi-PR aggregate (all merged → done, any changes_requested → ready_for_development)
- [ ] Deleted/force-pushed branch leaves the ticket needs_attention, never silently in_review; tests run in remote test

## Depends on
Wire delivery-id idempotency + audit into the webhook handler; Parse and dispatch pull_request_review and non-opened pull_request webhook events; Build remote PR-state reconciliation poller driving ticket status

## Estimate
L

### `M` · `devops` — Verification harness: §13.7 remote boot + R2-severed webhook path

## Context
§13.7 (remote standalone boot: Postgres `wal_level=logical` + Electric + JWT + 1 OAuth provider + reverse proxy) and §13.8 (parent_workspace_id + branch-per-attempt semantics post-refactor 20251216142123) are prerequisites for trusting the webhook→status path. The PR review path also assumed the now-severed R2/cloud worker (`review_worker_base_url`, `r2()` at `github_app.rs:867/1098`) — verify the handler boots and processes events with R2/review-worker UNSET so CUTOUT severance didn't break webhooks. Document the minimal env subset and a smoke test posting a signed webhook to a booted remote.

## Acceptance criteria
- [ ] Minimal remote stack boots and accepts a signed `pull_request_review` webhook with R2/review-worker UNSET
- [ ] The webhook→status transition is observed end-to-end against real Postgres
- [ ] parent_workspace_id + branch-per-attempt semantics confirmed and documented for the linkage path
- [ ] Smoke test runnable in CI or documented as a manual gate

## Depends on
Implement PR-event → ticket-status state machine (event-sourced on aggregate PR state)

## Estimate
M


## M5 · External clients + sandbox

### `M` · `security` — Flip permissive executor defaults to Supervised for untrusted paths

## Context
`crates/executors/default_profiles.json` ships EVERY agent fully permissive (CLAUDE_CODE `dangerously_skip_permissions`, AMP `dangerously_allow_all`, GEMINI/QWEN_CODE `yolo`, CODEX `sandbox=danger-full-access`, OPENCODE `auto_approve`, CURSOR `force`, COPILOT `allow_all_tools`, DROID `skip-permissions-unsafe`). The lever exists: `PermissionPolicy::{Auto,Supervised,Plan}` (`model_selector.rs:53`; `claude.rs:316-344` maps Supervised → approvals=true). Resolve the effective `PermissionPolicy` at dispatch from the ticket's trust tier: trusted/internal keeps the profile default; any external-touch ticket forces Supervised, overriding the permissive flags before spawn. Add a guard so an external-touch dispatch can never resolve to `Auto`. Do NOT change trusted-internal behavior.

## Acceptance criteria
- [ ] Dispatch computes effective `PermissionPolicy` from trust tier; external-touch → Supervised across all 9 executors
- [ ] Permissive raw flags are overridden to approval-required for external-touch runs
- [ ] An external-touch run can never resolve to `Auto` (compile- or runtime-guarded with a test); a test asserts no permissive flag in any supervised variant
- [ ] Internal/trusted runs retain existing behavior; the resolved policy per run is recorded for audit

## Depends on
none

## Estimate
M

### `L` · `security` — Gate execution behind internal trust tier (guest = propose-only)

## Context
§10 core: untrusted input must never directly trigger execution — a guest-authored ticket needs an internal human to promote it to agent-ready first. The local server has ZERO authz on `create_and_start_workspace` (`crates/server/src/routes/workspaces/create.rs:212`), and trust tiers live in remote while execution initiates locally with no app-user identity (DISCOVERY §2.3).

**Decision (default): the gate is authoritative remote-side.** Add a ticket `trust_state TEXT CHECK IN ('proposed','agent_ready')` defaulting `proposed` when the ticket or any comment is guest-authored, require a member+ promotion (audited) to set `agent_ready`, and refuse to issue any dispatch/sync to the local executor for a ticket below `agent_ready` — the single chokepoint upstream of `container.rs:1156` Session::create. Tie to `can_trigger_execution(role)` (guest → false).

## Acceptance criteria
- [ ] Guest-authored tickets default to a non-executable trust state; promotion requires member+ and is audited
- [ ] No dispatch reaches Session::create for a ticket below agent_ready (authz test across guest/member/admin)
- [ ] Untrusted input cannot directly trigger execution end-to-end; attempting start on an un-promoted external ticket returns a clear 403
- [ ] Backward compat: tickets with no external authorship default to executable

## Depends on
Add ready_for_development and needs_attention to local TaskStatus enum; Extend member_role enum to owner/admin/member/guest

## Estimate
L

### `M` · `security` — Add sandbox_profile to the Agent entity and resolve it at run start

## Context
PRD §4.2/§10 put a `sandbox_profile TEXT NULL` on the Agent entity to select isolation per run. The Agent entity is a Phase-1 build; add `sandbox_profile` there (or a follow-up additive migration) and a resolver that, at the `container.rs:1079` start seam, picks the profile based on the agent AND whether the ticket is external-touch — forcing a sandbox profile for external-touch regardless of the agent default. This issue defines the field + resolution policy; the runner is separate.

## Acceptance criteria
- [ ] `agents.sandbox_profile` exists and is readable by the assignment/start path
- [ ] External-touch runs always resolve to a sandbox profile even if the agent default is none
- [ ] The resolution decision is logged for audit
- [ ] Internal trusted runs with no sandbox_profile behave exactly as today

## Depends on
Gate execution behind internal trust tier (guest = propose-only)

## Estimate
M

### `XL` · `infra` — Container-per-run executor backend for external-touch runs (macOS)

## Context
§10 + §13.1 locked decision: any external-touch execution must run in an ephemeral container/jail with no host FS, no secrets, egress-restricted; Ollama/GPU stays on host reached over the network. Today executors spawn as host child processes (`claude.rs:650 group_spawn_no_window`). Build a sandboxed run backend provisioning the worktree + toolchain INSIDE a Linux container, routing the executor's spawn through it when `sandbox_profile` is set, gated at the `container.rs:1079` seam.

**Decision (default): Docker Desktop runner for v1**; leave the Apple `container` backend and egress-allowlist tuning to follow-ups (see macOS-sandbox decision/spike). Verify env injection (`CmdOverrides.env`), log streaming, and worktree paths work inside the container (`claude.rs:630-650`, `acp/harness.rs`).

## Acceptance criteria
- [ ] An external-touch run has no host-FS access outside its mounted worktree and no host secrets
- [ ] The sandboxed agent reaches the host Ollama endpoint but not arbitrary egress
- [ ] Run lifecycle is ephemeral (container removed on completion); worktree result captured before teardown
- [ ] Falls back by refusing to run (never run-unsandboxed) when the runtime is unavailable

## Depends on
Add sandbox_profile to the Agent entity and resolve it at run start; Flip permissive executor defaults to Supervised for untrusted paths

## Estimate
XL

### `M` · `security` — Add prompt-injection containment for external-authored ticket/comment content

## Context
§10 requires prompt-injection containment for any external-authored content reaching an agent. Beyond the §9.3 re-dispatch toggle, external ticket descriptions and comments can feed the initial prompt. Add a sanitization/quoting layer at prompt assembly wrapping all guest-authored text in clearly delimited untrusted-content blocks with a preamble instructing the model to treat it as data, never instructions; neutralize known injection markers; tag the attempt for audit when external content is present. Applies to both initial and follow-up prompts. Defense-in-depth alongside the sandbox, not a guarantee.

## Acceptance criteria
- [ ] External-authored text is wrapped as untrusted content at prompt-assembly for both initial and follow-up runs
- [ ] A run consuming external content is tagged in the audit timeline
- [ ] Known injection patterns are neutralized/quoted, not executed; internal-only tickets unaffected
- [ ] Unit tests cover the changes_requested follow-up and the initial-prompt external-description cases

## Depends on
Gate review-comment re-dispatch behind per-project toggle, off for external-touch tickets

## Estimate
M

### `M` · `testing` — Security authz tests: guest cannot reach an executor; external-touch never runs unsandboxed

## Context
§10 success criteria are test-defined: no code path lets a guest-authored ticket reach an executor without internal promotion, and no external-touch run executes outside a sandbox profile. Add authz tests over the promotion gate and run-resolution.

## Acceptance criteria
- [ ] Guest-authored ticket → start returns 403 until an internal member promotes it
- [ ] External-touch run resolves to a sandbox_profile + supervised executor, never the permissive DEFAULT (negative test included)
- [ ] Review-comment re-dispatch is suppressed when external comments exist (prompt-injection)
- [ ] Tests run in CI as part of `cargo test --workspace`

## Depends on
Gate execution behind internal trust tier (guest = propose-only); Add sandbox_profile to the Agent entity and resolve it at run start; Flip permissive executor defaults to Supervised for untrusted paths

## Estimate
M


## Key decisions to resolve (blocking design questions)

> Surfaced by the review; several correct errors in the PRD (e.g. the assignment seam is `start_workspace` ~`:1079`/`Session::create :1156`, not `container.rs:1063`).

1. ****
   - _Recommended:_ Insert the engine call just before Session::create at container.rs:1156 inside start_workspace (:1079), resolving the Task/tier via workspace.task_id. Have engineering confirm the post-20251216142123 refactor hasn't moved it again before implementation.
   - _Blocks:_ Wire the assignment engine into start_workspace before Session::create; Spike: resolve Task/tier linkage; all M1 routing wiring.

2. ****
   - _Recommended:_ Synthetic users row per Agent + member row flagged agent/is_system, so issue_assignees.user_id and activity.assignee_user_id reuse verbatim; firewall synthetic users from all auth/login and member-list UIs. Avoids a parallel agent_assignees schema.
   - _Blocks:_ Create Agent entity (local + remote); Model agents as org members; every assignee/audit join; the engine's unassigned predicate.

3. ****
   - _Recommended:_ Extend the Postgres member_role enum with owner, guest, and agent via isolated ALTER TYPE ADD VALUE (not a created_by column). Backfill org creators to owner in a follow-up data step.
   - _Blocks:_ Extend member_role enum; remote Agent entity; org Anthropic key owner-gating; guest propose-only gate.

4. ****
   - _Recommended:_ Use a dedicated SERVER_ENCRYPTION_KEY for the org Anthropic key rather than the JWT-secret-derived key (jwt.rs derive_key), so rotating VIBEKANBAN_REMOTE_JWT_SECRET does not orphan stored keys. Document the existing JWT-secret coupling for provider tokens loudly.
   - _Blocks:_ Build org-level encrypted Anthropic API key store; Verify and harden provider-token-at-rest encryption.

5. ****
   - _Recommended:_ Add a system_category column to project_statuses with a CHECK over the canonical set and a per-project seeding/backfill, then resolve transition targets by (project_id, system_category). Do NOT keep the string-fragile name lookup ('In review','Done').
   - _Blocks:_ The entire §9.3 PR→ticket state machine; needs_attention/ready_for_development transitions; force-push handling.

6. ****
   - _Recommended:_ Confirm the canonical prefix is `tasca/<issue-simple-id>/…` (the repo rebranded from icemint; USER_AGENT is TascaRemote/1.0). Encode it once, shared by the agent's PR-open path and the webhook parser, before building the linker.
   - _Blocks:_ Auto-link PRs to tickets via branch convention; the webhook linked-issue resolver.

7. ****
   - _Recommended:_ Store review_state + auto_moved_at on each transition per §4.5, with the reconciliation poller as the drift guard, but compute every transition decision from aggregate PR state so writes stay order-independent.
   - _Blocks:_ Extend pull_requests with review_state; PR→ticket state machine; reconciliation poller.

8. ****
   - _Recommended:_ Create a separate org-level audit_log table (actor_kind human/agent/assistant, org_id, payload JSONB) rather than adding nullable org_id and relaxing the partitioned, project-scoped activity table — safer for Electric sync shapes.
   - _Blocks:_ PM-assistant + agent audit logging; the assistant no-silent-write guarantee.

9. ****
   - _Recommended:_ DB-backed durable counters for the per-account login path (aligns with persisted locked_until and survives restart/replicas); in-memory tower_governor per-IP for OAuth/refresh. Trust only the configured proxy's X-Forwarded-For.
   - _Blocks:_ Add rate limiting to auth endpoints; account lockout; auth security test matrix.

10. ****
   - _Recommended:_ Reuse a JSONB metadata blob (mirroring remote issues' extension_metadata) by adding an equivalent JSON field to local tasks, rather than typed columns — simpler fill path for the PM-assistant. Revisit if validation rigor demands typing.
   - _Blocks:_ Build per-tier required-field validation gate; PM-assistant decompose/tier-suggest (§6.1).

11. ****
   - _Recommended:_ Make the gate authoritative remote-side (trust_state on the ticket, member+ promotion, can_trigger_execution); the local dispatch must be unreachable except via promoted/sync'd tickets. Treat local-only desktop mode as fully trusted in v1 since it has no app-user identity.
   - _Blocks:_ Gate execution behind internal trust tier; review-comment re-dispatch; sandbox resolution; M5 authz tests.

12. ****
   - _Recommended:_ Confirm §8.2 still holds: accept only sk-ant-api03-* Console keys, reject anything resembling subscription/OAuth tokens, add no 'Connect Anthropic account' affordance, and validate keys with a cheap minimal Messages call.
   - _Blocks:_ Org Anthropic key store; Anthropic Messages client; PM-assistant chat UI key settings.

13. ****
   - _Recommended:_ Target Docker Desktop for the v1 container-per-run backend (worktree mount + network policy reaching host Ollama), and spike Apple `container` + GPU-on-host reachability separately on the M1 Max before committing. Refuse-to-run if the runtime is absent — never run unsandboxed.
   - _Blocks:_ Container-per-run executor backend; sandbox_profile resolution; external-touch security guarantees.

14. ****
   - _Recommended:_ Stream Messages API responses through a server-side SSE proxy so the org key never leaves the server and the zero-client-egress posture holds; do not hand the browser a scoped Anthropic token.
   - _Blocks:_ Build PM-assistant chat UI; orchestration; key-never-exposed test guarantee.

15. ****
   - _Recommended:_ Use a github_webhook_deliveries ledger keyed on X-GitHub-Delivery (ON CONFLICT DO NOTHING; mark processed_at only after side effects commit). Also confirm the GitHub App handler boots with R2/review-worker UNSET so CUTOUT severance hasn't broken webhook processing, and that the install grants checks + pull_request_review subscriptions.
   - _Blocks:_ Webhook idempotency wiring; pull_request_review dispatch; §13.7 verification harness.

16. ****
   - _Recommended:_ Keep all deploy/publish work out of scope now: no GHCR/Coolify webhook, no NPM_TOKEN, no Apple/Windows signing (npx update-notifier and Tauri updater already removed per CUTOUT §3). Stand up a separate M-deploy milestone only when the §12 HeyLinks target and its secrets are confirmed.
   - _Blocks:_ Any release pipeline; version-convergence rollout; CHANGELOG seeding cadence.
