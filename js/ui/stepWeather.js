/**
 * stepWeather.js
 * --------------
 * The Weather step of the scenario wizard.
 *
 * Two design decisions carried over from the project's ground rules:
 *
 * 1. Manual entry is a FIRST-CLASS mode, not a fallback. It sits beside
 *    "fetch current conditions" as an equal choice, because HAZEL is as much a
 *    simulation and training tool as a live-incident one — and because a
 *    responder in a tunnel or a rural layby has no connectivity anyway. The
 *    whole step, and everything downstream of it, works with no network.
 *
 * 2. Fetched data is never silently trusted because it exists. Its age is
 *    shown, and the user decides whether to refresh or proceed. Weather an
 *    hour old may be perfectly fine; the point is that the user knows, rather
 *    than the interface quietly deciding for them.
 *
 * Rendering approach: the form is drawn once when the step is opened, then
 * only the derived parts (stability class, warnings) update as fields change.
 * Re-rendering the whole form on every keystroke would steal focus mid-typing.
 *
 * NOTE (2026-09-23): the "Quick presets" buttons now track and show which
 * preset (if any) is currently applied, via weather.activePreset — see
 * presetsHtml() and the wireEvents() handlers below. Previously a clicked
 * preset button gave no lasting indication that it had actually done
 * anything, and there was no way to tell, by looking at the form, whether
 * the current values still matched a preset or had since been hand-edited.
 */

import { state } from "./state.js";
import { wireOnce } from "./domUtils.js";
import {
  isWeatherFetchAvailable,
  fetchWeather,
  getCachedWeather,
  isStale,
  isWithinThrottleWindow,
  minutesSinceLastFetch,
} from "../services/weatherService.js";
import { config } from "../../config.js";
import { describeAge } from "../services/weatherStorage.js";
import {
  WIND_SPEED_UNITS,
  TEMPERATURE_UNITS,
  windSpeedToMetresPerSecond,
  temperatureToKelvin,
  parseWindDirection,
  degreesToCompassPoint,
  downwindDirection,
} from "../engine/units.js";
import {
  determineStabilityClass,
  cloudCoverToCategory,
  insolationFromSolarElevation,
  isWindSpeedUsable,
} from "../engine/engineStability.js";
import { solarElevation } from "../engine/solarPosition.js";
import { incidentMoment } from "./stepLocation.js";
import {
  GROUND_ROUGHNESS_PRESETS,
  roughnessForOpenWater,
  STABILITY_CLASSES,
  MIN_WIND_SPEED,
} from "../engine/engineConstants.js";

/**
 * Ready-made condition sets.
 *
 * These exist for the training and what-if use case: somebody exploring how
 * the threat zone responds to weather should not have to invent plausible
 * numbers first. "Worst case" is the combination that produces the largest
 * zone — light wind with a stable night-time atmosphere, which disperses the
 * cloud least — and is the one a planner most often wants.
 */
const PRESETS = {
  typicalDay: {
    label: "Typical day",
    description: "Moderate wind, partly cloudy, neutral stability",
    values: {
      windSpeed: 5,
      windSpeedUnit: "m/s",
      windFromDirection: "SW",
      windMeasurementHeight: 10,
      temperature: 15,
      temperatureUnit: "C",
      cloudCoverOktas: 4,
      relativeHumidity: 60,
      isDaytime: true,
      inversionPresent: false,
    },
  },
  worstCase: {
    label: "Worst case",
    description: "Light wind, clear night, inversion — least dispersion",
    values: {
      windSpeed: 1.5,
      windSpeedUnit: "m/s",
      windFromDirection: "SW",
      windMeasurementHeight: 10,
      temperature: 5,
      temperatureUnit: "C",
      cloudCoverOktas: 0,
      relativeHumidity: 80,
      isDaytime: false,
      inversionPresent: true,
      inversionHeight: 100,
    },
  },
  windyDay: {
    label: "Windy day",
    description: "Strong wind, overcast — rapid dilution",
    values: {
      windSpeed: 10,
      windSpeedUnit: "m/s",
      windFromDirection: "W",
      windMeasurementHeight: 10,
      temperature: 12,
      temperatureUnit: "C",
      cloudCoverOktas: 8,
      relativeHumidity: 70,
      isDaytime: true,
      inversionPresent: false,
    },
  },
};

