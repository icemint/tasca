# Tasca — Product Requirements Document
### Agentic project-delivery platform: VK execution core + team layer + capability-aware tier routing + PM-assistant
*Version 0.1 — 2026-06-01. Fork point: BloopAI/vibe-kanban `4deb7eca8` (v0.1.44), hard fork. Clean-room re: Multica (concepts only).*

---

## 1. Vision & thesis

Build a self-hostable, multi-tenant project-delivery platform where humans and AI coding agents work the same board. The differentiator is **deterministic, capability-aware task routing**: every ticket carries a complexity tier; every agent declares the tiers it can handle; the system assigns work an agent *can actually complete*, prompted the way that agent needs. This fixes the failure mode of heavyweight orchestrators (e.g. Multica) that drown local models in coordination round-trips.

**Core bet:** a local ~30B model (Qwen3-Coder on a headless M1 Max) is a reliable teammate for fully-decomposed, low-reasoning tickets, and unreliable on open-ended ones. The product *encodes* that boundary as a first-class tier system + per-tier prompt scaffolding, and escalates the rest to cloud Claude.

**Non-goals (v1):** replacing human code review; autonomous handling of `hard`/`ultra` tickets on local models; being a general Jira/Linear competitor outside agent-driven delivery.

---

## 2. Foundation: what we reuse, build, and cut

### 2.1 Reuse from VK (verified in DISCOVERY.md)
- Kanban board, drag-status, diff viewer, inline comments, browser preview.
- Git worktree isolation; Task→Workspace→Session→ExecutionProcess lifecycle; PR creation/merge.
- Executor engine: `StandardCodingAgentExecutor` trait + `enum_dispatch` over 9 agents (ClaudeCode, Codex, Gemini, QwenCode, Copilot, Cursor, Amp, Opencode, Droid).
- **Ollama wiring (verified working code):** `CmdOverrides.env` merged at `claude.rs:641-642`. Inject `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`; keep `disable_api_key=false`.
- **Remote team layer (self-contained in `crates/remote/`):** Organizations, Projects, Issues (priority/assignees/tags/statuses/relationships), membership + roles, full invitation lifecycle — PostgreSQL, no closed-cloud proxy.
- Remote auth machinery: JWT + sessions + refresh-token rotation (reuse detection) + OAuth PKCE (GitHub/Google).
- MCP task server (programmatic issue CRUD/assignees/tags for agents).
- WebSocket real-time updates (`EventService` + `MsgStore`); GitHub App (webhooks, PR reviews) + GitHub OAuth.

### 2.2 Build fresh (the product)
1. **Multi-user credential layer** — per-user hashed store + lifecycle (§7).
2. **Capability-aware routing** — `complexity_tier`, `Agent` entity, assignment engine (§5).
3. **Per-tier prompt scaffolding** — required ticket fields + prompt templates (§6).
4. **PM-assistant** — org-key Claude for decomposition/tiering/orchestration (§8).
5. **GitHub PR↔ticket linkage + review-driven status automation** (§9).
6. **Execution sandboxing** for untrusted/external runs (§10).

### 2.3 Cut from fork
Telemetry/analytics, BloopAI update-check + auto-update, BloopAI cloud/relay back-connection, private billing crate, QA-repo integrations, all branding. See the separate **CUT-OUT discovery prompt** (delivered alongside this PRD) for the exhaustive list and deletion plan.

---

## 3. Personas & roles

| Persona | Role(s) | Capabilities |
|---|---|---|
| Org Owner | `owner` | Billing/key mgmt, delete org, all admin |
| Admin/Lead | `admin` | Manage members, projects, agents, sprints, set org Anthropic key, promote external proposals |
| Engineer | `member` | Create/assign tickets, review PRs, run agents |
| External Client | `guest` (propose-only) | File/comment on tickets; **cannot trigger execution** (§10) |
| PM-Assistant | system actor (org-scoped) | Decompose, tier-suggest, orchestrate; logged to activity timeline |
| Worker Agent | system actor (assignee) | Pick up tickets ≤ max_tier, execute in worktree, open PR |

