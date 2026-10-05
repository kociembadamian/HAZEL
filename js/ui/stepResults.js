/**
 * stepResults.js
 * --------------
 * The Results step: draws the threat zones on a real map, lets the user
 * query the concentration at any point, and offers to save or export the
 * scenario.
 *
 * This is where every earlier step's output converges: the location and
 * time (solar elevation, map origin), the chemical (thresholds, molecular
 * weight), the weather (stability, wind), and the source (release rate) all
 * feed the dispersion engine here, and the Richardson-number verdict from
 * engineDispersionChoice.js decides whether the numbers that come out mean
 * anything at all.
 *
 * Mapping: Leaflet + OpenStreetMap tiles, loaded from a CDN only when this
 * step is opened — nothing else in HAZEL needs a mapping library, so nothing
 * else pays for its download. See loadLeaflet() below.
 *
 * A note on OSM tile usage: the public tile server at tile.openstreetmap.org
 * is intended for light use and testing (see
 * https://operations.osmfoundation.org/policies/tiles/). A deployment
 * expecting real traffic should run its own tile server or use a commercial
 * provider; TILE_URL_TEMPLATE below is a single constant precisely so a
 * self-hoster can point it elsewhere without touching any other code.
 *
 * NOTE (2026-09-23): the map no longer captures the mouse wheel or a
 * one-finger touch-swipe — see the comments right where L.map() is
 * constructed in drawMap(). Both defaults meant scrolling the PAGE over the
 * map, with a mouse wheel or a phone swipe, moved the map instead.
 *
 * NOTE (2026-09-26): fireWedgeLocalPoints() and fireCircleLocalPoints() are
 * now exported. pdfExport.js's own static map (drawn from scratch rather
 * than screenshotting this one — see that module's docstring for why)
 * reuses them so the fire/explosion overlay shapes in the PDF match this
 * screen exactly rather than being redefined a second time.
 */

import { state } from "./state.js";
import { buildDispersionScenario } from "./stepSource.js";
import { findThreatZone, massConcentrationToPpm, peakConcentration } from "../engine/engineGaussian.js";
import { findHeavyGasThreatZone, concentrationAtDistance, concentrationAtOffset } from "../engine/engineHeavyGas.js";
import { projectFootprint, pointToPlumeFrame } from "../engine/engineGeoProjection.js";
import { levelsOfConcern } from "../services/chemicalDatabase.js";
import { relevantLimitations, SHORT_DISCLAIMER } from "../engine/engineLimitations.js";
import { saveScenario, summariseScenario } from "../services/scenarioStorage.js";
import { renderFireExplosionPanel, computeFireResults } from "./fireExplosionPanel.js";
import { renderIndoorPanel } from "./indoorPanel.js";
import { openPdfExportDialog } from "../services/pdfExport.js";

/** OpenStreetMap's public tile server. See the module comment on usage policy. */
const TILE_URL_TEMPLATE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Pinned Leaflet version, loaded from unpkg. Bump deliberately, not silently. */
const LEAFLET_VERSION = "1.9.4";

let leafletLoadPromise = null;
let map = null;
let drawnLayers = [];
/** Fire/explosion circles, tracked separately so they can be cleared and
 *  redrawn on their own without disturbing the toxic/flammable-area zones —
 *  see drawFireCircles() below. */
let fireLayers = [];

/* ========================================================================
   LEAFLET LOADING
   ======================================================================== */

/**
 * Loads Leaflet's CSS and JS from a CDN, once per session.
 *
 * Deferred to this step specifically so a phone visiting HAZEL to check the
 * Weather or Chemical step never downloads a mapping library it will not use
 * this session.
 */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
    document.head.appendChild(css);

    const script = document.createElement("script");
    script.src = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
    script.onload = () => resolve(window.L);
    script.onerror = () =>
      reject(new Error("Could not load the mapping library. Check your connection."));
    document.head.appendChild(script);
  });

  return leafletLoadPromise;
}

/* ========================================================================
   COMPUTING THE ZONES
   ======================================================================== */

