/**
 * main.js
 * -------
 * Application entry point. Its only job is wiring modules together — no
 * business logic belongs here. If this file ever grows beyond a dozen or so
 * lines, that is a sign something should be extracted into its own module.
 *
 * NOTE (2026-09-25): initConsentGate() runs first. It shows a one-time,
 * dismissable overlay (see consentGate.js) rather than blocking anything
 * below it from initialising — the rest of the app wires up underneath it
 * exactly as before, so there is nothing to "unblock" once the gate closes.
 */

import { initConsentGate } from "./ui/consentGate.js";
import { initAppShell } from "./ui/appShell.js";
import { initWizard } from "./ui/wizard.js";
import { initPageRouter } from "./ui/pageRouter.js";

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  // Register the service worker only after the page has fully loaded, so it
  // does not compete for network bandwidth with the first paint.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((error) => {
      // A failed registration must not block the application — HAZEL simply
      // will not be fully offline-capable in that session.
      console.warn("Service worker registration failed:", error);
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initConsentGate();
  initAppShell();
  initWizard();
  initPageRouter();
  registerServiceWorker();
});
