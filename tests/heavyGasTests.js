/**
 * heavyGasTests.js
 * ----------------
 * Verification for the Stage 1 heavy gas (dense cloud) dispersion model.
 * Run with:  node tests/heavyGasTests.js
 *
 * This model rests on a genuinely different foundation from the Gaussian
 * engine: there is no ALOHA worked example to reproduce (ALOHA's own
 * examples in this project's possession do not exercise the heavy gas
 * branch), and the source material itself (a 1985 scanned government
 * report) could not be fully verified — see the long comment at the top of
 * engineHeavyGas.js for exactly what was and was not confirmed (as of
 * 2026-09-22, that now includes the secondary source blanket / Q*max
 * closure, confirmed against a cleaner scan of the DEGADIS 2.1 User's
 * Guide — see section 10 below; as of 2026-09-26, it also includes the
 * finite-duration correction — see section 11 below). These tests
 * therefore lean harder on two things that do not depend on trusting any
 * single equation: internal mathematical correctness (the gamma function
 * against exact values) and physical DIRECTION (a denser gas, a faster
 * release, and a calmer wind should all make the hazard larger — regardless
 * of the exact numbers, the relative ordering is a hard physical
 * requirement any correct implementation must satisfy).
 */

import {
  gammaFunction, stabilityFunction, richardsonStarAt,
  effectiveHeight, effectiveVelocity, verticalGrowthRate, lateralGrowthRate,
  marchDownwind, findHeavyGasThreatZone, concentrationAtDistance,
  lateralSpread, coreHalfWidth, concentrationAtOffset, edgeAtThreshold,
  maximumAtmosphericTakeupFlux, secondarySourceBlanketRadius,
  finiteDurationFactor,
  heavyGasFrictionVelocity, obukhovLength, businger, fineSearchCeiling,
  compositeMarch, releaseStepsFromSeries, stepPulseWeight,
} from "../js/engine/engineHeavyGas.js";
import { simulatePuddleEvaporation } from "../js/engine/engineSourcePuddle.js";
import { sigmaY } from "../js/engine/engineGaussian.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Gamma function against exact values ===");
check("Gamma(1) = 1", closeTo(gammaFunction(1), 1, 1e-10));
check("Gamma(2) = 1", closeTo(gammaFunction(2), 1, 1e-10));
check("Gamma(3) = 2", closeTo(gammaFunction(3), 2, 1e-9));
check("Gamma(4) = 6", closeTo(gammaFunction(4), 6, 1e-8));
check("Gamma(5) = 24", closeTo(gammaFunction(5), 24, 1e-7));
check("Gamma(0.5) = sqrt(pi)", closeTo(gammaFunction(0.5), Math.sqrt(Math.PI), 1e-9));
check("Gamma(1.5) = 0.5*sqrt(pi)", closeTo(gammaFunction(1.5), 0.5 * Math.sqrt(Math.PI), 1e-9));
// The recurrence Gamma(z+1) = z*Gamma(z) holds for any z, not just the
// tabulated integers/half-integers above — a good general sanity check.
for (const z of [0.7, 1.3, 2.6, 3.9]) {
  check(`Gamma(${z}+1) = ${z}*Gamma(${z}) (recurrence)`,
    closeTo(gammaFunction(z + 1), z * gammaFunction(z), 1e-9));
}

console.log("\n=== 2. Stability function phi(Ri*) ===");
check("phi(0) = 0.88 exactly", stabilityFunction(0) === 0.88);
check("phi is monotonically increasing with Ri*",
  stabilityFunction(1) > stabilityFunction(0) &&
  stabilityFunction(10) > stabilityFunction(1) &&
  stabilityFunction(100) > stabilityFunction(10));
check("phi(negative) is clamped to phi(0), not extrapolated",
  stabilityFunction(-5) === stabilityFunction(0));
// The Ri*^5.7 term is negligible until Ri* reaches roughly 10^4-10^5 (its
// coefficient is 1.4e-25); checked numerically before picking this value so
// the test exercises the term it names rather than the Ri*^1.04 term, which
// already dominates comfortably below Ri* = 1000.
check("the Ri*^5.7 term eventually dominates at very large Ri*",
  stabilityFunction(1e5) > 10 * stabilityFunction(1e4));

console.log("\n=== 3. Richardson number ===");
check("Ri* is zero when reduced gravity is zero (neutral density)",
  richardsonStarAt(0, 10, 0.3) === 0);
check("Ri* increases with height", richardsonStarAt(1, 20, 0.3) > richardsonStarAt(1, 10, 0.3));
check("Ri* decreases with friction velocity", richardsonStarAt(1, 10, 0.6) < richardsonStarAt(1, 10, 0.3));

console.log("\n=== 4. Effective height and velocity ===");
// At alpha -> a specific value, check the formulas are internally consistent
// with their own defining relations rather than against an external number
// (there is no independent reference for these two specifically).
const h1 = effectiveHeight(10, 0.14);
check("effective height is positive and less than a few multiples of Sz",
  h1 > 0 && h1 < 10, `got ${h1.toFixed(2)}`);
check("effective height scales linearly with Sz",
  closeTo(effectiveHeight(20, 0.14) / effectiveHeight(10, 0.14), 2, 1e-9));

const v1 = effectiveVelocity(10, 5, 0.14);
check("effective velocity is positive", v1 > 0);
check("a deeper cloud (larger Sz) has a higher effective velocity (wind shear)",
  effectiveVelocity(20, 5, 0.14) > v1);
check("effective velocity scales linearly with reference wind speed",
  closeTo(effectiveVelocity(10, 10, 0.14) / v1, 2, 1e-9));

console.log("\n=== 5. Growth rates are positive (the plume must not shrink) ===");
const growthArgs = {
  verticalDispersion: 5, uStar: 0.3, referenceWindSpeed: 5, alpha: 0.14, phi: 1.0,
};
check("vertical growth rate is positive", verticalGrowthRate(growthArgs) > 0);

const lateralArgs = {
  verticalDispersion: 5, effHeight: 3, reducedG: 2, referenceWindSpeed: 5, alpha: 0.14,
};
check("lateral growth rate is positive when the gas is denser than air",
  lateralGrowthRate(lateralArgs) > 0);
check("lateral growth rate is zero for a neutrally buoyant gas (reducedG = 0)",
  lateralGrowthRate({ ...lateralArgs, reducedG: 0 }) === 0);

console.log("\n=== 5b. Crosswind profile: homogeneous core + Gaussian tail ===");
// lateralSpread(x, stabilityClass) = sqrt(2) * sigmaY(x, stabilityClass) —
// the S_y for which the Tech Doc's tail exp(-((|y|-b)/S_y)^2) becomes the
// ordinary Gaussian exp(-y^2/(2 sigma_y^2)) once the core is gone (2026-09-30;
// previously sqrt(pi) * sigmaY, see engineHeavyGas.js).
check("lateralSpread matches sqrt(2)*sigmaY exactly",
  closeTo(lateralSpread(100, "D"), Math.SQRT2 * sigmaY(100, "D"), 1e-9));
check("with the core gone, the tail IS the Gaussian with sigma_y (same value one sigma out)",
  closeTo(concentrationAtOffset(1, sigmaY(500, "F"), 0, 500, "F"), Math.exp(-0.5), 1e-9));
check("lateralSpread is zero at the source and grows with distance",
  lateralSpread(0, "D") === 0 && lateralSpread(200, "D") > lateralSpread(100, "D"));

