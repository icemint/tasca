// @vitest-environment happy-dom
// DOM-driven wiring for the roster create-agent form (slice Wizard-B). Proves the live behaviour:
// the form reveals on demand, the tier pre-fills from the typed model (and tracks model changes
// until the user overrides), a submit calls POST /api/agents with the field values incl. the
// (pre-filled or overridden) maxTier, an ok re-runs the roster, and a 400 surfaces inline.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadRoster, wireRoster } from './roster';
import { _resetCsrfForTest } from '../api';
import { stubFetch, AGENT_ELVIS, htmlOf } from '../test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
});

const BASE = {
  '/api/agents': { body: [AGENT_ELVIS] },
  '/api/orgs': { body: { orgs: [{ id: 'o1', name: 'A', role: 'member', active: true }] } },
  '/api/orgs/agents': { body: { agents: [] } },
  '/api/csrf': { body: { token: 'tok-1' } },
};

/** Mount the roster into a div + wire it, returning the element + a rerun counter. */
async function mountRoster(): Promise<{ el: HTMLElement; reruns: () => number }> {
  const el = document.createElement('div');
  el.innerHTML = htmlOf(await loadRoster());
  let n = 0;
  wireRoster(el, async () => {
    n++;
    el.innerHTML = htmlOf(await loadRoster());
  });
  return { el, reruns: () => n };
}

describe('roster create-agent wiring (slice Wizard-B)', () => {
  it('the form is hidden until the Create agent control is clicked', async () => {
    _resetCsrfForTest();
    stubFetch(BASE);
    const { el } = await mountRoster();
    const form = el.querySelector<HTMLFormElement>('[data-ca-form]')!;
    expect(form.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')!.click();
    expect(form.hidden).toBe(false);
  });

  it('the tier pre-fills from the typed model and tracks model changes (opus → ULTRA)', async () => {
    _resetCsrfForTest();
    stubFetch(BASE);
    const { el } = await mountRoster();
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')!.click();
    const model = el.querySelector<HTMLInputElement>('input[name="model"]')!;
    const tier = el.querySelector<HTMLSelectElement>('select[name="maxTier"]')!;

    model.value = 'claude-3-5-haiku';
    model.dispatchEvent(new Event('input'));
    expect(tier.value).toBe('low');

    model.value = 'claude-opus-4-8';
    model.dispatchEvent(new Event('input'));
    expect(tier.value).toBe('ultra'); // tracks the model until the user overrides
  });

  it('a manual tier override is NOT clobbered by a later model edit', async () => {
    _resetCsrfForTest();
    stubFetch(BASE);
    const { el } = await mountRoster();
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')!.click();
    const model = el.querySelector<HTMLInputElement>('input[name="model"]')!;
    const tier = el.querySelector<HTMLSelectElement>('select[name="maxTier"]')!;

    tier.value = 'basic';
    tier.dispatchEvent(new Event('change')); // user overrides
    model.value = 'claude-opus-4-8';
    model.dispatchEvent(new Event('input'));
    expect(tier.value).toBe('basic'); // the override stands
  });

  it('submit POSTs /api/agents with the field values incl. the (overridden) maxTier, then re-runs', async () => {
    _resetCsrfForTest();
    let posted: { path: string; body: Record<string, unknown> } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents') {
          posted = { path, body: JSON.parse(String(init.body)) };
          return new Response(JSON.stringify({ id: 'a9', name: 'Mona', vendor: 'openai', model: 'gpt-4o', maxTier: 'hard' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const routes: Record<string, { status?: number; body?: unknown }> = BASE;
        const r = routes[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const { el, reruns } = await mountRoster();
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')!.click();
    el.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'Mona';
    el.querySelector<HTMLSelectElement>('select[name="vendor"]')!.value = 'openai';
    el.querySelector<HTMLInputElement>('input[name="model"]')!.value = 'gpt-4o';
    const tier = el.querySelector<HTMLSelectElement>('select[name="maxTier"]')!;
    tier.value = 'ultra';
    tier.dispatchEvent(new Event('change')); // override
    el.querySelector<HTMLFormElement>('[data-ca-form]')!.dispatchEvent(new Event('submit'));

    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(posted).not.toBeNull();
    expect(posted!.body).toMatchObject({ name: 'Mona', vendor: 'openai', model: 'gpt-4o', maxTier: 'ultra' });
    expect(reruns()).toBeGreaterThan(0); // reconciled from server truth (the new agent appears)
  });

  it('a 400 validation failure surfaces the server message inline and does NOT re-run', async () => {
    _resetCsrfForTest();
    // The GET /api/agents (initial load + rerun) must succeed; only the POST 400s.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents') {
          return new Response(JSON.stringify({ error: 'name must be 80 characters or fewer' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        const routes: Record<string, { status?: number; body?: unknown }> = BASE;
        const r = routes[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const { el, reruns } = await mountRoster();
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')!.click();
    el.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'X';
    el.querySelector<HTMLInputElement>('input[name="model"]')!.value = 'claude-opus-4-8';
    el.querySelector<HTMLFormElement>('[data-ca-form]')!.dispatchEvent(new Event('submit'));

    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    const err = el.querySelector<HTMLElement>('[data-ca-err]')!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('name must be 80 characters or fewer'); // server message, surfaced
    expect(reruns()).toBe(0); // the form stays for correction; nothing re-runs on failure
  });

  it('an empty name is caught client-side before any POST', async () => {
    _resetCsrfForTest();
    let agentPosts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents') agentPosts++;
        const routes: Record<string, { status?: number; body?: unknown }> = BASE;
        const r = routes[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const { el } = await mountRoster();
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')!.click();
    // leave name blank, fill model
    el.querySelector<HTMLInputElement>('input[name="model"]')!.value = 'claude-opus-4-8';
    el.querySelector<HTMLFormElement>('[data-ca-form]')!.dispatchEvent(new Event('submit'));

    await new Promise((res) => setTimeout(res, 0));

    expect(agentPosts).toBe(0); // never hit the network
    expect(el.querySelector<HTMLElement>('[data-ca-err]')!.hidden).toBe(false);
  });
});
