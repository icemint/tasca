// The agent-runner process entry. Boots with NO worker secret in its env: a Postgres
// URL (the queue), a unix-socket path (the broker), and the agent toolchain on PATH.
// It claims dispatch_job, asks the broker for a per-task scoped token, runs the agent,
// and revokes the token. Designed for a separate, non-root, egress-restricted
// container (the deploy slice wires that isolation).

import { Pool } from 'pg';
import { PgDispatchQueue } from '@tasca/db';
import { brokerClient } from '@tasca/broker';
import { serveAnthropicBridge, type AnthropicBridgeHandle } from '@tasca/anthropic-proxy';
import { createExecution } from '@tasca/execution';
import path from 'node:path';
import os from 'node:os';
import { createRunner } from './runner';
import { makeRunnerExecute } from './execute';

const DEFAULT_ANTHROPIC_BRIDGE_PORT = 8787;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`agent-runner: ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const brokerSocket = requireEnv('TASCA_BROKER_SOCKET');
  const runnerId = process.env.TASCA_RUNNER_ID ?? `runner-${process.pid}`;
  const reposDir = process.env.TASCA_REPOS_DIR ?? path.join(os.tmpdir(), 'tasca-repos');

  const pool = new Pool({ connectionString: databaseUrl });
  const queue = new PgDispatchQueue(pool);
  const broker = brokerClient({ socketPath: brokerSocket });

  // Anthropic credential proxy (runner side): a KEYLESS TCP↔unix bridge to the worker's
  // proxy socket. Point the agent's Claude CLI at it via ANTHROPIC_BASE_URL; the worker
  // injects the real key on its HTTPS leg, so the runner/agent never holds it. Only when
  // the proxy socket is wired (production) — absent → the agent uses ANTHROPIC_API_KEY
  // directly (dev/no-proxy), the factory's direct mode.
  let anthropicBridge: AnthropicBridgeHandle | undefined;
  const anthropicProxySocket = process.env.TASCA_ANTHROPIC_PROXY_SOCKET;
  if (anthropicProxySocket) {
    const listenPort = process.env.TASCA_ANTHROPIC_BRIDGE_PORT
      ? Number(process.env.TASCA_ANTHROPIC_BRIDGE_PORT)
      : DEFAULT_ANTHROPIC_BRIDGE_PORT;
    try {
      anthropicBridge = await serveAnthropicBridge({ listenPort, socketPath: anthropicProxySocket, logger: console });
      // The agent inherits this via the factory allowlist; the real key is NOT in env.
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropicBridge.port}`;
      console.log('agent-runner: anthropic bridge listening', { port: anthropicBridge.port });
    } catch (err) {
      console.error('agent-runner: anthropic bridge failed to start — agent model calls will fail', { err: String(err) });
    }
  }

  // The execution toolchain (PTY agent spawn, git, gh) — the SAME ExecutionPort the
  // worker uses, so spawnAgent's env scrub (#230) carries over to the runner.
  const execution = createExecution();
  try {
    await execution.initDb();
  } catch (err) {
    console.error('agent-runner: execution store init failed', { err: String(err) });
  }

  // The real execute: clone (scoped-token env-auth) → spawn → commit → openPr.
  const execute = makeRunnerExecute({ execution, reposDir, logger: console });

  const runner = createRunner({
    queue,
    broker,
    execute,
    runnerId,
    // Per-job attribution for agent-call metering (slice W3-S4b): the bridge stamps these onto each
    // request head so the worker proxy records usage_event{source:'agent'}. No bridge (dev/no-proxy)
    // → no-op (the agent calls Anthropic directly, unmetered by this path).
    ...(anthropicBridge ? { setUsageContext: (ctx) => anthropicBridge!.setContext(ctx) } : {}),
    logger: console,
  });
  runner.start();
  console.log('agent-runner: started', { runnerId, reposDir });

  const shutdown = (): void => {
    void (async () => {
      console.log('agent-runner: shutting down');
      await runner.stop();
      await Promise.allSettled([pool.end(), execution.close(), anthropicBridge?.close() ?? Promise.resolve()]);
      process.exit(0);
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('agent-runner: failed to start', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