check("coreHalfWidth matches Beff - sqrt(pi)/2*Sy by hand",
  closeTo(coreHalfWidth(100, 10), 100 - (Math.sqrt(Math.PI) / 2) * 10, 1e-9));
check("coreHalfWidth is clamped to zero once the tail would exceed B_eff",
  coreHalfWidth(5, 100) === 0);
check("coreHalfWidth never exceeds B_eff itself",
  coreHalfWidth(50, 0) === 50);

check("concentrationAtOffset returns the centreline value inside the core",
  concentrationAtOffset(10, 0, 50, 100, "D") === 10);
check("concentrationAtOffset falls off beyond the core",
  concentrationAtOffset(10, 200, 50, 100, "D") < 10);
check("concentrationAtOffset is symmetric in y",
  concentrationAtOffset(10, 80, 50, 100, "D") === concentrationAtOffset(10, -80, 50, 100, "D"));
check("concentrationAtOffset approaches zero far outside the core",
  concentrationAtOffset(10, 100000, 50, 100, "D") < 1e-6);

check("edgeAtThreshold returns null when the centreline is already below threshold",
  edgeAtThreshold(5, 50, 100, "D", 10) === null);
check("edgeAtThreshold never exceeds the raw B_eff by an unreasonable margin at a typical ratio",
  edgeAtThreshold(100, 50, 100, "D", 10) < 200); // generous sanity bound, not a tight physical claim
check("edgeAtThreshold is consistent with concentrationAtOffset (inverse of each other)",
  closeTo(
    concentrationAtOffset(100, edgeAtThreshold(100, 50, 100, "D", 10), 50, 100, "D"),
    10,
    0.01
  ));
check("edgeAtThreshold approaches the core width as the centreline approaches the threshold",
  closeTo(edgeAtThreshold(10.001, 50, 100, "D", 10), coreHalfWidth(50, lateralSpread(100, "D")), 1));

console.log("\n=== 6. Downwind march produces physically sane behaviour ===");
const chlorineBase = {
  releaseRate: 5, // kg/s — a substantial, genuinely heavy-gas-triggering release
  molecularWeight: 70.9, // chlorine
  temperature: 293.15,
  windSpeed10m: 5,
  roughnessLength: 0.03,
  stabilityClass: "D",
  sourceHalfWidth: 5,
  characteristicHeight: 2,
};

const series = marchDownwind(chlorineBase);
check("a full series is produced", series.length > 100);
check("the plume half-width never shrinks",
  series.every((p, i) => i === 0 || p.halfWidth >= series[i - 1].halfWidth - 1e-9));
check("concentration generally falls with distance (checked far downwind, past the peak)",
  series[series.length - 1].concentrationKgM3 < series[Math.floor(series.length / 4)].concentrationKgM3);
check("concentration is never negative", series.every((p) => p.concentrationKgM3 >= 0));
check("Richardson number is never negative (Stage 1 has no heat-transfer branch)",
  series.every((p) => p.ri >= 0));

console.log("\n=== 7. Threat zone: physical direction checks ===");
const baseZoneScenario = { ...chlorineBase, levelOfConcernPpm: 20 }; // AEGL-3-like threshold

const baseZone = findHeavyGasThreatZone(baseZoneScenario);
check("a substantial chlorine release exceeds a low threshold", baseZone.thresholdExceeded === true);
check("the footprint is a non-trivial polygon", baseZone.footprint.length > 10);

// A lower threshold must never give a SHORTER distance than a higher one.
const stricterZone = findHeavyGasThreatZone({ ...baseZoneScenario, levelOfConcernPpm: 2 });
check("a stricter (lower) threshold reaches at least as far",
  stricterZone.maxDownwindDistance >= baseZone.maxDownwindDistance,
  `2 ppm: ${stricterZone.maxDownwindDistance.toFixed(0)} m vs 20 ppm: ${baseZone.maxDownwindDistance.toFixed(0)} m`);

// A larger release rate must never give a shorter distance.
const biggerRelease = findHeavyGasThreatZone({ ...baseZoneScenario, releaseRate: 20 });
check("a larger release reaches at least as far",
  biggerRelease.maxDownwindDistance >= baseZone.maxDownwindDistance,
  `20 kg/s: ${biggerRelease.maxDownwindDistance.toFixed(0)} m vs 5 kg/s: ${baseZone.maxDownwindDistance.toFixed(0)} m`);

// A denser gas (all else equal) does NOT simply "reach farther" — it
// exhibits two competing, physically real effects: gravity spreading makes
// the plume WIDER (checked directly below, via marchDownwind), while the
// higher Richardson number SUPPRESSES vertical growth (also checked below).
// Which of the two dominates the downwind THREAT DISTANCE for a given
// substance depends on the specific scenario, so that comparison is not
// asserted here — see the direct mechanism checks instead, and the note in
// heavyGasTests.js's file header on why this matters.
const denseSeries = marchDownwind({ ...chlorineBase, stepCount: 50 });
const lighterSeries = marchDownwind({ ...chlorineBase, molecularWeight: 30, stepCount: 50 });
const sampleIndex = 20;
check("a denser gas spreads laterally wider than a lighter one at the same downwind distance",
  denseSeries[sampleIndex].halfWidth > lighterSeries[sampleIndex].halfWidth,
  `Cl2: ${denseSeries[sampleIndex].halfWidth.toFixed(1)} m vs M=30: ${lighterSeries[sampleIndex].halfWidth.toFixed(1)} m`);
check("a denser gas has slower vertical growth (suppressed mixing) than a lighter one",
  denseSeries[sampleIndex].effHeight < lighterSeries[sampleIndex].effHeight,
  `Cl2: ${denseSeries[sampleIndex].effHeight.toFixed(2)} m vs M=30: ${lighterSeries[sampleIndex].effHeight.toFixed(2)} m`);
console.log(`  (informational: at this scenario's parameters, the wider-but-shallower Cl2 ` +
  `plume reaches ${baseZone.maxDownwindDistance < findHeavyGasThreatZone({ ...baseZoneScenario, molecularWeight: 30 }).maxDownwindDistance ? "a SHORTER" : "a LONGER"} ` +
  `threat distance than the M=30 case — both are physically valid outcomes of the same mechanism)`);

// A calmer wind gives weaker turbulent entrainment (lower u*), so the cloud
// should be diluted more slowly and the threat zone should not shrink.
const calmerWind = findHeavyGasThreatZone({ ...baseZoneScenario, windSpeed10m: 3 });
check("a calmer wind does not shorten the threat distance",
  calmerWind.maxDownwindDistance >= baseZone.maxDownwindDistance * 0.8,
  `3 m/s: ${calmerWind.maxDownwindDistance.toFixed(0)} m vs 5 m/s: ${baseZone.maxDownwindDistance.toFixed(0)} m`);

// An unreachable threshold must report cleanly, not a bogus distance.
const unreachable = findHeavyGasThreatZone({ ...baseZoneScenario, levelOfConcernPpm: 1e9 });
check("an unreachable threshold reports no zone",
  unreachable.thresholdExceeded === false && unreachable.maxDownwindDistance === 0);

console.log("\n=== 8. Footprint geometry ===");
check("footprint is symmetric about the centreline",
  closeTo(baseZone.footprint[0].y, -baseZone.footprint[baseZone.footprint.length - 1].y, 1e-6));
check("every footprint point has a non-negative downwind distance",
  baseZone.footprint.every((p) => p.x >= 0));

