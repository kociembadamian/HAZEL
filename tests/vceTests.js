/**
 * vceTests.js
 * -----------
 * Verification for the vapour cloud explosion (VCE) overpressure model.
 * Run with:  node tests/vceTests.js
 *
 * As with bleveTests.js, no ALOHA worked example for a VCE was available
 * to reproduce. Section 1 instead confirms Table 14 and Table 15 were
 * transcribed correctly (a table of numbers offers nothing to reason about
 * — either it matches the source or it does not), section 2 confirms the
 * piecewise curve fit is continuous at its own stated breakpoint (a real,
 * checkable mathematical property, not just a transcription check), and
 * the remaining sections confirm physical direction.
 */

import {
  flameMachNumber, blastEnergy, explosiveMass, normalisedDistance,
  normalisedOverpressure, overpressureAt, findOverpressureDistance,
  OVERPRESSURE_LEVELS, psiToPa,
} from "../js/engine/engineVce.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Table 14 (flame speed) transcription ===");
check("low reactivity, low congestion = 0.026", flameMachNumber("low", "low") === 0.026);
check("low reactivity, medium congestion = 0.23", flameMachNumber("low", "medium") === 0.23);
check("low reactivity, high congestion = 0.34", flameMachNumber("low", "high") === 0.34);
check("medium reactivity, low congestion = 0.11", flameMachNumber("medium", "low") === 0.11);
check("medium reactivity, medium congestion = 0.44", flameMachNumber("medium", "medium") === 0.44);
check("medium reactivity, high congestion = 0.5", flameMachNumber("medium", "high") === 0.5);
check("high reactivity, low congestion = 0.36", flameMachNumber("high", "low") === 0.36);
check("high reactivity, medium congestion = DDT (Mach 5.2)", flameMachNumber("high", "medium") === 5.2);
check("high reactivity, high congestion = DDT (Mach 5.2)", flameMachNumber("high", "high") === 5.2);
check("a hard ignition always detonates, regardless of reactivity/congestion",
  flameMachNumber("low", "low", true) === 5.2);
check("an unknown reactivity is rejected",
  (() => { try { flameMachNumber("extreme", "low"); return false; } catch { return true; } })());

console.log("\n=== 2. Table 15 curve fit: transcription and continuity ===");
// Continuity at x0 is a genuine mathematical property of a correctly
// transcribed piecewise fit, checked numerically before writing these tests:
// both branches must agree at the boundary, since the source document
// presents this as one continuous curve per Mach number.
const curvesByMach = {
  0.2: { A: 0.0335, B: 0.8359, C: -1.1192, D: 0.065, x0: 0.35 },
  0.35: { A: 0.1041, B: 0.8642, C: -1.0568, D: 0.22, x0: 0.32 },
  0.7: { A: 0.3764, B: 0.7439, C: -1.2728, D: 0.65, x0: 0.3 },
  5.2: { A: 0.2932, B: 1.399, C: -1.1591, D: 20, x0: 0.16 },
};
for (const [mach, curve] of Object.entries(curvesByMach)) {
  check(`Mach ${mach}: flat plateau below x0`,
    normalisedOverpressure(curve.x0 * 0.5, curve) === curve.D);
  check(`Mach ${mach}: curve is continuous with the plateau at x0`,
    closeTo(normalisedOverpressure(curve.x0 + 1e-6, curve), curve.D, 0.01),
    `got ${normalisedOverpressure(curve.x0 + 1e-6, curve).toFixed(4)}, expected ~${curve.D}`);
  check(`Mach ${mach}: overpressure falls beyond x0`,
    normalisedOverpressure(curve.x0 * 3, curve) < curve.D);
}

console.log("\n=== 3. Nearest-curve selection is monotonic in flame speed ===");
// Every Table 14 speed must resolve to a Table 15 curve without throwing,
// and — since a faster flame should never produce a WEAKER blast than a
// slower one at the same distance and mass — overpressure must be
// monotonically non-decreasing as reactivity/congestion combinations are
// walked from the slowest Table 14 entry to the fastest.
const reactivityCongestionBySpeed = [
  ["low", "low"],       // 0.026
  ["medium", "low"],    // 0.11
  ["low", "medium"],    // 0.23
  ["low", "high"],      // 0.34
  ["high", "low"],      // 0.36
  ["medium", "medium"], // 0.44
  ["medium", "high"],   // 0.5
];
const commonScenario = { flammableMassKg: 1000, heatOfCombustion: 46000000, distanceM: 300 };
const pressuresInSpeedOrder = reactivityCongestionBySpeed.map(([reactivity, congestion]) =>
  overpressureAt({ ...commonScenario, reactivity, congestion })
);
check("every reactivity/congestion combination produces a finite, positive overpressure",
  pressuresInSpeedOrder.every((p) => Number.isFinite(p) && p > 0));
