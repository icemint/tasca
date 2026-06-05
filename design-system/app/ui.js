/* TASCA app · shared UI helpers (plain JS string builders). window.UI */
(function () {
  const D = window.DATA;

  // Router mark (locked logo · direction B) ──────────────────────────────────
  const MARK = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="3.5" y="11.8" width="8.8" height="8.8" rx="2.5" fill="var(--signal)"/>
    <path d="M12.3 16.2H16.4M16.4 8.5V23.9M16.4 8.5H20M16.4 16.2H20M16.4 23.9H20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="22.6" cy="8.5" r="2.6" fill="currentColor"/><circle cx="22.6" cy="16.2" r="2.6" fill="currentColor"/><circle cx="22.6" cy="23.9" r="2.6" fill="currentColor"/></svg>`;

  const I = {
    search:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3" stroke-linecap="round"/></svg>',
    bell:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 6a3 3 0 016 0c0 3 1.2 4 1.2 4H3.8S5 9 5 6Z" stroke-linejoin="round"/><path d="M6.6 13a1.6 1.6 0 002.8 0" stroke-linecap="round"/></svg>',
    plus:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3v10M3 8h10" stroke-linecap="round"/></svg>',
    kebab:'<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="12.5" r="1.4"/></svg>',
    roster:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="11" y="3" width="6" height="6" rx="1.5"/><rect x="3" y="11" width="6" height="6" rx="1.5"/><rect x="11" y="11" width="6" height="6" rx="1.5"/></svg>',
    monitor:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11h3l2-6 3 12 2-7 1.5 4H18"/></svg>',
    plug:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M7 3v4M13 3v4M5 7h10v2a5 5 0 01-10 0V7ZM10 14v3"/></svg>',
    gear:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg>',
    spark:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6Z"/></svg>',
    grid:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg>',
    rows:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>',
    back:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3L4 8l5 5"/></svg>',
    arrow:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M8 4l4 4-4 4"/></svg>',
    pause:'<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>',
    pr:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M4 6v4M12 10V8a2 2 0 00-2-2H7" stroke-linecap="round"/></svg>',
    empty:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="5" width="7" height="7" rx="1.5"/><rect x="13" y="5" width="7" height="7" rx="1.5"/><rect x="4" y="14" width="7" height="6" rx="1.5" stroke-dasharray="2 2"/><rect x="13" y="14" width="7" height="6" rx="1.5" stroke-dasharray="2 2"/></svg>',
    chevron:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
  };

  const SG = {
    idle:'<svg class="g" viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="3.7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    working:'<svg class="g" viewBox="0 0 11 11"><circle class="pulse" cx="5.5" cy="5.5" r="3.4" fill="currentColor"/></svg>',
    awaiting:'<svg class="g" viewBox="0 0 11 11"><path d="M5.5 1.2 10 9.6H1Z" fill="currentColor"/></svg>',
    blocked:'<svg class="g" viewBox="0 0 11 11"><rect x="1.4" y="1.4" width="8.2" height="8.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.4 3.4l4.2 4.2" stroke="currentColor" stroke-width="1.5"/></svg>',
    shipped:'<svg class="g" viewBox="0 0 11 11"><path d="M1.6 5.7 4.3 8.5 9.4 2.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    queued:'<svg class="g" viewBox="0 0 11 11"><rect x="1.6" y="1.6" width="7.8" height="7.8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.2 1.8"/></svg>',
  };
  const STATE_LABEL = { idle:'Idle', working:'Working', awaiting:'Awaiting input', blocked:'Blocked', shipped:'Shipped', queued:'Queued' };
  const VG = {
    claude:'<svg viewBox="0 0 11 11"><path d="M5.5 1 10 5.5 5.5 10 1 5.5Z" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    openai:'<svg viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/></svg>',
    local:'<svg viewBox="0 0 11 11"><rect x="1.4" y="1.7" width="8.2" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.3 4.1 4.7 5.5 3.3 6.9M5.8 6.9H7.7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
  };
  const VENDOR_LABEL = { claude:'Claude', openai:'OpenAI', local:'Local' };
  const PLATFORM_LABEL = { shortcut:'Shortcut', github:'GitHub', linear:'Linear' };

  const av = (a, size) => `<div class="${size} ${a.vendor==='local'?'local':''}" aria-hidden="true">${a.in}</div>`;
  const vendorChip = (a) => `<span class="vendor">${VG[a.vendor]}${VENDOR_LABEL[a.vendor]}</span>`;
  const statePill = (a, solid) => `<span class="astate astate-${a.state} ${solid?'solid':''}">${SG[a.state]}${STATE_LABEL[a.state]}</span>`;
  const tierRamp = (a) => {
    let cells=''; for (let i=1;i<=5;i++) cells += `<i class="${i>=a.minTier&&i<=a.maxTier?'on t-'+i:''}"></i>`;
    return `<span class="tierbar"><span class="cells" role="img" aria-label="Capability ${D.TIER_NAMES[a.minTier]} to ${D.TIER_NAMES[a.maxTier]}">${cells}</span><span class="lab">to <b>${D.TIER_NAMES[a.maxTier]}</b></span></span>`;
  };
  const tierTag = (t) => `<span class="tier tier-${D.TIER_NAMES[t].toLowerCase()}"><span class="dot"></span>${D.TIER_NAMES[t]}</span>`;
  const taskTitle = (id) => { const t = D.TASKS[id]; return t ? t.title : id; };
  const taskRef = (id) => `<span class="mono ref">${id}</span>`;

  // tiny sparkline (success history) → inline svg
  const spark = (vals, w, h) => {
    const min = Math.min(...vals)-1, max = Math.max(...vals)+1, rng = max-min || 1;
    const pts = vals.map((v,i)=>`${(i/(vals.length-1)*w).toFixed(1)},${(h-((v-min)/rng)*h).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none" preserveAspectRatio="none"><polyline points="${pts}" stroke="var(--signal)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };

  window.UI = { MARK, I, SG, VG, STATE_LABEL, VENDOR_LABEL, PLATFORM_LABEL,
    av, vendorChip, statePill, tierRamp, tierTag, taskTitle, taskRef, spark };
})();
