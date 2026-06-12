// Onboarding — the connect → hire → deploy flow. GitHub connect is LIVE (slice W4-S3): admin+ can
// begin the App install (GET /api/connect/github, a redirect-out); Shortcut/Linear stay gated until
// their adapters ship. Continue routes into the app. Real connection state from GET /api/connections
// drives the done-checks; nothing here is fabricated.

import { getConnections, canManageActiveOrg, connectGitHub, APP_HOME } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { I, PLATFORM_LABEL, esc, roControl, RO_GATE_SETUP, RO_GATE_ADMIN_CONNECT } from '../ui';
import type { ConnectionPlatform, Platform } from '../contract';

const PLATFORMS: Platform[] = ['shortcut', 'github', 'linear'];

/** The per-platform connect affordance. GitHub is live (admin+ → a navigation control; non-admin →
 *  disabled with the honest reason). Shortcut/Linear stay gated (no connect flow yet). */
function connectAffordance(platform: Platform, canManage: boolean): string {
  if (platform !== 'github') return roControl('Connect', { cls: 'ictl signal', gate: RO_GATE_SETUP });
  if (!canManage) return roControl('Connect', { cls: 'ictl signal', gate: RO_GATE_ADMIN_CONNECT });
  return `<button class="ictl signal onb-connect" type="button" data-act="connect-github" aria-label="Connect a GitHub workspace">Connect</button>`;
}

function platRow(platform: Platform, connected: ConnectionPlatform | undefined, canManage: boolean): string {
  const done = connected && connected.health !== 'revoked';
  return `<div class="onb-plat ${done ? 'done' : ''}">
    <div class="onb-plat-ic">${I.plug}</div>
    <div class="onb-plat-body">
      <div class="onb-plat-t">${esc(PLATFORM_LABEL[platform])}${platform === 'shortcut' ? '<span class="rec-pill">Recommended</span>' : ''}</div>
      <div class="onb-plat-s">${done ? `Connected · ${esc(connected!.workspaceId || 'workspace')}` : 'Not connected yet'}</div>
    </div>
    ${done
      ? `<span class="onb-check" role="img" aria-label="Connected">${I.chevron}</span>`
      : connectAffordance(platform, canManage)}
  </div>`;
}

export async function loadOnboarding(): Promise<LoadResult> {
  const [res, canManage] = await Promise.all([getConnections(), canManageActiveOrg()]);
  return fromResult(res, (data) => {
    const byPlatform = new Map(data.platforms.map((p) => [p.platform, p]));
    const steps = `
      <div class="onb-steps-preview">
        <div class="osp"><span class="osp-n">1</span><div class="osp-ic">${I.plug}</div><div><div class="osp-t">Connect a platform</div><div class="osp-d">Link Shortcut, GitHub or Linear so agents work where your team already does.</div></div></div>
        <div class="osp-line"></div>
        <div class="osp"><span class="osp-n">2</span><div class="osp-ic">${I.roster}</div><div><div class="osp-t">Hire an agent</div><div class="osp-d">Pick a vendor and model; Tasca gives the agent a name and a native identity.</div></div></div>
        <div class="osp-line"></div>
        <div class="osp"><span class="osp-n">3</span><div class="osp-ic">${I.spark}</div><div><div class="osp-t">Deploy &amp; route</div><div class="osp-d">The routing engine assigns incoming work to the best-fit agent automatically.</div></div></div>
      </div>`;

    const platlist = `<div class="onb-platlist">${PLATFORMS.map((p) => platRow(p, byPlatform.get(p), canManage)).join('')}</div>`;

    const html = `<div style="max-width:680px;margin:0 auto">
      <div class="onb-eyebrow">Getting started</div>
      <h1>Set up your AI dev team</h1>
      <p class="onb-lead">Three steps to a working team. Connect a platform, hire your first agent, and let routing take it from there.</p>
      ${steps}
      <div class="conn-sec-h" style="margin-top:30px"><span class="csh-t">Connect a platform</span></div>
      ${platlist}
      <div class="onb-nav">
        <span class="mono dim">Connect GitHub above, then hire an agent from your roster.</span>
        <button class="btn-add lg onb-continue" type="button" data-act="continue" aria-label="Continue to your team">Continue</button>
      </div>
    </div>`;
    return { kind: 'ok', html };
  });
}

/** Wire the live onboarding controls — both are NAVIGATIONS (connect → GitHub install; continue →
 *  the app home), not in-page writes. */
export function wireOnboarding(el: HTMLElement): void {
  el.querySelectorAll<HTMLButtonElement>('[data-act="connect-github"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.textContent = 'Connecting…';
      connectGitHub();
    })
  );
  el.querySelectorAll<HTMLButtonElement>('[data-act="continue"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      if (typeof location !== 'undefined') location.assign(APP_HOME);
    })
  );
}
