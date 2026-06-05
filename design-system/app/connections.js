/* TASCA app · Connections — management counterpart to the wizard's deploy step.
   Platform integrations (Shortcut/GitHub/Linear) + vendor/key management
   (Anthropic/OpenAI/local), live health, deployed-agents per connection,
   and the repair/re-auth path when something breaks.
   window.CONN.render(ctx)  ·  ctx.connEmpty toggles the honest empty state. */
(function () {
  const D = window.DATA, U = window.UI;
  const C = D.CONNECTIONS;

  const STATUS = {
    connected:    { label: 'Connected', cls: 'ok',   c: 'var(--green)' },
    degraded:     { label: 'Degraded',  cls: 'warn', c: 'var(--amber)' },
    disconnected: { label: 'Disconnected', cls: 'off', c: 'var(--fg-faint)' },
  };
  const dotState = { ok: 'var(--green)', warn: 'var(--amber)', off: 'var(--fg-faint)', err: 'var(--red)' };

  const statusBadge = (s) => `<span class="conn-status ${STATUS[s].cls}"><span class="d"></span>${STATUS[s].label}</span>`;

  // agents-deployed avatar stack
  function agentStack(list, plat) {
    if (!list.length) return `<span class="mono dim" style="font-size:var(--fs-xs)">No agents deployed</span>`;
    const shown = list.slice(0, 6);
    const av = shown.map(a => {
      const warn = plat && a.identities[plat] && a.identities[plat].health === 'warn';
      return `<button class="stack-av ${a.vendor==='local'?'local':''} ${warn?'warn':''}" data-act="open-agent" data-id="${a.id}" title="${a.name}${warn?' · webhook delayed':''}">${a.in}</button>`;
    }).join('');
    const more = list.length > 6 ? `<span class="stack-more">+${list.length-6}</span>` : '';
    return `<div class="agent-stack">${av}${more}<span class="stack-ct">${list.length} deployed</span></div>`;
  }

  // metric line (webhook / token)
  function metric(label, st, value, sub) {
    return `<div class="cmetric"><span class="cm-dot" style="background:${dotState[st]}"></span>
      <div class="cm-body"><span class="cm-k">${label}</span><span class="cm-v">${value}</span>${sub?`<span class="cm-s mono">${sub}</span>`:''}</div></div>`;
  }

  function issueBlock(issue, status) {
    if (!issue) return '';
    const tone = status === 'degraded' ? 'warn' : 'err';
    return `<div class="conn-issue ${tone}">
      <div class="ci-head"><span class="ci-ico">${U.I.kebab}</span><span class="ci-title">${issue.title}</span></div>
      <p class="ci-detail">${issue.detail}</p>
      ${issue.affected && issue.affected.length ? `<div class="ci-affected"><span class="mono dim">Affected:</span>${issue.affected.map(id=>{const a=D.agent(id);return `<button class="affected-chip" data-act="open-agent" data-id="${id}">${a.name}</button>`;}).join('')}</div>`:''}
      <div class="ictl-row" style="margin-top:14px"><button class="ictl ${tone==='err'?'':'amber'}">${issue.action}</button><button class="ictl">View logs</button></div>
    </div>`;
  }

  // ── platform connection card ──────────────────────────────────────────────
  function platformCard(key, p) {
    const agents = D.agentsOnPlatform(key);
    return `<article class="conncard ${STATUS[p.status].cls}">
      <div class="conn-top">
        <div class="conn-id"><span class="conn-mark">${U.I.plug}</span>
          <div><div class="conn-name">${p.label}</div><div class="conn-sub mono">${p.identityModel} · own actor, not a human seat</div></div></div>
        ${statusBadge(p.status)}</div>
      <div class="conn-metrics">
        ${metric('Webhook <span class="coming-tag">Preview</span>', p.webhook.state, p.webhook.last, p.webhook.rate)}
        ${metric(p.token.label, p.token.state, p.token.detail, '')}
      </div>
      <div class="conn-scope"><span class="cm-k">Scope</span><span class="mono dim">${p.scope}</span></div>
      ${issueBlock(p.issue, p.status)}
      <div class="conn-foot">
        ${agentStack(agents, key)}
        <div class="conn-actions"><button class="ictl">Manage</button><button class="kebab-btn">${U.I.kebab}</button></div>
      </div></article>`;
  }

  // ── vendor / key card ───────────────────────────────────────────────────
  function vendorCard(key, v) {
    const agents = D.agentsOnVendor(v.vendor);
    const endpoints = v.endpoints ? `<div class="endpoints">${v.endpoints.map(e=>`<div class="endpoint"><span class="cm-dot" style="background:${dotState[e.state]}"></span><span class="ep-rt">${e.rt}</span><span class="mono dim">${e.url}</span></div>`).join('')}</div>` : '';
    return `<article class="conncard vendor ${STATUS[v.status].cls}">
      <div class="conn-top">
        <div class="conn-id"><span class="conn-mark vendor-mark">${U.VG[v.vendor]}</span>
          <div><div class="conn-name">${v.label}</div><div class="conn-sub mono">since ${v.connected}</div></div></div>
        ${statusBadge(v.status)}</div>
      <div class="conn-metrics single">
        ${metric(v.cred.label, v.cred.state, v.cred.detail, '')}
      </div>
      ${endpoints}
      <div class="conn-scope"><span class="cm-k">Usage</span><span class="mono dim">${v.usage}</span></div>
      ${issueBlock(v.issue, v.status)}
      <div class="conn-foot">
        ${agentStack(agents, null)}
        <div class="conn-actions"><button class="ictl">${v.vendor==='local'?'Endpoints':'Manage key'}</button><button class="kebab-btn">${U.I.kebab}</button></div>
      </div></article>`;
  }

  // ── health summary strip ──────────────────────────────────────────────────
  function summary() {
    const all = [...Object.values(C.platforms), ...Object.values(C.vendors)];
    const ct = (s) => all.filter(x => x.status === s).length;
    const tiles = [
      { k: 'Connected', v: ct('connected'), g: 'var(--green)' },
      { k: 'Degraded', v: ct('degraded'), g: 'var(--amber)' },
      { k: 'Disconnected', v: ct('disconnected'), g: 'var(--fg-faint)' },
    ];
    const degraded = all.filter(x => x.status === 'degraded');
    const banner = degraded.length ? `<div class="attn-banner"><span class="ab-dot"></span><span class="ab-msg"><b>${degraded.length} connection${degraded.length>1?'s':''} need attention.</b> ${degraded.map(d=>d.label).join(' and ')} ${degraded.length>1?'are':'is'} degraded — agents keep working, but repair before it escalates.</span></div>` : '';
    return { banner, strip: `<div class="health-strip conn-strip">${tiles.map(t=>`<div class="hstat"><span class="k"><span class="glyph" style="background:${t.g}"></span>${t.k}</span><span class="v">${t.v}</span></div>`).join('')}</div>` };
  }

  function emptyState() {
    return `<div class="state-wrap"><div class="state-ico">${U.I.plug}</div>
      <h2>Connect your stack</h2>
      <p>No connections yet. Link Shortcut, GitHub, or Linear so agents can act with native identities, and add a model vendor so they have an engine. Connections are where you provision and repair those links.</p>
      <div class="state-actions"><button class="btn-add" data-act="conn-add">${U.I.plus} Add a connection</button>
        <button class="ictl" data-act="add-agent">Hire an agent</button></div></div>`;
  }

  function render(ctx) {
    const head = `<div class="roster-head">
        <div><h1>Connections</h1><div class="sub">Platform integrations &amp; model vendors · the links your agents act through</div></div>
        <button class="btn-add" data-act="conn-add">${U.I.plus} Add connection</button></div>`;
    if (ctx && ctx.connEmpty) return `${head}${emptyState()}`;
    const s = summary();
    const plats = Object.entries(C.platforms).map(([k, p]) => platformCard(k, p)).join('');
    const vends = Object.entries(C.vendors).map(([k, v]) => vendorCard(k, v)).join('');
    return `${head}${s.strip}${s.banner}
      <div class="conn-section"><div class="conn-sec-h"><span class="csh-t">Platforms</span><span class="csh-s mono dim">where agents do work</span></div>
        <div class="conngrid">${plats}</div></div>
      <div class="conn-section"><div class="conn-sec-h"><span class="csh-t">Model vendors</span><span class="csh-s mono dim">the engines behind your agents</span></div>
        <div class="conngrid">${vends}</div></div>`;
  }

  window.CONN = { render };
})();
