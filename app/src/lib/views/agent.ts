// Agent detail (Slice D). One coherent, EDITABLE page for tuning an agent: identity & model (#318/#324),
// capability — tier range + structured specialties + concurrency + cost ceiling (#337/#320), the agent.md
// description (#329), and per-agent platform credentials (#319). Pause/Resume + every Edit/Save is a LIVE
// optimistic control: a save carries the agent's `version` and reconciles to server truth via `liveAction`
// (a stale write 409s → the view re-renders + a banner). Each editable card is its own reveal-on-demand
// form (the established .ca-form / .vk-form idiom) — section-scoped, so credentials stay write-only while
// identity pre-fills. Non-admins get gated roControls (the server is the authority either way).

import {
  getAgent, pauseAgent, resumeAgent, editAgentProfile,
  activeOrgId, getAgentCredentials, setAgentCredential, deleteAgentCredential, testAgentCredential,
  canManageActiveOrg, redirectToLogin, type WriteResult,
} from '../api';
import { fromResult, queryId, type LoadResult } from '../mount';
import { empty } from '../states';
import { liveAction } from '../live';
import {
  I, avatar, vendorChip, statePill, tierRamp, tierTag, pct, money, taskRef, taskLabel,
  PLATFORM_LABEL, TIER_LABEL, esc, roControl, RO_GATE_PROVISION, RO_GATE_AGENT_EDIT, RO_GATE_AGENT_CREDS,
} from '../ui';
import { TIERS, type AgentCredentialStatus, type AgentDetail, type Binding, type Capability, type TaskSummary, type Tier, type Vendor } from '../contract';
import { LANGUAGE_SPECIALTIES, FRAMEWORK_SPECIALTIES, specialtyLabel, isLanguageSpecialty, isFrameworkSpecialty } from '../taxonomy';
import { defaultTierForModel } from './roster';

// The vendors the identity form offers (Claude default — the org's vault key is Anthropic). The model
// placeholder seeds the default-tier hint when a field is blank.
const VENDORS: ReadonlyArray<{ value: Vendor; label: string; modelPlaceholder: string }> = [
  { value: 'claude', label: 'Claude', modelPlaceholder: 'claude-opus-4-8' },
  { value: 'openai', label: 'OpenAI', modelPlaceholder: 'gpt-4o' },
  { value: 'local', label: 'Local', modelPlaceholder: 'qwen2.5-coder' },
];

// The per-agent credential providers (mirrors the server's isAgentCredentialProvider — github + shortcut
// only; anthropic is the ORG vendor key, not an agent token). Each platform gets its own row/form/test
// scoped by data-* (no shared DOM — the single-querySelector trap the spec calls out).
const CREDENTIAL_PROVIDERS: ReadonlyArray<{ value: AgentCredentialStatus['provider']; label: string }> = [
  { value: 'github', label: 'GitHub' },
  { value: 'shortcut', label: 'Shortcut' },
];

/** A visible lifecycle-status chip so a pause/resume is reflected in the UI (the state pill shows
 *  working/idle; status is active/paused/retired). */
function statusBadge(a: AgentDetail): string {
  if (a.status === 'paused') return `<span class="status-chip paused">Paused</span>`;
  if (a.status === 'retired') return `<span class="status-chip retired">Retired</span>`;
  return '';
}

/** The live Pause/Resume control — toggles agent status under optimistic concurrency (carries the
 *  version; a stale write 409s → the view reconciles). */
function pauseControl(a: AgentDetail): string {
  const paused = a.status === 'paused';
  const action = paused ? 'resume' : 'pause';
  const label = paused ? 'Resume' : 'Pause';
  return `<button class="ictl live-ctl" type="button" data-action="${action}" data-agent-id="${esc(a.id)}" data-version="${a.version}" aria-label="${label} ${esc(a.name)}">${paused ? '' : I.pause + ' '}${label}</button>`;
}

// ── Identity bindings (read summary, unchanged) ────────────────────────────────

const BINDING_DOT: Record<Binding['state'], string> = {
  active: 'var(--green)',
  provisioned: 'var(--amber)',
  revoked: 'var(--fg-faint)',
};
const BINDING_LABEL: Record<Binding['state'], string> = {
  active: 'Active',
  provisioned: 'Provisioned',
  revoked: 'Revoked',
};

function bindingRow(b: Binding): string {
  return `<div class="idrow"><div class="idp"><span class="idp-name">${esc(PLATFORM_LABEL[b.platform])}</span>
      <span class="mono idp-h">${b.externalHandle ? esc(b.externalHandle) : '—'}</span></div>
    <span class="idhealth"><span class="d" style="background:${BINDING_DOT[b.state]}"></span>${BINDING_LABEL[b.state]}</span></div>`;
}

function recentRow(t: TaskSummary): string {
  // QA item 325: show the story title (falling back to the story ref) as the row's label — never the raw
  // task UUID, which previously led the row. The UUID stays in the href for navigation.
  return `<a class="recrow" href="/tasks?id=${encodeURIComponent(t.id)}">
    <span class="rec-title">${esc(taskLabel(t))}</span>${tierTag(t.tierEstimate)}<span class="rec-arrow">${I.chevron}</span></a>`;
}

// ── 1. Current work (existing, unchanged) ──────────────────────────────────────

function currentWork(a: AgentDetail): string {
  if (!a.currentTaskId) {
    return `<div class="pcard"><div class="pc-h">Current work</div>
      <div class="work-empty"><div class="we-ico">${I.roster}</div><div><div class="we-t">Idle · available to route</div>
        <div class="we-s">No active task. The routing engine assigns work matching this agent's profile.</div></div>
        ${roControl('Assign a task', { icon: I.plus, cls: 'ictl signal' })}</div></div>`;
  }
  return `<div class="pcard">
    <div class="pc-h">Current work <span class="pc-h-r">${statePill(a.state)}</span></div>
    <div class="taskcard">
      <div class="tc-top">${taskRef(a.currentTaskId)}</div>
      <a class="tc-title" href="/tasks?id=${encodeURIComponent(a.currentTaskId)}">${esc(a.currentTaskId)}</a>
      <div class="tc-meta"><a class="ictl" href="/tasks?id=${encodeURIComponent(a.currentTaskId)}">Inspect routing ${I.arrow}</a></div>
    </div>
    <div class="ictl-row">
      ${roControl('Interrupt')}
      ${roControl('Reassign')}
      ${roControl('Escalate')}
    </div></div>`;
}

// ── 2. Description (agent.md) — NEW (#329). Raw-only for v1 (escaped, mono) — no markdown renderer is
//      bundled, and rendering unsanitized agent.md is stored-XSS (the spec's engineering flag). A
//      Rendered|Raw toggle is offered but both views show the escaped raw text. ──

