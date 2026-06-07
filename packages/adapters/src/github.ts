import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  GitHubWebhookSchema,
  type AdapterEvent,
  type PlatformAdapter,
  type Reject,
  type StatusUpdate,
  type VerifiedEvent,
} from '@tasca/contracts';
import type { IdentityBinding, Platform } from '@tasca/domain';
import { GitHubAppClient } from './github-app-client';

// @tasca/adapters — the GitHub platform adapter (the second PlatformAdapter,
// mirroring the Shortcut adapter). GitHub ISSUES are a work SOURCE here: assigning
// an issue to an agent, or @-mentioning one in a comment, dispatches that agent.
// This is DISTINCT from @tasca/execution using the `gh` CLI to open PRs (that is
// the execution OUTPUT on a target repo, not a task source).
//
// Ungated intake only:
//   - verifyWebhook : HMAC-SHA-256 of the raw body vs `X-Hub-Signature-256`
//                     (`sha256=<hex>`), constant-time
//   - parseEvent    : issues.assigned + issue_comment.created (@-mention) ∩
//                     registered agents → AdapterEvent
//   - registerWebhook: POST /repos/{owner}/{repo}/hooks → hook id
//   - dedupeBySelf  : drop the agent's own round-tripped comments (sender login)
// The gated halves (provisionIdentity / postStatus) are typed but THROW — they
// depend on the GitHub-App-vs-PAT decision (see docs/Tasca-GitHub-Kickoff-Brief.md).
//
// Boundary: imports only @tasca/{domain,contracts} + node builtins.
// NO new runtime deps — node:crypto / node:fetch only.

const GATED_PROVISION_MESSAGE =
  'gated: GitHub identity provisioning not yet built — see docs/Tasca-GitHub-Kickoff-Brief.md (per-agent native identity is Phase 2)';

/** The header GitHub signs the raw body into: `sha256=<hex>` (HMAC-SHA-256). */
const SIGNATURE_HEADER = 'x-hub-signature-256';

/** The required signature prefix; the hex digest follows it. */
const SIGNATURE_PREFIX = 'sha256=';

/** GitHub REST v3 base. Overridable for tests; no trailing slash. */
const DEFAULT_API_BASE = 'https://api.github.com';

export interface GitHubAdapterConfig {
  /** The webhook secret used to verify the X-Hub-Signature-256 HMAC. */
  webhookSecret: string;
  /**
   * Our own agent GitHub logins (lowercased). Events whose ACTOR `sender.login`
   * is in this set are our writes round-tripping back — dedupeBySelf drops them.
   * Distinct from the *assignee* / mentioned agent ids passed to parseEvent.
   */
  selfLogins?: ReadonlySet<string>;
  /** REST v3 base override (tests). Defaults to the public GitHub API. */
  apiBase?: string;
  /** fetch override (tests). Defaults to global fetch (node:fetch). */
  fetchImpl?: typeof fetch;
  /**
   * The GitHub App client used for write-back (`postIssueStatus`). Pass a
   * pre-built client, OR `{appId, privateKey}` to have the adapter construct one
   * (sharing apiBase/fetchImpl). Absent → write-back throws (the App is not
   * configured); intake (verify/parse) is unaffected.
   */
  appClient?: GitHubAppClient;
  /** App credentials, used to construct a GitHubAppClient when `appClient` is absent. */
  appId?: string | number;
  privateKey?: string;
}

/** A status-back to a GitHub issue: a comment + an optional close, under the App. */
export interface PostIssueStatusInput {
  owner: string;
  repo: string;
  issueNumber: number;
  /** The installation under which to act (resolved per workspace). */
  installationId: string;
  /** The issue-comment body to post (already includes any attribution trailer). */
  commentBody: string;
  /** When true, also PATCH the issue to `state: 'closed'` after commenting. */
  closeIssue?: boolean;
}

/**
 * Look up a header case-insensitively (Node lowercases incoming header names,
 * but callers may forward a mixed-case map — normalize defensively).
 */
function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/**
 * Constant-time compare of two hex signatures. Returns false (never throws) on
 * any length mismatch or non-hex input, so a malformed signature is a clean
 * reject rather than an exception. timingSafeEqual requires equal-length buffers,
 * so the length guard precedes it; the byte comparison stays constant-time for
 * equal-length inputs (the only case an attacker controls once a length is fixed).
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, 'hex');
    bufB = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Lowercased @-mention logins in a comment body (e.g. "@elvis ..." → "elvis"). */
