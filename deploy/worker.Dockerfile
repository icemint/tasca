# The Tasca worker image: coordination HTTP server + in-process execution.
#
# Unlike the website/app images (static nginx), this is a Node runtime that runs
# the composition root (packages/coordination/src/main.ts) and, on demand, spawns
# the Claude Code CLI over a PTY, creates git worktrees, and opens PRs. It carries
# the full execution toolchain: git, gh, the Claude CLI, and the natively-rebuilt
# vendor modules (sqlite3 / node-pty / keytar).
#
# Build context is the repo ROOT (the worktree spans packages/* + the emdash
# submodule under packages/execution/vendor). CD checks out with submodules.
# Debian bookworm ships Python 3.11 — node-gyp needs <3.12 (distutils), so no
# extra Python pin is required beyond installing python3.
#
# Single-stage on purpose: the pnpm workspace + native rebuild + vendor's own
# pnpm store are awkward to copy between stages; image size is a Stage-1
# non-priority. Slim later if it matters.
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

# The Claude Code CLI (the agent) onto PATH; factory.spawnAgent runs `claude`.
RUN npm i -g @anthropic-ai/claude-code && claude --version

# Runtime config. HOME=/data so the secret-store dir + git/gh config land on the
# mounted volume alongside the execution SQLite and the git worktrees.
ENV NODE_ENV=production \
    HOME=/data \
    PORT=8080 \
    EMDASH_DB_FILE=/data/execution.sqlite \
    TASCA_WORKTREE_ROOT=/data/worktrees
RUN mkdir -p /data/worktrees
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

CMD ["pnpm", "start:worker"]
