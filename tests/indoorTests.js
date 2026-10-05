/**
 * indoorTests.js
 * --------------
 * Verification for engineIndoor.js: the building-leakage estimate of the
 * infiltration time constant, and the R-C filter concentration model
 * itself. Run with:
 *   node tests/indoorTests.js
 *
 * Where possible these check a formula's PROPERTIES (scales linearly,
 * scales as a square root, is zero when an input is zero, matches the Tech
 * Doc's own stated definition) rather than a single hand-computed number —
 * the safer form of verification when a source formula's own transcription
 * has already turned out to be wrong once elsewhere in this project (see
 * engineJetFire.js's module docstring).
 */

import {
  LEAKAGE_AREA_FRACTION,
  DEFAULT_FLOOR_AREA_M2,
  effectiveLeakageArea,
  stackParameter,
  stackDrivenFlow,
  windDrivenFlow,
  infiltrationTimeConstant,
  estimateInfiltrationTimeConstant,
  validateBuildingParameters,
  effectiveExposureDurationSeconds,
  STORY_CEILING_HEIGHTS_M,
  indoorConcentrationDuringExposure,
  peakIndoorConcentration,
  indoorConcentrationAfterExposure,
  indoorConcentrationAtTime,
} from "../js/engine/engineIndoor.js";
import { peakConcentration, massConcentrationToPpm, logProfileWindSpeed } from "../js/engine/engineGaussian.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
function close(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
}

console.log("\n=== 1. Effective leakage area ===");
check(
  "160 m^2 gives AE = 0.00059 * 160 exactly",
  close(effectiveLeakageArea(160), LEAKAGE_AREA_FRACTION * 160)
);
check(
  "scales linearly with floor area",
  close(effectiveLeakageArea(320), 2 * effectiveLeakageArea(160))
);
check("rejects zero or negative floor area", (() => {
  try { effectiveLeakageArea(0); return false; } catch { return true; }
})());

console.log("\n=== 2. Stack parameter and stack-driven flow ===");
const fsBase = stackParameter({ structureHeightM: 2.5, internalTemperatureK: 293.15 });
check("stack parameter is positive and finite", Number.isFinite(fsBase) && fsBase > 0);
check(
  "a taller structure gives a larger stack parameter",
  stackParameter({ structureHeightM: 5.0, internalTemperatureK: 293.15 }) > fsBase
);
check(
  "a higher internal temperature gives a smaller stack parameter",
  stackParameter({ structureHeightM: 2.5, internalTemperatureK: 320 }) < fsBase
);

const AE = effectiveLeakageArea(160);
check("stack-driven flow is zero when there is no temperature difference", (() => {
  const q = stackDrivenFlow({
    effectiveLeakageAreaM2: AE, structureHeightM: 2.5,
    internalTemperatureK: 293.15, outdoorTemperatureK: 293.15,
  });
  return close(q, 0, 1e-9);
})());
check("stack-driven flow scales as sqrt(deltaT): quadrupling dT doubles the flow", (() => {
  const q1 = stackDrivenFlow({
    effectiveLeakageAreaM2: AE, structureHeightM: 2.5,
    internalTemperatureK: 293.15, outdoorTemperatureK: 283.15, // dT = 10
  });
  const q2 = stackDrivenFlow({
    effectiveLeakageAreaM2: AE, structureHeightM: 2.5,
    internalTemperatureK: 293.15, outdoorTemperatureK: 253.15, // dT = 40
  });
  return close(q2, 2 * q1, 1e-6);
})());
check("stack-driven flow does not care about the sign of the temperature difference", (() => {
  const qColder = stackDrivenFlow({
    effectiveLeakageAreaM2: AE, structureHeightM: 2.5,
    internalTemperatureK: 293.15, outdoorTemperatureK: 283.15,
  });
  const qWarmer = stackDrivenFlow({
    effectiveLeakageAreaM2: AE, structureHeightM: 2.5,
    internalTemperatureK: 293.15, outdoorTemperatureK: 303.15,
  });
  return close(qColder, qWarmer);
})());

