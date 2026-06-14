import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadRoster, defaultTierForModel } from './roster';
import { loadMonitoring } from './monitoring';
import { loadTask, describeTaskOutcome } from './task';
import { loadAgent } from './agent';
import { loadConnections } from './connections';
import { loadOnboarding } from './onboarding';
import { loadSettings } from './settings';
import { loadPmAssistant } from './pm-assistant';
import {
  stubFetch,
  AGENT_ELVIS,
  AGENT_ELVIS_DETAIL,
  TASK_LRU,
  TASK_RETRY_ATTN,
  TASK_LRU_DETAIL,
  TASK_EXECUTING_DETAIL,
  TASK_NO_CAPACITY_DETAIL,
  CONNECTIONS_OK,
  VENDOR_CREDS_ACTIVE,
  VENDOR_CREDS_EMPTY,
  CREDENTIAL_AUDIT_OK,
  CREDENTIAL_AUDIT_EMPTY,
  ORG_INFO_OWNER,
  ORG_INFO_MEMBER,
  MEMBERS_OK,
  INVITES_OK,
  INVITES_EMPTY,
  SESSION_OK,
  htmlOf,
} from '../test-support';
import type { TaskSummary } from '../contract';

afterEach(() => vi.unstubAllGlobals());

/** Set the ?id= query the detail views read via queryId(). */
function withId(id: string): void {
  vi.stubGlobal('location', { search: `?id=${id}` });
}

describe('roster', () => {
  it('renders real agents and a LIVE Create agent control (member+, not gated) — no stray "Coming soon"', async () => {
    stubFetch({ '/api/agents': { body: [AGENT_ELVIS] } });
    const r = await loadRoster();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('Elvis');
    expect(htmlOf(r)).toContain('Your team');
    // Create agent is a LIVE member+ control — never the read-only provisioning gate.
    expect(htmlOf(r)).toContain('data-act="ca-open"');
    expect(htmlOf(r)).toContain('Create agent');
    expect(htmlOf(r)).not.toContain('Agent provisioning is operator-run today');
    expect(htmlOf(r)).not.toContain('Coming soon');
  });

  it('renders an honest empty state with no agents', async () => {
    stubFetch({ '/api/agents': { body: [] } });
    const r = await loadRoster();
    expect(r.kind).toBe('empty');
    expect(htmlOf(r)).toContain('No agents yet');
  });

  it('propagates unauth from a 401', async () => {
    stubFetch({ '/api/agents': { status: 401, body: {} } });
    expect((await loadRoster()).kind).toBe('unauth');
  });

  it('the create form carries all fields, real labels, and a role=alert error slot', async () => {
    stubFetch({ '/api/agents': { body: [AGENT_ELVIS] } });
    const html = htmlOf(await loadRoster());
    expect(html).toContain('data-ca-form');
    // every field has a real <label for> + native control
    expect(html).toContain('<label class="ca-label" for="ca-name">');
    expect(html).toContain('id="ca-name"');
    expect(html).toContain('<label class="ca-label" for="ca-vendor">');
    expect(html).toContain('<select id="ca-vendor"');
    expect(html).toContain('<label class="ca-label" for="ca-model">');
    expect(html).toContain('id="ca-model"');
    expect(html).toContain('<label class="ca-label" for="ca-tier">');
    expect(html).toContain('<select id="ca-tier"');
    expect(html).toContain('type="url"'); // optional avatar
    // vendor options (Claude default first)
    expect(html).toContain('<option value="claude">Claude</option>');
    expect(html).toContain('<option value="openai">OpenAI</option>');
    expect(html).toContain('<option value="local">Local</option>');
    // the inline error is announced
    expect(html).toContain('data-ca-err');
    expect(html).toContain('role="alert"');
    // the default model (claude-opus-4-8) pre-selects ULTRA in the tier <select>
    expect(html).toContain('<option value="ultra" selected>ULTRA</option>');
  });

  it('the Create agent control is member+ — a NON-ADMIN member still sees the live form', async () => {
    stubFetch({
      '/api/agents': { body: [AGENT_ELVIS] },
      '/api/orgs': { body: { orgs: [{ id: 'o1', name: 'A', role: 'member', active: true }] } },
      '/api/orgs/agents': { body: { agents: [] } },
    });
    const html = htmlOf(await loadRoster());
    // create is live for a non-admin member (the per-card Hire stays admin-gated — unaffected)
    expect(html).toContain('data-act="ca-open"');
    expect(html).toContain('data-ca-form');
    expect(html).not.toContain('data-act="hire"'); // hire is still admin-gated
    expect(html).toContain('Admin role required to manage the roster');
  });
});

