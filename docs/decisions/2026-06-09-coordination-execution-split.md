# Coordination|Execution split: a non-root, egress-restricted agent-runner

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** maintainer

## Context

Tasca runs an autonomous coding agent (the Claude Code CLI) against customer repositories.
The agent's prompt is **attacker-influenced** — it is the content of a user story, which a
malicious actor can craft (prompt injection). Until this change, the worker process did
everything in one container: held the GitHub App **master private key**, ran the HTTP server,
AND spawned the agent in-process. That co-location means a prompt-injected agent shares a
process boundary with the master key and has unrestricted network egress — it could read the
key from the environment/filesystem, or exfiltrate any credential to an arbitrary endpoint.

The Stage-2 plan calls for splitting execution out of the worker. This ADR records the split
and the two controls that contain the lowest-trust process.

## Decision

Split the system into two processes across a trust boundary:

- **worker** (trusted) — coordination HTTP, the credential **broker**, the dispatch reaper,
  and an in-process execution **fallback**. Holds the GitHub App master key. Has internet
  access (GitHub App API, Anthropic, inbound webhooks).
- **agent-runner** (lowest trust) — claims `dispatch_job` from the Postgres queue, mints a
  **per-task, single-repo scoped token** from the broker over a unix socket, runs the agent,
  opens the PR, and revokes the token. Carries **no worker secret**.

Two controls contain the runner — both are the panels' break-targets across this track:

1. **No master key.** The master key never leaves the worker. The broker (`@tasca/broker`)
   exposes only `mint(repoRef) → {token, expiresAt}` over a unix socket; the wire never
   carries the key. Tokens are scoped to the one task repo (minimal perms) and revoked on
   completion. The socket is `0o660`, group-owned by the runner's gid — only the runner uid
   can connect, never the world. *(Proven: broker panel #236 — master key unreachable.)*

2. **Allowlisted egress.** The runner runs **non-root** (uid 10001) and sits ONLY on
   `internal: true` networks (the DB plane + the proxy plane). It has **no default route to
   the internet**. Its sole path out is an egress proxy (`deploy/egress-proxy`, tinyproxy with
   `FilterDefaultDeny`) that permits CONNECT only to `*.anthropic.com` + `*.github.com` +
   `*.githubusercontent.com`, port 443 only. So even an agent that unsets `HTTPS_PROXY`
   cannot reach a third party to exfiltrate its scoped token — there is no route, and what
   does go through the proxy is constrained to the allowlist. *(Proven locally:
   `deploy/verify-egress.sh` — allowed reachable, denied + look-alike blocked, direct egress
   impossible.)*

The credential-isolation carried into execution earlier (#230): the token authenticates git
via a `GIT_CONFIG` extraheader on the clone child's env only (never persisted to `.git/config`),
and the agent is spawned with a scrubbed env (no token, no broker socket path).

## Reference topology

`deploy/compose.yml` is the platform-agnostic encoding of the boundary (worker, postgres,
egress-proxy, runner; `frontend` internet bridge; `backend` + `runner-egress` both
`internal: true`). The Coolify resources mirror it: the runner resource attaches only to
internal networks + the proxy; the worker resource is the only app container with internet +
ingress. `cd-worker.yml` builds + publishes the shared base; `cd-runner.yml` builds the runner
`FROM` that base and deploys it.

## Consequences

- **+** A prompt-injected agent cannot read the master key (it's in another process) nor
  exfiltrate its scoped token (no egress route off the allowlist). Blast radius = one repo,
  task-lived token.
- **+** The runner is non-root; a container-level compromise has no root in the container.
- **−** The **in-process fallback** in the worker still runs agents with the worker's trust
  and full egress when no runner claims a job (a runner outage). This is the migration safety
  net (a runner outage never stalls a task), but it is a *reduced-but-not-zero* exposure until
  runners are the steady-state path. Mitigation: keep `TASCA_DISPATCH_MODE=queue` with healthy
  runners so the fallback is cold; hardening the worker's own agent spawn (drop-root, egress)
  is tracked for a later pass.
- **−** Operational surface grows (a proxy + extra networks). The egress allowlist must be
  maintained as legitimate agent destinations change; `deploy/verify-egress.sh` guards it.
- The egress enforcement is **network-level** (internal-only networks) by deliberate choice;
  an env-only `HTTPS_PROXY` would be bypassable by the agent and was rejected.
