# Tasca — Execution Roadmap v2 (BYOK + True Multi-Tenancy)

> **Status:** decided 2026-06-12. The canonical **sequencing** source of truth for "100% PRD".
> **Supersedes** the *ordering* in [`PRD-Completion-Gap-Analysis.md`](PRD-Completion-Gap-Analysis.md) (#259) — that doc remains the **engine definition-of-done** (section-by-section PRD + design coverage). This doc re-orders what's left around a major architecture decision and inserts a new milestone (**Wave 3.5**) *before* platform breadth.
> **Build nothing from this doc until reviewed.** Each slice below carries a definition-of-done, dependency order, and the standing org-scoped / role-gated / fail-closed requirements.

---

## 0. The decision in one paragraph

Tasca becomes **truly multi-tenant and BYOK-only**. The server holds **no vendor API key**. Every org supplies its own vendor key(s) (Anthropic now, OpenAI later), stored **encrypted at rest per-org**. **Every** LLM call — agent execution *and* the coordination classifier (routing/triage/decomposition) — runs on the **org's** key. An org with no key configured degrades to **heuristic routing only** and **cannot run agents** until a key is added. "Metering done" is therefore a property of **BYOK agent execution**, not a server-key bolt-on — the earlier server-key in-process metering (Option A) is **rejected and will not be built**. The work to make an org self-sufficient (keys → agents → members → metering) is sequenced as a new milestone, **Wave 3.5: Tenant Self-Sufficiency**, *ahead of* platform breadth (Shortcut/Linear).

---

## 1. Core decisions (locked 2026-06-12)

| # | Decision | Binding consequence |
|---|----------|---------------------|
| **D1** | **BYOK only.** Server holds no Anthropic key. Per-org encrypted vendor keys. All LLM calls (agent + classifier) on the org key. | `ANTHROPIC_API_KEY` as a server **token source** is removed. The coordination LLM client stops being a single boot-time singleton and becomes **per-org, resolved per task**. |
| **D2** | **No-key degradation.** No key → heuristic routing only (no LLM classifier); agents cannot run until a key is added. | The heuristic fallback is the **load-bearing** no-key path. LLM classification is a **BYOK-gated enhancement**. A keyless org's dispatch fails **closed** with a clear "no vendor key" reason — never a breaker burn, never a crash. |
| **D3** | **Full self-serve stack is the prerequisite for "metering done."** Metering is a property of BYOK execution. | **Reject Option A** (in-process *server-key* metering). The proxy/bridge/tee *plumbing* is reused, but it injects the **org's** key (decrypted per task) — built as 3.5-A + 3.5-D, not before. |
| **D4** | **Agent creation scope = name + vendor/model + tier/capability** (full routing control). | **No** system-prompt / persona authoring yet (a later enhancement). The chosen model is **pinned at spawn** (config == runtime — folds in the #3 fix). |

> **Deployment-posture gate (honest constraint):** Wave 3.5 makes Tasca *self-serve* multi-tenant (multiple orgs onboard themselves). Running **multiple untrusted orgs' agents on shared infra** is only safe behind the **W4-S1 per-agent UID + namespace sandbox** (the security capstone). Until W4-S1 lands, the safe operating bar stays **trusted / limited-tenant** (e.g. single customer or vetted design partners). Wave 3.5 ≠ "open the public multi-tenant doors"; W4-S1 is that gate.

---

## 2. NEW MILESTONE — Wave 3.5: Tenant Self-Sufficiency

**Goal:** an org admin can land in the app and reach a working AI dev team **entirely self-serve**, on their **own** vendor key, with their spend **metered** — without an operator touching the server. Sequenced **before** platform breadth.

**Dependency order:** `3.5-A` (keystone) → `3.5-B` + `3.5-D` (both depend on A) → `3.5-C` (independent, parallel any time).

```
                3.5-A  BYOK credential management  (keystone — blocks all)
                  │
        ┌─────────┼───────────────┐
        ▼         ▼               ▼
   3.5-B agent  3.5-D metering   (classifier enablement is gated on A too)
   creation     (BYOK tee)
        │
        ▼
   #4 agent-state-source fix (small; in/after 3.5)

   3.5-C member invites — independent of A/B/D, parallelizable
```

---

### 3.5-A — BYOK vendor credential management  ·  *keystone, blocks everything*

This is **W3-S8 (API-key management) pulled forward and made foundational.** Without it, no agent runs and no classifier fires under BYOK.

**Scope:** an org **admin** inputs a vendor key (Anthropic first; vendor-parameterized for OpenAI later). Stored **encrypted at rest, per-org**. Decrypted and **injected per-task** into three consumers: (1) agent execution, (2) the coordination classifier, (3) the metering tee.

**Encryption-at-rest approach:**
- **Envelope encryption.** A server-held master key (`TASCA_SECRET_STORE_KEY`, already in the deploy spec) is the KEK; each org vendor key is sealed with **AES-256-GCM** (authenticated; store the IV + auth tag). Plaintext exists **only** transiently at injection time — never persisted, never logged.
- **Threat model, stated honestly:** this is *custodial* BYOK, not zero-knowledge. The server **can** decrypt org keys (it must, to inject them into agent runs), but stores only ciphertext and never emits plaintext (no logs, no error messages, no API echo). True "server never sees plaintext" would prevent server-side injection — out of scope. Document this in the ADR so the posture is explicit to enterprise customers.
- New table `org_vendor_credential` (org-scoped, in `TENANT_TABLES`): `{org_id, vendor, ciphertext, iv, auth_tag, key_fingerprint, status, created_by, created_at, last_validated_at}`. The **fingerprint** (e.g. last-4 + a salted hash) is what the UI displays — never the key.

**Key validation on input:** before saving, make a **cheap live vendor call** (e.g. a minimal Anthropic `/v1/messages` or a models probe) to verify the key authenticates **and** has access to the model the org will use. Reject on failure with a clear, non-leaky message. Re-validate on a schedule (and stamp `last_validated_at`) so a silently-revoked key surfaces.

**Mid-task rotation / revocation policy (must be specified, not emergent):**
- **Rotation** (admin replaces the key): in-flight runs already have the key **injected at spawn** → they continue on the old key to completion; **new** runs/classifier calls use the new key. No mid-run swap.
- **Revocation / a key that starts failing mid-run:** the agent's next vendor call 401s → the run fails-soft to **`needs_attention` with a distinct "vendor credential rejected" reason** (NOT a breaker burn — re-running won't help until the key is fixed). The classifier on a revoked key → degrades to heuristic + the loud `onClassifierError` log (already shipped in #276).
- **No key at dispatch time:** fail **closed** — `needs_attention` "no vendor key configured for this org" (no breaker, no crash). Per D2.

**Architecture change this forces:** the coordination LLM client becomes **per-org**. Today `AnthropicChat` is a single boot-time instance with the server key (`main.ts`). Under BYOK it is **resolved per task** from the org's decrypted key (a small per-org client cache, evicted on rotation). `estimateTier`'s classifier and the PM proposers receive the **org-keyed** client; absent a key, they receive **none** (heuristic path).

**Definition of done:**
- [ ] `org_vendor_credential` table (org-scoped, required-`orgId`, in `TENANT_TABLES`, CI org-scoping guard updated).
- [ ] Admin-only (5b) create/replace/delete vendor key endpoints, CSRF-protected; **server-side role gate** (not just UI).
- [ ] AES-256-GCM envelope encryption under `TASCA_SECRET_STORE_KEY`; plaintext never persisted/logged/echoed; only the fingerprint is readable.
- [ ] Live validation on input (authenticates + model access) with a clear non-leaky failure.
- [ ] Per-org LLM client resolution (classifier + proposers) wired to the org key; **no server key anywhere** (the `ANTHROPIC_API_KEY` token-source path is deleted, including the proxy's master-key injection).
- [ ] Rotation/revocation/no-key policies implemented and **tested** (no-key → fail-closed needs_attention; revoked-mid-run → needs_attention reason, no breaker).
- [ ] Settings → "Vendor keys" UI: input + status (valid / invalid / not-set) + fingerprint, admin-gated with an honest disabled state for non-admins.
- [ ] Adversarial security panel: secret hygiene (no plaintext leak path), org isolation (org A can never read/use org B's key), fail-closed under every error.

**Standing requirements:** org-scoped (every read/write WHERE org_id), role-gated (admin+, server-enforced), fail-closed (no key / bad key / decrypt failure all degrade safely, never crash, never cross-org).

---

### 3.5-B — Agent creation / provisioning wizard

The disabled **"Add agent"** control (left gated in W4-S3) becomes real: orgs **build their own roster**. The global *Elvis* seed model is replaced by **per-org agent creation**.

**Scope:** create an agent with `{ name, vendor/model, tier/capability }` (full routing control). **No** persona/system-prompt. The created agent gets its **native platform identity** (the GitHub service-user binding — the Wedge-1 primitive) so it can be assigned natively. The chosen model is **pinned at spawn** (folds in **#3 model-pinning**: `--model`/`ANTHROPIC_MODEL` = the agent's model → config == runtime; the Roster card label becomes truthful).

**Definition of done:**
- [ ] Agents become **org-owned** (created by the org, org-scoped) — the `agent`/`org_agent` model extended so an org creates rather than only hires a global seed; the identity-binding (per-agent, per-platform) created on agent creation.
- [ ] `POST /api/orgs/agents` (or a creation route) — admin-gated (server-enforced), CSRF; validates name uniqueness within the org, a supported vendor/model, a valid tier/capability.
- [ ] **Model pinned at spawn** so the execution model == the configured model == the routing capability (#3 fixed). Roster card shows the real model.
- [ ] "Add agent" wizard UI (name → vendor/model → tier/capability), admin-gated, `liveAction` + reconcile, honest non-admin disabled state.
- [ ] A created agent can be assigned a real issue and **routes + runs on the org's key** (depends on 3.5-A).
- [ ] Adversarial panel: org isolation (no cross-org agent visibility/assignment), routing integrity (declared model == run model).

**Dependencies:** **3.5-A** (a created agent cannot *run* without an org key). The creation *wizard* can be built in parallel; end-to-end run is gated on A.

---

### 3.5-C — Org member invites  ·  *independent, parallelizable*

Extends **5a/5b** (org membership + RBAC). Invite a human teammate **by email** → they join the org with a **role** (owner / admin / member).

**Definition of done:**
- [ ] Invite by email (existing user → immediate membership; non-user → a pending invite consumed on first login). Admin-gated, server-enforced; CSRF.
- [ ] Role assignment at invite (owner/admin/member); last-owner protection (cannot leave an org ownerless — the existing `last_owner` guard).
- [ ] Settings → "Members" UI: list + invite + role change + remove, admin-gated with honest disabled states; reflects 5b role semantics.
- [ ] Adversarial panel: org isolation (invite only into your own org; can't escalate your own role), fail-closed on a stale/forged invite token.

**Dependencies:** none beyond shipped 5a/5b — fully parallel to A/B/D.

---

### 3.5-D — Metering, correctly ("S4b done right")

Agent **and** classifier runs execute on the **org key** → `usage_event` per org via the tee, **sourced from BYOK**. This **replaces** the rejected server-key Option A.

**Scope:** reuse the proxy/bridge/**tee** plumbing (the SSE-aware usage extractor already built), but the credential injected is the **org's** decrypted key (per task), and there is **no server key**. The tee records `usage_event{org_id, task_id, source}` for agent calls; the per-org classifier records its own usage (the S4a path, now org-keyed). Add **per-org usage visibility** (feeds the later Settings "Billing & usage" panel).

**Definition of done:**
- [ ] Agent execution traverses the tee with the **org key** injected per task → `usage_event source='agent'` lands per org. (In-process or queue topology per the eventual dispatch decision — but the **key is the org's**, never a server key.)
- [ ] Classifier usage (`source='classifier'`) records per org under the org key (S4a path, BYOK-wired).
- [ ] `GET` per-org usage summary (org-scoped SUM by source) — the read API the Settings usage panel consumes.
- [ ] CAS-idempotent writes preserved (ON CONFLICT on the response id); fire-and-forget; metering failure never blocks or delays a run.
- [ ] Adversarial panel: a call's usage is **always** attributed to the right org (no cross-org bleed under concurrency), no key in any log/usage row, the tee can't corrupt/stall the stream (re-prove under BYOK injection).

**Dependencies:** **3.5-A** (the tee needs the org key to inject + meter).

---

## 3. Folded-in correctness fixes

| Item | Disposition |
|------|-------------|
| **Stabilization slice** (S4a classifier loudness + unmetered-direct-mode WARNs + #2 no-changes terminal handling) | **Shipped — PR #276 (`5af012c61`)**, merged **independent** of this restructure. The unmetered WARNs and the loud `onClassifierError` remain valid under BYOK (they now signal a missing/invalid *org* key path). |
| **#3 model-pinning** (card shows provisioned model; execution doesn't pin it) | **Absorbed into 3.5-B** (pin the chosen model at spawn; config == runtime). |
| **#4 agent-state-source** (Roster "in flight" vs Monitoring "in review" diverge — `agentJson.state` = claimed-presence, not task-status, `read-api.ts:147`) | **Small correctness fix**, scheduled **in or right after Wave 3.5** (derive `agent.state` from the claimed task's status so both views agree). |
| **Server-key removal** | Part of **3.5-A** DoD: delete the `ANTHROPIC_API_KEY` token-source path (proxy master-key injection + boot-time classifier client). |

---

## 4. Re-sequenced remainder (after Wave 3.5)

> Order top-to-bottom = build order. Each carries the standing org-scoped / role-gated / fail-closed discipline and the architect → slice → adversarial-panel → merge flow.

### Phase P1 — Platform breadth
- [ ] **W3-S2 Shortcut** — intake now; **write-back deferred** on the F1 token model (chase the reply; else documented-intake + best-effort write-back behind a flag; `identity.credential_ref` absorbs the resolution).
- [ ] **W3-S3 Linear** — full adapter, flag-off, built against the documented contract (Dev-Preview-volatile bits isolated behind the contracts schema).

### Phase P2 — Money (builds on BYOK metering, 3.5-D)
- [ ] **W3-S5 cost ceilings + budget alerts** — enforce per-org against the `usage_event` ledger (24/7 runaway protection).
- [ ] **W3-S6 billing / Stripe** — **per-agent-seat base + usage overage**, calc'd over BYOK metering; Settings "Billing & usage" panel (consumes 3.5-D's per-org usage read).

### Phase P3 — Operability
- [ ] **W3-S7 audit surfacing** — `/api/audit` (org-scoped) + the Security/audit view (sane default format/retention).
- [ ] **Remaining W4-S3 surfaces** — routing audience-split + live log + worktree, monitoring live feed/depth, full Settings tabs (Vendor keys [3.5-A], Members [3.5-C], Billing & usage [P2], Security/audit [P3]).
- [ ] **Manage / Repair connections + the connection-transfer integrity rule** — the deferred W4-S3 remainder, **plus the `org_default`-dupe lesson made a hard rule:** a connection transfer/rebind must, in **one transaction**, rebind the connection **and** resolve the workspace's in-flight tasks (retire/migrate — never leave them, which bricked boot on the global `(platform, story)` unique). **Also add the `applySchema` dupe-preflight guard** (detect duplicate `(platform, external_story_id)` and fail with a legible, actionable error instead of an opaque index-build crash).

### Phase P4 — Security capstone (the gate for untrusted multi-tenant)
- [ ] **W4-S1 per-agent UID + PID/mount/net namespace sandbox** — the dominant residual; **required before opening to untrusted/public multi-tenant** (see the deployment-posture gate in §1). Until this lands, the safe bar stays trusted/limited-tenant.
- [ ] Residual Wave-4 items from #259 (scrub regression M1, multi-vendor/BYO-local proven E2E + re-tier breaker arm, full roster management CRUD/scheduler/health-monitor) — re-confirm against #259 after Wave 3.5.

### Out of "product full"
- [ ] **Marketing site = separate Wave 5** — design-complete but product-orthogonal.

---

## 5. Sequencing summary (the critical path)

```
#276 stabilization (SHIPPED, independent)
        │
        ▼
Wave 3.5  ──  3.5-A BYOK creds (keystone)
              ├── 3.5-B agent creation (+ #3 model pin)
              ├── 3.5-D BYOK metering  ("S4b done right")
              └── 3.5-C member invites (parallel)
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

Unchanged engine DoD = [#259 gap analysis Part F](PRD-Completion-Gap-Analysis.md). This roadmap adds the **tenant-self-sufficiency + BYOK** gates on top of it. "Full" is reached when:

- [ ] Wave 3.5 complete — an org self-serves keys → agents → members → metered runs, on its own vendor key, no operator, no server key.
- [ ] P1–P3 complete — Shortcut + Linear breadth; ceilings + billing on BYOK metering; audit + operability surfaces; connection transfer-integrity + dupe-preflight.
- [ ] P4 complete — W4-S1 sandbox shipped → untrusted multi-tenant safe.
- [ ] #259 engine DoD residuals re-confirmed closed.
- [ ] Marketing (Wave 5) tracked separately, in or out of "full" per the standing F7 decision.

---

## 7. Open items to confirm before building 3.5-A

1. **Custodial-BYOK threat model** — confirm the "server can decrypt to inject, stores only ciphertext, never logs plaintext" posture is acceptable for the enterprise audience (vs zero-knowledge, which precludes server-side injection). Recommend: **yes**, document in an ADR.
2. **Per-org LLM client cache** eviction policy on rotation — recommend a short TTL + explicit bust on key replace.
3. **Dispatch topology for BYOK metering** (3.5-D) — in-process vs queue is now decoupled from "server key" (there is none); pick the topology that best fits the tee + per-task key injection. Recommend deciding at 3.5-D design time, not now.
4. **Vendor abstraction depth** — build 3.5-A vendor-parameterized (Anthropic now) so OpenAI is a config addition, not a rewrite.
