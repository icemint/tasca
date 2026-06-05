/* TASCA app · Roster home view. window.ROSTER.render(ctx) → html string.
   ctx = { ui (mutable view state), go(view,params) }  — events via data-act. */
(function () {
  const D = window.DATA, U = window.UI;
  const ATTN_RANK = { blocked: 0, awaiting: 1, working: 2, shipped: 3, idle: 4 };

  function visible(ui) {
    let list = D.AGENTS.slice();
    if (ui.stateF !== 'all') list = list.filter(a => a.state === ui.stateF);
    if (ui.platF !== 'all') list = list.filter(a => a.identities[ui.platF] && a.identities[ui.platF].health !== 'off');
    if (ui.q) { const q = ui.q.toLowerCase(); list = list.filter(a => a.name.toLowerCase().includes(q) || a.specialties.join(' ').toLowerCase().includes(q)); }
    if (ui.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else if (ui.sort === 'tput') list.sort((a, b) => b.tput - a.tput);
    else list.sort((a, b) => (ATTN_RANK[a.state] - ATTN_RANK[b.state]) || a.name.localeCompare(b.name)); // auto
    return list;
  }

  const taskCell = (a, cls) => a.task
    ? `<button class="linktask ${cls||''}" data-act="open-task" data-id="${a.task}">${U.taskRef(a.task)} ${U.taskTitle(a.task)}</button>`
    : `<span class="muted">—</span>`;

  function card(a) {
    return `<article class="agentcard">
      <button class="id" data-act="open-agent" data-id="${a.id}">${U.av(a,'av-lg')}
        <div class="nm"><div class="name">${a.name}</div>
          <div class="meta">${U.vendorChip(a)}<span class="mono dim">${a.model}</span></div></div>
        ${U.statePill(a)}</button>
      <div class="task ${a.task?'':'muted'}">${a.task
        ? `<button class="linktask" data-act="open-task" data-id="${a.task}">${U.taskRef(a.task)} ${U.taskTitle(a.task)}</button>`
        : 'No active task · available to route'}</div>
      <div class="foot">
        <div class="metricset">
          <div class="metric"><span class="mv">${a.tput}</span><span class="mk">Today</span></div>
          <div class="metric"><span class="mv ${a.succ<90?'warn':''}">${a.succ}%</span><span class="mk">Success</span></div>
          <div class="metric"><span class="mv">$${a.cost}</span><span class="mk">Cost</span></div>
        </div>${U.tierRamp(a)}</div>
    </article>`;
  }

  function row(a) {
    return `<button class="trow" data-act="open-agent" data-id="${a.id}">
      <div class="ag">${U.av(a,'av-md')}<div class="nm"><div class="name">${a.name}</div><div class="vrow">${U.vendorChip(a)}</div></div></div>
      <div>${U.statePill(a)}</div>
      <div class="tk">${taskCell(a,'tight')}</div>
      <div>${U.tierRamp(a)}</div>
      <div class="num r">${a.tput}</div>
      <div class="num r ${a.succ<90?'warn':a.succ>=95?'good':''}">${a.succ}%</div>
      <div class="num r">$${a.cost}</div>
      <div class="r"><span class="kebab-btn" title="Manage">${U.I.kebab}</span></div>
    </button>`;
  }

  function healthStrip() {
    const c = s => D.AGENTS.filter(a => a.state === s).length;
    const cost = D.AGENTS.reduce((s, a) => s + parseFloat(a.cost), 0).toFixed(2);
    const tiles = [
      { k: 'In flight', v: c('working'), g: 'var(--state-working)' },
      { k: 'Awaiting input', v: c('awaiting'), g: 'var(--state-awaiting)' },
      { k: 'Blocked', v: c('blocked'), g: 'var(--state-blocked)' },
      { k: 'Shipped today', v: 12, g: 'var(--state-shipped)' },
      { k: 'Cost today', v: `<small>$</small>${cost}`, g: 'var(--fg-faint)' },
    ];
    return `<div class="health-strip">${tiles.map(t => `<div class="hstat"><span class="k"><span class="glyph" style="background:${t.g}"></span>${t.k}</span><span class="v">${t.v}</span></div>`).join('')}</div>`;
  }

  const chip = (label, on, act, v) => `<button class="chip ${on?'is-on':''}" data-act="${act}" data-v="${v}">${label}</button>`;

  function toolbar(ui) {
    const states = [['all','All'],['working','Working'],['awaiting','Awaiting'],['blocked','Blocked'],['idle','Idle']];
    const plats = [['all','All'],['shortcut','Shortcut'],['github','GitHub'],['linear','Linear']];
    const sorts = [['auto','Attention'],['name','Name'],['tput','Throughput']];
    return `<div class="toolbar">
      <div class="searchbox"><span class="sico">${U.I.search}</span><input data-act="search" placeholder="Search agents, skills…" value="${ui.q||''}"></div>
      <div class="grp"><span class="fl">State</span>${states.map(([v,l])=>chip(l, ui.stateF===v, 'filter-state', v)).join('')}</div>
      <div class="grp"><span class="fl">Platform</span>${plats.map(([v,l])=>chip(l, ui.platF===v, 'filter-plat', v)).join('')}</div>
      <div class="tb-right">
        <div class="seg"><span class="fl">Sort</span>${sorts.map(([v,l])=>`<button class="seg-b ${ui.sort===v?'on':''}" data-act="sort" data-v="${v}">${l}</button>`).join('')}</div>
        <div class="seg density"><button class="seg-b ${ui.density==='cards'?'on':''}" data-act="density" data-v="cards" title="Card grid">${U.I.grid}</button><button class="seg-b ${ui.density==='rows'?'on':''}" data-act="density" data-v="rows" title="Dense rows">${U.I.rows}</button></div>
      </div>
    </div>`;
  }

  function render(ctx) {
    const ui = ctx.ui;
    const list = visible(ui);
    const attn = D.AGENTS.filter(a => a.state === 'blocked' || a.state === 'awaiting');
    const banner = (ui.sort === 'auto' && attn.length && ui.stateF === 'all')
      ? `<div class="attn-banner"><span class="ab-dot"></span><span class="ab-msg"><b>${attn.length} ${attn.length===1?'agent needs':'agents need'} you.</b> Sorted attention-first — blocked and awaiting-input surface on top.</span></div>`
      : '';

    let body;
    if (!list.length) {
      body = `<div class="state-wrap"><div class="state-ico">${U.I.empty}</div><h2>No agents match</h2>
        <p>No agents match the current filters. Clear them to see your whole team.</p>
        <div class="state-actions"><button class="btn-add" data-act="clear-filters">Clear filters</button></div></div>`;
    } else if (ui.density === 'cards') {
      body = `${banner}<div class="agent-grid">${list.map(card).join('')}</div>`;
    } else {
      body = `${banner}<div class="optable"><div class="thead">
        <span>Agent</span><span>State</span><span>Current task</span><span>Tiers</span>
        <span class="r">Today</span><span class="r">Success</span><span class="r">Cost</span><span></span></div>
        ${list.map(row).join('')}</div>`;
    }

    return `<div class="roster-head">
        <div><h1>Your team</h1><div class="sub"><b>${D.AGENTS.length}</b> agents · <b>${D.AGENTS.filter(a=>a.state!=='idle').length}</b> active · <b>92%</b> success this week</div></div>
        <button class="btn-add" data-act="add-agent">${U.I.plus} Add agent</button></div>
      ${healthStrip()}${toolbar(ui)}${body}`;
  }

  window.ROSTER = { render };
})();