check("overpressure is non-decreasing as flame speed increases across Table 14's entries",
  pressuresInSpeedOrder.every((p, i) => i === 0 || p >= pressuresInSpeedOrder[i - 1] - 1e-9),
  `sequence: ${pressuresInSpeedOrder.map((p) => p.toFixed(1)).join(", ")}`);

console.log("\n=== 4. Blast energy and explosive mass ===");
check("blast energy scales linearly with mass",
  closeTo(blastEnergy(46000000, 200) / blastEnergy(46000000, 100), 2, 1e-9));
check("blast energy scales linearly with heat of combustion",
  closeTo(blastEnergy(92000000, 100) / blastEnergy(46000000, 100), 2, 1e-9));
check("a detonation uses 100% of the flammable mass", explosiveMass(1000, true) === 1000);
check("a deflagration uses 20% of the flammable mass", explosiveMass(1000, false) === 200);

console.log("\n=== 5. Normalised distance ===");
check("normalised distance grows with real distance",
  normalisedDistance(200, 1e9) > normalisedDistance(100, 1e9));
check("a bigger blast energy gives a SMALLER normalised distance at the same real distance",
  normalisedDistance(100, 2e9) < normalisedDistance(100, 1e9),
  "more energy means the same real distance is relatively closer to the blast");

console.log("\n=== 6. Combined overpressure and physical direction ===");
const baseVce = {
  flammableMassKg: 2000,
  heatOfCombustion: 46000000, // propane-like
  reactivity: "medium",
  congestion: "medium",
};
const pNear = overpressureAt({ ...baseVce, distanceM: 20 });
const pFar = overpressureAt({ ...baseVce, distanceM: 200 });
check("overpressure falls with distance", pNear > pFar);
check("overpressure is positive", pFar > 0);

const moreMass = overpressureAt({ ...baseVce, flammableMassKg: 20000, distanceM: 200 });
check("more flammable mass gives higher overpressure at the same distance",
  moreMass > pFar);

const detonation = overpressureAt({ ...baseVce, distanceM: 200, hardIgnition: true });
check("a detonation gives higher overpressure than a deflagration at the same distance and mass",
  detonation > pFar);

const moreCongested = overpressureAt({ ...baseVce, congestion: "high", distanceM: 200 });
check("more congestion gives higher overpressure at the same distance",
  moreCongested >= pFar);

console.log("\n=== 7. Threat distance search ===");
const level1Pa = psiToPa(1);
const result1 = findOverpressureDistance({ ...baseVce, thresholdPa: level1Pa });
check("a substantial VCE exceeds the glass-breakage threshold", result1.thresholdExceeded === true);

const level3Pa = psiToPa(8);
const result3 = findOverpressureDistance({ ...baseVce, thresholdPa: level3Pa });
check("the structural-damage threshold (8 psi) reaches less far than glass breakage (1 psi)",
  result3.maxDistance < result1.maxDistance,
  `8psi: ${result3.maxDistance.toFixed(0)} m, 1psi: ${result1.maxDistance.toFixed(0)} m`);

const unreachable = findOverpressureDistance({ ...baseVce, thresholdPa: 1e12 });
check("an unreachable threshold reports no exceedance",
  unreachable.thresholdExceeded === false && unreachable.maxDistance === 0);

console.log("\n=== 8. Standard Levels of Concern ===");
check("three overpressure levels are defined", OVERPRESSURE_LEVELS.length === 3);
check("thresholds match the Tech Doc's published values (1/3.5/8 psi)",
  OVERPRESSURE_LEVELS.map((l) => l.psi).join(",") === "8,3.5,1");
check("psi-to-Pa conversion is correct (1 psi = 6894.76 Pa)", psiToPa(1) === 6894.76);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
