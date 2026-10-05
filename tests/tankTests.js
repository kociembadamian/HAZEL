/**
 * tankTests.js
 * ------------
 * Verification for tank geometry and the three tank release models.
 * Run with:  node tests/tankTests.js
 *
 * Section 1 checks geometry against cases with exact known answers — a
 * horizontal cylinder filled to its axis holds exactly half its volume, a
 * sphere filled to its diameter holds all of it. Geometry errors would be
 * invisible downstream: the release rate would simply come out wrong, and
 * plausibly so.
 *
 * Section 6 is the important one: it reproduces the propane tank car example
 * published in ALOHA's own examples document. Together with the benzene
 * puddle comparison in sourceTests.js, this gives HAZEL two independent
 * end-to-end checks against a separate implementation of the same models.
 */

import {
  tankVolume, liquidVolumeAtDepth, depthForLiquidVolume,
  submergedHoleArea, headAboveHole,
} from "../js/engine/engineTankGeometry.js";
import {
  liquidMassFlowRate, pressureAtHole, vapourSpecificVolume,
  twoPhaseMassFlux, maximumQuality, criticalPressureRatio,
  chokedGasFlowRate, unchokedGasFlowRate, gasReleaseRate,
  expandedGasTemperatureWithGamma, selectReleaseModel, simulateTankRelease,
} from "../js/engine/engineSourceTank.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}
const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Tank geometry, against exact answers ===");
const hCyl = { shape: "horizontalCylinder", diameter: 2, length: 5 };
const vCyl = { shape: "verticalCylinder", diameter: 2, length: 5 };
const sphere = { shape: "sphere", diameter: 2 };

check("horizontal cylinder volume = pi*r^2*L",
  closeTo(tankVolume(hCyl), Math.PI * 1 * 1 * 5, 1e-9));
check("sphere volume = 4/3*pi*r^3",
  closeTo(tankVolume(sphere), (4 / 3) * Math.PI, 1e-9));
check("horizontal cylinder filled to its axis is exactly half full",
  closeTo(liquidVolumeAtDepth(hCyl, 1) / tankVolume(hCyl), 0.5, 1e-9));
check("sphere filled to its centre is exactly half full",
  closeTo(liquidVolumeAtDepth(sphere, 1) / tankVolume(sphere), 0.5, 1e-9));
check("vertical cylinder fills linearly",
  closeTo(liquidVolumeAtDepth(vCyl, 2.5) / tankVolume(vCyl), 0.5, 1e-9));
check("empty at zero depth", liquidVolumeAtDepth(hCyl, 0) === 0);
check("full at full depth", closeTo(liquidVolumeAtDepth(hCyl, 2), tankVolume(hCyl), 1e-9));
check("overfilling is clamped, not extrapolated",
  closeTo(liquidVolumeAtDepth(hCyl, 99), tankVolume(hCyl), 1e-9));

console.log("\n=== 2. Depth/volume inversion ===");
let inversionOk = true;
for (const fraction of [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]) {
  const target = tankVolume(hCyl) * fraction;
  const depth = depthForLiquidVolume(hCyl, target);
  const roundTrip = liquidVolumeAtDepth(hCyl, depth) / tankVolume(hCyl);
  if (Math.abs(roundTrip - fraction) > 1e-3) inversionOk = false;
}
check("horizontal cylinder inversion round-trips at every fill level", inversionOk);
check("sphere inversion round-trips",
  closeTo(liquidVolumeAtDepth(sphere, depthForLiquidVolume(sphere, tankVolume(sphere) * 0.3)) /
    tankVolume(sphere), 0.3, 1e-3));
// The non-linearity is the point: a horizontal tank is not half full at half depth
check("horizontal cylinder fill is non-linear with depth",
  Math.abs(liquidVolumeAtDepth(hCyl, 0.5) / tankVolume(hCyl) - 0.25) > 0.01,
  "quarter depth should not be quarter volume");

console.log("\n=== 3. Submerged hole area ===");
const roundHole = { shape: "circular", diameter: 0.2, heightAboveBottom: 0.5 };
check("a hole above the liquid is dry", submergedHoleArea(roundHole, 0.4).dry === true);
check("a hole level with the surface is dry", submergedHoleArea(roundHole, 0.5).dry === true);
check("a hole half covered passes half its area",
  closeTo(submergedHoleArea(roundHole, 0.6).submergedArea /
    submergedHoleArea(roundHole, 0.6).totalArea, 0.5, 1e-6));
check("a fully covered hole is flagged as such",
  submergedHoleArea(roundHole, 0.75).fullySubmerged === true);
check("a hole exactly covered to its top counts as full",
  submergedHoleArea(roundHole, 0.7).fullySubmerged === true);

const slot = { shape: "rectangular", width: 1.0, height: 0.1, heightAboveBottom: 0.2 };
check("rectangular hole scales linearly with submerged height",
  closeTo(submergedHoleArea(slot, 0.25).submergedArea, 0.05, 1e-9));