function descriptionCard(a: AgentDetail, canManage: boolean): string {
  const raw = a.description?.trim() ?? '';
  const editControl = canManage
    ? `<button class="ictl signal" type="button" data-act="desc-edit" aria-label="Edit instructions">Edit</button>`
    : roControl('Edit', { gate: RO_GATE_AGENT_EDIT });

  let body: string;
  if (!raw) {
    const add = canManage
      ? `<button class="ictl signal" type="button" data-act="desc-edit" aria-label="Add instructions">${I.plus} Add instructions</button>`
      : roControl('Add instructions', { icon: I.plus, cls: 'ictl signal', gate: RO_GATE_AGENT_EDIT });
    body = `<div class="work-empty"><div class="we-ico">${I.spark}</div><div><div class="we-t">No instructions yet</div>
        <div class="we-s">Give this agent an agent.md to define how it works.</div></div>${add}</div>`;
  } else {
    // Rendered|Raw segmented toggle. Both panes render the SAME escaped text (no markdown renderer in v1 —
    // see the card comment); the toggle is wired in `wireDescription` to swap a wrap class only.
    body = `<div class="desc-view" data-desc-view>
        <div class="seg desc-seg" role="group" aria-label="Instruction view">
          <button class="seg-b on" type="button" data-act="desc-mode" data-mode="rendered" aria-pressed="true">Rendered</button>
          <button class="seg-b" type="button" data-act="desc-mode" data-mode="raw" aria-pressed="false">Raw</button>
        </div>
        <pre class="desc-body mono" data-desc-body>${esc(raw)}</pre>
      </div>`;
  }

  // The reveal-on-demand textarea (admin+ only) — hidden by default, pre-filled with the raw markdown.
  const form = canManage
    ? `<form class="ca-form desc-form" data-desc-form hidden>
        <label class="ca-label" for="desc-text">Instructions <span class="ca-opt">(agent.md, markdown)</span></label>
        <textarea id="desc-text" class="ca-input mono desc-text" name="description" rows="10" maxlength="20000"
          spellcheck="false" aria-label="Agent instructions (agent.md)" aria-describedby="desc-hint"
          placeholder="# Role&#10;You are…">${esc(raw)}</textarea>
        <p class="ca-hint" id="desc-hint">Stored as the agent's definition. Not yet wired into the live run.</p>
        <div class="ca-actions">
          <button class="btn-add" type="submit" data-act="desc-save">Save instructions</button>
          <button class="ictl" type="button" data-act="desc-cancel">Cancel</button>
        </div>
        <p class="ca-err" data-desc-err role="alert" tabindex="-1"></p>
      </form>`
    : '';

  return `<div class="pcard">
    <div class="pc-h">Description <span class="pc-h-r">${editControl}</span></div>
    <div class="pc-sub">The agent's operating instructions (agent.md). Stored as its definition.</div>
    ${body}${form}</div>`;
}

// ── 4. Identity & model — NEW edit surface (#318, #324) ────────────────────────

function vendorSelect(selected: Vendor | string): string {
  const opts = VENDORS.map(
    (v) => `<option value="${v.value}"${v.value === selected ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
  return `<select id="id-vendor" class="ca-input" name="vendor" data-id-vendor>${opts}</select>`;
}

function identityCard(a: AgentDetail, canManage: boolean): string {
  const editControl = canManage
    ? `<button class="ictl signal" type="button" data-act="id-edit" aria-label="Edit identity and model">Edit</button>`
    : roControl('Edit', { gate: RO_GATE_AGENT_EDIT });

  const read = `<div class="id-read">
      <div class="id-read-av">${avatar(a, 'av-lg')}</div>
      <div class="id-read-meta">
        <div class="cap-row"><span class="cap-k">Name</span><span class="cap-v">${esc(a.name)}</span></div>
        <div class="cap-row"><span class="cap-k">Vendor</span><span class="cap-v">${vendorChip(a.vendor)}</span></div>
        <div class="cap-row"><span class="cap-k">Model</span><span class="cap-v mono">${esc(a.model)}</span></div>
      </div></div>`;

  const placeholder = VENDORS.find((v) => v.value === a.vendor)?.modelPlaceholder ?? 'model-id';
  const form = canManage
    ? `<form class="ca-form" data-id-form hidden>
        <div class="ca-grid">
          <div class="ca-field">
            <label class="ca-label" for="id-name">Name <span class="ca-req">(required)</span></label>
            <input id="id-name" class="ca-input" type="text" name="name" required maxlength="80"
              autocomplete="off" spellcheck="false" value="${esc(a.name)}" />
          </div>
          <div class="ca-field">
            <label class="ca-label" for="id-vendor">Vendor</label>
            ${vendorSelect(a.vendor)}
          </div>
          <div class="ca-field">
            <label class="ca-label" for="id-model">Model <span class="ca-req">(required)</span></label>
            <input id="id-model" class="ca-input mono" type="text" name="model" required maxlength="120"
              autocomplete="off" spellcheck="false" data-id-model value="${esc(a.model)}" placeholder="${esc(placeholder)}" />
            <p class="ca-hint" id="id-tier-hint" data-id-tier-hint aria-live="polite"></p>
          </div>
          <div class="ca-field ca-field-wide">
            <label class="ca-label" for="id-avatar">Avatar URL <span class="ca-opt">(optional)</span></label>
            <input id="id-avatar" class="ca-input" type="url" name="avatarUrl" maxlength="500"
              autocomplete="off" spellcheck="false" value="${esc(a.avatarUrl ?? '')}" placeholder="https://…" />
          </div>
        </div>
        <div class="ca-actions">
          <button class="btn-add" type="submit" data-act="id-save">Save identity</button>
          <button class="ictl" type="button" data-act="id-cancel">Cancel</button>
        </div>
        <p class="ca-err" data-id-err role="alert" tabindex="-1"></p>
      </form>`
    : '';

  return `<div class="pcard">
    <div class="pc-h">Identity &amp; model <span class="pc-h-r">${editControl}</span></div>
    ${read}${form}</div>`;
}

// ── 5. Capability profile — now EDITABLE (#337, #320) ──────────────────────────

function tierSelect(id: string, name: string, selected: Tier, dataAttr: string): string {
  const opts = TIERS.map(
    (t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${esc(TIER_LABEL[t])}</option>`
  ).join('');
  return `<select id="${id}" class="ca-input" name="${name}" ${dataAttr}>${opts}</select>`;
}

/** A removable specialty chip (the wire token in data-token; the human label shown). The "×" is a real
 *  focusable button ≥24px so the chip is keyboard-removable. */
