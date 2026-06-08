# The Tasca worker image: coordination HTTP server + in-process execution + the
# credential broker + the dispatch reaper. A Node runtime that runs the composition
# root (packages/coordination/src/main.ts) and, on demand, spawns the Claude Code CLI
# over a PTY, creates git worktrees, and opens PRs.
#
# It shares the heavy toolchain (native rebuild + git/gh/claude + the installed pnpm
# workspace) with the agent-runner via the published base image — built ONCE, so the
# two images can't drift and the native rebuild doesn't run twice.
ARG TASCA_BASE_IMAGE=tasca-base:latest
FROM ${TASCA_BASE_IMAGE}

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
