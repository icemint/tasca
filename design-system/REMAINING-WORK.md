# Tasca — Build vs. Spec: Remaining Work

Audit of what's been designed against `PRD.md` and `DESIGN-SPEC.md` (§5–§7 + the 149-item §9.2 backlog).
Legend: ✅ done · ◑ partial · ◻ not started.

---

## What's shipped

**Foundation**
- ✅ Token system — `tokens.css`: primitive → semantic → component, **light + dark** via `data-theme`.
- ✅ Full **tier scale** basic→ultra (themed, AA-tuned) + **review-state** + **exec-state** tokens.
- ✅ Type scale (incl. Space Grotesk display), weights, tracking; **spacing** (8-pt), **radii**, **elevation/shadow**, **z-index**, **opacity**, **motion**.
- ✅ **Diff / 9 syntax roles / 16-color ANSI** tokens (both themes).
- ✅ **Tailwind v4 `@theme`** mapping (`tailwind-theme.css`).
- ✅ Standardized **focus-ring** token; **skip-link** (home + app).
- ✅ Component **state variants** for Button, Input, Checkbox, Select, Card (focus/active/disabled/loading/error/selected/indeterminate).
- ✅ Reference pages: `tokens.html` (live **WCAG matrix**, dark/light) + `components.html` (state matrix).

**Surfaces**
- ✅ Marketing site — Home, Docs, Security, Terms, Privacy (hosted-first).
- ✅ Auth — Login (Google OAuth) + 404/error.
- ✅ App — board, **issue drawer** (tier selector, agent-as-assignee picker, PR widget, required-fields), **PM-assistant** panel.

---

## Remaining — by spec area

### §6 New-feature screens
- ◻ **Org Settings** — Anthropic API key (masked + validate), **feature flags** (tiers/PM-assistant/GitHub/guest), **member permissions + roles** (owner/admin/member/guest), **tier policy**. *(P0: "Add org-level API key settings"; P1: "feature-flag toggles".)*
- ◻ **Agents management** screen — availability, min/max tier, concurrency, base_url/credential.
- ◻ **Sprints management** UI — list + CRUD. *(P1)*
- ◻ **Guest propose-only** — read-only list/detail + "Propose issue" modal + RBAC utility. *(P2 / PRD §10, M5.)*
- ◑ **GitHub PR↔ticket surface** — badges + auto-sync toggle + rules exist in the drawer; still need the **link/unlink modal w/ autocomplete**, multi-PR tabs, reviewer avatar stack. *(P1)*
- ◻ **ExecutionProcess view** (running agent, turn count, approval gate, linked PR) + **Logs panel** (stderr/tool output/transcript). *(P1, M4.)*
- ◑ Auth lifecycle — login/error done; **register, email-verify, password-reset, lockout (423), account-link** screens not built. *(PRD §7.)*

### §5.2 Review / diff / agent-run
- ◑ Diff/review/exec **tokens** done; **components** that consume them (diff viewer card, PR-comment card w/ `review_state`, approval card with awaiting/changes/approved/denied variants, conversation-row exec status icons) not built.
- ◻ Approve / Request-changes / Deny **action buttons** in the approval workflow.

### §7 Accessibility (WCAG 2.2 AA)
- ✅ **Reduced-motion** — global sweep in `a11y.css` (all animation/transition neutralized under the media query).
- ✅ **Keyboard** — kanban cards are `role="button"` + `tabindex=0` with Enter/Space activation (`a11y.js`).
- ✅ **Dialog a11y** — `role=dialog` + `aria-modal`, focus-trap, and **return-focus** auto-applied to drawer/assistant/modals via `a11y.js` (verified open→trap→Esc→return).
- ✅ **Focus-visible rings** standardized on every interactive element; **skip-link + `#main`** on all pages.
- ✅ **ARIA live region** — `window.tascaAnnounce()` + assistant body `aria-live`; board labelled `role="list"`.
- ✅ **Icon-button SR labels** — `title`→`aria-label` mirrored automatically for icon-only controls.
- ◑ Automated (axe/Lighthouse) + manual screen-reader audit pass still recommended before ship.

### Responsive
- ✅ **App is now responsive** — rail collapses to a bottom bar < 860px, board columns become swipe/snap, drawer + assistant go full-screen sheet < 640px, 44px touch targets on coarse pointers.
- ✅ Marketing + auth pages already responsive.

### Empty / loading / system states
- ✅ **Skeleton loaders** (shimmer, kanban-card footprint) + **empty states** — `states.css`, documented in `components.html`.
- ✅ **Board empty state** wired live — tier filter + search combine and show a "No issues match / Clear filters" state with an ARIA announce.
- ✅ **Global theme switcher** — `theme.js` (persists to localStorage, applies before paint, system-aware), segmented control in the app topbar; the whole app honors it across pages.

### Tokens — lower-priority polish
- ◻ Token **source-of-truth as JSON/YAML + build pipeline** (we ship hand-authored CSS; spec wants generated). *(P0/P1 "build pipeline" items.)*
- ◻ Formal **naming-convention** + color-space + versioning **docs**.
- ◻ Syntax **theme variants** (Monokai/Solarized), **colorblind-safe** palette.
- ◑ **Theme-switcher UI** lives in the app (token-driven, adapts cleanly). Marketing/auth pages still have a few literal dark values (sticky-header glass, hero gradients) that won't fully adapt to light — switcher intentionally kept out of those until they're tokenized.

---

## Notes / non-goals
- Items framed as codebase refactors (CVA across 18 React components, Pierre/pr-comment refactors, `useIsMobile`→breakpoint migration, Figma export, visual-regression CI) are **engineering tasks in the real repo** — our deliverables provide the tokens/specs they consume.
- Brand-mark logo fills are intentionally literal (a logo is a fixed constant, not a themed token).

## Suggested order
1. **Settings cluster** (Org Settings + Agents + Sprints) — clears the most P0/P1 flow items at once.
2. **Guest propose-only** + RBAC.
3. **GitHub link/unlink modal + ExecutionProcess/Logs** views.
4. **A11y pass** (dialog focus-trap, ARIA live, reduced-motion sweep) + **responsive app**.
5. Empty/loading states; token-pipeline + docs polish.

## Feature-flag guardrail

The app's feature flags (`packages/web-core/src/shared/flags`) gate UI that is
scaffolded ahead of its backend (tiers/agents/sprints/run-view/PR-linking/etc.).
Rules:

- Every flag **defaults off**. Resolution order: env (`VITE_FLAG_*`, build-time)
  → organization settings (runtime) → off.
- A flag may only be turned **on** in an environment where its named endpoint or
  table returns **real** data.
- **No-seeded-data:** a flagged component must never render sample/seeded rows.
  The only allowed placeholder content is the empty / loading / error states in
  `states.css`.

Build-now vs flag-scaffold split per screen is tracked in the M-AppUI milestone
issues (#98–#116) and the per-milestone flag-flip tickets (#117–#121).
