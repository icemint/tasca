# CUTOUT — Severing BloopAI / Vibe Kanban egress, telemetry & update-checking

> Read-only audit. Nothing was modified. Goal: catalogue everything that must be **removed or severed** so this fork makes **zero outbound connections to BloopAI/VK infrastructure** and ships **no telemetry/analytics/update-checking**.
> Date 2026-06-01, branch `main` @ `4deb7eca8` (v0.1.44). Citations are `file:line`, verified directly unless noted. "NOT FOUND" = searched, absent.
>
> **Legend (per item):** DELETE = remove code/feature outright · SEVER = cut the connection (the feature may stay, the egress goes) · REPOINT = make it ours/configurable, no BloopAI default · KEEP = generic, self-hostable, no BloopAI egress.

---

## 1. Outbound calls to BloopAI / VK infrastructure

### 1a. Release/update check → `api.github.com/repos/BloopAI/...` — **DELETE or REPOINT**
- `crates/server/src/routes/releases.rs:14` — `const GITHUB_API_URL: &str = "https://api.github.com/repos/BloopAI/vibe-kanban/releases";` (verified; call site `:105` `.get(GITHUB_API_URL)`, 15-min cache).
- **What/connects:** `/releases` route fetches BloopAI's GitHub releases; consumed by the frontend "update available" banner (see §3). Active outbound HTTP.
- **Action:** Either delete the route + `fetch_releases`/`get_releases` and the frontend banner that calls it, or replace the const with an env-configured URL pointing at *your* repo (no BloopAI default). Hardcoded, not env-configurable today.
- **Blast radius:** Frontend update banner stops; `/releases` consumers 404. No core flow depends on it.

### 1b. Review CLI cloud default → `api.vibekanban.com` — **REPOINT (or DELETE feature)**
- `crates/review/src/main.rs:21` — `const DEFAULT_API_URL: &str = "https://api.vibekanban.com";` (verified). Used as the default for `--api-url` / `REVIEW_API_URL` (`:50`).
- **What/connects:** The `review` CLI uploads repo archives to VK's cloud for AI review. **Sends your code to BloopAI by default.**
- **Action:** Remove the baked default (force explicit `--api-url`/`REVIEW_API_URL`, fail if unset), or drop the `review` binary if you won't host the service.
- **Blast radius:** High — the review CLI is unusable until pointed at a self-hosted endpoint. This is the single most sensitive egress (source code leaves the machine).

### 1c. Git commit author → `noreply@vibekanban.com` — **REPOINT**
- `crates/git/src/lib.rs:215-216` (`user.name="Vibe Kanban"`, `user.email="noreply@vibekanban.com"`) and `:228` (`Signature::now("Vibe Kanban", "noreply@vibekanban.com")`) (verified).
- **What/connects:** Not network egress, but stamps VK identity into commit history when git user is unset.
- **Action:** Replace with neutral/your identity or an env-configured value.
- **Blast radius:** Cosmetic-ish, but persists VK attribution in public git history. No build break.

### 1d. PR-description self-attribution link → `vibekanban.com` — **DELETE**
- `crates/services/src/services/config/mod.rs:19` — prompt template instructs: `"This PR was written using [Vibe Kanban](https://vibekanban.com)"` (verified).
- **Action:** Delete the line (or rebrand).
- **Blast radius:** None functional; removes VK link from generated PRs.

### 1e. MCP metadata links → vibekanban.com / BloopAI — **REPOINT** (see §8b)
- `crates/executors/default_mcp.json:51` (`https://www.vibekanban.com/docs/...`), `:81` (`https://github.com/BloopAI/dev-manager-mcp`). Passive UI/doc links, not boot-time calls.

### 1f. QA repos `git clone github.com/BloopAI/internal-qa-*` — see **§6** (feature-gated, off by default).

### Startup phone-home (non-telemetry): **NOT FOUND**
No version-ping/registration/"hello" call fires on boot beyond the analytics init (§2) and the on-demand `/releases` fetch (1a). `RemoteClient` has **no baked cloud base URL** — it's always constructed with a caller-supplied `base` (consistent with the remote-info crate being fully env-driven).

