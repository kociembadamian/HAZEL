/**
 * tankPuddleTests.js
 * ------------------
 * A tank holding a liquid below its boiling point (acetone, methanol,
 * petrol...) does not release into the air what drains from the hole: the
 * liquid forms a puddle, and only what evaporates from it becomes airborne
 * (ALOHA Technical Documentation 3.4 and 3.4.4). Added 2026-10-01, when
 * HAZEL was found to pass the DRAIN rate (about 1.5 kg/s through a 5 cm hole)
 * straight to the dispersion model — 20 to 50 times the real airborne rate.
 *
 * Run with:  node tests/tankPuddleTests.js
 */

import { state } from "../js/ui/state.js";
import { runSourceModel, buildDispersionScenario } from "../js/ui/stepSource.js";
import { simulateSpreadingPuddle, simulatePuddleEvaporation, vapourPressureAt } from "../js/engine/engineSourcePuddle.js";
import { findThreatZone } from "../js/engine/engineGaussian.js";
import { findHeavyGasThreatZone } from "../js/engine/engineHeavyGas.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

const acetone = {
  // Heat of vaporisation AT THE BOILING POINT (NIST: 29.1 kJ/mol at 329 K),
  // as the Source step asks for — 31.3 kJ/mol is the 25 C value.
  molecularWeight: 58.08, boilingPointK: 329.4, heatOfVaporizationJPerMol: 29100,
  liquidDensity: 784, liquidHeatCapacityJPerKgK: 2150,
};
const typicalNight = {
  windSpeed10m: 5, powerLawExponent: 0.142, roughnessLength: 0.03,
  airTemperatureK: 288.15, relativeHumidity: 60, cloudCoverOktas: 4,
};

console.log("\n=== 1. The spreading puddle on its own ===");
{
  const inflow = 1.5; // kg/s, about what a 5 cm hole drains
  const run = simulateSpreadingPuddle({
    chemical: acetone, weather: typicalNight, inflowAt: () => inflow,
    maxPuddleArea: 10, sourceInventory: 25000, substrateKey: "concrete",
    durationSeconds: 1800,
  });
  check("the puddle grows to the area limit and no further",
    Math.abs(run.puddleArea - 10) < 1e-6 && run.series.every((p) => p.puddleArea <= 10 + 1e-9),
    `${run.puddleArea.toFixed(3)} m2`);
  check("mass is conserved: drained = evaporated + still on the ground",
    Math.abs(run.totalInflow - run.totalEvaporated - run.puddleMassLeft) < 1e-6 * run.totalInflow);
  check("evaporation is a small fraction of the drain rate (most liquid stays on the ground)",
    run.peakRate < inflow / 20, `${run.peakRate.toFixed(4)} vs ${inflow} kg/s`);
  check("the puddle never exceeds its boiling point",
    run.series.every((p) => p.temperature <= acetone.boilingPointK + 1e-9));
  check("'remaining' counts down from the tank inventory by what has evaporated",
    Math.abs(run.series.at(-1).remaining - (25000 - run.totalEvaporated)) < 0.2 + run.peakRate * 60);

  const free = simulateSpreadingPuddle({
    chemical: acetone, weather: typicalNight, inflowAt: () => inflow,
    maxPuddleArea: null, substrateKey: "concrete", durationSeconds: 600,
  });
  const depth = free.puddleMassLeft / (acetone.liquidDensity * free.puddleArea);
  check("with no area limit the puddle spreads until it is about 5 mm deep",
    depth > 0.0045 && depth < 0.0065, `${(depth * 1000).toFixed(2)} mm, ${free.puddleArea.toFixed(0)} m2`);
  check("and keeps spreading while liquid keeps arriving",
    free.series.at(-1).puddleArea > free.series[2].puddleArea * 2);

  const stopped = simulateSpreadingPuddle({
    chemical: acetone, weather: typicalNight, inflowAt: (t) => (t < 60 ? 1 : 0),
    maxPuddleArea: 10, substrateKey: "concrete", durationSeconds: 3600,
  });
  check("once the tank stops, the puddle keeps evaporating until it is gone or the hour ends",
    stopped.totalEvaporated > 0 && stopped.series.at(-1).rate >= 0 &&
      Math.abs(stopped.totalInflow - 60) < 1e-9);
}

