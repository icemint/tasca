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
   `*.githubusercontent.com`, port 443 only. So even an agent that unsets `HTTPS_PROXY` cannot
   reach an **arbitrary third party** — there is no route, and the proxy denies any host off
   the allowlist. *(Proven locally: `deploy/verify-egress.sh` — allowed reachable, denied +
   look-alike blocked, **no-route proven against a literal public IP**.)*

   **What egress filtering does NOT do (be precise — the prior wording over-claimed):** it is
   *not* a confidentiality boundary for secrets against a GitHub-capable attacker. GitHub
   (`github.com`, `api.github.com`, `*.githubusercontent.com`) is multi-tenant and
   **attacker-writable** — anyone can create a gist/repo/issue — and the proxy only inspects
   the CONNECT host, not the tunnelled TLS. So a prompt-injected agent that holds a secret
   *can* write it as content to an attacker-controlled GitHub destination. What contains the
   secrets is therefore NOT egress but the scrub + scope + lifetime below; egress stops the
   naive third-party beacon, DNS look-alike, and arbitrary-host exfil, which is its job.

The credential-isolation carried into execution earlier (#230): the token authenticates git
via a `GIT_CONFIG` extraheader on the clone child's env only (never persisted to `.git/config`),
and the agent is spawned with a scrubbed env (no token, no broker socket path).

**What the prompt-injected agent can actually reach (the true secret surface):**
- The **scoped GitHub token is NOT in the agent's environment** (#230 scrub; it lives only in
  the transient clone/push child processes). So the agent cannot read its own scoped token to
  exfiltrate it — its confidentiality rests on the scrub + the one-repo scope + the task
  lifetime + **revoke-on-completion** (#237 always revokes, even on failure), not on egress.
- The **`ANTHROPIC_API_KEY` IS in the agent's env** (the Claude CLI needs it). Egress does not
  make it confidential: the agent could write it to an attacker-controlled GitHub gist over the
  allowlisted proxy. This is a **residual** — bounded (the key is rotatable, org-level not
  customer data), and the proper fix (proxy the Anthropic credential so the agent never holds
  the raw key, or use a per-session token) is tracked as a follow-up, not in this slice.

## Reference topology

`deploy/compose.yml` is the platform-agnostic encoding of the boundary (worker, postgres,
egress-proxy, runner; `frontend` internet bridge; `backend` + `runner-egress` both
`internal: true`). The Coolify resources mirror it: the runner resource attaches only to
internal networks + the proxy; the worker resource is the only app container with internet +
ingress. `cd-worker.yml` builds + publishes the shared base; `cd-runner.yml` builds the runner
`FROM` that base and deploys it.

## Consequences

- **+** A prompt-injected agent cannot read the master key (it's in another process) nor reach
  an arbitrary third party (no egress route off the allowlist). Its own scoped token isn't in
  its env (#230) and is revoked on completion (#237), so even the GitHub-as-exfil-channel
  residual (above) buys an attacker a one-repo, already-expiring token. Blast radius = one repo,
  task-lived.
- **+** The runner is non-root; a container-level compromise has no root in the container.
- **−** **GitHub is an exfil channel for whatever the agent CAN read.** Egress filtering is a
  host-level CONNECT allowlist, not TLS-inspecting, and GitHub is attacker-writable — so any
  secret in the agent's env (today: `ANTHROPIC_API_KEY`) can be written to an attacker gist.
  Carried by token scrub/scope/lifetime, not egress; closing it fully needs the Anthropic-cred
  proxy (tracked).
- **−** **Cross-task persistence on a shared runner.** The agent runs via a login shell and
  `HOME=/data` is the runner's persistent, agent-writable volume, so task A's agent can plant a
  `~/.bashrc` / git credential helper that task B's agent sources — harvesting a future task's
  context. The egress wall still contains the box, but this erodes per-task isolation on a
  shared runner. Fix (tracked follow-up in `@tasca/execution`): give each agent run an
  **ephemeral per-task `HOME`** distinct from the runner volume, and spawn with a non-login,
  non-interactive shell so rc/profile files are never sourced.
- **−** The **in-process fallback** in the worker still runs agents with the worker's trust
  and full egress when no runner claims a job (a runner outage). This is the migration safety
  net (a runner outage never stalls a task), but it is a *reduced-but-not-zero* exposure until
  runners are the steady-state path. Mitigation: keep `TASCA_DISPATCH_MODE=queue` with healthy
  runners so the fallback is cold; the fallback path now logs at **error-level** ("SECURITY —
  running the agent IN-PROCESS") so a boundary downgrade is visible/alertable; hardening the
  worker's own agent spawn (drop-root, egress) is tracked for a later pass.
- **−** Operational surface grows (a proxy + extra networks). The egress allowlist must be
  maintained as legitimate agent destinations change; `deploy/verify-egress.sh` guards it.
- The egress enforcement is **network-level** (internal-only networks) by deliberate choice;
  an env-only `HTTPS_PROXY` would be bypassable by the agent and was rejected.

## Status update (2026-06-10) — Wave-2 Track-1 residual closures

The three `−` residuals above have since been **closed** (Track-1 security residuals are now
fully closed; the sole remaining Track-1 item is the dominant deploy-layer one — a separate-UID +
PID/mount/net namespace sandbox **per agent on the runner**, deferred):

- **`ANTHROPIC_API_KEY` as a GitHub-exfil channel → CLOSED (#248).** `@tasca/anthropic-proxy`: the
  worker holds the key and runs a streaming credential-injecting proxy over a unix socket (the key
  is injected only on the upstream HTTPS leg); the runner runs a keyless TCP↔unix bridge and points
  the agent at `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`. The agent is **keyless** —
  `ANTHROPIC_API_KEY` is deliberately **not** in the agent env allowlist
  (`execution/src/factory.ts`). So there is no longer a key in the agent's env to write to a gist.
- **Cross-task persistence on a shared runner (shared `HOME=/data`) → CLOSED (#246).** Each agent
  run gets an **ephemeral per-task `HOME`** (`mkdtemp`, fresh + empty per spawn, reclaimed after),
  distinct from the runner volume — so task A can no longer plant a `~/.bashrc` / credential helper
  that task B sources. (The matching non-login `-c` shell was scoped down to empty-HOME-only; the
  empty HOME already closes the profile-sourcing residual.)
- **In-process fallback in the worker → RETIRED (#247).** Production no longer runs the agent
  in-process when no runner claims: orchestrate polls for a runner up to `TASCA_RUNNER_WAIT_MS`
  (default 30s), then retires the task to `needs_attention` with `last_error="no execution
  capacity"` (NOT via the breaker). The hardened boundary always holds — the agent only ever runs
  in the non-root, egress-restricted runner. (The in-process path remains for the no-queue/dev
  mode only; `no_inflight` interrupt/reassign is now unreachable in production.)