---

## 2. Telemetry / analytics / usage stats / crash reporting

Three systems exist. **All are env-gated** (no key → no-op), but the wiring, keys, and a hardcoded Sentry org are present and must be cut for a guaranteed-silent fork. Search confirmed **no** Segment/Mixpanel/Amplitude/Datadog.

### 2a. PostHog analytics (backend ×2 + frontend) — **DELETE / SEVER**
- Backend (local): `crates/services/src/services/analytics.rs` — `AnalyticsService::track_event` POSTs to `{POSTHOG_API_ENDPOINT}/capture/` (verified `:56-61`), fire-and-forget via `tokio::spawn`; anonymous user-id hash from machine-id+USERNAME+HOME. Gated on `POSTHOG_API_KEY`+`POSTHOG_API_ENDPOINT`.
- Backend (remote): `crates/remote/src/analytics.rs` (+ `crates/remote/src/app.rs:171-182` "PostHog analytics configured" log).
- Build-time capture: `crates/server/build.rs:10-23` embeds `POSTHOG_API_KEY`/`POSTHOG_API_ENDPOINT` via `option_env!`.
- Frontend: `packages/local-web/src/app/entry/Bootstrap.tsx:30-46` `posthog.init(VITE_POSTHOG_API_KEY, …)` — note `opt_out_capturing_by_default=true`. Usage in `packages/web-core/.../onboarding/*`, `web-core/src/shared/actions/index.ts:487` (`displaySurvey`), `local-web/src/routes/__root.tsx`.
- Docs site: `docs/docs.json:159-162` ships a **real PostHog key** `phc_V5Xpx…` → `https://eu.i.posthog.com`.
- **Opt-out today:** `analytics_enabled` config flag gates backend events (`crates/deployment/src/lib.rs:141-144` `track_if_analytics_allowed`); frontend defaults to opt-out.
- **Action:** Remove init + `track`/`capture`/`displaySurvey` calls; drop `posthog-js` dep; remove the build.rs env capture; scrub the docs.json key. For a minimal cut, simply never set the keys (backend no-ops; frontend already opt-out) — but the docs.json key is hardcoded and **will** send unless removed.
- **Blast radius:** Onboarding/survey/perf tracking gone; no functional regression.

### 2b. Sentry crash/error reporting (all platforms) — **SEVER (incl. hardcoded org)**
- Core: `crates/utils/src/sentry.rs` — `init_once(source)` reads `SENTRY_DSN` / `SENTRY_DSN_REMOTE`; no-op if unset; `sentry_layer` ships ERROR events; `configure_user_scope` attaches user_id/username/email.
- Wiring: `crates/deployment/src/lib.rs:131-139` (`update_sentry_scope` attaches GitHub username+email); build watches in `crates/tauri-app/build.rs:2`.
- Frontend: `Bootstrap.tsx:20-28` `Sentry.init(VITE_SENTRY_DSN, tracesSampleRate=1.0)`, `ErrorBoundary` → CrashScreen.
- **Hardcoded org (egress even without DSN at build):** `packages/local-web/vite.config.ts:111` — `sentryVitePlugin({ org: 'bloop-ai', project: 'vibe-kanban' })` (verified). This uploads source maps to **BloopAI's Sentry org** at build time.
- **Action:** Remove `init_once`/`sentry_layer`/`update_sentry_scope`, frontend `Sentry.init`+ErrorBoundary, and the `sentryVitePlugin` block (or repoint org to yours). Drop `sentry`/`@sentry/*` deps.
- **Blast radius:** No crash/error egress; lose remote error visibility; frontend errors fall back to a non-reporting boundary.

### 2c. OpenTelemetry → Azure App Insights (remote only) — **DELETE**
- `crates/remote/src/lib.rs` — `init_otel_layer()` reads `APPLICATIONINSIGHTS_CONNECTION_STRING` (no-op if unset), exporter via `opentelemetry-application-insights 0.44`; `OTEL_SERVICE_NAME` default `"vibe-kanban-remote"`.
- **Action:** Remove the OTel layer + dep from `crates/remote/Cargo.toml`.
- **Blast radius:** Remote-only; no distributed tracing. None for local/desktop.