console.log("\n=== 2. Consistent with the stand-alone puddle model ===");
{
  // A deep puddle at a fixed 10 m2: the first minute should match a tank-fed
  // puddle that reaches 10 m2 within seconds (same evaporation physics).
  const fed = simulateSpreadingPuddle({
    chemical: acetone, weather: typicalNight, inflowAt: () => 1.5, maxPuddleArea: 10,
    substrateKey: "concrete", durationSeconds: 120,
  });
  const fixed = simulatePuddleEvaporation({
    chemical: acetone, weather: typicalNight, spillMass: 5000, puddleArea: 10,
    substrateKey: "concrete", durationSeconds: 120,
  });
  // The tank-fed puddle is still thin after a minute (about 90 kg against
  // 5000 kg), so evaporation cools it faster; a modest shortfall is expected.
  const ratio = fed.series[1].rate / fixed.series[1].rate;
  check("tank-fed and stand-alone puddles of the same area evaporate alike (within 0.8-1.1x)",
    ratio > 0.8 && ratio < 1.1, `ratio ${ratio.toFixed(3)}`);
}

console.log("\n=== 3. Through the Source step, and against ALOHA ===");
/* Real ALOHA runs (2026-10-01): horizontal cylinder 2.5 m x 8 m, 80% full,
   5 cm circular hole 0.1 m above the bottom, concrete, maximum puddle area
   10 m2, Eindhoven 02:00. Typical day: D, 5 m/s, 15 C, RH 60%, cloud 5/10.
   Worst case: F, 1.5 m/s, 5 C, RH 80%, cloud 0.
     acetone  typical  2.38 kg/min, 138 kg/h, Gaussian,  yellow (200 ppm) 36 m
     methanol typical  0.715 kg/min, 41.8 kg/h, Gaussian, yellow (530 ppm) 13 m
     acetone  worst    0.601 kg/min, 35.5 kg/h, Heavy gas, yellow 59 m
     methanol worst    0.166 kg/min, 9.83 kg/h, Gaussian,  yellow 39 m
     chlorine typical  2,700 kg/min, Heavy gas, red (20 ppm) 6.5 km
     chlorine worst    2,280 kg/min, Heavy gas, red 8.1 km
   */
const SUBSTANCES = {
  acetone: { mw: 58.08, rho: 784, cp: 2150, bp: 329.4, hv: 29100, loc: [5700, 3200, 200] },
  methanol: { mw: 32.04, rho: 792, cp: 2530, bp: 337.8, hv: 35300, loc: [7200, 2100, 530] },
  chlorine: { mw: 70.9, rho: 1553, cp: 950, bp: 239.1, hv: 20400, loc: [20, 2, 0.5] },
};
const WEATHER = {
  typical: { windSpeed: 5, temperature: 15, cloudCoverOktas: 4, relativeHumidity: 60, stabilityOverride: "D" },
  worst: { windSpeed: 1.5, temperature: 5, cloudCoverOktas: 0, relativeHumidity: 80, stabilityOverride: "F" },
};

