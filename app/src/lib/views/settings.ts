// Settings (C8). Two panels are now LIVE (slice 3.5-A.2c.2): "Vendor keys" lets an admin
// set / replace / remove a per-org vendor key (Anthropic today) WITHOUT ever seeing a stored
// key (the read shape carries only a status + a non-reversible fingerprint), and "Audit log"
// shows the credential governance trail (admin+). Workspace + Billing stay honest `Planned`
// rows. The key input is WRITE-ONLY: never pre-filled, never echoed, cleared + re-rendered
// from server truth on save.

import {
  getVendorCredentials,
  setVendorCredential,
  deleteVendorCredential,
  getCredentialAudit,
  canManageActiveOrg,
  type WriteResult,
} from '../api';
import { liveAction } from '../live';
import { error, empty } from '../states';
import type { LoadResult } from '../mount';
import { I, esc, roControl, RO_GATE_VENDOR_KEYS } from '../ui';
import type { ApiResult } from '../api';
import type { CredentialAuditEvent, VendorCredentialStatus, VendorCredentialsResponse } from '../contract';

const PROVIDER = 'anthropic';
const PROVIDER_LABEL = 'Anthropic';

// Deferred panels — unchanged honest "not yet available" rows.
const PLANNED = [
  { title: 'Workspace', desc: 'Name, members and defaults for your team.' },
  { title: 'Billing & usage', desc: 'Plan, invoices and per-agent spend.' },
];

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

/** The status badge — NEVER color-alone: a text label is always present, paired with a glyph
 *  (a check for Active, a hollow dash for Not configured) AND a token color. Reuses the
 *  connections `.conn-status.ok/.off` shape. */
function statusBadge(active: boolean): string {
  return active
    ? `<span class="conn-status ok"><span class="d"></span>Active</span>`
    : `<span class="conn-status off"><span class="d hollow"></span>Not configured</span>`;
}

/** The fingerprint, shown only when a key is active (`key ••••1a2b`), in mono. */
function fingerprint(fp: string | null): string {
  if (!fp) return '';
  return `<span class="vk-fp mono">key ••••${esc(fp)}</span>`;
}

function vendorRow(cred: VendorCredentialStatus, canManage: boolean): string {
  const active = cred.status === 'active';
  const meta = active
    ? `${fingerprint(cred.fingerprint)}<span class="vk-when">Validated ${esc(relTime(cred.lastValidatedAt))}</span>`
    : `<span class="vk-when">No key set for this provider yet.</span>`;

  let controls: string;
  if (!canManage) {
    // Non-admin: read-only status + a single gated control. NEVER a form.
    controls = roControl('Set key', { gate: RO_GATE_VENDOR_KEYS });
  } else if (active) {
    controls =
      `<button class="ictl signal" type="button" data-act="vk-edit" aria-label="Replace the ${esc(PROVIDER_LABEL)} key">Replace key</button>` +
      `<button class="ictl vk-danger" type="button" data-act="vk-remove" aria-label="Remove the ${esc(PROVIDER_LABEL)} key">Remove</button>`;
  } else {
    controls = `<button class="ictl signal" type="button" data-act="vk-edit" aria-label="Set the ${esc(PROVIDER_LABEL)} key">${I.plus} Set key</button>`;
  }

  // The reveal-on-demand set/replace form + the two-step remove confirm are hidden by default
  // and toggled in `wireSettings` — so the input is only ever in the DOM blank, never pre-filled.
  const form = canManage
    ? `<form class="vk-form" data-vk-form hidden>
        <label class="vk-label" for="vk-key">${active ? 'Replace' : 'Set'} ${esc(PROVIDER_LABEL)} key</label>
        <input id="vk-key" class="vk-input mono" type="password" name="key" autocomplete="off" spellcheck="false"
          placeholder="Paste the API key" aria-label="${esc(PROVIDER_LABEL)} API key" />
        <div class="vk-form-actions">
          <button class="btn-add" type="submit" data-act="vk-save">Save key</button>
          <button class="ictl" type="button" data-act="vk-cancel">Cancel</button>
        </div>
        <p class="vk-err" data-vk-err hidden role="alert"></p>
      </form>`
    : '';

  const confirm = canManage && active
    ? `<div class="vk-confirm" data-vk-confirm hidden>
        <span class="vk-confirm-q">Remove the ${esc(PROVIDER_LABEL)} key? Agents lose access until a new key is set.</span>
        <div class="vk-confirm-actions">
          <button class="ictl vk-danger" type="button" data-act="vk-remove-confirm" aria-label="Confirm removing the ${esc(PROVIDER_LABEL)} key">Confirm remove</button>
          <button class="ictl" type="button" data-act="vk-remove-cancel">Cancel</button>
        </div>
      </div>`
    : '';

  return `<div class="vk-row">
      <div class="vk-id">
        <div class="vk-name">${esc(PROVIDER_LABEL)}</div>
        <div class="vk-meta">${meta}</div>
      </div>
      <div class="vk-status">${statusBadge(active)}</div>
      <div class="vk-actions">${controls}</div>
    </div>
    ${form}${confirm}`;
}

