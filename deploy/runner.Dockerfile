# The agent-runner image: the execution-side worker. It claims dispatch_job from the
# Postgres queue, asks the broker (over a mounted unix socket) for a per-task scoped
# token, runs the agent, and revokes the token. It shares the heavy toolchain with the
# worker via the published base image (no second native rebuild).
#
# It carries NO worker secret: only DATABASE_URL (the queue), TASCA_BROKER_SOCKET (the
# broker socket path on the shared volume), and ANTHROPIC_API_KEY (the agent model).
# The master GitHub App key stays in the worker, behind the broker.
#
# SECURITY (hardened in the deploy slice): this container runs as a dedicated NON-ROOT
# user on a separate, egress-restricted network (Anthropic + GitHub only) so a
# prompt-injected agent can't exfiltrate its scoped token. Those controls (USER,
# network policy / egress proxy) land with the Coolify wiring + the deploy panel.
ARG TASCA_BASE_IMAGE=tasca-base:latest
FROM ${TASCA_BASE_IMAGE}

# DROP ROOT. The runner executes a prompt-injected agent, so it runs as a dedicated
# non-root user — a container escape or a malicious `claude` child has no root in the
# container. The user owns /data (HOME + worktrees + clones); /app (the workspace) stays
# root-owned and world-readable (the runner only reads it). The broker socket is mounted
# from the worker's shared volume; the deploy grants this uid access via the socket perms.
RUN useradd --create-home --home-dir /home/tasca --uid 10001 --user-group tasca \
  && mkdir -p /data/worktrees /data/repos \
  && chown -R tasca:tasca /data

# Runtime config. HOME=/data for the agent's git/gh config + the per-task worktrees;
# TASCA_REPOS_DIR keeps clones on the volume (not /tmp) so teardown + disk are bounded.
ENV NODE_ENV=production \
    HOME=/data \
    TASCA_WORKTREE_ROOT=/data/worktrees \
    TASCA_REPOS_DIR=/data/repos \
    TASCA_BROKER_SOCKET=/run/tasca/broker.sock
VOLUME ["/data"]

USER tasca

# Runs the runner claim loop (packages/agent-runner/src/main.ts via tsx).
CMD ["pnpm", "--filter", "@tasca/agent-runner", "start"]
