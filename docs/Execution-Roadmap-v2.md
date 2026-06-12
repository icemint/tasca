# Tasca — Execution Roadmap v2 (BYOK + True Multi-Tenancy)

> **Status:** decided 2026-06-12. The canonical **sequencing** source of truth for "100% PRD".
> **Supersedes** the *ordering* in [`PRD-Completion-Gap-Analysis.md`](PRD-Completion-Gap-Analysis.md) (#259) — that doc remains the **engine definition-of-done** (section-by-section PRD + design coverage). This doc re-orders what's left around two locked architecture decisions and inserts a new milestone (**Wave 3.5**) *before* platform breadth.
> **Build nothing from this doc until reviewed.** Each slice carries a definition-of-done, dependency order, and the standing org-scoped / role-gated / fail-closed requirements.

---

## 0. The two decisions in one paragraph each

**BYOK + truly multi-tenant.** The server holds **no vendor API key**. Every org supplies its own vendor key(s) (Anthropic now, OpenAI later), stored **encrypted at rest per-org**. **Every** LLM call — agent execution *and* the coordination classifier (routing/triage/decomposition) — runs on the **org's** key. No key configured → **heuristic routing only** and **agents can't run** until a key is added. Metering is a property of **BYOK agent execution** (the tee meters the org-key path), so the earlier server-key in-process metering (Option A) is **rejected and will not be built**.

**Org identity + a 3-role model.** Each org has a **name** (display) + **slug** (URL-safe, derived, unique) + a **path-based vanity URL** `app.tasca.dev/o/<slug>` (path routing, **not** subdomains). Three roles replace the 5b minimal matrix: **Owner-admin** (everything incl. delete org; multiple allowed), **Admin** (everything except delete org), **User** (no governance, but **full CRUD on agents + tasks**). The boundary: **Admin = governance** (settings, people, keys, org existence); **User = work** (tasks + agents — agents are work tools, so Users own them).

The work to make an org self-sufficient (identity/roles → keys → agents → members → metered runs) is sequenced as a new milestone, **Wave 3.5: Tenant Self-Sufficiency**, *ahead of* platform breadth (Shortcut/Linear).

---

## 1. Core decisions (locked 2026-06-12)

### 1.1 BYOK + metering

| # | Decision | Binding consequence |
|---|----------|---------------------|
| **D1** | **BYOK only.** Server holds no Anthropic key. Per-org encrypted vendor keys. All LLM calls (agent + classifier) on the org key. | `ANTHROPIC_API_KEY` as a server **token source** is removed. The coordination LLM client stops being a single boot-time singleton and becomes **per-org, resolved per task**. |
| **D2** | **No-key degradation.** No key → heuristic routing only (no LLM classifier); agents cannot run until a key is added. | Heuristic fallback is the **load-bearing** no-key path. LLM classification is a **BYOK-gated enhancement**. A keyless org's dispatch fails **closed** ("no vendor key") — never a breaker burn, never a crash. |
| **D3** | **Metering = a property of BYOK execution.** | **Reject Option A** (in-process *server-key* metering). The proxy/bridge/tee *plumbing* is reused, injecting the **org's** key (decrypted per task) — built as 3.5-A + 3.5-E, not before. |

### 1.2 Org identity + roles (supersedes the 5b minimal matrix)

| # | Decision | Detail |
|---|----------|--------|
| **D4** | **Org identity** = name + slug + path-based vanity URL. | `name` (display, editable) · `slug` (URL-safe, **derived** from name, **unique** org-wide) · vanity `app.tasca.dev/o/<slug>` via **path routing, NOT subdomain**. Slug collisions resolved deterministically (slugify + numeric suffix on conflict). |
| **D5** | **Three roles** (capability matrix below). | First registrant = **owner-admin**. **Multiple owner-admins** allowed; any can delete the org or promote others to owner-admin. |
| **D6** | **Agent creation scope** = name + vendor/model + tier/capability. | **No** system-prompt / persona authoring yet. The chosen model is **pinned at spawn** (config == runtime — folds in #3). Creatable by **User and above** (agents are work). |

**Role capability matrix (D5):**

| Capability | Owner-admin | Admin | User |
|------------|:----------:|:-----:|:----:|
| Delete org | ✅ | ❌ | ❌ |
| Promote/demote owner-admin | ✅ | ❌ | ❌ |
| Org settings (name/slug/…) | ✅ | ✅ | ❌ |
| Members CRUD (invite / role / remove) | ✅ | ✅ | ❌ |
| Vendor API keys CRUD | ✅ | ✅ | ❌ |
| **Agents CRUD** (create/edit/delete, models/tiers) | ✅ | ✅ | **✅** |
| **Tasks / operations CRUD** | ✅ | ✅ | **✅** |

**The boundary:** *Admin = governance* (settings, people, keys, org existence). *User = work* (tasks + agents). Agents are work tools → Users own them; keys / people / org are governance → Admins own them.

**UX-honesty rule (binding):** a **User can create an agent but cannot add a key.** An agent created in a **keyless org** must show **"No API key configured — ask an admin"**, not silently fail to run. The keyless state is surfaced, never a silent dead-end.

**Endpoint gating (binding):** every endpoint is **role-gated server-side** (gate the endpoint, not just the button), **fail-closed**, and **no existence-leak on cross-tenant** access — a non-member hitting `/o/<otherslug>` or another org's resource gets a **404 (not 403)** so org existence isn't disclosed.

> **Deployment-posture gate (honest constraint):** Wave 3.5 makes Tasca *self-serve* multi-tenant (orgs onboard themselves). Running **multiple untrusted orgs' agents on shared infra** is only safe behind the **W4-S1 per-agent UID + namespace sandbox** (the security capstone). Until W4-S1 lands, the safe bar stays **trusted / limited-tenant**. Wave 3.5 ≠ "open the public doors"; W4-S1 is that gate.

---

## 2. NEW MILESTONE — Wave 3.5: Tenant Self-Sufficiency

**Goal:** an org admin lands in the app and reaches a working AI dev team **entirely self-serve** — own identity, own roles + people, own vendor key, own roster — with spend **metered**, no operator, no server key. Sequenced **before** platform breadth.

**Build order:** `3.5-B` role model + identity is the **governance foundation that gates every endpoint**, so it lands first (or co-first); `3.5-A` is the **keystone for running** (nothing executes without a key). Then `3.5-C` (agents) + `3.5-E` (metering) and `3.5-D` (invites) in parallel.

```
3.5-B  org identity + 3-role model   (governance foundation — gates every endpoint, supersedes 5b)
   │
3.5-A  BYOK credential mgmt           (keystone for RUNNING; admin-gated per 3.5-B)
   │
   ├── 3.5-C  agent creation wizard   (User+; + #3 model-pin; runs only with a key → 3.5-A)
   ├── 3.5-E  metering (BYOK tee)     ("S4b done right"; needs 3.5-A's per-task key injection)
   └── 3.5-D  member invites          (owner-admin/admin; needs 3.5-B roles) — parallel
            │
            ▼
        #4 agent-state-source fix (small; in/after 3.5)
```

---

### 3.5-A — BYOK vendor credential management  ·  *keystone for running*

**W3-S8 (API-key management) pulled forward and made foundational.** Without it nothing runs under BYOK.

**Scope:** an **admin+** (per the matrix; Users **cannot**) inputs a vendor key (Anthropic first; vendor-parameterized for OpenAI). Stored **encrypted at rest, per-org**. Decrypted and **injected per-task** into three consumers: agent execution, the coordination classifier, the metering tee.

**Encryption-at-rest:** **AES-256-GCM envelope.** Server-held master key (`TASCA_SECRET_STORE_KEY`, already in the deploy spec) is the KEK; each org vendor key is sealed (store IV + auth tag). Plaintext exists **only** transiently at injection — never persisted, never logged, never echoed. **Custodial BYOK, not zero-knowledge** (the server must decrypt to inject into runs); stores only ciphertext. New table `org_vendor_credential` (org-scoped, in `TENANT_TABLES`): `{org_id, vendor, ciphertext, iv, auth_tag, key_fingerprint, status, created_by, created_at, last_validated_at}`; the UI shows only the **fingerprint**.

**Validate-on-input:** a **cheap live vendor call** before save (authenticates + model access); reject with a clear, non-leaky message; scheduled re-validation stamps `last_validated_at` so a silent revoke surfaces.

**Mid-task rotation / revocation:** **rotation** → in-flight runs finish on the key injected at spawn; new runs use the new key (no mid-run swap). **Revocation / a key failing mid-run** → the run fails-soft to `needs_attention` "vendor credential rejected" (NOT a breaker burn); the classifier degrades to heuristic + the loud `onClassifierError` log (shipped #276). **No key at dispatch** → fail closed: `needs_attention` "no vendor key configured" (no breaker, no crash) — and per the UX-honesty rule, surfaced in-app.

**Architecture change forced:** the coordination LLM client becomes **per-org**, resolved per task from the org's decrypted key (small per-org client cache, bust on rotation). `estimateTier`'s classifier + PM proposers get the org-keyed client; absent a key → none (heuristic path).

**Definition of done:**
- [ ] `org_vendor_credential` table (org-scoped, required-`orgId`, in `TENANT_TABLES`, CI org-scoping guard updated).
- [ ] Admin+ create/replace/delete key endpoints, CSRF, **server-side role gate** (Users blocked).
- [ ] AES-256-GCM envelope under `TASCA_SECRET_STORE_KEY`; plaintext never persisted/logged/echoed; fingerprint-only display.
- [ ] Validate-on-input + scheduled re-validation.
- [ ] Per-org LLM client (classifier + proposers) wired to the org key; **server key path deleted** (proxy master-key injection + boot-time classifier client removed).
- [ ] Rotation/revocation/no-key policies implemented + **tested** (no-key → fail-closed; revoked-mid-run → reason, no breaker).
- [ ] Settings → "Vendor keys" UI: input + status + fingerprint, admin-gated with honest non-admin disabled state.
- [ ] Adversarial security panel: secret hygiene (no plaintext leak path), org isolation (A can never read/use B's key), fail-closed under every error.

---

### 3.5-B — Org identity + 3-role model  ·  *governance foundation (supersedes 5b)*

Redefines org membership/RBAC from 5a/5b's owner/admin/member to the **owner-admin / admin / user** matrix (D5), adds org **identity** (name/slug/vanity URL), and re-gates every endpoint.

**Scope:** org **name** (editable) + **slug** (derived, unique, collision-suffixed) + **path-based** `/o/<slug>` routing (the app + worker resolve the org from the path, then **verify membership fail-closed with no existence leak**). The 3-role capability matrix, **multiple owner-admins**, promote/demote, last-owner-admin protection (an org can't be left with zero owner-admins). The **User-can-CRUD-agents** boundary wired into the agent + task endpoints' gates.

**Definition of done:**
- [ ] Role model migrated to owner-admin / admin / user; existing memberships mapped (owner→owner-admin, admin→admin, member→user) with the **new** capability split enforced server-side.
- [ ] Org `slug` (unique, derived, collision-handled) + `name`; `/o/<slug>` path routing resolves the org and **verifies membership fail-closed (404 on non-member / unknown slug — no existence leak)**.
- [ ] Every mutating endpoint re-gated to the matrix (governance = admin+, work = user+); **gate on the endpoint, not the button**; CSRF.
- [ ] Multiple owner-admins; promote/demote; **last-owner-admin guard** (cannot remove/demote the final owner-admin).
- [ ] Settings → "Organization" UI (name/slug/vanity URL) + role management, with honest per-role disabled states.
- [ ] Adversarial panel: cross-tenant isolation (no existence leak; 404 not 403), no self-privilege-escalation (a user/admin can't grant themselves a higher role), last-owner-admin can't be stranded.

**Dependencies:** extends shipped 5a/5b. **Foundational** — its role model gates 3.5-A/C/D, so land its gates **before/with** those.

---

### 3.5-C — Agent creation wizard

The disabled **"Add agent"** (left gated in W4-S3) becomes real: orgs **build their own roster**; the global *Elvis* seed becomes **per-org creation**. Creatable by **User and above** (agents are work).

**Scope:** create `{ name, vendor/model, tier/capability }` (full routing control); **no** persona/system-prompt. The agent gets its **native platform identity** (the GitHub service-user binding — Wedge-1). Model **pinned at spawn** (#3: `--model`/`ANTHROPIC_MODEL` = the agent's model → config == runtime; Roster card label truthful). Per the UX-honesty rule, a User creating an agent in a keyless org sees **"No API key configured — ask an admin."**

**Definition of done:**
- [ ] Agents **org-owned** (created by the org, org-scoped); identity-binding created per agent.
- [ ] Create/edit/delete endpoints gated **User+** (server-enforced per 3.5-B); validate name-unique-in-org, supported vendor/model, valid tier/capability.
- [ ] **Model pinned at spawn** (execution model == configured == routing capability — #3 fixed).
- [ ] "Add agent" wizard UI (name → vendor/model → tier/capability), User+ enabled; keyless-org "ask an admin" state.
- [ ] A created agent assigns + routes + **runs on the org key** (needs 3.5-A).
- [ ] Adversarial panel: org isolation (no cross-org agent visibility/assignment), routing integrity (declared model == run model).

**Dependencies:** **3.5-B** (the User role + agent-CRUD gate) and **3.5-A** (to *run*; creation works keyless but surfaces "no key").

---

### 3.5-D — Member invites  ·  *parallelizable*

Invite a human teammate **by email** → joins the org with a **role**. **Owner-admin / admin only.**

**Definition of done:**
- [ ] Invite by email (existing user → immediate membership; non-user → pending invite consumed on first login). Admin+ gated, server-enforced, CSRF.
- [ ] Role assignment at invite (owner-admin / admin / user); last-owner-admin protection.
- [ ] Settings → "Members" UI: list + invite + role change + remove, admin-gated with honest disabled states.
- [ ] Adversarial panel: org isolation (invite only into your own org; no self-escalation), fail-closed on a stale/forged invite token.

**Dependencies:** **3.5-B** (the role model). Independent of A/C/E.

---

### 3.5-E — Metering, correctly ("S4b done right")

Agent **and** classifier run on the **org key** → `usage_event` per org via the tee, **sourced from BYOK**. **Replaces** the rejected server-key Option A.

**Scope:** reuse the proxy/bridge/**tee** plumbing (the SSE-aware usage extractor already built), injecting the **org's** decrypted key per task; **no server key**. The tee records `usage_event{org_id, task_id, source}` for agent calls; the per-org classifier records its own usage (S4a path, org-keyed). Add **per-org usage visibility** (feeds the later Billing panel).

**Definition of done:**
- [ ] Agent execution traverses the tee with the **org key** per task → `usage_event source='agent'` per org. (Topology decided at design time — but the **key is the org's**, never a server key.)
- [ ] Classifier usage (`source='classifier'`) recorded per org under the org key.
- [ ] Per-org usage summary read (org-scoped SUM by source) for the Settings usage panel.
- [ ] CAS-idempotent (ON CONFLICT on the response id); fire-and-forget; metering never blocks/delays a run.
- [ ] Adversarial panel: always-correct org attribution (no cross-org bleed under concurrency), no key in any log/usage row, tee can't corrupt/stall the stream (re-prove under BYOK injection).

**Dependencies:** **3.5-A** (the tee needs the org key to inject + meter).

---

## 3. Folded-in correctness fixes

| Item | Disposition |
|------|-------------|
| **Stabilization slice** (S4a classifier loudness + unmetered-direct-mode WARNs + #2 no-changes terminal handling) | **Shipped — PR #276 (`5af012c61`)**, merged **independent** of this restructure. The WARNs + loud `onClassifierError` stay valid under BYOK (they now signal a missing/invalid *org* key). |
| **#3 model-pinning** | **Absorbed into 3.5-C** (pin the chosen model at spawn; config == runtime). |
| **#4 agent-state-source** (`agentJson.state` = claimed-presence not task-status, `read-api.ts:147`) | **Small correctness fix**, scheduled **in or right after Wave 3.5** (derive `agent.state` from the claimed task's status so Roster and Monitoring agree). |
| **Server-key removal** | Part of **3.5-A** DoD (delete the `ANTHROPIC_API_KEY` token-source path). |

---

## 4. Re-sequenced remainder (after Wave 3.5)

> Top-to-bottom = build order. Each carries the standing org-scoped / role-gated / fail-closed discipline + the architect → slice → adversarial-panel → merge flow.

### Phase P1 — Platform breadth
- [ ] **W3-S2 Shortcut** — intake now; **write-back deferred** on the F1 token model (`identity.credential_ref` absorbs the resolution).
- [ ] **W3-S3 Linear** — full adapter, flag-off, against the documented contract.

### Phase P2 — Money (on BYOK metering, 3.5-E)
- [ ] **W3-S5 cost ceilings + budget alerts** — enforce per-org against the `usage_event` ledger.
- [ ] **W3-S6 billing / Stripe** — **per-agent-seat base + usage overage** over BYOK metering; Settings "Billing & usage" panel (consumes 3.5-E's per-org usage read).

### Phase P3 — Operability
- [ ] **W3-S7 audit surfacing** — `/api/audit` (org-scoped) + the Security/audit view.
- [ ] **Remaining W4-S3 surfaces** — routing audience-split + live log + worktree, monitoring live feed/depth, full Settings tabs (Organization [3.5-B], Vendor keys [3.5-A], Members [3.5-D], Billing & usage [P2], Security/audit [P3]).
- [ ] **Manage / Repair connections + the connection-transfer integrity rule** — a connection transfer/rebind must, in **one transaction**, rebind the connection **and** resolve the workspace's in-flight tasks (retire/migrate — never leave them, which bricked boot on the global `(platform, story)` unique). **Plus the `applySchema` dupe-preflight guard** (detect duplicate `(platform, external_story_id)` and fail with a legible, actionable error instead of an opaque index-build crash).

### Phase P4 — Security capstone (gate for untrusted multi-tenant)
- [ ] **W4-S1 per-agent UID + PID/mount/net namespace sandbox** — the dominant residual; **required before untrusted/public multi-tenant** (see the deployment-posture gate in §1). Until it lands, the safe bar stays trusted/limited-tenant.
- [ ] Residual Wave-4 items from #259 (scrub regression M1, multi-vendor/BYO-local proven E2E + re-tier breaker arm, full roster management CRUD/scheduler/health-monitor) — re-confirm against #259 after Wave 3.5.

### Out of "product full"
- [ ] **Marketing site = separate Wave 5** — design-complete but product-orthogonal.

---

## 5. Sequencing summary (the critical path)

```
#276 stabilization (SHIPPED, independent)
        │
        ▼
Wave 3.5  ──  3.5-B org identity + 3-role model  (governance foundation)
              ├── 3.5-A BYOK creds (keystone for running)
              │     ├── 3.5-C agent creation (+ #3 model pin)
              │     └── 3.5-E BYOK metering ("S4b done right")
              └── 3.5-D member invites (parallel)
        │   (+ #4 agent-state fix in/after)
        ▼
P1 platform breadth (Shortcut intake, Linear)
        ▼
P2 money (ceilings, billing/Stripe on BYOK metering)
        ▼
P3 operability (audit, W4-S3 surfaces, connection transfer-integrity + dupe preflight)
        ▼
P4 security capstone (W4-S1 sandbox)  ──►  untrusted multi-tenant unlocked
        ▼
Wave 5 marketing (separate track)
```

---

## 6. Definition of "100% PRD" (sign-off)

Engine DoD = [#259 gap analysis Part F](PRD-Completion-Gap-Analysis.md). This roadmap stacks the **tenant-self-sufficiency + BYOK + identity/roles** gates on top. "Full" is reached when:

- [ ] Wave 3.5 complete — an org self-serves **identity/roles → keys → agents → members → metered runs**, on its own vendor key, no operator, no server key.
- [ ] P1–P3 complete — Shortcut + Linear; ceilings + billing on BYOK metering; audit + operability; connection transfer-integrity + dupe-preflight.
- [ ] P4 complete — W4-S1 sandbox → untrusted multi-tenant safe.
- [ ] #259 engine DoD residuals re-confirmed closed.
- [ ] Marketing (Wave 5) tracked separately per the standing F7 decision.

---

## 7. Open items to confirm before building 3.5

1. **Custodial-BYOK threat model** — confirm "server can decrypt to inject, stores only ciphertext, never logs plaintext" is acceptable for the enterprise audience (vs zero-knowledge, which precludes server-side injection). Recommend **yes**, document in an ADR.
2. **Slug policy** — derivation (slugify name), reserved slugs (`o`, `api`, `auth`, …), rename behavior (does changing the name change the slug? recommend: slug is set at create, editable separately, old slug 404s or 301s — confirm).
3. **Role migration** — owner→owner-admin, admin→admin, member→user is the proposed mapping; confirm the **member→user gains agent + task CRUD** (a capability *increase* for existing members) is intended.
4. **Per-org LLM client cache** eviction on rotation — recommend short TTL + explicit bust on key replace.
5. **Vendor abstraction depth** — build 3.5-A vendor-parameterized (Anthropic now) so OpenAI is config, not a rewrite.