function mentionedLogins(body: string): Set<string> {
  const out = new Set<string>();
  // GitHub logins: alphanumeric or single hyphens, 1–39 chars. Match @login not
  // preceded by a word char (so emails like a@b aren't treated as mentions).
  const re = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.add(m[1]!.toLowerCase());
  }
  return out;
}

export class GitHubAdapter implements PlatformAdapter {
  readonly platform: Platform = 'github';

  private readonly webhookSecret: string;
  private readonly selfLogins: ReadonlySet<string>;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  /** App client for write-back; null when the App is not configured. */
  private readonly appClient: GitHubAppClient | null;

  constructor(config: GitHubAdapterConfig) {
    if (!config.webhookSecret) {
      // An empty secret would make verifyWebhook accept any body signed with the
      // empty-key HMAC — i.e. a forgeable signature. Refuse to construct.
      throw new Error('GitHubAdapter: webhookSecret is required and must be non-empty');
    }
    this.webhookSecret = config.webhookSecret;
    this.selfLogins = config.selfLogins ?? new Set();
    this.apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    // Write-back client: an explicit client wins; otherwise build one from App
    // creds (sharing apiBase/fetchImpl) when both are present; else null (gated).
    if (config.appClient) {
      this.appClient = config.appClient;
    } else if (config.appId !== undefined && config.privateKey) {
      this.appClient = new GitHubAppClient({
        appId: config.appId,
        privateKey: config.privateKey,
        apiBase: this.apiBase,
        fetchImpl: this.fetchImpl,
      });
    } else {
      this.appClient = null;
    }
  }

