/**
 * fireExplosionIntegrationTests.js
 * ---------------------------------
 * Verification that computeFireResults() (fireExplosionPanel.js) correctly
 * wires the BLEVE and VCE engines to the rest of the scenario. Run with:
 *   node tests/fireExplosionIntegrationTests.js
 *
 * Same rationale as resultsIntegrationTests.js: engineBleve.js and
 * engineVce.js are already thoroughly tested on their own (bleveTests.js,
 * vceTests.js), and engineFlammableMass.js has its own dedicated test file
 * (flammableMassTests.js). This checks the WIRING — that computeFireResults()
 * builds a scenario object each engine can actually use from a realistic
 * state.js scenario, without a DOM (computeFireResults() only reads state
 * and calls pure functions, same as computeZones() in stepResults.js).
 *
 * Section 4/5 (VCE) were rewritten 2026-09-22 when the flammable mass
 * became an automatic calculation (engineFlammableMass.js) rather than a
 * manually-entered number: the scenario now needs a lower and upper
 * explosive limit instead of a flammableMassKg value.
 *
 * Section 5c (added 2026-09-23) covers the Chemical library integration:
 * heat of combustion and the upper explosive limit — the field the built-in
 * database never carries at all — can now also come from a chemical
 * record's own saved data (customChemicalStore.js), not just a manual entry
 * here or the built-in LEL.
 */

import { state } from "../js/ui/state.js";
import { computeFireResults, defaultFireScenario, fireFieldValueFromInput } from "../js/ui/fireExplosionPanel.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

function baseScenario(fireOverrides = {}) {
  return {
    location: { lat: 51.4416, lng: 5.4697, elevation: null },
    chemical: {
      selected: {
        casNumber: "74-98-6",
        name: "Propane",
        molecularWeight: 44.1,
        state25C: "gas",
        pac1Ppm: 700,
        pac2Ppm: 2000,
        pac3Ppm: 3000,
        // Propane's own LEL, 2.1% = 21000 ppm — present on some real
        // records (see chemicalDatabase.js), absent here on purpose so
        // section 4 below can check the "not on file" path.
      },
      selectedLevels: ["pac1", "pac2", "pac3"],
    },
    weather: {
      windSpeed: 5, windSpeedUnit: "m/s", windFromDirection: "SW",
      windMeasurementHeight: 10, temperature: 20, temperatureUnit: "C",
      cloudCoverOktas: 4, relativeHumidity: 60, isDaytime: true,
      groundRoughnessPreset: "openCountry", customRoughness: 0.03,
      inversionPresent: false, inversionHeight: 100, stabilityOverride: "",
    },
    source: {
      type: "tank", tankShape: "horizontalCylinder", tankDiameter: 2, tankLength: 6,
      tankFillPercent: 80, holeShape: "circular", holeDiameter: 0.05,
      holeHeightAboveBottom: 0.1, pipeLength: 0,
      result: { peakRate: 5, averageRate: 5, durationSeconds: 300, totalMass: 1500 },
    },
    fire: { ...defaultFireScenario(), ...fireOverrides },
  };
}

console.log("\n=== 1. Disabled by default ===");
state.update({ scenario: baseScenario() });
const disabled = computeFireResults();
check("status is 'disabled' when the toggle is off", disabled.status === "disabled");

console.log("\n=== 2. BLEVE, missing heat of combustion ===");
state.update({ scenario: baseScenario({ enabled: true, scenarioType: "bleve" }) });
const missingHc = computeFireResults();
check("status is 'incomplete' without a heat of combustion", missingHc.status === "incomplete");
check("the missing list names the heat of combustion",
  missingHc.missing.some((m) => m.includes("heat of combustion")));

console.log("\n=== 3. BLEVE, fully specified ===");
state.update({
  scenario: baseScenario({ enabled: true, scenarioType: "bleve", heatOfCombustion: 46000000 }),
});
const bleveResult = computeFireResults();
check("status is 'ok'", bleveResult.status === "ok", `got ${bleveResult.status}`);
check("scenario type is bleve", bleveResult.scenarioType === "bleve");
check("three thermal radiation results are returned", bleveResult.results?.length === 3);
check("the fireball mass matches the source step's computed total mass",
  bleveResult.mass === 1500);
check("at least one thermal level is exceeded for a 1500 kg propane fireball",
  bleveResult.results.some((r) => r.thresholdExceeded));