function runTank(name, weatherKey, maxArea = 10) {
  const c = SUBSTANCES[name];
  state.update({
    scenario: {
      location: { lat: 51.4416, lng: 5.4697, elevation: null, date: "2026-09-29", time: "02:00", useCurrentTime: false },
      chemical: {
        selected: { casNumber: "x", name, molecularWeight: c.mw, state25C: "liquid",
          pac1Ppm: c.loc[2], pac2Ppm: c.loc[1], pac3Ppm: c.loc[0] },
        selectedLevels: ["pac1", "pac2", "pac3"],
      },
      weather: {
        windSpeedUnit: "m/s", windFromDirection: "SW", windMeasurementHeight: 10, temperatureUnit: "C",
        isDaytime: false, groundRoughnessPreset: "openCountry", customRoughness: 0.03,
        inversionPresent: false, inversionHeight: 100, ...WEATHER[weatherKey],
      },
      source: {
        type: "tank", tankShape: "horizontalCylinder", tankDiameter: 2.5, tankLength: 8, tankFillPercent: 80,
        holeShape: "circular", holeDiameter: 0.05, holeHeightAboveBottom: 0.1, pipeLength: 0,
        substrate: "concrete", tankMaxPuddleArea: maxArea,
        liquidDensity: c.rho, liquidHeatCapacity: c.cp, boilingPointK: c.bp, heatOfVaporization: c.hv,
        result: null,
      },
    },
  });
  const result = runSourceModel();
  state.update({ scenario: { ...state.current.scenario, source: { ...state.current.scenario.source, result } } });
  const built = buildDispersionScenario();
  const zone = (ppm) => (built.isHeavyGas ? findHeavyGasThreatZone : findThreatZone)(
    { ...built.scenarioBase, levelOfConcernPpm: ppm }).maxDownwindDistance;
  return { result, built, zones: c.loc.map(zone) };
}

const cases = [
  // name, weather, ALOHA rate, ALOHA total, ALOHA heavy gas?, ALOHA yellow, [total band], [yellow band]
  ["acetone", "typical", 2.38 / 60, 138, false, 36, [0.85, 1.15], [0.8, 1.2]],
  ["methanol", "typical", 0.715 / 60, 41.8, false, 13, [0.85, 1.2], [0.8, 1.3]],
  ["acetone", "worst", 0.601 / 60, 35.5, true, 59, [0.85, 1.15], [0.7, 1.2]],
  ["methanol", "worst", 0.166 / 60, 9.83, false, 39, [0.85, 1.2], [0.8, 1.3]],
];
for (const [name, w, alohaRate, alohaTotal, alohaHeavy, alohaYellow, totalBand, yellowBand] of cases) {
  const { result, built, zones } = runTank(name, w);
  check(`${name} ${w}: the puddle model is used`, /puddle/.test(result.regime), result.regime);
  check(`${name} ${w}: airborne rate is far below the drain rate`,
    result.peakRate < result.tankDrainPeakRate / 20);
  const totalRatio = result.totalMass / alohaTotal;
  check(`${name} ${w}: evaporated in the hour within ${totalBand[0]}-${totalBand[1]}x of ALOHA's ${alohaTotal} kg`,
    totalRatio > totalBand[0] && totalRatio < totalBand[1], `${result.totalMass.toFixed(1)} kg = ${totalRatio.toFixed(2)}x`);
  check(`${name} ${w}: same dispersion model as ALOHA (${alohaHeavy ? "heavy gas" : "Gaussian"})`,
    built.isHeavyGas === alohaHeavy);
  const yRatio = zones[2] / alohaYellow;
  check(`${name} ${w}: AEGL-1 distance within ${yellowBand[0]}-${yellowBand[1]}x of ALOHA's ${alohaYellow} m`,
    yRatio > yellowBand[0] && yRatio < yellowBand[1], `${zones[2].toFixed(0)} m = ${yRatio.toFixed(2)}x`);
}

for (const [w, alohaRateKgMin, alohaRed] of [["typical", 2700, 6500], ["worst", 2280, 8100]]) {
  const { result, built, zones } = runTank("chlorine", w);
  check(`chlorine ${w}: still a flashing two-phase release (no puddle)`,
    /two-phase/.test(result.regime) && result.puddleDiameter === undefined);
  const rateRatio = (result.peakRate * 60) / alohaRateKgMin;
  check(`chlorine ${w}: release rate within 10% of ALOHA's ${alohaRateKgMin} kg/min`,
    Math.abs(rateRatio - 1) < 0.1, `${(result.peakRate * 60).toFixed(0)} kg/min`);
  check(`chlorine ${w}: heavy gas`, built.isHeavyGas);
  const redRatio = zones[0] / alohaRed;
  check(`chlorine ${w}: AEGL-3 distance within 0.85-1.15x of ALOHA's ${alohaRed} m`,
    redRatio > 0.85 && redRatio < 1.15, `${zones[0].toFixed(0)} m = ${redRatio.toFixed(2)}x`);
}

