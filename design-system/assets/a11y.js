/* ============================================================================
   TASCA · Accessibility runtime  (load with <script src="assets/a11y.js" defer>)
   - Focus-trap + return-focus on any open dialog/drawer/assistant/modal
   - Keyboard activation (Enter/Space) for clickable cards
   - title → aria-label mirroring for icon-only controls
   - window.tascaAnnounce(msg) live-region helper
   Non-invasive: observes the `open` class that existing page scripts already
   toggle, so no per-page rewiring is needed.
   ============================================================================ */
(function () {
  'use strict';

  var FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  /* ---- live region ---------------------------------------------------------- */
  var live = document.createElement('div');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  live.className = 'sr-only';
  live.id = 'tasca-live';
  function ready(fn){ if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function(){ document.body.appendChild(live); });
  window.tascaAnnounce = function (msg) {
    live.textContent = '';
    // rAF so AT registers the change even for identical text
    requestAnimationFrame(function(){ live.textContent = msg; });
  };

  /* ---- focus trap ----------------------------------------------------------- */
  var trapStack = []; // {el, returnTo, handler}

  function focusables(el) {
    return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (n) {
      return n.offsetParent !== null || n === document.activeElement;
    });
  }

  function trap(el) {
    if (trapStack.some(function (t) { return t.el === el; })) return;
    var returnTo = document.activeElement;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');

    var handler = function (e) {
      if (e.key !== 'Tab') return;
      var f = focusables(el);
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', handler);
    trapStack.push({ el: el, returnTo: returnTo, handler: handler });

    // move focus inside
    var f = focusables(el);
    var target = el.querySelector('[autofocus]') || f[0] || el;
    setTimeout(function () { try { target.focus({ preventScroll: true }); } catch (_) {} }, 60);
  }

  function release(el) {
    var i = -1;
    for (var k = 0; k < trapStack.length; k++) if (trapStack[k].el === el) { i = k; break; }
    if (i === -1) return;
    var t = trapStack[i];
    el.removeEventListener('keydown', t.handler);
    el.setAttribute('aria-modal', 'false');
    trapStack.splice(i, 1);
    if (t.returnTo && typeof t.returnTo.focus === 'function') {
      try { t.returnTo.focus({ preventScroll: true }); } catch (_) {}
    }
  }

  /* ---- observe dialog open/close via the `open` class ----------------------- */
  // For .modal-scrim the trap target is the inner .modal; otherwise the el itself.
  function trapTargetFor(el) {
    if (el.classList.contains('modal-scrim')) return el.querySelector('.modal') || el;
    return el;
  }

  function wireDialog(el) {
    var wasOpen = el.classList.contains('open');
    if (wasOpen) trap(trapTargetFor(el));
    var mo = new MutationObserver(function () {
      var isOpen = el.classList.contains('open');
      if (isOpen === wasOpen) return;
      wasOpen = isOpen;
      var tgt = trapTargetFor(el);
      if (isOpen) trap(tgt); else release(tgt);
    });
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  ready(function () {
    document.querySelectorAll('.drawer, .assistant, .modal-scrim').forEach(wireDialog);

    /* ---- keyboard-activatable cards --------------------------------------- */
    // Kanban cards (and anything tagged data-activate) act as buttons.
    document.querySelectorAll('.kanban .kc, [data-activate]').forEach(function (card) {
      if (card.dataset.kbd === '1') return;
      card.dataset.kbd = '1';
      if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
      if (!card.hasAttribute('role')) card.setAttribute('role', 'button');
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          card.click();
        }
      });
      // focus the card on activation so a dialog it opens returns focus here
      card.addEventListener('click', function () {
        try { card.focus({ preventScroll: true }); } catch (_) {}
      });
    });

    /* ---- mirror title → aria-label on icon-only controls ------------------ */
    document.querySelectorAll('button[title], a[title]').forEach(function (b) {
      if (!b.getAttribute('aria-label') && !b.textContent.trim()) {
        b.setAttribute('aria-label', b.getAttribute('title'));
      }
    });
  });
})();
