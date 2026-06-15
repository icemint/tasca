// @vitest-environment happy-dom
// DOM-driven wiring for the agent-detail page (Slice D). Mirrors settings-wiring.test.ts / roster-wiring.
// Covers: Edit reveals the section form; Save sends the right editAgentProfile patch + re-renders from
// truth; a 409 reconciles with a banner; the taxonomy specialty tag-input rejects off-taxonomy + adds/
// removes chips; the credential Set reveals a BLANK input + calls setAgentCredential (and the stored token
// NEVER reaches the DOM); Test drives the idle→testing→pass/fail state machine; Remove is two-step.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadAgent, wireAgent } from './agent';
import { _resetCsrfForTest } from '../api';
import {
  stubFetch,
  AGENT_ELVIS_DETAIL_FULL,
  AGENT_CREDS_GITHUB,
  AGENT_CREDS_EMPTY,
  htmlOf,
} from '../test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
});

const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };

function withId(id: string): void {
  vi.stubGlobal('location', { search: `?id=${id}` });
}

/** Mount the agent page for an admin and return the live element + a rerun counter. */
async function mountAdmin(routes: Record<string, { status?: number; body?: unknown }>) {
  withId('agent-elvis');
  stubFetch(routes);
  const el = document.createElement('div');
  el.innerHTML = htmlOf(await loadAgent());
  let reruns = 0;
  const rerun = async () => {
    reruns++;
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, rerun);
  };
  wireAgent(el, rerun);
  return { el, rerun, reruns: () => reruns };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const CRED_ROUTES = {
  '/api/agents/agent-elvis': { body: AGENT_ELVIS_DETAIL_FULL },
  '/api/orgs': { body: ADMIN_ORGS },
  '/api/orgs/o1/agents/agent-elvis/credentials': { body: AGENT_CREDS_GITHUB },
  '/api/csrf': { body: { token: 'tok-1' } },
};

