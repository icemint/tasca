// Project switcher (slice Project-B) — the top-nav control that scopes every task view to one
// project (or "All projects"). A project is a finer filter WITHIN the org; the read API filters by
// the user's server-held active project, so selecting here just sets it server-side and reloads — no
// client-side `?project=` dance, no per-view filter logic.
//
// Available on every authenticated page (mounted from AppShell). It is a custom menu (not a native
// <select>) so each item can carry the project name + repo subtitle + a checkmark on the active one
// (active is NEVER conveyed by color alone). The trigger is a real <button aria-haspopup="menu"
// aria-expanded>; the menu uses role="menuitemradio" with full keyboard operability (Arrow/Home/End/
// Enter/Escape), matching the design brief's a11y gates.

import { getProjects, setActiveProject, clearActiveProject } from './api';
import type { ProjectSummary } from './contract';
import { I, esc } from './ui';

const ALL_PROJECTS = 'All projects';

/** Render the switcher's inner HTML (trigger + menu) for a resolved project list + active id.
 *  Exported for unit tests; the DOM wiring lives in `wireProjectSwitcher`. */
export function projectSwitcherHtml(projects: ProjectSummary[], activeProjectId: string | null): string {
  const active = activeProjectId ? projects.find((p) => p.id === activeProjectId) ?? null : null;
  const label = active ? active.name : ALL_PROJECTS;

  // "All projects" is the first item; it is active when nothing is selected.
  const allItem = menuItem({ id: '', name: ALL_PROJECTS, sub: null, selected: activeProjectId === null });
  const projectItems = projects
    .map((p) => menuItem({ id: p.id, name: p.name, sub: p.repoRef, selected: p.id === activeProjectId }))
    .join('');

  return `<button class="psw-trigger" type="button" data-psw-trigger aria-haspopup="menu" aria-expanded="false"
      aria-label="Project: ${esc(label)} — switch project">
      <span class="psw-label" title="${esc(label)}">${esc(label)}</span>${I.chevron}
    </button>
    <div class="psw-menu" data-psw-menu role="menu" aria-label="Switch project" hidden>${allItem}${projectItems}</div>`;
}

interface ItemSpec {
  id: string; // '' = the All-projects sentinel
  name: string;
  sub: string | null;
  selected: boolean;
}

function menuItem(it: ItemSpec): string {
  // role=menuitemradio + aria-checked carries the active state to assistive tech; the rendered
  // checkmark (I.check) is the non-color signal for sighted users (active-not-by-color-alone).
  const mark = `<span class="psw-check" aria-hidden="true">${it.selected ? I.check : ''}</span>`;
  const sub = it.sub ? `<span class="psw-sub mono">${esc(it.sub)}</span>` : '';
  return `<button class="psw-item${it.selected ? ' is-on' : ''}" type="button" role="menuitemradio"
      aria-checked="${it.selected ? 'true' : 'false'}" data-psw-id="${esc(it.id)}" tabindex="-1">
      ${mark}<span class="psw-text"><span class="psw-name" title="${esc(it.name)}">${esc(it.name)}</span>${sub}</span>
    </button>`;
}

/** Mount the switcher into `host`: fetch the project list once, render, and wire open/close + keyboard
 *  + selection. A read failure renders nothing (the switcher is non-essential chrome — it must never
 *  break the page). Selecting an item sets/clears the active project server-side, then reloads so every
 *  view re-fetches the now-filtered task set (a global scope change; a reload is the robust path). */
export async function mountProjectSwitcher(host: HTMLElement): Promise<void> {
  const res = await getProjects();
  if (res.kind !== 'ok') return; // unauth/error → leave the chrome empty rather than render a broken control
  const { projects, activeProjectId } = res.data;

  host.innerHTML = projectSwitcherHtml(projects, activeProjectId);
  wireProjectSwitcher(host);
}

/** Wire the rendered switcher's behavior. Split out so a DOM test can drive it without the network. */
export function wireProjectSwitcher(host: HTMLElement): void {
  const trigger = host.querySelector<HTMLButtonElement>('[data-psw-trigger]');
  const menu = host.querySelector<HTMLDivElement>('[data-psw-menu]');
  if (!trigger || !menu) return;
  const items = (): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-psw-id]'));

  const open = (): void => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    // Focus the active item (or the first) so keyboard users land on a meaningful row.
    const list = items();
    (list.find((b) => b.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
  };
  const close = (focusTrigger = true): void => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  };
  const isOpen = (): boolean => !menu.hidden;

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });

  // Selection: set or clear the active project, then reload so the views re-fetch the filtered set.
  // `data-psw-busy` guards against a double-select while the write is in flight.
  const select = async (id: string): Promise<void> => {
    if (host.dataset.pswBusy === '1') return;
    host.dataset.pswBusy = '1';
    const result = id === '' ? await clearActiveProject() : await setActiveProject(id);
    if (result.kind === 'ok') {
      close(false);
      if (typeof location !== 'undefined') location.reload();
      return;
    }
    // A non-ok write (a stale/foreign project that 404'd, or a transient error) — reload to re-derive
    // the switcher from server truth: a vanished project drops from the list and the active scope
    // self-corrects, rather than leaving the user bouncing on a control that silently did nothing.
    host.dataset.pswBusy = '0';
    close(false);
    if (typeof location !== 'undefined') location.reload();
  };

  menu.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-psw-id]');
    if (item) void select(item.dataset.pswId ?? '');
  });

  // Roving focus within the menu: Arrow/Home/End move, Enter/Space select, Escape closes.
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const idx = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // Tab leaves the menu — close it (don't trap focus) and let Tab move focus naturally onward, so
      // aria-expanded can't go stale while the user's focus has left the menu (WAI-ARIA menu pattern).
      close(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(idx + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(idx - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (idx >= 0) void select(list[idx]!.dataset.pswId ?? '');
    }
  });

  // Click-away closes (no trigger refocus — the user is acting elsewhere).
  document.addEventListener('click', (e) => {
    if (isOpen() && !host.contains(e.target as Node)) close(false);
  });
}