  /**
   * Verify HMAC-SHA-256 over the RAW UTF-8 body keyed by the webhook secret,
   * compared CONSTANT-TIME against the `X-Hub-Signature-256` header. The header
   * value is `sha256=<hex>`; the `sha256=` prefix is required and stripped before
   * comparison. Rejects on a missing header, a missing/wrong prefix, or a
   * mismatch. Never throws — returns a discriminated VerifiedEvent | Reject.
   */
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>
  ): VerifiedEvent | Reject {
    const provided = getHeader(headers, SIGNATURE_HEADER);
    if (!provided) {
      return { ok: false, reason: 'missing X-Hub-Signature-256 header' };
    }
    if (!provided.startsWith(SIGNATURE_PREFIX)) {
      return { ok: false, reason: 'signature missing sha256= prefix' };
    }
    const providedHex = provided.slice(SIGNATURE_PREFIX.length);
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody, 'utf8').digest('hex');
    if (!constantTimeHexEqual(providedHex, expected)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    return { ok: true, rawBody };
  }

  /**
   * Parse a verified webhook into normalized `AdapterEvent`s. Validates the
   * payload with the Zod schema FIRST (malformed → []), then handles two events:
   *
   *   - `issues` action `assigned`: the just-assigned `assignee` (NOT `sender`,
   *     the actor) — if its id is a registered agent, emit one event.
   *   - `issue_comment` action `created`: each registered agent @-mentioned in the
   *     comment body (matched by handle/login) emits one event.
   *
   * `agentExternalIds` carries BOTH stringified numeric user ids (for the
   * assignee branch) and lowercased logins (for the mention branch); each branch
   * matches against the form it has. De-duped by (story, agent) so one envelope
   * never double-dispatches. `repoHint` carries `repository.full_name`.
   */
  parseEvent(verified: VerifiedEvent, agentExternalIds: ReadonlySet<string>): AdapterEvent[] {
    let raw: unknown;
    try {
      raw = JSON.parse(verified.rawBody);
    } catch {
      return [];
    }
    const parsed = GitHubWebhookSchema.safeParse(raw);
    if (!parsed.success) return [];
    const payload = parsed.data;

    const repoFullName = payload.repository?.full_name;
    const issueNumber = payload.issue?.number;
    // No resolvable issue → nothing to route to.
    if (repoFullName === undefined || issueNumber === undefined) return [];
    const externalStoryId = `${repoFullName}#${issueNumber}`;
    const repoHint = repoFullName;

    const events: AdapterEvent[] = [];
    const seen = new Set<string>();
    const push = (agentExternalId: string) => {
      const key = `${externalStoryId} ${agentExternalId}`;
      if (seen.has(key)) return;
      seen.add(key);
      events.push({
        type: 'task.assigned',
        platform: 'github',
        externalStoryId,
        agentExternalId,
        repoHint,
      });
    };

    if (payload.action === 'assigned' && payload.assignee) {
      // The assignment signal is the just-assigned user, matched by numeric id.
      const assigneeId = String(payload.assignee.id);
      if (agentExternalIds.has(assigneeId)) push(assigneeId);
    } else if (payload.action === 'created' && payload.comment) {
      // @-mentions are by login; match registered agent logins (lowercased).
      const mentions = mentionedLogins(payload.comment.body);
      for (const login of mentions) {
        if (agentExternalIds.has(login)) push(login);
      }
    }
    return events;
  }

  /**
   * Drop events that originated from our OWN comments round-tripping back through
   * the webhook stream. The envelope's actor `sender.login` is matched against our
   * agent logins; if it is one of ours, every event from that envelope is our echo
   * and must not be re-dispatched.
   *
   * Because `parseEvent` discards `sender` (correctly — it is the actor, not the
   * assignee), the actor login must be supplied here explicitly.
   */
  dedupeBySelf(events: AdapterEvent[], actorLogin: string | undefined): AdapterEvent[] {
    if (actorLogin !== undefined && this.selfLogins.has(actorLogin.toLowerCase())) {
      return [];
    }
    return events;
  }

  /**
   * Self-register a repository webhook at install:
   * `POST /repos/{owner}/{repo}/hooks` with the bearer `token` (REST v3).
   * Resolves to the created hook id (a string). Uses node:fetch — no new deps.
   *
   * NOTE: when the identity model is a GitHub App, webhooks are delivered by the
   * App installation automatically and this is unused; it remains for the REST
   * repo-hook path and interface conformance.
   */
  async registerWebhook(input: {
    webhookUrl: string;
    secret: string;
    token: string;
    /** `owner/repo` — required for GitHub (the PlatformAdapter seam omits it). */
    repoFullName?: string;
  }): Promise<string> {
    if (!input.repoFullName) {
      throw new Error('github registerWebhook: repoFullName is required (owner/repo)');
    }
    const res = await this.fetchImpl(`${this.apiBase}/repos/${input.repoFullName}/hooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${input.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['issues', 'issue_comment'],
        config: { url: input.webhookUrl, content_type: 'json', secret: input.secret },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`github registerWebhook failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    const json = (await res.json()) as { id?: string | number };
    if (json.id === undefined || json.id === null) {
      throw new Error('github registerWebhook: response missing hook id');
    }
    return String(json.id);
  }

  /**
   * Write-back: post a status comment to an issue (and optionally close it) under
   * the GitHub App installation. Acquires an installation token via the App client
   * (in-memory cached), then `POST /repos/{owner}/{repo}/issues/{n}/comments` with
   * `{body}`; when `closeIssue`, also `PATCH /repos/{owner}/{repo}/issues/{n}`
   * with `{state:'closed'}`. Throws on a non-2xx (the worker reporter decides
   * whether to swallow or propagate) and when the App is not configured.
   */
  async postIssueStatus(input: PostIssueStatusInput): Promise<void> {
    if (!this.appClient) {
      throw new Error(
        'github postIssueStatus: GitHub App not configured (appClient / appId+privateKey required)'
      );
    }
    const { token } = await this.appClient.getInstallationToken(input.installationId);
    const base = `/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`;
    await this.appClient.request(token, 'POST', `${base}/comments`, { body: input.commentBody });
    if (input.closeIssue) {
      await this.appClient.request(token, 'PATCH', base, { state: 'closed' });
    }
  }

  /**
   * GATED — provision/link the agent's native GitHub identity. Throws until the
   * per-agent identity model is built; do NOT implement here. See
   * docs/Tasca-GitHub-Kickoff-Brief.md.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async provisionIdentity(_agentId: string, _workspaceConn: unknown): Promise<IdentityBinding> {
    throw new Error(GATED_PROVISION_MESSAGE);
  }

  /**
   * The thin PlatformAdapter status seam. Write-back is driven through
   * `postIssueStatus` (which carries the installation id + owner/repo/issue the
   * binding-shaped `StatusUpdate` does not), so this overload is unused — it
   * throws pointing at the real entrypoint rather than the old generic gated note.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async postStatus(_binding: IdentityBinding, _update: StatusUpdate): Promise<void> {
    throw new Error('github postStatus: use postIssueStatus(...) for GitHub write-back');
  }
}