---

## 4. Data model deltas (additive migrations only)

### 4.1 `complexity_tier` on Issue/Task
- Migration adds `complexity_tier TEXT NOT NULL DEFAULT 'medium' CHECK (complexity_tier IN ('basic','low','medium','hard','ultra'))` to `tasks` (local) and `issues` (remote).
- Plus `tier_source TEXT DEFAULT 'manual' CHECK (tier_source IN ('manual','assistant','classifier'))` and `tier_confidence REAL NULL`.
- Field added to `crates/db/src/models/task.rs` Task struct and `crates/api-types/src/issue.rs`.

### 4.2 `Agent` entity (new)
```
agents (
  id UUID PK,
  org_id UUID FK,                       -- remote; null for local
  name TEXT,
  executor_profile TEXT,                -- maps to ExecutorConfig (executor+variant+model_id)
  base_url TEXT NULL,                   -- e.g. http://mac.tailnet:11434 (Ollama)
  credential_ref UUID NULL,             -- FK to secret store (cloud agents)
  max_complexity_tier TEXT,             -- highest tier this agent may take
  min_complexity_tier TEXT DEFAULT 'basic',
  availability TEXT DEFAULT 'free' CHECK (availability IN ('free','busy','offline','paused')),
  concurrency_limit INT DEFAULT 1,
  active_sessions INT DEFAULT 0,
  sandbox_profile TEXT NULL,            -- §10
  created_at, updated_at
)
```
- New model `crates/db/src/models/agent.rs` (`find_available_for_tier`, `claim`, `release`); one-line `pub mod agent;`.
- Agent appears in the assignee picker by being modeled as an org member of type `agent` (reuse `issue_assignees`).

### 4.3 Sprints
- v1: `sprint_id UUID NULL` on Issue + a `sprints (id, project_id, name, starts_at, ends_at, state)` table. (Chosen over saved-filter for assignment scoping fidelity.)

