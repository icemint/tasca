/* TASCA app · data model (representative sample content for the prototype).
   Single source the views read from. Shipped product replaces this with real
   data + honest empty states. */
(function () {
  // tasks (referenced by agents + the routing inspector) ─────────────────────
  const TASKS = {
    'TAS-241': {
      id: 'TAS-241', platform: 'shortcut', title: 'Refactor auth middleware to shared guard',
      repo: 'acme/api', estTier: 4, state: 'working', routedTo: 'nova',
      pr: { number: 4821, ci: 'running', checks: '4 / 6' }, branch: 'tas-241/auth-guard',
      opened: '38m ago',
      why: 'Estimated HARD: touches auth + 3 call-sites, needs migration. Among HARD-eligible agents, Nova ranked highest on TypeScript + auth-domain history.',
      eligible: [
        { id: 'nova',  score: 0.92, note: 'TS + auth history, HARD-capable, free slot' },
        { id: 'mira',  score: 0.81, note: 'TS-capable, no auth-domain history' },
        { id: 'sable', score: 0.74, note: 'HARD/ULTRA-capable but at concurrency limit' },
      ],
      log: [
        ['12:04:02', 'route', 'estimated tier=HARD (confidence 0.86)'],
        ['12:04:02', 'route', 'eligible: nova(0.92) mira(0.81) sable(0.74)'],
        ['12:04:03', 'assign', 'nova ← TAS-241 · slot 1/2'],
        ['12:04:09', 'agent', 'cloned acme/api @ main, branch tas-241/auth-guard'],
        ['12:11:55', 'agent', 'opened PR #4821 · 6 files changed'],
        ['12:12:01', 'ci', 'checks running — 4/6 green'],
      ],
    },
    'TAS-219': {
      id: 'TAS-219', platform: 'linear', title: 'Webhook retry backoff is too aggressive',
      repo: 'acme/edge', estTier: 3, state: 'working', routedTo: 'juno',
      pr: { number: 4830, ci: 'green', checks: '6 / 6' }, branch: 'tas-219/backoff',
      opened: '1h ago', why: 'Estimated MEDIUM. Juno is MEDIUM-capable with edge-runtime history and a free slot.',
      eligible: [{ id: 'juno', score: 0.88, note: 'edge history, free slot' }, { id: 'atlas', score: 0.7, note: 'MEDIUM-capable, idle' }],
      log: [], 
    },
    'BILL-77': {
      id: 'BILL-77', platform: 'shortcut', title: 'Type errors in billing reconciliation',
      repo: 'acme/billing', estTier: 5, state: 'blocked', routedTo: 'sable',
      pr: null, branch: 'bill-77/recon-types', opened: '2h ago',
      why: 'Estimated ULTRA. Sable is the only ULTRA-capable agent with billing-domain history.',
      eligible: [{ id: 'sable', score: 0.79, note: 'ULTRA + billing history' }],
      breaker: 'CI failed 3× on type-check — breaker tripped, awaiting human review or re-tier.',
      log: [], 
    },
    'TAS-205': {
      id: 'TAS-205', platform: 'github', title: 'Add rate-limit guard to public API', repo: 'acme/api',
      estTier: 4, state: 'shipped', routedTo: 'pike', pr: { number: 4807, ci: 'merged', checks: '6 / 6' },
      branch: 'tas-205/ratelimit', opened: '4h ago', why: 'Estimated HARD. Pike shipped 2 similar guards last week.',
      eligible: [{ id: 'pike', score: 0.9, note: 'rate-limit history' }], log: [],
    },
    'TAS-260': {
      id: 'TAS-260', platform: 'shortcut', title: 'Confirm target DB for users migration', repo: 'acme/api',
      estTier: 2, state: 'awaiting', routedTo: 'wren', pr: null, branch: 'tas-260/users-migrate',
      opened: '20m ago', why: 'Estimated LOW. Wren handles routine migrations; flagged a question before destructive step.',
      question: 'Migrate to `users_v2` (new schema) or keep `users` and add columns? This step is destructive.',
      eligible: [{ id: 'wren', score: 0.84, note: 'migration history, LOW-capable, local' }], log: [],
    },
    'TAS-271': {
      id: 'TAS-271', platform: 'linear', title: 'Add pagination to activity feed API', repo: 'acme/api',
      estTier: 3, state: 'queued', routedTo: null, pr: null, branch: null, opened: '6m ago',
      why: 'Estimated MEDIUM. Waiting for a free MEDIUM-capable slot — Juno and Mira are at capacity.',
      eligible: [{ id: 'juno', score: 0.83, note: 'MEDIUM-capable, at concurrency limit' }, { id: 'mira', score: 0.8, note: 'MEDIUM-capable, at concurrency limit' }, { id: 'atlas', score: 0.71, note: 'idle, MEDIUM-capable' }], log: [],
    },
    'TAS-274': {
      id: 'TAS-274', platform: 'github', title: 'Flaky test in checkout suite — quarantine + fix', repo: 'acme/web',
      estTier: 2, state: 'queued', routedTo: null, pr: null, branch: null, opened: '2m ago',
      why: 'Estimated LOW. Queued behind tier-matching — will route to the next free LOW-capable agent.',
      eligible: [{ id: 'echo', score: 0.76, note: 'idle, LOW-capable, local' }, { id: 'atlas', score: 0.72, note: 'idle' }], log: [],
    },
  };

  // agents ───────────────────────────────────────────────────────────────────
  const AGENTS = [
    { id: 'nova', in: 'NV', name: 'Nova', vendor: 'claude', model: 'Sonnet 4.5', state: 'working', minTier: 1, maxTier: 4,
      task: 'TAS-241', tput: 7, succ: 94, cost: '4.20', specialties: ['TypeScript', 'Node', 'Auth', 'Postgres'],
      concurrency: { active: 1, max: 2 }, ceiling: '$20 / day', spent: '21%',
      identities: { shortcut: { handle: 'nova-agent', health: 'ok' }, github: { handle: 'tasca-nova[bot]', health: 'ok' }, linear: { handle: 'Nova', health: 'idle' } },
      hist: [88, 90, 91, 93, 92, 94, 94], shipped: 132, esc: 4, recent: ['TAS-241', 'TAS-205'] },
    { id: 'sable', in: 'SB', name: 'Sable', vendor: 'claude', model: 'Opus 4.1', state: 'blocked', minTier: 3, maxTier: 5,
      task: 'BILL-77', tput: 2, succ: 90, cost: '6.80', specialties: ['TypeScript', 'Billing', 'Distributed', 'Go'],
      concurrency: { active: 2, max: 2 }, ceiling: '$40 / day', spent: '64%',
      identities: { shortcut: { handle: 'sable-agent', health: 'ok' }, github: { handle: 'tasca-sable[bot]', health: 'ok' }, linear: { handle: 'Sable', health: 'ok' } },
      hist: [92, 91, 93, 90, 88, 91, 90], shipped: 78, esc: 9, recent: ['BILL-77'] },
    { id: 'wren', in: 'WR', name: 'Wren', vendor: 'local', model: 'Ollama · llama3.1', state: 'awaiting', minTier: 1, maxTier: 2,
      task: 'TAS-260', tput: 3, succ: 88, cost: '0.00', specialties: ['SQL', 'Migrations', 'Scripts'],
      concurrency: { active: 1, max: 3 }, ceiling: 'local · no cap', spent: '—',
      identities: { shortcut: { handle: 'wren-agent', health: 'ok' }, github: { handle: 'tasca-wren[bot]', health: 'warn' }, linear: { handle: '—', health: 'off' } },
      hist: [80, 83, 85, 84, 86, 87, 88], shipped: 41, esc: 2, recent: ['TAS-260'] },
    { id: 'pike', in: 'PK', name: 'Pike', vendor: 'claude', model: 'Sonnet 4.5', state: 'shipped', minTier: 1, maxTier: 4,
      task: 'TAS-205', tput: 9, succ: 96, cost: '3.40', specialties: ['TypeScript', 'API', 'Security', 'React'],
      concurrency: { active: 0, max: 2 }, ceiling: '$20 / day', spent: '17%',
      identities: { shortcut: { handle: 'pike-agent', health: 'ok' }, github: { handle: 'tasca-pike[bot]', health: 'ok' }, linear: { handle: 'Pike', health: 'ok' } },
      hist: [94, 95, 95, 96, 95, 96, 96], shipped: 164, esc: 3, recent: ['TAS-205'] },
    { id: 'mira', in: 'MR', name: 'Mira', vendor: 'claude', model: 'Sonnet 4.5', state: 'working', minTier: 2, maxTier: 4,
      task: 'TAS-241', tput: 8, succ: 95, cost: '5.10', specialties: ['TypeScript', 'Search', 'React', 'Python'],
      concurrency: { active: 1, max: 2 }, ceiling: '$25 / day', spent: '34%',
      identities: { shortcut: { handle: 'mira-agent', health: 'ok' }, github: { handle: 'tasca-mira[bot]', health: 'ok' }, linear: { handle: 'Mira', health: 'ok' } },
      hist: [90, 92, 93, 94, 94, 95, 95], shipped: 119, esc: 5, recent: ['TAS-241'] },
    { id: 'juno', in: 'JN', name: 'Juno', vendor: 'openai', model: 'GPT-4.1', state: 'working', minTier: 1, maxTier: 3,
      task: 'TAS-219', tput: 6, succ: 92, cost: '2.75', specialties: ['Node', 'Edge', 'Webhooks'],
      concurrency: { active: 1, max: 2 }, ceiling: '$15 / day', spent: '28%',
      identities: { shortcut: { handle: 'juno-agent', health: 'ok' }, github: { handle: 'tasca-juno[bot]', health: 'ok' }, linear: { handle: 'Juno', health: 'ok' } },
      hist: [89, 90, 90, 91, 92, 92, 92], shipped: 96, esc: 6, recent: ['TAS-219'] },
    { id: 'atlas', in: 'AT', name: 'Atlas', vendor: 'openai', model: 'GPT-4.1 mini', state: 'idle', minTier: 1, maxTier: 3,
      task: null, tput: 5, succ: 91, cost: '2.10', specialties: ['Node', 'Docs', 'Refactor'],
      concurrency: { active: 0, max: 2 }, ceiling: '$15 / day', spent: '9%',
      identities: { shortcut: { handle: 'atlas-agent', health: 'ok' }, github: { handle: 'tasca-atlas[bot]', health: 'ok' }, linear: { handle: 'Atlas', health: 'idle' } },
      hist: [88, 89, 90, 90, 91, 91, 91], shipped: 71, esc: 4, recent: [] },
    { id: 'echo', in: 'EC', name: 'Echo', vendor: 'local', model: 'LM Studio · qwen2.5', state: 'idle', minTier: 1, maxTier: 2,
      task: null, tput: 1, succ: 85, cost: '0.00', specialties: ['Scripts', 'Tests', 'Docs'],
      concurrency: { active: 0, max: 3 }, ceiling: 'local · no cap', spent: '—',
      identities: { shortcut: { handle: 'echo-agent', health: 'ok' }, github: { handle: 'tasca-echo[bot]', health: 'ok' }, linear: { handle: '—', health: 'off' } },
      hist: [82, 83, 84, 84, 85, 85, 85], shipped: 33, esc: 1, recent: [] },
  ];

  const byId = Object.fromEntries(AGENTS.map(a => [a.id, a]));

  // ── connections (platform integrations + vendor/key credentials) ──────────
  // health derives partly from agents' identity bindings; GitHub is degraded
  // because Wren's install webhook is failing (see agent.identities.github.warn).
  const CONNECTIONS = {
    platforms: {
      shortcut: { kind: 'platform', label: 'Shortcut', identityModel: 'Agent user', status: 'connected',
        webhook: { state: 'ok', last: '8s ago', rate: '100% · 1.2k/24h' }, token: { state: 'ok', label: 'API token', detail: 'valid · rotated 12d ago' },
        scope: 'Workspace: Acme Robotics', connected: '3 months ago' },
      github: { kind: 'platform', label: 'GitHub', identityModel: 'GitHub App', status: 'degraded',
        webhook: { state: 'warn', last: '14m ago', rate: '82% · 6 failed/24h' }, token: { state: 'ok', label: 'App install', detail: 'installed · 4 repos' },
        scope: 'acme/api, acme/edge, acme/billing, acme/web', connected: '3 months ago',
        issue: { kind: 'webhook', title: 'Webhook deliveries failing', detail: 'GitHub returned 410 Gone on 6 of the last 33 push events. The endpoint may have been removed or the App secret rotated. Re-delivering and re-validating the endpoint usually clears this.', action: 'Repair webhook', affected: ['wren'] } },
      linear: { kind: 'platform', label: 'Linear', identityModel: 'Actor = app', status: 'connected',
        webhook: { state: 'ok', last: '41s ago', rate: '100% · 380/24h' }, token: { state: 'ok', label: 'OAuth actor', detail: 'app actor · valid' },
        scope: 'Team: Engineering', connected: '2 months ago' },
    },
    vendors: {
      anthropic: { kind: 'vendor', vendor: 'claude', label: 'Anthropic', status: 'connected',
        cred: { label: 'API key', detail: 'sk-ant-…7f2a · valid', state: 'ok' }, usage: '$18.40 today · across 4 agents', connected: '3 months ago' },
      openai: { kind: 'vendor', vendor: 'openai', label: 'OpenAI', status: 'degraded',
        cred: { label: 'API key', detail: 'sk-…9c1b · rate-limited', state: 'warn' }, usage: '$4.85 today · across 2 agents', connected: '2 months ago',
        issue: { kind: 'token', title: 'Hitting rate limits', detail: 'OpenAI returned 429 on 11% of requests in the last hour. Your tier 2 quota may be exhausted, or several agents are bursting at once. Raise the org limit or stagger concurrency.', action: 'Manage key & limits' } },
      local: { kind: 'vendor', vendor: 'local', label: 'Local endpoints', status: 'connected',
        cred: { label: '2 runtimes', detail: 'Ollama · LM Studio', state: 'ok' }, usage: '$0.00 · 2 agents · on-device', connected: '6 weeks ago',
        endpoints: [ { rt: 'Ollama', url: 'localhost:11434', state: 'ok' }, { rt: 'LM Studio', url: 'localhost:1234', state: 'ok' }, { rt: 'MLX', url: 'not configured', state: 'off' } ] },
    },
  };
  // agents deployed through a given platform (health-aware), via identity bindings
  function agentsOnPlatform(plat) { return AGENTS.filter(a => a.identities[plat] && a.identities[plat].health !== 'off'); }
  function agentsOnVendor(v) { return AGENTS.filter(a => (v === 'local' ? a.vendor === 'local' : a.vendor === v)); }

  window.DATA = { AGENTS, TASKS, CONNECTIONS, agent: (id) => byId[id], agentsOnPlatform, agentsOnVendor,
    TIER_NAMES: ['', 'BASIC', 'LOW', 'MEDIUM', 'HARD', 'ULTRA'] };
})();