describe('agent wiring — identity edit (issues 318/324)', () => {
  it('Edit reveals the identity form; Cancel hides it and restores focus to the trigger', async () => {
    const { el } = await mountAdmin(CRED_ROUTES);
    const form = el.querySelector<HTMLFormElement>('[data-id-form]')!;
    expect(form.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('[data-act="id-edit"]')!.click();
    expect(form.hidden).toBe(false);
    el.querySelector<HTMLButtonElement>('[data-act="id-cancel"]')!.click();
    expect(form.hidden).toBe(true);
  });

  it('Save sends an editAgentProfile patch with the edited name + the version, then re-renders', async () => {
    let postBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents/agent-elvis/profile') {
          postBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ ok: true, version: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    let reruns = 0;
    wireAgent(el, async () => { reruns++; el.innerHTML = htmlOf(await loadAgent()); wireAgent(el, async () => {}); });

    el.querySelector<HTMLButtonElement>('[data-act="id-edit"]')!.click();
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    name.value = 'Elvis Renamed';
    el.querySelector<HTMLFormElement>('[data-id-form]')!.dispatchEvent(new Event('submit'));
    await tick(); await tick();

    expect(postBody).toMatchObject({ name: 'Elvis Renamed', version: 0 });
    // a full patch carries the required capability fields too (never a partial that drops them)
    expect(postBody).toHaveProperty('maxTier');
    expect(postBody).toHaveProperty('concurrencyLimit');
    expect(postBody).toHaveProperty('costCeiling');
    expect(reruns).toBeGreaterThan(0); // reconciled from server truth
  });

  it('a stale-version 409 reconciles with a banner (never a silent overwrite)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents/agent-elvis/profile') {
          return new Response(JSON.stringify({ error: 'stale', currentVersion: 7 }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => { el.innerHTML = htmlOf(await loadAgent()); wireAgent(el, async () => {}); });

    el.querySelector<HTMLButtonElement>('[data-act="id-edit"]')!.click();
    el.querySelector<HTMLInputElement>('input[name="name"]')!.value = 'X';
    el.querySelector<HTMLFormElement>('[data-id-form]')!.dispatchEvent(new Event('submit'));
    await tick(); await tick();

    expect(el.querySelector('.write-banner')).toBeTruthy(); // a banner explains the conflict
    expect(el.textContent).toContain('Someone else changed this agent');
  });
});

describe('agent wiring — capability specialty tag-input (issue 337, taxonomy-bound)', () => {
  it('rejects an OFF-taxonomy value inline and does NOT add a chip', async () => {
    const { el } = await mountAdmin(CRED_ROUTES);
    el.querySelector<HTMLButtonElement>('[data-act="cap-edit"]')!.click();
    const entry = el.querySelector<HTMLInputElement>('[data-spec-entry="lang"]')!;
    entry.value = 'cobol'; // not in the taxonomy
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const err = el.querySelector<HTMLElement>('[data-spec-err="lang"]')!;
    expect(err.textContent).toContain('Pick from the list');
    expect(el.querySelector('[data-spec-chip="cobol"]')).toBeNull(); // no chip added
  });

  it('adds a taxonomy value (by display label) as a chip, and removes a chip by its × button', async () => {
    const { el } = await mountAdmin(CRED_ROUTES);
    el.querySelector<HTMLButtonElement>('[data-act="cap-edit"]')!.click();
    const entry = el.querySelector<HTMLInputElement>('[data-spec-entry="lang"]')!;
    entry.value = 'Python'; // the display label maps back to the 'python' token
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(el.querySelector('[data-spec-chip="python"]')).toBeTruthy();
    expect(entry.value).toBe(''); // entry cleared after add
    // remove the seeded 'typescript' chip
    el.querySelector<HTMLButtonElement>('[data-spec-chip="typescript"] [data-act="spec-remove"]')!.click();
    expect(el.querySelector('[data-spec-chip="typescript"]')).toBeNull();
  });

  it('Save sends the chip tokens (wire values) as languageSpecialties + the min≤max tier range', async () => {
    let postBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents/agent-elvis/profile') {
          postBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ ok: true, version: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => { el.innerHTML = htmlOf(await loadAgent()); wireAgent(el, async () => {}); });

    el.querySelector<HTMLButtonElement>('[data-act="cap-edit"]')!.click();
    const entry = el.querySelector<HTMLInputElement>('[data-spec-entry="lang"]')!;
    entry.value = 'Go';
    entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    el.querySelector<HTMLFormElement>('[data-cap-form]')!.dispatchEvent(new Event('submit'));
    await tick(); await tick();

    expect(postBody!.languageSpecialties).toEqual(['typescript', 'go']); // seeded + added, as wire tokens
    expect(postBody!.frameworkSpecialties).toEqual(['node']);
    expect(postBody).toHaveProperty('tiersCovered');
  });

  it('rejects min > max with an inline error and does NOT write', async () => {
    let posted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path === '/api/agents/agent-elvis/profile') { posted = true; }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => {});

    el.querySelector<HTMLButtonElement>('[data-act="cap-edit"]')!.click();
    el.querySelector<HTMLSelectElement>('[data-cap-min]')!.value = 'ultra';
    el.querySelector<HTMLSelectElement>('[data-cap-max]')!.value = 'low';
    el.querySelector<HTMLFormElement>('[data-cap-form]')!.dispatchEvent(new Event('submit'));
    await tick();

    expect(el.querySelector<HTMLElement>('[data-cap-err]')!.textContent).toContain('can’t be higher');
    expect(posted).toBe(false);
  });
});

