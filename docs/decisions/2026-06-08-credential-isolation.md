# 2026-06-08 — Credential isolation for the agent execution context

Status: accepted

## Context

The live GitHub agent-dispatch loop runs an autonomous `claude` agent (with Bash) inside a per-task worktree, driven by a prompt built from the issue title + body. **The issue body is attacker-controlled** — anyone who can open/assign an issue on a connected repo can attempt prompt injection. Before any untrusted issue author reaches the loop, the agent's execution context must hold **no worker secret**: not the GitHub App private key, the installation token, `DATABASE_URL`, `SHORTCUT_*`, `GH_TOKEN`, nor a usable ssh-agent socket. This is the gate to multi-tenant. Two concrete exposures existed:

1. **Token at rest in `.git/config`.** clone-on-dispatch persisted the installation token into the clone's `origin` URL, so the agent could `git config --get remote.origin.url` (or read `.git/config`) and exfiltrate it.
2. **Worker env inherited by the agent.** `spawnAgent` passed `{...process.env, ...input.env}` to the child, handing the prompt-injectable agent every worker secret a `printenv` could read.

## Decision

A combination, enforced at the boundaries Tasca owns:

1. **Tokenless origin + per-invocation env-auth.** `origin` is `https://github.com/<owner>/<repo>.git` (no credential). The clone/fetch (`repo-provisioner`) and the PR push (`open-pr`) authenticate by injecting an `http.<base>.extraheader: Authorization: Basic base64(x-access-token:<token>)` into **that one git child's env** via `GIT_CONFIG_COUNT/KEY_0/VALUE_0` — never in argv, never persisted to `.git/config`. The token is structurally absent from any config the worktree can read. `gh pr create` gets the token as `GH_TOKEN` (it doesn't read git config).

2. **Provisioner owns worktree creation.** `createWorktree` runs `git worktree add` off the already-fetched `origin/<defaultBranch>` (local, no auth), bypassing the vendored worktree path that would `git fetch origin` + `pushOnCreate` against an origin we deliberately left unauthenticated.

3. **Agent env = strict allowlist, enforced on the GLOBAL `process.env`.** `spawnAgent` builds the child env from `AGENT_ENV_ALLOWLIST` (PATH/HOME/locale/TZ + the Anthropic auth the CLI reads) — never the full env. **Crucially**, the vendored `startLifecyclePty` reads `process.env` *directly* (its happy path pulls `SSH_AUTH_SOCK` + X11/Wayland display vars; its node-pty-unavailable fallback spreads the *entire* `process.env` under our `env` arg). Under de-Electronized Node the native `node-pty` binding often fails to load, making that fallback the **likely production path** — so filtering the `env` argument alone is insufficient. We therefore transiently reduce `process.env` to the allowlist around the **synchronous** spawn (`spawnWithScrubbedEnv`) and restore it in `finally`. `startLifecyclePty` does no awaiting before it forks, so on Node's single thread nothing but the child being created observes the reduced env.

4. **Worktree reclamation.** `removeWorktree` (best-effort, never throws) reaps the worktree + per-attempt branch on every terminal dispatch path, so dispatches and re-drives don't leak worktrees/branches under the repos dir without bound.

## Consequences

- The installation token never reaches the agent's execution context (not in `.git/config`, not in argv, not in env). `redactToken` stays as defense-in-depth and is now positively tested for wiring (a token in a failing git argv is redacted).
- The agent inherits no worker secret and no ssh-agent socket. Verified by tests that snapshot `process.env` at spawn time (what the vendor actually reads), not just the `env` arg.
- Zero new runtime deps; no vendored-code edits (enforcement is entirely at the Tasca seam).

## Residuals (Phase-2, ops — not closed by this change)

These are host/deployment boundaries, not in-process leaks:

1. **Login-shell profiles.** The vendor runs the command via `$SHELL -ilc …` (login+interactive), sourcing `/etc/profile` and the worker user's rc files inside the agent. Any `export SECRET=…` there re-enters after the scrub, and the agent's Bash can read those files. **Mitigation:** run the agent as a dedicated unprivileged user with empty profiles (the multi-tenant deploy target).
2. **Same-user / shared-namespace exposure (the dominant residual).** On the current deploy the worker runs as **root** and the agent is spawned **in-process**, sharing the worker's PID, network, mount namespaces and HOME. So the in-process env scrub is necessary but **not sufficient**: a prompt-injected root agent reads the **worker's own** `/proc/<pid>/environ` — which permanently holds `GITHUB_APP_PRIVATE_KEY` (the master credential), `DATABASE_URL`, and every other secret — directly, bypassing the scrub entirely. It can likewise read a concurrent git/gh child's environ to lift a live installation token, reach internal Postgres / cloud metadata over the shared network namespace, and source the worker's login profiles. *(An earlier draft of this residual understated it as only "a concurrent git-child's env" — corrected here; the always-present worker environ is the real target. Full analysis: `docs/Security-Review-Stage1.md`.)*

These close only with a **separate-user + PID/mount/network-namespace sandbox per agent, brokered credential minting, and default-deny egress** — the Phase-2 hardening (the actual multi-tenant gate). Until then: **trusted single-tenant repos only**, and set `TASCA_REPOS_DIR` to a dedicated private volume.

## Provenance

Architected, then reviewed by a security-focused adversarial panel (token-leak, env-allowlist, worktree correctness, test rigor). The panel surfaced the vendor's direct `process.env` reads (both must-fixes) — the original allowlist filtered only the `env` arg and was a no-op on the production fallback path; decision 3's global scrub is the fix.

## Status update (2026-06-10) — residuals superseded by the coordination|execution split

This ADR's residuals were written for the **single-container** deploy (worker runs the agent
in-process as root). That topology has been **superseded** by the coordination|execution split
(`docs/decisions/2026-06-09-coordination-execution-split.md`, #234–#248). On the split deploy the
agent runs in a separate **non-root runner** holding **no worker secret**, the GitHub App master
key never leaves the worker (the credential **broker** mints per-task, single-repo scoped tokens
over a unix socket), and the runner has **default-deny egress** (model API + GitHub allowlist only).
The in-process env scrub here (decision 3) remains correct and is retained for the no-queue/dev
path. Residual status against the split:

- **Residual 1 (login-shell profiles) → closed for the dominant case (#246):** each agent run gets
  an ephemeral, empty per-task `HOME`, so the worker's profiles are no longer in the agent's HOME to
  source. (A true non-login `-c` shell is a deferred optional deploy-layer wrapper.)
- **Residual 2 (same-user / shared-namespace; root agent reads the worker's `/proc/.../environ` for
  `GITHUB_APP_PRIVATE_KEY` / `DATABASE_URL`) → closed for production:** the agent is no longer
  in-process in the worker (split #234–#243; in-process fallback **retired** #247), and the master
  key is broker-gated worker-side. `ANTHROPIC_API_KEY` left the agent env entirely (#248).

**The dominant residual that remains** is the deploy-layer one named in both this ADR and the
Security Review: a **separate-UID + PID/mount/network namespace sandbox per agent on the runner**
(multiple agent runs in one runner container still share namespaces). Until it lands, the safe bar
stays as documented. Multi-tenant data-plane isolation (org_id) is a separate axis — see
`docs/decisions/2026-06-10-org-scoping-app-level.md`.
