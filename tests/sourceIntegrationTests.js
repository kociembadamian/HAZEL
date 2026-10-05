/**
 * sourceIntegrationTests.js
 * -------------------------
 * Verification that stepSource.js's runSourceModel() picks the physically
 * correct tank release regime. Run with:  node tests/sourceIntegrationTests.js
 *
 * This is a real regression test, not a hypothetical one. An earlier
 * version of runSourceModel() decided whether a tank held "gas" or
 * "liquid" using the chemical's natural state at 25C and 1 atm
 * (chemical.state25C). That is wrong for exactly the substances this tool
 * most needs to get right: propane, chlorine, ammonia, and butane are all
 * "gas" at 25C and 1 atm, but in an actual road or rail tank they are kept
 * liquid by their own vapour pressure — a liquefied gas under pressure,
 * which selectReleaseModel() in engineSourceTank.js already documents
 * propane and chlorine as examples of. The bug sent every one of them into
 * the pure compressed-gas venting equations instead of the two-phase
 * flashing-liquid ones, computing a "tank pressure" from the vapour
 * pressure formula with no matching physical tank pressure to make sense
 * of it, and producing release rates on the order of 10^20 kg/s — a real
 * report from a real test of this software, not a constructed edge case.
 *
 * This file builds exactly that scenario (a propane tank) and checks the
 * result is bounded, sane, and uses the two-phase regime.
 *
 * Section 4 (added 2026-09-23) covers the Chemical library integration:
 * runSourceModel() now falls back to a chemical record's own
 * liquidDensity/liquidHeatCapacity/boilingPointK/heatOfVaporization when the
 * Source step's own manual fields are empty (customChemicalStore.js can
 * supply these), and surfaces an explicit note when the chemical is flagged
 * isNonCondensableGas.
 */

import { state } from "../js/ui/state.js";
import { runSourceModel, buildDispersionScenario } from "../js/ui/stepSource.js";
import { findHeavyGasThreatZone } from "../js/engine/engineHeavyGas.js";
import { findThreatZone } from "../js/engine/engineGaussian.js";
import { findJetFireRadiationDistance } from "../js/engine/engineJetFire.js";
import { gasDensity } from "../js/engine/engineDispersionChoice.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

function propaneTankScenario(overrides = {}) {
  return {
    location: { lat: 51.4416, lng: 5.4697, elevation: null },
    chemical: {
      selected: {
        casNumber: "74-98-6",
        name: "Propane",
        molecularWeight: 44.11,
        state25C: "gas", // propane IS a gas at 25C/1atm — exactly the case that broke
        pac1Ppm: 5500, pac2Ppm: 17000, pac3Ppm: 33000,
        lowerExplosiveLimitPpm: 23000,
      },
      selectedLevels: ["pac1", "pac2", "pac3"],
    },
    weather: {
      windSpeed: 5, windSpeedUnit: "m/s", windFromDirection: "SW",
      windMeasurementHeight: 10, temperature: 20, temperatureUnit: "C",
      cloudCoverOktas: 4, relativeHumidity: 50, isDaytime: true,
      groundRoughnessPreset: "openCountry", customRoughness: 0.03,
      inversionPresent: false, inversionHeight: 100, stabilityOverride: "",
    },
    source: {
      type: "tank",
      tankShape: "horizontalCylinder",
      tankDiameter: 2,
      tankLength: 12,
      tankFillPercent: 80,
      holeShape: "circular",
      holeDiameter: 0.1,
      holeHeightAboveBottom: 0,
      pipeLength: 0,
      // Correct, real physical properties for propane — boiling point well
      // below the 20C ambient/tank temperature, which is exactly what
      // should trigger the two-phase regime.
      liquidDensity: 500,
      liquidHeatCapacity: 2400,
      boilingPointK: 231.1,
      heatOfVaporization: 18750, // J/mol — see the module docstring in
      // engineSourceTank.js: this field is deliberately molar, not per kg
      result: null,
      ...overrides,
    },
  };
}