/** The vendor-keys panel. On a read failure it renders an honest error block (the rest of the
 *  page still renders). Other providers are named as a future hint, not as inputs. */
function vendorPanel(res: ApiResult<VendorCredentialsResponse>, canManage: boolean): string {
  let body: string;
  if (res.kind === 'error') {
    body = error('Could not load vendor keys. ' + res.message);
  } else if (res.kind === 'unauth') {
    // Treated as an empty/unknown state here (mount already session-gates the page).
    body = empty('Vendor keys unavailable', 'Sign in again to manage vendor keys.', I.gear);
  } else {
    const cred =
      res.data.credentials.find((c) => c.provider === PROVIDER) ??
      ({ provider: PROVIDER, status: 'unconfigured', fingerprint: null, lastValidatedAt: null } as VendorCredentialStatus);
    body = vendorRow(cred, canManage) + `<p class="vk-future">More vendors (OpenAI, local) arrive as Tasca rolls them out.</p>`;
  }

  return `<div class="pcard vk-panel">
      <div class="pc-h">Vendor keys</div>
      <div class="pc-sub">A per-workspace API key Tasca seals and uses on your behalf. The stored key is write-only — it is never shown again.</div>
      ${body}
    </div>`;
}

const AUDIT_VERB: Record<CredentialAuditEvent['action'], string> = {
  'credential.set': 'Set',
  'credential.delete': 'Removed',
};

function auditRow(ev: CredentialAuditEvent): string {
  const actor = ev.actorUserId ? esc(ev.actorUserId) : '—';
  const provider = esc(ev.target ?? PROVIDER);
  const fp = ev.payload.fingerprint ? `<span class="vk-fp mono">key ••••${esc(ev.payload.fingerprint)}</span>` : '';
  return `<div class="audit-row">
      <span class="audit-verb">${esc(AUDIT_VERB[ev.action] ?? ev.action)}</span>
      <span class="audit-target mono">${provider}</span>
      ${fp}
      <span class="audit-actor">${actor}</span>
      <span class="audit-when">${esc(relTime(ev.at))}</span>
    </div>`;
}

/** The audit panel — admin-only (the backend is admin+; a non-admin never fetches it). */
function auditPanel(res: ApiResult<{ events: CredentialAuditEvent[] }>): string {
  let body: string;
  if (res.kind === 'error') {
    body = error('Could not load the audit log. ' + res.message);
  } else if (res.kind === 'unauth') {
    body = empty('Audit log unavailable', 'Sign in again to view the audit log.', I.gear);
  } else if (res.data.events.length === 0) {
    body = empty('No credential changes yet', 'Setting or removing a vendor key records an entry here.', I.gear);
  } else {
    body = `<div class="audit-list">${res.data.events.map(auditRow).join('')}</div>`;
  }
  return `<div class="pcard audit-panel">
      <div class="pc-h">Audit log</div>
      <div class="pc-sub">Every credential change, newest first. A key is never recorded — only who, when, and a fingerprint.</div>
      ${body}
    </div>`;
}

export async function loadSettings(): Promise<LoadResult> {
  const canManage = await canManageActiveOrg();
  // The vendor read is member+ (always fetched); the audit read is admin+ (only fetched for
  // an admin — a member fetch would 403). Both run concurrently with the role already resolved.
  const [credRes, auditRes] = await Promise.all([
    getVendorCredentials(),
    canManage ? getCredentialAudit() : Promise.resolve(null),
  ]);

  const planned = PLANNED.map(
    (s) =>
      `<div class="idrow"><div class="idp"><span class="idp-name">${esc(s.title)}</span><span class="idp-h">${esc(s.desc)}</span></div><span class="coming-tag">Planned</span></div>`
  ).join('');

  const auditHtml = canManage && auditRes ? auditPanel(auditRes) : '';

  const html = `<div class="roster-head"><div><h1>Settings</h1><div class="sub">Workspace configuration</div></div></div>
    <div class="settings-stack">
      ${vendorPanel(credRes, canManage)}
      ${auditHtml}
      <div class="pcard">
        <div class="pc-h">Configuration</div>
        <div class="pc-sub">These panels arrive as Tasca rolls them out for your workspace.</div>
        ${planned}
      </div>
    </div>`;
  return { kind: 'ok', html };
}

