/**
 * site.js
 * -------
 * Behaviour for the standalone pages (landing, about, how-to-use) — the same
 * sidebar / mobile drawer as the app, plus a "you are here" marker for the
 * in-page menu of the landing page.
 *
 * Plain script (not an ES module) and dependency-free on purpose: these pages
 * are meant to be crawled and opened by anyone, on any host, without the
 * app's state.js / service worker. If this file fails to load, every link
 * still works — only the drawer button and the highlight stop working.
 *
 * It mirrors appShell.js (drawer: hamburger, close button, scrim, Escape,
 * closes when a link is chosen, resets when the window grows to desktop
 * width) but keeps its state in the DOM only (data-drawer on .app-shell).
 */
(function () {
  "use strict";

  var shell = document.querySelector(".app-shell");
  var hamburger = document.querySelector(".app-topbar__hamburger");
  var closeBtn = document.querySelector(".app-sidebar__close");
  var scrim = document.querySelector(".app-sidebar-scrim");
  var sidebar = document.querySelector(".app-sidebar");
  var main = document.querySelector(".app-main");

  /* ---------- Drawer (mobile) ---------- */

  if (shell && hamburger) {
    var setDrawer = function (isOpen) {
      shell.dataset.drawer = isOpen ? "open" : "closed";
      hamburger.setAttribute("aria-expanded", String(isOpen));
    };
    var isOpen = function () {
      return shell.dataset.drawer === "open";
    };

    hamburger.addEventListener("click", function () {
      setDrawer(!isOpen());
    });
    if (closeBtn) closeBtn.addEventListener("click", function () { setDrawer(false); });
    if (scrim) scrim.addEventListener("click", function () { setDrawer(false); });

    // Choosing any link closes the drawer, including the links that open
    // another tab (otherwise the menu stays open over the page).
    if (sidebar) {
      sidebar.addEventListener("click", function (event) {
        if (event.target.closest("a") && isOpen()) setDrawer(false);
      });
    }

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && isOpen()) setDrawer(false);
    });

    if (window.matchMedia) {
      var mobileQuery = window.matchMedia("(max-width: 768px)");
      var onChange = function (event) {
        if (!event.matches) setDrawer(false);
      };
      if (mobileQuery.addEventListener) mobileQuery.addEventListener("change", onChange);
      else if (mobileQuery.addListener) mobileQuery.addListener(onChange);
    }
  }

  /* ---------- In-page menu: highlight the section being read ---------- */

  var links = Array.prototype.slice.call(
    document.querySelectorAll('.app-sidebar__link[href^="#"]')
  );
  var entries = [];
  links.forEach(function (link) {
    var id = decodeURIComponent(link.getAttribute("href").slice(1));
    var target = id ? document.getElementById(id) : null;
    if (target) entries.push({ link: link, target: target });
  });

  if (entries.length) {
    var ticking = false;

    var atBottom = function () {
      // Desktop: .app-main scrolls. Mobile: the document scrolls.
      var mainScrolls = main && main.scrollHeight > main.clientHeight + 1 &&
        getComputedStyle(main).overflowY !== "visible";
      if (mainScrolls) return main.scrollTop + main.clientHeight >= main.scrollHeight - 4;
      var doc = document.documentElement;
      return window.pageYOffset + window.innerHeight >= doc.scrollHeight - 4;
    };

    var update = function () {
      ticking = false;
      // A section counts as "current" once its top has passed this line
      var line = Math.max(120, window.innerHeight * 0.25);
      var current = entries[0];
      entries.forEach(function (entry) {
        if (entry.target.getBoundingClientRect().top <= line) current = entry;
      });
      // The last section may be too short to ever reach the line
      if (atBottom()) current = entries[entries.length - 1];

      entries.forEach(function (entry) {
        if (entry === current) entry.link.setAttribute("aria-current", "location");
        else entry.link.removeAttribute("aria-current");
      });
    };

    var schedule = function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    };

    if (main) main.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
  }
})();
