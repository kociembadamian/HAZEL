/**
 * sourceTests.js
 * --------------
 * Verification for the puddle evaporation model.  Run with:
 *   node tests/sourceTests.js
 *
 * Section 8 is the one that matters most: it reproduces the worked benzene
 * example published in ALOHA's own examples document and compares HAZEL's
 * answer with ALOHA's. That is the first end-to-end check in this project
 * against an independent implementation of the same models, rather than
 * against internal consistency or textbook formulas.
 */

import {
  molecularDiffusivity, schmidtNumber, puddleFrictionVelocity,
  roughnessReynoldsNumber, fSc, averageMassTransferCoefficient,
  volatilityCorrection, saturationConcentration, vapourPressureAt,
  solarFlux, longwaveUpFlux, longwaveDownFlux, waterVapourPartialPressure,
  groundHeatFlux, sensibleHeatFlux, evaporativeHeatFlux,
  simulatePuddleEvaporation, SUBSTRATE_PROPERTIES,
} from "../js/engine/engineSourcePuddle.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Molecular diffusivity (Graham's law) ===");
check("water returns its own reference value",
  closeTo(molecularDiffusivity(18.015), 2.39e-5, 1e-9));
check("a heavier molecule diffuses more slowly",
  molecularDiffusivity(78.11) < molecularDiffusivity(18.015));
check("diffusivity scales as 1/sqrt(M)",
  closeTo(molecularDiffusivity(72.06) / molecularDiffusivity(18.015), 0.5, 0.01),
  "quadrupling M should halve diffusivity");
check("Schmidt number for benzene is order 1",
  schmidtNumber(78.11) > 0.5 && schmidtNumber(78.11) < 1.5);

console.log("\n=== 2. Friction velocity and roughness ===");
const uStar = puddleFrictionVelocity(5, 10, 0.142);
check("friction velocity is ~3% of wind speed at 10 m", closeTo(uStar, 0.15, 0.001));
check("friction velocity rises with wind speed",
  puddleFrictionVelocity(10, 10, 0.142) > uStar);
check("roughness Reynolds number rises with roughness",
  roughnessReynoldsNumber(uStar, 1.0) > roughnessReynoldsNumber(uStar, 0.03));

console.log("\n=== 3. f(Sc) branches and their transition ===");
const sc = schmidtNumber(78.11);
check("smooth branch used below Re0 = 0.13", Number.isFinite(fSc(sc, 0.05)));
check("rough branch used above Re0 = 2", Number.isFinite(fSc(sc, 100)));
// The interpolation exists to avoid a discontinuity; check it is continuous
const justBelow = fSc(sc, 0.129), atLower = fSc(sc, 0.13);
const justUnder = fSc(sc, 1.999), atUpper = fSc(sc, 2.0);
check("no jump at the lower transition", closeTo(justBelow, atLower, 0.05),
  `${justBelow.toFixed(3)} vs ${atLower.toFixed(3)}`);
check("no jump at the upper transition", closeTo(justUnder, atUpper, 0.05),
  `${justUnder.toFixed(3)} vs ${atUpper.toFixed(3)}`);

console.log("\n=== 4. Vapour pressure (Clausius-Clapeyron) ===");
const benzeneBP = 353.25, benzeneHvap = 30720;
check("vapour pressure equals 1 atm at the boiling point",
  closeTo(vapourPressureAt(benzeneBP, benzeneBP, benzeneHvap), 101325, 1));
check("vapour pressure falls as temperature falls",
  vapourPressureAt(293.15, benzeneBP, benzeneHvap) < 101325);
// Published benzene vapour pressure at 20 C is about 10 kPa. The two-point
// Clausius-Clapeyron estimate runs high; the size of that error is worth
// pinning down rather than leaving unstated.
const vp20 = vapourPressureAt(293.15, benzeneBP, benzeneHvap);
check("benzene at 20 C is within 25% of the published 10 kPa",
  Math.abs(vp20 - 10000) / 10000 < 0.25, `got ${vp20.toFixed(0)} Pa`);

