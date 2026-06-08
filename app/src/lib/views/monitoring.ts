// Monitoring (C7) — mission control. A pipeline board of tasks grouped by their
// real status from GET /api/tasks, plus an attention rail for needs_attention /
// failed tasks. KPI tiles report honest counts only (no throughput / cost-burn /
// success-over-time aggregates — those columns don't exist, so they're omitted).

import { getTasks } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, platTag, tierTag, taskRef, esc, roControl } from '../ui';
import type { TaskStatus, TaskSummary } from '../contract';

// Pipeline columns, in flow order. needs_attention/failed surface in the rail.
const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'routable', label: 'Routable' },
  { status: 'claimed', label: 'Claimed' },
  { status: 'executing', label: 'Executing' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
];

function taskCard(t: TaskSummary): string {
  const agent = t.claimedBy
    ? `<a class="mt-agent" href="/agents?id=${encodeURIComponent(t.claimedBy)}">${esc(t.claimedBy)}</a>`
    : `<span class="mt-agent unrouted">Unrouted</span>`;
  return `<a class="montask" href="/tasks?id=${encodeURIComponent(t.id)}">
    <div class="mt-top">${platTag(t.platform)}${taskRef(t.id)}</div>
    <div class="mt-title">${esc(t.externalStoryId)}</div>
    <div class="mt-foot">${agent}<span class="mt-meta">${tierTag(t.tierEstimate)}</span></div>
  </a>`;
}

function column(label: string, tasks: TaskSummary[]): string {
  const body = tasks.length
    ? tasks.map(taskCard).join('')
    : `<div class="col-empty">Empty</div>`;
  return `<div class="moncol"><div class="moncol-h"><span class="mono fl" style="color:var(--fg-4)">${esc(label)}</span><span class="moncol-ct">${tasks.length}</span></div><div class="moncol-body">${body}</div></div>`;
}

function kpis(tasks: TaskSummary[]): string {
  const c = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const tiles = [
    { k: 'Total', v: tasks.length, g: 'var(--fg-faint)' },
    { k: 'Executing', v: c('executing'), g: 'var(--state-working)' },
    { k: 'In review', v: c('in_review'), g: 'var(--state-awaiting)' },
    { k: 'Needs attention', v: c('needs_attention') + c('failed'), g: 'var(--state-blocked)' },
    { k: 'Done', v: c('done'), g: 'var(--state-shipped)' },
  ];
  return `<div class="mon-kpis">${tiles
    .map(
      (t) =>
        `<div class="kpi"><div class="kpi-k"><span class="glyph" style="background:${t.g}"></span>${t.k}</div><div class="kpi-v">${t.v}</div></div>`
    )
    .join('')}</div>`;
}

function attentionRail(tasks: TaskSummary[]): string {
  const attn = tasks.filter((t) => t.status === 'needs_attention' || t.status === 'failed');
  if (!attn.length) return '';
  const rows = attn
    .map(
      (t) =>
        `<div class="escrow"><a class="esc-task" href="/tasks?id=${encodeURIComponent(t.id)}">${taskRef(t.id)}<span class="esc-title">${esc(t.externalStoryId)}</span></a>
        <span class="esc-reason">${t.failureCount} ${t.failureCount === 1 ? 'failed attempt' : 'failed attempts'} · awaiting review</span>
        <span class="esc-act">${roControl('Re-tier', { cls: 'ictl amber' })}${roControl('Escalate')}</span></div>`
    )
    .join('');
  return `<div class="pcard esc-rail" style="margin-top:24px"><div class="pc-h">Needs attention <span class="pc-h-r mono dim">${attn.length}</span></div>${rows}</div>`;
}

export async function loadMonitoring(): Promise<LoadResult> {
  const res = await getTasks({ limit: 200 });
  return fromResult(res, (tasks) => {
    const head = `<div class="roster-head"><div><h1>Monitoring</h1><div class="sub">Live pipeline across every connected platform</div></div>
      <div class="head-actions">
        <button class="ictl" type="button" data-act="refresh" aria-label="Refresh the pipeline">Refresh</button>
        <span class="live-dot big" role="status" aria-label="Live — refreshes on demand">Live</span>
      </div></div>`;

    if (!tasks.length) {
      return {
        kind: 'empty',
        html:
          head +
          empty(
            'No tasks yet',
            'When a connected platform assigns work to one of your agents, it flows through this pipeline.',
            I.monitor
          ),
      };
    }

    const board = COLUMNS.map((col) =>
      column(col.label, tasks.filter((t) => t.status === col.status))
    ).join('');

    return {
      kind: 'ok',
      html: `${head}${kpis(tasks)}<div class="monboard">${board}</div>${attentionRail(tasks)}`,
    };
  });
}