console.log("\n=== 1. Propane tank release stays physically bounded ===");
state.update({ scenario: propaneTankScenario() });
const result = runSourceModel();
check("no error is reported", !result.error, `error: ${JSON.stringify(result.error)}`);
check("peak rate is a finite number", Number.isFinite(result.peakRate));
// A generous but genuinely bounding sanity ceiling: even a catastrophic
// 0.1 m hole in a large pressurised tank should not exceed a few hundred
// kg/s. 10^20 kg/s (the actual bug) is not a borderline case to distinguish
// from a real answer — it is many orders of magnitude beyond anything
// physically possible for this hole size.
check("peak rate is within a physically sane range (not astronomically large)",
  result.peakRate > 0 && result.peakRate < 10000,
  `got ${result.peakRate} kg/s`);
check("total released mass does not exceed the tank's own contents",
  result.totalMass <= 15200, // ~80% of a 2m x 12m horizontal cylinder at 500 kg/m3, with headroom
  `got ${result.totalMass} kg`);

console.log("\n=== 2. The two-phase regime was actually selected ===");
check("the regime description mentions the two-phase/flashing behaviour",
  typeof result.regime === "string" && result.regime.toLowerCase().includes("two-phase"),
  `got regime: ${result.regime}`);

console.log("\n=== 3. A genuinely liquid-at-ambient chemical still uses the liquid regime ===");
state.update({
  scenario: {
    ...propaneTankScenario(),
    chemical: {
      ...propaneTankScenario().chemical,
      selected: { ...propaneTankScenario().chemical.selected, state25C: "liquid" },
    },
    source: {
      ...propaneTankScenario().source,
      boilingPointK: 353.25, // benzene's boiling point, well above 20C ambient
    },
  },
});
const liquidResult = runSourceModel();
check("no error is reported for the liquid case", !liquidResult.error);
check("the liquid regime was selected, not two-phase",
  typeof liquidResult.regime === "string" && !liquidResult.regime.toLowerCase().includes("two-phase"),
  `got regime: ${liquidResult.regime}`);
check("liquid-case peak rate is also physically bounded",
  liquidResult.peakRate > 0 && liquidResult.peakRate < 10000,
  `got ${liquidResult.peakRate} kg/s`);

console.log("\n=== 4. Chemical library values fill in for empty manual fields ===");
// Same propane tank, but this time the Source step's own manual fields are
// left empty (null) — as they would be for a substance the user has never
// filled in here before — while the CHEMICAL record itself carries the
// physical properties, as a saved Chemical library entry would.
const libraryScenario = propaneTankScenario();
libraryScenario.source.liquidDensity = null;
libraryScenario.source.liquidHeatCapacity = null;
libraryScenario.source.boilingPointK = null;
libraryScenario.source.heatOfVaporization = null;
libraryScenario.chemical.selected.liquidDensity = 500;
libraryScenario.chemical.selected.liquidHeatCapacity = 2400;
libraryScenario.chemical.selected.boilingPointK = 231.1;
libraryScenario.chemical.selected.heatOfVaporization = 18750;
state.update({ scenario: libraryScenario });
const libraryResult = runSourceModel();
check("no error is reported when properties come from the chemical record instead of the form",
  !libraryResult.error, `error: ${JSON.stringify(libraryResult.error)}`);
check("the result matches the manually-entered case (same underlying numbers either way)",
  Number.isFinite(libraryResult.peakRate) &&
    Math.abs(libraryResult.peakRate - result.peakRate) < 1e-6 * Math.max(1, result.peakRate),
  `library-derived: ${libraryResult.peakRate}, manual: ${result.peakRate}`);

console.log("\n=== 5. A substance flagged as a non-condensable gas is treated as a compressed gas (2026-10-02) ===");
const flaggedScenario = propaneTankScenario();
flaggedScenario.chemical.selected.isNonCondensableGas = true;
state.update({ scenario: flaggedScenario });
const flaggedResult = runSourceModel();
check("without a tank pressure it asks for one, instead of using the liquefied-gas equations",
  Array.isArray(flaggedResult.error) && flaggedResult.error.some((e) => e.includes("tank pressure")),
  JSON.stringify(flaggedResult));