console.log("\n=== 4. No area limit given ===");
{
  const limited = runTank("acetone", "typical", 10).result;
  const unlimited = runTank("acetone", "typical", "").result;
  check("without a limit the puddle grows far larger, and so does the evaporation",
    unlimited.puddleArea > 100 && unlimited.totalMass > limited.totalMass * 5,
    `${unlimited.puddleArea.toFixed(0)} m2, ${unlimited.totalMass.toFixed(0)} kg`);
  check("and the person is told so",
    unlimited.notes.some((n) => n.includes("No maximum puddle area")));
}

console.log("\n=== 5. Stand-alone puddles against ALOHA; terrain does not change evaporation ===");
{
  /* Real ALOHA (2026-10-01): 1000 kg on 10 m2, concrete, ground and puddle
     at air temperature, Eindhoven 02:00.
       P1 acetone, typical (D 5 m/s 15 C), open country   2.58 kg/min, 113 kg
       P2 the same, urban/forest                          2.58 kg/min, 113 kg
       P3 acetone, worst (F 1.5 m/s 5 C), urban/forest    0.613 kg/min, 33.1 kg
       P4 methanol, typical, open country                 0.757 kg/min, 35.9 kg */
  const worstNight = { windSpeed10m: 1.5, powerLawExponent: 0.253, airTemperatureK: 278.15,
    relativeHumidity: 80, cloudCoverOktas: 0 };
  const methanol = { molecularWeight: 32.04, boilingPointK: 337.8, heatOfVaporizationJPerMol: 35300,
    liquidDensity: 792, liquidHeatCapacityJPerKgK: 2530 };
  const run = (chemical, weather, roughnessLength) => simulatePuddleEvaporation({
    chemical, weather: { ...weather, roughnessLength }, spillMass: 1000, puddleArea: 10,
    substrateKey: "concrete", durationSeconds: 3600,
  });
  const p1 = run(acetone, typicalNight, 0.03), p2 = run(acetone, typicalNight, 1.0);
  const p3 = run(acetone, worstNight, 1.0), p4 = run(methanol, typicalNight, 0.03);
  const rate = (r) => r.series[1].rate * 60; // kg/min
  check("P1/P2: evaporation does not depend on the terrain roughness (as in ALOHA)",
    Math.abs(rate(p1) - rate(p2)) < 1e-9);
  for (const [label, r, aloha, alohaTotal] of [
    ["P1 acetone typical", p1, 2.58, 113],
    ["P3 acetone worst, urban", p3, 0.613, 33.1],
    ["P4 methanol typical", p4, 0.757, 35.9],
  ]) {
    const ratio = rate(r) / aloha;
    check(`${label}: rate within 10% of ALOHA's ${aloha} kg/min`, Math.abs(ratio - 1) < 0.1,
      `${rate(r).toFixed(3)} kg/min = ${ratio.toFixed(2)}x`);
    const totalRatio = r.totalEvaporated / alohaTotal;
    check(`${label}: hour's total within 10% of ALOHA's ${alohaTotal} kg`, Math.abs(totalRatio - 1) < 0.1,
      `${r.totalEvaporated.toFixed(1)} kg = ${totalRatio.toFixed(2)}x`);
  }
}

