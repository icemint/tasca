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
  htmlOf,
} from '../test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
});

const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };

describe('settings wiring — vendor key set is write-only (slice 3.5-A.2c.2)', () => {
  it('SECURITY: a set-key happy path NEVER echoes the submitted key into the DOM, and clears the input', async () => {
    _resetCsrfForTest();
    const SECRET = 'sk-ant-supersecret-do-not-render-0xDEADBEEF';
    stubFetch({
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
