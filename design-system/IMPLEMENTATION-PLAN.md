# Tasca — Authoritative Frontend Implementation Plan

> Lead-architect synthesis of 6 analyses (3×architect + 3×SWE across Auth/org-project,
> Board/drawer/run, Settings/guest) against the current codebase, `docs/PRD.md`, and
> `docs/ROADMAP.md` (milestones M0–M5). This is the single source of truth for porting the
> `design-system/*.html` mockups into the React apps (`packages/remote-web` + `packages/web-core`
> + `@vibe/ui`) and wiring each screen to the correct backend milestone.
>
> **Cardinal rule (non-negotiable):** *Never wire fake/mock data to a surface presented as live.*
> A screen is either (a) **build-now** — wired to a LIVE endpoint/table that exists today, or
> (b) **flag-scaffold** — fully built UI, gated behind a feature flag, wired to the **real** M1/M2/M3/M4/M5
> endpoint that lands later (the flag flips on when the endpoint ships, not before). Empty/loading/error
> states are real states, not placeholder data.

---

## 1. Overview & full app flow

Tasca is the hosted, multi-tenant rebrand of the VK execution core, layered with team auth (M2),
capability-aware tier routing (M1), a PM-assistant (M3), GitHub PR↔ticket automation (M4), and
external-client sandboxing (M5). The remote web client (`packages/remote-web`) is the multi-tenant
shell; it composes container logic and UI from `packages/web-core` and primitives from
`packages/ui` (`@vibe/ui`, 156 components).

End-to-end user flow:

```
Login (/account)                         ── LIVE (M0)
  → OAuth init/redeem  (/account_/complete)
  → Org + Project selection (/)          ── HomePage; org browser → project redirect (M1 chrome partial)
    → App Shell (rail + topbar)          ── RemoteAppShell (partial chrome)
      → Board / Kanban (/projects/$projectId)              ── board LIVE; tier/agent overlays M1
        → Issue Drawer (.../issues/$issueId overlay)        ── drawer LIVE; tier/PR/timeline M1/M4
          → Run View (.../hosts/$hostId/workspaces/$workspaceId
                       OR new .../runs/$runId)               ── NET-NEW; transcript/approval/logs M1, PR M4
      → Settings (/settings/* — new)                         ── general/members LIVE-adjacent; AI key/agents/sprints/flags/tier M3/M1
  → Guest propose-only (guest-scoped board + propose modal)  ── M5 (read-only board + propose; RBAC gate)
```

Cross-cutting context providers thread through every authenticated screen: `OrgContext`,
`ProjectContext`, `ExecutionProcessesProvider`, the TanStack Router tree (`__root.tsx`), the
auth/session layer (PKCE → IndexedDB tokens → JWT 120s access / 365d refresh with rotation), and
the Zustand `useOrganizationStore` (selected org persisted to localStorage and synced to server).

---

## 2. Screen → component-tree + route map

