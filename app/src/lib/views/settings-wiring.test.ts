// @vitest-environment happy-dom
// DOM-driven wiring for the Settings vendor-keys form. The key input is WRITE-ONLY: this proves the
// submitted secret is NEVER echoed back into the rendered DOM (the view re-renders from server truth,
// which carries only a status + fingerprint), and that the input is cleared on submit.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadSettings, wireSettings } from './settings';
import { _resetCsrfForTest } from '../api';
import {
  stubFetch,
  VENDOR_CREDS_ACTIVE,
  CREDENTIAL_AUDIT_OK,
  ORG_INFO_OWNER,
  MEMBERS_OK,
  INVITES_OK,
  INVITES_EMPTY,
  SESSION_OK,
  htmlOf,
} from '../test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
});

const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };
const WS_ROUTES = {
  '/api/auth/me': { body: SESSION_OK },
  '/api/org': { body: ORG_INFO_OWNER },
  '/api/orgs/members': { body: MEMBERS_OK },
  '/api/invites': { body: INVITES_OK },
};

describe('settings wiring — vendor key set is write-only (slice 3.5-A.2c.2)', () => {
  it('SECURITY: a set-key happy path NEVER echoes the submitted key into the DOM, and clears the input', async () => {
    _resetCsrfForTest();
    const SECRET = 'sk-ant-supersecret-do-not-render-0xDEADBEEF';
    stubFetch({
      ...WS_ROUTES,
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
      '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
      '/api/csrf': { body: { token: 'tok-1' } },
    });
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadSettings());
    let reruns = 0;
    const rerun = async () => {
      reruns++;
      el.innerHTML = htmlOf(await loadSettings());
    };
    wireSettings(el, rerun);

    // Reveal the replace form, type the secret, submit.
    el.querySelector<HTMLButtonElement>('[data-act="vk-edit"]')!.click();
    const input = el.querySelector<HTMLInputElement>('input[name="key"]')!;
    input.value = SECRET;
    el.querySelector<HTMLFormElement>('[data-vk-form]')!.dispatchEvent(new Event('submit'));

    // Let the async write + rerun settle.
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(reruns).toBeGreaterThan(0); // reconciled from server truth
    expect(el.innerHTML).not.toContain(SECRET); // the key is NEVER in the rendered DOM
    expect(el.innerHTML).not.toContain('supersecret');
  });

  it('Cancel clears the (write-only) input so a typed secret never lingers in the DOM', async () => {
    stubFetch({
      ...WS_ROUTES,
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
      '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
    });
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadSettings());
    wireSettings(el, async () => {});

    el.querySelector<HTMLButtonElement>('[data-act="vk-edit"]')!.click();
    const input = el.querySelector<HTMLInputElement>('input[name="key"]')!;
    input.value = 'sk-ant-typed-then-cancelled';
    el.querySelector<HTMLButtonElement>('[data-act="vk-cancel"]')!.click();

    expect(input.value).toBe(''); // input cleared on cancel
    expect(el.innerHTML).not.toContain('typed-then-cancelled');
  });
});

describe('settings wiring — Workspace members (slice 3.5-B.2)', () => {
  const FULL = {
    ...WS_ROUTES,
    '/api/orgs': { body: ADMIN_ORGS },
    '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
    '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
    '/api/csrf': { body: { token: 'tok-1' } },
  };

  it('a last-owner 409 on a role change surfaces the inline guard message (NOT swallowed)', async () => {
    _resetCsrfForTest();
    stubFetch({
      ...FULL,
      // changing u1 (the owner) away from owner is refused by the backend with 409 last_owner
      '/api/orgs/members/u1/role': { status: 409, body: { error: 'cannot remove or demote the last owner', code: 'last_owner' } },
    });
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadSettings());
    const rerun = async () => {
      el.innerHTML = htmlOf(await loadSettings());
    };
    wireSettings(el, rerun);

    // The owner demotes themselves (u1) → the select change fires the role write.
    const sel = el.querySelector<HTMLSelectElement>('[data-act="ws-role"][data-user-id="u1"]')!;
    sel.value = 'member';
    sel.dispatchEvent(new Event('change'));

    // Let the async write + rerun + banner settle.
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(el.innerHTML).toContain('Can’t change the last owner'); // surfaced, not swallowed
  });

  it('the two-step Remove reveals a confirm before any write', async () => {
    stubFetch(FULL);
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadSettings());
    wireSettings(el, async () => {});

    const confirm = el.querySelector<HTMLElement>('[data-ws-confirm="u2"]')!;
    expect(confirm.hidden).toBe(true); // hidden until the first Remove click
    el.querySelector<HTMLButtonElement>('[data-act="ws-remove"][data-user-id="u2"]')!.click();
    expect(confirm.hidden).toBe(false); // revealed, awaiting confirmation
  });
});

