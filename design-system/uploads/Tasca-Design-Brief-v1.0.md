# Tasca — Design Brief (v1.0, complete) · Platform UI + Marketing Site, from scratch

**For:** Claude Code (CC). **Scope:** Full visual + UX redesign of (A) the Tasca **platform application** and (B) the **marketing site**, from scratch, to match the pivoted product (see Tasca-PRD-v1.0-FINAL.md). **Owner:** Dennis.
**Companion doc:** the finalized PRD is the source of truth for *what the product does*; this brief is the source of truth for *how it looks and feels*. Where they conflict, raise it — don't silently reconcile.

> Process note: this is a **design brief**, not a build order. Produce a design system + high-fidelity screen designs (component-level, token-driven) for review BEFORE implementation. Same flow as prior milestones (architect → senior-swe → 9-agent panel → merge). No fake/seeded data in any screen — use real empty/loading/error states. WCAG AA is mandatory throughout (light + dark). Token-driven only — no hardcoded colors. No AI-attribution in any VCS artifact.

---

## PART A — FOUNDATION

### A1. What we're designing (product in one line)
A control plane for an **AI development workforce**: users build a roster of named AI "employees," give each a real identity inside Shortcut / GitHub / Linear, and Tasca's routing engine assigns the right agent to the right task across projects, 24/7.

### A2. Brand positioning & personality
- **Positioning:** *"Your AI dev team — named, capable, and working in the tools you already use."*
- **Personality:** confident, technical, calm. This is infrastructure for serious engineering teams (Fortune-500-grade clients are in scope), not a toy. Think "the operations console for a team you trust," not "fun AI gimmick."
- **Tone:** precise, plainspoken, a little dry. No hype words ("revolutionary," "magic"). The product's credibility is its restraint.
- **Emotional target:** the user should feel they're *managing a competent team*, with full visibility and control — never that work is happening in an opaque black box.

### A3. Core metaphor (drives the whole design)
**Agents are employees, not jobs.** Every design decision flows from this:
- Agents have **names, avatars, identities, capability profiles, and a work history** — like a team roster, not a task queue.
- The primary surface is **"your team"** (the roster), not a kanban board.
- Status language is human/team language: *idle, working, awaiting input, blocked, shipped* — not *queued, running, exit 0*.
- Avoid anthropomorphizing into cutesy territory — these are professional teammates (named, capable), not mascots.

### A4. Design principles (apply to every screen)
1. **Visibility over magic** — always show what each agent is doing, why it was routed there, and what it produced. The routing decision must be inspectable.
2. **Control is never more than one action away** — pause an agent, reassign, escalate, intervene. The human is always in command.
3. **Token-consistent, not decorative** — restrained, systematic, professional. Density appropriate to an ops console.
4. **Honest states** — real empty/loading/error/blocked states everywhere; never fake data, never a spinner with no fallback.
5. **Multi-vendor neutrality** — Claude, OpenAI, local models are all first-class; no vendor's branding dominates the UI. (Use neutral vendor indicators, not giant logos.)
6. **Accessible by construction** — WCAG AA contrast in both themes, keyboard-navigable, screen-reader landmarks, reduced-motion safe.

### A5. Existing assets — reuse vs. replace
- **Replace from scratch:** all kanban/board UI, the project-delivery screens, the old marketing pages. The product is no longer a kanban tool.
- **Reuse the engineering of the design system, redesign the look:** the prior token architecture (primitive → semantic → component tokens, light+dark, the HSL bridge, states.css/a11y) was sound *engineering*. Keep that **structure**; produce a **new visual identity** on top of it (new palette, type, components). Do not carry over the old visual language.
- **Carry over:** WCAG-AA discipline, token-driven approach, the no-fake-data state system, both-theme support.

---

## PART B — VISUAL LANGUAGE

> CC: propose concrete values for each below as the first deliverable (a `design-system/` foundation), then apply. Everything token-driven.

### B1. Logo & mark
- Design a new Tasca wordmark + mark fitting the "AI workforce control plane" identity. (Note: the live app currently still ships misnamed VK-derived favicon art — the new mark fully replaces all favicons/manifest/app icons.)
- Mark should read at 16px (favicon) through hero scale. Provide light/dark/maskable variants + full favicon/PWA manifest set.
- Direction: geometric, infrastructural, calm. Not a robot, not a speech bubble. Something that suggests *coordination / roster / routing* — restrained and ownable.

