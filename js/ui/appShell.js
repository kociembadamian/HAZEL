/**
 * appShell.js
 * -----------
 * Handles the ONE behavioural difference between desktop and mobile: opening
 * and closing the side drawer. The appearance itself (persistent sidebar vs.
 * hidden behind a hamburger) is already solved in layout.css via a media
 * query; this file only toggles the data-drawer attribute on .app-shell that
 * those styles hook into.
 *
 * Note: this is NOT the wizard navigation (see wizard.js). This file handles
 * only the menu OUTSIDE the wizard — saved scenarios, settings, about.
 *
 * NOTE (2026-09-25): an explicit close button was added inside the drawer
 * (.app-sidebar__close, mobile-only via CSS). Tapping outside the drawer
 * (the scrim) or pressing Escape already closed it — both of those still
 * work exactly as before — but a labelled "close" affordance is easier for
 * a less technical user to find than either of those, which is why it was
 * asked for even though a way to close the menu already existed.
 */

import { state } from "./state.js";

export function initAppShell() {
  const shell = document.querySelector(".app-shell");
  const hamburgerBtn = document.querySelector(".app-topbar__hamburger");
  const closeBtn = document.querySelector(".app-sidebar__close");
  const scrim = document.querySelector(".app-sidebar-scrim");
  const sidebar = document.querySelector(".app-sidebar");

  if (!shell || !hamburgerBtn || !scrim) {
    console.warn("appShell.js: required elements are missing from the DOM");
    return;
  }

  function setDrawerOpen(isOpen) {
    state.update({ drawerOpen: isOpen });
    shell.dataset.drawer = isOpen ? "open" : "closed";
    hamburgerBtn.setAttribute("aria-expanded", String(isOpen));
  }

  hamburgerBtn.addEventListener("click", () => {
    setDrawerOpen(!state.current.drawerOpen);
  });

  // Explicit close button inside the drawer itself.
  closeBtn?.addEventListener("click", () => setDrawerOpen(false));

  // Choosing ANY link inside the drawer should also close it on mobile —
  // otherwise the menu stays open over whatever the person just asked for.
  // Delegated to the sidebar itself (rather than to each link) so it
  // covers every kind of link the sidebar contains without pageRouter.js
  // (which owns the "New scenario"/"Saved scenarios"/etc. view-switching
  // links) needing to know anything about the sidebar's other links — the
  // "Full documentation" and "Other tools" links, which open in a new tab
  // and are never handled by pageRouter.js at all.
  sidebar?.addEventListener("click", (event) => {
    if (event.target.closest("a") && state.current.drawerOpen) {
      setDrawerOpen(false);
    }
  });

  // Clicking the dimmed backdrop closes the drawer — standard behaviour for
  // the off-canvas drawer pattern.
  scrim.addEventListener("click", () => setDrawerOpen(false));

  // Escape closes the drawer — keyboard accessibility.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.current.drawerOpen) {
      setDrawerOpen(false);
    }
  });

  // If the viewport changes from mobile to desktop (rotation, window resize),
  // make sure the drawer is not left stuck open in the desktop layout.
  const mobileQuery = window.matchMedia("(max-width: 768px)");
  mobileQuery.addEventListener("change", (event) => {
    if (!event.matches) setDrawerOpen(false);
  });
}
