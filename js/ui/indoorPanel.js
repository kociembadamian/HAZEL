/**
 * indoorPanel.js
 * --------------
 * The optional "sheltering indoors" section of the Results step: given a
 * building at a chosen distance downwind, how much of the outdoor cloud
 * actually builds up inside it, and how that compares to the outdoor peak.
 *
 * Kept as its own module, alongside the same-shaped fireExplosionPanel.js,
 * for the same reason that one gives: a genuinely separate concern, with
 * its own inputs, that can be computed and redrawn independently of the
 * map and the toxic/flammable-area zones above it.
 *
 * WHY THIS EXISTS
 * -----------------
 * ALOHA's own indoor concentration model (Tech Doc section 4.6, after
 * Wilson 1987) was, for a while, an honestly-documented gap in HAZEL — see
 * the "hazel-indoor" entry in engineLimitations.js and the physics itself
 * in engineIndoor.js. It matters most for exactly the case this project
 * exists for that also happens to sit near people: a dangerous-goods
 * transport incident within reach of a populated area, where the practical
 * question during the incident is genuinely "evacuate, or shelter in
 * place?" — a question this panel gives a modelled, comparative answer to,
 * without pretending to make that call itself.
 *
 * WHAT IT ASSUMES
 * -----------------
 * The building sits directly on the plume centreline at a distance the
 * user supplies (not necessarily where they last clicked on the map,
 * though that is a good way to read the distance off). This is the most
 * exposed position a building at that distance could be in, which fits
 * this project's general bias toward the conservative side (see
 * engineLimitations.js). Off-centreline placement is not modelled; a real
 * building offset from the centreline sees a lower outdoor concentration,
 * and therefore an even lower indoor one, than reported here.
 */

import { state } from "./state.js";
import { buildDispersionScenario } from "./stepSource.js";
import { peakConcentration, massConcentrationToPpm, logProfileWindSpeed } from "../engine/engineGaussian.js";
import { concentrationAtDistance, concentrationAtOffset } from "../engine/engineHeavyGas.js";
import {
  estimateInfiltrationTimeConstant,
  peakIndoorConcentration,
  indoorConcentrationAfterExposure,
  validateBuildingParameters,
  effectiveExposureDurationSeconds,
  DEFAULT_FLOOR_AREA_M2,
  STORY_CEILING_HEIGHTS_M,
} from "../engine/engineIndoor.js";

export function defaultIndoorScenario() {
  return {
    enabled: false,
    downwindDistance: null, // m, on the plume centreline — see module docstring
    tauMode: "auto", // "auto" | "manual"
    manualTauHours: null,
    floorAreaM2: DEFAULT_FLOOR_AREA_M2,
    stories: 1,
    sheltering: "unsheltered",
    internalTemperatureC: 20,
  };
}

function currentIndoor() {
  return state.current.scenario.indoor ?? defaultIndoorScenario();
}

function updateIndoor(changes) {
  const indoor = { ...currentIndoor(), ...changes };
  state.update({ scenario: { ...state.current.scenario, indoor } });
}

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Reads a form control's value in the type it should actually be stored as
 *  (see fireExplosionPanel.js's fireFieldValueFromInput for why this matters
 *  — input.value is always a string, even for <input type="number">). */
function indoorFieldValueFromInput(input, field) {
  if (input.type === "checkbox") return input.checked;
  if (field === "stories") return Number(input.value);
  if (input.tagName === "SELECT") return input.value;
  return Number(input.value);
}

/* ========================================================================
   COMPUTATION
   ======================================================================== */

/**
 * Computes the outdoor-vs-indoor comparison for the currently configured
 * building, or explains what is still needed.
 *
 * @returns {{status: "disabled"}
 *          |{status: "incomplete", missing: string[]}
 *          |{status: "ok", outdoorPpm: number, peakIndoorPpm: number,
 *             indoorOneTauAfter: number, tauSeconds: number,
 *             exposureDurationSeconds: number, buildingDetail: object|null,
 *             downwindDistance: number}}
 */
