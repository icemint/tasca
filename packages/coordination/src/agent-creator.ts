// The Postgres AgentCreator (slice Wizard-A): mint an agent + capability profile + auto-hire into the
// caller's org in ONE transaction, so a partial failure leaves NO orphan global agent.
//
// Why one tx (and how): PgIdentityRepository and PgOrgRosterRepo both accept a Queryable (Pool |
// PoolClient). We check out a single client here, BEGIN, construct BOTH repos over that client, run
// create → setCapabilityProfile → hire on it, then COMMIT. The identity repo's createAgent reuses the
// caller's tx when handed a client (no nested BEGIN), so all three writes share one boundary — if the
// hire fails (or any step throws) the whole tx rolls back and the agent never existed. The principal is
// minted exactly once (inside createAgent).

import type { Pool, PoolClient } from 'pg';
import { PgIdentityRepository } from '@tasca/identity';
import { PgOrgRosterRepo } from './roster';
import { tiersUpTo, type AgentCreator, type CreateAgentOutcome, type CreateAgentRequest } from './agent-api';

export class PgAgentCreator implements AgentCreator {
  constructor(private readonly pool: Pool) {}

  async create(orgId: string, req: CreateAgentRequest): Promise<CreateAgentOutcome> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const identity = new PgIdentityRepository(client);
      const roster = new PgOrgRosterRepo(client);

      const created = await identity.createAgent({
        name: req.name,
        vendor: req.vendor,
        model: req.model,
        ...(req.avatarUrl !== undefined ? { avatarUrl: req.avatarUrl } : {}),
      });
      const agentId = created.agent.id;

      await identity.setCapabilityProfile({
        agentId,
        maxTier: req.maxTier,
        tiersCovered: tiersUpTo(req.maxTier),
        languageSpecialties: [],
        frameworkSpecialties: [],
        concurrencyLimit: 1,
        // 0 = "no cap" as this type models it (setCapabilityProfile's costCeiling is `number`, and the
        // read path coalesces NULL→0, so 0 and NULL display identically). A new agent is uncapped.
        // (The null-vs-0 distinction only matters once cost enforcement reads the raw column — that
        // slice should widen the write type to number|null and fix the read-coalesce together.)
        costCeiling: 0,
        successRate: null,
        avgLatencyMs: null,
      });

      const hired = await roster.hire(orgId, agentId);
      if (hired !== 'ok') {
        // The hire didn't attach the agent — roll the whole thing back so no orphan agent survives.
        await client.query('ROLLBACK');
        return { ok: false, reason: hired };
      }

      await client.query('COMMIT');
      return {
        ok: true,
        agent: { id: agentId, name: req.name, vendor: req.vendor, model: req.model, maxTier: req.maxTier },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
