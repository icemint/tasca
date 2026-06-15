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

/** The human-readable label for a task (QA item 325): its story title, falling back to the story ref —
 *  NEVER the raw task UUID. Used wherever a task is named to a user. The UUID stays in hrefs/ids for
 *  navigation, never in the visible label. */
export function taskLabel(t: { title: string | null; externalStoryId: string }): string {
  return t.title?.trim() || t.externalStoryId;
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

// ── read-only controls ────────────────────────────────────────────────────────
// Tasca is a READ-ONLY console today. Every mutating control renders through this
// one helper so the story is coherent (not stray "Coming soon" labels): a visible,
// clearly-disabled button with a consistent affordance and an HONEST reason. Two
// honest categories:
//   - default ("soon")  — the action ships with the write API (not yet built).
//   - gated             — blocked by a specific decision/operator step today; pass
//                         the reason so the tooltip + a11y label say so plainly.
export const RO_SOON = 'Read-only console — this action arrives with the write API';
/** Provisioning an agent identity is an operator-run step today (the provisioning
 *  CLI + a platform machine account), not a one-click UI action yet. */
export const RO_GATE_PROVISION = 'Agent provisioning is operator-run today';
/** Connecting/repairing a platform involves an OAuth / App-install step run by an
 *  operator today; the in-app setup flow is not enabled yet. */
export const RO_GATE_SETUP = 'Platform setup is operator-run today';
/** Admin-gated self-serve controls (slice W4-S3): a non-admin sees the control disabled with the
 *  honest reason (the server enforces the same gate — these are UX, not the security boundary). */
export const RO_GATE_ADMIN_CONNECT = 'Admin role required to connect a workspace';
export const RO_GATE_ADMIN_ROSTER = 'Admin role required to manage the roster';
/** Per-org vendor keys are set/replaced/removed by an admin (slice 3.5-A.2c.2); a non-admin
 *  sees the read-only status with this honest reason on the disabled control. */
export const RO_GATE_VENDOR_KEYS = 'Vendor keys are managed by an admin';
/** Workspace name + member roles are managed by an admin/owner (slice 3.5-B.2); a non-admin
 *  sees the read-only workspace with this honest reason on the disabled control. */
export const RO_GATE_WORKSPACE = 'Workspace settings are managed by an admin';
/** Inviting teammates is an admin+ action (slice 3.5-B.3.2); a non-admin never sees the invite
 *  section (the server enforces the same gate — this is the honest reason where a control shows). */
export const RO_GATE_INVITES = 'Invites are managed by an admin';
/** Editing an agent's profile/capability (Slice D #318/#337/#320/#329) is an admin+ action; a non-admin
 *  sees the read-only profile with this honest reason on the disabled Edit control (server-enforced too). */
export const RO_GATE_AGENT_EDIT = 'Agent settings are managed by an admin';
/** Setting/replacing an agent's platform credentials (Slice D #319) is an admin+ action; a non-admin
 *  sees the read-only credential status with this honest reason (the server enforces the same gate). */
export const RO_GATE_AGENT_CREDS = 'Agent credentials are managed by an admin';

/** Render a mutating control in the read-only console: visible-but-disabled, with a
 *  consistent class hook (`.ro-ctl` + `data-ro`) and an honest reason surfaced to
 *  both sighted users (title) and assistive tech (aria-label). `cls` is the full
 *  base class list so each call keeps its existing styling (ictl / btn-add / …). */
export function roControl(
  label: string,
  opts: { icon?: string; cls?: string; gate?: string } = {}
): string {
  const reason = opts.gate ?? RO_SOON;
  const cls = `${opts.cls ?? 'ictl'} ro-ctl`;
  const kind = opts.gate ? 'gated' : 'soon';
  const body = `${opts.icon ? opts.icon + ' ' : ''}${esc(label)}`;
  return `<button class="${cls}" type="button" disabled aria-disabled="true" data-ro="${kind}" aria-label="${esc(label)} — ${esc(reason)}" title="${esc(reason)}">${body}</button>`;
}
