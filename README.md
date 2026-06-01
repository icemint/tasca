<p align="center">
  <a href="https://tasca.dev">
    <picture>
      <source srcset="packages/public/tasca-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/public/tasca-logo.svg" media="(prefers-color-scheme: light)">
      <img src="packages/public/tasca-logo.svg" alt="Tasca Logo">
    </picture>
  </a>
</p>

<p align="center"><strong>The board where humans and AI agents ship together.</strong></p>
<p align="center">A self-hosted, multi-tenant project tracker that assigns tickets to coding agents — local or cloud — based on what each agent can actually deliver.</p>

<p align="center">
  <a href="https://github.com/icemint/tasca/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/icemint/tasca/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Rust" src="https://img.shields.io/badge/rust-stable-000000?logo=rust&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white">
</p>

> **Status: v0.1.0** — sanitized fork foundation. Built on the open-source [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) execution core (Apache-2.0), with all upstream telemetry, auto-update, and back-channel egress severed. The team layer, capability-aware routing, PM assistant, and GitHub automation ship in subsequent releases (see [Roadmap](#roadmap)).

---

## Table of contents

- [Why Tasca](#why-tasca)
- [How it works](#how-it-works)
- [Capability-aware routing](#capability-aware-routing)
- [Supported agents](#supported-agents)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Quickstart](#quickstart)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Security model](#security-model)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License & attribution](#license--attribution)

---

## Why Tasca

Coding agents are getting good enough to do real work — but the tools around them assume one model fits every task. Point a heavyweight orchestrator at a local model and a trivial ticket drowns in coordination round-trips; point it at a frontier model for everything and the bill (and the latency) is absurd.

Tasca takes a different stance: **a ticket carries a complexity tier, an agent declares the tiers it can handle, and the board assigns work an agent can actually finish** — prompted the way that agent needs. A local 30B model on your own hardware handles fully-decomposed, low-reasoning tickets for free; cloud Claude takes the hard ones. Humans and agents share one board, one set of issues, one review flow.

The result is a Linear/Shortcut-style tracker that treats agents as teammates with honest, declared capabilities — not as magic that works everywhere or nowhere.

## How it works

1. **Plan on the board** — create, prioritise, tier, and assign issues across a kanban board, organised by project and sprint.
2. **Decompose with the PM assistant** — an org-connected Claude breaks vague tickets into tier-appropriate, fully-specified work (edge cases, IO contracts, acceptance gates).
3. **Agents pick up what they can** — the routing engine matches an unassigned, unblocked ticket to a free agent whose capability tier covers it, seeding an isolated git worktree.
4. **Review the diff** — agents open PRs with AI-generated descriptions; you review inline, on the board or on GitHub.
5. **Status follows the work** — GitHub webhooks move tickets automatically: a PR opened → in review, `changes_requested` → back to ready-for-development (optionally re-dispatched to the agent with the review comments), merged → done.

## Capability-aware routing

Every ticket gets one of five complexity tiers. Every agent declares the highest tier it may take. Assignment is deterministic — no leader-agent burning tokens to decide who works.

| Tier | Meaning | Typical agent |
| --- | --- | --- |
| **basic** | Fully specified; exact files, IO contract, all edge cases, acceptance test | Local model (e.g. Qwen3-Coder) |
| **low** | + modules/relations named, tool list constrained | Local model |
| **medium** | Design note included; some reasoning allowed | Local or cloud |
| **hard** | Human-authored plan required | Cloud (Claude) recommended |
| **ultra** | Human + cloud own it; agent assists | Cloud, supervised |

Lower tiers require more decomposition *before* an agent may start — the board enforces the "decompose until there's no reasoning left, just coding" discipline that makes local models reliable. Failed attempts surface for one-click escalation to a higher tier or a cloud agent.

## Supported agents

Tasca runs coding agents as isolated subprocesses, each in its own git worktree. Any agent can be pointed at a custom endpoint — including a **local model served over your network** (e.g. Claude Code → Ollama on an Apple Silicon rig) via per-agent environment overrides.

Claude Code · Codex · Gemini CLI · GitHub Copilot · Amp · Cursor · OpenCode · Droid · Qwen Code — switchable per agent profile, mixable on one board.

## Architecture

```
            ┌─────────────┐
            │ Cloudflare  │   DNS · edge TLS · WAF
            └──────┬──────┘
                   │  origin TLS
            ┌──────▼──────┐
            │   Traefik   │   routing · TLS termination
            └──────┬──────┘
        ┌──────────┼──────────┐
        ▼          ▼          ▼
    frontend    backend    routing engine
   (React/Vite) (Axum/Rust) (tier × capability)
                   │
        ┌──────────┼───────────────┐
        ▼          ▼               ▼
   PostgreSQL   git worktrees   agent runner
   (org/issue)  (per attempt)   (sandboxed)
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
                   local models           cloud agents
                  (Ollama / LAN)        (Claude, …)

  tasca.dev        → landing surface
  app.tasca.dev    → board surface          (hostname-routed)
 *.tasca.dev       → team vanity domains
  api.tasca.dev    → backend
```

Each project connects to one or more GitHub repos; PRs link back to their tickets, and review events drive ticket status. The agent runner executes untrusted/external work in ephemeral, egress-restricted sandboxes (see [Security model](#security-model)).

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | React · Vite · TypeScript · Tailwind · shadcn/ui · `@dnd-kit` |
| Backend | Rust · Axum · Tokio · SQLx |
| Datastore | SQLite (local mode) · PostgreSQL (team/remote mode) |
| Agent execution | Subprocess executors · git worktree isolation · MCP task API |
| Type sync | `ts-rs` (Rust structs → TypeScript) |
| Auth | JWT + refresh rotation · OAuth PKCE (GitHub/Google) |
| PM assistant | Anthropic Messages API (org-level key, BYO) |
| Realtime | WebSocket (event stream → live board) |

## Quickstart

### Prerequisites

- **Rust** (latest stable) — [rustup](https://rustup.rs/)
- **Node.js** 20+ and **pnpm** 8+
- **PostgreSQL** 16 (team/remote mode only; local mode uses SQLite)
- A coding agent authenticated on your machine (Claude Code, Codex, etc.)
- *(optional)* **Ollama** on a reachable host for local-model agents

### Run (local mode)

```bash
git clone git@github.com:icemint/tasca.git
cd tasca
pnpm i
pnpm run dev          # backend + web app; blank DB seeded from dev_assets_seed
```

### Point an agent at a local model

Set a Claude Code agent profile's environment to your Ollama endpoint:

```bash
ANTHROPIC_BASE_URL=http://<your-rig>:11434
ANTHROPIC_API_KEY=ollama
```

Then assign it a `max_tier` of `low` and let it pick up basic/low tickets off the board.

Run `pnpm run dev` and open the URL it prints. Full guides live at [tasca.dev/docs](https://tasca.dev/docs).

## Repository layout

```
tasca/
├── crates/                      Rust workspace
│   ├── server/                  Axum HTTP/WS entry (local mode)
│   ├── remote/                  Team mode — orgs, issues, members, PostgreSQL
│   ├── executors/               Agent executor trait + per-agent impls
│   ├── services/                Worktrees, events, git, assignment engine
│   ├── db/                      SQLx models + migrations
│   ├── api-types/               Shared types (→ TypeScript via ts-rs)
│   └── …                        git, utils, relay
├── packages/                    Frontend
│   ├── local-web/               Local board SPA
│   ├── remote-web/              Team board SPA
│   ├── web-core/ · ui/          Shared components & stores
│   └── public/                  Logos & assets
├── npx-cli/                     CLI launcher
├── PRD.md                       Product requirements
├── SANITIZE.md                  Upstream-severance runbook
├── CLAUDE.md                    Engineering workflow + project context
├── LICENSE                      Apache-2.0
└── NOTICE                       Attribution (Vibe Kanban / BloopAI)
```

## Development

```bash
pnpm run dev          # full stack
pnpm run check        # tsc + cargo check (frontend + backend)
cargo check --workspace
cargo install cargo-watch sqlx-cli   # dev tooling
```

Team/remote mode additionally needs PostgreSQL with `wal_level=logical` and at least one OAuth provider configured. See [PRD.md](./PRD.md) for the full architecture and phasing.

## Security model

Coding agents execute arbitrary code. Tasca treats that as the central design constraint, not an afterthought:

- **Trust tiers** — external collaborators are propose-only (file/comment); execution requires an internal human to promote a ticket to agent-ready.
- **Sandboxed runs** — untrusted/external execution happens in ephemeral, egress-restricted containers with no host filesystem or secrets.
- **No permissive defaults on untrusted paths** — agent permission policy defaults to supervised outside trusted internal work.

Tasca ships with **zero outbound telemetry, analytics, crash reporting, or auto-update** — all upstream egress was severed and verified (see [SANITIZE.md](./SANITIZE.md)).

## Roadmap

| Version | Theme | Highlights (planned) |
| --- | --- | --- |
| v0.1.0 | _Clean foundation._ | Sanitized fork, zero upstream egress, hard-forked at Vibe Kanban v0.1.44 |
| v0.2.x | Route the work. | Complexity tiers, agent capability tiers, deterministic assignment engine, local-model (Ollama) agent profiles |
| v0.3.x | A real team. | Multi-user auth (hashing, verify, reset, lockout), sprints, agents as assignees, vanity team domains |
| v0.4.x | Plan with Claude. | Org-key PM assistant — ticket decomposition, tier suggestion, board orchestration |
| v0.5.x | Ship through GitHub. | PR↔ticket linkage, webhook-driven status automation, review-driven re-dispatch |
| v0.6.x | Open the doors safely. | External-client propose-only tier, sandboxed agent execution |

This isn't a release calendar — it's the direction of travel. The order is what matters.

## Contributing

Tasca is developed internally by Icemint Labs. Open an issue before writing code; branch from `main`; use [Conventional Commits](https://www.conventionalcommits.org/); keep `pnpm run check` and `cargo check --workspace` green locally.

## License & attribution

Tasca is licensed under the **Apache License 2.0** — see [LICENSE](./LICENSE).

Tasca is a hard fork of [**Vibe Kanban**](https://github.com/BloopAI/vibe-kanban) by BloopAI, also Apache-2.0. Original copyright notices are preserved per Apache §4, and modifications are documented in [NOTICE](./NOTICE). "Vibe Kanban" and "BloopAI" are trademarks of their owner and are used here only descriptively; Tasca is an independent project, not affiliated with or endorsed by BloopAI.

---

<sub>Icemint Labs · Built for teams who ship with agents.</sub>