| # | Screen | Route(s) | Top-level component(s) | Component tree (key nodes) |
|---|---|---|---|---|
| 1 | Login | `/account` (alias `/login`) | `LoginPage` (`packages/remote-web/src/pages/LoginPage.tsx`) | `BrandLogo` → `Input`/`Label` (`@vibe/ui`) → `OAuthButton` (custom) → submit |
| 2 | OAuth Callback | `/account_/complete` (alias `/login_/complete`) | `LoginCompletePage` (`packages/remote-web/src/pages/LoginCompletePage.tsx`) | `StatusCard` → redeem flow (`shared/lib/auth.ts`) |
| 3 | Org + Project + App Shell | `/` ; `/projects/$projectId` | `HomePage` (`packages/remote-web/src/pages/HomePage.tsx`); `RemoteAppShell` (`packages/remote-web/src/app/layout/RemoteAppShell.tsx`) | `OrganizationSection` → `ProjectCard[]`; shell: `RemoteDesktopNavbar` (.rail) + `RemoteNavbarContainer` (.topbar) |
| 4 | Board (Kanban) | `/projects/$projectId` | `RemoteProjectKanbanShell` → `ProjectKanban` (`packages/web-core/src/pages/kanban/ProjectKanban.tsx`) | `KanbanContainer` → `KanbanBoard`/`KanbanColumn`/`KanbanCard` (`@vibe/ui`); `ViewNavTabs`; `KanbanFilterBar` (tier); `BulkActionBarContainer` |
| 5 | Issue Drawer | `/projects/$projectId_/issues/$issueId` (overlay) | `KanbanIssuePanelContainer` (`packages/web-core/src/pages/kanban/KanbanIssuePanelContainer.tsx`) | `KanbanIssuePanel` (`@vibe/ui`) → `WYSIWYGEditor`; `IssueCommentsSectionContainer`; `IssueSubIssuesSectionContainer`; `IssueRelationshipsSectionContainer`; `IssueWorkspacesSectionContainer`; `ProjectRightSidebarContainer`; **new** TierPicker, AssigneePickerDropdown, PRCardList, RequiredFieldsChecklist, ActivityTimeline |
| 6 | Run View | `/projects/$projectId_/issues/$issueId_/hosts/$hostId/workspaces/$workspaceId` (today renders board); **new** `/projects/$projectId_/issues/$issueId_/runs/$runId` | **new** `RunPage` (`packages/web-core/src/pages/runs/RunPage.tsx`) | `RunHeader`; `TranscriptContainer` → `TranscriptEntry` → `ToolUseCard` / `ApprovalGateCard`; `LogsPanel` → `LogsViewer`; `PRLinkingModal`/`PRCardDisplay`. Reuse `DisplayConversationEntry`, `SessionChatBoxContainer` (`packages/web-core/src/features/workspace-chat/ui/`), `VirtualizedProcessLogs` |
| 7 | Settings | **new** `/settings` + `/settings/$section` (org, flags, members, agents, sprints, tier) | **new** `SettingsPage` (mirror mockup `set-wrap`) | `SettingsNav`; sections: `OrgGeneralSection` (+AI key), `FeatureFlagsSection`, `MembersRolesSection`, `AgentsSection`, `SprintsSection`, `TierPolicySection`. Reuse `OrganizationsSettingsSection`, `AgentsSettingsSection`, `MemberListItem`, `PendingInvitationItem` |
| 8 | Guest (propose-only) | guest-scoped `/projects/$projectId` (read-only board) + propose modal | `RemoteProjectKanbanShell` with `guest` RBAC variant | `GuestBanner`; read-only `KanbanContainer` (`.kanban.ro`); `ProposeIssueModal`; `Toast`. RBAC via `can_trigger_execution(role)` / role context |

---

## 3. Exists-vs-build matrix (real paths)