### 4.4 PR↔ticket link
- `issue_pull_requests (issue_id, pr_number, repo, state, head_branch, base_branch, created_at)` — many-to-many (one ticket may span PRs; reuses VK's existing `pull_request_issues` remote migration where present).

### 4.5 Review automation state
- On Issue add `review_state TEXT NULL CHECK (review_state IN ('awaiting_review','changes_requested','approved','merged'))` + `auto_moved_at TIMESTAMP NULL`.

---

## 5. Feature: Capability-aware assignment engine

### 5.1 Behavior
On ticket start (or sprint auto-dispatch), select an agent where: `agent.min_tier ≤ issue.complexity_tier ≤ agent.max_tier` AND `availability='free'` AND `active_sessions < concurrency_limit` AND issue is `unassigned` AND not blocked by an open `blocking` relationship AND in the active sprint. Seed the Session with that agent's `ExecutorConfig` (+`base_url`/credential). The HTTP-supplied `executor_config` becomes an explicit **manual override** (backward compatible).

### 5.2 Insertion point
`crates/services/src/services/container.rs:1063`, before `Session::create`. New crate `crates/assignment-engine/` (deps: db, executors, services); single ~1-line call inserted upstream.

### 5.3 Escalation (human-gated v1)
On attempt failure (executor error, validation gate fail, or max-turn exhaustion), the engine does **not** auto-bump tier. It flips the ticket to `needs_attention`, records the failure reason, and surfaces a one-click "escalate to tier+1 / reassign to cloud agent." (Auto-escalation is a v2 flag.)

### 5.4 Edge cases
- **No eligible agent:** ticket stays `todo`, flagged `no_capable_agent`; notify leads. Never silently drop.
- **All capable agents busy:** ticket queued `ready` (FIFO by priority then sort_order); picked up on agent release event.
- **Agent goes offline mid-run** (headless Mac sleeps/network drops): Session marked `interrupted`, worktree preserved, ticket → `needs_attention`; resumable via follow-up, not silent retry.
- **Concurrency race** (two dispatchers claim one agent): `claim` uses an atomic conditional UPDATE (`active_sessions < concurrency_limit`); loser re-queries. Single GPU reality: even with concurrency>1 the Mac serializes inference — document and default `concurrency_limit=1` for local agents.
- **Tier downgrade after start:** in-flight session unaffected; new tier applies to next attempt only.
- **Blocked-by cycle:** detect on relationship create; reject with explicit error (reuse VK `CHECK (issue_id != related_issue_id)` + app-level cycle check).
- **Manual override conflicts with tier ceiling:** allowed but warns ("assigned below/above declared capability") and tags the attempt for audit.

### 5.5 Success criteria
- 100% of started tickets either get a capable agent or a logged `no_capable_agent`/queued state — zero silent no-ops (validated by integration test across all 5 tiers × {free,busy,offline} agent states).
- Assignment decision < 200ms p95 (excludes model inference).
- Backward compat: existing `create_and_start_workspace` calls with explicit `executor_config` behave exactly as upstream when no Agent rows exist.

---

## 6. Feature: Per-tier prompt scaffolding (the IP)

### 6.1 Required ticket fields by tier
Lower tiers demand more decomposition (encode the "no reasoning, just coding" discipline):

| Tier | Required fields before an agent may pick up |
|---|---|
| `basic` | title, exact file(s), explicit IO contract, acceptance test/gate, all edge cases enumerated |
| `low` | + affected modules/relations, constrained tool list |
| `medium` | + design note; reasoning allowed |
| `hard` | + human-authored plan; cloud agent recommended |
| `ultra` | human + cloud only; agent assists, doesn't own |

Validation blocks `start` if required fields for the ticket's tier are absent (with a clear checklist of what's missing). PM-assistant (§8) can fill these.

### 6.2 Prompt templates
Per-tier system-prompt wrappers stored as editable templates; injected via the executor's prompt. Low/basic templates: constrain tool surface, cap turns (`max_turns`), forbid open-ended planning ("implement exactly the spec; do not redesign"). Templates are versioned; per-org override allowed.

### 6.3 Edge cases
- Tier raised after fields filled → previously-satisfied fields retained; only newly-required fields prompted.
- Template references a tool the agent lacks → validation warns at save, not at runtime.

### 6.4 Success criteria
- Measured uplift: on a fixed eval set of 20 `basic`/`low` tickets, scaffolded prompts achieve ≥ target first-attempt pass rate vs unscaffolded baseline (quantify baseline in first sprint; target set after baseline).

---

## 7. Feature: Multi-user auth (build on existing session/OAuth)

### 7.1 Build
- **Per-user credential store:** `users` gains hashed password (argon2id), `email_verified`, `failed_attempts`, `locked_until`. Replaces single plaintext env secret (`local.rs:42-55`).
- **Lifecycle:** email verification, password reset (tokenized, expiring), account lockout (after N failures), optional TOTP MFA (v2).
- **Rate limiting** on `/auth/local/login`, OAuth callback, refresh endpoint (currently NOT FOUND).
- **Provider-token-at-rest encryption** — verify/extend `encrypted_provider_tokens`.
- Reuse as-is: JWT (120s access / 365d refresh), session rotation + reuse detection, OAuth PKCE.

### 7.2 Edge cases
- Refresh-token reuse detected → revoke session family, force re-login (VK already supports `TokenReuseDetected`).
- OAuth email collides with existing local account → link flow, not silent merge.
- Org with no valid Anthropic key → PM-assistant disabled with explicit banner; worker agents on local Ollama still function.

