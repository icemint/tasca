// Connections (read-only). Per-platform health + 24h webhook delivery counters
// from GET /api/connections. Repair / manage controls render visible-but-disabled.
// Counters are real (from the webhook ledger); a platform with no traffic shows
// honest zeros and "—" for last-received.

import { getConnections } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, PLATFORM_LABEL, esc, roControl, RO_GATE_SETUP } from '../ui';
import type { ConnectionPlatform } from '../contract';

const HEALTH_CLASS: Record<ConnectionPlatform['health'], string> = {
  healthy: 'ok',
  degraded: 'warn',
  revoked: 'off',
};
const HEALTH_LABEL: Record<ConnectionPlatform['health'], string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  revoked: 'Revoked',
};

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function card(c: ConnectionPlatform): string {
  const cls = HEALTH_CLASS[c.health];
  const w = c.webhook;
  const successRate =
    w.received24h > 0 ? `${Math.round((w.processed24h / w.received24h) * 100)}%` : '—';
  return `<div class="conncard ${cls === 'warn' ? 'warn' : ''}">
    <div class="conn-top">
      <div class="conn-id"><div class="conn-mark">${I.plug}</div>
        <div><div class="conn-name">${esc(PLATFORM_LABEL[c.platform])}</div><div class="conn-sub">${esc(c.workspaceId || '—')}</div></div></div>
      <span class="conn-status ${cls}"><span class="d"></span>${HEALTH_LABEL[c.health]}</span>
    </div>
    <div class="conn-metrics">
      <div class="cmetric"><span class="cm-dot" style="background:var(--green)"></span><div class="cm-body"><div class="cm-k">Webhooks (24h)</div><div class="cm-v">${w.received24h} received</div><div class="cm-s">${w.processed24h} processed · ${successRate}</div></div></div>
      <div class="cmetric"><span class="cm-dot" style="background:var(--fg-faint)"></span><div class="cm-body"><div class="cm-k">Last received</div><div class="cm-v">${relTime(w.lastReceivedAt)}</div></div></div>
    </div>
    <div class="conn-foot">
      <span class="mono dim">Read-only</span>
      <div class="conn-actions">${roControl('Manage', { gate: RO_GATE_SETUP })}${roControl('Repair', { cls: 'ictl signal', gate: RO_GATE_SETUP })}</div>
    </div>
  </div>`;
}

export async function loadConnections(): Promise<LoadResult> {
  const res = await getConnections();
  return fromResult(res, (data) => {
    const platforms = data.platforms ?? [];
    const head = `<div class="roster-head"><div><h1>Connections</h1><div class="sub">Platform integrations and their delivery health</div></div></div>`;

    if (!platforms.length) {
      return {
        kind: 'empty',
        html:
          head +
          empty(
            'No connections yet',
            'Connect Shortcut, GitHub or Linear to deploy your agents into the tools your team already uses.',
            I.plug
          ),
      };
    }
    return {
      kind: 'ok',
      html: `${head}<div class="conn-section"><div class="conngrid">${platforms.map(card).join('')}</div></div>`,
    };
  });
}
