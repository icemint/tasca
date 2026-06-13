import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendInviteEmail, type InviteEmail } from './email';
import type { Logger } from './ports';

const EMAIL: InviteEmail = {
  to: 'invitee@x.test',
  acceptUrl: 'https://app.tasca.test/invite?token=SECRET-TOKEN',
  orgName: 'Acme',
  inviterEmail: 'admin@x.test',
};

function recordingLogger(): { logger: Logger; errors: Array<[string, Record<string, unknown> | undefined]>; infos: Array<[string, Record<string, unknown> | undefined]> } {
  const errors: Array<[string, Record<string, unknown> | undefined]> = [];
  const infos: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    errors,
    infos,
    logger: {
      error: (m, c) => errors.push([m, c]),
      info: (m, c) => infos.push([m, c]),
    },
  };
}

describe('sendInviteEmail — best-effort Resend, never throws', () => {
  const origKey = process.env.RESEND_API_KEY;
  const origFetch = globalThis.fetch;
  afterEach(() => {
    if (origKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = origKey;
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('RESEND_API_KEY set → POSTs to the Resend endpoint with the right shape', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> => new Response('{}', { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendInviteEmail(EMAIL);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, init] = fetchMock.mock.calls[0]!;
    expect(urlArg).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer rk_test');
    const sent = JSON.parse(init.body as string);
    expect(sent.to).toBe(EMAIL.to);
    expect(sent.subject).toContain('Acme');
    expect(sent.html).toContain(EMAIL.acceptUrl);
  });

  it('RESEND_API_KEY unset → logs the link at info and does NOT call fetch', async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { logger, infos } = recordingLogger();

    await sendInviteEmail(EMAIL, logger);

    expect(fetchMock).not.toHaveBeenCalled();
    // The skip is logged, but with the token REDACTED — the raw single-use token must never reach the log
    // pipeline (that would defeat hash-at-rest; the admin gets the full link from the create response).
    expect(
      infos.some(([m, c]) => m.includes('RESEND_API_KEY unset') && c?.acceptUrl === 'https://app.tasca.test/invite?token=***')
    ).toBe(true);
    expect(JSON.stringify(infos)).not.toContain('SECRET-TOKEN');
  });

  it('a non-2xx response is logged at error and swallowed (never thrown); no token in the error context', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    globalThis.fetch = (async () => new Response('nope', { status: 422 })) as unknown as typeof fetch;
    const { logger, errors } = recordingLogger();

    await expect(sendInviteEmail(EMAIL, logger)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).not.toContain('SECRET-TOKEN');
  });

  it('a fetch throw is logged at error and swallowed (never thrown)', async () => {
    process.env.RESEND_API_KEY = 'rk_test';
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { logger, errors } = recordingLogger();

    await expect(sendInviteEmail(EMAIL, logger)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).not.toContain('SECRET-TOKEN');
  });
});
