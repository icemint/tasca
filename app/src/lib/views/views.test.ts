import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadRoster } from './roster';
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
  htmlOf,
} from '../test-support';

afterEach(() => vi.unstubAllGlobals());

/** Set the ?id= query the detail views read via queryId(). */
function withId(id: string): void {
  vi.stubGlobal('location', { search: `?id=${id}` });
}

describe('roster', () => {
  it('renders real agents and a read-only (gated) Add agent control — no stray "Coming soon"', async () => {
    stubFetch({ '/api/agents': { body: [AGENT_ELVIS] } });
    const r = await loadRoster();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('Elvis');
    expect(htmlOf(r)).toContain('Your team');
    expect(htmlOf(r)).toContain('data-ro="gated"'); // Add agent = provisioning, gated
    expect(htmlOf(r)).toContain('Agent provisioning is operator-run today');
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
});

describe('monitoring', () => {
  it('boards real tasks, surfaces the needs-attention rail, and offers a live Refresh', async () => {
    stubFetch({ '/api/tasks': { body: [TASK_LRU, TASK_RETRY_ATTN] } });
    const r = await loadMonitoring();
    expect(r.kind).toBe('ok');
    // the done LRU task and the needs-attention retry task both show
    expect(htmlOf(r)).toContain('roadhero/agentic-playground#5');
    expect(htmlOf(r)).toContain('roadhero/agentic-playground#6');
    expect(htmlOf(r)).toContain('2 failed attempts');
    // "Live" is honest: a real Refresh re-fetch, not a fake realtime claim
    expect(htmlOf(r)).toContain('data-act="refresh"');
    expect(htmlOf(r)).toContain('data-ro="soon"'); // Re-tier / Escalate
    expect(htmlOf(r)).not.toContain('Coming soon');
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
  it('reflects real connection state and frames setup as a read-only preview', async () => {
    stubFetch({ '/api/connections': { body: CONNECTIONS_OK } });
    const r = await loadOnboarding();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('Connected · roadhero'); // github already connected
    expect(htmlOf(r)).toContain('read-only preview');
    expect(htmlOf(r)).toContain('data-ro="gated"'); // Connect (shortcut/linear) + Continue
    expect(htmlOf(r)).not.toContain('Coming soon');
  });
});

describe('settings', () => {
  it('is an honest deferred shell listing the planned panels', async () => {
    const r = await loadSettings();
    expect(r.kind).toBe('ok');
    expect(htmlOf(r)).toContain('Workspace');
    expect(htmlOf(r)).toContain('Audit log');
    expect(htmlOf(r)).toContain('Planned'); // honest deferred tag, not a stray "Coming soon"
    expect(htmlOf(r)).not.toContain('Coming soon');
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

  it('on-state with no suggestions offers on-demand "Suggest routing" over routable tasks', async () => {
    stubFetch({
      '/api/proposals': { body: { enabled: true, proposals: [] } },
      '/api/tasks': {
        body: [
          { id: 't9', externalStoryId: 'acme/api#9', platform: 'github', status: 'routable', tierEstimate: 'hard', repoRef: 'acme/api', claimedBy: null, failureCount: 0 },
        ],
      },
    });
    const r = await loadPmAssistant();
    const html = htmlOf(r);
    expect(html).toContain('No suggestions yet');
    expect(html).toContain('Generate a routing suggestion');
    expect(html).toContain('data-action="generate"');
    expect(html).toContain('data-task-id="t9"');
  });
});