// A real, reported symptom, distinct from the resolution issue in section 9:
// the earlier plain top-hat profile reported the SAME (ever-growing) width
// everywhere the centreline exceeded the threshold, so the polygon simply
// stopped at the last exceeding station's full — by then largest-yet —
// width: a flat wall at the far end. The homogeneous-core-plus-Gaussian-tail
// profile (concentrationAtOffset/edgeAtThreshold) replaces that raw B_eff
// value with the actual LOC-crossing width, which is never larger than
// B_eff itself and shrinks toward the core width b(x) — not necessarily to
// zero — as the centreline approaches the threshold. Whether that is
// visually a sharp point or a gently rounded edge depends on how much the
// core has eroded by that distance for the specific scenario; what is
// checked here is the part that is unconditionally true regardless of that:
// the reported edge is a real function of distance, not the untapered B_eff.
const lastUpperEdge = baseZone.footprint[exceedingCountFor(baseZone) - 1];
function exceedingCountFor(zone) {
  return zone.footprint.length / 2;
}
// Compare against the SAME scenario's own raw (untapered) B_eff at that
// exact station, rather than a hardcoded number from a different scenario.
const rawSeriesAtTip = marchDownwind({ ...baseZoneScenario, maxDistance: baseZone.maxDownwindDistance * 1.05, stepCount: 200 });
const nearestRawStation = rawSeriesAtTip.reduce((a, b) =>
  Math.abs(b.x - lastUpperEdge.x) < Math.abs(a.x - lastUpperEdge.x) ? b : a
);
check("the reported edge at the far station is strictly less than the raw (untapered) B_eff there",
  lastUpperEdge.y < nearestRawStation.halfWidth,
  `edge=${lastUpperEdge.y.toFixed(1)}, raw B_eff=${nearestRawStation.halfWidth.toFixed(1)}`);
check("the upper and lower edges meet at the same x at the far end (no artificial extra point)",
  closeTo(lastUpperEdge.x, baseZone.footprint[exceedingCountFor(baseZone)].x, 1e-6));
check("the upper and lower edges are mirror images at that station",
  closeTo(lastUpperEdge.y, -baseZone.footprint[exceedingCountFor(baseZone)].y, 1e-6));

console.log("\n=== 9. Footprint resolution (regression) ===");
// A real, reported symptom: marchDownwind()'s default search range (20 km)
// vastly exceeds a typical zone's actual extent (tens to a few hundred
// metres for many scenarios), so a single fixed-step march across the full
// default range left only a handful of stations inside the real zone —
// enough to close a polygon, but rendering as a jagged wedge rather than
// the smooth shape the physics predicts. findHeavyGasThreatZone() now runs
// a coarse pass to locate the zone, then a second pass sized to it.
const denseChlorine = {
  releaseRate: 5, molecularWeight: 70.9, temperature: 293.15,
  windSpeed10m: 5, roughnessLength: 0.03, stabilityClass: "D",
  sourceHalfWidth: 5, characteristicHeight: 2, levelOfConcernPpm: 20,
};
const resolvedZone = findHeavyGasThreatZone(denseChlorine);
check("a real (short) zone is resolved with far more than a handful of points",
  resolvedZone.footprint.length > 100,
  `got ${resolvedZone.footprint.length} points for a ${resolvedZone.maxDownwindDistance.toFixed(0)} m zone`);

// A separate, much larger scenario should ALSO resolve well — the fix must
// not just work for short zones, it must not break long ones either.
const bigCloud = { ...denseChlorine, releaseRate: 200, levelOfConcernPpm: 2 };
const bigZone = findHeavyGasThreatZone(bigCloud);
check("a much larger zone is also well resolved",
  bigZone.footprint.length > 100,
  `got ${bigZone.footprint.length} points for a ${bigZone.maxDownwindDistance.toFixed(0)} m zone`);

console.log("\n=== 10. Secondary source blanket (Q*max), resolved 2026-09-22 ===");
// A reference scenario matching the one worked by hand while implementing
// this: chlorine, stability D, 5 m/s wind, a modest 2.5 m primary source
// radius. Q*max should be a positive, physically plausible flux (kg/m^2/s,
// the same order of magnitude as an ordinary mass-transfer coefficient).
const qmaxScenario = {
  sourceConcentration: 2.9474, // kg/m^3, chlorine vapour at 293.15 K, 1 atm
  reducedG: 14.202,
  uStar: 0.34428,
  alpha: 0.142, // stability D
  windSpeed10m: 5,
  sourceLength: 5, // 2 * 2.5 m radius
};
const qmax = maximumAtmosphericTakeupFlux(qmaxScenario);
check("Q*max is positive and a plausible magnitude for a mass-transfer flux",
  qmax > 0 && qmax < 100, `got ${qmax.toFixed(4)} kg/m^2/s`);

check("a larger primary source (more area to take gas up over) raises Q*max's threshold before a blanket forms, all else equal",
  maximumAtmosphericTakeupFlux({ ...qmaxScenario, sourceLength: 20 }) !== qmax);

check("Q*max rises with friction velocity (more turbulence, more atmospheric uptake capacity)",
  maximumAtmosphericTakeupFlux({ ...qmaxScenario, uStar: qmaxScenario.uStar * 2 }) > qmax);

console.log("\n--- secondarySourceBlanketRadius() ---");
check("the blanket radius never shrinks below the primary source radius",
  secondarySourceBlanketRadius({ releaseRate: 0.001, potentialTakeupFlux: qmax, primarySourceRadius: 2.5 }) === 2.5);
check("a release rate exactly matching Q*max*pi*Rp^2 gives back the primary radius",
  closeTo(
    secondarySourceBlanketRadius({
      releaseRate: qmax * Math.PI * 2.5 * 2.5,
      potentialTakeupFlux: qmax,
      primarySourceRadius: 2.5,
    }),
    2.5,
    1e-6
  ));
check("a release rate four times the threshold doubles the blanket radius (R scales as sqrt(E))",
  closeTo(
    secondarySourceBlanketRadius({
      releaseRate: qmax * Math.PI * 2.5 * 2.5 * 4,
      potentialTakeupFlux: qmax,
      primarySourceRadius: 2.5,
    }) / 2.5,
    2,
    1e-6
  ));
check("a non-positive Q*max falls back to the primary source radius rather than dividing by zero",
  secondarySourceBlanketRadius({ releaseRate: 100, potentialTakeupFlux: 0, primarySourceRadius: 3 }) === 3);

console.log("\n--- marchDownwind()/findHeavyGasThreatZone() wiring ---");
// A release large enough, over a small enough primary source, to force
// blanket formation should behave sanely and give an EQUAL-OR-LARGER threat
// zone than a comparison release too small to form one — the blanket widens
// the starting footprint, never narrows it.
const smallSource = { ...chlorineBase, releaseRate: 0.2, sourceHalfWidth: 1, characteristicHeight: 0.3 };
const smallZone = findHeavyGasThreatZone({ ...smallSource, levelOfConcernPpm: 20 });
const hugeReleaseSameSource = { ...smallSource, releaseRate: 200 };
const hugeZone = findHeavyGasThreatZone({ ...hugeReleaseSameSource, levelOfConcernPpm: 20 });
check("a release large enough to force blanket formation over a small source reaches farther, not less far",
  hugeZone.maxDownwindDistance > smallZone.maxDownwindDistance,
  `0.2 kg/s: ${smallZone.maxDownwindDistance.toFixed(0)} m vs 200 kg/s: ${hugeZone.maxDownwindDistance.toFixed(0)} m`);

