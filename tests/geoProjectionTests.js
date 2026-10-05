/**
 * geoProjectionTests.js
 * ---------------------
 * Verification for the metres-to-lat/lng projection used to draw threat
 * zones on the map. Run with:  node tests/geoProjectionTests.js
 *
 * The two things that matter here: the forward and inverse transforms must
 * be exact inverses of each other (a click on the map must map back to
 * exactly the point that was projected there), and the known-value checks
 * confirm the projection points the right way — a sign error here would draw
 * every threat zone on the wrong side of the source, upwind instead of
 * downwind, which is about as serious a bug as this module could have.
 */

import { metresToLatLng, latLngToMetres, projectFootprint, pointToPlumeFrame } from "../js/engine/engineGeoProjection.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

const EINDHOVEN = { lat: 51.4416, lng: 5.4697 };

console.log("\n=== 1. metresToLatLng / latLngToMetres round trip ===");
for (const [east, north] of [[0, 0], [1000, 0], [0, 1000], [500, -500], [-2000, 3000], [10000, 10000]]) {
  const { lat, lng } = metresToLatLng(EINDHOVEN.lat, EINDHOVEN.lng, east, north);
  const back = latLngToMetres(EINDHOVEN.lat, EINDHOVEN.lng, lat, lng);
  const ok = closeTo(back.east, east, 0.01) && closeTo(back.north, north, 0.01);
  check(`round trip at (${east}, ${north}) m`, ok, `got (${back.east.toFixed(3)}, ${back.north.toFixed(3)})`);
}

console.log("\n=== 2. Known-distance sanity checks ===");
// 1 degree of latitude is almost exactly 111.32 km at any longitude
const oneDegreeNorth = metresToLatLng(EINDHOVEN.lat, EINDHOVEN.lng, 0, 111320);
check("111,320 m north changes latitude by ~1 degree",
  closeTo(oneDegreeNorth.lat - EINDHOVEN.lat, 1, 0.01), `got ${(oneDegreeNorth.lat - EINDHOVEN.lat).toFixed(4)}`);
check("moving north does not change longitude",
  closeTo(oneDegreeNorth.lng, EINDHOVEN.lng, 1e-9));

// Moving east should change longitude more at low latitude than high, since
// meridians converge toward the poles.
const eastAtEindhoven = metresToLatLng(EINDHOVEN.lat, EINDHOVEN.lng, 10000, 0);
const eastAtEquator = metresToLatLng(0, 0, 10000, 0);
const eastAtPole = metresToLatLng(80, 0, 10000, 0);
check("the same eastward distance spans more longitude near the pole than the equator",
  (eastAtPole.lng - 0) > (eastAtEquator.lng - 0),
  `equator ${eastAtEquator.lng.toFixed(5)}, 80N ${eastAtPole.lng.toFixed(5)}`);
check("moving east does not change latitude",
  closeTo(eastAtEindhoven.lat, EINDHOVEN.lat, 1e-9));

console.log("\n=== 3. Footprint projection points the right way ===");
// A simple two-point "footprint": one point straight downwind, one crosswind.
const footprint = [{ x: 1000, y: 0 }, { x: 0, y: 500 }];

// Wind blowing due north (downwind bearing 0): the downwind point should
// land due north of the source, the crosswind point due east or west of it.
const north = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, footprint, 0);
check("wind toward the north puts the downwind point north of the source",
  north[0].lat > EINDHOVEN.lat, `got lat ${north[0].lat}`);
check("wind toward the north keeps the downwind point at the source's longitude",
  closeTo(north[0].lng, EINDHOVEN.lng, 1e-6));
check("wind toward the north puts the crosswind point east or west, not north/south",
  closeTo(north[1].lat, EINDHOVEN.lat, 1e-6) && Math.abs(north[1].lng - EINDHOVEN.lng) > 1e-6);

// Wind blowing due east (downwind bearing 90): the downwind point should
// land due east of the source.
const east = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, footprint, 90);
check("wind toward the east puts the downwind point east of the source",
  east[0].lng > EINDHOVEN.lng, `got lng ${east[0].lng}`);
check("wind toward the east keeps the downwind point at the source's latitude",
  closeTo(east[0].lat, EINDHOVEN.lat, 1e-6));

// Wind blowing due south: downwind point should land south.
const south = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, footprint, 180);
check("wind toward the south puts the downwind point south of the source",
  south[0].lat < EINDHOVEN.lat);

// Wind blowing due west: downwind point should land west.
const west = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, footprint, 270);
check("wind toward the west puts the downwind point west of the source",
  west[0].lng < EINDHOVEN.lng);

console.log("\n=== 4. Footprint symmetry is preserved under projection ===");
// The real footprint from findThreatZone() is symmetric about y=0. Confirm
// that symmetry survives projection at an oblique bearing, which exercises
// both sine and cosine terms at once (0/90/180/270 alone would not).
const symmetricFootprint = [
  { x: 500, y: 200 },
  { x: 500, y: -200 },
];
const projected = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, symmetricFootprint, 37);
const d1 = latLngToMetres(EINDHOVEN.lat, EINDHOVEN.lng, projected[0].lat, projected[0].lng);
const d2 = latLngToMetres(EINDHOVEN.lat, EINDHOVEN.lng, projected[1].lat, projected[1].lng);
// Both points are equidistant from the source, since they differ only in the
// sign of the crosswind offset.
const dist1 = Math.hypot(d1.east, d1.north);
const dist2 = Math.hypot(d2.east, d2.north);
check("symmetric footprint points stay equidistant from the source after projection",
  closeTo(dist1, dist2, 0.01), `${dist1.toFixed(2)} vs ${dist2.toFixed(2)}`);

console.log("\n=== 5. pointToPlumeFrame is the true inverse of projectFootprint ===");
for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
  const original = { x: 750, y: -300 };
  const [proj] = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, [original], bearing);
  const back = pointToPlumeFrame(EINDHOVEN.lat, EINDHOVEN.lng, proj.lat, proj.lng, bearing);
  const ok = closeTo(back.x, original.x, 0.01) && closeTo(back.y, original.y, 0.01);
  check(`bearing ${bearing}°: point round-trips through the plume frame`, ok,
    `got (${back.x.toFixed(3)}, ${back.y.toFixed(3)})`);
}

console.log("\n=== 6. The source itself always projects to the source ===");
for (const bearing of [0, 90, 180, 270]) {
  const [proj] = projectFootprint(EINDHOVEN.lat, EINDHOVEN.lng, [{ x: 0, y: 0 }], bearing);
  check(`bearing ${bearing}°: the origin (0,0) projects to the source coordinates`,
    closeTo(proj.lat, EINDHOVEN.lat, 1e-9) && closeTo(proj.lng, EINDHOVEN.lng, 1e-9));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