/**
 * Runs the dispersion calculation for every selected threshold and returns
 * the zones with their map-projected footprints, or an explanation of why
 * none could be computed.
 *
 * Exported (not just used internally by render()) so the routing between
 * the Gaussian and heavy-gas engines — the newest, least-exercised part of
 * this file — can be checked directly in resultsIntegrationTests.js without
 * needing a DOM.
 */
export function computeZones() {
  const dispersionScenario = buildDispersionScenario();
  if (dispersionScenario.status !== "ok") {
    return { status: "incomplete", missing: dispersionScenario.missing };
  }

  const location = state.current.scenario.location;
  if (!location || location.lat === null) {
    return { status: "incomplete", missing: ["an incident location, set in the Location step"] };
  }

  const { isHeavyGas, scenarioBase, dispersion, chemical, weather } = dispersionScenario;

  const selectedLevels = state.current.scenario.chemical?.selectedLevels ?? [];
  const levels = levelsOfConcern(chemical).filter(
    (level) => selectedLevels.includes(level.id) && Number.isFinite(level.ppm)
  );

  if (levels.length === 0) {
    return { status: "incomplete", missing: ["at least one selected threshold, in the Chemical step"] };
  }

  const computeOneZone = isHeavyGas ? findHeavyGasThreatZone : findThreatZone;

  const zones = levels.map((level) => {
    // A flammable threshold uses ALOHA's 10-second averaging for the
    // passive plume's crosswind spread (FLAMMABLE_SIGMA_Y_FACTOR,
    // engineGaussian.js; ignored by the heavy-gas model). 2026-10-02.
    const result = computeOneZone({
      ...scenarioBase,
      levelOfConcernPpm: level.ppm,
      flammableAveraging: level.id === "flash",
    });
    const footprint =
      result.thresholdExceeded && result.footprint.length > 0
        ? projectFootprint(location.lat, location.lng, result.footprint, weather.downwindDegrees)
        : [];
    return { level, result, footprint };
  });

  return {
    status: "ok",
    zones,
    scenarioBase,
    location,
    downwindDegrees: weather.downwindDegrees,
    dispersion,
    isHeavyGas,
  };
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function missingBannerHtml(missing) {
  return `
    <div class="banner banner--info">
      <span>To draw threat zones HAZEL still needs: ${missing.map(escapeHtml).join("; ")}.</span>
    </div>`;
}

/**
 * Crosswind extent of a zone at its widest point, in metres — max(y) -
 * min(y) over the RAW local-frame footprint (x downwind, y crosswind),
 * before projectFootprint() converts it to map lat/lng. Added 2026-09-29
 * so the legend states the zone's shape, not just how far it reaches —
 * "13081 m downwind" alone says nothing about how narrow or wide that
 * plume actually is at its widest.
 */
function maxZoneWidth(result) {
  if (!result.footprint || result.footprint.length === 0) return null;
  const ys = result.footprint.map((p) => p.y);
  return Math.max(...ys) - Math.min(...ys);
}

function legendHtml(zones) {
  return `
    <div class="zone-legend">
      ${zones
        .map(({ level, result }) => {
          const width = result.thresholdExceeded ? maxZoneWidth(result) : null;
          // NOTE (2026-10-03): the distance/width figures now sit on their
          // own line BELOW the description, each half kept whole but free to
          // wrap onto a further line between them. On a phone the old single
          // row (badge | description | nowrap figures) was wider than the
          // screen, so the whole page scrolled sideways.
          const valueText = result.thresholdExceeded
            ? `<span class="zone-legend__figure">${result.maxDownwindDistance.toFixed(0)} m downwind</span>${
                width !== null
                  ? ` <span class="zone-legend__sep" aria-hidden="true">·</span> <span class="zone-legend__figure">${width.toFixed(0)} m wide at widest</span>`
                  : ""
              }`
            : `<span class="zone-legend__figure">not exceeded</span>`;
          return `
        <div class="zone-legend__row">
          <span class="threat-badge threat-badge--${level.colour}">${level.label}</span>
          <span class="zone-legend__text">
            <span class="zone-legend__desc">${escapeHtml(level.description)}</span>
            <span class="zone-legend__value">${valueText}</span>
          </span>
        </div>`;
        })
        .join("")}
      <p class="field__hint" style="margin-top: var(--space-3);">
        PAC-1/2/3 follow the US Department of Energy's Protective Action
        Criteria: mild and transient effects, effects serious enough to impair
        escape, and life-threatening effects, respectively. Where available
        these correspond directly to AEGL or ERPG thresholds at the same
        levels — see About for the full methodology.
      </p>
    </div>`;
}

function pointQueryHtml() {
  return `<div id="results-point-query"></div>`;
}

/**
 * Draws the map: OSM tiles, the source marker, a wind indicator, and each
 * zone's footprint as a translucent polygon.
 *
 * Drawn largest to smallest (yellow, then orange, then red) so the more
 * severe, smaller zone always renders crisply on top rather than being
 * obscured by a larger zone drawn after it.
 */
async function drawMap(container, computed) {
  const L = await loadLeaflet();
  const mapEl = container.querySelector("#results-map");
  if (!mapEl) return;

  if (map) {
    map.remove();
    map = null;
  }
  drawnLayers = [];
  fireLayers = []; // the old map and everything on it was just destroyed above

  const { location, zones, downwindDegrees } = computed;

  // scrollWheelZoom: false and the touchAction override just below both
  // exist for the same reason (2026-09-23): by default Leaflet captures the
  // mouse wheel to zoom the map, and captures a one-finger touch-drag to
  // pan it — so scrolling the PAGE with the wheel while the cursor happens
  // to be over the map, or swiping down over the map on a phone meaning to
  // scroll the page, moved the map instead of the page. Turning off wheel
  // capture here means the wheel always scrolls the page like anywhere
  // else; zooming is still available via the +/- controls, double-click,
  // or a pinch gesture (touchZoom is left on).
  map = L.map(mapEl, { scrollWheelZoom: false }).setView([location.lat, location.lng], 14);

  // See the comment above: Leaflet sets touch-action to "none" on its own
  // container element (not this one — Leaflet creates ".leaflet-container"
  // INSIDE #results-map/.map-container) to get raw, unfiltered touch events
  // for its own pinch-to-zoom handling, which as a side effect blocks the
  // browser's native touch scrolling too, even for a plain vertical swipe.
  // Setting it back to "pan-y" here — after Leaflet has already applied its
  // own value, so this wins — restores native vertical page scrolling
  // through the map; a swipe with any real horizontal component (or a
  // second finger) still reaches Leaflet's own drag/pinch handling.
  map.getContainer().style.touchAction = "pan-y";

  L.tileLayer(TILE_URL_TEMPLATE, {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 19,
  }).addTo(map);

  L.marker([location.lat, location.lng]).addTo(map).bindPopup("Release location");

  // A short line in the downwind direction, as a simple visual cue — the
  // same information ALOHA conveys with its "wind ->" arrow beside the
  // threat zone diagram.
  const windLineLength = 200; // m, a fixed visual length regardless of zone size
  const [windEnd] = projectFootprint(
    location.lat, location.lng, [{ x: windLineLength, y: 0 }], downwindDegrees
  );
  L.polyline(
    [[location.lat, location.lng], [windEnd.lat, windEnd.lng]],
    { color: "#12242e", weight: 2, dashArray: "4 4" }
  ).addTo(map).bindTooltip("wind →", { permanent: false });

  const colourFor = { red: "#c6362b", orange: "#e2792b", yellow: "#e8c22a", flame: "#7c3aed" };
  // Largest zone first, so a smaller, more severe zone always renders on
  // top of a larger one rather than being hidden beneath it. Sorting by the
  // actual computed extent (rather than a fixed colour order) is what makes
  // this correct regardless of how many threshold types are in play — PAC
  // severity and the flash-fire flammable area do not have any guaranteed
  // size relationship to each other.
  const orderedZones = [...zones].sort(
    (a, b) => b.result.maxDownwindDistance - a.result.maxDownwindDistance
  );

  const bounds = [[location.lat, location.lng]];

  orderedZones.forEach(({ level, footprint }) => {
    if (footprint.length === 0) return;
    const latlngs = footprint.map((p) => [p.lat, p.lng]);
    const polygon = L.polygon(latlngs, {
      color: colourFor[level.colour],
      fillColor: colourFor[level.colour],
      fillOpacity: 0.35,
      weight: 1,
    }).addTo(map);
    polygon.bindTooltip(`${level.label}`, { sticky: true });
    drawnLayers.push(polygon);
    latlngs.forEach((ll) => bounds.push(ll));
  });

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [30, 30] });
  }

  // "Threat at a point": clicking anywhere reports the modelled concentration
  // there, the same feature ALOHA offers through MARPLOT's threat-at-a-point.
  map.on("click", (event) => {
    reportPointConcentration(container, computed, event.latlng);
  });
}