/** Values the form starts with when the step is opened for the first time. */
const DEFAULT_WEATHER = {
  mode: "manual", // "manual" | "fetched"
  ...PRESETS.typicalDay.values,
  groundRoughnessPreset: "openCountry",
  customRoughness: 0.03,
  inversionHeight: 100,
  stabilityOverride: "", // empty means "use the automatically determined class"
  activePreset: null, // key of PRESETS, or null once any field is hand-edited
};

/* ========================================================================
   DERIVED VALUES
   ======================================================================== */

/**
 * Returns the incident location when it has usable coordinates, otherwise null.
 *
 * Written defensively because deriveEngineInputs() is also called from tests
 * and from contexts where the Location step has not been visited. A missing
 * location must degrade the stability determination, never break it.
 */
function locationForSolarPosition() {
  const location = state?.current?.scenario?.location;
  if (!location) return null;
  if (location.lat === null || location.lat === undefined) return null;
  if (location.lng === null || location.lng === undefined) return null;
  return location;
}

/**
 * Works out the surface roughness length from the chosen terrain preset.
 *
 * Open water is the odd one out: its roughness depends on wind speed, because
 * the wave field the wind raises IS the roughness (Tech Doc section 4.2.3).
 */
export function resolveRoughness(weather, windSpeedMs) {
  switch (weather.groundRoughnessPreset) {
    case "openCountry":
      return GROUND_ROUGHNESS_PRESETS.openCountry;
    case "urbanOrForest":
      return GROUND_ROUGHNESS_PRESETS.urbanOrForest;
    case "openWater":
      return roughnessForOpenWater(windSpeedMs);
    case "custom":
      return Number(weather.customRoughness) || GROUND_ROUGHNESS_PRESETS.openCountry;
    default:
      return GROUND_ROUGHNESS_PRESETS.openCountry;
  }
}

/**
 * Turns the raw form contents into the SI values the dispersion engine wants,
 * plus the derived stability class.
 *
 * Everything the engine needs comes out of this one function, which keeps the
 * conversion and classification logic in a single testable place rather than
 * scattered through event handlers.
 *
 * @returns {object} engine-ready weather, with `problems` listing anything wrong
 */