describe('defaultTierForModel — client mirror of the backend model→tier table', () => {
  it('maps the known model families', () => {
    expect(defaultTierForModel('claude', 'claude-opus-4-8')).toBe('ultra');
    expect(defaultTierForModel('claude', 'claude-sonnet-4')).toBe('hard');
    expect(defaultTierForModel('claude', 'claude-3-5-haiku')).toBe('low');
    expect(defaultTierForModel('openai', 'gpt-4o')).toBe('hard');
    expect(defaultTierForModel('openai', 'o1-preview')).toBe('hard');
    expect(defaultTierForModel('openai', 'gpt-4o-mini')).toBe('low');
    expect(defaultTierForModel('openai', 'gpt-3.5-turbo')).toBe('low');
    expect(defaultTierForModel('local', 'qwen2.5-coder')).toBe('medium'); // the fallback
  });

  it('is VENDOR-GATED (no cross-vendor substring drift) — matches the backend', () => {
    // A local/openai model that merely CONTAINS a Claude/GPT keyword must NOT inherit that tier — the
    // backend gates on vendor, so the client must too (else a confidently-wrong recommended cap ships).
    expect(defaultTierForModel('local', 'gpt-4-coder')).toBe('medium'); // not 'hard'
    expect(defaultTierForModel('local', 'my-opus-clone')).toBe('medium'); // not 'ultra'
    expect(defaultTierForModel('openai', 'opus-mini')).toBe('medium'); // not 'ultra' (opus only under claude)
    expect(defaultTierForModel('claude', 'gpt-4-something')).toBe('medium'); // gpt-4 only under openai
    expect(defaultTierForModel('local', 'sonnet-q4')).toBe('medium'); // not 'hard'
  });
});

describe('monitoring', () => {
  /** A TaskSummary fixture for one status (covering the 5-column remap). */
  const taskAt = (status: TaskSummary['status'], id: string, lastError: string | null = null): TaskSummary => ({
    id,
    externalStoryId: `roadhero/agentic-playground#${id}`,
    platform: 'github',
    status,
    tierEstimate: 'medium',
    repoRef: 'roadhero/agentic-playground',
    claimedBy: null,
    failureCount: 0,
    lastError,
  });

  it('boards real tasks across five operator columns and offers a live Refresh', async () => {
    stubFetch({ '/api/tasks': { body: [TASK_LRU, TASK_RETRY_ATTN] } });
    const r = await loadMonitoring();
    expect(r.kind).toBe('ok');
    // the done LRU task and the needs-attention retry task both show
    expect(htmlOf(r)).toContain('roadhero/agentic-playground#5');
    expect(htmlOf(r)).toContain('roadhero/agentic-playground#6');
    // the five operator columns
    for (const label of ['Backlog', 'Blocked', 'In Progress', 'PR Opened', 'Completed']) {
      expect(htmlOf(r)).toContain(label);
    }
    // "Live" is honest: a real Refresh re-fetch, not a fake realtime claim
    expect(htmlOf(r)).toContain('data-act="refresh"');
    expect(htmlOf(r)).not.toContain('Coming soon');
    // scope indicator: with no active project the board reads "All projects"
    expect(htmlOf(r)).toContain('class="scope-tag">All projects');
  });

  it('the Blocked column shows each task’s why-blocked reason (lastError)', async () => {
    const reason = 'no execution capacity: no agent-runner claimed within 30000ms';
    stubFetch({ '/api/tasks': { body: [taskAt('needs_attention', 'blk', reason)] } });
    const r = await loadMonitoring();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('Blocked');
    expect(htmlOf(r)).toContain('class="mt-reason"');
    expect(htmlOf(r)).toContain(reason);
  });

  it('covers all eight statuses — every task lands in exactly one column, none orphaned', async () => {
    const all: TaskSummary[] = [
      taskAt('ingested', 'a'),
      taskAt('routable', 'b'),
      taskAt('needs_attention', 'c', 'human needed'),
      taskAt('failed', 'd', 'execution failed'),
      taskAt('claimed', 'e'),
      taskAt('executing', 'f'),
      taskAt('in_review', 'g'),
      taskAt('done', 'h'),
    ];
    stubFetch({ '/api/tasks': { body: all } });
    const r = await loadMonitoring();
    expect(r.kind).toBe('ok');
    // Every one of the eight tasks is rendered (none dropped by the status→column map).
    for (const t of all) {
      expect(htmlOf(r)).toContain(`roadhero/agentic-playground#${t.id}`);
    }
    // Column counts: Backlog 2, Blocked 2, In Progress 2, PR Opened 1, Completed 1.
    const counts = (htmlOf(r).match(/class="moncol-ct">(\d+)</g) ?? []).map((m) => Number(m.match(/(\d+)/)![1]));
    expect(counts).toEqual([2, 2, 2, 1, 1]);
  });

  it('names the active project in the board scope indicator (slice Project-B)', async () => {
    stubFetch({
      '/api/tasks': { body: [TASK_LRU] },
      '/api/projects': { body: { projects: [{ id: 'p1', name: 'billing', repoRef: 'acme/billing' }], activeProjectId: 'p1' } },
    });
    const r = await loadMonitoring();
    expect(htmlOf(r)).toContain('class="scope-tag">billing');
  });

  it('renders an honest empty pipeline', async () => {
    stubFetch({ '/api/tasks': { body: [] } });
    const r = await loadMonitoring();
    expect(r.kind).toBe('empty');
    expect(htmlOf(r)).toContain('No tasks yet');
  });
});

