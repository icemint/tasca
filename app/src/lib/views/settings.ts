// Settings (C8). Three panels are now LIVE: "Workspace" (slice 3.5-B.2) lets an admin rename the
// instance + manage members and roles (list / change-role / remove; owner-only for role + remove);
// "Vendor keys" (slice 3.5-A.2c.2) lets an admin set / replace / remove a per-org vendor key
// (Anthropic today) WITHOUT ever seeing a stored key (the read shape carries only a status + a
// non-reversible fingerprint); "Audit log" shows the credential governance trail (admin+). Billing
// stays an honest `Planned` row. The key input is WRITE-ONLY: never pre-filled, never echoed,
// cleared + re-rendered from server truth on save.

import {
  getVendorCredentials,
  setVendorCredential,
  deleteVendorCredential,
  getCredentialAudit,
  getOrgInfo,
  getMembers,
  renameOrg,
  setMemberRole,
  removeMember,
  getInvites,
  createInvite,
  revokeInvite,
  getSession,
  canManageActiveOrg,
  redirectToLogin,
  type WriteResult,
} from '../api';
import { liveAction, showBanner } from '../live';
import { error, empty } from '../states';
import type { LoadResult } from '../mount';
import { I, esc, roControl, RO_GATE_VENDOR_KEYS, RO_GATE_WORKSPACE } from '../ui';
import type { ApiResult } from '../api';
import type {
  CredentialAuditEvent,
  InvitesResponse,
  MembersResponse,
  OrgInfo,
  OrgMember,
  OrgRole,
  PendingInvite,
  VendorCredentialStatus,
  VendorCredentialsResponse,
} from '../contract';

const PROVIDER = 'anthropic';
const PROVIDER_LABEL = 'Anthropic';

// Deferred panels — unchanged honest "not yet available" rows.
const PLANNED = [{ title: 'Billing & usage', desc: 'Plan, invoices and per-agent spend.' }];

