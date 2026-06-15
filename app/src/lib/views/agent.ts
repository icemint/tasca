// Agent detail (C6). Renders one agent's identity bindings, capability profile and
// recent tasks from GET /api/agents/:id. Pause/Resume are LIVE optimistic controls
// (the first UI writes); Deploy/Assign/Interrupt/Reassign/Escalate stay read-only.

import { getAgent, pauseAgent, resumeAgent } from '../api';
import { fromResult, queryId, type LoadResult } from '../mount';
import { empty } from '../states';
import { liveAction } from '../live';
import {
  I, avatar, vendorChip, statePill, tierRamp, tierTag, pct, money, taskRef, taskLabel,
  PLATFORM_LABEL, esc, roControl, RO_GATE_PROVISION,
} from '../ui';
import type { AgentDetail, Binding, TaskSummary } from '../contract';

/** A visible lifecycle-status chip so a pause/resume is reflected in the UI (the
 *  state pill shows working/idle; status is active/paused/retired). */
function statusBadge(a: AgentDetail): string {
  if (a.status === 'paused') return `<span class="status-chip paused">Paused</span>`;
  if (a.status === 'retired') return `<span class="status-chip retired">Retired</span>`;
  return '';
}

/** The live Pause/Resume control — toggles agent status under optimistic concurrency
 *  (carries the version; a stale write 409s → the view reconciles). */
function pauseControl(a: AgentDetail): string {
  const paused = a.status === 'paused';
  const action = paused ? 'resume' : 'pause';
  const label = paused ? 'Resume' : 'Pause';
  return `<button class="ictl live-ctl" type="button" data-action="${action}" data-agent-id="${esc(a.id)}" data-version="${a.version}" aria-label="${label} ${esc(a.name)}">${paused ? '' : I.pause + ' '}${label}</button>`;
}

/** Wire the agent view's live controls after each render; `rerun` reconciles to
 *  server truth (mount passes it). Re-reads id/version from the DOM each render. */
export function wireAgent(el: HTMLElement, rerun: () => Promise<void>): void {
  const btn = el.querySelector<HTMLButtonElement>('.live-ctl[data-action]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const id = btn.dataset.agentId ?? '';
    const version = Number(btn.dataset.version);
    const action = btn.dataset.action;
    void liveAction({
      button: btn,
      pendingLabel: action === 'pause' ? 'Pausing…' : 'Resuming…',
      view: el,
      rerun,
      write: () => (action === 'pause' ? pauseAgent(id, version) : resumeAgent(id, version)),
    });
  });
}

const BINDING_DOT: Record<Binding['state'], string> = {
  active: 'var(--green)',
  provisioned: 'var(--amber)',
  revoked: 'var(--fg-faint)',
};
const BINDING_LABEL: Record<Binding['state'], string> = {
  active: 'Active',
  provisioned: 'Provisioned',
  revoked: 'Revoked',
};

function bindingRow(b: Binding): string {
  return `<div class="idrow"><div class="idp"><span class="idp-name">${esc(PLATFORM_LABEL[b.platform])}</span>
      <span class="mono idp-h">${b.externalHandle ? esc(b.externalHandle) : '—'}</span></div>
    <span class="idhealth"><span class="d" style="background:${BINDING_DOT[b.state]}"></span>${BINDING_LABEL[b.state]}</span></div>`;
}

function recentRow(t: TaskSummary): string {
  // QA item 325: show the story title (falling back to the story ref) as the row's label — never the raw
  // task UUID, which previously led the row. The UUID stays in the href for navigation.
  return `<a class="recrow" href="/tasks?id=${encodeURIComponent(t.id)}">
    <span class="rec-title">${esc(taskLabel(t))}</span>${tierTag(t.tierEstimate)}<span class="rec-arrow">${I.chevron}</span></a>`;
}

