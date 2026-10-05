/**
 * stepLocation.js
 * ---------------
 * The Location step: where the release happens, and when.
 *
 * "When" sits here rather than in its own step because the two are only useful
 * together. Solar elevation — which drives atmospheric stability during the
 * day — needs latitude, longitude and the moment all three at once. Splitting
 * them would mean neither step could show the user anything meaningful on its own.
 *
 * As everywhere else in HAZEL, the offline path is the primary one: typing
 * coordinates needs no network. Address search, elevation and terrain lookup
 * are enrichments that are simply absent when no relay is configured.
 */

import { state } from "./state.js";
import { wireOnce } from "./domUtils.js";
import { config } from "../../config.js";
import {
  parseCoordinatePair,
  parseCoordinateComponent,
  validateCoordinates,
  formatDecimal,
  formatDms,
} from "../engine/coordinates.js";
import {
  isGeocodingAvailable,
  isElevationAvailable,
  isTerrainLookupAvailable,
  searchPlaces,
  lookupElevation,
  suggestRoughness,
} from "../services/locationService.js";
import { solarElevation, describeSolarElevation } from "../engine/solarPosition.js";

/** Values the step opens with the first time it is visited. */
function defaultLocation() {
  const now = new Date();
  return {
    lat: null,
    lng: null,
    address: "",
    elevation: null,
    roughnessSuggestion: null,
    // Local date and time, in the formats the date and time inputs expect.
    date: toDateInputValue(now),
    time: toTimeInputValue(now),
    useCurrentTime: true,
  };
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10);
}

