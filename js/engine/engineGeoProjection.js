/**
 * engineGeoProjection.js
 * ----------------------
 * Converts between the plume's own local coordinate frame — metres, with the
 * downwind direction along +x, exactly what findThreatZone() in
 * engineGaussian.js returns — and real latitude/longitude, so the footprint
 * can be drawn on a map and a point clicked on that map can be checked
 * against the plume.
 *
 * The projection is a flat-Earth (equirectangular) approximation: fine at the
 * scale threat zones operate on, which the Gaussian model itself limits to
 * tens of kilometres at most (see MAX_RELEASE_DURATION and the general
 * applicability range in engineLimitations.js). At that scale Earth's
 * curvature introduces an error far smaller than the model's own uncertainty,
 * so a more elaborate projection would add complexity without adding
 * trustworthy precision.
 *
 * Convention: bearings are compass degrees, clockwise from north (0 = N,
 * 90 = E). "Downwind degrees" — the direction the wind is blowing TOWARD,
 * i.e. the output of downwindDirection() in units.js — is what orients the
 * plume's +x axis on the map.
 */

/** Mean Earth radius, metres — the same value used in coordinates.js. */
const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Rotates a point from the plume's local frame (x downwind, y crosswind) into
 * local east/north metre offsets.
 *
 * The rotation is a standard 2D rotation by the downwind bearing. Because the
 * plume footprint is symmetric about y = 0 (see buildFootprint() in
 * engineGaussian.js), the choice of rotation handedness here is cosmetic —
 * it decides which compass side "positive y" ends up on, not whether the
 * drawn shape is correct — so one consistent convention is picked and used
 * throughout this file.
 *
 * @param {number} x - downwind distance, m
 * @param {number} y - crosswind offset, m
 * @param {number} downwindBearingDegrees - compass bearing the plume travels toward
 * @returns {{ east: number, north: number }} metres
 */
function plumeFrameToEastNorth(x, y, downwindBearingDegrees) {
  const b = toRad(downwindBearingDegrees);
  return {
    east: x * Math.sin(b) - y * Math.cos(b),
    north: x * Math.cos(b) + y * Math.sin(b),
  };
}

/** The inverse of plumeFrameToEastNorth — see that function for the convention. */
function eastNorthToPlumeFrame(east, north, downwindBearingDegrees) {
  const b = toRad(downwindBearingDegrees);
  return {
    x: east * Math.sin(b) + north * Math.cos(b),
    y: -east * Math.cos(b) + north * Math.sin(b),
  };
}

/**
 * Converts a local east/north metre offset from an origin into latitude and
 * longitude.
 *
 * @param {number} originLat - degrees
 * @param {number} originLng - degrees
 * @param {number} eastMetres
 * @param {number} northMetres
 * @returns {{ lat: number, lng: number }}
 */
export function metresToLatLng(originLat, originLng, eastMetres, northMetres) {
  const deltaLat = toDeg(northMetres / EARTH_RADIUS_M);
  const deltaLng = toDeg(
    eastMetres / (EARTH_RADIUS_M * Math.cos(toRad(originLat)))
  );
  return { lat: originLat + deltaLat, lng: originLng + deltaLng };
}

/** The inverse of metresToLatLng: lat/lng offset from an origin, in metres east/north. */
export function latLngToMetres(originLat, originLng, lat, lng) {
  const north = toRad(lat - originLat) * EARTH_RADIUS_M;
  const east = toRad(lng - originLng) * EARTH_RADIUS_M * Math.cos(toRad(originLat));
  return { east, north };
}

/**
 * Projects a threat-zone footprint (as returned by findThreatZone() in
 * engineGaussian.js) onto the map as a list of {lat, lng} points, oriented so
 * the plume's downwind axis points along the given bearing from the source.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {Array<{x: number, y: number}>} footprint - metres, from findThreatZone()
 * @param {number} downwindBearingDegrees
 * @returns {Array<{lat: number, lng: number}>}
 */
export function projectFootprint(originLat, originLng, footprint, downwindBearingDegrees) {
  return footprint.map(({ x, y }) => {
    const { east, north } = plumeFrameToEastNorth(x, y, downwindBearingDegrees);
    return metresToLatLng(originLat, originLng, east, north);
  });
}

/**
 * The inverse of projectFootprint for a single point: given a location
 * clicked on the map, returns its position in the plume's own frame (x
 * downwind, y crosswind from the source). This is what powers "threat at a
 * point" — the clicked point's x, y can be fed straight into
 * peakConcentration() from engineGaussian.js.
 *
 * @returns {{ x: number, y: number }} metres in the plume frame
 */
export function pointToPlumeFrame(originLat, originLng, lat, lng, downwindBearingDegrees) {
  const { east, north } = latLngToMetres(originLat, originLng, lat, lng);
  return eastNorthToPlumeFrame(east, north, downwindBearingDegrees);
}
