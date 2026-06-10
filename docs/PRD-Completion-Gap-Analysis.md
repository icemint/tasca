# Tasca — PRD + Design Completion Gap Analysis

> **Purpose.** This is the definition-of-done checklist for taking Tasca to **full PRD + design completion** — every surface, every adapter, production-grade. It walks the PRD (`docs/Tasca-PRD-v1.0-FINAL.md`) section by section and every canonical design ("CD") surface (`docs/Tasca-Design-Brief-v1.0.md` + `design-system/`), marks each **{done / partial / not-built}** against the *actual code*, and maps every gap to a build slice. "Full" is derived from the PRD and the designs — not guessed.
>
> **Method.** Six parallel read-only surveys (PRD inventory, design inventory, backend code-state, adapter parity, frontend code-state, billing/usage/audit/keys + deploy) cross-checked against the repo. Load-bearing "not-built" claims were verified directly (grep/read), not taken on narrative.
>
> **Status as of 2026-06-10**, `main` @ `bb5431c05` (Wave-2 multi-tenancy arc complete, PR #258).

**Legend:** ✅ done · 🟡 partial · ⬜ not-built · 🔒 out-of-scope (PRD-excluded) · ▶ maps to slice

---

## 0. Executive summary

The **engine is done; the surfaces and the second/third platforms are not.** Everything below the UI — routing/tier engine, agent-identity primitive, multi-tenancy + RBAC, coordination/orchestration, dispatch queue + reaper, credential isolation (broker + Anthropic proxy), agent-runner, webhook handling — is built, wired, and tested. **GitHub is a complete reference adapter** (intake + write-back + identity + connect, end-to-end). The frontend read-console is real (real data, honest empty/loading/error states, a11y, status-not-by-color-alone).

What's missing to reach "matches the PRD and the designs, end to end":

1. **PM-assistant (PRD Stage 5 / M3)** — not built at all (no backend proposal engine, no `pm-assistant` view). The non-technical entry point.
2. **Adapter parity** — **Shortcut** is intake-only (write-back gated on the token model; no content read-client; no mention intake; no connect flow). **Linear** does not exist (reserved enum value only).
3. **Billing / usage / audit / keys** — usage metering is a *documented-but-unbuilt* proxy hook; Stripe billing absent; the audit trail is **written but never surfaced** (no `/api/audit`); API-key management absent; **cost ceilings are stored but never enforced** (no runtime budget gate — PRD §11 runaway protection is unbuilt).
4. **The dominant security residual** — container isolation shipped, but the **per-agent separate-UID + PID/mount/net namespace sandbox** inside the runner is not built. Current safe bar is *trusted single-tenant repos only*.
5. **Design surfaces partial/not-built** — `hire` wizard, `add-connection` flow, `pm-assistant`, the routing inspector's **audience-split** (PM/Eng + live log + worktree), monitoring **live feed**, and the full **Settings** tabs (org/members/roles, billing/usage, flags, security/audit, keys) — all designed, none fully built. Error pages (404/403/500) not built as routes.
6. **PRD Stage 3 multi-vendor / BYO-local** — routing + identity are vendor-agnostic, but **no OpenAI or local-model agent is proven end-to-end** (execution currently spawns the Claude CLI; the Emdash CLI registry covers more but isn't wired/proven). 🟡
7. **PRD Stage 4 roster management** — the roster *dashboard* (read) is done; **roster CRUD, capability-profile editor (UI), cross-repo deploy, and the cloud scheduler/health-monitor/restart** are partial/not-built.

**Stage rollup (PRD §8):** Stage 1 ✅ (Shortcut write-back is the one residual) · Stage 2 ✅ (GitHub reference) · Stage 3 🟡 (Linear ⬜, multi-vendor/BYO 🟡) · Stage 4 🟡 (dashboard ✅, management ⬜) · Stage 5 ⬜ (PM-assistant).

---

## Part A — PRD walk (section by section)

### §1–2 Product shape & positioning
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-1/2-wedges | Three wedges: named multi-vendor identities × capability/tier routing × roster | ✅ engine; 🟡 surfaced | All three exist in code; roster/identity only partially surfaced in UI | — |
| PRD-1-native-loop | Receive ticket → worktree → PR → respond to webhooks | ✅ (GitHub) / 🟡 (Shortcut) | GitHub end-to-end; Shortcut intake-only | ▶W3-S2 |
| PRD-1-multiproject-247 | Agents across many projects 24/7 | 🟡 | Per-task dispatch works; cross-repo deploy + scheduler/health-monitor not built (Stage 4) | ▶W4-S5 |
| PRD-1-concede-orchestration / PRD-2-commodities / PRD-7-dropped-kanban | Do **not** build orchestration/kanban/Jira | 🔒 | Correctly excluded | — |

### §3.1 Persistent named identities (Wedge 1)
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-3.1-identity-primitive-fields | service-user + RBAC + capability profile + delegation/attribution | ✅ | `packages/identity` — service_user (stable `principal_id`), `rbac_role`, capability_profile, identity_binding, delegation, append-only `audit_event` | — |
| PRD-3.1-no-fake-human-accounts / native-only | Native service-user identity only; no self-approval | ✅ | GitHub App-as-actor; branch protection holds | — |
| PRD-3.1-primitive-maps-to-all-platforms | Primitive maps onto each platform | 🟡 | Maps to GitHub (App); Shortcut/Linear bindings reserved but unprovisioned | ▶W3-S2/S3 |

### §3.2 Capability/tier routing (Wedge 2 — "crown jewel")
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-3.2-heuristics / -classifier / -off-hot-path | Heuristic tier + budgeted LLM classifier + confidence | ✅ engine; 🟡 classifier impl | `routing/src/tier.ts` complete with fallback; **no concrete classifier plugged in** (heuristics carry it; `LlmClassifierPort` left optional in factory) | ▶W4-S4 (wire a classifier) |
| PRD-3.2-capability-profiles | vendor/model, specialties, max tier, success-rate history, cost/latency, concurrency | ✅ | capability_profile + match scoring | — |
| PRD-3.2-atomic-claim | Exactly-one via CAS | ✅ | `routing/src/claim.ts` + `db/claim-repo.ts`, org-scoped | — |
| PRD-3.2-concurrency-limits | per-agent + per-project + same-repo serialization | ✅ | `concurrency.ts` + `canDispatch` | — |
| PRD-3.2-escalation-breaker | failure counter → breaker (N=2) → re-tier / human | 🟡 | Breaker trips to needs_attention; **re-tier/auto-escalate arm reserved for Stage 2+** (not built) | ▶W4-S4 |
| PRD-3.2-mistier-retrain / repo-health-signals | learning loop; optional repo signals | ⬜ | Not built (nice-to-have) | ▶ defer (fork F8) |

### §3.3 Roster / team-of-employees (Wedge 3)
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-3.3-capability-profile-plus-bindings | named agent + identity bindings per platform | ✅ data; 🟡 UI | Bindings modeled; only GitHub provisioned; hire/editor UI not built | ▶W4-S3/S5 |
| PRD-3.3-multiproject-multitool | one agent across many repos/tools | 🟡 | org_agent roster join done; cross-repo deploy UI/flow not built | ▶W4-S5 |
| PRD-3.3-247-cloud-coordination | scheduler, health monitor, restart crashed sessions, escalate | 🟡 | Reaper/sweeper + breaker exist; no standing scheduler/health-monitor/auto-restart loop | ▶W4-S5 |
| PRD-3.3-roster-dashboard | per-agent state/task/throughput/success/cost "your team" | ✅ (read) | `app` roster + monitoring views, real data | — |

### §4 Execution layer (Emdash fork)
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-4-fork-headless / de-electron-* / inherited-capabilities / pin-fork | Headless Emdash fork: worktrees, PTY, secrets backend, sqlite ABI, pinned | ✅ | `packages/execution` over `vendor/emdash` submodule; worktrees + PTY + scrubbed-env spawn + ephemeral HOME | — |
| PRD-4-operator-patterns | lifecycle states; autonomous vs paired (INV/SPIKE human-in-loop) | 🟡 | Lifecycle states present; explicit autonomous-vs-paired mode policy not surfaced | ▶W4-S4 (with multi-vendor) |

### §5 Adapters (the parity gap)
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-5-adapter-contract / -ordering | 4-function contract (identity, intake, status, PR-linkage); Shortcut→GitHub→Linear | 🟡 | Contract uniform; only GitHub implements all four | — |
| **GitHub** PRD-5.2-* | identity (App), intake (issues/PR/review/check_run), write-back, connect | ✅ | The reference. `adapters/github.ts`, `github-app-client.ts`, `github-connect.ts`, status reporter, content source | — |
| **Shortcut** PRD-5.1-* | agent-user provisioning, webhook intake, status-back, stable-token auth | 🟡 | Intake (assignment) + verify + webhook self-register **done**; **write-back gated** (token-model unknown), **mention intake** not built, **content read-client** stubbed (id-only), **connect flow** absent, **provisioning** gated | ▶W3-S2 |
| **Linear** PRD-5.3-* | actor=app identity, AgentSession intake (ack ≤5s/activity ≤10s), activities write-back, delegate semantics | ⬜ | **Nonexistent** — `'linear'` is a reserved enum value only. Full from-scratch adapter required | ▶W3-S3 |
| PRD-5-jira-out-of-scope | No Jira | 🔒 | Correctly excluded | — |

### §6 PM-assistant (advisory)
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-6-pm-{triage,decompose,estimate,suggest-routing,cross-project,standups} | Advisory triage/decomposition/routing-proposals/standups | ⬜ | No backend proposal engine; no `pm-assistant` view (design `pm-assistant.js` exists) | ▶W3-S1 |
| PRD-6-pm-advisory-only | Advisory only; deterministic engine stays binding; never irreversibly mis-assign | ⬜ (constraint) | Must be enforced by design: proposals persisted, human accept/edit/dismiss, never auto-apply | ▶W3-S1 |

### §7 Carry-over / dropped — ✅ (routing, agent-as-member, cloud layer, OAuth, host execution carried; kanban/Jira dropped). No gap.

### §8 Phased delivery — rollup in §0 above.

### §9–11 Recommendations / open questions / risks (binding requirements)
| PRD id | Requirement | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| PRD-9.1-advance-benchmark | Story→reviewed-PR under native identity, one project | ✅ (GitHub) | Met on GitHub | — |
| PRD-11-cost-runaway-ceilings | **per-agent cost ceilings + budget alerts** | ⬜ | `cost_ceiling` stored/edited but **never read for enforcement**; no usage accumulator; no alerts | ▶W3-S5 |
| PRD-11-security-posture | least-privilege scopes, branch protection, credential isolation, **audit logging** | 🟡 | Scopes/branch-protection/cred-isolation ✅; audit **written but not surfaced** | ▶W3-S7 |
| PRD-11-security (deploy isolation, implied) | per-agent OS isolation for untrusted multi-tenant | ⬜ | Container isolation done; **per-agent UID+namespace sandbox not built** (dominant residual) | ▶W4-S1 |
| PRD-10-oq-billing-model | per-agent / per-task / pass-through usage billing | ⬜ (open) | Product decision needed → **Fork F3** | ▶W3-S6 |
| PRD-10-oq-shortcut-api | confirm Shortcut Agent API surface | 🟡 (open) | Drives Shortcut write-back → **Fork F1** | ▶W3-S2 |
| PRD-10-oq-{human-of-record, local-model-location, tos-legal} | accountability mapping; BYO-local residency; per-platform ToS | 🟡 | Partially addressed by org/identity work; confirm at first enterprise customer | ▶ track (not a build slice) |

**PRD-silent items flagged (not omissions — beyond this PRD, already built or to confirm):** OS-level sandbox/namespaces (Wave 4 closes it anyway); multi-tenancy/org-creation/onboarding (built in Wave 2, beyond PRD); audit-log format/retention (no spec — we'll set a sane default in W3-S7).

---

## Part B — Design surface walk (every CD comp)

**Foundation (Group 0)** — ✅ across the board: tokens (light+dark), status/state tokens (glyph+label), tier scale, vendor indicators, iconography, state system (empty/loading/error), a11y foundation, app-shell, components reference. The mandatory CI gates partially exist — verify in W4-S6.

| Design id | Surface | Status | Evidence / gap | ▶ Slice |
|---|---|---|---|---|
| DESIGN-onboarding-* | Onboarding flow (login/welcome/connect/hire/done) | 🟡 | App `onboarding.ts` is a **read-only preview** reflecting real connection state; Connect/Continue gated, no real connect/hire actions | ▶W4-S3 |
| DESIGN-roster-* | Roster (card grid / ops table / grouped) | ✅ (cards) / 🟡 | Real data, states, a11y; density/grouped variants partial; "Add agent" gated | ▶W4-S3 (variants) |
| DESIGN-agent-detail-view | Agent profile (bindings, capability, performance) | ✅ / 🟡 | Real data + live Pause/Resume; Deploy/Edit/Assign/Escalate gated | ▶W4-S3/S5 |
| DESIGN-hire-wizard (+5 steps) | Create-agent + per-platform provision wizard | ⬜ | No `views/hire.ts`; only a disabled onboarding label | ▶W4-S3 |
| DESIGN-routing-inspector | Task detail w/ audience-split (PM/Eng), candidate math, **live log, worktree** | 🟡 | `task.ts` has the decision block + candidate table + PR list; **audience-split toggle, live log stream, worktree view not built** | ▶W4-S3 |
| DESIGN-monitoring-view | Mission-control pipeline + escalations + burn | ✅ / 🟡 | Real data + states; **"Live" is a manual refresh, not a feed** (no SSE/poll) | ▶W4-S3 (live feed) |
| DESIGN-connections-view | Platforms + vendors health | ✅ | Real data (24h webhook counters), states; Manage/Repair gated | — |
| DESIGN-add-connection-flow | Pick platform/vendor + connect/consent steps | ⬜ | No view; Connect buttons are gated stubs | ▶W4-S3 (+ W3-S2/S3 connect backends) |
| DESIGN-settings-* | Org/members/roles · Billing/usage · Flags · Security/audit · Keys | 🟡 (shell) | `settings.ts` is a 4-row "Planned" shell, no data | ▶W3-S7/S8 (data) + W4-S3 (tabs) |
| DESIGN-pm-assistant-view | Advisory off/on; suggestion cards (accept/edit/dismiss) | ⬜ | Not built | ▶W3-S1 |
| DESIGN-error-pages | 404 / 500 / 403 | ⬜ | Designed (`Error Pages.html`); no app routes | ▶W4-S6 |
| DESIGN-marketing-* | Home / Product / Pricing / Security / Docs / Legal | ⬜ | Designed in `design-system/`; `website/` exists but parity unverified | ▶ Fork F7 (scope) |
| DESIGN-gate-{aa-contrast,hardcoded-color,status-not-color,no-ai-mention} | Mandatory CI guards | 🟡 | no-ai-mention + boundary/org-scoping guards exist; **AA-contrast + hardcoded-color + status-not-color guards** not confirmed wired | ▶W4-S6 |

---

## Part C — Slice plan (the build)

Same flow per slice: **architect → slice → adversarial panel → merge on green**, forks surfaced with a recommendation, reported at every merge. Each wave fronts its locked decisions.

### WAVE 3 — remaining PRD surfaces

| Slice | Scope | Closes | Depends on |
|---|---|---|---|
| **W3-S1 PM-assistant** | Advisory proposal engine (triage / decomposition / routing-proposal / standup) persisted as **proposals** (never auto-applied) + `pm-assistant` view (off-state hero + on-state suggestion cards, accept/edit/dismiss) + inline proposals where the designs show them | PRD-6-*, DESIGN-pm-assistant-view | routing engine (done) |
| **W3-S2 Shortcut parity** | Resolve token model (Fork F1) → write-back (comment + state move + PR link) + mention intake + real REST content read-client + workspace→org connect flow + agent-user provisioning | PRD-5.1-*, Shortcut gaps | Fork F1 |
| **W3-S3 Linear adapter** | Full actor=app adapter: verifier (HMAC + replay window), AgentSession intake (ack ≤5s / activity ≤10s), GraphQL content source, activities write-back, OAuth connect flow, provisioning, `main.ts` wiring (flag-off until verified) | PRD-5.3-* | Fork F6 |
| **W3-S4 Usage metering** | Proxy SSE-aware usage tee (non-buffering) + HTTP-aware bridge stamping `X-Tasca-Task-Id` + `usage_event` ledger (task + principal + tokens + cost) | PRD-3.2 cost field, metering | Fork F2 |
| **W3-S5 Cost ceilings + alerts** | Read `cost_ceiling` against the W3-S4 ledger; per-agent/per-task budget gate in dispatch; budget-alert emission | PRD-11-cost-runaway-ceilings | W3-S4 |
| **W3-S6 Billing (Stripe)** | Usage-based billing + seats per the metering ledger; pricing surface real | PRD-10-oq-billing-model, DESIGN-settings-billing | W3-S4, **Fork F3** |
| **W3-S7 Audit surfacing** | `/api/audit` read endpoint (org-scoped, paginated, filterable) + Security settings tab (least-privilege scopes + immutable agent-action log) | PRD-11-security (audit), DESIGN-settings-security | audit write (done) |
| **W3-S8 API-key management** | Vendor-key add/rotate/revoke surface + `keys` settings tab (masked, rotation age, state) | DESIGN-settings-keys, api-key gap | — |

### WAVE 4 — deepest security gate + production hardening

| Slice | Scope | Closes | Depends on |
|---|---|---|---|
| **W4-S1 Per-agent sandbox** | Separate-UID + PID/mount/net namespace jail per agent dispatch (bwrap/nsjail/per-dispatch sidecar — Fork F5); only task worktree bind-mounted; per-agent tmpfs HOME; per-agent default-deny egress; `/proc hidepid=2` | PRD-11-security (deploy), the dominant residual | Fork F5 |
| **W4-S2 Scrub regression (M1)** | The await-free env-scrub regression test flagged Open in the security review | Security-Review M1 | — |
| **W4-S3 Design surfaces → real** | `hire` wizard, `add-connection` flow, routing-inspector audience-split (+ live log + worktree), monitoring live feed (SSE/poll), full Settings tabs, onboarding real actions — every CD comp wired to real data + flagged-on where the PRD says ship | DESIGN-hire/add-connection/routing/monitoring/settings/onboarding | W3 connect/provision backends |
| **W4-S4 Multi-vendor + BYO-local** | Prove an OpenAI agent + a local-model agent (Ollama/LM Studio/MLX via Emdash CLI registry) end-to-end; wire a concrete tier classifier; re-tier/auto-escalate breaker arm; autonomous-vs-paired mode policy | PRD-8-stage3, PRD-3.2-classifier, escalation | execution (done) |
| **W4-S5 Roster management (Stage 4)** | Roster CRUD + capability-profile editor (UI), cross-repo deploy, standing cloud scheduler/health-monitor/auto-restart | PRD-8-stage4, PRD-3.3-247 | W4-S3 |
| **W4-S6 a11y + states + gates sweep** | Error pages (404/403/500) as routes; verify error/empty/loading on every view; a11y audit across all; wire the mandatory design CI gates (AA-contrast, hardcoded-color, status-not-by-color) | DESIGN-error-pages, DESIGN-gate-* | all views |

### Out of the two-wave frame — surfaced for your call
- **Marketing site** (DESIGN-marketing-*) — designed in full; `website/` exists but parity unverified. **Fork F7.**
- **Mis-tier retraining / repo-health signals** (PRD-3.2 nice-to-haves) — **Fork F8** (defer recommended).

---

## Part D — Forks (each with my recommendation — your call before the relevant slice)

- **F1 — Shortcut write-back token model** (W3-S2). *Recommendation (matches your brief):* chase the Shortcut team's token-model reply once more; if still unanswered, build against documented intake + **best-effort write-back** (REST v3 with a per-persona token — the conservative reading; v3 has no act-as header, so attribution = one token per persona), behind a flag, with `identity.credential_ref` absorbing either eventual resolution. **Pre-locked by your Wave-3 brief — confirm.**
- **F2 — Usage metering mechanism** (W3-S4). *Recommendation:* build the **designed** hook — non-buffering SSE `usage` tee in the proxy + HTTP-aware bridge stamping `X-Tasca-Task-Id`, persisted to a `usage_event` ledger. Keeps attribution at the credential boundary; the only risk is the tee must not break streaming purity (assert it). Alternative (post-hoc vendor usage-API reconciliation) rejected: coarser, no per-task attribution.
- **F3 — Billing model** (W3-S6). *Recommendation:* **meter first, bill second** — usage-based (pass-through vendor cost + CI minutes) + per-seat, via Stripe metered billing. But this is a **pricing decision that's yours** — I'll implement once you pick per-agent/month vs per-task vs pass-through. **Needs your decision.**
- **F4 — PM-assistant depth** (W3-S1). *Recommendation:* advisory-only, LLM-generated proposals **persisted** with accept/edit/dismiss; the deterministic routing engine + atomic claim stay the binding source of truth; a PM-assistant error can never mis-assign. Dedicated view + inline proposals per the designs. **Pre-locked by your brief — confirm.**
- **F5 — Sandbox mechanism** (W4-S1). *Recommendation:* **per-dispatch ephemeral sidecar container** (clean namespaces + UID per dispatch, composes with the existing runner topology) over in-process `bwrap`/`nsjail` — easier to reason about for multi-tenant and matches the deploy spec's "per-dispatch sidecar" option. Decide at W4-S1 architect step.
- **F6 — Linear Developer-Preview risk** (W3-S3). *Recommendation:* build the full adapter against the documented contract, **flag-off** until verified against a real Linear workspace; isolate Preview-volatile bits (AgentSession event shapes) behind the contracts schema so changes are one-file.
- **F7 — Marketing site scope.** *Recommendation:* treat as a **separate Wave 5 track** (or explicitly out of scope for "full"). It's design-complete but product-orthogonal. **Needs your decision: in or out of "full."**
- **F8 — Mis-tier retraining / repo-health signals** (PRD nice-to-haves). *Recommendation:* **defer** — log mis-tier/escalation telemetry now (cheap), build the retraining loop post-Wave-4 once there's real signal.

---

## Part E — Ongoing

- **Reconciliation pass is due** (5a–5d is a 4-PR batch; §10 cadence). Known drift to fix: the org-scoping ADR (`docs/decisions/2026-06-10-org-scoping-app-level.md`) still says "3c — pending". Fold a docs-reconciler pass into Wave-3 kickoff.
- **Report at every merge**; each wave fronts its locked decisions before the big diff.

---

## Part F — Definition of done (sign-off checklist)

"Full" = every row below is ✅:

- [ ] **PM-assistant** advisory engine + view + inline proposals (W3-S1)
- [ ] **Shortcut** parity: write-back + mention intake + content read-client + connect + provisioning (W3-S2)
- [ ] **Linear** full adapter to GitHub-parity (W3-S3)
- [ ] **Usage metering** ledger live (W3-S4); **cost ceilings enforced + budget alerts** (W3-S5)
- [ ] **Billing** real (W3-S6, pending F3)
- [ ] **Audit** surfaced via API + Security tab (W3-S7); **API-key management** (W3-S8)
- [ ] **Per-agent UID + namespace sandbox** (W4-S1) + scrub regression (W4-S2) → safe for untrusted multi-tenant
- [ ] **Every CD comp** wired to real data + flagged-on where the PRD ships it; **hire / add-connection / routing-audience-split / monitoring-live / settings-tabs / onboarding-real** (W4-S3)
- [ ] **Multi-vendor + BYO-local** proven end-to-end; concrete classifier; re-tier breaker arm (W4-S4)
- [ ] **Roster management**: CRUD + capability editor + cross-repo deploy + scheduler/health-monitor (W4-S5)
- [ ] **Error pages + a11y + design CI gates** across all views (W4-S6)
- [ ] Forks resolved: F1 ✓ F2 ✓ F3 ✓ F4 ✓ F5 ✓ F6 ✓ F7 ✓ F8 ✓

> Sign-off requested on: (1) this gap analysis as the definition of done, (2) the slice plan / wave ordering, (3) the **decision forks F3 (billing model)** and **F7 (marketing in/out)** — the two that need your product call before their slices. F1/F4 are pre-locked by your brief (confirm); F2/F5/F6/F8 carry my recommendation and can proceed unless you object.
