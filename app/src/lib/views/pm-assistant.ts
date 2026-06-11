// PM-assistant (slice W3-S1) — advisory. The assistant only SUGGESTS; accepting a
// suggestion routes through the normal, inspectable routing decision (the engine + atomic
// claim stay binding). Designed flag-OFF first: when the server reports `enabled:false` the
// view renders the off-state and generation is refused server-side. On-state lists real
// PENDING proposals with Accept / Dismiss live writes, plus an on-demand "Suggest routing"
// affordance over the org's routable tasks. Nothing here is applied until a human accepts.

import { getProposals, getTasks, acceptProposal, dismissProposal, generateProposal } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { liveAction, type LiveActionOpts } from '../live';
import { I, esc, taskRef, tierTag, roControl } from '../ui';
import type { ProposalSummary, RoutingProposalPayload, TriageProposalPayload, DecompositionProposalPayload, TaskSummary, Tier } from '../contract';
import type { WriteResult } from '../api';

const SPARK = I.spark;

const CAP_IC: Record<string, string> = {
  triage:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h14M3 10h9M3 15h5"/></svg>',
  decomp:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/><path d="M9 6h3a2 2 0 012 2v3" stroke-linecap="round"/></svg>',
  route:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="10" r="2.2"/><circle cx="15" cy="5" r="2.2"/><circle cx="15" cy="15" r="2.2"/><path d="M7 9l6-3M7 11l6 3" stroke-linecap="round"/></svg>',
  standup:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M7 2v3M13 2v3" stroke-linecap="round"/></svg>',
};

const CAPS = [
  { ic: 'triage', t: 'Triage', d: 'Reads new issues and proposes a tier estimate + priority. You confirm before anything routes.' },
  { ic: 'decomp', t: 'Decomposition', d: 'Breaks a large story into smaller, independently-routable tasks — as a draft you edit.' },
  { ic: 'route', t: 'Routing proposals', d: 'Suggests which agent fits a task and why. The engine still makes the call; this is a second opinion.' },
  { ic: 'standup', t: 'Standups', d: 'Drafts a daily summary of what shipped, what’s blocked, and what needs you. Yours to send or ignore.' },
];

function head(): string {
  return `<div class="roster-head"><div><h1>PM assistant</h1>
    <div class="sub">Advisory suggestions · triage, decomposition, routing &amp; standups</div></div></div>`;
}

function offState(): string {
  const caps = CAPS.map(
    (c) => `<div class="pm-cap"><span class="pm-cap-ic">${CAP_IC[c.ic]}</span>
      <div><div class="pm-cap-t">${esc(c.t)}</div><div class="pm-cap-d">${esc(c.d)}</div></div></div>`
  ).join('');
  return `<div class="pm-off">
    <div class="pm-hero">
      <span class="pm-badge advisory">Advisory · off by default</span>
      <div class="pm-mark">${SPARK}</div>
      <h2>A PM assistant that only suggests</h2>
      <p>It reads your backlog and proposes triage, task breakdowns, routing, and standups. Every output is a <b>draft you accept, edit, or ignore</b> — the assistant never assigns work or changes anything on its own. You and the routing engine stay in control.</p>
      <div class="pm-actions">
        ${roControl('Turn on suggestions', { icon: SPARK, cls: 'btn-add', gate: 'Enabled by an operator (TASCA_PM_ASSISTANT) — per-org toggle arrives with Settings' })}
        <span class="pm-note mono">Nothing it suggests is binding</span>
      </div>
    </div>
    <div class="pm-caps">${caps}</div>
    <div class="pm-principle"><span class="pmp-k mono">How it stays advisory</span>
      <div class="pmp-row"><span class="pmp-dot"></span>Suggestions appear as cards with <b>Accept</b> / <b>Dismiss</b> — no silent actions.</div>
      <div class="pmp-row"><span class="pmp-dot"></span>Accepting a routing proposal still runs the normal, <b>inspectable</b> routing decision.</div>
      <div class="pmp-row"><span class="pmp-dot"></span>It can read your roster &amp; backlog; it <b>cannot</b> hire agents, change limits, or touch connections.</div>
    </div>
  </div>`;
}

