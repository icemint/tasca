// One-shot operator CLI: register an agent's native GitHub identity binding so the
// worker will route issues assigned to that GitHub account to the agent.
//
//   DATABASE_URL=…  GITHUB_USER_ID=<numeric>  [GITHUB_LOGIN=<login>] \
//     [AGENT_ID=<existing> | AGENT_NAME=<name> AGENT_MODEL=<model> [AGENT_VENDOR=] [AGENT_MAX_TIER=]] \
//     pnpm --filter @tasca/coordination provision-github-agent
//
// The worker snapshots bindings at boot — RESTART it after provisioning. Thin shell:
// all logic + validation lives in the testable core.

import { Pool } from 'pg';
import { PgIdentityRepository } from '@tasca/identity';
import { provisionGitHubAgent } from '../src/github-agent-provisioning';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await provisionGitHubAgent(new PgIdentityRepository(pool), {
      githubUserId: process.env.GITHUB_USER_ID,
      githubLogin: process.env.GITHUB_LOGIN,
      agentId: process.env.AGENT_ID,
      agentName: process.env.AGENT_NAME,
      model: process.env.AGENT_MODEL,
      vendor: process.env.AGENT_VENDOR,
      maxTier: process.env.AGENT_MAX_TIER,
    });
    console.log(
      JSON.stringify({
        ok: true,
        ...result,
        note: 'restart the worker to pick up the new binding (it snapshots active bindings at boot)',
      })
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
