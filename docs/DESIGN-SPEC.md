# Tasca — Design & Branding Specification

> **Tier-A target. 100% UI-surface coverage.** Produced by a read-only 9-agent design discovery (3 UI/frontend + 3 UX architects + 3 senior UI engineers) auditing the live React/TS/Tailwind/shadcn frontend against [`docs/PRD.md`](PRD.md) + [`docs/ROADMAP.md`](ROADMAP.md). No code changed; all values/refs cite real files. Source spec for restyling Tasca to our own brand.

**Contents:** 1. Current-state audit · 2. Brand foundation slots · 3. Target token spec · 4. Component standards · 5. IA & key flows · 6. New-feature screens · 7. Accessibility (WCAG 2.2 AA) · 8. Theming/rebrand plan · 9. Gaps & prioritized backlog · 10. Open questions.


---

## 1. Current-state UI audit

### 1.1 Theme system & design tokens (current)
#### Current Theme System Architecture

**Tailwind Config**: `/packages/local-web/tailwind.new.config.js` (186 lines)
- Dark mode: class-based (`darkMode: ["class"]`)
- Sizing system: 2xs (0.5), xs (0.75), sm (0.875), base (1), lg (1.125), xl (1.25)
- Icon sizes: multiplied by 1.25 (icon-2xs: 0.625rem through icon-xl: 1.5625rem)
- Spacing tokens: half (0.125rem), base (0.25rem), plusfifty (0.375rem), double (0.5rem)
- Typography: IBM Plex Sans (0.75-1.25rem calculated), IBM Plex Mono
- Border radius: lg/md/sm via 0.25 multiplier (0.28125rem, 0.21875rem, 0.21875rem)
- Color refs: `hsl(var(--COLOR-NAME))` for all colors

**CSS Custom Properties**: `/packages/web-core/src/app/styles/new/index.css` (485 lines, lines 15-163)

