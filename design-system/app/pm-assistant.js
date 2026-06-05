/* TASCA app · PM assistant (Stage-5, advisory). Designed flag-OFF first.
   The assistant only SUGGESTS — triage, decomposition, routing proposals,
   standups. A human (or the routing engine) always decides; nothing it
   produces is binding or auto-applied. window.PM.render(ctx) · ctx.pm={on}. */
(function () {
  const D = window.DATA, U = window.UI;

  const SPARK = U.I.spark;
  const CAPS = [
    { ic: 'triage', t: 'Triage', d: 'Reads new issues and proposes a tier estimate + priority. You confirm before anything routes.' },
    { ic: 'decomp', t: 'Decomposition', d: 'Breaks a large story into smaller, independently-routable tasks — as a draft you edit.' },
    { ic: 'route',  t: 'Routing proposals', d: 'Suggests which agent fits a task and why. The engine still makes the call; this is a second opinion.' },
    { ic: 'standup',t: 'Standups', d: 'Drafts a daily summary of what shipped, what’s blocked, and what needs you. Yours to send or ignore.' },
  ];
  const CAP_IC = {
    triage:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h14M3 10h9M3 15h5"/></svg>',
    decomp:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/><path d="M9 6h3a2 2 0 012 2v3" stroke-linecap="round"/></svg>',
    route:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="10" r="2.2"/><circle cx="15" cy="5" r="2.2"/><circle cx="15" cy="15" r="2.2"/><path d="M7 9l6-3M7 11l6 3" stroke-linecap="round"/></svg>',
    standup:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M7 2v3M13 2v3" stroke-linecap="round"/></svg>',
  };

  // ── PRIMARY: flag-off / advisory empty state ──────────────────────────────
  function offState() {
    const caps = CAPS.map(c => `<div class="pm-cap"><span class="pm-cap-ic">${CAP_IC[c.ic]}</span>
      <div><div class="pm-cap-t">${c.t}</div><div class="pm-cap-d">${c.d}</div></div></div>`).join('');
    return `<div class="pm-off">
      <div class="pm-hero">
        <span class="pm-badge advisory">Advisory · off by default</span>
        <div class="pm-mark">${SPARK}</div>
        <h2>A PM assistant that only suggests</h2>
        <p>It reads your backlog and proposes triage, task breakdowns, routing, and standups. Every output is a <b>draft you accept, edit, or ignore</b> — the assistant never assigns work or changes anything on its own. You and the routing engine stay in control.</p>
        <div class="pm-actions">
          <button class="btn-add" data-act="pm-toggle" data-v="on">${SPARK} Turn on suggestions</button>
          <span class="pm-note mono">You can turn it off anytime · nothing it suggests is binding</span>
        </div>
      </div>
      <div class="pm-caps">${caps}</div>
      <div class="pm-principle"><span class="pmp-k mono">How it stays advisory</span>
        <div class="pmp-row"><span class="pmp-dot"></span>Suggestions appear as cards with <b>Accept</b> / <b>Edit</b> / <b>Dismiss</b> — no silent actions.</div>
        <div class="pmp-row"><span class="pmp-dot"></span>Accepting a routing proposal still runs the normal, <b>inspectable</b> routing decision.</div>
        <div class="pmp-row"><span class="pmp-dot"></span>It can read your roster &amp; backlog; it <b>cannot</b> hire agents, change limits, or touch connections.</div>
      </div>
    </div>`;
  }

  // ── what an advisory suggestion looks like (on state) ─────────────────────
  function suggestion({ kind, tag, title, body, foot }) {
    return `<div class="pm-suggestion">
      <div class="pms-top"><span class="pm-cap-ic sm">${CAP_IC[kind]}</span><span class="pms-tag">${tag}</span>
        <span class="pm-badge advisory sm">Suggestion · not applied</span></div>
      <div class="pms-title">${title}</div>
      <div class="pms-body">${body}</div>
      <div class="pms-foot">${foot||''}<div class="pms-act">
        <button class="ictl" data-act="noop">Dismiss</button>
        <button class="ictl" data-act="noop">Edit</button>
        <button class="ictl signal" data-act="noop">Accept</button></div></div></div>`;
  }

  function onState() {
    const triage = suggestion({
      kind: 'triage', tag: 'Triage · 3 new issues',
      title: 'TAS-281 “Checkout 500s under load” looks like a HARD incident',
      body: `Proposed: tier <b>HARD</b>, priority <b>P1</b>. Mentions 500s + load — pattern-matches past incidents in <span class="mono">acme/api</span>. I’d suggest routing to an agent with auth/API history.`,
      foot: `<span class="pms-meta mono dim">confidence 0.78 · you confirm before it routes</span>`,
    });
    const decomp = suggestion({
      kind: 'decomp', tag: 'Decomposition',
      title: 'Break “Billing reconciliation v2” into 3 routable tasks',
      body: `Draft split: <span class="pm-chip">1 · schema migration (LOW)</span> <span class="pm-chip">2 · recon engine (ULTRA)</span> <span class="pm-chip">3 · report export (MEDIUM)</span> — editable before anything is created.`,
    });
    const standup = suggestion({
      kind: 'standup', tag: 'Daily standup · draft',
      title: 'Yesterday: 12 shipped · 1 blocked · 1 awaiting you',
      body: `Pike merged the rate-limit guard; Nova’s auth refactor is in review. <b>Blocked:</b> Sable on billing types (breaker tripped). <b>Needs you:</b> Wren’s migration question. Burn $24.35 / $140.`,
      foot: `<span class="pms-meta mono dim">drafted from Monitoring · yours to send or ignore</span>`,
    });
    return `<div class="pm-on">
      <div class="pm-on-head"><div><div class="pm-on-t"><span class="pm-mark sm">${SPARK}</span> PM assistant <span class="pm-badge advisory sm">Advisory · on</span></div>
        <div class="pm-on-s">Suggestions below. Nothing here has been applied — accept, edit, or dismiss each.</div></div>
        <button class="ictl" data-act="pm-toggle" data-v="off">Turn off</button></div>
      <div class="pm-suggestions">${triage}${decomp}${standup}</div>
    </div>`;
  }

  function render(ctx) {
    const on = !!(ctx.pm && ctx.pm.on);
    const head = `<div class="roster-head"><div><h1>PM assistant</h1>
        <div class="sub">Advisory suggestions · triage, decomposition, routing &amp; standups</div></div></div>`;
    return `${head}<div class="pm-body">${on ? onState() : offState()}</div>`;
  }

  window.PM = { render };
})();