console.log("\n=== 6. Three more liquids, 5-35 C, small and large puddles, 1.5-10 m/s ===");
{
  /* Real ALOHA (2026-10-01), stand-alone puddle on concrete, ground and
     puddle at air temperature, open country, Eindhoven 02:00, RH 60% /
     cloud 5/10 (D) or RH 80% / cloud 0 (F). ALOHA's printed vapour pressure
     is checked too: HAZEL now estimates it with a temperature-dependent
     heat of vaporisation (engineSourcePuddle.js, vapourPressureAt()). */
  const chem = {
    methanol: { molecularWeight: 32.04, boilingPointK: 337.8, heatOfVaporizationJPerMol: 35300, liquidDensity: 792, liquidHeatCapacityJPerKgK: 2530 },
    benzene: { molecularWeight: 78.11, boilingPointK: 353.25, heatOfVaporizationJPerMol: 30720, liquidDensity: 876, liquidHeatCapacityJPerKgK: 1740 },
    toluene: { molecularWeight: 92.14, boilingPointK: 383.75, heatOfVaporizationJPerMol: 33180, liquidDensity: 867, liquidHeatCapacityJPerKgK: 1700 },
  };
  const weather = (U, cls, celsius) => ({
    windSpeed10m: U, powerLawExponent: cls === "F" ? 0.253 : 0.142, roughnessLength: 0.03,
    airTemperatureK: celsius + 273.15, relativeHumidity: cls === "F" ? 80 : 60, cloudCoverOktas: cls === "F" ? 0 : 4,
  });
  // label, substance, wind, class, C, mass, area, ALOHA kg/min, ALOHA kg/h, ALOHA vapour pressure atm
  const runs = [
    ["M1", "methanol", 5, "D", 25, 1000, 10, 1.28, 54.8, 0.17],
    ["M2", "methanol", 5, "D", 35, 1000, 10, 2.11, 79.2, 0.27],
    ["M3", "methanol", 10, "D", 15, 5000, 200, 24.2, 829, 0.096],
    ["B1", "benzene", 5, "D", 15, 1000, 10, 1.29, 65.9, 0.077],
    ["B3", "benzene", 5, "D", 30, 1000, 10, 2.55, 118, 0.16],
    ["T1", "toluene", 5, "D", 15, 1000, 10, 0.427, 23.9, 0.022],
    ["T2", "toluene", 1.5, "F", 5, 1000, 10, 0.0867, 5.05, 0.012],
    ["T3", "toluene", 5, "D", 30, 1000, 10, 0.902, 48.7, 0.048],
    ["T4", "toluene", 10, "D", 15, 5000, 200, 12.6, 684, 0.022],
  ];
  for (const [label, name, U, cls, celsius, mass, area, alohaRate, alohaTotal, alohaVp] of runs) {
    const c = chem[name];
    const vp = vapourPressureAt(celsius + 273.15, c.boilingPointK, c.heatOfVaporizationJPerMol) / 101325;
    check(`${label} ${name} ${celsius} C: vapour pressure within 10% of ALOHA's ${alohaVp} atm`,
      Math.abs(vp / alohaVp - 1) < 0.1, `${vp.toFixed(4)} atm = ${(vp / alohaVp).toFixed(2)}x`);
    const r = simulatePuddleEvaporation({
      chemical: c, weather: weather(U, cls, celsius), spillMass: mass, puddleArea: area,
      substrateKey: "concrete", durationSeconds: 3600,
    });
    const rateRatio = (r.series[1].rate * 60) / alohaRate;
    check(`${label}: rate within 12% of ALOHA's ${alohaRate} kg/min`, Math.abs(rateRatio - 1) < 0.12,
      `${(r.series[1].rate * 60).toFixed(3)} kg/min = ${rateRatio.toFixed(2)}x`);
    const totalRatio = r.totalEvaporated / alohaTotal;
    check(`${label}: hour's total within 10% of ALOHA's ${alohaTotal} kg`, Math.abs(totalRatio - 1) < 0.1,
      `${r.totalEvaporated.toFixed(1)} kg = ${totalRatio.toFixed(2)}x`);
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