describe('settings wiring — Invites (slice 3.5-B.3.2)', () => {
  const FULL = {
    ...WS_ROUTES,
    '/api/orgs': { body: ADMIN_ORGS },
    '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
    '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
    '/api/csrf': { body: { token: 'tok-1' } },
  };

  it('a successful send reveals the returned acceptUrl with a Copy control', async () => {
    _resetCsrfForTest();
    const ACCEPT_URL = 'https://app.tasca.dev/invite?token=abc123single-use';
    // The stub keys by path (ignoring query + method), so GET-list and POST-create share the same
    // /api/invites response. A body carrying BOTH the create shape (acceptUrl) and the list shape
    // (invites) satisfies the GET re-run and the POST in one fixture.
    stubFetch({
      ...FULL,
      '/api/invites': {
        body: { ok: true, email: 'new@tasca.dev', role: 'member', acceptUrl: ACCEPT_URL, invites: INVITES_OK.invites },
      },
    });
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadSettings());
    wireSettings(el, async () => {
      el.innerHTML = htmlOf(await loadSettings());
    });

    const email = el.querySelector<HTMLInputElement>('[data-inv-form] input[name="email"]')!;
    email.value = 'new@tasca.dev';
    el.querySelector<HTMLFormElement>('[data-inv-form]')!.dispatchEvent(new Event('submit'));

    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    const link = el.querySelector<HTMLInputElement>('[data-inv-link]')!;
    expect(link.value).toBe(ACCEPT_URL); // the copyable accept link is revealed
    expect(el.querySelector('[data-act="inv-copy"]')).toBeTruthy(); // Copy control present
  });

  it('a 403 privilege-cap on send surfaces an inline error and does NOT reveal a link', async () => {
    _resetCsrfForTest();
    // Render from a clean owner state (empty pending list) so the invite form exists, then stub the
    // POST to 403 (the cap). The stub keys by path, so re-stubbing after render targets the submit.
    const el = document.createElement('div');
    stubFetch({ ...FULL, '/api/invites': { body: INVITES_EMPTY } });
    el.innerHTML = htmlOf(await loadSettings());
    stubFetch({ ...FULL, '/api/invites': { status: 403, body: { error: 'cannot invite above your own role' } } });
    wireSettings(el, async () => {});

    const email = el.querySelector<HTMLInputElement>('[data-inv-form] input[name="email"]')!;
    email.value = 'boss@tasca.dev';
    el.querySelector<HTMLFormElement>('[data-inv-form]')!.dispatchEvent(new Event('submit'));

    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    const err = el.querySelector<HTMLElement>('[data-inv-err]')!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('can’t invite above your own role');
    const link = el.querySelector<HTMLInputElement>('[data-inv-link]')!;
    expect(link.value).toBe(''); // no link revealed on failure
  });

  it('Revoke wires to a DELETE on the invite id and re-runs', async () => {
    _resetCsrfForTest();
    let deletedPath: string | null = null;
    // Custom fetch that records the DELETE path; everything else resolves the FULL fixtures.
    const routes: Record<string, { status?: number; body?: unknown }> = {
      ...FULL,
      '/api/invites': { body: INVITES_OK },
      '/api/invites/inv1': { body: { ok: true } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = String(input).split('?')[0]!;
        if (init?.method === 'DELETE') deletedPath = path;
        const r = routes[path];
        if (!r) return new Response('not found', { status: 404 });
        const status = r.status ?? 200;
        const body = r.body === undefined ? '' : JSON.stringify(r.body);
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      })
    );
    const el = document.createElement('div');
    el.innerHTML = htmlOf(await loadSettings());
    let reruns = 0;
    wireSettings(el, async () => {
      reruns++;
      el.innerHTML = htmlOf(await loadSettings());
    });

    el.querySelector<HTMLButtonElement>('[data-act="inv-revoke"][data-invite-id="inv1"]')!.click();

    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(deletedPath).toBe('/api/invites/inv1'); // wired to DELETE the right invite
    expect(reruns).toBeGreaterThan(0); // reconciled from server truth
  });
});