### B2. Color
- Define a full **primitive → semantic → component** token set, light + dark, all pairings **WCAG AA verified** (run the contrast check; rounding can cross the AA boundary — assert it).
- Required semantic families: surface scale, line/border, foreground scale (incl. muted), a **signal/brand accent**, plus **status colors** for agent states: idle (neutral), working (active/blue), awaiting-input (amber), blocked/failed (red), shipped/success (green).
- **Tier palette:** five distinct, accessible tier colors (basic → low → medium → hard → ultra) that read as an ordered ramp and are distinguishable for color-blind users (don't rely on hue alone — pair with label/shape).
- **Vendor indicators:** neutral, small, consistent treatment for Claude / OpenAI / local — no vendor's brand color dominating.

### B3. Typography
- Choose a technical, legible type system (one display/UI family + one mono for code/logs/IDs). Define the full type scale, weights, line-heights as tokens.
- Mono is load-bearing here (logs, diffs, IDs, tokens) — pick a strong mono and define its usage rules.

### B4. Spacing, radius, elevation, motion
- Token scales for spacing, radius, elevation (shadows/borders — favor borders over heavy shadows for the ops-console feel).
- Motion: subtle, functional, reduced-motion-safe. State transitions (agent idle→working) should be perceptible but not animated theater.

### B5. Iconography
- Consistent icon set (line style recommended). Define icons for: agent states, tiers, the three platforms (Shortcut/GitHub/Linear), vendors, routing, escalation, PR, repo, project.

---

## PART C — PLATFORM APPLICATION (screen by screen)

> Design every surface below in high fidelity, light + dark, with real empty/loading/error states. These are the surfaces the pivoted product needs; the old kanban screens are gone.

### C1. Onboarding / first-run
- Account creation (OAuth — GitHub/Google), then a guided first-run: connect your first platform (Shortcut), create your first agent, deploy it.
- Empty-state-first: a brand-new account has no agents, no connected tools — design that state as a welcoming "build your team" flow, not a blank screen.

### C2. The Roster (primary surface — "Your Team")
- The home screen. A roster of named agents shown as **team members**, not rows in a queue.
- Per agent card: avatar, name, vendor indicator, capability tiers covered, current state (idle/working/awaiting-input/blocked), current task (if any), today's throughput, success rate, cost.
- Roster-level: add agent, filter by state/platform/tier, overall team health summary.
- States: empty (no agents yet → "hire your first agent"), loading, error.

### C3. Agent detail / profile
- The "employee profile": identity bindings (its Shortcut agent user, GitHub App, Linear app user — show which platforms it's deployed into), capability profile (tiers, language/framework specialties, max tier, concurrency limit, cost ceiling), performance history (success rate over time, tasks shipped, escalations), and current/recent work.
- Controls: pause/resume, edit capability profile, deploy into a new project/tool, retire.

### C4. Agent creation / configuration
- Create a named agent: name, avatar, vendor (Claude/OpenAI/BYO-local with model picker for Ollama/LM Studio/MLX), capability profile, concurrency + cost limits.
- Deploy flow: connect/select the platform(s) and project(s)/repo(s) this agent works in; provision its native identity (Shortcut agent user / GitHub App install / Linear actor=app) — design the per-platform install/consent steps.

### C5. Task / work detail + routing inspector
- For a given task: which agent it routed to and **why** (the routing decision — estimated tier, eligible agents, the match). The routing decision must be **inspectable** (principle #1).
- Live work view: the agent's current activity, logs (mono), the worktree/branch, the PR link + CI checks, and intervention controls (interrupt, reassign, escalate).
- The escalation path visible: if an agent failed/mis-tiered, show the breaker tripping and the re-tier/human-review handoff.

### C6. Routing & monitoring dashboard
- Cross-roster operational view: what's in flight, queued, blocked, awaiting input; throughput; cost burn; escalations. The "mission control" for the workforce.
- Honest states: a quiet day (little in flight) should look calm and intentional, not broken/empty.

### C7. Connections / integrations
- Manage connected platforms (Shortcut, GitHub, Linear) and per-platform agent identities + webhooks. Show connection health (e.g. webhook delivery status).
- This is where the per-platform native-identity provisioning lives — design Shortcut agent-user config, GitHub App install, Linear app install distinctly but consistently.

### C8. Settings
- Org settings (members/roles — admin-gated), billing/usage (per-agent cost, vendor credit consumption, CI minutes), feature flags, security (scopes, audit log), AI/vendor keys (Anthropic/OpenAI keys, local-model endpoints).
- Security surface: least-privilege scopes per identity, audit log of agent actions.

### C9. PM-assistant surface (Stage 5, design now as flag-off)
- The Claude PM-assistant: a panel/surface for triage, decomposition suggestions, routing proposals, and standup summaries. Advisory framing — it *suggests*, the human/engine decides. Design it flag-off/empty-state-ready.

### C10. Cross-cutting app chrome
- App shell: navigation (Roster / Monitoring / Connections / Settings / PM-assistant), top bar (org/project context, search, notifications, theme toggle, account).
- Notifications surface (agent needs input, task blocked, escalation, shipped).
- Global empty/loading/error/blocked patterns (the state system).

---

## PART D — MARKETING SITE (page by page, from scratch)

> The current marketing site reflects the old kanban product (and earlier carried VK-shutdown leftovers). Redesign entirely for the workforce-platform positioning.

### D1. Home / landing
- **Hero:** the positioning line ("Your AI dev team — named, capable, and working in the tools you already use") + a single strong visual of the roster concept (named agents as a team). One primary CTA.
- **The three wedges** as the core value sections: (1) named multi-vendor agents with real identities, (2) capability/tier routing, (3) the roster/employee model + 24/7. Each shown concretely, not abstractly.
- **How it works:** the end-to-end loop (assign a Story in Shortcut → Tasca routes to a capable agent → it codes, opens a PR → status back) — ideally an illustrative walkthrough.
- **Integrations:** Shortcut, GitHub, Linear (lead with Shortcut). Neutral multi-vendor model support (Claude/OpenAI/local).
- **Trust/credibility:** security posture (native identities, branch protection, audit, least-privilege), who it's for.
- **CTA / sign-up.**

### D2. Supporting pages
- **How it works / Product** (deeper than the home section).
- **Pricing** (model TBD per PRD open question — design flexible to per-agent / per-task / usage).
- **Security** (the real posture — native identities, no fake humans, scopes, audit, data handling; do NOT overstate unbuilt features as live — match reality per the PRD's honesty rule).
- **Docs** entry point.
- **Login** (hands off to the app OAuth).
- **404** + legal (Terms, Privacy).

### D3. Marketing visual language
- Same brand foundation as the app (shared tokens/type/logo) so app and site feel like one product.
- Lean into the "team/roster" visual metaphor. Show named agents, capability, routing — make the abstract concrete.
- Honest: never depict features that aren't built as if they're live (Stages 3–5 features are roadmap; represent accordingly or clearly as "coming").

---

## PART E — REQUIREMENTS & ACCEPTANCE

### E1. Accessibility (mandatory)
- WCAG AA contrast on every text/UI pairing, **both light and dark**, **verified** (assert in CI, like the prior bridge's contrast check).
- Full keyboard navigation, focus-visible via a focus-ring token, ARIA landmarks/labels, decorative SVGs aria-hidden, reduced-motion safe, content usable without JS where applicable.
- Tier/status never conveyed by color alone (pair with label/shape) — color-blind safe.

### E2. Theming & tokens
- Token-driven only; no hardcoded hex/rgb anywhere (CI color-guard enforces). Primitive→semantic→component layering, light+dark.
- Persistent theme switcher.

### E3. States
- Every data surface ships real empty / loading / error / blocked states. No fake or seeded data in any design or implementation.

### E4. Responsive
- Desktop-first (this is an ops console) but responsive; define breakpoints and the mobile behavior for the roster, monitoring, and detail surfaces.

### E5. Deliverables (in order)
1. `design-system/` foundation: new tokens (color/type/space/radius/elevation/motion), logo + favicon/manifest set, iconography, component primitives — token-driven, AA-verified, light+dark. **Plus a reference page rendering the system (tokens + components) in both themes.**
2. High-fidelity designs for every Part C app surface + every Part D marketing page, with real states, both themes.
3. A short design-rationale doc mapping each decision back to the brand principles (A4) and the product (PRD).
4. Implementation only after the above is reviewed — same panel flow, CI green, no deploy until owner review.

### E6. Out of scope / explicitly dropped
- All old kanban / project-delivery UI. Jira (no adapter, no UI). Any VK-derived visual language or leftover assets.

### E7. Open design questions to surface (don't decide silently)
- Final brand name treatment / does "Tasca" stay as the product name for the pivoted platform?
- Logo direction options (present 2–3 before committing).
- Pricing-page model (depends on PRD billing open question).
- How much of the routing inspector to expose to non-technical PMs vs engineers (audience split).