export function deriveEngineInputs(weather) {
  const problems = [];

  const windSpeedMs = windSpeedToMetresPerSecond(
    Number(weather.windSpeed),
    weather.windSpeedUnit
  );

  let windFromDegrees = 0;
  try {
    windFromDegrees = parseWindDirection(weather.windFromDirection);
  } catch (error) {
    problems.push(error.message);
  }

  const temperatureK = temperatureToKelvin(
    Number(weather.temperature),
    weather.temperatureUnit
  );

  // Stability class. Three routes, in order of preference:
  //
  //   1. A manual override, if the user set one. An experienced adviser on
  //      site may know the actual stability better than any lookup can infer.
  //
  //   2. Solar elevation, when the Location step has supplied coordinates and
  //      a time. This is what ALOHA does and is materially more accurate: the
  //      same cloud cover and wind produce different stability under a high
  //      summer sun than under a low winter one.
  //
  //   3. Cloud cover with a plain day/night flag, when no coordinates are set
  //      yet. Coarser, but it keeps the Weather step usable on its own.
  let stabilityClass;
  let stabilitySource;
  let solarElevationDegrees = null;

  if (weather.stabilityOverride) {
    stabilityClass = weather.stabilityOverride;
    stabilitySource = "override";
  } else {
    const location = locationForSolarPosition();

    let category;
    let isDaytime;

    if (location) {
      solarElevationDegrees = solarElevation(
        incidentMoment(location),
        location.lat,
        location.lng
      );
      const derivedCategory = insolationFromSolarElevation(
        solarElevationDegrees,
        Number(weather.cloudCoverOktas)
      );
      isDaytime = derivedCategory.isDaytime;
      category = derivedCategory.insolation
        ? { insolation: derivedCategory.insolation }
        : { nightCloud: derivedCategory.nightCloud };
      stabilitySource = "solar";
    } else {
      isDaytime = weather.isDaytime;
      category = cloudCoverToCategory(Number(weather.cloudCoverOktas), isDaytime);
      stabilitySource = "cloudCover";
    }

    stabilityClass = determineStabilityClass({
      windSpeed10m: windSpeedMs,
      isDaytime,
      ...category,
    });
  }

  const roughnessLength = resolveRoughness(weather, windSpeedMs);

  if (!isWindSpeedUsable(windSpeedMs)) {
    problems.push(
      `Wind speed of ${windSpeedMs.toFixed(1)} m/s is below the ${MIN_WIND_SPEED} m/s ` +
        `minimum for the dispersion model. In near-calm conditions the cloud is not ` +
        `carried predictably by the wind and no reliable threat zone can be calculated.`
    );
  }

  return {
    windSpeed10m: windSpeedMs,
    windFromDegrees,
    downwindDegrees: downwindDirection(windFromDegrees),
    temperature: temperatureK,
    relativeHumidity: Number(weather.relativeHumidity),
    stabilityClass,
    stabilityWasOverridden: Boolean(weather.stabilityOverride),
    stabilitySource,
    // Whether the daytime/night split actually used was the Weather step's
    // own manual flag, or one derived from the sun's real position (see the
    // "solar" branch above, and the stepWeather.js note next to it). Exposed
    // so the derived-conditions panel below can tell the user which one
    // happened, rather than leaving the "Time of day" dropdown looking like
    // it always does something.
    isDaytime: stabilitySource === "solar" ? Boolean(solarElevationDegrees > 0) : weather.isDaytime,
    solarElevationDegrees,
    roughnessLength,
    inversionHeight: weather.inversionPresent ? Number(weather.inversionHeight) : null,
    problems,
  };
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function currentWeather() {
  return state.current.scenario.weather ?? { ...DEFAULT_WEATHER };
}

function updateWeather(changes) {
  const weather = { ...currentWeather(), ...changes };
  state.update({
    scenario: { ...state.current.scenario, weather },
  });
  refreshDerived();
}

function optionsHtml(entries, selected) {
  return entries
    .map(
      ([value, label]) =>
        `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`
    )
    .join("");
}

function modeSelectorHtml(weather) {
  const fetchAvailable = isWeatherFetchAvailable();

  return `
    <div class="mode-grid">
      <button type="button" class="choice-card" data-mode="manual"
              aria-pressed="${weather.mode === "manual"}">
        <span class="choice-card__title">Enter conditions manually</span>
        <span class="choice-card__desc">
          Type in observed or hypothetical weather. Works offline, and is the
          mode to use for training scenarios and what-if planning.
        </span>
      </button>

      <button type="button" class="choice-card" data-mode="fetched"
              aria-pressed="${weather.mode === "fetched"}"
              ${fetchAvailable ? "" : "disabled"}>
        <span class="choice-card__title">Use current conditions</span>
        <span class="choice-card__desc">
          ${
            fetchAvailable
              ? "Fetch the latest forecast for the incident location."
              : "Not available — this installation has no weather relay configured."
          }
        </span>
      </button>
    </div>
  `;
}

/**
 * The preset buttons, marked with aria-pressed so the currently-applied one
 * (if any) stays visibly highlighted (see components.css's
 * .btn--secondary[aria-pressed="true"] rule) until a field is hand-edited,
 * at which point wireEvents() clears weather.activePreset and a re-render
 * drops the highlight — see the module docstring's 2026-09-23 note.
 */
function presetsHtml(weather) {
  const buttons = Object.entries(PRESETS)
    .map(
      ([key, preset]) => `
        <button type="button" class="btn btn--secondary btn--small" data-preset="${key}"
                aria-pressed="${weather.activePreset === key}"
                title="${preset.description}">${preset.label}</button>`
    )
    .join("");

  return `
    <div class="field">
      <label>Quick presets</label>
      <div class="preset-row">${buttons}</div>
      <div class="field__hint">
        Starting points for exploring how conditions change the result. Every
        value stays editable afterwards — editing any of them clears the
        highlight above, since the values no longer match that preset exactly.
      </div>
    </div>
  `;
}

function formHtml(weather) {
  return `
    ${presetsHtml(weather)}

    <div class="field-grid">
      <div class="field">
        <label for="wx-wind-speed">Wind speed</label>
        <div class="input-pair">
          <input type="number" id="wx-wind-speed" step="0.1" min="0"
                 value="${weather.windSpeed}" data-field="windSpeed" />
          <select data-field="windSpeedUnit" aria-label="Wind speed unit">
            ${optionsHtml(
              Object.entries(WIND_SPEED_UNITS).map(([k, v]) => [k, v.label]),
              weather.windSpeedUnit
            )}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="wx-wind-dir">Wind blowing from</label>
        <input type="text" id="wx-wind-dir" value="${weather.windFromDirection}"
               data-field="windFromDirection" placeholder="SW or 225" />
        <div class="field__hint">Compass point or degrees. The cloud travels the opposite way.</div>
      </div>

      <div class="field">
        <label for="wx-wind-height">Measurement height</label>
        <div class="input-pair">
          <input type="number" id="wx-wind-height" step="1" min="1"
                 value="${weather.windMeasurementHeight}" data-field="windMeasurementHeight" />
          <span class="input-suffix">m</span>
        </div>
        <div class="field__hint">Standard weather masts report at 10 m.</div>
      </div>

      <div class="field">
        <label for="wx-temp">Air temperature</label>
        <div class="input-pair">
          <input type="number" id="wx-temp" step="0.1"
                 value="${weather.temperature}" data-field="temperature" />
          <select data-field="temperatureUnit" aria-label="Temperature unit">
            ${optionsHtml(Object.entries(TEMPERATURE_UNITS), weather.temperatureUnit)}
          </select>
        </div>
      </div>

      <div class="field">
        <label for="wx-cloud">Cloud cover</label>
        <div class="input-pair">
          <input type="range" id="wx-cloud" min="0" max="8" step="1"
                 value="${weather.cloudCoverOktas}" data-field="cloudCoverOktas" />
          <span class="input-suffix" id="wx-cloud-readout">${weather.cloudCoverOktas}/8</span>
        </div>
        <div class="field__hint">In eighths: 0 is clear sky, 8 is fully overcast.</div>
      </div>

      <div class="field">
        <label for="wx-humidity">Relative humidity</label>
        <div class="input-pair">
          <input type="number" id="wx-humidity" min="0" max="100" step="1"
                 value="${weather.relativeHumidity}" data-field="relativeHumidity" />
          <span class="input-suffix">%</span>
        </div>
      </div>

      <div class="field">
        <label for="wx-daynight">Time of day</label>
        <select id="wx-daynight" data-field="isDaytime">
          <option value="true"${weather.isDaytime ? " selected" : ""}>Daytime</option>
          <option value="false"${!weather.isDaytime ? " selected" : ""}>Night</option>
        </select>
        <div class="field__hint">Affects atmospheric stability, and so how fast the cloud spreads.</div>
      </div>

      <div class="field">
        <label for="wx-roughness">Ground roughness</label>
        <select id="wx-roughness" data-field="groundRoughnessPreset">
          <option value="openCountry"${weather.groundRoughnessPreset === "openCountry" ? " selected" : ""}>Open country (0.03 m)</option>
          <option value="urbanOrForest"${weather.groundRoughnessPreset === "urbanOrForest" ? " selected" : ""}>Urban or forest (1.0 m)</option>
          <option value="openWater"${weather.groundRoughnessPreset === "openWater" ? " selected" : ""}>Open water (varies with wind)</option>
          <option value="custom"${weather.groundRoughnessPreset === "custom" ? " selected" : ""}>Custom value</option>
        </select>
      </div>

      <div class="field" data-visible-when="custom-roughness"
           style="${weather.groundRoughnessPreset === "custom" ? "" : "display:none"}">
        <label for="wx-roughness-custom">Roughness length z₀</label>
        <div class="input-pair">
          <input type="number" id="wx-roughness-custom" step="0.01" min="0.0001"
                 value="${weather.customRoughness}" data-field="customRoughness" />
          <span class="input-suffix">m</span>
        </div>
      </div>

      <div class="field">
        <label for="wx-inversion">Low-level inversion</label>
        <select id="wx-inversion" data-field="inversionPresent">
          <option value="false"${!weather.inversionPresent ? " selected" : ""}>None</option>
          <option value="true"${weather.inversionPresent ? " selected" : ""}>Present</option>
        </select>
        <div class="field__hint">A stable layer aloft traps the cloud near the ground.</div>
      </div>

      <div class="field" data-visible-when="inversion-height"
           style="${weather.inversionPresent ? "" : "display:none"}">
        <label for="wx-inversion-height">Inversion height</label>
        <div class="input-pair">
          <input type="number" id="wx-inversion-height" step="10" min="10"
                 value="${weather.inversionHeight}" data-field="inversionHeight" />
          <span class="input-suffix">m</span>
        </div>
      </div>
    </div>
  `;
}

function stabilityPanelHtml() {
  return `
    <div class="panel panel--derived">
      <h3>Derived conditions</h3>
      <div id="wx-derived"></div>

      <div class="field" style="margin-top: var(--space-4);">
        <label for="wx-stability-override">Override stability class</label>
        <select id="wx-stability-override" data-field="stabilityOverride">
          <option value="">Determine automatically</option>
          ${STABILITY_CLASSES.map(
            (c) => `<option value="${c}">Class ${c}</option>`
          ).join("")}
        </select>
        <div class="field__hint">
          Only set this if you have a better basis than the conditions above —
          an on-site observation, or a value from another model.
        </div>
      </div>
    </div>
  `;
}

/** Redraws only the derived readouts and warnings, leaving form inputs untouched. */
function refreshDerived() {
  const container = document.getElementById("wx-derived");
  const warningsEl = document.getElementById("wx-warnings");
  if (!container) return;

  const weather = currentWeather();

  let derived;
  try {
    derived = deriveEngineInputs(weather);
  } catch (error) {
    container.innerHTML = `<p class="text-danger">${error.message}</p>`;
    return;
  }

  const stabilityNotes = {
    override: "set manually",
    solar: "from wind, cloud and sun elevation",
    cloudCover: "from wind, cloud and time of day",
  };
  const stabilityNote = ` (${stabilityNotes[derived.stabilitySource] ?? "derived"})`;

  // Only shown when the solar route was used, so the user can see the figure
  // the stability class was actually based on.
  const solarRow =
    derived.solarElevationDegrees !== null
      ? `<div><dt>Sun elevation</dt><dd>${derived.solarElevationDegrees.toFixed(1)}°</dd></div>`
      : "";

  container.innerHTML = `
    <dl class="readout">
      <div><dt>Stability class</dt><dd>${derived.stabilityClass}${stabilityNote}</dd></div>
      ${solarRow}
      <div><dt>Wind speed</dt><dd>${derived.windSpeed10m.toFixed(2)} m/s</dd></div>
      <div><dt>Wind from</dt><dd>${derived.windFromDegrees.toFixed(0)}° (${degreesToCompassPoint(derived.windFromDegrees)})</dd></div>
      <div><dt>Cloud travels toward</dt><dd>${derived.downwindDegrees.toFixed(0)}° (${degreesToCompassPoint(derived.downwindDegrees)})</dd></div>
      <div><dt>Temperature</dt><dd>${derived.temperature.toFixed(2)} K</dd></div>
      <div><dt>Surface roughness</dt><dd>${derived.roughnessLength.toFixed(3)} m</dd></div>
      <div><dt>Inversion</dt><dd>${derived.inversionHeight ? `${derived.inversionHeight} m` : "none"}</dd></div>
    </dl>
    ${
      derived.stabilitySource === "cloudCover"
        ? `<p class="field__hint" style="margin-top: var(--space-3);">
             Stability is being estimated from cloud cover and a day/night flag.
             Setting coordinates and a time in the Location step lets HAZEL use
             the sun's actual elevation instead, which is more accurate.
           </p>`
        : ""
    }
    ${
      derived.stabilitySource === "solar"
        ? `<p class="field__hint" style="margin-top: var(--space-3);">
             Ignored — the Location step's time (sun elevation
             ${derived.solarElevationDegrees.toFixed(1)}°) determines this
             automatically, currently ${derived.isDaytime ? "daytime" : "night"}.
             To force a specific time of day, set it in the Location step's
             "Time of release" field instead.
           </p>`
        : ""
    }
  `;

  if (warningsEl) {
    warningsEl.innerHTML = derived.problems
      .map(
        (problem) => `
        <div class="banner banner--warning">
          <span>${problem}</span>
        </div>`
      )
      .join("");
  }
}

