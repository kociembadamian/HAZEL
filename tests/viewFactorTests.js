/**
 * viewFactorTests.js
 * ------------------
 * Verification for the shared Sparrow-Cess tile-integration engine used by
 * pool fire and jet fire. Run with:  node tests/viewFactorTests.js
 *
 * See engineViewFactor.js's module docstring for why a flat disk, not a
 * closed shape like a sphere, is the validation case: for a closed surface
 * the unclipped kernel this module implements integrates to exactly zero by
 * construction (the same mathematics as Gauss's law), regardless of
 * whether the code is correct — that was discovered the hard way while
 * building this test file, and is recorded here so it is not rediscovered
 * by accident later.
 */

import { computeViewFactor, tileTiltedCylinder, tileTiltedFrustum } from "../js/engine/engineViewFactor.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Tiles a flat disk in the z=0 plane, normal +z — test-only, since no
 * production flame shape in this project is a flat disk. Exists purely to
 * exercise computeViewFactor() against the textbook exact result for a
 * coaxial disk-to-point view factor, F = R^2/(R^2+H^2) (Incropera,
 * Fundamentals of Heat and Mass Transfer).
 */
function tileDisk(radius, radialDivisions, angularDivisions) {
  const tiles = [];
  for (let i = 0; i < radialDivisions; i++) {
    const r0 = (i / radialDivisions) * radius;
    const r1 = ((i + 1) / radialDivisions) * radius;
    const rMid = (r0 + r1) / 2;
    const area = (Math.PI * (r1 * r1 - r0 * r0)) / angularDivisions;
    for (let j = 0; j < angularDivisions; j++) {
      const phi = (j + 0.5) * ((2 * Math.PI) / angularDivisions);
      tiles.push({
        position: [rMid * Math.cos(phi), rMid * Math.sin(phi), 0],
        normal: [0, 0, 1],
        area,
      });
    }
  }
  return tiles;
}

console.log("\n=== 1. Disk-to-point exact formula (Incropera): F = R^2/(R^2+H^2) ===");
for (const [R, H] of [[50, 120], [30, 30], [100, 500], [10, 5]]) {
  const tiles = tileDisk(R, 30, 60);
  const result = computeViewFactor(tiles, [0, 0, H]);
  const exact = (R * R) / (R * R + H * H);
  const errorPct = (100 * Math.abs(result.viewFactor - exact)) / exact;
  check(`R=${R}, H=${H}: numeric matches exact within 1%`,
    errorPct < 1, `numeric=${result.viewFactor.toFixed(5)}, exact=${exact.toFixed(5)}, error=${errorPct.toFixed(2)}%`);
}

console.log("\n=== 2. Disk view factor increases with radius, decreases with distance ===");
const base = computeViewFactor(tileDisk(50, 30, 60), [0, 0, 200]).viewFactor;
const bigger = computeViewFactor(tileDisk(100, 30, 60), [0, 0, 200]).viewFactor;
const farther = computeViewFactor(tileDisk(50, 30, 60), [0, 0, 400]).viewFactor;
check("a bigger disk has a bigger view factor at the same distance", bigger > base);
check("view factor falls with distance", farther < base);

console.log("\n=== 3. Convergence: finer tiling should not change the answer much ===");
const coarse = computeViewFactor(tileDisk(50, 10, 20), [0, 0, 120]).viewFactor;
const fine = computeViewFactor(tileDisk(50, 60, 120), [0, 0, 120]).viewFactor;
check("coarse and fine tilings agree within 2%",
  (100 * Math.abs(fine - coarse)) / fine < 2, `coarse=${coarse.toFixed(5)}, fine=${fine.toFixed(5)}`);

console.log("\n=== 4. Tilted cylinder: an open surface, not subject to closed-surface cancellation ===");
const verticalCyl = tileTiltedCylinder(20, 30, 0, 40, 25);
const vResult = computeViewFactor(verticalCyl, [100, 0, 5]);
check("a vertical cylinder's view factor is a sane, non-negligible positive number",
  vResult.viewFactor > 1e-4 && vResult.viewFactor < 1,
  `got ${vResult.viewFactor}`);

console.log("\n=== 5. Cylinder geometry sanity ===");
check("a bigger-diameter cylinder has a bigger view factor at the same distance",
  computeViewFactor(tileTiltedCylinder(40, 30, 0, 40, 25), [100, 0, 5]).viewFactor > vResult.viewFactor);
check("a taller cylinder has a bigger view factor at the same distance",
  computeViewFactor(tileTiltedCylinder(20, 60, 0, 40, 25), [100, 0, 5]).viewFactor > vResult.viewFactor);
check("view factor falls with distance",
  computeViewFactor(tileTiltedCylinder(20, 30, 0, 40, 25), [500, 0, 5]).viewFactor < vResult.viewFactor);

console.log("\n=== 6. Cylinder total tile area matches the exact lateral surface area ===");
const diameter = 20, height = 30;
const tiles = tileTiltedCylinder(diameter, height, 0.3, 40, 25);
const totalArea = tiles.reduce((sum, t) => sum + t.area, 0);
const exactLateralArea = Math.PI * diameter * height;
check("tiled area matches pi*d*h regardless of tilt",
  closeTo(totalArea, exactLateralArea, exactLateralArea * 0.001),
  `tiled=${totalArea.toFixed(2)}, exact=${exactLateralArea.toFixed(2)}`);

console.log("\n=== 6. Tilted frustum: area conservation and cylinder limit ===");
const frustumTiles = tileTiltedFrustum(10, 4, 20, 3, 0.3, 40, 25);
const frustumArea = frustumTiles.reduce((sum, t) => sum + t.area, 0);
const slantLength = Math.sqrt(20 * 20 + (2 - 5) * (2 - 5)); // r0=5, r1=2 from diameters 10, 4
const analyticalFrustumArea = Math.PI * (5 + 2) * slantLength;
check("tiled frustum area matches the analytical formula pi*(r0+r1)*slant_length",
  closeTo(frustumArea, analyticalFrustumArea, analyticalFrustumArea * 0.001),
  `tiled=${frustumArea.toFixed(2)}, exact=${analyticalFrustumArea.toFixed(2)}`);

const equalRadiusFrustum = tileTiltedFrustum(10, 10, 20, 3, 0.3, 40, 25);
const equalRadiusArea = equalRadiusFrustum.reduce((sum, t) => sum + t.area, 0);
const matchingCylinder = tileTiltedCylinder(10, 20, 0.3, 40, 25);
const cylinderAreaForComparison = matchingCylinder.reduce((sum, t) => sum + t.area, 0);
check("a frustum with equal base and tip diameter reduces exactly to a cylinder",
  closeTo(equalRadiusArea, cylinderAreaForComparison, 0.01),
  `frustum=${equalRadiusArea.toFixed(2)}, cylinder=${cylinderAreaForComparison.toFixed(2)}`);

console.log("\n=== 7. Frustum view factor sanity ===");
const frustumViewFactor = computeViewFactor(frustumTiles, [100, 0, 5]).viewFactor;
check("frustum view factor is a sane, non-negligible positive number",
  frustumViewFactor > 1e-5 && frustumViewFactor < 1, `got ${frustumViewFactor}`);
check("a bigger frustum has a bigger view factor at the same distance",
  computeViewFactor(tileTiltedFrustum(20, 8, 20, 3, 0.3, 40, 25), [100, 0, 5]).viewFactor > frustumViewFactor);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
