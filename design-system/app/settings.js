/* TASCA app · Settings — tabbed admin surface.
   Tabs: Organization (members/roles, admin-gated) · Billing & usage ·
   Feature flags · Security (least-privilege scopes + agent-action audit log) ·
   Vendor keys. Admin-gated surfaces are shown with the gate visible.
   NOTE (source-doc discrepancy): Brief C9 labels PM-assistant "Stage 5" while
   PRD/Roadmap place it at Phase/M3. Immaterial to design (roadmap → flag-off).
   window.SETTINGS.render(ctx)  ·  ctx.settings = { tab, isAdmin } */
(function () {
  const D = window.DATA, U = window.UI;

  const TABS = [
    { k: 'org',      n: 'Organization', admin: true },
    { k: 'billing',  n: 'Billing & usage', admin: false },
    { k: 'flags',    n: 'Feature flags', admin: true },
    { k: 'security', n: 'Security', admin: false },
    { k: 'keys',     n: 'Vendor keys', admin: true },
  ];

  const card = (title, sub, body, right) => `<div class="pcard set-card">
    <div class="pc-h">${title}${right?`<span class="pc-h-r">${right}</span>`:''}</div>
    ${sub?`<div class="pc-sub">${sub}</div>`:''}${body}</div>`;

  const adminGate = () => `<div class="admin-gate"><span class="ag-ico">${LOCK}</span>
      <div><div class="ag-t">Admin only</div><div class="ag-s">You're viewing as a <b>Member</b>. These controls are read-only — an organization admin can change them.</div></div></div>`;
  const LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke-linecap="round"/></svg>';

  // ── Organization ──────────────────────────────────────────────────────────
  function org(s) {
    const members = [
      { in: 'DM', name: 'Dana Mercer', email: 'dana@acme.co', role: 'Admin', you: true },
      { in: 'RK', name: 'Ravi Kapoor', email: 'ravi@acme.co', role: 'Admin', you: false },
      { in: 'JL', name: 'Jo Lindqvist', email: 'jo@acme.co', role: 'Maintainer', you: false },
      { in: 'SP', name: 'Sam Park', email: 'sam@acme.co', role: 'Member', you: false },
    ];
    const roleTag = (r) => `<span class="role-tag role-${r.toLowerCase()}">${r}</span>`;
    const rows = members.map(m => `<div class="member-row">
      <div class="mr-id"><span class="av-md" style="border-radius:50%;background:color-mix(in srgb,var(--fg) 12%,transparent);border-color:var(--line-2);color:var(--fg-2)">${m.in}</span>
        <div><div class="mr-name">${m.name}${m.you?'<span class="you-tag">You</span>':''}</div><div class="mr-email mono dim">${m.email}</div></div></div>
      ${s.isAdmin && !m.you ? `<div class="mr-role-edit">${roleTag(m.role)}<button class="kebab-btn">${U.I.kebab}</button></div>` : roleTag(m.role)}</div>`).join('');
    return `${s.isAdmin?'':adminGate()}
      ${card('Members', '4 people · roles govern who can hire agents, manage connections, and change limits.', `<div class="member-list">${rows}</div>
        ${s.isAdmin?`<div class="ictl-row"><button class="btn-add" data-act="noop">${U.I.plus} Invite member</button></div>`:''}`)}
      ${card('Roles', 'What each role can do.', `<div class="role-matrix">
        ${[['Admin','Full control · billing, members, keys, flags'],['Maintainer','Hire agents, manage connections, set limits'],['Member','View roster & monitoring, answer agent questions']].map(([r,d])=>`<div class="rm-row">${roleTag(r)}<span class="rm-d">${d}</span></div>`).join('')}</div>`)}`;
  }

  // ── Billing & usage ─────────────────────────────────────────────────────────
  function billing(s) {
    const perAgent = D.AGENTS.filter(a => a.cost !== '0.00').sort((a,b)=>parseFloat(b.cost)-parseFloat(a.cost)).slice(0,6);
    const max = Math.max(...perAgent.map(a => parseFloat(a.cost)));
    const bars = perAgent.map(a => `<div class="usage-row"><span class="ur-name">${U.av(a,'av-sm')}${a.name}</span>
      <span class="ur-bar"><span style="width:${parseFloat(a.cost)/max*100}%;background:${a.vendor==='local'?'var(--green)':'var(--signal)'}"></span></span>
      <span class="ur-val mono">$${a.cost}</span></div>`).join('');
    const meters = [
      { k: 'Vendor credits', v: '$24.35', of: '$140.00', pct: 17, sub: 'daily ceiling across all agents' },
      { k: 'CI minutes', v: '1,840', of: '5,000', pct: 37, sub: 'this billing cycle' },
      { k: 'Seats', v: '4', of: '10', pct: 40, sub: 'included in plan' },
    ];
    return `${card('This cycle', 'Team plan · renews Jul 1, 2026', `<div class="meter-grid">${meters.map(m=>`<div class="meter-card">
        <div class="mc-k">${m.k}</div><div class="mc-v">${m.v}<span class="mc-of mono dim">/ ${m.of}</span></div>
        <div class="mc-bar"><span style="width:${m.pct}%"></span></div><div class="mc-s">${m.sub}</div></div>`).join('')}</div>`)}
      ${card('Cost per agent', 'Today · token spend by agent. Local agents run at $0.', `<div class="usage-list">${bars}</div>`,
        `<button class="ictl" data-act="noop">Export CSV</button>`)}`;
  }

  // ── Feature flags ────────────────────────────────────────────────────────────
  function flags(s) {
    const items = [
      { k: 'Auto-route on ticket start', d: 'When a ticket starts, route it automatically to a capable, free agent.', on: true },
      { k: 'Breaker auto-escalation', d: 'Auto-bump tier / reassign to cloud after repeated failure. v1 keeps escalation human-gated — turn this on to opt into v2 behavior.', on: false, beta: true },
      { k: 'PM assistant', d: 'Advisory triage, decomposition & routing suggestions. Off by default — suggestions are never binding.', on: false, beta: true },
      { k: 'Parallel agents per task', d: 'Allow >1 agent to attempt the same task; best result is kept.', on: false, beta: true },
      { k: 'Local-only mode', d: 'Restrict routing to on-device agents — no external vendor calls.', on: false },
    ];
    const rows = items.map(f => `<div class="flag-row">
      <div class="fr-body"><div class="fr-k">${f.k}${f.beta?'<span class="beta-tag">Beta</span>':''}</div><div class="fr-d">${f.d}</div></div>
      <button class="toggle ${f.on?'on':''} ${s.isAdmin?'':'locked'}" data-act="${s.isAdmin?'set-flag':'noop'}" ${s.isAdmin?'':'disabled'}><span class="tg-knob"></span></button></div>`).join('');
    return `${s.isAdmin?'':adminGate()}${card('Feature flags', 'Capabilities you can turn on for the whole organization. Beta flags may change.', `<div class="flag-list">${rows}</div>`)}`;
  }

  // ── Security ──────────────────────────────────────────────────────────────────
  function security(s) {
    // least-privilege scopes per platform identity (Shortcut-first ordering)
    const scopes = [
      { plat: 'Shortcut', identity: '*-agent (agent user)', granted: ['stories:write','comments:write','iterations:read'], denied: ['workspace_admin','billing'] },
      { plat: 'GitHub', identity: 'tasca-*[bot]', granted: ['contents:write','pull_requests:write','checks:read'], denied: ['admin','secrets','members'] },
      { plat: 'Linear', identity: 'app actor', granted: ['issues:write','comments:write','projects:read'], denied: ['admin','members:write'] },
    ];
    const scopeCards = scopes.map(sc => `<div class="scope-card">
      <div class="sc-top"><span class="plat-tag">${sc.plat}</span><span class="mono dim">${sc.identity}</span></div>
      <div class="sc-grid"><div class="sc-col"><span class="sc-k granted">Granted</span>${sc.granted.map(g=>`<span class="scope-chip ok mono">${g}</span>`).join('')}</div>
        <div class="sc-col"><span class="sc-k denied">Denied</span>${sc.denied.map(g=>`<span class="scope-chip no mono">${g}</span>`).join('')}</div></div></div>`).join('');
    // agent-action audit log
    const audit = [
      ['12:12:01', 'Nova', 'opened PR #4821', 'github', 'ok'],
      ['12:04:03', 'router', 'assigned TAS-241 → Nova', 'system', 'ok'],
      ['11:58:22', 'Sable', 'breaker tripped on BILL-77 (3× CI fail)', 'system', 'warn'],
      ['11:40:10', 'Wren', 'paused — asked for human input on TAS-260', 'shortcut', 'ok'],
      ['11:21:55', 'Pike', 'merged PR #4807', 'github', 'ok'],
      ['10:02:14', 'admin · Dana', 'rotated Shortcut API token', 'shortcut', 'admin'],
    ];
    const auditRows = audit.map(([t, who, what, src, k]) => `<div class="audit-row"><span class="al-t mono">${t}</span>
      <span class="al-who">${who}</span><span class="al-what">${what}</span><span class="al-src mono dim">${src}</span>
      <span class="al-k al-${k}"></span></div>`).join('');
    return `${card('Least-privilege scopes', 'Each agent identity is granted only what it needs — verified against the platform on every connect. Agents act as their own native identity and never impersonate a human teammate; they never hold admin or secrets access.', `<div class="scope-list">${scopeCards}</div>`)}
      ${card('Agent-action audit log', 'Every action an agent or admin takes, attributed to its identity. Immutable.', `<div class="audit-log">${auditRows}</div>`,
        `<button class="ictl" data-act="noop">Full log ${U.I.arrow}</button>`)}`;
  }

  // ── Vendor keys ────────────────────────────────────────────────────────────────
  function keys(s) {
    const k = [
      { v: 'claude', label: 'Anthropic', detail: 'sk-ant-…7f2a', state: 'ok', rotated: '12 days ago', agents: 4 },
      { v: 'openai', label: 'OpenAI', detail: 'sk-…9c1b', state: 'warn', rotated: '40 days ago', agents: 2 },
      { v: 'local', label: 'Local endpoints', detail: 'Ollama · LM Studio', state: 'ok', rotated: 'n/a — no key', agents: 2 },
    ];
    const dot = { ok:'var(--green)', warn:'var(--amber)', err:'var(--red)' };
    const rows = k.map(x => `<div class="key-row">
      <span class="cp-ic vendor"><span class="vglyph">${U.VG[x.v]}</span></span>
      <div class="kr-body"><div class="kr-name">${x.label}</div><div class="kr-detail mono dim">${x.detail} · ${x.agents} agents · rotated ${x.rotated}</div></div>
      <span class="key-state" style="color:${dot[x.state]}"><span class="d" style="background:${dot[x.state]}"></span>${x.state==='ok'?'Valid':x.state==='warn'?'Rotate soon':'Invalid'}</span>
      ${s.isAdmin?`<div class="kr-act">${x.v!=='local'?`<button class="ictl">Rotate</button>`:''}<button class="kebab-btn">${U.I.kebab}</button></div>`:''}</div>`).join('');
    return `${s.isAdmin?'':adminGate()}${card('Vendor keys', 'Credentials your agents use. Stored encrypted; surfaced here for rotation. Keys are never shown in full after saving.', `<div class="key-list">${rows}</div>
      ${s.isAdmin?`<div class="ictl-row"><button class="btn-add" data-act="conn-add">${U.I.plus} Add vendor</button></div>`:''}`)}`;
  }

  const TAB_FN = { org, billing, flags, security, keys };

  function render(ctx) {
    const s = ctx.settings;
    const tabs = TABS.map(t => `<button class="set-tab ${s.tab===t.k?'on':''}" data-act="set-tab" data-v="${t.k}">${t.n}${t.admin?`<span class="tab-lock">${LOCK}</span>`:''}</button>`).join('');
    return `<div class="roster-head"><div><h1>Settings</h1><div class="sub">Acme Robotics · organization &amp; platform configuration</div></div>
        <div class="role-switch"><span class="rs-lab mono">Viewing as</span>
          <div class="seg"><button class="seg-b ${s.isAdmin?'on':''}" data-act="set-role" data-v="admin">Admin</button><button class="seg-b ${!s.isAdmin?'on':''}" data-act="set-role" data-v="member">Member</button></div></div></div>
      <div class="set-tabs">${tabs}</div>
      <div class="set-body">${(TAB_FN[s.tab]||org)(s)}</div>`;
  }

  window.SETTINGS = { render, TABS };
})();