function routingCard(p: ProposalSummary): string {
  const pay = p.payload as RoutingProposalPayload;
  const conf = Math.round(Math.max(0, Math.min(1, Number(pay.confidence) || 0)) * 100);
  const target = p.targetTaskId
    ? `<a class="pms-target mono" href="/tasks?id=${encodeURIComponent(p.targetTaskId)}">${taskRef(p.targetTaskId)}</a>`
    : '';
  return `<div class="pm-suggestion" data-proposal="${esc(p.id)}">
    <div class="pms-top"><span class="pm-cap-ic sm">${CAP_IC.route}</span><span class="pms-tag">Routing proposal</span>
      <span class="pm-badge advisory sm">Suggestion · not applied</span></div>
    <div class="pms-title">Route to <b>${esc(pay.agentName)}</b> ${target}</div>
    <div class="pms-body">${esc(pay.why)}</div>
    <div class="pms-foot"><span class="pms-meta mono dim">confidence ${conf}% · you confirm before it routes</span>
      <div class="pms-act">
        <button class="ictl pm-ctl" type="button" data-action="dismiss" data-proposal="${esc(p.id)}" aria-label="Dismiss this suggestion">Dismiss</button>
        ${roControl('Edit', { gate: 'Editing a proposal arrives with the next sub-slice' })}
        <button class="ictl signal pm-ctl" type="button" data-action="accept" data-proposal="${esc(p.id)}" aria-label="Accept — route to ${esc(pay.agentName)}">Accept</button>
      </div></div></div>`;
}

function triageCard(p: ProposalSummary): string {
  const pay = p.payload as TriageProposalPayload;
  const conf = Math.round(Math.max(0, Math.min(1, Number(pay.confidence) || 0)) * 100);
  const target = p.targetTaskId
    ? `<a class="pms-target mono" href="/tasks?id=${encodeURIComponent(p.targetTaskId)}">${taskRef(p.targetTaskId)}</a>`
    : '';
  return `<div class="pm-suggestion" data-proposal="${esc(p.id)}">
    <div class="pms-top"><span class="pm-cap-ic sm">${CAP_IC.triage}</span><span class="pms-tag">Triage</span>
      <span class="pm-badge advisory sm">Suggestion · not applied</span></div>
    <div class="pms-title">Estimate ${tierTag(pay.tier as Tier)} ${target}</div>
    <div class="pms-body">${esc(pay.why)}</div>
    <div class="pms-foot"><span class="pms-meta mono dim">confidence ${conf}% · you confirm before it re-tiers</span>
      <div class="pms-act">
        <button class="ictl pm-ctl" type="button" data-action="dismiss" data-proposal="${esc(p.id)}" aria-label="Dismiss this suggestion">Dismiss</button>
        ${roControl('Edit', { gate: 'Editing a proposal arrives with the next sub-slice' })}
        <button class="ictl signal pm-ctl" type="button" data-action="accept" data-proposal="${esc(p.id)}" aria-label="Accept — set the tier">Accept</button>
      </div></div></div>`;
}

function decompositionCard(p: ProposalSummary): string {
  const pay = p.payload as DecompositionProposalPayload;
  const chips = (pay.children ?? [])
    .map((c, i) => `<span class="pm-chip">${i + 1} · ${esc(c.title)}</span>`)
    .join(' ');
  const target = p.targetTaskId
    ? `<a class="pms-target mono" href="/tasks?id=${encodeURIComponent(p.targetTaskId)}">${taskRef(p.targetTaskId)}</a>`
    : '';
  return `<div class="pm-suggestion" data-proposal="${esc(p.id)}">
    <div class="pms-top"><span class="pm-cap-ic sm">${CAP_IC.decomp}</span><span class="pms-tag">Decomposition</span>
      <span class="pm-badge advisory sm">Suggestion · not applied</span></div>
    <div class="pms-title">Split into ${(pay.children ?? []).length} subtasks ${target}</div>
    <div class="pms-body">${chips}</div>
    <div class="pms-foot"><span class="pms-meta mono dim">${esc(pay.why ?? '')} · nothing is created until you accept</span>
      <div class="pms-act">
        <button class="ictl pm-ctl" type="button" data-action="dismiss" data-proposal="${esc(p.id)}" aria-label="Dismiss this suggestion">Dismiss</button>
        ${roControl('Edit', { gate: 'Editing a proposal arrives with the next sub-slice' })}
        <button class="ictl signal pm-ctl" type="button" data-action="accept" data-proposal="${esc(p.id)}" aria-label="Accept — create the subtasks">Accept</button>
      </div></div></div>`;
}

/** A task is a candidate for an on-demand suggestion: any open task can be triaged or decomposed;
 *  routing additionally needs a tier estimate (the server returns no suggestion otherwise). */