### npx-cli telemetry: **NOT FOUND** (no analytics; only the update notifier in §3d).

---

## 3. Auto-update / version-check machinery

### 3a. Tauri desktop updater — **DELETE (sequence carefully)**
- Config: `crates/tauri-app/tauri.conf.json` — `"createUpdaterArtifacts": true` + `plugins.updater` block with `endpoints: ["__TAURI_UPDATE_ENDPOINT__"]` (CI-injected R2 URL) + base64 pubkey.
- Dep: `crates/tauri-app/Cargo.toml:17` `tauri-plugin-updater = "2"`.
- Code: `crates/tauri-app/src/main.rs` — `UPDATE_CHECK_INTERVAL = 60min` (`:26`), plugin registered release-only (`:161-163`), `check_for_updates` (`:441-499`), `install_pending_update` (`:411-439`), `run_periodic_update_checks` (`:501-511`).
- **Action:** Remove dep + plugin registration + the three fns; set `createUpdaterArtifacts:false`; delete the `plugins.updater` block.
- **Blast radius (build/signing):** Removing the Cargo dep but leaving registration → **build fails**. Setting `createUpdaterArtifacts:false` but leaving the plugin → app builds, then errors at runtime checking updates (no `.sig`). Correct order: strip code+dep+config together. macOS codesign/notarization is **independent** of the updater — the deferred-install design exists only to keep the signature valid; removing the updater does not break signing.

### 3b. Frontend update banner — **DELETE**
- `packages/local-web/src/app/hooks/useTauriUpdateReady.ts:10-36` (listens for `update-installed`), `packages/web-core/src/shared/stores/useAppUpdateStore.ts`, `packages/ui/src/components/AppBar.tsx` (`Update to v…` tooltip), `web-core/.../SharedAppLayout.tsx`.
- **Action:** Remove the hook + store usage + AppBar conditional. Decoupled — safe to remove; no build break.

### 3c. Releases endpoint feeding web update banner — covered in **§1a**.

### 3d. npx-cli update notifier → R2 manifest — **DELETE or REPOINT**
- `npx-cli/src/download.ts:270-275` `getLatestVersion()` fetches `${R2_BASE_URL}/binaries/manifest.json`; `R2_BASE_URL`/`BINARY_TAG` are pack-time placeholders (`__R2_PUBLIC_URL__`, `__BINARY_TAG__`).
- `npx-cli/src/cli.ts:198-214` `checkForUpdates()` (called in `runMain` `:245`), prints "Update available". Runs only if `R2_BASE_URL` is real and not `LOCAL_DEV_MODE`.
- **Action:** Delete `checkForUpdates` + `getLatestVersion`, or point R2 at your own bucket. Independent of desktop build/signing.

### 3e. CI release/update plumbing (R2/S3) — **DELETE/REPOINT** (only if you publish builds)
- `.github/workflows/pre-release.yml` (build-tauri patches `__TAURI_UPDATE_ENDPOINT__` → R2 `tauri-update/latest.json`; `upload-tauri-update` generates `latest.json` via `scripts/generate-tauri-update-json.js`; `upload-to-r2` writes `binaries/manifest.json`) and `publish.yml` promote-to-live copy. (Workflow line refs per agent; re-verify before editing.)
- **Action:** Drop the updater-manifest jobs / repoint the bucket. Not needed for source-only forks.

---

## 4. Private / proprietary dependencies

### 4a. Stripe billing crate (private) — already auto-stripped; **DELETE for cleanliness**
- `crates/remote/Cargo.toml:17` — `billing = { git = "ssh://git@github.com/BloopAI/vibe-kanban-private", branch="main", package="billing", optional=true }`; feature `vk-billing = ["dep:billing"]` (`:13`).
- Fully `#[cfg(feature="vk-billing")]`-gated: `crates/remote/src/billing.rs`, `src/main.rs:18-42` (provider init + no-op fallback), `routes/billing.rs` (endpoints fall back to `Free`/`billing_enabled:false`), `routes/mod.rs` cfg-gated mount.
- **Already handled:** `crates/remote/Dockerfile:88-94` (verified) seds the dep + feature out when `FEATURES` is empty; SSH key mount `--mount=type=ssh` (`:101`) only used with the feature on.
- **Action:** Build with default features (feature off → compiles without the private crate). For a clean public tree, delete `Cargo.toml:13,17` and the `billing` module refs. No code changes required to build.
- **Blast radius:** Billing endpoints return "not configured" (already the off-path). No SSH key needed.