function toTimeInputValue(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function currentLocation() {
  return state.current.scenario.location ?? defaultLocation();
}

function updateLocation(changes) {
  const location = { ...currentLocation(), ...changes };
  state.update({ scenario: { ...state.current.scenario, location } });
  refreshDerived();
}

/**
 * Combines the date and time fields into a Date.
 * Interpreted in the browser's local timezone, which is what a user entering
 * "14:30" means — the time on the clock where the incident is.
 */
export function incidentMoment(location) {
  if (location.useCurrentTime) return new Date();
  const [hours, minutes] = (location.time || "00:00").split(":").map(Number);
  const date = new Date(location.date);
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function coordinateEntryHtml(location) {
  const hasCoordinates = location.lat !== null && location.lng !== null;

  return `
    <div class="field">
      <label for="loc-coords">Coordinates</label>
      <div class="input-pair">
        <input type="text" id="loc-coords"
               value="${hasCoordinates ? formatDecimal(location.lat, location.lng) : ""}"
               placeholder="51.4416, 5.4697"
               data-action="parse-coords" />
        <button type="button" class="btn btn--secondary btn--small" data-action="use-my-location">
          Use my position
        </button>
      </div>
      <div class="field__hint">
        Decimal degrees, or degrees-minutes-seconds such as 51°26'30"N 5°28'11"E.
        Positive is north and east.
      </div>
      <div id="loc-coord-error"></div>
    </div>

    <div class="field-grid">
      <div class="field">
        <label for="loc-lat">Latitude</label>
        <input type="text" id="loc-lat" data-field="lat"
               value="${hasCoordinates ? location.lat.toFixed(5) : ""}" placeholder="51.44160" />
      </div>
      <div class="field">
        <label for="loc-lng">Longitude</label>
        <input type="text" id="loc-lng" data-field="lng"
               value="${hasCoordinates ? location.lng.toFixed(5) : ""}" placeholder="5.46970" />
      </div>
    </div>
  `;
}

function addressSearchHtml() {
  if (!isGeocodingAvailable()) {
    return `
      <div class="banner banner--info">
        <span>
          Address search is not configured for this installation, so coordinates
          have to be entered directly. That path needs no network and works offline.
        </span>
      </div>`;
  }

  return `
    <div class="field">
      <label for="loc-search">Search for a place</label>
      <div class="input-pair">
        <input type="text" id="loc-search" placeholder="Motorway junction, town, address…" />
        <button type="button" class="btn btn--secondary btn--small" data-action="search">Search</button>
      </div>
      <div id="loc-search-results"></div>
    </div>
  `;
}

function timeHtml(location) {
  return `
    <div class="field-grid">
      <div class="field">
        <label for="loc-when">Time of release</label>
        <select id="loc-when" data-field="useCurrentTime">
          <option value="true"${location.useCurrentTime ? " selected" : ""}>Now</option>
          <option value="false"${!location.useCurrentTime ? " selected" : ""}>A specific date and time</option>
        </select>
        <div class="field__hint">
          Determines the sun's position, and with it how quickly the atmosphere mixes.
        </div>
      </div>

      <div class="field" data-visible-when="specific-time"
           style="${location.useCurrentTime ? "display:none" : ""}">
        <label for="loc-date">Date</label>
        <input type="date" id="loc-date" data-field="date" value="${location.date}" />
      </div>

      <div class="field" data-visible-when="specific-time"
           style="${location.useCurrentTime ? "display:none" : ""}">
        <label for="loc-time">Time (local)</label>
        <input type="time" id="loc-time" data-field="time" value="${location.time}" />
      </div>
    </div>
  `;
}

/** Redraws the derived readout without touching the input fields. */
function refreshDerived() {
  const container = document.getElementById("loc-derived");
  if (!container) return;

  const location = currentLocation();

  if (location.lat === null || location.lng === null) {
    container.innerHTML = `
      <p>Enter coordinates to see the sun's position and the conditions it implies.</p>`;
    return;
  }

  const moment = incidentMoment(location);
  const elevation = solarElevation(moment, location.lat, location.lng);
  const daylight = elevation > 0;

  const elevationRow =
    location.elevation !== null
      ? `<div><dt>Ground elevation</dt><dd>${location.elevation.toFixed(0)} m</dd></div>`
      : "";

  container.innerHTML = `
    <dl class="readout">
      <div><dt>Decimal degrees</dt><dd>${formatDecimal(location.lat, location.lng)}</dd></div>
      <div><dt>Deg/min/sec</dt><dd>${formatDms(location.lat, location.lng)}</dd></div>
      <div><dt>Incident time</dt><dd>${moment.toLocaleString()}</dd></div>
      <div><dt>Sun elevation</dt><dd>${elevation.toFixed(1)}° — ${describeSolarElevation(elevation)}</dd></div>
      <div><dt>Daylight</dt><dd>${daylight ? "yes" : "no"}</dd></div>
      ${elevationRow}
    </dl>
    <p class="field__hint" style="margin-top: var(--space-3);">
      ${
        daylight
          ? "The Weather step will use this sun elevation together with cloud cover to determine atmospheric stability."
          : "The sun is below the horizon, so the Weather step will use the night-time stability classification."
      }
    </p>
  `;
}

/* ========================================================================
   ACTIONS
   ======================================================================== */

/** Applies a coordinate pair and kicks off the optional lookups for it. */
async function applyCoordinates(lat, lng, container) {
  updateLocation({ lat, lng });

  // Redraw so both the combined field and the separate lat/lng fields agree.
  // (Referencing the exported step object, not a bare "render" — this used
  // to call an identifier that did not exist anywhere in this module, which
  // threw silently on every coordinate update and skipped everything after
  // it, including the elevation and terrain lookups below.)
  locationStep.render(container);

  if (isElevationAvailable()) {
    try {
      const elevation = await lookupElevation(lat, lng);
      updateLocation({ elevation });
      refreshDerived(); // elevation arrives after the render() above already ran
    } catch {
      // Elevation is informational; a failure is not worth an interruption.
    }
  }

  if (isTerrainLookupAvailable()) {
    const suggestion = await suggestRoughness(lat, lng);
    if (suggestion) {
      updateLocation({ roughnessSuggestion: suggestion });
      showRoughnessSuggestion(suggestion);
    }
  }
}

/**
 * Offers the terrain-derived roughness as something to accept, rather than
 * applying it. The user may know the site; the map only knows its tags.
 */
function showRoughnessSuggestion(suggestion) {
  const slot = document.getElementById("loc-suggestion");
  if (!slot) return;

  const labels = {
    openCountry: "Open country",
    urbanOrForest: "Urban or forest",
    openWater: "Open water",
  };

  slot.innerHTML = `
    <div class="banner banner--info">
      <span>
        The map shows ${suggestion.reason} here, which suggests a ground
        roughness of "${labels[suggestion.preset]}" in the Weather step.
      </span>
      <span class="banner__actions">
        <button type="button" class="btn btn--secondary btn--small" data-action="apply-roughness">
          Apply
        </button>
      </span>
    </div>`;
}

function showCoordinateError(message) {
  const slot = document.getElementById("loc-coord-error");
  if (slot) {
    slot.innerHTML = message
      ? `<div class="banner banner--warning" style="margin-top: var(--space-2);"><span>${message}</span></div>`
      : "";
  }
}

function wireEvents(container) {
  // Combined coordinate field: parse on change, report clearly on failure.
  container.querySelector('[data-action="parse-coords"]')?.addEventListener("change", (event) => {
    const value = event.target.value.trim();
    if (value === "") return;
    try {
      const { lat, lng } = parseCoordinatePair(value);
      showCoordinateError(null);
      applyCoordinates(lat, lng, container);
    } catch (error) {
      showCoordinateError(error.message);
    }
  });

  // Separate latitude and longitude fields, for editing one at a time.
  container.querySelectorAll('[data-field="lat"], [data-field="lng"]').forEach((input) => {
    input.addEventListener("change", () => {
      const latInput = container.querySelector('[data-field="lat"]');
      const lngInput = container.querySelector('[data-field="lng"]');
      if (!latInput.value.trim() || !lngInput.value.trim()) return;

      try {
        const lat = parseCoordinateComponent(latInput.value);
        const lng = parseCoordinateComponent(lngInput.value);
        validateCoordinates(lat, lng);
        showCoordinateError(null);
        applyCoordinates(lat, lng, container);
      } catch (error) {
        showCoordinateError(error.message);
      }
    });
  });

  // Date and time fields
  container.querySelectorAll('[data-field="date"], [data-field="time"], [data-field="useCurrentTime"]')
    .forEach((input) => {
      input.addEventListener("change", () => {
        const field = input.dataset.field;
        let value = input.value;
        if (field === "useCurrentTime") {
          value = value === "true";
          container.querySelectorAll('[data-visible-when="specific-time"]').forEach((el) => {
            el.style.display = value ? "none" : "";
          });
        }
        updateLocation({ [field]: value });
      });
    });

  wireOnce(container, "location-click", "click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;

    if (action === "use-my-location") {
      const button = event.target.closest("[data-action]");
      if (!navigator.geolocation) {
        showCoordinateError("This device offers no position information.");
        return;
      }
      button.disabled = true;
      button.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          await applyCoordinates(position.coords.latitude, position.coords.longitude, container);

          // Confirm success rather than leaving the button on "Locating…"
          // forever — with nothing said afterward, a working request looked
          // identical to a stuck one. The button re-enables after a couple
          // of seconds rather than staying disabled, since the person may
          // move and want to set their position again.
          const freshButton = container.querySelector('[data-action="use-my-location"]');
          if (freshButton) {
            freshButton.textContent = "Located ✓";
            setTimeout(() => {
              freshButton.disabled = false;
              freshButton.textContent = "Use my position";
            }, 2000);
          }
        },
        (error) => {
          showCoordinateError(
            `Could not read your position (${error.message}). Enter coordinates manually.`
          );
          button.disabled = false;
          button.textContent = "Use my position";
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }

    if (action === "search") {
      const input = container.querySelector("#loc-search");
      const results = container.querySelector("#loc-search-results");
      if (!input || !results) return;

      results.innerHTML = `<p class="field__hint">Searching…</p>`;
      try {
        const places = await searchPlaces(input.value);
        results.innerHTML = places.length
          ? places
              .map(
                (place) => `
                <button type="button" class="choice-card" style="margin-top: var(--space-2);"
                        data-action="pick-place"
                        data-lat="${place.lat}" data-lng="${place.lng}">
                  <span class="choice-card__title">${place.label}</span>
                  <span class="choice-card__desc">${formatDecimal(place.lat, place.lng)}</span>
                </button>`
              )
              .join("")
          : `<p class="field__hint">Nothing found for that search.</p>`;
      } catch (error) {
        results.innerHTML = `<div class="banner banner--warning"><span>${error.message}</span></div>`;
      }
    }

    if (action === "pick-place") {
      const button = event.target.closest("[data-action]");
      const lat = Number(button.dataset.lat);
      const lng = Number(button.dataset.lng);
      updateLocation({ address: button.querySelector(".choice-card__title").textContent.trim() });
      applyCoordinates(lat, lng, container);
    }

    if (action === "apply-roughness") {
      const suggestion = currentLocation().roughnessSuggestion;
      if (!suggestion) return;
      const weather = state.current.scenario.weather ?? {};
      state.update({
        scenario: {
          ...state.current.scenario,
          weather: { ...weather, groundRoughnessPreset: suggestion.preset },
        },
      });
      const slot = document.getElementById("loc-suggestion");
      if (slot) {
        slot.innerHTML = `<div class="banner banner--info"><span>Ground roughness set in the Weather step.</span></div>`;
      }
    }
  });
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

export const locationStep = {
  id: "location",
  label: "Location",

  render(container) {
    if (!state.current.scenario.location) {
      state.update({
        scenario: { ...state.current.scenario, location: defaultLocation() },
      });
    }

    const location = currentLocation();

    const attribution =
      isGeocodingAvailable() || isTerrainLookupAvailable()
        ? `<p class="attribution">
             <a href="${config.osmAttribution.url}" target="_blank" rel="noopener">
               ${config.osmAttribution.text}
             </a>
           </p>`
        : "";

    container.innerHTML = `
      <div class="panel">
        <h2>Incident location and time</h2>
        <p>
          Where the release happens, and when. The time matters as much as the
          place: the sun's height above the horizon drives how quickly the
          atmosphere mixes, and so how far the cloud travels.
        </p>

        ${addressSearchHtml()}
        ${coordinateEntryHtml(location)}
        <div id="loc-suggestion"></div>
        ${timeHtml(location)}
        ${attribution}
      </div>

      <div class="panel panel--derived">
        <h3>Derived from location and time</h3>
        <div id="loc-derived"></div>
      </div>
    `;

    wireEvents(container);
    refreshDerived();

    if (location.roughnessSuggestion) {
      showRoughnessSuggestion(location.roughnessSuggestion);
    }
  },

  isComplete() {
    const location = state.current.scenario.location;
    return Boolean(location && location.lat !== null && location.lng !== null);
  },
};
