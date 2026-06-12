# Tasca — Execution Roadmap v3 (Single-Tenant OSS first, Multi-Tenant quarantined)

> **Status:** decided 2026-06-12. The canonical **sequencing** source of truth.
> **Supersedes the sequencing** of [`Execution-Roadmap-v2.md`](Execution-Roadmap-v2.md). **v2 is retained** as the **spec for the deferred multi-tenant / hosted tier** (the quarantined layer). [`PRD-Completion-Gap-Analysis.md`](PRD-Completion-Gap-Analysis.md) (#259) stays the **engine definition-of-done**.
> **Build nothing from this doc until the maintainer confirms the restructured shape.**

---

## 0. The pivot in one paragraph

**The product is single-tenant, multi-project, open-source, Dockerized.** One team (the **instance**) runs many **projects**, each a platform workflow (GitHub/Shortcut/Linear), with their own agents on their own infra and their own vendor keys (BYOK = **self-hosted config**, the operator's keys). Ship this first for **adoption**. **Multi-tenant SaaS is a LATER hosted tier on top** (open-core). All multi-tenant work is **preserved but quarantined** so the OSS codebase stays **100% clean** — multi-tenant is an **additive layer**, never scattered `if(multiTenant)` branches or commented-out cruft.

This is the convergence of the session's refinements: **BYOK → projection → projects → single-tenant OSS** is now one coherent product.

---

## 1. The open-core boundary (the precise cut)

**The good news:** almost nothing needs to be *removed*. The multi-tenant *foundation* — `org_id` partitioning everywhere + the org-scoping CI guard — is **clean data-partitioning hygiene**, not "multi-tenant cruft." It **stays** unconditionally (and lets the hosted tier re-expand later with no migration). What's actually multi-tenant is the **exposure of multiplicity**, and that surface is **small**.

| Concern | OSS core (stays on `main`) | Multi-tenant addition (quarantined → hosted tier) |
|---|---|---|
| `org_id` columns + org-scoping guard | ✅ **Stable internal partition key**, single value (the instance) | re-expanded to N tenants |
| Org resolution (`resolveOrg`/`getActiveOrg` seam, `DEFAULT_ORG_ID`) | ✅ resolves to the **one instance org** (no per-user active-org) | resolves **per-request** to the caller's tenant |
| 3-role model (owner-admin / admin / user) | ✅ **within the instance** | within each tenant |
| Members + invites | ✅ add humans **to the instance** | add humans to a tenant |
| BYOK vault (3.5-A, shipped) | ✅ **the operator's own keys** (self-hosted config) | custodial per-tenant keys + the custodial threat model |
| Projects (instance → projects) | ✅ **central** — one team, many platform workflows | unchanged (tenant → projects) |
| Projection board (D8) | ✅ | unchanged |
| Workflow-as-strategy adapters | ✅ | unchanged |
| Agent creation, metering | ✅ (metering = operator's own cost visibility) | + billing/Stripe |
| **Org create / switch / list (multiplicity)** | ❌ **gated off / not wired** in OSS | ✅ the hosted tier's org-switcher |
| **Vanity URL / slug / `/o/<slug>`** | ❌ **dropped from OSS** | ✅ hosted tier |
| **Namespace sandbox (W4-S1)** | 🔶 **future hardening, NOT a blocking gate** (operator's own trust boundary) | ✅ **blocking gate** (untrusted cross-tenant execution) |
| Billing / Stripe | ❌ | ✅ hosted-tier monetization |

**The `org_id` cut — confirmed clean.** Keep `org_id` as the **stable internal key** with a **single default org** (the instance, anchored on the existing `DEFAULT_ORG_ID` / a configured instance org id). The OSS product **never exposes** org-switching, cross-tenant, or multi-org. The `resolveOrg` seam — which already returns "the active org or null" — is wired in OSS to return the **one instance org** for every authenticated user. The hosted tier swaps that one function to resolve per-request. **No schema change, no scattered branching — one seam.**

---

## 2. Quarantine mechanism — recommendation

**Recommendation: OSS-clean-now; create the MT track only when hosted-tier work begins.** Concretely:

1. **Make `main` the clean single-tenant OSS product now.** Wire `resolveOrg` to the single instance org; **gate off / unwire the 3 multi-org-exposure routes** (`create-org`, `switch-org`, `list-orgs`) behind the composition root (they simply aren't registered in the OSS server); drop the unbuilt vanity/slug plan.
2. **Preserve multi-tenant as three things** — no parallel track to maintain: **(a)** the `org_id` partitioning + scoping discipline that *stays* on `main`; **(b)** the **v2 roadmap** as the exposure-surface spec; **(c)** git history of the already-built org-api multi-org routes.
3. **Create the MT branch _or_ module when the hosted tier is actually built** — not before. At that point the cleanest form is a **`@tasca/multi-tenant` module wired only in the hosted composition root** (the OSS build never imports it): a per-request org resolver + the multi-org routes + billing. The OSS `main` never carries the complexity.

**Why not a long-lived branch *now*:** a parallel branch drifts and every OSS change needs forward-porting — pure tax for a solo maintainer while no MT-specific code is being actively written. The MT *exposure* is small and additive; it re-attaches cleanly at the `resolveOrg` seam + composition root when needed.

**Alternatives (your call — a genuine architecture fork):**
- *Long-lived MT branch off clean `main`* — simplest mental model; costs rebase tax. (Your initial lean.)
- *`TASCA_MULTI_TENANT` flag* — one composition-root decision (not scattered), but ships dormant MT code in the OSS binary (less "100% clean" by the literal bar).

**My recommendation: option (the staged module) above** — clean OSS now, MT re-attached as a module when the hosted tier starts. **Confirm which you want.**

---

## 3. Instance identity reshape (3.5-B)

The "org" concept **collapses to "the instance"** in OSS. 3.5-B becomes:

- **Instance config** — a name + "the one team." **No** vanity URL, **no** slug, **no** multi-org, **no** org-switching.
- **3 roles** (owner-admin / admin / user) operating **within the instance** (unchanged capability matrix from v2 §1.2).
- **Invites** — add humans to the instance (the v2 signed-token + OAuth model, Resend email).
- **The single-org cut** — wire `resolveOrg` → the instance org; unwire `create/switch/list-org`.

(v2's D4 slug/vanity-URL is **dropped from OSS** → hosted tier.)

---

## 4. Revised Wave 3.5 (single-tenant OSS shape)

> Build order. Each: architect → slice → adversarial panel → merge on green. Org = the instance throughout.

- [x] **3.5-A — BYOK vault** (shipped #279) — reframed as **self-hosted config**: the operator's own vendor keys for their instance. (Not custodial-customer-credentials; the custodial threat framing moves to the hosted tier.)
- [ ] **3.5-A.2 — BYOK consumer wiring** (in progress) — single-tenant: per-instance classifier + agent resolve **the instance's** vault key per-task; delete the server-key fallback; no-key → fail-closed with the honest "no API key configured — ask an admin" UX. `Closes #N` shipped (#281). DoD: metering re-test populates `usage_event` (classifier + agent).
- [ ] **3.5-B — Instance identity + roles** — instance config (name/team) + 3 roles + the single-org cut (resolveOrg→instance; unwire multi-org routes). **No** vanity/slug/multi-org.
- [ ] **3.5-B.2 — Project abstraction** — `org→project` becomes **instance→project**. Central to OSS: one team, many projects, each a platform workflow. Defines the project entity, project-scoped tasks/agents/connections, the project switcher (within the instance).
- [ ] **3.5-C — Agent creation (project-aware)** — create `{name, vendor/model, tier/capability}`, user+, **scoped to a project**; model pinned at spawn (#3). Per-org Elvis seed → per-instance creation.
- [ ] **3.5-D — Invites (within the instance)** — owner-admin/admin invite by email → signed-token + OAuth → joins the instance with a role. Resend (server-level key).
- [ ] **3.5-E — Metering (instance BYOK key)** — agent + classifier on the instance key → `usage_event`; the operator's own cost/usage visibility (no billing).

Then:
- [ ] **Platform breadth** — Shortcut, Linear via the **projection model** + **workflow-as-strategy** adapters + **manual-agent-token-in-vault** (the operator stores the platform agent token in the same vault; no custodial concern — it's their token). Each adapter projects native state, links work via native PR/branch mechanisms, no parallel state machine.
- [ ] **Dockerization (first-class deliverable, §5)**.
- [ ] **OSS readiness** — README/quickstart, LICENSE, clean default config, `docker run` story, contribution docs.

---

## 5. Dockerization — a first-class slice

A real deliverable, not an afterthought:
- [ ] **Clean image** — single-container (or a minimal `docker-compose` with Postgres) that runs the worker + serves the app.
- [ ] **Fully env-configured** — every knob via env (`DATABASE_URL`, `TASCA_SECRET_STORE_KEY`, OAuth creds, GitHub App, Resend, `ANTHROPIC`/vendor handled via the in-app BYOK vault — **no vendor key in the image/env**), with **sane defaults**.
- [ ] **Easy `docker run`** — a documented one-liner / compose-up that boots a working instance; first-run bootstraps the owner-admin.
- [ ] **Docs** — a self-hosting guide (env reference, OAuth/GitHub-App setup, first-login → vault key → first project → first agent).

---

## 6. Deferred to the hosted / SaaS tier (quarantined)

Explicitly **out of the OSS product**, preserved per §2 for the hosted tier:
- Multi-org (multiple tenants per deployment), org creation/switching/listing, the org-switcher UI.
- Cross-tenant **isolation** as a blocking concern; the **W4-S1 namespace sandbox as the critical capstone** (in OSS it's *future hardening* — the operator's own trust boundary).
- Vanity URLs / slugs / `/o/<slug>` routing.
- The **custodial-key threat model** (OSS keys are the operator's own, not custodial).
- Billing / Stripe (W3-S6), seat/overage pricing.

---

## 7. Design decisions for your confirmation

1. **Open-core boundary (§1)** — `org_id` stays as a stable internal key with a single instance org; OSS exposes no multiplicity. **Confirm this is the clean cut.**
2. **Quarantine mechanism (§2)** — recommendation: OSS-clean-now + preserve-as-partitioning/spec/history + create the MT **module** when the hosted tier starts (vs a long-lived branch now, or a dormant flag). **Pick one.**
3. **3.5-B reshape (§3)** — instance config + roles + invites, **no** vanity/slug/multi-org. **Confirm.**
4. **W4-S1 sandbox** — demoted from blocking capstone to future hardening for OSS. **Confirm.**
5. **Instance-org anchor** — reuse `DEFAULT_ORG_ID` ('org_default') as the instance org, or mint a configured instance org id at first boot? *Recommendation:* a first-boot-provisioned instance org (cleaner than the grandfather default), `resolveOrg` returns it for all users. **Confirm.**