| Screen | Status | Evidence (real paths) |
|---|---|---|
| Login | **full** | `packages/remote-web/src/pages/LoginPage.tsx`, `routes/account.tsx`, `shared/lib/{api,pkce,auth}.ts` |
| OAuth Callback | **full** | `packages/remote-web/src/pages/LoginCompletePage.tsx`, `routes/account_.complete.tsx`, `shared/lib/auth.ts` |
| Org + Project + Shell | **partial** | `routes/index.tsx`, `pages/HomePage.tsx`, `app/layout/RemoteAppShell.tsx`, `RemoteDesktopNavbar.tsx`, `RemoteNavbarContainer.tsx`, `shared/stores/useOrganizationStore.ts`. Missing: full rail/topbar chrome (search, notifications, PM-assistant toggle, theme switcher in-shell), drawer integration. |
| Board (Kanban) | **partial→full** | UI exists in `@vibe/ui` (`KanbanBoard`/`KanbanCard`/`KanbanCards`/`KanbanHeader`); container `packages/web-core/src/features/kanban/ui/KanbanContainer.tsx`, `BulkActionBarContainer.tsx`; entry `pages/kanban/ProjectKanban.tsx` **currently renders `ProjectSunsetPage`** and must be swapped to the real board. Filters: `features/kanban/model/hooks/useKanbanFilters.ts`, `shared/stores/useUiPreferencesStore.ts`. |
| Issue Drawer | **partial (≈70%)** | `pages/kanban/KanbanIssuePanelContainer.tsx` (36KB), `IssueCommentsSectionContainer.tsx` (14KB), `IssueSubIssuesSectionContainer.tsx`, `IssueRelationshipsSectionContainer.tsx`, `IssueWorkspacesSectionContainer.tsx`, `ProjectRightSidebarContainer.tsx` (18KB); `@vibe/ui/components/KanbanIssuePanel`, `WYSIWYGEditor`. Net-new: TierPicker, AssigneePickerDropdown (agent vs human), PRCardList, RequiredFieldsChecklist, ActivityTimeline. |
| Run View | **none** | No dedicated page; route `routes/projects.$projectId_.issues.$issueId_.hosts.$hostId.workspaces.$workspaceId.tsx` renders board. Reuse seeds: `features/workspace-chat/ui/DisplayConversationEntry.tsx` (37KB), `SessionChatBoxContainer.tsx` (34KB), `shared/components/VirtualizedProcessLogs.tsx`, `RawLogText.tsx`, `shared/providers/ExecutionProcessesProvider.tsx`, `shared/hooks/{useExecutionProcesses,useWorkspaceExecution}.ts`, `shared/components/tasks/TaskDetails/ProcessesTab.tsx`. |
| Settings | **partial** | Dialog-form sections exist under `packages/web-core/src/shared/dialogs/settings/settings/` (`OrganizationsSettingsSection`, `AgentsSettingsSection`, `RemoteProjectsSettingsSection`, `ReposSettingsSection`, `settingsRegistry.tsx`, rjsf widgets) and `shared/components/settings/ExecutorProfileSelector.tsx`, `shared/components/org/{MemberListItem,PendingInvitationItem}.tsx`. Missing as a **standalone settings *page***: org AI-key card, feature-flag toggles, members+roles (owner/admin/member/guest), sprints CRUD, tier policy. |
| Guest | **none** | No guest board variant; invitations exist (`pages/InvitationPage.tsx`, `routes/invitations.$token.accept.tsx`) but not the propose-only board/modal/RBAC. |

---

## 4. Data & state wiring per screen

