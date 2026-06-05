/* TASCA · Login + first-run onboarding narrative (stitched).
   login → welcome (empty roster) → connect first platform (Shortcut) →
   hire first agent → done (hands into the app). Plain-JS string builders.
   window.ONB.render(state) where state = { step, ... }. Honest empty-first. */
(function () {
  const U = window.UI;
  const MARK = U.MARK;

  const G = {
    github: '<svg viewBox="0 0 18 18" fill="currentColor"><path d="M9 1.5a7.5 7.5 0 00-2.37 14.62c.37.07.5-.16.5-.36v-1.3c-2.08.45-2.52-.88-2.52-.88-.34-.87-.83-1.1-.83-1.1-.68-.46.05-.45.05-.45.75.05 1.14.77 1.14.77.67 1.14 1.75.81 2.18.62.07-.48.26-.81.47-1-1.66-.19-3.4-.83-3.4-3.7 0-.82.29-1.48.77-2-.08-.19-.34-.95.07-1.98 0 0 .63-.2 2.06.76a7.2 7.2 0 013.75 0c1.43-.96 2.06-.76 2.06-.76.41 1.03.15 1.79.07 1.98.48.52.77 1.18.77 2 0 2.87-1.75 3.5-3.42 3.69.27.23.5.69.5 1.39v2.06c0 .2.14.43.51.36A7.5 7.5 0 009 1.5Z"/></svg>',
    google: '<svg viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.92v2.34A9 9 0 009 18Z"/><path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 010-3.44V4.94H.92a9 9 0 000 8.12l3.06-2.34Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 00.92 4.94l3.06 2.34C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5L13 5"/></svg>',
    arrow: U.I.arrow, plus: U.I.plus, back: U.I.back, plug: U.I.plug, spark: U.I.spark,
  };

  // shared centered shell
  function shell(inner, opts) {
    opts = opts || {};
    return `<div class="onb-stage ${opts.wide?'wide':''}">
      <div class="onb-topbar"><span class="onb-brand"><span class="onb-mark">${MARK}</span><span class="brand-word"><span class="a">Tas</span><span class="b">ca</span></span></span>
        ${opts.steps ? stepDots(opts.steps) : ''}
        <span class="theme-seg onb-theme"><button data-act="onb-theme" data-v="dark" class="${(window.__onbTheme||'dark')==='dark'?'on':''}">Dark</button><button data-act="onb-theme" data-v="light" class="${(window.__onbTheme||'dark')==='light'?'on':''}">Light</button></span></div>
      <div class="onb-content">${inner}</div></div>`;
  }
  function stepDots(cur) {
    const steps = ['connect', 'hire', 'done'];
    const i = steps.indexOf(cur);
    return `<div class="onb-progress">${steps.map((s, n) => `<span class="opd ${n<i?'done':n===i?'on':''}"></span>`).join('')}</div>`;
  }

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  function login() {
    return shell(`<div class="onb-auth-col">
    <div class="onb-card auth">
      <div class="auth-mark">${MARK}</div>
      <h1>Sign in to Tasca</h1>
      <p class="auth-sub">Your AI dev team — named, capable, working in the tools you already use.</p>
      <div class="oauth-col">
        <button class="oauth-btn" data-act="onb-go" data-v="connect">${G.github}<span>Continue with GitHub</span></button>
        <button class="oauth-btn" data-act="onb-go" data-v="connect">${G.google}<span>Continue with Google</span></button>
      </div>
      <div class="auth-or"><span>or</span></div>
      <form class="auth-form" onsubmit="return false">
        <input class="tinput" type="email" placeholder="you@company.com" aria-label="Email">
        <input class="tinput" type="password" placeholder="Password" aria-label="Password">
        <button class="btn-add wide" data-act="onb-go" data-v="connect">Sign in</button>
      </form>
      <div class="auth-foot"><a data-act="noop">Create an account</a><span class="sep">·</span><a data-act="noop">Forgot password?</a></div>
    </div>
    <div class="auth-legal mono">Tasca uses OAuth (GitHub / Google). We never see your password for those providers.</div>
    </div>`, { auth: true });
  }

  // ── WELCOME / EMPTY ROSTER ─────────────────────────────────────────────────
  function welcome() {
    return shell(`<div class="onb-card welcome">
      <span class="onb-eyebrow mono">Welcome to Tasca</span>
      <h1>Let’s build your team</h1>
      <p class="onb-lead">A brand-new workspace has no agents and no connected tools yet. Two steps and your first AI teammate is working: <b>connect a platform</b>, then <b>hire an agent</b>.</p>
      <div class="onb-steps-preview">
        <div class="osp"><span class="osp-n">1</span><span class="osp-ic">${G.plug}</span><div><div class="osp-t">Connect a platform</div><div class="osp-d">Give Tasca a place to do work — Shortcut, GitHub, or Linear.</div></div></div>
        <div class="osp-line"></div>
        <div class="osp"><span class="osp-n">2</span><span class="osp-ic">${G.spark}</span><div><div class="osp-t">Hire your first agent</div><div class="osp-d">Name it, pick an engine, set its tiers, deploy its identity.</div></div></div>
      </div>
      <button class="btn-add lg" data-act="onb-go" data-v="connect">Get started ${G.arrow}</button>
    </div>`);
  }

  // ── STEP 1 · CONNECT FIRST PLATFORM (Shortcut-first) ───────────────────────
  function connect(state) {
    const connected = state.connected; // null | 'connecting' | 'done'
    const plats = [
      { k: 'shortcut', label: 'Shortcut', identity: 'Agent user', blurb: 'Lead here — stories, comments, PRs', rec: true },
      { k: 'github', label: 'GitHub', identity: 'GitHub App', blurb: 'Repos, PRs, checks' },
      { k: 'linear', label: 'Linear', identity: 'Actor = app', blurb: 'Issues, projects, cycles' },
    ];
    const card = (p) => {
      const st = connected && state.target === p.k ? state.connected : 'idle';
      const badge = st === 'done' ? `<span class="prov-badge done"><span class="d"></span>Connected</span>`
        : st === 'connecting' ? `<span class="prov-badge work"><span class="d"></span>Authorizing…</span>`
        : p.rec ? `<span class="rec-pill">Recommended</span>` : '';
      const action = st === 'done' ? `<span class="onb-check">${G.check}</span>`
        : st === 'connecting' ? `<button class="ictl signal" data-act="onb-connect" data-k="${p.k}" data-to="done">Confirm in popup</button>`
        : `<button class="ictl ${p.rec?'signal':''}" data-act="onb-connect" data-k="${p.k}" data-to="connecting">Connect</button>`;
      return `<div class="onb-plat ${st}">
        <span class="onb-plat-ic">${G.plug}</span>
        <div class="onb-plat-body"><div class="onb-plat-t">${p.label} ${badge}</div>
          <div class="onb-plat-s">${p.identity} · ${p.blurb}</div>
          <div class="onb-plat-note mono">Provisions a native identity — its own actor, never a human seat.</div></div>
        ${action}</div>`;
    };
    const ready = connected === 'done';
    return shell(`<div class="onb-card step">
      <button class="onb-back" data-act="onb-go" data-v="welcome">${G.back} Back</button>
      <span class="onb-eyebrow mono">Step 1 of 2 · Connect</span>
      <h1>Where should your team work?</h1>
      <p class="onb-lead">Connect your first platform. You can add the others anytime. We lead with <b>Shortcut</b> — assign a Story and Tasca routes it to a capable agent.</p>
      <div class="onb-platlist">${plats.map(card).join('')}</div>
      <div class="onb-nav">
        <span class="mono dim">${ready ? 'Connected — next, hire an agent.' : 'Connect one platform to continue.'}</span>
        <button class="btn-add ${ready?'':'is-disabled'}" data-act="${ready?'onb-go':'noop'}" data-v="hire">Continue ${G.arrow}</button></div>
    </div>`, { steps: 'connect' });
  }

  // ── STEP 2 · HIRE FIRST AGENT (condensed) ──────────────────────────────────
  function hire(state) {
    const h = state.hire || {};
    const name = h.name || '';
    const vendorPicked = h.vendor;
    const deployed = h.deployed;
    const initials = (name || 'A1').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const vendors = [
      { k: 'claude', label: 'Claude', sub: 'Anthropic' },
      { k: 'openai', label: 'OpenAI', sub: 'GPT-4.1' },
      { k: 'local', label: 'Local', sub: 'Ollama · $0' },
    ];
    const canDeploy = name && vendorPicked;
    return shell(`<div class="onb-card step">
      <button class="onb-back" data-act="onb-go" data-v="connect">${G.back} Back</button>
      <span class="onb-eyebrow mono">Step 2 of 2 · Hire</span>
      <h1>Hire your first agent</h1>
      <p class="onb-lead">Agents are teammates — give it a name, an engine, and deploy its identity into ${state.target ? cap(state.target) : 'your platform'}.</p>

      <div class="onb-hire-grid">
        <div class="ohg-field"><label class="ohg-l">Name</label>
          <div class="ohg-name"><span class="av-lg" id="onb-av">${initials}</span>
            <input class="tinput" data-act="onb-name" placeholder="e.g. Nova" value="${name}"></div></div>
        <div class="ohg-field"><label class="ohg-l">Engine</label>
          <div class="ohg-vendors">${vendors.map(v => `<button class="ohg-vendor ${vendorPicked===v.k?'on':''}" data-act="onb-vendor" data-v="${v.k}">
            <span class="ohg-vg">${U.VG[v.k]}</span><span class="ohg-vt">${v.label}</span><span class="ohg-vs mono">${v.sub}</span></button>`).join('')}</div></div>
      </div>

      <div class="onb-deploy ${deployed?'done':''}">
        <div class="ond-row"><span class="onb-plat-ic sm">${G.plug}</span>
          <div><div class="onb-plat-t">${state.target?cap(state.target):'Platform'} identity</div>
            <div class="onb-plat-s">${deployed?`Provisioned · ${name||'agent'} acts as its own ${state.target==='github'?'GitHub App':state.target==='linear'?'app actor':'agent user'}`:'Deploy a native identity for this agent — never impersonating a human.'}</div></div>
          ${deployed?`<span class="onb-check">${G.check}</span>`:`<button class="ictl signal ${canDeploy?'':'is-disabled'}" data-act="${canDeploy?'onb-deploy':'noop'}">Deploy identity</button>`}</div>
      </div>

      <div class="onb-nav">
        <span class="mono dim">${deployed?'Ready — meet your team.':'Name, engine, and deploy to finish.'}</span>
        <button class="btn-add ${deployed?'':'is-disabled'}" data-act="${deployed?'onb-go':'noop'}" data-v="done">Finish ${G.arrow}</button></div>
    </div>`, { steps: 'hire' });
  }

  // ── DONE → hands into the app ──────────────────────────────────────────────
  function done(state) {
    const name = (state.hire && state.hire.name) || 'Your agent';
    return shell(`<div class="onb-card done-card">
      <div class="done-badge">${G.check}</div>
      <h1>${name} is on the team</h1>
      <p class="onb-lead">Your first agent is deployed with a native identity in ${state.target?cap(state.target):'your platform'} and ready to receive work. Assign it a task and Tasca routes by capability — you’ll see every decision.</p>
      <div class="done-actions">
        <a class="btn-add lg" href="Tasca.html">Go to your team ${G.arrow}</a>
        <button class="ictl" data-act="onb-go" data-v="connect">Connect another platform</button>
      </div>
      <div class="done-hint mono">You can hire more agents, connect platforms, and watch everything in Monitoring.</div>
    </div>`);
  }

  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  const STEP = { login, welcome, connect, hire, done };
  function render(state) { return (STEP[state.step] || login)(state); }
  window.ONB = { render };
})();
