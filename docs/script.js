/* =========================================================================
   WordLens landing page — progressive enhancement only.

   Nothing here is required to read the page. Every section renders, every
   anchor works and the FAQ opens with JavaScript disabled; this file adds the
   sticky header state, the small-screen menu, the scroll reveal and the
   Chrome Web Store gate.

   No cookies, no analytics, no network requests.
   ========================================================================= */

(function () {
  'use strict';

  /* -----------------------------------------------------------------------
     Chrome Web Store gate — THE ONE LINE TO FLIP WHEN THE LISTING IS LIVE
     -----------------------------------------------------------------------
     Set STORE_AVAILABLE to true and paste the listing address into STORE_URL.
     While STORE_AVAILABLE is false the button under "From the Chrome Web
     Store" stays disabled, is skipped by the keyboard, and the badge next to
     the heading keeps saying "Coming soon".
     ----------------------------------------------------------------------- */
  var STORE_AVAILABLE = false;
  var STORE_URL = 'https://chromewebstore.google.com/detail/wordlens';

  var root = document.documentElement;
  var header = document.getElementById('site-header');
  var navToggle = document.getElementById('nav-toggle');
  var nav = document.getElementById('site-nav');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* -----------------------------------------------------------------------
     1. Chrome Web Store button
     ----------------------------------------------------------------------- */
  function applyStoreGate() {
    var button = document.querySelector('[data-store-button]');
    var note = document.querySelector('[data-store-note]');
    var badge = document.querySelector('[data-store-badge]');

    if (!button) {
      return;
    }

    if (STORE_AVAILABLE) {
      button.href = STORE_URL;
      button.target = '_blank';
      button.rel = 'noopener noreferrer';
      button.classList.remove('btn-disabled');
      button.removeAttribute('aria-disabled');
      button.removeAttribute('tabindex');

      if (note) {
        note.textContent = 'Opens on the Chrome Web Store';
      }

      if (badge) {
        badge.textContent = 'Available now';
        badge.classList.remove('badge-soon');
        badge.classList.add('badge-now');
      }
      return;
    }

    button.href = '#store-option';
    button.classList.add('btn-disabled');
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('tabindex', '-1');

    if (note) {
      note.textContent = 'Not published yet';
    }
  }

  /* -----------------------------------------------------------------------
     2. Sticky header: add depth only once the page has moved.
     ----------------------------------------------------------------------- */
  function initHeaderState() {
    if (!header) {
      return;
    }

    var ticking = false;

    function update() {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    }

    function onScroll() {
      if (ticking) {
        return;
      }
      ticking = true;
      window.requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* -----------------------------------------------------------------------
     3. Small-screen menu. aria-expanded lives on the button, aria-controls
        points at the nav, and the panel closes on Escape, on a link click and
        when the viewport grows past the breakpoint.
     ----------------------------------------------------------------------- */
  function initMenu() {
    if (!navToggle || !nav || !header) {
      return;
    }

    var narrow = window.matchMedia('(max-width: 55.999rem)');

    function setOpen(open) {
      header.setAttribute('data-nav-open', open ? 'true' : 'false');
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      navToggle.querySelector('.visually-hidden').textContent = open ? 'Close menu' : 'Menu';
    }

    function isOpen() {
      return header.getAttribute('data-nav-open') === 'true';
    }

    function close(returnFocus) {
      if (!isOpen()) {
        return;
      }
      setOpen(false);
      if (returnFocus) {
        navToggle.focus();
      }
    }

    setOpen(false);

    navToggle.addEventListener('click', function () {
      setOpen(!isOpen());
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        close(false);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        close(true);
      }
    });

    var onBreakpointChange = function (event) {
      if (!event.matches) {
        close(false);
      }
    };

    if (typeof narrow.addEventListener === 'function') {
      narrow.addEventListener('change', onBreakpointChange);
    } else if (typeof narrow.addListener === 'function') {
      narrow.addListener(onBreakpointChange);
    }
  }

  /* -----------------------------------------------------------------------
     4. Scroll reveal. The hidden state is applied by CSS only when the .js
        class is present, so content is never trapped behind an animation.
     ----------------------------------------------------------------------- */
  function initReveal() {
    var targets = document.querySelectorAll('.reveal');

    if (!targets.length) {
      return;
    }

    if (!('IntersectionObserver' in window) || reduceMotion.matches) {
      for (var i = 0; i < targets.length; i++) {
        targets[i].classList.add('is-visible');
      }
      return;
    }

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) {
            return;
          }
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.01 }
    );

    for (var j = 0; j < targets.length; j++) {
      observer.observe(targets[j]);
    }
  }

  /* -----------------------------------------------------------------------
     5. Footer year, so the copyright does not go stale.
     ----------------------------------------------------------------------- */
  function initYear() {
    var year = document.getElementById('year');

    if (year) {
      year.textContent = String(new Date().getFullYear());
    }
  }

  /* ----------------------------------------------------------------------- */
  function init() {
    root.classList.add('js');
    applyStoreGate();
    initHeaderState();
    initMenu();
    initYear();
    initReveal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