console.log("\n=== 6. An ordinary liquefied gas is not treated as compressed gas ===");
state.update({ scenario: propaneTankScenario() });
const unflaggedResult = runSourceModel();
check("propane at 20 C stays a liquefied gas (two-phase)", unflaggedResult.regime?.includes("two-phase"));
check("no compressed-gas note appears", !unflaggedResult.notes.some((n) => n.includes("compressed gas only")));

console.log("\n=== 7. Carbon monoxide, gas only, 20 atm (ALOHA C1/C2, 2026-10-02) ===");
/* ALOHA: tank 2.5 x 8 m horizontal, 15 C, D 5 m/s; 941 kg in the tank.
   C1 hole 0.02 m: 49.2 kg/min max average, 853 kg released, Heavy Gas
   313 / 653 m (330 / 83 ppm). C2 hole 0.1 m: 693 kg/min, Heavy Gas
   1.1 / 2.0 km. */
function coScenario(holeDiameter, extra = {}) {
  const sc = propaneTankScenario();
  sc.chemical.selected = {
    casNumber: "630-08-0", name: "Carbon monoxide", molecularWeight: 28.01, state25C: "gas",
    pac1Ppm: 83, pac2Ppm: 83, pac3Ppm: 330, boilingPointK: 81.6,
  };
  sc.weather = { ...sc.weather, temperature: 15, cloudCoverOktas: 5, relativeHumidity: 60, stabilityOverride: "D" };
  sc.source = {
    type: "tank", tankShape: "horizontalCylinder", tankDiameter: 2.5, tankLength: 8, tankFillPercent: 80,
    holeShape: "circular", holeDiameter, holeHeightAboveBottom: 0.1, pipeLength: 0,
    tankContents: "", tankPressureAtm: 20, gasHeatCapacityRatio: 1.4, ...extra,
  };
  return sc;
}
{
  state.update({ scenario: coScenario(0.02) });
  const r = runSourceModel();
  check("CO is recognised as a compressed gas without being told (above its critical temperature)",
    !r.error && r.regime?.startsWith("gas"), JSON.stringify(r.error ?? r.regime));
  check("mass in the tank within 2% of ALOHA's 941 kg", Math.abs(r.tankMass / 941 - 1) < 0.02, `${r.tankMass?.toFixed(0)} kg`);
  const firstMinute = (r.series[0].remainingMass + r.series[0].rate - r.series[1].remainingMass) / 60;
  check("first-minute rate within 12% of ALOHA's 49.2 kg/min",
    Math.abs((firstMinute * 60) / 49.2 - 1) < 0.12, `${(firstMinute * 60).toFixed(1)} kg/min`);
  check("released mass within 5% of ALOHA's 853 kg", Math.abs(r.totalMass / 853 - 1) < 0.05, `${r.totalMass.toFixed(0)} kg`);
  check("the expanded gas is cold: about -151 C", Math.abs(r.cloudTemperature - 122.4) < 1, `${r.cloudTemperature.toFixed(1)} K`);
  state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
  const ds = buildDispersionScenario();
  check("the cold cloud is screened as a heavy gas, as in ALOHA", ds.status === "ok" && ds.isHeavyGas,
    JSON.stringify(ds.dispersion?.model));
  check("the heavy-gas scenario carries the source temperature", Math.abs(ds.scenarioBase.sourceTemperature - 122.4) < 1);
  [330, 83].forEach((ppm, i) => {
    const d = findHeavyGasThreatZone({ ...ds.scenarioBase, levelOfConcernPpm: ppm }).maxDownwindDistance;
    const aloha = [313, 653][i];
    check(`C1 ${ppm} ppm: within 0.85-1.10x of ALOHA's ${aloha} m`, d / aloha > 0.85 && d / aloha < 1.1,
      `${d.toFixed(0)} m = ${(d / aloha).toFixed(2)}x`);
  });
}
{
  state.update({ scenario: coScenario(0.1) });
  const r = runSourceModel();
  state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
  const ds = buildDispersionScenario();
  [330, 83].forEach((ppm, i) => {
    const d = findHeavyGasThreatZone({ ...ds.scenarioBase, levelOfConcernPpm: ppm }).maxDownwindDistance;
    const aloha = [1100, 2000][i];
    check(`C2 ${ppm} ppm: within 0.85-1.10x of ALOHA's ${aloha} m`, ds.isHeavyGas && d / aloha > 0.85 && d / aloha < 1.1,
      `${d.toFixed(0)} m = ${(d / aloha).toFixed(2)}x`);
  });
}
{
  state.update({ scenario: coScenario(0.02, { tankContents: "liquid" }) });
  const r = runSourceModel();
  check("forcing 'liquid' for CO at 15 C is refused with the critical-temperature reason",
    Array.isArray(r.error) && r.error.some((e) => e.includes("critical temperature")), JSON.stringify(r.error));
  state.update({ scenario: coScenario(0.02, { tankPressureAtm: "" }) });
  check("a missing tank pressure is asked for", runSourceModel().error?.some((e) => e.includes("tank pressure")));
}

