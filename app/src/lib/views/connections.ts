// Connections. Per-platform health + 24h webhook delivery counters from GET /api/connections.
// Connect-a-workspace (slice W4-S3) is a live admin+ control that begins the GitHub App install
// (GET /api/connect/github — a redirect-out, not an in-page write). Per-card Manage / Repair stay
// gated (they need disconnect/re-auth backends — a follow-up). Counters are real (webhook ledger).

import { getConnections, canManageActiveOrg, connectGitHub } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, PLATFORM_LABEL, esc, roControl, RO_GATE_SETUP, RO_GATE_ADMIN_CONNECT } from '../ui';
import type { ConnectionPlatform } from '../contract';

/** The "Connect GitHub" control — live for admin+, otherwise disabled with the honest reason. */
function connectControl(canManage: boolean): string {
  if (!canManage) return roControl('Connect GitHub', { icon: I.plus, cls: 'btn-add', gate: RO_GATE_ADMIN_CONNECT });
  return `<button class="btn-add conn-connect" type="button" data-act="connect-github" aria-label="Connect a GitHub workspace">${I.plus} Connect GitHub</button>`;
}

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
  const [res, canManage] = await Promise.all([getConnections(), canManageActiveOrg()]);
  return fromResult(res, (data) => {
    const platforms = data.platforms ?? [];
    const head = `<div class="roster-head"><div><h1>Connections</h1><div class="sub">Platform integrations and their delivery health</div></div>${connectControl(canManage)}</div>`;

    if (!platforms.length) {
      return {
        kind: 'empty',
        html:
          head +
          empty(
            'No connections yet',
            'Connect GitHub to deploy your agents into the tools your team already uses.',
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

/** Wire the live connect control. Connect is a NAVIGATION (redirect to GitHub), not a reconciling
 *  write — show a brief pending state, then leave the app; the Setup URL returns the user. */
export function wireConnections(el: HTMLElement): void {
  el.querySelectorAll<HTMLButtonElement>('[data-act="connect-github"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      connectGitHub();
    })
  );
}
