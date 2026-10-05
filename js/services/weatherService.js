/**
 * weatherService.js
 * -----------------
 * Fetches current weather through the configured relay and normalises it into
 * the shape the dispersion engine needs.
 *
 * This module is an OPTIONAL enrichment. Every function here can fail — no
 * relay configured, no network, relay unreachable — and the Weather step
 * handles all of those by falling back to manual entry. Nothing downstream of
 * this file assumes weather was fetched rather than typed.
 *
 * Data source: MET Norway Locationforecast 2.0, licensed CC BY 4.0 / NLOD 2.0.
 * Attribution is required wherever the data appears; see config.js.
 */

import { config } from "../../config.js";
import { saveWeather, loadWeather } from "./weatherStorage.js";

/** True when this deployment has a relay configured and can fetch at all. */
export function isWeatherFetchAvailable() {
  return Boolean(config.weatherRelayUrl);
}

/**
 * Converts the MET Norway Locationforecast compact payload into HAZEL's own
 * weather shape.
 *
 * Normalising here rather than downstream means swapping in a different
 * weather source later only touches this function, and the dispersion engine
 * never learns which service the numbers came from.
 *
 * MET Norway units, for reference:
 *   air_temperature        degrees Celsius
 *   wind_speed             m/s
 *   wind_from_direction    degrees, meteorological convention (where it blows FROM)
 *   relative_humidity      percent
 *   cloud_area_fraction    percent
 *
 * @param {object} payload - raw Locationforecast JSON
 * @returns {object} normalised weather
 */
export function normaliseMetNoResponse(payload) {
  const firstEntry = payload?.properties?.timeseries?.[0];
  if (!firstEntry) {
    throw new Error("Weather response contained no forecast data");
  }

  const instant = firstEntry.data?.instant?.details;
  if (!instant) {
    throw new Error("Weather response was missing instantaneous readings");
  }

  return {
    // MET Norway reports wind at 10 m, which is also the reference height the
    // dispersion model expects — no profile correction needed on this path.
    windSpeed: instant.wind_speed,
    windSpeedUnit: "m/s",
    windMeasurementHeight: 10,
    windFromDirection: instant.wind_from_direction,

    temperature: instant.air_temperature,
    temperatureUnit: "C",

    relativeHumidity: instant.relative_humidity,

    // Cloud cover arrives as a percentage; the stability lookup works in
    // oktas (eighths), the convention used in meteorological observation.
    cloudCoverOktas: Math.round((instant.cloud_area_fraction / 100) * 8),

    observedAt: firstEntry.time,
    origin: "met.no",
  };
}

/**
 * Fetches current weather for a location through the relay.
 *
 * On success the result is written to the on-device cache before being
 * returned, so a later offline session still has it.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<object>} normalised weather
 * @throws {Error} when no relay is configured or the request fails
 */
export async function fetchWeather(latitude, longitude) {
  if (!isWeatherFetchAvailable()) {
    throw new Error(
      "No weather relay is configured for this installation. Enter weather manually, " +
        "or see config.js to set one up."
    );
  }

  const url = new URL(config.weatherRelayUrl);
  url.searchParams.set("lat", latitude.toFixed(4));
  url.searchParams.set("lon", longitude.toFixed(4));

  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (networkError) {
    // Distinguish "you are offline" from "the relay said no", because the two
    // call for different actions from the user.
    throw new Error(
      "Could not reach the weather service. Check your connection, or enter weather manually."
    );
  }

  if (!response.ok) {
    throw new Error(
      `The weather service returned an error (${response.status}). Enter weather manually.`
    );
  }

  const payload = await response.json();
  const weather = normaliseMetNoResponse(payload);

  recordFetchTime();

  // Cache failures must not lose data the user already has in hand.
  try {
    await saveWeather(latitude, longitude, weather);
  } catch (storageError) {
    console.warn("Could not cache weather on this device:", storageError);
  }

  return weather;
}

/**
 * Returns cached weather for a location together with its age, or null.
 * A thin pass-through kept here so the Weather step has a single import for
 * everything weather-related.
 */
export async function getCachedWeather(latitude, longitude) {
  try {
    return await loadWeather(latitude, longitude);
  } catch (error) {
    console.warn("Could not read the weather cache:", error);
    return null;
  }
}

/** True when a cached reading is older than the configured freshness window. */
export function isStale(ageMinutes) {
  return ageMinutes > config.weatherFreshnessMinutes;
}

/* ========================================================================
   THROTTLING
   ======================================================================== */

const LAST_FETCH_KEY = "hazel:lastWeatherFetchAt";

/**
 * Minutes since the last live fetch, across page reloads (stored in
 * localStorage, which is appropriate here: this is a UI courtesy timer, not
 * sensitive data, and does not need IndexedDB's async API for one number).
 *
 * @returns {number|null} minutes, or null if no fetch has been recorded
 */
export function minutesSinceLastFetch() {
  const stored = localStorage.getItem(LAST_FETCH_KEY);
  if (!stored) return null;
  return (Date.now() - Number(stored)) / 60000;
}

/** Records that a fetch just happened, for the throttle check above. */
function recordFetchTime() {
  localStorage.setItem(LAST_FETCH_KEY, String(Date.now()));
}

/**
 * Whether a fetch right now would be within the courtesy window configured
 * in config.js. The caller decides what to do with this — see stepWeather.js
 * for the "check" / "check anyway" pattern this exists to support.
 */
export function isWithinThrottleWindow() {
  const minutes = minutesSinceLastFetch();
  return minutes !== null && minutes < config.weatherMinRefreshIntervalMinutes;
}