/**
 * Computes and displays the modelled concentration at a clicked point.
 */
/**
 * Draws (or redraws) the fire/explosion overlays on the map, without
 * touching the toxic/flammable-area zone polygons or the map's current
 * pan/zoom.
 *
 * BLEVE and VCE radiate/blast outward equally in every direction — see the
 * module comment in fireExplosionPanel.js — so those draw as plain circles,
 * centred on the incident location and sized directly in metres via
 * Leaflet's L.circle (no coordinate projection needed).
 *
 * Pool fire and jet fire are different: enginePoolFire.js and
 * engineJetFire.js both report a single downwind distance (matching how
 * ALOHA itself reports these), because the flame leans downwind and that is
 * where the flux is strongest. Those draw as a narrow wedge in the downwind
 * direction instead, using the same projection the toxic/flammable zones
 * use, so it reads as directional at a glance rather than looking like
 * another omnidirectional circle.
 */
/**
 * Local-frame (x downwind, y crosswind, metres) point sets for the two
 * fire/explosion overlay shapes, shared between the map drawing
 * (drawFireCircles) and the KML export (buildKml) so the two stay
 * consistent with each other.
 */
export function fireWedgeLocalPoints(maxDistance) {
  const halfWidth = maxDistance * 0.15;
  return [{ x: 0, y: 0 }, { x: maxDistance, y: halfWidth }, { x: maxDistance, y: -halfWidth }];
}