check("head above the hole is never negative", headAboveHole(0.1, roundHole) === 0);

console.log("\n=== 4. Liquid release (Bernoulli) ===");
const flowBase = {
  submergedArea: 0.01, pressureAtHole: 200000,
  ambientPressure: 101325, liquidDensity: 800,
};
const flow = liquidMassFlowRate(flowBase);
// Hand check: 0.61 * 0.01 * sqrt(2 * 98675 * 800) = 0.61*0.01*12567 = 76.7 kg/s
check("flow matches a hand calculation", closeTo(flow, 76.66, 0.5), `got ${flow.toFixed(2)}`);
check("no flow when inside and outside pressures match",
  liquidMassFlowRate({ ...flowBase, pressureAtHole: 101325 }) === 0);
check("no flow through a dry hole",
  liquidMassFlowRate({ ...flowBase, submergedArea: 0 }) === 0);
check("flow rises with driving pressure",
  liquidMassFlowRate({ ...flowBase, pressureAtHole: 400000 }) > flow);
check("flow scales with the square root of pressure",
  closeTo(liquidMassFlowRate({ ...flowBase, pressureAtHole: 101325 + 4 * 98675 }) / flow, 2, 0.01),
  "quadrupling the driving pressure should double the rate");
check("flow rises with hole area",
  liquidMassFlowRate({ ...flowBase, submergedArea: 0.02 }) > flow);

console.log("\n=== 5. Pressure at the hole ===");
const head = pressureAtHole({ vapourPressure: 50000, liquidDensity: 800, headHeight: 2 });
// 50000 + 800*9.80665*2 = 50000 + 15691 = 65691, but the floor is 1.01*101325 = 102338
check("the ALOHA pressure floor applies when the computed value is low",
  closeTo(head, 1.01 * 101325, 1), `got ${head.toFixed(0)} Pa`);
const highHead = pressureAtHole({ vapourPressure: 300000, liquidDensity: 800, headHeight: 2 });
check("hydrostatic head adds to vapour pressure when above the floor",
  closeTo(highHead, 300000 + 800 * 9.80665 * 2, 1));
check("a deeper head gives more pressure",
  pressureAtHole({ vapourPressure: 300000, liquidDensity: 800, headHeight: 5 }) > highHead);

console.log("\n=== 6. Two-phase flow (Homogeneous Nonequilibrium Model) ===");
const propane = {
  latentHeat: (18770 / 44.10) * 1000,  // J/kg
  vapourSpecificVolume: vapourSpecificVolume(44.10, 294.26, 800000),
  liquidSpecificVolume: 1 / 493,
  heatCapacity: 2500,
  temperature: 294.26,
  pressureDifference: 800000 - 101325,
};
const flux = twoPhaseMassFlux(propane);
check("two-phase flux is positive and finite", flux > 0 && Number.isFinite(flux));
check("two-phase flux is a plausible magnitude for propane",
  flux > 1000 && flux < 50000, `${flux.toFixed(0)} kg/(m2*s)`);
check("a longer pipe reduces the flux",
  twoPhaseMassFlux({ ...propane, pipeLength: 0.1 }) < flux,
  "more pipe means more flashing, which chokes the flow");
check("no flux without a pressure difference",
  twoPhaseMassFlux({ ...propane, pressureDifference: 0 }) === 0);
// The Tech Doc's printed equation for this is dimensionally inconsistent —
// see the comment on maximumQuality() for the analysis and the corrected form.
const quality = maximumQuality(propane);
check("maximum quality is a valid mass fraction for propane",
  quality > 0 && quality < 1, `got ${quality.toFixed(3)}`);
check("propane quality is a plausible ~19% vapour",
  closeTo(quality, 0.19, 0.03), `got ${quality.toFixed(3)}`);
check("a larger pressure drop flashes more of the liquid",
  maximumQuality({ ...propane, pressureDifference: propane.pressureDifference * 2 }) > quality);

console.log("\n=== 7. Gas release ===");
const gamma = 1.4;
// For air-like gas the big-hole critical ratio is the textbook 0.528
check("critical pressure ratio for a big hole matches the textbook value",
  closeTo(criticalPressureRatio(gamma, 0.5), 0.528, 0.001),
  `got ${criticalPressureRatio(gamma, 0.5).toFixed(4)}`);
check("the small-hole form returns a valid ratio",
  (() => { const r = criticalPressureRatio(gamma, 0.1); return r > 0 && r < 1; })(),
  `got ${criticalPressureRatio(gamma, 0.1).toFixed(4)}`);

const gasArgs = {
  holeArea: 0.001, holeDimension: 0.036, tankDimension: 2,
  gasDensity: 10, tankPressure: 1000000, ambientPressure: 101325, gamma,
};
const choked = gasReleaseRate(gasArgs);
check("a high pressure ratio gives choked flow", choked.choked === true);
check("choked flow rate is positive", choked.rate > 0);