function specChip(token: string): string {
  return `<span class="spec spec-chip" data-spec-chip="${esc(token)}">${esc(specialtyLabel(token))}<button type="button" class="spec-x" data-act="spec-remove" data-token="${esc(token)}" aria-label="Remove ${esc(specialtyLabel(token))}">✕</button></span>`;
}

/** A taxonomy-bound tag-input: the current chips + a constrained <input>+<datalist> that only accepts
 *  taxonomy values. `kind` keys the data-* + the datalist so languages and frameworks don't collide. */
function specInput(kind: 'lang' | 'fw', selected: string[], options: readonly string[]): string {
  const label = kind === 'lang' ? 'Languages' : 'Frameworks';
  const listId = `spec-list-${kind}`;
  const chips = selected.map(specChip).join('');
  const dataOpts = options
    .map((o) => `<option value="${esc(specialtyLabel(o))}" data-token="${esc(o)}"></option>`)
    .join('');
  return `<div class="ca-field ca-field-wide spec-field" data-spec-field="${kind}">
      <label class="ca-label" for="spec-in-${kind}">${label}</label>
      <div class="spec-input">
        <div class="spec-chips" data-spec-chips="${kind}">${chips}</div>
        <input id="spec-in-${kind}" class="ca-input spec-entry" type="text" list="${listId}" autocomplete="off"
          spellcheck="false" data-spec-entry="${kind}" aria-describedby="spec-hint-${kind}" placeholder="Add ${label.toLowerCase()}…" />
        <datalist id="${listId}">${dataOpts}</datalist>
      </div>
      <p class="ca-hint" id="spec-hint-${kind}">Pick from the list — specialties drive routing.</p>
      <p class="ca-err" data-spec-err="${kind}" role="alert"></p>
    </div>`;
}

function capabilityCard(a: AgentDetail, canManage: boolean): string {
  const c = a.capability;
  const specs = [...c.languageSpecialties, ...c.frameworkSpecialties];
  const specList = specs.length
    ? specs.map((s) => `<span class="spec">${esc(specialtyLabel(s))}</span>`).join('')
    : '<span class="mono dim">—</span>';

  const editControl = canManage
    ? `<button class="ictl signal" type="button" data-act="cap-edit" aria-label="Edit capability profile">Edit</button>`
    : roControl('Edit', { gate: RO_GATE_AGENT_EDIT });

  const read = `<div class="cap-read" data-cap-read>
    <div class="cap-row"><span class="cap-k">Tier range</span><span>${tierRamp(c)}</span></div>
    <div class="cap-block"><span class="cap-k">Specialties</span><div class="speclist">${specList}</div></div>
    <div class="cap-row"><span class="cap-k">Concurrency</span><span class="cap-v">${c.concurrencyLimit ?? '—'} slots</span></div>
    <div class="cap-row"><span class="cap-k">Success rate</span><span class="cap-v">${pct(c.successRate)}</span></div>
    <div class="cap-row"><span class="cap-k">Cost ceiling</span><span class="cap-v">${money(c.costCeiling)}</span></div>
  </div>`;

  let form = '';
  if (canManage) {
    const derived = defaultTierForModel(a.vendor, a.model);
    const maxTier = c.maxTier ?? derived;
    const minTier = c.tiersCovered.length
      ? (TIERS.find((t) => c.tiersCovered.includes(t)) ?? maxTier)
      : maxTier;
    const noCap = c.costCeiling === 0;
    form = `<form class="ca-form" data-cap-form hidden>
        <div class="ca-grid">
          <div class="ca-field">
            <label class="ca-label" for="cap-min">Covers from</label>
            ${tierSelect('cap-min', 'minTier', minTier, 'data-cap-min')}
          </div>
          <div class="ca-field">
            <label class="ca-label" for="cap-max">Max tier</label>
            ${tierSelect('cap-max', 'maxTier', maxTier, 'data-cap-max')}
            <p class="ca-hint" id="cap-tier-hint" data-cap-tier-hint aria-live="polite"></p>
          </div>
          <div class="ca-field ca-field-wide">
            <span class="ca-label">Tier ramp preview</span>
            <div class="tier-preview" data-cap-ramp>${tierRamp(rampCapability(minTier, maxTier))}</div>
            <button type="button" class="ca-reset" data-act="cap-tier-reset">Reset to model default (${esc(TIER_LABEL[derived])})</button>
          </div>
          ${specInput('lang', c.languageSpecialties, LANGUAGE_SPECIALTIES)}
          ${specInput('fw', c.frameworkSpecialties, FRAMEWORK_SPECIALTIES)}
          <div class="ca-field">
            <label class="ca-label" for="cap-conc">Concurrency</label>
            <div class="ca-suffixed"><input id="cap-conc" class="ca-input" type="number" name="concurrencyLimit"
              min="1" step="1" inputmode="numeric" value="${c.concurrencyLimit ?? ''}" data-cap-conc
              placeholder="unlimited" /><span class="ca-suffix">slots</span></div>
            <p class="ca-hint">Empty = unlimited.</p>
          </div>
          <div class="ca-field">
            <label class="ca-label" for="cap-cost">Cost ceiling</label>
            <div class="ca-suffixed"><span class="ca-prefix">$</span><input id="cap-cost" class="ca-input" type="number"
              name="costCeiling" min="0" step="1" inputmode="numeric" value="${c.costCeiling ?? ''}" data-cap-cost
              ${noCap ? 'disabled' : ''} placeholder="—" /><span class="ca-suffix">/ day</span></div>
            <label class="ca-check"><input type="checkbox" data-cap-nocap ${noCap ? 'checked' : ''} aria-describedby="cap-cost-hint" /> No cap</label>
            <p class="ca-hint" id="cap-cost-hint">No cap = local, unmetered (0). Empty = no ceiling set (—).</p>
          </div>
        </div>
        <div class="ca-actions">
          <button class="btn-add" type="submit" data-act="cap-save">Save capability</button>
          <button class="ictl" type="button" data-act="cap-cancel">Cancel</button>
        </div>
        <p class="ca-err" data-cap-err role="alert" tabindex="-1"></p>
      </form>`;
  }

  return `<div class="pcard">
    <div class="pc-h">Capability profile <span class="pc-h-r">${editControl}</span></div>
    ${read}${form}</div>`;
}

/** The covered-tiers list spanning min..max (inclusive) — what the tierRamp preview consumes so the
 *  ramp lights up the chosen range. */
function rampCovered(min: Tier, max: Tier): Tier[] {
  const lo = TIERS.indexOf(min);
  const hi = TIERS.indexOf(max);
  if (lo < 0 || hi < 0 || lo > hi) return [max];
  return TIERS.slice(lo, hi + 1) as Tier[];
}

