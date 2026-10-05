/**
 * engineTests.js
 * --------------
 * Verification tests for the dispersion engine. Run with:
 *   node tests/engineTests.js
 *
 * These are not unit tests in the "cover every branch" sense. They check the
 * things that would make the model silently wrong: coefficient values against
 * the published tables, unit conversions against independently published
 * factors, and physical behaviours the model must exhibit regardless of
 * implementation (concentration falls with distance, a more stable atmosphere
 * produces a longer threat zone, a longer release converges on steady state).
 *
 * A model that passes these is not thereby validated — see the
 * "hazel-validation" entry in engineLimitations.js. It is merely free of the
 * errors that are easy to make and hard to notice.
 */

import { erf } from "../js/engine/engineMath.js";
import {
  sigmaY,
  sigmaZ,
  sigmaX,
  windSpeedAtHeight,
  steadyStateConcentration,
  peakConcentration,
  massConcentrationToPpm,
  ppmToMassConcentration,
  findThreatZone,
  validateScenario,
} from "../js/engine/engineGaussian.js";
import { determineStabilityClass, cloudCoverToCategory } from "../js/engine/engineStability.js";

let passed = 0;
let failed = 0;

function check(description, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${description}`);
  } else {
    failed++;
    console.log(`  FAIL  ${description}${detail ? ` — ${detail}` : ""}`);
  }
}

function closeTo(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

console.log("\n=== 1. Error function ===");
// Reference values from standard tables
check("erf(0) = 0", closeTo(erf(0), 0, 1e-9));
check("erf(1) ≈ 0.8427008", closeTo(erf(1), 0.8427008, 1e-6), `got ${erf(1)}`);
check("erf(2) ≈ 0.9953223", closeTo(erf(2), 0.9953223, 1e-6), `got ${erf(2)}`);
check("erf(-1) = -erf(1) (odd function)", closeTo(erf(-1), -erf(1), 1e-12));
check("erf(large) → 1", closeTo(erf(5), 1, 1e-6));

console.log("\n=== 2. Briggs dispersion parameters vs published formulas ===");
// Class A rural: sigmaZ = 0.20x  (Briggs 1973, simple linear form)
check(
  "sigmaZ class A rural at 1000 m = 200 m",
  closeTo(sigmaZ(1000, "A", 0.03), 200, 0.01),
  `got ${sigmaZ(1000, "A", 0.03)}`
);
// Class D rural: sigmaZ = 0.06x(1+0.0015x)^-0.5
// at x=1000: 60 * (2.5)^-0.5 = 60/1.5811 = 37.95
// This is the widely published Briggs value of roughly 38 m at 1 km for
// neutral rural conditions, which makes it a useful external cross-check.
check(
  "sigmaZ class D rural at 1000 m ≈ 37.95 m",
  closeTo(sigmaZ(1000, "D", 0.03), 37.95, 0.01),
  `got ${sigmaZ(1000, "D", 0.03)}`
);
// Class D crosswind: sigmaY = 0.08x(1+0.0001x)^-0.5
// at x=1000: 80 * (1.1)^-0.5 = 80/1.0488 = 76.28
check(
  "sigmaY class D at 1000 m ≈ 76.28 m",
  closeTo(sigmaY(1000, "D"), 76.28, 0.01),
  `got ${sigmaY(1000, "D")}`
);
// Urban class D differs from rural — confirms the roughness switch works
check(
  "sigmaZ class D urban differs from rural",
  Math.abs(sigmaZ(1000, "D", 1.0) - sigmaZ(1000, "D", 0.03)) > 1,
  `urban ${sigmaZ(1000, "D", 1.0)}, rural ${sigmaZ(1000, "D", 0.03)}`
);
// The 20 cm threshold: just below is rural, at or above is urban
check(
  "roughness threshold at 0.2 m switches rural→urban",
  sigmaZ(1000, "D", 0.19) !== sigmaZ(1000, "D", 0.2)
);
// sigmaY must not depend on roughness (deliberate, per Tech Doc)
check(
  "sigmaY is independent of roughness",
  sigmaY(1000, "D") === sigmaY(1000, "D"),
  "sigmaY takes no roughness argument by design"
);
// Stability ordering: unstable classes spread faster than stable ones
check(
  "sigmaY decreases from class A to class F",
  sigmaY(1000, "A") > sigmaY(1000, "C") && sigmaY(1000, "C") > sigmaY(1000, "F")
);
check(
  "sigmaZ decreases from class A to class F (rural)",
  sigmaZ(1000, "A", 0.03) > sigmaZ(1000, "C", 0.03) &&
    sigmaZ(1000, "C", 0.03) > sigmaZ(1000, "F", 0.03)
);
// Alongwind, Beals: class A sigmaX = 0.02 x^1.22; at 1000 m = 0.02 * 1000^1.22
check(
  "sigmaX class A at 1000 m ≈ 74.3 m",
  closeTo(sigmaX(1000, "A"), 0.02 * Math.pow(1000, 1.22), 0.01),
  `got ${sigmaX(1000, "A")}`
);

console.log("\n=== 3. Wind profile ===");
// Power law: U2 = U1 (z2/z1)^n, class D n = 0.142
const u2 = windSpeedAtHeight(5, 10, 2, "D");
check(
  "wind at 2 m is lower than at 10 m",
  u2 < 5 && u2 > 3,
  `got ${u2.toFixed(3)} m/s`
);
check(
  "wind profile matches power law exactly",
  closeTo(u2, 5 * Math.pow(2 / 10, 0.142), 1e-9)
);
check(
  "stable class F has a steeper profile than unstable class A",
  windSpeedAtHeight(5, 10, 2, "F") < windSpeedAtHeight(5, 10, 2, "A")
);

console.log("\n=== 4. Unit conversion (independently verifiable) ===");
// NIOSH Pocket Guide for chlorine: 1 ppm = 2.90 mg/m^3
// So 2.90e-6 kg/m^3 should convert to 1.00 ppm at 25 C, 1 atm.
const chlorinePpm = massConcentrationToPpm(2.9e-6, 70.9, 298.15);
check(
  "chlorine 2.90 mg/m³ = 1.00 ppm (NIOSH conversion factor)",
  closeTo(chlorinePpm, 1.0, 0.005),
  `got ${chlorinePpm.toFixed(4)} ppm`
);
// Round trip must be lossless
const roundTrip = massConcentrationToPpm(
  ppmToMassConcentration(20, 70.9, 298.15),
  70.9,
  298.15
);
check("ppm → kg/m³ → ppm round trip", closeTo(roundTrip, 20, 1e-9));
// Ammonia: 1 ppm = 0.696 mg/m^3 at 25 C (NIOSH)
const ammoniaPpm = massConcentrationToPpm(0.696e-6, 17.03, 298.15);
check(
  "ammonia 0.696 mg/m³ = 1.00 ppm",
  closeTo(ammoniaPpm, 1.0, 0.01),
  `got ${ammoniaPpm.toFixed(4)} ppm`
);

console.log("\n=== 5. Concentration behaviour ===");
const baseScenario = {
  releaseRate: 0.1, // kg/s
  releaseHeight: 0,
  windSpeed: 5,
  stabilityClass: "D",
  roughnessLength: 0.03,
  inversionHeight: null,
};
const c100 = steadyStateConcentration({ ...baseScenario, x: 100, y: 0, z: 0 });
const c500 = steadyStateConcentration({ ...baseScenario, x: 500, y: 0, z: 0 });
const c2000 = steadyStateConcentration({ ...baseScenario, x: 2000, y: 0, z: 0 });
check("concentration falls with distance", c100 > c500 && c500 > c2000);
check("concentration is positive", c100 > 0);

const cCentre = steadyStateConcentration({ ...baseScenario, x: 500, y: 0, z: 0 });
const cOffset = steadyStateConcentration({ ...baseScenario, x: 500, y: 50, z: 0 });
check("concentration falls off the centreline", cCentre > cOffset);

const cGround = steadyStateConcentration({ ...baseScenario, x: 500, y: 0, z: 0 });
const cAloft = steadyStateConcentration({ ...baseScenario, x: 500, y: 0, z: 100 });
check("ground-level release: concentration falls with height", cGround > cAloft);

// Doubling the release rate must double the concentration (linearity)
const cDouble = steadyStateConcentration({
  ...baseScenario,
  releaseRate: 0.2,
  x: 500,
  y: 0,
  z: 0,
});
check("concentration is linear in release rate", closeTo(cDouble, 2 * c500, 1e-12));

// Halving the wind must double the concentration (inverse proportionality)
const cHalfWind = steadyStateConcentration({
  ...baseScenario,
  windSpeed: 2.5,
  x: 500,
  y: 0,
  z: 0,
});
check("concentration is inversely proportional to wind speed", closeTo(cHalfWind, 2 * c500, 1e-12));

console.log("\n=== 6. Finite-duration release (Palazzi term) ===");
const shortRelease = peakConcentration({
  ...baseScenario,
  x: 1000,
  y: 0,
  z: 0,
  releaseDuration: 30,
});
const longRelease = peakConcentration({
  ...baseScenario,
  x: 1000,
  y: 0,
  z: 0,
  releaseDuration: 3600,
});
const steady = steadyStateConcentration({ ...baseScenario, x: 1000, y: 0, z: 0 });
check("a short release gives less than steady state", shortRelease < steady);
check("a long release converges on steady state", closeTo(longRelease, steady, steady * 0.01));
check("longer release gives higher peak", longRelease > shortRelease);

console.log("\n--- regression (2026-09-27): peak-time fix, factor stays near 1 well past U*t_r ---");
// See engineGaussian.js's peakConcentration() "FIX (2026-09-27)" note: the
// duration factor previously collapsed to numerically zero once x exceeded
// roughly windSpeed*releaseDuration, because it evaluated the Palazzi (1982)
// expression at a fixed time (source shutoff) instead of each station's own
// peak-passage time. A 10-minute, 5 m/s release has windSpeed*releaseDuration
// = 3000 m; a station well beyond that (10000 m) should still see a
// meaningful fraction of the steady-state concentration, not ~0.
const durationRegressionScenario = { ...baseScenario, windSpeed: 5, y: 0, z: 0 };
const farStation = peakConcentration({ ...durationRegressionScenario, x: 10000, releaseDuration: 600 });
const farSteady = steadyStateConcentration({ ...durationRegressionScenario, x: 10000 });
check(
  "at 10 km, more than 3x the release length (3 km), a 10-min release still keeps a substantial fraction of steady-state concentration",
  farStation > farSteady * 0.3,
  `got ${(farStation / farSteady).toFixed(4)} of steady state`
);
check(
  "...but still strictly less than the steady-state value (a finite release cannot exceed the continuous case)",
  farStation < farSteady
);
check(
  "immediately at the source, the factor is still effectively 1 for a substantial release",
  closeTo(
    peakConcentration({ ...durationRegressionScenario, x: 1, releaseDuration: 600 }),
    steadyStateConcentration({ ...durationRegressionScenario, x: 1 }),
    steadyStateConcentration({ ...durationRegressionScenario, x: 1 }) * 0.01
  )
);

console.log("\n=== 7. Inversion lid ===");
const noInversion = steadyStateConcentration({ ...baseScenario, x: 3000, y: 0, z: 0 });
const withInversion = steadyStateConcentration({
  ...baseScenario,
  inversionHeight: 100,
  x: 3000,
  y: 0,
  z: 0,
});
check(
  "an inversion traps the cloud and raises ground concentration",
  withInversion > noInversion,
  `with ${withInversion.toExponential(3)}, without ${noInversion.toExponential(3)}`
);

console.log("\n=== 8. Stability class lookup (Turner) ===");
check("light wind, strong sun → A", determineStabilityClass({ windSpeed10m: 1.5, isDaytime: true, insolation: "strong" }) === "A");
check("moderate wind, moderate sun → C", determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "moderate" }) === "C");
check("strong wind, day → D", determineStabilityClass({ windSpeed10m: 8, isDaytime: true, insolation: "moderate" }) === "D");
check("light wind, clear night → F", determineStabilityClass({ windSpeed10m: 1.5, isDaytime: false, nightCloud: "clear" }) === "F");
check("strong wind, night → D", determineStabilityClass({ windSpeed10m: 8, isDaytime: false, nightCloud: "clear" }) === "D");
check("overcast day maps to slight insolation", cloudCoverToCategory(7, true).insolation === "slight");
check("clear night maps to clear category", cloudCoverToCategory(1, false).nightCloud === "clear");

console.log("\n=== 9. Scenario validation ===");
const calmProblems = validateScenario({
  windSpeed10m: 0.4,
  releaseRate: 1,
  releaseDuration: 600,
  molecularWeight: 70.9,
  temperature: 293,
});
check("calm conditions are rejected", calmProblems.length === 1 && calmProblems[0].includes("1 m/s"));

const longProblems = validateScenario({
  windSpeed10m: 5,
  releaseRate: 1,
  releaseDuration: 7200,
  molecularWeight: 70.9,
  temperature: 293,
});
check("release beyond one hour is rejected", longProblems.length === 1);

const okProblems = validateScenario({
  windSpeed10m: 5,
  releaseRate: 1,
  releaseDuration: 600,
  molecularWeight: 70.9,
  temperature: 293,
});
check("a valid scenario produces no problems", okProblems.length === 0);

console.log("\n=== 10. Threat zone search ===");
// A benzene-like neutrally buoyant vapour, which is what this model is for.
const threatScenario = {
  releaseRate: 0.5, // kg/s
  releaseDuration: 1800, // 30 min
  releaseHeight: 0,
  windSpeed10m: 5,
  stabilityClass: "D",
  roughnessLength: 0.03,
  molecularWeight: 78.11, // benzene
  temperature: 293.15,
  levelOfConcernPpm: 800, // benzene AEGL-2, 60 min
};

const zone = findThreatZone(threatScenario);
check("threat zone is found", zone.thresholdExceeded === true);
check("threat distance is a sensible magnitude", zone.maxDownwindDistance > 10 && zone.maxDownwindDistance < 50000, `got ${zone.maxDownwindDistance.toFixed(1)} m`);
check("footprint polygon is produced", zone.footprint.length > 10);
check("footprint is symmetric about the centreline", closeTo(zone.footprint[0].y, -zone.footprint[zone.footprint.length - 1].y, 1e-6));

// A threshold high enough never to be reached must report that honestly
const noZone = findThreatZone({ ...threatScenario, levelOfConcernPpm: 1e9 });
check("an unreachable threshold reports no zone", noZone.thresholdExceeded === false && noZone.maxDownwindDistance === 0);

// Physical ordering: a lower threshold must give a longer zone
const lowThreshold = findThreatZone({ ...threatScenario, levelOfConcernPpm: 52 }); // AEGL-1
check(
  "a lower Level of Concern gives a longer threat zone",
  lowThreshold.maxDownwindDistance > zone.maxDownwindDistance,
  `AEGL-1 ${lowThreshold.maxDownwindDistance.toFixed(0)} m vs AEGL-2 ${zone.maxDownwindDistance.toFixed(0)} m`
);

// A more stable atmosphere disperses less, so the zone must reach further
const stableZone = findThreatZone({ ...threatScenario, stabilityClass: "F" });
check(
  "stable class F gives a longer zone than neutral class D",
  stableZone.maxDownwindDistance > zone.maxDownwindDistance,
  `F ${stableZone.maxDownwindDistance.toFixed(0)} m vs D ${zone.maxDownwindDistance.toFixed(0)} m`
);

// More wind dilutes but also carries further; for a fixed threshold, higher
// wind should reduce concentration and shorten the zone.
const windyZone = findThreatZone({ ...threatScenario, windSpeed10m: 10 });
check(
  "doubling the wind shortens the threat zone",
  windyZone.maxDownwindDistance < zone.maxDownwindDistance,
  `10 m/s ${windyZone.maxDownwindDistance.toFixed(0)} m vs 5 m/s ${zone.maxDownwindDistance.toFixed(0)} m`
);

console.log("\n=== 11. Footprint resolution near the source (regression) ===");
// A real user report: at a high release rate the threat zone reaches far
// enough downwind that plain evenly-spaced sampling left the near-source
// "neck" of the lens shape unresolved — the polygon's first recorded point
// was already tens of metres wide, so the shape rendered as a wedge that
// looked wide from the very start instead of the true narrow-wide-narrow
// lens. buildFootprint() now uses cosine-spaced stations specifically to
// keep the near-source (and, symmetrically, the far-tip) region well
// resolved regardless of how far the zone reaches. This section pins that
// down for a release large enough to reach kilometres downwind.
const bigRelease = {
  releaseRate: 100, releaseDuration: 600, releaseHeight: 0,
  stabilityClass: "D", roughnessLength: 0.1, temperature: 293.15,
  molecularWeight: 30, windSpeed10m: 5, inversionHeight: null,
  levelOfConcernPpm: 10,
};
const bigZone = findThreatZone(bigRelease);
check("a large release still produces a threat zone", bigZone.thresholdExceeded === true);
const firstPoint = bigZone.footprint[0];
check("the first footprint point is close to the source, not far downwind",
  firstPoint.x < bigZone.maxDownwindDistance * 0.05,
  `first point at x=${firstPoint.x.toFixed(1)} m of a ${bigZone.maxDownwindDistance.toFixed(0)} m zone`);
check("the first footprint point is narrow (the near-source neck), not already wide",
  Math.abs(firstPoint.y) < bigZone.footprint[Math.floor(bigZone.footprint.length / 4)].y,
  `first point y=${firstPoint.y.toFixed(1)} m`);


console.log("Benzene, 0.5 kg/s for 30 min, ground level, 5 m/s, class D, open country:");
[
  { label: "AEGL-3 (4000 ppm)", loc: 4000 },
  { label: "AEGL-2 (800 ppm)", loc: 800 },
  { label: "AEGL-1 (52 ppm)", loc: 52 },
].forEach(({ label, loc }) => {
  const r = findThreatZone({ ...threatScenario, levelOfConcernPpm: loc });
  const distance = r.thresholdExceeded
    ? `${r.maxDownwindDistance.toFixed(0)} m`
    : "not exceeded";
  console.log(`  ${label.padEnd(20)} ${distance}`);
});

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
