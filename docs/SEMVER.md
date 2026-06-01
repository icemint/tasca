# Versioning & Release Policy

Tasca is **pre-1.0**. We follow [Semantic Versioning](https://semver.org/) with the
pre-1.0 convention: `0.MINOR.PATCH`.

| Change | Bump | Example |
|---|---|---|
| New feature / capability | **minor** | `0.1.x → 0.2.0` |
| Bug fix, internal change, dep bump | **patch** | `0.1.44 → 0.1.45` |
| Breaking change (API, schema, config) | **minor** (allowed pre-1.0) — **must be called out** in the changelog and PR | `0.1.x → 0.2.0` |

A `1.0.0` is cut only when the v1 Definition of Done (PRD §14) is met and the
public surface is considered stable.

## One converged version train

Tasca ships as **one version number across the whole repo**. The app, the
multi-tenant `remote` server, the `relay-tunnel` binary, and every web package
all move together on a single `0.MINOR.PATCH` train. There are **no** separate
`remote-v*` / `relay-v*` trains.

A release moves all of these surfaces to the same number, in lockstep:

- `package.json` (root) and `npx-cli/package.json`
- every workspace crate (`crates/*/Cargo.toml` → `[package].version`)
- `crates/tauri-app/tauri.conf.json`
- the excluded sub-workspace crates `crates/remote` and `crates/relay-tunnel`
  (own `Cargo.lock`, bumped here too)
- web packages `packages/*/package.json`

Do not bump these surfaces by hand — use the helper (below) so they can never
drift apart.

## Release-tag convention

A single tag per release on `main`:

- `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v0.2.0`)

No component-specific tags.

## Bumping the version

`scripts/bump-version.mjs` rewrites every surface above in one pass:

```sh
pnpm run bump-version 0.2.0        # explicit target
pnpm run bump-version patch        # 0.1.44 -> 0.1.45
pnpm run bump-version minor        # 0.1.44 -> 0.2.0
pnpm run bump-version major        # 0.1.44 -> 1.0.0
pnpm run bump-version 0.2.0 --dry-run   # print changes, write nothing
```

After bumping crate versions, refresh the sub-workspace lockfiles so the
`--locked` CI checks stay green:

```sh
cargo update -p remote --precise <new> --manifest-path crates/remote/Cargo.toml
cargo update -p relay-tunnel --precise <new> --manifest-path crates/relay-tunnel/Cargo.toml
```

## Process (until release CI exists)

1. Update the changelog (`CHANGELOG.md`, Keep-a-Changelog format) under a new
   `## [x.y.z] - YYYY-MM-DD` section.
2. Run `pnpm run bump-version <x.y.z>` to move every surface together, then
   refresh the two sub-workspace lockfiles.
3. Commit, tag `v<x.y.z>`, and push. (Build/publish CI is **deferred** — see the
   M0 deploy issues; no secrets are wired yet.)

GitHub Release bodies are written for humans (see the release-notes convention);
`CHANGELOG.md` stays in structured Keep-a-Changelog format.