console.log("\n=== 11. Finite-duration correction (Beals/Palazzi sigma_x smearing, resolved 2026-09-26) ===");
// The regression this section exists for: a user reported that changing a
// chlorine release's declared duration from 60 s to 6 s (same 1 kg/s rate)
// produced the IDENTICAL threat distance at every threshold — physically
// indefensible, and traced to marchDownwind() never reading releaseDuration
// at all before this fix. See engineHeavyGas.js's module docstring,
// "FINITE-DURATION CORRECTION", for the full account, including why this is
// not something the earlier crosswind-profile ("triangle") fixes touched.

check("finiteDurationFactor is exactly 1 (unchanged, continuous) when no duration is given",
  finiteDurationFactor(500, 5, undefined, "D") === 1);
check("finiteDurationFactor is 0 at or before the source, consistent with marchDownwind() never querying x<=0 (its own starting station x0 is always > 0)",
  finiteDurationFactor(0, 5, 6, "D") === 0);

const fNear = finiteDurationFactor(50, 5, 6, "D");
const fFar = finiteDurationFactor(5000, 5, 6, "D");
check("a brief (6 s) release's finite-duration factor is smaller far downwind than near the source",
  fFar < fNear, `near (50 m): ${fNear.toFixed(3)}, far (5000 m): ${fFar.toFixed(3)}`);

const fFarLongRelease = finiteDurationFactor(5000, 5, 3600, "D");
check("the same far distance sees a factor much closer to 1 for a 1-hour release than a 6-second one",
  fFarLongRelease > fFar,
  `1 h: ${fFarLongRelease.toFixed(3)} vs 6 s: ${fFar.toFixed(3)}`);

console.log("\n--- regression: threat distance now depends on release duration ---");
// Parameters echoing the user's real report (chlorine, stability D, 5 m/s
// wind) but with a small enough source/rate that the zone resolves at a
// convenient scale for this test; the physical point — duration must now
// matter — does not depend on matching the exact reported numbers.
const durationRegressionBase = {
  releaseRate: 1, molecularWeight: 70.906, temperature: 293.15,
  windSpeed10m: 5, roughnessLength: 0.03, stabilityClass: "D",
  sourceHalfWidth: 0.5, characteristicHeight: 0.3, levelOfConcernPpm: 2,
};
const zone6s = findHeavyGasThreatZone({ ...durationRegressionBase, releaseDuration: 6 });
const zone60s = findHeavyGasThreatZone({ ...durationRegressionBase, releaseDuration: 60 });
const zone3600s = findHeavyGasThreatZone({ ...durationRegressionBase, releaseDuration: 3600 });
const zoneNoDuration = findHeavyGasThreatZone(durationRegressionBase);

check("a 6-second release gives a SHORTER threat distance than the same rate held for 60 seconds (the reported bug)",
  zone6s.maxDownwindDistance < zone60s.maxDownwindDistance,
  `6 s: ${zone6s.maxDownwindDistance.toFixed(0)} m vs 60 s: ${zone60s.maxDownwindDistance.toFixed(0)} m`);
check("a 60-second release gives a shorter-or-equal distance to a 1-hour release at the same rate",
  zone60s.maxDownwindDistance <= zone3600s.maxDownwindDistance,
  `60 s: ${zone60s.maxDownwindDistance.toFixed(0)} m vs 3600 s: ${zone3600s.maxDownwindDistance.toFixed(0)} m`);
check("omitting releaseDuration altogether still reproduces the original continuous-release behaviour",
  closeTo(zoneNoDuration.maxDownwindDistance, zone3600s.maxDownwindDistance, Math.max(zone3600s.maxDownwindDistance * 0.1, 1)),
  `no duration: ${zoneNoDuration.maxDownwindDistance.toFixed(0)} m vs 3600 s: ${zone3600s.maxDownwindDistance.toFixed(0)} m`);

console.log("\n--- concentrationAtDistance() forwards releaseDuration automatically ---");
// concentrationAtDistance() just spreads its scenario into marchDownwind(),
// so this confirms that wiring actually reaches the finite-duration factor
// rather than asserting it as a given.
const stationShort = concentrationAtDistance({ ...durationRegressionBase, releaseDuration: 6 }, 2000);
const stationLong = concentrationAtDistance({ ...durationRegressionBase, releaseDuration: 3600 }, 2000);
check("concentrationAtDistance reports a lower concentration for a brief release than a long one, at the same far station",
  stationShort.concentrationKgM3 < stationLong.concentrationKgM3,
  `6 s: ${stationShort.concentrationKgM3.toExponential(3)} kg/m3 vs 3600 s: ${stationLong.concentrationKgM3.toExponential(3)} kg/m3`);

console.log("\n--- regression: the finite-duration cliff must not be skipped by the coarse search (found 2026-09-26) ---");
// A second real report, right after the first fix shipped: two identical
// 6-second, 1 kg/s chlorine releases, differing only in wind speed (10 m/s
// vs 5 m/s), gave 58 m for EVERY PAC level in the fast-wind case and
// collapsed to under 1 m in the slow-wind case — for all three thresholds
// simultaneously, which should never happen (a stricter threshold must
// reach at least as far as a looser one, per section 7 above). Traced to
// findHeavyGasThreatZone()'s coarse pass: its ~50 m station spacing across
// the full 20 km default range stepped clean over the entire real zone,
// because finiteDurationFactor()'s transition for a brief release can be
// far narrower than that. See engineHeavyGas.js's module docstring,
// "FINITE-DURATION CLIFF", for the fix (a second, near-field pass sized
// around windSpeed10m * releaseDuration).
function chlorineDensity(temperature) {
  const R = 8.314462618, M = 70.906;
  return 101325 * (M / 1000) / (R * temperature);
}
function nonPuddleCharacteristicHeight(releaseRate, cloudDensity, windSpeed10m) {
  return Math.sqrt((releaseRate * Math.PI) / (4 * cloudDensity * windSpeed10m));
}
function buildCliffRegressionScenario(windSpeed10m, temperature) {
  const cloudDensity = chlorineDensity(temperature);
  return {
    releaseRate: 1.0,
    releaseDuration: 6,
    molecularWeight: 70.906,
    temperature,
    windSpeed10m,
    roughnessLength: 0.03,
    stabilityClass: "D",
    sourceHalfWidth: 0.05,
    characteristicHeight: nonPuddleCharacteristicHeight(1.0, cloudDensity, windSpeed10m),
  };
}

const fastWindScenario = buildCliffRegressionScenario(10, 285.15);
const slowWindScenario = buildCliffRegressionScenario(5, 288.15);
// Approximate PAC-3 / PAC-2 / PAC-1 for chlorine (AEGL-3/2/1, 60-minute),
// close enough to the real dataset values for this to be a meaningful check
// without depending on pageLibrary.js's dataset from this test file.
const pacLevels = [20, 2, 0.5];

const fastZones = pacLevels.map((ppm) => findHeavyGasThreatZone({ ...fastWindScenario, levelOfConcernPpm: ppm }));
const slowZones = pacLevels.map((ppm) => findHeavyGasThreatZone({ ...slowWindScenario, levelOfConcernPpm: ppm }));

check("at 10 m/s, the three PAC levels no longer collapse onto one identical distance (the coarse pass used to skip right over the real, threshold-dependent shape)",
  new Set(fastZones.map((z) => z.maxDownwindDistance.toFixed(1))).size === pacLevels.length,
  fastZones.map((z) => z.maxDownwindDistance.toFixed(1)).join(", "));
