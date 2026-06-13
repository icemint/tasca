// Roster view (C4) — "Your team". Lists every agent from GET /api/agents as cards.
// Per-card Hire/Unhire (slice W4-S3) links an agent into the ACTIVE org (org_agent), which is
// what makes it routable; admin+ only (the server enforces it too — the UI gate is UX). The
// "Create agent" header control (slice Wizard-B) is member+ (any logged-in member) — it provisions
// a new global agent AND auto-hires it into the active org, so it appears in the roster at once.

import { getAgents, getHiredAgents, canManageActiveOrg, createAgent, hireAgent, unhireAgent, redirectToLogin, type WriteResult } from '../api';
import { liveAction } from '../live';
import { fromResult, type LoadResult } from '../mount';
import { empty } from '../states';
import { I, avatar, vendorChip, statePill, tierRamp, pct, taskRef, esc, roControl, TIER_LABEL, RO_GATE_ADMIN_ROSTER } from '../ui';
import { TIERS, type Agent, type NewAgentResponse, type Tier, type Vendor } from '../contract';

// Vendors the create form offers, in the order they appear (Claude default — the org's vault key
// is Anthropic). Labels reuse the design system's VENDOR_LABEL via the <option> text below.
const CREATE_VENDORS: ReadonlyArray<{ value: Vendor; label: string; modelPlaceholder: string }> = [
  { value: 'claude', label: 'Claude', modelPlaceholder: 'claude-opus-4-8' },
  { value: 'openai', label: 'OpenAI', modelPlaceholder: 'gpt-4o' },
  { value: 'local', label: 'Local', modelPlaceholder: 'qwen2.5-coder' },
];

/** Client-side mirror of the backend's model→tier table (agent-api.ts defaultTierForModel) — VENDOR-
 *  GATED, verbatim, so the pre-filled tier matches what the backend would derive (a confidently-wrong
 *  cross-vendor pre-fill, e.g. a Local model named 'gpt-4-x' showing Hard, is worse than none). The
 *  parity is asserted by a test. */
export function defaultTierForModel(vendor: string, model: string): Tier {
  const m = model.toLowerCase();
  if (vendor === 'claude') {
    if (m.includes('opus')) return 'ultra';
    if (m.includes('sonnet')) return 'hard';
    if (m.includes('haiku')) return 'low';
  }
  if (vendor === 'openai') {
    // cheap-mini check FIRST (gpt-4o-mini contains 'gpt-4').
    if (m.includes('gpt-3.5') || m.includes('gpt-4o-mini')) return 'low';
    if (m.includes('o1') || m.includes('gpt-4')) return 'hard';
  }
  return 'medium'; // unknown + all local
}

function healthStrip(agents: Agent[]): string {
  const count = (s: Agent['state']) => agents.filter((a) => a.state === s).length;
  const tiles = [
    { k: 'In flight', v: count('working'), g: 'var(--state-working)' },
    { k: 'Awaiting input', v: count('awaiting_input'), g: 'var(--state-awaiting)' },
    { k: 'Blocked', v: count('blocked'), g: 'var(--state-blocked)' },
    { k: 'Shipped', v: count('shipped'), g: 'var(--state-shipped)' },
    { k: 'Idle', v: count('idle'), g: 'var(--fg-faint)' },
  ];
  return `<div class="health-strip">${tiles
    .map(
      (t) =>
        `<div class="hstat"><span class="k"><span class="glyph" style="background:${t.g}"></span>${t.k}</span><span class="v">${t.v}</span></div>`
    )
    .join('')}</div>`;
}

/** The per-card hire/unhire control. Admin+ → an enabled live control; otherwise the disabled
 *  control with an honest reason (never a button that would just 403). */
function hireControl(a: Agent, hired: boolean, canManage: boolean): string {
  const label = hired ? 'Unhire' : 'Hire';
  if (!canManage) return roControl(label, { cls: 'ictl', gate: RO_GATE_ADMIN_ROSTER });
  const act = hired ? 'unhire' : 'hire';
  return `<button class="ictl hire-ctl ${hired ? 'is-hired' : 'signal'}" type="button" data-act="${act}" data-agent-id="${esc(a.id)}" aria-label="${label} ${esc(a.name)}">${label}</button>`;
}