function currentWork(a: AgentDetail): string {
  if (!a.currentTaskId) {
    return `<div class="pcard"><div class="pc-h">Current work</div>
      <div class="work-empty"><div class="we-ico">${I.roster}</div><div><div class="we-t">Idle · available to route</div>
        <div class="we-s">No active task. The routing engine assigns work matching this agent's profile.</div></div>
        ${roControl('Assign a task', { icon: I.plus, cls: 'ictl signal' })}</div></div>`;
  }
  return `<div class="pcard">
    <div class="pc-h">Current work <span class="pc-h-r">${statePill(a.state)}</span></div>
    <div class="taskcard">
      <div class="tc-top">${taskRef(a.currentTaskId)}</div>
      <a class="tc-title" href="/tasks?id=${encodeURIComponent(a.currentTaskId)}">${esc(a.currentTaskId)}</a>
      <div class="tc-meta"><a class="ictl" href="/tasks?id=${encodeURIComponent(a.currentTaskId)}">Inspect routing ${I.arrow}</a></div>
    </div>
    <div class="ictl-row">
      ${roControl('Interrupt')}
      ${roControl('Reassign')}
      ${roControl('Escalate')}
    </div></div>`;
}

function capability(a: AgentDetail): string {
  const c = a.capability;
  const specs = [...c.languageSpecialties, ...c.frameworkSpecialties];
  const specList = specs.length
    ? specs.map((s) => `<span class="spec">${esc(s)}</span>`).join('')
    : '<span class="mono dim">—</span>';
  return `<div class="pcard">
    <div class="pc-h">Capability profile</div>
    <div class="cap-row"><span class="cap-k">Tier range</span><span>${tierRamp(c)}</span></div>
    <div class="cap-block"><span class="cap-k">Specialties</span><div class="speclist">${specList}</div></div>
    <div class="cap-row"><span class="cap-k">Concurrency</span><span class="cap-v">${c.concurrencyLimit ?? '—'} slots</span></div>
    <div class="cap-row"><span class="cap-k">Success rate</span><span class="cap-v">${pct(c.successRate)}</span></div>
    <div class="cap-row"><span class="cap-k">Cost ceiling</span><span class="cap-v">${money(c.costCeiling)}</span></div>
  </div>`;
}

export async function loadAgent(): Promise<LoadResult> {
  const id = queryId();
  if (!id) {
    return { kind: 'empty', html: empty('No agent selected', 'Pick an agent from your team to see its profile.', I.roster) };
  }
  const res = await getAgent(id);
  return fromResult(res, (a) => {
    const head = `<div class="vhead">
        <a class="vback" href="/roster">${I.back} Your team</a>
        <div class="vh-main">
          <div class="vh-id">${avatar(a, 'av-xl')}
            <div><div class="vh-name">${esc(a.name)}</div>
              <div class="vh-meta">${vendorChip(a.vendor)}<span class="mono dim">${esc(a.model)}</span>${statePill(a.state)}${statusBadge(a)}</div></div></div>
          <div class="vh-actions">
            ${pauseControl(a)}
            ${roControl('Edit profile')}
            ${roControl('Deploy', { gate: RO_GATE_PROVISION })}
          </div>
        </div></div>`;

    const bindings = a.bindings.length
      ? a.bindings.map(bindingRow).join('')
      : '<div class="we-s" style="padding:8px 0">No platform identities yet.</div>';
    const recent = a.recentTasks.length
      ? a.recentTasks.map(recentRow).join('')
      : '<div class="we-s" style="padding:8px 0">No recent work yet.</div>';

    const html = `${head}
      <div class="pcols">
        <div class="pcol">${currentWork(a)}
          <div class="pcard"><div class="pc-h">Recent work</div>${recent}</div></div>
        <div class="pcol">
          <div class="pcard"><div class="pc-h">Identity bindings</div>
            <div class="pc-sub">The native identity this agent acts as inside each platform — its own actor, never impersonating a human teammate.</div>
            ${bindings}</div>
          ${capability(a)}
        </div></div>`;
    return { kind: 'ok', html };
  });
}