// The role lattice the Workspace panel surfaces (product labels). The backend lattice is
// owner|admin|member; the role <select> offers exactly these, in privilege order.
const MANAGED_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member'];
const ROLE_LABEL: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};
// The badge is NEVER color-alone — a text role label (Owner/Admin/Member) is ALWAYS rendered. The dot
// adds a second, non-color signal where it differs: a FILLED dot for owner/admin, a HOLLOW dot for
// member/viewer. (Owner vs admin are distinguished by the label + color, not the dot shape.)
const ROLE_BADGE_CLASS: Record<OrgRole, string> = {
  owner: 'ok',
  admin: 'warn',
  member: 'off',
  viewer: 'off',
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

// ── Workspace panel (slice 3.5-B.2: instance name + members/roles) ─────────────

/** A role badge — NEVER color-alone: the role label is always present, paired with a glyph
 *  (a dot whose fill/shape varies by role) AND a token color. Reuses the connections
 *  `.conn-status` badge treatment (ok/warn/off + the `.d` / `.d.hollow` dot shapes). */
function roleBadge(role: OrgRole): string {
  const cls = ROLE_BADGE_CLASS[role];
  const dot = role === 'member' || role === 'viewer' ? '<span class="d hollow"></span>' : '<span class="d"></span>';
  return `<span class="conn-status ${cls}">${dot}${esc(ROLE_LABEL[role] ?? role)}</span>`;
}

/** The role <select> for an owner acting on a member (owner-only). When `lock` is set (the row is
 *  the org's only owner), the control is disabled — demoting the last owner is refused server-side
 *  (409 last_owner), so we don't offer the doomed action; promote another owner first. */
function roleSelect(m: OrgMember, lock: boolean): string {
  const opts = MANAGED_ROLES.map(
    (r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${esc(ROLE_LABEL[r])}</option>`
  ).join('');
  const dis = lock
    ? ` disabled title="Promote another owner before changing the only owner’s role." aria-describedby="ws-hint-${esc(m.userId)}"`
    : '';
  return `<select class="ws-role-select" data-act="ws-role" data-user-id="${esc(m.userId)}"${dis} aria-label="Role for ${esc(m.displayName || m.email)}">${opts}</select>`;
}

/** One member row: identity + a role badge (+ a `(you)` marker), and — owner-only — a role
 *  control + a two-step Remove. A non-owner sees the badge only (read-only list). When the member is
 *  the org's only owner (`isLastOwner`), the role + Remove controls are disabled and a hint explains
 *  why — the lockout guard (issue 316) lives in the server (atomic 409 last_owner); this just keeps the
 *  operator from clicking into a guaranteed failure. */
function memberRow(m: OrgMember, isOwner: boolean, selfUserId: string | null, isLastOwner: boolean): string {
  const you = m.userId === selfUserId ? ' <span class="ws-you">(you)</span>' : '';
  const name = esc(m.displayName || m.email);
  const removeDis = isLastOwner
    ? ` disabled title="Promote another owner before removing the only owner." aria-describedby="ws-hint-${esc(m.userId)}"`
    : '';
  const controls = isOwner
    ? `<div class="ws-member-controls">${roleSelect(m, isLastOwner)}` +
      `<button class="ictl vk-danger" type="button" data-act="ws-remove" data-user-id="${esc(m.userId)}"${removeDis} aria-label="Remove ${name}">Remove</button></div>`
    : '';
  const hint = isOwner && isLastOwner
    ? `<div class="ws-member-hint" id="ws-hint-${esc(m.userId)}">Sole owner — promote another owner before changing this role or removing this member.</div>`
    : '';
  // No two-step Remove confirm for the last owner: Remove is disabled, so it can never open.
  const confirm = isOwner && !isLastOwner
    ? `<div class="ws-confirm" data-ws-confirm="${esc(m.userId)}" hidden>
        <span class="ws-confirm-q">Remove ${name} from this workspace?</span>
        <div class="ws-confirm-actions">
          <button class="ictl vk-danger" type="button" data-act="ws-remove-confirm" data-user-id="${esc(m.userId)}" aria-label="Confirm removing ${name}">Confirm remove</button>
          <button class="ictl" type="button" data-act="ws-remove-cancel" data-user-id="${esc(m.userId)}">Cancel</button>
        </div>
      </div>`
    : '';
  return `<div class="ws-member">
      <div class="ws-member-id">
        <div class="ws-member-name">${name}${you}</div>
        <div class="ws-member-email">${esc(m.email)}</div>
      </div>
      <div class="ws-member-role">${roleBadge(m.role)}</div>
      ${controls}
      ${hint}
    </div>${confirm}`;
}

/** The name block: the workspace name + (admin+) a reveal-on-demand inline edit form. A non-admin
 *  sees the read-only name + a single gated control (never a form). */
function nameBlock(info: OrgInfo, canManage: boolean): string {
  const control = canManage
    ? `<button class="ictl signal" type="button" data-act="ws-name-edit" aria-label="Rename the workspace">Rename</button>`
    : roControl('Rename', { gate: RO_GATE_WORKSPACE });
  const form = canManage
    ? `<form class="ws-name-form" data-ws-name-form hidden>
        <label class="ws-label" for="ws-name">Workspace name</label>
        <input id="ws-name" class="ws-input" type="text" name="name" maxlength="80" autocomplete="off"
          value="${esc(info.name)}" aria-label="Workspace name" />
        <div class="ws-name-actions">
          <button class="btn-add" type="submit" data-act="ws-name-save">Save</button>
          <button class="ictl" type="button" data-act="ws-name-cancel">Cancel</button>
        </div>
        <p class="ws-err" data-ws-name-err hidden role="alert"></p>
      </form>`
    : '';
  return `<div class="ws-name-row">
      <div class="ws-name-id"><div class="ws-name-k">Name</div><div class="ws-name-v">${esc(info.name || '—')}</div></div>
      <div class="ws-name-ctl">${control}</div>
    </div>${form}`;
}

/** The Workspace panel. On a read failure it renders an honest error block (the rest of the page
 *  still renders). Role + remove controls are OWNER-only (the caller's role === 'owner'); the name
 *  edit is admin+. The backend enforces both — the UI gate is UX, not the security boundary. */
function workspacePanel(
  infoRes: ApiResult<OrgInfo>,
  membersRes: ApiResult<MembersResponse>,
  invitesRes: ApiResult<InvitesResponse> | null,
  canManage: boolean,
  selfUserId: string | null
): string {
  if (infoRes.kind !== 'ok') {
    const msg = infoRes.kind === 'error' ? infoRes.message : 'Sign in again to manage the workspace.';
    return `<div class="pcard ws-panel">
        <div class="pc-h">Workspace</div>
        <div class="pc-sub">Your workspace name, members and their roles.</div>
        ${error('Could not load the workspace. ' + msg)}
      </div>`;
  }
  const info = infoRes.data;
  const isOwner = info.role === 'owner';

  let membersBody: string;
  if (membersRes.kind !== 'ok') {
    const msg = membersRes.kind === 'error' ? membersRes.message : 'Sign in again to view members.';
    membersBody = error('Could not load members. ' + msg);
  } else if (membersRes.data.members.length === 0) {
    membersBody = empty('No members yet', 'Members appear here once they sign in.', I.roster);
  } else {
    const members = membersRes.data.members;
    const ownerCount = members.filter((m) => m.role === 'owner').length;
    membersBody = `<div class="ws-members">${members
      .map((m) => memberRow(m, isOwner, selfUserId, m.role === 'owner' && ownerCount <= 1))
      .join('')}</div>`;
  }

  // The Invites section is admin+ only — a non-admin never fetches it (invitesRes is null) and
  // never sees it. The role <select> caps at the caller's own role (server-enforced regardless).
  const invites = canManage && invitesRes ? invitesSection(invitesRes, info.role) : '';

  return `<div class="pcard ws-panel">
      <div class="pc-h">Workspace</div>
      <div class="pc-sub">Your workspace name, members and their roles.</div>
      ${nameBlock(info, canManage)}
      <div class="ws-members-head">Members</div>
      ${membersBody}
      ${invites}
    </div>`;
}

// ── Invites section (slice 3.5-B.3.2: invite a teammate by email + role) ───────
// Admin+ only — a non-admin never fetches or sees it. The role <select> offers only roles ≤ the
// caller's own (owner → Owner/Admin/Member; admin → Admin/Member): a UX cap, NOT the security
// boundary (the server refuses an invite above your role with a 403). The accept link returned on
// create is revealed with a Copy control so an invite works even without email configured.

/** Privilege rank (higher = more privileged) — bounds the invite role options to ≤ the caller's. */
const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

/** Days until an ISO timestamp, floored at 0 (an honest "expires in N days"). */
function daysUntil(iso: string): number {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.ceil((then - Date.now()) / 86_400_000));
}

function expiresLabel(iso: string): string {
  const d = daysUntil(iso);
  if (d <= 0) return 'expires today';
  return `expires in ${d} day${d === 1 ? '' : 's'}`;
}

/** The invite role <select> — offers only roles at or below the caller's own privilege. */
function inviteRoleSelect(callerRole: OrgRole): string {
  const cap = ROLE_RANK[callerRole];
  const opts = MANAGED_ROLES.filter((r) => ROLE_RANK[r] <= cap)
    .map((r) => `<option value="${r}">${esc(ROLE_LABEL[r])}</option>`)
    .join('');
  return `<select class="inv-role-select" name="role" aria-label="Role for the invited teammate">${opts}</select>`;
}

/** One pending-invite row: email, role badge, "expires in N days", and a Revoke control. */
function inviteRow(inv: PendingInvite): string {
  return `<div class="inv-row">
      <div class="inv-id">
        <div class="inv-email">${esc(inv.email)}</div>
        <div class="inv-when">${esc(expiresLabel(inv.expiresAt))}</div>
      </div>
      <div class="inv-role">${roleBadge(inv.role)}</div>
      <button class="ictl vk-danger" type="button" data-act="inv-revoke" data-invite-id="${esc(inv.id)}" aria-label="Revoke the invite for ${esc(inv.email)}">Revoke</button>
    </div>`;
}

/** The Invites section — admin+ only. On a list-read failure it renders an honest inline error;
 *  the rest of the Workspace panel still renders. `callerRole` bounds the role <select>. */
function invitesSection(invitesRes: ApiResult<InvitesResponse>, callerRole: OrgRole): string {
  const form = `<form class="inv-form" data-inv-form>
      <div class="inv-form-fields">
        <input class="inv-input" type="email" name="email" required autocomplete="off" spellcheck="false"
          placeholder="teammate@company.com" aria-label="Email of the teammate to invite" />
        ${inviteRoleSelect(callerRole)}
        <button class="btn-add" type="submit" data-act="inv-send">Send invite</button>
      </div>
      <p class="inv-err" data-inv-err hidden role="alert"></p>
      <div class="inv-result" data-inv-result hidden role="status">
        <label class="inv-result-label" for="inv-link">Invite link</label>
        <div class="inv-result-row">
          <input id="inv-link" class="inv-link mono" type="text" readonly aria-label="Single-use invite link" data-inv-link />
          <button class="ictl" type="button" data-act="inv-copy" aria-label="Copy the invite link">${I.copy} Copy link</button>
        </div>
        <p class="inv-note">We also emailed it if email is configured.</p>
      </div>
    </form>`;

  let list: string;
  if (invitesRes.kind !== 'ok') {
    const msg = invitesRes.kind === 'error' ? invitesRes.message : 'Sign in again to view invites.';
    list = error('Could not load invites. ' + msg);
  } else if (invitesRes.data.invites.length === 0) {
    list = empty('No pending invites', 'Invite a teammate by email above; pending invites appear here.', I.mail);
  } else {
    list = `<div class="inv-list">${invitesRes.data.invites.map(inviteRow).join('')}</div>`;
  }

  return `<div class="ws-members-head">Invites</div>
    ${form}
    ${list}`;
}

export async function loadSettings(): Promise<LoadResult> {
  const canManage = await canManageActiveOrg();
  // Workspace name + members are member+ (always fetched); the vendor read is member+ (always);
  // the audit read + invites list are admin+ (only fetched for an admin — a member fetch would 403).
  // All run concurrently. The session resolves the caller's own id (the `(you)` marker).
  const [orgRes, membersRes, credRes, auditRes, invitesRes, sessionRes] = await Promise.all([
    getOrgInfo(),
    getMembers(),
    getVendorCredentials(),
    canManage ? getCredentialAudit() : Promise.resolve(null),
    canManage ? getInvites() : Promise.resolve(null),
    getSession(),
  ]);

  const selfUserId =
    sessionRes.kind === 'ok' && sessionRes.data.authenticated ? sessionRes.data.user.id : null;

  const planned = PLANNED.map(
    (s) =>
      `<div class="idrow"><div class="idp"><span class="idp-name">${esc(s.title)}</span><span class="idp-h">${esc(s.desc)}</span></div><span class="coming-tag">Planned</span></div>`
  ).join('');

  const auditHtml = canManage && auditRes ? auditPanel(auditRes) : '';

  const html = `<div class="roster-head"><div><h1>Settings</h1><div class="sub">Workspace configuration</div></div></div>
    <div class="settings-stack">
      ${workspacePanel(orgRes, membersRes, invitesRes, canManage, selfUserId)}
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

  wireWorkspace(el, rerun);
}

/** Honest failure copy for workspace member writes. The last-owner guard arrives as a 409
 *  `code:'last_owner'` (the conflict channel) — surfaced as its OWN message, never swallowed. */
function describeMemberFailure(r: WriteResult<unknown>): string {
  if (r.kind === 'conflict') {
    const code = (r.data as { code?: string } | undefined)?.code;
    if (code === 'last_owner') return 'Can’t change the last owner — promote someone else first.';
    return 'Members changed elsewhere — showing the latest. Review and retry.';
  }
  switch (r.kind) {
    case 'forbidden':
      return 'Couldn’t apply — you may not have owner rights, or your session token expired. Showing the latest.';
    case 'notfound':
      return 'That member isn’t available to change — showing the latest.';
    case 'error':
      return `Couldn’t apply the change (${r.message}). Showing the latest.`;
    default:
      return 'Couldn’t apply the change. Showing the latest.';
  }
}

/** Wire the Workspace panel: the admin+ name rename (reveal-on-demand inline form) and the
 *  owner-only per-member role change + two-step remove. Controls absent for a non-admin/non-owner
 *  simply have no listeners (the server is the authority either way). */
function wireWorkspace(el: HTMLElement, rerun: () => Promise<void>): void {
  // ── name rename (admin+) ─────────────────────────────────────────────────────
  const nameForm = el.querySelector<HTMLFormElement>('[data-ws-name-form]');
  const nameInput = nameForm?.querySelector<HTMLInputElement>('input[name="name"]') ?? null;
  const nameErr = el.querySelector<HTMLElement>('[data-ws-name-err]');

  el.querySelector<HTMLButtonElement>('[data-act="ws-name-edit"]')?.addEventListener('click', () => {
    if (nameErr) nameErr.hidden = true;
    if (nameForm) nameForm.hidden = false;
    nameInput?.focus();
  });
  el.querySelector<HTMLButtonElement>('[data-act="ws-name-cancel"]')?.addEventListener('click', () => {
    if (nameForm) nameForm.hidden = true;
    if (nameErr) nameErr.hidden = true;
  });
  nameForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!nameInput) return;
    const name = nameInput.value.trim();
    if (!name) {
      if (nameErr) {
        nameErr.textContent = 'Enter a workspace name before saving.';
        nameErr.hidden = false;
      }
      return;
    }
    const saveBtn = nameForm.querySelector<HTMLButtonElement>('[data-act="ws-name-save"]');
    if (!saveBtn) return;
    void liveAction({
      button: saveBtn,
      pendingLabel: 'Saving…',
      view: el,
      rerun,
      write: (): Promise<WriteResult<unknown>> => renameOrg(name),
      describe: describeMemberFailure,
    });
  });

  // ── member role change (owner-only) ──────────────────────────────────────────
  el.querySelectorAll<HTMLSelectElement>('[data-act="ws-role"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      if (sel.dataset.busy === '1') return;
      const userId = sel.dataset.userId;
      const role = sel.value as OrgRole;
      if (!userId) return;
      sel.dataset.busy = '1';
      sel.disabled = true;
      void (async () => {
        let result: WriteResult<unknown>;
        try {
          result = await setMemberRole(userId, role);
        } catch {
          result = { kind: 'error', message: 'Unexpected error' };
        }
        if (result.kind === 'unauth') {
          redirectToLogin();
          return;
        }
        await rerun();
        if (result.kind !== 'ok') showBanner(el, describeMemberFailure(result));
      })();
    });
  });

  // ── two-step member remove (owner-only) ──────────────────────────────────────
  el.querySelectorAll<HTMLButtonElement>('[data-act="ws-remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const userId = btn.dataset.userId;
      el.querySelector<HTMLElement>(`[data-ws-confirm="${userId}"]`)?.removeAttribute('hidden');
    });
  });
  el.querySelectorAll<HTMLButtonElement>('[data-act="ws-remove-cancel"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const userId = btn.dataset.userId;
      el.querySelector<HTMLElement>(`[data-ws-confirm="${userId}"]`)?.setAttribute('hidden', '');
    });
  });
  el.querySelectorAll<HTMLButtonElement>('[data-act="ws-remove-confirm"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const userId = btn.dataset.userId;
      if (!userId) return;
      void liveAction({
        button: btn,
        pendingLabel: 'Removing…',
        view: el,
        rerun,
        write: (): Promise<WriteResult<unknown>> => removeMember(userId),
        describe: describeMemberFailure,
      });
    });
  });

  wireInvites(el, rerun);
}

