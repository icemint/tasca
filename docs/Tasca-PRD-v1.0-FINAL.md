# Tasca — Agent Workforce Platform · Finalized PRD (v1.0)

**Status:** Approved for build. **Owner:** Dennis (EltexSoft / Icemint Labs).
**Pivot decision:** Tasca pivots from a project-delivery/kanban tool into an **AI agent workforce platform**. Existing kanban UI is dropped. The tier/capability routing engine, agent-as-member concept, cloud coordination layer, and OAuth infra carry over.
**Adapter sequencing (FINAL):** **Shortcut → GitHub Issues → Linear.** **Jira is out of scope** (no adapter, no A2A connector). Rationale: most of our projects run in Shortcut and we have direct Shortcut team support for API questions, which offsets the API's relative freshness — making Shortcut both the highest-value and now lowest-risk first adapter.

---

## 1. TL;DR
Build a platform where a user assembles a **standing roster of named AI "employees"** — e.g. *Elvis* (Claude), *Mona* (OpenAI), *Qwen-1* (self-hosted local) — each with a **persistent native identity** inside the tools the team already uses (**Shortcut first**, then GitHub Issues, then Linear), each governed by **Tasca's tier/capability routing engine** that decides which agent is fit for which task. Agents receive assigned tickets natively, work code in isolated git worktrees, open PRs, respond to review/webhooks, and run across multiple projects 24/7.

**The three defensible wedges** (everything else is commoditized in 2026):
1. **Persistent named multi-vendor agent identities**, deployed natively per platform (not ephemeral runners, not single-vendor).
2. **Capability/tier routing** — task complexity matched to agent capability profiles.
3. **The roster / "team of employees" framing** — agents as a managed standing workforce with profiles, multi-project assignment, and continuous operation.

**Execution layer:** **Fork Emdash's service layer** (Apache-2.0) into a headless module rather than rebuild — saves ~3–4 focused-team months. **Internal agent-identity primitive:** modeled on Devin's service-user RBAC. **Concede orchestration/worktrees/PR-creation** to GitHub Agent HQ, Cursor, Jules, Devin — do not compete there.

---

## 2. Product Vision & Positioning
Tasca is the control plane for an **AI development workforce**. You hire a team of AI developers, give each a name and a real identity inside the tools you already use, and Tasca's routing engine assigns the right agent to the right task — across every project, around the clock.

**Positioning line:** *"Your AI dev team — named, capable, and working in the tools you already use."*

**Commoditized (table stakes — do NOT differentiate on):** multi-agent orchestration, git-worktree isolation, pulling tickets from PM tools, PR creation, CI/CD monitoring, multi-CLI agent support.

**Wedge (the product):** native multi-vendor identities × capability/tier routing × roster/employee model.

---

## 3. The Three Core Advantages (specified)

### 3.1 Persistent Named Identities — per-platform native (never fake humans)
**Decision (final):** use **native agent / service-user APIs** as the only identity path. No fake-human email/password accounts — they break branch protection (self-approval), have no audit trail, and violate platform ToS.

