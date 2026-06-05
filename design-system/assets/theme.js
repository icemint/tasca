/* ============================================================================
   TASCA · Theme switcher  (load in <head>, NOT deferred, to avoid FOUC)
   - Applies the saved theme to <html data-theme> before paint
   - window.tascaSetTheme('dark'|'light'|'system')
   - Auto-wires any element with class .theme-switch containing
     <button data-theme-set="dark|light|system">
   ============================================================================ */
(function () {
  'use strict';
  var KEY = 'tasca-theme';
  var mql = window.matchMedia('(prefers-color-scheme: light)');

  function stored() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return mql.matches ? 'light' : 'dark'; // 'system' or null
  }
  function apply(pref) {
    document.documentElement.setAttribute('data-theme', resolve(pref));
  }

  // 1) apply immediately (script is in <head>, before body paints)
  var pref = stored() || 'dark';
  apply(pref);

  // follow system changes only when in 'system' mode
  mql.addEventListener && mql.addEventListener('change', function () {
    if ((stored() || 'dark') === 'system') apply('system');
  });

  window.tascaSetTheme = function (p) {
    try { localStorage.setItem(KEY, p); } catch (_) {}
    apply(p);
    syncControls(p);
    window.dispatchEvent(new CustomEvent('tasca:themechange', { detail: { theme: resolve(p), pref: p } }));
  };
  window.tascaGetTheme = function () { return { pref: stored() || 'dark', theme: resolve(stored() || 'dark') }; };

  function syncControls(p) {
    document.querySelectorAll('.theme-switch [data-theme-set]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-set') === p));
    });
  }

  function wire() {
    document.querySelectorAll('.theme-switch').forEach(function (sw) {
      if (sw.dataset.wired === '1') return;
      sw.dataset.wired = '1';
      sw.setAttribute('role', 'group');
      if (!sw.getAttribute('aria-label')) sw.setAttribute('aria-label', 'Color theme');
      sw.addEventListener('click', function (e) {
        var b = e.target.closest('[data-theme-set]'); if (!b) return;
        window.tascaSetTheme(b.getAttribute('data-theme-set'));
      });
    });
    syncControls(stored() || 'dark');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