describe('task inspector — the agent-authored PR actually shows', () => {
  it('renders the routing decision and links the real merged PR', async () => {
    withId('task-lru');
    stubFetch({ '/api/tasks/task-lru': { body: TASK_LRU_DETAIL } });
    const r = await loadTask();
    expect(r.kind).toBe('ok');
    // routing decision: winner + candidate score
    expect(htmlOf(r)).toContain('Routing decision');
    expect(htmlOf(r)).toContain('agent-elvis');
    expect(htmlOf(r)).toContain('0.92');
    // the real agent-authored PR (#8) renders with its state
    expect(htmlOf(r)).toContain('github.com/roadhero/agentic-playground/pull/8');
    expect(htmlOf(r)).toContain('merged');
  });

  it('is an honest empty when no task is selected', async () => {
    vi.stubGlobal('location', { search: '' });
    const r = await loadTask();
    expect(r.kind).toBe('empty');
    expect(htmlOf(r)).toContain('No task selected');
  });

  it('an EXECUTING task renders LIVE Interrupt + Reassign controls (the cancel-coupled actions)', async () => {
    withId('task-exec');
    stubFetch({ '/api/tasks/task-exec': { body: TASK_EXECUTING_DETAIL } });
    const html = htmlOf(await loadTask());
    expect(html).toContain('data-action="interrupt"');
    expect(html).toContain('data-action="reassign"');
    expect(html).toContain('live-ctl'); // Interrupt + Reassign are live (not disabled) controls
    // (Escalate stays read-only — out of this slice's scope — so data-ro is still present for it.)
  });

  it('a DONE task offers no Interrupt and only a disabled Reassign (nothing live to act on)', async () => {
    withId('task-lru');
    stubFetch({ '/api/tasks/task-lru': { body: TASK_LRU_DETAIL } });
    const html = htmlOf(await loadTask());
    expect(html).not.toContain('data-action="interrupt"');
    expect(html).not.toContain('data-action="reassign"'); // Reassign is read-only (roControl) on a done task
    expect(html).toContain('data-ro'); // the disabled Reassign control
  });

  it('a needs_attention task surfaces the honest reason (e.g. no execution capacity), not a silent stall', async () => {
    withId('task-nocap');
    stubFetch({ '/api/tasks/task-nocap': { body: TASK_NO_CAPACITY_DETAIL } });
    const html = htmlOf(await loadTask());
    expect(html).toContain('Needs attention');
    expect(html).toContain('no execution capacity'); // the reason is visible + actionable
  });
});

describe('describeTaskOutcome — the three cancel truths reach the user distinctly (never a lie)', () => {
  it('too_late says the agent already finished, NOT "interrupted"', () => {
    const msg = describeTaskOutcome({ kind: 'conflict', data: { error: 'x', code: 'too_late' } });
    expect(msg).toContain('already finished');
    expect(msg.toLowerCase()).not.toContain('interrupt');
  });
  it('no_inflight explains the in-process limitation distinctly', () => {
    const msg = describeTaskOutcome({ kind: 'conflict', data: { error: 'x', code: 'no_inflight' } });
    expect(msg).toContain('in-process');
  });
  it('a generic conflict is distinct from both', () => {
    const msg = describeTaskOutcome({ kind: 'conflict', data: { error: 'x', code: 'conflict' } });
    expect(msg).toContain('current state');
    expect(msg).not.toContain('already finished');
    expect(msg).not.toContain('in-process');
  });
  it('falls back to the generic describer for non-conflict failures', () => {
    expect(describeTaskOutcome({ kind: 'notfound' })).toMatch(/no longer exists|not found/i);
  });
});

