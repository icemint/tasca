/* TASCA app · Routing inspector (task detail) with audience-split progressive
   disclosure. One surface, two depths: PM-readable by default; an Engineer
   view expands the candidate math, log stream, and worktree.
   window.ROUTING.render(ctx, id)  ·  ctx.ui.eng toggles depth. */
(function () {
  const D = window.DATA, U = window.UI;
  const LOG_KIND = { route: 'var(--signal-2)', assign: 'var(--green)', agent: 'var(--fg-2)', ci: 'var(--amber)' };

  // plain-English status — the PM-readable summary of where the work stands
  function plainStatus(t, a) {
    if (t.state === 'working') return `<b>${a.name}</b> is on it.${t.pr ? ` PR #${t.pr.number} is open and CI is running (${t.pr.checks} green).` : ' No PR yet.'}`;
    if (t.state === 'awaiting') return `<b>${a.name}</b> paused to ask a question before a destructive step. Your answer unblocks it.`;
    if (t.state === 'blocked') return `<b>${a.name}</b>'s run failed CI repeatedly — the breaker tripped. Re-tier it or hand to a human to continue.`;
    if (t.state === 'shipped') return `<b>${a.name}</b> shipped this. PR #${t.pr.number} merged, all checks green.`;
    return `${a.name} is assigned.`;
  }

  function decision(t, eng) {
    const routed = D.agent(t.routedTo);
    const cand = t.eligible.map((e, i) => {
      const a = D.agent(e.id), chosen = e.id === t.routedTo;
      return `<div class="cand ${chosen ? 'chosen' : ''}">
        <span class="cand-rank">${i + 1}</span>${U.av(a, 'av-md')}
        <div class="cand-id"><span class="cand-name">${a.name}</span><span class="cand-note">${e.note}</span></div>
        <div class="cand-score"><span class="scorebar"><span style="width:${Math.round(e.score*100)}%"></span></span><span class="mono scoreval">${e.score.toFixed(2)}</span></div>
        ${chosen ? '<span class="routed-badge">Routed</span>' : '<span class="cand-pass">—</span>'}</div>`;
    }).join('');

    const engBlock = eng
      ? `<div class="cand-head"><span>Candidate</span><span class="r">Match score</span></div>
         <div class="cands">${cand}</div>
         <div class="score-note">score = capability-fit × domain-history × availability. Tier-eligibility is a hard gate; ties break on lowest cost-to-serve. ${t.eligible.length} of ${D.AGENTS.length} agents cleared the gate.</div>`
      : `<div class="depth-hint"><span>${t.eligible.length} agents were eligible. <b>${routed.name}</b> was the best match.</span>
         <button class="linkmore" data-act="rt-depth" data-v="eng">Show match scores ${U.I.chevron}</button></div>`;

    return `<div class="pcard decision">
      <div class="pc-h">Routing decision <span class="pc-h-r tag-inspect">Inspectable</span></div>
      <div class="flow">
        <div class="flow-step"><div class="fs-k">Estimated tier</div><div class="fs-v">${U.tierTag(t.estTier)}</div><div class="fs-sub mono">confidence 0.86</div></div>
        <div class="flow-arr">${U.I.arrow}</div>
        <div class="flow-step"><div class="fs-k">Eligible agents</div><div class="fs-v big">${t.eligible.length}</div><div class="fs-sub mono">of ${D.AGENTS.length} on roster</div></div>
        <div class="flow-arr">${U.I.arrow}</div>
        <div class="flow-step"><div class="fs-k">Routed to</div><div class="fs-v big">${routed.name}</div><div class="fs-sub mono">best match</div></div>
      </div>
      <div class="why">${t.why}</div>
      ${engBlock}</div>`;
  }

  function liveWork(t, eng) {
    const a = D.agent(t.routedTo);
    const ci = t.pr ? `<span class="ci ci-${t.pr.ci}">${t.pr.ci==='green'?'CI green':t.pr.ci==='running'?'CI running':t.pr.ci} · ${t.pr.checks}</span>` : '';
    const prRow = t.pr
      ? `<div class="prrow"><span class="prchip big">${U.I.pr} #${t.pr.number}</span>${ci}</div>`
      : `<div class="prrow muted">No PR opened yet</div>`;

    let depth;
    if (eng) {
      const logs = (t.log && t.log.length) ? t.log.map(([tm, k, m]) =>
        `<div class="logline"><span class="lt">${tm}</span><span class="lk" style="color:${LOG_KIND[k]||'var(--fg-3)'}">${k}</span><span class="lm">${m}</span></div>`).join('')
        : `<div class="we-s" style="padding:14px">Log stream starts when the agent picks up work. Nothing to show yet.</div>`;
      depth = `<div class="worktree"><span class="cap-k">Worktree</span><span class="mono dim">~/agents/${a.id}/${t.repo.split('/')[1]}</span><span class="branch-tag mono">${t.branch}</span></div>
        <div class="logs"><div class="logs-h"><span class="mono">routing + agent log</span><span class="live-dot">live</span></div>${logs}</div>`;
    } else {
      depth = `<div class="depth-hint"><span class="mono dim">${t.branch}</span>
        <button class="linkmore" data-act="rt-depth" data-v="eng">Show log stream &amp; worktree ${U.I.chevron}</button></div>`;
    }
    return `<div class="pcard"><div class="pc-h">Live work <span class="coming-tag">PR sync · preview</span></div>
      <div class="status-line">${plainStatus(t, a)}</div>${prRow}${depth}</div>`;
  }

  function sidebar(t) {
    const a = D.agent(t.routedTo);
    const meta = [['Platform', U.PLATFORM_LABEL[t.platform]], ['Repo', t.repo], ['Branch', t.branch], ['Opened', t.opened]];
    const escalation = t.state === 'blocked' ? `<div class="pcard escal"><div class="pc-h">Escalation path</div>
      <div class="esc-step done"><span class="esc-dot"></span>Breaker tripped <span class="dim">— ${t.breaker || 'repeated failure'}</span></div>
      <div class="esc-step active"><span class="esc-dot"></span>Awaiting handoff</div>
      <div class="ictl-row" style="margin-top:14px"><button class="ictl amber">Re-tier to ULTRA</button><button class="ictl">Hand to human review</button></div></div>` : '';
    const awaiting = t.state === 'awaiting' && t.question ? `<div class="pcard"><div class="pc-h">Needs your answer</div>
      <div class="we-s" style="margin:6px 0 12px">${t.question}</div>
      <div class="ictl-row"><button class="ictl signal">Answer</button><button class="ictl">Reassign</button></div></div>` : '';
    return `<div class="pcard"><div class="pc-h">Routed agent</div>
        <button class="routed-agent" data-act="open-agent" data-id="${a.id}">${U.av(a,'av-md')}
          <div class="nm"><div class="name">${a.name}</div><div class="vrow">${U.vendorChip(a)} ${U.statePill(a)}</div></div>${U.I.chevron}</button></div>
      ${awaiting}${escalation}
      <div class="pcard"><div class="pc-h">Task</div>${meta.map(([k,v])=>`<div class="cap-row"><span class="cap-k">${k}</span><span class="cap-v mono">${v}</span></div>`).join('')}</div>
      <div class="pcard"><div class="pc-h">Intervene</div><div class="ictl-row col">
        <button class="ictl">Interrupt run</button><button class="ictl">Reassign agent</button><button class="ictl ${t.state==='blocked'?'amber':''}">Escalate</button></div></div>`;
  }

  function render(ctx, id) {
    const t = D.TASKS[id];
    if (!t) return `<div class="state-wrap"><h2>Task not found</h2></div>`;
    const a = D.agent(t.routedTo);
    const eng = !!(ctx.ui && ctx.ui.eng);
    return `<div class="vhead">
        <button class="vback" data-act="go-roster">${U.I.back} Your team</button>
        <div class="vh-main">
          <div class="vh-id"><div><div class="vh-eyebrow"><span class="plat-tag">${U.PLATFORM_LABEL[t.platform]}</span>${U.taskRef(t.id)}<span class="mono dim">${t.repo}</span></div>
            <div class="vh-name task">${t.title}</div></div></div>
          <div class="vh-actions">
            <span class="depth-lab">Detail</span>
            <div class="seg depth-seg"><button class="seg-b ${!eng?'on':''}" data-act="rt-depth" data-v="pm">Summary</button><button class="seg-b ${eng?'on':''}" data-act="rt-depth" data-v="eng">Engineer</button></div>
            ${U.statePill(a, true)}</div></div></div>
      ${decision(t, eng)}
      <div class="pcols">
        <div class="pcol">${liveWork(t, eng)}</div>
        <div class="pcol">${sidebar(t)}</div></div>`;
  }
  window.ROUTING = { render };
})();