/** A minimal Capability for the tierRamp preview (only maxTier + tiersCovered are read by it; the rest
 *  are placeholders so the type checks without leaking a fake metric anywhere visible). */
function rampCapability(min: Tier, max: Tier): Capability {
  return { maxTier: max, tiersCovered: rampCovered(min, max), languageSpecialties: [], frameworkSpecialties: [], concurrencyLimit: null, costCeiling: null, successRate: null };
}

// ── 6. Platform credentials — per-agent token binding + test (#319) ────────────
// Mirrors the Settings vendor-key card EXACTLY (masked ••••<fingerprint>, Set/Replace reveals a BLANK
// input, two-step Remove) so the two credential UIs are identical; the agent card additionally has the
// connection-test state machine (idle→testing→pass/fail). Each provider is scoped by data-provider — no
// shared DOM.

function credFingerprint(fp: string | null): string {
  if (!fp) return '';
  return `<span class="vk-fp mono">token ••••${esc(fp)}</span>`;
}

function credStatusBadge(active: boolean): string {
  return active
    ? `<span class="conn-status ok"><span class="d"></span>Active</span>`
    : `<span class="conn-status off"><span class="d hollow"></span>Not configured</span>`;
}

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const m = Math.round((Date.now() - then) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function credentialRow(
  provider: { value: AgentCredentialStatus['provider']; label: string },
  cred: AgentCredentialStatus | undefined,
  canManage: boolean
): string {
  const active = cred?.status === 'active';
  const p = provider.value;
  const meta = active
    ? `${credFingerprint(cred?.fingerprint ?? null)}<span class="vk-when">Validated ${esc(relTime(cred?.lastValidatedAt ?? null))}</span>`
    : `<span class="vk-when">No token set for this platform.</span>`;

  let controls: string;
  if (!canManage) {
    controls = roControl('Set token', { gate: RO_GATE_AGENT_CREDS });
  } else if (active) {
    controls =
      `<button class="ictl signal" type="button" data-act="cred-edit" data-provider="${p}" aria-label="Replace the ${esc(provider.label)} token">Replace token</button>` +
      `<button class="ictl vk-danger" type="button" data-act="cred-remove" data-provider="${p}" aria-label="Remove the ${esc(provider.label)} token">Remove</button>`;
  } else {
    controls = `<button class="ictl signal" type="button" data-act="cred-edit" data-provider="${p}" aria-label="Set the ${esc(provider.label)} token">${I.plus} Set token</button>`;
  }

  // The reveal-on-demand set/replace form: a BLANK write-only input (never pre-filled), a Test control
  // (the connection-test state machine), Save/Cancel. Hidden by default, scoped by data-provider.
  const form = canManage
    ? `<form class="vk-form cred-form" data-cred-form="${p}" hidden>
        <label class="vk-label" for="cred-in-${p}">${active ? 'Replace' : 'Set'} ${esc(provider.label)} token</label>
        <input id="cred-in-${p}" class="vk-input mono" type="password" name="token" autocomplete="off" spellcheck="false"
          placeholder="Paste the platform token" aria-label="${esc(provider.label)} token" data-cred-input="${p}" />
        <div class="conn-test" data-conn-test="${p}">
          <button class="ictl" type="button" data-act="cred-test" data-provider="${p}" aria-label="Test the ${esc(provider.label)} connection">Test connection</button>
          <span class="conn-test-result" data-conn-result="${p}" role="status" aria-live="polite"></span>
        </div>
        <div class="vk-form-actions">
          <button class="btn-add" type="submit" data-act="cred-save" data-provider="${p}">Save token</button>
          <button class="ictl" type="button" data-act="cred-cancel" data-provider="${p}">Cancel</button>
        </div>
        <p class="vk-err" data-cred-err="${p}" hidden role="alert"></p>
      </form>`
    : '';

  const confirm = canManage && active
    ? `<div class="vk-confirm" data-cred-confirm="${p}" hidden>
        <span class="vk-confirm-q">Remove the ${esc(provider.label)} token? The agent loses access to ${esc(provider.label)} until a new one is set.</span>
        <div class="vk-confirm-actions">
          <button class="ictl vk-danger" type="button" data-act="cred-remove-confirm" data-provider="${p}" aria-label="Confirm removing the ${esc(provider.label)} token">Confirm remove</button>
          <button class="ictl" type="button" data-act="cred-remove-cancel" data-provider="${p}">Cancel</button>
        </div>
      </div>`
    : '';

  return `<div class="vk-row">
      <div class="vk-id"><div class="vk-name">${esc(provider.label)}</div><div class="vk-meta">${meta}</div></div>
      <div class="vk-status">${credStatusBadge(active)}</div>
      <div class="vk-actions">${controls}</div>
    </div>${form}${confirm}`;
}

/** The Platform credentials card. `creds` is null when the read failed / the org couldn't be resolved —
 *  the rows degrade to "Not configured" honestly (never falsely "active"). `orgId` is stamped on the
 *  card so the wiring can build the org-scoped endpoint paths. */
function credentialsCard(a: AgentDetail, creds: AgentCredentialStatus[] | null, orgId: string | null, canManage: boolean): string {
  const byProvider = new Map((creds ?? []).map((c) => [c.provider, c]));
  const rows = CREDENTIAL_PROVIDERS.map((p) => credentialRow(p, byProvider.get(p.value), canManage)).join('');
  return `<div class="pcard" data-cred-card${orgId ? ` data-org-id="${esc(orgId)}"` : ''} data-agent-id="${esc(a.id)}">
    <div class="pc-h">Platform credentials</div>
    <div class="pc-sub">Each token lets this agent act on a platform AS ITSELF. Write-only — the stored token is never shown again.</div>
    ${rows}</div>`;
}

export async function loadAgent(): Promise<LoadResult> {
  const id = queryId();
  if (!id) {
    return { kind: 'empty', html: empty('No agent selected', 'Pick an agent from your team to see its profile.', I.roster) };
  }
  // The agent drives the page; the role + credentials + org are best-effort enrichments (a failure
  // degrades to read-only / "not configured" — never blocks the page, never falsely enables an edit).
  const [res, canManage, orgId] = await Promise.all([getAgent(id), canManageActiveOrg(), activeOrgId()]);
  const credsRes = orgId ? await getAgentCredentials(orgId, id) : null;
  const creds = credsRes?.kind === 'ok' ? credsRes.data.credentials : null;

  return fromResult(res, (a) => {
    const head = `<div class="vhead">
        <a class="vback" href="/roster">${I.back} Your team</a>
        <div class="vh-main">
          <div class="vh-id">${avatar(a, 'av-xl')}
            <div><h1 class="vh-name">${esc(a.name)}</h1>
              <div class="vh-meta">${vendorChip(a.vendor)}<span class="mono dim">${esc(a.model)}</span>${statePill(a.state)}${statusBadge(a)}</div></div></div>
          <div class="vh-actions">
            ${pauseControl(a)}
            ${canManage
              ? `<button class="ictl signal" type="button" data-act="id-edit" aria-label="Edit profile">Edit profile</button>`
              : roControl('Edit profile', { gate: RO_GATE_AGENT_EDIT })}
            ${roControl('Deploy', { gate: RO_GATE_PROVISION })}
          </div>
        </div></div>`;

    const bindings = a.bindings.length
      ? a.bindings.map(bindingRow).join('')
      : '<div class="we-s" style="padding:8px 0">No platform identities yet.</div>';
    const recent = a.recentTasks.length
      ? a.recentTasks.map(recentRow).join('')
      : '<div class="we-s" style="padding:8px 0">No recent work yet.</div>';

    const html = `${head}
      <div class="pcols">
        <div class="pcol">${currentWork(a)}
          ${descriptionCard(a, canManage)}
          <div class="pcard"><div class="pc-h">Recent work</div>${recent}</div></div>
        <div class="pcol">
          ${identityCard(a, canManage)}
          ${capabilityCard(a, canManage)}
          <div class="pcard"><div class="pc-h">Identity bindings</div>
            <div class="pc-sub">The native identity this agent acts as inside each platform — its own actor, never impersonating a human teammate.</div>
            ${bindings}</div>
          ${credentialsCard(a, creds, orgId, canManage)}
        </div></div>`;
    return { kind: 'ok', html };
  });
}

// ── Wiring ─────────────────────────────────────────────────────────────────────

/** Wire the agent view's live controls after each render; `rerun` reconciles to server truth (mount
 *  passes it). Re-reads id/version from the DOM each render. */
export function wireAgent(el: HTMLElement, rerun: () => Promise<void>): void {
  wirePause(el, rerun);
  wireDescription(el, rerun);
  wireIdentity(el, rerun);
  wireCapability(el, rerun);
  wireCredentials(el, rerun);
}

function wirePause(el: HTMLElement, rerun: () => Promise<void>): void {
  const btn = el.querySelector<HTMLButtonElement>('.live-ctl[data-action]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const id = btn.dataset.agentId ?? '';
    const version = Number(btn.dataset.version);
    const action = btn.dataset.action;
    void liveAction({
      button: btn,
      pendingLabel: action === 'pause' ? 'Pausing…' : 'Resuming…',
      view: el,
      rerun,
      write: () => (action === 'pause' ? pauseAgent(id, version) : resumeAgent(id, version)),
    });
  });
}