export function fireCircleLocalPoints(radius, segments = 72) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return points;
}

function drawFireCircles(computed) {
  if (!map || !window.L) return;

  fireLayers.forEach((layer) => map.removeLayer(layer));
  fireLayers = [];

  const fireResult = computeFireResults();
  if (fireResult.status !== "ok") return;

  const colourFor = { red: "#c6362b", orange: "#e2792b", yellow: "#e8c22a" };
  const isDirectional = fireResult.scenarioType === "pool" || fireResult.scenarioType === "jet";

  // Largest first, so a smaller and more severe overlay always renders
  // clearly on top of a larger one rather than being hidden beneath it.
  const ordered = [...fireResult.results]
    .filter((r) => r.thresholdExceeded)
    .sort((a, b) => b.maxDistance - a.maxDistance);

  ordered.forEach(({ level, maxDistance }) => {
    const colour = colourFor[level.colour] ?? "#12242e";
    let layer;

    if (isDirectional) {
      // A narrow wedge pointing downwind, tapering from the source to 30%
      // of the distance wide at its far edge — reuses the same
      // metres-to-lat/lng projection the wind-blown dispersion zones use.
      const wedgePoints = projectFootprint(
        computed.location.lat, computed.location.lng,
        fireWedgeLocalPoints(maxDistance),
        computed.downwindDegrees
      );
      layer = window.L
        .polygon(wedgePoints.map((p) => [p.lat, p.lng]), {
          color: colour, fillColor: colour, fillOpacity: 0.22, weight: 1, dashArray: "6 4",
        })
        .addTo(map);
    } else {
      layer = window.L
        .circle([computed.location.lat, computed.location.lng], {
          radius: maxDistance,
          color: colour, fillColor: colour, fillOpacity: 0.22, weight: 1, dashArray: "6 4",
        })
        .addTo(map);
    }

    layer.bindTooltip(level.label, { sticky: true });
    fireLayers.push(layer);
  });

  // Without this, a fire/explosion overlay whose extent differs from the
  // toxic/flammable zones' (very often the case — BLEVE and VCE radiate
  // symmetrically around the source, while the zones above are wind-blown)
  // could be drawn entirely outside the map's current view. The person
  // would see nothing change and reasonably conclude the panel was not
  // working. Extending the existing view rather than replacing it keeps
  // the toxic/flammable zones in frame too.
  if (fireLayers.length > 0) {
    const fireBounds = window.L.featureGroup(fireLayers).getBounds();
    map.fitBounds(map.getBounds().extend(fireBounds), { padding: [30, 30] });
  }
}


