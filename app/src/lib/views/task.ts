// Routing inspector (C5, read-only). For one task (GET /api/tasks/:id) it shows
// the routing decision flow (estimated tier → candidates → winner) and any linked
// pull requests. Intervention controls render visible-but-disabled. Absent data
// (no decision yet, no PRs) renders honest empty rows, never fabricated scores.

import { getTask } from '../api';
import { fromResult, queryId, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, tierTag, taskRef, platTag, esc, roControl } from '../ui';
import type { PullRequest, RoutingCandidate, RoutingDecision, TaskDetail } from '../contract';

function candidate(c: RoutingCandidate, rank: number, winner: string | null): string {
  const chosen = c.agentId === winner;
  const scorePct = Math.round(Math.max(0, Math.min(1, c.score)) * 100);
  const reasons = c.reasons.length ? esc(c.reasons.join(' · ')) : (c.eligible ? 'Eligible' : 'Not eligible');
  return `<div class="cand${chosen ? ' chosen' : ''}">
    <span class="cand-rank">${rank}</span>
    <span class="cand-id"><a class="cand-name" href="/agents?id=${encodeURIComponent(c.agentId)}">${esc(c.agentId)}</a><span class="cand-note">${reasons}</span></span>
    ${c.eligible
      ? `<span class="cand-score"><span class="scorebar"><span style="width:${scorePct}%"></span></span><span class="scoreval">${c.score.toFixed(2)}</span></span>`
      : `<span class="cand-pass">passed</span>`}
    ${chosen ? '<span class="routed-badge">Routed</span>' : ''}
  </div>`;
}

function decisionBlock(d: RoutingDecision): string {
  const ranked = [...d.candidates].sort((a, b) => b.score - a.score);
  const cands = ranked.length
    ? ranked.map((c, i) => candidate(c, i + 1, d.winnerAgentId)).join('')
    : '<div class="we-s" style="padding:8px 0">No candidates were recorded for this decision.</div>';
  return `<div class="pcard decision">
    <div class="pc-h">Routing decision <span class="tag-inspect">Inspector</span></div>
    <div class="flow">
      <div class="flow-step"><div class="fs-k">Estimated tier</div><div class="fs-v big">${esc(d.tierEstimate.toUpperCase())}</div></div>
      <div class="flow-arr">${I.arrow}</div>
      <div class="flow-step"><div class="fs-k">Candidates</div><div class="fs-v big">${ranked.length}</div></div>
      <div class="flow-arr">${I.arrow}</div>
      <div class="flow-step"><div class="fs-k">Routed to</div><div class="fs-v big">${d.winnerAgentId ? esc(d.winnerAgentId) : '—'}</div></div>
    </div>
    <div class="cand-head"><span>Agent</span><span>Score</span></div>
    <div class="cands">${cands}</div>
  </div>`;
}

function prRow(p: PullRequest): string {
  return `<div class="prrow"><a class="prchip big" href="${esc(p.url)}" target="_blank" rel="noopener">${I.pr} ${esc(p.url.replace(/^https?:\/\//, ''))}</a><span class="ci ci-${p.state === 'merged' ? 'merged' : p.state === 'open' ? 'running' : 'green'}">${esc(p.state)}</span></div>`;
}

export async function loadTask(): Promise<LoadResult> {
  const id = queryId();
  if (!id) {
    return { kind: 'empty', html: empty('No task selected', 'Pick a task from Monitoring to inspect its routing.', I.monitor) };
  }
  const res = await getTask(id);
  return fromResult(res, (t: TaskDetail) => {
    const head = `<div class="vhead">
        <a class="vback" href="/monitoring">${I.back} Monitoring</a>
        <div class="vh-main">
          <div class="vh-id"><div>
            <div class="vh-eyebrow">${platTag(t.platform)}${taskRef(t.id)}${tierTag(t.tierEstimate)}</div>
            <div class="vh-name task">${esc(t.externalStoryId)}</div>
            <div class="vh-meta"><span class="mono dim">${t.repoRef ? esc(t.repoRef) : '—'}</span><span class="branch-tag">${esc(t.status)}</span>${t.claimedBy ? `<span class="mono dim">claimed by ${esc(t.claimedBy)}</span>` : ''}</div>
          </div></div>
          <div class="vh-actions">
            ${roControl('Reassign')}
            ${roControl('Escalate', { cls: 'ictl amber' })}
          </div>
        </div></div>`;

    const decision = t.routingDecision
      ? decisionBlock(t.routingDecision)
      : `<div class="pcard decision"><div class="pc-h">Routing decision</div>${empty('No routing decision yet', 'This task has not been routed. Once the engine estimates a tier and ranks candidates, the decision appears here.', I.spark)}</div>`;

    const prs = t.pullRequests.length
      ? `<div class="pcard" style="margin-top:18px"><div class="pc-h">Pull requests</div>${t.pullRequests.map(prRow).join('')}</div>`
      : '';

    return { kind: 'ok', html: `${head}${decision}${prs}` };
  });
}