/** Honest failure copy for invite writes. The privilege cap (inviting above your role) arrives as a
 *  403 forbidden — surfaced as its own message, never swallowed; a bad email/role is a generic 400. */
function describeInviteFailure(r: WriteResult<unknown>): string {
  switch (r.kind) {
    case 'forbidden':
      return 'You can’t invite above your own role, or your session token expired.';
    case 'notfound':
      return 'That invite is no longer available.';
    case 'error':
      return `Couldn’t send the invite (${r.message}). Check the email and retry.`;
    default:
      return 'Couldn’t send the invite. Check the email and retry.';
  }
}

/** Wire the admin+ Invites section: send (reveal the copyable accept link on ok), copy-link, and
 *  per-row revoke. A non-admin never renders these controls (the server is the authority either
 *  way). On a successful send the view re-runs so the new invite joins the pending list. */
function wireInvites(el: HTMLElement, rerun: () => Promise<void>): void {
  const form = el.querySelector<HTMLFormElement>('[data-inv-form]');
  const emailInput = form?.querySelector<HTMLInputElement>('input[name="email"]') ?? null;
  const roleSel = form?.querySelector<HTMLSelectElement>('select[name="role"]') ?? null;
  const errBox = el.querySelector<HTMLElement>('[data-inv-err]');
  const linkInput = el.querySelector<HTMLInputElement>('[data-inv-link]');

  const showErr = (msg: string): void => {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.hidden = false;
  };

  // Send: validate the email is present, then POST. On ok, reveal the returned accept link (so the
  // invite works without email configured) and re-run so the new invite appears in the pending list.
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!emailInput || !roleSel) return;
    const email = emailInput.value.trim();
    if (!email) {
      showErr('Enter an email address to invite.');
      return;
    }
    const role = roleSel.value as OrgRole;
    const sendBtn = form.querySelector<HTMLButtonElement>('[data-act="inv-send"]');
    if (!sendBtn || sendBtn.dataset.busy === '1') return;
    if (errBox) errBox.hidden = true;
    sendBtn.dataset.busy = '1';
    sendBtn.disabled = true;
    sendBtn.setAttribute('aria-busy', 'true');
    const original = sendBtn.textContent;
    sendBtn.textContent = 'Sending…';
    void (async () => {
      let res: Awaited<ReturnType<typeof createInvite>>;
      try {
        res = await createInvite(email, role);
      } catch {
        res = { kind: 'error', message: 'Unexpected error' };
      }
      if (res.kind === 'unauth') {
        redirectToLogin();
        return;
      }
      if (res.kind === 'ok') {
        const url = (res.data as { acceptUrl?: string }).acceptUrl ?? '';
        // Re-run FIRST so the new invite joins the pending list (this re-renders the section); then
        // reveal the returned accept link in the freshly-rendered DOM. The acceptUrl lives only in
        // this POST response — the GET list never carries a token — so it must be re-applied after.
        await rerun();
        const freshResult = el.querySelector<HTMLElement>('[data-inv-result]');
        const freshLink = el.querySelector<HTMLInputElement>('[data-inv-link]');
        if (freshLink) freshLink.value = url;
        if (freshResult) freshResult.hidden = false;
        return;
      }
      // Restore the button and surface an inline error (403 cap / 400 bad email) — the form stays so
      // the user can correct and retry; nothing is re-run on failure.
      sendBtn.dataset.busy = '';
      sendBtn.disabled = false;
      sendBtn.removeAttribute('aria-busy');
      sendBtn.textContent = original;
      showErr(describeInviteFailure(res));
    })();
  });

  // Copy the accept link to the clipboard (best-effort — falls back to selecting the field).
  el.querySelector<HTMLButtonElement>('[data-act="inv-copy"]')?.addEventListener('click', () => {
    if (!linkInput || !linkInput.value) return;
    const copyBtn = el.querySelector<HTMLButtonElement>('[data-act="inv-copy"]');
    const done = (): void => {
      if (!copyBtn) return;
      copyBtn.innerHTML = `${I.check} Copied`;
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(linkInput.value).then(done, () => {
        linkInput.select();
      });
    } else {
      linkInput.select();
    }
  });

  // Per-row revoke — re-runs so the revoked invite drops out of the pending list.
  el.querySelectorAll<HTMLButtonElement>('[data-act="inv-revoke"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inviteId = btn.dataset.inviteId;
      if (!inviteId) return;
      void liveAction({
        button: btn,
        pendingLabel: 'Revoking…',
        view: el,
        rerun,
        write: (): Promise<WriteResult<unknown>> => revokeInvite(inviteId),
        describe: describeInviteFailure,
      });
    });
  });
}