describe('agent detail — bindings, recent work, live + read-only controls', () => {
  it('renders the binding, recent tasks, a LIVE pause control, and a gated Deploy', async () => {
    withId('agent-elvis');
    stubFetch({ '/api/agents/agent-elvis': { body: AGENT_ELVIS_DETAIL } });
    const r = await loadAgent();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('tasca-elvis'); // github binding handle
    expect(htmlOf(r)).toContain('roadhero/agentic-playground#5'); // recent work
    // Pause is now a LIVE control carrying the optimistic-concurrency version.
    expect(htmlOf(r)).toContain('class="ictl live-ctl"');
    expect(htmlOf(r)).toContain('data-action="pause"');
    expect(htmlOf(r)).toContain('data-version="0"');
    expect(htmlOf(r)).toContain('Agent provisioning is operator-run today'); // Deploy still gated
    expect(htmlOf(r)).not.toContain('Coming soon');
  });

  it('a paused agent shows a Paused chip and a Resume control (status is visible)', async () => {
    withId('agent-elvis');
    stubFetch({ '/api/agents/agent-elvis': { body: { ...AGENT_ELVIS_DETAIL, status: 'paused', version: 3 } } });
    const r = await loadAgent();
    expect(htmlOf(r)).toContain('status-chip paused');
    expect(htmlOf(r)).toContain('data-action="resume"');
    expect(htmlOf(r)).toContain('data-version="3"');
  });
});

describe('connections', () => {
  it('renders real per-platform health + 24h webhook counters', async () => {
    stubFetch({ '/api/connections': { body: CONNECTIONS_OK } });
    const r = await loadConnections();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('GitHub');
    expect(htmlOf(r)).toContain('Healthy');
    expect(htmlOf(r)).toContain('12 received');
    expect(htmlOf(r)).toContain('data-ro="gated"'); // Manage / Repair = operator setup
    expect(htmlOf(r)).not.toContain('Coming soon');
  });
});

describe('onboarding read presentation', () => {
  it('reflects real connection state; Shortcut/Linear stay gated, Continue is a live nav', async () => {
    // Only /api/connections stubbed → /api/orgs 404 → canManage=false (non-admin view).
    stubFetch({ '/api/connections': { body: CONNECTIONS_OK } });
    const r = await loadOnboarding();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('Connected · roadhero'); // github already connected
    expect(htmlOf(r)).toContain('data-ro="gated"'); // Connect (shortcut/linear) still gated
    expect(htmlOf(r)).toContain('data-act="continue"'); // Continue is a live navigation for everyone
    expect(htmlOf(r)).not.toContain('Coming soon');
  });
});

describe('W4-S3 self-serve controls — admin-gated wiring (server stays the authority)', () => {
  const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };
  const MEMBER_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'member', active: true }] };

  it('roster (admin): an un-hired agent shows a LIVE Hire control', async () => {
    stubFetch({ '/api/agents': { body: [AGENT_ELVIS] }, '/api/orgs': { body: ADMIN_ORGS }, '/api/orgs/agents': { body: { agents: [] } } });
    const r = await loadRoster();
    expect(htmlOf(r)).toContain('data-act="hire"');
    expect(htmlOf(r)).toContain('data-agent-id="agent-elvis"');
  });

  it('roster (admin): a hired agent shows Unhire', async () => {
    stubFetch({
      '/api/agents': { body: [AGENT_ELVIS] },
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/agents': { body: { agents: [{ agentId: 'agent-elvis', name: 'Elvis', status: 'active' }] } },
    });
    const r = await loadRoster();
    expect(htmlOf(r)).toContain('data-act="unhire"');
  });

  it('roster (non-admin): the hire control is DISABLED with an honest reason, never a live button', async () => {
    stubFetch({ '/api/agents': { body: [AGENT_ELVIS] }, '/api/orgs': { body: MEMBER_ORGS }, '/api/orgs/agents': { body: { agents: [] } } });
    const r = await loadRoster();
    expect(htmlOf(r)).not.toContain('data-act="hire"');
    expect(htmlOf(r)).toContain('Admin role required to manage the roster');
  });

  it('connections (admin): a LIVE Connect GitHub control', async () => {
    stubFetch({ '/api/connections': { body: CONNECTIONS_OK }, '/api/orgs': { body: ADMIN_ORGS } });
    expect(htmlOf(await loadConnections())).toContain('data-act="connect-github"');
  });

  it('connections (non-admin): Connect is disabled with an honest reason', async () => {
    stubFetch({ '/api/connections': { body: CONNECTIONS_OK }, '/api/orgs': { body: MEMBER_ORGS } });
    const r = await loadConnections();
    expect(htmlOf(r)).not.toContain('data-act="connect-github"');
    expect(htmlOf(r)).toContain('Admin role required to connect a workspace');
  });

  it('onboarding (admin): GitHub Connect is live when github is not yet connected', async () => {
    stubFetch({ '/api/connections': { body: { platforms: [] } }, '/api/orgs': { body: ADMIN_ORGS } });
    expect(htmlOf(await loadOnboarding())).toContain('data-act="connect-github"');
  });
});

