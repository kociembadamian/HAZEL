/**
 * flammableMassTests.js
 * ----------------------
 * Verification for the automatic VCE flammable-mass integration
 * (engineFlammableMass.js). Run with:  node tests/flammableMassTests.js
 *
 * There is no ALOHA worked example to reproduce here — the Tech Doc
 * describes the method (couple an air dispersion model to the LEL/UEL
 * bounds) without printing a numerical example — so these tests check
 * physical direction and the mass's actual order of magnitude, the same
 * approach vceTests.js and heavyGasTests.js already use for their own
 * unexampled sections. Both the Gaussian and heavy-gas integration paths
 * are exercised against genuinely different, model-appropriate scenarios
 * (a light gas that always disperses passively, and a large dense-gas
 * release that routes to the heavy-gas model) rather than one convenient
 * case, and chooseDispersionModel()'s own verdict is checked at the start
 * of each so a scenario silently routing to the wrong engine would be
 * caught rather than quietly testing nothing meaningful.
 */

import { estimateFlammableMass } from "../js/engine/engineFlammableMass.js";
import { chooseDispersionModel } from "../js/engine/engineDispersionChoice.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== 1. Gaussian model: ammonia-like (lighter than air), modest release ===");
// Ammonia: M=17.03 g/mol (lighter than air -> always routes to the
// Gaussian model regardless of release rate, per chooseDispersionModel()'s
// own "lighter than air cannot slump" branch), LEL ~150000 ppm (15%), UEL
// ~280000 ppm (28%).
const gaussianBase = {
  releaseRate: 2, // kg/s
  releaseDuration: 600,
  releaseHeight: 0,
  stabilityClass: "D",
  roughnessLength: 0.03,
  temperature: 293.15,
  molecularWeight: 17.03,
  windSpeed10m: 4,
  inversionHeight: null,
};
const verdict1 = chooseDispersionModel({
  molecularWeight: 17.03, releaseRate: 2, sourceDiameter: 0.05,
  windSpeed10m: 4, roughnessLength: 0.03, temperature: 293.15, isPuddle: false,
});
check("this scenario actually routes to the Gaussian model (test is meaningful)",
  verdict1.model === "gaussian");

const mass1 = estimateFlammableMass({
  isHeavyGas: false,
  scenarioBase: gaussianBase,
  lowerExplosiveLimitPpm: 150000,
  upperExplosiveLimitPpm: 280000,
});
check("mass is positive and finite", Number.isFinite(mass1) && mass1 > 0, `got ${mass1}`);
check("mass is a plausible order of magnitude for a 2 kg/s release (not absurdly huge or tiny)",
  mass1 > 0.01 && mass1 < 1e5, `got ${mass1}`);

console.log("\n=== 2. Gaussian: a bigger release rate gives more flammable mass ===");
const mass2 = estimateFlammableMass({
  isHeavyGas: false,
  scenarioBase: { ...gaussianBase, releaseRate: 8 },
  lowerExplosiveLimitPpm: 150000,
  upperExplosiveLimitPpm: 280000,
});
check("4x release rate gives more flammable mass", mass2 > mass1, `mass1=${mass1}, mass2=${mass2}`);

console.log("\n=== 3. Gaussian: a narrower LEL-UEL band gives less mass ===");
const massNarrowBand = estimateFlammableMass({
  isHeavyGas: false,
  scenarioBase: gaussianBase,
  lowerExplosiveLimitPpm: 150000,
  upperExplosiveLimitPpm: 160000, // artificially narrow band, for comparison only
});
check("a narrower flammable band gives less mass than the real one",
  massNarrowBand < mass1, `narrow=${massNarrowBand}, real=${mass1}`);
check("a narrower but still valid band gives a positive mass", massNarrowBand > 0);

console.log("\n=== 4. Explosive-limit validation ===");
check("throws when the UEL is at or below 90% of the LEL",
  (() => {
    try {
      estimateFlammableMass({ isHeavyGas: false, scenarioBase: gaussianBase, lowerExplosiveLimitPpm: 150000, upperExplosiveLimitPpm: 100000 });
      return false;
    } catch { return true; }
  })());
