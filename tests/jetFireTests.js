/**
 * jetFireTests.js
 * ---------------
 * Verification for the jet fire thermal radiation model. Run with:
 *   node tests/jetFireTests.js
 *
 * This model has the most moving parts of any single engine in this
 * project (compressible jet mechanics feeding into a multi-stage empirical
 * flame geometry), and no ALOHA worked example exists to check the final
 * combined number against. These tests lean on hand calculations for each
 * individual formula, unit-consistency checks (this is exactly the kind of
 * model where a degrees/radians mismatch hides easily — one was in fact
 * found and fixed during development, see the tilt-angle checks below),
 * and physical direction throughout.
 */

import {
  molecularWeightCorrection, radiatedFraction, unchokedJetMachNumber,
  chokedJetMachNumber, jetTemperature, jetVelocity, effectiveSourceDiameter,
  flameLength, velocityRatio, jetFlameTiltDegrees, stillAirFlameLength,
  flameLiftOff, frustumSlantLength, frustumBaseWidth, frustumTipWidth,
  jetFireGeometry, jetFireRadiationAt, findJetFireRadiationDistance,
} from "../js/engine/engineJetFire.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Molecular weight correction (three bands) ===");
check("MW < 21 g/mol gives C=1", molecularWeightCorrection(0.018) === 1); // water-ish, 18 g/mol
check("MW between 21 and 60 gives sqrt(MW/21)",
  closeTo(molecularWeightCorrection(0.0441), Math.sqrt(44.1 / 21), 1e-9)); // propane
check("MW > 60 gives the fixed 1.69 cap", molecularWeightCorrection(0.15) === 1.69);
check("the correction is continuous at MW=21",
  closeTo(molecularWeightCorrection(0.021), 1, 0.01));

console.log("\n=== 2. Radiated fraction ===");
check("radiated fraction decreases with jet velocity (faster jets radiate a smaller share)",
  radiatedFraction(0.044, 500) < radiatedFraction(0.044, 100));
check("radiated fraction is always positive", radiatedFraction(0.044, 1000) > 0);

console.log("\n=== 3. Jet Mach number, temperature, velocity ===");
const Mj = unchokedJetMachNumber(0.5, 0.02, 1.13, 293, 0.0441);
check("unchoked Mach number is positive and finite", Number.isFinite(Mj) && Mj > 0);
const Tj = jetTemperature(293, 1.13, Mj);
check("jet temperature is below source temperature (expansion cools the gas)", Tj < 293);
check("jet temperature is positive", Tj > 0);
const uj = jetVelocity(Mj, 1.13, Tj, 0.0441);
check("jet velocity is positive", uj > 0);
check("a bigger mass flow rate gives a bigger Mach number (more choked-like)",
  unchokedJetMachNumber(2, 0.02, 1.13, 293, 0.0441) > Mj);

console.log("\n=== 4. Choked flow ===");
const MjChoked = chokedJetMachNumber(2, 0.02, 1.13, 293, 0.0441);
check("choked Mach number is positive and finite", Number.isFinite(MjChoked) && MjChoked > 0);

console.log("\n=== 5. Effective source diameter and flame length ===");
const Ds = effectiveSourceDiameter(0.05, 1.9, 1.2);
check("effective diameter scales with sqrt(density ratio)",
  closeTo(Ds, 0.05 * Math.sqrt(1.9 / 1.2), 1e-9));
const LB = flameLength(Ds);
check("flame length for a vertical jet (thetaJ=90) matches 105.4*Ds exactly",
  closeTo(LB, 105.4 * Ds, 1e-9), "the (thetaJ-90) term vanishes at 90 degrees");
check("a bigger effective diameter gives a longer flame", flameLength(Ds * 2) > LB);

console.log("\n=== 6. Tilt angle: units (the bug this file exists to catch) ===");
// A real regression: an earlier version of this code used
// jetFlameTiltDegrees's result directly as radians elsewhere, giving a tilt
// of "1874 degrees" for a perfectly ordinary scenario. This section pins
// the fix down: the documented return value is DEGREES, and must stay
// within a physically sane 0-90 range for reasonable inputs.
const windSpeed = 5;
const stillAirLen = stillAirFlameLength(LB, windSpeed);
const R = velocityRatio(windSpeed, uj);
const tiltDeg = jetFlameTiltDegrees(R, stillAirLen, Ds, uj);
check("tilt angle is within a physically sane range (0 to 90 degrees) for an ordinary scenario",
  tiltDeg >= 0 && tiltDeg <= 90, `got ${tiltDeg.toFixed(1)} degrees`);
