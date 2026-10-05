/**
 * bleveTests.js
 * -------------
 * Verification for the BLEVE fireball thermal radiation model. Run with:
 *   node tests/bleveTests.js
 *
 * No ALOHA worked example for a BLEVE fireball was available to reproduce
 * in this project's document set (the propane tank car example used
 * elsewhere models a two-phase toxic/flammable release, not an ignited
 * BLEVE). These tests instead verify: the published constants and formulas
 * are transcribed correctly (checked against a hand calculation for each
 * one), and the physical DIRECTION of every relationship is correct
 * (a bigger fireball radiates further; radiation falls with distance;
 * humid air blocks more radiation than dry air).
 */

import {
  fireballDiameter, fireballDuration, fireballEmissivePower,
  fireballViewFactor, waterVapourPressure, atmosphericTransmissivity,
  fireballRadiationAt, findFireballRadiationDistance, THERMAL_RADIATION_LEVELS,
} from "../js/engine/engineBleve.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Fireball diameter (Roberts 1982) ===");
check("diameter for 1000 kg matches Roberts' formula by hand",
  closeTo(fireballDiameter(1000), 5.8 * 10, 1e-9), `got ${fireballDiameter(1000)}`);
check("diameter grows with mass", fireballDiameter(20000) > fireballDiameter(1000));
check("diameter scales as the cube root of mass",
  closeTo(fireballDiameter(8000) / fireballDiameter(1000), 2, 1e-9),
  "doubling the linear scale needs 8x the mass");
check("the 5000-tonne cap is enforced",
  fireballDiameter(1e10) === fireballDiameter(5000000));

console.log("\n=== 2. Fireball duration (Duiser 1992) — informational only ===");
check("duration for 1000 kg matches the formula by hand",
  closeTo(fireballDuration(1000), 0.852 * Math.pow(1000, 0.26), 1e-9));
check("a bigger fireball burns longer", fireballDuration(20000) > fireballDuration(1000));

console.log("\n=== 3. Emissive power ===");
const propaneHc = 46000000;
check("propane's own heat of combustion returns the 350 kW/m^2 reference",
  closeTo(fireballEmissivePower(propaneHc), 350000, 1e-6));
check("a more energetic fuel radiates more intensely",
  fireballEmissivePower(propaneHc * 2) > fireballEmissivePower(propaneHc));
check("emissive power scales linearly with heat of combustion",
  closeTo(fireballEmissivePower(propaneHc * 1.5) / fireballEmissivePower(propaneHc), 1.5, 1e-9));

console.log("\n=== 4. View factor ===");
const diameter100 = 100;
check("view factor is undefined inside the fireball's own radius",
  fireballViewFactor(40, diameter100) === null);
check("view factor is defined just outside the radius",
  fireballViewFactor(51, diameter100) !== null);
check("view factor falls with distance",
  fireballViewFactor(200, diameter100) > fireballViewFactor(1000, diameter100));
check("view factor never exceeds 1 (a physical upper bound)",
  fireballViewFactor(51, diameter100) <= 1);
check("a bigger fireball has a bigger view factor at the same distance",
  fireballViewFactor(500, 200) > fireballViewFactor(500, 100));
const r = diameter100 / 2;
const xSpecial = r * Math.sqrt(3);
check("view factor matches a hand-solved special case (x = r*sqrt(3))",
  closeTo(fireballViewFactor(xSpecial, diameter100), Math.sqrt(3) / 8, 1e-9),
  `got ${fireballViewFactor(xSpecial, diameter100)}, expected ${Math.sqrt(3) / 8}`);

console.log("\n=== 5. Water vapour pressure and transmissivity ===");
const pWaterDry = waterVapourPressure(20, 293.15);
const pWaterHumid = waterVapourPressure(90, 293.15);
check("higher relative humidity gives higher water vapour pressure",
  pWaterHumid > pWaterDry);
check("water vapour pressure scales linearly with relative humidity",
  closeTo(pWaterHumid / pWaterDry, 90 / 20, 1e-9));

const tauNear = atmosphericTransmissivity(pWaterDry, 100);
const tauFar = atmosphericTransmissivity(pWaterDry, 2000);
check("transmissivity falls with distance", tauFar < tauNear);
const tauHumid = atmosphericTransmissivity(pWaterHumid, 500);
const tauDry = atmosphericTransmissivity(pWaterDry, 500);
check("humid air transmits less radiation than dry air at the same distance",
  tauHumid < tauDry);
check("transmissivity is clamped to at most 1",
  atmosphericTransmissivity(0.001, 0.001) <= 1);
check("transmissivity is clamped to at least 0",
  atmosphericTransmissivity(1e6, 1e6) >= 0);

console.log("\n=== 6. Combined radiation flux ===");
const scenario = {
  fireballMassKg: 20000,
  heatOfCombustion: propaneHc,
  relativeHumidity: 60,
  ambientTemperature: 293.15,
};
const fluxNear = fireballRadiationAt({ ...scenario, groundDistance: 100 });
const fluxFar = fireballRadiationAt({ ...scenario, groundDistance: 500 });
check("flux falls with distance", fluxNear > fluxFar);
check("flux is positive at a reasonable distance", fluxFar > 0);
check("flux is null inside the fireball's radius",
  fireballRadiationAt({ ...scenario, groundDistance: 1 }) === null);

const biggerScenario = { ...scenario, fireballMassKg: 100000 };
check("a bigger fireball radiates more strongly at the same distance",
  fireballRadiationAt({ ...biggerScenario, groundDistance: 500 }) >
  fireballRadiationAt({ ...scenario, groundDistance: 500 }));

console.log("\n=== 7. Threat distance search ===");
const thermal2 = findFireballRadiationDistance({ ...scenario, thresholdWm2: 5000 });
check("a substantial fireball exceeds the second-degree-burn threshold",
  thermal2.thresholdExceeded === true);
check("the reported distance is beyond the fireball's own radius",
  thermal2.maxDistance > thermal2.fireballDiameter / 2);

const thermal3 = findFireballRadiationDistance({ ...scenario, thresholdWm2: 10000 });
const thermal1 = findFireballRadiationDistance({ ...scenario, thresholdWm2: 2000 });
check("the fatality threshold (10 kW/m2) reaches less far than the pain threshold (2 kW/m2)",
  thermal3.maxDistance < thermal1.maxDistance,
  `10kW: ${thermal3.maxDistance.toFixed(0)} m, 2kW: ${thermal1.maxDistance.toFixed(0)} m`);
check("severity ordering holds across all three standard levels",
  thermal3.maxDistance < thermal2.maxDistance && thermal2.maxDistance < thermal1.maxDistance);

const biggerThermal2 = findFireballRadiationDistance({ ...biggerScenario, thresholdWm2: 5000 });
check("a bigger fireball reaches at least as far for the same threshold",
  biggerThermal2.maxDistance >= thermal2.maxDistance);

const unreachable = findFireballRadiationDistance({ ...scenario, thresholdWm2: 1e9 });
check("an unreachable threshold reports no exceedance",
  unreachable.thresholdExceeded === false && unreachable.maxDistance === 0);

console.log("\n=== 8. Standard Levels of Concern ===");
check("three thermal radiation levels are defined", THERMAL_RADIATION_LEVELS.length === 3);
check("thresholds match the Tech Doc's published values (10/5/2 kW/m2)",
  THERMAL_RADIATION_LEVELS.map((l) => l.wPerM2).join(",") === "10000,5000,2000");
check("severity runs most severe first", THERMAL_RADIATION_LEVELS[0].id === "thermal3");

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
