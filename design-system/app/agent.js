/* TASCA app · Agent detail / profile. window.AGENT.render(ctx, id) */
(function () {
  const D = window.DATA, U = window.UI;

  const idRow = (plat, b) => {
    const dot = { ok: 'var(--green)', warn: 'var(--amber)', idle: 'var(--fg-4)', off: 'var(--fg-faint)' }[b.health];
    const txt = { ok: 'Healthy', warn: 'Webhook delayed', idle: 'Idle', off: 'Not deployed' }[b.health];
    return `<div class="idrow"><div class="idp"><span class="idp-name">${U.PLATFORM_LABEL[plat]}</span>
        <span class="mono idp-h">${b.handle}</span></div>
      <span class="idhealth"><span class="d" style="background:${dot}"></span>${txt}</span></div>`;
  };

  function currentWork(a) {
    if (!a.task) return `<div class="pcard"><div class="pc-h">Current work</div>
      <div class="work-empty"><div class="we-ico">${U.I.roster}</div><div><div class="we-t">Idle · available to route</div>
        <div class="we-s">No active task. The routing engine can assign work matching this agent's profile.</div></div>
        <button class="ictl signal" data-act="assign">${U.I.plus} Assign a task</button></div></div>`;
    const t = D.TASKS[a.task];
    const ci = t.pr ? `<span class="ci ci-${t.pr.ci}">${t.pr.ci === 'green' ? 'CI green' : t.pr.ci === 'running' ? 'CI running' : t.pr.ci} · ${t.pr.checks}</span>` : '';
    return `<div class="pcard">
      <div class="pc-h">Current work <span class="pc-h-r">${U.statePill(a)}</span></div>
      <div class="taskcard">
        <div class="tc-top"><span class="plat-tag">${U.PLATFORM_LABEL[t.platform]}</span>${U.taskRef(t.id)}<span class="mono dim">${t.repo}</span></div>
        <button class="tc-title" data-act="open-task" data-id="${t.id}">${t.title}</button>
        <div class="tc-meta">${U.tierTag(t.estTier)}
          ${t.pr ? `<span class="prchip">${U.I.pr} #${t.pr.number}</span>${ci}` : ''}
          <span class="mono dim">${t.branch}</span></div>
        ${a.state === 'blocked' && t.breaker ? `<div class="alert alert-error" style="margin-top:14px">${U.I.kebab}<span>${t.breaker}</span></div>` : ''}
        ${a.state === 'awaiting' && t.question ? `<div class="alert alert-warn" style="margin-top:14px"><span>Needs your answer — ${t.question}</span></div>` : ''}
      </div>
      <div class="ictl-row">
        <button class="ictl" data-act="open-task" data-id="${t.id}">Inspect routing ${U.I.arrow}</button>
        <button class="ictl">Interrupt</button><button class="ictl">Reassign</button>
        <button class="ictl ${a.state==='blocked'?'amber':''}">Escalate</button>
      </div></div>`;
  }

  function performance(a) {
    const stat = (v, k, cls) => `<div class="pstat"><div class="psv ${cls||''}">${v}</div><div class="psk">${k}</div></div>`;
    return `<div class="pcard">
      <div class="pc-h">Performance <span class="pc-h-r mono dim">last 7 days</span></div>
      <div class="perf">
        <div class="perf-spark">${U.spark(a.hist, 200, 56)}<div class="ps-cap"><span>${a.hist[0]}%</span><span>${a.succ}%</span></div></div>
        <div class="pstats">${stat(a.succ + '%', 'Success', a.succ<90?'warn':'')}${stat(a.shipped, 'Shipped')}${stat(a.esc, 'Escalations', a.esc>=8?'warn':'')}${stat(a.tput, 'Today')}</div>
      </div></div>`;
  }

  function recent(a) {
    const rows = a.recent.map(id => { const t = D.TASKS[id]; return `<button class="recrow" data-act="open-task" data-id="${id}">
      <span class="astate astate-${t.state}" style="gap:6px">${U.SG[t.state]}</span>
      ${U.taskRef(id)}<span class="rec-title">${t.title}</span>${U.tierTag(t.estTier)}<span class="rec-arrow">${U.I.chevron}</span></button>`; }).join('');
    return `<div class="pcard"><div class="pc-h">Recent work</div>${rows || '<div class="we-s" style="padding:8px 0">No completed work yet.</div>'}</div>`;
  }

  function capability(a) {
    const conc = Math.round(a.concurrency.active / a.concurrency.max * 100);
    return `<div class="pcard">
      <div class="pc-h">Capability profile</div>
      <div class="cap-row"><span class="cap-k">Tier range</span><span>${U.tierRamp(a)}</span></div>
      <div class="cap-block"><span class="cap-k">Specialties</span><div class="speclist">${a.specialties.map(s=>`<span class="spec">${s}</span>`).join('')}</div></div>
      <div class="cap-row"><span class="cap-k">Concurrency</span><span class="cap-v"><span class="barmeter"><span style="width:${conc}%"></span></span>${a.concurrency.active} / ${a.concurrency.max} slots</span></div>
      <div class="cap-row"><span class="cap-k">Cost ceiling</span><span class="cap-v">${a.ceiling} <span class="dim">· ${a.spent} used</span></span></div>
    </div>`;
  }

  function render(ctx, id) {
    const a = D.agent(id);
    if (!a) return `<div class="state-wrap"><h2>Agent not found</h2></div>`;
    return `<div class="vhead">
        <button class="vback" data-act="go-roster">${U.I.back} Your team</button>
        <div class="vh-main">
          <div class="vh-id">${U.av(a,'av-xl')}
            <div><div class="vh-name">${a.name}</div>
              <div class="vh-meta">${U.vendorChip(a)}<span class="mono dim">${a.model}</span>${U.statePill(a)}</div></div></div>
          <div class="vh-actions">
            <button class="ictl">${a.state==='idle'?'Activate':U.I.pause+' Pause'}</button>
            <button class="ictl">Edit profile</button>
            <button class="ictl">Deploy</button>
            <button class="kebab-btn">${U.I.kebab}</button></div>
        </div></div>
      <div class="pcols">
        <div class="pcol">${currentWork(a)}${performance(a)}${recent(a)}</div>
        <div class="pcol">
          <div class="pcard"><div class="pc-h">Identity bindings</div>
            <div class="pc-sub">Native identities this agent acts as inside each platform — its own actor, never impersonating a human teammate.</div>
            ${idRow('shortcut', a.identities.shortcut)}${idRow('github', a.identities.github)}${idRow('linear', a.identities.linear)}</div>
          ${capability(a)}
        </div></div>`;
  }
  window.AGENT = { render };
})();
