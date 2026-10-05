/**
 * pdfExport.js
 * ------------
 * Generates a self-contained PDF report of the current scenario: every
 * input (location, chemical, weather, source, and the optional fire/
 * explosion and indoor panels — including anything the user typed by hand,
 * not just what came from a database or a live fetch), the computed
 * results, a map, and the same limitations shown in the Results step.
 *
 * WHY THIS EXISTS
 * -----------------
 * HAZEL has no server (see scenarioStorage.js's module docstring) — nothing
 * the user enters ever leaves their own device unless they choose to export
 * it. A PDF report is that deliberate export: something a DGSA/responder can
 * attach to an incident file, a training record, or an email, with the
 * inputs and the disclaimer travelling together with the result rather than
 * a screenshot that carries neither.
 *
 * THE "DIGITAL TRACE" AND WHY IT IS DELIBERATELY LIGHTWEIGHT
 * -----------------
 * The report asks the generating person to type their name and to
 * reconfirm the same professional-use declaration consentGate.js shows on
 * first visit, and it prints a best-effort public IP address alongside a
 * timestamp. None of this is verification in any strong sense — a name is
 * self-reported and an IP address is trivially spoofed or shared behind
 * NAT/VPN/CGNAT, and HAZEL has no server to log any of it against. Its
 * purpose is closer to a paper form's signature line than a security
 * control: it puts a name to the document and makes plain, on the document
 * itself, who generated it and when. Fetching the IP address is the ONE
 * thing in this whole module that talks to the network (a public echo
 * service, ipify) — it fails silently (the report still generates, with
 * "could not be determined" printed instead) if there is no connection,
 * consistent with HAZEL's offline-first design everywhere else. Nothing
 * fetched or typed here is stored by HAZEL or sent anywhere except onto the
 * PDF the user's own browser writes to their own device.
 *
 * THE MAP IS DRAWN, NOT SCREENSHOTTED (2026-09-26)
 * -----------------------------------------------
 * An earlier version of this module rasterised the live Leaflet map with
 * html2canvas. That produced a map image whose marker, wind line and zone
 * polygons did not line up with the tiles underneath — Leaflet moves its
 * tile layer with a CSS transform for performance, which html2canvas does
 * not reproduce faithfully relative to the SVG/marker layers drawn on top.
 * Rather than fight that mismatch, this module draws its own small static
 * map from scratch: it fetches the OSM tiles a computed bounding box needs,
 * draws them onto a plain <canvas>, and projects the SAME lat/lng points
 * already computed for the on-screen map (the source location, the wind
 * line, each zone's footprint, and any fire/explosion overlay) onto that
 * canvas with one consistent Web Mercator projection. Nothing here depends
 * on Leaflet or html2canvas at all.
 *
 * LIBRARIES
 * -----------------
 * jsPDF (text/vector layout) is loaded from a CDN on first use, exactly
 * like stepResults.js's own loadLeaflet() — so a session that never clicks
 * "Download PDF report" never downloads it.
 */

import { state } from "../ui/state.js";
import { summariseScenario } from "./scenarioStorage.js";
import { incidentMoment } from "../ui/stepLocation.js";
import { formatDecimal, formatDms } from "../engine/coordinates.js";
import { describeVapourDensity, levelsOfConcern } from "./chemicalDatabase.js";
import { relevantLimitations } from "../engine/engineLimitations.js";
import { computeFireResults } from "../ui/fireExplosionPanel.js";
import { fireWedgeLocalPoints, fireCircleLocalPoints } from "../ui/stepResults.js";
import { computeIndoorResults } from "../ui/indoorPanel.js";
import { projectFootprint } from "../engine/engineGeoProjection.js";

const JSPDF_VERSION = "2.5.2";
const IP_ECHO_URL = "https://api.ipify.org?format=json";
const IP_ECHO_TIMEOUT_MS = 3000;
const LOGO_URL = "assets/hazel_logo.png";

const SHORT_DISCLAIMER = "Indicative simulation only.";

const FULL_DISCLAIMER = [
  "This report is an ORIENTATIONAL / INDICATIVE simulation, produced by the open-source HAZEL " +
    "dispersion-modelling tool, from the inputs entered by the person named below, some of which " +
    "were typed by hand. It is not a certified, validated, or official hazard assessment, and it is " +
    "not a substitute for the judgement of a qualified responder, safety adviser, or the competent " +
    "authority.",
  "By using HAZEL, the generating person declared that they are professionally involved in " +
    "dangerous goods transport and would use the software as intended (the same declaration shown " +
    "before HAZEL becomes usable).",
  "HAZEL's authors and contributors accept no responsibility or liability whatsoever for this " +
    "output, for any decision made on the basis of it, or for any consequence of its use or misuse.",
];

/* ========================================================================
   LIBRARY / ASSET LOADING
   ======================================================================== */

let jsPdfLoadPromise = null;
function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  if (jsPdfLoadPromise) return jsPdfLoadPromise;

  jsPdfLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://unpkg.com/jspdf@${JSPDF_VERSION}/dist/jspdf.umd.min.js`;
    script.onload = () => resolve(window.jspdf.jsPDF);
    script.onerror = () => reject(new Error("Could not load the PDF library. Check your connection."));
    document.head.appendChild(script);
  });
  return jsPdfLoadPromise;
}