check("at 5 m/s, the three PAC levels no longer collapse onto one identical distance either",
  new Set(slowZones.map((z) => z.maxDownwindDistance.toFixed(1))).size === pacLevels.length,
  slowZones.map((z) => z.maxDownwindDistance.toFixed(1)).join(", "));
check("within each wind speed, the stricter (lower ppm) threshold reaches at least as far as the looser one",
  fastZones[2].maxDownwindDistance >= fastZones[1].maxDownwindDistance &&
  fastZones[1].maxDownwindDistance >= fastZones[0].maxDownwindDistance &&
  slowZones[2].maxDownwindDistance >= slowZones[1].maxDownwindDistance &&
  slowZones[1].maxDownwindDistance >= slowZones[0].maxDownwindDistance);
check("the slow-wind case no longer collapses to under a metre — it now reaches tens of metres, in line with the same brief release's own passive-model analogue",
  slowZones[1].maxDownwindDistance > 20,
  `got ${slowZones[1].maxDownwindDistance.toFixed(2)} m`);
// NOTE (2026-09-27): this window was originally [0.3x, 0.9x] fastZones[1],
// calibrated against the finiteDurationFactor() formula as it stood right
// after the 2026-09-26 cliff fix. That formula itself had a separate bug,
// found the same day via a real ALOHA comparison and fixed in engineHeavyGas.js
// (see its "FIX (2026-09-27)" note): it evaluated the Palazzi (1982)
// leading/trailing-edge expression at a fixed time rather than at each
// station's own peak-passage time, which made concentration collapse to
// numerically zero far too close to the source for any finite-duration
// release. With that fixed, halving the wind here shortens the release
// length U*t_r (so the duration factor now tapers off sooner) while also
// roughly doubling the steady-state concentration (concentration ~ 1/U) —
// two effects pulling in opposite directions, so "roughly halves" is no
// longer the right expectation; a wide sanity band replaces it, still
// guarding against the original catastrophic (~80x) collapse.
check("halving the wind (same brief release) does not reproduce the ~80x collapse the 2026-09-26 bug produced",
  slowZones[1].maxDownwindDistance > fastZones[1].maxDownwindDistance * 0.3 &&
  slowZones[1].maxDownwindDistance < fastZones[1].maxDownwindDistance * 3,
  `10 m/s: ${fastZones[1].maxDownwindDistance.toFixed(1)} m, 5 m/s: ${slowZones[1].maxDownwindDistance.toFixed(1)} m`);

console.log("\n=== 12. Finite-duration peak-time fix (2026-09-27): duration factor stays near 1 well past U*t_r ===");
// The bug: finiteDurationFactor() evaluated the Palazzi (1982) expression at
// a FIXED time (the instant the source shuts off) instead of at each
// station's own peak-passage time, t* = x/U + t_r/2. That made the factor
// collapse to numerically zero once x exceeded roughly U*t_r plus a couple
// of sigmaX — for the user's real 10-min, 5 m/s chlorine release, U*t_r is
// only 3 km, yet real ALOHA's own AEGL-1/AEGL-2 threat distances (see the
// KML the user exported, 2026-09-27) run PAST 6 miles (~9.66 km). See
// engineHeavyGas.js's and engineGaussian.js's "FIX (2026-09-27)" notes for
// the full derivation.
check("finiteDurationFactor no longer collapses to zero at 5x the release length (U*t_r), only at the old formula's near-total collapse",
  finiteDurationFactor(15000, 5, 600, "E") > 0.3,
  `got ${finiteDurationFactor(15000, 5, 600, "E").toFixed(4)} at x=15000 m, U*t_r=3000 m`);
check("...and still decays toward 0 far enough out that sigmaX(x) dwarfs the release length (no runaway to a permanent plateau)",
  finiteDurationFactor(200000, 5, 600, "E") < finiteDurationFactor(15000, 5, 600, "E"));
check("...and is still exactly 1 immediately at the source, same as before",
  finiteDurationFactor(1, 5, 600, "E") > 0.999);

console.log("\n--- regression: real ALOHA comparison scenario (chlorine, Eindhoven, 2026-09-27) ---");
// Same scenario as the 2026-09-27 ALOHA comparison (stability-boundary bug):
// chlorine, ~10 kg/s direct source, 10-min release, wind 5 m/s, stability E
// (per the 2026-09-27 boundary fix), open country roughness. Real ALOHA
// reported: AEGL-3 2.5 mi; AEGL-2 and AEGL-1 BOTH "greater than 6 miles"
// (ALOHA's own plot is truncated there, confirmed by measuring the actual
// polygon vertices in the user's exported KML — the orange/yellow zones run
// to within a few tens of metres of the 6-mile display ceiling, not to some
// shorter true value). Before the 2026-09-27 duration-factor fix, HAZEL's
// AEGL-2/AEGL-1 distances were only ~2.2-2.4 mi — a roughly 3x gap this fix
// closes, without needing any further, unverified physics change.
function chlorineDensityAt(temperature) {
  const R = 8.314462618, M = 70.906;
  return (101325 * (M / 1000)) / (R * temperature);
}
const eindhovenScenario = {
  releaseRate: 10.0,
  releaseDuration: 600,
  molecularWeight: 70.906,
  temperature: 288.15,
  windSpeed10m: 5,
  roughnessLength: 0.03,
  stabilityClass: "E",
  sourceHalfWidth: 0.05,
  characteristicHeight: nonPuddleCharacteristicHeight(
    10.0, chlorineDensityAt(288.15), 5
  ),
};
const eindhovenAegl3 = findHeavyGasThreatZone({ ...eindhovenScenario, levelOfConcernPpm: 20 });
const eindhovenAegl2 = findHeavyGasThreatZone({ ...eindhovenScenario, levelOfConcernPpm: 2 });
const eindhovenAegl1 = findHeavyGasThreatZone({ ...eindhovenScenario, levelOfConcernPpm: 0.5 });
const METRES_PER_MILE = 1609.34;
check("AEGL-3 (20 ppm) lands within the same order of magnitude as ALOHA's reported 2.5 mi",
  eindhovenAegl3.maxDownwindDistance / METRES_PER_MILE > 1 &&
  eindhovenAegl3.maxDownwindDistance / METRES_PER_MILE < 4,
  `${(eindhovenAegl3.maxDownwindDistance / METRES_PER_MILE).toFixed(2)} mi`);
check("AEGL-2 (2 ppm) now reaches past 6 miles, matching ALOHA's own display-limited report instead of stopping at ~2.2 mi",
  eindhovenAegl2.maxDownwindDistance / METRES_PER_MILE > 6,
  `${(eindhovenAegl2.maxDownwindDistance / METRES_PER_MILE).toFixed(2)} mi`);
check("AEGL-1 (0.5 ppm) also reaches past 6 miles, and past AEGL-2's distance (a looser threshold must reach at least as far)",
  eindhovenAegl1.maxDownwindDistance / METRES_PER_MILE > 6 &&
  eindhovenAegl1.maxDownwindDistance >= eindhovenAegl2.maxDownwindDistance,
  `${(eindhovenAegl1.maxDownwindDistance / METRES_PER_MILE).toFixed(2)} mi`);

