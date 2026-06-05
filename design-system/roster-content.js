/* TASCA · Roster exploration — content builders (plain JS, no JSX).
   Exposes window.RC: shared component helpers + the three roster layouts +
   real empty/loading/error states. Every class comes from roster.css/tasca.css;
   theming is done by the wrapping [data-theme] artboard, so each builder is
   theme-agnostic and rendered once per theme.
   NOTE: agent records below are *representative sample* content for the design
   comp — the shipped product renders real data or the honest empty state. */
(function () {
  // ── icon glyphs ─────────────────────────────────────────────────────────
  const I = {
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>',
    bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 6a3 3 0 016 0c0 3 1.2 4 1.2 4H3.8S5 9 5 6Z" stroke-linejoin="round"/><path d="M6.6 13a1.6 1.6 0 002.8 0" stroke-linecap="round"/></svg>',
    theme: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="4"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>',
    kebab: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="12.5" r="1.4"/></svg>',
    roster: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
    monitor: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11h3l2-6 3 12 2-7 1.5 4H18"/></svg>',
    plug: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 01-10 0V7ZM10 14v3"/></svg>',
    gear: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg>',
    spark: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6Z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M8 4l4 4-4 4"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="5" width="7" height="7" rx="1.5"/><rect x="13" y="5" width="7" height="7" rx="1.5"/><rect x="4" y="14" width="7" height="6" rx="1.5" stroke-dasharray="2 2"/><rect x="13" y="14" width="7" height="6" rx="1.5" stroke-dasharray="2 2"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 7v6M12 16.5v.5"/><path d="M12 3.5l8.5 15h-17l8.5-15Z" stroke-linejoin="round"/></svg>',
  };

  // ── state glyphs (distinct SHAPE per state — colour-blind safe) ──────────
  const SG = {
    idle:     '<svg class="g" viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="3.7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    working:  '<svg class="g" viewBox="0 0 11 11"><circle class="pulse" cx="5.5" cy="5.5" r="3.4" fill="currentColor"/></svg>',
    awaiting: '<svg class="g" viewBox="0 0 11 11"><path d="M5.5 1.2 10 9.6H1Z" fill="currentColor"/></svg>',
    blocked:  '<svg class="g" viewBox="0 0 11 11"><rect x="1.4" y="1.4" width="8.2" height="8.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.4 3.4l4.2 4.2" stroke="currentColor" stroke-width="1.5"/></svg>',
    shipped:  '<svg class="g" viewBox="0 0 11 11"><path d="M1.6 5.7 4.3 8.5 9.4 2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const STATE_LABEL = { idle: 'Idle', working: 'Working', awaiting: 'Awaiting input', blocked: 'Blocked', shipped: 'Shipped' };

  // ── vendor glyphs (shape-coded, monochrome — no brand colour) ────────────
  const VG = {
    claude: '<svg viewBox="0 0 11 11"><path d="M5.5 1 10 5.5 5.5 10 1 5.5Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    openai: '<svg viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/></svg>',
    local:  '<svg viewBox="0 0 11 11"><rect x="1.4" y="1.7" width="8.2" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.3 4.1 4.7 5.5 3.3 6.9M5.8 6.9H7.7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  };
  const VENDOR_LABEL = { claude: 'Claude', openai: 'OpenAI', local: 'Local' };

  // ── representative sample roster ─────────────────────────────────────────
  const AGENTS = [
    { in: 'NV', name: 'Nova',  vendor: 'claude', model: 'Sonnet 4.5',      state: 'working',  maxTier: 4, task: 'PR #4821 · refactor auth middleware', tput: 7, succ: 94, cost: '4.20' },
    { in: 'SB', name: 'Sable', vendor: 'claude', model: 'Opus 4.1',        state: 'blocked',  maxTier: 5, task: 'CI failing · type errors in billing', tput: 2, succ: 90, cost: '6.80' },
    { in: 'WR', name: 'Wren',  vendor: 'local',  model: 'Ollama · llama3', state: 'awaiting', maxTier: 2, task: 'Q: confirm migration target DB', tput: 3, succ: 88, cost: '0.00' },
    { in: 'PK', name: 'Pike',  vendor: 'claude', model: 'Sonnet 4.5',      state: 'shipped',  maxTier: 4, task: 'Merged #4807 · rate-limit guard', tput: 9, succ: 96, cost: '3.40' },
    { in: 'MR', name: 'Mira',  vendor: 'claude', model: 'Sonnet 4.5',      state: 'working',  maxTier: 4, task: 'PR #4830 · search indexer', tput: 8, succ: 95, cost: '5.10' },
    { in: 'JN', name: 'Juno',  vendor: 'openai', model: 'GPT-4.1',         state: 'working',  maxTier: 3, task: 'TAS-219 · webhook retry backoff', tput: 6, succ: 92, cost: '2.75' },
    { in: 'AT', name: 'Atlas', vendor: 'openai', model: 'GPT-4.1 mini',    state: 'idle',     maxTier: 3, task: null, tput: 5, succ: 91, cost: '2.10' },
    { in: 'EC', name: 'Echo',  vendor: 'local',  model: 'LM Studio · qwen',state: 'idle',     maxTier: 2, task: null, tput: 1, succ: 85, cost: '0.00' },
  ];
  const TIER_NAMES = ['', 'BASIC', 'LOW', 'MEDIUM', 'HARD', 'ULTRA'];

  // ── component helpers ─────────────────────────────────────────────────────
  const av = (a, size) => `<div class="${size} ${a.vendor === 'local' ? 'local' : ''}" aria-hidden="true">${a.in}</div>`;
  const vendorChip = (a) => `<span class="vendor">${VG[a.vendor]}${VENDOR_LABEL[a.vendor]}</span>`;
  const statePill = (a, solid) => `<span class="astate astate-${a.state} ${solid ? 'solid' : ''}">${SG[a.state]}${STATE_LABEL[a.state]}</span>`;
  const tierRamp = (a) => {
    let cells = '';
    for (let i = 1; i <= 5; i++) cells += `<i class="${i <= a.maxTier ? 'on t-' + i : ''}"></i>`;
    return `<span class="tierbar"><span class="cells" role="img" aria-label="Capability to ${TIER_NAMES[a.maxTier]} tier">${cells}</span><span class="lab">to <b>${TIER_NAMES[a.maxTier]}</b></span></span>`;
  };
  const taskLine = (a) => a.task
    ? a.task.replace(/(PR #\d+|TAS-\d+|#\d+)/g, '<span class="mono">$1</span>')
    : '';

  // ── shared app chrome ─────────────────────────────────────────────────────
  function topbar() {
    return `<header class="app-topbar">
      <div style="display:flex;align-items:center;gap:18px">
        <span class="brand-word"><span class="a">Tas</span><span class="b">ca</span></span>
        <span class="topbar-ctx">Acme Robotics <span class="sep">/</span> Platform</span>
      </div>
      <div class="topbar-right">
        <button class="icon-btn" title="Search">${I.search}</button>
        <button class="icon-btn" title="Notifications">${I.bell}</button>
        <button class="icon-btn" title="Theme">${I.theme}</button>
        <div class="av-md" style="background:color-mix(in srgb,var(--fg) 12%,transparent);border-color:var(--line-2);color:var(--fg-2);border-radius:50%">DM</div>
      </div>
    </header>`;
  }
  function rail() {
    return `<nav class="app-rail" aria-label="Primary">
      <button class="rail-item is-on" title="Roster">${I.roster}</button>
      <button class="rail-item" title="Monitoring">${I.monitor}</button>
      <button class="rail-item" title="Connections">${I.plug}</button>
      <button class="rail-item" title="PM assistant">${I.spark}</button>
      <div style="flex:1"></div>
      <button class="rail-item" title="Settings">${I.gear}</button>
    </nav>`;
  }
  function healthStrip() {
    const tiles = [
      { k: 'In flight',     v: '4',       g: 'var(--state-working)' },
      { k: 'Awaiting input', v: '1',      g: 'var(--state-awaiting)' },
      { k: 'Blocked',       v: '1',       g: 'var(--state-blocked)' },
      { k: 'Shipped today', v: '12',      g: 'var(--state-shipped)' },
      { k: 'Cost today',    v: '<small>$</small>24.35', g: 'var(--fg-faint)' },
    ];
    return `<div class="health-strip">${tiles.map(t => `
      <div class="hstat"><span class="k"><span class="glyph" style="border-radius:2px;background:${t.g}"></span>${t.k}</span><span class="v">${t.v}</span></div>`).join('')}</div>`;
  }
  function filterbar() {
    return `<div class="filterbar">
      <div class="searchbox">${I.search}<span style="color:var(--fg-faint)">Search agents…</span></div>
      <div class="grp"><span class="fl">State</span>
        <span class="chip is-on">All</span><span class="chip">Working</span><span class="chip">Awaiting</span><span class="chip">Blocked</span></div>
      <div class="grp"><span class="fl">Platform</span>
        <span class="chip">Shortcut</span><span class="chip">GitHub</span><span class="chip">Linear</span></div>
    </div>`;
  }
  const head = (titleRight) => `<div class="roster-head">
      <div><h1>Your team</h1><div class="sub"><b>8</b> agents · <b>6</b> active · <b>92%</b> success this week</div></div>
      <button class="btn-add">${I.plus} Add agent</button>
    </div>`;

  // ════ LAYOUT A · card grid ════════════════════════════════════════════════
  function cardGrid() {
    const card = (a) => `<article class="agentcard">
      <div class="id">${av(a, 'av-lg')}
        <div class="nm"><div class="name">${a.name}</div>
          <div class="meta">${vendorChip(a)}<span style="font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--fg-faint)">${a.model}</span></div>
        </div>${statePill(a)}
      </div>
      <div class="task ${a.task ? '' : 'muted'}">${a.task ? taskLine(a) : 'No active task · available to route'}</div>
      <div class="foot">
        <div class="metricset">
          <div class="metric"><span class="mv">${a.tput}</span><span class="mk">Today</span></div>
          <div class="metric"><span class="mv ${a.succ < 90 ? 'warn' : ''}">${a.succ}%</span><span class="mk">Success</span></div>
          <div class="metric"><span class="mv">$${a.cost}</span><span class="mk">Cost</span></div>
        </div>${tierRamp(a)}
      </div>
    </article>`;
    return shell(`${head()}${healthStrip()}${filterbar()}<div class="agent-grid">${AGENTS.map(card).join('')}</div>`);
  }

  // ════ LAYOUT B · ops-console table ════════════════════════════════════════
  function opsTable() {
    const row = (a) => `<div class="trow">
      <div class="ag">${av(a, 'av-md')}<div class="nm"><div class="name">${a.name}</div><div class="vrow">${vendorChip(a)}</div></div></div>
      <div>${statePill(a)}</div>
      <div class="tk ${a.task ? '' : 'muted'}">${a.task || '—'}</div>
      <div>${tierRamp(a)}</div>
      <div class="num r">${a.tput}</div>
      <div class="num r ${a.succ < 90 ? 'warn' : a.succ >= 95 ? 'good' : ''}">${a.succ}%</div>
      <div class="num r">$${a.cost}</div>
      <div class="r"><button class="kebab-btn" title="Manage">${I.kebab}</button></div>
    </div>`;
    const t = `<div class="optable"><div class="thead">
        <span>Agent</span><span>State</span><span>Current task</span><span>Tiers</span>
        <span class="r">Today</span><span class="r">Success</span><span class="r">Cost</span><span></span>
      </div>${AGENTS.map(row).join('')}</div>`;
    return shell(`${head()}${healthStrip()}${filterbar()}${t}`);
  }

  // ════ LAYOUT C · attention-grouped roster ═════════════════════════════════
  function grouped() {
    const order = [
      { state: 'blocked',  attn: true,  label: 'Blocked', action: { t: 'Intervene', cls: 'amber' } },
      { state: 'awaiting', attn: true,  label: 'Awaiting input', action: { t: 'Respond', cls: 'signal' } },
      { state: 'working',  attn: false, label: 'Working', action: { t: 'View', cls: '' } },
      { state: 'shipped',  attn: false, label: 'Shipped today', action: { t: 'Review PR', cls: '' } },
      { state: 'idle',     attn: false, label: 'Idle · available', action: { t: 'Assign', cls: '' } },
    ];
    const rrow = (a, action) => `<div class="rrow">${av(a, 'av-md')}
      <div class="nm"><div class="name">${a.name}</div><div class="sub">${a.task ? taskLine(a) : 'Available to route'}</div></div>
      ${vendorChip(a)}
      <button class="act ${action.cls}">${action.t}</button>
    </div>`;
    const groups = order.map(g => {
      const list = AGENTS.filter(a => a.state === g.state);
      if (!list.length) return '';
      return `<section class="rgroup ${g.attn ? 'attn' : ''} astate-${g.state}">
        <div class="gh">${statePill({ state: g.state }, true)}<span class="ct">${list.length}</span><span class="line"></span></div>
        <div class="rgroup-list">${list.map(a => rrow(a, g.action)).join('')}</div>
      </section>`;
    }).join('');
    return shell(`${head()}${healthStrip()}<div class="rgroups">${groups}</div>`);
  }

  // ── states ────────────────────────────────────────────────────────────────
  function emptyState() {
    return shell(`${head()}<div class="state-wrap">
      <div class="state-ico">${I.empty}</div>
      <h2>Build your team</h2>
      <p>No agents yet. Hire your first AI employee — give it a name, pick a vendor, set its capability tiers, and deploy it into Shortcut, GitHub, or Linear.</p>
      <div class="state-actions"><button class="btn-add">${I.plus} Hire your first agent</button>
        <button class="rrow act" style="background:var(--surface);border:1px solid var(--line-2);padding:9px 15px">Connect a platform</button></div>
    </div>`);
  }
  function loadingState() {
    const sk = () => `<div class="sk-card"><div class="sk-row"><div class="sk" style="width:42px;height:42px;border-radius:var(--radius-md)"></div>
        <div style="flex:1"><div class="sk" style="width:55%;height:13px"></div><div class="sk" style="width:38%;height:10px;margin-top:7px"></div></div>
        <div class="sk" style="width:70px;height:14px"></div></div>
      <div class="sk" style="width:100%;height:38px;border-radius:8px"></div>
      <div class="sk-row" style="justify-content:space-between"><div class="sk" style="width:130px;height:22px"></div><div class="sk" style="width:90px;height:12px"></div></div></div>`;
    return shell(`${head()}<div class="filterbar" style="opacity:.5;pointer-events:none">${filterbar()}</div>
      <div class="agent-grid" aria-busy="true" aria-label="Loading roster">${Array(6).fill(0).map(sk).join('')}</div>`);
  }
  function errorState() {
    return shell(`${head()}<div class="state-wrap">
      <div class="state-ico err">${I.err}</div>
      <h2>Couldn’t load your roster</h2>
      <p>We reached the routing engine but the roster service didn’t respond. Your agents are unaffected — this is a read error on this view.</p>
      <div class="state-actions"><button class="btn-add" style="background:var(--surface-2);color:var(--fg);border:1px solid var(--line-2)">Retry</button>
        <button class="rrow act" style="background:transparent;border:1px solid var(--line-2);padding:9px 15px;color:var(--fg-3)">View status page</button></div>
      <p style="font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--fg-faint);margin-top:2px">roster.read · 503 · req_8f2a91c</p>
    </div>`);
  }

  // shell wraps content in the full app surface (topbar + rail + main scroll)
  function shell(inner) {
    return `<div class="surface-app">${topbar()}<div class="app-body">${rail()}
      <main class="app-main"><div class="main-scroll">${inner}</div></main></div></div>`;
  }

  window.RC = { I, SG, VG, STATE_LABEL, VENDOR_LABEL, AGENTS, TIER_NAMES,
    av, vendorChip, statePill, tierRamp,
    cardGrid, opsTable, grouped, emptyState, loadingState, errorState };
})();