console.log("\n=== 5. Volatility correction ===");
const j = 0.002;
check("correction tends to 1 as vapour pressure tends to 0",
  closeTo(volatilityCorrection(j, 1, 101325) / j, 1, 1e-4));
check("correction grows with vapour pressure",
  volatilityCorrection(j, 50000, 101325) > volatilityCorrection(j, 10000, 101325));
check("correction is infinite at ambient pressure (boiling)",
  volatilityCorrection(j, 101325, 101325) === Infinity);

console.log("\n=== 6. Energy balance terms ===");
check("no solar flux below the horizon", solarFlux(-5, 0) === 0);
check("no solar flux at very low sun", solarFlux(3, 0) === 0);
check("clear sky admits more sun than overcast", solarFlux(60, 0) > solarFlux(60, 10));
check("solar flux at high sun is physically plausible",
  solarFlux(60, 0) > 500 && solarFlux(60, 0) < 1000, `${solarFlux(60, 0).toFixed(0)} W/m2`);

// Stefan-Boltzmann, checked by hand: 0.97 * 5.67e-8 * 288^4 = 378 W/m2
check("longwave up matches Stefan-Boltzmann by hand",
  closeTo(-longwaveUpFlux(288), 0.97 * 5.67e-8 * Math.pow(288, 4), 0.5));
check("longwave up is a loss (negative)", longwaveUpFlux(288) < 0);
check("a warmer puddle radiates more", Math.abs(longwaveUpFlux(300)) > Math.abs(longwaveUpFlux(280)));

const ew = waterVapourPartialPressure(288.15, 60);
check("water vapour partial pressure is plausible at 15 C, 60% RH",
  ew > 800 && ew < 1200, `${ew.toFixed(0)} Pa`);
check("humid air radiates more downward than dry",
  longwaveDownFlux(288.15, waterVapourPartialPressure(288.15, 90), 0) >
  longwaveDownFlux(288.15, waterVapourPartialPressure(288.15, 10), 0));
check("overcast radiates more downward than clear",
  longwaveDownFlux(288.15, ew, 10) > longwaveDownFlux(288.15, ew, 0));

// Ground conduction must decay as 1/sqrt(t)
const g10 = groundHeatFlux(288, 280, 10, SUBSTRATE_PROPERTIES.concrete);
const g1000 = groundHeatFlux(288, 280, 1000, SUBSTRATE_PROPERTIES.concrete);
check("ground flux decays as 1/sqrt(t)", closeTo(g10 / g1000, 10, 0.1),
  `ratio ${(g10 / g1000).toFixed(2)}, expected 10`);
check("warm ground heats a cold puddle", g10 > 0);
check("cold ground cools a warm puddle",
  groundHeatFlux(270, 290, 10, SUBSTRATE_PROPERTIES.concrete) < 0);
check("concrete conducts better than dry sandy soil",
  Math.abs(groundHeatFlux(288, 280, 10, SUBSTRATE_PROPERTIES.concrete)) >
  Math.abs(groundHeatFlux(288, 280, 10, SUBSTRATE_PROPERTIES.drySandySoil)));

check("evaporation always cools", evaporativeHeatFlux(0.001, 400000) < 0);
check("no evaporation means no evaporative cooling", evaporativeHeatFlux(0, 400000) === 0);

console.log("\n=== 7. Simulation behaviour ===");
const benzene = {
  molecularWeight: 78.11, boilingPointK: 353.25,
  heatOfVaporizationJPerMol: 30720, liquidDensity: 876,
  liquidHeatCapacityJPerKgK: 1740,
};
const mildWeather = {
  windSpeed10m: 5, powerLawExponent: 0.142, roughnessLength: 0.03,
  airTemperatureK: 288.15, relativeHumidity: 60, cloudCoverOktas: 4,
};
const base = {
  chemical: benzene, weather: mildWeather, spillMass: 1000,
  puddleArea: 100, substrateKey: "defaultSoil",
  solarElevationDegrees: 30, durationSeconds: 3600, timeStepSeconds: 1,
};