### 7.3 Success criteria
- 0 plaintext credentials at rest; all passwords argon2id. Login rate-limited (verified by test). Lockout + reset + verify flows pass E2E.

---

## 8. Feature: PM-assistant (org-key Claude)

### 8.1 Behavior
Per-org conversational Claude (Messages API, org-level API key — §"credentials"). Capabilities: (a) **decompose** a vague ticket into tier-appropriate subtasks with required §6.1 fields; (b) **suggest complexity tier** (`tier_source='assistant'`, human override wins); (c) **orchestrate** ("what's ready/unassigned," "which agent fits") via the MCP task API, scoped to the org. All assistant actions logged to the activity timeline.

### 8.2 Credentials
- **Org-level shared key** (decided): encrypted, set/rotated by owner/admin only; `key_added_by`, `key_last_validated`. Validated on entry via cheap test call.
- Powers **PM-assistant only** (decided) — NOT worker agents. Worker spend (local Qwen = free; cloud agents = separate per-agent credentials) stays isolated for cost attribution + rate-limit isolation.
- **Compliance note:** subscription OAuth (Pro/Max) is prohibited in third-party tools by Anthropic (policy effective 2026-02-19; enforced 2026-01-09). MUST use Console API keys (`sk-ant-api03-*`), pay-as-you-go, billed to the org. No "Connect Anthropic account" OAuth button is permitted.

### 8.3 Edge cases
- Invalid/expired/rate-limited org key → assistant degrades gracefully, admins notified; manual tiering/decomposition still available.
- Assistant proposes a decomposition → created as drafts requiring human confirm before they enter the board (no silent ticket creation in v1).
- Assistant tier suggestion always overridable; override recorded.

### 8.4 Success criteria
- Assistant never writes to the board without the action appearing in the audit timeline. Key never logged/exposed. Decomposition output always passes §6.1 validation for the assigned tier (or is rejected back to the assistant).

---

## 9. Feature: GitHub integration — PR↔ticket + review-driven automation

### 9.1 Project↔GitHub connection
- Each Project connects to one or more GitHub repos (reuse VK GitHub App install: `github_app_installations`). Required scopes: repo contents, PRs, checks, webhooks.
- Connection stored per project; validated; re-auth flow on token expiry.

### 9.2 PR↔ticket linkage
- Agent (or human) opens a PR on the ticket's worktree branch; PR auto-linked to the ticket via `issue_pull_requests` (branch naming convention `icemint/<issue-simple-id>/...` + PR body backlink). Manual link/unlink also supported.
- Ticket card shows PR state (open/draft/checks/approved/merged).

### 9.3 Review-driven status automation (the requested hooks)
GitHub webhook → server handler → ticket status transitions:

| GitHub event | Condition | Ticket transition |
|---|---|---|
| PR opened (non-draft) | linked to ticket | → `inreview`, `review_state=awaiting_review` |
| `pull_request_review submitted: changes_requested` | | → **`ready_for_development`** (the requested behavior), `review_state=changes_requested`, re-notify assignee/agent |
| review `approved` | all required approvals met | `review_state=approved` (optionally → `ready_to_merge`) |
| PR merged | | → `done`, `review_state=merged`, close worktree |
| PR closed unmerged | | → `todo` (or `cancelled` if ticket cancelled), worktree archived |
| CI checks failed | linked PR | flag card `checks_failing`; if agent-owned + auto-fix enabled, re-queue at same tier (capped) |

- "Ready for development" on `changes_requested` can optionally **re-dispatch to the agent** with the review comments injected as follow-up prompt (toggle per project; default off for external-touch tickets — §10).

### 9.4 Edge cases
- Webhook missed/duplicated → reconcile via periodic PR-state poll (VK `PrMonitorService`) + idempotent transitions keyed on PR state + delivery id.
- Force-push / branch deleted → mark PR link stale, ticket `needs_attention`.
- Multiple PRs per ticket → ticket reflects aggregate (all merged → done; any changes_requested → ready_for_development).
- Review by non-required reviewer → recorded, no auto-transition unless it's `changes_requested` (always actionable).
- Webhook signature invalid → reject (verify GitHub App webhook secret).
- Out-of-order events (merge arrives before review) → state machine is event-sourced on PR status, not on transition order.