function card(a: Agent, hired: boolean, canManage: boolean): string {
  const task = a.currentTaskId
    ? `<a class="linktask" href="/tasks?id=${encodeURIComponent(a.currentTaskId)}">${taskRef(a.currentTaskId)}</a>`
    : 'No active task · available to route';
  return `<article class="agentcard">
    <a class="id" href="/agents?id=${encodeURIComponent(a.id)}">${avatar(a, 'av-lg')}
      <div class="nm"><div class="name">${esc(a.name)}</div>
        <div class="meta">${vendorChip(a.vendor)}<span class="mono dim">${esc(a.model)}</span></div></div>
      ${statePill(a.state)}</a>
    <div class="task ${a.currentTaskId ? '' : 'muted'}">${task}</div>
    <div class="foot">
      <div class="metricset">
        <div class="metric"><span class="mv">${pct(a.capability.successRate)}</span><span class="mk">Success</span></div>
        <div class="metric"><span class="mv">${a.capability.concurrencyLimit ?? '—'}</span><span class="mk">Slots</span></div>
      </div>${tierRamp(a.capability)}</div>
    <div class="card-actions"><span class="hire-state ${hired ? 'on' : ''}">${hired ? 'Hired' : 'Not hired'}</span>${hireControl(a, hired, canManage)}</div>
  </article>`;
}

/** The tier <select> for the create form — pre-selected to the default for the default vendor's
 *  placeholder model so the first render already SHOWS a sensible tier (re-derived on model input). */
