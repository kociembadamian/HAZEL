/**
 * fireAlohaTests.js
 * -----------------
 * Pool fire, BLEVE fireball and jet fire against real ALOHA runs
 * (2026-10-01). Run with:  node tests/fireAlohaTests.js
 *
 * Eindhoven 02:00, D 5 m/s, 15 C, RH 60%, cloud 5/10, open country;
 * thermal levels 10 / 5 / 2 kW/m2 (ALOHA's defaults, 60 s).
 */

import { findPoolFireRadiationDistance, poolFireRadiationAt } from "../js/engine/enginePoolFire.js";
import { findFireballRadiationDistance, fireballDiameter } from "../js/engine/engineBleve.js";
import { findJetFireRadiationDistance } from "../js/engine/engineJetFire.js";
import { gaussianTransportWindSpeed } from "../js/engine/engineGaussian.js";
import { gasDensity, chooseDispersionModel } from "../js/engine/engineDispersionChoice.js";
import { findHeavyGasThreatZone } from "../js/engine/engineHeavyGas.js";
import { findThreatZone } from "../js/engine/engineGaussian.js";
import { estimateFlammableCloud } from "../js/engine/engineFlammableMass.js";
import { findOverpressureDistance, psiToPa } from "../js/engine/engineVce.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const T = 288.15;
const LEVELS = [10000, 5000, 2000];
const airDensity = gasDensity(28.96, T);

console.log("\n=== 1. Pool fire, toluene (ALOHA F1, F2) ===");
for (const [label, area, aloha, alohaFlame] of [["F1 20 m2", 20, [16, 20, 28], 10], ["F2 200 m2", 200, [44, 57, 82], 23]]) {
  const D = Math.sqrt((4 * area) / Math.PI);
  const scenario = {
    poolDiameter: D, heatOfCombustion: 40.9e6, heatOfVaporization: 33180 / 0.09214,
    specificHeatCapacity: 1700, boilingPoint: 383.75, poolTemperature: T,
    windSpeed: gaussianTransportWindSpeed(5, 0.03, "D"), ambientAirDensity: airDensity,
    relativeHumidity: 60, ambientTemperature: T,
  };
  const flame = poolFireRadiationAt({ ...scenario, receptorPoint: [D, 0, 0] }).flameHeight;
  check(`${label}: flame length rounds to ALOHA's ${alohaFlame} m`, Math.abs(flame - alohaFlame) < 0.7, `${flame.toFixed(1)} m`);
  LEVELS.forEach((w, i) => {
    const d = findPoolFireRadiationDistance({ ...scenario, thresholdWm2: w }).maxDistance;
    check(`${label}, ${w / 1000} kW/m2: within 0.85-1.15x of ALOHA's ${aloha[i]} m`,
      d / aloha[i] > 0.85 && d / aloha[i] < 1.15, `${d.toFixed(0)} m = ${(d / aloha[i]).toFixed(2)}x`);
  });
}

console.log("\n=== 2. BLEVE fireball, propane (ALOHA F3, F4) ===");
for (const [label, mass, aloha, alohaDiameter] of [["F3 16,037 kg", 16037, [338, 478, 745], 146], ["F4 962 kg", 962, [138, 195, 304], 57]]) {
  check(`${label}: fireball diameter ${alohaDiameter} m`, Math.abs(fireballDiameter(mass) - alohaDiameter) < 1);
  LEVELS.forEach((w, i) => {
    const d = findFireballRadiationDistance({ fireballMassKg: mass, heatOfCombustion: 46.35e6,
      relativeHumidity: 60, ambientTemperature: T, thresholdWm2: w }).maxDistance;
    check(`${label}, ${w / 1000} kW/m2: within 3% of ALOHA's ${aloha[i]} m`,
      Math.abs(d / aloha[i] - 1) < 0.03, `${d.toFixed(0)} m = ${(d / aloha[i]).toFixed(3)}x`);
  });
}

console.log("\n=== 3. Jet fire, propane two-phase (ALOHA F5, F6, ALOHA's own burn rates) ===");
for (const [label, rate, aloha] of [["F5 1,830 kg/min", 1830 / 60, [45, 64, 98]], ["F6 1,630 kg/min", 1630 / 60, [43, 60, 93]]]) {
  const scenario = {
    massFlowRate: rate, orificeDiameter: 0.05, specificHeatRatio: 1.13, sourceTemperature: T,
    molecularWeightKgPerMol: 0.0441, jetDensity: gasDensity(44.1, T), ambientDensity: airDensity,
    windSpeed: 5, choked: true, isAerosol: true, heatOfCombustion: 46.35e6, relativeHumidity: 60, ambientTemperature: T,
  };
  LEVELS.forEach((w, i) => {
    const d = findJetFireRadiationDistance({ ...scenario, thresholdWm2: w }).maxDistance;
    check(`${label}, ${w / 1000} kW/m2: within 10% of ALOHA's ${aloha[i]} m`,
      Math.abs(d / aloha[i] - 1) < 0.1, `${d.toFixed(0)} m = ${(d / aloha[i]).toFixed(2)}x`);
  });
}