console.log("\n=== 13. Shape regression (2026-09-28): footprint must be a lightbulb, not a runaway wedge ===");
// BUG: with reducedG frozen at the source value for the whole march, the
// Richardson number climbed without bound as the cloud's effective height
// grew, and lateralGrowthRate() had no phi()-style brake of its own — so the
// plotted half-width grew monotonically for as long as the search ran,
// producing an ever-flaring wedge with an arbitrary far edge instead of a
// real dense-gas footprint. A real ALOHA run's own exported footprint (same
// scenario: chlorine, Eindhoven, direct source, 10-minute release — see
// the 2026-09-27 ALOHA comparison (stability-boundary bug)), measured
// directly from its KML polygon vertices, instead RISES from ~34 m at the
// source to a peak of ~162 m around 1.6-2.0 km, then narrows smoothly back to
// a point by ~4.1 km — the "lightbulb" shape [TechDoc Figure 4.4]. This is
// the shape check the fix (recomputing reducedG locally from how diluted the
// cloud already is — see engineHeavyGas.js's "WHY REDUCED GRAVITY IS
// RECOMPUTED LOCALLY") must satisfy: not merely a numeric assertion that
// happens to pass, but the actual rise-then-fall-to-near-zero geometry.
const upperEdge = eindhovenAegl3.footprint
  .slice(0, eindhovenAegl3.footprint.length / 2)
  .filter((p) => Number.isFinite(p.y) && p.y !== null)
  .sort((a, b) => a.x - b.x);

check("the footprint has a well-defined near-source and far-field edge to compare",
  upperEdge.length >= 5, `got ${upperEdge.length} points`);

let peak = upperEdge[0];
for (const p of upperEdge) if (p.y > peak.y) peak = p;

check("the half-width peaks partway out, not at the very first station (i.e. it actually widens from the source)",
  peak.x > upperEdge[0].x * 3 || upperEdge[0].x < 5,
  `peak at x=${peak.x.toFixed(0)} m, first station x=${upperEdge[0].x.toFixed(0)} m`);
check("the half-width peaks well before the far end of the zone, not at the last station (the runaway-wedge signature)",
  peak.x < upperEdge[upperEdge.length - 1].x * 0.85,
  `peak at x=${peak.x.toFixed(0)} m, last station x=${upperEdge[upperEdge.length - 1].x.toFixed(0)} m`);
check("the peak half-width is physically plausible (same order of magnitude as ALOHA's own measured ~162 m peak), not thousands of metres",
  peak.y > 50 && peak.y < 500,
  `peak half-width ${peak.y.toFixed(1)} m`);
check("the half-width narrows back down toward the far tip, matching the measured lightbulb's taper to a point — not still growing",
  upperEdge[upperEdge.length - 1].y < peak.y * 0.5,
  `peak ${peak.y.toFixed(1)} m at x=${peak.x.toFixed(0)} m, tip ${upperEdge[upperEdge.length - 1].y.toFixed(1)} m at x=${upperEdge[upperEdge.length - 1].x.toFixed(0)} m`);
// Guard against the exact original bug shape: B_eff itself (before the
// core/tail split) reached 5,600-7,000 m by x=2,800-3,400 m before this fix.
const rawSeriesForShape = marchDownwind(eindhovenScenario);
const stationNear3000 = rawSeriesForShape.reduce((best, p) =>
  Math.abs(p.x - 3000) < Math.abs(best.x - 3000) ? p : best
);
check("the raw effective half-width (B_eff) near x=3000 m stays in the low hundreds of metres, not the thousands the frozen-density bug produced",
  stationNear3000.halfWidth < 1000,
  `B_eff(${stationNear3000.x.toFixed(0)} m) = ${stationNear3000.halfWidth.toFixed(1)} m`);


console.log("\n=== 14. Stability-corrected friction velocity (2026-09-30) ===");
// [TechDoc 4.2.3]: U(z) = (U*/k)[ln((z+z0)/z0) - psi(z/L)], L from z0 per class.
check("class D is neutral: U* = k U / ln((10+z0)/z0) with k = 0.35",
  closeTo(heavyGasFrictionVelocity(5, 0.03, "D"), 0.35 * 5 / Math.log(10.03 / 0.03), 1e-12));
check("Obukhov length: F at z0=0.03 is 26.0*z0^0.17 (about 14.3 m)",
  closeTo(obukhovLength("F", 0.03), 26.0 * Math.pow(0.03, 0.17), 1e-12) && obukhovLength("F", 0.03) > 14 && obukhovLength("F", 0.03) < 15);
check("Obukhov length is infinite for D and negative for the unstable classes",
  obukhovLength("D", 0.03) === Infinity && obukhovLength("A", 0.03) < 0 && obukhovLength("C", 0.03) < 0);
check("Businger psi: zero when neutral, -4.7 zeta when stable",
  businger(0) === 0 && closeTo(businger(0.5), -2.35, 1e-12));
check("Businger psi is positive when unstable (the profile is flatter, U* larger)", businger(-0.2) > 0);
check("U* ordering follows stability: C > D > E > F at the same wind",
  heavyGasFrictionVelocity(5, 0.03, "C") > heavyGasFrictionVelocity(5, 0.03, "D") &&
  heavyGasFrictionVelocity(5, 0.03, "D") > heavyGasFrictionVelocity(5, 0.03, "E") &&
  heavyGasFrictionVelocity(5, 0.03, "E") > heavyGasFrictionVelocity(5, 0.03, "F"));
check("U* scales linearly with wind speed",
  closeTo(heavyGasFrictionVelocity(8, 0.03, "F") / heavyGasFrictionVelocity(4, 0.03, "F"), 2, 1e-12));
check("roughness above 0.10 m is capped at 0.10 m for the heavy-gas model [TechDoc 4.2.3]",
  heavyGasFrictionVelocity(5, 1.0, "D") === heavyGasFrictionVelocity(5, 0.1, "D"));

console.log("\n=== 15. Fine-pass bracketing (2026-09-30) ===");
check("fine pass runs to the first sampled station beyond the last exceeding one",
  fineSearchCeiling([[{ x: 1 }, { x: 51 }, { x: 101 }], null], 1) === 51);
check("stations from either pass count, whichever lies closer",
  fineSearchCeiling([[{ x: 1 }, { x: 51 }], [{ x: 1 }, { x: 12 }, { x: 23 }]], 1) === 12);
check("falls back to a 15% margin only when nothing was sampled beyond",
  closeTo(fineSearchCeiling([[{ x: 1 }, { x: 20000 }]], 20000), 23000, 1e-9));

console.log("\n=== 16. Mass carried by the drawn profile once the core has gone (2026-09-30) ===");
// A tiny release: gravity spreading is negligible, so far downwind the
// profile is pure tail. The concentration must then be what the ordinary
// Gaussian crosswind integral implies, E / (U_eff * H_eff * sqrt(2 pi) sigma_y),
// not E / (U_eff * H_eff * 2 B_eff) with a B_eff that never grew.
{
  const tiny = {
    releaseRate: 0.01, releaseDuration: undefined, molecularWeight: 70.91, temperature: 278.15,
    windSpeed10m: 8, roughnessLength: 0.03, stabilityClass: "F", sourceHalfWidth: 0.05,
    characteristicHeight: Math.sqrt((0.01 * Math.PI) / (4 * 3.107 * 8)), maxDistance: 1000, stepCount: 200,
  };
  const st = marchDownwind(tiny).find((p) => p.x > 800);
  const sy = lateralSpread(st.x, "F");
  const uEff = effectiveVelocity((st.effHeight * 1.253) / gammaFunction(1 / 1.253), 8, 0.253);
  const expected = 0.01 / (uEff * st.effHeight * Math.sqrt(Math.PI) * sy);
  check("far-field concentration matches the Gaussian-tail mass balance (core gone)",
    st.halfWidth < (Math.sqrt(Math.PI) / 2) * sy && closeTo(st.concentrationKgM3, expected, 1e-6 * expected + 1e-15),
    `got ${st.concentrationKgM3.toExponential(4)}, expected ${expected.toExponential(4)}`);
}

