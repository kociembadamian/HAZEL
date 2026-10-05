/**
 * chemicalTests.js
 * ----------------
 * Verification for the chemical database and its derived properties.
 * Run with:  node tests/chemicalTests.js
 *
 * These tests run against the REAL converted database rather than fixtures.
 * That is deliberate: the conversion from DOE's spreadsheet is where mistakes
 * would enter, and a fixture would only prove the code works on data the same
 * code produced. Running against the 3,148 real records catches conversion
 * errors that a synthetic record never would.
 *
 * Node has no fetch of local files, so the database module's loader is
 * bypassed here and the JSON is read from disk directly, then fed through the
 * same normalisation the browser path uses.
 */

import { readFileSync } from "node:fs";
import {
  vapourDensityRatio,
  describeVapourDensity,
  levelsOfConcern,
  isUsableForDispersion,
} from "../js/services/chemicalDatabase.js";
import { chooseDispersionModel, characteristicSourceHeight } from "../js/engine/engineDispersionChoice.js";

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

const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

// Load and normalise the slim index exactly as chemicalDatabase.js does.
const raw = JSON.parse(readFileSync(new URL("../data/chemicals.slim.json", import.meta.url), "utf8"));
const index = raw.map((r) => ({
  casNumber: r.cas,
  name: r.n,
  molecularFormula: r.f,
  state25C: r.s,
  molecularWeight: r.mw,
  pac1Ppm: r.p[0],
  pac2Ppm: r.p[1],
  pac3Ppm: r.p[2],
  lowerExplosiveLimitPpm: r.lel ?? null,
  originalUnit: r.u,
  searchName: (r.n || "").toLowerCase(),
}));

const byCas = (cas) => index.find((r) => r.casNumber === cas);

console.log("\n=== 1. Database integrity ===");
check("database loaded", index.length > 0, `${index.length} records`);
check("record count matches the source spreadsheet", index.length === 3148, `got ${index.length}`);
check("every record has a CAS number", index.every((r) => r.casNumber));
check("every record has a name", index.every((r) => r.name));

const duplicateCas = new Set();
const seen = new Set();
for (const r of index) {
  if (seen.has(r.casNumber)) duplicateCas.add(r.casNumber);
  seen.add(r.casNumber);
}
check("CAS numbers are unique", duplicateCas.size === 0, `${duplicateCas.size} duplicates`);

console.log("\n=== 2. Spot checks against independently known values ===");
// Methanol — cross-checked against the CAMEO Chemicals datasheet and the DOE
// PAC table, both consulted directly while building the converter.
const methanol = byCas("67-56-1");
check("methanol is present", Boolean(methanol));
check("methanol M = 32.04 g/mol", closeTo(methanol.molecularWeight, 32.04, 0.01));
check("methanol formula CH4O", methanol.molecularFormula === "CH4O");
check("methanol is a liquid at 25 °C", methanol.state25C === "liquid");
check("methanol PAC-1 = 530 ppm", methanol.pac1Ppm === 530, `got ${methanol.pac1Ppm}`);
check("methanol PAC-2 = 2100 ppm", methanol.pac2Ppm === 2100, `got ${methanol.pac2Ppm}`);
check("methanol PAC-3 = 7200 ppm", methanol.pac3Ppm === 7200, `got ${methanol.pac3Ppm}`);

// Chlorine — the PubChem record supplied earlier in this project gives
// AEGL-60min of 0.5 / 2 / 20 ppm, and PACs follow AEGLs where they exist.
const chlorine = byCas("7782-50-5");
check("chlorine is present", Boolean(chlorine));
check("chlorine M = 70.9 g/mol", closeTo(chlorine.molecularWeight, 70.9, 0.2), `got ${chlorine.molecularWeight}`);
check("chlorine PAC-1 = 0.5 ppm (matches AEGL-1 60 min)", closeTo(chlorine.pac1Ppm, 0.5, 0.01), `got ${chlorine.pac1Ppm}`);
check("chlorine PAC-2 = 2 ppm (matches AEGL-2 60 min)", closeTo(chlorine.pac2Ppm, 2, 0.01), `got ${chlorine.pac2Ppm}`);
check("chlorine PAC-3 = 20 ppm (matches AEGL-3 60 min)", closeTo(chlorine.pac3Ppm, 20, 0.01), `got ${chlorine.pac3Ppm}`);