### Other private git deps / registries / build-time BloopAI fetches: **NOT FOUND**
The only non-crates.io git dep elsewhere is the public `ts-rs` fork (`github.com/xazukx/ts-rs`) in the workspace `Cargo.toml` — not BloopAI, not private. No private npm scopes. Dockerfile clones nothing from BloopAI beyond the (stripped) billing crate.

---

## 5. Cloud/relay back-connection

**Headline:** the relay/tunnel stack is **self-hostable by design** — endpoints come from env/credentials, not baked BloopAI hosts. KEEP it; just ensure no BloopAI default leaks in. Two genuine third-party defaults (Google STUN) exist.

### 5a. Default relay/signalling host = **NOT FOUND (KEEP)**
- `crates/local-deployment/src/lib.rs:171-187` reads `VK_SHARED_RELAY_API_BASE` / `VK_SHARED_API_BASE` with **no BloopAI default**; `crates/server/build.rs` passes through, sets no default. `crates/relay-hosts/` stores user-supplied creds (JWT/PEM), **no hardcoded host registry**. `ws-bridge`, `relay-tunnel` config: endpoints/secrets all env-supplied. `crates/remote-info/` exposes runtime-configurable `api_base`/`relay_api_base`.
- **Action:** KEEP. Verify deployment configs/`.env` you ship don't set these to a BloopAI host.

### 5b. WebRTC STUN → `stun.l.google.com:19302` (×2) — **REPOINT (not BloopAI, but external)**
- `crates/relay-webrtc/src/client.rs:205` and `crates/relay-webrtc/src/peer.rs:56` hardcode Google's public STUN.
- **What:** NAT traversal for P2P relay. Not BloopAI, but a third-party egress on every WebRTC connection.
- **Action:** Repoint to your own STUN/TURN (or make configurable) if you want zero third-party contact; both sites must change together.
- **Blast radius:** WebRTC NAT traversal depends on it; mis-repoint breaks P2P relay.

### 5c. SPAKE2 protocol IDs — **KEEP (rename only if you change both ends)**
- `crates/relay-client/src/lib.rs:41-42` — `SPAKE2_CLIENT_ID = b"vibe-kanban-browser"`, `SPAKE2_SERVER_ID = b"vibe-kanban-server"`. Generic pairing markers, **not** egress.
- **Action:** KEEP, or rename — but client and server **must** use identical values or relay pairing fails. Not required for severance.

---

## 6. QA / internal integrations

