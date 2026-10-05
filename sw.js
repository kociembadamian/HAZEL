/**
 * sw.js
 * -----
 * Service worker responsible for making the application shell work fully
 * offline (everything except the future optional network enrichments —
 * weather, GIS, chemical data. Those will have their OWN caching and relay
 * logic, separate from this file, because they are governed by different
 * data-freshness rules).
 *
 * IMPORTANT for auditors: this file neither sends nor stores any user data.
 * It caches only the static assets of the application itself (HTML/CSS/JS),
 * which are identical for every user.
 *
 * Versioning: whenever the files in CACHE_FILES change, bump CACHE_NAME
 * (e.g. hazel-shell-v25). That forces every client to fetch the fresh version
 * and drop the old cache.
 *
 * NOTE (2026-09-23): two changes bundled into v26 —
 *   1. icon.svg replaced with HAZEL's own hazel_logo.png (see index.html).
 *   2. Four runtime files added earlier this session were never added here:
 *      customChemicalStore.js (used by pageLibrary.js and stepChemical.js),
 *      engineFlammableMass.js (used by fireExplosionPanel.js), and
 *      engineIndoor.js / indoorPanel.js (used by stepResults.js). The
 *      "fetch" handler below does cache a file the first time it is
 *      requested even if it is missing from this list, but only once a
 *      connection is available — so someone opening HAZEL offline for the
 *      first time after these features shipped, or whose browser evicted
 *      the cache, would have hit a hard failure on the Chemical library's
 *      custom entries or the indoor-concentration panel specifically
 *      offline, with no visible link between the symptom and this file.
 *
 * NOTE (2026-09-25): v27 adds consentGate.js, the new pre-use
 * acknowledgement screen imported by main.js — without it here, a first
 * offline visit (or one after the cache was evicted) would fail to load the
 * whole app, not just show the gate, since main.js's import of a missing
 * module throws before any of the other init calls in it ever run.
 *
 * NOTE (2026-10-03): v29 (a v28 already added about.html and
 * how-to-use.html on 2026-09-26) lists the two standalone pages together
 * with staticPageLoader.js: the in-app "About" and "How to use" views now
 * load their text from those pages, so they must be cached for offline use.
 *
 * NOTE (2026-10-05): v32 — about.html and how-to-use.html now carry the
 * sidebar layout of the standalone site (hazel-project.eu) and load
 * site.css and site.js. The in-app views only take the text out of those
 * pages (staticPageLoader.js), but someone who opens the pages directly
 * while offline would otherwise get them without their styling, so the two
 * new files are cached as well. landing.html (the home page of
 * hazel-project.eu) is deliberately NOT cached here — it is not part of the
 * app.
 *
 * NOTE (2026-10-05, later): v33 — index.html, about.html and how-to-use.html
 * now link to the public GitHub repository, so the cached copies must be
 * refreshed on every client.
 *
 * NOTE (2026-10-05, evening): v34 — the files were moved out of one flat
 * folder into css/, js/ (engine/, services/, ui/), data/, assets/ and so on.
 * Every URL in CACHE_FILES changed, so every client must drop the old cache.
 * pdfExport.js (imported by stepResults.js) was missing from the list and
 * is now included.
 * sw.js itself stays in the root on purpose: a service worker can only
 * control pages at or below its own folder, and index.html lives here.
 */

const CACHE_NAME = "hazel-shell-v34";

const CACHE_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/tokens.css",
  "./css/layout.css",
  "./css/components.css",
  "./css/site.css",
  "./js/site.js",
  "./config.js",
  "./js/ui/state.js",
  "./js/ui/appShell.js",
  "./js/ui/consentGate.js",
  "./js/ui/wizard.js",
  "./js/main.js",
  "./js/ui/pageRouter.js",
  "./js/ui/pageSaved.js",
  "./js/ui/pageLibrary.js",
  "./js/ui/pageAbout.js",
  "./js/ui/pageSettings.js",
  "./js/ui/staticPageLoader.js",
  "./about.html",
  "./how-to-use.html",
  "./js/engine/units.js",
  "./js/engine/coordinates.js",
  "./js/engine/solarPosition.js",
  "./js/engine/engineMath.js",
  "./js/engine/engineConstants.js",
  "./js/engine/engineStability.js",
  "./js/engine/engineGaussian.js",
  "./js/engine/engineDispersionChoice.js",
  "./js/engine/engineHeavyGas.js",
  "./js/engine/engineFlammableMass.js",
  "./js/engine/engineBleve.js",
  "./js/engine/engineVce.js",
  "./js/engine/engineIndoor.js",
  "./js/ui/indoorPanel.js",
  "./js/ui/fireExplosionPanel.js",
  "./js/engine/engineViewFactor.js",
  "./js/engine/enginePoolFire.js",
  "./js/engine/engineJetFire.js",
  "./js/engine/engineGeoProjection.js",
  "./js/engine/engineLimitations.js",
  "./js/engine/engineSourcePuddle.js",
  "./js/engine/engineSourceTank.js",
  "./js/engine/engineTankGeometry.js",
  "./js/ui/domUtils.js",
  "./js/services/weatherStorage.js",
  "./js/services/weatherService.js",
  "./js/services/scenarioStorage.js",
  "./js/services/customChemicalStore.js",
  "./js/services/pdfExport.js",
  "./js/services/locationService.js",
  "./js/services/chemicalDatabase.js",
  "./data/chemicals.slim.json",
  "./js/ui/stepLocation.js",
  "./js/ui/stepChemical.js",
  "./js/ui/stepWeather.js",
  "./js/ui/stepSource.js",
  "./js/ui/stepResults.js",
  "./assets/hazel_logo.png",
];

// Install: fetch and store every application shell file
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting(); // the new worker takes over immediately
});

// Activate: delete caches from previous CACHE_NAME versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/**
 * Strategy: cache-first for application shell files. That is a deliberate
 * choice for APPLICATION ASSETS (not for data such as weather or GIS, which
 * get their own freshness logic — a local cache with a timestamp). The shell
 * changes rarely, so instant offline start matters more than always having
 * the very latest code.
 */
self.addEventListener("fetch", (event) => {
  // Do not intercept requests to external APIs (weather, GIS, map tiles,
  // Leaflet's CDN) — those have their own logic, or none at all by design,
  // and must not pass through this application-shell cache.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          // Store the newly fetched file for next time (for example a new
          // wizard step that was not yet listed in CACHE_FILES)
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return response;
        })
      );
    })
  );
});
