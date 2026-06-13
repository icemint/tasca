// @vitest-environment happy-dom
// Project switcher (slice Project-B): the top-nav control that scopes the task views to one project
// (or "All projects"). DOM-driven — mounts against a stubbed fetch and drives clicks/keys to prove:
// the list + "All projects" render, the active one is marked (checkmark + aria-checked, not color
// alone), selecting a project calls setActiveProject + reloads, "All projects" calls clearActiveProject
// + reloads, and the menu is keyboard-operable (Arrow/Escape, aria-expanded).

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mountProjectSwitcher,
  projectSwitcherHtml,
  wireProjectSwitcher,
} from './project-switcher';
import { _resetCsrfForTest } from './api';
import type { ProjectSummary } from './contract';
import { stubFetch } from './test-support';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetCsrfForTest();
  document.body.innerHTML = '';
});

const PROJECTS: ProjectSummary[] = [
  { id: 'p1', name: 'api', repoRef: 'acme/api' },
  { id: 'p2', name: 'billing', repoRef: 'acme/billing' },
];

/** A reload-spy installed on a stubbed `location` (happy-dom's location.reload is read-only). */
function stubLocation(): () => number {
  let reloads = 0;
  vi.stubGlobal('location', { reload: () => { reloads++; }, search: '' });
  return () => reloads;
}

/** Mount a wired switcher ATTACHED to the document so `.focus()` works in happy-dom. */
function mountHost(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  wireProjectSwitcher(host);
  return host;
}

describe('projectSwitcherHtml — rendering + active marking', () => {
  it('renders "All projects" first, then each project with its repo subtitle', () => {
    const host = document.createElement('div');
    host.innerHTML = projectSwitcherHtml(PROJECTS, null);
    const items = Array.from(host.querySelectorAll('[data-psw-id]'));
    expect(items.map((i) => i.getAttribute('data-psw-id'))).toEqual(['', 'p1', 'p2']);
    expect(host.textContent).toContain('All projects');
    expect(host.textContent).toContain('api');
    expect(host.textContent).toContain('acme/api'); // repoRef subtitle
  });

  it('marks "All projects" active (checkmark + aria-checked) when nothing is selected', () => {
    const host = document.createElement('div');
    host.innerHTML = projectSwitcherHtml(PROJECTS, null);
    const all = host.querySelector('[data-psw-id=""]')!;
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(all.querySelector('.psw-check svg')).not.toBeNull(); // a checkmark, not color alone
    // No project row is marked.
    expect(host.querySelector('[data-psw-id="p1"]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('marks the active PROJECT and labels the trigger with its name (getProjects drives the mark)', () => {
    const host = document.createElement('div');
    host.innerHTML = projectSwitcherHtml(PROJECTS, 'p2');
    expect(host.querySelector('[data-psw-id="p2"]')!.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[data-psw-id="p2"]')!.querySelector('.psw-check svg')).not.toBeNull();
    expect(host.querySelector('.psw-label')!.textContent).toBe('billing');
  });
});

describe('mountProjectSwitcher — fetches the list once and renders', () => {
  it('renders the active org’s projects + the active mark from GET /api/projects', async () => {
    stubFetch({ '/api/projects': { body: { projects: PROJECTS, activeProjectId: 'p1' } } });
    const host = document.createElement('div');
    await mountProjectSwitcher(host);
    expect(host.querySelector('.psw-label')!.textContent).toBe('api');
    expect(host.querySelector('[data-psw-id="p1"]')!.getAttribute('aria-checked')).toBe('true');
  });

  it('leaves the chrome empty on a read failure (non-essential — never a broken control)', async () => {
    stubFetch({ '/api/projects': { status: 500 } });
    const host = document.createElement('div');
    await mountProjectSwitcher(host);
    expect(host.querySelector('[data-psw-trigger]')).toBeNull();
  });
});

describe('open/close + keyboard operability', () => {
  it('toggles aria-expanded + the menu on trigger click, and Escape closes', () => {
    const host = mountHost(projectSwitcherHtml(PROJECTS, null));
    const trigger = host.querySelector<HTMLButtonElement>('[data-psw-trigger]')!;
    const menu = host.querySelector<HTMLDivElement>('[data-psw-menu]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(menu.hidden).toBe(true);

    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(menu.hidden).toBe(false);

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('Tab from an open menu CLOSES it (no focus trap; aria-expanded never goes stale)', () => {
    const host = mountHost(projectSwitcherHtml(PROJECTS, null));
    const trigger = host.querySelector<HTMLButtonElement>('[data-psw-trigger]')!;
    const menu = host.querySelector<HTMLDivElement>('[data-psw-menu]')!;
    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // Tab leaves the menu → it closes + aria-expanded resets (WAI-ARIA menu-button pattern).
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('ArrowDown moves focus through the items (roving focus)', () => {
    const host = mountHost(projectSwitcherHtml(PROJECTS, null));
    const trigger = host.querySelector<HTMLButtonElement>('[data-psw-trigger]')!;
    trigger.click(); // opens + focuses the active ("All projects") item
    const all = host.querySelector<HTMLButtonElement>('[data-psw-id=""]')!;
    expect(document.activeElement).toBe(all);

    const menu = host.querySelector<HTMLDivElement>('[data-psw-menu]')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(host.querySelector('[data-psw-id="p1"]'));
  });
});

describe('selection → server write + reload', () => {
  it('selecting a project calls setActiveProject and reloads', async () => {
    const reloads = stubLocation();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]!;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/csrf') return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, activeProjectId: 'p1' }), { status: 200 });
    }));

    const host = mountHost(projectSwitcherHtml(PROJECTS, null));
    host.querySelector<HTMLButtonElement>('[data-psw-id="p1"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toContain('POST /api/active-project'); // the switch write
    expect(reloads()).toBe(1); // the view re-fetches the filtered set
  });

  it('selecting "All projects" calls clearActiveProject (DELETE) and reloads', async () => {
    const reloads = stubLocation();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = String(input).split('?')[0]!;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/csrf') return new Response(JSON.stringify({ token: 't' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, activeProjectId: null }), { status: 200 });
    }));

    const host = mountHost(projectSwitcherHtml(PROJECTS, 'p1'));
    host.querySelector<HTMLButtonElement>('[data-psw-id=""]')!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toContain('DELETE /api/active-project'); // the clear write
    expect(reloads()).toBe(1);
  });
});