console.log("\n=== 3. Vapour density ratio ===");
check("air-equivalent weight gives ratio 1", closeTo(vapourDensityRatio(28.96), 1, 1e-9));
// Chlorine's vapour density relative to air is published as 2.47-2.49
check("chlorine ratio ≈ 2.45", closeTo(vapourDensityRatio(70.9), 2.45, 0.05), `got ${vapourDensityRatio(70.9).toFixed(3)}`);
// Methanol's is published as 1.11
check("methanol ratio ≈ 1.11", closeTo(vapourDensityRatio(32.04), 1.11, 0.02), `got ${vapourDensityRatio(32.04).toFixed(3)}`);
// Ammonia is lighter than air
check("ammonia ratio < 1", vapourDensityRatio(17.03) < 1, `got ${vapourDensityRatio(17.03).toFixed(3)}`);
check("missing molecular weight yields null", vapourDensityRatio(null) === null);
check("zero molecular weight yields null", vapourDensityRatio(0) === null);

console.log("\n=== 4. Vapour density description (informational, not a gate) ===");
// This section exists because an earlier design DID gate on density alone and
// it was wrong — see the comment on describeVapourDensity(). These tests pin
// down that the function informs rather than blocks.
const chlorineDescription = describeVapourDensity(chlorine);
check("chlorine remains usable", chlorineDescription.usable === true);
check("chlorine draws no banner (its ratio is in the readout)",
  chlorineDescription.message === null);
check("chlorine still reports its ratio", chlorineDescription.ratio > 2);

const methanolDescription = describeVapourDensity(methanol);
check("methanol draws no banner", methanolDescription.message === null);

const lighterDescription = describeVapourDensity({ molecularWeight: 17.03 });
check("a lighter-than-air vapour is usable", lighterDescription.usable === true);
check("a lighter-than-air vapour gets a note", lighterDescription.severity === "note");
check("the note explains buoyant rise is not modelled", lighterDescription.message.includes("rise"));

const unknownDescription = describeVapourDensity({ molecularWeight: null });
check("missing molecular weight still blocks", unknownDescription.usable === false);
check("missing molecular weight is 'blocking'", unknownDescription.severity === "blocking");

// The critical check, and the reason this whole section exists: a banner must
// be the exception. Two earlier designs produced one on ~98% of substances,
// which is the same as producing none.
const withBanner = index
  .filter(isUsableForDispersion)
  .filter((r) => describeVapourDensity(r).message !== null);
const bannerPct = (100 * withBanner.length / index.filter(isUsableForDispersion).length);
console.log(`  ${withBanner.length} of ${index.filter(isUsableForDispersion).length} records draw a banner (${bannerPct.toFixed(1)}%)`);
check("a banner is the exception, not the rule", bannerPct < 20,
  `${bannerPct.toFixed(1)}% would make it background noise`);
check("some substances still do draw one", withBanner.length > 0,
  "a banner nobody ever sees is also useless");

console.log("\n=== 4a. Characteristic source height: puddle vs everything else (regression) ===");
// A real, user-reported bug: this used to apply the PUDDLE formula
// (H = E/(rho*U10*D)) to every source type, including a tank's small
// rupture hole. Dividing by a hole a few centimetres wide instead of a
// puddle several metres wide inflated the characteristic height by one or
// two orders of magnitude — a propane tank truck scenario in practice
// computed H=138 m from a 0.1 m hole, when the correct answer (via the
// OTHER formula the Tech Doc gives for non-puddle sources) was 3.3 m. That
// inflated height fed into the Richardson number and, further downstream,
// into the heavy-gas model's own seed value — the practical effect was
// every threat zone reporting "0 m", because the model believed the cloud
// was already many storeys tall and dilute at the moment it left the hole.
check("puddle formula matches E/(rho*U10*D) by hand",
  closeTo(characteristicSourceHeight(10, 2, 5, 4, true), 10 / (2 * 5 * 4), 1e-9));
