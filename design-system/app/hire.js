/* TASCA app · Hire an agent — creation + per-platform deploy/identity flow.
   A 5-step wizard rendered as one surface; step state lives in ctx.hire.
   Steps: 1 Identity · 2 Vendor+model · 3 Capability · 4 Limits · 5 Deploy/provision.
   window.HIRE.render(ctx)  ·  ctx.hire = { step, name, avatar, vendor, model,
     minTier, maxTier, specialties[], concurrency, ceiling, platforms{} } */
(function () {
  const D = window.DATA, U = window.UI;

  const STEPS = [
    { k: 'identity',   n: 'Identity' },
    { k: 'vendor',     n: 'Engine' },
    { k: 'capability', n: 'Capability' },
    { k: 'limits',     n: 'Limits' },
    { k: 'deploy',     n: 'Deploy' },
  ];

  const VENDORS = {
    claude: { label: 'Claude', sub: 'Anthropic API', models: ['Opus 4.1', 'Sonnet 4.5', 'Haiku 4'] },
    openai: { label: 'OpenAI', sub: 'OpenAI API', models: ['GPT-4.1', 'GPT-4.1 mini', 'o4-mini'] },
    local:  { label: 'Local · BYO', sub: 'Your hardware', models: [] },
  };
  const RUNTIMES = {
    ollama:    { label: 'Ollama', sub: 'localhost:11434', models: ['llama3.1:70b', 'qwen2.5-coder:32b', 'deepseek-coder-v2'] },
    lmstudio:  { label: 'LM Studio', sub: 'localhost:1234', models: ['qwen2.5-coder', 'codestral-22b', 'llama3.1-8b'] },
    mlx:       { label: 'MLX', sub: 'Apple silicon', models: ['Qwen2.5-Coder-32B-MLX', 'Llama-3.1-8B-MLX'] },
  };
  const SPECIALTIES = ['TypeScript', 'Python', 'Go', 'Rust', 'React', 'Node', 'SQL', 'Migrations', 'Auth', 'Security', 'API', 'Edge', 'Infra', 'Tests', 'Docs'];
  const PLATFORMS = {
    shortcut: { label: 'Shortcut', identity: 'Agent user', detail: 'Creates a dedicated agent user. The agent comments, moves stories, and opens PRs as this user — distinct from any human seat.', cta: 'Create agent user', step: 'Provisioning agent user' },
    github:   { label: 'GitHub', identity: 'GitHub App install', detail: 'Installs the Tasca GitHub App scoped to selected repos. The agent acts as a bot identity with least-privilege checks + PR permissions.', cta: 'Install GitHub App', step: 'Installing app · selecting repos' },
    linear:   { label: 'Linear', identity: 'Actor = app', detail: 'Registers the agent as an application actor. Issue activity is attributed to the app, never impersonating a teammate.', cta: 'Authorize in Linear', step: 'Registering app actor' },
  };

  // ── step rail ──────────────────────────────────────────────────────────────
  function rail(cur) {
    return `<div class="hire-rail">${STEPS.map((s, i) => {
      const idx = STEPS.findIndex(x => x.k === cur);
      const cls = i < idx ? 'done' : i === idx ? 'active' : '';
      return `<button class="hstep ${cls}" data-act="hire-goto" data-v="${s.k}">
        <span class="hstep-dot">${i < idx ? '✓' : i + 1}</span><span class="hstep-n">${s.n}</span></button>`;
    }).join('<span class="hstep-line"></span>')}</div>`;
  }

  const field = (label, sub, control) => `<div class="field"><div class="field-l">${label}${sub ? `<span class="field-s">${sub}</span>` : ''}</div>${control}</div>`;

  // ── steps ────────────────────────────────────────────────────────────────
  function stepIdentity(h) {
    const initials = (h.name || 'New agent').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const palette = ['signal', 'green', 'purple', 'teal', 'amber'];
    return `<div class="hcard">
      <div class="hc-head"><h2>Name your agent</h2><p>Agents are team members — give it a name and a face. You'll address it like a colleague.</p></div>
      <div class="identity-row">
        <div class="av-xl ${h.avatar==='green'?'local':''}" id="hire-av" style="${avStyle(h.avatar)}">${initials}</div>
        <div style="flex:1">
          ${field('Name', '', `<input class="tinput" data-act="hire-name" placeholder="e.g. Nova, Sable, Atlas…" value="${h.name||''}">`)}
          <div class="field"><div class="field-l">Accent</div><div class="swatchrow">
            ${palette.map(c => `<button class="swatch ${h.avatar===c?'on':''}" data-act="hire-avatar" data-v="${c}" style="${swatchStyle(c)}" title="${c}"></button>`).join('')}</div></div>
        </div></div></div>`;
  }
  function avStyle(c) {
    const map = { signal: '--signal', green: '--green', purple: '--purple', teal: '--teal', amber: '--amber' };
    const v = map[c] || '--signal';
    return `background:color-mix(in srgb,var(${v}) 16%,var(--surface));border-color:color-mix(in srgb,var(${v}) 42%,transparent);color:var(${v})`;
  }
  function swatchStyle(c) { const map = { signal: '--signal', green: '--green', purple: '--purple', teal: '--teal', amber: '--amber' }; return `background:var(${map[c]})`; }

  function stepVendor(h) {
    const vcards = Object.entries(VENDORS).map(([k, v]) => `<button class="optcard ${h.vendor===k?'on':''}" data-act="hire-vendor" data-v="${k}">
        <span class="optcard-ic">${U.VG[k] ? `<span class="vglyph">${U.VG[k]}</span>` : U.VG.local}</span>
        <span class="optcard-t">${v.label}</span><span class="optcard-s">${v.sub}</span>
        ${h.vendor===k?'<span class="optcard-check">✓</span>':''}</button>`).join('');

    let modelPicker = '';
    if (h.vendor === 'local') {
      const rt = h.runtime || 'ollama';
      modelPicker = `<div class="field"><div class="field-l">Local runtime<span class="field-s">Bring your own model — runs on your hardware, $0 per token</span></div>
        <div class="seg rt-seg">${Object.entries(RUNTIMES).map(([k, r]) => `<button class="seg-b ${rt===k?'on':''}" data-act="hire-runtime" data-v="${k}">${r.label}</button>`).join('')}</div>
        <div class="rt-meta mono dim">${RUNTIMES[rt].sub} · ${RUNTIMES[rt].models.length} models detected</div></div>
        ${field('Model', '', modelSelect(RUNTIMES[rt].models, h.model))}`;
    } else if (h.vendor) {
      modelPicker = field('Model', '', modelSelect(VENDORS[h.vendor].models, h.model));
    }
    return `<div class="hcard">
      <div class="hc-head"><h2>Pick the engine</h2><p>Which model powers this agent. Vendor stays neutral in the UI — capability and cost are what route work.</p></div>
      <div class="optgrid three">${vcards}</div>
      ${modelPicker}</div>`;
  }
  function modelSelect(models, sel) {
    if (!models.length) return `<div class="we-s">Select a runtime to list detected models.</div>`;
    return `<div class="modelrow">${models.map(m => `<button class="modelchip ${sel===m?'on':''}" data-act="hire-model" data-v="${m}">${m}</button>`).join('')}</div>`;
  }

  function stepCapability(h) {
    const tiers = D.TIER_NAMES.slice(1);
    const min = h.minTier || 1, max = h.maxTier || 3;
    const cells = tiers.map((t, i) => { const lvl = i + 1; const inRange = lvl >= min && lvl <= max;
      return `<button class="tiercell ${inRange?'on t-'+lvl:''}" data-act="hire-tier" data-v="${lvl}"><span class="tc-bar"></span><span class="tc-lab">${t}</span></button>`; }).join('');
    return `<div class="hcard">
      <div class="hc-head"><h2>Capability profile</h2><p>The tier range this agent is trusted to take, and the skills the router weighs. Click two tiers to set the range.</p></div>
      ${field('Tier range', `${D.TIER_NAMES[min]} → ${D.TIER_NAMES[max]}`, `<div class="tierpick">${cells}</div>`)}
      <div class="field"><div class="field-l">Specialties<span class="field-s">Bias routing toward matching work</span></div>
        <div class="speclist pick">${SPECIALTIES.map(s => `<button class="spec ${(h.specialties||[]).includes(s)?'on':''}" data-act="hire-spec" data-v="${s}">${s}</button>`).join('')}</div></div></div>`;
  }

  function stepLimits(h) {
    const conc = h.concurrency || 2;
    return `<div class="hcard">
      <div class="hc-head"><h2>Limits & guardrails</h2><p>Concurrency and spend ceilings. The breaker trips automatically when these are hit — control is built in, not bolted on.</p></div>
      ${field('Max concurrent tasks', `${conc} ${conc===1?'slot':'slots'}`, `<div class="steprow">
        <button class="stepbtn" data-act="hire-conc" data-v="dec">−</button><span class="stepval mono">${conc}</span><button class="stepbtn" data-act="hire-conc" data-v="inc">+</button>
        <span class="barmeter wide"><span style="width:${conc/5*100}%"></span></span></div>`)}
      ${h.vendor === 'local'
        ? `<div class="field"><div class="field-l">Cost ceiling</div><div class="local-cap">${U.VG.local}<span>Local engine · no token cost. Bounded by your hardware, not a dollar cap.</span></div></div>`
        : field('Daily cost ceiling', 'Hard stop — agent pauses when reached', `<div class="caprow">${[10,20,40].map(v=>`<button class="capchip ${(h.ceiling||20)===v?'on':''}" data-act="hire-cap" data-v="${v}">$${v}<span>/ day</span></button>`).join('')}</div>`)}
    </div>`;
  }

  function stepDeploy(h) {
    const cards = Object.entries(PLATFORMS).map(([k, p]) => {
      const st = (h.platforms && h.platforms[k]) || 'idle'; // idle · connecting · done
      const badge = st === 'done'
        ? `<span class="prov-badge done"><span class="d"></span>Provisioned</span>`
        : st === 'connecting'
        ? `<span class="prov-badge work"><span class="d"></span>${p.step}…</span>`
        : `<span class="prov-badge"><span class="d"></span>Not deployed</span>`;
      const action = st === 'done'
        ? `<button class="ictl" data-act="hire-deploy" data-v="${k}" data-to="idle">Disconnect</button>`
        : st === 'connecting'
        ? `<button class="ictl signal" data-act="hire-deploy" data-v="${k}" data-to="done">Confirm in popup</button>`
        : `<button class="ictl signal" data-act="hire-deploy" data-v="${k}" data-to="connecting">${p.cta} ${U.I.arrow}</button>`;
      return `<div class="provcard ${st}">
        <div class="prov-top"><div><span class="plat-tag">${p.label}</span><span class="prov-identity">${p.identity}</span></div>${badge}</div>
        <p class="prov-detail">${p.detail}</p>
        <div class="prov-foot">${st==='done'?`<span class="mono dim">acts as · ${h.name?h.name.toLowerCase():'agent'}-${k==='github'?'[bot]':'agent'}</span>`:'<span></span>'}${action}</div></div>`;
    }).join('');
    const done = h.platforms ? Object.values(h.platforms).filter(s => s === 'done').length : 0;
    return `<div class="hcard wide">
      <div class="hc-head"><h2>Deploy & provision identities</h2><p>Each platform gets a <b>native identity</b> for ${h.name||'this agent'} — never impersonating a human. Deploy to one now or all three; you can add more later.</p></div>
      <div class="provgrid">${cards}</div>
      <div class="prov-summary">${done>0?`<span class="prov-badge done"><span class="d"></span>${done} platform${done>1?'s':''} ready</span> — ${h.name||'Your agent'} can start receiving work.`:'Deploy to at least one platform so the router can assign work.'}</div></div>`;
  }

  const STEP_FN = { identity: stepIdentity, vendor: stepVendor, capability: stepCapability, limits: stepLimits, deploy: stepDeploy };

  // ── summary footer ──────────────────────────────────────────────────────
  function preview(h) {
    if (!h.name && !h.vendor) return '';
    const a = { in: (h.name||'NA').slice(0,2).toUpperCase(), vendor: h.vendor==='local'?'local':(h.vendor||'claude'), state: 'idle', minTier: h.minTier||1, maxTier: h.maxTier||3 };
    const accentAv = `<div class="av-md" style="${avStyle(h.avatar)}">${a.in}</div>`;
    return `<div class="hire-preview"><span class="hp-k mono">Preview</span>
      <span class="hp-card">${accentAv}<span class="hp-id"><span class="hp-name">${h.name||'Unnamed'}</span>
        <span class="hp-meta">${h.vendor?U.vendorChip({vendor:a.vendor}):''}${h.model?`<span class="mono dim">${h.model}</span>`:''}</span></span>
        ${h.minTier?U.tierRamp(a):''}</span></div>`;
  }

  function render(ctx) {
    const h = ctx.hire;
    const idx = STEPS.findIndex(s => s.k === h.step);
    const isLast = idx === STEPS.length - 1;
    const body = (STEP_FN[h.step] || stepIdentity)(h);
    return `<div class="vhead">
        <button class="vback" data-act="go-roster">${U.I.back} Your team</button>
        <div class="vh-main"><div class="vh-id"><div><div class="vh-eyebrow"><span class="mono dim">New team member</span></div>
          <div class="vh-name">Hire an agent</div></div></div></div></div>
      ${rail(h.step)}
      <div class="hire-body">${body}</div>
      ${preview(h)}
      <div class="hire-nav">
        <button class="ictl" data-act="hire-prev" ${idx===0?'disabled':''}>Back</button>
        ${isLast
          ? `<button class="btn-add" data-act="hire-finish">Add to roster</button>`
          : `<button class="btn-add" data-act="hire-next">Continue ${U.I.arrow}</button>`}
      </div>`;
  }

  window.HIRE = { render, STEPS, VENDORS, RUNTIMES, PLATFORMS };
})();
