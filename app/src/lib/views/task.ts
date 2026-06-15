// Routing inspector (C5). For one task (GET /api/tasks/:id) it shows the routing
// decision flow (estimated tier → candidates → winner) and any linked pull requests.
// Reassign + Interrupt are LIVE controls (the cancel-coupled write-API); Escalate stays
// read-only. Absent data (no decision yet, no PRs) renders honest empty rows.

import { getTask, reassignTask, interruptTask, forceResetTask, type WriteResult, type TaskWriteOk, type TaskWriteConflict } from '../api';
import { fromResult, queryId, type LoadResult } from '../mount';
import { empty } from '../states';
import { liveAction, describeFailure } from '../live';
import { I, tierTag, taskRef, taskLabel, platTag, esc, roControl } from '../ui';
import type { PullRequest, RoutingCandidate, RoutingDecision, TaskDetail } from '../contract';

/** The cancel-coupled controls. Interrupt only renders while a run is live (executing); Reassign
 *  renders live for any non-terminal task; both carry just the task id — the backend cancels any
 *  live runner job atomically with the task transition (the #244 seam). Force reset renders on the
 *  stuck states (executing/claimed): the operator escape hatch (issue 317) for a run that wedged
 *  with no live job, which interrupt/reassign can't clear (they dead-end no_inflight). Admin-only
 *  server-side — a non-admin's click 403s and surfaces honestly. */
function taskActions(t: TaskDetail): string {
  const interrupt =
    t.status === 'executing'
      ? `<button class="ictl live-ctl amber" type="button" data-action="interrupt" data-task-id="${esc(t.id)}" aria-label="Interrupt this run">${I.pause} Interrupt</button>`
      : '';
  const forceReset =
    t.status === 'executing' || t.status === 'claimed'
      ? `<button class="ictl live-ctl" type="button" data-action="force-reset" data-task-id="${esc(t.id)}" aria-label="Force-reset this stuck task">Force reset</button>`
      : '';
  const reassign =
    t.status === 'done'
      ? roControl('Reassign')
      : `<button class="ictl live-ctl" type="button" data-action="reassign" data-task-id="${esc(t.id)}" aria-label="Reassign this task">Reassign</button>`;
  return `${interrupt}${forceReset}${reassign}${roControl('Escalate', { cls: 'ictl amber' })}`;
}

/** Honest copy for the three "couldn't apply" truths — the UI must never tell the user it
 *  "interrupted" a run that had already finished. Success is shown by the re-render (the task's
 *  status flips to routable/needs_attention), so only the non-ok outcomes get a banner. */
export function describeTaskOutcome(r: WriteResult<TaskWriteOk | TaskWriteConflict>): string {
  if (r.kind === 'conflict') {
    const code = (r.data as TaskWriteConflict).code;
    if (code === 'too_late') return 'The agent already finished — showing the result.';
    if (code === 'no_inflight') return 'This run is executing in-process and can’t be interrupted — use Force reset to clear it.';
    return 'That action isn’t available in the task’s current state — showing the latest.';
  }
  // A 403 that survives the CSRF refresh-and-retry on a task write is a ROLE denial, not a stale
  // token (a fresh token can't grant a role) — Force reset is admin-only, the other interventions
  // member+. The generic describeFailure would wrongly claim "security token expired … please
  // retry" (a futile loop); tell the operator the truth instead.
  if (r.kind === 'forbidden') return 'You don’t have permission to do that — showing the latest.';
  return describeFailure(r);
}

/** Wire the task view's live controls after each render; `rerun` reconciles to server truth.
 *  Re-reads the task id from the DOM each render (the button is discarded + rebuilt on rerun). */
export function wireTask(el: HTMLElement, rerun: () => Promise<void>): void {
  el.querySelectorAll<HTMLButtonElement>('.live-ctl[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.taskId ?? '';
      const action = btn.dataset.action;
      void liveAction({
        button: btn,
        pendingLabel:
          action === 'interrupt' ? 'Interrupting…' : action === 'force-reset' ? 'Resetting…' : 'Reassigning…',
        view: el,
        rerun,
        write: () =>
          action === 'interrupt' ? interruptTask(id) : action === 'force-reset' ? forceResetTask(id) : reassignTask(id),
        describe: describeTaskOutcome,
      });
    });
  });
}

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
      <div class="flow-step"><div class="fs-k">Routed to</div><div class="fs-v big">${d.winnerAgentId ? esc(d.winnerAgentId) : '—'}${d.policy === 'em' ? '<span class="coming-tag">Assigned by EM</span>' : ''}</div></div>
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
            <div class="vh-name task">${esc(taskLabel(t))}</div>
            <div class="vh-meta"><span class="mono dim">${t.repoRef ? esc(t.repoRef) : '—'}</span><span class="branch-tag">${esc(t.status)}</span>${t.claimedBy ? `<span class="mono dim">claimed by ${esc(t.claimedBy)}</span>` : ''}</div>
          </div></div>
          <div class="vh-actions">
            ${taskActions(t)}
          </div>
        </div></div>`;

    // When a task is parked (needs_attention) with a recorded reason, surface it honestly so
    // the state is actionable — e.g. "no execution capacity" when no runner was available.
    const attention = t.lastError
      ? `<div class="pcard attention" style="margin-bottom:18px"><div class="pc-h">Needs attention</div><div class="we-s" style="padding:6px 0">${esc(t.lastError)}</div></div>`
      : '';

    const decision = t.routingDecision
      ? decisionBlock(t.routingDecision)
      : `<div class="pcard decision"><div class="pc-h">Routing decision</div>${empty('No routing decision yet', 'This task has not been routed. Once the engine estimates a tier and ranks candidates, the decision appears here.', I.spark)}</div>`;

    const prs = t.pullRequests.length
      ? `<div class="pcard" style="margin-top:18px"><div class="pc-h">Pull requests</div>${t.pullRequests.map(prRow).join('')}</div>`
      : '';

    return { kind: 'ok', html: `${head}${attention}${decision}${prs}` };
  });
}