check("results are ordered most severe first (thermal-3, thermal-2, thermal-1)",
  bleveResult.results[0].level.id === "thermal3" && bleveResult.results[2].level.id === "thermal1");
const [t3, t2, t1] = bleveResult.results;
if (t3.thresholdExceeded && t1.thresholdExceeded) {
  check("thermal-1 (2 kW/m2) reaches at least as far as thermal-3 (10 kW/m2)",
    t1.maxDistance >= t3.maxDistance, `t1: ${t1.maxDistance}, t3: ${t3.maxDistance}`);
}

console.log("\n=== 4. VCE, missing explosive limits ===");
state.update({
  scenario: baseScenario({ enabled: true, scenarioType: "vce", heatOfCombustion: 46000000 }),
});
const missingLimits = computeFireResults();
check("status is 'incomplete' without explosive limits", missingLimits.status === "incomplete");
check("the missing list names the lower explosive limit",
  missingLimits.missing.some((m) => m.includes("lower explosive limit")),
  JSON.stringify(missingLimits.missing));
check("the missing list names the upper explosive limit",
  missingLimits.missing.some((m) => m.includes("upper explosive limit")),
  JSON.stringify(missingLimits.missing));

console.log("\n=== 5. VCE, fully specified (LEL/UEL entered, mass computed automatically) ===");
state.update({
  scenario: baseScenario({
    enabled: true, scenarioType: "vce", heatOfCombustion: 46000000,
    reactivity: "medium", congestion: "medium",
    lowerExplosiveLimitPpm: 21000, // propane's real LEL, 2.1%
    upperExplosiveLimitPpm: 95000, // propane's real UEL, 9.5%
  }),
});
const vceResult = computeFireResults();
check("status is 'ok'", vceResult.status === "ok", `got ${vceResult.status}, missing: ${vceResult.missing}`);
check("scenario type is vce", vceResult.scenarioType === "vce");
check("a flammable mass was computed automatically, not supplied",
  Number.isFinite(vceResult.flammableMassKg) && vceResult.flammableMassKg > 0,
  `got ${vceResult.flammableMassKg}`);
check("three overpressure results are returned", vceResult.results?.length === 3);
check("results are ordered most severe first (blast-3, blast-2, blast-1)",
  vceResult.results[0].level.id === "blast3" && vceResult.results[2].level.id === "blast1");

console.log("\n=== 5b. VCE: the chemical database's own LEL is used when the field is not overridden ===");
state.update({
  scenario: (() => {
    const scenario = baseScenario({
      enabled: true, scenarioType: "vce", heatOfCombustion: 46000000,
      upperExplosiveLimitPpm: 95000,
      // lowerExplosiveLimitPpm left null: should fall back to the
      // chemical record's own value, set here to propane's real LEL.
    });
    scenario.chemical.selected.lowerExplosiveLimitPpm = 21000;
    return scenario;
  })(),
});
const vceFromDatabase = computeFireResults();
check("status is 'ok' using the database's own LEL", vceFromDatabase.status === "ok",
  `got ${vceFromDatabase.status}, missing: ${vceFromDatabase.missing}`);
check("the computed flammable mass matches the manually-entered-LEL case (same inputs either way)",
  Math.abs(vceFromDatabase.flammableMassKg - vceResult.flammableMassKg) < 1e-6 * Math.max(1, vceResult.flammableMassKg),
  `db-sourced: ${vceFromDatabase.flammableMassKg}, manual: ${vceResult.flammableMassKg}`);

console.log("\n=== 5c. VCE: heat of combustion AND the upper explosive limit both come from the chemical record when saved there (Chemical library) ===");
state.update({
  scenario: (() => {
    // heatOfCombustion and upperExplosiveLimitPpm both left OFF the fire
    // scenario itself — as they would be the first time a substance with a
    // saved Chemical library entry is used — while the chemical record
    // carries both, exactly as mergeCustomChemicalOntoBuiltIn() in
    // customChemicalStore.js would leave them after applying a saved
    // override.
    const scenario = baseScenario({
      enabled: true, scenarioType: "vce",
      reactivity: "medium", congestion: "medium",
      lowerExplosiveLimitPpm: 21000,
    });
    scenario.chemical.selected.heatOfCombustion = 46000000;
    scenario.chemical.selected.upperExplosiveLimitPpm = 95000;
    return scenario;
  })(),
});
const vceFromLibrary = computeFireResults();
check("status is 'ok' using the chemical record's own heat of combustion and UEL",
  vceFromLibrary.status === "ok", `got ${vceFromLibrary.status}, missing: ${vceFromLibrary.missing}`);