function reportPointConcentration(container, computed, latlng) {
  const slot = container.querySelector("#results-point-query");
  if (!slot) return;

  const { location, downwindDegrees, scenarioBase, zones, isHeavyGas } = computed;
  const { x, y } = pointToPlumeFrame(location.lat, location.lng, latlng.lat, latlng.lng, downwindDegrees);

  if (x <= 0) {
    slot.innerHTML = `
      <div class="banner banner--info">
        <span>That point is upwind of the source, where this model predicts no plume.</span>
      </div>`;
    return;
  }

  let concentrationKgM3;
  if (isHeavyGas) {
    // Uses the same homogeneous-core-plus-Gaussian-tail profile the
    // footprint itself is built from (engineHeavyGas.js), rather than a
    // plain top-hat lookup — so a point just outside the core still
    // reports a smoothly falling concentration instead of an abrupt zero.
    const station = concentrationAtDistance(scenarioBase, x);
    concentrationKgM3 = concentrationAtOffset(
      station.concentrationKgM3, y, station.halfWidth, station.x, scenarioBase.stabilityClass
    );
  } else {
    concentrationKgM3 = peakConcentration({ ...scenarioBase, x, y, z: 0 });
  }
  const ppm = massConcentrationToPpm(concentrationKgM3, scenarioBase.molecularWeight, scenarioBase.temperature);

  // Which zone, if any, this point falls inside — the highest severity whose
  // threshold is exceeded.
  const inside = zones
    .filter((z) => Number.isFinite(z.level.ppm) && ppm >= z.level.ppm)
    .sort((a, b) => b.level.ppm - a.level.ppm)[0];

  slot.innerHTML = `
    <div class="panel" style="margin-top: var(--space-4);">
      <h3>Point ${x.toFixed(0)} m downwind, ${Math.abs(y).toFixed(0)} m ${y >= 0 ? "to one side" : "to the other"}</h3>
      <dl class="readout">
        <div><dt>Modelled concentration</dt><dd>${ppm < 0.01 ? ppm.toExponential(2) : ppm.toFixed(2)} ppm</dd></div>
        <div><dt>Zone</dt><dd>${inside ? `${inside.level.label} (${inside.level.description})` : "below all selected thresholds"}</dd></div>
      </dl>
      <p class="field__hint" style="margin-top: var(--space-2);">
        Downwind distance ${x.toFixed(0)} m — use this figure in the Indoor
        concentration panel below to model a building near this point.
      </p>
    </div>`;
}

/* ========================================================================
   SAVE AND EXPORT
   ======================================================================== */

function actionsHtml() {
  return `
    <div class="results-actions">
      <button type="button" class="btn btn--primary" data-action="save-scenario">Save scenario</button>
      <button type="button" class="btn btn--secondary" data-action="export-kml">Download KML</button>
      <button type="button" class="btn btn--secondary" data-action="export-pdf">Download PDF report</button>
    </div>
    <div id="results-save-feedback"></div>`;
}

