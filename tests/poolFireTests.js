/**
 * poolFireTests.js
 * ----------------
 * Verification for the pool fire thermal radiation model. Run with:
 *   node tests/poolFireTests.js
 *
 * As with bleveTests.js and vceTests.js, no ALOHA worked example for a
 * pool fire was available to reproduce. These tests check formula
 * transcription by hand calculation and physical direction. A propane
 * pool's mass burn rate, flame height and emissive power were also
 * checked against published literature ranges during development (see the
 * comments below each check).
 */

import {
  massBurnRatePerArea, poolFlameHeight, poolFlameTilt,
  poolFireEmissivePower, poolFireRadiationAt, findPoolFireRadiationDistance,
} from "../js/engine/enginePoolFire.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

// Propane-like reference values used throughout.
const HC = 46000000, HV = 425000, CP = 2400, TB = 231;

console.log("\n=== 1. Mass burn rate (Mudan 1984, ALOHA temperature correction) ===");
check("matches the formula by hand for a pool at its own boiling point (T=Tb)",
  closeTo(massBurnRatePerArea(HC, HV, CP, TB, TB), 0.001 * HC / HV, 1e-9),
  "at T=Tb the temperature correction term vanishes");
check("a warmer pool (closer to boiling) burns faster (correction term shrinks)",
  massBurnRatePerArea(HC, HV, CP, TB, 280) > massBurnRatePerArea(HC, HV, CP, TB, 250));
check("mass burn rate is positive for a reasonable pool", massBurnRatePerArea(HC, HV, CP, TB, 288) > 0);

console.log("\n=== 2. Flame height (Thomas 1963, modified) ===");
const mdot = massBurnRatePerArea(HC, HV, CP, TB, 288);
// 0.16 kg/m2/s, 26 m for a 10 m pool — checked against typical hydrocarbon
// pool fire figures (mass burn rate ~0.1-0.2 kg/m2/s, flame height ~2-3x
// diameter for this fuel class) before writing these bounds.
check("flame height is positive and a plausible multiple of pool diameter",
  poolFlameHeight(5, 1.2, mdot, 10) > 5 && poolFlameHeight(5, 1.2, mdot, 10) < 100);
check("a bigger pool has a taller flame", poolFlameHeight(5, 1.2, mdot, 20) > poolFlameHeight(5, 1.2, mdot, 10));
check("a faster burn rate gives a taller flame", poolFlameHeight(5, 1.2, mdot * 2, 10) > poolFlameHeight(5, 1.2, mdot, 10));

console.log("\n=== 3. Flame tilt (American Gas Association 1973) ===");
check("a calm wind (u* <= 1) gives no tilt", poolFlameTilt(0.01, 1.2, mdot, 10) === 0);
check("a strong wind gives a positive tilt angle", poolFlameTilt(20, 1.2, mdot, 10) > 0);
check("tilt angle never exceeds 90 degrees (pi/2)", poolFlameTilt(1000, 1.2, mdot, 10) <= Math.PI / 2);
check("stronger wind tilts the flame further",
  poolFlameTilt(15, 1.2, mdot, 10) > poolFlameTilt(5, 1.2, mdot, 10));

console.log("\n=== 4. Emissive power (Moorhouse and Pritchard 1982) ===");
const h = poolFlameHeight(5, 1.2, mdot, 10);
// ~190 kW/m2 — checked against the standard 100-200 kW/m2 range reported
// for hydrocarbon pool fires before writing this bound.
check("emissive power is positive and in a plausible range for a hydrocarbon pool fire (50-300 kW/m2)",
  poolFireEmissivePower(HC, mdot, h, 10) > 50000 && poolFireEmissivePower(HC, mdot, h, 10) < 300000);
check("a taller flame relative to diameter reduces emissive power (the 1+4h/d denominator)",
  poolFireEmissivePower(HC, mdot, h * 2, 10) < poolFireEmissivePower(HC, mdot, h, 10));

console.log("\n=== 5. Combined radiation flux and physical direction ===");
const scenario = {
  poolDiameter: 10, heatOfCombustion: HC, heatOfVaporization: HV,
  specificHeatCapacity: CP, boilingPoint: TB, poolTemperature: 288,
  windSpeed: 5, ambientAirDensity: 1.2, relativeHumidity: 60, ambientTemperature: 293.15,
};
const near = poolFireRadiationAt({ ...scenario, receptorPoint: [15, 0, 0] });
const far = poolFireRadiationAt({ ...scenario, receptorPoint: [60, 0, 0] });
check("flux falls with distance", near.flux > far.flux);
check("flux is positive at a reasonable distance", far.flux > 0);

const biggerPool = poolFireRadiationAt({ ...scenario, poolDiameter: 30, receptorPoint: [60, 0, 0] });
check("a bigger pool radiates more strongly at the same distance", biggerPool.flux > far.flux);

console.log("\n=== 6. Threat distance search ===");
const thermal2 = findPoolFireRadiationDistance({ ...scenario, thresholdWm2: 5000 });
check("a 10 m pool fire exceeds the second-degree-burn threshold nearby",
  thermal2.thresholdExceeded === true);
check("the reported distance exceeds the pool's own radius",
  thermal2.maxDistance > scenario.poolDiameter / 2);

const thermal3 = findPoolFireRadiationDistance({ ...scenario, thresholdWm2: 10000 });
const thermal1 = findPoolFireRadiationDistance({ ...scenario, thresholdWm2: 2000 });
check("severity ordering holds (10 kW/m2 nearer than 5 nearer than 2)",
  thermal3.maxDistance < thermal2.maxDistance && thermal2.maxDistance < thermal1.maxDistance,
  `${thermal3.maxDistance.toFixed(1)} / ${thermal2.maxDistance.toFixed(1)} / ${thermal1.maxDistance.toFixed(1)}`);

const biggerPoolThreat = findPoolFireRadiationDistance({ ...scenario, poolDiameter: 30, thresholdWm2: 5000 });
check("a bigger pool reaches at least as far for the same threshold",
  biggerPoolThreat.maxDistance >= thermal2.maxDistance);

const unreachable = findPoolFireRadiationDistance({ ...scenario, thresholdWm2: 1e9 });
check("an unreachable threshold reports no exceedance",
  unreachable.thresholdExceeded === false && unreachable.maxDistance === 0);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
