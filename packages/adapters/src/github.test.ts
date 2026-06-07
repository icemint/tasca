import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { GitHubWebhookSchema } from '@tasca/contracts';
import { GitHubAdapter } from './index';

// Pure unit tests for the ungated GitHub intake — no live GitHub. Covers:
//   - HMAC verify: valid (sha256= prefix) passes, tampered fails, missing/prefix-less/!= rejects
//   - parseEvent: issues.assigned (assignee, not sender), issue_comment mention
//   - non-registered assignee/mention ignored; repoHint + composite story id
//   - dedupeBySelf drops our own (sender.login) comments
//   - registerWebhook POST shape; Zod boundary

const SECRET = 'whsec_test_github_secret';

// Registered agent GitHub numeric ids (for the assignee branch) + logins (mentions).
const ELVIS_ID = '5550001';
const ELVIS_LOGIN = 'elvis-tasca';
const MONA_ID = '5550002';
const MONA_LOGIN = 'mona-tasca';
// A human teammate — NOT registered.
const HUMAN_ID = '9990000';
// The actor who triggered the event (assigner / commenter), distinct from assignee.
const ACTOR_LOGIN = 'denny';

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function adapter(opts: Partial<ConstructorParameters<typeof GitHubAdapter>[0]> = {}) {
  return new GitHubAdapter({ webhookSecret: SECRET, ...opts });
}

/** issues.assigned envelope: Elvis just assigned to icemint/demo#42 by the actor. */
function assignedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'assigned',
    sender: { id: 7000, login: ACTOR_LOGIN },
    repository: { full_name: 'icemint/demo' },
    issue: { number: 42, node_id: 'I_kw42' },
    assignee: { id: Number(ELVIS_ID), login: ELVIS_LOGIN },
    ...overrides,
  };
}

/** issue_comment.created envelope mentioning @elvis-tasca on icemint/demo#42. */
function commentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    sender: { id: 7000, login: ACTOR_LOGIN },
    repository: { full_name: 'icemint/demo' },
    issue: { number: 42 },
    comment: { id: 9001, body: `hey @${ELVIS_LOGIN} can you take this?` },
    ...overrides,
  };
}

const REGISTERED = new Set([ELVIS_ID, ELVIS_LOGIN, MONA_ID, MONA_LOGIN]);

