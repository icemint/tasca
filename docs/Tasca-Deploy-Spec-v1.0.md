# Tasca — Coolify / CI-CD Deployment Spec v1.0

**Status:** authoritative for Stage 1. Execution shape is pinned (de-Electron Emdash fork, all-Node + Postgres). **Electric is dropped — confirmed absent** (no `electric-sql` / `@electric` dependency or reference anywhere in the repo, workflows, or docs).

> **Topology update (2026-06-10) — the coordination|execution split has SHIPPED.** This spec
> describes the single combined `worker` container ("Stage-2 split" deferred, §5/§8). That split
> has since landed (#234–#248): production now runs **worker + non-root agent-runner + egress-proxy
> + Postgres** on `internal:` networks, with the agent dispatched via a `dispatch_job` queue (no
> in-process fallback — #247) and the Anthropic key proxied worker-side so the **agent is keyless**
> (#248 — the `ANTHROPIC_API_KEY` rows below are the WORKER's key, no longer the agent's). The
> authoritative topology is now `deploy/compose.yml` + `docs/decisions/2026-06-09-coordination-execution-split.md`;
> the single-container sections below are retained as historical Stage-1 context.

> **One deviation from the requested 5-container list, flagged up front.** The request lists *coordination* and *execution* as separate containers. In the code as built, `@tasca/execution` is an **in-process library** that `@tasca/coordination` calls directly through `ExecutionPort` (`reserveWorktree` / `spawnAgent` / `openPr`). There is **no network/queue seam** between them — splitting them into two containers is net-new code (a dispatch queue or RPC), not infra config. So Stage 1 ships **one `worker` container = coordination + execution combined** (§2.3). The split is a documented Stage-2 step (§8). Everything below is the deployable-now topology; if you'd rather build the split first, say so and it becomes a code task before this spec applies.

---

## 1. Topology

```
                      Internet
                         │
        ┌────────────────┼─────────────────────────┐
        │                │                          │
   tasca.dev        app.tasca.dev              api.tasca.dev
   (marketing)        (app shell)            (worker: webhooks)
        │                │                          │
   ┌────▼────┐      ┌────▼────┐               ┌─────▼──────┐
   │ website │      │  app    │               │  worker    │  coordination HTTP
   │ nginx   │      │  nginx  │               │  (Node)    │  + execution in-proc
   │ :80     │      │  :80    │               │  :8080     │
   └─────────┘      └─────────┘               └─────┬──────┘
                                                    │ (internal network only)
                                              ┌─────▼──────┐
                                              │  postgres  │  coordination CAS
                                              │  :5432     │  + identity + ledger
                                              └────────────┘
```

- **Shared Coolify network.** All five resources join **one Coolify project / Docker network** (call it `tasca`). `worker → postgres` is **internal only** (service DNS name, never published). `postgres` exposes **no public port and no domain**. `website`, `app`, `worker` get public domains via Coolify's Traefik proxy (TLS auto).
- **Domains:** `tasca.dev` → website · `app.tasca.dev` → app · **`api.tasca.dev` → worker** (new; the Shortcut webhook target + `/healthz`).

---

## 2. Per-service container spec

### 2.1 `website` (marketing) — EXISTS
| | |
|---|---|
| Image | `ghcr.io/icemint/tasca-website:sha-<short>` |
| Build | `website/Dockerfile` — `nginx:1.27-alpine` packaging Astro `dist/` (built in CI before `docker build`) |
| Port | `80` |
| Domain | `tasca.dev` |
| Healthcheck | in-image: `wget --spider -q http://127.0.0.1/` (30s/4s/5s/3) |
| Network | `tasca` (public via proxy) |
| Env | none (fully static) |
| CD | `.github/workflows/cd-website.yml` → `scripts/coolify-deploy.sh` |
| Coolify UUID secret | `COOLIFY_WEBSITE_RESOURCE_UUID` ✅ already set |

### 2.2 `app` (app shell / sign-in) — EXISTS
| | |
|---|---|
| Image | `ghcr.io/icemint/tasca-app:sha-<short>` |
| Build | `app/Dockerfile` — `nginx:1.27-alpine` packaging Astro `dist/` |
| Port | `80` (CD also PATCHes `ports_exposes=80` to undo the dead Rust resource) |
| Domain | `app.tasca.dev` |
| Healthcheck | in-image `wget --spider` (same as website) |
| Network | `tasca` (public via proxy) |
| Env | none today (static). **OAuth is not yet served** — the login buttons link to `/api/auth/{github,google}`, which nothing handles yet. When auth lands it belongs on the worker/BFF (§4), not this static image. |
| CD | `.github/workflows/cd-app.yml` → `scripts/coolify-deploy.sh` |
| Coolify UUID secret | `COOLIFY_RESOURCE_UUID` ✅ already set (the bare name = the app) |

### 2.3 `worker` (coordination + execution) — **NEW, needs scaffolding**
The composition root (`createCoordination` → `createCoordinationServer`, `node:http`): `POST /webhooks/shortcut` (HMAC verify → idempotent ledger → fast-ack 202 → orchestrate) and `GET /healthz`. Execution runs **in-process**: it spawns the `claude` CLI over a PTY, creates git worktrees on a local volume, and runs `git`/`gh` to open PRs. So this image is **not** nginx — it's a Node runtime with the execution toolchain.

| | |
|---|---|
| Image | `ghcr.io/icemint/tasca-worker:sha-<short>` |
| Build | `deploy/worker.Dockerfile` — `node:22-bookworm` (bookworm ships Python 3.11, which node-gyp needs) + `git`, `gh`, `libsecret-1-0/-dev`, the Claude CLI; `pnpm install --frozen-lockfile` then the CI native-rebuild recipe (`corepack prepare pnpm@10.28.2` in the vendor + `node scripts/build-vendor.mjs`). Full install (not `--prod`) because the worker runs via **tsx** (the repo executes TS source — no JS emit pipeline). |
| Entry | `packages/coordination/src/main.ts` — validate env → apply `TASK_TABLE_DDL` + `IDENTITY_SCHEMA_DDL` + `COORDINATION_SCHEMA_DDL` (idempotent) → snapshot active agents + Shortcut bindings → `createCoordination({...}).createServer().listen(8080)` → graceful SIGTERM/SIGINT. Run: `pnpm start:worker` (= `tsx packages/coordination/src/main.ts`). |
| Port | `8080` |
| Domain | `api.tasca.dev` (Shortcut points its Outgoing Webhook at `https://api.tasca.dev/webhooks/shortcut`) |
| Healthcheck | `GET /healthz` → 200 `ok` (Coolify HTTP healthcheck on `:8080/healthz`, 30s/5s/10s start/3) |
| Network | `tasca`; reaches `postgres` by internal DNS; public only for the webhook path |
| Persistent volume | yes — a writable dir for git worktrees + the execution SQLite (`EMDASH_DB_FILE`) + the SecretStore dir (mode 0700). Mount e.g. `/data`. |
| Depends-on | `postgres` healthy first |
| Env | see §3 (DATABASE_URL, ANTHROPIC_API_KEY, SHORTCUT_WEBHOOK_SECRET, agent GH token, secret-store key, …) |
| CD | **new** `.github/workflows/cd-worker.yml` → `scripts/coolify-deploy.sh` |
| Coolify UUID secret | **new** `COOLIFY_WORKER_RESOURCE_UUID` |

### 2.4 `postgres` (coordination store) — **NEW**
The CAS / coordination store: `task` (the CAS target), identity tables, `routing_decision`, `pull_request`, `platform_connection`, `webhook_event` (the idempotency ledger). The DDL is applied by the worker on boot (§2.3 entry), so Postgres just needs to be an empty database.

| | |
|---|---|
| Image | `postgres:17-alpine` (matches CI's service image) |
| Port | `5432` — **internal only, do not publish** |
| Domain | none |
| Healthcheck | `pg_isready -U postgres` (Coolify’s built-in Postgres healthcheck) |
| Network | `tasca` |
| Persistent volume | yes — `/var/lib/postgresql/data` (Coolify-managed volume; enable scheduled backups) |
| Env | `POSTGRES_PASSWORD` (new secret), `POSTGRES_DB=tasca`, `POSTGRES_USER=postgres` |
| Recommended | use Coolify’s **managed PostgreSQL** resource type (gives backups + the internal connection string) rather than a raw Docker image |

> **Either path is fine.** Coolify "PostgreSQL database" resource (managed, backups, generated internal URL) is the recommendation. If you prefer a Docker-image resource, set the three `POSTGRES_*` envs yourself and point `DATABASE_URL` at the service DNS name.

---

## 3. Environment variables — carry-over vs greenfield-new

### 3.1 GitHub Actions secrets (CI/CD)
| Secret | Status | Used by | Purpose |
|---|---|---|---|
| `COOLIFY_API_URL` | ✅ carry-over | all `cd-*.yml` | Coolify API base |
| `COOLIFY_API_TOKEN` | ✅ carry-over | all `cd-*.yml` | Coolify API bearer (write+read) |
| `COOLIFY_WEBSITE_RESOURCE_UUID` | ✅ carry-over | `cd-website.yml` | website resource id |
| `COOLIFY_RESOURCE_UUID` | ✅ carry-over | `cd-app.yml` | app resource id |
| `COOLIFY_WORKER_RESOURCE_UUID` | 🆕 new | `cd-worker.yml` | worker resource id (after you create it) |
| `ANTHROPIC_API_KEY` | ✅ carry-over | spike + worker runtime | the agents’ Claude key |
| `SPIKE_GH_TOKEN` | ✅ carry-over | spike (SC1-7) | fine-grained PAT the agent uses to open PRs |
| `GITHUB_TOKEN` (built-in) | n/a | all `cd-*.yml` | push images to GHCR (Actions-issued, not a stored secret) |
| `COOLIFY_WEBHOOK_REMOTE` | ✅ carry-over | (unused by scripts) | alt deploy-webhook URL; the scripts use the API path instead |

### 3.2 Coolify-side config (not GitHub secrets)
| Item | Status | Purpose |
|---|---|---|
| **GHCR pull credential** (PAT, `read:packages`) | 🆕 new (the "GHCR PAT" carry-over) | Coolify must authenticate to pull **private** `ghcr.io/icemint/*` images. Add once as a Coolify "Docker Registry" / source credential; all three image resources use it. |
| Per-resource **env vars** below | mixed | set on the worker + postgres resources in the Coolify UI |

### 3.3 Worker runtime env (set on the `worker` resource)
| Var | Status | Purpose |
|---|---|---|
| `DATABASE_URL` | 🆕 new | `postgres://postgres:<pw>@<postgres-service-dns>:5432/tasca` (internal) |
| `ANTHROPIC_API_KEY` | ✅ carry-over | agent model key (mirror of the Actions secret) |
| `TASCA_AGENT_GH_TOKEN` | 🆕 new (promote `SPIKE_GH_TOKEN` → prod) | the token agents use to push branches + open PRs |
| `SHORTCUT_WEBHOOK_SECRET` | 🆕 new | HMAC secret to verify the Outgoing Webhook v1 `Payload-Signature` |
| `SHORTCUT_API_TOKEN` | 🆕 new, optional | Workspace **admin** token — used ONLY by the one-shot `shortcut:register-webhook` command (§7) to create the outgoing webhook. Ungated (distinct from the gated per-agent tokens below); not read by the running worker. |
| `TASCA_SECRET_STORE_KEY` | 🆕 new | 32-byte key for `@tasca/execution` SecretStore AES-256-GCM fallback (no keytar in-container) |
| `EMDASH_DB_FILE` | 🆕 new | execution-local SQLite path on the volume, e.g. `/data/execution.sqlite` |
| `TASCA_WORKTREE_ROOT` | 🆕 new | git worktree root on the volume, e.g. `/data/worktrees` |
| `PORT` | 🆕 new | `8080` (the server bind port) |
| Shortcut **per-agent tokens** | ⏸ gated | NOT set yet — write-back/provisioning is gated on the Shortcut token-issuance answer (`docs/Tasca-Shortcut-Kickoff-Brief.md` item 2). Intake (this spec) needs only `SHORTCUT_WEBHOOK_SECRET`. |
| OAuth: `GITHUB_OAUTH_CLIENT_ID/SECRET`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, `OAUTH_REDIRECT_BASE` | ✅ carry-over, ⏸ reserved | the carried-over login creds. **Not consumed yet** — the `/api/auth/*` handler isn’t built. Reserve them on the worker for when auth lands (§4). |

### 3.4 Postgres env (set on the `postgres` resource)
| Var | Status |
|---|---|
| `POSTGRES_PASSWORD` | 🆕 new (generate, store in a password manager) |
| `POSTGRES_DB=tasca` | 🆕 new |
| `POSTGRES_USER=postgres` | 🆕 new |

---

## 4. OAuth reality check (so nothing is overstated)

The app login page (`app/src/pages/index.astro`) renders "Continue with GitHub/Google" linking to `/api/auth/github` and `/api/auth/google`. Today the app is a **static nginx** image — those routes 404. OAuth is therefore **carry-over creds, reserved, not wired**. When auth is built it should live on the **worker** (or a small BFF) under `api.tasca.dev/api/auth/*` with the app proxying or linking to it; the four OAuth env vars in §3.3 move from "reserved" to "active" at that point. This spec does not deploy an auth backend.

---

## 5. CI/CD workflows

- **`ci.yml`** (exists, unchanged) — PR + feature-branch gate: `pnpm -r typecheck` + `pnpm test` against a `postgres:17-alpine` service. Never deploys.
- **`cd-website.yml`** (exists) — on `website/**` change → build → GHCR → `coolify-deploy.sh`.
- **`cd-app.yml`** (exists) — on `app/**` change → build → GHCR → `coolify-deploy.sh`.
- **`cd-worker.yml`** (🆕) — on `packages/**` or the worker Dockerfile change → `pnpm install` → native build → `docker build` the worker image → GHCR → `coolify-deploy.sh` with `IMAGE=ghcr.io/icemint/tasca-worker` and `COOLIFY_RESOURCE_UUID=${{ secrets.COOLIFY_WORKER_RESOURCE_UUID }}`.
- **`scripts/coolify-deploy.sh`** (exists, **reused as-is**) — PATCH the resource’s image name+tag → `GET /api/v1/deploy?uuid=` → poll `/api/v1/deployments/{uuid}` to terminal status. Fail-closed on explicit failure, fail-open if status can’t be confirmed. The worker uses the **same** script; only `IMAGE` + `COOLIFY_RESOURCE_UUID` differ.

`cd-worker.yml` skeleton (mirrors the existing two, swapping nginx-static for a Node image build):

```yaml
name: CD (worker)
on:
  push:
    branches: [main]
    paths:
      - 'packages/**'
      - 'pnpm-lock.yaml'
      - 'deploy/worker.Dockerfile'
      - 'scripts/coolify-deploy.sh'
      - '.github/workflows/cd-worker.yml'
  workflow_dispatch:
concurrency: { group: cd-worker-${{ github.ref }}, cancel-in-progress: false }
permissions: { contents: read, packages: write }
env: { IMAGE: ghcr.io/icemint/tasca-worker }
jobs:
  build-and-deploy:
    runs-on: ubuntu-24.04
    env:
      COOLIFY_API_URL: ${{ secrets.COOLIFY_API_URL }}
      COOLIFY_API_TOKEN: ${{ secrets.COOLIFY_API_TOKEN }}
      COOLIFY_RESOURCE_UUID: ${{ secrets.COOLIFY_WORKER_RESOURCE_UUID }}
    steps:
      - uses: actions/checkout@v6
        with: { submodules: recursive }   # @tasca/execution vendors emdash
      - id: vars
        run: echo "sha_tag=sha-$(echo "${GITHUB_SHA}" | cut -c1-7)" >> "$GITHUB_OUTPUT"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: deploy/worker.Dockerfile
          platforms: linux/amd64
          push: true
          tags: ${{ env.IMAGE }}:${{ steps.vars.outputs.sha_tag }}
          cache-from: type=gha,scope=worker
          cache-to: type=gha,mode=max,scope=worker
      - if: ${{ env.COOLIFY_RESOURCE_UUID != '' }}
        env: { IMAGE: ${{ env.IMAGE }}, SHA_TAG: ${{ steps.vars.outputs.sha_tag }} }
        run: bash scripts/coolify-deploy.sh
```

> The worker image build (native modules + Claude CLI) is heavier than the static images. The `deploy/worker.Dockerfile` + `packages/coordination/src/main.ts` entry are the two net-new code artifacts this container needs — small, and I can land them in the coordination PR (#196) or a follow-up. They are **not** required for the marketing/app/postgres resources.

---

## 6. Resource-creation checklist (Coolify UI)

Do these in order. Items 1–2 are likely already done (carry-over).

1. **Project + network.** Confirm a project (e.g. `tasca`) exists; all resources below live in it so they share one Docker network.
2. **GHCR pull credential.** Add a Docker registry source: `ghcr.io`, username `icemint` (or your GH user), password = a PAT with `read:packages`. (This is the "GHCR PAT" carry-over.)
3. **postgres.** New resource → **PostgreSQL** (managed) → version 17 → DB name `tasca` → generate password → enable backups. Note its **internal connection URL** (service DNS). *(Or Docker-image `postgres:17-alpine` with the three `POSTGRES_*` envs.)*
4. **worker.** New resource → **Docker Image** → `ghcr.io/icemint/tasca-worker:sha-<any>` (the CD will repoint the tag) → port `8080` → domain `api.tasca.dev` → HTTP healthcheck `/healthz` → attach a persistent volume at `/data` → set the §3.3 env vars (`DATABASE_URL` from step 3, `ANTHROPIC_API_KEY`, `TASCA_AGENT_GH_TOKEN`, `SHORTCUT_WEBHOOK_SECRET`, `TASCA_SECRET_STORE_KEY`, `EMDASH_DB_FILE=/data/execution.sqlite`, `TASCA_WORKTREE_ROOT=/data/worktrees`, `PORT=8080`) → ensure it’s on the `tasca` network with `postgres`.
5. **(existing) website + app** — no change; they already deploy.
6. **DNS.** Point `api.tasca.dev` at the Coolify host (A/AAAA or CNAME) so Traefik can issue TLS for the worker.
7. **Shortcut webhook.** Once the worker is green, register the Outgoing Webhook at `https://api.tasca.dev/webhooks/shortcut` with the secret you put in `SHORTCUT_WEBHOOK_SECRET`. Run the one-shot command (needs a workspace admin token). Pass the secrets via the environment, **not** inline on the command line (inline `VAR=… cmd` leaks to `ps`/`/proc` and shell history):
   ```
   export SHORTCUT_API_TOKEN        # paste the workspace admin token when prompted, or source from an untracked env file
   export SHORTCUT_WEBHOOK_SECRET   # the same value the worker verifies with
   pnpm --filter @tasca/coordination shortcut:register-webhook
   ```
   It prints the created webhook id (deletable later) and exits non-zero on failure; the HMAC secret/token are scrubbed from any error output. (Or set the webhook in the Shortcut UI.)

---

## 7. New secrets to add after you create the resources

**GitHub repo secrets** (Settings → Secrets → Actions):
- `COOLIFY_WORKER_RESOURCE_UUID` = the UUID Coolify shows for the **worker** resource (step 4). This is the one repoint the CD needs.
- *(optional)* promote `SPIKE_GH_TOKEN` → a prod `TASCA_AGENT_GH_TOKEN` repo secret if you want the worker image build/CD to inject it; otherwise set it directly on the Coolify worker resource.

**No change needed** to `COOLIFY_WEBSITE_RESOURCE_UUID` or `COOLIFY_RESOURCE_UUID` (website + app keep their existing UUIDs).

**Coolify resource env** (not GitHub): the §3.3 worker vars + §3.4 postgres vars, plus the GHCR pull credential (step 2).

> So the **only new `COOLIFY_*_RESOURCE_UUID` to repoint is `COOLIFY_WORKER_RESOURCE_UUID`.** Postgres has no CD workflow (the worker applies the DDL on boot), so it needs no UUID secret.

---

## 8. Stage-2: splitting execution into its own container

If/when execution should be a separate, independently-scaled container (it’s the heavy one — native modules, PTYs, git clones, disk per worktree), the prerequisite is a **dispatch seam** that does not exist today:

1. Replace the in-process `ExecutionPort` call with a **queue** (a `dispatch` table polled by `FOR UPDATE SKIP LOCKED`, or Postgres `LISTEN/NOTIFY`) — coordination enqueues a claimed task; one or more execution workers dequeue.
2. Execution workers report PR/status back through the store (they already share Postgres) — no new datastore.
3. Then: `worker` becomes `coordination` (thin, HTTP-only, no execution toolchain) + `execution` (N replicas, the heavy image, no public port). Both on the `tasca` network.

This is a code change (the queue + the two entrypoints), reviewed through the normal flow, **before** the infra splits. Until then, one combined `worker` is correct and simpler.

---

## 9. Summary deltas

- **Confirmed:** Electric absent; stack is all-Node + Postgres.
- **New containers:** `worker` (coordination+execution) + `postgres`.
- **New code artifacts (landed):** `deploy/worker.Dockerfile`, `packages/coordination/src/main.ts`, `.github/workflows/cd-worker.yml`, root `.dockerignore`, `tsx` runtime + `start:worker` script. (`coolify-deploy.sh` reused unchanged.) Boot verified locally against Postgres: DDL applied idempotently, `/healthz` 200, bad-sig webhook 401, graceful SIGTERM.
- **New GitHub secret to repoint:** `COOLIFY_WORKER_RESOURCE_UUID` (only one).
- **Carry-over, unchanged:** website + app resources + their UUIDs, all `COOLIFY_API_*`, `ANTHROPIC_API_KEY`, `SPIKE_GH_TOKEN`, the GHCR pull credential, the reserved OAuth creds.
- **Deferred:** separate execution container (needs the dispatch queue first); OAuth backend (`/api/auth/*` not built).