| Screen | Sync mechanism | Detail |
|---|---|---|
| Login | **REST + auth/session** | `/v1/auth/methods`, `/v1/oauth/web/init`, `/v1/auth/local/login`. Form state (email/password/pending); `authMethods` TanStack Query; PKCE verifier in `sessionStorage`. |
| OAuth Callback | **REST + auth/session** | `/v1/oauth/web/redeem`. Search params (handoff_id, app_code, error, next); verifier from `sessionStorage`; tokens persisted to **IndexedDB**; open-redirect guard. |
| Org + Project + Shell | **REST + Zustand** | `/v1/organizations`, `/v1/projects`, `/v1/identity`. `selectedOrgId` in Zustand+localStorage (defaults to first non-personal org); projects loaded per-org via `Promise.all`; relay host status. |
| Board | **Electric SQL (real-time) + REST** | Subscribe `issues` shape (columns = `status`/`system_category`, assignees incl. `member_kind='agent'`, `complexity_tier`); REST `GET /projects/:id/issues`, `PATCH /issues/:id`, `POST /issues`. Filter state in `useUiPreferencesStore`. Tier columns require the M1 Electric publication refresh (ROADMAP M1 "Add complexity_tier fields to remote issues table"). |
| Issue Drawer | **Electric SQL + REST** | Issue document + relations stream via Electric; mutations via `PATCH /issues/:id`. Comments `GET/POST /issues/:id/comments`; sub-issues; workspaces; **M1** tier/agent/sprint; **M4** linked-prs; activity timeline from `issue_events`/`activity` (Electric). |
| Run View | **streaming (SSE/WS) + REST** | `ExecutionProcessesProvider` context; `GET /workspaces/:id/execution-processes[/:pid/{transcript,logs}]`; control `POST .../pause|stop|approval`. Real-time transcript+logs via SSE/WS (server-side; decision #14 SSE proxy posture). Logs are a circular buffer; ANSI tokenized. |
| Settings | **REST + auth/session** | Org general + members: `/v1/organizations/:id`, member/role endpoints. **M3** org AI key (masked GET, owner/admin set/rotate/validate — never returns plaintext). **M1** agents/sprints/tier policy. Feature flags: org-settings REST. |
| Guest | **Electric SQL (read-only) + REST (propose)** | Guest reads issues shape filtered to allowed projects; propose = `POST /issues` creating a `proposed`/`trust_state='proposed'` ticket. RBAC enforced **server-side** (M5 `can_trigger_execution(role)`); client only hides affordances. |

---

## 5. Backend-dependency matrix

| Screen | Live now | M1 (routing core) | M2 (auth) | M3 (PM-assistant) | M4 (PR↔ticket) | M5 (guest/sandbox) | Endpoints / tables | PRD / ROADMAP refs |
|---|---|---|---|---|---|---|---|---|
| Login | ✅ | — | hardens (register/verify/reset/lockout/account-link UI) | — | — | — | `/v1/auth/*`, `users` | PRD §7; ROADMAP M2 "Build auth-lifecycle frontend" |
| OAuth Callback | ✅ | — | account-link collision | — | — | — | `/v1/oauth/web/redeem`, `oauth_accounts` | PRD §7.2; ROADMAP M2 "OAuth/local email collision" |
| Org + Project + Shell | ✅ (org/project list) | role-aware nav | owner/admin/member/guest roles | PM-assistant toggle | — | guest-scoped nav | `/v1/organizations`, `/v1/projects`, `member_role` | PRD §3; ROADMAP M2 "Extend member_role enum" |
| Board | ✅ (board/columns/cards) | tier badge+filter, agent assignee, status enum (`ready_for_development`,`needs_attention`) | permission checks on bulk actions | — | PR badge auto-sync | read-only variant | `issues`, `tasks`, `project_statuses.system_category`; Electric | PRD §4.1/§4.2/§9.3; ROADMAP M1 tier/agent, M4 system_category |
| Issue Drawer | ✅ (title/desc/comments/sub-issues/workspaces) | tier picker, agent field, sprint selector, required-fields gate | edit/delete role checks | tier source/confidence display | PR link modal + multi-PR tabs | — | `issues`, `agents`, `sprints`, `issue_pull_requests`, `issue_events` | PRD §4.1–§4.5, §6.1; ROADMAP M1 fields/gate, M4 linkage |
| Run View | ⚠️ workspace list only | ExecutionProcess + approval gates + transcript/logs | per-team approval permission | — | linked PR widget | sandbox/supervised badges | `execution_processes`, approval gate state, `/workspaces/:id/execution-processes/*` | PRD §5; ROADMAP M1 (engine/approval), M5 (supervised/sandbox) |
| Settings | ✅ (org general, members list) | agents CRUD, sprints CRUD, tier policy | roles owner/admin/member/guest | org Anthropic key store + validate, feature flags | repo connect (project↔repo) | — | `organization_ai_keys`, `agents`, `sprints`, `project_github_repos` | PRD §8.2, §3, §4.3; ROADMAP M3 key store, M1 agents/sprints, M4 repo connect |
| Guest | ❌ unbuilt | — | guest role recognized | — | — | `trust_state` gate, propose flow, `can_trigger_execution(role)` | `issues.trust_state`, propose `POST /issues` | PRD §10, §3; ROADMAP M5 "Gate execution behind internal trust tier" |

Status legend: ✅ live · ⚠️ partial (route/provider exists, page unbuilt) · ❌ unbuilt.

---

## 6. Port plan per screen (mockup HTML/classes → React + CSS integration)

**CSS strategy (applies to all):** the design system ships `tokens.css` (primitive→semantic→component,
light+dark via `data-theme`), `app.css` (semantic component layer: `.shell`, `.rail`, `.topbar`,
`.kanban`, `.kcol`, `.kc`, `.drawer`, `.scrim`, `.approval`, `.logs-tabs`, `.modal-scrim`, `.set-wrap`,
`.guest-banner`), `states.css` (state variants: `.on/.off/.awaiting/.approved/.changes/.done/.todo`),
`components.css`, and `a11y.css`. Tailwind v4 maps tokens via `tailwind-theme.css` `@theme`.
**Integration rule:** keep mockup semantic class names as the component-layer source of truth (CSS
custom properties, not utility soup); use Tailwind utilities only for one-off layout. **Verify the
`@theme` block enumerates every custom property** (`--fg`, `--bg`, `--surface`, `--line`, `--signal`,
`--amber`, `--green`, `--red`, `--violet`, `--purple`, `--t-basic/low/medium/hard/ultra`, `--exec-running`,
`--diff-add-fg`, `--diff-del-fg`, the 16 `--ansi-*`) so Tailwind utilities never clash with the CSS layer.

| Screen | Mockup file | Port notes |
|---|---|---|
| Login | `design-system/login.html` | Mockup is split-screen; React is centered card. Decide single layout. Replace hardcoded OAuth button colors (`#f2f2f2`, Roboto) with `OAuthButton` consuming tokens. Move PKCE verifier off `sessionStorage`-only (reload-loss risk) — mirror to IndexedDB. |
| Org + Shell | `design-system/app.html` (`.shell`→`.rail`+`.main`) | Build `.rail` (5 nav buttons + avatar) from `RemoteDesktopNavbar`; `.topbar` (crumb/search/notifications/PM-assistant toggle/theme switcher) from `RemoteNavbarContainer` + `AppBarNotificationBellContainer`. Wire in-shell theme switcher (`theme.js` pattern → React, persists to localStorage, applies before paint). |
| Board | `design-system/app.html` | `.kanban` (flex gap 14px, overflow-x auto) → `KanbanBoard` wrapper mapping Electric columns; `.kcol` (290px) → `KanbanColumn` w/ `useKanbanFilters`; `.kcol-head` count+add → composer; `.kc`/`.kc-top`/`.kc-title`/`.kc-foot` → `KanbanCard`. Tier badges from `--t-*`. Tabs `.tabs` → `ViewNavTabs`. Tier filter `.tfilter` (5 on/off opacity states) → `KanbanFilterBar`/TierFilterDropdown. Swap `ProjectSunsetPage` for the live board. |
| Issue Drawer | `design-system/app.html` (`.drawer`, `.scrim`) | Right panel `transform: translateX(100%)` slide; manage open via `:issueId` route param + composer Zustand. `.d-grid` (1fr/188px) metadata grid → `MetadataRow[]`. `.tierpick` → `TierPicker` (`--t-*`, on/off opacity+box-shadow). `.assignee`/`.pick-item` → `AssigneePickerDropdown` (visual robot badge for `member_kind='agent'`). `.pr-card`/`.sb-review`/`.sb-merged` → `PRCardList`. `.reqs`/`.req.done`/`.req.todo` → `RequiredFieldsChecklist`. `.d-section` → `ActivityTimeline`. |
| Run View | `design-system/run.html` | NET-NEW page. `.run-head` (`.agent-badge`, `.run-status .pulse`, `.run-turns`, pause/stop) → `RunHeader`. `.run-conv`/`.entry`/`.ico`/`.ehead`/`.etext` → `TranscriptContainer`/`TranscriptEntry` (reuse `DisplayConversationEntry`). `.tooluse`/`.th` → `ToolUseCard` (`--diff-add-fg`/`--diff-del-fg`). `.approval.awaiting/.approved/.changes`/`.ah`/`.ab`/`.aa` → `ApprovalGateCard` state machine. `.run-logs`/`.logs-tabs`(Logs/Diff/Env)/`.logs-pane`/`.log-line`/`.ts` → `LogsPanel`/`LogsViewer` (16 `--ansi-*` tokens; reuse `VirtualizedProcessLogs`). `.modal-scrim`/`.modal` → `PRLinkingModal`. |
| Settings | `design-system/settings.html` | `.set-wrap` (232px nav + content), `.set-nav` groups (Organization / Delivery), `.set-section.on` → routed sections. `.keyfield` (masked input + Rotate/Validate) → org AI-key card. `.tbl`/`.mrow` → members table. `.agent-card`/`.acap` → agents list (reuse `AgentsSettingsSection`). `.ff-grid`/`.addform` → feature-flag toggles + add forms. |
| Guest | `design-system/guest.html` | `.guest-banner` (shield icon + propose-only chip) → `GuestBanner`. `.kanban.ro` (no hover transform, `cursor:default`) → read-only board. `.col-line.cl-proposed`/`.pending` → Proposed column. `.modal-scrim`/`.modal`/`.char` → `ProposeIssueModal` (title+textarea+charcount). `.toast` → success toast. |

---

## 7. Reuse vs net-new component inventory

**Reuse (no/low change):**
- `@vibe/ui`: `KanbanBoard`, `KanbanCard`, `KanbanCards`, `KanbanHeader`, `KanbanIssuePanel`, `IssuePropertyRow`, `IssueTagsRow`, `WYSIWYGEditor`, `ConfirmDialog`, `ViewNavTabs`, `KanbanFilterBar`, `RunningDots`, `Input`/`Label`/`Button`.
- `packages/web-core`: `KanbanContainer`, `BulkActionBarContainer`, `KanbanIssuePanelContainer`, `IssueCommentsSectionContainer`, `IssueSubIssuesSectionContainer`, `IssueRelationshipsSectionContainer`, `IssueWorkspacesSectionContainer`, `ProjectRightSidebarContainer`, `AssigneeSelectionDialog`, `KanbanFiltersDialog`, `SearchableTagDropdownContainer`, `WYSIWYGEditor`, `VirtualizedProcessLogs`, `RawLogText`, `AgentIcon`, `ExecutionProcessesProvider`, `useExecutionProcesses`, `useWorkspaceExecution`, `useKanbanFilters`, `useUiPreferencesStore`.
- Run transcript seeds: `features/workspace-chat/ui/DisplayConversationEntry.tsx`, `SessionChatBoxContainer.tsx`.
- Settings seeds: `shared/dialogs/settings/settings/{OrganizationsSettingsSection,AgentsSettingsSection,RemoteProjectsSettingsSection,ReposSettingsSection,settingsRegistry}.tsx`, `shared/components/settings/ExecutorProfileSelector.tsx`, `shared/components/org/{MemberListItem,PendingInvitationItem}.tsx`.
- Shell: `RemoteAppShell`, `RemoteDesktopNavbar`, `RemoteNavbarContainer`, `AppBarNotificationBellContainer`.

**Net-new:**
- Board: `TierFilterDropdown`, agent-vs-human card affordance, `IssueDragDropLayer` (react-dropzone).
- Drawer: `TierPicker`, `AssigneePickerDropdown` (agent badge), `PRCardList`, `RequiredFieldsChecklist`, `ActivityTimeline`, `MetadataRow`, `DrawerHeader`/`DrawerBody`.
- Run View (`packages/web-core/src/pages/runs/`): `RunPage`, `RunHeader`, `TranscriptContainer`, `TranscriptEntry`, `ToolUseCard`, `ApprovalGateCard`, `LogsPanel`, `LogsViewer`, `PRLinkingModal`, `PRCardDisplay`. New route `routes/projects.$projectId_.issues.$issueId_.runs.$runId.tsx`.
- Settings page (`packages/remote-web/src/pages/SettingsPage.tsx` + sections): `SettingsNav`, `OrgGeneralSection` (+AI-key card), `FeatureFlagsSection`, `MembersRolesSection`, `SprintsSection`, `TierPolicySection`. New routes `routes/settings.tsx` + `routes/settings_.$section.tsx`.
- Guest: `GuestBanner`, read-only `KanbanContainer` variant, `ProposeIssueModal`, `Toast`, role/RBAC context utility.

---

## 8. Build-now vs flag-scaffold split

**Build-now (wired to LIVE endpoints today) — 4 screens:**
1. **Login** — live `/v1/auth/*`.
2. **OAuth Callback** — live `/v1/oauth/web/redeem`.
3. **Org + Project + App Shell** — live `/v1/organizations`, `/v1/projects`, `/v1/identity`. Ship base chrome now; role-aware items behind `flag.roles` (M2).
4. **Board (core)** — live board/columns/cards/composer/bulk actions via Electric `issues` + REST. Swap `ProjectSunsetPage` → `KanbanContainer`. Tier badge/filter + agent-assignee rendering ship **dark behind `flag.tiers`/`flag.agents`** until the M1 Electric tier columns + synthetic agent member land, then flip.

**Flag-scaffold (UI built now, wired to the REAL endpoint, flipped when the milestone lands):**

| Screen / feature | Flag | Real endpoint/table it waits on | Milestone |
|---|---|---|---|
| Issue Drawer: TierPicker, required-fields gate | `flag.tiers` | `issues.complexity_tier` (Electric refresh), `validate_required_fields` | M1 |
| Issue Drawer: AssigneePickerDropdown agent options | `flag.agents` | synthetic `users.member_kind='agent'`, `agents` table | M1 |
| Issue Drawer: Sprint selector | `flag.sprints` | `sprints` table, `issues.sprint_id` | M1 |
| Issue Drawer / Run View: PR link modal + multi-PR | `flag.github_pr` | `issue_pull_requests`, `project_github_repos`, webhook linker | M4 |
| Issue Drawer / Board: activity timeline (agent/assistant actors) | `flag.audit_timeline` | `issue_events`/org `audit_log` (Electric) | M1/M3 |
| Run View: full page (transcript/approval/logs) | `flag.run_view` | `execution_processes` + approval-gate state + SSE stream | M1 |
| Run View: supervised/sandbox badges | `flag.sandbox` | trust-tier resolution + `sandbox_profile` | M5 |
| Settings: org Anthropic key card | `flag.pm_assistant` | `organization_ai_keys` + `validate_key` | M3 |
| Settings: feature-flag toggles | (meta) | org-settings REST | M3 |
| Settings: Members & roles (owner/guest) | `flag.roles` | `member_role` enum owner/admin/member/guest | M2 |
| Settings: Agents CRUD | `flag.agents` | remote `agents` repo | M1/M3 |
| Settings: Sprints CRUD | `flag.sprints` | `sprints` table | M1 |
| Settings: Tier policy | `flag.tiers` | per-tier prompt templates / required-field config | M1 |
| PM-assistant panel (shell + chat) | `flag.pm_assistant` | SSE proxy → Messages API (decision #14) | M3 |
| Guest propose-only board + modal + RBAC | `flag.guest` | `trust_state` + `can_trigger_execution(role)` | M5 |

**Hard guardrails:** every flag defaults **off**; a flag may only flip to **on** in an environment
where its named endpoint/table returns real data. No component renders seeded/sample rows. Empty,
loading, and error states (already in `states.css`) are the *only* placeholder content allowed.

---

## 9. Test plan + color-guard / WCAG-AA constraints

**Unit (Vitest + RTL):**
- TierPicker (5 tiers × on/off), AssigneePickerDropdown (agent vs human branch on `member_kind`), RequiredFieldsChecklist (per-tier PRD §6.1 field sets), ApprovalGateCard state machine (`awaiting→approved|changes|denied`), LogsViewer ANSI→token mapping (all 16), feature-flag gating (off ⇒ no network, no render).

**Integration:**
- Board: column drag-drop, tier filter combinatorics (5 states × N issues), drawer open/close via route param, composer create, bulk actions.
- Drawer: tier/assignee mutation → Electric optimistic update, comment create/delete, sub-issue/relationship expand.
- Run View: SSE stream tail + reconnect/backfill, approval approve→next-turn appears, pause/stop, PR modal open/select/link (mutation gated behind `flag.github_pr`).
- Settings: AI-key set/rotate/validate never returns plaintext (assert masked); role gating (non-admin blocked); agents/sprints CRUD.
- Guest: propose modal → `proposed` ticket; assert **no** run/assign affordance reachable and server 403 on a forced execution attempt (RBAC is server-authoritative).

**Visual / regression:**
- Snapshot each ported screen against its mockup in **both** `data-theme` light and dark.
- Verify flag-off renders empty/skeleton (`states.css`), never fake rows.

**Color-guard + WCAG 2.2 AA (gating):**
- All foreground/background pairs must pass AA (4.5:1 text, 3:1 large/UI). Tier tokens are already AA-tuned per `REMAINING-WORK.md`; re-verify any new `color-mix()` surfaces against the live WCAG matrix in `design-system/tokens.html`.
- Color-guard: forbid literal hex in ported React (lint rule) — components must consume tokens (`--fg`, `--t-*`, `--ansi-*`); brand-mark logo fills are the only sanctioned literals.
- A11y must-pass (already established in `a11y.css`/`a11y.js`, port to React): focus-visible rings on every interactive node; `role="dialog"`+`aria-modal`+focus-trap+return-focus on drawer/assistant/modals; `role="button"`+`tabindex=0`+Enter/Space on kanban cards; ARIA live region (`tascaAnnounce`) for filter/empty-state changes; icon-button `aria-label`; reduced-motion sweep; 44px touch targets on coarse pointers; skip-link + `#main`. Run axe/Lighthouse + a manual screen-reader pass before each screen ships.

---

## 10. Risks, conflicts & sequencing

**Top risks / conflicts with in-flight M1/M2:**
1. **Board `ProjectSunsetPage` placeholder masks the real board** — swapping it in is the first build-now move; it can hide regressions in tier/agent rendering. Land the swap behind a quick smoke test.
2. **M1 schema not final** — TierPicker, agent field, sprint selector, and required-fields gate cannot be *flipped on* until `issues.complexity_tier` (Electric publication refresh), the synthetic `member_kind='agent'` user, `sprints`, and `validate_required_fields` land. Build the UI now behind flags wired to those exact endpoints; do **not** flip until they return real data. (ROADMAP M1.)
3. **Agent-as-assignee ambiguity** — humans vs agents must be visually unmistakable (robot badge) or users mis-assign. Server uses synthetic users (`member_kind='agent'`); the picker must branch on that flag, not heuristics.
4. **Run View is the largest net-new surface** and depends on an unfinalized `ExecutionProcess` model + unconfirmed real-time transport (SSE vs WS). Approval-gate state machine risks race conditions (pending→approved→executing) and infinite retry loops (cap retries per gate). Large transcripts/logs need virtualization (`VirtualizedProcessLogs`). This is the schedule long-pole.
5. **M2 permission checks** gate Board bulk actions, Drawer edit/delete, and Run approval — until owner/admin/member/guest roles ship (ROADMAP M2 enum), render single-user behavior behind `flag.roles`.
6. **M4 PR linking** (Drawer + Run) requires GitHub webhook/state-machine + `system_category` mapper. Stub modal/card UI now; gate **all** mutations behind `flag.github_pr`; do not implement GitHub API integration ahead of M4.
7. **Cross-screen tier consistency** — tier badges must render identically (Board filter, Drawer picker, Run header) via the same `--t-*` tokens; centralize the tier-badge component to avoid drift.
8. **PKCE verifier in `sessionStorage`** is lost on reload mid-flow (Login + Callback) — mirror to IndexedDB.
9. **Tailwind `@theme` coverage gap** could let utilities clash with the CSS layer — verify `tailwind-theme.css` enumerates all tokens before porting color-bearing screens (test the Board first).
10. **PM-assistant key exposure** — the org Anthropic key must never reach the browser; stream via the server-side SSE proxy (decision #14). Settings GET must return masked value only.

**Recommended sequencing:**
1. **Now (M0/M1 base, no backend wait):** Login + OAuth Callback polish (token-loss fix), App Shell chrome (rail/topbar/theme switcher), Board core (swap `ProjectSunsetPage` → live `KanbanContainer`). Verify Tailwind `@theme` coverage on Board.
2. **With M1:** Flip Board tier/agent flags; ship Drawer TierPicker + AssigneePickerDropdown + Sprint selector + RequiredFieldsChecklist; stand up Run View page behind `flag.run_view` wired to `execution_processes`/approval gates/SSE.
3. **With M2:** Members & roles settings; flip `flag.roles`; enable permission checks on bulk actions / edit-delete / approval.
4. **With M3:** Org Anthropic key card + feature-flag toggles + PM-assistant panel (SSE proxy); Agents/Tier-policy settings.
5. **With M4:** Flip `flag.github_pr` — PR link modal, multi-PR tabs, Run linked-PR widget; project↔repo connect in Settings.
6. **With M5:** Guest propose-only board + modal + RBAC; Run supervised/sandbox badges (`flag.sandbox`).

This ordering keeps build-now screens live immediately and lets each flag-scaffolded screen flip the
moment its named endpoint lands — never showing fake data as live.