check("a stronger crosswind increases the tilt angle",
  jetFlameTiltDegrees(velocityRatio(15, uj), stillAirLen, Ds, uj) >
  jetFlameTiltDegrees(velocityRatio(2, uj), stillAirLen, Ds, uj));

console.log("\n=== 7. Lift-off and frustum dimensions ===");
const tiltRad = (tiltDeg * Math.PI) / 180;
const liftOff = flameLiftOff(R, LB, tiltRad, false);
check("lift-off distance is positive for a gas release", liftOff > 0,
  `got ${liftOff} — a negative lift-off is the same class of units bug section 6 checks for`);
check("an aerosol release uses the fixed 0.015*LB rule",
  closeTo(flameLiftOff(R, LB, tiltRad, true), 0.015 * LB, 1e-9));

const slant = frustumSlantLength(LB, liftOff, tiltRad);
check("slant length is positive and does not exceed the flame length plus lift-off",
  slant > 0 && slant <= LB + liftOff);

const baseWidth = frustumBaseWidth(R, Ds, uj, 1.9, 1.2);
const tipWidth = frustumTipWidth(R, LB);
check("base width is positive", baseWidth > 0);
check("tip width is positive", tipWidth > 0);

console.log("\n=== 8. Full geometry pipeline produces physically sane values together ===");
const scenario = {
  massFlowRate: 2, orificeDiameter: 0.05, specificHeatRatio: 1.13,
  sourceTemperature: 293, molecularWeightKgPerMol: 0.0441,
  jetDensity: 1.9, ambientDensity: 1.2, windSpeed: 5, choked: false, isAerosol: false,
};
const geometry = jetFireGeometry(scenario);
check("tilt angle in the full pipeline is within 0-90 degrees",
  geometry.tiltAngleDegrees >= 0 && geometry.tiltAngleDegrees <= 90);
check("lift-off in the full pipeline is non-negative", geometry.liftOff >= 0);
check("slant length in the full pipeline is positive", geometry.slantLength > 0);
check("every geometry field is a finite number", Object.values(geometry).every(Number.isFinite));

console.log("\n=== 9. Combined radiation flux and physical direction ===");
const fireScenario = {
  ...scenario, heatOfCombustion: 46000000, relativeHumidity: 60, ambientTemperature: 293.15,
};
const near = jetFireRadiationAt({ ...fireScenario, receptorPoint: [3, 0, 0] });
const far = jetFireRadiationAt({ ...fireScenario, receptorPoint: [20, 0, 0] });
check("flux falls with distance", near.flux > far.flux);
check("flux is non-negative", far.flux >= 0);

const biggerFlow = jetFireRadiationAt({ ...fireScenario, massFlowRate: 8, receptorPoint: [20, 0, 0] });
check("a bigger mass flow rate radiates at least as strongly at the same distance",
  biggerFlow.flux >= far.flux);

console.log("\n=== 10. Threat distance search ===");
const thermal2 = findJetFireRadiationDistance({ ...fireScenario, thresholdWm2: 5000 });
check("status fields are well-formed", typeof thermal2.thresholdExceeded === "boolean");
if (thermal2.thresholdExceeded) {
  const thermal1 = findJetFireRadiationDistance({ ...fireScenario, thresholdWm2: 2000 });
  check("a lower threshold reaches at least as far",
    thermal1.maxDistance >= thermal2.maxDistance,
    `2kW: ${thermal1.maxDistance.toFixed(1)} m, 5kW: ${thermal2.maxDistance.toFixed(1)} m`);
}
const unreachable = findJetFireRadiationDistance({ ...fireScenario, thresholdWm2: 1e9 });
check("an unreachable threshold reports no exceedance",
  unreachable.thresholdExceeded === false && unreachable.maxDistance === 0);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
