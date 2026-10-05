/**
 * units.js
 * --------
 * Unit conversions for user-facing input.
 *
 * The engine works entirely in SI: metres, seconds, kelvin, kilograms. Users
 * do not. European responders work in m/s and Celsius; the ALOHA scenarios
 * someone may want to reproduce are in mph and Fahrenheit; marine and aviation
 * sources report knots. Conversion happens once, here, at the boundary between
 * the interface and the model — never inside the physics.
 */

/* ---------- Wind speed ---------- */

export const WIND_SPEED_UNITS = {
  "m/s": { label: "m/s", toMetresPerSecond: 1 },
  "km/h": { label: "km/h", toMetresPerSecond: 1 / 3.6 },
  mph: { label: "mph", toMetresPerSecond: 0.44704 },
  knots: { label: "knots", toMetresPerSecond: 0.514444 },
};

export function windSpeedToMetresPerSecond(value, unit) {
  const entry = WIND_SPEED_UNITS[unit];
  if (!entry) throw new Error(`Unknown wind speed unit: ${unit}`);
  return value * entry.toMetresPerSecond;
}

export function windSpeedFromMetresPerSecond(metresPerSecond, unit) {
  const entry = WIND_SPEED_UNITS[unit];
  if (!entry) throw new Error(`Unknown wind speed unit: ${unit}`);
  return metresPerSecond / entry.toMetresPerSecond;
}

/* ---------- Temperature ---------- */

export const TEMPERATURE_UNITS = { C: "°C", F: "°F" };

/** The engine needs kelvin: the ideal gas law has no meaning on a relative scale. */
export function temperatureToKelvin(value, unit) {
  if (unit === "C") return value + 273.15;
  if (unit === "F") return (value - 32) * (5 / 9) + 273.15;
  throw new Error(`Unknown temperature unit: ${unit}`);
}

export function temperatureFromKelvin(kelvin, unit) {
  if (unit === "C") return kelvin - 273.15;
  if (unit === "F") return (kelvin - 273.15) * (9 / 5) + 32;
  throw new Error(`Unknown temperature unit: ${unit}`);
}

/* ---------- Wind direction ---------- */

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/**
 * Converts a compass point such as "SW" to degrees.
 *
 * Wind direction throughout HAZEL follows the meteorological convention: the
 * direction the wind blows FROM. A south-westerly wind is 225 degrees and
 * carries the cloud toward the north-east. Getting this backwards would put
 * the threat zone on the wrong side of the incident, so the convention is
 * stated wherever direction is handled.
 *
 * @param {string} point - e.g. "N", "SW", "ESE" (case insensitive)
 * @returns {number} degrees, 0-359
 */
export function compassPointToDegrees(point) {
  const index = COMPASS_POINTS.indexOf(point.toUpperCase().trim());
  if (index === -1) throw new Error(`Unknown compass point: ${point}`);
  return index * 22.5;
}

/** Converts degrees to the nearest compass point, for display. */
export function degreesToCompassPoint(degrees) {
  const normalised = ((degrees % 360) + 360) % 360;
  const index = Math.round(normalised / 22.5) % 16;
  return COMPASS_POINTS[index];
}

/**
 * Accepts either a numeric bearing or a compass point, since responders use
 * both ("wind from the south-west" and "wind from 225").
 *
 * @param {string|number} input
 * @returns {number} degrees, 0-359
 */
export function parseWindDirection(input) {
  if (typeof input === "number") return ((input % 360) + 360) % 360;

  const trimmed = String(input).trim();
  if (trimmed === "") throw new Error("Wind direction is required");

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return ((asNumber % 360) + 360) % 360;

  return compassPointToDegrees(trimmed);
}

/**
 * The direction the cloud travels, which is the reverse of the direction the
 * wind comes from. Used when drawing the threat zone on a map.
 */
export function downwindDirection(windFromDegrees) {
  return (windFromDegrees + 180) % 360;
}