console.log("\n=== 8. Chlorine, gas only, 3 atm, urban (ALOHA G1, 2026-10-02) ===");
/* ALOHA: 367 kg in the tank, 10.6 kg/min max average, 225 kg in 41 min,
   Heavy Gas 323 / 1100 / 2300 m (20 / 2 / 0.5 ppm). */
{
  const sc = coScenario(0.02, { tankContents: "gas", tankPressureAtm: 3, gasHeatCapacityRatio: 1.33 });
  sc.chemical.selected = { casNumber: "7782-50-5", name: "Chlorine", molecularWeight: 70.91, state25C: "gas",
    pac1Ppm: 0.5, pac2Ppm: 2, pac3Ppm: 20, boilingPointK: 239.1 };
  sc.weather = { ...sc.weather, groundRoughnessPreset: "urbanOrForest" };
  state.update({ scenario: sc });
  const r = runSourceModel();
  check("mass in the tank within 5% of ALOHA's 367 kg", Math.abs(r.tankMass / 367 - 1) < 0.05, `${r.tankMass?.toFixed(0)} kg`);
  check("released mass within 6% of ALOHA's 225 kg", Math.abs(r.totalMass / 225 - 1) < 0.06, `${r.totalMass?.toFixed(0)} kg`);
  state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
  const ds = buildDispersionScenario();
  [20, 2, 0.5].forEach((ppm, i) => {
    const d = findHeavyGasThreatZone({ ...ds.scenarioBase, levelOfConcernPpm: ppm }).maxDownwindDistance;
    const aloha = [323, 1100, 2300][i];
    check(`G1 ${ppm} ppm: within 0.8-1.1x of ALOHA's ${aloha} m`, ds.isHeavyGas && d / aloha > 0.8 && d / aloha < 1.1,
      `${d.toFixed(0)} m = ${(d / aloha).toFixed(2)}x`);
  });
}