### 9.5 Success criteria
- Every linked-PR review event produces the correct ticket transition within 5s p95 of webhook receipt, idempotently (validated by replaying duplicate + out-of-order webhook fixtures).
- Zero orphaned tickets: a merged PR always closes its ticket + worktree; a deleted branch always flags, never silently leaves `inreview`.

---

## 10. Security model (gating for external clients)

VK executors default permissive (`dangerously_skip_permissions`, Codex `danger-full-access`, `yolo`) and run agents as host child processes. External-filed tickets = RCE risk on the headless Mac. Resolutions, layered:

- **Trust tiers (v1):** `guest`/external = **propose-only** (file/comment); execution requires an internal human to promote ticket to `agent-ready`. Untrusted input never directly triggers execution.
- **Sandboxing (v1 for any external-touch execution):** each run in an ephemeral container/jail — no host FS, no secrets, egress-restricted; `sandbox_profile` on Agent. On macOS this likely means moving the runner into a Linux container/VM (open question §13).
- **Permissive defaults flipped** to `Supervised`/approval for any non-trusted path.
- **Prompt-injection containment:** review-comment re-dispatch (§9.3) disabled by default for tickets that have external comments.

Success criteria: no code path lets a `guest`-authored ticket reach an executor without internal promotion (validated by authz test). No agent run for an external-touch ticket executes outside a sandbox profile.

---

## 11. Cross-cutting: edge-case & data-handling principles
- **No fixed assumptions about counts/sizes:** tiers, agents, repos-per-project, PRs-per-ticket all dynamic; iterate live structures (no magic numbers).
- **No silent drops:** every ticket reaches a logged terminal or waiting state; every webhook is acknowledged or reconciled.
- **Idempotency everywhere** external events drive state (webhooks, agent callbacks).
- **All state changes audited** to the activity timeline (human + agent + assistant actors uniformly).
- **Backward compatibility** with upstream VK APIs maintained so cherry-picked fixes still apply.

---

## 12. Phasing

**Phase 0 — Fork hygiene, severance, rebrand & CI/CD (1–2 sprints):** see §15 for the severance catalogue (✅ done). Boot remote/Postgres minimal subset (DB + Electric + one auth provider — verification §13.7); fill Apache-2.0 copyright; add NOTICE (✅ done). **Author fresh CI/CD** (all upstream BloopAI workflows deleted): GitHub Actions pipeline — lint + typecheck + `cargo check --workspace`/remote + `pnpm run check` + test on every PR; build pipeline for binaries/installers; branch protection requiring the CI status check; deploy to own infra (Hetzner + Coolify per the HeyLinks pattern) via GHCR + webhook; provision own secrets (no BloopAI R2/deploy-token refs). Re-author the 3 composite build actions (setup-node, sccache/Rust setup) pointing at upstream sources (mozilla-actions/sccache-action, mlugg/setup-zig) rather than the deleted BloopAI forks.

**Phase 1 — Routing core (2–3 sprints):** `complexity_tier`, `Agent` entity, assignment engine at `container.rs:1063`, Ollama executor profile wiring, per-tier required-field validation. Internal-only, single org.

**Phase 2 — Team + auth (2 sprints):** multi-user credential layer, rate-limit/verify/reset/lockout, sprints, agent-as-assignee.

**Phase 3 — PM-assistant (1–2 sprints):** org-key store, decomposition/tiering/orchestration, audit logging.

**Phase 4 — GitHub automation (2 sprints):** PR↔ticket linkage, webhook → status state machine, review-driven `ready_for_development`, reconciliation poller.