describe('GitHubAdapter.verifyWebhook (HMAC-SHA-256, sha256= prefix, constant-time)', () => {
  it('accepts a body signed with the webhook secret', () => {
    const body = JSON.stringify(assignedPayload());
    const res = adapter().verifyWebhook(body, { 'X-Hub-Signature-256': sign(body) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rawBody).toBe(body);
  });

  it('rejects a tampered body (signature no longer matches)', () => {
    const body = JSON.stringify(assignedPayload());
    const signature = sign(body);
    const tampered = body.replace('42', '43');
    const res = adapter().verifyWebhook(tampered, { 'X-Hub-Signature-256': signature });
    expect(res).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects when the signature header is absent', () => {
    const body = JSON.stringify(assignedPayload());
    const res = adapter().verifyWebhook(body, {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/missing/i);
  });

  it('rejects a signature missing the sha256= prefix', () => {
    const body = JSON.stringify(assignedPayload());
    const hexOnly = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    const res = adapter().verifyWebhook(body, { 'X-Hub-Signature-256': hexOnly });
    expect(res).toEqual({ ok: false, reason: 'signature missing sha256= prefix' });
  });

  it('rejects a present-but-wrong signature (different secret)', () => {
    const body = JSON.stringify(assignedPayload());
    const wrong = sign(body, 'whsec_other');
    const res = adapter().verifyWebhook(body, { 'X-Hub-Signature-256': wrong });
    expect(res).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a correct-length-but-non-hex digest without throwing (constant-time guard)', () => {
    const body = JSON.stringify(assignedPayload());
    const sixtyFourNonHex = 'sha256=' + 'z'.repeat(64);
    let res: ReturnType<ReturnType<typeof adapter>['verifyWebhook']>;
    expect(() => {
      res = adapter().verifyWebhook(body, { 'X-Hub-Signature-256': sixtyFourNonHex });
    }).not.toThrow();
    expect(res!.ok).toBe(false);
  });

  it('reads the signature header case-insensitively', () => {
    const body = JSON.stringify(assignedPayload());
    const res = adapter().verifyWebhook(body, { 'x-hub-signature-256': sign(body) });
    expect(res.ok).toBe(true);
  });

  it('verifies over the EXACT raw bytes (re-serialized JSON would not match)', () => {
    const body = '{ "action":"assigned", "spacing":"kept" }';
    const res = adapter().verifyWebhook(body, { 'X-Hub-Signature-256': sign(body) });
    expect(res.ok).toBe(true);
    const compact = JSON.stringify(JSON.parse(body));
    const res2 = adapter().verifyWebhook(body, { 'X-Hub-Signature-256': sign(compact) });
    expect(res2.ok).toBe(false);
  });
});

describe('GitHubAdapter.parseEvent (issues.assigned)', () => {
  it('detects the just-assigned registered agent, with repoHint + composite story id', () => {
    const body = JSON.stringify(assignedPayload());
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([
      {
        type: 'task.assigned',
        platform: 'github',
        externalStoryId: 'icemint/demo#42',
        agentExternalId: ELVIS_ID,
        repoHint: 'icemint/demo',
      },
    ]);
  });

  it('does NOT treat the actor (sender) as an assignee', () => {
    // sender is a registered agent, but the assignee is a human → no event.
    const body = JSON.stringify(
      assignedPayload({
        sender: { id: Number(ELVIS_ID), login: ELVIS_LOGIN },
        assignee: { id: Number(HUMAN_ID), login: 'a-human' },
      })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('ignores an assignee that is not a registered agent', () => {
    const body = JSON.stringify(
      assignedPayload({ assignee: { id: Number(HUMAN_ID), login: 'a-human' } })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('ignores non-assigned issues actions (e.g. opened/labeled)', () => {
    const body = JSON.stringify(assignedPayload({ action: 'labeled' }));
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('returns [] when there is no resolvable repo or issue', () => {
    const noRepo = JSON.stringify(assignedPayload({ repository: undefined }));
    expect(adapter().parseEvent({ ok: true, rawBody: noRepo }, REGISTERED)).toEqual([]);
    const noIssue = JSON.stringify(assignedPayload({ issue: undefined }));
    expect(adapter().parseEvent({ ok: true, rawBody: noIssue }, REGISTERED)).toEqual([]);
  });
});

describe('GitHubAdapter.parseEvent (issue_comment.created @-mention)', () => {
  it('emits on an @-mention of a registered agent (matched by login)', () => {
    const body = JSON.stringify(commentPayload());
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([
      {
        type: 'task.assigned',
        platform: 'github',
        externalStoryId: 'icemint/demo#42',
        agentExternalId: ELVIS_LOGIN,
        repoHint: 'icemint/demo',
      },
    ]);
  });

  it('ignores a mention of a non-registered login', () => {
    const body = JSON.stringify(commentPayload({ comment: { id: 1, body: 'cc @someone-else' } }));
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('ignores non-created comment actions (edited/deleted)', () => {
    const body = JSON.stringify(commentPayload({ action: 'edited' }));
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('does not treat an email-like a@b as a mention', () => {
    const body = JSON.stringify(commentPayload({ comment: { id: 2, body: `ping user@${ELVIS_LOGIN}.com` } }));
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toEqual([]);
  });

  it('emits at most one event per (issue, agent) when mentioned twice', () => {
    const body = JSON.stringify(
      commentPayload({ comment: { id: 3, body: `@${ELVIS_LOGIN} and again @${ELVIS_LOGIN}` } })
    );
    const events = adapter().parseEvent({ ok: true, rawBody: body }, REGISTERED);
    expect(events).toHaveLength(1);
    expect(events[0]!.agentExternalId).toBe(ELVIS_LOGIN);
  });

  it('returns [] for malformed / non-JSON bodies', () => {
    expect(adapter().parseEvent({ ok: true, rawBody: 'not json {' }, REGISTERED)).toEqual([]);
    expect(adapter().parseEvent({ ok: true, rawBody: JSON.stringify({ action: 5 }) }, REGISTERED)).toEqual([]);
  });
});

describe('GitHubAdapter.dedupeBySelf', () => {
  it('drops events whose actor login is one of our agents (case-insensitive)', () => {
    const a = adapter({ selfLogins: new Set([ELVIS_LOGIN]) });
    const events = [
      { type: 'task.assigned' as const, platform: 'github' as const, externalStoryId: 'r#1', agentExternalId: MONA_ID },
    ];
    expect(a.dedupeBySelf(events, ELVIS_LOGIN.toUpperCase())).toEqual([]);
  });

  it('keeps events whose actor is an external human', () => {
    const a = adapter({ selfLogins: new Set([ELVIS_LOGIN]) });
    const events = [
      { type: 'task.assigned' as const, platform: 'github' as const, externalStoryId: 'r#1', agentExternalId: MONA_ID },
    ];
    expect(a.dedupeBySelf(events, ACTOR_LOGIN)).toEqual(events);
  });

  it('keeps events when the actor is undefined', () => {
    const a = adapter({ selfLogins: new Set([ELVIS_LOGIN]) });
    const events = [
      { type: 'task.assigned' as const, platform: 'github' as const, externalStoryId: 'r#1', agentExternalId: MONA_ID },
    ];
    expect(a.dedupeBySelf(events, undefined)).toEqual(events);
  });
});

describe('GitHubAdapter constructor (secret guard)', () => {
  it('refuses to construct with an empty webhook secret', () => {
    expect(() => new GitHubAdapter({ webhookSecret: '' })).toThrow(/webhookSecret/);
  });
});

describe('GitHubWebhookSchema (Zod boundary guard)', () => {
  it('accepts the assigned + comment samples', () => {
    expect(GitHubWebhookSchema.safeParse(assignedPayload()).success).toBe(true);
    expect(GitHubWebhookSchema.safeParse(commentPayload()).success).toBe(true);
  });

  it('rejects a malformed payload (action not a string)', () => {
    expect(GitHubWebhookSchema.safeParse({ action: 5 }).success).toBe(false);
  });

  it('tolerates unknown extra fields (passthrough)', () => {
    expect(GitHubWebhookSchema.safeParse(assignedPayload({ installation: { id: 1 } })).success).toBe(true);
  });
});

describe('GitHubAdapter.registerWebhook (REST v3, injected fetch)', () => {
  it('POSTs to /repos/{owner}/{repo}/hooks with the bearer token and returns the id', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ id: 13579 }), { status: 201 });
    }) as unknown as typeof fetch;

    const a = adapter({ apiBase: 'https://api.example.test', fetchImpl: fakeFetch });
    const id = await a.registerWebhook({
      webhookUrl: 'https://api.tasca.dev/webhooks/github',
      secret: SECRET,
      token: 'ghs_token',
      repoFullName: 'icemint/demo',
    });

    expect(id).toBe('13579');
    expect(captured?.url).toBe('https://api.example.test/repos/icemint/demo/hooks');
    expect(captured?.init.method).toBe('POST');
    const headers = captured?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ghs_token');
    const sentBody = JSON.parse(String(captured?.init.body));
    expect(sentBody.events).toEqual(['issues', 'issue_comment']);
    expect(sentBody.config).toMatchObject({ url: 'https://api.tasca.dev/webhooks/github', secret: SECRET });
  });

  it('throws when repoFullName is missing', async () => {
    await expect(
      adapter().registerWebhook({ webhookUrl: 'https://x', secret: SECRET, token: 't' })
    ).rejects.toThrow(/repoFullName/);
  });

  it('throws on a non-2xx response', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 422, statusText: 'Unprocessable' })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(
      a.registerWebhook({ webhookUrl: 'https://x', secret: SECRET, token: 't', repoFullName: 'o/r' })
    ).rejects.toThrow(/422/);
  });

  it('throws on a 2xx response that omits the hook id', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 201 })) as unknown as typeof fetch;
    const a = adapter({ fetchImpl: fakeFetch });
    await expect(
      a.registerWebhook({ webhookUrl: 'https://x', secret: SECRET, token: 't', repoFullName: 'o/r' })
    ).rejects.toThrow(/missing hook id/i);
  });
});

describe('GitHubAdapter.postIssueStatus (write-back via the App, injected fetch)', () => {
  /** A stub App client that records its requests and returns a canned token. */
  function stubAppClient() {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    let throwStatus = false;
    return {
      calls,
      failNext() {
        throwStatus = true;
      },
      client: {
        async getInstallationToken(_installationId: string) {
          return { token: 'ghs_inst', expiresAt: Date.now() + 3_600_000 };
        },
        async request(_token: string, method: string, path: string, body?: unknown) {
          calls.push({ method, path, body });
          if (throwStatus) throw new Error('github POST failed: 422 Unprocessable');
          return null;
        },
      } as unknown as NonNullable<ConstructorParameters<typeof GitHubAdapter>[0]['appClient']>,
    };
  }

  it('POSTs a comment to /repos/{owner}/{repo}/issues/{n}/comments with the body', async () => {
    const stub = stubAppClient();
    const a = new GitHubAdapter({ webhookSecret: SECRET, appClient: stub.client });
    await a.postIssueStatus({
      owner: 'icemint',
      repo: 'demo',
      issueNumber: 42,
      installationId: '77',
      commentBody: 'PR opened\nhttps://github.com/icemint/demo/pull/5',
    });
    expect(stub.calls).toEqual([
      {
        method: 'POST',
        path: '/repos/icemint/demo/issues/42/comments',
        body: { body: 'PR opened\nhttps://github.com/icemint/demo/pull/5' },
      },
    ]);
  });

  it('also PATCHes the issue to state:closed when closeIssue is set', async () => {
    const stub = stubAppClient();
    const a = new GitHubAdapter({ webhookSecret: SECRET, appClient: stub.client });
    await a.postIssueStatus({
      owner: 'icemint',
      repo: 'demo',
      issueNumber: 42,
      installationId: '77',
      commentBody: 'done',
      closeIssue: true,
    });
    expect(stub.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/icemint/demo/issues/42/comments',
      'PATCH /repos/icemint/demo/issues/42',
    ]);
    expect(stub.calls[1]!.body).toEqual({ state: 'closed' });
  });

  it('propagates a non-2xx error from the underlying request', async () => {
    const stub = stubAppClient();
    stub.failNext();
    const a = new GitHubAdapter({ webhookSecret: SECRET, appClient: stub.client });
    await expect(
      a.postIssueStatus({
        owner: 'o',
        repo: 'r',
        issueNumber: 1,
        installationId: '77',
        commentBody: 'x',
      })
    ).rejects.toThrow(/422/);
  });

  it('throws when the App is not configured', async () => {
    await expect(
      adapter().postIssueStatus({
        owner: 'o',
        repo: 'r',
        issueNumber: 1,
        installationId: '77',
        commentBody: 'x',
      })
    ).rejects.toThrow(/App not configured/);
  });
});

describe('GitHubAdapter gated halves (stubbed)', () => {
  it('provisionIdentity throws the gated error citing the brief', async () => {
    await expect(adapter().provisionIdentity('agent_elvis', {})).rejects.toThrow(
      /gated: GitHub identity provisioning not yet built/
    );
  });
});
