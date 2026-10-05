/**
 * coordinates.js
 * --------------
 * Parsing and formatting of geographic coordinates.
 *
 * Coordinates arrive in whatever form the person has to hand. A dispatcher
 * reads decimal degrees off a screen, a police report quotes degrees and
 * minutes, a handheld GPS shows degrees-minutes-seconds, and someone pasting
 * from a mapping site gets a comma-separated pair. All of those should work,
 * because asking a responder to convert a format by hand is exactly the kind
 * of friction that gets a tool abandoned.
 *
 * Everything is parsed to signed decimal degrees, which is what the rest of
 * HAZEL uses: positive north and positive east, matching the convention in
 * OpenStreetMap, MET Norway and the ALOHA pass file format.
 */

/**
 * Parses one coordinate component: a latitude or a longitude on its own.
 *
 * Accepted forms, all with optional N/S/E/W suffix or prefix:
 *   51.4416          decimal degrees
 *   51.4416 N        decimal degrees with hemisphere
 *   51 26.5 N        degrees and decimal minutes
 *   51 26 30 N       degrees, minutes, seconds
 *   51°26'30"N       the same with symbols
 *   -51.4416         negative for south or west
 *
 * @param {string} input
 * @returns {number} decimal degrees, signed
 */
export function parseCoordinateComponent(input) {
  if (typeof input === "number") return input;

  let text = String(input).trim();
  if (text === "") throw new Error("Coordinate is empty");

  // Pull out the hemisphere letter wherever it sits, then remove it so the
  // numeric parsing below does not have to cope with it.
  let hemisphere = null;
  const hemisphereMatch = text.match(/[NSEWnsew]/);
  if (hemisphereMatch) {
    hemisphere = hemisphereMatch[0].toUpperCase();
    text = text.replace(/[NSEWnsew]/g, " ");
  }

  // Treat the degree, minute and second symbols as separators. After this the
  // string is just numbers separated by whitespace, whichever notation was used.
  const numbers = text
    .replace(/[°º'′"″]/g, " ")
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part !== "")
    .map(Number);

  if (numbers.length === 0 || numbers.some((n) => !Number.isFinite(n))) {
    throw new Error(`Could not read "${input}" as a coordinate`);
  }

  const [degrees = 0, minutes = 0, seconds = 0] = numbers;

  // The sign belongs to the degrees field; minutes and seconds are magnitudes.
  const sign = degrees < 0 ? -1 : 1;
  let decimal = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  decimal *= sign;

  // South and west are negative. A leading minus combined with an S or W
  // suffix would be contradictory, so the hemisphere letter wins.
  if (hemisphere === "S" || hemisphere === "W") decimal = -Math.abs(decimal);
  if (hemisphere === "N" || hemisphere === "E") decimal = Math.abs(decimal);

  return decimal;
}

/**
 * Parses a coordinate pair written as one string.
 *
 * Handles the forms people actually paste:
 *   51.4416, 5.4697
 *   51.4416 5.4697
 *   51°26'30"N 5°28'11"E
 *   N51.4416 E5.4697
 *
 * @param {string} input
 * @returns {{ lat: number, lng: number }}
 */
export function parseCoordinatePair(input) {
  const text = String(input).trim();
  if (text === "") throw new Error("Enter coordinates");

  // Split on a comma when there is one, since that is unambiguous. Otherwise
  // split on the boundary between the two components, which is either a
  // hemisphere letter followed by space, or simply the midpoint whitespace.
  let parts;
  if (text.includes(",")) {
    parts = text.split(",");
  } else {
    // Split after an N or S (end of the latitude), else on whitespace.
    const nsMatch = text.match(/^(.*?[NSns])\s*(.*)$/);
    parts = nsMatch ? [nsMatch[1], nsMatch[2]] : text.split(/\s+(?=[-\d]|[EWew])/);
  }

  if (parts.length < 2) {
    throw new Error(
      "Enter both latitude and longitude, for example: 51.4416, 5.4697"
    );
  }

  const lat = parseCoordinateComponent(parts[0]);
  const lng = parseCoordinateComponent(parts.slice(1).join(" "));

  return validateCoordinates(lat, lng);
}

/**
 * Checks that a coordinate pair is physically possible.
 *
 * Catching this here rather than downstream matters: a longitude of 200
 * degrees would otherwise silently produce a threat zone drawn somewhere that
 * does not exist, and a transposed pair (longitude typed into the latitude
 * field) is a common and easily missed mistake.
 */
export function validateCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`Latitude must be between -90 and 90 (got ${lat})`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`Longitude must be between -180 and 180 (got ${lng})`);
  }
  return { lat, lng };
}

/**
 * Formats a coordinate pair as decimal degrees.
 * Five decimal places is about one metre, which is finer than any input to the
 * dispersion model warrants and more than enough to identify a site.
 */
export function formatDecimal(lat, lng, places = 5) {
  return `${lat.toFixed(places)}, ${lng.toFixed(places)}`;
}

/** Formats a coordinate pair as degrees, minutes and seconds. */
export function formatDms(lat, lng) {
  const component = (value, positive, negative) => {
    const hemisphere = value >= 0 ? positive : negative;
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute);
    const minutesFull = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesFull);
    const seconds = (minutesFull - minutes) * 60;
    return `${degrees}°${String(minutes).padStart(2, "0")}'${seconds.toFixed(1).padStart(4, "0")}"${hemisphere}`;
  };

  return `${component(lat, "N", "S")} ${component(lng, "E", "W")}`;
}

/**
 * Great-circle distance between two points, in metres (haversine).
 *
 * Used to decide whether a cached lookup still applies to a newly entered
 * location, and to show how far a geocoded result sits from what was typed.
 */
export function distanceBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000; // mean Earth radius, metres
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}
