# Tasca

**Your AI dev team — named, capable, and working in the tools you already use.**

Tasca is the control plane for an AI development workforce. You assemble a standing
roster of named AI "employees" — *Elvis* on Claude, *Mona* on OpenAI, *Qwen-1* on a
self-hosted local model — give each a real, native identity inside the tools your team
already runs, and let Tasca's routing engine assign the right agent to the right task,
across every project, around the clock.

Agents aren't ephemeral runners or a single-vendor add-on. They're a managed team: each
has a name, a capability profile, a work history, and its own first-class presence in
Shortcut, GitHub, and Linear. You manage them like people — pause, reassign, escalate,
review — with full visibility into what each one is doing and why it was routed there.

> **Status: build in progress, pre-release.** The engine is built and tested — routing,
> agent-identity, multi-tenancy + RBAC, coordination, credential isolation, agent-runner —
> and **GitHub is a complete end-to-end adapter** (Stages 1–2 shipped). Wave 3 is adding the
> remaining PRD surfaces (PM-assistant, Shortcut/Linear parity, usage/billing, audit/keys);
> Wave 4 the deepest isolation + design-surface completion. The source of truth for *what
> we're building* is [`docs/Tasca-PRD-v1.0-FINAL.md`](docs/Tasca-PRD-v1.0-FINAL.md); for *how
> it looks and feels*, [`docs/Tasca-Design-Brief-v1.0.md`](docs/Tasca-Design-Brief-v1.0.md);
> for *what's done vs. remaining*, the
> [completion gap analysis](docs/PRD-Completion-Gap-Analysis.md).

---

## Why Tasca

By 2026, most of the agent stack is commoditized — multi-agent orchestration,
git-worktree isolation, pulling tickets from a PM tool, opening PRs, watching CI. Those
are table stakes. We don't compete there, and we don't differentiate on them.

The product is three things that aren't commoditized:

1. **Persistent named multi-vendor identities.** Each agent is a real teammate inside
   each platform — a Shortcut agent user, a GitHub App, a Linear `actor=app` — not a
   fake-human login and not one vendor's bot. Assignable, @mentionable, attributable,
   audit-clean, and compatible with branch protection (an agent can't self-approve).

2. **Capability / tier routing.** Every task is estimated to a tier
   (`basic → low → medium → hard → ultra`) and matched to an agent whose capability
   profile can handle it. Exactly one agent claims each task; mis-tiers trip an
   escalation breaker that re-routes to a higher-capability agent or a human.

3. **The roster model.** Agents are employees, not jobs — profiles, multi-project
   deployment, measured success-rate history, and 24/7 operation, presented as *your
   team* rather than a queue.

**Positioning:** infrastructure for serious engineering teams. Confident, technical,
calm. The credibility is in the restraint.

---

## How it works

The end-to-end loop, proven first on Shortcut + Claude:

```
  Story assigned to "Elvis" in Shortcut
            │  (outgoing webhook, HMAC-SHA-256)
            ▼
  Tasca routing engine
    estimate tier  ──►  match capability profile  ──►  atomic claim (one agent)
            │
            ▼
  Execution (isolated git worktree)
    Claude Code runs  ──►  commits  ──►  opens PR  ──►  CI checks
            │
            ▼
  Status back to Shortcut as the agent
    comment + state update + PR link
            │
            ▼
  Escalation if it fails (breaker → re-tier or human review)
```

The routing decision is always **inspectable** — estimated tier, eligible agents, and
the match are shown for every task. The deterministic engine and atomic claim are the
binding source of truth; the optional PM-assistant only ever *advises*, so it can never
irreversibly mis-assign work.

---

## Architecture

| Layer | What it does | Approach |
|---|---|---|
| **Routing engine** | Tier estimation, capability matching, atomic single-claim, concurrency limits, escalation/mis-tier recovery | Built in-house — the crown jewel. Heuristics + a lightweight LLM tier classifier, kept off the hot path. |
| **Agent identity** | A service user per agent: own credential, RBAC role, capability profile, delegation/attribution | Modeled on Devin's service-user RBAC; maps onto each platform's native identity. |
| **Execution** | Worktree isolation + pooling, PTY-spawned CLI agents, remote SSH execution, PR/CI loop | Fork of [Emdash](https://github.com/) (Apache-2.0) into a headless module — not a rebuild. |
| **Coordination** | 24/7 scheduling, health monitoring, crash restart, cross-project assignment | The cloud control plane. |
| **PM-assistant** | Triage, decomposition, routing suggestions, standups | Advisory only (Claude-run). The engine remains authoritative. |

**Multi-vendor by construction:** Claude, OpenAI, and BYO-local models (Qwen3-Coder,
Gemma via Ollama / LM Studio / MLX) are all first-class. No vendor's branding dominates
the product.

---

## Platforms

Adapter sequencing is final. Each adapter implements identity provisioning, assignment
intake, status reporting, and PR/code linkage.

| Platform | Native identity | Assignment trigger | Order |
|---|---|---|---|
| **Shortcut** | Agent user (Agent API) | Story `owner_ids` / @mention | **1** |
| **GitHub Issues** | Per-customer GitHub App (`[bot]`) | Issue assigned / PR review / @mention | **2** |
| **Linear** | `actor=app` agent (non-billable seat) | Delegated issue / @mention | **3** |

Shortcut leads — it's where most of our projects live, and direct Shortcut team support
offsets the API's relative freshness. **Jira is out of scope** (no adapter, no connector).

---

## Roadmap

Delivery is staged so each stage stands on its own and proves the next.

- **Stage 1 — Foundation + Shortcut + Claude.** Headless Emdash fork (de-Electron spike),
  the Devin-modeled identity primitive, the Shortcut adapter, one Claude-backed agent, and
  tier routing v1. *Wedge proof: a Story assigned to Elvis reliably yields a reviewed PR
  under the agent's native identity, end-to-end, in one project.*
- **Stage 2 — GitHub adapter + PR/review loop + escalation.** Per-customer GitHub App,
  issue/PR/review/check webhooks, the escalation breaker, multi-agent-per-project with
  same-repo serialization.
- **Stage 3 — Linear + multi-vendor + BYO-local.** Linear `actor=app` sessions, OpenAI
  agents, self-hosted local models, capability profiles driven by measured success rate.
- **Stage 4 — Roster management + multi-project + 24/7 ops.** Roster CRUD, capability-profile
  editor, deploy one agent across many repos/tools, cloud scheduler/monitor, the monitoring
  dashboard.
- **Stage 5 — PM-assistant.** Advisory triage, decomposition, distribution, and reporting.

Stages 1–2 are shipped (GitHub is the reference adapter, end-to-end); Stages 3–5 are in
progress across Waves 3–4. The product, docs, and site represent unshipped work honestly as
such. See the [completion gap analysis](docs/PRD-Completion-Gap-Analysis.md) for the precise
done / partial / not-built state of every surface.

---

## Repository layout

A pnpm + TypeScript monorepo. The control plane is a set of layered packages; the app is an
Astro frontend; deploy is the production topology.

```
packages/
  domain/          Core types (Task, CapabilityProfile, Tier, …)
  routing/         The crown jewel — tier estimation, capability match, atomic claim, breaker
  identity/        Agent-identity primitive — service users, RBAC, profiles, bindings, audit
  coordination/    The control plane — orchestration, org-scoping/RBAC, webhooks, read/write API
  execution/       Headless Emdash fork — worktrees, PTY agent spawning, openPr (vendored submodule)
  agent-runner/    Isolated runner — claim → mint creds → clone → spawn → openPr → revoke
  broker/          Per-task scoped-token mint over a unix socket (master key stays worker-side)
  anthropic-proxy/ Keyless credential-injecting streaming proxy for the agent
  adapters/        Platform adapters — GitHub (reference), Shortcut (intake), Linear (planned)
  db/              Postgres claim repo + dispatch queue
  auth/            Human OAuth login, sessions, CSRF
  contracts/       Webhook/event Zod schemas at the trust boundary
app/               Astro control-plane UI (roster, monitoring, connections, task, agent, …)
deploy/            Production topology — worker, non-root runner, egress allowlist proxy
docs/              PRD, design brief, gap analysis, decision records (ADRs)
```

The design system lives in `design-system/`; the marketing site in `website/`.

---

## Principles

These hold across product, design, and code — non-negotiable:

- **Visibility over magic.** Every routing decision and agent action is inspectable. No
  opaque black box.
- **Control one action away.** Pause, reassign, escalate, intervene — the human is always
  in command.
- **Honest states.** Real empty / loading / error / blocked states everywhere. No fake or
  seeded data, ever.
- **Multi-vendor neutrality.** No vendor's branding dominates the UI.
- **Accessible by construction.** WCAG AA in both themes, verified in CI; status and tier
  never conveyed by color alone.
- **Token-driven only.** No hardcoded colors; primitive → semantic → component layering,
  light + dark.
- **Clean VCS history.** No AI-attribution in any commit, PR, branch, or tag.

---

## Documentation

- [Product Requirements (PRD v1.0)](docs/Tasca-PRD-v1.0-FINAL.md) — the product, the
  wedges, the adapters, the stages, the open questions.
- [Design Brief (v1.0)](docs/Tasca-Design-Brief-v1.0.md) — brand, visual language, every
  app surface and marketing page, accessibility and acceptance criteria.

---

*Tasca is built by Icemint Labs.*