export function computeIndoorResults() {
  const indoor = currentIndoor();
  if (!indoor.enabled) return { status: "disabled" };

  const dispersionScenario = buildDispersionScenario();
  const missing = [];
  if (dispersionScenario.status !== "ok") missing.push(...dispersionScenario.missing);

  const x = Number(indoor.downwindDistance);
  if (!Number.isFinite(x) || x <= 0) {
    missing.push("a downwind distance to the building (click a point on the map above to read one off)");
  }

  if (missing.length > 0) return { status: "incomplete", missing };

  const { isHeavyGas, scenarioBase } = dispersionScenario;

  let concentrationKgM3;
  if (isHeavyGas) {
    // Same profile the map's own point-query uses (stepResults.js) — a
    // point just outside the homogeneous core still reports a smoothly
    // falling concentration rather than an abrupt zero. Offset is fixed
    // at zero: the building is assumed on the centreline (see module
    // docstring).
    const station = concentrationAtDistance(scenarioBase, x);
    concentrationKgM3 = concentrationAtOffset(
      station.concentrationKgM3, 0, station.halfWidth, station.x, scenarioBase.stabilityClass
    );
  } else {
    concentrationKgM3 = peakConcentration({ ...scenarioBase, x, y: 0, z: 0 });
  }
  const outdoorPpm = massConcentrationToPpm(concentrationKgM3, scenarioBase.molecularWeight, scenarioBase.temperature);

  // The exposure duration fed to the R-C filter model below is NOT simply
  // the release duration — see effectiveExposureDurationSeconds()'s own
  // docstring in engineIndoor.js (fixed 2026-09-26; see also
  // engineLimitations.js's "hazel-indoor" entry and
  // the 2026-09-26 duration review, finding #4) for why
  // a brief release needs an along-wind residence-time correction on top of
  // its own duration to avoid understating indoor exposure.
  const exposureDurationSeconds = effectiveExposureDurationSeconds({
    releaseDuration: scenarioBase.releaseDuration,
    downwindDistance: x,
    windSpeed10m: scenarioBase.windSpeed10m,
    stabilityClass: scenarioBase.stabilityClass,
  });

  let tauSeconds;
  let buildingDetail = null;

  if (indoor.tauMode === "manual") {
    const hours = Number(indoor.manualTauHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { status: "incomplete", missing: ["an infiltration time constant, in hours"] };
    }
    tauSeconds = hours * 3600;
  } else {
    const structureHeightM = STORY_CEILING_HEIGHTS_M[indoor.stories] ?? STORY_CEILING_HEIGHTS_M[1];
    const internalTemperatureK = Number(indoor.internalTemperatureC) + 273.15;
    const outdoorTemperatureK = scenarioBase.temperature;
    // Wind at the building height from the Tech Doc 4.2.3 log profile —
    // with it ALOHA's printed air-exchange rates are reproduced (2026-10-02,
    // see engineIndoor.js).
    const windSpeedAtStructureHeight = logProfileWindSpeed(
      scenarioBase.windSpeed10m, structureHeightM, scenarioBase.roughnessLength, scenarioBase.stabilityClass
    );

    const problems = validateBuildingParameters({
      floorAreaM2: Number(indoor.floorAreaM2),
      stories: indoor.stories,
      internalTemperatureK,
      outdoorTemperatureK,
      windSpeedAtStructureHeight,
    });
    if (problems.length > 0) return { status: "incomplete", missing: problems };

    buildingDetail = estimateInfiltrationTimeConstant({
      floorAreaM2: Number(indoor.floorAreaM2),
      stories: indoor.stories,
      structureHeightM,
      internalTemperatureK,
      outdoorTemperatureK,
      windSpeedAtStructureHeight,
      sheltering: indoor.sheltering,
    });
    tauSeconds = buildingDetail.tauSeconds;
  }

  const peakIndoorPpm = peakIndoorConcentration(outdoorPpm, exposureDurationSeconds, tauSeconds);
  // A fixed reference point — concentration indoors one full time constant
  // after the outdoor cloud has passed — not a claim about when it becomes
  // safe to leave; no threshold judgement is made here.
  const indoorOneTauAfter = indoorConcentrationAfterExposure(
    exposureDurationSeconds + tauSeconds, outdoorPpm, exposureDurationSeconds, tauSeconds
  );

  return {
    status: "ok",
    outdoorPpm,
    peakIndoorPpm,
    indoorOneTauAfter,
    tauSeconds,
    exposureDurationSeconds,
    buildingDetail,
    downwindDistance: x,
  };
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function formatPpm(ppm) {
  return ppm < 0.01 ? ppm.toExponential(2) : ppm.toFixed(2);
}

function formatDuration(seconds) {
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

function manualTauFormHtml(indoor) {
  return `
    <div class="field">
      <label for="indoor-tau-manual">Time constant</label>
      <div class="input-pair">
        <input type="number" id="indoor-tau-manual" step="0.05" min="0.01"
               value="${indoor.manualTauHours ?? ""}" data-indoor-field="manualTauHours"
               placeholder="e.g. 0.5" />
        <span class="input-suffix">hours</span>
      </div>
      <div class="field__hint">
        The time for indoor concentration to reach 63% of a sudden outdoor
        change. Use this if you know the building's actual tightness better
        than a generic estimate can.
      </div>
    </div>`;
}

function buildingFormHtml(indoor) {
  return `
    <div class="field-grid">
      <div class="field">
        <label for="indoor-floor-area">Building floor area</label>
        <div class="input-pair">
          <input type="number" id="indoor-floor-area" step="10" min="10"
                 value="${indoor.floorAreaM2 ?? DEFAULT_FLOOR_AREA_M2}" data-indoor-field="floorAreaM2" />
          <span class="input-suffix">m²</span>
        </div>
        <div class="field__hint">The default, 160 m², corresponds to an average house.</div>
      </div>

      <div class="field">
        <label for="indoor-stories">Building height</label>
        <select id="indoor-stories" data-indoor-field="stories">
          <option value="1"${indoor.stories === 1 ? " selected" : ""}>Single-story (2.5 m ceiling)</option>
          <option value="2"${indoor.stories === 2 ? " selected" : ""}>Two-story (5 m)</option>
        </select>
      </div>

      <div class="field">
        <label for="indoor-sheltering">Exposure to wind</label>
        <select id="indoor-sheltering" data-indoor-field="sheltering">
          <option value="unsheltered"${indoor.sheltering === "unsheltered" ? " selected" : ""}>Unsheltered (isolated building)</option>
          <option value="sheltered"${indoor.sheltering === "sheltered" ? " selected" : ""}>Sheltered (surrounded by other buildings)</option>
        </select>
      </div>

      <div class="field">
        <label for="indoor-internal-temp">Assumed indoor temperature</label>
        <div class="input-pair">
          <input type="number" id="indoor-internal-temp" step="0.5"
                 value="${indoor.internalTemperatureC ?? 20}" data-indoor-field="internalTemperatureC" />
          <span class="input-suffix">°C</span>
        </div>
      </div>
    </div>
    <p class="field__hint">
      This follows Sherman's method: an effective
      leakage area proportional to floor area, driven by both the wind at
      the building and the indoor/outdoor temperature difference. It is a
      broad generalisation, used for lack of anything more
      specific — a real building's actual tightness can differ
      substantially. If you know a better figure for this particular
      building, use "I'll specify it directly" above instead.
    </p>`;
}

function refreshIndoorResults(container) {
  const slot = container.querySelector("#indoor-results");
  if (!slot) return;

  const computed = computeIndoorResults();

  if (computed.status === "disabled") {
    slot.innerHTML = "";
    return;
  }

  if (computed.status === "incomplete") {
    slot.innerHTML = `
      <div class="banner banner--info">
        <span>Still needed: ${computed.missing.map(escapeHtml).join("; ")}.</span>
      </div>`;
    return;
  }

  const ratioPct = computed.outdoorPpm > 0 ? (computed.peakIndoorPpm / computed.outdoorPpm) * 100 : 0;

  slot.innerHTML = `
    <dl class="readout" style="margin-top: var(--space-4);">
      <div><dt>Infiltration time constant</dt><dd>${formatDuration(computed.tauSeconds)}</dd></div>
      <div><dt>Outdoor peak at ${computed.downwindDistance.toFixed(0)} m downwind</dt><dd>${formatPpm(computed.outdoorPpm)} ppm</dd></div>
      <div><dt>Peak indoor concentration</dt><dd>${formatPpm(computed.peakIndoorPpm)} ppm (${ratioPct.toFixed(0)}% of the outdoor peak)</dd></div>
      <div><dt>Indoors, one time constant after the release ends</dt><dd>${formatPpm(computed.indoorOneTauAfter)} ppm</dd></div>
    </dl>
    <p class="field__hint">
      This compares the two exposure routes at the same point — passing
      through the outdoor peak versus sheltering indoors — using the
      outdoor concentration held at its peak value for the whole release
      (the same conservative simplification used elsewhere in HAZEL for a
      time-varying source), fed through the model above. It does not judge
      which choice is safer for a given situation: that depends on
      evacuation time, route, and the specific thresholds in play, which is
      a decision for the responder, not this tool.
    </p>`;
}

function wireIndoorEvents(container, onChange) {
  container.querySelector("#indoor-enabled")?.addEventListener("change", (event) => {
    updateIndoor({ enabled: event.target.checked });
    renderIndoorPanel(container, onChange);
    onChange();
  });

  container.querySelectorAll("[data-indoor-field]").forEach((input) => {
    input.addEventListener("change", () => {
      const field = input.dataset.indoorField;
      updateIndoor({ [field]: indoorFieldValueFromInput(input, field) });
      if (field === "tauMode") {
        renderIndoorPanel(container, onChange); // swap between the manual and building sub-forms
      } else {
        refreshIndoorResults(container);
      }
      onChange();
    });
  });
}

/**
 * Renders the indoor-concentration panel into a container, wired to redraw
 * its own results whenever an input changes. Has no effect on the map — the
 * onChange callback exists purely for symmetry with fireExplosionPanel.js's
 * calling convention in stepResults.js.
 *
 * @param {HTMLElement} container - a fresh container for this render of the
 *        Results step (see stepResults.js)
 * @param {() => void} onChange
 */
export function renderIndoorPanel(container, onChange) {
  const indoor = currentIndoor();

  container.innerHTML = `
    <div class="panel" style="margin-top: var(--space-6);">
      <h3>Indoor concentration (shelter-in-place)</h3>
      <p>
        How much of the outdoor cloud actually builds up inside a nearby
        building, for someone sheltering in place instead of evacuating. A
        well-sealed building acts like a slow filter: indoor concentration
        rises and falls more gradually, and typically less far, than the
        outdoor peak passing by outside (after Wilson 1987).
      </p>

      <label style="display:flex; align-items:center; gap: var(--space-2);">
        <input type="checkbox" id="indoor-enabled" ${indoor.enabled ? "checked" : ""} style="width:auto;" />
        Model a building at a given downwind distance
      </label>

      <div id="indoor-form" style="${indoor.enabled ? "" : "display:none"}; margin-top: var(--space-4);">
        <div class="field-grid">
          <div class="field">
            <label for="indoor-distance">Downwind distance to the building</label>
            <div class="input-pair">
              <input type="number" id="indoor-distance" step="1" min="1"
                     value="${indoor.downwindDistance ?? ""}" data-indoor-field="downwindDistance"
                     placeholder="e.g. 400" />
              <span class="input-suffix">m</span>
            </div>
            <div class="field__hint">
              Measured along the plume centreline — the most exposed
              position a building at that distance could be in (click a
              point on the map above to read one off, if you are not sure).
            </div>
          </div>

          <div class="field">
            <label for="indoor-tau-mode">Infiltration time constant</label>
            <select id="indoor-tau-mode" data-indoor-field="tauMode">
              <option value="auto"${indoor.tauMode === "auto" ? " selected" : ""}>Estimate from building parameters</option>
              <option value="manual"${indoor.tauMode === "manual" ? " selected" : ""}>I'll specify it directly</option>
            </select>
          </div>
        </div>

        <div id="indoor-tau-form">
          ${indoor.tauMode === "manual" ? manualTauFormHtml(indoor) : buildingFormHtml(indoor)}
        </div>

        <div id="indoor-results"></div>
      </div>
    </div>`;

  wireIndoorEvents(container, onChange);
  refreshIndoorResults(container);
}