describe('settings — vendor keys + credential audit (slice 3.5-A.2c.2)', () => {
  const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };
  const MEMBER_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'member', active: true }] };
  // The Workspace panel (3.5-B.2) now also fetches these; stub them so it renders cleanly.
  const WS = {
    '/api/auth/me': { body: SESSION_OK },
    '/api/org': { body: ORG_INFO_OWNER },
    '/api/orgs/members': { body: MEMBERS_OK },
  };

  it('admin + a configured key: Active badge, fingerprint, Replace + Remove, and the audit events', async () => {
    stubFetch({
      ...WS,
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
      '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('Anthropic');
    expect(html).toContain('Active');
    expect(html).toContain('key ••••1a2b'); // fingerprint, never a key
    expect(html).toContain('data-act="vk-edit"'); // Replace key
    expect(html).toContain('Replace key');
    expect(html).toContain('data-act="vk-remove"'); // Remove
    // audit panel renders the events as verbs (Set / Removed), newest first
    expect(html).toContain('Audit log');
    expect(html).toContain('Set');
    expect(html).toContain('Removed');
    // the Workspace panel is live; Billing stays a Planned row
    expect(html).toContain('Workspace');
    expect(html).toContain('Planned');
    expect(html).not.toContain('Coming soon');
  });

  it('admin + no key: Not configured + a Set key control; audit empty state', async () => {
    stubFetch({
      ...WS,
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_EMPTY },
      '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_EMPTY },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('Not configured');
    expect(html).toContain('Set key');
    expect(html).toContain('data-act="vk-edit"');
    expect(html).not.toContain('data-act="vk-remove"'); // nothing to remove
    expect(html).toContain('No credential changes yet'); // audit empty state
  });

  it('non-admin: read-only status + the gated control, NO password input, NO audit panel/fetch', async () => {
    const routes: Record<string, { status?: number; body?: unknown }> = {
      ...WS,
      '/api/org': { body: ORG_INFO_MEMBER },
      '/api/orgs': { body: MEMBER_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
      // deliberately NO /api/orgs/credentials/audit route → a fetch would 404 here / 403 in prod
    };
    stubFetch(routes);
    const html = htmlOf(await loadSettings());
    expect(html).toContain('Active'); // status is still visible read-only
    expect(html).toContain('Vendor keys are managed by an admin'); // gated reason
    expect(html).toContain('data-ro'); // disabled gated control
    expect(html).not.toContain('type="password"'); // no form for a non-admin
    expect(html).not.toContain('data-act="vk-edit"');
    expect(html).not.toContain('Audit log'); // admin-only panel absent
  });

  it('a vendor-read error renders an honest error block, the rest of settings still renders', async () => {
    stubFetch({
      ...WS,
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/credentials': { status: 500, body: {} },
      '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_EMPTY },
    });
    const r = await loadSettings();
    expect(r.kind).toBe('ok'); // the page itself still renders
    const html = htmlOf(r);
    expect(html).toContain('Could not load vendor keys');
    expect(html).toContain('Workspace'); // the workspace panel is unaffected
  });

  it('SECURITY: no audit event payload ever renders a raw key', async () => {
    stubFetch({
      ...WS,
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
      '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
    });
    const html = htmlOf(await loadSettings());
    expect(html).not.toContain('sk-ant'); // fixtures carry only fingerprints, asserted
  });
});

describe('settings — Workspace panel (slice 3.5-B.2: name + members/roles)', () => {
  const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };
  const MEMBER_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'member', active: true }] };
  const VENDOR = {
    '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
    '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
  };

  it('owner: the workspace name + a live Rename, role <select>s, Remove controls, and the (you) marker', async () => {
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK }, // caller is u1
      '/api/org': { body: ORG_INFO_OWNER },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('Roadhero'); // the workspace name
    expect(html).toContain('data-act="ws-name-edit"'); // live Rename (admin+)
    // role badges carry a TEXT label (not color-only)
    expect(html).toContain('>Owner<');
    expect(html).toContain('>Admin<');
    expect(html).toContain('>Member<');
    // owner gets per-member role + remove controls
    expect(html).toContain('data-act="ws-role"');
    expect(html).toContain('data-act="ws-remove"');
    // the caller's own row is marked
    expect(html).toContain('(you)');
    expect(html).not.toContain('Coming soon');
  });

  it('sole owner (issue 316): own role <select> + Remove are disabled, with a hint to promote another owner first', async () => {
    // MEMBERS_OK has exactly one owner (u1) — the lockout-prone case.
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK }, // caller is u1, the only owner
      '/api/org': { body: ORG_INFO_OWNER },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
    });
    const html = htmlOf(await loadSettings());
    // u1's own controls are present but disabled (server refuses with 409 last_owner; don't offer the doomed action)
    expect(html).toMatch(/data-act="ws-role" data-user-id="u1" disabled/);
    expect(html).toMatch(/data-act="ws-remove" data-user-id="u1" disabled/);
    expect(html).toContain('promote another owner before changing this role or removing this member');
    // the disabled-reason is programmatically associated (not title-only): aria-describedby → the hint id
    expect(html).toContain('aria-describedby="ws-hint-u1"');
    expect(html).toContain('id="ws-hint-u1"');
    // the other members (not owners) keep enabled controls
    expect(html).toMatch(/data-act="ws-role" data-user-id="u2" aria-label/);
  });

  it('two owners (issue 316): the lock lifts — no member is the last owner, controls enabled, no hint', async () => {
    const TWO_OWNERS = {
      members: [
        { userId: 'u1', email: 'denny@tasca.dev', displayName: 'Denny', role: 'owner' },
        { userId: 'u2', email: 'mona@tasca.dev', displayName: 'Mona', role: 'owner' },
        { userId: 'u3', email: 'qwen@tasca.dev', displayName: null, role: 'member' },
      ],
    };
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: ORG_INFO_OWNER },
      '/api/orgs/members': { body: TWO_OWNERS },
      '/api/orgs': { body: ADMIN_ORGS },
    });
    const html = htmlOf(await loadSettings());
    expect(html).not.toContain('promote another owner before changing this role');
    expect(html).not.toMatch(/data-user-id="u1" disabled/);
    expect(html).not.toMatch(/data-user-id="u2" disabled/);
  });

  it('admin (not owner): can Rename, but the member list is read-only (badges, no role/remove controls)', async () => {
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: { id: 'org_default', name: 'Roadhero', role: 'admin' } },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('data-act="ws-name-edit"'); // admin+ can rename
    expect(html).toContain('>Owner<'); // badges still render
    expect(html).not.toContain('data-act="ws-role"'); // role change is owner-only
    expect(html).not.toContain('data-act="ws-remove"');
  });

  it('member: read-only name (gated Rename) + read-only member badges', async () => {
    stubFetch({
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: ORG_INFO_MEMBER },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: MEMBER_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('Roadhero');
    expect(html).toContain('Workspace settings are managed by an admin'); // gated Rename
    expect(html).not.toContain('data-act="ws-name-edit"');
    expect(html).not.toContain('data-act="ws-role"');
    expect(html).not.toContain('data-act="ws-remove"');
    expect(html).toContain('>Member<'); // badges still visible
  });

  it('an org-info read error renders an honest error block; the rest of settings still renders', async () => {
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { status: 500, body: {} },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
    });
    const r = await loadSettings();
    expect(r.kind).toBe('ok');
    const html = htmlOf(r);
    expect(html).toContain('Could not load the workspace');
    expect(html).toContain('Vendor keys'); // the rest of settings unaffected
  });
});

