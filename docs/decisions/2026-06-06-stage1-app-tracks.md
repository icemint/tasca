# 2026-06-06 — Stage-1 app tracks: Auth, UI, GitHub adapter

Status: accepted

## Context

With the worker live at `api.tasca.dev`, Stage-1 opens three parallel tracks: human Auth (OAuth login), the authenticated UI at `app.tasca.dev`, and the GitHub adapter (second `PlatformAdapter`). Architect plans were produced per track; four cross-cutting decisions were locked with the maintainer before building so the parallel work doesn't diverge.

## Decisions

1. **App ↔ API wiring: nginx reverse-proxy** (not CORS-direct). `app.tasca.dev` nginx proxies `location /api/ → http://<worker>:8080`. Consequences: same-origin (no CORS); session cookie is host-only on `app.tasca.dev`; login links stay `/api/auth/*` (no repointing); `OAUTH_REDIRECT_BASE=https://app.tasca.dev` and OAuth callback URLs register at `https://app.tasca.dev/api/auth/{github,google}/callback`; **the app's Coolify resource must join the worker's `tasca` Docker network** and resolve the worker by service DNS (deploy-topology change — update the deploy spec). The worker still serves `/webhooks/*` + `/healthz` directly on `api.tasca.dev`.

2. **GitHub identity: per-customer GitHub App** (PRD §5.2). One `app[bot]` author for write-back; per-agent attribution carried in comment text via `delegation.attribution_label`; short-lived installation tokens. `identity_binding.credential_ref` (per-binding) absorbs this with no model change. Intake is unaffected by this choice; it shapes the gated write-back/provisioning.

3. **Login: OAuth-only** (GitHub + Google). The inert email/password form on the login page is hidden; no password auth built now (matches the PRD no-fake-accounts stance + design brief C1).

4. **UI Settings (C8) + PM-assistant (C9): deferred to thin read-only shells / empty states.** The UI track stays read-only and focused on Roster, Routing inspector, Monitoring, Connections, Agent detail, Onboarding — all real-data-or-honest-empty.

## Adopted implementation defaults (architect-recommended)

Zero new runtime deps anywhere (stdlib + `node:crypto` + existing zod/pg); server-side opaque sessions, 7-day sliding TTL; Google `id_token` validated via userinfo/tokeninfo (no `jose`); UI stays Astro-static + client islands (no SSR/SPA), vendoring the design-system like `website/`; UI copies projected types into `app/` (no workspace coupling); **no fake data** — real API or honest empty states; all write/mutation controls render visible-but-disabled (flags OFF); GitHub `external_id` = stringified numeric user id, `externalStoryId` = `owner/repo#number`, @-mention match by handle; new human table `app_user` (`user` is reserved); human↔agent FK deferred.

## Parallelization seams

- **Session contract** — `GET /api/auth/me` → `{authenticated, user}` | 401; `tasca_session` cookie; failures redirect `?error=`. (Auth publishes; UI consumes via stub.)
- **Read-API contract** — typed GET endpoints projecting `@tasca/domain`. (UI builds against dev-only fixtures until live.)
- **GitHub adapter** — mirrors `ShortcutAdapter`; seams already enumerate `'github'`.

Dependency graph: GitHub ⟂ everything · Auth → session contract → UI · UI → read-API contract → worker.

## Gated / deferred (unchanged)

Shortcut + GitHub write-back/provisioning (throw); GitHub App customer install; PM-assistant; billing/usage/audit/keys; live log streaming.