check("throws with no LEL", (() => {
  try { estimateFlammableMass({ isHeavyGas: false, scenarioBase: gaussianBase, lowerExplosiveLimitPpm: null, upperExplosiveLimitPpm: 280000 }); return false; }
  catch { return true; }
})());
check("throws with no UEL", (() => {
  try { estimateFlammableMass({ isHeavyGas: false, scenarioBase: gaussianBase, lowerExplosiveLimitPpm: 150000, upperExplosiveLimitPpm: null }); return false; }
  catch { return true; }
})());
check("throws with a negative LEL", (() => {
  try { estimateFlammableMass({ isHeavyGas: false, scenarioBase: gaussianBase, lowerExplosiveLimitPpm: -1, upperExplosiveLimitPpm: 280000 }); return false; }
  catch { return true; }
})());

console.log("\n=== 5. Gaussian: a negligible release gives a negligible flammable mass ===");
const massTiny = estimateFlammableMass({
  isHeavyGas: false,
  scenarioBase: { ...gaussianBase, releaseRate: 0.0001 },
  lowerExplosiveLimitPpm: 150000,
  upperExplosiveLimitPpm: 280000,
});
// Not exactly zero: a Gaussian point source is mathematically singular at
// x=0 (sigmaY/sigmaZ both vanish there), so even a vanishingly small
// release rate still has an infinitesimal, hyper-concentrated region right
// at the source that exceeds any finite threshold. The MASS in that region
// is itself vanishingly small, which is what this actually checks — see
// gaussianFlammableMass()'s own docstring in engineFlammableMass.js.
check("a negligible release gives a negligible flammable mass",
  massTiny < 1e-3, `got ${massTiny}`);

console.log("\n=== 6. Heavy gas model: a large, dense-gas release ===");
const heavyVerdict = chooseDispersionModel({
  molecularWeight: 70.9, releaseRate: 15, sourceDiameter: 0.1,
  windSpeed10m: 3, roughnessLength: 0.03, temperature: 293.15, isPuddle: false,
});
check("this scenario actually routes to the heavy gas model (test is meaningful)",
  heavyVerdict.model === "heavyGas");

const heavyBase = {
  releaseRate: 15,
  molecularWeight: 70.9,
  temperature: 293.15,
  windSpeed10m: 3,
  roughnessLength: 0.03,
  stabilityClass: "D",
  sourceHalfWidth: 0.05,
  characteristicHeight: heavyVerdict.characteristicHeight,
};

// The chosen substance (chlorine-like molecular weight, already used and
// validated in heavyGasTests.js) is not itself flammable; the LEL/UEL
// values below are a numerical stand-in purely to exercise the heavy-gas
// integration path with a scenario the Richardson-number screening
// genuinely routes to that engine.
const massHeavy = estimateFlammableMass({
  isHeavyGas: true,
  scenarioBase: heavyBase,
  lowerExplosiveLimitPpm: 30000,
  upperExplosiveLimitPpm: 120000,
});
check("heavy-gas mass is positive and finite", Number.isFinite(massHeavy) && massHeavy > 0, `got ${massHeavy}`);

console.log("\n=== 7. Heavy gas: a bigger release gives more flammable mass ===");
const massHeavy2 = estimateFlammableMass({
  isHeavyGas: true,
  scenarioBase: { ...heavyBase, releaseRate: 60 },
  lowerExplosiveLimitPpm: 30000,
  upperExplosiveLimitPpm: 120000,
});
check("4x release rate gives more flammable mass (heavy gas)",
  massHeavy2 > massHeavy, `${massHeavy} -> ${massHeavy2}`);

console.log("\n=== 8. Heavy gas: a negligible release gives zero flammable mass ===");
const massHeavyTiny = estimateFlammableMass({
  isHeavyGas: true,
  scenarioBase: { ...heavyBase, releaseRate: 0.001 },
  lowerExplosiveLimitPpm: 30000,
  upperExplosiveLimitPpm: 120000,
});
// Unlike the Gaussian model, the heavy-gas march starts from a finite
// station (x0 = max(effectiveRadius, 0.1), see marchDownwind() in
// engineHeavyGas.js), not a mathematical point — so there is no
// near-source singularity here, and an exact zero is the right answer.
check("a negligible heavy-gas release gives exactly zero flammable mass",
  massHeavyTiny === 0, `got ${massHeavyTiny}`);

