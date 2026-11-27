// RuleCanvasKit hub: theme switch and copy button.
// Uses the same storage key and allowlist as useWorkbenchTheme so the hub and
// both workbenches share one preference on the same origin.
(function () {
  'use strict';

  var STORAGE_KEY = 'rulecanvas-theme';
  var root = document.documentElement;
  var media =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function toPreference(raw) {
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  }

  function readPreference() {
    try {
      return toPreference(window.localStorage.getItem(STORAGE_KEY));
    } catch (_e) {
      return 'system';
    }
  }

  function resolve(pref) {
    return pref === 'dark' || (pref === 'system' && media !== null && media.matches) ? 'dark' : 'light';
  }

  function apply(pref) {
    var resolved = resolve(pref);
    // Switch without animating every color token at once.
    var guard = document.createElement('style');
    guard.textContent = '*,*::before,*::after{transition:none!important}';
    document.head.appendChild(guard);
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-preference', pref);
    root.style.colorScheme = resolved;
    void window.getComputedStyle(root).color;
    window.requestAnimationFrame(function () {
      guard.remove();
    });
    var buttons = document.querySelectorAll('[data-theme-option]');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      button.setAttribute('aria-pressed', button.getAttribute('data-theme-option') === pref ? 'true' : 'false');
    }
  }

  function setPreference(pref) {
    try {
      window.localStorage.setItem(STORAGE_KEY, pref);
    } catch (_e) {
      // Storage can be unavailable (private mode); the choice still applies to this page.
    }
    apply(pref);
  }

  function initTheme() {
    apply(readPreference());
    var buttons = document.querySelectorAll('[data-theme-option]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function (event) {
        setPreference(toPreference(event.currentTarget.getAttribute('data-theme-option')));
      });
    }
    if (media !== null && typeof media.addEventListener === 'function') {
      media.addEventListener('change', function () {
        if (readPreference() === 'system') apply('system');
      });
    }
    window.addEventListener('storage', function (event) {
      if (event.key === STORAGE_KEY) apply(readPreference());
    });
  }

  function initCopy() {
    var buttons = document.querySelectorAll('[data-copy-target]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function (event) {
        var button = event.currentTarget;
        var target = document.getElementById(button.getAttribute('data-copy-target') || '');
        var note = button.closest('.code-block') && button.closest('.code-block').querySelector('.code-note');
        if (target === null) return;
        var text = target.textContent || '';
        var report = function (message) {
          if (note) note.textContent = message;
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(
            function () {
              report('Copied to the clipboard.');
            },
            function () {
              report('Copy failed. Select the commands and copy them manually.');
            },
          );
        } else {
          report('Copy is unavailable here. Select the commands and copy them manually.');
        }
      });
    }
  }

  initTheme();
  initCopy();
})();