const lowPressure = gasReleaseRate({ ...gasArgs, tankPressure: 120000 });
check("a low pressure ratio gives unchoked flow", lowPressure.choked === false);
check("unchoked flow is slower than choked", lowPressure.rate < choked.rate);
check("no flow when tank pressure equals ambient",
  unchokedGasFlowRate({ ...gasArgs, tankPressure: 101325 }) === 0);

const expanded = expandedGasTemperatureWithGamma(300, 1000000, 101325, gamma);
check("expanding gas cools", expanded < 300, `${expanded.toFixed(1)} K from 300 K`);
check("expansion cooling is substantial at high pressure ratio", expanded < 200);

console.log("\n=== 8. Model selection ===");
check("a gas tank gives the gas model",
  selectReleaseModel({ storedPhase: "gas", temperature: 300, boilingPointK: 200, holeIsSubmerged: true }) === "gas");
check("a liquid below its boiling point gives the liquid model",
  selectReleaseModel({ storedPhase: "liquid", temperature: 290, boilingPointK: 353, holeIsSubmerged: true }) === "liquid");
check("a liquid above its boiling point gives two-phase",
  selectReleaseModel({ storedPhase: "liquid", temperature: 294, boilingPointK: 231, holeIsSubmerged: true }) === "twoPhase");

console.log("\n=== 9. Comparison with ALOHA's published propane example ===");
/* ALOHA Examples, Example 2 (Columbia SC derailment):
     Tank      33,800 gallons, 70 ft long, 9.07 ft diameter, horizontal, 100% full
     Contents  propane liquefied under pressure, 70 F
     Rupture   rectangular seam failure, 40 in x 0.1 in, at the tank bottom
   ALOHA reported:
     Max Average Sustained Release Rate  5,730 lb/min
     Total Amount Released               140,200 lb
     Release Duration                    26 minutes
     "The chemical escaped as a mixture of gas and aerosol (two phase flow)" */
const FT = 0.3048, IN = 0.0254, KG_S_TO_LB_MIN = 132.277;
const propaneRun = simulateTankRelease({
  tank: { shape: "horizontalCylinder", diameter: 9.07 * FT, length: 70 * FT, fillFraction: 1.0 },
  hole: { shape: "rectangular", width: 40 * IN, height: 0.1 * IN, heightAboveBottom: 0, pipeLength: 0 },
  chemical: {
    molecularWeight: 44.10, boilingPointK: 231.1, heatOfVaporizationJPerMol: 18770,
    liquidDensity: 493, liquidHeatCapacityJPerKgK: 2500, gammaRatio: 1.13,
  },
  temperature: 294.26,
  storedPhase: "liquid",
  durationSeconds: 7200,
  timeStepSeconds: 1,
});

const rateLbMin = propaneRun.peakRate * KG_S_TO_LB_MIN;
const minutes = propaneRun.durationSeconds / 60;
console.log(`  Regime:    ${propaneRun.regime}`);
console.log(`  Rate:      ${rateLbMin.toFixed(0)} lb/min      ALOHA: 5,730 lb/min`);
console.log(`  Duration:  ${minutes.toFixed(1)} min           ALOHA: 26 min`);
console.log(`  Released:  ${(propaneRun.totalReleased * 2.20462).toFixed(0)} lb     ALOHA: 140,200 lb`);

check("ALOHA's two-phase regime is reproduced",
  propaneRun.regime.includes("two-phase"));
check("release rate matches ALOHA within 10%",
  Math.abs(rateLbMin - 5730) / 5730 < 0.10, `${rateLbMin.toFixed(0)} vs 5,730 lb/min`);
check("release duration matches ALOHA within 15%",
  Math.abs(minutes - 26) / 26 < 0.15, `${minutes.toFixed(1)} vs 26 min`);
check("the tank empties, as ALOHA found", propaneRun.emptied);

console.log("\n=== 10. Draining behaviour ===");
const drain = simulateTankRelease({
  tank: { shape: "horizontalCylinder", diameter: 2, length: 5, fillFraction: 0.8 },
  hole: { shape: "circular", diameter: 0.05, heightAboveBottom: 0.1 },
  chemical: {
    molecularWeight: 78.11, boilingPointK: 353.25, heatOfVaporizationJPerMol: 30720,
    liquidDensity: 876, liquidHeatCapacityJPerKgK: 1740,
  },
  temperature: 288.15,
  storedPhase: "liquid",
  durationSeconds: 7200,
  timeStepSeconds: 1,
});
check("a non-boiling liquid uses the Bernoulli model",
  drain.regime.includes("Bernoulli"));
check("the rate falls as the tank drains",
  drain.series[0].rate > drain.series[drain.series.length - 1].rate,
  `${drain.series[0].rate.toFixed(3)} -> ${drain.series[drain.series.length - 1].rate.toFixed(3)} kg/s`);
check("mass released never exceeds the initial inventory",
  drain.totalReleased <= drain.initialMass + 1e-6);
check("draining stops when the level reaches the hole",
  drain.totalReleased < drain.initialMass,
  "liquid below the hole cannot escape");

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