/** Read the agent id + version from the credentials/pause controls each render (the page carries one
 *  agent; the version lives on the live pause control). */
function agentId(el: HTMLElement): string {
  return el.querySelector<HTMLButtonElement>('.live-ctl[data-action]')?.dataset.agentId
    ?? el.querySelector<HTMLElement>('[data-cred-card]')?.dataset.agentId
    ?? '';
}
function agentVersion(el: HTMLElement): number {
  return Number(el.querySelector<HTMLButtonElement>('.live-ctl[data-action]')?.dataset.version ?? '0');
}

// ── 2. Description wiring ──────────────────────────────────────────────────────

function wireDescription(el: HTMLElement, rerun: () => Promise<void>): void {
  const form = el.querySelector<HTMLFormElement>('[data-desc-form]');
  const textarea = form?.querySelector<HTMLTextAreaElement>('textarea[name="description"]') ?? null;
  const errBox = el.querySelector<HTMLElement>('[data-desc-err]');
  const view = el.querySelector<HTMLElement>('[data-desc-view]');

  const clearErr = (): void => { if (errBox) errBox.textContent = ''; };

  // Rendered|Raw toggle — both panes show the escaped raw text (no markdown renderer in v1); the toggle
  // only swaps the pressed state + a wrap class, so it never injects unsanitized HTML.
  el.querySelectorAll<HTMLButtonElement>('[data-act="desc-mode"]').forEach((b) => {
    b.addEventListener('click', () => {
      el.querySelectorAll<HTMLButtonElement>('[data-act="desc-mode"]').forEach((o) => {
        const on = o === b;
        o.classList.toggle('on', on);
        o.setAttribute('aria-pressed', String(on));
      });
      view?.querySelector<HTMLElement>('[data-desc-body]')?.classList.toggle('raw', b.dataset.mode === 'raw');
    });
  });

  el.querySelectorAll<HTMLButtonElement>('[data-act="desc-edit"]').forEach((b) =>
    b.addEventListener('click', () => {
      clearErr();
      if (view) view.hidden = true;
      if (form) form.hidden = false;
      textarea?.focus();
    })
  );
  el.querySelector<HTMLButtonElement>('[data-act="desc-cancel"]')?.addEventListener('click', () => {
    clearErr();
    if (form) form.hidden = true;
    if (view) view.hidden = false;
    // Return focus to the Edit trigger (the first one — header/card share the data-act).
    el.querySelector<HTMLButtonElement>('[data-act="desc-edit"]')?.focus();
  });

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!textarea) return;
    const saveBtn = form.querySelector<HTMLButtonElement>('[data-act="desc-save"]');
    if (!saveBtn || saveBtn.dataset.busy === '1') return;
    clearErr();
    const id = agentId(el);
    const version = agentVersion(el);
    // Empty textarea → null (clears the instructions); a value trims trailing whitespace.
    const description = textarea.value.trim() ? textarea.value : null;
    void liveAction({
      button: saveBtn,
      pendingLabel: 'Saving…',
      view: el,
      rerun,
      write: (): Promise<WriteResult<unknown>> => editAgentProfile(id, version, capabilityPatch(el, { description })),
    });
  });
}

// ── 4. Identity wiring ─────────────────────────────────────────────────────────

