# Security Review — Stage 1 agent execution isolation (post-#230)

Date: 2026-06-08 · Scope: the agent execution context on the live worker · Method: architect-framed, 4-dimension adversarial panel with per-finding verification.

> ## Status update (2026-06-10) — most of this review has SHIPPED
>
> This review describes the **pre-split single-container** runtime (agent spawned in-process as
> root in the worker). That topology is **superseded** by the coordination|execution split
> (#234–#248). The findings below remain the historical analysis; their **isolation fixes have
> largely landed**. Current mapping:
>
> | Finding | Status | Shipped by |
> |---------|--------|-----------|
> | **C1** agent reads worker `/proc/.../environ` | **Closed for production** — agent runs in the separate non-root **runner**, not in-process in the worker; in-process fallback **retired** | split #234–#243, #247 |
> | **H1** App master key in agent-reachable env | **Closed** — master key stays worker-side behind the **broker**; runner mints per-task scoped tokens | broker #236, #248 |
> | **H2** sibling git/gh `/proc` token theft | **Mitigated** — runner holds only a one-repo, task-lived scoped token (revoked on completion) | #230, split, #237 |
> | **M2** unrestricted egress | **Closed** — runner is non-root on `internal:` networks; default-deny egress proxy (model API + GitHub only) | split #234–#243 |
> | **L1** AES file-store key on shared root HOME | **Closed for the shared-HOME part** — ephemeral per-task HOME | #246 |
> | **L2** login-shell profile sourcing | **Closed for the dominant case** — empty per-task HOME | #246 |
> | *(new)* `ANTHROPIC_API_KEY` in agent env (named in the split ADR) | **Closed** — keyless agent, credential proxy worker-side | #248 |
> | **M1** undefended await-free scrub invariant | **Open** — still relevant on the no-queue/dev in-process path | — |
>
> **The dominant residual that REMAINS:** a **separate-UID + PID/mount/network namespace sandbox
> per agent on the runner** — multiple agent runs in one runner container still share namespaces.
> Until it lands the safe bar holds (below). Note this is the **agent-sandbox** axis; the
> **multi-tenant data-plane** axis (org_id) is tracked separately in
> `docs/decisions/2026-06-10-org-scoping-app-level.md`.

## Threat model & doctrine

**Actor:** a prompt-injected `claude` agent. The agent prompt is built from the GitHub issue title + body (`orchestrate.ts`), which is **attacker-controlled** — anyone who can open/assign an issue on a connected repo can attempt injection. The agent has **Bash + full network** (it must — it writes code, runs `git`/`gh`, and reaches the model API; agent-authored PRs #8/#9 prove the capability is intact and must stay intact).

**Invariant under test:** the agent must not be able to **read or use** any worker secret — the GitHub App private key, installation tokens, `DATABASE_URL`, `SHORTCUT_*`, `GH_TOKEN`, OAuth secrets, or a usable ssh-agent socket.

**Doctrine — additive hardening:** every fix must **add isolation** (separate user / namespaces / brokered credentials / egress policy). Removing the agent's capability (strip Bash, cut network) is an **anti-pattern** and is rejected. The agent stays exactly as capable; the trust surface around it shrinks.

## Runtime ground truth (`deploy/worker.Dockerfile`, verified)

One `node:22-bookworm` container, **no `USER` directive → runs as root**. `HOME=/data` (persisted volume) is shared. Secrets are injected by Coolify as **env on the worker process** (`main.ts` reads `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`, `SHORTCUT_*`, `GITHUB_WEBHOOK_SECRET`, OAuth secrets directly from `process.env`). The agent is **PTY-spawned in-process by the same root worker** (`ptyManager.startLifecyclePty` → `pty.spawn($SHELL, ['-ilc', command])`), so it shares the worker's **PID namespace, network namespace, mount namespace, UID (root), and HOME**. The worker shares the `tasca` Docker network with internal Postgres `:5432`.

**This reframes #230.** The credential-isolation capstone (#230) correctly removed secrets from the agent's *own* environment, from `.git/config`, and from argv. But "the agent runs as root in the worker's namespaces" means env hygiene is only the first layer — a Bash-capable root agent reaches the worker's secrets *through the kernel*, not through its own env.

## Verdict

**The current single-tenant bar is correct and must hold.** The dominant exposures (C1, H1, H2, M2) are all closed only by **running the agent in its own user + PID + mount + network namespace** (the "Phase-2 sandbox" the #230 ADR already names). Until that ships: **trusted single-tenant repos only.** #230 was a necessary precondition (it removes the env/`.git` layer so the *sandbox* boundary becomes the single thing to get right), not the whole gate.

## Findings (ranked)

| # | Sev | Finding | Closed by |
|---|-----|---------|-----------|
| C1 | **Critical** | Agent reads the worker's `/proc/<pid>/environ` → full secret disclosure, bypassing the entire env scrub | PID+user namespace isolation |
| H1 | **High** | GitHub App **private key** (master credential) sits in the agent-reachable worker env | Credential broker (key never in agent-reachable process) |
| H2 | **High** | Concurrent dispatches let a live agent read **sibling git/gh children's** `/proc/<pid>/environ` → lift installation token + `GH_TOKEN` | Separate UID for token-bearing children / credential helper + dispatch serialization |
| M1 | **Medium** | The scrub's *await-free* invariant is load-bearing but undefended — a future vendor bump that awaits before `fork()` silently leaks the full env on the fallback path | Real-vendor fallback regression test + pre-scrubbed launcher |
| M2 | **Medium** | Unrestricted network egress (shared net ns): Postgres `:5432`, cloud metadata `169.254.169.254`, lateral, arbitrary exfil | Default-deny egress allowlist (model API + GitHub only) |
| L1 | **Low** | AES file-store key is agent-derivable on shared root HOME (latent — backend not wired on the dispatch path) | Per-agent tmpfs HOME + per-process key |
| L2 | **Low** | Login-shell `$SHELL -ilc` sources profiles into the agent (real but inert on this image — nothing writes secrets to rc files) | Dedicated unprivileged UID + empty agent HOME |
| L3 | **Low** | `redactToken` doesn't match the base64 `Authorization` form it now ships, and `open-pr` applies no redaction — token could surface in logs/audit under git trace | Broaden the redactor + apply it in `open-pr` (**fixed this pass**) |

---

### C1 — Agent reads `/proc/<worker>/environ` → full secret disclosure (Critical)

**Where:** `factory.ts` `spawnWithScrubbedEnv` + `main.ts` (secrets from `process.env`) on the root/shared-PID-ns runtime.

**Exposure.** `spawnWithScrubbedEnv` only transiently deletes non-allowlisted keys from the **worker's own** `process.env` around the synchronous spawn, restoring them in `finally` microseconds later. The worker process holds `GITHUB_APP_PRIVATE_KEY`/`DATABASE_URL`/etc. in its environ for its entire lifetime. The agent is an in-process child in the same PID namespace, running as root. A prompt-injected agent runs:

```
cat /proc/1/environ | tr '\0' '\n'      # or: grep -l . /proc/*/environ and scan the node pid
```

and reads every worker secret verbatim. The allowlist + scrub govern what the child *inherits* — not what a same-UID sibling can *read* from the parent's environ. This discloses the **GitHub App private key**, which mints installation tokens for **every** connected installation → cross-tenant compromise. *The #230 ADR residual #2 understates this as "a concurrent git child's env" — the always-present, long-lived worker environ holding the master key is the real target.*

**Isolation fix (capability-preserving).** Spawn the agent PTY in its **own PID + user + mount namespace** — a per-agent jail (`bwrap --unshare-pid --unshare-user --unshare-net …`, `nsjail`, or a per-dispatch sidecar container) under a dedicated non-root UID, with only the task worktree bind-mounted in. The agent keeps Bash/git/gh/network *inside the jail*; it simply cannot see the worker's `/proc`. Drop the worker itself off root (`USER` directive) as defense-in-depth. Pair with H1.

---

### H1 — App private key custody in the agent-reachable worker env (High)

**Where:** `main.ts` (`GITHUB_APP_PRIVATE_KEY`); minting in `repo-provisioner.ts`.

**Exposure.** Because C1 exposes the full worker environ, the agent obtains the App **private key** — the root of trust. With it an attacker self-mints installation tokens for **any** connected org/repo, at the App's full scope, indefinitely — strictly worse than leaking one ~1h scoped token. #230 kept the per-dispatch token out of `.git/config`/argv; the long-lived signing key in the same-namespace worker env is the bigger prize and is untouched.

**Isolation fix.** Move App-private-key custody into a **separate broker process/container** (own PID+mount ns, own UID) that holds the key and exposes only a narrow `mint installation token for <repoRef>` RPC over a unix socket. The worker/agent side never has the private key in its environ; the worst the agent can reach (post-namespacing) is one short-lived, repo-scoped token it already legitimately uses. Full git/gh/network capability via that scoped token.

---

### H2 — Concurrent-dispatch sibling `/proc` token theft (High)

**Where:** `server.ts` (detached, unserialized `queueMicrotask` dispatch; `repoBusy:false`) + `repo-provisioner.ts` (clone/fetch `authEnv`) + `open-pr.ts` (push `gitAuthEnv` / `gh` `GH_TOKEN`); window held open by the live agent PTY (up to `TASCA_AGENT_TIMEOUT_MS`, default 600 s).

**Exposure.** Webhook deliveries dispatch detached and unserialized; the same-repo serialization arm is disabled (`repoBusy:false`). So while dispatch A's agent is a live root Bash process for up to 10 minutes, dispatch B independently runs `git` clone/fetch (extraheader `Authorization: Basic base64(x-access-token:<token>)` in the child env), `git push` (same extraheader), and `gh pr create` (`GH_TOKEN=<token>`). All are siblings of the same root worker in the same PID namespace. The agent loops:

```
cat /proc/[0-9]*/environ 2>/dev/null | tr '\0' '\n' | grep -E 'GIT_CONFIG_VALUE_0|GH_TOKEN'
```

base64-decodes the extraheader, and recovers a **live ~1h installation token** at the App's repo scope, then exfiltrates it over its own network. The scrub bounds only the agent's *own* spawn snapshot, never a sibling's env.

**Isolation fix.** (a) Run every token-bearing `git`/`gh` child under a **dedicated unprivileged UID distinct from the agent's**, with `/proc` mounted `hidepid=2`, so their environ isn't readable by the agent; **or** (b) hold the token in a **credential-broker / `git credential.helper`** address space so it never enters a child environ at all. Independently, **serialize or namespace-separate** concurrent dispatches so a live agent never shares a PID namespace with a token-bearing child. All capability-preserving.

---

### M1 — Undefended await-free scrub invariant (Medium)

**Where:** `factory.ts` `spawnWithScrubbedEnv`; `vendor/.../ptyManager.ts` fallback (`spawn(command,{shell:true,env: mergeEnvWithNormalizedLocale(process.env, env)})` — spreads the **full** `process.env`).

**Exposure.** The scrub's safety rests entirely on `startLifecyclePty` doing **zero awaits** between scrub-start and the `fork()` that snapshots env. Today it holds (sync `require('node-pty')` + `pty.spawn`; the fallback's `child_process.spawn` is sync). The fallback is the **likely production path** (de-Electronized Node 22 often fails to load the native `node-pty` binding). The vendor is third-party and rebuilt in-image, so a future bump that makes any pre-fork step async (a sibling vendor fn already does `await import('node-pty')`) would: yield the event loop while the `finally` restores the full secret env, then fork the attacker-controlled child with `GITHUB_APP_PRIVATE_KEY`/`DATABASE_URL`/`GH_TOKEN`. No runtime guard or test pins the invariant against the *real* (non-override) vendor — every current test uses the synchronous `servicesOverride` seam.

**Isolation fix.** (a) Add a harness test that forces the real fallback (`EMDASH_DISABLE_PTY=1`) and asserts the **child's** env carries no planted secret — so a vendor regression fails CI, not production. (b) Long-term, fork a tiny **pre-scrubbed launcher child** built with an explicit clean `env` (the `env` option *replaces*, never merges, `process.env`) that `exec`s `$SHELL -ilc <command>`; the worker's `process.env` becomes irrelevant to what the agent inherits, removing the timing sensitivity. Both capability-preserving.

---

### M2 — Unrestricted network egress (Medium)

**Where:** `deploy/` (no egress controls; shared net ns); `DATABASE_URL` host on the internal `tasca` network.

**Exposure.** The agent shares the worker's network namespace with no egress filtering. It can: (1) reach the `DATABASE_URL` host `:5432` directly (it can't read the password from its *own* env, but combined with C1's `/proc` read it dumps the whole DB); (2) hit cloud/Coolify metadata `169.254.169.254` to lift instance/role credentials; (3) reach every other service on the internal `tasca` network; (4) POST harvested secrets/repo content anywhere. The agent's only *legitimate* needs are the model API (`ANTHROPIC_BASE_URL`/`api.anthropic.com`) and GitHub (`api.github.com`/`codeload.github.com`).

**Isolation fix.** Put the agent in a separate network namespace with **default-deny egress**, allowlisting only the model API and GitHub, and explicitly denying RFC1918 + link-local `169.254.0.0/16`. Implement via a per-agent netns + filtering egress proxy, a NetworkPolicy/nftables on an agent sidecar, or a pinned `HTTPS_PROXY` with a CONNECT allowlist. Model + GitHub paths stay fully open — PRs #8/#9 unaffected.

---

### L1 — AES file-store key agent-derivable on shared root HOME (Low, latent)

`secret-store.ts` derives the AES-256-GCM key from `username + hostname` + a salt stored beside the ciphertext under `$HOME/.tasca`. A same-UID root agent on the shared `HOME=/data` recomputes the key and decrypts. **Latent:** `makeSecretStore` is *not* on the coordination dispatch path (secrets are env-only; the file is never written on the worker). It goes live the moment the file backend is wired without first isolating HOME. **Fix:** per-agent tmpfs HOME (separate mount ns) + a per-process/KMS-held key, before ever enabling the file backend on the worker.

### L2 — Login-shell `-ilc` profile sourcing (Low, inert here)

`pty.spawn($SHELL, ['-ilc', command])` sources `/etc/profile` + any `~/.bashrc` into the agent after the scrub. On this image (root, fresh `/data`, no secret written to any rc file) it's theoretical — the real exposure is simply that the agent shares everything as root (C1/H2). It becomes live if a provisioning step ever writes an `export SECRET=` into a sourced file. **Fix:** the same dedicated-UID + empty per-agent HOME that closes C1/L1.

### L3 — Incomplete log redaction (Low) — **fixed this pass**

`redactToken`'s regex (`x-access-token:[^@]*@`) matches only the URL form, which the tokenless-origin design no longer produces; it does **not** match the base64 `Authorization: Basic …` form the env-auth now ships, and `open-pr` applied no redaction at all. Under git trace/verbose a failing `git`/`gh` could surface the live token into the dispatch error log + `audit_event`. Reachability is gated behind C1's `/proc` residual (the audit sink is Postgres; the log sink is the worker's fd) and a non-default debug toggle — so it's low — but it's a real defect in a security function. **Fixed:** the redactor now also scrubs the base64 `Authorization: Basic` header and `gh[ps]_…`/`github_pat_…` token forms, and `open-pr` routes its error messages through a redactor.

## Considered and dismissed (verified non-issues)

- **`getServices()` runs inside the scrub thunk → vendor mis-boots under scrubbed `EMDASH_*`.** *Refuted on reachability:* `initDb()` at boot pre-warms and caches `services` outside any scrub; the native sqlite3/keytar/node-pty loads are lazy (runtime `await import`), so the bridge module-load never throws on a native failure and never re-runs inside the scrub. A pure-JS dist failure throws deterministically (loud `ExecutionError('spawn')`), not a silent mis-boot. *(The `getServices()` hoist is still applied this pass as a defensive cleanup — it shrinks the scrub window to exactly the `startLifecyclePty` call.)*
- **`HOME=/data` retained in the allowlist → filesystem bypass.** *Refuted:* a documented, scoped residual subsumed by C1; no secret is written under `/data` on the dispatch path (tokenless `git`/`gh` config, secret-store unwired), so there's no credential file to read today.
- **Worktree `.git/config` could carry a token if a future build re-points origin with creds.** *Refuted:* the tokenless-origin invariant holds on the current diff; this is a regression-guard recommendation, not a live issue. *(Added a cheap assertion test pinning it.)*

## Remediation roadmap

**Landed this pass (cheap, capability-preserving, no infra):** L3 redaction fix (+ `open-pr` redaction); `getServices()` hoisted out of the scrub window; worktree tokenless-origin regression-guard test.

**Phase-2 sandbox — the multi-tenant gate (infra; closes C1, H1, H2, M2, L1, L2):** run each agent dispatch in a **dedicated unprivileged UID inside its own PID + user + mount + network namespace** (per-dispatch jail or sidecar), with: the worktree bind-mounted, a per-agent tmpfs HOME, default-deny egress (model API + GitHub allowlist, deny RFC1918 + link-local), and credential minting moved into a **broker** the agent can't reach (so the App private key never sits in an agent-reachable environ and token-bearing `git`/`gh` children run under a separate UID with `hidepid=2`). Add the real-vendor fallback regression test (M1). This is a deploy-topology + Dockerfile change warranting its own architect → build → on-target-verify cycle; it does not change a line of agent capability.

**Current safe-operating bar:** trusted single-tenant repos only. Do **not** enable for untrusted/multi-tenant issue authors until the Phase-2 sandbox lands.