/** Shows the age of cached weather, and offers a refresh when it is stale. */
async function renderCacheBanner() {
  const slot = document.getElementById("wx-cache-banner");
  if (!slot) return;

  const location = state.current.scenario.location;
  if (!location) {
    slot.innerHTML = `
      <div class="banner banner--info">
        <span>Set the incident location first to fetch weather for it. You can
        still enter conditions manually below.</span>
      </div>`;
    return;
  }

  const cached = await getCachedWeather(location.lat, location.lng);
  if (!cached) {
    slot.innerHTML = "";
    return;
  }

  const stale = isStale(cached.ageMinutes);
  slot.innerHTML = `
    <div class="banner banner--${stale ? "warning" : "info"}">
      <span>
        Stored weather for this location, fetched ${describeAge(cached.ageMinutes)}.
        ${stale ? "It may no longer reflect current conditions." : ""}
      </span>
      <span class="banner__actions">
        <button type="button" class="btn btn--secondary btn--small" data-action="use-cached">Use stored</button>
        ${refreshButtonHtml()}
      </span>
    </div>`;
}

/**
 * The refresh control, aware of the courtesy throttle window.
 *
 * Outside the window: a single "Refresh" button that fetches immediately.
 * Inside it: a disabled-feeling notice plus a "Check anyway" button, so the
 * choice to proceed stays with the person using the tool rather than being
 * silently blocked — see the rationale in config.js's
 * weatherMinRefreshIntervalMinutes.
 */
