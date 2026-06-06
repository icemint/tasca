# Tasca — Shortcut Integration Brief & Kickoff Confirmations

**Status (as of 2026-06-06):** Build the intake against the **documented Outgoing Webhook v1 + REST v3** surfaces now. Shortcut's "Agent API" is a **marketing umbrella + access-gated alpha**, *not* a public REST surface: no public endpoint to create Agent Users, no published Agent SDK, and **API v4 is in gated alpha** ("optimize agent compatibility", release note 2026-05-12; signup: forms.gle/kA5rUpPuCvUqxWGDA). Engage `support@shortcut.com` + the v4 alpha form before designing anything that depends on the Agent API.

**Context for the Shortcut team:** Tasca is an AI agent workforce platform — a roster of named AI "employees" (e.g. *Elvis*, *Mona*) that need native Shortcut identities, receive assigned Stories, work the code, and report status back as themselves. Shortcut is our first adapter.

---

## The 5 must-confirm items (the kickoff asks)

1. **Agent-User seat billing.** Do Agent Users consume a paid/billable seat? The Pricing FAQ is silent (Observers are documented free; agents are not). Materially changes whether we run one Agent User *per backing model per workspace* or cap to a small fixed roster.
2. **★ Token-issuance model — THE architecture-deciding question.** When an admin runs **Settings → Integrations → "Configure Agent Users"**, does Shortcut **issue a Shortcut-side API token** for that agent persona (which Tasca would store + use for writes), **or** is it the **Devin model** — a *federated partner trust* where Shortcut stores the *partner's* service token and calls outbound to the partner, and the persona's on-Shortcut writes flow via Shortcut's internal Agent API (no Shortcut-issued token at all)? The public Devin flow ("enter a Service API Token *from Devin*") suggests the latter. **This decides whether our write-back path is "REST v3 with a per-persona Shortcut token" or "implement Shortcut's partner/Agent-API contract."**
3. **Comment `@`-mention webhook shape.** The exact entity type (likely `story-comment`, unpublished) and where mentioned member UUIDs + comment text + parent-story id appear in the payload. Shortcut's docs deliberately don't enumerate comment-level events ("experiment against a live server"). We must reverse-engineer against a test workspace *or* get a definitive schema.
4. **v4 alpha: programmatic agent-create.** Will v4 expose `POST /agent-users` (or equivalent) so onboarding can self-provision personas instead of the manual UI step?
5. **v4 alpha: act-as / impersonation header.** Does v4 add an `on_behalf_of` / acting-user mechanism? (v3 has **none** — every write is attributed to the token's owning member.) If yes, the token vault collapses to one admin token + persona UUIDs.

> Send these to `support@shortcut.com` in writing and request v4 alpha access. **Do not finalize provisioning/write-back architecture before #1, #2, #3 are answered.**

---

## Buildable NOW (documented v3 + webhook v1 — ungated)

These need no Shortcut call and are starting in parallel:

- **Assignment intake.** Subscribe to the Outgoing Webhook v1 stream; for each event, **HMAC-SHA-256 verify** the body against the `Payload-Signature` header, then scan `actions[]` for `entity_type:"story"` + `action:"update"` with `changes.owner_ids.adds` intersecting a **registered agent-user UUID** → dispatch to that persona. (Top-level `member_id` is the *actor*, not the assignee — easy bug.) Normalize to our existing `AdapterEvent` (`@tasca/contracts`).
- **Webhook self-registration.** `POST /api/v3/integrations/webhook {webhook_url, secret}` at install (admin token) → returns a webhook id (deletable later). Our own writes round-trip through the stream → **dedupe by actor `member_id`**.
- **Per-persona token vault — already absorbed.** `@tasca/identity`'s per-binding `credential_ref` + stable `principal_id` already models "one Shortcut token per persona, keyed by persona," whichever way #2 resolves (one-token-per-agent → distinct refs; one-workspace-token-acting-as → shared ref + distinct `external_id`). No model change needed either way.
- **REST v3 / MCP facts:** single user-and-workspace-scoped token; **200 req/min** rate limit (429 over); members are **read-only** via REST + MCP; `Member` exposes no `is_agent` flag (maintain our own UUID→persona map); read-only tokens exist (2026-01-20) but no finer scopes. The MCP server (`@shortcut/mcp`) is the **read/write tooling** layer (orthogonal to the Agent API identity layer) — useful later as a write client, but a thin REST v3 client is more controllable for status-back.

## Truly gated (needs the call / v4)

- **Agent-User provisioning** — UI-only today (admin: Settings → Integrations → Configure Agent Users); self-serve depends on #4.
- **Write-back identity attribution** — depends on #2 (Shortcut-side token vs Devin-style partner trust).
- **Comment-`@`-mention intake** — depends on #3 (payload shape); the owner-add intake above is unaffected.

---

## Plan

- **Phase 0 (now):** email Shortcut the 5 items + request v4 alpha. Capture a corpus of real webhook payloads from a test workspace (story create/update/owner-add, comment create/mention/edit/delete, task, epic) before freezing the parser.
- **Phase 1 (now, in parallel — ungated):** build the `@tasca/adapters` Shortcut intake — `verifyWebhook` (HMAC-SHA-256), `parseEvent` (story.update owner_ids.adds → `AdapterEvent`), webhook self-registration, dedupe; `provisionIdentity`/`postStatus` stubbed behind the gate. Wire the coordination loop (#7) against the proven routing/execution/identity + the `AdapterEvent` contract.
- **Phase 2 (gated):** once #2/#3 land — implement provisioning + the correct write-back (REST v3 per-persona token *or* the partner/Agent-API contract) + comment-mention intake.
- **Re-architect triggers:** Shortcut publishes Agent API reference / `@shortcut/agents` SDK → adopt + drop the token-vault; confirms programmatic agent-create (v4) → self-serve onboarding; confirms an act-as header → collapse to one admin token + UUIDs; confirms agents are free → scale persona-per-model.

## Caveats
- The "Agent API" in Shortcut's marketing ≠ a documented REST surface; treat any richer-surface assumption as speculative until v4 alpha docs exist.
- v3 tokens are unscoped bearer-equivalents ("complete access") — treat persona tokens as secrets, rotate aggressively (`@tasca/identity` already keeps only `credential_ref` pointers, never the token).
- All anchored to docs visible 2026-06-06; Shortcut ships weekly — re-check at integration milestones.