console.log("\n=== 9. Heavy gas: finite-duration cliff must not starve the VCE mass integral (regression, 2026-09-26) ===");
// the 2026-09-26 duration review finding #1: heavyGasFlammableMass()'s
// own coarse pass shared the exact same fixed-spacing vulnerability that
// findHeavyGasThreatZone() was found and fixed to have — a brief release's
// finiteDurationFactor() cliff (engineHeavyGas.js) could fall entirely
// between two coarse stations, so the search never found where the real
// zone was and the integral silently returned close to zero for a real,
// substantial release. A large propane-like heavy-gas release (matching the
// audit's own reproduction) is used here specifically because it is big
// enough that even a brief release still carries a genuinely large
// flammable mass once correctly found — a scenario where "near zero" is
// unambiguously wrong.
const propaneVerdict = chooseDispersionModel({
  molecularWeight: 44.1, releaseRate: 20, sourceDiameter: 0.1,
  windSpeed10m: 4, roughnessLength: 0.03, temperature: 293.15, isPuddle: false,
});
check("the propane cliff-regression scenario actually routes to the heavy gas model",
  propaneVerdict.model === "heavyGas");

const propaneBase = {
  releaseRate: 20,
  molecularWeight: 44.1,
  temperature: 293.15,
  windSpeed10m: 4,
  roughnessLength: 0.03,
  stabilityClass: "D",
  sourceHalfWidth: 0.05,
  characteristicHeight: propaneVerdict.characteristicHeight,
};
// Propane's real LEL/UEL (2.1% / 9.5%), in ppm.
const propaneLimits = { lowerExplosiveLimitPpm: 21000, upperExplosiveLimitPpm: 95000 };

const massBrief = estimateFlammableMass({ isHeavyGas: true, scenarioBase: { ...propaneBase, releaseDuration: 4 }, ...propaneLimits });
const massMedium = estimateFlammableMass({ isHeavyGas: true, scenarioBase: { ...propaneBase, releaseDuration: 60 }, ...propaneLimits });
const massContinuous = estimateFlammableMass({ isHeavyGas: true, scenarioBase: propaneBase, ...propaneLimits }); // no releaseDuration at all

check("a brief (4 s) release is not silently starved to near-zero mass",
  massBrief > 1, `got ${massBrief} kg`);
check("a brief release gives less mass than a 60 s release of the same rate",
  massBrief < massMedium, `4s=${massBrief}, 60s=${massMedium}`);
// 2026-09-30: was a strict "60 s < continuous". Since the 2026-09-27
// peak-over-time fix, a 60 s release (240 m long at 4 m/s) is already fully
// established across a flammable zone this short, so the two masses are
// physically EQUAL to within grid noise — the strict inequality only held
// while the continuous case was being under-counted by the fine-pass
// cut-off fixed on 2026-09-30 (see fineSearchCeiling() in engineHeavyGas.js).
// What must hold is that a finite release never carries MORE than the
// continuous one.
check("a 60 s release never gives more mass than an effectively continuous release",
  massMedium <= massContinuous * 1.01, `60s=${massMedium}, continuous=${massContinuous}`);
check("all three are finite, positive numbers",
  [massBrief, massMedium, massContinuous].every((m) => Number.isFinite(m) && m > 0));

console.log("\n=== 10. Heavy gas: a continuous release's short flammable zone is not cut off at the source (regression, 2026-09-30) ===");
// Before fineSearchCeiling(), the fine pass ran to 1.15 x the farthest
// exceeding COARSE station. With coarse stations ~50 m apart, a flammable
// zone shorter than that left only the first station (a metre or two from
// the source) exceeding, and the fine pass stopped almost immediately: this
// same continuous propane release came out at roughly a third of its real
// flammable mass. It must now agree with the 60 s release (see section 9).
check("continuous-release mass is at least that of the 60 s release, within 1%",
  massContinuous >= massMedium * 0.99, `continuous=${massContinuous}, 60s=${massMedium}`);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