function tierSelect(selected: Tier): string {
  const opts = TIERS.map(
    (t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${esc(TIER_LABEL[t])}</option>`
  ).join('');
  return `<select id="ca-tier" class="ca-input" name="maxTier" aria-describedby="ca-tier-hint">${opts}</select>`;
}

/** The reveal-on-demand create-agent form. Hidden by default; toggled in `wireRoster`. Every field
 *  has a real <label for>, native controls, and an inline error as role=alert. The tier is pre-filled
 *  from the default vendor's placeholder model (re-derived as the user types). */
function createForm(): string {
  const defVendor = CREATE_VENDORS[0]!;
  const defTier = defaultTierForModel(defVendor.value, defVendor.modelPlaceholder);
  const vendorOpts = CREATE_VENDORS.map(
    (v) => `<option value="${v.value}">${esc(v.label)}</option>`
  ).join('');
  return `<form class="ca-form" data-ca-form hidden>
      <div class="ca-grid">
        <div class="ca-field">
          <label class="ca-label" for="ca-name">Name <span class="ca-req">(required)</span></label>
          <input id="ca-name" class="ca-input" type="text" name="name" required maxlength="80"
            autocomplete="off" spellcheck="false" placeholder="Elvis" />
        </div>
        <div class="ca-field">
          <label class="ca-label" for="ca-vendor">Vendor</label>
          <select id="ca-vendor" class="ca-input" name="vendor">${vendorOpts}</select>
        </div>
        <div class="ca-field">
          <label class="ca-label" for="ca-model">Model <span class="ca-req">(required)</span></label>
          <input id="ca-model" class="ca-input mono" type="text" name="model" required maxlength="120"
            autocomplete="off" spellcheck="false" placeholder="${esc(defVendor.modelPlaceholder)}" />
        </div>
        <div class="ca-field">
          <label class="ca-label" for="ca-tier">Tier</label>
          ${tierSelect(defTier)}
          <p class="ca-hint" id="ca-tier-hint">Auto-set from the model; change it if you want.</p>
        </div>
        <div class="ca-field ca-field-wide">
          <label class="ca-label" for="ca-avatar">Avatar URL <span class="ca-opt">(optional)</span></label>
          <input id="ca-avatar" class="ca-input" type="url" name="avatarUrl" maxlength="500"
            autocomplete="off" spellcheck="false" placeholder="https://…" />
        </div>
      </div>
      <div class="ca-actions">
        <button class="btn-add" type="submit" data-act="ca-save">Create agent</button>
        <button class="ictl" type="button" data-act="ca-cancel">Cancel</button>
      </div>
      <!-- role=alert is ALWAYS present (collapsed via :empty in CSS) so an injected message is announced;
           tabindex=-1 lets a server-error handler move focus here. -->
      <p class="ca-err" data-ca-err role="alert" tabindex="-1"></p>
    </form>`;
}

export async function loadRoster(): Promise<LoadResult> {
  // The agent list drives the page; the hired set + role are best-effort enrichments (a failure of
  // either degrades to "not hired" / non-admin — never blocks the roster, never falsely enables).
  const [res, hiredRes, canManage] = await Promise.all([getAgents(), getHiredAgents(), canManageActiveOrg()]);
  const hiredSet = new Set(hiredRes.kind === 'ok' ? hiredRes.data.agents.map((h) => h.agentId) : []);

  return fromResult(res, (agents) => {
    // "Create agent" is member+ (any logged-in member) — NOT gated on canManage. The reveal-on-demand
    // form lives in the header (mirrors the Settings vendor-keys / invite reveal pattern).
    const head = `<div class="roster-head">
        <div><h1>Your team</h1><div class="sub"><b>${agents.length}</b> ${agents.length === 1 ? 'agent' : 'agents'} · <b>${agents.filter((a) => a.state !== 'idle').length}</b> active</div></div>
        <button class="btn-add" type="button" data-act="ca-open" aria-label="Create an agent">${I.plus} Create agent</button>
      </div>${createForm()}`;

    if (!agents.length) {
      return {
        kind: 'empty',
        html:
          head +
          empty(
            'No agents yet',
            'Create your first agent above — it joins your roster and is ready to route.',
            I.roster
          ),
      };
    }
    return {
      kind: 'ok',
      html: `${head}${healthStrip(agents)}<div class="agent-grid">${agents.map((a) => card(a, hiredSet.has(a.id), canManage)).join('')}</div>`,
    };
  });
}

/** Honest failure copy for hire/unhire — covers the real outcomes (already hired/not hired → 409/404,
 *  not-admin-or-stale-CSRF → 403). Truth is always re-rendered (rerun); this names what happened. */
function describeRosterFailure(r: WriteResult<unknown>): string {
  switch (r.kind) {
    case 'conflict':
      return 'Roster already up to date — showing the latest.';
    case 'notfound':
      return 'That agent isn’t available to change — showing the latest.';
    case 'forbidden':
      return 'Couldn’t apply — you may not have admin rights, or your session token expired. Showing the latest.';
    case 'unconfigured':
      return 'Roster management isn’t enabled on this workspace yet.';
    case 'error':
      return `Couldn’t apply the change (${r.message}). Showing the latest.`;
    default:
      return 'Couldn’t apply the change. Showing the latest.';
  }
}

/** Honest failure copy for create-agent. A validation failure (400) rides the conflict channel
 *  carrying the server's `error` message — surfaced verbatim so the user can fix the field. */
function describeCreateFailure(r: WriteResult<unknown>): string {
  if (r.kind === 'conflict') {
    const msg = (r.data as { error?: string } | undefined)?.error;
    return msg ? `That didn’t validate: ${msg}` : 'That didn’t validate — check the fields and retry.';
  }
  // NOTE: unlike the hire path, create does NOT rerun on failure (the form stays open with the entered
  // values for correction), so these messages must NOT promise "showing the latest" — nothing refreshed.
  switch (r.kind) {
    case 'forbidden':
      return 'Couldn’t create — your session token expired, or you’re not a member of this workspace.';
    case 'unconfigured':
      return 'Creating agents isn’t enabled on this workspace yet.';
    case 'error':
      return `Couldn’t create the agent (${r.message}).`;
    default:
      return 'Couldn’t create the agent.';
  }
}

/** Wire the per-card hire/unhire controls + the member+ create-agent form (mount passes `rerun` =
 *  re-fetch + re-render from truth). */
export function wireRoster(el: HTMLElement, rerun: () => Promise<void>): void {
  el.querySelectorAll<HTMLButtonElement>('.hire-ctl[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.agentId;
      if (!id) return;
      const hire = btn.dataset.act === 'hire';
      void liveAction({
        button: btn,
        pendingLabel: hire ? 'Hiring…' : 'Removing…',
        view: el,
        rerun,
        write: (): Promise<WriteResult<unknown>> => (hire ? hireAgent(id) : unhireAgent(id)),
        describe: describeRosterFailure,
      });
    });
  });

  wireCreateAgent(el, rerun);
}

/** Wire the create-agent form: reveal/cancel, the live tier pre-fill from the model/vendor inputs,
 *  and submit. On ok the form clears + the roster re-runs (the new, auto-hired agent appears); on a
 *  400 the server's message surfaces inline (the form stays so the user can correct and retry). */
function wireCreateAgent(el: HTMLElement, rerun: () => Promise<void>): void {
  const form = el.querySelector<HTMLFormElement>('[data-ca-form]');
  if (!form) return;
  const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]');
  const vendorSel = form.querySelector<HTMLSelectElement>('select[name="vendor"]');
  const modelInput = form.querySelector<HTMLInputElement>('input[name="model"]');
  const avatarInput = form.querySelector<HTMLInputElement>('input[name="avatarUrl"]');
  const tierSel = form.querySelector<HTMLSelectElement>('select[name="maxTier"]');
  const errBox = el.querySelector<HTMLElement>('[data-ca-err]');

  // The role=alert region is ALWAYS in the DOM (collapsed via `.ca-err:empty` in CSS); setting its text
  // is what triggers the announcement — toggling a `hidden` region in the same tick is unreliable for SR.
  const showErr = (msg: string): void => {
    if (errBox) errBox.textContent = msg;
  };
  const clearErr = (): void => {
    if (errBox) errBox.textContent = '';
  };

  // Re-derive the tier pre-fill from the current vendor + model so the user SEES the default the
  // backend would pick. Skipped once the user has manually overridden the <select> (data-touched).
  const syncTier = (): void => {
    if (!tierSel || !modelInput || !vendorSel) return;
    if (tierSel.dataset.touched === '1') return;
    tierSel.value = defaultTierForModel(vendorSel.value, modelInput.value);
  };
  modelInput?.addEventListener('input', syncTier);
  vendorSel?.addEventListener('change', syncTier);
  tierSel?.addEventListener('change', () => {
    if (tierSel) tierSel.dataset.touched = '1';
  });

  el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')?.addEventListener('click', () => {
    clearErr();
    form.hidden = false;
    nameInput?.focus();
  });
  el.querySelector<HTMLButtonElement>('[data-act="ca-cancel"]')?.addEventListener('click', () => {
    clearErr();
    form.hidden = true;
    // Return focus to the trigger — else it falls to <body> and a keyboard user is teleported to the top.
    el.querySelector<HTMLButtonElement>('[data-act="ca-open"]')?.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!nameInput || !vendorSel || !modelInput || !tierSel) return;
    const name = nameInput.value.trim();
    const model = modelInput.value.trim();
    if (!name) {
      showErr('Enter a name for the agent.');
      nameInput.focus();
      return;
    }
    if (!model) {
      showErr('Enter a model for the agent.');
      modelInput.focus();
      return;
    }
    const avatarUrl = avatarInput?.value.trim() || undefined;
    const saveBtn = form.querySelector<HTMLButtonElement>('[data-act="ca-save"]');
    if (!saveBtn || saveBtn.dataset.busy === '1') return;
    clearErr();
    // A 400 keeps the form open with the server's reason; only an ok clears + re-runs. So this drives
    // the write directly (rather than liveAction, which always re-runs and discards the form).
    saveBtn.dataset.busy = '1';
    saveBtn.disabled = true;
    saveBtn.setAttribute('aria-busy', 'true');
    const original = saveBtn.textContent;
    saveBtn.textContent = 'Creating…';
    void (async () => {
      let res: WriteResult<NewAgentResponse>;
      try {
        res = await createAgent({ name, vendor: vendorSel.value, model, avatarUrl, maxTier: tierSel.value });
      } catch {
        res = { kind: 'error', message: 'Unexpected error' };
      }
      if (res.kind === 'unauth') {
        redirectToLogin();
        return;
      }
      if (res.kind === 'ok') {
        await rerun(); // the new (auto-hired) agent appears; the form is discarded by the re-render
        return;
      }
      // Restore the button + surface the failure inline (the form stays for correction).
      saveBtn.dataset.busy = '';
      saveBtn.disabled = false;
      saveBtn.removeAttribute('aria-busy');
      saveBtn.textContent = original;
      showErr(describeCreateFailure(res));
      // Move focus to the announced error (tabindex=-1) so a keyboard/SR user lands on it, rather than
      // being stranded on the Save button that appeared to do nothing.
      errBox?.focus();
    })();
  });
}
