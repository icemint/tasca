/* TASCA · Roster exploration — foundation + identity builders (plain JS).
   Exposes window.FC: three logo/mark directions + foundation reference panels
   (agent states, tier ramp, neutral vendor indicators, type). Uses RC helpers.
   Marks are pure geometry (bars / nodes / cells) — calm + infrastructural,
   readable from 16px favicon to hero. currentColor + one --signal accent. */
(function () {
  const RC = window.RC;

  // ── three marks (viewBox 0 0 32 32) ───────────────────────────────────────
  const MARKS = {
    stack: `<svg viewBox="0 0 32 32" width="100%" height="100%">
      <rect x="6" y="6.6" width="10" height="4.6" rx="2.3" fill="var(--signal)"/>
      <rect x="6" y="13.7" width="16" height="4.6" rx="2.3" fill="currentColor" opacity=".9"/>
      <rect x="6" y="20.8" width="20" height="4.6" rx="2.3" fill="currentColor" opacity=".5"/></svg>`,
    router: `<svg viewBox="0 0 32 32" width="100%" height="100%" fill="none">
      <rect x="3.5" y="11.8" width="8.8" height="8.8" rx="2.5" fill="var(--signal)"/>
      <path d="M12.3 16.2H16.4M16.4 8.5V23.9M16.4 8.5H20M16.4 16.2H20M16.4 23.9H20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="22.6" cy="8.5" r="2.6" fill="currentColor"/><circle cx="22.6" cy="16.2" r="2.6" fill="currentColor"/><circle cx="22.6" cy="23.9" r="2.6" fill="currentColor"/></svg>`,
    cluster: `<svg viewBox="0 0 32 32" width="100%" height="100%">
      <rect x="5.6" y="5.6" width="8.8" height="8.8" rx="2.7" fill="currentColor" opacity=".72"/>
      <rect x="17.6" y="5.6" width="8.8" height="8.8" rx="2.7" fill="var(--signal)"/>
      <rect x="5.6" y="17.6" width="8.8" height="8.8" rx="2.7" fill="currentColor" opacity=".72"/>
      <rect x="17.6" y="17.6" width="8.8" height="8.8" rx="2.7" fill="currentColor" opacity=".72"/></svg>`,
  };
  const MARK_META = {
    stack:   { letter: 'A', title: 'Stack', desc: 'Ordered bars — capability tiers ascending. Reads the routing ramp.' },
    router:  { letter: 'B', title: 'Router', desc: 'A node distributing work to agents. The coordination engine, literally.' },
    cluster: { letter: 'C', title: 'Cluster', desc: 'A roster of members, one active. The team as a grid of identities.' },
  };
  const markBox = (key, px) => `<span style="display:inline-grid;place-items:center;width:${px}px;height:${px}px;color:var(--fg)">${MARKS[key]}</span>`;
  const wordmark = (key, mk) => `<span style="display:inline-flex;align-items:center;gap:10px">
      ${markBox(key, mk)}<span style="font-family:var(--font-display);font-size:${mk * 0.86}px;font-weight:700;letter-spacing:-0.04em;line-height:1;color:var(--fg)">Tasca</span></span>`;

  function logoBoard(key) {
    const m = MARK_META[key];
    return `<div style="background:var(--bg);color:var(--fg-2);font-family:var(--font-body);height:100%;padding:26px;display:flex;flex-direction:column;gap:22px">
      <div>
        <div style="font-family:var(--font-mono);font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:var(--signal)">Direction ${m.letter}</div>
        <div style="font-family:var(--font-display);font-size:24px;font-weight:600;letter-spacing:-0.025em;color:var(--fg);margin-top:8px">${m.title}</div>
        <div style="font-size:13px;color:var(--fg-3);line-height:1.5;margin-top:8px;max-width:300px">${m.desc}</div>
      </div>
      <div style="display:flex;align-items:center;gap:24px;padding:22px;border:1px solid var(--line);border-radius:14px;background:var(--surface)">
        ${markBox(key, 72)}
        <div style="display:flex;flex-direction:column;gap:16px">${wordmark(key, 30)}
          <div style="font-family:var(--font-mono);font-size:11px;color:var(--fg-faint)">wordmark · Space Grotesk 700</div></div>
      </div>
      <div>
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--fg-4);margin-bottom:12px">Favicon · reads to 16px · both surfaces</div>
        <div style="display:flex;gap:12px">
          <div style="display:flex;align-items:center;gap:14px;padding:14px 18px;border:1px solid var(--line);border-radius:10px;background:var(--surface);flex:1">
            ${markBox(key, 32)}${markBox(key, 24)}${markBox(key, 16)}</div>
          <div data-theme="dark" style="display:grid;place-items:center;width:54px;border-radius:10px;background:#090D14;color:#F3F6FB">${markBox(key, 18)}</div>
          <div data-theme="light" style="display:grid;place-items:center;width:54px;border-radius:10px;background:#FFFFFF;border:1px solid #E2E8F0;color:#0F172A">${markBox(key, 18)}</div>
        </div>
      </div>
    </div>`;
  }

  // ── foundation panels ─────────────────────────────────────────────────────
  const fpanel = (inner) => `<div style="background:var(--bg);color:var(--fg-2);font-family:var(--font-body);height:100%;padding:26px;display:flex;flex-direction:column">${inner}</div>`;
  const ptitle = (kick, t) => `<div style="margin-bottom:20px"><div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:var(--signal)">${kick}</div>
      <div style="font-family:var(--font-display);font-size:20px;font-weight:600;letter-spacing:-0.02em;color:var(--fg);margin-top:7px">${t}</div></div>`;

  function statesPanel() {
    const rows = [
      { s: 'idle',     d: 'Available to route',        tok: '--state-idle' },
      { s: 'working',  d: 'Actively on a task',        tok: '--state-working' },
      { s: 'awaiting', d: 'Needs a human answer',      tok: '--state-awaiting' },
      { s: 'blocked',  d: 'Failed / stuck — intervene', tok: '--state-blocked' },
      { s: 'shipped',  d: 'Delivered, PR merged',      tok: '--state-shipped' },
    ];
    const r = (x) => `<div style="display:grid;grid-template-columns:150px 1fr auto;align-items:center;gap:16px;padding:13px 0;border-top:1px solid var(--line)">
      ${RC.statePill({ state: x.s }, true)}
      <span style="font-size:13px;color:var(--fg-3)">${x.d}</span>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--fg-faint)">${x.tok}</span></div>`;
    return fpanel(`${ptitle('Agent state', 'Team language, not exit codes')}
      <div style="font-size:13px;color:var(--fg-3);line-height:1.5;margin-bottom:6px;max-width:440px">Each state pairs a distinct <b style="color:var(--fg-2)">shape</b> with its colour and label — never colour alone, so it survives colour-blindness and greyscale.</div>
      ${rows.map(r).join('')}`);
  }

  function tierPanel() {
    const swatch = (i, name) => `<div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
        <div style="width:100%;height:30px;border-radius:7px;background:var(--tier-${name.toLowerCase()})"></div>
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.06em;color:var(--fg-3)"><b style="color:var(--fg-2)">${i}</b> ${name}</div></div>`;
    const names = ['BASIC', 'LOW', 'MEDIUM', 'HARD', 'ULTRA'];
    const examples = [2, 3, 5].map(mt => `<div style="display:flex;align-items:center;gap:14px;padding:9px 0">
        ${RC.tierRamp({ maxTier: mt })}<span style="font-family:var(--font-mono);font-size:11px;color:var(--fg-faint)">max ${RC.TIER_NAMES[mt]}</span></div>`).join('');
    return fpanel(`${ptitle('Capability tiers', 'An ordered ramp basic → ultra')}
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">${names.map((n, i) => swatch(i + 1, n)).join('')}</div>
      <div style="font-size:13px;color:var(--fg-3);line-height:1.5;margin:18px 0 4px;max-width:440px">In the UI, tier coverage is shown as a <b style="color:var(--fg-2)">fill level</b> — position encodes capability, so it never relies on hue alone:</div>
      ${examples}`);
  }

  function vendorPanel() {
    const r = (v, sub) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 0;border-top:1px solid var(--line)">
        ${RC.vendorChip({ vendor: v })}<span style="font-size:12px;color:var(--fg-faint)">${sub}</span></div>`;
    return fpanel(`${ptitle('Vendor indicators', 'Neutral by construction')}
      <div style="font-size:13px;color:var(--fg-3);line-height:1.5;margin-bottom:8px;max-width:380px">Multi-vendor neutrality: every indicator is the same muted ink. The <b style="color:var(--fg-2)">glyph shape</b> disambiguates — no vendor's brand colour dominates the console.</div>
      ${r('claude', 'diamond')}${r('openai', 'ring')}${r('local', 'terminal · Ollama / LM Studio / MLX')}`);
  }

  function typePanel() {
    return fpanel(`${ptitle('Type', 'One UI family + a load-bearing mono')}
      <div style="display:flex;flex-direction:column;gap:20px">
        <div><div style="font-family:var(--font-display);font-size:34px;font-weight:600;letter-spacing:-0.03em;color:var(--fg);line-height:1.05">Your AI dev team</div>
          <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fg-4);margin-top:8px">Space Grotesk · display / headings</div></div>
        <div><div style="font-size:15px;color:var(--fg-2);line-height:1.6;max-width:420px">Named, capable agents working in the tools you already use — routed by capability, visible and controllable at every step.</div>
          <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fg-4);margin-top:8px">Hanken Grotesk · UI / body</div></div>
        <div><div style="font-family:var(--font-mono);font-size:15px;color:var(--signal-2)">PR #4821 · req_8f2a91c · tier=HARD · 94.2%</div>
          <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fg-4);margin-top:8px">JetBrains Mono · logs · diffs · IDs · tokens</div></div>
      </div>`);
  }

  window.FC = { MARKS, logoBoard, statesPanel, tierPanel, vendorPanel, typePanel };
})();
