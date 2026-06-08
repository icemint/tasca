// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, fromResult, type LoadResult } from './mount';
import { stubFetch, SESSION_OK } from './test-support';

afterEach(() => vi.unstubAllGlobals());

function elt(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('fromResult', () => {
  it('maps ok via render, and passes through unauth/error', () => {
    const render = (n: number) => ({ kind: 'ok' as const, html: `<i>${n}</i>` });
    expect(fromResult({ kind: 'ok', data: 7 }, render)).toEqual({ kind: 'ok', html: '<i>7</i>' });
    expect(fromResult({ kind: 'unauth' }, render)).toEqual({ kind: 'unauth' });
    expect(fromResult({ kind: 'error', message: 'x' }, render)).toEqual({ kind: 'error', message: 'x' });
  });
});

describe('mount lifecycle', () => {
  it('verifies the session then renders the view html', async () => {
    stubFetch({ '/api/auth/me': { body: SESSION_OK } });
    const el = elt();
    await mount(el, async () => ({ kind: 'ok', html: '<p>roster</p>' }));
    expect(el.innerHTML).toContain('roster');
  });

  it('on unauth, shows the sign-in state and redirects to /', async () => {
    stubFetch({ '/api/auth/me': { status: 401, body: {} } });
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const el = elt();
    await mount(el, async () => ({ kind: 'ok', html: '<p>never</p>' }));
    expect(el.innerHTML).toContain('Sign in to continue');
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('renders an error state with a retry that re-runs the load', async () => {
    stubFetch({ '/api/auth/me': { body: SESSION_OK } });
    const load = vi
      .fn<() => Promise<LoadResult>>()
      .mockResolvedValueOnce({ kind: 'error', message: 'down' })
      .mockResolvedValueOnce({ kind: 'ok', html: '<p>recovered</p>' });
    const el = elt();
    await mount(el, load);
    expect(el.innerHTML).toContain('down');
    el.querySelector<HTMLButtonElement>('[data-act="retry"]')!.click();
    await vi.waitFor(() => expect(el.innerHTML).toContain('recovered'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('wires an in-content Refresh control to re-run the load', async () => {
    stubFetch({ '/api/auth/me': { body: SESSION_OK } });
    const load = vi
      .fn<() => Promise<LoadResult>>()
      .mockResolvedValue({ kind: 'ok', html: '<button data-act="refresh">Refresh</button><span>n</span>' });
    const el = elt();
    await mount(el, load);
    el.querySelector<HTMLButtonElement>('[data-act="refresh"]')!.click();
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