function refreshButtonHtml() {
  if (!isWithinThrottleWindow()) {
    return `<button type="button" class="btn btn--primary btn--small" data-action="refresh-weather">Refresh</button>`;
  }

  const minutes = Math.ceil(minutesSinceLastFetch());
  return `
    <span class="throttle-notice">
      Checked ${minutes} min ago — MET Norway asks that this stay infrequent.
    </span>
    <button type="button" class="btn btn--secondary btn--small" data-action="refresh-weather-anyway">
      Check anyway
    </button>`;
}

/* ========================================================================
   EVENT WIRING
   ======================================================================== */

function applyFetchedWeather(weather) {
  updateWeather({
    mode: "fetched",
    windSpeed: Number(weather.windSpeed.toFixed(1)),
    windSpeedUnit: "m/s",
    windMeasurementHeight: weather.windMeasurementHeight,
    windFromDirection: String(Math.round(weather.windFromDirection)),
    temperature: Number(weather.temperature.toFixed(1)),
    temperatureUnit: "C",
    cloudCoverOktas: weather.cloudCoverOktas,
    relativeHumidity: Math.round(weather.relativeHumidity),
    isDaytime: isDaytimeNow(weather.observedAt),
    // Fetched conditions are not a preset, so any highlight left over from
    // an earlier preset click no longer applies.
    activePreset: null,
  });
  // Redraw so the inputs show the fetched values.
  render(document.querySelector(".wizard-step-content"));
}