/**
 * Builds a KML document from the computed zones AND, when enabled, the
 * fire/explosion overlays — everything currently visible on the map, not
 * just the toxic/flammable dispersion zones — for opening in Google Earth
 * or Google Maps, matching the export ALOHA itself offers.
 *
 * KML colours are AABBGGRR (alpha, then blue-green-red — the reverse byte
 * order from CSS's RRGGBB), which is easy to get backwards, so it is
 * converted explicitly rather than by eye.
 */
function buildKml(computed) {
  const rgbToKmlColour = (hex, alphaHex) => {
    const r = hex.slice(1, 3), g = hex.slice(3, 5), b = hex.slice(5, 7);
    return `${alphaHex}${b}${g}${r}`;
  };
  const colourFor = { red: "#c6362b", orange: "#e2792b", yellow: "#e8c22a", flame: "#7c3aed" };

  const zonePlacemarks = computed.zones
    .filter((z) => z.footprint.length > 0)
    .map(({ level, footprint }) => {
      const coords = footprint.map((p) => `${p.lng},${p.lat},0`).join(" ");
      const closed = `${coords} ${footprint[0].lng},${footprint[0].lat},0`;
      const kmlColour = rgbToKmlColour(colourFor[level.colour], "80");
      return `
    <Placemark>
      <name>${escapeHtml(level.label)}</name>
      <description>${escapeHtml(level.description)}</description>
      <Style>
        <LineStyle><color>${kmlColour}</color><width>2</width></LineStyle>
        <PolyStyle><color>${kmlColour}</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${closed}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`;
    })
    .join("");

  // Fire/explosion overlays (BLEVE/VCE circles, pool/jet fire wedges) live
  // in a separate panel and are computed independently of the toxic and
  // flammable-area zones above — omitting them here would mean the same
  // shapes visible on screen disappear the moment they are exported, which
  // is exactly the mismatch a person reviewing a KML file offline would
  // have no way to know about.
  const fireResult = computeFireResults();
  const isDirectional = fireResult.scenarioType === "pool" || fireResult.scenarioType === "jet";
  const firePlacemarks =
    fireResult.status === "ok"
      ? fireResult.results
          .filter((r) => r.thresholdExceeded)
          .map(({ level, maxDistance }) => {
            const localPoints = isDirectional
              ? fireWedgeLocalPoints(maxDistance)
              : fireCircleLocalPoints(maxDistance);
            const projected = projectFootprint(
              computed.location.lat, computed.location.lng, localPoints, computed.downwindDegrees
            );
            const coords = projected.map((p) => `${p.lng},${p.lat},0`).join(" ");
            const closed = `${coords} ${projected[0].lng},${projected[0].lat},0`;
            const kmlColour = rgbToKmlColour(colourFor[level.colour] ?? "#12242e", "80");
            return `
    <Placemark>
      <name>${escapeHtml(level.label)}</name>
      <description>${escapeHtml(level.description)}</description>
      <Style>
        <LineStyle><color>${kmlColour}</color><width>2</width></LineStyle>
        <PolyStyle><color>${kmlColour}</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${closed}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`;
          })
          .join("")
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>HAZEL threat zone estimate</name>
    <description>${escapeHtml(SHORT_DISCLAIMER)}</description>
    ${zonePlacemarks}
    ${firePlacemarks}
  </Document>
</kml>`;
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function wireActions(container, computed) {
  container.querySelector('[data-action="save-scenario"]')?.addEventListener("click", async () => {
    const suggestedName = `${summariseScenario(state.current.scenario)} — ${new Date().toLocaleDateString()}`;
    const name = window.prompt("Name this scenario:", suggestedName);
    if (!name) return;

    const feedback = container.querySelector("#results-save-feedback");
    try {
      await saveScenario(name, state.current.scenario);
      if (feedback) {
        feedback.innerHTML = `<div class="banner banner--info"><span>Saved. Find it under "Saved scenarios".</span></div>`;
      }
    } catch (error) {
      if (feedback) {
        feedback.innerHTML = `<div class="banner banner--warning"><span>Could not save: ${escapeHtml(error.message)}</span></div>`;
      }
    }
  });

  container.querySelector('[data-action="export-kml"]')?.addEventListener("click", () => {
    downloadTextFile("hazel-threat-zones.kml", buildKml(computed), "application/vnd.google-earth.kml+xml");
  });

  // Opens the sign-and-generate dialog (name + reconfirmed declaration) in
  // pdfExport.js — see that module for why generating this report asks for
  // a name and reports an IP address, and why that is deliberately
  // lightweight rather than any kind of real verification.
  container.querySelector('[data-action="export-pdf"]')?.addEventListener("click", () => {
    openPdfExportDialog(computed);
  });
}

/* ========================================================================
   LIMITATIONS
   ======================================================================== */

function limitationsHtml(computed) {
  const scenario = {
    vapourDensityRatio: computed.dispersion?.densityRatio,
    maxDownwindDistance: Math.max(
      0,
      ...computed.zones.map((z) => (z.result.thresholdExceeded ? z.result.maxDownwindDistance : 0))
    ),
  };
  const limitations = relevantLimitations(scenario);

  return `
    <details class="panel" style="margin-top: var(--space-6);">
      <summary><h3 style="display:inline;">Limitations of this estimate</h3></summary>
      <ul>
        ${limitations
          .map(
            (l) => `<li><strong>${escapeHtml(l.title)}.</strong> ${escapeHtml(l.consequence)}</li>`
          )
          .join("")}
      </ul>
    </details>`;
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

export const resultsStep = {
  id: "results",
  label: "Results",

  async render(container) {
    const computed = computeZones();

    if (computed.status === "incomplete") {
      container.innerHTML = `
        <div class="panel">
          <h2>Threat zones</h2>
          <p class="scenario-summary">${escapeHtml(summariseScenario(state.current.scenario))}</p>
          ${missingBannerHtml(computed.missing)}
        </div>`;
      return;
    }

    // The Richardson-number verdict is shown for BOTH models, not just when
    // it picks the heavy gas branch — someone reviewing a Gaussian result
    // should be able to see that the model was in fact appropriate for this
    // release, not just assume it by default.
    const verdictHtml = computed.dispersion?.explanation
      ? `<div class="banner banner--${computed.isHeavyGas ? "warning" : "info"}">
           <span>${escapeHtml(computed.dispersion.explanation)}</span>
         </div>`
      : "";

    container.innerHTML = `
      <div class="panel">
        <h2>Threat zones</h2>
        <p class="scenario-summary">${escapeHtml(summariseScenario(state.current.scenario))}</p>
        ${verdictHtml}
        <div id="results-map" class="map-container"></div>
        <p class="field__hint" style="margin-top: calc(-1 * var(--space-2));">
          Scrolling or swiping over the map scrolls the page, not the map —
          use the +/− buttons, double-click, or pinch to zoom.
        </p>
        ${legendHtml(computed.zones)}
        ${pointQueryHtml()}
      </div>

      ${actionsHtml()}
      <div id="fire-panel"></div>
      <div id="indoor-panel"></div>
      ${limitationsHtml(computed)}
    `;

    wireActions(container, computed);
    await drawMap(container, computed);

    // The fire/explosion panel is independent of the toxic/flammable-area
    // calculation above: it can be filled in and recomputed without
    // disturbing the dispersion zones or the map's current pan/zoom. Its
    // own onChange callback only redraws the fire/explosion circles.
    const firePanelEl = container.querySelector("#fire-panel");
    if (firePanelEl) {
      renderFireExplosionPanel(firePanelEl, () => drawFireCircles(computed));
      drawFireCircles(computed);
    }

    // The indoor-concentration panel is likewise independent of the map: it
    // reads the same dispersion scenario at a distance the user supplies,
    // and has nothing to draw on the map itself, so its onChange is a no-op
    // kept only for calling-convention symmetry with the fire panel above.
    const indoorPanelEl = container.querySelector("#indoor-panel");
    if (indoorPanelEl) {
      renderIndoorPanel(indoorPanelEl, () => {});
    }
  },

  isComplete() {
    return true;
  },
};