**Phase 5 — External clients + sandbox (2 sprints):** propose-only guest tier, sandboxed execution, permissive-default lockdown. Gate before any external exposure.

---

## 13. Decisions (locked) & verification items

### Locked decisions
1. **Sandbox (macOS-native):** container-per-agent-run on the M1 Max (Docker Desktop or Apple `container`). Each run gets the client repo (worktree) + toolchain provisioned **inside** the container; isolated from the host filesystem, secrets, and other clients' repos. Ollama/GPU stays on host; the container reaches it over the network. Gating for any external-touch execution (Phase 5).
2. **Sprints:** first-class entity (`sprints` table) — required for sprint-scoped assignment pickup.
3. **Concurrency:** per-agent `concurrency_limit` is a **UI-settable** field; default `1` for local agents (single-GPU serialization documented).
4. **Complexity classification:** v1 = manual tier + PM-assistant suggestion (when an org key is present). Dedicated auto-classifier deferred to v2 pending tier-accuracy data.
5. **Escalation:** human-gated in v1 (failed attempt → `needs_attention` + one-click escalate). Auto-tier-bump is a v2 flag.
6. **Fork strategy:** hard fork; cherry-pick security fixes only; no upstream tracking. New code in new crates/packages to minimize edits to inherited files.

### Verification items (no decision; confirm during build)
7. **Remote standalone boot (Phase 0):** verify Postgres (`wal_level=logical`) + ElectricSQL + JWT + ≥1 OAuth provider + reverse proxy boots minimally (`Caddyfile.example` not wired upstream).
8. **Task↔Workspace↔Session / worktree plumbing (Phase 1):** confirm current `parent_workspace_id` + branch-per-attempt (gitflow) semantics after upstream refactor `20251216142123` before wiring tier-based pickup at `container.rs:1063`. Does not affect the client=Project=repo model (§9).
9. **Breaking rebrand constants:** sequenced/completed in Phase 0 (PHASE 4 of SANITIZE) — Tauri id, SPAKE2 (both ends), ProjectDirs. ✅ done.

---

## 15. Phase 0 severance catalogue (from CUTOUT audit, fork @ 4deb7eca8)

**Legend:** DELETE = remove outright · SEVER = cut the connection, keep feature · REPOINT = make configurable/ours, no BloopAI default · KEEP = generic/self-hostable, no egress.

### 15.1 Priority severance — active outbound egress
- **🔴 Review CLI → `api.vibekanban.com`** (`crates/review/src/main.rs:21,50`) — **uploads source to BloopAI by default. Highest sensitivity.** REPOINT (force explicit `REVIEW_API_URL`, fail if unset) or DELETE the binary.
- **Release check → `api.github.com/repos/BloopAI/...`** (`crates/server/src/routes/releases.rs:14`, call site `:105`) — feeds the update banner. DELETE route + banner, or REPOINT to your repo.
- **PostHog** — backend local (`crates/services/.../analytics.rs:56-61`), backend remote (`crates/remote/src/analytics.rs`), build capture (`crates/server/build.rs:10-23`), frontend (`Bootstrap.tsx:30-46`), **hardcoded real key in `docs/docs.json:159-162`**. DELETE/SEVER; the docs key WILL send unless removed.
- **Sentry** — core (`crates/utils/src/sentry.rs`), frontend (`Bootstrap.tsx:20-28`), **hardcoded org `bloop-ai` uploading source maps at build** (`packages/local-web/vite.config.ts:111`). SEVER incl. the vite plugin.
- **OpenTelemetry → Azure** (remote, `crates/remote/src/lib.rs`). DELETE.
- **Google STUN ×2** (`crates/relay-webrtc/src/client.rs:205`, `peer.rs:56`) — third-party, not BloopAI. REPOINT to own STUN/TURN (both sites together).