console.log("\n=== 9. Gas-only tanks, open country (ALOHA G1-G3, C3, C4, 2026-10-02) ===");
/* Released mass (polytropic tank, n = (1 + gamma)/2) and model choice:
   ALOHA ran Heavy Gas for CO and chlorine, Gaussian for methane. */
{
  const chlorine = { casNumber: "7782-50-5", name: "Chlorine", molecularWeight: 70.91, state25C: "gas",
    pac1Ppm: 0.5, pac2Ppm: 2, pac3Ppm: 20, boilingPointK: 239.1 };
  const methane = { casNumber: "74-82-8", name: "Methane", molecularWeight: 16.04, state25C: "gas",
    pac1Ppm: 65000, pac2Ppm: 230000, pac3Ppm: 400000, boilingPointK: 111.7, lowerExplosiveLimitPpm: 50000 };
  const cases = [
    // label, chemical (null = CO), source overrides, ALOHA released kg, heavy?, levels, ALOHA zones, flammable
    ["G1 chlorine 3 atm", chlorine, { tankContents: "gas", tankPressureAtm: 3, gasHeatCapacityRatio: 1.33, holeDiameter: 0.02 }, 225, true, [20, 2, 0.5], [378, 1300, 2600], false],
    ["G2 methane 50 atm, 0.02 m", methane, { tankPressureAtm: 50, gasHeatCapacityRatio: 1.31, holeDiameter: 0.02 }, 1425, false, [30000, 5000], [52, 130], true],
    ["G3 methane 50 atm, 0.05 m", methane, { tankPressureAtm: 50, gasHeatCapacityRatio: 1.31, holeDiameter: 0.05 }, 1426, false, [30000, 5000], [125, 325], true],
    ["C3 CO 5 atm, 0.05 m", null, { tankPressureAtm: 5, holeDiameter: 0.05 }, 168, true, [330, 83], [377, 768], false],
    ["C4 CO 2 atm, 0.03 m", null, { tankPressureAtm: 2, holeDiameter: 0.03 }, 39.1, true, [330, 83], [146, 302], false],
    // A1 acetylene (0.90 of air's molecular weight): ALOHA ran Heavy Gas, so the
    // light-gas cut-off lies between 0.55 and 0.90. ALOHA's tank mass is 12%
    // above the ideal-gas value at 15 atm (real-gas correction, not modelled).
    ["A1 acetylene 15 atm, 0.05 m", { casNumber: "74-86-2", name: "Acetylene", molecularWeight: 26.04, state25C: "gas",
      pac1Ppm: 65000, pac2Ppm: 230000, pac3Ppm: 400000, boilingPointK: 189.2, lowerExplosiveLimitPpm: 25000 },
      { tankContents: "gas", tankPressureAtm: 15, gasHeatCapacityRatio: 1.23, holeDiameter: 0.05 }, 665, true, [15000, 2500], [91, 312], true],
  ];
  for (const [label, chem, extra, alohaReleased, alohaHeavy, levels, alohaZones, flam] of cases) {
    const sc = coScenario(extra.holeDiameter, extra);
    if (chem) sc.chemical.selected = chem;
    state.update({ scenario: sc });
    const r = runSourceModel();
    // Methane: ALOHA's tank mass is ~11% above the ideal-gas value (real-gas
    // compressibility at 50 atm, not modelled), hence the wider band.
    const tol = chem && (chem === methane || chem.name === "Acetylene") ? 0.13 : 0.06;
    check(`${label}: released mass within ${tol * 100}% of ALOHA's ${alohaReleased} kg`,
      Math.abs(r.totalMass / alohaReleased - 1) < tol, `${r.totalMass.toFixed(1)} kg`);
    state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
    const ds = buildDispersionScenario();
    check(`${label}: ${alohaHeavy ? "Heavy Gas" : "Gaussian"} model, as in ALOHA`, ds.isHeavyGas === alohaHeavy, ds.dispersion?.model);
    const zone = ds.isHeavyGas ? findHeavyGasThreatZone : findThreatZone;
    levels.forEach((ppm, i) => {
      const d = zone({ ...ds.scenarioBase, levelOfConcernPpm: ppm, flammableAveraging: flam }).maxDownwindDistance;
      check(`${label}, ${ppm} ppm: within 0.7-1.1x of ALOHA's ${alohaZones[i]} m`,
        d / alohaZones[i] > 0.7 && d / alohaZones[i] < 1.1, `${d.toFixed(0)} m = ${(d / alohaZones[i]).toFixed(2)}x`);
    });
  }
}

