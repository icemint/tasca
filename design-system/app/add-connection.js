/* TASCA app · Add-connection flow — the surface Connections hands off to.
   Step 1: pick a platform (Shortcut/GitHub/Linear) or vendor (Anthropic/OpenAI/
   local endpoint). Step 2: the per-target connect/consent step, mirroring the
   hire wizard's provisioning cards, with real idle→connecting→connected→error.
   window.ADDCONN.render(ctx)  ·  ctx.addconn = { step, kind, target, status } */
(function () {
  const D = window.DATA, U = window.UI;

  const PLATFORMS = {
    shortcut: { label: 'Shortcut', identity: 'Agent user', blurb: 'Stories, comments, PR links',
      detail: 'Tasca creates a dedicated agent user in your workspace. Agents act as this user — distinct from any human seat. You authorize with a workspace API token.',
      consent: 'Authorize workspace token', step: 'Validating token · creating agent user', acts: 'agent user' },
    github: { label: 'GitHub', identity: 'GitHub App install', blurb: 'Repos, PRs, checks',
      detail: 'Installs the Tasca GitHub App scoped to the repos you select. Agents act as a least-privilege bot identity with PR + checks permissions — never your personal token.',
      consent: 'Install GitHub App', step: 'Opening GitHub · selecting repos', acts: 'GitHub App' },
    linear: { label: 'Linear', identity: 'Actor = app', blurb: 'Issues, projects, cycles',
      detail: 'Registers Tasca as an application actor via OAuth. Issue activity is attributed to the app, never impersonating a teammate. You consent to the requested scopes.',
      consent: 'Authorize in Linear', step: 'Redirecting to Linear OAuth', acts: 'app actor' },
  };
  const VENDORS = {
    anthropic: { vendor: 'claude', label: 'Anthropic', blurb: 'Claude · Opus / Sonnet / Haiku',
      detail: 'Paste an Anthropic API key. Tasca stores it encrypted and uses it only for agents you assign to Claude. Usage and spend show up under Billing.',
      consent: 'Validate & save key', step: 'Validating API key', cred: 'API key', ph: 'sk-ant-…' },
    openai: { vendor: 'openai', label: 'OpenAI', blurb: 'GPT-4.1 · o-series',
      detail: 'Paste an OpenAI API key. Stored encrypted, used only for agents assigned to OpenAI models. Rate limits and org quota are surfaced as connection health.',
      consent: 'Validate & save key', step: 'Validating API key', cred: 'API key', ph: 'sk-…' },
    local: { vendor: 'local', label: 'Local endpoint', blurb: 'Ollama · LM Studio · MLX',
      detail: 'Point Tasca at a local inference server. No key, no token cost — agents run on your hardware. Tasca probes the endpoint to confirm it’s reachable and lists models.',
      consent: 'Probe endpoint', step: 'Probing endpoint · listing models', cred: 'Endpoint URL', ph: 'localhost:11434' },
  };

  // ── step 1 · choose what to connect ───────────────────────────────────────
  function pick(c) {
    const card = (kind, key, o) => {
      const ic = kind === 'platform' ? U.I.plug : `<span class="vglyph">${U.VG[o.vendor]}</span>`;
      return `<button class="connpick" data-act="ac-pick" data-kind="${kind}" data-v="${key}">
        <span class="cp-ic ${kind==='vendor'?'vendor':''}">${ic}</span>
        <span class="cp-body"><span class="cp-t">${o.label}</span><span class="cp-s">${o.blurb}</span></span>
        <span class="cp-arr">${U.I.chevron}</span></button>`;
    };
    return `<div class="hcard wide">
      <div class="hc-head"><h2>Connect a platform</h2><p>Where your agents do work. Each gets a native identity — never impersonating a human teammate.</p></div>
      <div class="connpick-grid">${Object.entries(PLATFORMS).map(([k, o]) => card('platform', k, o)).join('')}</div>
      <div class="hc-head" style="margin-top:30px"><h2>Add a model vendor</h2><p>The engines behind your agents. Vendor stays neutral in the UI — capability and cost route work.</p></div>
      <div class="connpick-grid">${Object.entries(VENDORS).map(([k, o]) => card('vendor', k, o)).join('')}</div>
    </div>`;
  }

  // ── step 2 · connect / consent ─────────────────────────────────────────────
  function connect(c) {
    const isPlat = c.kind === 'platform';
    const o = isPlat ? PLATFORMS[c.target] : VENDORS[c.target];
    const st = c.status || 'idle'; // idle · connecting · connected · error
    const icon = isPlat ? U.I.plug : `<span class="vglyph">${U.VG[o.vendor]}</span>`;

    const badge = {
      idle:       `<span class="prov-badge"><span class="d"></span>Not connected</span>`,
      connecting: `<span class="prov-badge work"><span class="d"></span>${o.step}…</span>`,
      connected:  `<span class="prov-badge done"><span class="d"></span>Connected</span>`,
      error:      `<span class="prov-badge err"><span class="d"></span>Connection failed</span>`,
    }[st];

    // credential / consent input area (vendors take a key/URL; platforms consent via popup)
    let inputArea = '';
    if (!isPlat && (st === 'idle' || st === 'error')) {
      inputArea = `<div class="field" style="margin-top:16px"><div class="field-l">${o.cred}</div>
        <input class="tinput mono" data-act="ac-cred" placeholder="${o.ph}" value="${c.cred||''}"></div>`;
    } else if (isPlat && c.target === 'github' && (st === 'idle')) {
      inputArea = `<div class="repo-scope"><span class="rs-k mono">Repos to scope</span>
        <div class="rs-list">${['acme/api','acme/edge','acme/web','acme/billing'].map(r=>`<label class="rs-row"><span class="rs-check ${(c.repos||['acme/api','acme/edge']).includes(r)?'on':''}" data-act="ac-repo" data-v="${r}"></span><span class="mono">${r}</span></label>`).join('')}</div></div>`;
    }

    const errBlock = st === 'error'
      ? `<div class="conn-issue err" style="margin-top:16px"><div class="ci-head"><span class="ci-ico">${U.I.kebab}</span><span class="ci-title">${isPlat?'Authorization was cancelled or timed out':'That key was rejected (401)'}</span></div>
          <p class="ci-detail">${isPlat?'The consent popup closed before authorization completed. No identity was created. Try again — nothing was changed.':'The vendor rejected this credential. Check it’s active and has the right scope, then retry. The key is never stored until it validates.'}</p></div>`
      : '';

    const action = {
      idle:       `<button class="btn-add" data-act="ac-connect" data-to="connecting">${o.consent} ${U.I.arrow}</button>`,
      connecting: `<button class="btn-add" data-act="ac-connect" data-to="connected">${isPlat?'Confirm in popup':'Awaiting validation'}</button>`,
      connected:  `<button class="btn-add" data-act="ac-done">Done · view in Connections</button>`,
      error:      `<button class="btn-add" data-act="ac-connect" data-to="connecting">Retry</button>`,
    }[st];

    const successFoot = st === 'connected'
      ? `<div class="prov-summary"><span class="prov-badge done"><span class="d"></span>Ready</span> — ${o.label} is connected. ${isPlat?`Agents can now act as the ${o.acts}.`:`Assign agents to ${o.label} from any profile.`}</div>`
      : '';

    return `<div class="hcard wide">
      <button class="vback inline" data-act="ac-back">${U.I.back} Choose a different connection</button>
      <div class="connect-head">
        <span class="cp-ic ${isPlat?'':'vendor'} lg">${icon}</span>
        <div class="ch-id"><div class="ch-t">${o.label}</div><div class="ch-s mono dim">${isPlat?o.identity:'Model vendor'}</div></div>
        ${badge}</div>
      <p class="connect-detail">${o.detail}</p>
      ${inputArea}${errBlock}
      <div class="connect-foot">
        ${st==='idle' && !isPlat ? `<button class="ictl" data-act="ac-connect" data-to="error" title="Simulate a rejected credential">Try a bad key</button>` : '<span></span>'}
        ${action}</div>
      ${successFoot}</div>`;
  }

  function render(ctx) {
    const c = ctx.addconn;
    const head = `<div class="vhead"><button class="vback" data-act="ac-cancel">${U.I.back} Connections</button>
      <div class="vh-main"><div class="vh-id"><div><div class="vh-eyebrow"><span class="mono dim">New connection</span></div>
        <div class="vh-name">Add a connection</div></div></div></div></div>`;
    const body = c.step === 'connect' ? connect(c) : pick(c);
    return `${head}<div class="hire-body">${body}</div>`;
  }

  window.ADDCONN = { render, PLATFORMS, VENDORS };
})();
