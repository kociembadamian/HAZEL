/**
 * resultsIntegrationTests.js
 * --------------------------
 * Verification that stepResults.js's computeZones() routes to the correct
 * dispersion engine and builds a scenario object that engine can actually
 * use. Run with:  node tests/resultsIntegrationTests.js
 *
 * Both engines are already tested thoroughly on their own (engineTests.js,
 * heavyGasTests.js). What is NOT covered anywhere else is the wiring
 * between them and the rest of the scenario — computeZones() is where a
 * mismatched field name (windSpeed vs windSpeed10m, say) would silently
 * produce NaN or an empty zone rather than an error, since JavaScript does
 * not complain about a missing object property until something tries to use
 * it numerically. This file constructs full, realistic scenarios directly
 * in state.js and checks that computeZones() reaches the "ok" status with
 * sensible, non-empty results for both engines — no DOM required, since
 * computeZones() only reads state and calls pure functions.
 */

import { state } from "../js/ui/state.js";
import { computeZones } from "../js/ui/stepResults.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * Builds a complete scenario in the shape every step module actually
 * produces, so computeZones() sees exactly what it would from a real
 * session — not a hand-trimmed stand-in that might accidentally omit a
 * field the real steps always provide.
 */
function setScenario({ molecularWeight, peakRate, source25CState = "gas" }) {
  state.update({
    scenario: {
      location: { lat: 51.4416, lng: 5.4697, elevation: null },
      chemical: {
        selected: {
          casNumber: "0000-00-0",
          name: "Test substance",
          molecularWeight,
          state25C: source25CState,
          pac1Ppm: 50,
          pac2Ppm: 200,
          pac3Ppm: 800,
          originalUnit: "ppm",
        },
        selectedLevels: ["pac1", "pac2", "pac3"],
      },
      weather: {
        windSpeed: 5,
        windSpeedUnit: "m/s",
        windFromDirection: "SW",
        windMeasurementHeight: 10,
        temperature: 20,
        temperatureUnit: "C",
        cloudCoverOktas: 4,
        relativeHumidity: 60,
        isDaytime: true,
        groundRoughnessPreset: "openCountry",
        customRoughness: 0.03,
        inversionPresent: false,
        inversionHeight: 100,
        stabilityOverride: "",
      },
      source: {
        type: "tank",
        tankShape: "horizontalCylinder",
        tankDiameter: 2,
        tankLength: 6,
        tankFillPercent: 80,
        holeShape: "circular",
        holeDiameter: 0.05,
        holeHeightAboveBottom: 0.1,
        pipeLength: 0,
        result: { peakRate, averageRate: peakRate, durationSeconds: 600, totalMass: peakRate * 600 },
      },
    },
  });
}

console.log("\n=== 1. A near-neutral gas at a modest rate routes to Gaussian ===");
setScenario({ molecularWeight: 29, peakRate: 0.05 });
const gaussianResult = computeZones();
check("status is ok", gaussianResult.status === "ok", `got ${gaussianResult.status}`);
check("the Gaussian engine was selected", gaussianResult.isHeavyGas === false);
check("at least one zone is produced", gaussianResult.zones?.length > 0);
check("the scenario base carries a release duration (Gaussian-specific field)",
  Number.isFinite(gaussianResult.scenarioBase?.releaseDuration));
check("at least one zone footprint is non-empty",
  gaussianResult.zones.some((z) => z.footprint.length > 0),
  "every zone came back empty — check the field names passed into findThreatZone");

console.log("\n=== 2. A dense gas at a large rate routes to the heavy gas engine ===");
setScenario({ molecularWeight: 70.9, peakRate: 10 }); // chlorine-like, substantial release
const heavyResult = computeZones();
check("status is ok", heavyResult.status === "ok", `got ${heavyResult.status}`);
check("the heavy gas engine was selected", heavyResult.isHeavyGas === true);
check("at least one zone is produced", heavyResult.zones?.length > 0);
check("the scenario base carries a source half-width (heavy-gas-specific field)",
  Number.isFinite(heavyResult.scenarioBase?.sourceHalfWidth));
check("the scenario base carries a characteristic height (heavy-gas-specific field)",
  Number.isFinite(heavyResult.scenarioBase?.characteristicHeight));
check("at least one zone footprint is non-empty",
  heavyResult.zones.some((z) => z.footprint.length > 0),
  "every zone came back empty — check the field names passed into findHeavyGasThreatZone");
check("the dispersion verdict explains the Richardson number",
  heavyResult.dispersion?.explanation?.includes("Richardson"));

console.log("\n=== 2b. The user's model choice overrides the automatic one (2026-10-04) ===");
function withOverride(modelOverride) {
  state.update({
    scenario: {
      ...state.current.scenario,
      source: { ...state.current.scenario.source, modelOverride },
    },
  });
  return computeZones();
}
setScenario({ molecularWeight: 70.9, peakRate: 10 });
const forcedGaussian = withOverride("gaussian");
check("forcing Gaussian on a heavy-gas release uses the Gaussian engine",
  forcedGaussian.status === "ok" && forcedGaussian.isHeavyGas === false);
check("the verdict records the automatic choice and the override",
  forcedGaussian.dispersion?.automaticModel === "heavyGas" && forcedGaussian.dispersion?.overridden === true);
check("the explanation says the model was chosen by the user",
  forcedGaussian.dispersion?.explanation?.startsWith("Model chosen by the user: Gaussian"));
check("forced Gaussian still draws zones",
  forcedGaussian.zones.some((z) => z.footprint.length > 0));

setScenario({ molecularWeight: 35, peakRate: 0.002 }); // slightly dense, small (Ri ~1.3): automatic Gaussian
const autoSmall = computeZones();
const forcedHeavy = withOverride("heavyGas");
check("a small dense release is Gaussian automatically", autoSmall.isHeavyGas === false);
check("forcing Heavy Gas on it uses the heavy-gas engine", forcedHeavy.isHeavyGas === true);
check("the forced heavy-gas run has a finite characteristic height",
  Number.isFinite(forcedHeavy.scenarioBase?.characteristicHeight));
check("forced Heavy Gas draws zones",
  forcedHeavy.zones.some((z) => z.footprint.length > 0));

setScenario({ molecularWeight: 16.04, peakRate: 1 }); // methane-like, lighter than air
const refused = withOverride("heavyGas");
check("Heavy Gas cannot be forced for a cloud lighter than air",
  refused.isHeavyGas === false && refused.dispersion?.overrideRefused === true);

setScenario({ molecularWeight: 70.9, peakRate: 10 });
const backToAuto = withOverride("");
check("an empty choice returns to the automatic model",
  backToAuto.isHeavyGas === true && backToAuto.dispersion?.overridden === false);

console.log("\n=== 3. Missing pieces are reported, not silently computed wrong ===");
state.update({
  scenario: { location: null, chemical: null, weather: null, source: null },
});
const emptyResult = computeZones();
check("an empty scenario reports incomplete, not a crash or a fake zone",
  emptyResult.status === "incomplete");
check("the missing list is non-empty", emptyResult.missing?.length > 0);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
