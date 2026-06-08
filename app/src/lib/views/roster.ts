// Roster view (C4) — "Your team". Lists every agent from GET /api/agents as
// cards, with a team-health strip derived from the real agent states. Write
// controls (Add agent) render visible-but-disabled. No fake rows: an empty
// roster renders an honest empty state.

import { getAgents } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, avatar, vendorChip, statePill, tierRamp, pct, taskRef, esc, roControl, RO_GATE_PROVISION } from '../ui';
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

function card(a: Agent): string {
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
  </article>`;
}

export async function loadRoster(): Promise<LoadResult> {
  const res = await getAgents();
  return fromResult(res, (agents) => {
    const head = `<div class="roster-head">
        <div><h1>Your team</h1><div class="sub"><b>${agents.length}</b> ${agents.length === 1 ? 'agent' : 'agents'} · <b>${agents.filter((a) => a.state !== 'idle').length}</b> active</div></div>
        ${roControl('Add agent', { icon: I.plus, cls: 'btn-add', gate: RO_GATE_PROVISION })}</div>`;

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
      html: `${head}${healthStrip(agents)}<div class="agent-grid">${agents.map(card).join('')}</div>`,
    };
  });
}