describe('settings — Invites section (slice 3.5-B.3.2: invite by email + role)', () => {
  const ADMIN_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'owner', active: true }] };
  const MEMBER_ORGS = { orgs: [{ id: 'o1', name: 'A', role: 'member', active: true }] };
  const VENDOR = {
    '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
    '/api/orgs/credentials/audit': { body: CREDENTIAL_AUDIT_OK },
  };

  it('owner: the invite form + pending list render; the role <select> offers all 3 roles (≤ owner)', async () => {
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: ORG_INFO_OWNER },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/invites': { body: INVITES_OK },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('Invites'); // the section heading
    expect(html).toContain('data-inv-form'); // the invite form
    expect(html).toContain('type="email"'); // email input
    expect(html).toContain('data-act="inv-send"');
    // owner (rank 4) sees Owner/Admin/Member — exactly the three managed roles
    expect(html).toContain('<option value="owner">Owner</option>');
    expect(html).toContain('<option value="admin">Admin</option>');
    expect(html).toContain('<option value="member">Member</option>');
    // the pending list renders each invited email + a revoke control
    expect(html).toContain('newbie@tasca.dev');
    expect(html).toContain('lead@tasca.dev');
    expect(html).toContain('data-act="inv-revoke"');
    expect(html).toContain('expires in'); // honest expiry label
  });

  it('admin (not owner): the role <select> offers only Admin/Member (≤ admin, NOT Owner)', async () => {
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: { id: 'org_default', name: 'Roadhero', role: 'admin' } },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/invites': { body: INVITES_EMPTY },
    });
    const html = htmlOf(await loadSettings());
    expect(html).toContain('data-inv-form');
    expect(html).toContain('<option value="admin">Admin</option>');
    expect(html).toContain('<option value="member">Member</option>');
    expect(html).not.toContain('<option value="owner">Owner</option>'); // can't invite above own role
    expect(html).toContain('No pending invites'); // empty state
  });

  it('non-admin (member): NO invite section, NO invites fetch', async () => {
    stubFetch({
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: ORG_INFO_MEMBER },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: MEMBER_ORGS },
      '/api/orgs/credentials': { body: VENDOR_CREDS_ACTIVE },
      // deliberately NO /api/invites route → a member fetch would 404 here / 403 in prod
    });
    const html = htmlOf(await loadSettings());
    expect(html).not.toContain('data-inv-form'); // the section is admin-gated
    expect(html).not.toContain('data-act="inv-send"');
    expect(html).not.toContain('>Invites<'); // no heading for a non-admin
  });

  it('an invites read error renders an honest inline error; the rest of settings still renders', async () => {
    stubFetch({
      ...VENDOR,
      '/api/auth/me': { body: SESSION_OK },
      '/api/org': { body: ORG_INFO_OWNER },
      '/api/orgs/members': { body: MEMBERS_OK },
      '/api/orgs': { body: ADMIN_ORGS },
      '/api/invites': { status: 500, body: {} },
    });
    const r = await loadSettings();
    expect(r.kind).toBe('ok'); // the page still renders
    const html = htmlOf(r);
    expect(html).toContain('Could not load invites');
    expect(html).toContain('Vendor keys'); // the rest of settings unaffected
  });
});