console.log("\n=== 4. Flammable area and vapour-cloud explosion (ALOHA V1-V6, 2026-10-02) ===");
/* Direct source 1 kg/s for 10 min, D 5 m/s, 15 C. Propane: heavy gas in
   both tools; methane: Gaussian. Blast levels 8 / 3.5 / 1 psi. */
for (const [name, mw, lel, uel, hc, flamAloha, blasts] of [
  ["propane", 44.1, 21000, 95000, 46.35e6, [30, 96], [
    ["V2 congested, spark", "high", false, [null, 18, 34]],
    ["V3 uncongested, spark", "low", false, [null, null, null]],
    ["V4 detonation", "high", true, [23, 33, 71]],
  ]],
  ["methane", 16.04, 50000, 150000, 50.0e6, [41, 102], []],
  // Butane, ALOHA R1/R2 (2026-10-02): heavy gas in both tools. The R2 KML
  // shows the 1 psi circle centred 9.5 m downwind with a 25.6 m radius;
  // HAZEL places it 11.4 m out with 23.0 m, the same 34-35 m reach.
  ["butane", 58.12, 16000, 84000, 45.75e6, [29, 90], [
    ["R2 congested, spark", "high", false, [null, 17, 35]],
  ]],
]) {
  const d = chooseDispersionModel({ molecularWeight: mw, releaseRate: 1, sourceDiameter: 0.01, windSpeed10m: 5, roughnessLength: 0.03, temperature: T });
  const hg = d.model === "heavyGas";
  const base = hg
    ? { releaseRate: 1, releaseDuration: 600, molecularWeight: mw, temperature: T, windSpeed10m: 5, roughnessLength: 0.03,
        stabilityClass: "D", sourceHalfWidth: 0.05, characteristicHeight: d.characteristicHeight }
    : { releaseRate: 1, releaseDuration: 600, releaseHeight: 0, stabilityClass: "D", roughnessLength: 0.03, temperature: T,
        molecularWeight: mw, windSpeed10m: 5 };
  [0.6, 0.1].forEach((frac, i) => {
    const dist = (hg ? findHeavyGasThreatZone : findThreatZone)({ ...base, levelOfConcernPpm: frac * lel, flammableAveraging: true }).maxDownwindDistance;
    check(`${name} flammable area ${frac * 100}% LEL: within 0.85-1.15x of ALOHA's ${flamAloha[i]} m`,
      dist / flamAloha[i] > 0.85 && dist / flamAloha[i] < 1.15, `${dist.toFixed(0)} m = ${(dist / flamAloha[i]).toFixed(2)}x`);
  });
  const cloud = estimateFlammableCloud({ isHeavyGas: hg, scenarioBase: base, lowerExplosiveLimitPpm: lel, upperExplosiveLimitPpm: uel });
  if (name === "propane") {
    // Fitting ALOHA's three detonation distances gives an explosive mass of
    // 4.60 kg plus a 9.5 m cloud-centre offset.
    check("propane: flammable mass within 3% of the 4.60 kg ALOHA's detonation distances imply",
      Math.abs(cloud.massKg / 4.6 - 1) < 0.03, `${cloud.massKg.toFixed(2)} kg`);
  }
  for (const [label, congestion, hard, aloha] of blasts) {
    [8, 3.5, 1].forEach((psi, i) => {
      const z = findOverpressureDistance({ flammableMassKg: cloud.massKg, heatOfCombustion: hc, reactivity: "medium",
        congestion, hardIgnition: hard, thresholdPa: psiToPa(psi) });
      if (aloha[i] === null) {
        check(`${name} ${label}, ${psi} psi: not exceeded, as in ALOHA`, !z.thresholdExceeded,
          `HAZEL ${(z.maxDistance + cloud.centreX).toFixed(0)} m`);
      } else {
        const dist = z.maxDistance + cloud.centreX;
        check(`${name} ${label}, ${psi} psi: within 0.85-1.15x of ALOHA's ${aloha[i]} m`,
          z.thresholdExceeded && dist / aloha[i] > 0.85 && dist / aloha[i] < 1.15, `${dist.toFixed(0)} m = ${(dist / aloha[i]).toFixed(2)}x`);
      }
    });
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