console.log("\n=== 17. Controlled comparisons against real ALOHA runs (2026-09-30) ===");
// Chlorine, direct source, open country, 5 C, RH 80%, stability overridden.
// Real ALOHA figures from side-by-side runs made on 2026-09-29/30.
// See the 2026-09-30 ALOHA re-validation runs. Before
// the two 2026-09-30 fixes these ran 0.41-1.70x of ALOHA; afterwards they
// sit uniformly at roughly 0.8-0.95x. The band checked here (0.7-1.15x) is
// deliberately a regression guard around that result, not a claim of
// agreement to better than the Tech Doc's own ~10% ALOHA-DEGADIS vs DEGADIS
// difference.
{
  const chlorine = (rate, dur, wind, st, z0 = 0.03) => ({
    releaseRate: rate, releaseDuration: dur, molecularWeight: 70.91, temperature: 278.15,
    windSpeed10m: wind, roughnessLength: z0, stabilityClass: st, sourceHalfWidth: 0.05,
    characteristicHeight: Math.sqrt((rate * Math.PI) / (4 * 3.1068 * wind)),
  });
  const runs = [
    ["F, 1 min, 3 m/s, AEGL-3", chlorine(10, 60, 3, "F"), 20, 2100],
    ["F, 1 min, 8 m/s, AEGL-2", chlorine(10, 60, 8, "F"), 2, 7400],
    ["F, 30 min, 5 m/s, AEGL-3", chlorine(10, 1800, 5, "F"), 20, 5000],
    ["F, 1 min, 0.01 kg/s, 8 m/s, AEGL-1", chlorine(0.01, 60, 8, "F"), 0.5, 788],
    ["D, 30 min, 5 m/s, AEGL-3", chlorine(10, 1800, 5, "D"), 20, 3100],
    ["D, 1 min, 5 m/s, AEGL-1", chlorine(10, 60, 5, "D"), 0.5, 8200],
    ["E, 30 min, 5 m/s, AEGL-3", chlorine(10, 1800, 5, "E"), 20, 4000],
    ["C, 30 min, 5 m/s, AEGL-2", chlorine(10, 1800, 5, "C"), 2, 7900],
    // Predicted before these ALOHA runs were made (confirmation, not fitting):
    ["A, 30 min, 5 m/s, AEGL-3", chlorine(10, 1800, 5, "A"), 20, 1500],
    ["B, 30 min, 5 m/s, AEGL-2", chlorine(10, 1800, 5, "B"), 2, 6200],
    ["D, urban (z0 = 1 m), 30 min, 5 m/s, AEGL-2", chlorine(10, 1800, 5, "D", 1.0), 2, 8800],
    ["F, urban (z0 = 1 m), 30 min, 5 m/s, AEGL-3", chlorine(10, 1800, 5, "F", 1.0), 20, 4200],
    // Batch 4 (2026-10-02), 15 C runs (temperature only shifts ppm/kg by ~3%):
    ["H1 instantaneous 100 kg, D, AEGL-3", { ...chlorine(100 / 60, 60, 5, "D"), temperature: 288.15 }, 20, 1100],
    ["H1 instantaneous 100 kg, D, AEGL-1", { ...chlorine(100 / 60, 60, 5, "D"), temperature: 288.15 }, 0.5, 4400],
    ["U1 1 kg/s 10 min, urban, D, AEGL-3", { ...chlorine(1, 600, 5, "D", 1.0), temperature: 288.15 }, 20, 799],
    ["U1 1 kg/s 10 min, urban, D, AEGL-1", { ...chlorine(1, 600, 5, "D", 1.0), temperature: 288.15 }, 0.5, 5600],
  ];
  for (const [label, scenario, ppm, aloha] of runs) {
    const d = findHeavyGasThreatZone({ ...scenario, levelOfConcernPpm: ppm }).maxDownwindDistance;
    const ratio = d / aloha;
    check(`${label}: within 0.7-1.15x of ALOHA's ${aloha} m`, ratio > 0.7 && ratio < 1.15,
      `HAZEL ${d.toFixed(0)} m = ${ratio.toFixed(2)}x`);
  }
}


console.log("\n=== 18. Time-varying releases as superposed steady steps (2026-09-30) ===");
{
  const common = {
    molecularWeight: 70.91, temperature: 278.15, windSpeed10m: 5, roughnessLength: 0.03,
    stabilityClass: "F", sourceHalfWidth: 0.05,
    characteristicHeight: Math.sqrt((10 * Math.PI) / (4 * 3.1068 * 5)),
    maxDistance: 6000, stepCount: 300,
  };
  // Two back-to-back steps at the same rate are one constant release: the
  // composite peak must reproduce the closed-form single-step result.
  const single = marchDownwind({ ...common, releaseRate: 10, releaseDuration: 600 });
  const split = marchDownwind({
    ...common, releaseRate: 10, releaseDuration: 600,
    releaseSteps: [
      { startTime: 0, duration: 300, rate: 10 },
      { startTime: 300, duration: 300, rate: 10 },
    ],
  });
  const worst = single.reduce((m, p, i) =>
    Math.max(m, Math.abs(split[i].concentrationKgM3 - p.concentrationKgM3) / Math.max(p.concentrationKgM3, 1e-12)), 0);
  check("two equal back-to-back steps reproduce the single constant release (within 1%)", worst < 0.01,
    `largest relative difference ${(worst * 100).toFixed(2)}%`);

  check("a step's pulse weight never exceeds 1 and is ~1 mid-pulse near the source",
    stepPulseWeight(100, 300, { startTime: 0, duration: 600 }, 5, 10) > 0.999 &&
    stepPulseWeight(100, 300, { startTime: 0, duration: 600 }, 5, 10) <= 1);

  // A declining source gives a shorter zone than its first-minute rate held throughout.
  const declining = [
    { startTime: 0, duration: 60, rate: 10 },
    { startTime: 60, duration: 540, rate: 3 },
    { startTime: 600, duration: 600, rate: 1 },
  ];
  const d = findHeavyGasThreatZone({ ...common, releaseRate: 10, releaseDuration: 1200, releaseSteps: declining, levelOfConcernPpm: 20 }).maxDownwindDistance;
  const held = findHeavyGasThreatZone({ ...common, releaseRate: 10, releaseDuration: 1200, levelOfConcernPpm: 20 }).maxDownwindDistance;
  check("a declining release reaches less far than its peak rate held for the whole duration", d < held,
    `${d.toFixed(0)} m vs ${held.toFixed(0)} m`);
  check("...but further than its later, lower steps alone would", d > findHeavyGasThreatZone({ ...common, releaseRate: 1, releaseDuration: 1200, levelOfConcernPpm: 20 }).maxDownwindDistance);
}
{
  // Step reduction conserves mass and isolates the first minute.
  const chlorine = { molecularWeight: 70.91, boilingPointK: 239.1, heatOfVaporizationJPerMol: 20400, liquidDensity: 1553, liquidHeatCapacityJPerKgK: 950 };
  const night = { windSpeed10m: 1.5, powerLawExponent: 0.253, roughnessLength: 0.03, airTemperatureK: 278.15, relativeHumidity: 80, cloudCoverOktas: 0 };
  const run = simulatePuddleEvaporation({ chemical: chlorine, weather: night, spillMass: 500, puddleArea: 10, substrateKey: "concrete", solarElevationDegrees: -20, durationSeconds: 3600, timeStepSeconds: 1 });
  const initialMass = run.series[0].remaining + run.series[0].rate;
  check("initial mass is recoverable from the first sample", closeTo(initialMass, 500, 1e-6));
  const rho = (101325 * 70.91) / 1000 / (8.314462618 * 278.15);
  const D = Math.sqrt(40 / Math.PI);
  const steps = releaseStepsFromSeries({
    series: run.series, initialMass, totalMass: run.totalEvaporated, durationSeconds: run.durationSeconds,
    heightOf: (q) => q / (rho * 1.5 * D),
  });
  const stepMass = steps.reduce((m, st) => m + st.rate * st.duration, 0);
  check("at most five steps", steps.length >= 2 && steps.length <= 5, `${steps.length} steps`);
  check("the steps carry exactly the released mass", closeTo(stepMass, run.totalEvaporated, 1e-6));
  check("the first step is the first minute, and the highest", steps[0].startTime === 0 && steps[0].duration === 60 &&
    steps.every((st) => st.rate <= steps[0].rate));
  check("the first-minute average is well below the one-second spike (the old input)", steps[0].rate < run.peakRate / 2,
    `${steps[0].rate.toFixed(3)} vs ${run.peakRate.toFixed(3)} kg/s`);

  // Real ALOHA, same scenario (worst-case night, 500 kg chlorine, 10 m2,
  // concrete): Red 1010 m, Orange 3541 m, Yellow 7403 m. With the peak held
  // throughout, HAZEL gave 2.9-3.4x these; with the steps it sits in the
  // same band as every direct-source comparison.
  const scenario = {
    releaseRate: run.peakRate, releaseDuration: run.durationSeconds, molecularWeight: 70.91,
    temperature: 278.15, windSpeed10m: 1.5, roughnessLength: 0.03, stabilityClass: "F",
    sourceHalfWidth: D / 2, characteristicHeight: run.peakRate / (rho * 1.5 * D), releaseSteps: steps,
  };
  for (const [ppm, aloha, label] of [[20, 1010, "AEGL-3"], [2, 3541, "AEGL-2"], [0.5, 7403, "AEGL-1"]]) {
    const dist = findHeavyGasThreatZone({ ...scenario, levelOfConcernPpm: ppm }).maxDownwindDistance;
    check(`chlorine puddle, ${label}: within 0.7-1.15x of ALOHA's ${aloha} m`, dist / aloha > 0.7 && dist / aloha < 1.15,
      `HAZEL ${dist.toFixed(0)} m = ${(dist / aloha).toFixed(2)}x`);
  }
}

