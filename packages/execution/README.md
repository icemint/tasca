# @tasca/execution

The headless, **Electron-free** execution core for Tasca. A soft-fork **overlay**
over the [Emdash](https://github.com/generalaction/emdash) execution core: worktree
pool, PTY-spawn of an agent command, run lifecycle, PR creation, and a local
SQLite/Drizzle store — all running under plain `node`, no Electron runtime.

It exposes a clean **`ExecutionPort`** and a `createExecution()` factory. Per the
Stage-1 package boundary it may import only `@tasca/domain` / `@tasca/contracts`
and must **not** import routing / adapters / coordination — but it currently needs
neither and declares no `@tasca/*` runtime dependency.

## Overlay shape (zero upstream edits)

Upstream Emdash is vendored **verbatim** as a pinned git submodule and never
modified. The entire de-Electron cut is an additive overlay under `src/`:

```
packages/execution/
├─ vendor/emdash/            # git submodule, pinned to v0.4.48
│                            #   (commit 67ab3a86f7469f4a91200dadf50293b4be3d90d9)
├─ src/
│  ├─ port.ts               # the typed ExecutionPort interface + DTOs
│  ├─ factory.ts            # createExecution() — wires the vendored services
│  ├─ secret-store.ts       # SecretStore: env → keytar → AES-256-GCM file
│  ├─ open-pr.ts            # git push + gh pr create (lifted from gitIpc.ts; pure shell)
│  ├─ index.ts              # public barrel
│  └─ runtime/
│     ├─ electron-stub.cjs  # headless `electron` replacement (non-UI surface only)
│     ├─ bootstrap.cjs      # @shared/* + @/* aliases + require('electron')→stub hook
│     └─ vendor-bridge.cjs  # loads the compiled vendor services behind the shim
├─ scripts/build-vendor.mjs # the native-rebuild recipe → dist/main
├─ harness/headless-boot.mjs# proves SC1/SC2/SC3-trivial/SC5/SC6 (exit 0)
├─ NOTICE                    # Apache-2.0 attribution for the vendored fork
└─ README.md
```

Why no source edits are needed: the vendored services already expose
Electron-free seams. `ptyManager.startLifecyclePty` *is* the transport
(`onData`/`onExit` callbacks, no IPC); `db/path.ts` honors `EMDASH_DB_FILE`
before touching `app`; `drizzleClient` takes an injectable `filePath`. The only
reason the stub must exist is that the compiled main modules `require('electron')`
**eagerly** at import time — and under Node the real package *throws* (no binary).

## The ExecutionPort

```ts
import { createExecution } from '@tasca/execution';

const exec = createExecution({ dbFile, userDataDir });
await exec.initDb();                                  // sqlite3 + Drizzle migrations
const wt = await exec.reserveWorktree({ repoPath, taskLabel, projectId, baseRef });
const proc = exec.spawnAgent({ id, command, cwd: wt.path });
proc.onData((chunk) => …); proc.onExit((code) => …);
const { url } = await exec.openPr({ cwd: wt.path, branch: wt.branch, title, body });
await exec.close();
```

Secrets resolve via `makeSecretStore()` (`env → keytar → AES-256-GCM file`); there
is **no Electron `safeStorage`**. The `mod.default ?? mod` keytar ESM
normalization (spike §4.1) lives in `secret-store.ts`.

## Build (the native-rebuild recipe)

`createExecution()` needs the vendored `dist/main` build plus three native
modules (`node-pty`, `keytar`, `sqlite3`) compiled against the Node 22 ABI.
`scripts/build-vendor.mjs` bakes the proven recipe:

```bash
# requires Python 3.11 (3.12+ removed distutils → node-gyp fails)
uv python install 3.11
node packages/execution/scripts/build-vendor.mjs
```

Steps it runs, in order:

1. `pnpm install --ignore-scripts` with `EMDASH_SKIP_ELECTRON_REBUILD=1` and
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. `--ignore-scripts` is load-bearing: it
   stops pnpm running the native modules' own `node-gyp rebuild` during install
   under the system Python (which is 3.12+ and fails on missing `distutils`).
2. Per-module `node-gyp rebuild` for `node-pty` + `keytar` with **Python 3.11**.
3. `prebuild-install -r napi` for `sqlite3` (N-API prebuilt; no Xcode needed).
4. `pnpm run build:main` → `vendor/emdash/dist/main`.

> `pnpm rebuild <mods>` is unreliable here (exits 0, builds nothing) — the recipe
> drives each module's `node-gyp` / `prebuild-install` directly.

The build is heavy; it is **not** wired into the normal `ci.yml`. It runs only in
the dedicated `.github/workflows/spike-headless-boot.yml` (matrix
ubuntu-24.04 + macos-14, Python 3.11 pinned).

## Success criteria

The harness (`node harness/headless-boot.mjs`, exit 0) proves, through the
`ExecutionPort`:

| SC | What it proves | Status |
|----|----------------|--------|
| **SC1** | No Electron at runtime (`process.versions.electron` undefined; real binary absent) | proven (harness) |
| **SC2** | Worktree isolation headless (`reserveWorktree`) | proven (harness) |
| **SC3 (trivial)** | PTY-spawn a command in the worktree (`spawnAgent`) | proven (harness) |
| **SC5** | Secrets without `safeStorage` (`makeSecretStore`) | proven (harness) |
| **SC6** | Native SQLite under Node ABI + Drizzle migrations (`initDb`) | proven (harness) |
| **SC3 (real agent)** | Real Claude Code CLI run on the same transport | **gated** — needs `ANTHROPIC_API_KEY` |
| **SC4 (real PR)** | A live PR via `openPr` (`git push` + `gh pr create`) | **gated** — needs `SPIKE_GH_TOKEN` + a target repo |

### How SC1–7 close with credentials

SC1/SC2/SC3-trivial/SC5/SC6 close on every green run of the headless harness — no
credentials required. The two remaining criteria are **pure shell, no Electron**,
and the seams already exist:

- **SC3 (real agent):** put the Claude Code CLI on `PATH`, provide
  `ANTHROPIC_API_KEY` (via `SecretStore`), and pass the provider CLI argv as the
  `spawnAgent({ command })` — same PTY transport.
- **SC4 (real PR):** authenticate `gh` with `SPIKE_GH_TOKEN` (`repo` + PR scopes)
  against `SPIKE_TARGET_REPO` (e.g. `roadhero/agentic-playground`); `openPr()`
  runs `git push -u` then `gh pr create` and returns the PR URL.

The `spike-sc1-7` job in the workflow is the (unrun) stub wired to take exactly
those three secrets — adding them flips it on with no code change.