/** Loads an image (a CDN-hosted tile, or HAZEL's own logo) as an <img>, with a timeout. */
function loadImage(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => reject(new Error("image load timed out")), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("image failed to load"));
    };
    img.src = url;
  });
}

/**
 * Best-effort public IP lookup. Resolves to null (never rejects) on any
 * failure — no network, the echo service being down, or a slow reply — so
 * a report can always be generated even fully offline.
 */
async function lookupPublicIp() {
  if (!navigator.onLine) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IP_ECHO_TIMEOUT_MS);
  try {
    const response = await fetch(IP_ECHO_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    return data.ip ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ========================================================================
   SCENARIO DATA GATHERING
   ------------------------------------------------------------------------
   Rather than hand-listing every field name for every step (and drifting
   out of sync every time a step gains a new input), each section is built
   from the actual stored object: known fields get a human label from
   FIELD_LABELS below; anything else still prints, under a readable version
   of its own key, so a field added to a step later is never silently
   missing from the report.
   ======================================================================== */

const FIELD_LABELS = {
  // location
  lat: "Latitude", lng: "Longitude", address: "Address", elevation: "Ground elevation (m)",
  date: "Date", time: "Time (local)", useCurrentTime: "Uses current time",
  roughnessSuggestion: null, // rendered separately, not as a raw field
  // weather
  mode: "Weather mode", windSpeed: "Wind speed", windSpeedUnit: "Wind speed unit",
  windFromDirection: "Wind blowing from", windMeasurementHeight: "Measurement height (m)",
  temperature: "Air temperature", temperatureUnit: "Temperature unit",
  cloudCoverOktas: "Cloud cover (oktas, 0-8)", relativeHumidity: "Relative humidity (%)",
  isDaytime: "Daytime", inversionPresent: "Low-level inversion present",
  inversionHeight: "Inversion height (m)", groundRoughnessPreset: "Ground roughness preset",
  customRoughness: "Custom roughness length (m)", stabilityOverride: "Manual stability override",
  activePreset: "Applied preset",
  // source (shared + type-specific)
  type: "Source type", tankShape: "Tank shape", tankDiameter: "Tank diameter (m)",
  tankLength: "Tank length (m)", tankFillPercent: "Tank fill (%)", holeShape: "Opening shape",
  holeDiameter: "Opening diameter (m)", holeWidth: "Opening length (m)", holeHeight: "Opening width (m)",
  holeHeightAboveBottom: "Opening height above tank bottom (m)", pipeLength: "Pipe/valve length (m)",
  puddleMass: "Spilled mass (kg)", puddleArea: "Puddle area (m2)", substrate: "Ground surface",
  tankMaxPuddleArea: "Maximum puddle area (m2; empty = not known)",
  tankContents: "Tank contents (empty = from the substance)", tankPressureAtm: "Tank pressure (atm, absolute)",
  gasHeatCapacityRatio: "Gas heat capacity ratio",
  criticalTemperatureK: "Critical temperature (K; empty = from library)",
  criticalPressureBar: "Critical pressure (bar; empty = from library)",
  acentricFactor: "Acentric factor (empty = estimated)",
  boilingPointK: "Boiling point (K, manually entered)",
  heatOfVaporization: "Heat of vaporisation (J/mol, manually entered)",
  liquidDensity: "Liquid density (kg/m3, manually entered)",
  liquidHeatCapacity: "Liquid heat capacity (J/(kg*K), manually entered)",
  directRate: "Release rate (kg/s)", directDuration: "Release duration (s)", directHeight: "Source height (m)",
  // fire
  enabled: "Enabled", scenarioType: "Scenario type", heatOfCombustion: "Heat of combustion (J/kg)",
  lowerExplosiveLimitPpm: "Lower explosive limit (ppm)", upperExplosiveLimitPpm: "Upper explosive limit (ppm)",
  specificHeatRatio: "Specific heat ratio (gamma)", choked: "Choked flow", isAerosol: "Aerosol (two-phase) release",
  // indoor
  downwindDistance: "Downwind distance to building (m)", tauMode: "Infiltration time constant",
  manualTauHours: "Manual time constant (hours)", floorAreaM2: "Floor area (m2)", stories: "Stories",
  sheltering: "Sheltering", internalTemperatureC: "Internal temperature (C)",
};

const HIDDEN_FIELDS = new Set([
  "result", "series", "selected", "manualOverrides", "roughnessSuggestion", "notes",
]);

function humanizeKey(key) {
  const spaced = key.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "not set";
  return String(value);
}

/** Flat {label, value} pairs for a scenario section object, skipping opaque/nested fields. */
function sectionRows(sectionObject) {
  if (!sectionObject) return [];
  return Object.entries(sectionObject)
    .filter(([key]) => !HIDDEN_FIELDS.has(key))
    .filter(([, value]) => typeof value !== "object" || value === null)
    .map(([key, value]) => ({
      label: FIELD_LABELS[key] ?? humanizeKey(key),
      value: formatValue(value),
    }))
    .filter((row) => row.label !== null);
}

/* ========================================================================
   PDF LAYOUT HELPERS
   ------------------------------------------------------------------------
   A small stateful cursor (current y position, current page) shared by
   every section-drawing function below, so pagination is handled in one
   place rather than separately in each section.
   ======================================================================== */

const PAGE_MARGIN = 15;
const LINE_HEIGHT = 5.2;
/** Where the value column starts for a label/value pair drawn on one line. */
const INLINE_VALUE_X = PAGE_MARGIN + 80;

function makeCursor(doc) {
  return {
    doc,
    y: PAGE_MARGIN,
    pageWidth: doc.internal.pageSize.getWidth(),
    pageHeight: doc.internal.pageSize.getHeight(),
    contentWidth: doc.internal.pageSize.getWidth() - PAGE_MARGIN * 2,
  };
}

function ensureSpace(cursor, neededHeight) {
  if (cursor.y + neededHeight > cursor.pageHeight - PAGE_MARGIN) {
    cursor.doc.addPage();
    cursor.y = PAGE_MARGIN;
  }
}

function addHeading(cursor, text) {
  ensureSpace(cursor, LINE_HEIGHT * 3);
  cursor.y += LINE_HEIGHT * 0.4;
  cursor.doc.setFont(undefined, "bold");
  cursor.doc.setFontSize(13);
  cursor.doc.text(text, PAGE_MARGIN, cursor.y);
  cursor.y += LINE_HEIGHT * 1.4;
  cursor.doc.setFont(undefined, "normal");
  cursor.doc.setFontSize(10);
}

function addParagraph(cursor, text, options = {}) {
  const { fontSize = 10, bold = false } = options;
  cursor.doc.setFont(undefined, bold ? "bold" : "normal");
  cursor.doc.setFontSize(fontSize);
  const lines = cursor.doc.splitTextToSize(text, cursor.contentWidth);
  for (const line of lines) {
    ensureSpace(cursor, LINE_HEIGHT);
    cursor.doc.text(line, PAGE_MARGIN, cursor.y);
    cursor.y += LINE_HEIGHT;
  }
  cursor.doc.setFont(undefined, "normal");
  cursor.doc.setFontSize(10);
}

/**
 * Draws a list of {label, value} rows. A label short enough to sit beside
 * its value on one line does so (INLINE_VALUE_X marks the value column); a
 * longer label — a chemical description, a fire/explosion scenario name —
 * gets its own line instead, with the value indented underneath. This is
 * decided per row from the label's ACTUAL measured width at the font/size
 * about to be drawn, rather than a fixed guess, which is what previously
 * let a long label collide with its value or with the row after it.
 */
function addRows(cursor, rows) {
  if (rows.length === 0) {
    addParagraph(cursor, "(nothing entered for this section)", { fontSize: 9 });
    return;
  }

  const inlineLabelLimit = INLINE_VALUE_X - PAGE_MARGIN - 3;

  for (const { label, value } of rows) {
    cursor.doc.setFont(undefined, "bold");
    cursor.doc.setFontSize(10);
    const labelText = `${label}:`;
    const labelWidth = cursor.doc.getTextWidth(labelText);
    const text = String(value);

    if (labelWidth <= inlineLabelLimit) {
      const valueLines = cursor.doc.splitTextToSize(text, cursor.pageWidth - PAGE_MARGIN - INLINE_VALUE_X);
      ensureSpace(cursor, LINE_HEIGHT * valueLines.length);
      cursor.doc.text(labelText, PAGE_MARGIN, cursor.y);
      cursor.doc.setFont(undefined, "normal");
      valueLines.forEach((line, index) => {
        cursor.doc.text(line, INLINE_VALUE_X, cursor.y + index * LINE_HEIGHT);
      });
      cursor.y += LINE_HEIGHT * valueLines.length;
    } else {
      ensureSpace(cursor, LINE_HEIGHT);
      cursor.doc.text(labelText, PAGE_MARGIN, cursor.y);
      cursor.y += LINE_HEIGHT;
      cursor.doc.setFont(undefined, "normal");
      const valueLines = cursor.doc.splitTextToSize(text, cursor.contentWidth - 4);
      for (const line of valueLines) {
        ensureSpace(cursor, LINE_HEIGHT);
        cursor.doc.text(line, PAGE_MARGIN + 4, cursor.y);
        cursor.y += LINE_HEIGHT;
      }
    }
    cursor.y += LINE_HEIGHT * 0.25;
  }
  cursor.doc.setFont(undefined, "normal");
  cursor.doc.setFontSize(10);
  cursor.y += LINE_HEIGHT * 0.3;
}

function addDivider(cursor) {
  ensureSpace(cursor, LINE_HEIGHT);
  cursor.doc.setDrawColor(200);
  cursor.doc.line(PAGE_MARGIN, cursor.y, cursor.pageWidth - PAGE_MARGIN, cursor.y);
  cursor.y += LINE_HEIGHT;
}

/* ========================================================================
   SECTION BUILDERS
   ======================================================================== */

async function buildCoverAndTrace(cursor, { operatorName, generatedAt, ipAddress }) {
  // HAZEL's own logo, the same file consentGate.js and index.html use. Best
  // effort: a missing or slow-loading logo (a dev environment without the
  // asset, say) skips it rather than failing the whole report.
  try {
    const logo = await loadImage(LOGO_URL, 2500);
    const logoHeight = 14;
    const logoWidth = logoHeight * (logo.naturalWidth / logo.naturalHeight);
    cursor.doc.addImage(logo, PAGE_MARGIN, cursor.y, logoWidth, logoHeight);
    cursor.y += logoHeight + LINE_HEIGHT * 0.6;
  } catch {
    // No logo available — proceed without one.
  }

  cursor.doc.setFont(undefined, "bold");
  cursor.doc.setFontSize(18);
  cursor.doc.text("HAZEL — indicative dispersion simulation report", PAGE_MARGIN, cursor.y);
  cursor.y += LINE_HEIGHT * 2;
  cursor.doc.setFont(undefined, "normal");
  cursor.doc.setFontSize(10);

  addParagraph(cursor, summariseScenario(state.current.scenario), { bold: true, fontSize: 11 });
  cursor.y += LINE_HEIGHT * 0.5;

  // Disclaimer, boxed for visibility.
  ensureSpace(cursor, LINE_HEIGHT * 8);
  cursor.doc.setDrawColor(180, 60, 40);
  cursor.doc.setLineWidth(0.6);
  const boxStartY = cursor.y;
  cursor.y += LINE_HEIGHT * 0.8;
  cursor.doc.setFont(undefined, "bold");
  cursor.doc.text("Disclaimer", PAGE_MARGIN + 3, cursor.y);
  cursor.y += LINE_HEIGHT;
  cursor.doc.setFont(undefined, "normal");
  for (const paragraph of FULL_DISCLAIMER) {
    const lines = cursor.doc.splitTextToSize(paragraph, cursor.contentWidth - 6);
    for (const line of lines) {
      ensureSpace(cursor, LINE_HEIGHT);
      cursor.doc.text(line, PAGE_MARGIN + 3, cursor.y);
      cursor.y += LINE_HEIGHT;
    }
    cursor.y += LINE_HEIGHT * 0.3;
  }
  cursor.doc.rect(PAGE_MARGIN, boxStartY - LINE_HEIGHT * 0.6, cursor.contentWidth, cursor.y - boxStartY + LINE_HEIGHT * 0.3);
  cursor.doc.setDrawColor(0);
  cursor.doc.setLineWidth(0.2);
  cursor.y += LINE_HEIGHT;

  addHeading(cursor, "Generated by");
  addRows(cursor, [
    { label: "Name", value: operatorName },
    { label: "Generated at", value: `${generatedAt.toLocaleString()} (local), ${generatedAt.toISOString()} (UTC)` },
    { label: "Reported public IP address", value: ipAddress ?? "could not be determined (offline or blocked)" },
    {
      label: "Declaration",
      value:
        "Confirmed professional involvement in dangerous goods transport, and that this report will be " +
        "used as intended, at the point of generation.",
    },
  ]);
  addParagraph(
    cursor,
    "The name and IP address above are exactly as typed and reported by this device at the time this " +
      "PDF was generated. HAZEL has no server and does not store, transmit, or otherwise process this " +
      "information anywhere — it exists only on this document.",
    { fontSize: 8.5 }
  );
}

function buildLocationSection(cursor) {
  const location = state.current.scenario.location;
  addHeading(cursor, "1. Location and time");
  if (!location || location.lat === null) {
    addParagraph(cursor, "(not set)", { fontSize: 9 });
    return;
  }
  const moment = incidentMoment(location);
  addRows(cursor, [
    { label: "Coordinates (decimal)", value: formatDecimal(location.lat, location.lng) },
    { label: "Coordinates (DMS)", value: formatDms(location.lat, location.lng) },
    { label: "Address", value: formatValue(location.address) },
    { label: "Ground elevation", value: location.elevation !== null ? `${location.elevation.toFixed(0)} m` : "not set" },
    { label: "Incident time", value: `${moment.toLocaleString()}${location.useCurrentTime ? " (current time)" : " (specified)"}` },
  ]);
}

function buildChemicalSection(cursor) {
  const chemical = state.current.scenario.chemical;
  addHeading(cursor, "2. Chemical");
  const record = chemical?.selected;
  if (!record) {
    addParagraph(cursor, "(no substance selected)", { fontSize: 9 });
    return;
  }
  const vapour = describeVapourDensity(record);
  addRows(cursor, [
    { label: "Substance", value: record.name },
    { label: "CAS number", value: formatValue(record.casNumber) },
    { label: "Formula", value: formatValue(record.molecularFormula) },
    { label: "Molecular weight", value: `${formatValue(record.molecularWeight)} g/mol` },
    { label: "State at 25C", value: formatValue(record.state25C) },
    { label: "Vapour density vs air", value: vapour.ratio ? vapour.ratio.toFixed(2) : "not available" },
    { label: "Custom/overridden data used", value: record.hasCustomOverride || record.isCustom ? "yes" : "no" },
  ]);

  const levels = levelsOfConcern(record);
  const selectedIds = new Set(chemical.selectedLevels ?? []);
  addParagraph(cursor, "Selected thresholds:", { bold: true, fontSize: 10 });
  addRows(
    cursor,
    levels
      .filter((l) => selectedIds.has(l.id))
      .map((l) => ({
        label: l.label,
        value: Number.isFinite(l.ppm) ? `${l.ppm} ppm — ${l.description}` : "not published",
      }))
  );
}

function buildWeatherSection(cursor) {
  const weather = state.current.scenario.weather;
  addHeading(cursor, "3. Weather");
  addRows(cursor, sectionRows(weather));
}

/**
 * Which of the flat source object's fields are actually relevant to a given
 * source type.
 *
 * The scenario object keeps every field for every source type at once (see
 * stepSource.js's defaultSource()) so that switching the type radio never
 * loses values the user already typed into another type's form. That is the
 * right choice for the app's own state, but it means the raw object always
 * contains, say, a full tank geometry and a puddle area even for a "direct"
 * release that used neither — printing all of it verbatim (as this report
 * used to) made the report look like it had computed a tank rupture AND a
 * puddle evaporation alongside a direct release, when only the direct
 * release's own two fields were ever used. This mirrors stepSource.js's own
 * `needsProperties = source.type !== "direct"` split for which fields the
 * form itself shows.
 */
const SOURCE_FIELDS_BY_TYPE = {
  direct: ["directRate", "directDuration", "directHeight"],
  puddle: [
    "puddleMass", "puddleArea", "substrate",
    "liquidDensity", "liquidHeatCapacity", "boilingPointK", "heatOfVaporization",
  ],
  tank: [
    "tankShape", "tankDiameter", "tankLength", "tankFillPercent",
    "holeShape", "holeDiameter", "holeWidth", "holeHeight", "holeHeightAboveBottom", "pipeLength",
    "tankMaxPuddleArea", "substrate", "tankContents", "tankPressureAtm", "gasHeatCapacityRatio",
    "criticalTemperatureK", "criticalPressureBar", "acentricFactor",
    "liquidDensity", "liquidHeatCapacity", "boilingPointK", "heatOfVaporization",
  ],
};

/** Keeps only "type" plus whichever fields that type's own form actually uses. */
function fieldsForSourceType(source) {
  const relevant = new Set(["type", ...(SOURCE_FIELDS_BY_TYPE[source.type] ?? [])]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => relevant.has(key))
  );
}

function buildSourceSection(cursor) {
  const source = state.current.scenario.source;
  addHeading(cursor, "4. Release source");
  if (!source) {
    addParagraph(cursor, "(not set)", { fontSize: 9 });
    return;
  }
  addRows(cursor, sectionRows(fieldsForSourceType(source)));

  if (source.result) {
    addParagraph(cursor, "Computed release:", { bold: true, fontSize: 10 });
    addRows(cursor, [
      { label: "Regime", value: formatValue(source.result.regime) },
      { label: "Peak rate", value: `${source.result.peakRate?.toFixed?.(3) ?? "?"} kg/s` },
      { label: "Average rate", value: `${source.result.averageRate?.toFixed?.(3) ?? "?"} kg/s` },
      { label: "Duration", value: `${source.result.durationSeconds ?? "?"} s` },
      { label: "Total mass released", value: `${source.result.totalMass?.toFixed?.(0) ?? "?"} kg` },
      ...(Number.isFinite(source.result.tankMass)
        ? [
            { label: "Gas in the tank", value: `${source.result.tankMass.toFixed(0)} kg` +
              (Number.isFinite(source.result.compressibilityFactor) && source.result.compressibilityFactor !== 1
                ? ` (real gas, Z = ${source.result.compressibilityFactor.toFixed(3)})` : " (ideal gas)") },
            { label: "Temperature after expansion", value: `${(source.result.cloudTemperature - 273.15).toFixed(0)} C` },
          ]
        : []),
      ...(Number.isFinite(source.result.puddleDiameter)
        ? [
            { label: "Puddle formed", value: `${source.result.puddleArea.toFixed(0)} m2 (${source.result.puddleDiameter.toFixed(1)} m across)` },
            { label: "Drained from tank (first hour)", value: `${source.result.tankDrainedMass.toFixed(0)} kg` },
          ]
        : []),
    ]);
    if (source.result.notes?.length) {
      addParagraph(cursor, `Notes: ${source.result.notes.join(" ")}`, { fontSize: 8.5 });
    }
  }
}

function buildResultsSection(cursor, computed) {
  addHeading(cursor, "5. Threat zone results");
  if (computed.status !== "ok") {
    addParagraph(cursor, "(results incomplete — see the app for what is still missing)", { fontSize: 9 });
    return;
  }
  if (computed.dispersion?.explanation) {
    addParagraph(cursor, computed.dispersion.explanation, { fontSize: 9 });
    cursor.y += LINE_HEIGHT * 0.3;
  }
  addRows(
    cursor,
    computed.zones.map(({ level, result }) => ({
      label: `${level.label} (${level.description})`,
      value: result.thresholdExceeded ? `${result.maxDownwindDistance.toFixed(0)} m downwind` : "not exceeded",
    }))
  );
}

function buildFireSection(cursor) {
  const fire = computeFireResults();
  if (fire.status === "disabled") return;
  addHeading(cursor, "6. Fire and explosion");
  if (fire.status === "incomplete") {
    addParagraph(cursor, `Incomplete — still needed: ${fire.missing.join("; ")}.`, { fontSize: 9 });
    return;
  }
  addRows(cursor, [{ label: "Scenario type", value: fire.scenarioType }]);
  addRows(
    cursor,
    fire.results.map(({ level, thresholdExceeded, maxDistance }) => ({
      label: `${level.label} (${level.description})`,
      value: thresholdExceeded ? `${maxDistance.toFixed(0)} m` : "not exceeded",
    }))
  );
}

function buildIndoorSection(cursor) {
  const indoor = computeIndoorResults();
  if (indoor.status === "disabled") return;
  addHeading(cursor, "7. Indoor concentration (shelter-in-place)");
  if (indoor.status === "incomplete") {
    addParagraph(cursor, `Incomplete — still needed: ${indoor.missing.join("; ")}.`, { fontSize: 9 });
    return;
  }
  addRows(cursor, [
    { label: "Downwind distance", value: `${indoor.downwindDistance.toFixed(0)} m` },
    { label: "Outdoor peak", value: `${indoor.outdoorPpm} ppm` },
    { label: "Peak indoor concentration", value: `${indoor.peakIndoorPpm} ppm` },
    { label: "Indoors, one time constant after release ends", value: `${indoor.indoorOneTauAfter} ppm` },
  ]);
}

/* ========================================================================
   STATIC MAP
   ------------------------------------------------------------------------
   A small Web Mercator renderer, independent of Leaflet: it fetches only
   the OSM tiles a computed bounding box needs and draws the same lat/lng
   points the on-screen map uses onto a plain canvas with one projection,
   so nothing can drift out of alignment the way a DOM screenshot did.
   ======================================================================== */

const TILE_SIZE = 256;
const MAP_CANVAS_WIDTH = 1000;
const MAP_CANVAS_HEIGHT = 640;
const MAP_PADDING_PX = 40;
const ZONE_COLOUR = { red: "#c6362b", orange: "#e2792b", yellow: "#e8c22a", flame: "#7c3aed" };

function lonToPixelX(lon, zoom) {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** zoom;
}
function latToPixelY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

/** Picks the highest zoom at which every given lat/lng point fits the canvas, with padding. */
function chooseZoomAndOrigin(points) {
  let minLat = Math.min(...points.map((p) => p.lat));
  let maxLat = Math.max(...points.map((p) => p.lat));
  let minLon = Math.min(...points.map((p) => p.lng));
  let maxLon = Math.max(...points.map((p) => p.lng));

  // A single point (or a degenerate/near-zero footprint) needs an artificial
  // minimum span, or every zoom level would "fit" and the map would zoom in
  // to nothing meaningful.
  const MIN_SPAN_DEG = 0.01;
  if (maxLat - minLat < MIN_SPAN_DEG) {
    const c = (minLat + maxLat) / 2;
    minLat = c - MIN_SPAN_DEG / 2;
    maxLat = c + MIN_SPAN_DEG / 2;
  }
  if (maxLon - minLon < MIN_SPAN_DEG) {
    const c = (minLon + maxLon) / 2;
    minLon = c - MIN_SPAN_DEG / 2;
    maxLon = c + MIN_SPAN_DEG / 2;
  }

  const availableWidth = MAP_CANVAS_WIDTH - MAP_PADDING_PX * 2;
  const availableHeight = MAP_CANVAS_HEIGHT - MAP_PADDING_PX * 2;

  let zoom = 3;
  for (let z = 18; z >= 1; z--) {
    const widthPx = lonToPixelX(maxLon, z) - lonToPixelX(minLon, z);
    const heightPx = latToPixelY(minLat, z) - latToPixelY(maxLat, z);
    if (widthPx <= availableWidth && heightPx <= availableHeight) {
      zoom = z;
      break;
    }
  }

  const centreLat = (minLat + maxLat) / 2;
  const centreLon = (minLon + maxLon) / 2;
  const originX = lonToPixelX(centreLon, zoom) - MAP_CANVAS_WIDTH / 2;
  const originY = latToPixelY(centreLat, zoom) - MAP_CANVAS_HEIGHT / 2;

  return { zoom, originX, originY };
}

function project(lat, lng, view) {
  return {
    x: lonToPixelX(lng, view.zoom) - view.originX,
    y: latToPixelY(lat, view.zoom) - view.originY,
  };
}

async function drawTiles(ctx, view) {
  const n = 2 ** view.zoom;
  const tileMinX = Math.floor(view.originX / TILE_SIZE);
  const tileMaxX = Math.floor((view.originX + MAP_CANVAS_WIDTH) / TILE_SIZE);
  const tileMinY = Math.floor(view.originY / TILE_SIZE);
  const tileMaxY = Math.floor((view.originY + MAP_CANVAS_HEIGHT) / TILE_SIZE);

  const loads = [];
  for (let tx = tileMinX; tx <= tileMaxX; tx++) {
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
      if (ty < 0 || ty >= n) continue;
      const wrappedX = ((tx % n) + n) % n;
      const url = `https://a.tile.openstreetmap.org/${view.zoom}/${wrappedX}/${ty}.png`;
      const destX = tx * TILE_SIZE - view.originX;
      const destY = ty * TILE_SIZE - view.originY;
      loads.push(
        loadImage(url, 6000)
          .then((img) => ctx.drawImage(img, destX, destY, TILE_SIZE, TILE_SIZE))
          .catch(() => {
            // A single missing/slow tile leaves a gap rather than failing
            // the whole map — the surrounding tiles and every drawn
            // overlay are unaffected.
            ctx.fillStyle = "#e7e7e7";
            ctx.fillRect(destX, destY, TILE_SIZE, TILE_SIZE);
          })
      );
    }
  }
  await Promise.all(loads);
}