describe('pm-assistant (W3-S1)', () => {
  it('renders the advisory OFF-state when the server flag is off — generation NOT offered', async () => {
    stubFetch({ '/api/proposals': { body: { proposals: [], enabled: false } } });
    const r = await loadPmAssistant();
    expect(r.kind).toBe('ok');
    const html = htmlOf(r);
    expect(html).toContain('A PM assistant that only suggests');
    expect(html).toContain('Advisory · off by default');
    expect(html).toContain('How it stays advisory');
    expect(html).toContain('data-ro="gated"'); // "Turn on" is operator-gated, not a user toggle
    expect(html).not.toContain('data-action="generate"'); // no generation surface when off
    expect(html).not.toContain('Coming soon');
  });

  it('renders pending ROUTING suggestions with Accept/Dismiss and the not-applied badge', async () => {
    stubFetch({
      '/api/proposals': {
        body: {
          enabled: true,
          proposals: [
            {
              id: 'p1', kind: 'routing', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
              createdAt: '2026-01-01T00:00:00Z',
              payload: { agentName: 'Mona', why: 'best fit for a medium auth task', confidence: 0.78 },
            },
          ],
        },
      },
      '/api/tasks': { body: [] },
    });
    const r = await loadPmAssistant();
    const html = htmlOf(r);
    expect(html).toContain('Route to <b>Mona</b>');
    expect(html).toContain('best fit for a medium auth task');
    expect(html).toContain('confidence 78%');
    expect(html).toContain('Suggestion · not applied'); // advisory framing, structural
    expect(html).toContain('data-action="accept"');
    expect(html).toContain('data-action="dismiss"');
  });

  it('defensively clamps an out-of-range confidence (a malformed payload renders, never breaks)', async () => {
    stubFetch({
      '/api/proposals': {
        body: {
          enabled: true,
          proposals: [
            { id: 'p2', kind: 'routing', targetTaskId: null, targetVersion: null, status: 'pending', version: 0,
              createdAt: '2026-01-01T00:00:00Z', payload: { agentName: 'Mona', why: 'x', confidence: 2.5 } },
          ],
        },
      },
      '/api/tasks': { body: [] },
    });
    const html = htmlOf(await loadPmAssistant());
    expect(html).toContain('confidence 100%'); // clamped, not "250%"
  });

  it('on-state with no suggestions offers on-demand triage + routing over open tasks', async () => {
    stubFetch({
      '/api/proposals': { body: { enabled: true, proposals: [] } },
      '/api/tasks': {
        body: [
          { id: 't9', externalStoryId: 'acme/api#9', platform: 'github', status: 'routable', tierEstimate: 'hard', repoRef: 'acme/api', claimedBy: null, failureCount: 0 },
          { id: 't10', externalStoryId: 'acme/api#10', platform: 'github', status: 'routable', tierEstimate: null, repoRef: 'acme/api', claimedBy: null, failureCount: 0 },
        ],
      },
    });
    const html = htmlOf(await loadPmAssistant());
    expect(html).toContain('No suggestions yet');
    expect(html).toContain('Generate a suggestion');
    expect(html).toContain('data-kind="triage"'); // triage offered on every open task
    expect(html).toContain('data-kind="routing"'); // routing offered on the estimated task (t9)
    // t10 has no estimate → triage yes, route no; t9 has both
    expect((html.match(/data-kind="triage"/g) || []).length).toBe(2);
    expect((html.match(/data-kind="routing"/g) || []).length).toBe(1);
  });

  it('renders a pending DECOMPOSITION suggestion with the child chips and Accept/Dismiss', async () => {
    stubFetch({
      '/api/proposals': {
        body: {
          enabled: true,
          proposals: [
            { id: 'pd', kind: 'decomposition', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
              createdAt: '2026-01-01T00:00:00Z', payload: { children: [{ title: 'schema migration' }, { title: 'recon engine' }], why: 'splits cleanly' } },
          ],
        },
      },
      '/api/tasks': { body: [] },
    });
    const html = htmlOf(await loadPmAssistant());
    expect(html).toContain('Decomposition');
    expect(html).toContain('Split into 2 subtasks');
    expect(html).toContain('schema migration');
    expect(html).toContain('recon engine');
    expect(html).toContain('Suggestion · not applied');
  });

  it('offers a READ-ONLY standup generator (no accept) in the on-state', async () => {
    stubFetch({
      '/api/proposals': { body: { enabled: true, proposals: [] } },
      '/api/tasks': { body: [] },
    });
    const html = htmlOf(await loadPmAssistant());
    expect(html).toContain('Daily standup · read-only');
    expect(html).toContain('data-action="standup"');
    expect(html).toContain('Generate standup');
  });

  it('the generate list offers triage + decompose on every open task', async () => {
    stubFetch({
      '/api/proposals': { body: { enabled: true, proposals: [] } },
      '/api/tasks': { body: [{ id: 't10', externalStoryId: 'acme/api#10', platform: 'github', status: 'routable', tierEstimate: null, repoRef: 'acme/api', claimedBy: null, failureCount: 0 }] },
    });
    const html = htmlOf(await loadPmAssistant());
    expect(html).toContain('data-kind="triage"');
    expect(html).toContain('data-kind="decomposition"');
  });

  it('renders a pending TRIAGE suggestion with the proposed tier and Accept/Dismiss', async () => {
    stubFetch({
      '/api/proposals': {
        body: {
          enabled: true,
          proposals: [
            { id: 'pt', kind: 'triage', targetTaskId: 't1', targetVersion: 3, status: 'pending', version: 0,
              createdAt: '2026-01-01T00:00:00Z', payload: { tier: 'ultra', why: 'mentions 500s under load', confidence: 0.78 } },
          ],
        },
      },
      '/api/tasks': { body: [] },
    });
    const html = htmlOf(await loadPmAssistant());
    expect(html).toContain('Triage');
    expect(html).toContain('mentions 500s under load');
    expect(html).toContain('confidence 78%');
    expect(html).toContain('Suggestion · not applied');
    expect(html).toContain('data-action="accept"');
  });
});