check("non-puddle formula matches sqrt(E*pi/(4*rho*U10)) by hand",
  closeTo(characteristicSourceHeight(10, 2, 5, 4, false), Math.sqrt((10 * Math.PI) / (4 * 2 * 5)), 1e-9));
check("non-puddle height does NOT depend on the (irrelevant) diameter argument",
  characteristicSourceHeight(10, 2, 5, 4, false) === characteristicSourceHeight(10, 2, 5, 999, false));
check("a small hole no longer inflates height the way a puddle formula would",
  characteristicSourceHeight(126.6, 1.83, 5, 0.1, false) < 10,
  `got ${characteristicSourceHeight(126.6, 1.83, 5, 0.1, false).toFixed(2)} m — this is the exact propane/0.1m-hole case reported`);
check("defaulting isPuddle (omitted) behaves as non-puddle, not puddle",
  characteristicSourceHeight(10, 2, 5, 4) === characteristicSourceHeight(10, 2, 5, 4, false));

console.log("\n=== 4b. Richardson criterion (the real model choice) ===");
// The same substance must give different answers at different release rates —
// that is the whole point of moving the decision out of the Chemical step.
const chlorineBase = {
  molecularWeight: 70.9,
  sourceDiameter: 5,
  windSpeed10m: 5,
  roughnessLength: 0.03,
  temperature: 293.15,
};

// CHANGED 2026-09-30 (friction-velocity fix, see engineDispersionChoice.js's
// header comment): this used to be 0.0005 kg/s ("a slow leak"), which was
// genuinely passive under the old log-law screening. Under the corrected
// Deacon-based screening it is NOT — it now reads Ri≈3.3, Heavy Gas — because
// the corrected formula runs closer to real ALOHA's own behaviour, and a
// 0.0005 kg/s (30 g/min) chlorine leak at this wind speed is in fact close to
// where real ALOHA itself puts the boundary (see Test slowLeak's own value
// below and the 2026-09-30 ALOHA runs behind the Richardson/friction-velocity fix,
// Test E, a near-identical scenario checked against a real ALOHA run). A
// genuinely slow leak, one order of magnitude smaller, is used here instead
// so this test still demonstrates a real passive/non-passive boundary rather
// than accidentally sitting on the wrong side of it.
const slowLeak = chooseDispersionModel({ ...chlorineBase, releaseRate: 0.00002 });
const catastrophic = chooseDispersionModel({ ...chlorineBase, releaseRate: 50 });

console.log(`  Chlorine, 0.00002 kg/s: Ri = ${slowLeak.richardsonNumber.toFixed(3)} -> ${slowLeak.model}`);
console.log(`  Chlorine, 50 kg/s:   Ri = ${catastrophic.richardsonNumber.toFixed(1)} -> ${catastrophic.model}`);

check("a slow chlorine leak is passive (Gaussian)", slowLeak.model === "gaussian");
check("a catastrophic chlorine release is not (heavy gas)", catastrophic.model === "heavyGas");
check("Richardson number rises with release rate",
  catastrophic.richardsonNumber > slowLeak.richardsonNumber);

// Wind must matter too: more wind means more turbulence means more passive
const windy = chooseDispersionModel({ ...chlorineBase, releaseRate: 50, windSpeed10m: 20 });
check("stronger wind lowers the Richardson number",
  windy.richardsonNumber < catastrophic.richardsonNumber,
  `20 m/s: ${windy.richardsonNumber.toFixed(1)}, 5 m/s: ${catastrophic.richardsonNumber.toFixed(1)}`);

// CHANGED 2026-09-30 (friction-velocity fix): surface roughness used to
// lower the Richardson number (the old log-law U* formula depended on it).
// The corrected Deacon-based screening (screeningFrictionVelocity() in
// engineDispersionChoice.js) has NO roughness dependence at the standard
// 10 m reference height — and real ALOHA confirmed this directly: the same
// MEK puddle scenario gave Heavy Gas in both "Open Country" (z0=0.03 m) and
// "Urban or Forest" (z0=1.0 m) terrain (Test A2 in the comparison doc). This
// is therefore an intentional, validated property of the corrected model,
// not a regression to guard against — the test below pins it down so a
// future change that reintroduces roughness dependence here does not slip
// in unnoticed without someone deciding to change this comment too.
const roughOpenCountry = chooseDispersionModel({ ...chlorineBase, releaseRate: 50, roughnessLength: 0.03 });
const roughUrbanForest = chooseDispersionModel({ ...chlorineBase, releaseRate: 50, roughnessLength: 1.0 });
check("surface roughness no longer changes the Richardson number screening (matches real ALOHA behaviour, Test A2)",
  roughOpenCountry.richardsonNumber === roughUrbanForest.richardsonNumber,
  `z0=0.03: ${roughOpenCountry.richardsonNumber.toFixed(3)}, z0=1.0: ${roughUrbanForest.richardsonNumber.toFixed(3)}`);

