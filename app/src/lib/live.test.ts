// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { liveAction, showBanner, describeFailure } from './live';
import type { WriteResult } from './api';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const view = document.createElement('div');
  view.innerHTML = '<div class="content">truth</div>';
  document.body.appendChild(view);
  const button = document.createElement('button');
  button.textContent = 'Pause';
  view.appendChild(button);
  let reruns = 0;
  // rerun replaces the view with "server truth" (and removes the button), like mount.
  const rerun = async () => {
    reruns++;
    view.innerHTML = '<div class="content">fresh truth</div>';
  };
  return { view, button, rerun, reruns: () => reruns };
}

describe('liveAction — truthful reconcile (never leaves the UI lying)', () => {
  it('shows pending feedback, then reconciles to server truth on success (no banner)', async () => {
    const { view, button, rerun, reruns } = setup();
    const write = vi.fn(async (): Promise<WriteResult<unknown>> => ({ kind: 'ok', data: { version: 2 } }));
    await liveAction({ button, pendingLabel: 'Pausing…', view, rerun, write });
    expect(write).toHaveBeenCalledOnce();
    expect(reruns()).toBe(1); // re-rendered from truth
    expect(view.querySelector('.write-banner')).toBeNull(); // success → no banner
    expect(view.innerHTML).toContain('fresh truth');
  });

  it('on a 409 conflict: reconciles to truth AND surfaces a visible banner (no silent overwrite)', async () => {
    const { view, button, rerun, reruns } = setup();
    const write = async (): Promise<WriteResult<unknown>> => ({ kind: 'conflict', data: { currentVersion: 9 } });
    await liveAction({ button, pendingLabel: 'Pausing…', view, rerun, write });
    expect(reruns()).toBe(1); // truth re-rendered
    const banner = view.querySelector('.write-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Someone else changed this');
    expect(view.innerHTML).toContain('fresh truth'); // the truth is shown, not the optimistic value
  });

  it('on an error: snaps back to truth + explains why', async () => {
    const { view, button, rerun } = setup();
    const write = async (): Promise<WriteResult<unknown>> => ({ kind: 'error', message: 'boom' });
    await liveAction({ button, pendingLabel: 'Pausing…', view, rerun, write });
    expect(view.querySelector('.write-banner')!.textContent).toContain('boom');
  });

  it('on 401: redirects to login (does not pretend the write happened)', async () => {
    const { view, button, rerun, reruns } = setup();
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const write = async (): Promise<WriteResult<unknown>> => ({ kind: 'unauth' });
    await liveAction({ button, pendingLabel: 'Pausing…', view, rerun, write });
    expect(assign).toHaveBeenCalledWith('/');
    expect(reruns()).toBe(0); // no reconcile needed — we're leaving the page
  });

  it('ignores a re-click while a write is in flight', async () => {
    const { view, button, rerun } = setup();
    let resolve!: (r: WriteResult<unknown>) => void;
    const write = vi.fn(() => new Promise<WriteResult<unknown>>((r) => (resolve = r)));
    const p1 = liveAction({ button, pendingLabel: 'Pausing…', view, rerun, write });
    const p2 = liveAction({ button, pendingLabel: 'Pausing…', view, rerun, write }); // re-click, ignored
    resolve({ kind: 'ok', data: {} });
    await Promise.all([p1, p2]);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe('describeFailure + showBanner', () => {
  it('maps each failure kind to an honest message', () => {
    expect(describeFailure({ kind: 'conflict', data: {} })).toContain('Someone else changed');
    expect(describeFailure({ kind: 'unconfigured' })).toContain('aren’t enabled');
    expect(describeFailure({ kind: 'notfound' })).toContain('no longer exists');
    expect(describeFailure({ kind: 'forbidden' })).toContain('security token');
  });

  it('showBanner replaces a prior banner (no stacking) and is dismissible', () => {
    const view = document.createElement('div');
    showBanner(view, 'first');
    showBanner(view, 'second');
    expect(view.querySelectorAll('.write-banner')).toHaveLength(1);
    expect(view.querySelector('.write-banner')!.textContent).toContain('second');
    view.querySelector<HTMLButtonElement>('.wb-x')!.click();
    expect(view.querySelector('.write-banner')).toBeNull();
  });
});
