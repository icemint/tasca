# Tasca — Execution Roadmap v2 (BYOK + True Multi-Tenancy) — *HOSTED-TIER SPEC*

> **⚠️ SUPERSEDED for sequencing by [`Execution-Roadmap-v3-OSS.md`](Execution-Roadmap-v3-OSS.md) (2026-06-12).** The product ships **single-tenant OSS first** (v3); the multi-tenant work in this doc is **deferred to the hosted / SaaS tier** and **quarantined**. **This doc is now the SPEC for that deferred multi-tenant tier** — read it for the multi-org / cross-tenant / vanity-URL / custodial-key / billing / sandbox-as-gate surface when the hosted tier is built. Do not build single-tenant OSS work from here; use v3.
>
> *(Original status, retained for context:)* decided 2026-06-12; re-ordered around the BYOK + true-multi-tenancy decisions; #259 remains the engine definition-of-done.

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
| **D4** | **Org identity** = name + slug + path-based vanity URL. | `name` (display, editable) · `slug` **auto-generated from the name at create, NON-editable** (no rename path — generation must be right first time) · vanity `app.tasca.dev/o/<slug>` via **path routing, NOT subdomain**. Slug is URL-routing, so generation owns **uniqueness** (disambiguator suffix on name collision) + **reserved-word avoidance** (`api`, `app`, `admin`, `www`, `o`, `auth`, …). |
| **D5** | **Three roles** (capability matrix below). | First registrant = **owner-admin**. **Multiple owner-admins** allowed; any can delete the org or promote others to owner-admin. |
| **D6** | **Agent creation scope** = name + vendor/model + tier/capability. | **No** system-prompt / persona authoring yet. The chosen model is **pinned at spawn** (config == runtime — folds in #3). Creatable by **User and above** (agents are work). |
| **D7** | **Auth = OAuth-only** (GitHub/Google). **No** email/password, **no** magic-link. | Audience is developers (GitHub login is near-universal). Invites bridge the email↔OAuth-identity gap via a **signed single-use token** (possession of the link = authorization), **not** email matching — invited email and OAuth email need not match. Leave room for a future magic-link provider (non-dev members) but **do not build it now**. |

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

### 1.3 Issue/board state model — PROJECTION, not sync (locked 2026-06-12)

| # | Decision | Detail |
|---|----------|--------|
| **D8** | **The platform owns issue state; Tasca's board is a READ-ONLY PROJECTION** of (issue + linked PR + agent claim). | The agent's **only** state-affecting write is the **PR**, linked via **`Closes #N`**; the platform's native PR-merge→issue-close does the transition. Humans act in the platform (merge/close/reopen); Tasca **reflects** it. **No bidirectional sync, no echo suppression, no conflict resolution** — because Tasca never writes issue state. The board is a **viewer, not a controller**. |

**Board columns are DERIVED** (computed from platform reality), not stored-and-synced:

| Column | Derivation |
|--------|-----------|
| **New** | issue open, no claim, no linked PR |
| **In progress** | issue open, agent claimed / linked PR open |
| **In review** | issue open, linked PR ready for review |
| **Done** | issue **closed** (PR merged → platform auto-closed) |
| **Needs attention** | Tasca-internal **operational** state (agent failure / no-changes) — does **NOT** touch platform state |

Tasca's richer operational states (`needs_attention`, breaker, etc.) layer **on top of** the platform's open/closed; they are **not** synced back.

**The one required agent write — `Closes #N`.** The agent already opens PRs; it must include the closing reference so a merge auto-closes the issue. **Current state (confirmed 2026-06-12):** `orchestrate.ts`'s `openPr` call passes **no body** (`open-pr.ts` writes `--body ''`), so there is **no `Closes #N` today** — this is a small required change: derive the issue number from `externalStoryId` (`owner/repo#N`) and set the PR body to `Closes #N`. Tracked as a prerequisite of the projection/board work + P1.

**Generalizes to ALL platforms.** Shortcut/Linear adapters follow the same principle — **project** native state, link work via native PR/branch mechanisms, **never** maintain a parallel state machine. This is **why the F1 Shortcut write-back question is less blocking than feared**: projecting (not syncing) shrinks the write-back surface to *"link the PR,"* not *"mirror state."*

**FUTURE (deferred, not now):** *board-as-controller* (close/reopen/reassign **from** Tasca) would need limited **outbound** writes — explicitly deferred; build the projection/viewer first.

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

**Encryption-at-rest (locked):** **AEAD only — AES-256-GCM or libsodium secretbox — no homegrown crypto.** The master decryption key lives in **SERVER SECRET (env / KMS), NEVER in the DB** (`TASCA_SECRET_STORE_KEY`) — so a **DB-only breach cannot expose vendor keys** (the ciphertext is useless without the env-held master key). Each org vendor key is sealed (store IV/nonce + auth tag). Plaintext exists **only** transiently at injection — never persisted, never logged, never echoed, **never returned by any API** (write-only from the UI: set/replace/delete, never read back). **Custodial BYOK, not zero-knowledge** (the server must decrypt to inject into runs); stores only ciphertext. **Vendor-agnostic schema** (provider enum + credential table + a provider injection interface); **Anthropic-only live implementation** — OpenAI later = *implement a provider*, not migrate the schema. New table `org_vendor_credential` (org-scoped, in `TENANT_TABLES`): `{org_id, provider, ciphertext, nonce, auth_tag, key_fingerprint, status, created_by, created_at, last_validated_at}`; the UI shows only the **fingerprint**.

**Validate-on-input:** a **cheap live vendor call** before save (authenticates + model access); reject with a clear, non-leaky message; scheduled re-validation stamps `last_validated_at` so a silent revoke surfaces.

**Mid-task rotation / revocation:** **rotation** → in-flight runs finish on the key injected at spawn; new runs use the new key (no mid-run swap). **Revocation / a key failing mid-run** → the run fails-soft to `needs_attention` "vendor credential rejected" (NOT a breaker burn); the classifier degrades to heuristic + the loud `onClassifierError` log (shipped #276). **No key at dispatch** → fail closed: `needs_attention` "no vendor key configured" (no breaker, no crash) — and per the UX-honesty rule, surfaced in-app.

**Architecture change forced:** the coordination LLM client becomes **per-org**, resolved per task from the org's decrypted key. **Decrypted-key cache: ~60s TTL per org** (rotation takes effect within the TTL window — acceptable). `estimateTier`'s classifier + PM proposers get the org-keyed client; absent a key → none (heuristic path).

**Definition of done:**
- [ ] `org_vendor_credential` table (org-scoped, required-`orgId`, in `TENANT_TABLES`, CI org-scoping guard updated); **vendor-agnostic** (provider enum + injection interface, Anthropic live).
- [ ] Admin+ create/replace/delete key endpoints, CSRF, **server-side role gate** (Users blocked); **WRITE-ONLY — no endpoint ever returns the key** (set/replace/delete; reads return only status + fingerprint).
- [ ] **AEAD** (AES-256-GCM / libsodium secretbox, **no homegrown crypto**); master key in **server env (`TASCA_SECRET_STORE_KEY`), never the DB** → a DB-only breach can't expose keys; plaintext never persisted/logged/echoed/returned; fingerprint-only display.
- [ ] Validate-on-input (live provider probe) + scheduled re-validation.
- [ ] Per-org LLM client (classifier + proposers) wired to the org key, **~60s decrypted-key cache**; **server key path deleted** (proxy master-key injection + boot-time classifier client removed).
- [ ] Rotation/revocation/no-key policies implemented + **tested** (no-key → fail-closed; revoked-mid-run → reason, no breaker).
- [ ] Settings → "Vendor keys" UI: input + status + fingerprint, admin-gated with honest non-admin disabled state.
- [ ] Adversarial security panel: secret hygiene (no plaintext leak path), org isolation (A can never read/use B's key), fail-closed under every error.

---

### 3.5-B — Org identity + 3-role model  ·  *governance foundation (supersedes 5b)*

Redefines org membership/RBAC from 5a/5b's owner/admin/member to the **owner-admin / admin / user** matrix (D5), adds org **identity** (name/slug/vanity URL), and re-gates every endpoint.

**Scope:** org **name** (editable) + **slug** (derived, unique, collision-suffixed) + **path-based** `/o/<slug>` routing (the app + worker resolve the org from the path, then **verify membership fail-closed with no existence leak**). The 3-role capability matrix, **multiple owner-admins**, promote/demote, last-owner-admin protection (an org can't be left with zero owner-admins). The **User-can-CRUD-agents** boundary wired into the agent + task endpoints' gates.

**Definition of done:**
- [ ] Role model migrated to owner-admin / admin / user; **a migration step maps existing memberships** (owner→owner-admin, admin→admin, **member→User** — which *gains* agent + task CRUD, a deliberate capability increase) with the **new** split enforced server-side.
- [ ] Org `slug` **auto-generated from name at create, non-editable** (no rename path); generation owns **uniqueness** (disambiguator suffix) + **reserved-word avoidance** (`api`/`app`/`admin`/`www`/`o`/`auth`/…). `/o/<slug>` path routing resolves the org and **verifies membership fail-closed (404 on non-member / unknown slug — no existence leak)**.
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

### 3.5-D — Member invites (signed-token + OAuth)  ·  *parallelizable*

Invite a human teammate **by email** → they join the org with a **role**, authenticating via **OAuth only** (GitHub/Google) per D7. The invite bridges the email↔OAuth-identity gap with a **signed single-use token**, **not** email matching.

**Invite flow (locked):**
1. **Create** (owner-admin / admin): `{ email, org_id, role, signed single-use token, expiry ~7d }` → Tasca sends a **transactional email** with an accept link carrying the token.
2. **Accept** — invitee clicks the link:
   - **Logged in** → bind the **current session user** to `{org_id, role}` (no forced re-auth).
   - **Not logged in** → OAuth (GitHub/Google, **any** account/email) → on callback, **consume the token** → bind the authenticated user to `{org_id, role}` via `org_membership`.
3. **The token is the authorization** (possession of the link = proof of invited-inbox control); **OAuth is identity.** The invited email and the OAuth email **need not match** — a deliberate trust choice (the link is the secret).

**Edge cases (must handle):**
- Already-logged-in clicker → bind to the **session user**, no forced re-auth.
- Expired / already-used token → **honest error + "request a new invite."**
- Already-a-member → **idempotent no-op** (no duplicate membership, no role downgrade surprise).
- **Single-use consumption + expiry enforced server-side** (the token row is consumed atomically, replay finds nothing — mirrors the `oauth_state` / `github_install_state` nonce pattern).
- Cross-tenant invite acceptance → **fail-closed** (the token binds to its `org_id`; it can't be redirected to another org).

**Definition of done:**
- [ ] Signed single-use invite token (`{email, org_id, role}`, ~7d expiry), issued by owner-admin/admin only (server-gated, CSRF); stored server-side, consumed atomically.
- [ ] Accept endpoint: logged-in → bind session user; logged-out → OAuth → consume → bind. Email-need-not-match is intentional + documented.
- [ ] All edge cases above implemented + tested (expired/used → honest error; already-member → idempotent; cross-tenant → fail-closed; single-use enforced server-side).
- [ ] Role assignment at invite (owner-admin / admin / user); last-owner-admin protection.
- [ ] **Transactional email** wired (see the infra dependency below) — invite send + a basic template (accept link, org name, inviter).
- [ ] Settings → "Members" UI: list + pending-invites + invite + role change + remove, admin-gated with honest disabled states.
- [ ] Adversarial panel: token integrity (signature + single-use + expiry, no forge/replay), org isolation (invite only into your own org; no self-escalation; cross-tenant accept fail-closed), and the email-≠-OAuth trust choice is sound (link possession is the authorization).

**NEW INFRA DEPENDENCY — transactional email (the one new external service):**
- **Provider: Resend** (locked) for transactional invites. The only new external service Wave 3.5 adds.
- **Key custody:** the email API key is **server-level platform infra**, **NOT** org BYOK — invites are **Tasca's** email, not the org's. It lives in the server secret store (deploy env / KMS), distinct from `org_vendor_credential`.
- **Sending domain:** invites come from a `tasca.dev` address (e.g. `invites@tasca.dev`); the sending domain needs **SPF + DKIM** (and DMARC) configured so invites land, not in spam. Infra/DNS task, surfaced for the maintainer.
- **Failure handling:** an email-send failure must not strand the invite — the token is persisted first, so a failed send is retryable / the link is re-issuable; surface "couldn't send — retry" honestly.

**Dependencies:** **3.5-B** (the role model) + the transactional-email provider. Independent of A/C/E.

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

### Phase P1 — Platform breadth (all adapters follow the **projection model, §1.3**)
- [ ] **`Closes #N` on the agent's PR** (prerequisite) — set the PR body to `Closes #<issue>` (derived from `externalStoryId`) so a merge auto-closes the issue. Small change to the `openPr` call (no body today). The single agent state-write the projection model requires.
- [ ] **W3-S2 Shortcut** — intake now; **write-back is just "link the PR"** under the projection model (not state-mirroring), so the F1 token concern shrinks; `identity.credential_ref` absorbs the resolution.
- [ ] **W3-S3 Linear** — full adapter, flag-off, against the documented contract; **project native state, no parallel state machine.**

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

## 7. Resolved decisions (locked 2026-06-12, post-review)

1. **Custody** — custodial AEAD: **AES-256-GCM / libsodium secretbox, no homegrown crypto.** Master key in **server env, NEVER the DB** (a DB-only breach can't expose vendor keys). Keys are **write-only** from the API (set/replace/delete, never read back). → 3.5-A.
2. **Vendor abstraction** — **vendor-agnostic schema** (provider enum + credential table + injection interface), **Anthropic-only live**; OpenAI later = *implement a provider*, not a schema migration. → 3.5-A.
3. **Slug** — **auto-generated from name, non-editable** (no rename path; right first time). Generation owns uniqueness (disambiguator suffix) + reserved-word avoidance (`api`/`app`/`admin`/`www`/`o`/`auth`/…). → 3.5-B.
4. **Role migration** — existing 5b **`member` → `User`** (gains agent-CRUD — a deliberate increase); a migration step maps all existing memberships. → 3.5-B.
5. **Key cache** — per-org decrypted key cached **~60s TTL**; rotation takes effect within the window (acceptable). → 3.5-A.
6. **Email** — **Resend** for transactional invites; **server-level key (platform infra, not org BYOK)**; sending from a `tasca.dev` address; **SPF/DKIM/DMARC** on the domain is an in-scope DNS task; token persisted before send, send-failure retryable. → 3.5-D.

> **Build order confirmed:** ship this doc → **start 3.5-A** (BYOK credential mgmt, keystone). The 3.5-A security panel is mandatory and must prove: key never logged, never returned by any API (write-only), encrypted at rest under a server-held (not DB) master key, and the injection path doesn't leak the key into the agent subprocess env in a readable form.
