# Shared vendor base — the heavy, identical layers the worker AND the agent-runner
# both need: the native build toolchain, the agent's runtime tools (git, gh, the
# Claude CLI), the installed pnpm workspace, and the natively-rebuilt vendor modules
# (sqlite3 / node-pty / keytar). Built ONCE and published; worker.Dockerfile and
# runner.Dockerfile both `FROM` it, so the native rebuild + claude install happen a
# single time instead of per-image (no duplication, no drift between the two).
#
# Build context is the repo ROOT (packages/* + the emdash submodule under
# packages/execution/vendor; CD checks out with submodules). Debian bookworm ships
# Python 3.11 — node-gyp needs <3.12 (distutils) — so installing python3 is enough.
#
# This image carries NO runtime config and NO CMD: the final images set their own
# env, user, and entrypoint.
FROM node:22-bookworm

# --- system toolchain: native-build deps + the agent's runtime tools ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git \
      python3 python3-dev make g++ \
      libsecret-1-dev libsecret-1-0 \
  # GitHub CLI (gh) from its official apt repo — the agent uses it to open PRs.
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Copy the workspace (the .dockerignore strips node_modules/.git/docs/website/app,
# but keeps packages/* and the emdash submodule under packages/execution/vendor).
COPY . .

# Install the workspace (root pnpm 9.15.4 via packageManager), then build the
# de-Electron vendor fork with the same native-rebuild recipe CI uses.
RUN pnpm install --frozen-lockfile
RUN cd packages/execution/vendor/emdash && corepack prepare pnpm@10.28.2 --activate
RUN cd packages/execution && TASCA_PYTHON_311=python3.11 node scripts/build-vendor.mjs

# The Claude Code CLI (the agent) onto PATH; spawnAgent runs `claude`.
RUN npm i -g @anthropic-ai/claude-code && claude --version
