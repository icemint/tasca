// Monitoring (C7) — mission control. An operator-facing board of tasks grouped into
// five workflow columns (each mapping a SET of internal statuses, covering all eight),
// from GET /api/tasks. The Blocked column shows each task's why-blocked reason
// (lastError) so a human sees what needs attention inline. KPI tiles report honest
// counts only (no throughput / cost-burn / success-over-time aggregates — those
// columns don't exist, so they're omitted).

import { getTasks, getProjects } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, platTag, tierTag, taskRef, esc } from '../ui';
import type { TaskStatus, TaskSummary } from '../contract';

// Operator columns, in flow order. Each maps a SET of internal statuses; together the
// sets partition all eight statuses, so no task orphans. `blocked` flags the column
// that surfaces the why-blocked reason (lastError) under each task.
interface BoardColumn {
  label: string;
  statuses: TaskStatus[];
  blocked?: boolean;
  /** Token color for the summary-tile glyph (the tiles derive from COLUMNS so they can't drift). */
  glyph: string;
}
const COLUMNS: BoardColumn[] = [
  { label: 'Backlog', statuses: ['ingested', 'routable'], glyph: 'var(--fg-faint)' },
  { label: 'Blocked', statuses: ['needs_attention', 'failed'], blocked: true, glyph: 'var(--state-blocked)' },
  { label: 'In Progress', statuses: ['claimed', 'executing'], glyph: 'var(--state-working)' },
  { label: 'PR Opened', statuses: ['in_review'], glyph: 'var(--state-awaiting)' },
  { label: 'Completed', statuses: ['done'], glyph: 'var(--state-shipped)' },
];

function taskCard(t: TaskSummary, showReason = false): string {
  const agent = t.claimedBy
    ? `<a class="mt-agent" href="/agents?id=${encodeURIComponent(t.claimedBy)}">${esc(t.claimedBy)}</a>`
    : `<span class="mt-agent unrouted">Unrouted</span>`;
  // On the Blocked column, show the why-blocked reason (lastError) inline so the
  // operator sees what needs a human without opening the task. The reason is the
  // text signal — Blocked never relies on color alone to convey "needs attention".
  const reason =
    showReason && t.lastError
      ? `<div class="mt-reason">${esc(t.lastError)}</div>`
      : '';
  return `<a class="montask" href="/tasks?id=${encodeURIComponent(t.id)}">
    <div class="mt-top">${platTag(t.platform)}${taskRef(t.id)}</div>
    <div class="mt-title">${esc(t.externalStoryId)}</div>
    ${reason}
    <div class="mt-foot">${agent}<span class="mt-meta">${tierTag(t.tierEstimate)}</span></div>
  </a>`;
}

function column(col: BoardColumn, tasks: TaskSummary[]): string {
  const body = tasks.length
    ? tasks.map((t) => taskCard(t, col.blocked)).join('')
    : `<div class="col-empty">Empty</div>`;
  return `<div class="moncol"><div class="moncol-h"><span class="mono fl" style="color:var(--fg-4)">${esc(col.label)}</span><span class="moncol-ct">${tasks.length}</span></div><div class="moncol-body">${body}</div></div>`;
}

function kpis(tasks: TaskSummary[]): string {
  // The tiles MIRROR the 5 board columns (same labels, same status sets) plus a Total — derived from
  // COLUMNS so the strip and the columns can never disagree again.
  const tiles = [
    { k: 'Total', v: tasks.length, g: 'var(--fg-faint)' },
    ...COLUMNS.map((col) => ({
      k: col.label,
      v: tasks.filter((t) => col.statuses.includes(t.status)).length,
      g: col.glyph,
    })),
  ];
  return `<div class="mon-kpis">${tiles
    .map(
      (t) =>
        `<div class="kpi"><div class="kpi-k"><span class="glyph" style="background:${t.g}"></span>${t.k}</div><div class="kpi-v">${t.v}</div></div>`
    )
    .join('')}</div>`;
}

/** Resolve the active-project scope label for the board header (best-effort). "All projects" when
 *  nothing is selected or the lookup fails — the indicator must never block the board. The read API
 *  already filters the tasks by the active project server-side; this only NAMES the active scope. */
async function activeScopeLabel(): Promise<string> {
  const res = await getProjects();
  if (res.kind !== 'ok' || res.data.activeProjectId === null) return 'All projects';
  return res.data.projects.find((p) => p.id === res.data.activeProjectId)?.name ?? 'All projects';
}

export async function loadMonitoring(): Promise<LoadResult> {
  const [res, scope] = await Promise.all([getTasks({ limit: 200 }), activeScopeLabel()]);
  return fromResult(res, (tasks) => {
    const head = `<div class="roster-head"><div><h1>Monitoring</h1><div class="sub">Live pipeline · <span class="scope-tag">${esc(scope)}</span></div></div>
      <div class="head-actions">
        <button class="ictl" type="button" data-act="refresh" aria-label="Refresh the pipeline">Refresh</button>
        <span class="live-dot big" role="status" aria-label="Live — refreshes on demand">Live</span>
      </div></div>`;

    if (!tasks.length) {
      // Reflect the active scope: a filtered-empty PROJECT must not read as "no tasks at all".
      const scoped = scope !== 'All projects';
      return {
        kind: 'empty',
        html:
          head +
          (scoped
            ? empty(
                `No tasks in ${scope}`,
                'No work has reached this project yet. Switch to "All projects" to see tasks across the workspace.',
                I.monitor
              )
            : empty(
                'No tasks yet',
                'When a connected platform assigns work to one of your agents, it flows through this pipeline.',
                I.monitor
              )),
      };
    }

    const board = COLUMNS.map((col) =>
      column(col, tasks.filter((t) => col.statuses.includes(t.status)))
    ).join('');

    return {
      kind: 'ok',
      html: `${head}${kpis(tasks)}<div class="monboard">${board}</div>`,
    };
  });
}