console.log("\n=== 3. Wind-driven flow ===");
check("wind-driven flow is zero at zero wind speed", close(
  windDrivenFlow({ effectiveLeakageAreaM2: AE, windSpeedAtStructureHeight: 0, sheltering: "unsheltered" }), 0
));
check("wind-driven flow scales linearly with wind speed", (() => {
  const q1 = windDrivenFlow({ effectiveLeakageAreaM2: AE, windSpeedAtStructureHeight: 2, sheltering: "unsheltered" });
  const q2 = windDrivenFlow({ effectiveLeakageAreaM2: AE, windSpeedAtStructureHeight: 4, sheltering: "unsheltered" });
  return close(q2, 2 * q1);
})());
check("an unsheltered building infiltrates more from wind than a sheltered one", (() => {
  const sheltered = windDrivenFlow({ effectiveLeakageAreaM2: AE, windSpeedAtStructureHeight: 3, sheltering: "sheltered" });
  const unsheltered = windDrivenFlow({ effectiveLeakageAreaM2: AE, windSpeedAtStructureHeight: 3, sheltering: "unsheltered" });
  return unsheltered > sheltered;
})());
check("rejects an unknown sheltering category", (() => {
  try { windDrivenFlow({ effectiveLeakageAreaM2: AE, windSpeedAtStructureHeight: 3, sheltering: "cosy" }); return false; }
  catch { return true; }
})());

console.log("\n=== 4. Infiltration time constant ===");
check("combines stack and wind flow as sqrt(sum of squares) — a 3-4-5 triangle", (() => {
  // volume 100, stack flow 3 m^3/s, wind flow 4 m^3/s -> total flow 5 m^3/s -> tau = 20 s
  const tau = infiltrationTimeConstant({ buildingVolumeM3: 100, stackFlowM3PerS: 3, windFlowM3PerS: 4 });
  return close(tau, 20);
})());
check("a larger building has a larger time constant at the same flows", (() => {
  const small = infiltrationTimeConstant({ buildingVolumeM3: 100, stackFlowM3PerS: 3, windFlowM3PerS: 4 });
  const large = infiltrationTimeConstant({ buildingVolumeM3: 400, stackFlowM3PerS: 3, windFlowM3PerS: 4 });
  return large > small && close(large, 4 * small);
})());
check("rejects zero flow (nothing to divide by)", (() => {
  try { infiltrationTimeConstant({ buildingVolumeM3: 100, stackFlowM3PerS: 0, windFlowM3PerS: 0 }); return false; }
  catch { return true; }
})());

console.log("\n=== 5. estimateInfiltrationTimeConstant — a realistic composed example ===");
const estimate = estimateInfiltrationTimeConstant({
  floorAreaM2: DEFAULT_FLOOR_AREA_M2,
  stories: 1,
  outdoorTemperatureK: 283.15, // 10 C, a 10-degree indoor/outdoor difference
  windSpeedAtStructureHeight: 3,
  sheltering: "unsheltered",
});
check("returns a positive, finite time constant", Number.isFinite(estimate.tauSeconds) && estimate.tauSeconds > 0);
check(
  "falls within the Tech Doc's own stated typical range (roughly 0.1 to 1 hour, with some margin)",
  estimate.tauSeconds >= 60 && estimate.tauSeconds <= 3 * 3600,
  `got ${(estimate.tauSeconds / 60).toFixed(1)} minutes`
);
check("a two-story building of the same footprint has more volume than a one-story one", (() => {
  const oneStory = estimateInfiltrationTimeConstant({
    floorAreaM2: 160, stories: 1, outdoorTemperatureK: 283.15, windSpeedAtStructureHeight: 3,
  });
  const twoStory = estimateInfiltrationTimeConstant({
    floorAreaM2: 160, stories: 2, outdoorTemperatureK: 283.15, windSpeedAtStructureHeight: 3,
  });
  return twoStory.buildingVolumeM3 > oneStory.buildingVolumeM3;
})());

console.log("\n=== 6. validateBuildingParameters ===");
check("accepts a sensible set of parameters", validateBuildingParameters({
  floorAreaM2: 160, stories: 1, internalTemperatureK: 293.15, outdoorTemperatureK: 283.15,
  windSpeedAtStructureHeight: 3,
}).length === 0);
check("rejects a negative floor area", validateBuildingParameters({
  floorAreaM2: -10, stories: 1, internalTemperatureK: 293.15, outdoorTemperatureK: 283.15,
  windSpeedAtStructureHeight: 3,
}).length > 0);
check("rejects a number of stories other than 1 or 2", validateBuildingParameters({
  floorAreaM2: 160, stories: 3, internalTemperatureK: 293.15, outdoorTemperatureK: 283.15,
  windSpeedAtStructureHeight: 3,
}).length > 0);
check("rejects a non-finite outdoor temperature", validateBuildingParameters({
  floorAreaM2: 160, stories: 1, internalTemperatureK: 293.15, outdoorTemperatureK: NaN,
  windSpeedAtStructureHeight: 3,
}).length > 0);

