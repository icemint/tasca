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

> **Status: build in progress, pre-release — production deployment for EltexSoft is live.**
> The core engine, agent-detail surface, and Engineering Manager router are built. What works today:
> capability-profile editing (tier range, structured specialties, concurrency limit, cost ceiling),
> per-agent platform credentials sealed at rest, editable agent identity + `agent.md` description,
> task titles surfaced on board cards and in agent recent-work, and EM-as-router (assign to the EM →
> it routes by tier + specialty + load to the least-loaded qualified agent). **GitHub is the reference
> adapter, end-to-end.** Shortcut intake is live; write-back, Linear, usage metering, billing, and the
> per-agent namespace sandbox remain in progress. For the precise done / partial / not-built state of
> every surface, see the [completion gap analysis](docs/PRD-Completion-Gap-Analysis.md). For *what
> we're building*, [`docs/Tasca-PRD-v1.0-FINAL.md`](docs/Tasca-PRD-v1.0-FINAL.md); for *how it looks
> and feels*, [`docs/Tasca-Design-Brief-v1.0.md`](docs/Tasca-Design-Brief-v1.0.md).

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

The end-to-end loop, proven on GitHub (reference adapter):

```
  Issue assigned to the Engineering Manager (EM)
            │  (GitHub webhook, HMAC-SHA-256)
            ▼
  EM requirements gate
    reviews the task → clarifies if vague → approves for routing
            │
            ▼
  Tasca routing engine
    estimate tier  ──►  match capability profile + specialty  ──►  atomic claim (one agent)
    (least-loaded qualified agent wins; both per-agent and per-repo concurrency limits apply)
            │
            ▼
  Execution (isolated git worktree)
    agent's agent.md shapes the run ──►  commits  ──►  opens PR  ──►  CI checks
            │
            ▼
  Status back via the agent's native platform identity
    PR link + state update  (board column derived from platform reality — Tasca never owns issue state)
            │
            ▼
  Escalation if it fails (breaker → needs_attention → operator reviews)
```

The routing decision is always **inspectable** — estimated tier, eligible agents, the
winning match, and the "Assigned by EM" attribution are shown for every task. The
deterministic engine and atomic claim are the binding source of truth; the optional
PM-assistant (planned) will only ever *advise*, so it can never irreversibly mis-assign work.

---

## Architecture