**Internal primitive (Devin-modeled):** Each Tasca agent = a *service user* with its own credential, an RBAC role, a capability profile, and a delegation/attribution field (analogous to Devin's `create_as_user_id` + `ImpersonateOrgSessions`). This maps onto every platform's native model below.

### 3.2 Capability/Tier Routing (the crown jewel)
Carried over and extended. Tiers: basic / low / medium / hard / ultra.
- **Tier estimation:** heuristics (length, reasoning verbs, file/dir scope, labels) + a lightweight LLM classifier (tier + confidence) + optional repo code-health signals; kept off the hot path / budgeted.
- **Capability profiles:** per agent — vendor/model, context window, language/framework specialties, max tier, measured success-rate history, cost/latency, concurrency limit.
- **Atomic claim:** exactly-one-task-to-one-agent via conditional write (CAS on status/version); losers re-query. No double-claim.
- **Concurrency:** per-agent + per-project limits; same-repo serialization to avoid worktree collisions.
- **Escalation / mis-tier recovery:** failure counter → breaker (default N=2) → re-tier (escalate to higher-capability agent) or human review; mis-tier signals retrain the classifier.

### 3.3 Roster / "Team of Employees" Model
- **Capability profile per named agent**, plus identity bindings (its Shortcut agent user, GitHub App, Linear app user).
- **Multi-project / multi-tool:** one agent deployed into many repos and tools at once; routing pulls work from all its identities.
- **24/7 operation:** cloud coordination layer schedules, monitors health, restarts crashed sessions, escalates after N failures.
- **Monitoring:** roster dashboard — per-agent state (idle/working/awaiting-input/failed), current task, queue, throughput, success rate, cost. Framed as *"your team,"* not a job queue.

---

## 4. Execution Layer — Fork Emdash (decision-grade)
**Recommendation: FORK Emdash's service layer (`src/main/core/`) into a headless execution module. Do not embed the Electron app; do not reimplement from scratch.**

- **License:** Apache-2.0 with patent grant (relicensed from MIT in PR #1691, release v0.4.48). Permits forking/embedding; passes IP review.
- **Already built:** worktree isolation **with pooling** (reserve worktrees), PTY-based spawning of **27 CLI agents** (Claude Code, Codex, OpenCode, Gemini, Amp, Cursor CLI, Copilot CLI, Qwen, …), **SSH/SFTP remote execution** (run on the user's GPU box), OS-keychain creds, ticket intake, diff review, PR creation, CI/CD checks, tmux persistence, MCP sync, SQLite/Drizzle storage.
- **De-Electron work (the fork's cost):** replace `safeStorage` creds with a headless secrets backend; supply a non-Electron PTY transport (WebSocket/stdio); rebuild `better-sqlite3` for Node ABI; headless bootstrap replacing the Electron window. Env flags already exist to neuter subsystems (`EMDASH_DISABLE_PTY`, `EMDASH_DISABLE_NATIVE_DB`, `EMDASH_DB_FILE`).
- **No headless mode upstream** → this is a fork, not a library integration; pin the fork to control rebase cost.
- **Adopt from Operator! (pattern, not dependency):** sync external tickets → local work-order cache; agent lifecycle (Created→Running→Awaiting Input→Completed/Failed); autonomous vs paired modes (FEAT/FIX autonomous; INV/SPIKE human-in-loop).

---

## 5. Per-Platform Adapter Specs (Shortcut → GitHub → Linear)

Each adapter implements: (1) identity provisioning, (2) assignment intake, (3) status reporting, (4) PR/code linkage.

### 5.1 Shortcut — FIRST (highest value: most projects here; direct team support offsets freshness)
- **Identity:** Agent user via the **Shortcut Agent API** (admins "Configure Agent Users" in Integrations). Agent appears as a real teammate, assignable to Stories and @mentionable in comments.
- **Assignment trigger:** Story assigned to the agent (`owner_ids`) or agent @mentioned in a comment.
- **Intake:** Shortcut **outgoing webhook** (HMAC-SHA-256 `Payload-Signature`); events carry `actions[]` (e.g. `owner_ids` add, `workflow_state_id` change, Story id).
- **Status back:** comment + Story state update posted as the agent; PR link attached.
- **Auth:** `Shortcut-Token` header (user- and workspace-specific; dies if creating user is removed — provision under a stable service identity).
- **Open confirmations (use Shortcut team contact):** (a) programmatic agent-user creation surface, (b) the exact "assigned to agent" webhook event payload, (c) the Agent API SDK timeline. **Confirm these in Stage 1 kickoff before building intake.**

### 5.2 GitHub Issues — SECOND (the code home + PR loop)
- **Identity:** Per-customer **GitHub App** (`[bot]` identity in commit/PR history; branch protection works — App can't self-approve). Tasca provisions/manages the App install per customer/repo. (Note: there is no public API to register a custom first-class agent inside Agent HQ — the App path is the supported identity.)
- **Assignment trigger:** Issue assigned to the App / PR review requested / @mention.
- **Intake:** App webhooks — `issues` (assigned), `pull_request`, `pull_request_review`, `check_run`.
- **Status back:** PR commits + comments under the App identity; checks feed the escalation breaker.

### 5.3 Linear — THIRD (most mature agent model; free seats)
- **Identity:** `actor=app` agent (dedicated app user, own token/scopes); **non-billable seat**. Installed by workspace admin.
- **Assignment semantics:** assigning an issue to an agent sets it as **delegate** (human stays accountable assignee). Opt-in scopes `app:assignable` + `app:mentionable`; `actor=app` cannot request `admin`.
- **Intake:** `AgentSessionEvent` webhook (`created`) with `promptContext`; **must ack ≤5s and emit first activity ≤10s**. Session states: working / awaiting input / complete / errored. Activities: thought/action/tool-call/prompt/response/error.
- **Status back:** Agent Activities on the session; optional `issueRepositorySuggestions` for repo selection.
- **Note:** Developer Preview (APIs may change).

### ~~Jira~~ — OUT OF SCOPE
No Jira adapter, no `rovo:agentConnector`. Removed from roadmap per owner decision.

| Platform | Native identity | Trigger | Intake | Status back | Order |
|---|---|---|---|---|---|
| **Shortcut** | Agent user (Agent API) | Assign Story `owner_ids` / @mention | Outgoing webhook (HMAC-SHA-256) | Comment + state update as agent | **1** |
| **GitHub** | Per-customer GitHub App (`[bot]`) | Issue assigned / PR review / @mention | App webhooks (issues, PR, review, check_run) | PR commits/comments as App | **2** |
| **Linear** | `actor=app` agent (non-billable) | Delegate issue / @mention | `AgentSessionEvent` (5s ack / 10s activity) | Agent Activities on session | **3** |

---

## 6. PM-Assistant Layer (advisory)
A Claude-run PM-assistant above the roster: triage/decompose incoming tickets, estimate tiers, *suggest* routing, propose cross-project assignments and surface conflicts, generate human-readable standups. **Advisory only** — the deterministic routing engine + atomic claim remain the binding source of truth, so a PM-assistant error can never irreversibly mis-assign work.

---

## 7. Carry-over vs Dropped
**Carries over:** tier/capability routing engine (extend with profiles + atomic claim + escalation); agent-as-member concept (now native identities); deployed cloud coordination layer (now the 24/7 scheduler/monitor); OAuth infra (per-platform installs); host-side execution model (aligns with Emdash SSH execution).
**Dropped:** the kanban/project-delivery UI; Vibe-Kanban board UX as primary surface; any bespoke execution engine (superseded by Emdash fork); **Jira**.

---

## 8. Phased Delivery Stages

**Stage 1 — Foundation + Shortcut + Claude (prove the wedge).**
Fork Emdash → headless execution module (de-Electron spike). Internal Devin-modeled agent-identity primitive (service-user + RBAC + capability profile + delegation). **Shortcut adapter** (confirm Agent API surface with their team first): agent-user provisioning, assignment webhook intake, status-back. **One vendor:** Claude-backed agent ("Elvis"). Tier routing v1 (heuristics + LLM classifier + atomic claim + concurrency limits). End-to-end: Story assigned to Elvis → worktree → Claude Code → PR → status back to Shortcut.

**Stage 2 — GitHub adapter + PR/review loop + escalation.**
Per-customer GitHub App provisioning; issue-assignment + PR/review/check webhooks; PR flow under App identity. Escalation/mis-tier breaker. Multi-agent within one project with same-repo serialization.

**Stage 3 — Linear adapter + multi-vendor + BYO-local.**
Linear `actor=app` agent (session webhooks, delegate intake, activities). Add OpenAI-backed agents; add BYO-local models (Qwen3-Coder, Gemma) via Ollama/LM Studio/MLX through Emdash's CLI registry. Capability profiles use measured success-rate history.

**Stage 4 — Roster management + multi-project + 24/7 ops.**
Roster CRUD + capability-profile editor; deploy one agent across many repos/tools; cloud scheduler/health-monitor/restart; roster monitoring dashboard.

**Stage 5 — PM-assistant.**
Claude PM-assistant: triage/decomposition/distribution/reporting (advisory).

---

## 9. Recommendations
1. **Start Stage 1 with Shortcut + Claude.** Confirm the Agent API surface (agent-user creation + "assigned to agent" webhook) with the Shortcut team in kickoff. **Advance benchmark:** a Story assigned to Elvis reliably yields a reviewed PR under the agent's native identity, end-to-end, in one project.
2. **Fork Emdash now; timebox the de-Electron spike to ~2–3 weeks.** If it overruns, fall back to reimplementing only worktree+PTY. **Change-approach threshold:** if upstream churn makes rebasing cost more than the saved reimplementation, vendor a pinned fork and stop tracking upstream.
3. **Model the agent primitive on Devin's service-user RBAC now** — future-proofs attribution/impersonation; maps onto Shortcut agent users, GitHub Apps, Linear delegation.
4. **Treat routing as the crown jewel.** Invest in classifier + profiles + escalation early. **Benchmark:** track mis-tier and escalation rate; target falling mis-tier as the classifier learns.
5. **Adapter order is final: Shortcut → GitHub → Linear. No Jira.**
6. **Market on the roster/employee wedge, not orchestration.**

---

## 10. Open Questions for the Owner
- **Shortcut Agent API specifics** — confirm with their team: agent-user creation endpoint, the assignment webhook event, SDK availability/timeline. (Mitigated by your direct access — resolve in Stage 1 kickoff.)
- **GitHub identity at scale** — comfortable provisioning/managing a GitHub App per customer (keys, webhook fan-out)? Pursue GitHub Partner Program for first-class slots later?
- **Billing model** — agents are free seats on Linear but consume vendor API/credits + GitHub Actions minutes. Price per-agent/month, per-task, or pass-through usage?
- **Human-of-record** — Linear forces a human assignee behind each delegated agent. Require every Tasca agent to map to a human owner for accountability across all tools?
- **Local-model execution location** — BYO local models on the customer's own host/GPU over SSH (Emdash pattern) or Tasca-hosted? Data-residency implications.
- **ToS/automation legal review** — per platform (GitHub PAT/billing nuances, Shortcut, Linear DPA).

---

## 11. Risks & Caveats
- **Shortcut-first risk:** leading with the least-documented agent API — **mitigated by direct Shortcut team access**; confirm the surface before building intake.
- **Platform moving targets:** Linear agents in Developer Preview; Shortcut Agent API new. Confirm contracts; expect change.
- **Late to orchestration:** GitHub Agent HQ, Devin, Jules, Cursor shipped — do not drift into competing there.
- **GitHub registration limits:** confined to the GitHub App path (no public Agent-HQ custom-agent registration).
- **Emdash fork maintenance:** no upstream headless mode → rebase cost; pin the fork. Confirm `schema.ts` DDL + LICENSE before committing.
- **Routing correctness:** weak classifier mis-assigns; mitigate with escalation breaker, human-in-loop for high tiers, retraining.
- **Cost/runaway agents:** 24/7 multi-vendor agents burn credits/CI minutes; per-agent cost ceilings + budget alerts.
- **Security:** native identities + repo write + remote SSH widen attack surface; least-privilege scopes, branch protection (no self-approval), credential isolation, audit logging.
- **Forward-looking (not yet available, do not assume):** Emdash "Cloud," GitHub Agent-HQ partner expansion, Shortcut "full SDK coming soon," Devin Personal Access Tokens.
