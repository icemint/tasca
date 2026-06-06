// Typed UI string-builders — ported from the design system (app/ui.js `window.UI`).
// Pure functions returning HTML strings; the islands compose them and set
// innerHTML. Glyphs come from icons.ts; data shapes come from contract.ts. The
// builders adapt to the read-API shapes (no sample data — every value is real
// or an honest "—").

import { I, SG, VG } from './icons';
import type { Agent, AgentState, Capability, Platform, Tier, Vendor } from './contract';

export { I, SG, VG };

export const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Idle',
  working: 'Working',
  awaiting_input: 'Awaiting input',
  blocked: 'Blocked',
  shipped: 'Shipped',
};

// The design system's CSS/glyph token for each domain AgentState. The domain enum
// uses `awaiting_input`; the design system (roster.css `.astate-*`, ui.js `SG`)
// uses `awaiting`. This map bridges the two so the right class + glyph are emitted.
type StateToken = 'idle' | 'working' | 'awaiting' | 'blocked' | 'shipped';
const STATE_TOKEN: Record<AgentState, StateToken> = {
  idle: 'idle',
  working: 'working',
  awaiting_input: 'awaiting',
  blocked: 'blocked',
  shipped: 'shipped',
};

export const VENDOR_LABEL: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  local: 'Local',
};

export const PLATFORM_LABEL: Record<Platform, string> = {
  shortcut: 'Shortcut',
  github: 'GitHub',
  linear: 'Linear',
};

const TIER_RANK: Record<Tier, number> = { basic: 1, low: 2, medium: 3, hard: 4, ultra: 5 };
export const TIER_LABEL: Record<Tier, string> = {
  basic: 'BASIC',
  low: 'LOW',
  medium: 'MEDIUM',
  hard: 'HARD',
  ultra: 'ULTRA',
};

/** Escape text for safe interpolation into HTML (builders emit innerHTML). */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

/** Two-letter initials for an avatar tile, derived from the real agent name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

type AvSize = 'av-sm' | 'av-md' | 'av-lg' | 'av-xl';
export function avatar(a: { name: string; vendor: Vendor | string }, size: AvSize): string {
  const local = a.vendor === 'local' ? ' local' : '';
  return `<div class="${size}${local}" aria-hidden="true">${esc(initials(a.name))}</div>`;
}

export function vendorChip(vendor: Vendor | string): string {
  const glyph = (VG as Record<string, string>)[vendor] ?? VG.local;
  return `<span class="vendor">${glyph}${esc(VENDOR_LABEL[vendor] ?? vendor)}</span>`;
}

export function statePill(state: AgentState, solid = false): string {
  const tok = STATE_TOKEN[state] ?? 'idle';
  return `<span class="astate astate-${tok}${solid ? ' solid' : ''}">${SG[tok]}${esc(STATE_LABEL[state] ?? state)}</span>`;
}

/** Tier ramp — 5 ordered cells filled up to the agent's max capability. */
export function tierRamp(cap: Capability): string {
  if (!cap.maxTier) {
    return `<span class="tierbar"><span class="lab">Capability <b>—</b></span></span>`;
  }
  const min = cap.tiersCovered.length
    ? Math.min(...cap.tiersCovered.map((t) => TIER_RANK[t]))
    : 1;
  const max = TIER_RANK[cap.maxTier];
  let cells = '';
  for (let i = 1; i <= 5; i++) {
    cells += `<i class="${i >= min && i <= max ? 'on t-' + i : ''}"></i>`;
  }
  return `<span class="tierbar"><span class="cells" role="img" aria-label="Capability up to ${esc(TIER_LABEL[cap.maxTier])}">${cells}</span><span class="lab">to <b>${esc(TIER_LABEL[cap.maxTier])}</b></span></span>`;
}

export function tierTag(tier: Tier | null): string {
  if (!tier) return `<span class="tier"><span class="dot"></span>—</span>`;
  return `<span class="tier tier-${tier}"><span class="dot"></span>${esc(TIER_LABEL[tier])}</span>`;
}

export function platTag(platform: Platform): string {
  return `<span class="plat-tag">${esc(PLATFORM_LABEL[platform])}</span>`;
}

export function taskRef(id: string): string {
  return `<span class="mono ref">${esc(id)}</span>`;
}

/** A vendor-neutral state-glyph + label inline (used in compact rows). */
export function stateGlyph(state: AgentState): string {
  const tok = STATE_TOKEN[state] ?? 'idle';
  return `<span class="astate astate-${tok}">${SG[tok]}</span>`;
}

/** Map a percentage 0..1 success rate to a display string, honest when null. */
export function pct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export function money(v: number | null): string {
  return v === null ? '—' : v === 0 ? 'local · no cap' : `$${v} / day`;
}

export const agentVendor = (a: Agent): Vendor | string => a.vendor;
