import { describe, it, expect } from 'vitest';
import { registerShortcutWebhook, DEFAULT_SHORTCUT_WEBHOOK_URL } from './shortcut-webhook-registration';

interface Capture {
  url?: string | undefined;
  init?: RequestInit | undefined;
}

/** A fetch fake that records the call and returns a canned Response-like object. */
function fakeFetch(
  cap: Capture,
  response: { ok: boolean; status?: number; body?: unknown }
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    cap.url = String(url);
    cap.init = init;
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      statusText: '',
      async json() {
        return response.body;
      },
      async text() {
        return JSON.stringify(response.body ?? '');
      },
    } as Response;
  }) as typeof fetch;
}

describe('registerShortcutWebhook', () => {
  it('throws before any network call when SHORTCUT_API_TOKEN is missing', async () => {
    const cap: Capture = {};
    await expect(
      registerShortcutWebhook({ webhookSecret: 's' }, fakeFetch(cap, { ok: true, body: { id: 1 } }))
    ).rejects.toThrow(/SHORTCUT_API_TOKEN is required/);
    expect(cap.url).toBeUndefined(); // validation happens before the POST
  });

  it('throws before any network call when SHORTCUT_WEBHOOK_SECRET is missing', async () => {
    const cap: Capture = {};
    await expect(
      registerShortcutWebhook({ apiToken: 't' }, fakeFetch(cap, { ok: true, body: { id: 1 } }))
    ).rejects.toThrow(/SHORTCUT_WEBHOOK_SECRET is required/);
    expect(cap.url).toBeUndefined();
  });

  it('POSTs the webhook with the admin token + secret and returns the id', async () => {
    const cap: Capture = {};
    const id = await registerShortcutWebhook(
      {
        apiToken: 'tok-admin',
        webhookSecret: 'hmac-secret',
        webhookUrl: 'https://x.example/webhooks/shortcut',
      },
      fakeFetch(cap, { ok: true, body: { id: 4242 } })
    );
    expect(id).toBe('4242');
    expect(cap.url).toMatch(/\/api\/v3\/integrations\/webhook$/);
    expect(cap.init?.method).toBe('POST');
    expect((cap.init?.headers as Record<string, string>)['Shortcut-Token']).toBe('tok-admin');
    expect(JSON.parse(String(cap.init?.body))).toEqual({
      webhook_url: 'https://x.example/webhooks/shortcut',
      secret: 'hmac-secret',
    });
  });

  it('defaults the webhook URL to the worker route', async () => {
    const cap: Capture = {};
    await registerShortcutWebhook(
      { apiToken: 't', webhookSecret: 's' },
      fakeFetch(cap, { ok: true, body: { id: 1 } })
    );
    expect(JSON.parse(String(cap.init?.body)).webhook_url).toBe(DEFAULT_SHORTCUT_WEBHOOK_URL);
  });

  it('surfaces a Shortcut API error', async () => {
    const cap: Capture = {};
    await expect(
      registerShortcutWebhook(
        { apiToken: 't', webhookSecret: 's' },
        fakeFetch(cap, { ok: false, status: 401, body: { message: 'bad token' } })
      )
    ).rejects.toThrow(/registerWebhook failed/);
  });
});
