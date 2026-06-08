# Write-API Scope (follow-up initiative)

Status: not started · Gate: pick up deliberately once the decisions below are settled.

The read-only console (`docs/Web-App-Finalization.md`) renders 17 mutating controls as visible-but-disabled `roControl`s today. This document scopes the write-API that lights them up — the endpoints, the UI wiring, and **the decisions each family is blocked on**. It is intentionally NOT built yet: several families depend on unresolved product/security gates, and turning on writes flips the prod posture (flags ON), so it warrants its own architect → build → verify cycle.

## Cross-cutting prerequisites (apply to ALL write endpoints)

1. **AuthZ** — the read-API is session-gated read-only. Writes need an authorization model: who (which `app_user`) may mutate which agent/task/connection. Today there is no role/ownership check beyond "authenticated". **Decision needed:** workspace/ownership model + per-action permission (ties into identity RBAC, `capability_profile`).
2. **CSRF / mutation safety** — same-origin cookie auth + state-changing POSTs need CSRF protection (double-submit token or `SameSite=strict` + origin check). Not required for the current GETs.
3. **Optimistic concurrency** — task/agent mutations race the dispatch loop's own CAS writes. Writes must go through the same versioned `UPDATE ... WHERE version=:n` path (`@tasca/db`), not bypass it, or they corrupt the breaker/claim invariants.
4. **Audit** — every privileged action appends to `audit_event` (the table exists). Wire each write through it.
5. **Flag posture** — writes ship behind a flag, OFF in prod until the gate clears; the UI's `data-ro` controls flip to live only when the flag is on.

## Control families → endpoints → gate

### A. Task intervention — Reassign · Escalate · Re-tier · Interrupt
- **Controls:** monitoring attention rail (Re-tier, Escalate), task inspector (Reassign, Escalate), agent current-work (Interrupt, Reassign, Escalate).
- **Endpoints (sketch):** `POST /api/tasks/:id/reassign {agentId}`, `POST /api/tasks/:id/escalate`, `POST /api/tasks/:id/retier {tier}`, `POST /api/tasks/:id/interrupt`.
- **Mechanism:** mutate task status/claim via the versioned CAS; interrupt calls `ExecutionPort.killAgent`; escalate transitions to `needs_attention`.
- **GATE — Shortcut write-back:** escalate/reassign that post status back to the *originating platform* are **gated on the Shortcut token-issuance model** (the standing Shortcut-kickoff decider, `docs/Tasca-Shortcut-Kickoff-Brief.md` #2). GitHub write-back is live (#207), so GitHub-platform tasks could enable first; Shortcut-platform tasks stay gated. The UI must reflect per-task platform when enabling.

### B. Agent lifecycle — Add agent · Deploy · Pause · Edit profile · Assign a task
- **Controls:** roster (Add agent), agent header (Deploy, Pause, Edit profile), agent current-work (Assign a task).
- **Endpoints (sketch):** `POST /api/agents {vendor, model, name?}`, `POST /api/agents/:id/deploy`, `POST /api/agents/:id/pause`, `PATCH /api/agents/:id {capabilityProfile}`, `POST /api/agents/:id/assign {taskId}`.
- **GATE — identity provisioning is operator-run today:** creating/deploying an agent provisions a platform identity. The primitive exists as a **CLI** (`provision-github-agent`, #220) requiring a real machine GitHub account + collaborator add (App bots can't be assignees). A one-click "Add agent" needs: (a) a UI-driven provisioning flow that creates/links the machine account, or (b) accepting operator-run provisioning and having the UI only *register* an already-provisioned account. **Decision needed:** which, plus how `costCeiling`/capability edits map to `capability_profile` writes.

### C. Platform setup — Connect · Manage · Repair · Continue (onboarding)
- **Controls:** connections (Manage, Repair), onboarding (Connect per platform, Continue).
- **Endpoints (sketch):** OAuth/App-install initiation + callback handling per platform; `POST /api/connections/:platform/repair` (re-auth).
- **GATE — operator-run install today:** GitHub = customer installs the App (operator); Shortcut = webhook + token config (gated on the token model); Linear = not built. **Decision needed:** whether in-app connect flows are in scope for Stage 2 or remain operator-run; Linear adapter is a separate build.

## Suggested sequencing
1. Resolve the cross-cutting AuthZ + CSRF model (blocks everything).
2. **GitHub-only task intervention** first (Shortcut write-back already live for GitHub; smallest, highest-value, no provisioning dependency).
3. Agent `pause` / `edit profile` (no provisioning; pure state/profile writes).
4. Agent `add` / `deploy` once the provisioning-flow decision lands.
5. Platform connect flows + Shortcut write-back once those gates clear.

## Non-goals (stay deferred)
Settings panels (Workspace/Billing/API keys/Audit), live streaming, Linear adapter, routing-history UI.
