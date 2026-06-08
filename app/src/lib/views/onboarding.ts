// Onboarding (empty-state scaffold). A read-only preview of the connect → hire →
// deploy flow. All actions (connect / create / deploy) render visible-but-disabled
// behind the OFF flags. It reflects REAL connection state from GET /api/connections
// so a platform already connected shows as done; nothing here is fabricated.

import { getConnections } from '../api';
import { fromResult, type LoadResult } from '../mount';
import { I, PLATFORM_LABEL, esc, roControl, RO_GATE_SETUP } from '../ui';
import type { ConnectionPlatform, Platform } from '../contract';

const PLATFORMS: Platform[] = ['shortcut', 'github', 'linear'];

function platRow(platform: Platform, connected: ConnectionPlatform | undefined): string {
  const done = connected && connected.health !== 'revoked';
  return `<div class="onb-plat ${done ? 'done' : ''}">
    <div class="onb-plat-ic">${I.plug}</div>
    <div class="onb-plat-body">
      <div class="onb-plat-t">${esc(PLATFORM_LABEL[platform])}${platform === 'shortcut' ? '<span class="rec-pill">Recommended</span>' : ''}</div>
      <div class="onb-plat-s">${done ? `Connected · ${esc(connected!.workspaceId || 'workspace')}` : 'Not connected yet'}</div>
    </div>
    ${done
      ? `<span class="onb-check" role="img" aria-label="Connected">${I.chevron}</span>`
      : roControl('Connect', { cls: 'ictl signal', gate: RO_GATE_SETUP })}
  </div>`;
}

export async function loadOnboarding(): Promise<LoadResult> {
  const res = await getConnections();
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

    const platlist = `<div class="onb-platlist">${PLATFORMS.map((p) => platRow(p, byPlatform.get(p))).join('')}</div>`;

    const html = `<div style="max-width:680px;margin:0 auto">
      <div class="onb-eyebrow">Getting started</div>
      <h1>Set up your AI dev team</h1>
      <p class="onb-lead">Three steps to a working team. Connect a platform, hire your first agent, and let routing take it from there.</p>
      ${steps}
      <div class="conn-sec-h" style="margin-top:30px"><span class="csh-t">Connect a platform</span></div>
      ${platlist}
      <div class="onb-nav">
        <span class="mono dim">This is a read-only preview. Setup actions are operator-run today.</span>
        ${roControl('Continue', { cls: 'btn-add lg', gate: RO_GATE_SETUP })}
      </div>
    </div>`;
    return { kind: 'ok', html };
  });
}
