# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/) (see [docs/SEMVER.md](docs/SEMVER.md)).

## [Unreleased]

### Added
- Architecture discovery (`DISCOVERY.md`) and egress-severance audit (`CUTOUT.md`).
- `NOTICE` attribution for the upstream Vibe Kanban (BloopAI), Apache-2.0.
- Secret-free PR-validation CI (`.github/workflows/ci.yml`) and Dependabot config.
- Product requirements (`docs/PRD.md`) and milestone roadmap (`docs/ROADMAP.md`).

### Changed
- Rebranded the entire project to **Tasca** (`tasca.dev`, `github.com/icemint/tasca`):
  Tauri identifier, ProjectDirs, env prefixes (`TASCA_*`), SPAKE2 IDs, binary
  names, assets, and the `utils::observability` (ex-`sentry`) shim.

### Removed
- All upstream BloopAI/Vibe Kanban outbound egress, telemetry (PostHog/Sentry/
  OpenTelemetry), auto-update machinery, the private billing crate, QA-repo
  integrations, and all upstream GitHub Actions workflows.

[Unreleased]: https://github.com/icemint/tasca/commits/main