| Layer | What it does | Approach |
|---|---|---|
| **Routing engine** | Tier estimation, capability matching, atomic single-claim, concurrency limits, escalation/mis-tier recovery | Built in-house — the crown jewel. Heuristics + a lightweight LLM tier classifier, kept off the hot path. |
| **Agent identity** | A service user per agent: own credential, RBAC role, capability profile, delegation/attribution | Modeled on Devin's service-user RBAC; maps onto each platform's native identity. |
| **Execution** | Worktree isolation + pooling, PTY-spawned CLI agents, remote SSH execution, PR/CI loop | Fork of [Emdash](https://github.com/generalaction/emdash) (Apache-2.0) into a headless module — not a rebuild. |
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

## What works today

These surfaces are built and running in production:

- **Routing + execution engine** — tier estimation, capability-profile matching, atomic single-claim, per-agent and per-repo concurrency limits, breaker/escalation to `needs_attention`. GitHub is the reference adapter, end-to-end (intake, write-back, native identity, connection).
- **Engineering Manager (EM) router** — assign work to the EM; it gates on a requirements review, routes by tier + specialty + load, dispatches to the least-loaded qualified agent, surfaces staffing-gap and busy blocks with explanations. "Assigned by EM" is visible on every task.
- **Agent-detail page** — capability editor (tier range, structured taxonomy specialties, concurrency limit, cost ceiling), per-agent platform credentials (GitHub + Shortcut; sealed at rest, fingerprint-only reads, connection-test-on-entry), editable agent identity (name/vendor/model/avatar), `agent.md` description that shapes the agent's run, live Pause/Resume.
- **Task titles** — persisted and surfaced on board cards, task inspector, and agent recent-work. Raw UUIDs no longer appear on those surfaces.
- **Board** — 5 operator columns (Backlog, Blocked, In Progress, PR Opened, Completed); GitHub-merge triggers auto-complete. Board is a read-only projection of platform reality; Tasca never owns issue state.
- **Shortcut intake** — assignment webhook received + verified; write-back (status/PR link) is deferred pending token-model confirmation.
- **Multi-tenancy + RBAC** — org scoping, three roles (owner-admin / admin / user), BYOK credential vault (AES-256-GCM, env-held master key), Coolify autodeploy.
- **Operator controls** — sole-owner removal guard, stuck-task force-reset, collapsible nav.

## What is not yet built

The following are in-flight or planned — do not treat them as done:

- Model is a free-text field, not a validated vendor-model dropdown (#322).
- Local-model / Ollama execution is not proven end-to-end (#335).
- Per-agent success rate is stored but not yet computed from task history (#326).
- Shortcut identity handle display only — not auto-fetched (#321).
- Roster "Add agent" is an inline form, not the full hire wizard (#323).
- Usage metering, billing, cost-ceiling enforcement, and budget alerts are not built (#336).
- Agent-page current-task display and roster tile still show the task UUID in some paths (#325, partial).
- Settings vendor-keys card is Anthropic-only (#333, partial).
- LLM-derived specialty routing and capacity-freed re-drive are filed fast-follows (#370, #368).
- Linear adapter does not exist (reserved enum value only).
- PM-assistant advisory engine and view are not built.
- Per-agent OS namespace sandbox (the gate for untrusted multi-tenant) is not built.

## Roadmap

Delivery is staged so each stage stands on its own and proves the next.

- **Stage 1 — Foundation + Shortcut + Claude.** Headless Emdash fork, the identity primitive, the Shortcut adapter, one Claude-backed agent, and tier routing v1. *Shipped* (Shortcut write-back is the one open residual).
- **Stage 2 — GitHub adapter + PR/review loop + escalation.** Per-customer GitHub App, issue/PR/review/check webhooks, the escalation breaker, multi-agent-per-project with same-repo serialization. *Shipped* (reference adapter, end-to-end).
- **Stage 3 — Linear + multi-vendor + BYO-local.** Linear `actor=app` sessions, OpenAI agents, self-hosted local models. *Partial* — routing and identity are vendor-agnostic, but no OpenAI or local-model agent is proven end-to-end; Linear does not exist yet.
- **Stage 4 — Roster management + multi-project + 24/7 ops.** Roster dashboard is done (real data). Roster CRUD, capability-profile editor (hire wizard), cross-repo deploy, cloud scheduler/health-monitor are not yet built.
- **Stage 5 — PM-assistant.** Advisory triage, decomposition, distribution, and reporting. *Not built.*

See the [completion gap analysis](docs/PRD-Completion-Gap-Analysis.md) for the precise
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

## Self-hosting

Run your own instance with Docker Compose:

```sh
git clone --recursive https://github.com/icemint/tasca.git
cd tasca
cp .env.example .env     # fill in Tier 1 (Anthropic key, vault key, OAuth)
make up                  # builds the base image, then builds + starts the stack
```

Then open **http://localhost:3000**. Full walkthrough — config surface, GitHub App setup,
external Postgres — in [SELF_HOST.md](SELF_HOST.md).

---

## Documentation

- [Product Requirements (PRD v1.0)](docs/Tasca-PRD-v1.0-FINAL.md) — the product, the
  wedges, the adapters, the stages, the open questions.
- [Design Brief (v1.0)](docs/Tasca-Design-Brief-v1.0.md) — brand, visual language, every
  app surface and marketing page, accessibility and acceptance criteria.
- [Self-hosting guide](SELF_HOST.md) — Docker Compose, configuration, GitHub App setup.

---

## License

Tasca is licensed under the [GNU AGPL-3.0](LICENSE) for community use. A **commercial
license** is available for organizations that cannot operate under the AGPL — contact
Icemint Labs.

---

*Tasca is built by Icemint Labs.*