console.log("\n=== 10. Real-gas correction with the critical constants (2026-10-02) ===");
/* Critical constants and acentric factors: Poling, Prausnitz & O'Connell,
   "The Properties of Gases and Liquids", 5th ed., Appendix A. ALOHA's tank
   masses and released masses for the same runs. */
{
  const crit = {
    co: { criticalTemperatureK: 132.85, criticalPressureBar: 34.94, acentricFactor: 0.045 },
    chlorine: { criticalTemperatureK: 417.15, criticalPressureBar: 77.1, acentricFactor: 0.069 },
    methane: { criticalTemperatureK: 190.56, criticalPressureBar: 45.99, acentricFactor: 0.011 },
    // acentric factor left empty: estimated from the boiling point (Edmister)
    acetylene: { criticalTemperatureK: 308.3, criticalPressureBar: 61.38 },
  };
  const chlorineRec = { casNumber: "7782-50-5", name: "Chlorine", molecularWeight: 70.91, state25C: "gas",
    pac1Ppm: 0.5, pac2Ppm: 2, pac3Ppm: 20, boilingPointK: 239.1 };
  const methaneRec = { casNumber: "74-82-8", name: "Methane", molecularWeight: 16.04, state25C: "gas",
    pac1Ppm: 65000, pac2Ppm: 230000, pac3Ppm: 400000, boilingPointK: 111.7, lowerExplosiveLimitPpm: 50000 };
  const acetyleneRec = { casNumber: "74-86-2", name: "Acetylene", molecularWeight: 26.04, state25C: "gas",
    pac1Ppm: 65000, pac2Ppm: 230000, pac3Ppm: 400000, boilingPointK: 189.2, lowerExplosiveLimitPpm: 25000 };
  const runs = [
    // label, record (null = CO), source overrides, ALOHA tank mass, ALOHA released
    ["CO 20 atm (C1)", null, { tankPressureAtm: 20, holeDiameter: 0.02, ...crit.co }, 941, 853],
    ["CO 5 atm (C3)", null, { tankPressureAtm: 5, holeDiameter: 0.05, ...crit.co }, 233, 168],
    ["chlorine 3 atm (G1)", chlorineRec, { tankContents: "gas", tankPressureAtm: 3, gasHeatCapacityRatio: 1.33, holeDiameter: 0.02, ...crit.chlorine }, 367, 225],
    ["methane 50 atm (G2)", methaneRec, { tankPressureAtm: 50, gasHeatCapacityRatio: 1.31, holeDiameter: 0.02, ...crit.methane }, 1475, 1425],
    ["acetylene 15 atm (A1), omega estimated", acetyleneRec, { tankContents: "gas", tankPressureAtm: 15, gasHeatCapacityRatio: 1.23, holeDiameter: 0.05, ...crit.acetylene }, 728, 665],
  ];
  for (const [label, rec, extra, alohaMass, alohaReleased] of runs) {
    const sc = coScenario(extra.holeDiameter, extra);
    if (rec) sc.chemical.selected = rec;
    state.update({ scenario: sc });
    const r = runSourceModel();
    check(`${label}: tank mass within 2% of ALOHA's ${alohaMass} kg`, Math.abs(r.tankMass / alohaMass - 1) < 0.02,
      `${r.tankMass?.toFixed(0)} kg, Z = ${r.compressibilityFactor?.toFixed(3)}`);
    check(`${label}: released mass within 5% of ALOHA's ${alohaReleased} kg`, Math.abs(r.totalMass / alohaReleased - 1) < 0.05,
      `${r.totalMass?.toFixed(0)} kg`);
  }
  // The same constants saved on the chemical record (Chemical library) are used too.
  const sc = coScenario(0.02, { tankPressureAtm: 50, gasHeatCapacityRatio: 1.31 });
  sc.chemical.selected = { ...methaneRec, ...crit.methane };
  state.update({ scenario: sc });
  const fromLibrary = runSourceModel();
  check("critical constants from the chemical record are used when the Source fields are empty",
    Math.abs(fromLibrary.tankMass / 1475 - 1) < 0.02, `${fromLibrary.tankMass?.toFixed(0)} kg`);
  // Without them: ideal gas, and a note pointing to where to find them.
  const sc2 = coScenario(0.02, { tankPressureAtm: 50, gasHeatCapacityRatio: 1.31 });
  sc2.chemical.selected = methaneRec;
  state.update({ scenario: sc2 });
  const ideal = runSourceModel();
  check("without them the tank is an ideal gas, with a note naming the NIST WebBook",
    ideal.compressibilityFactor === 1 && ideal.notes.some((n) => n.includes("NIST")));
}

