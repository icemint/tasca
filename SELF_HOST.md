# Self-hosting Tasca

Run your own Tasca instance with Docker Compose. The stack is a hardened multi-container
topology (the agent that runs your code is the lowest-trust process — it holds no keys and
has no direct internet; see the [security boundary](docs/decisions/2026-06-09-coordination-execution-split.md)).

## Requirements

- Docker + Docker Compose v2, and `make`.
- A clone **with submodules** — the agent runtime is a git submodule:
  ```sh
  git clone --recursive https://github.com/icemint/tasca.git
  # already cloned without --recursive?
  git submodule update --init --recursive
  ```
- An Anthropic API key.
- A GitHub OAuth app **and** a Google OAuth client (login requires both — see step 3).

## Quickstart

```sh
cp .env.example .env
#   edit .env — fill in TIER 1 (see below)
make up            # builds the base image, then builds + starts the stack
```

Then open **http://localhost:3000** and log in.

`make up` runs everything in the background. Useful follow-ups:

```sh
make logs          # tail all services
make ps            # status
make down          # stop
```

The first build is slow (it compiles a native toolchain and the agent runtime). Subsequent
`make up` runs are cached.

## What to put in `.env`

`.env.example` is grouped into three tiers; you need **Tier 1** to log in.

### Tier 1 — required to boot and log in

| Var | What |
|-----|------|
| `POSTGRES_PASSWORD` | Password for the bundled Postgres. Set a real value. |
| `ANTHROPIC_API_KEY` | Held by the worker; the agent never sees it directly. |
| `TASCA_SINGLE_TENANT` | `on` for a self-host (auto-provisions one instance org on first boot). |
| `OAUTH_REDIRECT_BASE` | The URL you browse to — `http://localhost:3000` locally. |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | A [GitHub OAuth app](https://github.com/settings/developers). |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | A [Google OAuth client](https://console.cloud.google.com/apis/credentials). |

> **Login needs OAuth configured — there is no anonymous mode.** In a production container the
> API fails closed until a session can be verified, so all five OAuth vars must be set (both
> providers, today) before you can get past the front door. Set each provider's callback URL to
> `<OAUTH_REDIRECT_BASE>/api/auth/<github|google>/callback`.

To point at an **external/managed Postgres** instead of the bundled one, set `DATABASE_URL` in
`.env` and drop the `postgres` service from `docker-compose.yml`.

### Tier 2 — recommended (unlock the full product)

All of Tier 2 is optional for first boot. Once you're logged in you can create agents and
explore; set these to use the product fully.

**`TASCA_SECRET_STORE_KEY`** — the vault key for stored vendor credentials (BYOK). Agents run on
the worker's `ANTHROPIC_API_KEY` without it; set it (`openssl rand -hex 32`) to store per-agent
vendor keys through the UI. When unset, the BYOK surface fails closed (503) and nothing else is
affected.

**GitHub App** — to have an agent actually clone a repo and open a PR, register a GitHub App and
set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, and `GITHUB_WEBHOOK_SECRET`:

1. Create an App at **https://github.com/settings/apps/new**.
2. Permissions: **Contents** read/write, **Pull requests** read/write, **Issues** read/write,
   **Metadata** read.
3. Subscribe to **Issues** and **Issue comment** webhook events; set the webhook URL to your
   worker ingress (`http://<your-host>:8080/webhooks/github`) and a webhook secret
   (= `GITHUB_WEBHOOK_SECRET`).
4. Generate a private key (PEM). Paste it into `GITHUB_APP_PRIVATE_KEY` (multiline is fine; if
   your environment needs single-line, base64-encode the PEM — the worker decodes either).
5. Set `GITHUB_APP_SLUG` to the trailing segment of `github.com/apps/<slug>` so the in-product
   "Connect GitHub" flow can build the install URL.
6. `make down && make up` to apply, then connect your installation from the UI.

### Tier 3 — optional

Shortcut intake (`SHORTCUT_WEBHOOK_SECRET`), email invites (`RESEND_API_KEY` +
`TASCA_INVITE_FROM`), git author identity, and naming an existing org as the instance org —
see the comments in `.env.example`.

## First boot

On first start the worker applies the schema (idempotent) and, with `TASCA_SINGLE_TENANT=on`,
provisions a single instance organization. The first person to log in is enrolled into it. There
is no separate seed or setup step.

## Updating

```sh
git pull && git submodule update --init --recursive
make up
```

## Notes

- **Webhooks** (GitHub/Shortcut) need the worker's `:8080` reachable from the internet (a tunnel
  or a public host). Login and agent creation work without it.
- **Secrets** belong in `.env` (git-ignored) for local use; for a real deployment, inject them
  via your platform's secret store rather than a plaintext file, and never bake them into an image.
- The bundled Postgres stores data in the `pgdata` volume; back it up like any database.
