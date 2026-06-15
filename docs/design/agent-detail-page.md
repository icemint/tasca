# Design spec — Agent detail page (editable identity, capability, credentials & description)

> One coherent agent-detail page covering issues #318 (fully editable profile), #319 (per-agent
> GitHub/Shortcut credential binding), #320 (editable cost ceiling), #329 (agent.md description),
> #337 (capability editor). Build-ready spec; implement with `senior-swe` after `architect` sequences
> the backend prerequisites (see Deferred / backend gaps).

## User & job
The operator (admin/owner managing the org's AI workforce) lands on one agent's page to **tune that
employee**: fix name/avatar, point it at a different model, set what work it can take (tier range,
specialties, concurrency, cost ceiling), bind per-agent platform credentials, and write its operating
instructions (agent.md). Success: any agent attribute is editable and persists, no dead "coming soon"
controls, and credentials bind/test without ever exposing a stored secret.

## Entry points & context
Reached from the roster card (`/agents?id=<id>`) and routing-inspector "routed agent" links.
Desktop-first console; the two-column `.pcols` grid collapses to one column ≤1080px. The page already
loads `AgentDetail` via `getAgent(id)` and re-renders from server truth through `mount`'s `rerun`
(`agents.astro` → `loadAgent`/`wireAgent`).

## Information architecture — one page, sectioned (NOT tabbed)
Keep the existing single scrolling page with the `.pcols` two-column layout. No tabs:
- #318 asks for "all fields editable **in one place**" — tabs re-fragment that.
- The page already has a working IA + live-reconcile loop; tabs would add routing/state and break the
  "edit, save, re-render from truth" model that `liveAction` gives for free.
- ~6 sections — a scroll scans cheaper than a tab bar for a config surface this size.

Section order (header, then the two-column body — left = work/instructions, right = identity/capability/credentials):

```
HEADER  — avatar · name · vendor chip · model · state pill · status badge · [Edit profile] [Pause/Resume]
LEFT COLUMN
  1. Current work          (existing — unchanged)
  2. Description (agent.md) (NEW — #329)
  3. Recent work           (existing — unchanged)
RIGHT COLUMN
  4. Identity & model      (NEW edit surface — #318/#324: name, avatar, vendor, model)
  5. Capability profile    (existing card, now EDITABLE — #337/#320: tier range, specialties, concurrency, cost ceiling)
  6. Platform credentials  (existing "Identity bindings" card, EXTENDED — #319: per-agent GitHub/Shortcut token binding + test)
```

## Edit model — section-scoped edit mode (not inline-per-field, not one giant form)
Each editable card has its own reveal-on-demand edit form (the established `.vk-form` / `.ca-form` /
`.ws-name-form` idiom), toggled by a per-card **Edit** control, with **Save / Cancel** and an inline
`role="alert"` error. The header's **Edit profile** button opens the Identity & model card.
- Matches three existing precedents (Settings vendor key, Settings workspace name, roster create-agent)
  — `senior-swe` builds by analogy; a11y treatment is already proven.
- **Inline-per-field** loses optimistic concurrency (each field a separate `version`-carrying write;
  second save 409s against the first). Section forms send one atomic patch + one `version`.
- **One giant page-form** fights the live-reconcile loop (credentials are write-only and re-render
  differently from identity) — per-card forms let secrets stay write-only while identity pre-fills.
- Concurrency contract for every save form: carry `a.version`; a 409 reconciles visibly via
  `liveAction` (re-render from truth + banner), exactly as pause/resume does today.

## Sections

### 1. Current work — existing, unchanged (`currentWork(a)`).

### 2. Description (agent.md) — NEW (#329)
The agent's definition/instructions in Anthropic agent.md (markdown), shown rendered with a Raw/Rendered
toggle, editable via a reveal-on-demand textarea.
- **Controls:** `<textarea>` (mono, `spellcheck=false`, `maxlength` ~20000); a segmented
  **Rendered | Raw** view toggle (`.seg`) on the read view; Save / Cancel.
- **Display:** default = rendered markdown in a constrained prose block; **Raw** = verbatim markdown in
  a `.logs`-style mono block. Edit replaces the read block with the textarea (pre-filled with raw).
- **Empty:** `work-empty`-style block — icon, "No instructions yet", "Give this agent an agent.md to
  define how it works.", an **Add instructions** primary (admin+) / `roControl` for non-admins.
- **Error (save):** inline `role="alert"` under the textarea.
- **Rendering safety (engineering flag):** markdown→HTML must be sanitized (the app sets `innerHTML`
  from builder strings; an unsanitized agent.md render is stored-XSS). If no sanitizing renderer is
  bundled, **render raw-only (escaped, mono) for v1** and defer the rendered view — do not add an
  unsanitized renderer.
- **Architecture flag (engineering, not design):** how agent.md flows into the agent's actual system
  prompt is an open backend question (#329). This spec defines only the UI surface (store + display the
  markdown on `AgentDetail.description`). Until the prompt-assembly path exists, copy must say
  "Instructions" / "definition", NOT "system prompt".

### 3. Recent work — existing, unchanged.

### 4. Identity & model — NEW edit surface (#318, #324)
Replaces the dead header "Edit profile" stub. Read view: avatar, **Name**, **Vendor** (chip),
**Model** (mono). Edit form:

| Field | Control | Notes |
|---|---|---|
| Name | text, required, maxlength 80 | mirror `ca-name` |
| Avatar URL | url, optional, maxlength 500 | mirror `ca-avatar`; preview the `avatar()` tile beside it |
| Vendor | `<select>` (Claude/OpenAI/Local) | mirror `ca-vendor` |
| Model | text, mono, required, maxlength 120 | mirror `ca-model`; placeholder from the vendor's default |

- **Tier coupling:** changing vendor/model re-derives the **default** max-tier via
  `defaultTierForModel(vendor, model)` and surfaces it as a hint ("Model default tier: HARD") — does
  NOT silently change the capability card. Reuse the `syncTier` + `data-touched` pattern from roster.ts.
- Standard `.ca-form` Save/Cancel/error; one atomic patch + `version`.

### 5. Capability profile — now EDITABLE (#337, #320)
Read view = existing `capability(a)` card. Edit reveals a form. **Success rate stays read-only**
(observed metric, not a setting).

**5a. Specialties — structured tag multi-select (#337 → feeds EM router #339).**
Specialties must be **real and structured**, not free text. Two grouped tag-selects over a known
**taxonomy**:
- **Languages** (TypeScript, Python, Go, Rust, Java, Kotlin, Swift, Ruby, C#, SQL …) → `languageSpecialties[]`.
- **Frameworks** (React, Astro, Node, Fastify, Next, Django, Rails, Spring, .NET …) → `frameworkSpecialties[]`.
- **Interaction:** tag-input — selected items render as removable chips (`.spec` + "×" button); an
  `<input>` + `<datalist>` (or filtered listbox) constrains entries to the taxonomy; an out-of-taxonomy
  entry is rejected inline ("Pick from the list — specialties drive routing"). The taxonomy is the
  source of truth; free text outside it is not accepted. Keyboard: Enter adds focused suggestion,
  Backspace on empty removes last chip, each × is a focusable button.
- **Taxonomy ownership (flag):** the lists must come from a shared constant (ideally projected from
  `@tasca/domain`) so the router (#339) and the editor agree. The editor imports it — must not fork a
  copy that drifts from the router's.

**5b. Tier range + model-default override (#337).**
- **Max tier** — `<select>` over `TIERS` (reuse `tierSelect`), pre-filled to
  `capability.maxTier ?? defaultTierForModel(vendor, model)`.
- **Tiers covered** — lower bound (`tiersCovered`); a "covers from" `<select>` (min tier) paired with
  max; the `tierRamp` preview re-renders live. Validation: min ≤ max (inline error).
- **Override surfaced honestly:** a hint (`aria-describedby`, mirroring `ca-tier-hint`) reads
  "Model default: HARD. Overridden to ULTRA." when chosen ≠ derived, "Matches the model default (HARD)."
  when equal. A **Reset to model default** link re-applies the derived tier.

**5c. Concurrency (#337).** Number input, integer ≥ 1 (or empty = unlimited → `null`), suffix "slots".
Inline error on non-positive non-empty.

**5d. Cost ceiling (#320).** Replaces read-only `$100/day`. `money()` semantics: `null` = "—",
`0` = "local · no cap".
- Number input (`min=0`), default from `costCeiling`.
- Static "/ day" suffix (the only unit `money()` renders — keep static unless backend accepts periods; flag if not).
- A **No cap** toggle → sets `0` and disables the number field (matches `money()`'s `0 → "local · no cap"`).
  Cleared → `null` → "—".
- Inline error on negative.

**Save:** §5 saves as one atomic patch through an extended `editAgentProfile` carrying
`{ maxTier, tiersCovered, languageSpecialties, frameworkSpecialties, concurrencyLimit, costCeiling }` +
`version`. (api.ts today only sends `{ maxTier, concurrencyLimit, costCeiling }` — extend it.)

### 6. Platform credentials — EXTENDED from "Identity bindings" (#319)
Keep the existing binding rows (platform · external handle · binding-state dot+label) as the **read**
summary; add a **per-agent credential** treatment per platform (GitHub, Shortcut) mirroring the
Settings vendor-key idiom.

**Masked display (never the stored token):**
- Set: `token ••••<fingerprint>` (mono, `.vk-fp`), a **Set / Active** badge (`.conn-status.ok` + label
  + filled dot), last-validated relative time.
- Unset: **Not configured** badge (`.conn-status.off` + hollow dot + label), "No token set for this platform."
- The stored token is NEVER rendered. Read shape carries only `{ platform, status, fingerprint, lastValidatedAt }`.

**Replace flow (reveal an empty input — never the stored token):**
- Admin sees **Set token** (unset) / **Replace token** (set) + (when set) **Remove**.
- Reveals a hidden `.vk-form` with a **blank** `type="password"` input (write-only; cleared on cancel
  and before the write resolves — settings.ts:514–516, 543). Never pre-fill.
- **Remove** = two-step `.vk-confirm` (no `window.confirm`).

**Connection-test state machine (NEW — #319's explicit ask):**
```
idle ──Test──▶ testing ──▶ pass   (badge: "Connection OK", .conn-status.ok, check glyph)
                       └──▶ fail   (badge: "Couldn't connect", .conn-status.warn/off, + reason)
pass/fail ──edit input──▶ idle    (re-typing invalidates the prior result)
```
- **Status not by color alone:** label + glyph + token color. `testing` = "Testing…" + spinner/pulse
  (respect reduce-motion), `pass` = "Connection OK" + check, `fail` = "Couldn't connect" + short reason
  (`role="status"` so SR announces).
- **Save gating (recommend, confirm with product):** allow Save independent of a passed test, but on a
  failed test show a non-blocking confirm ("This token didn't pass a connection test — save anyway?").
  Don't hard-block (the endpoint may be flaky; operator stays in control).
- **Per-platform isolation:** GitHub and Shortcut each get their own row/form/test/confirm scoped by
  `data-*` id — no shared DOM (avoid the single-`querySelector` trap).

**Backend gaps to flag:** `Binding` today carries no fingerprint, and there is no per-agent credential
set/test/remove endpoint. See Handoff.

## Interaction contract (all sections)
- Default → edit: per-card Edit reveals the form, focus to first field; Cancel hides, **returns focus to
  the Edit trigger** (roster.ts:280), clears any write-only input.
- Save → loading: button `aria-busy`, disabled, "Saving…" via `liveAction`.
- Save → success: `rerun()` re-renders from truth; form discarded by the re-render.
- Save → conflict (409): re-render from truth + banner "Someone else changed this agent — showing the latest".
- Save → error/forbidden/unconfigured: re-render + honest banner (existing `describeFailure`).
- Empty: no agent → existing `empty(...)`. No specialties → "—". No description → add-instructions block.
  No credential → Not configured.
- Loading: page-level skeleton via `mount`.
- Read-only (non-admin): every editable control degrades to a `roControl` with an honest gate reason
  (mirror `RO_GATE_VENDOR_KEYS` / `RO_GATE_WORKSPACE`); add `RO_GATE_AGENT_EDIT` + `RO_GATE_AGENT_CREDS`.

## Accessibility (WCAG 2.2 AA floor)
- **Contrast:** tokens only; every pairing clears AA both themes (CI contrast assertion + hardcoded-color
  guard). Reuse `.conn-status`, `.spec`, `.vk-*`, `.ca-*`, `.tierbar` (already AA-asserted).
- **Targets:** controls ≥ `.ictl`/`.btn-add` sizing (~36–38px). Chip "×" hit area ≥24px.
- **Keyboard / focus order:** top-to-bottom, header → left → right. Every Edit/Save/Cancel/Test/Remove is
  a real `<button>`. Cancel restores focus to its trigger. The specialty tag-input is fully
  keyboard-operable. Two-step confirms move focus to the confirm action.
- **ARIA / hints:** reuse the `aria-describedby` hint pattern (roster.ts:92/123) for the tier override
  hint, the cost-ceiling "No cap" explanation, and the specialty "pick from the list" constraint. Error
  regions `role="alert"`, always-in-DOM-collapsed-when-empty (`.ca-err:empty`). Test result `role="status"`.
- **Status not by color alone:** test result (label+glyph+color), binding state (dot + **label**), tier
  (positional ramp + text "to ULTRA"). Hollow-vs-filled dot shape carries configured/not-configured.
- **Motion:** the testing spinner/pulse honors `prefers-reduced-motion` (match the codebase's
  `@media (prefers-reduced-motion: no-preference)` gating).
- **Semantics:** `<h1>` agent name; each `.pc-h` card title a real heading. Mono fingerprints get an
  accessible label.

## Design-system usage
**Reuse (no new component):** `tierRamp`, `tierSelect`, `defaultTierForModel`, `TIER_LABEL`, `TIERS`;
`vendorChip`, `avatar`, `statePill`, `statusBadge`, `money`, `pct`; `.ca-*` form classes; `.vk-*` +
`fingerprint()` + write-only input handling + two-step remove; `.conn-status` (`.ok/.warn/.off` + `.d` /
`.d.hollow`); `.spec` chip; `.seg` toggle; `liveAction`, `showBanner`, `describeFailure`, `roControl`,
`RO_GATE_*`.

**New (justified) — three small additions:**
1. **Specialty tag-input** (`.spec-input` + removable `.spec` chips + datalist/listbox). The DS has the
   static chip but no editable multi-select; must be taxonomy-bound for #339. Token-only, keyboard-native.
2. **Connection-test result control + state machine** (`.conn-test` reusing `.conn-status`). No
   test-connection affordance exists; #319 requires idle/testing/pass/fail. Only the state wiring is new.
3. **Description block** (rendered/raw viewer + textarea). No markdown surface exists yet. Reuse `.logs`
   for Raw + `.seg` toggle; the only new piece is the sanitized prose container (v1 may ship raw-only).

## UI acceptance criteria (QA / code-reviewer; both themes)
- [ ] Header "Edit profile" opens the Identity & model edit form (no longer a disabled `roControl`) for admin+; non-admin sees a gated control with an honest reason.
- [ ] Identity edit: name/avatar/vendor/model editable; Save persists + re-renders from truth; Cancel restores focus to trigger + discards.
- [ ] Model shown in header AND editable; the specific model string (e.g. `claude-sonnet-4-6`) in mono, not just vendor.
- [ ] Changing vendor/model surfaces the model-default tier as a hint without silently overwriting the capability tier.
- [ ] Specialties are taxonomy-bound (out-of-taxonomy value rejected inline); chips removable by keyboard + pointer.
- [ ] Tier range: max-tier + covers-from drive a live `tierRamp` preview; min ≤ max enforced; override hint + Reset-to-default link work.
- [ ] Concurrency: integer ≥ 1 or empty (→ unlimited); non-positive rejected inline.
- [ ] Cost ceiling: editable number; "No cap" → 0 → "local · no cap"; cleared → "—" (`money()` parity).
- [ ] Capability Save sends one atomic patch with `version`; a stale version 409s → visible reconcile + banner.
- [ ] Description: rendered/raw toggle; empty state add-instructions block; Save persists; render sanitized OR raw-only.
- [ ] Credentials: set/replace reveals a **blank** input; stored token NEVER in the DOM (assert only `••••<fingerprint>`); input cleared on cancel + before write resolves.
- [ ] Connection test: idle→testing→pass/fail renders label + glyph + token color (not color alone); re-typing → idle; result `role="status"`.
- [ ] Remove credential uses two-step `.vk-confirm`, not `window.confirm`.
- [ ] Every editable control degrades to a gated `roControl` for non-admins; server remains authority.
- [ ] Keyboard-only: full edit→save→cancel reachable; focus never stranded; Cancel returns focus to trigger.
- [ ] Reduced-motion: testing spinner/pulse suppressed.
- [ ] CI gates green: AA-contrast (both themes), hardcoded-color guard, status/tier-not-by-color-alone.

## Handoff

**Visuals (Claude Design) — screens × states × both themes:** full page read state; Identity edit-mode;
Capability edit-mode (specialty tag-input populated + tier-override hint visible); Credentials read (one
Set, one Not-configured); Credentials replace-form open; connection-test idle/testing/pass/fail; Remove
two-step confirm; Description empty/rendered/raw/edit. Component close-ups: specialty tag-input,
test-result badge set, cost-ceiling "No cap". Responsive: ≤1080px single-column, ≤560px `.ca-grid` → 1 col.

**`senior-swe` (files, reuse, contract changes):**
- **Edit (UI):** `app/src/lib/views/agent.ts` — make `capability()`, the bindings card, and the header
  edit control reveal-on-demand forms; replace the `roControl('Edit profile')` stub; add a `description`
  section; extend `wireAgent` (today wires only one `.live-ctl`) to wire per-section Edit/Save/Cancel,
  the specialty tag-input, the tier-range live preview, and per-platform credential set/test/remove,
  scoped by `data-*`.
- **Styles:** add `.spec-input`, `.conn-test`, the description block to a view CSS file (extend
  `app-views.css` or new `agent.css`) — tokens only; reuse `.ca-*`, `.vk-*`, `.conn-status`, `.spec`,
  `.seg`, `.logs`.
- **Contract (`contract.ts`):** extend `Capability` write path; add `AgentDetail.description: string |
  null`; add a per-agent credential read shape `{ platform, status, fingerprint, lastValidatedAt }` to
  `Binding` (or a sibling array).
- **API (`api.ts`):** extend `editAgentProfile` to carry `{ name, avatarUrl, vendor, model, maxTier,
  tiersCovered, languageSpecialties, frameworkSpecialties, concurrencyLimit, costCeiling }`; add
  `setAgentCredential(agentId, platform, token)` (write-only, mirror `setVendorCredential` incl. the
  400-lift), `deleteAgentCredential`, `testAgentCredential(agentId, platform)`.
- **Taxonomy:** import the language/framework taxonomy from a shared constant (ideally `@tasca/domain`)
  so editor + EM router (#339) agree — do not fork a local copy.
- Reuse `liveAction` / `describeFailure` / `roControl` / `RO_GATE_*` verbatim; add `RO_GATE_AGENT_EDIT`,
  `RO_GATE_AGENT_CREDS`.

**Deferred / out of scope (flag to `architect`):**
- **Backend endpoints don't exist yet** for: full profile patch (only the 3-field `editAgentProfile`
  exists), per-agent credential set/test/remove, and the agent.md → system-prompt assembly path (#329).
  This is a UI spec; the read shapes (`Binding` fingerprint, `AgentDetail.description`) and write/test
  endpoints are backend prerequisites — sequence them before/with the UI build.
- **Rendered markdown** may ship raw-only (escaped, mono) in v1 to avoid an unsanitized renderer; the
  sanitized rendered view is a fast-follow.
- Success rate stays read-only. Deploy/Assign/Interrupt/Reassign/Escalate stay as-is (separate tickets).
