// The agent-runner process entry. Boots with NO worker secret in its env: a Postgres
// URL (the queue), a unix-socket path (the broker), and the agent toolchain on PATH.
// It claims dispatch_job, asks the broker for a per-task scoped token, runs the agent,
// and revokes the token. Designed for a separate, non-root, egress-restricted
// container (the deploy slice wires that isolation).

import { Pool } from 'pg';
import { PgDispatchQueue } from '@tasca/db';
import { brokerClient } from '@tasca/broker';
import { createRunner, type ExecuteJob } from './runner';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`agent-runner: ${name} is required`);
    process.exit(1);
  }
  return v;
}

function main(): void {
  const databaseUrl = requireEnv('DATABASE_URL');
  const brokerSocket = requireEnv('TASCA_BROKER_SOCKET');
  const runnerId = process.env.TASCA_RUNNER_ID ?? `runner-${process.pid}`;

  const pool = new Pool({ connectionString: databaseUrl });
  const queue = new PgDispatchQueue(pool);
  const broker = brokerClient({ socketPath: brokerSocket });

  // Placeholder execute: the real clone/worktree/spawn/openPr wiring (using the scoped
  // token for git auth via the ExecutionPort) lands with the enqueue slice. Until then
  // the runner boots + claims — proving the queue + broker plumbing — and defers any
  // job. No job is enqueued before that slice, so the placeholder never actually runs.
  const execute: ExecuteJob = async (job, payload) => {
    console.log('agent-runner: claimed a job (execution not yet wired)', {
      jobId: job.id,
      repoRef: payload.repoRef,
    });
    return { ok: false, retry: true, error: 'execution not yet wired' };
  };

  const runner = createRunner({ queue, broker, execute, runnerId, logger: console });
  runner.start();

  const shutdown = (): void => {
    void (async () => {
      console.log('agent-runner: shutting down');
      await runner.stop();
      await pool.end().catch(() => {});
      process.exit(0);
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