console.log("\n=== 11. Batch 5: acetone puddle, ammonia tank, methane jet fire (ALOHA P1, N1, J1, 2026-10-02) ===");
{
  // P1: acetone puddle 1000 kg / 100 m2, concrete, D 5 m/s, flammable area.
  // ALOHA: 23.6 kg/min, 846 kg in 1 h, Gaussian, < 10 / 20 m. Ri = 1.35 —
  // above the Tech Doc's 1, below HAZEL's threshold of 1.95.
  const sc = coScenario(0.05, {});
  sc.chemical.selected = { casNumber: "67-64-1", name: "Acetone", molecularWeight: 58.08, state25C: "liquid",
    pac1Ppm: 200, pac2Ppm: 3200, pac3Ppm: 5700, boilingPointK: 329.2, heatOfVaporization: 29100, lowerExplosiveLimitPpm: 26000 };
  sc.source = { type: "puddle", puddleMass: 1000, puddleArea: 100, substrate: "concrete", liquidDensity: 790, liquidHeatCapacity: 2150 };
  state.update({ scenario: sc });
  const r = runSourceModel();
  check("P1: total evaporated within 8% of ALOHA's 846 kg", Math.abs(r.totalMass / 846 - 1) < 0.08, `${r.totalMass.toFixed(0)} kg`);
  state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
  const ds = buildDispersionScenario();
  check("P1: Gaussian model, as in ALOHA", !ds.isHeavyGas, `Ri ${ds.dispersion.richardsonNumber.toFixed(2)}`);
  const y = findThreatZone({ ...ds.scenarioBase, levelOfConcernPpm: 2600, flammableAveraging: true }).maxDownwindDistance;
  const red = findThreatZone({ ...ds.scenarioBase, levelOfConcernPpm: 15600, flammableAveraging: true }).maxDownwindDistance;
  check("P1: 10% LEL within 0.85-1.1x of ALOHA's 20 m", y / 20 > 0.85 && y / 20 < 1.1, `${y.toFixed(1)} m`);
  check("P1: 60% LEL under 10 m, as in ALOHA", red < 10, `${red.toFixed(1)} m`);
}
{
  // R1 / R2: acetone puddles 140 m2 / 1400 kg and 200 m2 / 2000 kg (Ri 1.57
  // and 1.85). ALOHA: Gaussian in both; 32.5 / 45.7 kg/min; 10% LEL 24 / 28 m.
  for (const [area, mass, alohaRate, alohaYellow] of [[140, 1400, 32.5, 24], [200, 2000, 45.7, 28]]) {
    const sc = coScenario(0.05, {});
    sc.chemical.selected = { casNumber: "67-64-1", name: "Acetone", molecularWeight: 58.08, state25C: "liquid",
      pac1Ppm: 200, pac2Ppm: 3200, pac3Ppm: 5700, boilingPointK: 329.2, heatOfVaporization: 29100, lowerExplosiveLimitPpm: 26000 };
    sc.source = { type: "puddle", puddleMass: mass, puddleArea: area, substrate: "concrete", liquidDensity: 790, liquidHeatCapacity: 2150 };
    state.update({ scenario: sc });
    const r = runSourceModel();
    const firstMinute = r.series[0].remaining + r.series[0].rate - r.series[1].remaining;
    check(`R ${area} m2: first-minute rate within 6% of ALOHA's ${alohaRate} kg/min`, Math.abs(firstMinute / alohaRate - 1) < 0.06,
      `${firstMinute.toFixed(1)} kg/min`);
    state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
    const ds = buildDispersionScenario();
    check(`R ${area} m2: Gaussian model, as in ALOHA`, !ds.isHeavyGas, `Ri ${ds.dispersion.richardsonNumber.toFixed(2)}`);
    const y = findThreatZone({ ...ds.scenarioBase, levelOfConcernPpm: 2600, flammableAveraging: true }).maxDownwindDistance;
    check(`R ${area} m2: 10% LEL within 0.85-1.1x of ALOHA's ${alohaYellow} m`, y / alohaYellow > 0.85 && y / alohaYellow < 1.1,
      `${y.toFixed(1)} m`);
  }
}
{
  // N1: ammonia, liquefied, 2.5 x 8 m, 80 %, hole 0.05 m at 0.1 m. ALOHA:
  // 19,417 kg, 1,990 kg/min, 12 min, two-phase; Heavy Gas 1.2 / 4.0 / 9.8 km.
  const sc = coScenario(0.05, { tankContents: "liquid", liquidDensity: 617, liquidHeatCapacity: 4700 });
  sc.chemical.selected = { casNumber: "7664-41-7", name: "Ammonia", molecularWeight: 17.03, state25C: "gas",
    pac1Ppm: 30, pac2Ppm: 160, pac3Ppm: 1100, boilingPointK: 239.8, heatOfVaporization: 23350 };
  state.update({ scenario: sc });
  const r = runSourceModel();
  check("N1: two-phase release", r.regime?.includes("two-phase"), r.regime);
  check("N1: peak rate within 5% of ALOHA's 1,990 kg/min", Math.abs((r.peakRate * 60) / 1990 - 1) < 0.05, `${(r.peakRate * 60).toFixed(0)} kg/min`);
  check("N1: the note explains ALOHA's heavy-gas treatment of the aerosol", r.notes.some((n) => n.includes("cold aerosol")));
  state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result: r } } });
  const ds = buildDispersionScenario();
  [1100, 160, 30].forEach((ppm, i) => {
    const d = (ds.isHeavyGas ? findHeavyGasThreatZone : findThreatZone)({ ...ds.scenarioBase, levelOfConcernPpm: ppm }).maxDownwindDistance;
    const aloha = [1200, 4000, 9800][i];
    check(`N1 ${ppm} ppm: within 0.85-1.1x of ALOHA's ${aloha} m`, d / aloha > 0.85 && d / aloha < 1.1, `${d.toFixed(0)} m = ${(d / aloha).toFixed(2)}x`);
  });
}
{
  // J1: methane, gas only, 50 atm, jet fire. ALOHA max burn rate 105 / 659
  // kg/min; zones 10 / 13 / 20 m (0.02 m hole), 22 / 30 / 47 m (0.05 m).
  for (const [d, alohaRate, aloha] of [[0.02, 105, [10, 13, 20]], [0.05, 659, [22, 30, 47]]]) {
    const sc = coScenario(d, { tankPressureAtm: 50, gasHeatCapacityRatio: 1.31,
      criticalTemperatureK: 190.56, criticalPressureBar: 45.99, acentricFactor: 0.011 });
    sc.chemical.selected = { casNumber: "74-82-8", name: "Methane", molecularWeight: 16.04, state25C: "gas",
      pac1Ppm: 65000, pac2Ppm: 230000, pac3Ppm: 400000, boilingPointK: 111.7, lowerExplosiveLimitPpm: 50000 };
    state.update({ scenario: sc });
    const r = runSourceModel();
    check(`J1 ${d} m: burn rate within 3% of ALOHA's ${alohaRate} kg/min`, Math.abs((r.peakRate * 60) / alohaRate - 1) < 0.03,
      `${(r.peakRate * 60).toFixed(0)} kg/min`);
    const T = 288.15;
    const jet = { massFlowRate: r.peakRate, orificeDiameter: d, specificHeatRatio: 1.31, sourceTemperature: T,
      molecularWeightKgPerMol: 0.01604, jetDensity: gasDensity(16.04, T), ambientDensity: gasDensity(28.96, T),
      windSpeed: 5, choked: true, isAerosol: false, heatOfCombustion: 50.0e6, relativeHumidity: 60, ambientTemperature: T };
    [10000, 5000, 2000].forEach((w, i) => {
      const dist = findJetFireRadiationDistance({ ...jet, thresholdWm2: w }).maxDistance;
      check(`J1 ${d} m, ${w / 1000} kW/m2: within 0.85-1.15x of ALOHA's ${aloha[i]} m`,
        dist / aloha[i] > 0.85 && dist / aloha[i] < 1.15, `${dist.toFixed(0)} m = ${(dist / aloha[i]).toFixed(2)}x`);
    });
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