const run = simulatePuddleEvaporation(base);
check("evaporation occurs", run.totalEvaporated > 0);
check("mass is conserved", run.totalEvaporated <= base.spillMass + 1e-6);
check("a time series is produced", run.series.length > 0);
check("the rate declines as the puddle cools and shrinks",
  run.series[0].rate > run.series[Math.min(10, run.series.length - 1)].rate);

// Evaporative cooling must actually cool the pool below ambient
check("evaporative cooling drops the puddle below air temperature",
  run.series[5].temperature < mildWeather.airTemperatureK,
  `${(run.series[5].temperature - 273.15).toFixed(1)} C vs air ${(mildWeather.airTemperatureK - 273.15).toFixed(1)} C`);

// More wind means faster evaporation
const windy = simulatePuddleEvaporation({ ...base, weather: { ...mildWeather, windSpeed10m: 15 } });
check("stronger wind evaporates faster", windy.peakRate > run.peakRate,
  `15 m/s: ${windy.peakRate.toFixed(3)} vs 5 m/s: ${run.peakRate.toFixed(3)} kg/s`);

// A bigger puddle of the same mass evaporates faster (more surface area)
const spread = simulatePuddleEvaporation({ ...base, puddleArea: 400 });
check("a wider puddle evaporates faster", spread.peakRate > run.peakRate);

// A warmer day evaporates faster
const warm = simulatePuddleEvaporation({ ...base, weather: { ...mildWeather, airTemperatureK: 303.15 } });
check("warmer air evaporates faster", warm.peakRate > run.peakRate);

// A less volatile liquid evaporates more slowly
const heavier = simulatePuddleEvaporation({
  ...base,
  chemical: { ...benzene, boilingPointK: 450, heatOfVaporizationJPerMol: 45000 },
});
check("a higher-boiling liquid evaporates more slowly", heavier.peakRate < run.peakRate);

// Temperature must never exceed the boiling point
check("puddle temperature never exceeds the boiling point",
  run.series.every((p) => p.temperature <= benzene.boilingPointK + 1e-6));

console.log("\n=== 8. Comparison with ALOHA's published worked example ===");
/* From the ALOHA Examples document, Example 1 (Baton Rouge benzene spill):
     conditions  80 F, 7 mph from SW, open country, 7/8 cloud, 75% RH,
                 class D, concrete, 22:30 local time (dark)
     ALOHA reports
       Max Average Sustained Release Rate  77.1 lb/min (averaged over a
                                           minute or more)
       Total Amount Released               3,078 lb
       Release Duration                    46 minutes
       Puddle spread to                    21.6 yards diameter
   HAZEL is given the same puddle size and spill mass, and asked for the
   same quantities. */
const alohaDiameter = 19.75; // 21.6 yards in metres
const alohaArea = Math.PI * Math.pow(alohaDiameter / 2, 2);
const alohaRun = simulatePuddleEvaporation({
  chemical: benzene,
  weather: {
    windSpeed10m: 3.129,      // 7 mph
    powerLawExponent: 0.142,  // class D
    roughnessLength: 0.03,    // open country
    airTemperatureK: 299.82,  // 80 F
    relativeHumidity: 75,
    cloudCoverOktas: 7,
  },
  spillMass: 1396,            // 3,078 lb
  puddleArea: alohaArea,
  substrateKey: "concrete",
  solarElevationDegrees: -20, // night
  durationSeconds: 3600,
  timeStepSeconds: 1,
});

const KG_S_TO_LB_MIN = 132.277;
const sustainedRate = alohaRun.series[1].rate * KG_S_TO_LB_MIN;
const durationMinutes = alohaRun.durationSeconds / 60;

