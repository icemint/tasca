# Tasca — Emdash De-Electron Spike: Result (v1.0)

**Date:** 2026-06-06 · **Verdict: PASS** (headless-boot milestone) · **Companion:** [`Tasca-Spike-Emdash-De-Electron-v1.0.md`](Tasca-Spike-Emdash-De-Electron-v1.0.md) (the plan).
**Upstream:** `generalaction/emdash` @ tag **v0.4.48** (`67ab3a86…`), Apache-2.0.

## Bottom line

**The headless de-Electron fork works.** Emdash's execution core boots under plain `node` with **no Electron runtime**, PTY-spawns a process inside an **isolated git worktree**, persists state to **native sqlite**, and resolves secrets via **keytar (OS keychain), no `safeStorage`** — proven by a single reproducible harness (`node spike/headless-spike.mjs`, exit 0, run twice). The riskiest question ("can Emdash run headless?") is answered **yes**.

Critically, the cut required **zero edits to upstream source** — it is a purely **additive shim layer**, the narrowest possible diff, so upstream rebases can't conflict on the seam (early read: **soft fork**).

## Per-SC result

| SC | Result | Evidence |
|----|--------|----------|
| **SC1 — No Electron at runtime** | **PASS** | `process.versions.electron` undefined; the real `electron` package throws under node (binary absent) → genuinely unavailable, not merely unused; core imports via a headless stub. |
| **SC2 — Worktree isolation** | **PASS** | `WorktreeService.createWorktree` made an isolated worktree on branch `emdash/spike-task-XXX` off a throwaway repo (`git worktree list`). |
| **SC3 — PTY (trivial command)** | **PASS** | `ptyManager.startLifecyclePty` ran a commit in the worktree; stdout streamed via `onData`; `onExit` code 0; `spike.txt` committed. Real `node-pty`, no Electron transport. |
| **SC5 — Secrets without safeStorage** | **PASS** | `SecretStore` round-tripped via real keytar (Keychain) headless; `safeStorage.isEncryptionAvailable()===false` (inert stub). Env + AES-256-GCM file fallback also built. |
| **SC6 — Native DB headless** | **PASS** | `sqlite3` (N-API prebuilt) under Node 22; real Drizzle migrations applied to `EMDASH_DB_FILE`; row persisted and **reloaded from a fresh DB client**. |
| **SC3 (real Claude Code agent)** | **BLOCKED (resource)** | Needs the Claude Code CLI + `ANTHROPIC_API_KEY`. Not a de-Electron blocker. |
| **SC4 (real PR)** | **BLOCKED (resource)** | Needs a GitHub remote + `gh`/PAT with repo+PR scopes. Not a de-Electron blocker. |

## Reproducible native-rebuild recipe (the one GO-WITH-RISK item — resolved)

```bash
git clone --depth 1 --branch v0.4.48 https://github.com/generalaction/emdash.git && cd emdash
corepack prepare pnpm@10.28.2 --activate
EMDASH_SKIP_ELECTRON_REBUILD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1 pnpm install
uv python install 3.11 && PY=$(uv python find 3.11)   # Python 3.12+ removed distutils → node-gyp fails
( cd node_modules/node-pty && PYTHON=$PY npm_config_python=$PY ../.bin/node-gyp rebuild )
( cd node_modules/keytar  && PYTHON=$PY npm_config_python=$PY ../.bin/node-gyp rebuild )
( cd node_modules/sqlite3 && ../.bin/prebuild-install -r napi )   # N-API prebuilt; no Xcode needed
pnpm run build:main && node spike/headless-spike.mjs
```

- `node-pty 1.0.0` + `keytar 7.9.0` are classic **node-gyp** → compile against Node 22 ABI with **Python 3.11**.
- `sqlite3 5.1.7` is **N-API** → ABI-stable **prebuilt** via `prebuild-install -r napi` (sidesteps `xcodebuild`).
- `pnpm rebuild <mods>` is unreliable (exits 0, builds nothing) — use **per-module** `node-gyp`/`prebuild-install`.

## The seam cut (additive overlay — zero upstream edits)

| Shim | Seam | Cuts |
|------|------|------|
| `electron-stub.cjs` | D (bootstrap) | Headless `electron` replacement — provides the non-UI surface used headless (`app.getPath/getVersion/isPackaged`), inert/loud stubs for `BrowserWindow`/`ipcMain`/`dialog`/`safeStorage`/`webContents` (never on the headless path). |
| `bootstrap.cjs` | D | `@shared/*`/`@/*` aliases (per upstream `entry.js`) + one `Module._resolveFilename` hook routing `require('electron')` → the stub. |
| `secret-store.mjs` | B | `SecretStore {get,set,delete,list}` — env → **keytar** → AES-256-GCM file. Production KMS/Vault drops in behind it. |
| `headless-spike.mjs` | A + C | The headless `main()`: PTY via `ptyManager.startLifecyclePty` (Emdash's existing callback transport, zero IPC) + DB via `DatabaseService`/`createDrizzleClient({filePath})` driven by `EMDASH_DB_FILE`. |

**Why no source edits:** the KEEP services already expose Electron-free seams — `startLifecyclePty` *is* the transport (its lone `app.getPath` touchpoint is lazy), `AccountCredentialStore` already wraps keytar (no safeStorage), `drizzleClient` takes an injectable `filePath`, and `db/path.ts` honors `EMDASH_DB_FILE` before touching `app`.

## §4.1 corrections to the plan (no showstoppers)

1. **`import { app } from 'electron'` *throws* at import under node** (binary absent) — it does **not** silently no-op. So the eager imports in `errorTracking`/`telemetry`/`settings`/`db/path` are hard import-time crashes; the `appInfo`/electron shim is **mandatory** for the import graph, not optional. (Same fix as planned, higher priority.)
2. **ESM keytar interop:** under `await import('keytar')` only `getPassword` is a named export; the rest live on `.default`. Emdash works because its compiled output is CommonJS — **a native-ESM port must normalize `mod.default ?? mod`**.

## What closes SC3-real-agent + SC4-real-PR (both pure shell, no Electron)

- **SC3 real agent:** Claude Code CLI on PATH + `ANTHROPIC_API_KEY` (via the proven `SecretStore`); swap the trivial command for `ptyManager.buildProviderCliArgs('claude')` argv on the same transport.
- **SC4 real PR:** a GitHub remote + authenticated `gh`/PAT (`repo`+PR scopes); the mechanism is `gitIpc.ts` → `git push -u origin <branch>` then `gh pr create --fill` (PR URL from stdout) — lift it out of the IPC handler into a plain callable.

## Vendor readiness

**Ready to vendor into `@tasca/execution`.** The overlay shape is correct (soft-fork-friendly). The vendoring step should: bake the native-rebuild recipe into CI, produce the `dist/main` build artifact, and decide whether to upstream the `appInfo` shim as a thin PR vs. keep the overlay. A full 2–3 wk rebase-tax sample (plan Task 6) remains the recommended follow-on before the soft-vs-hard-fork call — but the seam-conflict surface against upstream is currently **empty**.