/**
 * Rough day/night determination from the observation timestamp.
 *
 * Deliberately crude: proper solar elevation needs latitude and a solar
 * position algorithm, which belongs with the Location step where coordinates
 * are known. Until then this errs toward "night" at the margins, which yields
 * a more stable class and a larger threat zone — the conservative direction.
 */
function isDaytimeNow(isoTimestamp) {
  const hour = new Date(isoTimestamp ?? Date.now()).getHours();
  return hour >= 7 && hour < 19;
}

function wireEvents(container) {
  // Mode selection
  container.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      // Switching mode is itself a manual action, not a preset — clear any
      // preset highlight left over from before (fetched weather also clears
      // it again in applyFetchedWeather() once the fetch actually completes).
      updateWeather({ mode: button.dataset.mode, activePreset: null });
      render(container);
    });
  });

  // Presets
  container.querySelectorAll("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.preset;
      const preset = PRESETS[key];
      updateWeather({ ...preset.values, stabilityOverride: "", activePreset: key });
      render(container);
    });
  });

  // Every field carries data-field naming the property it edits, so one
  // handler covers the whole form rather than one per input.
  container.querySelectorAll("[data-field]").forEach((input) => {
    const eventName = input.type === "range" ? "input" : "change";

    input.addEventListener(eventName, () => {
      const field = input.dataset.field;
      let value = input.value;

      // Selects return strings; these two fields are genuinely boolean.
      if (field === "isDaytime" || field === "inversionPresent") {
        value = value === "true";
      }

      // Any hand edit — including re-picking the same value a preset had
      // set — means the form no longer represents that preset exactly, so
      // its highlight is cleared. This is a blunt rule (it does not check
      // whether the new value happens to still match), which matches what
      // was asked for: editing a field should visibly drop the highlight,
      // not silently keep it because of a coincidental match.
      updateWeather({ [field]: value, activePreset: null });

      // Fields that reveal or hide another field
      if (field === "groundRoughnessPreset") {
        const customField = container.querySelector('[data-visible-when="custom-roughness"]');
        if (customField) customField.style.display = value === "custom" ? "" : "none";
      }
      if (field === "inversionPresent") {
        const heightField = container.querySelector('[data-visible-when="inversion-height"]');
        if (heightField) heightField.style.display = value ? "" : "none";
      }
      if (field === "cloudCoverOktas") {
        const readout = container.querySelector("#wx-cloud-readout");
        if (readout) readout.textContent = `${value}/8`;
      }

      // A hand edit no longer needs a full re-render (the preset buttons are
      // the only thing that would change), but the preset row's aria-pressed
      // highlight lives in markup produced at render time — clear it directly
      // here instead of re-rendering the whole form and risking focus loss
      // mid-edit.
      container.querySelectorAll("[data-preset]").forEach((btn) => btn.setAttribute("aria-pressed", "false"));
    });
  });

  // Fetch and cache actions
  wireOnce(container, "weather-click", "click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    const location = state.current.scenario.location;
    if (!location) return;

    if (action === "refresh-weather" || action === "refresh-weather-anyway") {
      const button = event.target.closest("[data-action]");
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "Fetching…";
      try {
        const weather = await fetchWeather(location.lat, location.lng);
        applyFetchedWeather(weather);
      } catch (error) {
        const slot = document.getElementById("wx-warnings");
        if (slot) {
          slot.innerHTML = `<div class="banner banner--warning"><span>${error.message}</span></div>`;
        }
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }

    if (action === "use-cached") {
      const cached = await getCachedWeather(location.lat, location.lng);
      if (cached) applyFetchedWeather(cached.weather);
    }
  });
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