describe('agent wiring — platform credentials (issue 319, mirrors vendor-keys)', () => {
  it('SECURITY: a set-token happy path NEVER echoes the token into the DOM, and clears the input', async () => {
    const TOKEN = 'ghp_supersecret_do_not_render_0xDEADBEEF';
    const { el } = await mountAdmin(CRED_ROUTES);
    // Replace flow reveals a BLANK input (never the stored token).
    el.querySelector<HTMLButtonElement>('[data-act="cred-edit"][data-provider="github"]')!.click();
    const input = el.querySelector<HTMLInputElement>('[data-cred-input="github"]')!;
    expect(input.value).toBe(''); // blank on reveal — never pre-filled with a stored token
    input.value = TOKEN;
    el.querySelector<HTMLFormElement>('[data-cred-form="github"]')!.dispatchEvent(new Event('submit'));
    await tick(); await tick();

    expect(el.innerHTML).not.toContain(TOKEN); // the token is NEVER in the rendered DOM
    expect(el.innerHTML).not.toContain('supersecret');
  });

  it('Set posts to the org-scoped per-agent endpoint with {provider, token}', async () => {
    let postedPath: string | null = null;
    let postBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path.includes('/credentials') && !path.endsWith('/test')) {
          postedPath = path;
          postBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ ok: true, provider: 'github', fingerprint: 'aa11' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => { el.innerHTML = htmlOf(await loadAgent()); wireAgent(el, async () => {}); });

    el.querySelector<HTMLButtonElement>('[data-act="cred-edit"][data-provider="github"]')!.click();
    el.querySelector<HTMLInputElement>('[data-cred-input="github"]')!.value = 'ghp_x';
    el.querySelector<HTMLFormElement>('[data-cred-form="github"]')!.dispatchEvent(new Event('submit'));
    await tick(); await tick();

    expect(postedPath).toBe('/api/orgs/o1/agents/agent-elvis/credentials');
    expect(postBody).toEqual({ provider: 'github', token: 'ghp_x' });
  });

  it('connection Test drives idle→testing→pass when the probe returns {ok:true}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path.endsWith('/test')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => {});

    el.querySelector<HTMLButtonElement>('[data-act="cred-edit"][data-provider="github"]')!.click();
    el.querySelector<HTMLInputElement>('[data-cred-input="github"]')!.value = 'ghp_probe';
    el.querySelector<HTMLButtonElement>('[data-act="cred-test"][data-provider="github"]')!.click();
    await tick(); await tick();

    const result = el.querySelector<HTMLElement>('[data-conn-result="github"]')!;
    expect(result.className).toContain('pass'); // not color-alone: a class + a label + a glyph
    expect(result.textContent).toContain('Connection OK');
    expect(result.getAttribute('role')).toBe('status'); // SR announces the verdict
  });

  it('connection Test renders fail (with the curated reason) when the probe returns {ok:false}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path.endsWith('/test')) {
          return new Response(JSON.stringify({ ok: false, reason: 'token lacks repo scope' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => {});

    el.querySelector<HTMLButtonElement>('[data-act="cred-edit"][data-provider="github"]')!.click();
    el.querySelector<HTMLInputElement>('[data-cred-input="github"]')!.value = 'ghp_bad';
    el.querySelector<HTMLButtonElement>('[data-act="cred-test"][data-provider="github"]')!.click();
    await tick(); await tick();

    const result = el.querySelector<HTMLElement>('[data-conn-result="github"]')!;
    expect(result.className).toContain('fail');
    expect(result.textContent).toContain('token lacks repo scope');
  });

  it('re-typing the token after a result returns the test to idle (invalidates the prior verdict)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'POST' && path.endsWith('/test')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const r = (CRED_ROUTES as Record<string, { status?: number; body?: unknown }>)[path];
        if (!r) return new Response('not found', { status: 404 });
        return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      })
    );
    withId('agent-elvis');
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadAgent());
    wireAgent(el, async () => {});

    el.querySelector<HTMLButtonElement>('[data-act="cred-edit"][data-provider="github"]')!.click();
    const input = el.querySelector<HTMLInputElement>('[data-cred-input="github"]')!;
    input.value = 'ghp_probe';
    el.querySelector<HTMLButtonElement>('[data-act="cred-test"][data-provider="github"]')!.click();
    await tick(); await tick();
    expect(el.querySelector<HTMLElement>('[data-conn-result="github"]')!.className).toContain('pass');
    // re-typing invalidates it
    input.value = 'ghp_probe2';
    input.dispatchEvent(new Event('input'));
    expect(el.querySelector<HTMLElement>('[data-conn-result="github"]')!.textContent).toBe('');
  });

  it('Remove is two-step (a confirm reveals before any DELETE)', async () => {
    const { el } = await mountAdmin(CRED_ROUTES);
    const confirm = el.querySelector<HTMLElement>('[data-cred-confirm="github"]')!;
    expect(confirm.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('[data-act="cred-remove"][data-provider="github"]')!.click();
    expect(confirm.hidden).toBe(false); // revealed, awaiting confirmation
  });

  it('a not-configured provider offers Set token but renders no Remove + no confirm', async () => {
    const { el } = await mountAdmin({ ...CRED_ROUTES, '/api/orgs/o1/agents/agent-elvis/credentials': { body: AGENT_CREDS_EMPTY } });
    expect(el.querySelector('[data-act="cred-edit"][data-provider="shortcut"]')).toBeTruthy();
    expect(el.querySelector('[data-cred-confirm="shortcut"]')).toBeNull();
  });
});
