# Tasca — Product Vision (North Star)

> The single doc that makes the roadmap cohere. If a ticket doesn't serve this, question it.

## One sentence

**Tasca is the place a team of humans *and* AI agents ship work together — Tasca runs the coordination and the PM brain; you bring the execution compute.**

## The model

A Tasca **team is a mix of first-class members**: humans and AI agents, side by side on the same board. An agent isn't a hidden background worker — it's a **tier-capable member** you assign work to, exactly like a teammate. Each member (human or agent) has a **complexity tier** ceiling; the routing engine matches an issue's tier to a member that can handle it.

Crucially, **Tasca does not sell or manage inference.** You bring the compute:

- **Self-hosted models** (e.g. Qwen, Gemma) running through the **Tasca host** (the desktop/relay host on your own machine/infra), or
- **Claude** via your **API key or login** — plugged in as a "developer" agent.

So an organization's agent roster is *its own* models and keys. Tasca is the layer that coordinates them.

## Three layers (who owns what)

| Layer | What it does | Who runs it |
|---|---|---|
| **Coordination + PM brain** | The board, issues, tiers, sprints, the **routing/assignment engine**, escalation, audit, real-time sync (Electric), per-org feature flags | **Tasca-hosted** (`app.tasca.dev` — the platform) |
| **Distribution + advisory** | The **PM assistant** (Claude): triages, tiers, decomposes, routes, advises — the intelligence that decides *what* goes to *whom* | Tasca-hosted brain, **your Claude key/login** for the inference |
| **Execution** | Actually doing the coding work — running the agent in a workspace | **You** (BYO: self-hosted Qwen/Gemma via the host, or Claude via key/login) |

This is what **"hosted-first" actually means**: *we run the platform; you plug in your agents.* The marketing promise ("we run it") and the product are consistent — Tasca hosts the coordination and the PM brain, not the model inference. There is no contradiction with self-hosting: self-hosting is where your **execution compute** lives, by design.

## Why the deferred tickets are actually central

The features that looked "optional/deferred" are the load-bearing pieces of this model. They are not nice-to-haves — they are the vision:

- **#14 — synthetic agent-as-member (`member_kind='agent'`) → CENTRAL, not optional.** This is *the* mechanism that makes an agent a first-class, tier-capable, assignable member. Without it, agents can't be teammates — the whole "humans + agents on one board" premise rests on it. It was deferred to M3 as a data-model concern; under this vision it's the keystone. (Issue Drawer assignee picker #106 — "agent vs human" — is its first UI surface.)
- **#115 — the PM assistant = the advisory + distribution/routing layer.** Not a chatbot bolted on; it *is* the "distribution" layer above. It reads the backlog, assigns/recommends a tier, decomposes work, and routes each piece to a capable member (human or agent). It's the brain that drives the routing engine with judgment. (Tasca hosts this brain; it runs on the org's Claude key.)
- **The M1 routing engine = the substrate both of the above plug into.** `assignment_engine::decide()` (tier → capable agent, with `needs_attention` on failure and `no_capable_agent` when over-tier) is the deterministic core. #14 gives it agents-as-members to route *to*; #115 gives it the intelligence to route *with*. M1 built the engine; #14 + #115 make it a team.

So the cohesion is: **engine (M1) ⟶ members to route to (#14) ⟶ intelligence to route with (#115)**, all over **BYO execution compute**, all coordinated by the **Tasca-hosted platform**.

## Supporting pieces, in vision terms

- **Tiers (`complexity_tier`)** — the shared language between a piece of work and a member's capability ceiling. Lets a cheap local model take basic/low work and Claude take hard/ultra.
- **Sprints** — time-boxed scoping for the mixed human+agent team.
- **Escalation (human-gated, remote-authoritative)** — when an agent can't, a human (or a higher-tier member) takes over; the §5.5 guarantee (`needs_attention`, never silently dropped) keeps the team honest.
- **Per-org feature flags (#156)** — the production rollout lever: turn capabilities on per-org as this vision ships, without a redeploy.
- **The Tasca host + relay** — the bridge that lets your self-hosted execution compute join the hosted coordination plane.

## What Tasca is *not*

- Not a managed-inference business. We don't resell model tokens; you bring compute.
- Not a single-actor tool. Humans and agents are peers on the board, not user-and-assistant.
- Not a fork still in vibe-kanban's "sunset" posture — Tasca is hosted-first and active. (See the M1 close-out + the VK-leftover cleanup.)

## North-star → roadmap

| Vision pillar | Milestone / tickets |
|---|---|
| Routing engine (the substrate) | **M1 ✅** (assignment-engine, the seam, escalation, validation, prompt templates) |
| Agents as first-class members | **#14** (synthetic agent-member, M3) + **#106** (assignee picker) |
| PM assistant (distribution/advisory) | **#115 / M3** (PM-assistant + org AI key + SSE) |
| BYO execution compute | The host + relay (built) + executor support (Qwen/Gemma/Claude) |
| Per-org rollout | **#156 ✅** (org feature flags) |
| The signed-in app surface | **M-AppUI** (the board/drawer/settings port these run on) |

---
*This is the north star. Tickets and PRs should be able to point back to a line in this doc.*