/**
 * Draws the step into the container it is given.
 * Follows the contract every wizard step implements — see wizard.js.
 *
 * NOTE (2026-09-23): this was previously an inline method on the exported
 * weatherStep object (`render(container) { ... }`), which meant its own
 * name, `render`, was never a usable identifier anywhere else in this
 * module — only `weatherStep.render` was. wireEvents()'s mode/preset click
 * handlers and applyFetchedWeather() all called a bare `render(container)`
 * to redraw the form after changing state, which threw a silent
 * ReferenceError every time: clicking "Windy day", say, updated the
 * scenario (the Derived conditions readout below refreshed correctly,
 * since that happens separately inside updateWeather()) but the wind
 * speed/temperature/etc. FORM FIELDS never visibly changed, since the
 * redraw that would show the preset's new values never completed. Hoisting
 * this out to an ordinary function declaration makes `render` a real,
 * callable name throughout the module, fixing that silent failure — and is
 * also what makes the preset-highlight fix elsewhere in this file actually
 * visible, since the highlight lives in markup this function produces.
 */
function render(container) {
    const weather = currentWeather();

    // Persist the defaults on first visit so later steps can rely on the
    // scenario object being populated.
    if (!state.current.scenario.weather) {
      state.update({
        scenario: { ...state.current.scenario, weather: { ...DEFAULT_WEATHER } },
      });
    }

    const attribution = isWeatherFetchAvailable()
      ? `<p class="attribution">
           <a href="${config.weatherAttribution.url}" target="_blank" rel="noopener">
             ${config.weatherAttribution.text}
           </a>, licensed
           <a href="${config.weatherAttribution.licenceUrl}" target="_blank" rel="noopener">CC BY 4.0</a>.
         </p>`
      : "";

    container.innerHTML = `
      <div class="panel">
        <h2>Atmospheric conditions</h2>
        <p>
          Wind and atmospheric stability govern how far and how fast the cloud
          travels. These are the inputs the dispersion calculation is most
          sensitive to.
        </p>

        ${modeSelectorHtml(weather)}
        <div id="wx-cache-banner"></div>
        <div id="wx-warnings"></div>
        ${formHtml(weather)}
        ${attribution}
      </div>

      ${stabilityPanelHtml()}
    `;

    // Restore the override selection, which the markup above cannot express
    // inline without duplicating the option list.
    const overrideSelect = container.querySelector("#wx-stability-override");
    if (overrideSelect) overrideSelect.value = weather.stabilityOverride ?? "";

    wireEvents(container);
    refreshDerived();

    if (weather.mode === "fetched") {
      renderCacheBanner();
    }
}

/**
 * Whether the step holds enough valid data for the wizard to advance.
 * The wizard calls this to decide whether "Next" is enabled.
 */
function isComplete() {
  const weather = state.current.scenario.weather;
  if (!weather) return false;
  try {
    return deriveEngineInputs(weather).problems.length === 0;
  } catch {
    return false;
  }
}

export const weatherStep = {
  id: "weather",
  label: "Weather",
  render,
  isComplete,
};
