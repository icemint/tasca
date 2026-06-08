// Settings (C8) — a deliberately thin read-only shell. Billing / usage / audit /
// API keys are out of scope for this track; this page session-gates and shows an
// honest "not yet available" surface rather than fabricating any of those panels.

import type { LoadResult } from '../mount';
import { esc } from '../ui';

const SECTIONS = [
  { title: 'Workspace', desc: 'Name, members and defaults for your team.' },
  { title: 'Billing & usage', desc: 'Plan, invoices and per-agent spend.' },
  { title: 'API keys & credentials', desc: 'Vendor keys and platform tokens.' },
  { title: 'Audit log', desc: 'A record of every privileged agent action.' },
];

export async function loadSettings(): Promise<LoadResult> {
  const rows = SECTIONS.map(
    (s) =>
      `<div class="idrow"><div class="idp"><span class="idp-name">${esc(s.title)}</span><span class="idp-h">${esc(s.desc)}</span></div><span class="coming-tag">Planned</span></div>`
  ).join('');

  const html = `<div class="roster-head"><div><h1>Settings</h1><div class="sub">Workspace configuration</div></div></div>
    <div class="pcard" style="margin-top:22px;max-width:680px">
      <div class="pc-h">Configuration</div>
      <div class="pc-sub">These panels arrive as Tasca rolls them out for your workspace.</div>
      ${rows}
    </div>`;
  return { kind: 'ok', html };
}
