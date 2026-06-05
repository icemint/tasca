/* TASCA app · Monitoring — cross-roster "mission control".
   Everything in flight / queued / blocked / awaiting across all agents +
   projects, with throughput, cost burn and escalations. Reads the same DATA
   as Roster + inspector; clicking a task → routing inspector, an agent →
   profile. Includes the calm "quiet day" honest state.
   window.MON.render(ctx)  ·  ctx.quiet toggles the quiet-day state. */
(function () {
  const D = window.DATA, U = window.UI;
  const TASKS = () => Object.values(D.TASKS);

  // ── KPI burn tiles ────────────────────────────────────────────────────────
  function kpis(tasks) {
    const inflight = tasks.filter(t => t.state === 'working').length;
    const queued = tasks.filter(t => t.state === 'queued').length;
    const attn = tasks.filter(t => t.state === 'blocked' || t.state === 'awaiting').length;
    const shipped = tasks.filter(t => t.state === 'shipped').length;
    const cost = D.AGENTS.reduce((s, a) => s + parseFloat(a.cost), 0).toFixed(2);
    const tiles = [
      { k: 'In flight', v: inflight, sub: 'across 3 projects', g: 'var(--state-working)' },
      { k: 'Queued', v: queued, sub: 'awaiting a free slot', g: 'var(--fg-faint)' },
      { k: 'Needs you', v: attn, sub: 'blocked + awaiting', g: 'var(--state-awaiting)' },
      { k: 'Shipped today', v: 12, sub: '+3 vs. yesterday', g: 'var(--state-shipped)' },
      { k: 'Burn today', v: `<small>$</small>${cost}`, sub: 'of $140 ceiling', g: 'var(--signal)' },
    ];
    return `<div class="mon-kpis">${tiles.map(t => `<div class="kpi"><div class="kpi-k"><span class="glyph" style="background:${t.g}"></span>${t.k}</div>
      <div class="kpi-v">${t.v}</div><div class="kpi-s">${t.sub}</div></div>`).join('')}</div>`;
  }

  // ── pipeline columns (kanban-of-state) ────────────────────────────────────
  const COLS = [
    { state: 'queued',   label: 'Queued',         attn: false },
    { state: 'working',  label: 'In flight',      attn: false },
    { state: 'awaiting', label: 'Awaiting input', attn: true },
    { state: 'blocked',  label: 'Blocked',        attn: true },
    { state: 'shipped',  label: 'Shipped today',  attn: false },
  ];

  function taskCard(t) {
    const a = t.routedTo ? D.agent(t.routedTo) : null;
    const ci = t.pr ? `<span class="ci ci-${t.pr.ci}">${t.pr.ci==='green'?'CI ✓':t.pr.ci==='running'?'CI…':t.pr.ci}</span>` : '';
    const agentBit = a
      ? `<button class="mt-agent" data-act="open-agent" data-id="${a.id}" title="${a.name}">${U.av(a,'av-sm')}<span>${a.name}</span></button>`
      : `<span class="mt-agent unrouted"><span class="av-sm ghost">·</span><span>Unrouted</span></span>`;
    return `<div class="montask" data-act="open-task" data-id="${t.id}" role="button" tabindex="0">
      <div class="mt-top"><span class="plat-tag sm">${U.PLATFORM_LABEL[t.platform]}</span>${U.taskRef(t.id)}</div>
      <div class="mt-title">${t.title}</div>
      <div class="mt-foot">${agentBit}<span class="mt-meta">${U.tierTag(t.estTier)}${t.pr?`<span class="prchip">${U.I.pr} #${t.pr.number}</span>`:''}${ci}</span></div>
    </div>`;
  }

  function pipeline(tasks) {
    const cols = COLS.map(c => {
      const list = tasks.filter(t => t.state === c.state);
      const body = list.length
        ? list.map(taskCard).join('')
        : `<div class="col-empty">None</div>`;
      return `<section class="moncol ${c.attn?'attn astate-'+c.state:''}">
        <div class="moncol-h">${U.statePill({ state: c.state }, true)}<span class="moncol-ct">${list.length}</span></div>
        <div class="moncol-body">${body}</div></section>`;
    }).join('');
    return `<div class="monboard">${cols}</div>`;
  }

  // ── escalations rail ──────────────────────────────────────────────────────
  function escalations(tasks) {
    const esc = tasks.filter(t => t.state === 'blocked' || t.state === 'awaiting');
    if (!esc.length) return '';
    const rows = esc.map(t => {
      const a = D.agent(t.routedTo);
      const action = t.state === 'blocked' ? { t: 'Resolve', cls: 'amber' } : { t: 'Answer', cls: 'signal' };
      const reason = t.state === 'blocked' ? (t.breaker || 'Run failed — breaker tripped') : (t.question || 'Needs your input');
      return `<div class="escrow">
        <button class="esc-task" data-act="open-task" data-id="${t.id}">
          ${U.statePill({ state: t.state })}
          <span class="esc-title">${U.taskRef(t.id)} ${t.title}</span></button>
        <span class="esc-reason">${reason}</span>
        <div class="esc-act"><button class="mt-agent sm" data-act="open-agent" data-id="${a.id}">${U.av(a,'av-sm')}<span>${a.name}</span></button>
          <button class="ictl ${action.cls}" data-act="open-task" data-id="${t.id}">${action.t}</button></div></div>`;
    }).join('');
    return `<div class="pcard esc-rail" style="margin-top:22px"><div class="pc-h">Escalations <span class="pc-h-r mono dim">${esc.length} need a human</span></div>${rows}</div>`;
  }

  // ── quiet-day honest state (calm, intentional — NOT broken) ───────────────
  function quietDay() {
    return `<div class="quiet-wrap">
      <div class="quiet-ico">${U.I.monitor}</div>
      <h2>All quiet</h2>
      <p>Nothing needs you right now. <b>2 agents</b> are working, nothing is blocked or awaiting input, and burn is well under ceiling. This is the system running smoothly — not an empty screen.</p>
      <div class="quiet-stats">
        <div class="qs"><div class="qs-v">2</div><div class="qs-k">In flight</div></div>
        <div class="qs sep"><div class="qs-v">0</div><div class="qs-k">Need you</div></div>
        <div class="qs"><div class="qs-v">12</div><div class="qs-k">Shipped today</div></div>
      </div>
      <div class="quiet-hint mono">Live · monitoring 8 agents across 3 projects</div>
    </div>`;
  }

  function render(ctx) {
    const head = `<div class="roster-head">
        <div><h1>Monitoring</h1><div class="sub">Mission control · everything in flight across your team &amp; projects</div></div>
        <div class="mon-headright"><span class="live-dot big">live</span><button class="ictl">Last 24h ${U.I.chevron}</button></div></div>`;
    if (ctx && ctx.quiet) return `${head}${kpis(TASKS().filter(t => t.state !== 'blocked' && t.state !== 'awaiting' && t.state !== 'queued'))}${quietDay()}`;
    const tasks = TASKS();
    return `${head}${kpis(tasks)}${pipeline(tasks)}${escalations(tasks)}`;
  }

  window.MON = { render };
})();
