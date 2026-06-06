# Tasca — GitHub Integration Brief

**Status (2026-06-06):** Build the **intake** now against the documented webhook + REST surfaces. The identity model is **decided: a per-customer GitHub App** (see `docs/decisions/2026-06-06-stage1-app-tracks.md`, decision 2). Write-back + provisioning stay gated on the App being built/installed, not on any undocumented API — so GitHub's gate is narrower than Shortcut's (which waits on an undocumented token-issuance answer, `docs/Tasca-Shortcut-Kickoff-Brief.md` item 2).

**Context for the integration:** Tasca is an AI agent-workforce platform — named AI "employees" that receive assigned work, do it, and report back as themselves. GitHub **Issues are a work SOURCE** here: assigning an issue to an agent, or @-mentioning one in a comment, dispatches that agent. This is distinct from `@tasca/execution` using the `gh` CLI to open PRs (the execution *output* on a target repo).

---

## Buildable NOW (documented, ungated — shipped in `@tasca/adapters`)

- **Assignment + mention intake.** `GitHubAdapter`:
  - `verifyWebhook` — HMAC-SHA-256 over the raw body vs `X-Hub-Signature-256` (`sha256=<hex>` prefix), constant-time.
  - `parseEvent` — `issues` action `assigned` (the just-assigned `assignee`, matched by numeric user id) and `issue_comment` action `created` (@-mention, matched by login) ∩ registered agent ids → `AdapterEvent`. `repoHint` carries `repository.full_name`; `externalStoryId` is the composite `owner/repo#number` (globally unique).
  - `dedupeBySelf` — drops the agent's own round-tripped comments by `sender.login`.
  - `registerWebhook` — `POST /repos/{owner}/{repo}/hooks` (REST repo-hook path; unused when the App delivers webhooks automatically).
- **Idempotency key** = the `X-GitHub-Delivery` header (GitHub puts no dedupe id in the body); the worker reads it off the headers into the `webhook_event` ledger.
- **Identity vault already absorbed.** `identity_binding` (per-binding `credential_ref` + stable `principal_id`) models the GitHub App installation token exactly as it models a Shortcut token — no schema change. `identity_binding.platform` already allows `'github'`.

## Decided

- **Per-customer GitHub App** (PRD §5.2). One `app[bot]` author for write-back; per-agent attribution carried in the comment body / trailer via `delegation.attribution_label`. Branch protection holds (the App can't self-approve). Auth uses short-lived installation tokens (App JWT → installation access token). `external_id` for a binding = the stringified numeric GitHub user id (rename-stable); `external_handle` = the login (for @-mention matching).

## Gated / deferred (needs the App built + installed)

- **App provisioning** — the customer installs the Tasca GitHub App on their org/repos (a UI/onboarding step, analogous to Shortcut's "Configure Agent Users"). `GitHubAdapter.provisionIdentity` throws until this lands.
- **Write-back identity attribution** — `postStatus` (issue comment / state under the `app[bot]` identity, with per-agent attribution in text) throws until the App + installation-token flow is implemented. The APIs are fully documented; this is a build-it step, not an unknown-surface block.

---

## Plan

- **Phase 1 (done — ungated):** `GitHubAdapter` intake (verify/parse/dedupe/registerWebhook) + the GitHub webhook Zod schema in `@tasca/contracts`; wired into the worker as a second verifier behind `POST /webhooks/github` (flags OFF until `GITHUB_WEBHOOK_SECRET` is set).
- **Phase 2 (gated):** build the GitHub App (manifest, installation-token exchange), `provisionIdentity` (bind on install), and `postStatus` (comment/state as `app[bot]` + attribution). Re-check at integration time.

## Notes
- v3 webhooks sign with `X-Hub-Signature-256` (HMAC-SHA-256, `sha256=` prefix) — older `X-Hub-Signature` (SHA-1) is not used.
- The registered-agent set is a boot-time snapshot of active `github` bindings (numeric ids + logins); a roster change needs a worker restart — dynamic reload is a follow-up (same caveat as Shortcut).
