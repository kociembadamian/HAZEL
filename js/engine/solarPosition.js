/**
 * solarPosition.js
 * ----------------
 * Computes the sun's elevation above the horizon for a given time and place.
 *
 * Why this matters for a dispersion tool: atmospheric stability during the day
 * is driven by how strongly the ground is being heated, and that depends on
 * how high the sun is. A low winter sun produces weak heating and a
 * near-neutral atmosphere; a high summer sun produces strong convection and
 * rapid mixing. Using a plain "daytime / night" switch instead can easily put
 * the stability class two categories off, which changes the threat distance
 * substantially.
 *
 * ALOHA derives insolation from solar altitude in the same way (Tech Doc
 * section 4.2.2). This module supplies the altitude; engineStability.js turns
 * it into an insolation category.
 *
 * Algorithm: the NOAA Solar Calculator equations, which are accurate to about
 * a hundredth of a degree for years between 1800 and 2100 — far better than
 * the stability classification needs, and cheap enough to run on every input
 * change. Everything is computed locally; no network, no location service.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * Julian day number, the continuous day count astronomers use so that date
 * arithmetic does not have to care about month lengths or leap years.
 */
function julianDay(date) {
  // 2440587.5 is the Julian day at the Unix epoch (1970-01-01T00:00:00Z)
  return date.getTime() / 86400000 + 2440587.5;
}

/** Julian centuries since J2000.0, the time variable the NOAA series use. */
function julianCentury(date) {
  return (julianDay(date) - 2451545) / 36525;
}

/**
 * Solar elevation (altitude) above the horizon.
 *
 * @param {Date} date - the moment, in any timezone; UTC is taken from it
 * @param {number} latitude - degrees, positive north
 * @param {number} longitude - degrees, positive east
 * @returns {number} elevation in degrees; negative means the sun is below the horizon
 */
export function solarElevation(date, latitude, longitude) {
  const t = julianCentury(date);

  // Geometric mean longitude of the sun, degrees
  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;

  // Geometric mean anomaly, degrees
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);

  // Eccentricity of Earth's orbit
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // Equation of centre: the correction from a circular to an elliptical orbit
  const centre =
    Math.sin(meanAnomaly * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * DEG) * 0.000289;

  const trueLongitude = meanLongitude + centre;

  // Apparent longitude, correcting for nutation and aberration
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Obliquity of the ecliptic — the tilt of Earth's axis
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * DEG);

  // Solar declination: how far north or south of the equator the sun stands
  const declination =
    Math.asin(Math.sin(obliquity * DEG) * Math.sin(apparentLongitude * DEG)) * RAD;

  // Equation of time, in minutes: the difference between clock time and true
  // solar time, caused by the orbit's ellipticity and the axial tilt
  const y = Math.tan((obliquity / 2) * DEG) ** 2;
  const equationOfTime =
    4 *
    RAD *
    (y * Math.sin(2 * meanLongitude * DEG) -
      2 * eccentricity * Math.sin(meanAnomaly * DEG) +
      4 * eccentricity * y * Math.sin(meanAnomaly * DEG) * Math.cos(2 * meanLongitude * DEG) -
      0.5 * y * y * Math.sin(4 * meanLongitude * DEG) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * DEG));

  // True solar time at this longitude, in minutes from local midnight
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (utcMinutes + equationOfTime + 4 * longitude + 1440) % 1440;

  // Hour angle: 0 at solar noon, negative in the morning, positive after
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  // Solar zenith angle, then elevation as its complement
  const cosZenith =
    Math.sin(latitude * DEG) * Math.sin(declination * DEG) +
    Math.cos(latitude * DEG) * Math.cos(declination * DEG) * Math.cos(hourAngle * DEG);

  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) * RAD;

  return 90 - zenith;
}

/**
 * Whether the sun is above the horizon at this time and place.
 *
 * The threshold is 0 degrees — geometric sunrise. Twilight is treated as
 * night for stability purposes, which is the conservative choice: after sunset
 * the ground cools and the atmosphere stabilises, dispersing the cloud less.
 */
export function isDaylight(date, latitude, longitude) {
  return solarElevation(date, latitude, longitude) > 0;
}

/**
 * Describes the sun's position in words, for the interface.
 * Saves the user having to interpret a bare angle.
 */
export function describeSolarElevation(elevationDegrees) {
  if (elevationDegrees <= 0) return "below the horizon";
  if (elevationDegrees < 15) return "low on the horizon";
  if (elevationDegrees < 35) return "low";
  if (elevationDegrees < 60) return "moderately high";
  return "high";
}