### 15.2 Update machinery — DELETE (sequence carefully)
- **Tauri updater** (`tauri.conf.json` updater block + `createUpdaterArtifacts`, `tauri-app/Cargo.toml:17`, `main.rs:26,161-163,411-511`) — remove code+dep+config **as one atomic change** (half-removal fails build or errors at runtime). Codesign/notarization is independent — not affected.
- **Frontend update banner** (`useTauriUpdateReady.ts`, `useAppUpdateStore.ts`, `AppBar.tsx`). DELETE, decoupled.
- **npx update notifier → R2** (`npx-cli/src/cli.ts:198-214`, `download.ts:270-275`). DELETE or REPOINT.
- **CI updater/R2 jobs** (`.github/workflows/pre-release.yml`, `publish.yml`) — line refs unverified, re-check before editing. DELETE/REPOINT if publishing.

### 15.3 Already-neutralized (verify, low risk)
- **Private billing crate** (`crates/remote/Cargo.toml:13,17`) — feature-gated AND Dockerfile auto-strips (`:88-94`). Builds clean with default features; DELETE lines for cleanliness only.
- **QA repos** (`crates/services/.../qa_repos.rs:15-18` + `qa-mode` feature) — off by default. DELETE or never enable.

### 15.4 Identity/branding — REPOINT (sequence last)
- Tauri id `ai.bloop.vibe-kanban` (`tauri.conf.json:5`) + Windows AUMID (`windows_notifications.rs:24`) — change together, only after updater is gone.
- ProjectDirs `("ai","bloop")` (`utils/src/lib.rs:53,56`, `assets.rs:25`) — relocates config dir; migrate or accept reset.
- SPAKE2 IDs `vibe-kanban-browser/-server` (`relay-client/src/lib.rs:41-42`) — KEEP or rename **both ends in one commit** or pairing breaks.
- Commit author `noreply@vibekanban.com` (`crates/git/src/lib.rs:215-216,228`), PR self-attribution link (`config/mod.rs:19`), npm name/repo URL, MCP doc links (`default_mcp.json:51,81`), Loops template IDs (docker-compose), env prefixes `VK_*`. REPOINT/DELETE as rebranding.

### 15.5 KEEP (self-hostable, no BloopAI default)
- Relay/signalling stack — env-driven, no baked host (`local-deployment/src/lib.rs:171-187`, `relay-hosts/`). Verify shipped `.env` sets no BloopAI host.
- `RemoteClient` — no baked cloud base. `default_profiles.json`, `Caddyfile.example` — no outbound hosts.
- ⚠️ Review: `default_mcp.json:12` ships `mcp.context7.com` as a live third-party MCP default — decide whether to keep.

### 15.6 Ordered removal & verification
Removal order: (1) pure deletions — PR link, commit email, all telemetry call sites+init then deps, QA, billing lines; (2) update machinery — banner + `/releases`, npx notifier, then Tauri updater atomically + rebuild, then CI; (3) repoint-before-cut — review URL, STUN, Loops; (4) identity last — Tauri id+AUMID, ProjectDirs, SPAKE2. Rebuild + egress-trace after each phase.

Verify-no-egress: grep gates for `bloopai|vibekanban\.com|\.bloop\.ai|repos/BloopAI`, `posthog|sentry|opentelemetry|application-insights|/capture/`, updater strings, `vibe-kanban-private|internal-qa|qa-mode`, `stun:|context7`; `cargo tree` + node-dep gates report clean; runtime `lsof`/`tcpdump` shows zero connections to posthog/sentry/azure/vibekanban/BloopAI/STUN across a full local+remote exercise; optionally run with those domains firewalled and confirm no errors/retries.

---

## 14. Definition of done (v1 / internal-ready)
- A ticket can be tiered, validated for required fields, auto-assigned to a capable agent, executed locally (Qwen via Ollama) or on cloud Claude, produce a PR linked to the ticket, and auto-transition on review — with every step audited and no silent failures across the tier×availability×webhook edge matrix.
