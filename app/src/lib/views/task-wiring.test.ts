// @vitest-environment happy-dom
// DOM-driven wiring for the task inspector's live controls. Proves the force-reset escape hatch
// (issue 317) is wired to the RIGHT endpoint with the RIGHT pending label — a regression in the
// action→call ternary in wireTask would otherwise mis-map force-reset to reassign silently.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadTask, wireTask } from './task';
import { _resetCsrfForTest } from '../api';
import { TASK_EXECUTING_DETAIL, htmlOf } from '../test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
});

describe('task inspector force-reset wiring (issue 317)', () => {
  it('a Force reset click POSTs /force-reset (not reassign/interrupt) and re-runs to truth', async () => {
    _resetCsrfForTest();
    vi.stubGlobal('location', { search: '?id=task-exec' });
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === 'POST') posts.push(u);
      if (u.includes('/api/csrf')) return new Response(JSON.stringify({ token: 'tok-1' }), { status: 200 });
      if (u.includes('/force-reset')) return new Response(JSON.stringify({ ok: true, status: 'needs_attention' }), { status: 200 });
      return new Response(JSON.stringify(TASK_EXECUTING_DETAIL), { status: 200 }); // the GET (initial + re-fetch)
    });

    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadTask());
    let reruns = 0;
    wireTask(el, async () => {
      reruns++;
      el.innerHTML = htmlOf(await loadTask());
    });

    const btn = el.querySelector<HTMLButtonElement>('[data-action="force-reset"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Force reset');

    btn!.click();
    // Let the async liveAction (await write, await rerun) settle.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    expect(posts.some((u) => u.includes('/api/tasks/task-exec/force-reset'))).toBe(true);
    expect(posts.some((u) => u.includes('/reassign') || u.includes('/interrupt'))).toBe(false);
    expect(reruns).toBeGreaterThan(0); // reconciled to server truth after the write
  });
});