console.log("\n=== 7. Indoor concentration — charging phase ===");
check("zero at t=0", indoorConcentrationDuringExposure(0, 100, 600) === 0);
check(
  "reaches 63.2% of the outdoor value after exactly one time constant — the Tech Doc's own definition of tau_E",
  close(indoorConcentrationDuringExposure(600, 100, 600), 100 * (1 - Math.exp(-1)), 1e-9)
);
check(
  "approaches the outdoor value for a very long exposure, never overshooting it",
  (() => {
    const c = indoorConcentrationDuringExposure(1000 * 600, 100, 600);
    return c <= 100 && c > 99.999;
  })()
);
check(
  "a short exposure relative to tau leaves indoor concentration well below outdoor",
  indoorConcentrationDuringExposure(60, 100, 600) < 20 // t = tau/10
);
check("rejects a zero or negative time constant", (() => {
  try { indoorConcentrationDuringExposure(100, 50, 0); return false; }
  catch { return true; }
})());

console.log("\n=== 8. Peak indoor concentration ===");
check(
  "peak equals the charging value evaluated at the end of the exposure",
  close(
    peakIndoorConcentration(100, 900, 600),
    indoorConcentrationDuringExposure(900, 100, 600)
  )
);
check(
  "a longer exposure (more time to fill up) gives a higher peak, all else equal",
  peakIndoorConcentration(100, 1800, 600) > peakIndoorConcentration(100, 300, 600)
);
check(
  "peak never exceeds the outdoor concentration it is drawn from",
  peakIndoorConcentration(100, 100000, 600) <= 100
);

console.log("\n=== 9. Discharging phase, and continuity between the two phases ===");
check(
  "no jump at the exposure boundary — indoorConcentrationAtTime is continuous there",
  close(
    indoorConcentrationAtTime(900, 100, 900, 600),
    peakIndoorConcentration(100, 900, 600),
    1e-9
  )
);
check(
  "decays to 36.8% of the peak (1/e) one time constant after the exposure ends",
  (() => {
    const peak = peakIndoorConcentration(100, 900, 600);
    const afterOneTau = indoorConcentrationAfterExposure(900 + 600, 100, 900, 600);
    return close(afterOneTau, peak * Math.exp(-1), 1e-9);
  })()
);
check(
  "decays toward zero for a long time after the exposure",
  indoorConcentrationAfterExposure(900 + 100 * 600, 100, 900, 600) < 0.001
);
check(
  "indoorConcentrationAtTime matches indoorConcentrationDuringExposure before the exposure ends",
  close(
    indoorConcentrationAtTime(300, 100, 900, 600),
    indoorConcentrationDuringExposure(300, 100, 600)
  )
);
check(
  "indoorConcentrationAtTime matches indoorConcentrationAfterExposure after the exposure ends",
  close(
    indoorConcentrationAtTime(1500, 100, 900, 600),
    indoorConcentrationAfterExposure(1500, 100, 900, 600)
  )
);