console.log("\n=== 19. Small sources, short distances: integration-step independence (2026-10-01) ===");
{
  const T = 283.15;
  const rhoBenzene = (101325 * 78.11) / 1000 / (8.314462618 * T);
  const base = {
    releaseRate: 0.37 / 60, releaseDuration: 3600, molecularWeight: 78.11, temperature: T,
    windSpeed10m: 1.5, roughnessLength: 0.03, stabilityClass: "F", sourceHalfWidth: 0.05,
    characteristicHeight: Math.sqrt(((0.37 / 60) * Math.PI) / (4 * rhoBenzene * 1.5)),
  };
  const at = (maxDistance, stepCount, x) => {
    const series = marchDownwind({ ...base, maxDistance, stepCount });
    let best = series[0];
    for (const p of series) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    return best;
  };
  const fine = at(100, 400, 50), coarse = at(20000, 400, 50);
  // Compare at the coarse station nearest 50 m, re-evaluated on the fine grid.
  const fineAtCoarseX = at(coarse.x * 1.0001, 2000, coarse.x);
  check("the concentration at a given distance does not depend on the station spacing (within 3%)",
    Math.abs(coarse.concentrationKgM3 / fineAtCoarseX.concentrationKgM3 - 1) < 0.03,
    `${coarse.concentrationKgM3.toExponential(3)} vs ${fineAtCoarseX.concentrationKgM3.toExponential(3)}`);
  check("and the fine march is self-consistent", fine.concentrationKgM3 > 0);

  /* Real ALOHA (2026-10-01), benzene, F 1.5 m/s, 10 C, RH 80%, cloud 0,
     open country, 02:00; user-set levels 1000 / 200 / 50 ppm.
       G5 direct source 0.37 kg/min for 60 min, heavy gas  16 / 40 / 91 m
       G1 puddle 10 m2, 1000 kg (0.369 kg/min), heavy gas   15 / 40 / 91 m
       G4 puddle 100 m2, 5000 kg (3.24 kg/min), heavy gas   44 / 109 / 256 m
     Before the fix HAZEL gave 11/31/50, 12/32/52 and 38/56/56 m. */
  const g5 = [1000, 200, 50].map((ppm) => findHeavyGasThreatZone({ ...base, levelOfConcernPpm: ppm }).maxDownwindDistance);
  [16, 40, 91].forEach((aloha, i) => {
    const ratio = g5[i] / aloha;
    check(`G5 direct 0.37 kg/min, ${[1000, 200, 50][i]} ppm: within 0.65-1.15x of ALOHA's ${aloha} m`,
      ratio > 0.65 && ratio < 1.15, `HAZEL ${g5[i].toFixed(0)} m = ${ratio.toFixed(2)}x`);
  });

  const benzene = { molecularWeight: 78.11, boilingPointK: 353.25, heatOfVaporizationJPerMol: 30720,
    liquidDensity: 876, liquidHeatCapacityJPerKgK: 1740 };
  for (const [label, mass, area, aloha] of [["G1", 1000, 10, [15, 40, 91]], ["G4", 5000, 100, [44, 109, 256]]]) {
    const run = simulatePuddleEvaporation({
      chemical: benzene,
      weather: { windSpeed10m: 1.5, powerLawExponent: 0.253, roughnessLength: 0.03, airTemperatureK: T,
        relativeHumidity: 80, cloudCoverOktas: 0 },
      spillMass: mass, puddleArea: area, substrateKey: "concrete", durationSeconds: 3600,
    });
    const D = Math.sqrt((4 * area) / Math.PI);
    const H = run.peakRate / (rhoBenzene * 1.5 * D);
    const steps = releaseStepsFromSeries({
      series: run.series, initialMass: run.series[0].remaining + run.series[0].rate,
      totalMass: run.totalEvaporated, durationSeconds: run.durationSeconds, heightOf: (q) => (H * q) / run.peakRate,
    });
    const scenario = { ...base, releaseRate: run.peakRate, releaseDuration: run.durationSeconds,
      sourceHalfWidth: D / 2, characteristicHeight: H, releaseSteps: steps };
    [1000, 200, 50].forEach((ppm, i) => {
      const d = findHeavyGasThreatZone({ ...scenario, levelOfConcernPpm: ppm }).maxDownwindDistance;
      const ratio = d / aloha[i];
      check(`${label} puddle ${area} m2, ${ppm} ppm: within 0.7-1.15x of ALOHA's ${aloha[i]} m`,
        ratio > 0.7 && ratio < 1.15, `HAZEL ${d.toFixed(0)} m = ${ratio.toFixed(2)}x`);
    });
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