function drawPolygon(ctx, pixelPoints, colour, opacity) {
  if (pixelPoints.length === 0) return;
  ctx.beginPath();
  pixelPoints.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.globalAlpha = opacity;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawMarker(ctx, point) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = "#1b6f93";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
}

/**
 * Builds the static map canvas for this scenario, or returns null if there
 * is nothing to draw (no completed results) or the tiles could not be
 * fetched at all (fully offline).
 */
async function renderStaticMap(computed) {
  const { location, zones, downwindDegrees } = computed;

  const allPoints = [{ lat: location.lat, lng: location.lng }];
  zones.forEach((z) => z.footprint.forEach((p) => allPoints.push(p)));

  const fireResult = computeFireResults();
  const fireOverlays = [];
  if (fireResult.status === "ok") {
    const isDirectional = fireResult.scenarioType === "pool" || fireResult.scenarioType === "jet";
    fireResult.results
      .filter((r) => r.thresholdExceeded)
      .forEach(({ level, maxDistance }) => {
        const localPoints = isDirectional
          ? fireWedgeLocalPoints(maxDistance)
          : fireCircleLocalPoints(maxDistance);
        const projected = projectFootprint(location.lat, location.lng, localPoints, downwindDegrees);
        projected.forEach((p) => allPoints.push(p));
        fireOverlays.push({ level, footprint: projected });
      });
  }

  const view = chooseZoomAndOrigin(allPoints);

  const canvas = document.createElement("canvas");
  canvas.width = MAP_CANVAS_WIDTH;
  canvas.height = MAP_CANVAS_HEIGHT;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e7e7e7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await drawTiles(ctx, view);

  // Wind line, same fixed 200 m visual length as the on-screen map.
  const [windEnd] = projectFootprint(location.lat, location.lng, [{ x: 200, y: 0 }], downwindDegrees);
  const sourcePixel = project(location.lat, location.lng, view);
  const windPixel = project(windEnd.lat, windEnd.lng, view);
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = "#12242e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sourcePixel.x, sourcePixel.y);
  ctx.lineTo(windPixel.x, windPixel.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Largest zone first, so a smaller and more severe zone always renders on
  // top — same rule the on-screen map uses.
  const orderedZones = [...zones].sort((a, b) => b.result.maxDownwindDistance - a.result.maxDownwindDistance);
  orderedZones.forEach(({ level, footprint }) => {
    if (footprint.length === 0) return;
    const pixelPoints = footprint.map((p) => project(p.lat, p.lng, view));
    drawPolygon(ctx, pixelPoints, ZONE_COLOUR[level.colour] ?? "#12242e", 0.35);
  });

  const orderedFire = [...fireOverlays].sort((a, b) => {
    const extentA = Math.max(...a.footprint.map((p) => Math.abs(p.lat) + Math.abs(p.lng)));
    const extentB = Math.max(...b.footprint.map((p) => Math.abs(p.lat) + Math.abs(p.lng)));
    return extentB - extentA;
  });
  orderedFire.forEach(({ level, footprint }) => {
    const pixelPoints = footprint.map((p) => project(p.lat, p.lng, view));
    drawPolygon(ctx, pixelPoints, ZONE_COLOUR[level.colour] ?? "#12242e", 0.22);
  });

  drawMarker(ctx, sourcePixel);

  // Required OSM attribution — the same text the on-screen map carries.
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(canvas.width - 190, canvas.height - 20, 190, 20);
  ctx.fillStyle = "#333333";
  ctx.fillText("© OpenStreetMap contributors", canvas.width - 6, canvas.height - 6);

  return canvas;
}

async function buildMapSection(cursor, computed) {
  addHeading(cursor, "8. Map");
  try {
    const canvas = await renderStaticMap(computed);
    const imgData = canvas.toDataURL("image/jpeg", 0.85);
    const imgWidth = cursor.contentWidth;
    const imgHeight = (canvas.height / canvas.width) * imgWidth;
    ensureSpace(cursor, imgHeight);
    cursor.doc.addImage(imgData, "JPEG", PAGE_MARGIN, cursor.y, imgWidth, imgHeight);
    cursor.y += imgHeight + LINE_HEIGHT;
  } catch {
    addParagraph(
      cursor,
      "The map could not be built for this report (this can happen fully offline, since it needs to " +
        "fetch map tiles). Try again with a connection.",
      { fontSize: 9 }
    );
  }
}

function buildLimitationsSection(cursor, computed) {
  addHeading(cursor, "9. Limitations of this estimate");
  const scenario = {
    vapourDensityRatio: computed?.dispersion?.densityRatio,
    maxDownwindDistance: Math.max(
      0,
      ...(computed?.zones ?? []).map((z) => (z.result.thresholdExceeded ? z.result.maxDownwindDistance : 0))
    ),
  };
  for (const limitation of relevantLimitations(scenario)) {
    addParagraph(cursor, `${limitation.title}.`, { bold: true, fontSize: 9.5 });
    addParagraph(cursor, limitation.consequence, { fontSize: 9 });
    cursor.y += LINE_HEIGHT * 0.3;
  }
}

function addFootersToAllPages(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(120);
    doc.text(SHORT_DISCLAIMER, PAGE_MARGIN, doc.internal.pageSize.getHeight() - 8);
    doc.text(
      `Page ${i} of ${pageCount}`,
      doc.internal.pageSize.getWidth() - PAGE_MARGIN,
      doc.internal.pageSize.getHeight() - 8,
      { align: "right" }
    );
    doc.setTextColor(0);
  }
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

/**
 * Builds and downloads the full report as a PDF.
 * @param {object} computed - the object returned by stepResults.js's
 *        computeZones(), already available to the caller since the map on
 *        screen was drawn from it.
 * @param {{ operatorName: string, ipAddress: string|null }} trace
 */
export async function exportScenarioPdf(computed, trace) {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF({ unit: "mm", format: "a4" });
  const cursor = makeCursor(doc);

  await buildCoverAndTrace(cursor, {
    operatorName: trace.operatorName,
    generatedAt: new Date(),
    ipAddress: trace.ipAddress,
  });
  addDivider(cursor);
  buildLocationSection(cursor);
  buildChemicalSection(cursor);
  buildWeatherSection(cursor);
  buildSourceSection(cursor);
  buildResultsSection(cursor, computed);
  buildFireSection(cursor);
  buildIndoorSection(cursor);
  if (computed.status === "ok") {
    await buildMapSection(cursor, computed);
  }
  buildLimitationsSection(cursor, computed);

  addFootersToAllPages(doc);

  const filename = `hazel-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.pdf`;
  doc.save(filename);
}

/**
 * Shows the "sign before generating" dialog (name + re-confirmed
 * declaration), fetches the best-effort IP address in the background while
 * the person is typing, and calls exportScenarioPdf() once they confirm.
 *
 * Modelled on consentGate.js's overlay so it reuses its CSS rather than
 * introducing a second dialog style — see components.css's .consent-gate*
 * rules.
 */
export function openPdfExportDialog(computed) {
  const ipPromise = lookupPublicIp();

  const overlay = document.createElement("div");
  overlay.className = "consent-gate";
  overlay.innerHTML = `
    <div class="consent-gate__panel" role="dialog" aria-modal="true" aria-labelledby="pdf-export-title">
      <h1 id="pdf-export-title">Generate PDF report</h1>
      <p>
        This report includes every input from this scenario — including anything typed by hand — the
        computed results, a map, and this software's usual disclaimer. Because it is meant to be
        shared or filed, it also records who generated it.
      </p>
      <div class="field">
        <label for="pdf-export-name">Full name</label>
        <input type="text" id="pdf-export-name" placeholder="Jan Kowalski" />
      </div>
      <label class="consent-gate__check">
        <input type="checkbox" id="pdf-export-confirm" />
        <span>
          I confirm I am professionally involved in dangerous goods transport, as declared when I
          started using HAZEL, and that this report will be used as intended. I understand this is an
          indicative simulation only and that HAZEL's authors accept no liability for this output or
          its use.
        </span>
      </label>
      <div id="pdf-export-error"></div>
      <div style="display:flex; gap: var(--space-3); margin-top: var(--space-4);">
        <button type="button" class="btn btn--secondary" id="pdf-export-cancel">Cancel</button>
        <button type="button" class="btn btn--primary" id="pdf-export-generate" disabled>Generate PDF</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  const nameInput = overlay.querySelector("#pdf-export-name");
  const confirmBox = overlay.querySelector("#pdf-export-confirm");
  const generateBtn = overlay.querySelector("#pdf-export-generate");
  const errorSlot = overlay.querySelector("#pdf-export-error");

  function refreshEnabled() {
    generateBtn.disabled = !(nameInput.value.trim().length > 0 && confirmBox.checked);
  }
  nameInput.addEventListener("input", refreshEnabled);
  confirmBox.addEventListener("change", refreshEnabled);

  function close() {
    overlay.remove();
    document.body.style.overflow = "";
  }

  overlay.querySelector("#pdf-export-cancel").addEventListener("click", close);

  generateBtn.addEventListener("click", async () => {
    if (generateBtn.disabled) return;
    generateBtn.disabled = true;
    generateBtn.textContent = "Generating…";
    try {
      const ipAddress = await ipPromise;
      await exportScenarioPdf(computed, {
        operatorName: nameInput.value.trim(),
        ipAddress,
      });
      close();
    } catch (error) {
      errorSlot.innerHTML = `<div class="banner banner--warning" style="margin-top: var(--space-2);"><span>Could not generate the PDF: ${error.message}</span></div>`;
      generateBtn.disabled = false;
      generateBtn.textContent = "Generate PDF";
    }
  });
}
