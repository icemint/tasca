# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added

**Agent-detail page — full editing surface**

- Capability editor: tier range (min/max), structured taxonomy specialties (language + framework tags via a tag-input, taxonomy-bound), concurrency limit, and cost ceiling. All fields editable and persisted through an optimistic-concurrency (version-CAS) `/profile` endpoint that rejects stale writes with a 409 and re-renders from server truth.
- Per-agent platform credentials (GitHub and Shortcut): sealed at rest under AES-256-GCM with an env-held master key. Reads return only a status indicator and fingerprint — the token is never echoed, logged, or returned by any API. Connection-test-on-entry validates the token live before sealing. Existing credentials are replaceable. Provider schema is extensible (one new file for additional platforms). Mirrors the org vendor-key UX.
- Editable agent identity (name, vendor, model, avatar) and an `agent.md` description (a freeform Markdown file that shapes how the agent runs). Both editable under the same combined version-CAS endpoint.
- Per-agent credential actions (set, replace, delete, test) are gated admin+; identity/capability edits are user+; all gating is server-side with no existence leak cross-tenant.

**Agent execution shaped by agent.md**

- An agent's `agent.md` is passed as `--append-system-prompt` at dispatch, additive to the task prompt. The agent receives its own persona, repo conventions, and the task description in a single run.

**Engineering Manager (EM) as router**

- Assign a task to the EM (a distinct entity with its own sealed credential, not an agent) instead of to a specific agent. The EM runs a requirements gate — clarifying vague tasks before routing — then dispatches to the least-loaded qualified agent by tier + specialty + load.
- Two orthogonal concurrency limits enforced: per-agent `concurrencyLimit` and per-repo `perProjectLimit` (both default 1). Merge-safe.
- Visible blocks: staffing-gap (no agent can handle this tier/specialty), transient-busy (all qualified agents at capacity), and repo-at-capacity (per-repo limit hit). Each block surfaces an explanation on the task card.
- "Assigned by EM" attribution is shown on the task card and inspector.
- Operator override: an operator can force-assign to a specific agent, bypassing EM routing.
- Specialty derivation is a deterministic title + file-extension heuristic today; LLM-derived specialty is a filed fast-follow (#370).

**Task titles persisted and surfaced**

- Task titles are stored at intake and shown on board cards, the task inspector, and agent recent-work. Raw task UUIDs no longer appear on those surfaces.

**Operator controls**

- Sole-owner removal guard: the last owner-admin of an instance cannot be removed or demoted.
- Stuck-task force-reset: an operator can force-reset a task stuck in a terminal dispatch state back to routable.
- Collapsible navigation sidebar.

### Changed

- Board cards and the task inspector now lead with the task title (falling back to the story reference); the task UUID is preserved in the navigation href.
- Agent recent-work rows show the story title rather than the task UUID.
- Agent identity and capability edits share a single combined version-CAS endpoint; a stale write 409s and the view re-renders from server truth with a banner.

### Fixed

- Capacity-freed re-drive (dispatching queued tasks when an agent completes and frees a slot) filed as a fast-follow (#368); not yet implemented.
- Current-task display on the agent page and roster tile still shows the task UUID in some paths (#325, partial).

---

<!-- Older sessions are summarized below. These entries cover merged work prior to 2026-06-15. -->

## [Pre-release — Waves 1–2] — 2026-06-10

### Added

- **Multi-tenancy + RBAC (Waves 1–2, PRs #240–#258):** org scoping on all tenant tables enforced by a CI guard, org_id columns + backfill, three-role model (owner-admin / admin / user), role-gated endpoints (fail-closed, 404 on cross-tenant — no existence leak).
- **BYOK credential vault (PR #279):** AES-256-GCM sealed vendor keys (Anthropic) stored per org, master key env-held, write-only API, fingerprint-only display, live validation on input, ~60 s decrypted-key cache.
- **Anthropic credential proxy (PR #248):** keyless agent execution — the master key stays worker-side; a scoped token is minted per task via a Unix socket broker and injected into the agent subprocess.
- **In-process fallback retired (PR #247):** no runner → `needs_attention`; no silent fallback paths.
- **Ephemeral per-task agent HOME (PR #246):** isolated HOME directory per dispatch to prevent shared-HOME residual leakage.
- **GitHub adapter — reference, end-to-end:** intake (issues, PRs, review, check_run webhooks), write-back (status comment + PR link), native GitHub App identity, connect flow, content source.
- **Shortcut adapter — intake:** assignment webhook received and verified (HMAC-SHA-256), webhook self-registration, outgoing webhook flow. Write-back deferred pending token-model confirmation.
- **Engineering Manager v1 — requirements gate + block-explanation:** EM entity with sealed credential, requirements review before routing, block explanations (staffing-gap, transient-busy, repo-at-capacity).
- **Projection board:** 5 operator columns (Backlog, Blocked, In Progress, PR Opened, Completed); GitHub-merge auto-completes tasks. Board is a read-only projection of platform reality.
- **Roster and monitoring views:** real data, honest empty/loading/error states, WCAG-AA, status not conveyed by color alone.
- **OAuth + GitHub App identity:** human login, session management, CSRF protection.
- **Coolify autodeploy:** worker and app containers with SHA-verify on merge.
- **Docker Compose self-hosting:** `make up` boots the full stack; `SELF_HOST.md` covers the first-run walkthrough.

[Unreleased]: https://github.com/icemint/tasca/compare/main...HEAD