console.log("\n=== 10. Effective exposure duration — along-wind residence correction (fixed 2026-09-26) ===");
// the 2026-09-26 duration review finding #4: feeding
// peakIndoorConcentration() the release duration alone understated indoor
// exposure by up to ~37x for a brief release observed far downwind, because
// a passing puff's true residence time at a fixed point grows with
// along-wind spreading (sigma_x), not with the release duration itself.
check(
  "a missing release duration falls back to one hour, unchanged from before",
  effectiveExposureDurationSeconds({
    releaseDuration: undefined, downwindDistance: 1000, windSpeed10m: 3, stabilityClass: "D",
  }) === 3600
);
check(
  "the corrected duration is never shorter than the release duration itself",
  (() => {
    const d = effectiveExposureDurationSeconds({
      releaseDuration: 6, downwindDistance: 3000, windSpeed10m: 2, stabilityClass: "F",
    });
    return d >= 6;
  })()
);
check(
  "a brief release far downwind gets a substantially longer effective duration than the raw release duration",
  (() => {
    const d = effectiveExposureDurationSeconds({
      releaseDuration: 6, downwindDistance: 3000, windSpeed10m: 2, stabilityClass: "F",
    });
    return d > 6 * 10; // order-of-magnitude correction, matching the audit's own finding
  })()
);
check(
  "the correction grows with downwind distance (sigma_x grows with x)",
  (() => {
    const near = effectiveExposureDurationSeconds({
      releaseDuration: 6, downwindDistance: 200, windSpeed10m: 2, stabilityClass: "F",
    });
    const far = effectiveExposureDurationSeconds({
      releaseDuration: 6, downwindDistance: 3000, windSpeed10m: 2, stabilityClass: "F",
    });
    return far > near;
  })()
);
check(
  "a genuinely long release sees only a small correction relative to its own duration",
  (() => {
    const d = effectiveExposureDurationSeconds({
      releaseDuration: 600, downwindDistance: 1000, windSpeed10m: 2, stabilityClass: "F",
    });
    return d < 600 * 2; // nowhere near the >10x seen for a brief release
  })(),
);
check(
  "a longer effective duration produces a higher (never lower) peak indoor concentration",
  (() => {
    const shortWay = peakIndoorConcentration(100, 6, 900);
    const correctedWay = peakIndoorConcentration(
      100,
      effectiveExposureDurationSeconds({ releaseDuration: 6, downwindDistance: 3000, windSpeed10m: 2, stabilityClass: "F" }),
      900
    );
    return correctedWay >= shortWay;
  })()
);
check(
  "zero or missing wind speed / distance falls back to the release duration, rather than dividing by zero",
  effectiveExposureDurationSeconds({
    releaseDuration: 6, downwindDistance: 0, windSpeed10m: 2, stabilityClass: "F",
  }) === 6 &&
  effectiveExposureDurationSeconds({
    releaseDuration: 6, downwindDistance: 1000, windSpeed10m: 0, stabilityClass: "F",
  }) === 6
);


console.log("\n=== 11. Against ALOHA's printed air-exchange rates and indoor values (2026-10-02) ===");
/* Ammonia direct 1 kg/s, 60 min, open country; building on the centreline
   500 m downwind. ALOHA prints the air changes per hour it uses. */
{
  const T15 = 288.15;
  const outdoor = massConcentrationToPpm(peakConcentration({ releaseRate: 1, releaseDuration: 3600, releaseHeight: 0,
    roughnessLength: 0.03, temperature: T15, molecularWeight: 17.03, windSpeed10m: 5, stabilityClass: "D", x: 500, y: 0, z: 0 }), 17.03, T15);
  const dur = effectiveExposureDurationSeconds({ releaseDuration: 3600, downwindDistance: 500, windSpeed10m: 5, stabilityClass: "D" });
  for (const [label, stories, sheltering, u, cls, tOut, alohaAch, alohaIndoor] of [
    ["B1 single storey, unsheltered, 5 m/s D", 1, "unsheltered", 5, "D", T15, 0.85, 70.6],
    ["B2 double storey, sheltered, 5 m/s D", 2, "sheltered", 5, "D", T15, 0.39, 39.4],
    ["W1 double storey, sheltered, 1.5 m/s F, 10 C", 2, "sheltered", 1.5, "F", 283.15, 0.24, null],
    ["I0 double storey, sheltered, 5 m/s E", 2, "sheltered", 5, "E", T15, 0.37, null],
  ]) {
    const h = STORY_CEILING_HEIGHTS_M[stories];
    const b = estimateInfiltrationTimeConstant({ floorAreaM2: 160, stories, structureHeightM: h, internalTemperatureK: 293.15,
      outdoorTemperatureK: tOut, windSpeedAtStructureHeight: logProfileWindSpeed(u, h, 0.03, cls), sheltering });
    const ach = 3600 / b.tauSeconds;
    check(`${label}: air changes within 4% of ALOHA's ${alohaAch}/h`, Math.abs(ach / alohaAch - 1) < 0.04, `${ach.toFixed(3)}/h`);
    if (alohaIndoor !== null) {
      const indoor = peakIndoorConcentration(outdoor, dur, b.tauSeconds);
      check(`${label}: indoor peak within 0.95-1.06x of ALOHA's ${alohaIndoor} ppm`,
        indoor / alohaIndoor > 0.95 && indoor / alohaIndoor < 1.06, `${indoor.toFixed(1)} ppm`);
    }
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