function wireIdentity(el: HTMLElement, rerun: () => Promise<void>): void {
  const form = el.querySelector<HTMLFormElement>('[data-id-form]');
  if (!form) return;
  const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]');
  const vendorSel = form.querySelector<HTMLSelectElement>('[data-id-vendor]');
  const modelInput = form.querySelector<HTMLInputElement>('[data-id-model]');
  const avatarInput = form.querySelector<HTMLInputElement>('input[name="avatarUrl"]');
  const tierHint = form.querySelector<HTMLElement>('[data-id-tier-hint]');
  const errBox = el.querySelector<HTMLElement>('[data-id-err]');

  const showErr = (msg: string): void => { if (errBox) errBox.textContent = msg; };
  const clearErr = (): void => { if (errBox) errBox.textContent = ''; };

  // Surface the model-default tier as an HONEST hint when vendor/model change — never silently mutate the
  // capability card (the spec's #324 ask). The placeholder seeds the derivation when the field is blank.
  const syncHint = (): void => {
    if (!tierHint || !vendorSel || !modelInput) return;
    const vendor = vendorSel.value;
    const model = modelInput.value.trim() || (VENDORS.find((v) => v.value === vendor)?.modelPlaceholder ?? '');
    tierHint.textContent = `Model default tier: ${TIER_LABEL[defaultTierForModel(vendor, model)]}. Set the range in Capability.`;
  };
  syncHint();
  modelInput?.addEventListener('input', syncHint);
  vendorSel?.addEventListener('change', syncHint);

  el.querySelectorAll<HTMLButtonElement>('[data-act="id-edit"]').forEach((b) =>
    b.addEventListener('click', () => {
      clearErr();
      form.hidden = false;
      nameInput?.focus();
    })
  );
  el.querySelector<HTMLButtonElement>('[data-act="id-cancel"]')?.addEventListener('click', () => {
    clearErr();
    form.hidden = true;
    el.querySelector<HTMLButtonElement>('[data-act="id-edit"]')?.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!nameInput || !vendorSel || !modelInput) return;
    const name = nameInput.value.trim();
    const model = modelInput.value.trim();
    if (!name) { showErr('Enter a name for the agent.'); nameInput.focus(); return; }
    if (!model) { showErr('Enter a model for the agent.'); modelInput.focus(); return; }
    const saveBtn = form.querySelector<HTMLButtonElement>('[data-act="id-save"]');
    if (!saveBtn || saveBtn.dataset.busy === '1') return;
    clearErr();
    const id = agentId(el);
    const version = agentVersion(el);
    const avatarUrl = avatarInput?.value.trim() ? avatarInput.value.trim() : null;
    void liveAction({
      button: saveBtn,
      pendingLabel: 'Saving…',
      view: el,
      rerun,
      write: (): Promise<WriteResult<unknown>> =>
        editAgentProfile(id, version, capabilityPatch(el, {
          name,
          vendor: vendorSel.value as Vendor,
          model,
          avatarUrl,
        })),
    });
  });
}

// ── 5. Capability wiring ───────────────────────────────────────────────────────

/** The current capability fields read from the (possibly hidden) capability form, so EVERY save path
 *  (identity, description, capability) sends a full, coherent patch — editAgentProfile's required fields
 *  (maxTier, concurrencyLimit, costCeiling) must always be present, and a partial save must not silently
 *  drop the others. Merges the explicit `extra` (the field the active form changed) over the form's
 *  current values. When the capability form is absent (non-admin can't reach here), falls back to the
 *  read values stamped on the card. */
function capabilityPatch(el: HTMLElement, extra: Record<string, unknown>): {
  maxTier: string; concurrencyLimit: number | null; costCeiling: number | null;
  tiersCovered?: string[]; languageSpecialties?: string[]; frameworkSpecialties?: string[];
  name?: string; vendor?: Vendor; model?: string; avatarUrl?: string | null; description?: string | null;
} {
  const form = el.querySelector<HTMLFormElement>('[data-cap-form]');
  const maxSel = form?.querySelector<HTMLSelectElement>('[data-cap-max]');
  const minSel = form?.querySelector<HTMLSelectElement>('[data-cap-min]');
  const concInput = form?.querySelector<HTMLInputElement>('[data-cap-conc]');
  const costInput = form?.querySelector<HTMLInputElement>('[data-cap-cost]');
  const noCap = form?.querySelector<HTMLInputElement>('[data-cap-nocap]');

  const maxTier = (maxSel?.value ?? 'medium') as Tier;
  const minTier = (minSel?.value ?? maxTier) as Tier;
  const tiersCovered = rampCovered(minTier, maxTier);

  const concRaw = concInput?.value.trim() ?? '';
  const concurrencyLimit = concRaw === '' ? null : Number(concRaw);

  let costCeiling: number | null;
  if (noCap?.checked) costCeiling = 0;
  else {
    const costRaw = costInput?.value.trim() ?? '';
    costCeiling = costRaw === '' ? null : Number(costRaw);
  }

  const base = {
    maxTier,
    concurrencyLimit,
    costCeiling,
    tiersCovered,
    languageSpecialties: readChips(el, 'lang'),
    frameworkSpecialties: readChips(el, 'fw'),
  };
  return { ...base, ...extra };
}

/** Read the current specialty chip tokens for a kind (the wire values, never the labels). */
function readChips(el: HTMLElement, kind: 'lang' | 'fw'): string[] {
  return Array.from(el.querySelectorAll<HTMLElement>(`[data-spec-chips="${kind}"] [data-spec-chip]`))
    .map((c) => c.dataset.specChip ?? '')
    .filter(Boolean);
}