##### Light Mode Colors (`:root`)
- **Text**: --text-high (0 0% 5%), --text-normal (0 0% 20%), --text-low (0 0% 39%)
- **Background**: --_bg-primary-default (0 0% 100%), --_bg-secondary-default (0 0% 95%), --_bg-panel-default (0 0% 89%)
- **Brand**: --brand (25 82% 54%), --brand-hover (25 75% 62%), --brand-secondary (25 82% 37%), --text-on-brand (0 0% 100%)
- **Status**: --_success (117 38% 50%), --_warning (32 95% 44%), --_info (217 91% 60%), --_destructive (0 59% 57%)
- **Syntax (hex)**: --_syntax-keyword (#d73a49), --_syntax-function (#6f42c1), --_syntax-constant (#005cc5), --_syntax-string (#032f62), --_syntax-variable (#e36209), --_syntax-comment (#6a737d)

##### Dark Mode Colors (`.dark`)
- **Text**: --text-high (0 0% 96%), --text-normal (0 0% 77%), --text-low (0 0% 56%)
- **Background**: --_bg-primary-default (0 0% 13%), --_bg-secondary-default (0 0% 11%), --_bg-panel-default (0 0% 16%)
- **Brand**: Unchanged (25 82% 54%), --brand-secondary darkened to 25 82% 66%
- **Status**: Success/warning/info maintained, --_destructive unchanged (0 59% 57%)
- **Syntax (hex)**: --_syntax-keyword (#ff7b72), --_syntax-function (#d2a8ff), --_syntax-constant (#79c0ff), --_syntax-string (#a5d6ff), --_syntax-variable (#ffa657), --_syntax-comment (#8b949e)

**Diff Styles**: `/packages/ui/src/styles/diff-style-overrides.css` (47 lines, 1-13)
- Light: --line-added (160 77% 88%), --line-removed (10 100% 90%), --line-unchanged (var(--bg-primary)), --line-number-color (var(--text-low))
- Dark: --line-added (130 30% 20%), --line-removed (12 30% 18%), --line-unchanged (var(--bg-panel)), --line-number-color (var(--text-low))

**Component Token Usage**: 278 component files use className
- Heavy adoption of spacing tokens (half, base, plusfifty, double) in `.tsx` files
- Border radius: rounded-sm (xs multiplier), rounded-md (sm), rounded-lg (lg) used consistently
- Color usage patterns:
  - Brand accent: className includes brand, brand-hover, brand-secondary
  - Status: error, success, merged tokens tokenized
  - Text: high, normal, low usage throughout components
- ANSI color utilities (ansi-red through ansi-bright-white) with light/dark mode pairs

**Hardcoded Values Found** (from grep audit):
- Google Logo colors: #EA4335 (red), #4285F4 (blue), #FBBC05 (yellow), #34A853 (green) in GoogleLogo.tsx
- Inline styles with dynamic HSL: `style={{ backgroundColor: \`hsl(\${color})\` }}` in KanbanBadge.tsx, KanbanBoard.tsx, StatusDot.tsx, IssueTagsRow.tsx
- Shadow definitions: shadow-[2px_2px_4px_rgba(121,121,121,0.25)] (ContextBar.tsx:18), shadow-[inset_2px_2px_5px_rgba(255,255,255,0.03),_0_0_10px_rgba(0,0,0,0.2)] (ContextBar.tsx:19)
- Diff tooltip hardcoded colors: #555555 (background), #ffffff (text) at diff-style-overrides.css:476-500
- Dynamic linear gradients using hsl(var(--brand)), hsl(var(--brand-secondary)) in animations

**Tailwind Classes with Hardcoded Values**:
- `shadow-[inset_2px_2px_5px_rgba(255,255,255,0.03),_0_0_10px_rgba(0,0,0,0.2)]` (ContextBar.tsx)
- `shadow-[0_4px_24px_rgba(0,0,0,0.3)]` (BulkActionBar.tsx)
- `drop-shadow-[2px_2px_4px_rgba(121,121,121,0.25)]` (ContextBar.tsx)
- `rounded-[2rem]` (PreviewBrowser.tsx), `rounded-[1.5rem]`, `rounded-[0.2em]`
- Arbitrary opacity: opacity-0, opacity-40, opacity-50, opacity-100 (semantic use)

**Mobile Overrides** (index.css:463-484):
- #f2f2f2 light mode (px-safe-area)
- #212121 dark mode (px-safe-area)
- font-size scale variable: --mobile-font-scale

**Font Imports**: Google Fonts (@import url) for IBM Plex Sans, IBM Plex Mono, Noto Emoji, Roboto (line 1)

**VS Code Integration**: CSS vars with fallback pattern
- --bg-primary: var(--vscode-editor-background, var(--_bg-primary-default))
- --brand: var(--text-on-brand) from index.css:86 (text on accent tokens)

### 1.2 Component library & states (current)
#### Shadcn/UI Primitives In Use

**Core Primitives (Radix):**
- Button (6 variants: default, destructive, outline, secondary, ghost, link, icon): /Users/macpro/Documents/tasca/packages/ui/src/components/Button.tsx:8-38
  - States: disabled (opacity-50, pointer-events-none), focus-visible (ring-1 ring-ring/40), hover (variant-dependent bg shifts)
  - Missing: active, loading, loading-error states
- Dialog (Radix + DialogPrimitive): /Users/macpro/Documents/tasca/packages/ui/src/components/Dialog.tsx:1-141
  - States: open/closed (data-[state=open/closed] with fade-in-0 zoom-in-95 animations), overlay z-[9998], content z-[9999]
  - Close button: opacity-70 hover:opacity-100 focus:ring-2
  - Missing: accessibility checks for dialog return focus
- Input (text, with custom keyboard handlers): /Users/macpro/Documents/tasca/packages/ui/src/components/Input.tsx:11-55
  - States: focus-visible (outline-none), disabled (cursor-not-allowed opacity-50), file variant
  - Custom: onCommandEnter, onCommandShiftEnter handlers, Escape blur
  - Missing: error state styling, aria-invalid, loading state
- Checkbox (custom button-based, lucide Check icon): /Users/macpro/Documents/tasca/packages/ui/src/components/Checkbox.tsx:13-44
  - States: checked (bg-primary text-primary-foreground), focus-visible (ring-2), disabled (opacity-50)
  - Missing: indeterminate state, loading state
- Dropdown (Radix + phosphor icons): /Users/macpro/Documents/tasca/packages/ui/src/components/Dropdown.tsx:1-378
  - Variants: DropdownMenuTriggerButton (icon, label, caret), DropdownMenuItem (icon, badge, variant destructive), CheckboxItem, RadioItem
  - States: focus (bg-secondary), data-[state=open], data-[disabled], preventFocusOnHover
  - Icons: phosphor CaretDownIcon, CaretRightIcon, CheckIcon, MagnifyingGlassIcon (weight='bold')
  - SearchInput subcomponent
  - Missing: hover loading spinner, keyboard shortcut hints aligned right
- Tooltip (Radix + shortcut kbd): /Users/macpro/Documents/tasca/packages/ui/src/components/Tooltip.tsx:14-54
  - Delay: 300ms, side positioning (top/bottom/left/right), kbd child for shortcuts
  - States: animate-in fade-in-0 zoom-in-95
  - Kbd styling: border border-border bg-secondary font-ibm-plex-mono
  - Missing: aria-hidden on non-essential tooltips
- Card (layout primitives): /Users/macpro/Documents/tasca/packages/ui/src/components/Card.tsx:1-84
  - Subcomponents: CardHeader, CardTitle, CardDescription, CardContent (p-6 pt-0), CardFooter
  - No variant system
  - Missing: elevation/shadow variants, state styling

**Custom Buttons & Badges:**
- PrimaryButton (variant: default/secondary/tertiary + disabled styling): /Users/macpro/Documents/tasca/packages/ui/src/components/PrimaryButton.tsx:1-52
  - States: disabled (cursor-not-allowed bg-panel), actionIcon spinner variant (SpinnerIcon animate-spin)
  - Hardcoded colors: bg-brand hover:bg-brand-hover text-on-brand | bg-brand-secondary hover:bg-brand-hover | bg-panel hover:bg-secondary text-normal
  - Missing: focus states, loading state separate from disabled
- KanbanBadge (colored dot indicator): /Users/macpro/Documents/tasca/packages/ui/src/components/KanbanBadge.tsx:11-32
  - **CRITICAL BLOCKER**: Inline style with HSL color injection: `style={{ backgroundColor: \`hsl(\${color})\` }}` (line 26)
  - No variant system, no size scaling
  - Missing: interactive states

#### Icon Library

**Phosphor Icons** (primary): CaretDownIcon, CaretRightIcon, CheckIcon, MagnifyingGlassIcon, XIcon, TerminalIcon, WrenchIcon, ListChecksIcon, SpinnerIcon, FolderSimpleIcon, PaperclipIcon, ArrowLeftIcon, ArrowRightIcon, DotsSixVerticalIcon, PlusIcon
- Files: /Users/macpro/Documents/tasca/packages/ui/src/components/ModelSelectorPopover.tsx, Dropdown.tsx, InputField.tsx, PreviewNavigation.tsx, etc. (19 files)
- Icon weight attribute: weight='bold' (used to increase visual weight)

**Lucide React** (secondary/selective): X (Dialog close), Circle/Check/CircleDot (ChatTodoList.tsx, TodoProgressPopup.tsx)
- Selective use suggests migration in progress or hybrid strategy

#### Inline Styles & Hardcoded Values - CRITICAL GAPS

**Color Injection via Inline Style:**
1. KanbanBadge: `style={{ backgroundColor: \`hsl(\${color})\` }}` (line 26 of /Users/macpro/Documents/tasca/packages/ui/src/components/KanbanBadge.tsx)
2. StatusDot: `style={{ backgroundColor: \`hsl(\${color})\` }}`
3. IssueTagsRow: `style={{ backgroundColor: \`hsl(\${tag.color})\` }}`
4. KanbanBoard: `style={{ backgroundColor: \`hsl(var(\${props.color}))\` }}`
5. ColorPicker: `style={{ backgroundColor: \`hsl(\${color})\` }}`
6. CommandBar: `style={{ backgroundColor: \`hsl(\${item.status.color})\` }}`
7. component-info-node: `style={{ backgroundColor: 'hsl(var(--bg-panel))' }}`

**Layout/Dimension Inline Styles:**
- TodoProgressPopup: `style={{ width: \`\${percentage}%\` }}` (line in /Users/macpro/Documents/tasca/packages/ui/src/components/TodoProgressPopup.tsx)
- PreviewBrowser: MOBILE_WIDTH, MOBILE_HEIGHT constants, iframe container sizing
- FileTreeNode: `style={{ paddingLeft: \`\${depth * 12 + 6}px\` }}` — **hardcoded 12px multiplier, 6px offset instead of token**
- SearchableDropdown: `style={{ height: '16rem' }}` — **hardcoded 256px instead of token**
- ChatMarkdown: `style={{ maxWidth }}` (dynamic but not tokenized)

**Display/Visibility Inline Styles:**
- UserAvatar, KanbanAssignee: `style={imageUrl ? { display: 'none' } : undefined}`
- FileTree: `style={{ contain: 'layout style paint' }}`
- ChangesPanel: `style={{ contain: 'layout style paint' }}`

**Total Inline Style Count:** 27+ instances across component library

#### Tailwind Token Coverage

**Implemented Tokens** (tailwind.new.config.js lines 97-138):
- Spacing: half (0.25rem), base (0.5rem), plusfifty (0.75rem), double (1rem) — **custom scale**
- Height: cta (29px)
- Icon sizes: icon-2xs through icon-xl (0.625rem to 1.25rem)
- Colors: text (high/normal/low), background (primary/secondary/panel), brand (brand/brand-hover/brand-secondary), status (error/success/merged)
- Border radius: lg/md/sm (scaled from 0.25rem multiplier)

**Missing Token Categories:**
- Shadow system (no elevation tokens; uses only shadow-md hardcoded)
- Z-index system (hardcoded: z-[10000], z-[10001], z-[9998], z-[9999])
- Opacity/transparency scale (uses hardcoded opacity-50, opacity-70, /40, /10, /50)
- Animation timing (no delay system beyond Radix presets)
- Transition durations (hardcoded 200ms, 300ms in multiple places)

#### Component State Coverage Matrix

| Component | Default | Hover | Focus | Active | Disabled | Loading | Error | Empty | Selected |
|-----------|---------|-------|-------|--------|----------|---------|-------|-------|----------|
| Button | ✓ | ✓ (via variants) | ✓ ring | ✗ | ✓ opacity-50 | ✗ | ✗ | N/A | N/A |
| Input | ✓ | ✗ | ✓ focus-visible | ✗ | ✓ opacity-50 | ✗ | ✗ | N/A | N/A |
| Checkbox | ✓ | ✗ | ✓ ring-2 | ✗ | ✓ opacity-50 | ✗ | ✗ | ✗ (indeterminate) | ✓ checked |
| Dialog | ✓ open | ✗ | ✓ (close button) | N/A | ✗ | ✗ | ✗ | ✗ | N/A |
| Dropdown | ✓ | ✗ | ✓ focus:bg-secondary | ✗ | ✓ data-[disabled] | ✗ | ✗ | ✗ | ✓ checked |
| PrimaryButton | ✓ | ✓ (variant-specific) | ✗ | ✗ | ✓ bg-panel | ✓ spinner variant | ✗ | N/A | N/A |
| Tooltip | ✓ | N/A | ✓ (trigger) | N/A | ✗ | ✗ | ✗ | ✗ | N/A |
| Card | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | N/A |

#### A11y Gaps Observed

1. **ARIA attributes:** Input missing aria-invalid on error; Dialog missing focus management guidance
2. **Color as only indicator:** KanbanBadge, StatusDot rely on HSL color only (no pattern/icon fallback)
3. **Keyboard shortcuts in Tooltip:** Hard to discover (kbd element only in content, not visually prominent)
4. **Focus rings:** Inconsistent ring colors (ring-ring/40 vs ring-brand vs ring-2), ring width varies
5. **Screen reader text:** All components use sr-only sparingly; closeButton has `<span className='sr-only'>Close</span>` pattern (good)
6. **Contrast:** Text tokens (text-high/normal/low) defined but no WCAG AA/AAA verification
7. **Motion sensitivity:** Some animations (border-flash 2s, running-dot 1.4s) lack prefers-reduced-motion guards (one instance at lines 438-442 in index.css is insufficient)

### 1.3 Screens, routes & responsive (current)
#### Design System Foundation (Tokenized)
**Color System**: CSS custom properties in `/packages/web-core/src/app/styles/new/index.css`:
- Light: `--_background: 0 0% 95%`, `--_foreground: 0 0% 5%`, `--_primary: 0 0% 5%`, `--_secondary: 0 0% 95%`, `--_destructive: 0 59% 57%` (lines 17-28)
- Dark: `--_background: 0 0% 13%`, `--_secondary: 0 0% 12%`, `--_destructive: 0 59% 57%` (lines 94-108)
- Brand accent: `--brand: 25 82% 54%`, `--brand-hover: 25 75% 62%`, `--brand-secondary: 25 82% 37%` (lines 78-80, 137-139)
- Status colors: success `117 38% 50%`, warning `32 95% 44%`, info `217 91% 60%` (light), merged `271 81% 46%` (dark: `271 81% 66%`)
- Console/terminal: `--_console-background: 0 0% 100%` (light), `0 0% 0%` (dark); syntax highlighting with hardcoded hex colors (#d73a49, #6f42c1, #005cc5, etc., lines 51-161)

**Spacing Scale** (from `/packages/local-web/tailwind.new.config.js` lines 3-10, 97-102):
- Base unit: 1rem
- Scale: sizes = { '2xs': 0.5, 'xs': 0.75, 'sm': 0.875, base: 1, lg: 1.125, xl: 1.25 }
- Custom: `--half: 0.125rem`, `--base: 0.5rem`, `--plusfifty: 0.75rem`, `--double: 1rem`
- Icon sizes: icon-2xs (0.625rem), icon-xs (0.9375rem), icon-sm (1.09375rem), icon-base (1.25rem), icon-lg (1.40625rem), icon-xl (1.5625rem)

**Typography**:
- Font family: IBM Plex Sans (body), IBM Plex Mono (code), Noto Emoji (emoji)
- Font sizes: xs (12px/18px), sm (14px/21px), base (16px/24px), lg (18px/27px), xl (20px/30px) — line-height multiplier 1.5×
- Radius scale: lg (0.28125rem), md (0.21875rem), sm (0.1875rem)

**Responsive Breakpoint Strategy**:
- Mobile threshold: 767px max-width (custom JS breakpoint via `useIsMobile` hook, `/packages/web-core/src/shared/hooks/useIsMobile.ts` line 3)
- Tailwind breakpoints (from safelist in tailwind config): xl:hidden, xl:flex, xl:flex-1, xl:min-w-0, xl:overflow-y-auto, xl:opacity-100, xl:pointer-events-auto (lines 36-48)
- **NO explicit sm:, md:, lg: Tailwind breakpoints found** — responsive design achieved via conditional rendering + `useIsMobile()` hook and resizable panels (react-resizable-panels)

#### Local-Web Routes (24 total, `/packages/local-web/src/routes/`)
1. **index.tsx** — Root redirect page (RootRedirectPage)
2. **__root.tsx** — App root layout: I18nextProvider, ThemeProvider (system/light/dark), UserProvider
3. **_app.tsx** — Main app shell
4. **onboarding.tsx** — Onboarding flow entry
5. **onboarding_.sign-in.tsx** — Sign-in page (onboarding sub-route)
6. **_app.workspaces.tsx** — Workspaces list/management page
7. **_app.workspaces_.$workspaceId.tsx** — Single workspace detail
8. **_app.workspaces_.create.tsx** — Create workspace flow
9. **_app.projects.$projectId.tsx** — Project detail (kanban/issues view)
10. **_app.projects.$projectId_.issues.$issueId.tsx** — Issue detail modal/page
11. **_app.projects.$projectId_.workspaces.create.$draftId.tsx** — Workspace creation within project context
12. **_app.projects.$projectId_.issues.$issueId_.workspaces.$workspaceId.tsx** — Issue workspace execution view
13. **_app.projects.$projectId_.issues.$issueId_.workspaces.create.$draftId.tsx** — Workspace creation in issue context
14. **_app.projects.$projectId_.issues.$issueId_.hosts.$hostId.workspaces.$workspaceId.tsx** — Host-scoped workspace in issue
15. **_app.projects.$projectId_.issues.$issueId_.hosts.$hostId.workspaces.create.$draftId.tsx** — Host-scoped workspace creation
16. **_app.hosts.$hostId.workspaces.$workspaceId.tsx** — Host-specific workspace
17. **_app.hosts.$hostId.workspaces_.create.tsx** — Host workspace creation
18. **_app.hosts.$hostId.workspaces_.$workspaceId.tsx** — Host workspace detail
19. **_app.notifications.tsx** — Notifications panel
20. **_app.export.tsx** — Export/download feature page (inferred from route file)
21. **workspaces.$workspaceId.vscode.tsx** — VSCode integration route
22. **hosts.$hostId.workspaces.$workspaceId.vscode.tsx** — Host-scoped VSCode integration
23. **_app.electric-test.tsx** — Electric integration test page (developer/debug)
24. **_app.tsx** — App root/layout component

**Key Components Used**: WorkspacesLayout (resizable panels via react-resizable-panels), KanbanContainer (kanban board), IssueListView, CommandBarDialog, Settings dialogs, Terminal panels, Git/Diff viewers, Chat/Conversation components

**Responsive Patterns**: 
- Mobile/desktop split via `useIsMobile()` hook (767px threshold)
- Tab-based mobile UI: `useMobileActiveTab()` in WorkspacesLayout (line 111, `/packages/web-core/src/pages/workspaces/WorkspacesLayout.tsx`)
- Resizable panel system (Group, Panel, Separator from react-resizable-panels) collapses on mobile
- TextSize responsive: `isMobile && 'text-lg'` fallback to `'text-2xl'` (KanbanContainer line 22)
- No Tailwind sm:/md:/lg:/xl: prefixes used (verified via grep — returns empty)

#### Remote-Web Pages (10 total, `/packages/remote-web/src/pages/` + routes)
1. **LoginPage.tsx** — OAuth + local email/password login form; centered max-w-md layout (line 84: `className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-base py-double"`); error states (lines 93-107)
2. **LoginCompletePage.tsx** — Post-auth completion/redirect page
3. **InvitationPage.tsx** — Invitation acceptance flow
4. **InvitationCompletePage.tsx** — Invitation completion confirmation
5. **AccountPage.tsx** — User account settings/profile (standalone route `/account`)
6. **HomePage.tsx** — Organization projects/hosts dashboard; uses `useIsMobile` (line 53); responsive orgs × projects grid
7. **NotFoundPage.tsx** — 404 error page
8. **WorkspacesUnavailablePage.tsx** — Degraded-state page (no workspaces/projects available)
9. **ExportPage.tsx** — Data export interface
10. **RemoteProjectKanbanShell.tsx** — Kanban board wrapper for remote workspaces
11. **RemoteWorkspacesPageShell.tsx** — Workspaces list wrapper

**Key Components Used**: BrandLogo, Input, Label, SettingsDialog, useAuth, useIsMobile, useUserOrganizations, useRelayAppBarHosts

**Responsive Patterns**:
- LoginPage: max-w-md fixed (max 448px), px-base (8px), py-double (16px) padding
- HomePage: conditional rendering via `isMobile` for host/org selection UI
- Standalone routes bypass RemoteAppShell for auth/public pages (lines 134-152, `/__root.tsx`)

#### Component Library (/packages/ui/src/)
- **shadcn/ui-based**: Button, Input, Label, Dropdown, Dialog, Accordion, etc. (via @vibe/ui imports)
- **Custom**: KanbanBoard, KanbanCard, KanbanFilterBar, ViewNavTabs, IssueWorkspaceCard, IssueListView, CollapsibleSectionHeader, BrandLogo
- **Third-party integration**: react-resizable-panels (layout), @phosphor-icons/react (icons), fancy-ansi (terminal coloring), react-markdown (rendered content)

#### Design Tokens Used Across Codebase
**Color tokens** (Tailwind extended colors, `/packages/local-web/tailwind.new.config.js` lines 103-125):
- Text: `text-high`, `text-normal`, `text-low` (no CSS class, uses hsl vars)
- Background: `bg-primary`, `bg-secondary`, `bg-panel`
- Accent: `bg-brand`, `bg-brand-hover`, `bg-brand-secondary`
- Status: `bg-success`, `bg-error`, `bg-warning`, `text-error/30`, `text-error/10` (opacity modifiers)
- Border: `border-border`, `border-error/30`
- No per-component color overrides found (tokens consistently applied)

**Spacing tokens**:
- `px-base` (8px padding-x), `py-double` (16px padding-y), `p-base`, `p-double`, `p-half`
- `gap-half` (4px), `gap-base` (8px), `gap-2` (8px), `gap-double` (16px)
- `space-y-base`, `space-y-double`, `space-x-2`
- `mt-base`, `m-0` (reset)
- `h-full`, `w-full`, `min-h-screen`, `min-h-full`

**Radius tokens**:
- `rounded-sm` (1.875rem? — actual value unclear, needs verification)
- No explicit xl/lg/md radius modifiers in observed code

#### Responsive Behavior Specifics
- **Mobile-first**: conditional components via `useIsMobile()`, NOT Tailwind breakpoint utilities
- **Panel resizing**: react-resizable-panels provides drag-to-resize; collapsible sections via `usePersistedExpanded` state store
- **No breakpoint variants observed**: sm:, md:, lg:, xl: Tailwind prefixes NOT found in analyzed files
- **Icon sizing**: responsive via conditional `size-icon-sm` (mobile) vs `size-icon-base` (desktop)
- **Max-widths**: LoginPage `max-w-md` (448px), chat width `w-chat` (48rem/768px)

#### Loading/Empty/Error States
- **Loading**: `LoadingState()` component with animated spinner (KanbanContainer line 112-118): flex centering + "Loading" text
- **Empty kanban**: `useIsMobile && 'text-lg'` size reduction + "No visible statuses" message (KanbanContainer implicit)
- **Error states**: 
  - LoginPage (lines 93-96): `className="rounded-sm border border-error/30 bg-error/10 p-base"` with error text
  - HomePage (inferred): error from failed org/project fetch with error message display
- **No explicit skeleton/placeholder screens** observed for data loading states

#### Hardcoded/Problematic Values
- Syntax highlighting hex colors hardcoded in CSS (lines 51-161): #d73a49, #6f42c1, #005cc5, #032f62, #e36209, #6a737d, #22863a, #24292e, #b31d28 (light); #ff7b72, #d2a8ff, #79c0ff, #a5d6ff, #ffa657, #8b949e, #7ee787, #c9d1d9, #ffdcd7 (dark) — NOT tokenized
- VSCode integration variables hardcoded: `--vscode-editor-background`, `--vscode-button-background`, etc. (CSS lines 70-75, 129-134) — design system depends on editor theme injection
- Icon size multiplier hardcoded (1.25) instead of token
- Chat max-width hardcoded (48rem/768px) in config
- Border radius multiplier hardcoded (0.25)
- Breakpoint hardcoded to 767px in JS (non-configurable without code change)

#### Accessibility Gaps
- **No ARIA labels observed** in accessible components (buttons, icons)
- **No focus ring customization** beyond `@apply ring-inset` (line 278, `/new/index.css`)
- **No high-contrast mode** detected
- **Color-only coding**: error/success states rely on color alone (no icons/patterns)
- **No skip-to-content link** observed in root layouts
- **Keyboard shortcuts implemented** (WorkspaceKeyboardShortcuts provider, global Scope.GLOBAL keyboard hooks) but no discoverable help for mobile users
- **Modal/dialog accessibility**: NiceModalProvider in use, but no indication of focus trapping or restore
- **Text contrast**: reliant on CSS custom properties which vary by theme; no explicit WCAG AA/AAA verification

#### CSS/Styling Architecture
- **Tailwind CSS 3.x** with custom config
- **CSS layers**: @layer base, @layer components, @layer utilities (index.css structure)
- **CSS custom properties (variables)**: Full theme tokenization (--background, --foreground, --brand, etc.)
- **No inline styles observed** in analyzed components (good practice followed)
- **CSS imports**: @tailwind base/components/utilities + Google Fonts import (line 1, index.css)
- **Dark mode**: class-based (`<html class="dark">`) with `:root` and `.dark {}` selectors

### 1.4 Information architecture (current)

#### Navigation & board
#### App Shell Architecture (SharedAppLayout)
- Desktop: `grid grid-cols-[auto_1fr]` with conditional `grid-rows-[auto_auto_1fr]` when banner present
- Mobile: `flex flex-col flex-1` with MobileDrawer for project nav
- Desktop structure: AppBar (col 1) | Navbar (col 2 row 1) | Main content (col 2, grows vertically)
- Workspaces sidebar preview: `position: absolute left-0 top-0 z-30 h-full w-[300px]`, hidden by default, shows on hover when workspaces active AND sidebar not visible
- Preview animation: `translate-x-0` / `-translate-x-full` with `transition-transform duration-150 ease-out`
- Mobile font scaling: `--mobile-font-scale` set dynamically (1, 0.9, or 0.8) via CSS variable
- Cloud shutdown banner displayed conditionally above grid

#### Sidebar Navigation (AppBar)
- Vertical stacked sections: Local workspaces, Remote hosts, Projects, Export
- Base button class: `'flex items-center justify-center w-10 h-10 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand'`
- Project list draggable via `@hello-pangea/dnd` (vertical direction)
- Project initials: 2-char abbreviation from project name
- Host status indicators: `bg-success`, `bg-low`, `bg-white border-warning` (hardcoded color classes)
- Active state: `isActive ? 'bg-brand/20 text-brand hover:bg-brand/20' : 'bg-primary text-normal hover:bg-brand/10'`
- Project colors: inline style `color: hsl(${project.color}), backgroundColor: hsl(${project.color} / 0.2)`
- Section headers: `text-center text-[9px] font-medium leading-none tracking-wide text-low`
- Bottom: notification bell, user popover (avatar + org selector), GitHub badge link
- Mobile: accessible via MobileDrawer in SharedAppLayout

#### Top Navbar (NavbarContainer)
- Component: `<Navbar>` from @vibe/ui, rendered in col 2 row 1
- Sections: project breadcrumb (with icons/links), action navbar items (icons + tooltips + shortcuts)
- Item spacing: `gap-1` and `gap-base` (via Tailwind token; `gap-base` = unresolved custom spacing)
- Breadcrumb styling: variable `textClassName` applied to nav sections, min-w-0 for truncation
- Divider support: filter logic removes leading/trailing/consecutive dividers in navbar items
- Mobile support: `mobileMode` prop, `onOpenDrawer` callback for mobile drawer trigger
- Action visibility: context-aware filtering via `isActionVisible`, hides special icons
- Status/navigation driven by `useCurrentAppDestination()` hook to resolve `AppDestination` from route

#### Command Bar (KeyBoard-Driven)
- Shortcut: CMD+K (Mac) or Ctrl+K (Windows/Linux) via `useCommandBarShortcut`
- Hook location: captures in capture phase to bypass other handlers (e.g., Lexical editor)
- Modal wrapper: `CommandBarDialog` using `@ebay/nice-modal-react`
- State machine: `useCommandBarState(page)` with actions RESET, SELECT_ITEM, GO_BACK, SEARCH_CHANGE
- Item types: page, repo, branch, status, priority, createSubIssue, issue, action
- Rendering: `CommandBar` component from @vibe/ui with `CommandGroup` + `CommandItem`
- Status color: `h-4 w-4 rounded-full` with `backgroundColor: hsl(${item.status.color})`
- Priority icons: colored with Tailwind classes `text-error`, `text-brand`, `text-low`, `text-success`
- Issue items: priority icon + monospace `simple_id` + status dot + title (truncated)
- Back navigation: button shown only when `canGoBack && !search`
- Command styling: `rounded-sm border border-border` with custom padding
- Issue context resolution: props > multi-selection store > route params
- Focus restoration: captures previous focus on open, restores on close (unless another dialog active)

#### Kanban Board (KanbanContainer)
- Core component: `<KanbanBoard>` from @vibe/ui with `<KanbanProvider>` wrapping columns
- Grid layout: `grid-flow-col auto-cols-[minmax(200px,400px)] divide-x border-x`
- Drag mechanics: `@hello-pangea/dnd` with DragDropContext, Droppable (columns), Draggable (cards)
- KanbanCard drag state: `snapshot.isDragging && 'cursor-grabbing shadow-lg'` (conditional styling)
- KanbanHeader status color: inline style `backgroundImage: 'linear-gradient(hsl(var(${props.color}) / 0.03), ...)'`
- Card styling: mix of Tailwind (`p-base outline-none flex-col border`) and inline values
- Mobile drag handle: DotsSixVerticalIcon; desktop: `provided.dragHandleProps`
- Status color as CSS custom property: `backgroundColor: 'hsl(var(${props.color}))'`
- Bulk actions: `BulkActionBarContainer` with multi-select via `useIssueMultiSelect`
- Filter bar: `KanbanFilterBar` with searchQuery, priorities, assigneeIds, tagIds filtering
- Sort options: via `useKanbanFilters` with PRIORITY_ORDER and field-based sorting
- View tabs: `ViewNavTabs` for switching between Kanban and IssueListView
- Issue composer: Zustand store (`useKanbanIssueComposerStore`) for create/edit mode
- Route-driven sidebar panels: issue detail, workspace session, workspace create panels

#### Design Tokens (Color & Spacing)
- CSS custom properties (root variables): `--brand`, `--brand-hover`, `--brand-secondary`, `--error`, `--success`, `--merged`, `--text-on-brand`
- Text hierarchy: `--text-high`, `--text-normal`, `--text-low` (light: 0 0% 5% / 20% / 39%, dark: 96% / 77% / 56%)
- Status colors: `--success` (117 38% 50%), `--warning` (32 95% 44%), `--info` (217 91% 60%)
- Background layers: `--bg-primary-default` (light 0 0% 100%, dark 0 0% 13%), `--bg-secondary-default`, `--bg-panel-default`
- Brand HSL: 25 82% 54% (light & dark), with hover variant 25 75% 62%
- Border: `--border` (light 0 0% 85%, dark 0 0% 20%)
- Border radius token: `--_radius: 0.125rem` (0.5px, shadcn default)
- Spacing token `gap-base`: referenced in templates but value not explicitly defined in CSS (appears to be missing definition in Tailwind config)
- Transition utilities: `transition-colors duration-200` applied globally on interactive elements

#### Routing & State
- AppDestination types: root, onboarding, workspaces, workspace, project, project-issue, project-issue-workspace, project-workspace-create
- KanbanRouteState: hostId, projectId, issueId, workspaceId, draftId, sidebarMode, isCreateMode, isWorkspaceCreateMode, isPanelOpen
- SidebarMode: 'closed', 'issue', 'issue-workspace', 'workspace-create'
- Navigation via TanStack Router with useParams hook
- Destination resolution: `resolveKanbanRouteState(destination)` function extracts route state
- Route patterns: `/projects/:projectId`, `/projects/:projectId/issues/:issueId`, `/projects/:projectId/issues/:issueId/workspaces/:workspaceId`

#### Review / diff / agent-run surfaces
#### Conversation Entry Routing (DisplayConversationEntry.tsx)
- Multi-type router handling user_message, assistant_message, system_message, thinking, error_message, next_action, token_usage_info, user_feedback, user_answered_questions, tool_use (file_edit, plan, todo, approval, scripts), subagent, aggregated groups
- Auto-expand pattern: entries with pending_approval status trigger expansion; FileEditEntry, PlanEntry, GenericToolApprovalEntry all check approval status
- **IA BLOCKER**: No explicit execution state visualization — running agent output shows as streaming text only, no "agent is running" vs "idle" visual distinction at conversation level
- **DESIGN BLOCKER**: ConversationRow classification (conversation-row-model.ts) uses compact/medium/tall size hints, but no visual tokens for status colors (running, completed, failed, pending)

#### Diff Visualization (PierreConversationDiff.tsx + ChatAggregatedDiffEntries.tsx)
- DiffViewCard header: file path, +/-additions stats in hardcoded text-success/text-error (no semantic token), file icon with ToolStatusDot overlay
- DiffViewBody: Uses @pierre/diffs with THEME_CSS overrides injecting hardcoded HSL values (not Tailwind tokens):
  - Light theme additions: hsl(160, 77%, 35%) for text, hsl(160, 77%, 88%) for background (green scale hardcoded)
  - Dark theme additions: hsl(130, 50%, 50%) text, hsl(130, 30%, 20%) background (different HSL, not token)
  - Deletions follow same pattern: hsl(10, 100%, 40%) light / hsl(12, 50%, 55%) dark (red scale hardcoded)
  - Line numbers: hsl(var(--text-low)) — only semantic reference
  - **DESIGN BLOCKER**: No variables for diff colors (--diff-addition-bg, --diff-deletion-bg, etc.); all HSL values hardcoded in CSS string
- ChatAggregatedDiffEntries: Shows file path + edit count ("· 3 edits"), aggregated +/- stats, aggregateStatus logic (failed > denied > timed_out > pending_approval > created > success), border/header bg changes to error/20 + error/10 when denied
  - **DESIGN BLOCKER**: isDenied check applies bg-error/20 and border-error hardcoded; no pending_approval visual variant (card looks same whether awaiting_review, changes_requested, or approved)
- DiffEntry sub-component renders per-change action label ('Edit', 'Write', 'Delete', 'Rename → path'), inline stats, ToolStatusDot
  - **DESIGN BLOCKER**: No visual distinction between pending_approval, approved, changes_requested statuses on individual edits

#### PR Comment Embedding (pr-comment-card.tsx + pr-comment-node.tsx)
- PrCommentCard three variants: compact (inline chip ~50px height), full (inline card for dialog), list (block card)
- Compact: icon + @author + truncated body (max 50 chars), bg-muted border, hover:border-muted-foreground
- Full: author + timestamp + review badge, file path + line for review comments, diff hunk (DiffHunk sub-component), comment body
- DiffHunk inline render: hardcoded bg-green-500/20 text-green-700 dark:text-green-400 for additions, bg-red-500/20 text-red-700 dark:text-red-400 for deletions, text-muted-foreground for @@ lines
  - **DESIGN BLOCKER**: Tailwind color scale (green-500, red-500) inconsistent with diff visualization HSL values
  - **DESIGN BLOCKER**: No semantic tokens; max-h-32 overflow-y with scroll but no virtualization for large diffs
- **MISSING STATE**: No rendering of review_state field (awaiting_review, changes_requested, approved) on comments; no visual indication comment is from PR review vs general discussion

#### Approval Workflow (ChatApprovalCard.tsx + ChatEntryContainer.tsx)
- ChatApprovalCard: thin wrapper around ChatEntryContainer with variant="plan", title, expanded/onToggle, status (ChatEntryStatusLike), renderMarkdown callback
  - No approval-specific UI — relies entirely on ChatEntryContainer
- ChatEntryContainer: Variant-based header styling (user, plan, plan_denied, system)
  - plan variant: border-brand, bg-brand/20 header, bg-brand/10 body
  - plan_denied variant: border-error, bg-error/20 header, bg-error/10 body (triggered when status?.status === 'denied')
  - **DESIGN BLOCKER**: Only two states rendered (plan vs plan_denied); no visual variants for pending_approval, changes_requested, approved, awaiting_review
  - **DESIGN BLOCKER**: Uses Tailwind opacity (bg-brand/20) instead of semantic approval-state tokens
- **MISSING INTERACTION**: No approval action buttons (Approve, Request Changes, Deny) shown in container; likely rendered as sibling actions prop or external component

#### Browser Preview (PreviewBrowser.tsx)
- Toolbar: Play/Pause icons for server start/stop, URL input with submit/clear, refresh, open-in-tab, screen size toggle (desktop/mobile/responsive), inspect mode, eruda devtools toggle
- Desktop vs Mobile vs Responsive layouts handled separately
- Mobile: scales down to phone frame (390x844 with padding) using transform: scale()
- Responsive: allows drag-resize on right/bottom/corner edges with cursor-ew-resize / cursor-ns-resize / cursor-nwse-resize
- **MISSING STATE**: No visual indication when iframe is loading, errored, or content mismatches sandbox restrictions
- **DESIGN BLOCKER**: No status indicators for preview state (loading, ready, error); uses loading spinner text only

#### Execution State & Agent Runs
- No dedicated ExecutionProcess visualization component examined; conversation entries stream as assistant_message type
- **MISSING COMPONENT**: No Session-level view showing running agent (agent active indicator, turn count, approval gate, log viewer)
- **MISSING COMPONENT**: No Logs panel surface (errors, warnings, tool outputs, stderr capture)
- **MISSING STATE**: No indication of pending agent actions (waiting for approval, awaiting user input, blocked on tool)

#### Settings / onboarding / multi-tenant
#### Current Surface Areas

##### Remote Auth & Login (Cloud Entry)
- **LoginPage.tsx** (line 20-194): Sign-in with OAuth (GitHub/Google) + optional local email/password form. Uses hardcoded button styles: `border-[#dadce0] bg-[#f2f2f2] text-[#1f1f1f]` (line 212-213), custom fontFamily style (not tokenized). Error state: `border-error/30 bg-error/10` (lines 94-96). No register/verify/reset flows. Tokens referenced: `bg-primary` (line 83), `border-border`, `bg-secondary`, `text-low`, `text-on-brand`, `bg-brand-hover` (line 136). BLOCKER: OAuth buttons hardcoded hex colors instead of brand token.
- **InvitationPage.tsx** (line 16-155): Accept org invite via OAuth, shows org name + role + expiration date (lines 101-124). Same OAuth button hardcoding as LoginPage. Status card pattern for error/loading (StatusCard component, lines 186-208).
- **LoginCompletePage.tsx**: Not read in depth but referenced as OAuth callback handler.
- **InvitationCompletePage.tsx**: Implied as invite acceptance callback.

##### Local Onboarding (Desktop App)
- **LandingPage.tsx** (line 148-574): Multi-column form with Coding Agent selector (AGENT_PRIORITY priority list, lines 87-92), Code Editor selector (EditorType options, lines 227), and Notification Sound selector with playable previews (SOUND_OPTIONS, lines 49-85). Default sound selection via `randomDefaultSoundFile()` (line 134-137). Grid layout: 3 columns (lines 372). State management: selectedAgent, editorType, customCommand, soundEnabled, soundFile. Button disabled on save or invalid custom command (line 249). Footer: T&C/privacy links, Continue button (line 543-570). Uses `@phosphor-icons/react` for icons (line 22), Tailwind for layout. TOKENIZATION: Uses semantic tokens (bg-primary, border-border, bg-brand/10, text-high, text-low, text-normal). MISSING: No agent availability indicators, no tier selector, no PM-assistant onboarding step.

##### Home / Workspace & Project Listing (Remote)
- **HomePage.tsx** (line 38-400): Org + project grid with workspace count (lines 176-180). On mobile: Host selector section with status badges (online: `bg-success`, unpaired: `border border-warning bg-white`, offline: `bg-low`, lines 235-243). Host card: `border-border bg-primary` + hover state `hover:border-high/20 hover:bg-panel` (lines 213-217). Project card: link to `/projects/$projectId` + host requirement gating (lines 354-393). Error/loading states via CenteredCard (lines 298-305). Uses SettingsDialog.show() to trigger settings modal (line 60-63, 79-82). TOKENIZATION: Uses design tokens (bg-primary, border-border, text-low, text-high, text-normal, bg-brand/15, text-brand, bg-panel, focus-visible:ring-brand, lines 184-390). GAPS: No org-level settings trigger for API key config, no sprint selector, no complexity tier display, no agent status indicator.

##### Settings Dialog (Modal System)
- **SettingsDialog.tsx** (line 1-396): Responsive modal wrapper with sidebar navigation + content area. Navigation: Host-specific sections (group='host') vs Universal sections (group='universal', lines 57-62). Host picker dropdown with status labels + "Pair Other Machines" action (lines 120-135). Section navigation buttons with icons + disabled state when host unavailable (lines 78-109). Mobile: sidebar hidden when showing content, back button in header (lines 275-330). Desktop: fixed 900×700px, sidebar width-56, rounded corners (lines 259-271). Uses SettingsDirtyProvider + SettingsHostProvider (lines 380-381). TOKENIZATION: `bg-secondary/80 border-r border-border` (line 277), `bg-brand/10 text-brand` active state (lines 99), `text-low opacity-50 cursor-not-allowed` disabled (lines 97). GAPS: No org-level Anthropic key settings, no tier policy config, no guest permission controls, no sprint/backlog settings.

- **CreateConfigurationDialog.tsx** (line 24-163): Executor profile creation modal. Fields: config name (input, max 40 chars, alphanumeric+_-), clone-from select (blank or existing config, lines 119-136). Validation: name required, uniqueness check (lines 51-63). Error alert variant (line 139-143). Uses shadcn Dialog primitives (lines 91-154). GAPS: No executor availability/readiness indicator, no tier complexity hints.

##### Onboarding Flow Navigation
- **onboarding/ui/OnboardingSignInPage.tsx**: Not read but implied; references to appNavigation.goToOnboardingSignIn() (line 296 in LandingPage).

##### Project/Workspace/Issue Surface
- **RemoteProjectKanbanShell.tsx** & **RemoteWorkspacesPageShell.tsx**: Page shells referenced but not read in detail.
- Current Kanban feature: `/features/kanban/ui` (directory exists), no detailed read.
- Current workspace feature: `/features/workspace/` (directory exists), no detailed read.

#### Design System Status

##### Tailwind Config
- **packages/remote-web/tailwind.config.cjs** (line 2-7): Minimal config, no custom theme extension visible; uses web-core shared components.
- Tokenization: Observed tokens include `bg-primary`, `bg-secondary`, `border-border`, `text-high`, `text-low`, `text-normal`, `bg-brand`, `bg-brand-hover`, `text-on-brand`, `text-brand`, `bg-brand/10`, `bg-success`, `bg-warning`, `bg-panel`, `text-error`, semantic spacing (`px-base`, `py-base`, `py-half`, `p-double`), icon sizes (`size-icon-sm`, `size-icon-xs`, `size-icon-xl`).
- BLOCKER: OAuth buttons (LoginPage, InvitationPage) use hardcoded inline hex colors (`#dadce0`, `#f2f2f2`, `#1f1f1f`, `#f691b3`) + hardcoded fontFamily instead of tokenized brand button component.

##### UI Component Library
- **packages/ui**: Design-system primitives (Button, Input, Label, Dialog, Select, Alert, ConfirmDialog referenced).
- Components observed: Input (LoginPage), Label (LoginPage), OAuthButton (inline in LoginPage/InvitationPage, NOT using UI component library).
- BLOCKER: OAuthButton inlined in pages instead of using UI library; blocks consistent oauth brand theming.

##### Color & Token Reference
- Observed semantic tokens: `primary`, `secondary`, `panel`, `border`, `high`, `low`, `normal`, `brand`, `brand-hover`, `on-brand`, `success`, `warning`, `error`, plus opacity variants (`/10`, `/30`, `/50`, `/60`).
- NO ENUM *TOKENS* FOUND for complexity tiers, agent types, or role-based access levels. (Update: the #104 tier badge now ships per-tier colors as INLINE HSL values in `KanbanCardContent.tsx` TIER_BADGE, not design tokens — so 'define tier tokens' below is now a *tokenize-the-existing-hardcoded-colors* migration, not greenfield.)
- NO DEDICATED TOKENS for PM-assistant surfaces or GitHub PR integration state colors.

#### Onboarding Flow Map

1. Remote Cloud: LoginPage → (OAuth redirect) → LoginCompletePage → HomePage (org/project list)
2. Remote Invitation: InvitationPage → (OAuth redirect) → InvitationCompletePage → HomePage (join org)
3. Local Desktop: LandingPage (agent/editor/sound) → OnboardingSignIn → (auth) → Root app
4. Settings Entry: HomePage (or any page) → SettingsDialog.show() modal + any section
5. Executor Profile: SettingsDialog → (host-specific section) → CreateConfigurationDialog

#### Missing/Gaps

- No tier-*edit* surface (TierPicker #105, pending). The basic/low/medium/hard/ultra enum IS now reflected in the UI as a card badge + kanban filter (#104, flag-gated 'tiers', off by default)
- No agent-as-assignee picker (no Agent entity in UI code, no avatar selector; the backend Agent entity exists in crates/db/src/models/agent.rs but is not surfaced — agent UI #106 deferred to M3)
- PM-assistant chat panel exists only as a flag-gated INERT scaffold (`PmAssistantPanel`, gated behind `useFlag('pm_assistant')`, off by default): chrome + empty state + disabled composer, 'coming soon'. No orchestration surface, no websocket/polling, no transcript wiring (M3)
- No GitHub PR ↔ ticket status display (no PR widget, no review_state automation UI)
- No guest propose-only restricted view (no role-based issue creation gate)
- No sprint management UI (sprint entity exists in PRD but no screens observed)
- No org-level Anthropic API key settings (required for PM-assistant in Phase 3)
- Tier complexity display on the issue card IS built (#104 badge, flag-gated 'tiers', off by default)
- No agent availability status indicator
- No review-driven state-transition UI for ready_for_development state
- No feature-flag *toggle UI* in settings yet. NOTE: a typed feature-flag SYSTEM now exists (`packages/web-core/src/shared/flags/flags.ts` — FLAG_NAMES incl. 'tiers'/'agents'/'sprints'/'pm_assistant', all default off, resolved env→org via `resolveFlags`, consumed via `useFlag`) and already gates the #104 tier surfaces and the PM-assistant scaffold

### 1.5 Where current code BLOCKS good design (must-fix to enable restyle)

- index.css:51 hardcoded #555555 tooltip background (diff-style-overrides.css:476) - blocks formalization of shadow/overlay elevation system until mapped to tokens
- index.css:51 hardcoded #ffffff tooltip text (diff-style-overrides.css:500) - blocks text color consistency guarantees until migrated to var(--text-on-dark-bg)
- KanbanBadge.tsx/KanbanBoard.tsx/StatusDot.tsx dynamic HSL interpolation from data.color/status.color - blocks token-only design system until color picker outputs token names instead of HSL strings
- PreviewBrowser.tsx rounded-[2rem]/rounded-[1.5rem]/rounded-[0.2em] arbitrary values - blocks radius scale formalization until component refactored to use named radius tokens
- ContextBar.tsx/BulkActionBar.tsx arbitrary shadow values - blocks shadow elevation system until overrides use elevation scale
- GoogleLogo.tsx hardcoded brand colors - blocks brand color token aliasing until logo updated to reference tokens
- Mobile safe-area styles (#f2f2f2, #212121 in index.css:477-482) - blocks responsive color token strategy until migrated to breakpoint-specific CSS vars
- Prefers-reduced-motion override missing for border-flash/shake animations in some components - blocks motion system validation until audit-wide sweep adds @media checks
- Syntax highlighting colors mixed (HSL vars + hardcoded hex) - blocks unified syntax theme system until all 9 syntax roles use token vars
- ANSI color classes (ansi-red through ansi-bright-white) not using design system colors - blocks CLI/console output theming until mapped to status palette
- KanbanBadge.tsx line 26: inline style backgroundColor injection prevents centralized theming and makes color validation impossible
- Tailwind config lacks complete shadow system: only shadow-md exists; z-index, opacity, and animation-delay token definitions incomplete
- 27+ components use hardcoded layout values (px, rem, %) instead of spacing tokens: FileTreeNode (12px*depth+6px), SearchableDropdown (16rem), PreviewBrowser (MOBILE_WIDTH constants)
- Icon library split between phosphor (19 files) and lucide (2 files) without clear migration path or rationale documented
- Button active state missing: no visual feedback for :active/:pressed, blocking interaction state completeness
- Dialog focus management not implemented: no aria-modal, aria-labelledby, or return-focus-on-close pattern documented
- Prefers-reduced-motion not applied to 95% of animations: blocks accessibility audit compliance
- Card component has no variant system or elevation tokens: limits design consistency and reusability
- CSS Custom Properties (HSL format) require runtime evaluation — cannot extract static color values for Figma without parsing each theme variant
- react-resizable-panels library creates DOM mutation for drag handles — design team cannot control resize area size/appearance without library fork
- useIsMobile() hook hardcoded to 767px threshold — changing responsive breakpoint requires code change, not design token update
- Syntax highlighting hex colors embedded in CSS @layer base — overrides must be made in CSS, not Tailwind config
- VSCode injection variables in CSS create circular dependency (design system depends on runtime editor variables) — cannot generate static design spec without environment context
- Tailwind spacing scale derived from JS function (getSize()) — cannot inspect or verify final values without running build
- Icon multiplier (1.25) hardcoded in config function — all icon sizes are derived; change requires code modification, not token swap
- KanbanBoard.tsx:50-52 — drag-drop styling relies on @hello-pangea/dnd snapshot isDragging state; no token-based styling approach prevents consistent brand application across drag states
- SharedAppLayout.tsx:71 — workspace sidebar preview animation uses hardcoded translate-x values with inline className; should be refactored to CSS animation class for consistency
- AppBar.tsx:44-46 — host status indicator colors (bg-success, bg-low, bg-white) hardcoded as Tailwind classes; should map to semantic token (e.g., status.connected vs status.offline)
- CommandBar.tsx:59-62 — status color and priority colors applied via inline styles (`backgroundColor: hsl(${...})`) mixing inline + Tailwind; should standardize on design tokens with HSL function
- KanbanContainer.tsx (derived from file reads) — card styling mix of Tailwind utilities and inline styles prevents creation of cohesive card component variant system
- NavbarContainer.tsx — action visibility filtering logic creates divergence between intended and rendered items; blocks ability to spec sidebar and navbar as unified action surface
- Tailwind config minimal (tailwind.config.cjs only references content paths); no spacing, color, or radius extensions defined; blocks Fortune-500-grade spec implementation
- PierreConversationDiff.tsx:22-107: PIERRE_DIFFS_THEME_CSS hardcodes HSL values instead of using CSS custom properties; must refactor to use --diff-addition-text, --diff-deletion-bg, etc.
- pr-comment-card.tsx:45-49: DiffHunk component hardcodes bg-green-500/20 and bg-red-500/20 instead of semantic diff color tokens; inconsistent with PierreConversationDiff HSL values
- ChatAggregatedDiffEntries.tsx:254-257: isDenied check applies hardcoded bg-error/20 and border-error; no pending_approval variant rendering; must add approval-state-specific styling
- ChatEntryContainer.tsx:24-49: variantConfig uses hardcoded 'border-brand' and 'bg-brand/20' instead of semantic review-state tokens (--review-awaiting-bg, etc.); must expand variants to cover pending_approval/changes_requested/approved
- DisplayConversationEntry.tsx: No execution state visualization (running/pending/error) on conversation rows; must add status indicator rendering in row classification logic
- OAuthButton component inlined in LoginPage (line 196-222) and InvitationPage (line 158-183) with hardcoded hex colors instead of using tokenized brand button from @vibe/ui; blocks consistent OAuth branding and design system adoption
- Tailwind config (packages/remote-web/tailwind.config.cjs) minimal/empty theme extension; no token definitions for tier, agent, role-based states, or PM-assistant surfaces; all colors rely on semantic primitives (brand, primary, secondary, border, etc.)
- No tier enum, agent entity, or role enums visible in component code; suggests data model incomplete at UI layer; blocks tier selector and agent picker implementation
- LoginPage email/password form (lines 110-142) exists but appears unused in cloud deployment (env-secret auth only); unclear if register/verify/reset flows exist upstream, blocking complete auth surface design
- CreateConfigurationDialog minimal (no agent availability indicators, no tier support hints); suggests missing supporting data structures at API layer
- SettingsDialog sections hardcoded in SETTINGS_SECTION_DEFINITIONS (line 16); no org-level API key settings, feature flags, or member permission sections; requires registry expansion
- Kanban shell (RemoteProjectKanbanShell.tsx) referenced but not read; issue detail view not inspected; can't confirm current tier/agent/status display or form field presence
- GitHub PR entity and review_state not referenced anywhere; suggests pre-Phase-4 state; blocks PR widget design
- No visible PM-assistant orchestration code; suggests infra (websocket, message schema) not yet implemented; blocks UI design validation
- Guest role mentioned in PRD but no role-based access control observable in current settings/permissions UI; blocks propose-only surface design
- Hardcoded mobile safe-area colors (#f2f2f2, #212121) in /Users/macpro/Documents/tasca/packages/web-core/src/app/styles/new/index.css lines 477, 482 should use tokenized color variables instead
- Tailwind default shadows used rather than custom elevation scale—prevents consistent depth language across UI
- VS Code variable overrides (--vscode-*) in /Users/macpro/Documents/tasca/packages/web-core/src/app/styles/new/index.css (lines 70-76, 129-134) bypass design tokens for editor integration—acceptable but limits token flexibility
- Remote-web app doesn't extend Tailwind theme—design tokens not available in cloud web package without manual duplication
- Tailwind config (/packages/remote-web/tailwind.config.cjs) has NO theme extension with color/spacing/radius token references → cannot add semantic tokens without modifying every component
- Hardcoded Radix attributes (data-[state=checked], data-[state=open], etc.) couple styling to Radix version → upgrading Radix risks breaking selectors if DOM structure changes
- .dark class mode requires JavaScript class manipulation → cannot prerender dark mode or support attribute-based theme switching
- Custom utilities (p-base, py-half, size-icon-base) referenced in Popover/Tooltip/Avatar/UserAvatar are not defined in tailwind.config → will fail if Tailwind's unknown-class purging is enabled in production
- Dialog/DropdownMenu hardcoded z-index values (z-[9998], z-[9999], z-[10000]) conflict if multiple modals/dropdowns open; no layering token strategy
- Hardcoded inline styles in KanbanBoard.tsx:224, 230 (gradient, color dot) prevent clean CSS theme overrides; refactor to Tailwind or CSS variables required before color token migration
- PRESET_COLORS hardcoded in colors.ts:3–16; not theme-aware or token-driven, blocks semantic color rebranding
- Button.tsx Button.tsx CVA variants don't include responsive size breakdowns (xs currently 32px); blocka11y-compliant touch target scaling without component refactor
- No tailwind.config.cjs theme extension visible (file only 8 lines); blocks semantic token injection (colors, typography, spacing scale)
- Fixed grid-flow-col in KanbanBoard.tsx:273 hardcodes desktop layout; no responsive 'single-column-on-mobile' mode without conditionals or media queries
- transition-colors global utility (index.css:288) applied without prefers-reduced-motion wrapper; blocks accessible motion without CSS refactor


---

## 2. Brand foundation slots — *for the brand/design team to fill*

Deliberately empty slots. The *current* values (orange brand `hsl(25 82% 54%)`, IBM Plex Sans/Mono) are the **baseline to replace**, not a recommendation.

| Slot | What to provide | Current placeholder (replace) | Lands in |
|---|---|---|---|
| **Logomark / wordmark** | SVG light+dark, monochrome, favicon/app-icon, min-size & clear-space | `packages/public/tasca-logo*.svg`, `favicon-tasca-*.svg`, Tauri `icons/` | §8 step 3 |
| **Brand color(s)** | Primary (+optional accent) as L\*C\*h/hex, on-brand text, hover/active | `--brand 25 82% 54%`, `--brand-hover`, `--brand-secondary` | §3 |
| **Neutrals** | Greyscale ramp (or keep audited HSL neutrals) | `--text-high/normal/low`, `--_bg-*` | §3 |
| **Typography** | Display + UI + mono families (license), weights, optional fluid scale | IBM Plex Sans / Mono (Google Fonts) | §3 |
| **Voice & tone** | Microcopy principles; empty-state / error voice; button verbs | none today | §4, §6 |
| **Density / shape** | Radius feel (sharp↔round), spacing density, elevation style | radius `~0.22–0.28rem`; `half/base/double` | §3 |
| **Motion personality** | Easing+duration character; reduced-motion stance | ad-hoc | §3, §7 |


---

## 3. Target design-token specification (light + dark, semantic + tier scales)

#### TARGET Token System Specification (Fortune-500 Grade Design System)

##### 1. COLOR SYSTEM - LIGHT MODE

**Base Neutrals (Achromatic):**
- Neutral 0: 0 0% 100% (#FFFFFF) — pure white backgrounds
- Neutral 1: 0 0% 95% (#F2F2F2) — soft white surfaces
- Neutral 2: 0 0% 89% (#E3E3E3) — light panel backgrounds
- Neutral 3: 0 0% 85% (#D9D9D9) — borders, dividers
- Neutral 4: 0 0% 75% (#BFBFBF) — disabled text
- Neutral 5: 0 0% 56% (#8F8F8F) — secondary text
- Neutral 6: 0 0% 39% (#636363) — tertiary text
- Neutral 7: 0 0% 20% (#333333) — body text
- Neutral 8: 0 0% 5% (#0D0D0D) — heading text
- Neutral 9: 0 0% 0% (#000000) — solid black

**Brand/Primary (Warm Orange):**
- Primary 50: 25 100% 93% (#FCE6CC) — lightest tint
- Primary 100: 25 95% 87% (#F9D0A0) — very light tint
- Primary 200: 25 90% 75% (#F3B372) — light tint
- Primary 300: 25 85% 63% (#ECAC52) — medium-light tint
- Primary 400: 25 82% 54% (#E59632) — brand primary (current --brand)
- Primary 500: 25 78% 48% (#D68829) — brand hover variant
- Primary 600: 25 80% 42% (#CA7D21) — darker brand
- Primary 700: 25 82% 37% (#BD6B16) — brand-secondary (current)
- Primary 800: 25 85% 28% (#9D540F) — darkest brand
- Primary 900: 25 85% 18% (#7A3D0A) — brand ultra-dark

**Semantic Colors - Status & State:**
- Success: 117 38% 50% (#4A9D6F) — positive/pass state
- Success-light: 117 35% 80% (#A8D5BB) — success background
- Error: 0 59% 57% (#C94242) — destructive/fail state
- Error-light: 0 50% 85% (#EFC5C5) — error background
- Warning: 32 95% 44% (#FF9800) — caution/attention state
- Warning-light: 32 90% 80% (#FFD9A8) — warning background
- Info: 217 91% 60% (#4DB3FF) — informational state
- Info-light: 217 91% 85% (#B3D9FF) — info background
- Merged: 271 81% 46% (#8B5CF6) — merged/special state
- Merged-light: 271 75% 80% (#E5D4FF) — merged background

**Text/Foreground Roles:**
- Text-high: 0 0% 5% (#0D0D0D) — primary headings, emphasized text (100% contrast on white)
- Text-normal: 0 0% 20% (#333333) — body text, paragraphs (88% contrast on white)
- Text-low: 0 0% 39% (#636363) — secondary labels, hints, disabled (68% contrast on white)
- Text-on-brand: 0 0% 100% (#FFFFFF) — text layered on brand colors (100% contrast on brand)
- Text-on-error: 0 0% 100% (#FFFFFF) — text on error backgrounds
- Text-on-success: 0 0% 100% (#FFFFFF) — text on success backgrounds

**Background/Surface Roles:**
- Background-primary: 0 0% 100% (#FFFFFF) — main content area
- Background-secondary: 0 0% 95% (#F2F2F2) — secondary surfaces, cards
- Background-tertiary: 0 0% 89% (#E3E3E3) — panels, nested surfaces
- Background-brand: 25 82% 54% (#E59632) — call-to-action regions
- Background-success: 117 35% 80% (#A8D5BB) — success regions
- Background-error: 0 50% 85% (#EFC5C5) — error/warning regions
- Background-info: 217 91% 85% (#B3D9FF) — info regions

**Border Roles:**
- Border-default: 0 0% 85% (#D9D9D9) — standard dividers, edges
- Border-subtle: 0 0% 92% (#EBEBEB) — low-emphasis separators
- Border-strong: 0 0% 75% (#BFBFBF) — emphasized borders
- Border-brand: 25 82% 54% (#E59632) — brand-focused borders (focus rings)

##### 2. COLOR SYSTEM - DARK MODE

**Base Neutrals (Achromatic):**
- Neutral 0: 0 0% 8% (#141414) — pure black backgrounds
- Neutral 1: 0 0% 13% (#212121) — soft dark surfaces
- Neutral 2: 0 0% 16% (#292929) — panel backgrounds
- Neutral 3: 0 0% 20% (#333333) — borders, dividers
- Neutral 4: 0 0% 35% (#595959) — disabled text
- Neutral 5: 0 0% 56% (#8F8F8F) — secondary text
- Neutral 6: 0 0% 77% (#C4C4C4) — tertiary text
- Neutral 7: 0 0% 96% (#F5F5F5) — body text
- Neutral 8: 0 0% 100% (#FFFFFF) — heading text
- Neutral 9: 0 0% 100% (#FFFFFF) — solid white

**Brand/Primary (Warm Orange - same hue family):**
- Primary 50: 25 82% 54% (#E59632) — primary (unchanged)
- Primary 100: 25 78% 48% (#D68829) — hover variant
- Primary 200: 25 75% 62% (#F0A855) — lightened for dark mode visibility
- Primary 300: 25 70% 72% (#FACB81) — even lighter tint
- Primary 400: 25 65% 80% (#FDD9A8) — very light tint
- Primary 500: 25 60% 87% (#FDE4BB) — lightest tint
- Primary 600: 25 82% 37% (#BD6B16) — darker saturated
- Primary 700: 25 85% 28% (#9D540F) — darkest brand
- Primary 800: 25 85% 18% (#7A3D0A) — ultra-dark (rare)

**Semantic Colors - Status & State (adjusted for dark mode readability):**
- Success: 117 38% 50% (#4A9D6F) — positive (same as light)
- Success-light: 117 40% 70% (#7AC998) — success foreground on dark bg
- Error: 0 59% 57% (#C94242) — destructive (same)
- Error-light: 0 60% 70% (#E86B6B) — error foreground on dark bg
- Warning: 32 95% 44% (#FF9800) — caution (same)
- Warning-light: 32 92% 65% (#FFB84D) — warning foreground on dark bg
- Info: 217 91% 60% (#4DB3FF) — informational (same)
- Info-light: 217 92% 75% (#80CCFF) — info foreground on dark bg
- Merged: 271 81% 66% (#D4A3FF) — merged (lightened; current value)
- Merged-light: 271 75% 85% (#E8D9FF) — merged background on dark

**Text/Foreground Roles:**
- Text-high: 0 0% 96% (#F5F5F5) — primary headings (100% contrast on #141414)
- Text-normal: 0 0% 77% (#C4C4C4) — body text (76% contrast on #141414)
- Text-low: 0 0% 56% (#8F8F8F) — secondary labels (58% contrast on #141414)
- Text-on-brand: 0 0% 100% (#FFFFFF) — text on brand backgrounds (unchanged)
- Text-on-error: 0 0% 100% (#FFFFFF) — text on error backgrounds
- Text-on-success: 0 0% 100% (#FFFFFF) — text on success backgrounds

**Background/Surface Roles:**
- Background-primary: 0 0% 13% (#212121) — main content area
- Background-secondary: 0 0% 11% (#1C1C1C) — secondary surfaces, cards
- Background-tertiary: 0 0% 16% (#292929) — panels, nested surfaces
- Background-brand: 25 82% 54% (#E59632) — call-to-action regions (same hue)
- Background-success: 117 40% 70% (#7AC998) — success regions
- Background-error: 0 60% 70% (#E86B6B) — error regions
- Background-info: 217 92% 75% (#80CCFF) — info regions

**Border Roles:**
- Border-default: 0 0% 20% (#333333) — standard dividers, edges
- Border-subtle: 0 0% 16% (#292929) — low-emphasis separators
- Border-strong: 0 0% 35% (#595959) — emphasized borders
- Border-brand: 25 82% 54% (#E59632) — brand-focused borders (focus rings)

##### 3. COMPLEXITY TIER COLOR PAIRS (Light Mode - Accessible Contrast)

**Basic Tier (Simplest, most common UI):**
- Foreground: 0 0% 39% (#636363, text-low) — WCAG AA on white
- Background: 0 0% 95% (#F2F2F2, neutral-1) — clean, minimal contrast
- Accent: 25 82% 54% (#E59632, brand primary) — supports interaction visibility
- Use case: Default button state, simple list items, basic info boxes

**Low Tier (Light emphasis):**
- Foreground: 0 0% 20% (#333333, text-normal) — increased contrast
- Background: 0 0% 89% (#E3E3E3, neutral-2) — moderate surface distinction
- Accent: 25 75% 62% (#F0A855, brand-hover) — secondary interactions
- Use case: Hovered buttons, secondary cards, supporting content

**Medium Tier (Moderate emphasis):**
- Foreground: 0 0% 5% (#0D0D0D, text-high) — high contrast for readability
- Background: 0 0% 75% (#BFBFBF, neutral-4) — visible surface distinction
- Accent: 25 82% 37% (#BD6B16, brand-secondary) — primary interactive areas
- Use case: Active states, form inputs, important sections, card headers

**Hard Tier (High emphasis):**
- Foreground: 0 0% 100% (#FFFFFF, on-brand) — maximum contrast
- Background: 25 82% 54% (#E59632, brand primary) — brand-dominant surfaces
- Accent: 0 0% 5% (#0D0D0D, text-high) — contrast on brand background
- Use case: CTA buttons, primary actions, modal headers, success confirmations

**Ultra Tier (Highest emphasis, most critical):**
- Foreground: 0 0% 100% (#FFFFFF, on-brand) — absolute white on dark
- Background: 0 59% 57% (#C94242, error) or 117 38% 50% (#4A9D6F, success) — semantic critical state
- Accent: 0 0% 0% (#000000, solid black) — maximum visual weight
- Use case: Destructive actions, critical warnings, system alerts, emergency states

##### 4. COMPLEXITY TIER COLOR PAIRS (Dark Mode - Accessible Contrast)

**Basic Tier:**
- Foreground: 0 0% 56% (#8F8F8F, text-low) — WCAG AA on #212121
- Background: 0 0% 16% (#292929, neutral-2) — minimal visual noise
- Accent: 25 82% 54% (#E59632, brand primary) — interaction focus
- Use case: Default button state, simple list items

**Low Tier:**
- Foreground: 0 0% 77% (#C4C4C4, text-normal) — increased brightness
- Background: 0 0% 11% (#1C1C1C, neutral-1) — subtle depth
- Accent: 25 75% 62% (#F0A855, brand-hover) — hover states
- Use case: Hovered buttons, secondary content, supporting info

**Medium Tier:**
- Foreground: 0 0% 96% (#F5F5F5, text-high) — high contrast
- Background: 0 0% 20% (#333333, neutral-3) — distinct surfaces
- Accent: 25 82% 37% (#BD6B16, brand-secondary) — primary interactions
- Use case: Active states, form focus, important sections

**Hard Tier:**
- Foreground: 0 0% 0% (#000000, text on brand) — pure black on brand
- Background: 25 82% 54% (#E59632, brand primary) — brand prominence
- Accent: 0 0% 100% (#FFFFFF) — maximum contrast accent
- Use case: CTA buttons, primary actions, modal headers

**Ultra Tier:**
- Foreground: 0 0% 100% (#FFFFFF) — pure white text
- Background: 0 59% 57% (#C94242, error) or 117 38% 50% (#4A9D6F, success) — semantic critical
- Accent: 25 82% 54% (#E59632, brand) — layered brand accent
- Use case: Destructive actions, critical alerts, system warnings

##### 5. TYPOGRAPHY SYSTEM

**Font Families:**
- Sans Serif (UI, body): IBM Plex Sans (weights: 100, 200, 300, 400, 500, 600, 700) with Noto Emoji fallback
- Monospace (code, terminal): IBM Plex Mono (weights: 100, 200, 300, 400, 500, 600, 700)

**Type Scale (rem-based, root 16px):**
| Scale | Size (px) | Size (rem) | Line Height (px) | Line Height (rem) | Use Case |
|-------|-----------|-----------|------------------|------------------|----------|
| 2xs | 8 | 0.5rem | 12 | 0.75rem | inline labels, tiny badges |
| xs | 12 | 0.75rem | 18 | 1.125rem | labels, captions, small UI text |
| sm | 14 | 0.875rem | 21 | 1.3125rem | secondary UI, helper text |
| base | 16 | 1rem | 24 | 1.5rem | body text, default UI (PRIMARY) |
| lg | 18 | 1.125rem | 27 | 1.6875rem | section headers, larger UI |
| xl | 20 | 1.25rem | 30 | 1.875rem | page headers, prominent labels |

**Font Weights (Standard Palette):**
- 100 (Thin): emphasis reduction, decorative only
- 300 (Light): secondary headings, subtle text
- 400 (Regular): body text, default UI
- 500 (Medium): button text, input labels, emphasis
- 600 (Semibold): subheadings, interaction indicators
- 700 (Bold): main headings, critical information

**Letter Spacing:**
- Default: 0 (no adjustment)
- Headlines (xl, lg): 0.01em (tighten for visual impact)
- UI Labels: 0.025em (increase for clarity)
- All caps: 0.08em (standard for acronyms)

**Line Height:**
- Tight (condensed text): 1.25 (20px on 16px base)
- Normal (body, UI): 1.5 (24px on 16px base) — CURRENT STANDARD
- Loose (long-form prose): 1.75 (28px on 16px base)

##### 6. SPACING SYSTEM

**Discrete Spacing Scale (rem-based):**
| Token | Multiplier | Size (px) | Size (rem) | Use Cases |
|-------|-----------|-----------|-----------|-----------|
| space-0 | 0 | 0 | 0rem | negative space, reset |
| space-half | 0.25 | 4 | 0.25rem | micro spacing, inline gaps |
| space-1 | 0.5 | 8 | 0.5rem | tight component spacing |
| space-1.5 | 0.75 | 12 | 0.75rem | component internal padding |
| space-2 | 1 | 16 | 1rem | standard spacing (PRIMARY) |
| space-3 | 1.5 | 24 | 1.5rem | section margins |
| space-4 | 2 | 32 | 2rem | large component spacing |
| space-6 | 3 | 48 | 3rem | major section breaks |
| space-8 | 4 | 64 | 4rem | full layout sections |
| space-12 | 6 | 96 | 6rem | hero/page boundaries |
| space-16 | 8 | 128 | 8rem | max spacing between major sections |

**Padding & Margin Convention:**
- Components: space-1 to space-2 (8-16px) — tight internal spacing
- Sections: space-3 to space-6 (24-48px) — comfortable breathing room
- Modals/Pages: space-4 to space-8 (32-64px) — emphasis via white space

##### 7. BORDER RADIUS SYSTEM

**Scale (rem-based with 0.25 multiplier):**
| Token | Multiplier | Size (px) | Size (rem) | Use Cases |
|-------|-----------|-----------|-----------|-----------|
| radius-none | 0 | 0 | 0rem | hard edges, full rectangles |
| radius-xs | 0.25x | 3 | 0.1875rem | very tight curves |
| radius-sm | 0.5x | 6 | 0.375rem | subtle rounding, buttons (current md) |
| radius-md | 0.75x | 7 | 0.4375rem | standard corner radius (current md) |
| radius-lg | 1x | 8 | 0.5rem | cards, panels (current lg) |
| radius-xl | 1.5x | 12 | 0.75rem | modals, large surfaces |
| radius-2xl | 2x | 16 | 1rem | rounded visual elements |
| radius-3xl | 2.5x | 20 | 1.25rem | pill buttons, strong rounding |
| radius-full | 9999 | 9999 | 50% | perfect circles, fully rounded |

**Current mapping (to update):**
- Button/small UI: radius-sm (6px)
- Cards/standard: radius-lg (8px)
- Modals/large: radius-xl (12px)

##### 8. ELEVATION & SHADOW SYSTEM

**Shadow Depth Tiers (box-shadow):**
| Level | Shadow | Elevation Use Case |
|-------|--------|-------------------|
| Flat | none | base surfaces, text, icons |
| Subtle | 0 1px 2px rgba(0,0,0,0.05) | borders, dividers, raised flat |
| Elevation-1 | 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24) | cards on light background |
| Elevation-2 | 0 3px 6px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.12) | hovered cards, dropdowns |
| Elevation-3 | 0 10px 20px rgba(0,0,0,0.15), 0 3px 6px rgba(0,0,0,0.10) | modals, popovers, floating panels |
| Elevation-4 | 0 15px 25px rgba(0,0,0,0.15), 0 5px 10px rgba(0,0,0,0.05) | high Z-index overlays |
| Elevation-5 | 0 20px 40px rgba(0,0,0,0.2) | full-screen modal, critical overlays |

**Dark Mode Adjustment:** Increase shadow alpha by 20-40% to maintain depth perception on dark backgrounds.

##### 9. MOTION & ANIMATION SYSTEM

**Timing Functions (standard easing curves):**
- ease-linear (0 easing): 1s default duration; constant velocity
- ease-in (cubic-bezier 0.42, 0, 1, 1): 0.3s default; acceleration start
- ease-out (cubic-bezier 0, 0, 0.58, 1): 0.2s default; deceleration finish
- ease-in-out (cubic-bezier 0.42, 0, 0.58, 1): 0.4s default; smooth both ends

**Duration Standards:**
- Micro (instant feedback): 0.1s — no wait perception
- Short (state change): 0.2s — button hover, tab switch (CURRENT: accordion)
- Standard (transition): 0.3s — modal open, item enter/exit (CURRENT: shake)
- Moderate (emphasis): 0.5s — scroll reveal, scroll reveal
- Long (narrative): 1.0s-2.0s — onboarding, running-dot feedback (CURRENT)
- Extra long (sustained): 2.0s-3.0s — sustained attention, looping animation (CURRENT: border-flash 2s, pill 2s)

**Keyframe Library (Current + Target):**
| Name | Duration | Easing | Purpose |
|------|----------|--------|---------|
| accordion-down | 0.2s | ease-out | panel expansion (current) |
| accordion-up | 0.2s | ease-out | panel collapse (current) |
| pill | 2s | ease-in-out | notification entrance/exit (current) |
| running-dot-1/2/3 | 1.4s | ease-in-out | loading indicator cascade (current) |
| border-flash | 2s | linear | attention border animation (current) |
| shake | 0.3s | ease-in-out | error emphasis (current) |
| fade-in | 0.2s | ease-out | NEW: element reveal |
| slide-in-left | 0.3s | ease-out | NEW: drawer/sidebar enter |
| slide-in-right | 0.3s | ease-out | NEW: panel slide |
| scale-up | 0.2s | ease-out | NEW: focus/emphasis |
| pulse | 2s | ease-in-out | NEW: attention loop |

**Reduced Motion:** All animations MUST respect prefers-reduced-motion, reducing to instant/0.1s versions or disabling entirely.

##### 10. TOKEN MAPPING TO TAILWIND THEME KEYS

**CSS Custom Variables (in :root and .dark):**
```css
/* Colors */
--color-neutral-0: 0 0% 100%;
--color-neutral-1: 0 0% 95%;
--color-brand-primary: 25 82% 54%;
--color-semantic-success: 117 38% 50%;
--color-text-high: 0 0% 5%;
--color-text-normal: 0 0% 20%;
--color-text-low: 0 0% 39%;
--color-bg-primary: 0 0% 100%;
--color-bg-secondary: 0 0% 95%;
--color-border-default: 0 0% 85%;

/* Typography */
--font-sans: 'IBM Plex Sans', 'Noto Emoji', sans-serif;
--font-mono: 'IBM Plex Mono', monospace;
--size-2xs: 0.5rem;
--size-xs: 0.75rem;
--size-base: 1rem;
--line-height-tight: 1.25;
--line-height-normal: 1.5;
--line-height-loose: 1.75;

/* Spacing */
--space-0: 0rem;
--space-half: 0.25rem;
--space-1: 0.5rem;
--space-2: 1rem;
--space-3: 1.5rem;

/* Radius */
--radius-xs: 0.1875rem;
--radius-sm: 0.375rem;
--radius-md: 0.4375rem;
--radius-lg: 0.5rem;

/* Shadow */
--shadow-subtle: 0 1px 2px rgba(0,0,0,0.05);
--shadow-elevation-1: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);

/* Motion */
--duration-micro: 0.1s;
--duration-short: 0.2s;
--duration-standard: 0.3s;
--timing-linear: linear;
--timing-ease-in-out: cubic-bezier(0.42, 0, 0.58, 1);
```

**Tailwind theme.extend:**
```js
{
  colors: {
    neutral: { 0: 'hsl(var(--color-neutral-0))', 1: '...', ... },
    brand: { primary: 'hsl(var(--color-brand-primary))', ... },
    text: { high: '...', normal: '...', low: '...' },
    background: { primary: '...', secondary: '...' },
    border: { default: '...', brand: '...' }
  },
  fontFamily: { sans: 'var(--font-sans)', mono: 'var(--font-mono)' },
  fontSize: { xs: ['var(--size-xs)', 'var(--line-height-normal)'], ... },
  spacing: { 0: '0', half: 'var(--space-half)', 1: 'var(--space-1)', ... },
  borderRadius: { xs: 'var(--radius-xs)', sm: '...', md: '...', lg: '...' },
  boxShadow: { subtle: 'var(--shadow-subtle)', elevation-1: '...', ... },
  keyframes: { fadeIn: '@keyframes { from { opacity: 0 } to { opacity: 1 } }', ... },
  animation: { fadeIn: 'fadeIn 0.2s ease-out', ... }
}
```

### 3.x Additional token detail (frontend audit)
#### Target: Fortune-500-Grade Design System Specification

##### 1. Design Token Taxonomy & Naming Convention
- **Establish formal token hierarchy**: CATEGORY-SEMANTIC-STATE-CONTEXT (e.g., color-text-primary-default, color-background-surface-hover)
- **Document token deprecation policy**: All hardcoded HSL/hex values must map to named tokens with version + migration guidance
- **Define color space explicitly**: Clarify HSL vs RGB vs sRGB linear; document color management assumptions (no gamut mapping currently)
- **Token resolution rules**: Public tokens > internal fallbacks > hardcoded values (zero hardcoded colors post-audit)

##### 2. Semantic Theming Architecture
- **Named themes not just dark/light**: Support branded themes (brand, accessibility-high-contrast, colorblind-friendly) via switchable CSS class sets
- **Complete color palette specification**: Define 12-15 semantic color roles + 3-4 status variants (success/warning/error/info)
  - Foreground/background pairs with explicit WCAG AA/AAA contrast requirements noted
  - Brand color family: 5 tints (10%, 25%, 50%, 75%, 90%) + 5 shades with explicit L*, C*, H* target values
- **Token value tables**: Render as reference spec with current hex/HSL + target (if refactoring)
- **Automatic color scales**: Define algorithm (e.g., HSL lightness + saturation curves) for deriving related tokens

##### 3. Typography System Formalization
- **Font stack specification**: Document font weights available (100-700 for Plex Sans/Mono), fallback chains, emoji handling
- **Type scale definition**: Explicit mapping of size names (xs/sm/base/lg/xl) to rem values + computed line heights + letter-spacing
  - Include mobile/tablet scales as separate variants (not runtime --mobile-font-scale)
  - Define minimum line-height ratios (e.g., 1.5x for body, 1.2x for headings)
- **Font feature table**: Document intentional feature flags (liga, dlig, ss01-ss20) per context
- **Text hierarchy rules**: Document when to use which font weight + size combo; provide rendered examples

##### 4. Spacing & Layout Grid
- **Baseline grid definition**: Document 0.5rem base unit, derive all spacing from it
- **Spacing scale formal spec**: Interval naming (half, base, plusfifty, double) with explicit rem values + visual ruler diagrams
- **Responsive spacing rules**: Define when spacing tokens change by breakpoint (e.g., base = 0.25rem @sm, 0.375rem @md)
- **Layout grid**: Define column/row counts (12-col or 8-col), gutter width, container widths per breakpoint

##### 5. Component Design Primitives
- **Shadow system**: Formalize 5-7 shadow depths (elevation-0 through elevation-4) with explicit blur/spread/opacity values
  - Separate shadows for: surface (subtle), hover (moderate), elevated (cards), focus ring
  - Formula for deriving shadow blur from elevation (e.g., blur = elevation * 2px)
- **Border radius scale**: Map sm/md/lg to explicit rem values; define corner falloff algorithm (not just multiplier)
  - Specify radius ratios for different shapes (buttons 2px/4px, cards 8px/12px, modals 16px)
- **Focus indicator spec**: Define focus-visible style (ring-brand with 2px width, 2px offset), animation duration (200ms)
- **Interaction states**: Formal matrix showing disabled/hover/active/focus-visible states for each component class
  - Define opacity overlays for disabled state (all 40% opacity per audit finding)
  - Define hover color shifts (explicit L* delta, not just predefined -hover token)

##### 6. Animation & Motion
- **Motion curve library**: Define 3-4 easing functions + durations (fast 150ms, normal 200ms, slow 300ms, deliberate 500ms)
- **Animation catalog**: Formalize keyframes: accordion-down/up (200ms), pill (2s), running-dot (1.4s staggered), border-flash (2s), shake (300ms)
- **Prefers-reduced-motion**: Ensure all motion animations explicitly check @media (prefers-reduced-motion: reduce) + disable
- **Transition rules**: Define which properties animate (colors, transforms, opacity) + default curve/duration

##### 7. Accessibility Requirements & Validation
- **WCAG AA/AAA compliance targets**: Document minimum contrast ratios by use case (normal text >=4.5:1, large >=3:1)
- **Color not alone rule**: Ensure no status indicated by color alone (use icons, patterns, or text + color)
- **Focus management**: Visible focus indicators on all interactive elements, focus order documentation
- **Keyboard navigation**: Define tab order conventions, arrow key behaviors for menu/tabs/selects
- **Semantic HTML guidance**: Map design tokens to semantic HTML elements (e.g., error-foreground to <input aria-invalid>)
- **Automated testing strategy**: Tools + thresholds (e.g., axe-core, pa11y, minimum 95% pass rate)

##### 8. Code Architecture & Implementation
- **Design token build pipeline**: Auto-generate token files from source (JSON/YAML) → CSS custom properties → Tailwind config → component imports
- **Token consumption patterns**: Formalize how components access tokens
  - Tailwind classes: `text-high`, `bg-primary`, `border-brand` (from Tailwind extend.colors)
  - Direct CSS vars: `hsl(var(--brand))` for dynamic/gradient use
  - Inline dynamic values: Require token function wrapper (e.g., `getColorToken('brand')`) not bare `hsl(${var})` strings
- **Component token API**: Establish if shadcn/ui components should map to internal token names or inherit from Tailwind
- **Dark mode switching strategy**: Document class-based toggle + localStorage persistence + SSR safety checks

##### 9. Documentation & Handoff Artifacts
- **Design token reference site**: Interactive Storybook with:
  - Color swatches (all 30+ tokens with WCAG contrast matrix)
  - Typography specimens (every font/size/weight combo)
  - Component patterns (buttons, inputs, cards, modals with all states)
  - Animation demos with code samples
- **Figma/design tool sync**: Ensure token names in design file = code token names (versioned)
- **Breaking changes guide**: Document how to deprecate tokens + migration path for consuming code
- **Team workflows**: Document who updates design tokens (designer vs engineer), code review process, version bumping rules

##### 10. Testing & Validation Gates
- **Unit tests**: Token value tests (verify color contrast, spacing alignment)
- **Visual regression**: Chromatic/Percy with design token changes triggering baseline reviews
- **Accessibility scanning**: Automated checks on all component states + responsive breakpoints
- **Color blindness simulation**: Ensure designs pass Daltonism checks (red/green/blue-yellow variants)
- **Performance**: Token file size limits, CSS custom property lookup performance budgets


---

## 4. Component standards & states

#### Token Indirection Strategy: Primitive → Semantic → Brand

##### Tier 1: Primitive Tokens (never used directly in components)
All values stored as HSL `H S% L%` (not RGB). Example structure in CSS:
```css
/* Light mode defaults */
:root {
  --primitive-gray-50: 0 0% 98%;
  --primitive-gray-100: 0 0% 95%;
  --primitive-gray-200: 0 0% 92%;
  --primitive-gray-300: 0 0% 89%;
  --primitive-gray-400: 0 0% 85%;
  --primitive-gray-500: 0 0% 56%;
  --primitive-gray-600: 0 0% 39%;
  --primitive-gray-700: 0 0% 20%;
  --primitive-gray-800: 0 0% 5%;

  --primitive-brand-50: 25 95% 95%;
  --primitive-brand-100: 25 89% 90%;
  --primitive-brand-500: 25 82% 54%;     /* primary brand orange */
  --primitive-brand-600: 25 75% 44%;
  --primitive-brand-700: 25 70% 34%;

  --primitive-error-500: 0 59% 57%;
  --primitive-success-500: 117 38% 50%;
  --primitive-warning-500: 32 95% 44%;
  --primitive-info-500: 217 91% 60%;

  --primitive-radius-none: 0;
  --primitive-radius-xs: 0.125rem;       /* 2px */
  --primitive-radius-sm: 0.25rem;        /* 4px */
  --primitive-radius-md: 0.5rem;         /* 8px */
  --primitive-radius-lg: 1rem;           /* 16px */
  --primitive-radius-full: 9999px;

  --primitive-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
  --primitive-shadow-md: 0 4px 6px rgba(0, 0, 0, 0.1);
  --primitive-shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.1);

  --primitive-duration-fast: 100ms;
  --primitive-duration-normal: 200ms;
  --primitive-duration-slow: 300ms;
  --primitive-easing-ease-in: cubic-bezier(0.4, 0, 1, 1);
  --primitive-easing-ease-out: cubic-bezier(0, 0, 0.2, 1);
}

.dark {
  --primitive-gray-50: 0 0% 13%;
  --primitive-gray-100: 0 0% 16%;
  --primitive-gray-200: 0 0% 20%;
  --primitive-gray-300: 0 0% 25%;
  --primitive-gray-400: 0 0% 64%;
  --primitive-gray-500: 0 0% 77%;
  --primitive-gray-600: 0 0% 90%;
  --primitive-gray-700: 0 0% 96%;
  --primitive-gray-800: 0 0% 100%;
  /* Brand colors stay consistent */
}
```

##### Tier 2: Semantic Tokens (components use ONLY these)
Map primitives → meaning. Add intent-based names:
```css
:root {
  /* Surface colors */
  --semantic-surface-primary: hsl(var(--primitive-gray-50));    /* page bg */
  --semantic-surface-secondary: hsl(var(--primitive-gray-100));  /* card bg */
  --semantic-surface-tertiary: hsl(var(--primitive-gray-200));   /* hover state bg */
  --semantic-surface-inverse: hsl(var(--primitive-gray-800));    /* dark overlay */
  
  /* Text colors */
  --semantic-text-primary: hsl(var(--primitive-gray-800));       /* high contrast */
  --semantic-text-secondary: hsl(var(--primitive-gray-700));     /* medium contrast */
  --semantic-text-tertiary: hsl(var(--primitive-gray-500));      /* low contrast */
  --semantic-text-inverse: hsl(var(--primitive-gray-50));        /* on dark surface */
  --semantic-text-disabled: hsl(var(--primitive-gray-400));      /* opacity: 50% fallback */
  
  /* Border & input */
  --semantic-border-default: hsl(var(--primitive-gray-300));
  --semantic-border-strong: hsl(var(--primitive-gray-400));
  --semantic-input-background: hsl(var(--primitive-gray-100));
  --semantic-input-border: hsl(var(--primitive-gray-300));
  
  /* Interactive (brand) */
  --semantic-button-primary-bg: hsl(var(--primitive-brand-500));
  --semantic-button-primary-bg-hover: hsl(var(--primitive-brand-600));
  --semantic-button-primary-bg-active: hsl(var(--primitive-brand-700));
  --semantic-button-primary-text: hsl(var(--primitive-gray-50));
  
  --semantic-button-secondary-bg: hsl(var(--primitive-gray-100));
  --semantic-button-secondary-bg-hover: hsl(var(--primitive-gray-200));
  --semantic-button-secondary-text: hsl(var(--primitive-gray-800));
  
  --semantic-button-danger-bg: hsl(var(--primitive-error-500));
  --semantic-button-danger-bg-hover: hsl(var(--primitive-error-500), 0.9);
  --semantic-button-danger-text: hsl(var(--primitive-gray-50));
  
  /* Focus ring */
  --semantic-focus-ring: hsl(var(--primitive-brand-500));
  --semantic-focus-ring-offset: hsl(var(--primitive-gray-50));
  
  /* Status */
  --semantic-status-success-bg: hsl(var(--primitive-success-500), 0.1);
  --semantic-status-success-text: hsl(var(--primitive-success-500));
  --semantic-status-error-bg: hsl(var(--primitive-error-500), 0.1);
  --semantic-status-error-text: hsl(var(--primitive-error-500));
  --semantic-status-warning-bg: hsl(var(--primitive-warning-500), 0.1);
  --semantic-status-warning-text: hsl(var(--primitive-warning-500));
}

.dark {
  --semantic-surface-primary: hsl(var(--primitive-gray-50));     /* inverted in dark */
  --semantic-surface-secondary: hsl(var(--primitive-gray-100));
  --semantic-text-primary: hsl(var(--primitive-gray-800));
  --semantic-text-secondary: hsl(var(--primitive-gray-700));
  /* etc. */
}
```

##### Tier 3: Brand Layer (one per brand, overrides sematics)
NEW file per brand in `/packages/ui/src/brands/`:

**File: `/packages/ui/src/brands/tasca.css` (DEFAULT)**
```css
/* Tasca brand specifics */
:root {
  --brand-primary-color: var(--primitive-brand-500);           /* orange */
  --brand-secondary-color: var(--primitive-brand-600);         /* darker */
  --brand-accent-color: hsl(217, 91%, 60%);                   /* blue from info */
  --brand-logo-url: url('/tasca-logo.svg');
  
  /* Override semantics for this brand */
  --semantic-button-primary-bg: hsl(var(--brand-primary-color));
  --semantic-focus-ring: hsl(var(--brand-primary-color));
}
```

**File: `/packages/ui/src/brands/enterprise.css` (EXAMPLE)**
```css
/* Enterprise brand (customer A) */
:root {
  --brand-primary-color: hsl(280, 70%, 50%);   /* purple */
  --brand-secondary-color: hsl(280, 60%, 40%);
  --brand-accent-color: hsl(40, 100%, 50%);    /* gold */
  
  /* Override semantics */
  --semantic-button-primary-bg: hsl(var(--brand-primary-color));
  --semantic-focus-ring: hsl(var(--brand-primary-color));
}
```

##### Tier 4: Tailwind Config with Token References

**File: `/packages/remote-web/tailwind.config.cjs` (or `.js`)**
```javascript
module.exports = {
  content: ['./src/**/*.{tsx,ts}', '../web-core/src/**/*.{tsx,ts}'],
  theme: {
    extend: {
      colors: {
        /* Semantic mapping */
        background: 'hsl(var(--semantic-surface-primary) / <alpha-value>)',
        foreground: 'hsl(var(--semantic-text-primary) / <alpha-value>)',
        card: 'hsl(var(--semantic-surface-secondary) / <alpha-value>)',
        'card-foreground': 'hsl(var(--semantic-text-primary) / <alpha-value>)',
        popover: 'hsl(var(--semantic-surface-secondary) / <alpha-value>)',
        'popover-foreground': 'hsl(var(--semantic-text-primary) / <alpha-value>)',
        
        primary: 'hsl(var(--semantic-button-primary-bg) / <alpha-value>)',
        'primary-foreground': 'hsl(var(--semantic-button-primary-text) / <alpha-value>)',
        secondary: 'hsl(var(--semantic-button-secondary-bg) / <alpha-value>)',
        'secondary-foreground': 'hsl(var(--semantic-button-secondary-text) / <alpha-value>)',
        
        destructive: 'hsl(var(--semantic-button-danger-bg) / <alpha-value>)',
        'destructive-foreground': 'hsl(var(--semantic-button-danger-text) / <alpha-value>)',
        
        muted: 'hsl(var(--semantic-surface-tertiary) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--semantic-text-tertiary) / <alpha-value>)',
        
        accent: 'hsl(var(--semantic-focus-ring) / <alpha-value>)',
        'accent-foreground': 'hsl(var(--semantic-text-inverse) / <alpha-value>)',
        
        border: 'hsl(var(--semantic-border-default) / <alpha-value>)',
        input: 'hsl(var(--semantic-input-background) / <alpha-value>)',
        ring: 'hsl(var(--semantic-focus-ring) / <alpha-value>)',
      },
      spacing: {
        'half': '0.25rem',   /* 4px */
        'base': '0.5rem',    /* 8px */
        /* extend 4–64px in 4px increments */
      },
      borderRadius: {
        xs: 'var(--primitive-radius-xs)',
        sm: 'var(--primitive-radius-sm)',
        md: 'var(--primitive-radius-md)',
        lg: 'var(--primitive-radius-lg)',
      },
      zIndex: {
        'dropdown': '1000',
        'sticky': '1020',
        'fixed': '1030',
        'modal-backdrop': '1040',
        'modal': '1050',
        'popover': '1060',
        'tooltip': '1070',
      },
    },
  },
};
```

##### Implementation in Components

**Example: Button with explicit state variants**

```typescript
// /packages/ui/src/components/Button.tsx
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded border font-medium transition-colors duration-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 disabled:bg-primary',
        secondary: 'bg-secondary text-secondary-foreground border-border hover:bg-muted active:bg-muted/80 disabled:bg-secondary',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80 disabled:bg-destructive',
        outline: 'border border-border text-foreground hover:bg-muted active:bg-muted/80 disabled:text-muted-foreground',
        ghost: 'text-foreground hover:bg-muted active:bg-muted/60 disabled:text-muted-foreground',
        link: 'text-primary underline-offset-4 hover:underline disabled:text-muted-foreground',
      },
      size: {
        xs: 'h-8 px-2.5 py-1 text-xs',
        sm: 'h-9 px-3 py-1.5 text-sm',
        default: 'h-10 px-4 py-2 text-sm',
        lg: 'h-11 px-8 py-2.5 text-base',
      },
      state: {
        default: '',
        loading: 'opacity-70 cursor-wait',
        error: 'border-destructive bg-destructive/10 text-destructive',
      },
    },
    compoundVariants: [
      {
        variant: 'primary',
        state: 'loading',
        className: 'bg-primary/70',
      },
    ],
    defaultVariants: {
      variant: 'primary',
      size: 'default',
      state: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  isLoading?: boolean;
  hasError?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, state, isLoading, hasError, disabled, ...props }, ref) => {
    const finalState = isLoading ? 'loading' : hasError ? 'error' : 'default';
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, state: finalState }), className)}
        disabled={disabled || isLoading}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';
```

##### Brand Swap at Runtime

**File: `/packages/web-core/src/hooks/useBrand.ts`**
```typescript
export function useBrand(brandId?: string) {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/brands/${brandId || 'tasca'}.css`;
    link.id = 'brand-stylesheet';
    document.head.appendChild(link);
    
    return () => {
      const existing = document.getElementById('brand-stylesheet');
      if (existing) existing.remove();
    };
  }, [brandId]);
}
```

**Usage in app root:**
```typescript
// /packages/remote-web/src/App.tsx
export function App() {
  useBrand('tasca'); // or pass brandId from user settings
  return <>{/* app content */}</>;
}
```

#### Component State Spec Template

For EACH of the 18 core components, define a state table:

**Button**
| Variant | Size | Default | Hover | Focus | Active | Disabled | Loading | Error |
|---------|------|---------|-------|-------|--------|----------|---------|-------|
| primary | default | `bg-primary text-primary-foreground` | `bg-primary/90` | `focus-ring` | `bg-primary/80` | `opacity-50` | `bg-primary/70 cursor-wait` | `border-destructive bg-destructive/10` |
| secondary | default | `bg-secondary border-border` | `bg-muted` | `focus-ring` | `bg-muted/80` | `opacity-50` | `bg-secondary/70 cursor-wait` | (same) |
| ... | ... | ... | ... | ... | ... | ... | ... | ... |

(Complete for all 6 variants × 4 sizes × 8 states = 192 rows; publish as CSV/JSON)

**Input**
| Type | Disabled | Focus | Error | Placeholder |
|------|----------|-------|-------|-------------|
| text | `opacity-50 cursor-not-allowed` | `ring-2 ring-ring ring-offset-2` | `border-destructive` | `text-muted-foreground` |
| email | (same) | (same) | (same) | (same) |

(Continue for all 18 components)

### 4.x Component coverage notes
#### Design System Specification for Tasca Redesign

##### 1. Token-First Architecture

**Spacing Scale (replace all px-base, py-half usages):**
- 4px (0.25rem) = xs
- 8px (0.5rem) = sm / base
- 12px (0.75rem) = md
- 16px (1rem) = lg
- 24px (1.5rem) = xl
- 32px (2rem) = 2xl
Define as CSS custom properties: `--spacing-xs: 4px; --spacing-sm: 8px;` etc., then map Tailwind tokens to these

**Z-Index System (replace all hardcoded z-[NNNN]):**
- Base layer: 0–99 (content)
- Sticky/Headers: 100–199
- Dropdowns/Menus: 1000–1099
- Modals/Dialogs: 2000–2099 (overlay 2000, content 2050)
- Notifications/Toast: 2100–2199
- Tooltips: 3000–3099
Example: DialogOverlay = 2000, DialogContent = 2050, Dropdown = 1000, Tooltip = 3000

**Elevation/Shadow System:**
- shadow-xs: 0 1px 2px rgba(0,0,0,0.05)
- shadow-sm: 0 2px 4px rgba(0,0,0,0.08)
- shadow-md: 0 4px 8px rgba(0,0,0,0.12) [current default]
- shadow-lg: 0 8px 16px rgba(0,0,0,0.15)
- shadow-xl: 0 12px 24px rgba(0,0,0,0.20)

**Opacity/Transparency Scale:**
- Disabled text: opacity-60 (not opacity-50)
- Muted/secondary: opacity-70
- Hover states: opacity-80
- Reduced: opacity-40 (for hints/helpers)

**Animation Timing:**
- Fast: 150ms (state changes, icon transitions)
- Normal: 200ms (modal open/close, fade)
- Slow: 300ms (tooltip delay, long transitions)
Implement as CSS custom properties: `--duration-fast: 150ms;`

**Focus Ring System:**
- Color: always var(--ring) / brand token
- Width: 2px (not 1px or 1.5px)
- Offset: 2px (outer)
- States: focus-visible only (not :focus)
Global rule: `*:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }`

##### 2. Color Refactoring (from inline HSL to Semantic Tokens)

**Replace dynamic HSL injection with semantic status colors:**
- Issue Status: --status-open, --status-closed, --status-in-progress, --status-merged (6–8 predefined HSL values)
- Tag Colors: --tag-red, --tag-blue, --tag-green, --tag-purple, --tag-orange (CSS variables, not inline style)
- User/Assignee Colors: map to --avatar-color-1 through --avatar-color-8

**Pattern for KanbanBadge, StatusDot, etc.:**
```tsx
// Instead of:
style={{ backgroundColor: `hsl(${color})` }}

// Use:
className={cn('bg-status-open', {
  'bg-status-closed': status === 'closed',
  'bg-status-merged': status === 'merged',
})}
```

Or with CSS variable fallback:
```tsx
style={{ backgroundColor: `hsl(var(--status-${status}))` }}
```

##### 3. Component State Definitions (All States Required)

**Button Component:**
- **default:** bg-primary, text-primary-foreground, border-foreground
  - hover: bg-primary/90
  - focus-visible: ring-2 ring-ring
  - active: bg-primary/80 scale-98
  - disabled: opacity-60 cursor-not-allowed
  - loading: pointer-events-none + spinner icon
- **destructive:** border-error text-error
  - hover: bg-error/10
  - active: bg-error/20
- **outline:** border-input
  - hover: bg-accent text-accent-foreground
- **ghost:** text-foreground/70
  - hover: text-primary-foreground/50 (current), should be: hover: bg-secondary text-foreground
- **icon:** bg-transparent text-muted-foreground
  - hover: text-foreground
  - focus-visible: ring-1 ring-ring
- **link:** text-brand underline-offset-4
  - hover: underline
  - active: text-brand-secondary

**Input Component:**
- **default:** border border-input, bg-transparent
  - placeholder: text-muted-foreground
  - focus-visible: ring-2 ring-ring border-ring
  - disabled: opacity-50 cursor-not-allowed
  - error: border-error + aria-invalid='true' + red ring on focus
  - loading: disabled state + spinner trailing icon

**Checkbox Component:**
- **default:** border border-primary-foreground, rounded-sm
  - hover: border-primary
  - focus-visible: ring-2 ring-ring
  - checked: bg-primary text-primary-foreground
  - indeterminate: bg-primary (with dash icon instead of Check)
  - disabled: opacity-50 cursor-not-allowed

**Dialog Component:**
- **open:** overlay animate-in fade-in, content animate-in zoom-in-95 slide-in
- **closed:** animate-out fade-out zoom-out slide-out
- **focus-visible:** close button ring-2 ring-ring
- **responsive:** max-h-[90vh], max-w-[min(90vw, 42rem)]

**Dropdown Component:**
- **trigger:** bg-secondary border-border
  - hover: bg-secondary/80 (not hardcoded, use opacity)
  - focus-visible: ring-1 ring-brand
- **item:** text-high
  - hover: bg-secondary
  - focus: bg-secondary (keyboard nav)
  - disabled: opacity-50 cursor-not-allowed
  - selected: bg-brand text-on-brand + checkmark icon
- **destructive item:** text-error
  - hover: bg-error/10 text-error

##### 4. Accessibility (A11y) Spec

**Color + Pattern:**
- Status badges: color + icon or border pattern (not color alone)
- Disabled states: grayscale + opacity-60 + cursor-not-allowed
- Focus indicators: always visible, 2px ring, color ≠ bg

**ARIA Attributes (mandatory):**
- Input error: `aria-invalid="true"` + `aria-describedby="error-msg"`
- Dialog: `role="dialog"` aria-modal="true" aria-labelledby="dialog-title"` + return focus on close
- Button loading: `aria-busy="true"` when loading
- Checkbox: `role="checkbox"` aria-checked="true|false|mixed"` (for indeterminate)

**Keyboard Navigation:**
- All interactive: Tab-focusable, Enter/Space to activate, Escape to close (modals)
- Dropdown: Arrow Up/Down to navigate, Enter to select, Tab to close
- Tooltip: Trigger focusable; content NOT focusable (display: none on blur)

**Motion:**
- All animations guarded by `@media (prefers-reduced-motion: reduce)` → `animation: none`
- Current coverage: ~5% (only border-flash and create-issue-attention have guards)
- **Required:** Add to all Radix animations (fade-in, zoom-in, slide-in)

**Screen Reader:**
- sr-only for all hidden text: close labels, icon-only buttons with aria-label
- Tooltips: `aria-label` on trigger if no visible label; `role="tooltip"` on content
- Loading spinners: `aria-hidden="true"` (unless loading text provided)

##### 5. Deprecation & Refactoring Tasks

**Remove/Replace:**
1. All inline `style={{ backgroundColor: \`hsl(...)\` }}` → semantic token classes
2. All hardcoded `padding` (`12px`, `6px`) → spacing tokens
3. All hardcoded `height` (`16rem`, `29px`) → size tokens with CSS variable fallback
4. Z-index hardcodes (`z-[10000]`, `z-[9999]`) → z-layer system
5. Opacity hardcodes (`opacity-50`, `opacity-70`) → opacity scale
6. Missing focus rings on interactive: PrimaryButton, Dropdown trigger, etc.
7. Missing loading states on Button, Input (spinner icon or disabled styling)

**Add:**
1. Focus ring system (2px ring-ring with 2px offset)
2. Error state for Input (border-error, ring-error on focus, aria-invalid)
3. Indeterminate state for Checkbox (check with dash or mixed icon)
4. Prefers-reduced-motion for ALL animations (currently ~5% coverage)
5. ARIA attributes on Dialog (role, aria-modal, aria-labelledby, focus trap)
6. Keyboard navigation docs in component API (Tab, Enter, Escape, Arrow keys)
7. Status color tokens and enum for KanbanBadge, IssueTagsRow, etc.


---

## 5. Information architecture & key-flow specs

### 5.1 Navigation & kanban board
#### 1. App Shell Foundation (M1: Design-Foundation)
##### Grid Layout & Breakpoints
- **Desktop layout**: 2-column grid `grid-cols-[auto_1fr]` with AppBar sidebar (270px or 300px reserved width) | main content area
- **Desktop with banner**: 3-row grid `grid-rows-[auto_auto_1fr]` (banner | navbar | content)
- **Mobile layout**: Single-column flex container, font-size scale via `--mobile-font-scale` CSS variable
- **Breakpoints**: Mobile max-width 767px (hardcoded in CSS media query); tablet/desktop >= 768px
- **Overlay preview pane** (workspace sidebar): positioned `absolute left-0 top-0 z-30 w-[300px] h-full`, slide-in animation 150ms ease-out

##### Sidebar (AppBar) Specifications
- **Width**: 56px (w-10 * 4 + padding = 40px icon + 16px padding) or ~80px with labels on hover
- **Button base**: w-10 h-10 (40x40px), rounded-lg (0.5rem), focus-visible ring-2 on brand color
- **Spacing within sections**: 8px vertical gap (gap-2 implied in Tailwind default)
- **Section header typography**: text-[9px] (0.5625rem), leading-none, tracking-wide, color text-low
- **Bottom zone padding**: 16px (p-base token, likely 1rem)
- **Project initials badge**: 2-character abbreviation, centered, 10px font-size, medium weight
- **Status indicator dots**: 4px diameter circle for host connection state
- **Colors (hardcoded to replace)**: success (HSL 117 38% 50%), warning (32 95% 44%), neutral (0 0% 92%)

##### Top Navbar (NavbarContainer) Specifications
- **Height**: 44px (derived from text-sm with standard line-height + padding)
- **Padding**: px-base (1rem left/right), py-half (0.5rem top/bottom)
- **Breadcrumb max-width**: 100% - actions-width, with overflow hidden and min-w-0
- **Breadcrumb item spacing**: gap-1 (0.25rem) between icon and text
- **Action navbar spacing**: gap-base (token value TBD, recommend 0.5rem)
- **Divider**: 1px line, color border (0 0% 85% light / 0 0% 20% dark)
- **Focus indicators**: focus-visible ring-2 on all interactive items
- **Tooltip font-size**: text-xs (0.75rem), positioned above/below action button

#### 2. Kanban Board Anatomy (M1: Design-Foundation, M3: Tier Scaffolding)
##### Column Specifications
- **Width range**: minmax(200px, 400px) per column, flow: col auto-cols
- **Spacing between columns**: 1px divide-x border-x (0 0% 85% light / 0 0% 20% dark)
- **Column header height**: 40px (assuming 32px text + 8px padding)
- **Column header background**: gradient from brand color at 3% opacity to transparent
- **Column header text**: font-semibold, text-sm (0.875rem), truncated with text-low
- **Status label color circle**: 12px diameter, positioned before text

##### Card (Issue) Specifications
- **Width**: inherits column width (200-400px)
- **Padding**: p-base (1rem all sides)
- **Margin**: gap-base (0.5rem?) between cards
- **Border**: 1px solid border (0 0% 85% light / 0 0% 20% dark)
- **Border-radius**: 0.5rem (inherited from --_radius token)
- **Background**: background color, darker on hover (hover:bg-secondary)
- **Card title**: font-medium, text-sm, line-clamp-2 for truncation
- **Card metadata line**: flex, items-center, gap-1, text-xs, color text-low
- **Assignee avatar**: 20px diameter circle
- **Priority icon**: 16x16px, color mapped to priority level
- **Status dot**: 8px diameter circle with priority color
- **Tier/complexity badge**: 12px pill with background and text color
- **Tag pills**: 20px height, gap-half (0.25rem?) between tags, font-size text-xs
- **Drag state**: cursor-grabbing, shadow-lg (4px offset, 0.3 opacity)

##### Filter & Sort Bar
- **Height**: 44px
- **Padding**: 12px (p-half?) left/right, 8px (py-half) top/bottom
- **Filter pill styling**: rounded-sm, bg-secondary, border-none, height 32px, gap-half between icon/text
- **Search input**: inherited from Input component (w-[180px] or flex-1), bg-input, border-border
- **Sort dropdown**: 32px height button, text-sm
- **Filter count badge**: 12px diameter circle in top-right corner of filter icon

##### Multi-Select & Bulk Actions (M3: Tier Scaffolding)
- **Checkbox column**: left margin of first card (16px), width 40px, sticky on scroll
- **Checkbox**: 16x16px, border-border, checked: bg-brand
- **Bulk action bar**: sticky top, height 56px, bg-secondary, shadow-md
- **Action button group**: gap-2, padding-base, text-sm font-medium
- **Undo/clear selection button**: text-low, hover: text-normal

#### 3. Navigation & Route State (M1: Routing)
##### Routing Hierarchy
- Root: `/` (workspaces or projects page)
- Onboarding: `/onboarding` → `/onboarding/sign-in`
- Projects: `/projects/:projectId` (kanban board main view)
- Issue detail: `/projects/:projectId/issues/:issueId` (kanban + right panel)
- Workspace session: `/projects/:projectId/issues/:issueId/workspaces/:workspaceId`
- Workspace create: `/projects/:projectId/issues/:issueId/workspaces/create/:draftId`

##### Sidebar Panel Modes
- **Closed**: no right panel visible
- **Issue**: right panel shows issue detail (100% height, 360px width fixed or flex)
- **Issue-workspace**: right panel shows workspace session (split or tab view)
- **Workspace-create**: right panel shows workspace form/creation flow

##### Panel Styling
- **Width**: 360px fixed (or 40% on desktop >= 1400px)
- **Background**: bg-secondary
- **Border-left**: 1px border-border
- **Header**: 40px height, sticky top, bg-secondary, border-bottom
- **Close button**: top-right, 32px button, icon 16px
- **Scroll area**: flex-1 overflow-y-auto with custom scrollbar

#### 4. Command Bar (Keyboard Navigation - M1: Routing)
##### Dialog Wrapper
- **Positioning**: fixed, z-50 (above all other layers)
- **Overlay**: backdrop-blur-sm, bg-black/50 opacity
- **Content width**: min(90vw, 600px) centered
- **Border-radius**: 0.5rem
- **Shadow**: shadow-xl (large, 0.3 opacity)

##### Command Input
- **Height**: 44px
- **Padding**: px-base py-half
- **Font-size**: text-sm (0.875rem)
- **Border-bottom**: 1px border-border
- **Placeholder color**: text-low

##### Command Items
- **Height**: 40px
- **Padding**: px-base
- **Group label**: text-xs, text-low, uppercase, letter-spacing 0.05em
- **Item hover**: bg-accent
- **Item selected**: bg-brand, color text-on-brand
- **Icon size**: 16x16px, margin-right gap-half
- **Status color circle**: 8px diameter, margin-right gap-half
- **Keyboard shortcut text**: text-right, text-xs, color text-low, font-mono
- **Empty state**: text-center, padding-base, color text-low

#### 5. Design System Tokens (M1: Design-Foundation, M2: Team Auth)
##### Color System (HSL format, light/dark modes)
**Brand**: 25 82% 54% (orange/burnt-sienna)
- Brand-hover: 25 75% 62%
- Brand-secondary: 25 82% 37% (darker variant)
- Brand-05: 25 82% 54% opacity 5% (for backgrounds)
- Brand-10: 25 82% 54% opacity 10%

**Status Colors**:
- Success: 117 38% 50% (green)
- Warning: 32 95% 44% (amber)
- Error/Destructive: 0 59% 57% (red)
- Info: 217 91% 60% (blue)
- Merged: 271 81% 46% (purple)

**Text Hierarchy**:
- Text-high: 0 0% 5% (light) / 0 0% 96% (dark) — highest contrast, primary text
- Text-normal: 0 0% 20% (light) / 0 0% 77% (dark) — default, body text
- Text-low: 0 0% 39% (light) / 0 0% 56% (dark) — secondary, muted

**Neutral Backgrounds**:
- Background: 0 0% 95% (light) / 0 0% 13% (dark)
- Secondary: 0 0% 95% (light) / 0 0% 12% (dark)
- Muted: 0 0% 89% (light) / 0 0% 16% (dark)

**Semantic Boundaries**:
- Border: 0 0% 85% (light) / 0 0% 20% (dark) — 1px dividers, outlines
- Input/Focus: 0 0% 96% (light) / 0 0% 20% (dark) — input backgrounds

##### Spacing Scale (to define)
- **Recommended Tailwind scale**: xs: 2px, sm: 4px, base: 8px, lg: 12px, xl: 16px, 2xl: 24px, 3xl: 32px
- Current usage observed: `gap-1` (0.25rem), `gap-2` (0.5rem), `gap-base` (undefined), `p-base` (assumed 1rem), `py-half` (0.5rem)
- **Action**: Define and deploy `gap-base`, `p-half`, `p-base`, `py-base`, `px-base` in Tailwind config

##### Typography Scale
- **Font families**: IBM Plex Sans (body), IBM Plex Mono (code), Roboto (fallback)
- **Font sizes**: text-xs (0.75rem), text-sm (0.875rem), text-base (1rem), text-lg (1.125rem)
- **Font weights**: normal (400), medium (500), semibold (600), bold (700)
- **Line-height**: text-xs/4, text-sm/5, text-base/6
- **Letter-spacing**: tracking-wide (0.025em) for section headers

##### Radius & Borders
- **Border-radius**: 0.5rem (--_radius token, 0.125rem in CSS is INCORRECT, should be 0.5rem)
- **Border-width**: 1px standard
- **Border-color**: use `border-border` token (color variables defined)

##### Shadows & Elevation
- **Card shadow**: shadow-sm (0 1px 2px 0 rgba(0,0,0,0.05))
- **Drag active shadow**: shadow-lg (0 10px 15px -3px rgba(0,0,0,0.1))
- **Modal shadow**: shadow-xl (0 20px 25px -5px rgba(0,0,0,0.1))
- **Elevation hierarchy**: sm < base < lg < xl (for layering modals, dropdowns, panels)

##### Motion & Animation
- **Transition duration**: 150ms ease-out (sidebar overlays, panel slides)
- **Transition color**: 200ms (default for text/bg color changes)
- **Accessibility**: respect `prefers-reduced-motion: reduce`

### 5.2 Review, diff & agent-run flows
#### Design Token System for Review & Diff Surfaces

##### Diff Color Tokens (CSS Custom Properties)
```css
/* Light theme */
--diff-addition-text: hsl(160 77% 35%);       /* +additions text */
--diff-addition-bg: hsl(160 77% 88%);         /* +additions background */
--diff-deletion-text: hsl(10 100% 40%);       /* -deletions text */
--diff-deletion-bg: hsl(10 100% 90%);         /* -deletions background */
--diff-context-bg: var(--bg-primary);         /* context lines */
--diff-number-text: hsl(var(--text-low));     /* line numbers */
--diff-hunk-marker-text: var(--text-low);     /* @@ separators */

/* Dark theme overrides */
@media (prefers-color-scheme: dark) {
  --diff-addition-text: hsl(130 50% 50%);
  --diff-addition-bg: hsl(130 30% 20%);
  --diff-deletion-text: hsl(12 50% 55%);
  --diff-deletion-bg: hsl(12 30% 18%);
}
```

##### Review State Tokens
```css
--review-awaiting-bg: hsl(var(--brand) / 0.1);     /* Plan pending approval */
--review-awaiting-border: hsl(var(--brand));
--review-changes-bg: hsl(var(--warning) / 0.1);    /* Changes requested */
--review-changes-border: hsl(var(--warning));
--review-approved-bg: hsl(var(--success) / 0.1);   /* Approved */
--review-approved-border: hsl(var(--success));
--review-denied-bg: hsl(var(--error) / 0.1);       /* Denied/failed */
--review-denied-border: hsl(var(--error));
```

##### Approval Status Indicators
Render as badges on DiffViewCard, ChatAggregatedDiffEntries, and approval cards:
- **Awaiting Review** (default pending): Border brand-20, header bg-brand/10, checkmark icon outline
- **Changes Requested**: Border warning, header bg-warning/10, x-circle icon in warning color
- **Approved**: Border success, header bg-success/10, check-circle icon in success color, "✓ Approved" label
- **Denied/Failed**: Border error, header bg-error/10, x-circle icon in error, "✗ Denied" label

##### Execution State Tokens
```css
--exec-running: hsl(var(--info));           /* Agent/tool actively running */
--exec-pending: hsl(var(--brand));          /* Awaiting approval/input */
--exec-success: hsl(var(--success));        /* Completed successfully */
--exec-error: hsl(var(--error));            /* Failed with error */
--exec-denied: hsl(var(--error));           /* Explicitly rejected */
--exec-timeout: hsl(var(--warning));        /* Timed out */
```

##### Conversation Entry Status Icons
- Running: Animated spinner (hsl(var(--exec-running)))
- Pending approval: Hourglass or clock icon (hsl(var(--exec-pending)))
- Success: Check-circle (hsl(var(--exec-success)))
- Error: X-circle (hsl(var(--exec-error)))
- Denied: Prohibition sign (hsl(var(--exec-denied)))

### 5.3 Screen/route target notes
#### Design System Specification for Design Team

##### Color Palette (Target)
**Semantic Tokens** (lock these, no hardcoding):
- Primary: Light 95% gray → Dark 13% gray (backgrounds)
- Foreground: Light 5% → Dark 96% (text)
- Secondary: Light 95% → Dark 12% (card backgrounds)
- Muted: Light 89% → Dark 16% (disabled, subtle)
- Accent: Light 92% → Dark 20% (highlights)
- Destructive: 0° 59% 57% (error, delete actions, both themes)
- Success: 117° 38% 50% (confirmations, passes)
- Warning: 32° 95% 44% (alerts, in-progress)
- Info: 217° 91% 60% (information, help)
- Brand: 25° 82% 54% (primary action), 25° 75% 62% (hover), 25° 82% 37% (secondary action)
- Merged: 271° 81% 46% (light) / 66% (dark) — for version control merged states

**Status for Solution**: 
- Eliminate hardcoded syntax colors (#d73a49, etc.) → create syntax-token-palette (e.g., --syntax-keyword-light, --syntax-keyword-dark)
- Eliminate VSCode injection variables → create design-system-only fallback palette
- Document all hex/hsl values in design-tokens.json or design spec wiki

##### Spacing & Sizing (Target)
**Canonical Scale** (1rem = 16px):
- 2xs: 8px (0.5rem)
- xs: 12px (0.75rem)
- sm: 14px (0.875rem)
- base: 16px (1rem) — default
- lg: 18px (1.125rem)
- xl: 20px (1.25rem)

**Derived Scales**:
- Spacing (margin/padding): half (4px), base (8px), plusfifty (12px), double (16px) — ADD: triple (24px), quad (32px)
- Icon sizes: half → xl (multip. 1.25), generate full icon size guide
- Gap/space-y: gap-half (4px), gap-base (8px), gap-double (16px) — standardize gap scale across components
- Border radius: xs (2px), sm (3px), md (4px), lg (5px) — match radii to foreground/button sizes
- Border width: half (1px), base (2px) — only two weights observed, sufficient

##### Typography (Target)
**Font stack** (approved):
- Serif body: IBM Plex Sans (current, good) — confirm weight distribution (100-700 supported)
- Monospace: IBM Plex Mono (current, good)
- Emoji fallback: Noto Emoji (current, good)

**Text styles**:
- Heading/title: xl (20px, 30px lh), lg (18px, 27px lh), sm (14px, 21px lh) — no h1/h2/h3 in system yet
- Body: base (16px, 24px lh), sm (14px, 21px lh)
- Caption/label: xs (12px, 18px lh)
- Line height: base 1.5 × font size (e.g., 24px lh for 16px font) — consistent, locked

**Font weights**:
- Regular (400) — body text, most copy
- Medium (500) — headers, strong emphasis
- Bold (700) — action labels, prominence
- Light (300) — secondary text, if needed (Noto Emoji 300-700)

##### Responsive Design (Target)
**Mobile-first approach LOCKED**:
- Mobile threshold: 767px (custom breakpoint, matches iOS iPad Mini width)
- NO Tailwind sm:/md:/lg:/xl: breakpoint utilities — use conditional rendering + `useIsMobile()` hook
- Tablet/desktop detection: add `useMedium(1024px)`, `useLarge(1280px)` hooks alongside existing `useIsMobile()` for 3-tier layout system
- Panel resizing: resizable-panels library sufficient for desktop; mobile tabs via `useMobileActiveTab()` state

**Breakpoint guidance for design team**:
| Breakpoint | Width | Primary Use | Layout Strategy |
|---|---|---|---|
| Mobile | ≤ 767px | Phone, small tablet | Single-column, tab navigation, full-width cards |
| Medium | 768–1279px | Large tablet | 2-column, collapsible sidebars |
| Large | ≥ 1280px | Desktop, wide screens | 3+ column, multi-panel layout |

**Responsive component rules**:
- Buttons: full-width on mobile, auto on desktop
- Cards: 100% width on mobile, constrained grid on desktop
- Forms: single-column on mobile, 2-column grid on desktop (login max-w-md = 448px, acceptable)
- Modals: 90vw on mobile, max-w-md on desktop
- Navigation: hamburger menu on mobile, horizontal on desktop (already implemented via WorkspacesSidebar)

##### Component Baseline (Target)
**Standardized states for all interactive components**:
1. Default/rest
2. Hover/focus
3. Active/pressed
4. Disabled
5. Loading (spinner overlay or skeleton)
6. Error (border + icon + message)
7. Success (checkmark, color change)

**Required component library coverage**:
- Buttons: primary, secondary, tertiary, destructive, ghost (all 4 states + sizes: xs, sm, base, lg, xl)
- Inputs: text, email, password, number, textarea (with label, placeholder, error, disabled, focus states)
- Selects/dropdowns: with search, multi-select, large lists (virtual scrolling for 100+ options)
- Dialogs/modals: alert, form, confirmation, custom content
- Notifications: toast, inline alert (error/warning/info/success)
- Cards: default, hover, selected, loading states
- Badges/pills: sizes xs-xl, colors (all semantic colors), dismissible variant
- Progress indicators: linear, circular, spinner, skeleton
- Tabs: vertical, horizontal, scrollable (mobile consideration)
- Disclosure/accordion: expand/collapse with animation
- Kanban cards: status-labeled, priority-colored, assignee avatar, drag-handle styling

##### Typography Scale (Target)
Create 8-level system:
- Display (h1): 32px / 48px lh, weight 700
- Headline (h2): 24px / 36px lh, weight 700
- Title (h3): 20px / 30px lh, weight 600
- Subtitle: 18px / 27px lh, weight 500
- Body (default): 16px / 24px lh, weight 400
- Body small: 14px / 21px lh, weight 400
- Caption: 12px / 18px lh, weight 400
- Label: 11px / 16px lh, weight 500 (for buttons, form labels)

##### Theming & Dark Mode (Target)
**Approved approach** (class-based):
- Root element: `<html class="dark">` or `<html>` (no class = light)
- Theme provider: ThemeProvider component (already in place, `/packages/local-web/src/routes/__root.tsx`)
- System-preference detection: implemented (useSystemTheme hook)
- User override: localStorage + UI toggle (settings dialog, already referenced)
- Transition: all colors `transition-colors duration-200` on interactive elements (line 288, index.css)

**Dark mode parity**:
- All colors have light + dark definitions in CSS custom properties ✓
- Syntax highlighting: light #d73a49, #6f42c1, etc. vs. dark #ff7b72, #d2a8ff, etc. — **needs audit** (may not meet dark-mode contrast)
- Console colors: light `0 0% 100%` vs. dark `0 0% 0%` — good contrast
- VSCode injection: fallback system colors used, acceptable

##### Icon System (Target)
**Library**: Phosphor Icons (React) — currently used
**Sizes** (locked to spacing scale):
- 2xs: 10px (icon-2xs, 0.625rem)
- xs: 15px (icon-xs, 0.9375rem)
- sm: 17px (icon-sm, 1.09375rem)
- base: 20px (icon-base, 1.25rem) — default for most UI
- lg: 23px (icon-lg, 1.40625rem)
- xl: 25px (icon-xl, 1.5625rem)

**Weights**: bold for primary actions, regular for secondary/status (verified in code, e.g., `weight="bold"`)
**Colors**: use semantic color tokens (no hardcoded icon colors)

##### Animation & Motion (Target)
**Approved animations** (from tailwind config, lines 143-181):
- accordion-down/up: 0.2s ease-out (disclosure)
- pill: 2s ease-in-out (notification fade in/out)
- running-dot: 1.4s infinite (loading indicator)
- border-flash: 2s infinite (attention, data refresh)
- shake: 0.3s ease-in-out (error state)

**Additional needed**:
- Fade: 0.2s ease-in-out (modal enter/exit)
- Slide: 0.2s ease-out (sidebar, panel)
- Spin: infinite (spinner, data fetching)
- Pulse: infinite (skeleton, loading placeholders)

**Accessibility**: all animations respect `prefers-reduced-motion: reduce` (NOT currently implemented — flag as gap)

##### Design System Documentation (Target)
Deliverables for design team:
1. **Design tokens JSON**: export all color, spacing, typography, radius, animation values
2. **Component catalog**: Figma library with all states/variants (buttons, inputs, modals, etc.)
3. **Responsive grid**: 12-column grid for desktop, 4-column for tablet, 2-column for mobile (constrain max-w in Tailwind)
4. **Pattern library**: form layouts, card arrangements, kanban column widths, modal max-w
5. **Accessibility guide**: WCAG AA minimum contrast ratios, focus indicators, ARIA labeling templates
6. **Dark mode spec**: all color pairs with contrast ratios verified
7. **Icon set style guide**: sizing, weight, color, usage rules
8. **Typography showcase**: all heading/body/label styles with examples
9. **Animation transitions**: approved ease functions, durations, use cases
10. **Theming code documentation**: how to extend colors, add new semantic tokens


---

## 6. New-feature screens the PRD requires

> Complexity-tier UI, agent-as-assignee picker, PM-assistant chat, GitHub PR↔ticket status, guest propose-only.

#### Required Design Specifications for Five New Features

##### 1. Complexity Tier Selector (M3, ROADMAP L27 "Add agent picker and complexity-tier UI to the issue surface")

**When**: On issue detail/card edit, inline or modal picker
**Where**: Issue detail sidebar or card overlay, right-align with priority/status selectors
**Type**: Button group or dropdown select; radio group for mobile

**States**:
- Basic (default): `bg-tier-basic-light border-tier-basic text-tier-basic-dark` (token req: tier-basic palette)
- Low: `bg-tier-low-light border-tier-low text-tier-low-dark`
- Medium: `bg-tier-medium-light border-tier-medium text-tier-medium-dark`
- Hard: `bg-tier-hard-light border-tier-hard text-tier-hard-dark`
- Ultra: `bg-tier-ultra-light border-tier-ultra text-tier-ultra-dark` (red/error-adjacent)

**Tokens to Define**: `tier-basic`, `tier-low`, `tier-medium`, `tier-hard`, `tier-ultra` (each with `-light`, `-dark`, default, hover, focus variants). Recommend: Basic→gray, Low→blue, Medium→yellow, Hard→orange, Ultra→red.

**Accessibility**: ARIA labels "Complexity: Basic", focus ring, keyboard nav (arrow keys), screen reader announces current tier. Min touch target 44px.

**Responsive**: Desktop: 160px width button group; Mobile: full-width dropdown select.

**API Integration**: Endpoint `PATCH /issues/{id}` with `complexity_tier` enum payload.

---

##### 2. Agent-as-Assignee Picker (M3, ROADMAP L27 "Add agent picker and complexity-tier UI to the issue surface")

**When**: On issue detail/card edit, assignee selector
**Where**: Issue detail sidebar, inline with current assignee avatar + role badge

**Type**: Searchable dropdown or modal picker with avatar + name + availability status
**Options**: 
  - User list (existing team members, with role badge: owner/admin/member/guest)
  - Agent list (PM-Assistant if enabled, Worker Agent if available)
  - "Unassigned" option

**Agent Entry Fields**:
- Avatar: Agent-specific icon or generated avatar (`AgentIcon` component ref from LandingPage:35)
- Name: `getAgentName()` result (ref LandingPage:35)
- Type badge: "AI" or "Agent" label with icon, `bg-agent-badge text-on-agent-badge` token
- Availability status: dot indicator (green=available, gray=offline, yellow=busy) + tooltip "Available" / "Offline" / "Processing"
- Tier support hint: Text "Supports Ultra complexity" or "Supports up to Hard" (conditional on agent type)

**States**:
- Unassigned: `text-low italic "Unassigned"`
- User selected: Avatar + name, border `border-brand/50` on focus
- Agent selected: Avatar + name + "AI" badge, border `border-brand/50`
- Hover: `bg-panel/80` highlight
- Focus: `ring-1 ring-brand`

**Tokens to Define**: `agent-badge`, `agent-avatar-bg` (or use `bg-brand/15`), avatar size tokens (24px for picker, 32px for assignee display).

**Keyboard**: Space/Enter to select, arrow keys to navigate list, Escape to close.

**Responsive**: Desktop: 280px dropdown; Mobile: full-screen modal with search input.

**API Integration**: Endpoint `PATCH /issues/{id}` with `assignee_id` or `agent_id` payload. Return assignee with `type: "user" | "agent"` and availability data.

---

##### 3. PM-Assistant Chat Panel (M3, ROADMAP L716 "Build PM-assistant chat UI"; PRD §5.3)

**When**: Opens on-demand via button in project toolbar or sidebar toggle
**Where**: Right sidebar (landscape) or bottom drawer (mobile); overlay above kanban

**Type**: Chat-style vertical panel with message list + input bar

**Layout**:
- Header: "PM Assistant" title + close button (X)
- Messages area: Scrollable list, 320px width (desktop), full width on mobile
- Input area: Text input + submit button (send icon)

**Message Styles**:
- User message: `bg-brand/10 border-l-4 border-brand text-high` (right-aligned on desktop), avatar user icon or initials
- Assistant message: `bg-panel border-l-4 border-low text-normal`, avatar agent icon
- System message (degraded): `bg-warning/10 border-l-2 border-warning text-low italic` (e.g., "API key not configured")

**States**:
- Empty: Placeholder text "Ask me about sprint planning, priorities..." in `text-low`
- Loading: Typing indicator (three animated dots), `text-low` color
- Error: Red alert box `bg-error/10 border-error/30 text-error`
- Ready: Input active, send button enabled `bg-brand text-on-brand` hover `bg-brand-hover`

**Tokens to Define**: `panel-surface` (or use `bg-panel`), `message-user-bg`, `message-assistant-bg`, `typing-indicator-color`, message border-left color tokens.

**Accessibility**: ARIA live region for new messages, keyboard focus in input, Tab to send button, Escape to close.

**Responsive**: Desktop sidebar fixed 320px; Mobile full-width bottom drawer with 60% max-height, swipe-down to dismiss.

**API Integration**: WebSocket or polling endpoint `/projects/{id}/pm-assistant/messages` for streaming responses. POST `/projects/{id}/pm-assistant/messages` for user input. Include `parent_message_id` for threading.

---

##### 4. GitHub PR ↔ Ticket Status Surface (M4, ROADMAP L198 "Add system_category to project_statuses"; PRD §5.4)

**Where**: Issue card detail + quick-view widget; new "GitHub" section in issue sidebar

**Type**: Embedded widget showing linked PR(s) + review state + auto-status-sync toggle

**Widget Structure**:
- Header: "Linked GitHub PRs" title + "Link PR" button (launches modal)
- PR List (if any): For each PR, show:
  - PR title (truncated, ~40 chars)
  - PR number + repo (`icemint/tasca#1234`)
  - Review state badge: `Draft` / `Open` / `Approved` / `Changes Requested` / `Closed` / `Merged`
  - Review state color: Draft→gray, Open→blue, Approved→green, Changes Requested→orange, Closed→red, Merged→purple
  - Reviewers: Avatar stack (max 3, +N more) with tooltip
  - Last updated timestamp ("5m ago")
  - Action button: Unlink (trash icon) or View on GitHub (external link icon)

**Status Sync Toggle** (if PR linked):
- Label: "Auto-sync: Issue status follows PR reviews"
- Toggle ON: `bg-brand`, OFF: `bg-border`
- Rules displayed below toggle: "When PR is Approved → ready_for_development | When Changes Requested → in_review"

**Link PR Modal**:
- Search input: "Search GitHub PR..." with autocomplete
- Button: "Link This PR" (disabled if already linked or invalid)
- Text: "Linking will enable auto-status sync based on review state"

**States**:
- No PR linked: `text-low italic "No linked PR. Link one to enable status sync."`
- PR Draft: Badge `bg-gray/20 text-gray` + "Draft review, no action needed"
- PR Approved: Badge `bg-success/20 text-success` + "Ready for development when merged"
- PR Changes Requested: Badge `bg-warning/20 text-warning` + "Review feedback pending"
- Multiple PRs: Tabs or list showing each; only latest merged one drives auto-sync

**Tokens to Define**: `review-state-draft`, `review-state-open`, `review-state-approved`, `review-state-changes-requested`, `review-state-closed`, `review-state-merged` (each with `-bg-light` and `-text` variants). Recommend using semantic colors: gray, blue, green, orange, red, purple.

**Accessibility**: ARIA labels "Review state: Approved", keyboard navigation in list, external link icon with title="Open on GitHub".

**Responsive**: Desktop: 360px sidebar widget; Mobile: drawer / bottom sheet with full PR list.

**API Integration**: `GET /tickets/{id}/github-prs` returns linked PRs with review state. `POST /tickets/{id}/github-prs` to link. `DELETE /tickets/{id}/github-prs/{pr_id}` to unlink. `PATCH /tickets/{id}/github-sync-enabled` to toggle auto-sync. Auto-status endpoint: `POST /tickets/auto-sync-from-pr-reviews` (system trigger on PR review webhook).

---

##### 5. Guest Propose-Only Restricted View (M5, PRD §6 "External clients + sandbox"; ROADMAP implied)

**Where**: New issue creation form (modal or page) + issue detail read-only view

**Type**: Conditional UI rendering based on role = "guest" + status filter

**Guest View Restrictions**:
- Issue list: Read-only, no edit/delete buttons; can filter by status only (no advanced search)
- Issue detail: Read-only body + comments; no assignee/status/tier/priority edit
- Issue creation: NEW SURFACE - "Propose Issue" modal (instead of "Create Issue")
  - Fields visible: Title (required), Description (rich text), maybe Category/Type (if enum exists)
  - Fields hidden: Assignee, Status, Priority, Complexity Tier, Sprint, Labels
  - Submit button: "Propose" not "Create"
  - Post-submit: Confirmation toast "Your proposal has been submitted for review" + read-only view of proposed issue

**Propose Issue Modal**:
- Header: "Propose a New Issue"
- Form:
  - Title: Text input, placeholder "What needs to be done?", required, max 200 chars
  - Description: Rich text editor or markdown textarea, optional
  - Category: Maybe optional select if project has categories, else hidden
  - Submit: "Propose Issue" button `bg-brand text-on-brand`
  - Cancel: "Dismiss" button
- On submit success:
  - Toast: `bg-success/10 border-success text-success` "Your proposal submitted. Admins will review and create the issue."
  - Redirect to issue list (read-only)

**Guest List View Restrictions**:
- Toolbar: "Create Issue" button hidden or disabled with tooltip "Only members can create issues"
- Bulk actions (select checkbox): Disabled/hidden
- Issue card: Click-to-view only; no context menu
- Filters: Only "Status" filter visible, no "Assignee" or "Complexity" filters

**Tokens to Define**: `propose-action-bg` (could be `bg-brand/10` or new `bg-secondary-brand`), `role-badge-guest` (`bg-low text-low`), restricted-state indicators (`text-low opacity-50`).

**Accessibility**: ARIA labels "Read-only. You cannot edit issues as a guest." Announce role in page header. Focus management in modal.

**Responsive**: Desktop: Modal centered 600px width; Mobile: full-screen sheet with scrollable form.

**API Integration**: `POST /issues/propose` (guest endpoint, no assignee/status/tier allowed). Returns issue with `status: "proposed"` (new enum value). Admins see "proposed" issues in separate tab or badge. `PATCH /issues/{id}/approve-proposal` (admin only) to create final issue from proposal.

---

#### Settings Surfaces for Feature Management

##### New Settings Sections Required

1. **Organization > API Keys** (NEW)
   - Field: Anthropic API key input (masked, copy button)
   - Validation: Test connection, show "Connected" checkmark if valid
   - Required for Phase 3 (PM-assistant)
   - Condition: Only show if org has owner/admin role

2. **Organization > Feature Flags** (NEW)
   - Toggle: "Enable Complexity Tiers" (default OFF for Phase 2; ON in Phase 3)
   - Toggle: "Enable PM-Assistant" (default OFF; ON when Anthropic key configured)
   - Toggle: "Enable GitHub Integration" (default OFF; ON in Phase 4)
   - Toggle: "Allow Guest Propose-Only" (default OFF; ON in Phase 5)
   - Dependency hints: "PM-Assistant requires valid Anthropic API key" (yellow alert if key not set but toggle ON)

3. **Organization > Member Permissions** (EXISTING, ENHANCE)
   - Add row for "Guest (Propose-Only)" role
   - Permissions table: Create Issue → Guest shows "Propose only" instead of on/off

4. **Project > Sprint Management** (NEW)
   - Table: Sprint name, status (active/archived), start/end dates, capacity
   - Actions: New Sprint button, Edit, Delete
   - Only visible if Sprints feature enabled (Phase 3+)

5. **Project > Tier Policy** (NEW)
   - Toggle: Require tier on creation (default OFF)
   - Dropdown: Default tier for new issues (Basic/Low/Medium)
   - Rule: Agent assignments auto-set tier to Hard/Ultra if agent has high capability

---

#### Responsive Breakpoints

- **Mobile (<768px)**: Full-screen modals, bottom drawers, stacked layout, touch targets 44px min
- **Tablet (768px-1024px)**: Half-width modals, 2-column layouts, side drawer for chat
- **Desktop (>1024px)**: Centered modals (600-900px), sidebar panels, 3-column grids, hover states enabled

---

#### A11y Requirements Across All New Surfaces

- Focus rings: `ring-1 ring-brand` on all interactive elements
- ARIA labels: "Complexity Tier: Basic", "Agent: PM-Assistant (Available)", "Review State: Approved"
- Color + icon: Never use color alone to convey status (always add badge/icon/text)
- Keyboard: Arrow keys for selection, Tab for navigation, Enter/Space for activate, Escape for close
- Screen reader: Live regions for async updates (chat messages, status changes), announce role/availability on focus
- Form validation: Clear error messages in alert boxes, field-level hints in gray `text-low`

---

#### New Enum/Type Tokens to Define in Tailwind Config

```
colors: {
  // Complexity Tiers
  tier-basic: { light: '#E8F0FE', dark: '#001D52' },
  tier-low: { light: '#D0E8F2', dark: '#0B3D91' },
  tier-medium: { light: '#FEF3C7', dark: '#92400E' },
  tier-hard: { light: '#FED7AA', dark: '#7C2D12' },
  tier-ultra: { light: '#FEE2E2', dark: '#7F1D1D' },
  
  // Agent / Review States
  agent-badge: '#F3E8FF', // lavender
  review-state-approved: '#DCFCE7', // light green
  review-state-requested: '#FED7AA', // light orange
  review-state-draft: '#E5E7EB', // light gray
  
  // Message Styles
  message-user-bg: '#E0E7FF', // indigo-light
  message-assistant-bg: '#F3F4F6', // gray-light
},
spacing: {
  // Existing: base, half, double, etc. (verify in current config)
  icon-sm: '16px',
  icon-xs: '12px',
  icon-xl: '24px',
}
```

---

#### Design Debt to Address Before Feature Launch

1. Extract OAuthButton to @vibe/ui/components/OAuthButton (tokenize hardcoded colors)
2. Create agent-related icon/avatar component system
3. Add tier-selector component to UI library
4. Define PM-assistant chat message styles in theme
5. Create review-state badge component with color tokens
6. Audit all inline `className` hardcoding; migrate to tokens
7. Add role-based conditional rendering utilities (guest, agent, admin checks)


---

## 7. Accessibility requirements (WCAG 2.2 AA)

#### Target: WCAG 2.2 AA Accessibility + Responsive + Rebrand-Ready Design System

##### 1. Color & Contrast Compliance

###### 1.1 Semantic Color Tokens (WCAG AA, AA-Large)
Create a **contrast matrix** for all color pairs:

**Light Mode (0 0% 95% background)**
- Text high (0 0% 5%): 20:1 on bg → **Text color AA & AAA-Large ✓**
- Text normal (0 0% 20%): ~17:1 on bg → **Text color AA & AAA-Large ✓**
- Text low (0 0% 39%): ~10.5:1 on bg → **Text color AA for large text, AAA questionable**
- **Action**: Increase text-low to 0 0% 35% (~8.5:1) or use only for secondary text (>18pt)

- Destructive (0 59% 57%): ~4.2:1 on bg → **Below AA for normal text**
- **Action**: Use hsl(0, 68%, 48%) → 4.8:1 AA minimum, or hsl(0, 72%, 42%) → 5.1:1

- Muted-foreground (0 0% 56%) on muted bg (0 0% 89%): 4.5:1 → **AA marginal**
- **Action**: Change muted-foreground to 0 0% 50% → 6:1 (comfortable margin)

- Success (117 38% 50%): **1.3:1 on white** ✗ **No WCAG compliance**
- **Action**: Dual tokens:
  - `--success-text: 117 38% 35%` → 5.2:1 on white (AA text color)
  - `--success-bg: 117 38% 85%` → 3.2:1 for success badge bg (use with dark text)

- Warning (32 95% 44%), Info (217 91% 60%): **Similar failures**
- **Action**: Create separate `-text` and `-bg` variants:
  - Warning-text: 32 95% 30% (6.5:1 on white) | Warning-bg: 32 95% 88% (3:1)
  - Info-text: 217 91% 30% (6:1 on white) | Info-bg: 217 91% 90% (2.8:1)

**Dark Mode (0 0% 13% background)**
- Text high (0 0% 96%): 20:1 on bg → **AA & AAA ✓**
- Text normal (0 0% 77%): 9.8:1 → **AA ✓, AAA for large only**
- Text low (0 0% 56%): 4:1 → **AA-large text only; avoid for normal copy**
- **Action**: Adjust text-low to 0 0% 60% → 4.8:1 (safer margin)

- Destructive (0 59% 57%): **Same as light** ✗
- **Action**: Use hsl(0, 72%, 62%) → 4.9:1 on dark bg

- Success (117 38% 50%): **1.9:1 on dark** ✗
- **Action**: Use 117 38% 65% → 5.1:1 on dark (or use -text/-bg variants like light)

###### 1.2 CSS Implementation
```css
@layer base {
  :root {
    /* Light mode */
    --text-high: 0 0% 5%;
    --text-normal: 0 0% 18%;
    --text-low: 0 0% 38%;
    
    /* Status - light */
    --success-text: 117 38% 35%;
    --success-bg: 117 38% 88%;
    --warning-text: 32 95% 30%;
    --warning-bg: 32 95% 88%;
    --info-text: 217 91% 28%;
    --info-bg: 217 91% 90%;
    
    /* Muted */
    --muted-foreground: 0 0% 50%;
  }
  
  .dark {
    --text-high: 0 0% 96%;
    --text-normal: 0 0% 78%;
    --text-low: 0 0% 58%;
    
    /* Status - dark */
    --success-text: 117 38% 65%;
    --success-bg: 117 38% 22%;
    --warning-text: 32 95% 68%;
    --warning-bg: 32 95% 18%;
    --info-text: 217 91% 68%;
    --info-bg: 217 91% 20%;
  }
}
```

###### 1.3 Measurement & Audit
- Publish a **contrast matrix** (Excel/CSV or design doc):
  - Columns: `Color Token`, `Light Mode HSL`, `Light Contrast Ratio`, `Dark Mode HSL`, `Dark Contrast Ratio`, `WCAG Level`
  - Rows: all semantic tokens (text-high, destructive, success, warning, info, muted-foreground, etc.)
- Run Lighthouse/axe-core against all color combinations in staging
- **Audit schedule**: Monthly; flag any ratio <4.5:1 as P0

---

##### 2. Focus Management & Keyboard Navigation

###### 2.1 Focus Indicator Enhancement
**Target**: Visible on all backgrounds, 3:1 minimum contrast to focused element

**Current**:
- Ring: `focus-visible:ring-1 focus-visible:ring-ring/40` (40% opacity)
- Single 1px ring insufficient for visibility

**Target CSS**:
```css
/* Base focus ring (upgrade) */
button:focus-visible,
a:focus-visible,
[role="button"]:focus-visible {
  outline: none;
  /* 2px ring, 100% opacity on ring color */
  box-shadow: 0 0 0 2px hsl(var(--background)),
              0 0 0 4px hsl(var(--ring));
}

/* High-contrast mode support */
@media (prefers-contrast: more) {
  button:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }
}
```

**Rationale**: Double-ring creates a 2px outline that's visible on both light and dark backgrounds (white inner, colored outer). Respects high-contrast preference.

###### 2.2 Focus Order & Skip Links
- **Target**: Tab order matches visual order (LTR in English)
- **Implementation**:
  - KanbanBoard: Add skip link at top: `<a href="#main-content" class="sr-only">Skip to main content</a>`
  - Ensure tabIndex values follow visual hierarchy; audit with aXe DevTools
  - Dialog: Trap focus inside (Radix Dialog does this ✓); return focus on close

###### 2.3 Button Role Semantics
**Current issue**: Interactive divs with `role="button"` don't get automatic keyboard handling (Space/Enter).

**Target**: Use native `<button>` or add keyboard handling:
```typescript
// For role="button" divs:
onKeyDown={(e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    onClick?.(e as any);
  }
}}
```

Apply to: ChatAggregatedDiffEntries, SubIssueRow, RelationshipBadge, all role="button" elements.

###### 2.4 Disabled State a11y
**Current**: `disabled:opacity-50 disabled:cursor-not-allowed` only.

**Target**:
```css
button:disabled {
  @apply opacity-50 cursor-not-allowed;
  /* Ensure disabled buttons are not focusable */
  pointer-events: none;
}

/* Or use aria-disabled for semantic divs */
[aria-disabled="true"] {
  @apply opacity-50 cursor-not-allowed pointer-events-none;
}
```

---

##### 3. ARIA & Semantic HTML

###### 3.1 Live Regions for Drag-Drop
**Current gap**: No aria-live notification when a card is dropped.

**Target**:
```typescript
const [announcement, setAnnouncement] = useState("");

const handleDragEnd = (result) => {
  // ... reorder logic ...
  setAnnouncement(
    `Card moved to ${destination.droppableId}. ` +
    `${result.source.index + 1} of ${cardCount} in column.`
  );
  setTimeout(() => setAnnouncement(""), 1000);
};

// In JSX:
<div aria-live="polite" aria-atomic="true" className="sr-only">
  {announcement}
</div>
```

###### 3.2 Form Input a11y
**Current gap**: No aria-describedby, aria-required, aria-invalid.

**Target**: Create an `<InputField>` component wrapper:
```typescript
interface InputFieldProps {
  label: string;
  id: string;
  error?: string;
  required?: boolean;
  // ...
}

export const InputField = ({ label, id, error, required }) => (
  <>
    <label htmlFor={id}>{label}</label>
    <input
      id={id}
      aria-required={required}
      aria-describedby={error ? `${id}-error` : undefined}
      aria-invalid={!!error}
      // ...
    />
    {error && <span id={`${id}-error`}>{error}</span>}
  </>
);
```

Apply to: All form fields in settings, modal dialogs, create-issue flow.

###### 3.3 Navigation & Current Page
**Current gap**: No aria-current on active nav links.

**Target**:
```typescript
const navItems = [{ label: "Dashboard", href: "/", current: location === "/" }];

navItems.map(item => (
  <a
    href={item.href}
    aria-current={item.current ? "page" : undefined}
  >
    {item.label}
  </a>
))
```

###### 3.4 Toggle Components
**Current gap**: Toggle buttons lack aria-pressed.

**Target**:
```typescript
<button
  aria-pressed={isOpen}
  onClick={() => setIsOpen(!isOpen)}
>
  {isOpen ? "Hide" : "Show"} Details
</button>
```

---

##### 4. Motion & Prefers-Reduced-Motion

###### 4.1 Apply prefers-reduced-motion Globally
**Current**: Only `.create-issue-attention` respects reduced motion; `.chat-box-running` does not.

**Target**:
```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Or per-component: */
@media (prefers-reduced-motion: reduce) {
  .chat-box-running::before {
    animation: none;
  }
}
```

Apply to all animations (border-flash, transition-colors global, etc.).

###### 4.2 Transition Utility Wrapper
```css
@layer utilities {
  @media (prefers-reduced-motion: reduce) {
    .transition-colors {
      transition: none;
    }
  }
}
```

---

##### 5. Target Sizes & Touch

###### 5.1 Minimum 44x44px Touch Targets
**Current gaps**:
- xs button: 32px height ✗
- Kanban drag handle: ~16x16px ✗

**Target**:
```css
/* Button size scale (Tailwind mapping) */
size: {
  xs: 'h-11 px-2 text-xs',     /* 44px min */
  sm: 'h-11 px-3',              /* 44px min */
  default: 'h-11 px-4 py-2',    /* 44px min */
  lg: 'h-12 px-8',              /* 48px min */
  icon: 'h-11 w-11',            /* 44x44px min */
}

/* Kanban drag handle */
.drag-handle {
  @apply min-w-11 min-h-11;  /* 44x44px */
  /* On mobile, expand touch target with padding */
  @media (max-width: 768px) {
    @apply p-2;
  }
}
```

###### 5.2 Touch Padding in Dense Layouts
- Dialog buttons: Add spacing between confirm/cancel (gap-2 ✓)
- Kanban cards: Minimum 8px margin when stacked on mobile (add m-2 when single-column)
- Icon buttons in toolbars: Minimum 44px; add touch padding (8px) on mobile

---

##### 6. Responsive Design Strategy

###### 6.1 Breakpoints & Layout
Use Tailwind defaults:
- `sm: 640px` → Tablet portrait / large phone
- `md: 768px` → Tablet landscape
- `lg: 1024px` → Desktop minimum
- `xl: 1280px` → Large desktop

###### 6.2 Kanban Board Responsive Behavior
**Current**: Fixed `inline-grid grid-flow-col` → horizontal scroll on all sizes ✗

**Target**:
```typescript
// KanbanProvider responsive grid
const kanbanClasses = () => {
  if (isMobile) {
    // Single column on mobile (< 640px)
    return 'flex flex-col';
  } else if (isTablet) {
    // 1-2 columns on tablet (640px–1024px)
    return 'grid grid-cols-1 md:grid-cols-2';
  } else {
    // Horizontal scroll for columns on desktop (>1024px)
    return 'inline-grid grid-flow-col auto-cols-[minmax(280px,400px)]';
  }
};
```

**Or Tailwind-first**:
```html
<div class="flex flex-col lg:inline-grid lg:grid-flow-col lg:auto-cols-[minmax(280px,400px)]">
```

###### 6.3 Typography Scaling
**Current**: Fixed font sizes (font-sm, text-sm = 14px).

**Target**: Scale text on mobile:
```css
/* Mobile text scale (opt-in via font-size adjustment) */
@media (max-width: 640px) {
  body {
    font-size: calc(14px * var(--mobile-font-scale, 1));
  }
  
  h1 { @apply text-lg; }  /* 32px → 18px */
  h2 { @apply text-base; } /* 24px → 16px */
  p { @apply text-sm; }   /* 16px → 14px */
}
```

###### 6.4 Dialog Responsive
**Current**: sm:max-w-[425px] ✓
**Target**: Add mobile full-width override:
```css
@media (max-width: 640px) {
  .dialog-content {
    @apply mx-4;  /* 16px margin on mobile */
  }
}
```

---

##### 7. Rebrand Implementation Plan (Step-by-Step)

###### Phase 1: Design Tokens (2–3 days)
**Goal**: Decoupled from code; single source of truth.

1. **Audit current tokens**
   - Export all CSS custom properties from index.css into a token map: `/docs/design-tokens.json`
   - Categorize: color (base, semantic, status), typography (family, size, weight), spacing, radius, shadows

2. **Define rebrand tokens**
   - New brand color: e.g., `--brand: 280 95% 45%` (purple) instead of `25 82% 54%` (orange)
   - Create `--brand-primary`, `--brand-secondary`, `--brand-hover`, `--brand-active`
   - Derive UI colors: keep `--success`, `--warning`, but adjust for new brand context
   - Define logo color (if custom): `--logo-color: hsl(var(--brand))`

3. **Publish token spec**
   - Figma token document or design tool export
   - Includes light/dark variants for all colors
   - Developers consume via tailwind.config.js

**File changes**:
- `/packages/web-core/src/app/styles/new/index.css` — update @layer base colors
- `/packages/remote-web/tailwind.config.cjs` — add theme extension (if not present)
- `/docs/design-tokens.json` — new file with token spec

###### Phase 2: Typography & Logo (3–5 days)
**Goal**: Font family and logo slot.

1. **Swap font family**
   - Current: IBM Plex Sans (file:line: /Users/macpro/Documents/tasca/packages/web-core/src/app/styles/new/index.css:1)
   - Target font: e.g., Inter, Roboto Flex, etc.
   - Update @import URL and font-family in index.css
   - No code changes required (applied globally via `font-ibm-plex-sans` class)

2. **Logo component**
   - Current: `.logo { @apply fill-foreground }` (uses theme color)
   - Target: Create `<BrandLogo>` component slot:
   ```typescript
   interface BrandLogoProps {
     variant?: 'horizontal' | 'icon' | 'wordmark';
   }
   export const BrandLogo = ({ variant = 'horizontal' }) => {
     // SVG imported or URL-based; uses --logo-color token
     return <svg className="text-brand" />;
   };
   ```
   - Place in: `/packages/ui/src/components/BrandLogo.tsx`
   - Use in: Navbar, dialogs, auth flows (replace current inline logo refs)

**File changes**:
- `/packages/web-core/src/app/styles/new/index.css` — font-family, @import swap
- `/packages/ui/src/components/BrandLogo.tsx` — new component
- `/packages/ui/src/index.ts` — export BrandLogo
- References to hardcoded logo paths → use BrandLogo component

###### Phase 3: Color Token Propagation (5–7 days)
**Goal**: Replace hardcoded colors and inline styles with tokens.

1. **Remove hardcoded status colors**
   - Current: PRESET_COLORS hardcoded in `/packages/web-core/src/shared/lib/colors.ts:3–16`
   - Target: Move to CSS tokens or design system config
   - Option A: Keep HSL values but reference from tokens file
   - Option B: Use theme-aware palette (light/dark variants)
   
   ```typescript
   // New approach
   export const PRESET_COLORS = [
     'hsl(var(--preset-1))',  // Reference tokens
     'hsl(var(--preset-2))',
     // ...
   ] as const;
   ```

2. **Inline style cleanup**
   - KanbanHeader gradient: `linear-gradient(hsl(var(${props.color}) / 0.03), ...)` → convert to class or Tailwind
   - Color dot: `backgroundColor: 'hsl(var(${props.color}))'` → convert to CSS class
   - Find all `style={{}}` props with color values; convert to data-driven classes or Tailwind

   **Example refactor**:
   ```typescript
   // Before:
   style={{ backgroundColor: `hsl(var(${props.color}))` }}
   
   // After:
   className={`bg-[hsl(var(--color-${props.colorId}))]`}
   // or use CSS variable at component render:
   style={{ '--color-bg': `hsl(var(${props.color}))` } as any}
   className="bg-[color:var(--color-bg)]"
   ```

3. **Test dynamic colors**
   - Ensure project/tag colors still render dynamically
   - Verify light/dark mode contrast after refactor

**File changes**:
- `/packages/ui/src/components/KanbanBoard.tsx` — remove inline styles, use Tailwind
- `/packages/ui/src/components/` — any other inline style refs
- `/packages/web-core/src/shared/lib/colors.ts` — refactor PRESET_COLORS

###### Phase 4: Theme Variants & Design Density (5–7 days)
**Goal**: Multi-theme support; optional compact/dense mode.

1. **Light/Dark/Auto detection**
   - Current: CSS `.dark` class toggle via JS
   - Target: Enhance with system preference detection
   ```typescript
   useEffect(() => {
     const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
     if (localStorage.getItem('theme') === null) {
       document.documentElement.classList.toggle('dark', isDark);
     }
   }, []);
   ```

2. **Optional compact mode**
   - Add `.compact` class for denser spacing
   - Reduce padding, gap, margins by 25%
   - Smaller font sizes (text-xs, text-sm)
   - Useful for high-volume dashboards (kanban with 20+ columns)

   ```css
   .compact {
     --spacing-base: 0.5rem;  /* 8px instead of 16px */
   }
   ```

3. **Theme switcher UI**
   - Add settings panel with options: Light, Dark, Auto
   - Optional: Compact mode toggle
   - Persist to localStorage

**File changes**:
- `/packages/web-core/src/app/styles/new/index.css` — add .compact layer
- `/packages/local-web/src/components/ThemeSwitcher.tsx` — new component
- Settings dialog — integrate ThemeSwitcher

###### Phase 5: QA & Audit (3–5 days)
**Goal**: Ensure rebrand is complete, consistent, and accessible.

1. **Checklist**:
   - [ ] All brand colors updated (logo, buttons, links, accent)
   - [ ] Typography changed (font-family applied globally)
   - [ ] No hardcoded hex/HSL colors in component code (all use tokens)
   - [ ] Dark mode contrast ratios ≥4.5:1 (test with aXe)
   - [ ] Light mode contrast ratios ≥4.5:1
   - [ ] Drag-drop flow tested on mobile/tablet
   - [ ] Focus rings visible on all buttons, links, inputs
   - [ ] prefers-reduced-motion respected (animations off)
   - [ ] No broken images, missing icons, or layout shifts

2. **Automated audits**
   - Lighthouse Accessibility score ≥90
   - aXe DevTools: 0 critical/serious violations
   - WAVE browser extension: 0 errors, 0 contrast fails

3. **Manual testing**
   - Keyboard-only navigation (Tab, Shift+Tab, Enter, Space, Esc)
   - Screen reader (NVDA, JAWS, or macOS VoiceOver)
   - Mobile (iOS Safari, Android Chrome) with accessibility inspector
   - Reduced motion: toggle in OS settings, verify animations off

**File changes**:
- `/docs/REBRAND_CHECKLIST.md` — test plan
- `/docs/REBRAND_REPORT.md` — results and sign-off"


---

## 8. Theming / rebrand implementation plan

**Principle: rebrand by swapping *tokens*, never by forking components.** The audit confirms class-based dark mode with `hsl(var(--token))` indirection (`packages/web-core/src/app/styles/new/index.css`) consumed via Tailwind (`packages/local-web/tailwind.new.config.js`) — a sound base. The blocker is the **hardcoded colors/shadows** (§1.5) that bypass tokens.

**Sequence:**
1. **Tokenize the escapees first (P0).** Replace every hardcoded color/shadow/radius from §1.5 (inline `hsl()` in `KanbanBadge`/`StatusDot`/`IssueTagsRow`, arbitrary `shadow-[…]` in `ContextBar`/`BulkActionBar`, diff-tooltip hex, `GoogleLogo` hexes) with semantic CSS vars (§3). A rebrand cannot be complete until this is done.
2. **Two-layer token model (§3/§4).** Primitive ramp (`--c-*`) → semantic aliases (`--brand`, `--text-*`, `--surface-*`). Components reference *only* semantic tokens; a brand = a values file for primitives + semantic mapping.
3. **Drop in the brand slots (§2):** swap primitive brand ramp + neutrals, set fonts (replace IBM Plex `@import`), swap logo/favicon/app-icon, set radius/density/motion. No component edits.
4. **Theme registry:** `:root`/`.dark` + optional brand/high-contrast classes, switched at `ThemeProvider`.
5. **Verify:** contrast gate (§7) on the new palette incl. the 5 tier colors in both modes; visual-regression across the §1.3 screen inventory.


---

## 9. Gap analysis & prioritized design backlog

### 9.1 Gap summary (126 distinct)

- No formal semantic token naming convention; tokens use prefix-based (--text-, --bg-) without STATE/CONTEXT suffixes
- Mobile typography scaling via runtime --mobile-font-scale variable instead of breakpoint-specific token variants
- Shadow system lacks elevation terminology; only hardcoded arbitrary values (shadow-[...]) in components, no shadow scale tokens
- Border radius multiplier (0.25) is implicit; no sm/md/lg scale tokens in CSS, only in Tailwind config
- No focus ring / focus-visible design tokens; focus-border and separator-border defined as single values without state variants
- Color space documentation missing; unclear if HSL conversion to sRGB linear is intended for consistency across platforms
- Syntax highlighting colors exist only in light/dark mode pairs; no high-contrast or colorblind-friendly theme variants
- WCAG contrast ratios not documented for color pairs; no automated validation that new tokens meet AA/AAA
- No animation documentation; keyframes defined in Tailwind config without motion curves/duration conventions
- Google Logo hardcoded hex values (#EA4335, #4285F4, #FBBC05, #34A853) not mapped to design tokens
- Diff viewer styles hardcoded (#555555, #ffffff tooltips) instead of referencing theme tokens
- Console/terminal colors exist but isolated to CSS vars, no unified color system with other UI components
- No design token versioning or deprecation policy
- Mobile safe-area background colors hardcoded (#f2f2f2, #212121) instead of using token system
- Arbitrary Tailwind values (rounded-[2rem], shadow-[...]) bypass token system, create design debt
- No component state matrix documenting disabled/hover/active/focus-visible styles for design consistency
- Opacity utilities use magic numbers (0, 40, 50, 100) instead of semantic names (disabled=40%, highlight=50%)
- No token consumption guidelines; components use both Tailwind classes, CSS vars, and dynamic hsl() strings inconsistently
- Allotment library integration uses custom CSS vars (--separator-border, --focus-border) not exposed in main theme
- No design system documentation site or reference; token meanings inferred from code only
- Missing active/pressed state styling on all buttons (scale, opacity, or background shift)
- Loading state absent from Button, Input, Dialog (no spinner variant or aria-busy pattern)
- Error state not implemented on Input (no border-error, ring-error, or aria-invalid)
- Indeterminate checkbox state missing (partial selection UI pattern)
- Focus ring inconsistency: Button uses ring-1 ring-ring/40, Dialog uses ring-2 ring-brand, Dropdown varies
- Z-index system hardcoded in 6+ locations (z-[10000], z-[9998], z-[9999], z-[10001]) instead of centralized scale
- Shadow/elevation system incomplete: only shadow-md used, no shadow-xs/sm/lg/xl variants defined
- 27+ inline style instances with hardcoded layout values (padding, height, width) bypassing token system
- Opacity scale not tokenized: hardcoded opacity-50, opacity-70, opacity-80, /10, /40, /50 suffixes in various states
- Animation timing not centralized: Radix animations use fixed durations (200ms, 300ms) without token variables
- Prefers-reduced-motion coverage ~5%: only 2 components guard animations; 95% of transitions lack motion sensitivity
- ARIA attributes sparse: missing aria-invalid on Input error, aria-busy on loading states, aria-modal/aria-labelledby on Dialog
- Keyboard shortcut hints in Tooltip not visually prominent (kbd element buried in content, no space)
- No semantic color tokens for status/tag colors: KanbanBadge, StatusDot, IssueTagsRow use dynamic HSL injection (7 instances)
- Card component lacks variant system (no elevated/outlined/filled variants common in design systems)
- Button hover states incomplete on ghost variant (uses text-primary-foreground/50 instead of bg shift)
- Color-alone indicators violate WCAG AA pattern requirement: StatusDot, KanbanBadge need icon/pattern fallback
- Screen reader coverage: sr-only used sparingly; tooltips, icon buttons, spinners lack aria-label/aria-hidden
- Contrast verification absent: text-high/normal/low tokens defined but no WCAG AA/AAA validation documented
- No Tailwind breakpoint utilities (sm:/md:/lg:/xl:) — responsive design relies entirely on JS hooks; design team cannot use standard responsive modifiers
- Hardcoded syntax highlighting colors (12 hex values in light mode, 12 in dark) — not tokenized, prevents design system consistency for code display
- VSCode injection variables (--vscode-editor-background, --vscode-button-background, etc.) create design system dependency on editor theme; no fallback-only design spec
- No high-contrast mode or accessibility-focused color palette
- No explicit WCAG AA/AAA contrast ratio verification in design tokens
- Missing prefers-reduced-motion: reduce support for animations (8 keyframe animations defined but not gated)
- No Figma-to-code token sync system (design tokens hardcoded in config, manual update cycle)
- No component skeleton/placeholder states for data loading (only generic LoadingState with spinner)
- Missing tablet breakpoint hook (useMedium, useLarge) — 3-tier responsive strategy not implemented
- No explicit design spec for kanban column widths, card sizes, or layout constraints on different screen sizes
- Icon sizes derived from formula (base × multiplier 1.25) instead of discrete scale — icon-lg is 1.40625rem (22.5px), odd value for pixel-perfect design
- No skip-to-content link or focus management patterns documented
- Border radius uses fractional multiplier (0.25) — values like md (3.28125px) are unusual; should be round numbers (4px, 8px, etc.)
- No color-blind safe palette verification (rely on brand orange 25° + status colors without simulation check)
- Chat max-width hardcoded (48rem) — not composable for different screen sizes or content widths
- Spacing scale uses unusual increments (half=4px, base=8px, plusfifty=12px, double=16px) — no 24px, 32px, 48px gaps for larger layouts
- Missing definition of `gap-base` spacing token in Tailwind config; used throughout KanbanBoard, Navbar, CommandBar, AppBar but value undefined
- No explicit width specification for AppBar sidebar (inferred as 56px or 80px); not standardized in design tokens
- No explicit height/padding spec for navbar; using inferred values from component classes
- Border-radius token `--_radius: 0.125rem` appears incorrect (0.5px instead of standard 0.5rem); creates inconsistency with shadcn/ui defaults
- Spacing scale incomplete: `p-half`, `p-base`, `py-half`, `px-base` used but not explicitly defined in Tailwind config
- Missing multi-select checkbox styling specifications (size, color, focus state)
- No specification for drag-drop target zone highlight (currently relying on @hello-pangea/dnd snapshot state only)
- Missing active/focused states for sidebar buttons and navbar items (only hover and base states documented)
- No explicit mobile/responsive breakpoints defined for navbar/sidebar layout transitions
- Workspace sidebar preview animation timing/easing not parameterized; hardcoded 150ms ease-out
- No specifications for empty states (kanban with no issues, no projects, no workspaces)
- Missing focus-visible ring specifications (currently using brand color but no size/offset parameters)
- No a11y specifications for keyboard navigation focus order and tab traps within modals/panels
- Command bar keyboard shortcut display format not standardized (currently uses component prop but design not specified)
- Status dot colors in command bar tied to issue status colors but no explicit design for closed/completed states
- No Session-level ExecutionProcess view showing running agent status, turn count, approval gate, or linked PR/issue
- No Logs panel surface for viewing agent stderr, tool outputs, errors, or execution transcript
- No visual distinction between review states (awaiting_review, changes_requested, approved, denied) in approval cards or diff headers
- No execution state indicators on conversation entries (running spinner, pending approval clock, error badge) — only streaming text
- No approval action buttons (Approve, Request Changes, Deny) visible in ChatApprovalCard; integration point unclear
- No virtualized rendering for large diffs in pr-comment-card DiffHunk preview (max-h-32 with scroll only)
- No PR review state field visualization on embedded PR comments — comment_type is 'general' or 'review' but no review_state (awaiting_review, changes_requested, approved) shown
- No preview iframe loading/error state indication in PreviewBrowser — only spinner and text
- No conversation-level agent-is-running indicator or turn counter visible in workspace-chat
- Missing semantic tokens for diff colors, review states, and execution states — all hardcoded as Tailwind classes or inline HSL
- No tier *selector/editor* surface on issue detail (TierPicker, #105 — pending). NOTE (M1, post-audit): the complexity-tier read-only BADGE and the kanban tier FILTER (#104) ARE built and shipped — flag-gated behind `useFlag('tiers')` (off by default). `complexity_tier` is referenced in `packages/ui/src/components/KanbanCardContent.tsx` (TIER_BADGE, all 5 tiers), `KanbanContainer.tsx`, `KanbanFiltersDialog.tsx`, and `useKanbanFilters.ts`. Only the tier *edit* control is still missing.
- No agent-as-assignee picker; no Agent entity in the *frontend/UI* code (the backend Agent entity exists in `crates/db/src/models/agent.rs` and is used by the assignment engine, but is not surfaced in any UI — agent UI #106 deferred to M3)
- PM-assistant chat panel exists as an INERT flag-gated scaffold only (`pm_assistant` flag, off by default — chrome + empty state + disabled composer). No orchestration surface and no websocket/polling implementation (M3)
- No GitHub PR status widget; no review_state field or PR linkage visible in issue detail
- No guest propose-only restricted view; role-based issue creation gating not implemented
- No sprint management UI; sprint entity exists in PRD but no screens observed
- No org-level Anthropic API key settings dialog; required for Phase 3 PM-assistant
- No feature-flag *toggle UI* in settings for tier/agent/GitHub/guest features. NOTE: the flag *system* (`flags.ts`, FLAG_NAMES, `resolveFlags`/`useFlag`, all default off) is built and already gates shipped surfaces (#104 tiers badge/filter, pm_assistant scaffold)
- OAuthButton hardcoded hex colors (#dadce0, #f2f2f2, #1f1f1f) instead of using brand tokens; not in UI library
- Tier complexity IS displayed on the kanban card via the #104 badge (flag-gated 'tiers', off by default); a tier *selector* on issue detail is still missing (TierPicker #105, pending)
- No agent availability status indicator (online/offline/busy); no agent avatar component system
- No review-driven state-transition UI for ready_for_development state
- No tier-source indicator (manual vs assistant-recommended) on issues
- No role-based UI filtering for guest users; no conditional render patterns for guest restrictions
- No search/autocomplete in agent picker or GitHub PR link modal
- LoginPage + InvitationPage lack register/verify/reset flows for self-hosted auth
- Settings modal missing org-level sections: API Keys, Feature Flags, Member Permissions (Guest role)
- Settings modal missing project-level sections: Sprint Management, Tier Policy, GitHub Integration config
- Explicit elevation/shadow scale not defined in current system (relies on Tailwind defaults)
- Complexity tier color pairs missing—no accessible fg/bg pairs mapped to basic/low/medium/hard/ultra tiers
- Motion/animation scale lacks formalized standards (individual keyframes exist but no timing/easing system documented)
- Remote-web tailwind.config.cjs has no theme extension—design tokens not applied to cloud app consistently
- Letter spacing not standardized across typography scale
- Reduced motion preferences not consistently applied to all animations (only partially in index.css line 438)
- No explicit CSS variable naming convention documented (current: --_internal, --public but inconsistent)
- Dark mode color adjustments for brand tier incomplete (primary 200-500 tints not defined)
- Spacing tokens not extracted (hardcoded Tailwind: p-6, px-3, py-2, space-y-1.5, gap-2, min-h-[80px], w-72)
- No explicit component state variants (disabled, hover, focus-visible, active, loading, error, selected) — embedded in class strings rather than extracted as Tailwind utilities or CVA compound variants
- Tailwind config has no theme layer with token references; only content paths defined
- Theme switching hardcoded to .dark class mode; no support for data-theme attribute or multi-brand runtime swapping
- Brand colors embedded in CSS; no brand layer for swapping primary color without editing styles
- Custom Tailwind utilities undefined in config (p-base, py-half, size-icon-base appear in components but not in config)
- Z-index values hardcoded (z-[9998], z-[9999], z-[10000]); no centralized z-stacking strategy
- Animation classes hardcoded (animate-in, fade-in-0, zoom-in-95, slide-in-from-top-2, etc.); no token definitions
- No component variant documentation exportable for design tools (Figma, Sketch, etc.)
- Input focus ring offset applied inline (ring-offset-2) rather than tokenized
- No explicit WCAG 2.2 AA contrast matrix documented; status color contrast insufficient in light/dark modes (Success 1.3:1, Warning/Info require separate -text/-bg variants)
- Focus ring insufficient (40% opacity 1px ring); needs 2px double-ring pattern and high-contrast mode support
- Missing aria-live regions for drag-drop notifications and form validation errors
- No aria-describedby on inputs; no aria-invalid, aria-required semantic markup
- KanbanBoard layout not responsive (fixed grid-flow-col; no mobile single-column mode); drag handle too small for touch (16x16px vs 44x44px target)
- xs button size 32px; below 44px WCAG touch target recommendation
- Chat-box-running animation lacks prefers-reduced-motion support; global transition-colors class ignores reduced motion
- Hardcoded inline styles for KanbanHeader gradient and color dot; PRESET_COLORS HSL values not theme-aware
- No skip link or focus trap verification; disabled buttons use opacity-only, not semantic aria-disabled
- No design tokens abstraction for typography, border-radius, or dynamic color palette rebranding

### 9.2 Prioritized backlog (149 items)

`Design-Foundation` = design-system groundwork (prereq to feature theming). Effort S/M/L/XL.


#### P0 (39)

| Item | Area | Milestone | Effort |
|---|---|---|---|
| Define and document WCAG AA/AAA contrast matrix for all color pairs (text, background, border, focus) | a11y | Design-Foundation | M |
| Define WCAG AA contrast ratio minimums and audit all semantic color pairs | a11y | Design-Foundation | M |
| Audit & update contrast ratios for all semantic colors (light/dark modes) | a11y | Design-Foundation | S |
| Enhance focus ring: 2px double-ring with high-contrast mode support | a11y | Design-Foundation | S |
| Add keyboard handlers (Space/Enter) to all role='button' divs | a11y | Design-Foundation | M |
| Implement prefers-reduced-motion globally; add @media wrapper to all animations | a11y | Design-Foundation | S |
| Document contrast matrix for all semantic colors (light/dark, AA/AAA) | a11y | Design-Foundation | S |
| Run automated a11y audits (Lighthouse, aXe, WAVE); document baseline scores | a11y | Design-Foundation | S |
| Manual keyboard-only & screen-reader smoke test; document results | a11y | Design-Foundation | M |
| Refactor KanbanBadge to Use Semantic Status Color Tokens | components | Design-Foundation | M |
| Extract OAuthButton to @vibe/ui library with brand token colors | components | Design-Foundation | M |
| Extract all component state variants (hover/focus/active/disabled/error/loading/selected) into explicit CVA compound variants across all 18 core components | components | Design-Foundation | L |
| Create Figma design system with exported color, spacing, typography, radius tokens | new-feature | Design-Foundation | XL |
| Create dark mode color palette for brand tier (primary 200-500 tints) | theming | Design-Foundation | S |
| Create Tailwind config theme layer with semantic token references (colors: background, foreground, card, primary, secondary, destructive, border, input, ring; spacing; radius; zIndex; animation) | theming | Design-Foundation | M |
| Replace .dark class mode with data-theme attribute (HTML) + CSS custom property for multi-brand/attribute-based theme support | theming | Design-Foundation | M |
| Create formal semantic token naming convention and taxonomy document | tokens | Design-Foundation | M |
| Build token consumption audit: inventory all {inline-hsl, hardcoded-hex, arbitrary-tw} values and prioritize migration | tokens | Design-Foundation | L |
| Establish design token source of truth: JSON/YAML schema with validation + build pipeline → CSS custom properties | tokens | Design-Foundation | L |
| Build token auto-generation pipeline from source to CSS custom properties + Tailwind config | tokens | Design-Foundation | L |
| Establish color space specification (HSL, sRGB, or linear sRGB) + document conversion assumptions | tokens | Design-Foundation | S |
| Implement Z-Index System | tokens | Design-Foundation | M |
| Create Complete Shadow/Elevation System | tokens | Design-Foundation | M |
| Remove Inline Styles and Use Spacing Tokens Throughout | tokens | Design-Foundation | L |
| Define and deploy spacing token system in Tailwind config | tokens | Design-Foundation | S |
| Create comprehensive color token map with HSL values for light/dark themes | tokens | Design-Foundation | M |
| Fix border-radius token value (0.125rem → 0.5rem) and verify shadcn/ui alignment | tokens | Design-Foundation | S |
| Define complete design token system for diff, review, and execution states | tokens | Design-Foundation | M |
| Define complexity tier color tokens (basic/low/medium/hard/ultra) | tokens | Design-Foundation | S |
| Define Tailwind config theme extension with all tier/agent/role colors | tokens | Design-Foundation | M |
| Implement elevation/shadow scale CSS variables | tokens | Design-Foundation | S |
| Define and document complexity tier color pairs for all 5 tiers (basic/low/medium/hard/ultra) | tokens | Design-Foundation | M |
| Define spacing token scale (4–64px in 4px increments) and export to Tailwind extend.spacing | tokens | Design-Foundation | S |
| Extend tailwind.config.cjs with semantic color theme tokens (primary, secondary, status colors) | tokens | Design-Foundation | M |
| Create kanban tier/complexity badge component spec and styling | components | M3-PM-Assistant | M |
| Implement complexity-tier selector on issue detail sidebar | flows | M3-PM-Assistant | M |
| Add org-level API key settings section (Anthropic key input + test) | flows | M3-PM-Assistant | M |
| Add agent-as-assignee picker (modal + dropdown with search) | new-feature | M3-PM-Assistant | L |
| Design and spec PM-assistant chat panel (sidebar + bottom drawer) | new-feature | M3-PM-Assistant | L |

#### P1 (74)

| Item | Area | Milestone | Effort |
|---|---|---|---|
| Establish focus-visible design tokens and document keyboard navigation + tab order conventions | a11y | Design-Foundation | M |
| Add @media prefers-reduced-motion to all animations + motion preference enforcement in JS | a11y | Design-Foundation | M |
| Standardize Focus Ring System Across All Components | a11y | Design-Foundation | M |
| Add prefers-reduced-motion Guards to All Animations | a11y | Design-Foundation | M |
| Implement Dialog ARIA Attributes and Focus Management | a11y | Design-Foundation | M |
| Implement prefers-reduced-motion support for all animations (8 keyframes) | a11y | Design-Foundation | S |
| Implement focus ring/keyboard navigation indicators on all interactive elements | a11y | Design-Foundation | M |
| Add reduced-motion support to all keyframe animations | a11y | Design-Foundation | M |
| Generate accessible contrast pair testing matrix (WCAG AA/AAA) for all complexity tiers | a11y | Design-Foundation | M |
| Add aria-live regions for drag-drop and form validation feedback | a11y | Design-Foundation | M |
| Add skip link and focus trap verification to main layout & dialogs | a11y | Design-Foundation | S |
| Migrate Google Logo hardcoded colors to brand token references | branding | Design-Foundation | S |
| Define and document brand layer (primitive token overrides per brand: primary color, secondary color, accent, logo URL, typography scale) | branding | Design-Foundation | M |
| Create BrandLogo component with dynamic color slot for rebranding | branding | Design-Foundation | M |
| Define component state matrix for all interactive patterns (disabled, hover, active, focus-visible, pressed) | components | Design-Foundation | L |
| Add Loading and Error States to Button Component | components | Design-Foundation | M |
| Implement Error State and aria-invalid on Input Component | components | Design-Foundation | M |
| Add Indeterminate State to Checkbox Component | components | Design-Foundation | S |
| Build component states library (loading, error, disabled, focus, hover, active for all base components) | components | Design-Foundation | L |
| Refactor AppBar sidebar width and padding into design tokens | components | Design-Foundation | M |
| Specify navbar height, padding, and breakpoint transitions for responsive layout | components | Design-Foundation | M |
| Standardize card component with variant system (default, dragging, selected, loading) | components | Design-Foundation | L |
| Extend remote-web Tailwind config to include full theme from local-web | components | Design-Foundation | S |
| Create component variant spec document (state matrix table for all 18 components: default/hover/focus/active/disabled/loading/error states) | components | Design-Foundation | M |
| Create InputField component wrapper with aria-describedby, aria-invalid, aria-required | components | Design-Foundation | M |
| Create motion curves library + document animation durations + audit @media prefers-reduced-motion coverage | flows | Design-Foundation | M |
| Document responsive grid system (12-column desktop, 4-column tablet, 2-column mobile) | ia | Design-Foundation | S |
| Document all responsive behavior patterns for design team (mobile-first approach, breakpoint cutoffs) | ia | Design-Foundation | S |
| Build token-to-Figma sync pipeline (design tokens as single source of truth) | new-feature | Design-Foundation | XL |
| Create Tailwind breakpoint utilities (sm, md, lg, xl) and remove useIsMobile() dependency | responsive | Design-Foundation | L |
| Specify mobile-responsive navbar/sidebar layout transitions and breakpoints | responsive | Design-Foundation | M |
| Increase minimum button heights to 44px (xs: 32px → 44px); add touch padding on mobile | responsive | Design-Foundation | M |
| Refactor PierreConversationDiff to use CSS custom properties instead of hardcoded HSL values | theming | Design-Foundation | L |
| Refactor pr-comment-card DiffHunk to use semantic diff color tokens instead of hardcoded Tailwind | theming | Design-Foundation | M |
| Audit and refactor LoginPage + InvitationPage inline styles to tokens | theming | Design-Foundation | M |
| Remove hardcoded inline styles in KanbanHeader & color dots; convert to Tailwind/CSS variables | theming | Design-Foundation | M |
| Refactor PRESET_COLORS to token-driven palette (move HSL values to CSS custom properties) | theming | Design-Foundation | S |
| Create shadow/elevation scale: define 5-7 depths with blur/spread/opacity formulas + remove arbitrary values | tokens | Design-Foundation | M |
| Formalize typography scale: define font weights, line-height ratios, letter-spacing per size + document mobile variants | tokens | Design-Foundation | M |
| Document design token versioning policy and breaking changes migration guide | tokens | Design-Foundation | S |
| Add Semantic Color Token System for Status and Tag Colors | tokens | Design-Foundation | L |
| Create Opacity/Transparency Scale Tokens | tokens | Design-Foundation | S |
| Extract and tokenize syntax highlighting colors into design system | tokens | Design-Foundation | M |
| Define focus-visible ring color, size, and offset parameters in tokens | tokens | Design-Foundation | S |
| Establish brand color variants (brand-05, brand-10, etc.) for semantic usage | tokens | Design-Foundation | S |
| Create motion/animation system with formalized timing functions and duration standards | tokens | Design-Foundation | M |
| Tokenize hardcoded mobile safe-area background colors | tokens | Design-Foundation | S |
| Audit and define all custom Tailwind utilities (p-base, py-half, size-icon-base, etc.) in tailwind.config.extend.spacing | tokens | Design-Foundation | S |
| Define z-index token scale (dropdown: 1000, sticky: 1020, modal-backdrop: 1040, modal: 1050, popover: 1060, tooltip: 1070) and replace hardcoded z-[...] with tokens | tokens | Design-Foundation | S |
| Add skip-to-content link to root layout for keyboard users | a11y | M1-Routing | S |
| Establish keyboard navigation and focus management specs for command bar modal | a11y | M1-Routing | M |
| Refactor KanbanBadge/StatusDot/IssueTagsRow components to use named tokens instead of dynamic HSL interpolation | components | M1-Routing | M |
| Audit and migrate diff viewer tooltip colors (#555555, #ffffff) to semantic tokens | components | M1-Routing | S |
| Create KanbanBoard drag-drop visual states spec with token-based styling | components | M1-Routing | M |
| Refactor command bar styling from inline styles to design token system | components | M1-Routing | M |
| Add approval state variants (awaiting_review, changes_requested, approved, denied) to ChatApprovalCard and ChatEntryContainer | components | M1-Routing | M |
| Create tier-selector component (button group + dropdown variants) | components | M1-Routing | M |
| Build agent-icon/avatar component system with availability status | components | M3-PM-Assistant | M |
| Add useMedium (1024px) and useLarge (1280px) hooks for 3-tier responsive design | responsive | M1-Routing | S |
| Refactor KanbanBoard to responsive single-column layout on mobile (<640px) | responsive | M1-Routing | L |
| Add Approve/Request Changes/Deny action buttons to approval workflow UI | components | M2-Team-Auth | L |
| Specify multi-select checkbox component with design tokens | components | M3-PM-Assistant | M |
| Add execution state indicators (running, pending_approval, success, error, denied) to conversation rows | components | M3-PM-Assistant | M |
| Create agent-is-running indicator and turn counter at conversation level | components | M3-PM-Assistant | M |
| Add feature-flag toggles in org settings (tiers, PM-assistant, GitHub, guest) | flows | M3-PM-Assistant | M |
| Create Storybook design system reference site with color swatches, typography specimens, component patterns | new-feature | M3-PM-Assistant | L |
| Create sprint management UI (list + CRUD forms) in project settings | new-feature | M3-PM-Assistant | L |
| Add review_state field visualization on embedded PR comments (awaiting_review, changes_requested, approved) | components | M4-GitHub-Automation | S |
| Build GitHub PR link/unlink modal with autocomplete search | flows | M4-GitHub-Automation | M |
| Implement auto-status-sync toggle and rules display | flows | M4-GitHub-Automation | M |
| Create ExecutionProcess view component showing running agent, turn count, approval gate, and linked PR/issue | new-feature | M4-GitHub-Automation | L |
| Build Logs panel surface for agent stderr, tool outputs, and execution transcript | new-feature | M4-GitHub-Automation | L |
| Design GitHub PR status widget with review-state badges | new-feature | M4-GitHub-Automation | L |
| Add review-state color tokens (draft/open/approved/changes-requested/merged) | tokens | M4-GitHub-Automation | S |

#### P2 (36)

| Item | Area | Milestone | Effort |
|---|---|---|---|
| Add Screen Reader Labels to Icon Buttons and Tooltips | a11y | Design-Foundation | M |
| Verify WCAG AA/AAA Contrast for Text Color Tokens | a11y | Design-Foundation | M |
| Create brand spec document + Figma component library export strategy (component variants, state matrix, token mapping for design tool) | branding | Design-Foundation | L |
| Add Variant System to Card Component | components | Design-Foundation | M |
| Audit and Document Icon Library Strategy (Phosphor vs Lucide) | components | Design-Foundation | S |
| Add Active/Pressed State Visual Feedback to Button Component | components | Design-Foundation | S |
| Create skeleton/placeholder loading states for kanban, issues, and projects lists | components | Design-Foundation | M |
| Create navbar action visibility and focus state specifications | components | Design-Foundation | M |
| Create workspace sidebar overlay animation and positioning spec | components | Design-Foundation | S |
| Add preview iframe loading/error state visualization in PreviewBrowser | components | Design-Foundation | S |
| Document CSS variable naming convention (internal vs public tokens) | ia | Design-Foundation | S |
| Responsive typography: scale text sizes down on mobile; test readability | responsive | Design-Foundation | S |
| Establish syntax highlighting theme variants (GitHub light/dark, Monokai, Solarized) mapped to token system | theming | Design-Foundation | L |
| Create color-blind safe palette with LightHouse/WCAG verification | theming | Design-Foundation | M |
| Implement theme switcher UI with light/dark/auto + optional compact mode toggle | theming | Design-Foundation | M |
| Centralize Animation Timing as CSS Variables | tokens | Design-Foundation | S |
| Replace hardcoded VSCode injection variables with design-system-only fallbacks | tokens | Design-Foundation | M |
| Standardize spacing scale to round numbers (4, 8, 12, 16, 24, 32, 48, 64px) | tokens | Design-Foundation | M |
| Update icon size scale to discrete pixel values (16, 20, 24, 28, 32, 36px) | tokens | Design-Foundation | S |
| Standardize letter spacing across typography scale | tokens | Design-Foundation | S |
| Define animation token library (duration: 100ms/200ms/300ms, easing: ease-in/ease-out) and replace hardcoded animate-in/fade-in-0/zoom-in-95 with semantic utilities | tokens | Design-Foundation | M |
| Refactor PreviewBrowser arbitrary border-radius values to named tokens | components | M1-Routing | S |
| Create drag-drop target zone highlight visual spec for kanban columns | components | M1-Routing | S |
| Define filter bar and sort menu styling with token system | components | M1-Routing | M |
| Define empty state screens for kanban, project list, workspace list | new-feature | M1-Routing | M |
| Migrate mobile safe-area background colors from hardcoded hex to responsive token variants | responsive | M1-Routing | S |
| Establish semantic opacity scale (disabled=40%, highlight=50%) and replace magic numbers in components | tokens | M1-Routing | M |
| Refactor host status indicator colors to semantic token system | components | M2-Team-Auth | S |
| Create high-contrast and colorblind-friendly theme variants as named CSS class sets | theming | M2-Team-Auth | L |
| Implement virtualized diff rendering for pr-comment-card DiffHunk preview | components | M3-PM-Assistant | M |
| Unify ANSI/console colors with UI status palette + ensure same tokens used | tokens | M4-GitHub-Automation | M |
| Create role-based access control utility (useRoleCheck hook + hasRole helper) | components | M5-External-Sandbox | S |
| Implement role-based UI filtering for guest users (list/detail read-only) | flows | M5-External-Sandbox | L |
| Add guest role to member permissions settings table | flows | M5-External-Sandbox | M |
| Create guest propose-only issue creation modal | new-feature | M5-External-Sandbox | L |
| Add visual regression testing integration (Chromatic/Percy) with design token change detection | tokens | M5-External-Sandbox | M |


---

## 10. Open questions for the brand / design team (79)

- Should color space conversion (HSL → sRGB → linear sRGB) be automatic or manual? Current code uses HSL directly without documented assumptions.
- What is the desired token naming convention priority: brevity (current --text-high) vs explicitness (color-text-primary-interactive-state)?
- Should component state matrix be enforced via design tokens or CSS class generators? Current implementation mixes semantic tokens + arbitrary Tailwind.
- How should dynamic color picker output be normalized: as token names, as HSL tuples for semantic interpolation, or as validated hex values?
- Is the --mobile-font-scale runtime variable intentional for fluid scaling, or should mobile typography use breakpoint-specific token variants?
- Should diff viewer use VS Code theme vars (--vscode-editor-background) or Tasca theme tokens? Currently uses both without clear priority.
- Are Google Logo brand colors intentionally brand-specific (#EA4335, #4285F4, #FBBC05, #34A853) or should they use Tasca brand palette?
- Should Allotment library (--separator-border, --focus-border) be integrated into main theme token system or kept isolated?
- What is the accessibility testing/validation strategy: automated scans (axe-core), manual WCAG checklist, or both + what is the pass threshold?
- Should theme switching persist to localStorage/IndexedDB and restore on reload, or reset to system preference each session?
- How should color blindness variants (deuteranopia, protanopia, tritanopia) be generated: algorithmic shift or hand-curated palettes?
- Should hardcoded arbitrary Tailwind values (shadow-[...], rounded-[...]) be banned via linter or allowed with design review gate?
- Is VS Code integration (--vscode-editor-background overrides) a permanent feature or migration target to pure Tasca tokens?
- Should phosphor icons and lucide icons coexist indefinitely, or migrate all to one library? (Currently 19 files use phosphor, 2 use lucide)
- What is the intended behavior for Button ghost variant hover state? (Current: text-primary-foreground/50, inconsistent with other variants)
- Are Dropdown menu items supposed to have a selected state visually distinct from focus state? (Currently uses same bg-secondary for both)
- Should Card have elevated/outlined/filled variants like Material Design, or remain minimal layout component?
- How should color be validated in KanbanBadge, StatusDot, etc. at runtime? (Currently accepts arbitrary HSL without schema)
- Is the 29px CTA height (h-cta) intentional or legacy from Vibe Kanban? (Does not align with 4px base scale)
- Should all focus rings be 2px ring-ring, or allow variant-specific ring colors per component? (Currently inconsistent)
- Do loading spinners need aria-label or aria-hidden? (Current: neither specified)
- Should animation timing be synchronized with Tailwind's standard durations (150/300/500ms) or keep custom 200/300?
- Which components require keyboard shortcut hints in tooltips vs inline labels? (Currently only Tooltip kbd, not discoverable)
- What are the intended kanban column widths on mobile vs. desktop? Currently resizable but no design spec.
- Should border-radius use discrete pixel values (4px, 8px) instead of multiplier (0.28125rem)? Current values are fractional.
- Is VSCode theme injection a permanent requirement or temporary for the local-web app? This blocks design-system-only spec.
- Should syntax highlighting use CSS custom properties for light/dark parity, or remain hardcoded hex colors?
- What is the intended tablet layout for workspaces/projects? Currently jumps from mobile (single-column) to desktop (multi-panel) at 767px.
- Is the 767px mobile breakpoint intentional (iPad Mini width) or should it align with Tailwind defaults (640px for sm)?
- Should chat width (48rem / 768px) be responsive or stay fixed on all screens?
- How should loading/skeleton states animate? Currently static spinner with text, but kanban cards need placeholder skeletons.
- What is the intended keyboard shortcut discoverability pattern for mobile users? Currently only modal help dialog.
- Should focus rings use the brand color (hsl(var(--brand))) or a neutral contrast color per WCAG AAA?
- What is the intended fixed width or responsive behavior for AppBar sidebar on desktop (currently inferred as 56-80px)? Should it support collapse/expand animation?
- Should the workspace sidebar preview be a persistent interaction pattern or mobile-only feature? Current design constrains it to hover overlay, blocking discoverability on mobile.
- How should drag-drop target zones (columns in kanban) be visualized? Currently relies on browser drag event styling; need explicit highlight color and border specification.
- What are the exact breakpoints for mobile/tablet/desktop layout transitions? CSS only shows max-width: 767px for mobile; need specifications for tablet/desktop viewport ranges.
- Should multi-select bulk actions be visible always, only on selection, or behind a toggle button? Current design omits visibility spec.
- How should the kanban board handle empty states (no issues, no columns, no statuses)? Need designs for onboarding, uninitialized, and error scenarios.
- Should the command bar support nested pages (breadcrumb navigation) or only flat list? Current implementation supports pages but no visual spec for back button styling.
- What is the intended behavior for focus-visible styling on all interactive elements? Should rings be 2px (current) or variable by component type?
- Should status/priority colors be consistent across kanban cards, command bar, navbar, and filter pills, or support variants per context? Current code mixes inline and Tailwind approaches.
- Are there performance/UX implications for the workspace sidebar preview animation (150ms)? Should this be user-configurable via accessibility settings?
- Where is the approval action handler (Approve/Request Changes/Deny button logic) currently implemented? ChatApprovalCard only renders content via callback, not actions.
- How is review_state (awaiting_review, changes_requested, approved) from GitHub API currently stored and passed to conversation entries? Should it be on NormalizedComment or separate metadata?
- Does PR↔ticket linkage show inline on approval cards (e.g., 'Linked to Issue #42'), or is that handled at workspace level?
- What is the intended UX for aggregated approval (e.g., 5-file change where 2 approved, 3 pending) — single aggregate card or per-file approval states?
- Is the execution state (running/pending/error) intended to persist in the conversation (stored as field) or computed from linked PR/issue status?
- Where is the ticket/issue data model currently defined? Are complexity_tier, agent_id, and role_enum fields already in the schema, or must be added before UI implementation?
- Is the PM-assistant orchestration backend (websocket, message streaming, Anthropic API integration) already scoped/started, or does UI design need to wait for API contract definition?
- Does the GitHub integration API (PR fetch, review state webhooks, auto-sync rules) exist or need to be designed concurrently with the UI surface?
- What is the current authentication model for org-level settings (API key access)? Does SettingsDialog already support org-context switching, or must HomePage/workspace selection feed org ID to settings?
- Sprint entity is in PRD but no UI observed. Are sprints already in the data model? If so, where is the sprint selector currently exposed (issue detail dropdown, kanban column headers, or nowhere)?
- Is there a design spec for tier complexity breakpoints (agent capability matching)? E.g., does 'Ultra' tier require PM-assistant agent, or can a team member create Ultra issues manually?
- Are user roles (owner, admin, member, guest, PM-Assistant, Worker Agent) fully defined in the data model with permission matrices? Are system agents (PM-Assistant, Worker Agent) separate from user roles or special user records?
- What is the scope of 'guest propose-only'? Can guests comment on proposed issues before admin approval, or are they read-only until approval?
- Should tier-selector, agent-picker, and GitHub PR widget all be inline on issue detail, or should some be behind a 'More' menu or advanced panel on mobile?
- Is there a dark mode theming requirement? Tier/agent/review-state colors need both light and dark variants if so.
- Should brand color change hue in dark mode (current: same 25 82% across both modes) or maintain luminosity relationship only? Current approach (same hue) maintains brand consistency but may need luminosity boost for dark mode readability—recommend testing with design team.
- How should elevation/shadow respond to color contrast ratios? Current Tailwind shadows use fixed RGBA on all backgrounds—should shadows adapt per background color (primary/secondary/panel/brand) to maintain consistent depth perception?
- Are 5 complexity tiers (basic/low/medium/hard/ultra from PRD) meant to map to 5 distinct visual states (color + size + weight) or only to color pairs? If broader: need sizing/weight progressions too.
- Should motion animations disable completely under prefers-reduced-motion or reduce to instant (0.1s)? Current: mixed approach (line 438 disables some, others remain). Recommend: disable all except critical state changes.
- Is the 0.25 radius multiplier (current value from config line 13) locked in for all tiers, or should radius scale independently per complexity tier? Current: global 0.25 applied uniformly—consider per-tier values for visual differentiation.
- What is the target brand color palette beyond orange (--brand: 25 82% 54%)? Should secondary/hover/active variants be auto-derived via lightness shift or hand-tuned per brand?
- Are custom Tailwind utilities (p-base, py-half, size-icon-base) intentional design tokens or regression artifacts? Should they be defined in Tailwind config or removed in favor of standard Tailwind scales (e.g., px-2, py-1)?
- Should component state variants (disabled, loading, error) be exposed as React props or derived from HTML/Radix attributes? (e.g., <Button state='loading' /> vs. <Button disabled disabled-style='error' />)
- For tier-based components (status icon colors, priority indicators in CommandBar), do these need brand customization or should they remain fixed (error=red, success=green)?
- Should Tasca support dark-mode-specific brand colors (lighter orange on dark bg), or can dark variants be auto-derived via Tailwind's opacity modifiers?
- Is there a product analytics report on which component states are actually used? (e.g., Button loading-state is critical, but Checkbox error-state is never used)
- Should brand swapping happen at runtime (CSS var injection) or build-time (separate Tailwind theme files per brand + environment variable)?
- What is the Radix UI version lock strategy? Updating Radix may break hardcoded data-[...] selectors if DOM structure changes; should we pin version or refactor to semantic utilities?
- PRESET_COLORS palette: Should preset status colors remain hardcoded for random assignment, or should they reference theme-aware CSS tokens (e.g. hsl(var(--preset-1)))?
- Button xs size: Reduce to 32px, or raise minimum to 44px and deprecate xs variant? (touch target compliance vs. dense UI trade-off)
- Drag handle on mobile: Expand invisible touch target to 44x44px with padding, or increase visible icon size?
- Font family for rebrand: Committed to IBM Plex Sans, or open to change? (affects @import and global CSS)
- Compact mode: Worth implementing as design density toggle, or focus on responsive breakpoints only?
- Dark mode colors: Adjust existing tokens (success, warning, info) or create separate -text/-bg variants per light mode?
- Kanban single-column fallback: Use `flex flex-col lg:inline-grid` in JSX, or media query + CSS Grid?
- prefers-reduced-motion: Apply blanket animation: none, or disable only specific animations (chat-box-running, border-flash)?