console.log(`  HAZEL sustained rate: ${sustainedRate.toFixed(1)} lb/min   ALOHA: 77.1 lb/min`);
console.log(`  HAZEL duration:       ${durationMinutes.toFixed(0)} min       ALOHA: 46 min`);
console.log(`  HAZEL total:          ${(alohaRun.totalEvaporated * 2.20462).toFixed(0)} lb      ALOHA: 3,078 lb`);

// 2026-10-01: with the Tech Doc's Schmidt number, the fixed puddle
// roughness (engineSourcePuddle.js, PUDDLE_ROUGHNESS_LENGTH) and the
// temperature-dependent heat of vaporisation in vapourPressureAt(), HAZEL
// gives benzene 0.139 atm at 80 F against a measured ~0.135 atm (the old
// fixed-L estimate gave 0.155). A non-boiling puddle evaporates in
// proportion to its vapour pressure, so the comparison is made both at
// ALOHA's vapour pressure and as computed.
const benzeneVapourRatio = vapourPressureAt(299.82, benzene.boilingPointK, benzene.heatOfVaporizationJPerMol) /
  (0.1351 * 101325);
const rateAtAlohaVapourPressure = sustainedRate / benzeneVapourRatio;
console.log(`  HAZEL rate at ALOHA's vapour pressure: ${rateAtAlohaVapourPressure.toFixed(1)} lb/min`);
check("sustained release rate matches ALOHA within 10% at the same vapour pressure",
  Math.abs(rateAtAlohaVapourPressure - 77.1) / 77.1 < 0.10,
  `${rateAtAlohaVapourPressure.toFixed(1)} vs 77.1 lb/min`);
check("as computed, HAZEL is within 10% of ALOHA",
  Math.abs(sustainedRate - 77.1) / 77.1 < 0.10,
  `${sustainedRate.toFixed(1)} vs 77.1 lb/min`);
check("release duration matches ALOHA within 20%",
  Math.abs(durationMinutes - 46) / 46 < 0.20,
  `${durationMinutes.toFixed(0)} vs 46 min`);
check("the whole spill evaporates, as ALOHA found", alohaRun.fullyEvaporated);

console.log("\n=== 9. Liquefied-gas puddle at ambient temperature — boiling switch (regression, 2026-09-26) ===");
// A liquefied gas (chlorine-like) modelled as a puddle at ordinary ambient
// temperature, well above its own boiling point — exactly the case
// the 2026-09-26 duration review finding #2 reported producing
// NaN/Infinity throughout. See engineSourcePuddle.js's module docstring.
const chlorineLike = {
  molecularWeight: 70.906, boilingPointK: 239.11,
  heatOfVaporizationJPerMol: 20410, liquidDensity: 1470,
  liquidHeatCapacityJPerKgK: 950,
};
const chlorineRun = simulatePuddleEvaporation({
  chemical: chlorineLike,
  weather: { windSpeed10m: 3, powerLawExponent: 0.142, roughnessLength: 0.03,
             airTemperatureK: 288.15, relativeHumidity: 50, cloudCoverOktas: 4 },
  spillMass: 500, puddleArea: 20, initialTemperature: 288.15,
  substrateKey: "concrete", solarElevationDegrees: 20,
  durationSeconds: 600, timeStepSeconds: 1,
});
check("no NaN/Infinity in the rate series",
  chlorineRun.series.every((p) => Number.isFinite(p.rate)));
check("no NaN/Infinity in the temperature series",
  chlorineRun.series.every((p) => Number.isFinite(p.temperature)));
check("evaporation actually occurs", chlorineRun.totalEvaporated > 0);
check("the puddle temperature drops to (at or below) its own boiling point rather than staying at ambient",
  chlorineRun.series[chlorineRun.series.length - 1].temperature < chlorineLike.boilingPointK + 1,
  `got ${chlorineRun.series[chlorineRun.series.length - 1].temperature.toFixed(1)} K vs ambient 288.15 K`);
check("puddle temperature never exceeds the boiling point",
  chlorineRun.series.every((p) => p.temperature <= chlorineLike.boilingPointK + 1e-6));

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