function wireCapability(el: HTMLElement, rerun: () => Promise<void>): void {
  const form = el.querySelector<HTMLFormElement>('[data-cap-form]');
  if (!form) return;
  const read = el.querySelector<HTMLElement>('[data-cap-read]');
  const minSel = form.querySelector<HTMLSelectElement>('[data-cap-min]');
  const maxSel = form.querySelector<HTMLSelectElement>('[data-cap-max]');
  const tierHint = form.querySelector<HTMLElement>('[data-cap-tier-hint]');
  const ramp = form.querySelector<HTMLElement>('[data-cap-ramp]');
  const noCap = form.querySelector<HTMLInputElement>('[data-cap-nocap]');
  const costInput = form.querySelector<HTMLInputElement>('[data-cap-cost]');
  const errBox = el.querySelector<HTMLElement>('[data-cap-err]');
  // The model-default tier derives from the identity form's vendor+model (pre-filled with the agent's
  // current values). Both panes live on the same page, so the override hint stays honest as the operator
  // tunes either card before saving.
  const idVendor = el.querySelector<HTMLSelectElement>('[data-id-vendor]')?.value ?? '';
  const idModel = el.querySelector<HTMLInputElement>('[data-id-model]')?.value.trim() ?? '';
  const derived = defaultTierForModel(idVendor, idModel);

  const showErr = (msg: string): void => { if (errBox) errBox.textContent = msg; };
  const clearErr = (): void => { if (errBox) errBox.textContent = ''; };

  // Live tier-ramp preview + override hint as min/max change. min ≤ max is enforced inline on save; the
  // preview always reflects the chosen ints so the operator SEES the range.
  const refreshTier = (): void => {
    if (!minSel || !maxSel) return;
    const min = minSel.value as Tier;
    const max = maxSel.value as Tier;
    if (ramp) ramp.innerHTML = tierRamp(rampCapability(min, max));
    if (tierHint) {
      tierHint.textContent = max === derived
        ? `Matches the model default (${TIER_LABEL[derived]}).`
        : `Model default: ${TIER_LABEL[derived]}. Overridden to ${TIER_LABEL[max]}.`;
    }
  };
  refreshTier();
  minSel?.addEventListener('change', refreshTier);
  maxSel?.addEventListener('change', refreshTier);
  el.querySelector<HTMLButtonElement>('[data-act="cap-tier-reset"]')?.addEventListener('click', () => {
    if (maxSel) maxSel.value = derived;
    refreshTier();
  });

  // "No cap" toggle → 0 (and disable the $ field); cleared → re-enable (empty = no ceiling).
  noCap?.addEventListener('change', () => {
    if (costInput) {
      costInput.disabled = !!noCap.checked;
      if (noCap.checked) costInput.value = '';
    }
  });

  wireSpecInput(el, 'lang', isLanguageSpecialty);
  wireSpecInput(el, 'fw', isFrameworkSpecialty);

  el.querySelector<HTMLButtonElement>('[data-act="cap-edit"]')?.addEventListener('click', () => {
    clearErr();
    if (read) read.hidden = true;
    form.hidden = false;
    minSel?.focus();
  });
  el.querySelector<HTMLButtonElement>('[data-act="cap-cancel"]')?.addEventListener('click', () => {
    clearErr();
    form.hidden = true;
    if (read) read.hidden = false;
    el.querySelector<HTMLButtonElement>('[data-act="cap-edit"]')?.focus();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!minSel || !maxSel) return;
    // min ≤ max.
    if (TIERS.indexOf(minSel.value as Tier) > TIERS.indexOf(maxSel.value as Tier)) {
      showErr('“Covers from” can’t be higher than the max tier.'); minSel.focus(); return;
    }
    const concInput = form.querySelector<HTMLInputElement>('[data-cap-conc]');
    if (concInput?.value.trim() && Number(concInput.value) < 1) {
      showErr('Concurrency must be 1 or more (leave blank for unlimited).'); concInput.focus(); return;
    }
    if (!noCap?.checked && costInput?.value.trim() && Number(costInput.value) < 0) {
      showErr('Cost ceiling can’t be negative.'); costInput.focus(); return;
    }
    const saveBtn = form.querySelector<HTMLButtonElement>('[data-act="cap-save"]');
    if (!saveBtn || saveBtn.dataset.busy === '1') return;
    clearErr();
    const id = agentId(el);
    const version = agentVersion(el);
    void liveAction({
      button: saveBtn,
      pendingLabel: 'Saving…',
      view: el,
      rerun,
      write: (): Promise<WriteResult<unknown>> => editAgentProfile(id, version, capabilityPatch(el, {})),
    });
  });
}

/** Wire one taxonomy-bound specialty tag-input: add a typed/selected value ONLY if it's in the taxonomy
 *  (an off-taxonomy entry is rejected inline — the server rejects it too, this avoids the doomed round
 *  trip), and remove a chip by pointer or keyboard. Backspace on the empty entry removes the last chip. */
function wireSpecInput(el: HTMLElement, kind: 'lang' | 'fw', inTaxonomy: (s: string) => boolean): void {
  const field = el.querySelector<HTMLElement>(`[data-spec-field="${kind}"]`);
  if (!field) return;
  const chipsWrap = field.querySelector<HTMLElement>(`[data-spec-chips="${kind}"]`);
  const entry = field.querySelector<HTMLInputElement>(`[data-spec-entry="${kind}"]`);
  const datalist = field.querySelector<HTMLDataListElement>('datalist');
  const errBox = field.querySelector<HTMLElement>(`[data-spec-err="${kind}"]`);
  if (!chipsWrap || !entry) return;

  const showErr = (msg: string): void => { if (errBox) errBox.textContent = msg; };
  const clearErr = (): void => { if (errBox) errBox.textContent = ''; };

  // Map a typed display label (e.g. "TypeScript") OR a raw token ("typescript") back to its wire token.
  const toToken = (raw: string): string | null => {
    const v = raw.trim();
    if (!v) return null;
    if (inTaxonomy(v)) return v; // already a wire token
    const opt = Array.from(datalist?.options ?? []).find(
      (o) => o.value.toLowerCase() === v.toLowerCase()
    );
    const token = opt?.dataset.token ?? '';
    return token && inTaxonomy(token) ? token : null;
  };

  const addChip = (raw: string): void => {
    const token = toToken(raw);
    if (!token) { showErr('Pick from the list — specialties drive routing.'); return; }
    if (readChips(el, kind).includes(token)) { entry.value = ''; clearErr(); return; } // dedupe silently
    chipsWrap.insertAdjacentHTML('beforeend', specChip(token));
    entry.value = '';
    clearErr();
  };

  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (entry.value.trim()) addChip(entry.value);
    } else if (e.key === 'Backspace' && entry.value === '') {
      const last = Array.from(chipsWrap.querySelectorAll<HTMLElement>('[data-spec-chip]')).pop();
      last?.remove();
    } else {
      clearErr();
    }
  });
  // A datalist pick fires `change` (not Enter) — commit it.
  entry.addEventListener('change', () => { if (entry.value.trim()) addChip(entry.value); });

  // Chip removal (delegated so chips added after wiring still respond).
  chipsWrap.addEventListener('click', (e) => {
    const x = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act="spec-remove"]');
    if (x) x.closest('[data-spec-chip]')?.remove();
  });
}

// ── 6. Credentials wiring ──────────────────────────────────────────────────────

function describeCredFailure(r: WriteResult<unknown>): string {
  if (r.kind === 'conflict') {
    const code = (r.data as { code?: string } | undefined)?.code;
    if (code === 'key_invalid') return 'That token was rejected by the platform — check it and retry.';
    const err = (r.data as { error?: string } | undefined)?.error;
    return err ? `Couldn’t save: ${err}` : 'Couldn’t save the token. Review and retry.';
  }
  switch (r.kind) {
    case 'forbidden':
      return 'Couldn’t save — you may not have admin rights, or your session token expired. Showing the latest.';
    case 'notfound':
      return 'There’s no token to change — showing the latest.';
    case 'unconfigured':
      return 'Agent credentials aren’t enabled on this workspace yet.';
    case 'error':
      return `Couldn’t save the token (${r.message}). Showing the latest.`;
    default:
      return 'Couldn’t apply the change. Showing the latest.';
  }
}

