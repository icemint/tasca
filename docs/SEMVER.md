# Versioning & Release Policy

Tasca is **pre-1.0**. We follow [Semantic Versioning](https://semver.org/) with the
pre-1.0 convention: `0.MINOR.PATCH`.

| Change | Bump | Example |
|---|---|---|
| New feature / capability | **minor** | `0.1.x → 0.2.0` |
| Bug fix, internal change, dep bump | **patch** | `0.1.4 → 0.1.5` |
| Breaking change (API, schema, config) | **minor** (allowed pre-1.0) — **must be called out** in the changelog and PR | `0.1.x → 0.2.0` |

A `1.0.0` is cut only when the v1 Definition of Done (PRD §14) is met and the
public surface is considered stable.

## Version surfaces

A release touches several files that must move together for the **app** train:

- `package.json` (root)
- `npx-cli/package.json`
- workspace crates (`Cargo.toml` versions) + `crates/tauri-app/tauri.conf.json`
- web packages `packages/*/package.json`

**Independently versioned** (their own release cadence, not part of the app bump):

- `crates/remote` (currently `0.1.27`) — the multi-tenant server
- `crates/relay-tunnel` (`0.1.7`) — standalone relay binary
- `crates/server-info` / `client-info` / `remote-info` metadata crates

> **Open decision (DevOps):** converge everything to one number at the next
> release, or keep `remote`/`relay-tunnel` on independent trains with namespaced
> tags (`remote-v*`, `relay-v*`). Until decided, the app train uses `v0.x.y` and
> the others bump independently.

## Release-tag convention

- App: `v<MAJOR>.<MINOR>.<PATCH>` (e.g. `v0.2.0`) on `main`.
- Remote server: `remote-v<x.y.z>` (matches the upstream `remote-*` tag filter).
- Relay: `relay-v<x.y.z>`.

## Process (until release CI exists)

1. Update the changelog (`CHANGELOG.md`, Keep-a-Changelog format) under a new
   `## [x.y.z] - YYYY-MM-DD` section.
2. Bump the version surfaces for the relevant train (a `scripts/bump-version`
   helper is a Phase-0 issue).
3. Tag and push. (Build/publish CI is **deferred** — see the M0 deploy issues;
   no secrets are wired yet.)

GitHub Release bodies are written for humans (see the release-notes convention);
`CHANGELOG.md` stays in structured Keep-a-Changelog format.