// A lighter-than-air cloud can never be a heavy gas, whatever the release rate
const hydrogen = chooseDispersionModel({
  ...chlorineBase, molecularWeight: 2.016, releaseRate: 100,
});
check("hydrogen is Gaussian even at a huge release rate", hydrogen.model === "gaussian");
check("hydrogen reports a density ratio below 1", hydrogen.densityRatio < 1);

// A cold cloud is denser than its molecular weight alone implies
const ambient = chooseDispersionModel({ ...chlorineBase, releaseRate: 1 });
const cold = chooseDispersionModel({ ...chlorineBase, releaseRate: 1, cloudTemperature: 239 });
check("a cold cloud has a higher density ratio", cold.densityRatio > ambient.densityRatio,
  `cold ${cold.densityRatio.toFixed(2)} vs ambient ${ambient.densityRatio.toFixed(2)}`);

// Every explanation must say something actionable
check("explanations mention the Richardson number",
  catastrophic.explanation.includes("Richardson"));
// 2026-10-04: the verdict text no longer says "Stage 1" (an internal
// term); it names the heavy-gas model instead.
check("the heavy gas verdict names the heavy-gas model",
  catastrophic.explanation.includes("heavy-gas model"));

console.log("\n=== 4c. Real-ALOHA-validated scenarios (friction-velocity fix regression, 2026-09-30) ===");
// These six scenarios are exactly the ones used to validate the friction
// velocity fix in engineDispersionChoice.js — real ALOHA runs (2026-09-30),
// not constructed examples; the full parameters are in the assertions
// below. They are pinned down here as hard regression tests so a future change to the
// screening formula gets caught against real, previously-confirmed ALOHA
// behaviour rather than only against this file's other, synthetic scenarios.
check("A1: MEK puddle, 60m², open country, F-class -> Heavy Gas (matches real ALOHA)",
  chooseDispersionModel({
    molecularWeight: 72.11, releaseRate: 0.02480, sourceDiameter: 8.74,
    windSpeed10m: 1.5, roughnessLength: 0.03, temperature: 278.15, isPuddle: true,
  }).model === "heavyGas");

check("A2: same MEK puddle, urban/forest terrain -> still Heavy Gas (matches real ALOHA; roughness-invariant)",
  chooseDispersionModel({
    molecularWeight: 72.11, releaseRate: 0.01185, sourceDiameter: 8.74,
    windSpeed10m: 1.5, roughnessLength: 1.0, temperature: 278.15, isPuddle: true,
  }).model === "heavyGas");

check("B: Ethyl acetate puddle, 25m², open country, F-class -> Heavy Gas (matches real ALOHA)",
  chooseDispersionModel({
    molecularWeight: 88.11, releaseRate: 667 / 60000, sourceDiameter: 5.64,
    windSpeed10m: 1.5, roughnessLength: 0.03, temperature: 278.15, isPuddle: true,
  }).model === "heavyGas");

check("C: MEK small puddle, 1m² -> Gaussian (floor check; matches real ALOHA)",
  chooseDispersionModel({
    molecularWeight: 72.11, releaseRate: 30 / 60000, sourceDiameter: 1.13,
    windSpeed10m: 1.5, roughnessLength: 0.03, temperature: 278.15, isPuddle: true,
  }).model === "gaussian");

