# Tasca — Emdash De-Electron Fork: Spike Plan (v1.0)

**Status:** Proposed · **Owner:** Execution-layer architect · **Timebox:** 2–3 weeks (hard cap)
**Scope:** Stage 1 enabler (PRD §8). Fork Emdash's service layer (`src/main/core/`) into a headless,
Electron-free execution module that Tasca's coordination layer can drive over a programmatic transport.

> Context: Tasca's execution layer is a **fork of Emdash** (TypeScript/Node; PTY-spawned CLI agents,
> worktree isolation with pooling, SQLite/Drizzle, SSH/SFTP remote exec). Emdash ships **only as an
> Electron desktop app** (no headless mode), Apache-2.0. Decided stack is **TypeScript/Node everywhere**,
> one monorepo, shared types — so this fork stays in-language; there is no codegen/FFI boundary to cross.
> This document is **plan-only** (no code). It defines what to build, in what order, what to keep vs strip,
> how to maintain the fork, and the timebox + fallback + change-approach threshold from PRD §9.2.

---

## 1. Goal & Success Criteria

### 1.1 Goal (one sentence)
Run **one CLI agent (Claude Code) inside an isolated git worktree and have it open a real pull request —
headless, with no Electron runtime, no BrowserWindow, no `app.whenReady()`** — driven entirely by a Node
process that Tasca's coordination layer can spawn or call in-process.

### 1.2 Why this is the spike (not the build)
The PRD already commits to forking Emdash. The open question is **cost and feasibility of de-Electronizing
its service layer**. Emdash's `src/main/core/` was written to run inside Electron's main process; it reaches
for Electron-only APIs in a small number of well-known seams (credential storage via `safeStorage`, the PTY
transport wired to Electron IPC/renderer, native-module ABI built against Electron's Node, and the
window/`app` lifecycle as the process bootstrap). This spike **proves those seams can be cut cleanly** and
**measures the ongoing rebase tax** before we commit the fork as Tasca's permanent execution core.

### 1.3 Success criteria (binary, demoable)
The spike **passes** only if all of the following are true on a clean machine (CI Linux runner + one macOS dev box):