check("the computed flammable mass matches the fully-manual case (same inputs either way)",
  Math.abs(vceFromLibrary.flammableMassKg - vceResult.flammableMassKg) < 1e-6 * Math.max(1, vceResult.flammableMassKg),
  `library-sourced: ${vceFromLibrary.flammableMassKg}, manual: ${vceResult.flammableMassKg}`);

console.log("\n=== 6. Missing upstream data is reported, not silently guessed ===");
state.update({
  scenario: {
    location: null, chemical: null, weather: null, source: null,
    fire: { ...defaultFireScenario(), enabled: true, heatOfCombustion: 46000000 },
  },
});
const noUpstream = computeFireResults();
check("status is 'incomplete' when location/chemical/weather are all missing",
  noUpstream.status === "incomplete");
check("the missing list is non-empty", noUpstream.missing.length > 0);

console.log("\n=== 7. Pool fire, reuses Source step's puddle properties when present ===");
state.update({
  scenario: {
    ...baseScenario({
      enabled: true, scenarioType: "pool", heatOfCombustion: 46000000, poolDiameter: 10,
    }),
    source: {
      type: "puddle", boilingPointK: 231, heatOfVaporization: 425000, liquidHeatCapacity: 2400,
      result: { peakRate: 1, averageRate: 1, durationSeconds: 300, totalMass: 500 },
    },
  },
});
const poolResult = computeFireResults();
check("status is 'ok' reusing the Source step's liquid properties",
  poolResult.status === "ok", `got ${poolResult.status}, missing: ${poolResult.missing}`);
check("scenario type is pool", poolResult.scenarioType === "pool");
check("three thermal radiation results are returned", poolResult.results?.length === 3);

console.log("\n=== 8. Pool fire, missing liquid properties reports what is needed ===");
state.update({
  scenario: baseScenario({ enabled: true, scenarioType: "pool", heatOfCombustion: 46000000, poolDiameter: 10 }),
});
const poolMissing = computeFireResults();
check("status is 'incomplete' without boiling point / Hvap / Cp",
  poolMissing.status === "incomplete");
check("the missing list names the boiling point",
  poolMissing.missing.some((m) => m.includes("boiling point")));

console.log("\n=== 9. Jet fire, reuses Source step's hole diameter and release rate ===");
state.update({
  scenario: baseScenario({
    enabled: true, scenarioType: "jet", heatOfCombustion: 46000000, specificHeatRatio: 1.13,
  }),
});
const jetResult = computeFireResults();
check("status is 'ok' reusing the tank's hole diameter and release rate",
  jetResult.status === "ok", `got ${jetResult.status}, missing: ${jetResult.missing}`);
check("scenario type is jet", jetResult.scenarioType === "jet");
check("three thermal radiation results are returned", jetResult.results?.length === 3);

console.log("\n=== 10. Jet fire, missing specific heat ratio reports what is needed ===");
state.update({
  scenario: baseScenario({ enabled: true, scenarioType: "jet", heatOfCombustion: 46000000 }),
});
const jetMissing = computeFireResults();
check("status is 'incomplete' without a specific heat ratio",
  jetMissing.status === "incomplete");
check("the missing list names the specific heat ratio",
  jetMissing.missing.some((m) => m.includes("specific heat ratio")));

console.log("\n=== 11. Input value type conversion (the bug this file also exists to catch) ===");
// A real regression: input.value is always a string in the DOM, even for
// type="number". Storing it as-is meant a field that looked filled in on
// screen never satisfied Number.isFinite() downstream — "still needed"
// never went away no matter what was typed. These use plain objects
// standing in for real <input>/<select> elements, the same style as
// domUtilsTests.js's fakeElement().
check("a number input's string value is converted to an actual number",
  fireFieldValueFromInput({ type: "number", value: "46000000" }) === 46000000);
check("the converted value is a genuine number, not a numeric string",
  typeof fireFieldValueFromInput({ type: "number", value: "46000000" }) === "number");
check("a checkbox's checked state is read directly, not from .value",
  fireFieldValueFromInput({ type: "checkbox", value: "on", checked: true }) === true);
check("a select's value stays a string (e.g. reactivity: 'medium')",
  fireFieldValueFromInput({ tagName: "SELECT", value: "medium" }) === "medium");

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
