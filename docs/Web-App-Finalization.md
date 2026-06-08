# Web App Finalization — Stage 1 (read-only console)

Date: 2026-06-08 · Scope: `app.tasca.dev` (the authenticated console) + a marketing-site pass. Decision: productionize the **read-only** console now; the write-API is a separate initiative (`docs/Write-API-Scope.md`).

## Done this pass

### Read views — all wired to the real read-API, honest states
| View | Source | Status |
|------|--------|--------|
| Roster (`/roster`) | `GET /api/agents` | ✅ real data · loading/empty/unauth/error |
| Agent detail (`/agents?id=`) | `GET /api/agents/:id` | ✅ bindings, capability, recent work |
| Monitoring (`/monitoring`) | `GET /api/tasks` | ✅ pipeline board + KPIs + attention rail + **Refresh** |
| Task inspector (`/tasks?id=`) | `GET /api/tasks/:id` | ✅ routing decision + **linked PRs render** |
| Connections (`/connections`) | `GET /api/connections` | ✅ per-platform health + 24h webhook counters |
| Onboarding (`/onboarding`) | `GET /api/connections` | ✅ read-only preview reflecting real connection state |
| Settings (`/settings`) | — | ✅ honest deferred shell (panels out of scope) |
| Login (`/`) | OAuth (GitHub/Google) | ✅ error handling, `noindex` |

### Coherent read-only / preview story (was: 17 stray "Coming soon" labels)
- Every mutating control now renders through one helper — `ui.roControl(label, { gate? })` — producing a consistent, clearly-disabled affordance with an **honest reason** surfaced to both sighted users (`title`) and assistive tech (`aria-label`), tagged `data-ro="soon|gated"`.
- One app-level signal: a **"Read-only" badge** in the topbar declares the stance once (replaced a decorative kebab).
- Honest gated-vs-not-built split:
  - **gated** (operator-run today): Add agent / Deploy / Assign — *agent provisioning*; Connect / Manage / Repair / Continue — *platform setup*.
  - **soon** (ships with the write API): Pause, Edit profile, Interrupt, Reassign, Escalate, Re-tier.
- The only remaining "Coming soon" is the **Settings** page's panel list (an intentional roadmap shell, not a control).

### Real agent activity actually shows
- Task inspector renders the agent-authored PRs (e.g. agentic-playground `#5`→PR `#8`) with their merge state; monitoring boards the done + needs-attention tasks; agent detail lists recent work + the `tasca-elvis` GitHub binding. Pinned by tests against fixtures mirroring the live run.

### "Live" made honest
- Monitoring's "Live" badge is paired with a real **Refresh** control (re-runs the read via `mount`'s `data-act="refresh"`) and an accessible label — no fake realtime claim.

### Accessibility
- `roControl` adds `aria-label` to every disabled control (was title-only). Theme toggles across app + login + marketing now carry `aria-pressed` + `role="group"`. `onb-check` connected glyphs labelled. Existing skip-link, focus-visible rings, reduced-motion, semantic states retained.

### Tests — was ZERO, now covered
- `app/` gains vitest (+ happy-dom). 35 tests: `ui` (roControl soon/gated + formatters), `states`, `api` (ok/unauth/401/5xx/network/malformed classification), all 7 view loaders (real-data + empty + unauth), and `mount` (session gate → render, unauth → redirect, error → retry, refresh re-run). Production path pinned (`vi.stubEnv('DEV', false)`), so tests drive states via stubbed `fetch`.
- **CI:** new `app` job (`ci.yml`) runs `typecheck + test + build` in `app/` with `--ignore-workspace` (the app is a standalone package).

### Cleanup
- Removed dead `getRoutingDecisions()` + its unused `RoutingDecision` import (the `/api/routing-decisions` endpoint had no consumer).

### Marketing site (`tasca.dev`) final pass
- Verified launch-ready: full OG/Twitter/canonical meta, sitemap integration, `robots.txt`, web manifest, favicons; CTAs hand off to `app.tasca.dev` (`APP_URL`). Applied the same `aria-pressed` theme-toggle a11y. Build green (7 pages).

## Remaining (out of scope this pass)

- **Write-API + the disabled controls** — the 17 read-only controls light up only when the coordination write-API exists. Scoped separately in `docs/Write-API-Scope.md`, including the gating decisions each family needs. Until then the console is read-only by design and says so.
- **Settings panels** (Workspace / Billing / API keys / Audit) — deferred product surface.
- **Routing-history view** — the worker serves `/api/routing-decisions`; no UI consumes it yet (candidate for a future "decisions over time" view).
- **Live streaming** — Monitoring refreshes on demand (Refresh), not via a push/poll stream; a future enhancement.

## Verification
- `app`: `pnpm typecheck` clean · `pnpm test` 35 passed · `pnpm build` 8 pages · no dev-fixtures or stray "Coming soon" in `dist`.
- `website`: `pnpm build` clean (7 pages + sitemap).