check("D: Chlorine direct/continuous release, 0.01 kg/s, wind 8 m/s -> Heavy Gas (matches real ALOHA)",
  chooseDispersionModel({
    molecularWeight: 70.906, releaseRate: 0.01, sourceDiameter: 1,
    windSpeed10m: 8, roughnessLength: 0.03, temperature: 278.15,
    cloudTemperature: 239.15, isPuddle: false,
  }).model === "heavyGas");

check("E: Chlorine direct/continuous release, 0.0002 kg/s -> Gaussian (floor check; matches real ALOHA)",
  chooseDispersionModel({
    molecularWeight: 70.906, releaseRate: 0.0002, sourceDiameter: 1,
    windSpeed10m: 8, roughnessLength: 0.03, temperature: 278.15,
    cloudTemperature: 239.15, isPuddle: false,
  }).model === "gaussian");

console.log("\n=== 5. Levels of concern ===");
const levels = levelsOfConcern(methanol);
check("four levels are returned for a flammable substance", levels.length === 4,
  `got ${levels.length}`);
check("levels run most severe first", levels[0].id === "pac3" && levels[2].id === "pac1");
check("PAC-3 maps to the red zone", levels[0].colour === "red");
check("PAC-2 maps to the orange zone", levels[1].colour === "orange");
check("PAC-1 maps to the yellow zone", levels[2].colour === "yellow");
// Severity ordering must hold: a more severe effect requires a higher dose
check("threshold values increase with severity",
  levels[2].ppm < levels[1].ppm && levels[1].ppm < levels[0].ppm,
  `${levels[2].ppm} / ${levels[1].ppm} / ${levels[0].ppm}`);

console.log("\n=== 5b. Flash fire (flammable area) ===");
check("methanol's fourth level is the flash-fire entry", levels[3].id === "flash");
check("flash fire has its own colour, not on the toxicity gradient",
  levels[3].colour === "flame");
// Methanol's LEL is published as 55,000 ppm (6% by volume) — see the PAC
// dataset conversion; 60% of that is 33,000 ppm.
check("flash fire threshold is 60% of the published LEL",
  closeTo(levels[3].ppm, 55000 * 0.6, 1), `got ${levels[3].ppm}`);
// Chlorine is an oxidiser with no LEL in the dataset — it must not get a
// flash-fire option just because it has PAC thresholds.
const chlorineLevels = levelsOfConcern(chlorine);
check("chlorine (no LEL) gets exactly three levels, not a flash-fire entry",
  chlorineLevels.length === 3, `got ${chlorineLevels.length}`);
check("chlorine has no 'flash' level", !chlorineLevels.some((l) => l.id === "flash"));

console.log("\n=== 6. Usability for dispersion ===");
check("methanol is usable", isUsableForDispersion(methanol) === true);
check("chlorine is usable (density warning is separate)", isUsableForDispersion(chlorine) === true);
check("null is not usable", isUsableForDispersion(null) === false);
check("a record with no molecular weight is not usable",
  isUsableForDispersion({ molecularWeight: null, pac2Ppm: 10 }) === false);
check("a record with no threshold is not usable",
  isUsableForDispersion({ molecularWeight: 30, pac1Ppm: null, pac2Ppm: null, pac3Ppm: null }) === false);

console.log("\n=== 7. Coverage across the whole database ===");
const usable = index.filter(isUsableForDispersion);
console.log(`  ${usable.length} of ${index.length} records are usable for dispersion ` +
            `(${(100 * usable.length / index.length).toFixed(1)}%)`);
check("most of the database is usable", usable.length / index.length > 0.9);

// Ordering must hold across every record, not just the spot checks. A
// violation would mean a conversion error, since the thresholds are defined
// to increase with severity.
const misordered = index.filter((r) => {
  const values = [r.pac1Ppm, r.pac2Ppm, r.pac3Ppm].filter(Number.isFinite);
  return values.length > 1 && values.some((v, i) => i > 0 && v < values[i - 1]);
});
check("PAC thresholds are non-decreasing in every record", misordered.length === 0,
  `${misordered.length} records violate this`);

// Every usable record must survive the assessment without throwing
let descriptionErrors = 0;
for (const record of usable) {
  try {
    describeVapourDensity(record);
  } catch {
    descriptionErrors++;
  }
}
check("the density description handles every usable record", descriptionErrors === 0,
  `${descriptionErrors} threw`);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