function wireCredentials(el: HTMLElement, rerun: () => Promise<void>): void {
  const card = el.querySelector<HTMLElement>('[data-cred-card]');
  if (!card) return;
  const orgId = card.dataset.orgId ?? null;
  const agent = card.dataset.agentId ?? '';

  // Per-provider scoping: every lookup is keyed by data-provider so GitHub and Shortcut never share DOM.
  const formFor = (p: string) => el.querySelector<HTMLFormElement>(`[data-cred-form="${p}"]`);
  const inputFor = (p: string) => el.querySelector<HTMLInputElement>(`[data-cred-input="${p}"]`);
  const confirmFor = (p: string) => el.querySelector<HTMLElement>(`[data-cred-confirm="${p}"]`);
  const errFor = (p: string) => el.querySelector<HTMLElement>(`[data-cred-err="${p}"]`);
  const resultFor = (p: string) => el.querySelector<HTMLElement>(`[data-conn-result="${p}"]`);

  const showErr = (p: string, msg: string): void => {
    const e = errFor(p); if (!e) return; e.textContent = msg; e.hidden = false;
  };
  const clearErr = (p: string): void => {
    const e = errFor(p); if (!e) return; e.textContent = ''; e.hidden = true;
  };
  // Reset the connection-test result to idle (re-typing invalidates a prior pass/fail).
  const resetResult = (p: string): void => {
    const r = resultFor(p); if (!r) return; r.className = 'conn-test-result'; r.textContent = '';
  };
  const setResult = (p: string, state: 'testing' | 'pass' | 'fail', reason?: string): void => {
    const r = resultFor(p); if (!r) return;
    if (state === 'testing') { r.className = 'conn-test-result testing'; r.innerHTML = `<span class="d"></span>Testing…`; }
    else if (state === 'pass') { r.className = 'conn-test-result pass'; r.innerHTML = `${I.check} Connection OK`; }
    else { r.className = 'conn-test-result fail'; r.innerHTML = `<span class="d hollow"></span>Couldn’t connect${reason ? ` — ${esc(reason)}` : ''}`; }
  };

  // Reveal the set/replace form (scoped). Hide the confirm + reset prior error/test state.
  el.querySelectorAll<HTMLButtonElement>('[data-act="cred-edit"]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.provider!;
      confirmFor(p)?.setAttribute('hidden', '');
      clearErr(p);
      resetResult(p);
      const f = formFor(p); if (f) f.hidden = false;
      inputFor(p)?.focus();
    })
  );
  // Cancel — clear the write-only input so nothing typed lingers in the DOM; restore focus to the trigger.
  el.querySelectorAll<HTMLButtonElement>('[data-act="cred-cancel"]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.provider!;
      const inp = inputFor(p); if (inp) inp.value = '';
      clearErr(p);
      resetResult(p);
      const f = formFor(p); if (f) f.hidden = true;
      el.querySelector<HTMLButtonElement>(`[data-act="cred-edit"][data-provider="${p}"]`)?.focus();
    })
  );

  // Two-step remove (no window.confirm), scoped.
  el.querySelectorAll<HTMLButtonElement>('[data-act="cred-remove"]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.provider!;
      formFor(p)?.setAttribute('hidden', '');
      confirmFor(p)?.removeAttribute('hidden');
      confirmFor(p)?.querySelector<HTMLButtonElement>('[data-act="cred-remove-confirm"]')?.focus();
    })
  );
  el.querySelectorAll<HTMLButtonElement>('[data-act="cred-remove-cancel"]').forEach((b) =>
    b.addEventListener('click', () => confirmFor(b.dataset.provider!)?.setAttribute('hidden', ''))
  );

  // Re-typing the token invalidates a prior test result (idle).
  CREDENTIAL_PROVIDERS.forEach(({ value: p }) => {
    inputFor(p)?.addEventListener('input', () => resetResult(p));
  });

  // Connection test: idle → testing → pass/fail. Probes the SUBMITTED token (never a stored one).
  el.querySelectorAll<HTMLButtonElement>('[data-act="cred-test"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const p = btn.dataset.provider!;
      const inp = inputFor(p);
      const token = inp?.value.trim() ?? '';
      if (!token) { showErr(p, 'Paste a token to test.'); return; }
      if (!orgId) { showErr(p, 'Couldn’t resolve your workspace — reload and retry.'); return; }
      if (btn.dataset.busy === '1') return;
      clearErr(p);
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      setResult(p, 'testing');
      void (async () => {
        let res: Awaited<ReturnType<typeof testAgentCredential>>;
        try {
          res = await testAgentCredential(orgId, agent, p, token);
        } catch {
          res = { kind: 'error', message: 'Unexpected error' };
        }
        btn.dataset.busy = '';
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        if (res.kind === 'unauth') { redirectToLogin(); return; }
        if (res.kind === 'ok') {
          const data = res.data as { ok: boolean; reason?: string };
          if (data.ok) setResult(p, 'pass');
          else setResult(p, 'fail', data.reason);
          return;
        }
        // A bad-request / transport failure: show the test as failed with an honest reason.
        setResult(p, 'fail');
        showErr(p, describeCredFailure(res));
      })();
    })
  );

  // Save (set/replace): the input is write-only — cleared BEFORE the write resolves so the secret never
  // lingers in the DOM; the view re-renders from server truth (which carries only status + fingerprint).
  el.querySelectorAll<HTMLFormElement>('[data-cred-form]').forEach((form) =>
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const p = form.dataset.credForm!;
      const inp = inputFor(p);
      const token = inp?.value.trim() ?? '';
      if (!token) { showErr(p, 'Paste a token before saving.'); return; }
      if (!orgId) { showErr(p, 'Couldn’t resolve your workspace — reload and retry.'); return; }
      const saveBtn = form.querySelector<HTMLButtonElement>('[data-act="cred-save"]');
      if (!saveBtn || saveBtn.dataset.busy === '1') return;
      clearErr(p);
      if (inp) inp.value = ''; // clear before the write resolves — the local `token` is the only copy
      void liveAction({
        button: saveBtn,
        pendingLabel: 'Saving…',
        view: el,
        rerun,
        write: (): Promise<WriteResult<unknown>> => setAgentCredential(orgId, agent, p, token),
        describe: describeCredFailure,
      });
    })
  );

  // Confirm remove (scoped).
  el.querySelectorAll<HTMLButtonElement>('[data-act="cred-remove-confirm"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const p = btn.dataset.provider!;
      if (!orgId) { showErr(p, 'Couldn’t resolve your workspace — reload and retry.'); return; }
      void liveAction({
        button: btn,
        pendingLabel: 'Removing…',
        view: el,
        rerun,
        write: (): Promise<WriteResult<unknown>> => deleteAgentCredential(orgId, agent, p),
        describe: describeCredFailure,
      });
    })
  );
}
