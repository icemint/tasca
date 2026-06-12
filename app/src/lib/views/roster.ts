// Roster view (C4) — "Your team". Lists every agent from GET /api/agents as cards.
// Per-card Hire/Unhire (slice W4-S3) links an agent into the ACTIVE org (org_agent), which is
// what makes it routable; admin+ only (the server enforces it too — the UI gate is UX). The
// "Add agent" header control (provisioning a NEW global agent) stays gated — that's W4-S5.

import { getAgents, getHiredAgents, canManageActiveOrg, hireAgent, unhireAgent, type WriteResult } from '../api';
import { liveAction } from '../live';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, avatar, vendorChip, statePill, tierRamp, pct, taskRef, esc, roControl, RO_GATE_PROVISION, RO_GATE_ADMIN_ROSTER } from '../ui';
import type { Agent } from '../contract';

function healthStrip(agents: Agent[]): string {
  const count = (s: Agent['state']) => agents.filter((a) => a.state === s).length;
  const tiles = [
    { k: 'In flight', v: count('working'), g: 'var(--state-working)' },
    { k: 'Awaiting input', v: count('awaiting_input'), g: 'var(--state-awaiting)' },
    { k: 'Blocked', v: count('blocked'), g: 'var(--state-blocked)' },
    { k: 'Shipped', v: count('shipped'), g: 'var(--state-shipped)' },
    { k: 'Idle', v: count('idle'), g: 'var(--fg-faint)' },
  ];
  return `<div class="health-strip">${tiles
    .map(
      (t) =>
        `<div class="hstat"><span class="k"><span class="glyph" style="background:${t.g}"></span>${t.k}</span><span class="v">${t.v}</span></div>`
    )
    .join('')}</div>`;
}

/** The per-card hire/unhire control. Admin+ → an enabled live control; otherwise the disabled
 *  control with an honest reason (never a button that would just 403). */
function hireControl(a: Agent, hired: boolean, canManage: boolean): string {
  const label = hired ? 'Unhire' : 'Hire';
  if (!canManage) return roControl(label, { cls: 'ictl', gate: RO_GATE_ADMIN_ROSTER });
  const act = hired ? 'unhire' : 'hire';
  return `<button class="ictl hire-ctl ${hired ? 'is-hired' : 'signal'}" type="button" data-act="${act}" data-agent-id="${esc(a.id)}" aria-label="${label} ${esc(a.name)}">${label}</button>`;
}

function card(a: Agent, hired: boolean, canManage: boolean): string {
  const task = a.currentTaskId
    ? `<a class="linktask" href="/tasks?id=${encodeURIComponent(a.currentTaskId)}">${taskRef(a.currentTaskId)}</a>`
    : 'No active task · available to route';
  return `<article class="agentcard">
    <a class="id" href="/agents?id=${encodeURIComponent(a.id)}">${avatar(a, 'av-lg')}
      <div class="nm"><div class="name">${esc(a.name)}</div>
        <div class="meta">${vendorChip(a.vendor)}<span class="mono dim">${esc(a.model)}</span></div></div>
      ${statePill(a.state)}</a>
    <div class="task ${a.currentTaskId ? '' : 'muted'}">${task}</div>
    <div class="foot">
      <div class="metricset">
        <div class="metric"><span class="mv">${pct(a.capability.successRate)}</span><span class="mk">Success</span></div>
        <div class="metric"><span class="mv">${a.capability.concurrencyLimit ?? '—'}</span><span class="mk">Slots</span></div>
      </div>${tierRamp(a.capability)}</div>
    <div class="card-actions"><span class="hire-state ${hired ? 'on' : ''}">${hired ? 'Hired' : 'Not hired'}</span>${hireControl(a, hired, canManage)}</div>
  </article>`;
}

export async function loadRoster(): Promise<LoadResult> {
  // The agent list drives the page; the hired set + role are best-effort enrichments (a failure of
  // either degrades to "not hired" / non-admin — never blocks the roster, never falsely enables).
  const [res, hiredRes, canManage] = await Promise.all([getAgents(), getHiredAgents(), canManageActiveOrg()]);
  const hiredSet = new Set(hiredRes.kind === 'ok' ? hiredRes.data.agents.map((h) => h.agentId) : []);

  return fromResult(res, (agents) => {
    const addAgent = roControl('Add agent', { icon: I.plus, cls: 'btn-add', gate: RO_GATE_PROVISION });
    const head = `<div class="roster-head">
        <div><h1>Your team</h1><div class="sub"><b>${agents.length}</b> ${agents.length === 1 ? 'agent' : 'agents'} · <b>${agents.filter((a) => a.state !== 'idle').length}</b> active</div></div>
        ${addAgent}</div>`;

    if (!agents.length) {
      return {
        kind: 'empty',
        html:
          head +
          empty(
            'No agents yet',
            'Once you connect a platform and deploy your first agent, your team appears here.',
            I.roster
          ),
      };
    }
    return {
      kind: 'ok',
      html: `${head}${healthStrip(agents)}<div class="agent-grid">${agents.map((a) => card(a, hiredSet.has(a.id), canManage)).join('')}</div>`,
    };
  });
}

/** Honest failure copy for hire/unhire — covers the real outcomes (already hired/not hired → 409/404,
 *  not-admin-or-stale-CSRF → 403). Truth is always re-rendered (rerun); this names what happened. */
function describeRosterFailure(r: WriteResult<unknown>): string {
  switch (r.kind) {
    case 'conflict':
      return 'Roster already up to date — showing the latest.';
    case 'notfound':
      return 'That agent isn’t available to change — showing the latest.';
    case 'forbidden':
      return 'Couldn’t apply — you may not have admin rights, or your session token expired. Showing the latest.';
    case 'unconfigured':
      return 'Roster management isn’t enabled on this workspace yet.';
    case 'error':
      return `Couldn’t apply the change (${r.message}). Showing the latest.`;
    default:
      return 'Couldn’t apply the change. Showing the latest.';
  }
}

/** Wire the per-card hire/unhire controls (mount passes `rerun` = re-fetch + re-render from truth). */
export function wireRoster(el: HTMLElement, rerun: () => Promise<void>): void {
  el.querySelectorAll<HTMLButtonElement>('.hire-ctl[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.agentId;
      if (!id) return;
      const hire = btn.dataset.act === 'hire';
      void liveAction({
        button: btn,
        pendingLabel: hire ? 'Hiring…' : 'Removing…',
        view: el,
        rerun,
        write: (): Promise<WriteResult<unknown>> => (hire ? hireAgent(id) : unhireAgent(id)),
        describe: describeRosterFailure,
      });
    });
  });
}