- **SC1 — No Electron at runtime.** The execution module starts from a plain `node` entrypoint. `electron`
  is not in the runtime dependency closure (it may remain a *transitive devDependency* of unforked upstream
  packages, but is never `require()`'d on the headless path). Verified by: process starts with `electron`
  uninstalled / unavailable on `PATH`.
- **SC2 — Worktree isolation works headless.** Given a target repo + base branch, the module reserves/creates
  an isolated git worktree (using Emdash's existing worktree+pooling logic) on a fresh checkout.
- **SC3 — One agent runs in the worktree.** A Claude Code CLI process is PTY-spawned inside that worktree via
  the **non-Electron PTY transport**, receives a task prompt, and produces a non-trivial commit (file change
  in the worktree).
- **SC4 — A PR is opened, headless.** The module drives Emdash's existing PR-creation path (push branch +
  open PR via the configured git host) and returns a live PR URL. The PR is authored under a real identity
  (a GitHub PAT/App token for the spike; native agent identity is a Stage-1 build concern, not a spike gate).
- **SC5 — Credentials resolve without `safeStorage`.** Agent/vendor and git-host secrets are read from the
  **headless secrets backend** (§2.1), not Electron's `safeStorage`. Verified by: run with `safeStorage`
  unavailable and confirm secrets still resolve.
- **SC6 — Native DB works on Node ABI.** `better-sqlite3` (or the spike's DB path) is loaded against the
  **Node ABI**, not Electron's, OR the run uses `EMDASH_DISABLE_NATIVE_DB` + `EMDASH_DB_FILE` cleanly. The
  module persists agent/run state to a SQLite file at a configured path and reloads it on restart.
- **SC7 — Driveable programmatically.** The whole flow (reserve worktree → spawn agent → stream output →
  open PR) is invoked by a single async call / CLI command with structured input and a structured result —
  no human clicking, no UI. Output (PTY stream, lifecycle state) is observable over the chosen transport.

### 1.4 Explicit non-goals for the spike
Not in scope (these are **Stage 1+ build**, deliberately excluded to protect the timebox):
- Native agent identities (Shortcut agent-user, GitHub App `[bot]`, Linear `actor=app`). Spike uses a plain token.
- The routing engine, tier estimation, atomic claim, concurrency limits.
- Any adapter (Shortcut/GitHub/Linear webhook intake). The spike is triggered by a local CLI call.
- Multi-agent concurrency, same-repo serialization, escalation breaker.
- Multi-vendor (OpenAI/local). Claude Code only.
- SSH/SFTP remote execution (keep the code; do not exercise it as a spike gate — see §3).
- The web UI / dashboard.
- Production secrets management (KMS/Vault). Spike uses the simplest backend that satisfies SC5 (§2.1).

---

## 2. Ordered De-Electron Task List

Tasks are ordered so each unblocks the next and so we **hit the riskiest seam first** (PTY transport and
native ABI are where Electron coupling is deepest and most likely to blow the timebox). Each task lists its
**done-when** signal.

> Lever throughout: Emdash already exposes env flags to neuter subsystems —
> **`EMDASH_DISABLE_PTY`**, **`EMDASH_DISABLE_NATIVE_DB`**, **`EMDASH_DB_FILE`**. Use these to bring the
> module up in stages (DB off, PTY off → then turn each on) so we isolate which seam is failing.

### Task 0 — Fork, pin, and stand up the headless workspace (Day 1)
- Fork `emdash` at a **specific upstream commit/tag** (record the SHA; prefer a release tag ≥ the Apache-2.0
  relicense, PR #1691 / v0.4.48, so the license is clean — confirm during this task). Vendor it into the Tasca
  monorepo as the **`@tasca/execution`** package (`packages/execution/`), tracked with a pinned upstream remote.
- Stand up a throwaway **`headless-smoke` entrypoint** (a `node` script) that does nothing but import the core
  module and exit 0. This is the canary: the moment an import pulls in `electron`, it fails here.
- Inventory every `import`/`require` of `electron` and every Electron-only global (`app`, `BrowserWindow`,
  `ipcMain`, `safeStorage`, `webContents`, `dialog`, `Menu`, `shell`) in `src/main/core/` and its transitive
  in-repo imports. Produce the **seam map** (this drives Tasks 1–4).
- **Done when:** seam map exists; `headless-smoke` runs under `node` and lists every Electron touchpoint it hit.

### Task 1 — Non-Electron PTY transport (highest risk — do first) (Days 2–4)
- Emdash spawns CLI agents over a PTY (`node-pty`) and currently bridges PTY I/O to the **renderer via Electron
  IPC** (`webContents`/`ipcMain`). Replace that bridge with a transport that has no Electron dependency:
  - **Primary: in-process / stdio.** Since the coordination layer is also Node, the simplest headless transport
    is a direct in-process EventEmitter/stream API (caller subscribes to PTY `data`/`exit`). Add a **WebSocket**
    framing on top only if/when remote observability is needed.
  - Define a small transport interface (`onData`, `onExit`, `write`, `resize`, `kill`) so the IPC bridge becomes
    one implementation and the headless stream becomes another. Keep `node-pty` itself — only the *delivery*
    of its bytes changes.
- Validate `node-pty` builds/loads on the Node ABI (it is a native module — see Task 3; resolve jointly).
- Use `EMDASH_DISABLE_PTY` to bring the rest of the system up first, then enable PTY and prove a real spawn.
- **Done when:** a Claude Code (or `bash -lc 'echo hi'` as a pre-test) PTY session spawns from a `node`
  process, streams stdout to the caller, and exits cleanly — zero Electron on the path.

### Task 2 — Headless secrets backend (replace `safeStorage`) (Days 4–5)
- Emdash stores credentials (vendor API keys, git-host tokens) via Electron **`safeStorage`** (OS-keychain
  encryption). Define a **`SecretStore` interface** (`get(key)`, `set(key, val)`, `delete(key)`, `list()`) and
  provide a headless implementation. For the spike, the bar is "satisfies SC5 without `safeStorage`":
  - **Spike backend:** environment variables + an optional encrypted file (e.g. libsodium/`age`-style or a
    keyring lib like `keytar`-free alternative) at a path from config. Simplest thing that is not plaintext
    in the repo.
  - **Design the interface so production backends drop in later** (OS keychain on a workstation, KMS/Vault/
    cloud secret manager in the coordination layer). The spike does not build those — it proves the seam.
- Route every `safeStorage` call site through `SecretStore`.
- **Done when:** vendor key + git token resolve from the headless store with `safeStorage` unavailable (SC5).

### Task 3 — Rebuild native modules for the Node ABI (`better-sqlite3`, `node-pty`) (Days 5–6, overlaps 1–2)
- Emdash's native modules (`better-sqlite3`, `node-pty`) are built against **Electron's Node ABI** in the
  upstream app. Headless runs on **system Node**, a different ABI — prebuilt/Electron-targeted binaries will
  fail to load. Resolve:
  - Pin a **single Node version** for the execution module (record it; this becomes the runtime contract).
  - Rebuild native modules against that Node ABI (`npm rebuild` / `node-gyp` against system Node, not
    `electron-rebuild`). Capture the exact build steps as the reproducible recipe.
  - Provide the **escape hatch:** `EMDASH_DISABLE_NATIVE_DB` + `EMDASH_DB_FILE` lets us run the DB path
    without the native binding if `better-sqlite3` resists the ABI rebuild within the timebox — fall back to
    a pure-JS or file-backed store to keep the spike moving, and log it as a known follow-up.
- **Done when:** `better-sqlite3` loads and round-trips a row under system Node (SC6), **or** the disable-flag
  path is proven and documented as the interim. `node-pty` loads (shared with Task 1).

### Task 4 — Headless bootstrap (replace the Electron window/lifecycle) (Days 6–7)
- Replace Emdash's Electron bootstrap (`app.whenReady()` → create `BrowserWindow` → wire IPC) with a plain
  **headless bootstrap**: a `main()` that initializes config, the `SecretStore`, the DB, the worktree manager,
  and the PTY transport, then exposes the programmatic entrypoint (SC7). No `app`, no window, no menu, no
  `shell.openExternal`, no `dialog`.
- Audit lifecycle hooks Emdash hung off Electron events (`will-quit`, `window-all-closed`, power/suspend) and
  re-home the ones that matter (graceful PTY kill, DB flush, worktree release) onto Node process signals
  (`SIGINT`/`SIGTERM`, `process.on('exit')`).
- Define the **config surface** (repo path, base branch, agent CLI selection, secret-store path, DB file path)
  as structured input — env + a config object — so the coordination layer drives it deterministically.
- **Done when:** `node packages/execution/headless.js <config>` boots the full module with no Electron.

### Task 5 — Wire the end-to-end happy path & prove it (Days 8–10)
- Compose the above into the single driveable flow (SC7): **reserve/create worktree (SC2) → PTY-spawn Claude
  Code in it (SC3) → agent edits + commits → push branch + open PR (SC4) → return PR URL + final state**.
- Persist run/agent lifecycle state (Created→Running→Awaiting Input→Completed/Failed, per PRD §4 Operator!
  pattern) to SQLite so a restart can read it back (SC6).
- **Done when:** SC1–SC7 all green on the CI Linux runner and one macOS dev box; PR URL produced from a `node`
  invocation; demo recorded.

### Task 6 — Measure the rebase tax (runs in background across the whole spike) (continuous)
- After the fork is pinned (Task 0), **track upstream** without merging: periodically diff upstream `main`
  against the pinned SHA and **classify churn that touches our seams** (`src/main/core/`, PTY bridge, secrets,
  bootstrap, native-module config). Record: # of upstream commits/week touching seam files, and an estimate of
  merge-conflict effort.
- This feeds the §5 change-approach threshold decision. **Done when:** we have a 2–3 week churn sample and a
  go/no-go recommendation on tracking upstream vs. vendoring a hard fork.

---

## 3. Keep vs Strip (from the fork)

The forking principle: **keep everything that is execution logic; strip only the Electron shell and the
desktop-UI surface.** Do not reimplement what Emdash already solved.

### KEEP (the reason we forked — port headless, do not rewrite)
- **Worktree isolation + pooling** (reserve worktrees) — core of SC2; Emdash's hardest-won logic.
- **PTY agent spawning + the CLI-agent registry** (the 27-agent abstraction). Keep the spawn machinery and
  registry even though the spike exercises only Claude Code — multi-vendor (Stage 3) reuses it untouched.
- **SQLite/Drizzle schema + storage layer** — state persistence; only the ABI/build target changes (Task 3).
- **PR creation, diff review, CI/CD check plumbing** — SC4 and Stage 2's PR/review loop ride on this.
- **Ticket-intake / work-order lifecycle scaffolding** (Operator! pattern, PRD §4) — even if the spike triggers
  via CLI, keep the lifecycle state machine; adapters plug into it in Stage 1+.
- **SSH/SFTP remote-execution code** — *keep in the tree, do not exercise as a spike gate.* It aligns with
  the PRD's host-side execution model (§7) and is expensive to rebuild later. Leaving it dormant costs nothing.
- **tmux persistence, MCP sync** — keep; low coupling to Electron, useful later.
- **The env-flag neutering machinery** (`EMDASH_DISABLE_*`, `EMDASH_DB_FILE`) — these are our staging levers;
  keep and lean on them.

### STRIP (Electron shell + desktop UI — dead weight headless)
- **The entire renderer / React desktop UI** (Emdash's own app windows, settings screens, diff viewer UI).
  Tasca's UI is a separate web app in this monorepo; the execution core is headless and UI-less.
- **Electron main-process bootstrap** — `app`, `BrowserWindow`, `Menu`, `Tray`, `dialog`, `shell`,
  `autoUpdater`, `webContents`, `ipcMain`/`ipcRenderer` bridges. Replaced by Task 4 + Task 1.
- **`safeStorage`** credential path — replaced by `SecretStore` (Task 2).
- **Electron-specific build/packaging** (electron-builder, code signing, notarization, app icons,
  auto-update feeds). Our packaging target is a Node service/container, not a `.app`/`.exe`.
- **`electron-rebuild`** and Electron-ABI native binaries — replaced by Node-ABI rebuilds (Task 3).
- Any **Electron-only IPC contracts** that exist purely to talk to the renderer.

### DEFER / FLAG (decide during the spike, don't block on it)
- Telemetry/analytics wired to the desktop app — strip the Electron coupling; re-home only if Tasca wants it.
- Settings/preferences that assumed a UI — fold the few that matter into the §2.4 config surface.

---

## 4. Fork-Maintenance Strategy

The PRD calls Emdash-without-headless-mode a **fork, not a library integration** (§4) and says to **pin the
fork to control rebase cost** (§4). Strategy:

- **Pin to a specific upstream SHA/tag** (Task 0); never float on upstream `main`. The pin is recorded in the
  package and in this doc's changelog so the fork point is auditable.
- **Track, don't merge, by default.** Keep an `upstream` remote and watch it (Task 6), but only pull in
  upstream changes deliberately, when there's a concrete reason (a bug fix or a new CLI agent we want).
- **Isolate our changes in seam-local files.** Where possible, our de-Electron edits live behind interfaces
  (`SecretStore`, the PTY transport interface, the bootstrap) so upstream changes to *execution logic* merge
  cleanly and only *seam* changes conflict. The narrower our diff against upstream, the cheaper the rebase.
- **Quantify rebase cost continuously** (Task 6): commits/week touching our seam files, and observed conflict
  effort when we trial-merge. This number is the input to §5's threshold.
- **Two long-term postures, chosen by the §5 threshold:**
  1. **Soft fork (track upstream):** periodic rebases onto newer pins; we keep getting new CLI agents and fixes
     "for free" minus merge effort. Preferred *if* seam churn stays low.
  2. **Hard fork (vendor + stop tracking):** snapshot the pinned fork as owned Tasca code, stop rebasing,
     cherry-pick only specific upstream fixes by hand. Chosen *if* rebase cost exceeds the value (§5).
- **License hygiene:** Apache-2.0 (post-relicense) — preserve `NOTICE`/`LICENSE`, attribute the fork, and keep
  our modifications dated. Confirm the pinned SHA is at/after the relicense commit (Task 0).

---

## 5. Timebox, Fallback & Change-Approach Threshold

### 5.1 Timebox
**2–3 weeks, hard cap** (PRD §9.2). Week 1: Tasks 0–4 (cut every Electron seam). Week 2: Task 5 (wire + prove
SC1–SC7). Buffer (into week 3 only if needed): hardening, the macOS/Linux parity pass, and the Task 6 churn
sample. **Mid-spike checkpoint at end of week 1:** if the PTY transport (Task 1) and native ABI (Task 3) — the
two deepest seams — are not both green by then, trigger the fallback decision early rather than burning week 2.

### 5.2 Fallback (if the de-Electron spike overruns)
Per PRD §9.2: **fall back to reimplementing only worktree + PTY.** Concretely, if cutting Emdash's Electron
seams proves too entangled to finish in the timebox, abandon the fork's *shell-coupled* parts and build a
**minimal headless harness in TS/Node** that does only:
1. git worktree create/reserve/release (shell out to `git worktree`),
2. PTY-spawn one CLI agent in the worktree (`node-pty` directly),
3. push branch + open PR (git host API).

We **keep Emdash as a reference** for the worktree-pooling and PR logic even in the fallback — we copy the
hard-won patterns, not the Electron scaffolding. This sacrifices the 27-agent registry, SSH remote exec, diff
review, and MCP sync (rebuildable later) but unblocks Stage 1 end-to-end on schedule.

### 5.3 Change-approach threshold (explicit)
Per PRD §9.2: **if upstream churn makes rebasing cost more than the saved reimplementation, vendor a pinned
fork and stop tracking upstream.** Operationalized:

- **Trigger to hard-fork:** when the measured rebase tax (Task 6) — the recurring effort to merge upstream onto
  our seams — exceeds the one-time effort we'd save by *not* having to reimplement those subsystems ourselves.
  In practice: if seam-touching upstream churn is high *and* each rebase costs more than a few days, the
  "free upgrades" are not free — stop tracking, snapshot the fork, cherry-pick by hand (§4 posture 2).
- **Trigger to fallback (reimplement worktree+PTY):** the spike itself overruns the 2–3 week cap with the deep
  seams (PTY transport, native ABI, bootstrap) still red at the week-1 checkpoint.
- **Default if both are fine:** soft fork, track upstream, periodic deliberate rebases (§4 posture 1).

---

## 6. Risks & Open Questions

### 6.1 Risks (with mitigations)
- **R1 — PTY transport is more Electron-entangled than expected.** Emdash's PTY I/O may be threaded through
  renderer IPC in more places than the seam map predicts. *Mitigation:* tackle it first (Task 1); the interface
  abstraction limits blast radius; the §5.2 fallback reimplements exactly this if it explodes.
- **R2 — Native ABI rebuild fights us** (`better-sqlite3`/`node-pty` against system Node across macOS + Linux).
  *Mitigation:* pin one Node version; `EMDASH_DISABLE_NATIVE_DB` + `EMDASH_DB_FILE` is the documented escape
  hatch so DB pain can't block the whole spike.
- **R3 — Hidden Electron dependencies** beyond the four known seams (e.g. `shell.openExternal` for the PR URL,
  `dialog` in an error path). *Mitigation:* the `headless-smoke` canary (Task 0) surfaces them at import time;
  re-home or strip case by case.
- **R4 — High upstream churn** makes the soft fork uneconomical sooner than hoped. *Mitigation:* Task 6 measures
  it; §5.3 threshold converts the measurement into a hard-fork decision instead of letting it fester.
- **R5 — Timebox pressure tempts scope creep** (adding identity/routing/adapters into the spike). *Mitigation:*
  §1.4 non-goals are explicit; the spike gate is SC1–SC7 only.
- **R6 — macOS/Linux parity** (native builds, keychain availability) diverges. *Mitigation:* prove on both a CI
  Linux runner and one macOS dev box (SC criteria) before declaring pass.

### 6.2 Open questions (resolve during the spike)
- **Q1 — Exact pinned SHA/tag.** Which release is the safest fork point at/after the Apache-2.0 relicense
  (PR #1691 / v0.4.48)? Confirm license + that the seam code is present at that tag (Task 0).
- **Q2 — Transport choice for observability.** Is in-process/stdio sufficient for Stage 1 (coordination layer
  is also Node), or do we want WebSocket framing now for remote/streamed observability? Default: in-process for
  the spike, leave the WebSocket impl as a thin follow-on.
- **Q3 — Secrets backend for the spike.** Env-vars-only vs. encrypted file — which clears SC5 with least effort
  while leaving a clean seam for the production KMS/Vault backend? (Interface fixed now; backend swappable.)
- **Q4 — How much of the lifecycle/DB schema to bring up** for the spike vs. defer. Minimum to satisfy SC6 +
  the Operator! state machine; rest deferred.
- **Q5 — node-pty + better-sqlite3 single Node version** that satisfies both native modules cleanly — pin it
  and make it the runtime contract.
- **Q6 — Does Emdash's PR-creation path assume Electron** anywhere (e.g. opening the URL via `shell`)? If so,
  swap for a returned URL string (we don't open browsers headless).

---

## 7. Deliverables of the Spike
1. The pinned, vendored fork in the monorepo (`packages/execution`, `@tasca/execution`) with the fork SHA recorded.
2. A headless entrypoint demonstrating SC1–SC7 (worktree → Claude Code → PR), runnable from `node` on Linux + macOS.
3. The **seam map** (every Electron touchpoint and how it was cut).
4. The **native-module rebuild recipe** (Node version + build steps), reproducible in CI.
5. A **rebase-tax report** (Task 6) + a go/no-go recommendation: soft fork vs. hard fork (§5.3).
6. A short demo recording of a PR opened end-to-end, headless.