function suggestRow(t: TaskSummary): string {
  const route = t.tierEstimate !== null
    ? `<button class="ictl pm-ctl" type="button" data-action="generate" data-kind="routing" data-task-id="${esc(t.id)}" aria-label="Suggest a routing for ${esc(t.id)}">Route</button>`
    : '';
  return `<div class="pm-srow">
    <span class="pm-srow-id">${taskRef(t.id)} ${tierTag(t.tierEstimate)}</span>
    <span class="pm-srow-act">
      <button class="ictl pm-ctl" type="button" data-action="generate" data-kind="triage" data-task-id="${esc(t.id)}" aria-label="Suggest a triage for ${esc(t.id)}">${SPARK} Triage</button>
      <button class="ictl pm-ctl" type="button" data-action="generate" data-kind="decomposition" data-task-id="${esc(t.id)}" aria-label="Suggest a decomposition for ${esc(t.id)}">Decompose</button>
      ${route}
    </span>
  </div>`;
}

function suggestionCard(p: ProposalSummary): string {
  if (p.kind === 'triage') return triageCard(p);
  if (p.kind === 'decomposition') return decompositionCard(p);
  return routingCard(p);
}

function onState(proposals: ProposalSummary[], suggestable: TaskSummary[]): string {
  const cardsFor = proposals.filter((p) => p.kind === 'routing' || p.kind === 'triage' || p.kind === 'decomposition');
  const cards = cardsFor.length
    ? `<div class="pm-suggestions">${cardsFor.map(suggestionCard).join('')}</div>`
    : empty('No suggestions yet', 'Generate a triage, routing, or decomposition suggestion from one of your tasks below — nothing is applied until you accept it.', SPARK);
  const gen = suggestable.length
    ? `<div class="pm-gen"><div class="pm-gen-h mono">Generate a suggestion</div>${suggestable.map(suggestRow).join('')}</div>`
    : '';
  return `<div class="pm-on">
    <div class="pm-on-head"><div><div class="pm-on-t"><span class="pm-mark sm">${SPARK}</span> PM assistant <span class="pm-badge advisory sm">Advisory · on</span></div>
      <div class="pm-on-s">Suggestions below. Nothing here has been applied — accept or dismiss each.</div></div></div>
    ${cards}${gen}</div>`;
}

export async function loadPmAssistant(): Promise<LoadResult> {
  const res = await getProposals();
  if (res.kind !== 'ok') return fromResult(res, () => ({ kind: 'ok', html: '' }));
  if (!res.data.enabled) {
    return { kind: 'ok', html: `${head()}<div class="pm-body">${offState()}</div>` };
  }
  // On: also pull the backlog for the on-demand suggestion list. Triage applies to any open task;
  // routing needs an estimate (the Route button only shows then).
  const OPEN = new Set(['ingested', 'routable', 'needs_attention', 'failed']);
  const tasks = await getTasks({ limit: 50 });
  const suggestable = tasks.kind === 'ok' ? tasks.data.filter((t) => OPEN.has(t.status)) : [];
  return { kind: 'ok', html: `${head()}<div class="pm-body">${onState(res.data.proposals, suggestable)}</div>` };
}

/** Human, honest reason for a failed proposal write. */
function describeProposal(r: WriteResult<unknown>): string {
  if (r.kind === 'conflict') {
    const code = (r.data as { code?: string } | undefined)?.code;
    if (code === 'agent_not_hired') return 'That agent isn’t on your roster — it was not routed. Hire the agent or pick another.';
    return 'This suggestion was already handled, or its task moved. Showing the latest.';
  }
  if (r.kind === 'forbidden') return 'Your session’s security token expired. Showing the latest — please retry.';
  if (r.kind === 'notfound') return 'This suggestion no longer exists. Showing the latest.';
  if (r.kind === 'error') return `Couldn’t apply that (${r.message}). Showing the latest.`;
  return 'Couldn’t apply that. Showing the latest.';
}

export function wirePmAssistant(el: HTMLElement, rerun: () => Promise<void>): void {
  el.querySelectorAll<HTMLButtonElement>('.pm-ctl[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const opts: LiveActionOpts<unknown> = {
        button: btn,
        pendingLabel: action === 'accept' ? 'Routing…' : action === 'generate' ? 'Thinking…' : 'Dismissing…',
        view: el,
        rerun,
        describe: describeProposal,
        write: () => {
          if (action === 'accept') return acceptProposal(btn.dataset.proposal ?? '');
          if (action === 'dismiss') return dismissProposal(btn.dataset.proposal ?? '');
          const k = btn.dataset.kind;
          const kind = k === 'triage' || k === 'decomposition' ? k : 'routing';
          return generateProposal(btn.dataset.taskId ?? '', kind);
        },
      };
      void liveAction(opts);
    });
  });
}