function describeKeyFailure(r: WriteResult<unknown>): string {
  // The vendor rejects an invalid key with 400 code:'key_invalid' → classified as a conflict.
  if (r.kind === 'conflict') {
    const code = (r.data as { code?: string } | undefined)?.code;
    if (code === 'key_invalid') return 'That key was rejected by the vendor — check it and retry.';
    return 'Vendor keys changed elsewhere — showing the latest. Review and retry.';
  }
  switch (r.kind) {
    case 'forbidden':
      return 'Couldn’t save — you may not have admin rights, or your session token expired. Showing the latest.';
    case 'notfound':
      return 'There’s no key to change — showing the latest.';
    case 'unconfigured':
      return 'Vendor keys aren’t enabled on this workspace yet.';
    case 'error':
      return `Couldn’t save the key (${r.message}). Showing the latest.`;
    default:
      return 'Couldn’t apply the change. Showing the latest.';
  }
}

/** Wire the admin set/replace + remove controls. The set form's input is write-only: on a
 *  successful save it is cleared and the view re-renders from server truth (the key is never
 *  echoed). `rerun` re-fetches + re-renders (mount's run). */
export function wireSettings(el: HTMLElement, rerun: () => Promise<void>): void {
  const form = el.querySelector<HTMLFormElement>('[data-vk-form]');
  const confirm = el.querySelector<HTMLElement>('[data-vk-confirm]');
  const errBox = el.querySelector<HTMLElement>('[data-vk-err]');
  const input = form?.querySelector<HTMLInputElement>('input[name="key"]') ?? null;

  const showErr = (msg: string): void => {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.hidden = false;
  };
  const clearErr = (): void => {
    if (errBox) {
      errBox.textContent = '';
      errBox.hidden = true;
    }
  };

  // Reveal the set/replace form.
  el.querySelector<HTMLButtonElement>('[data-act="vk-edit"]')?.addEventListener('click', () => {
    confirm?.setAttribute('hidden', '');
    clearErr();
    if (form) form.hidden = false;
    input?.focus();
  });
  // Cancel the form — clear the (write-only) input so nothing typed lingers in the DOM.
  el.querySelector<HTMLButtonElement>('[data-act="vk-cancel"]')?.addEventListener('click', () => {
    if (input) input.value = '';
    clearErr();
    if (form) form.hidden = true;
  });

  // Two-step remove confirm (the codebase avoids window.confirm).
  el.querySelector<HTMLButtonElement>('[data-act="vk-remove"]')?.addEventListener('click', () => {
    if (form) form.hidden = true;
    confirm?.removeAttribute('hidden');
  });
  el.querySelector<HTMLButtonElement>('[data-act="vk-remove-cancel"]')?.addEventListener('click', () => {
    confirm?.setAttribute('hidden', '');
  });

  // Save: validate-and-seal. On any non-ok outcome the view re-renders from truth + a banner.
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input) return;
    const key = input.value.trim();
    if (!key) {
      showErr('Enter a key before saving.');
      return;
    }
    const saveBtn = form.querySelector<HTMLButtonElement>('[data-act="vk-save"]');
    if (!saveBtn) return;
    clearErr();
    // Clear the input BEFORE the write resolves so the secret never lingers in the DOM, and the
    // local `key` (a function-scoped const) is the only copy until it's posted.
    input.value = '';
    void liveAction({
      button: saveBtn,
      pendingLabel: 'Saving…',
      view: el,
      rerun,
      write: (): Promise<WriteResult<unknown>> => setVendorCredential(PROVIDER, key),
      describe: describeKeyFailure,
    });
  });

  // Confirm remove.
  el.querySelector<HTMLButtonElement>('[data-act="vk-remove-confirm"]')?.addEventListener('click', () => {
    const btn = el.querySelector<HTMLButtonElement>('[data-act="vk-remove-confirm"]');
    if (!btn) return;
    void liveAction({
      button: btn,
      pendingLabel: 'Removing…',
      view: el,
      rerun,
      write: (): Promise<WriteResult<unknown>> => deleteVendorCredential(PROVIDER),
      describe: describeKeyFailure,
    });
  });
}