### 6a. Hardcoded BloopAI QA repos — **DELETE (feature-gated, off by default)**
- `crates/services/src/services/qa_repos.rs:15-18` — `QA_REPOS = [("internal-qa-1","https://github.com/BloopAI/internal-qa-1"), ("internal-qa-2","https://github.com/BloopAI/internal-qa-2")]`; `clone_qa_repos_if_needed` git-clones on first use.
- Feature `qa-mode`: `crates/server/Cargo.toml:78`, `crates/services/Cargo.toml:9`, `crates/executors/Cargo.toml:64`. Consumers behind `#[cfg(feature="qa-mode")]`: `services/.../filesystem.rs` (replaces repo discovery), `executors/.../qa_mock.rs` (`QaMockExecutor`), `coding_agent_initial.rs`/`_follow_up.rs`, `container.rs`.
- **Action:** Delete `qa_repos.rs` + the three feature defs + cfg blocks (or just never enable `qa-mode` — it's not in any default feature set). 
- **Blast radius:** Zero in default builds (feature off → real filesystem discovery + real executors). Only matters if someone builds `--features qa-mode`.

---

## 7. Branding/identity strings tied to connections (not cosmetic)

| Item | file:line | Tied to | Action | Breaks? |
|---|---|---|---|---|
| Tauri identifier `ai.bloop.vibe-kanban` | `crates/tauri-app/tauri.conf.json:5` | OS app identity + update endpoint routing | REPOINT (own reverse-DNS id) | Changing **breaks desktop auto-update continuity** (new id = new app). Fine if you're dropping the updater anyway (§3a). |
| Windows AUMID `ai.bloop.vibe-kanban` | `crates/tauri-app/src/windows_notifications.rs:24` | Toast notification identity | REPOINT (must match Tauri id) | Toast routing breaks if it mismatches the bundle id. |
| ProjectDirs `("ai","bloop", …)` / `("ai","bloop-dev", …)` | `crates/utils/src/lib.rs:53,56`; `crates/utils/src/assets.rs:25` | macOS/Linux data/config/cache dir path | REPOINT | Renaming relocates config/db/assets dir → effectively a fresh install; migrate or accept reset. No egress. |
| SPAKE2 IDs `vibe-kanban-browser/-server` | `crates/relay-client/src/lib.rs:41-42` | Relay pairing handshake | KEEP/rename-both | Renaming one end **breaks pairing**; change client+server together. |
| npm name `vibe-kanban` + `repository.url` BloopAI | `package.json`, `npx-cli/package.json:14,16-17` (`author:"bloop"`, BloopAI repo URL) | Publish identity / `npx vibe-kanban` | REPOINT | Cosmetic for runtime; affects publish + the update-notifier target (§3d). |
| Env prefixes `VK_*` / `VIBEKANBAN_*`, log filter `vibe_kanban_*` | repo-wide | Internal identifiers | KEEP/rename-consistently | No egress; rename only if rebranding, must be consistent across code + deploy env. |

**Safe sequence for identity changes:** decide updater fate first (§3a). If dropping auto-update, you may freely change the Tauri id + AUMID together. Change SPAKE2 IDs only if you control both relay ends and do them in one commit. Rename ProjectDirs with a migration step or document the config reset.

---

## 8. Default config that points outward

### 8a. docker-compose env defaults — mostly safe; one BloopAI-specific default — **REPOINT**
- `crates/remote/docker-compose.yml`: `SERVER_PUBLIC_BASE_URL` defaults to `http://localhost:3000` (safe); `REMOTE_SERVER_PORTS` → localhost (safe); `POSTHOG_API_KEY`/`POSTHOG_API_ENDPOINT`/`SENTRY_DSN_REMOTE` default **empty** (no-op).
- **BloopAI-specific:** Loops email template IDs are hardcoded defaults (e.g. `LOOPS_INVITE_TEMPLATE_ID:-cmhvy2…`) — these are BloopAI's Loops templates; only fire if `LOOPS_EMAIL_API_KEY` is set, and would target BloopAI's templates under your key. **Action:** blank them / replace with yours.
- **Blast radius:** Email no-ops without a Loops key; with a key, wrong templates → REPOINT.

### 8b. `default_mcp.json` — third-party + BloopAI links — **REPOINT/REVIEW**
- `crates/executors/default_mcp.json` (verified): line 12 `https://mcp.context7.com/mcp` is a **live third-party remote MCP server** default; `:51` `www.vibekanban.com/docs/...` and `:81` `github.com/BloopAI/dev-manager-mcp` are doc/repo links; plus context7/playwright/exa/chrome-devtools repo links (`:57,63,69,75`).
- **Action:** Repoint the two VK/BloopAI links; decide whether to ship the context7 remote MCP as a default (it's an outbound endpoint, though not BloopAI). Doc links are passive.
- **Blast radius:** Cosmetic except context7 (an actual MCP egress if that server is enabled by default).

### 8c. `default_profiles.json`, `Caddyfile.example`, `RemoteClient` — **NOT FOUND / KEEP**
No outbound hosts in `default_profiles.json`; `Caddyfile.example` is local reverse-proxy only; `RemoteClient` has no baked cloud base.

---

## DELETE / SEVER / REPOINT / KEEP — master table

| # | Finding | file:line | Action |
|---|---|---|---|
| 1a | GitHub releases check (BloopAI) | `crates/server/src/routes/releases.rs:14` | DELETE or REPOINT |
| 1b | Review CLI cloud default | `crates/review/src/main.rs:21,50` | REPOINT (or DELETE feature) |
| 1c | Commit author email | `crates/git/src/lib.rs:215-216,228` | REPOINT |
| 1d | PR self-attribution link | `crates/services/src/services/config/mod.rs:19` | DELETE |
| 1e | MCP doc/repo links | `crates/executors/default_mcp.json:51,81` | REPOINT |
| 2a | PostHog (backend ×2 + FE + docs key) | `services/.../analytics.rs`, `remote/src/analytics.rs`, `Bootstrap.tsx:30-46`, `server/build.rs:10-23`, `docs/docs.json:159-162` | DELETE / SEVER |
| 2b | Sentry (all platforms) + hardcoded org | `utils/src/sentry.rs`, `Bootstrap.tsx:20-28`, `vite.config.ts:111` | SEVER |
| 2c | OpenTelemetry → Azure (remote) | `crates/remote/src/lib.rs` | DELETE |
| 3a | Tauri updater | `tauri.conf.json` updater block, `tauri-app/Cargo.toml:17`, `main.rs:26,161-163,411-511` | DELETE |
| 3b | Frontend update banner | `useTauriUpdateReady.ts`, `useAppUpdateStore.ts`, `AppBar.tsx` | DELETE |
| 3d | npx update notifier | `npx-cli/src/cli.ts:198-214`, `download.ts:270-275` | DELETE or REPOINT |
| 3e | CI updater/R2 jobs | `.github/workflows/pre-release.yml`, `publish.yml` | DELETE/REPOINT |
| 4a | Private billing crate | `crates/remote/Cargo.toml:13,17` (Dockerfile:88-94 auto-strips) | DELETE (already feature-off) |
| 5b | Google STUN ×2 | `relay-webrtc/src/client.rs:205`, `peer.rs:56` | REPOINT |
| 5a | Relay/signalling default host | `local-deployment/src/lib.rs:171-187` | KEEP (no BloopAI default) |
| 5c | SPAKE2 IDs | `relay-client/src/lib.rs:41-42` | KEEP (rename-both only) |
| 6a | QA repos (BloopAI) | `services/.../qa_repos.rs:15-18` + `qa-mode` features | DELETE (off by default) |
| 7 | Tauri id / AUMID | `tauri.conf.json:5`, `windows_notifications.rs:24` | REPOINT (breaks update continuity) |
| 7 | ProjectDirs `ai/bloop` | `utils/src/lib.rs:53,56`, `assets.rs:25` | REPOINT (config relocates) |
| 8a | Loops template-id defaults | `crates/remote/docker-compose.yml` | REPOINT |
| 8b | context7 remote MCP default | `default_mcp.json:12` | REVIEW (3rd-party egress) |

---

## Ordered removal plan (sequence breaking changes safely)

**Phase 0 — baseline.** Confirm clean build with default features (billing/qa-mode already off): `cargo build --workspace` and `cargo build --manifest-path crates/remote/Cargo.toml`. Capture a baseline egress trace (see checklist) to know what fires today.

**Phase 1 — pure deletions, no repoint needed (lowest risk, no break):**
1. Delete PR-attribution line (1d) and rebrand commit email (1c).
2. Remove telemetry **call sites + init**: PostHog (2a) incl. `docs/docs.json` key + `server/build.rs` capture; Sentry (2b) incl. `vite.config.ts` plugin; OTel (2c). Drop the deps from Cargo.toml/package.json last (after call sites compile-clean).
3. Delete QA repos + `qa-mode` features (6a) — off by default, safe.
4. Delete the private billing dep lines (4a) — feature already off.

**Phase 2 — update machinery (order matters for the desktop build):**
5. Remove the frontend update banner (3b) and the `/releases` route + its caller (1a) — decoupled, no build impact.
6. Remove npx update notifier (3d).
7. Desktop updater (3a) **as one change**: delete plugin registration + the three fns in `main.rs`, remove `tauri-plugin-updater` from Cargo.toml, set `createUpdaterArtifacts:false`, delete the `plugins.updater` block. Then rebuild the Tauri app to confirm it compiles and signs. (Do NOT do these piecemeal — half-removal either fails the build or errors at runtime.)
8. Strip CI updater/R2 jobs (3e) if you publish.

**Phase 3 — repoint-before-cut (must point somewhere first):**
9. Review CLI (1b): set your own `REVIEW_API_URL` default (or remove the binary). Verify it no longer defaults to `api.vibekanban.com`.
10. STUN (5b): repoint both `relay-webrtc` sites to your STUN/TURN; verify WebRTC relay still negotiates before removing Google's.
11. Loops template defaults (8a) and `default_mcp.json` links (8b); decide on context7 default.

**Phase 4 — identity (do last, deliberately):**
12. Tauri id + AUMID together (7) — only after the updater is gone, so update-continuity loss is moot.
13. ProjectDirs rename (7) with a config-migration note (or accept a fresh config dir).
14. SPAKE2 IDs (5c) only if changing both relay ends in the same commit.

**After each phase:** rebuild (`cargo build --workspace` + remote manifest), boot the server, and re-run the egress trace below.

---

## Verify-no-egress checklist

**Static (grep) gates — must all return only intended/removed hits:**
```bash
cd /Users/macpro/Documents/icemintdev
# BloopAI/VK hosts & identifiers
grep -rniE 'bloopai|vibekanban\.com|\.bloop\.ai|repos/BloopAI' crates packages shared npx-cli docs
# Telemetry SDKs / endpoints
grep -rniE 'posthog|sentry|opentelemetry|application[_-]?insights|/capture/|i\.posthog\.com' crates packages docs
grep -rniE 'posthog|@sentry|sentry-vite' package.json packages/*/package.json
# Update machinery
grep -rniE 'tauri-plugin-updater|createUpdaterArtifacts|__TAURI_UPDATE_ENDPOINT__|update-available|getLatestVersion|checkForUpdates' crates packages npx-cli
# Private deps / QA
grep -rn 'vibe-kanban-private|internal-qa|qa-mode' crates
# Third-party network defaults
grep -rniE 'stun:|turn:|mcp\.context7\.com' crates
```

**Dependency gates:**
```bash
# No telemetry/updater crates in the build graph:
cargo tree -e no-dev 2>/dev/null | grep -Ei 'sentry|posthog|opentelemetry|application-insights|tauri-plugin-updater' && echo "STILL PRESENT" || echo "clean"
# No telemetry node deps:
grep -RniE '"(posthog-js|@sentry/[^"]+|@sentry/vite-plugin)"' package.json packages/*/package.json || echo "clean"
```

**Dynamic (runtime egress) gate — confirm the running app talks to nobody but localhost/your hosts:**
```bash
# Boot the local stack, exercise it (create task, run an executor, open the UI), then watch sockets:
#   macOS:
sudo lsof -nP -iTCP -iUDP | grep -E 'server|remote|node|tauri' 
#   or capture & inspect destinations (exclude loopback + your own relay):
sudo tcpdump -n 'tcp[tcpflags] & tcp-syn != 0 and not dst net 127.0.0.0/8' 
# Assert: ZERO connections to *.posthog.com, *.sentry.io, *.in.applicationinsights.azure.com,
#         api.github.com (repos/BloopAI), api.vibekanban.com, *.bloop.ai, stun.l.google.com.
```
Optionally run the server with outbound DNS to those domains blocked (e.g. `/etc/hosts` → `0.0.0.0`, or a deny firewall rule) and confirm **no errors and no retries** in logs — proving nothing depends on them.

**Frontend gate:** load the web UI with devtools Network tab open through onboarding + a task run; assert no requests to posthog/sentry/vibekanban/github-BloopAI. Build the bundle and confirm no source-map upload step ran (`sentryVitePlugin` removed).

**Pass criteria:** all grep host/SDK gates return only removed/own-host hits, `cargo tree` and node-dep gates report `clean`, and the runtime trace shows zero connections to the BloopAI/VK/telemetry domain list above across a full local + remote exercise.
