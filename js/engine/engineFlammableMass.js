/**
 * engineFlammableMass.js
 * -----------------------
 * The mass of vapour actually sitting within flammable limits at the
 * moment of ignition — what engineVce.js's overpressureAt() needs as
 * flammableMassKg, computed automatically from the SAME dispersion field
 * (Gaussian or heavy gas) already used to draw the toxic/flammable-area
 * threat zones, rather than typed in as a guess.
 *
 * METHOD (Tech Doc section 5.2, after AIChE 1994)
 * -------------------------------------------------
 * "the BST blast curves can be coupled with an air dispersion model for
 * determining the mass of the explosive cloud, using all the fuel within
 * flammable limits ... ALOHA deviates slightly from the AIChE
 * recommendation by using the fuel within a concentration range between
 * the upper explosive limit and 90% of the lower explosive limit." Gas
 * richer than the UEL is presumed too rich to burn; gas leaner than 90% of
 * the LEL is presumed too lean.
 *
 * The Tech Doc describes this as coupling "an air dispersion model" to the
 * two concentration bounds — it does not print a closed-form integral (no
 * equation number, no citation for one), which matches the AIChE source it
 * names: a numerical procedure, not an algebraic formula. What follows is a
 * direct numerical integration of the SAME concentration fields this
 * project's own dispersion engines already compute and have already been
 * validated against (engineGaussian.js, engineHeavyGas.js) — summing
 * concentration times volume over every point of the modelled cloud that
 * falls inside the flammable band, not a new, separately-sourced formula.
 *
 * WHY THIS NEEDS THE UPPER EXPLOSIVE LIMIT SPECIFICALLY
 * --------------------------------------------------------
 * The DOE PAC/TEEL dataset HAZEL ships (see chemicalDatabase.js,
 * convert_pac_data.py) carries a lower explosive limit for flammable
 * substances but never an upper one — DOE's own source table simply does
 * not have that column. Rather than leaving the whole flammable-mass
 * calculation manual for want of one missing number, the fire/explosion
 * panel asks for the UEL the way it already asks for heat of combustion: a
 * single field with a hint on where to look it up (fireExplosionPanel.js).
 * Supply that one number (and the LEL, auto-filled when the database has
 * it) and this module does the actual integration — no percentage-of-
 * total-release guess required, which is what the manual mass entry this
 * replaces used to demand.
 */

import { peakConcentration, ppmToMassConcentration, gaussianTransportWindSpeed } from "./engineGaussian.js";
import {
  marchDownwind,
  concentrationAtOffset,
  edgeAtThreshold,
  nearFieldMarch,
  fineSearchCeiling,
} from "./engineHeavyGas.js";
import { bisectBoundary } from "./engineMath.js";

/** Tech Doc 5.2: 90% of the LEL, not the LEL itself — ALOHA's own deliberate conservative bias. */
const LEL_PARTICIPATION_FRACTION = 0.9;

/**
 * Finds the largest x at which a monotonically-decreasing function of one
 * variable is still at or above a threshold, starting from a known-good
 * point near zero. Shared by every 1-D search this module needs (the
 * Gaussian centreline's downwind reach, and its crosswind/vertical extent
 * at a fixed downwind station).
 *
 * @param {(x: number) => number} fn
 * @param {number} threshold
 * @param {number} maxSearch - upper bound on the search, in the same units as x
 * @returns {number} 0 if fn never reaches the threshold even at the smallest probe
 */
function findExtent(fn, threshold, maxSearch) {
  const smallest = Math.min(1e-3, maxSearch / 1000);
  if (fn(smallest) < threshold) return 0;

  let inside = smallest;
  let outside = 0;
  let probe = smallest;
  while (probe <= maxSearch) {
    if (fn(probe) >= threshold) {
      inside = probe;
      probe *= 1.5;
    } else {
      outside = probe;
      break;
    }
  }

  if (outside === 0) return maxSearch; // still exceeding at the search ceiling
  return bisectBoundary((x) => fn(x) >= threshold, inside, outside, Math.max(1e-3, maxSearch * 1e-5));
}

/* ========================================================================
   GAUSSIAN MODEL
   ======================================================================== */

/**
 * Integrates the Gaussian plume's concentration field over (x, y, z),
 * summing concentration times cell volume wherever it falls inside
 * [lowThresholdKgM3, highThresholdKgM3].
 *
 * The grid is generous rather than exact: at each downwind station x, the
 * crosswind and vertical extents are each found out to where concentration
 * falls to the LOW threshold (the widest either bound could possibly be,
 * since anything richer than that, including the too-rich core near the
 * UEL, sits closer to the centreline/ground than that). Every individual
 * grid cell is then still tested against both thresholds before being
 * counted, so a generous outer bound only means some cells contribute
 * zero — it never miscounts a cell as flammable that is not.
 *
 * Integration starts a short distance downwind of the source rather than
 * at the literal mathematical point x=0, where the Gaussian formula is
 * singular (sigmaY and sigmaZ both vanish there). That sliver of neglected
 * near-source volume is the same "too rich to burn" region the UEL bound
 * excludes everywhere else in this integral in any case, so omitting it
 * near the singularity rather than resolving it numerically costs nothing
 * physically meaningful.
 */
function gaussianFlammableMass(rawScenarioBase, lowThresholdKgM3, highThresholdKgM3) {
  // peakConcentration()/steadyStateConcentration() read a "windSpeed" field,
  // while the scenarioBase this module is handed (from
  // buildDispersionScenario() in stepSource.js — the same object the
  // Results step's map already uses) carries it as "windSpeed10m", matching
  // findThreatZone()'s own field name there. findThreatZone() bridges this
  // with a one-line rename before calling peakConcentration(); this does
  // the same, once, rather than at every one of the many calls below.
  // The Gaussian transport wind (3 m, Tech Doc profile — see
  // gaussianTransportWindSpeed() in engineGaussian.js, 2026-10-01).
  const scenarioBase = {
    ...rawScenarioBase,
    windSpeed: gaussianTransportWindSpeed(
      rawScenarioBase.windSpeed10m, rawScenarioBase.roughnessLength, rawScenarioBase.stabilityClass,
      rawScenarioBase.releaseHeight
    ),
    // 10-second averaging for a flammable cloud (2026-10-02, see
    // FLAMMABLE_SIGMA_Y_FACTOR in engineGaussian.js).
    flammableAveraging: true,
  };

  const centrelineAt = (x) => peakConcentration({ ...scenarioBase, x, y: 0, z: 0 });

  const xMax = findExtent(centrelineAt, lowThresholdKgM3, 50000);
  if (!(xMax > 0)) return { massKg: 0, centreX: 0 };

  const X_STATIONS = 70;
  const Y_STEPS = 36;
  const Z_STEPS = 22;
  const xMin = Math.min(1, xMax * 0.005);

  let totalMassKg = 0;
  let massMoment = 0;

  for (let i = 0; i < X_STATIONS; i++) {
    // Cosine-clustered stations, denser near the source where the profile
    // changes fastest — the same reasoning buildFootprint() in
    // engineGaussian.js already uses for the threat-zone outline.
    const t0 = i / X_STATIONS;
    const t1 = (i + 1) / X_STATIONS;
    const x0 = xMin + (xMax - xMin) * (1 - Math.cos((Math.PI * t0) / 2));
    const x1 = xMin + (xMax - xMin) * (1 - Math.cos((Math.PI * t1) / 2));
    const dx = x1 - x0;
    if (!(dx > 0)) continue;
    const x = (x0 + x1) / 2;

    const centreConc = centrelineAt(x);
    if (centreConc < lowThresholdKgM3) continue; // nothing at this x can qualify

    const yMax = findExtent((y) => peakConcentration({ ...scenarioBase, x, y, z: 0 }), lowThresholdKgM3, 20000);
    if (!(yMax > 0)) continue;

    const zMax = findExtent((z) => peakConcentration({ ...scenarioBase, x, y: 0, z }), lowThresholdKgM3, 5000);
    if (!(zMax > 0)) continue;

    const dy = yMax / Y_STEPS;
    const dz = zMax / Z_STEPS;

    for (let j = 0; j < Y_STEPS; j++) {
      const y = (j + 0.5) * dy;
      for (let k = 0; k < Z_STEPS; k++) {
        const z = (k + 0.5) * dz;
        const c = peakConcentration({ ...scenarioBase, x, y, z });
        if (c >= lowThresholdKgM3 && c <= highThresholdKgM3) {
          // *2 for the +/- y mirror only — z stays one-sided (ground at
          // z=0 is a real boundary, not a symmetry: the model's own
          // ground-reflection term folds material back into z>=0, it does
          // not mean the real cloud also occupies z<0).
          totalMassKg += c * dx * dy * dz * 2;
          massMoment += c * dx * dy * dz * 2 * x;
        }
      }
    }
  }

  return { massKg: totalMassKg, centreX: totalMassKg > 0 ? massMoment / totalMassKg : 0 };
}

/* ========================================================================
   HEAVY GAS MODEL
   ======================================================================== */

/**
 * Integrates the heavy-gas plume's concentration field over (x, y), using
 * the same homogeneous-core-plus-Gaussian-tail crosswind profile the
 * threat-zone outline itself is built from (engineHeavyGas.js). No
 * separate z-integration is needed: that model treats the cloud as a
 * top-hat in the vertical (uniform concentration from the ground up to the
 * local effective cloud height, zero above it — see marchDownwind()'s own
 * docstring), so each cell's volume is simply its horizontal area times
 * that station's effective height.
 *
 * Re-runs marchDownwind() itself (twice, coarse then fine — the same
 * two-pass approach findHeavyGasThreatZone() uses and for the same reason:
 * the march is cumulative along x, so there is no cheaper way to "zoom in"
 * on the part of the range that actually matters).
 */
function heavyGasFlammableMass(scenarioBase, lowThresholdKgM3, highThresholdKgM3) {
  const coarseSeries = marchDownwind(scenarioBase);
  let coarseExceeding = coarseSeries.filter((p) => p.concentrationKgM3 >= lowThresholdKgM3);

  // FINITE-DURATION CLIFF (2026-09-26): a brief release's finite-duration
  // correction (engineHeavyGas.js's finiteDurationFactor()) falls from ~1 to
  // ~0 over a span that can be much narrower than this coarse pass's fixed
  // station spacing across the full default search range — exactly the same
  // resolution artefact findHeavyGasThreatZone() was found to have (see that
  // function's own "FINITE-DURATION CLIFF" docstring in engineHeavyGas.js),
  // discovered here independently while auditing this file: a coarse pass
  // that steps clean over the real cliff can report zero (or a token
  // fraction of the real) flammable mass for a brief release, silently
  // starving engineVce.js's overpressure calculation. nearFieldMarch() runs
  // an extra pass sized specifically around the distance that transition is
  // centred on; a continuous or long release (no usable duration) leaves it
  // returning null and this behaves exactly as before.
  const nearFieldSeries = nearFieldMarch(scenarioBase);
  if (nearFieldSeries) {
    coarseExceeding = coarseExceeding.concat(
      nearFieldSeries.filter((p) => p.concentrationKgM3 >= lowThresholdKgM3)
    );
  }
  if (coarseExceeding.length === 0) return { massKg: 0, centreX: 0 };

  // The two passes are concatenated, not necessarily in x order (see the
  // same reasoning in findHeavyGasThreatZone()), so the farthest exceeding
  // station is found explicitly rather than assumed to be the last element.
  const roughXMax = Math.max(...coarseExceeding.map((p) => p.x));
  // 2026-09-30: out to the first sampled station already below the
  // threshold, not roughXMax * 1.15 — see fineSearchCeiling() in
  // engineHeavyGas.js for the bug this fixes (a short flammable zone from a
  // continuous release was being cut off almost at the source).
  const series = marchDownwind({
    ...scenarioBase,
    maxDistance: fineSearchCeiling([coarseSeries, nearFieldSeries], roughXMax),
    stepCount: 300,
  });

  const Y_STEPS = 60;
  let totalMassKg = 0;
  let massMoment = 0;

  for (let i = 0; i < series.length - 1; i++) {
    const station = series[i];
    const dx = series[i + 1].x - station.x;
    if (station.concentrationKgM3 < lowThresholdKgM3) continue;

    const yMax = edgeAtThreshold(
      station.concentrationKgM3,
      station.halfWidth,
      station.x,
      scenarioBase.stabilityClass,
      lowThresholdKgM3
    );
    if (!(yMax > 0)) continue;

    const dy = yMax / Y_STEPS;
    for (let j = 0; j < Y_STEPS; j++) {
      const y = (j + 0.5) * dy;
      const c = concentrationAtOffset(station.concentrationKgM3, y, station.halfWidth, station.x, scenarioBase.stabilityClass);
      if (c >= lowThresholdKgM3 && c <= highThresholdKgM3) {
        // *2 for the +/- y mirror; the height factor is the station's own
        // effective cloud height rather than a further z-integration —
        // see the function docstring.
        totalMassKg += c * dx * dy * station.effHeight * 2;
        massMoment += c * dx * dy * station.effHeight * 2 * (station.x + dx / 2);
      }
    }
  }

  return { massKg: totalMassKg, centreX: totalMassKg > 0 ? massMoment / totalMassKg : 0 };
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

/**
 * Estimates the mass of vapour within flammable limits, given whichever
 * dispersion scenario the Results step already built.
 *
 * @param {object} params
 * @param {boolean} params.isHeavyGas - which engine's fields scenarioBase carries
 * @param {object} params.scenarioBase - same shape stepResults.js's computeZones()
 *        (via stepSource.js's buildDispersionScenario()) passes to
 *        findThreatZone() / findHeavyGasThreatZone()
 * @param {number} params.lowerExplosiveLimitPpm - LEL, ppm
 * @param {number} params.upperExplosiveLimitPpm - UEL, ppm
 * @returns {number} kg of vapour between 90% of the LEL and the UEL
 */
export function estimateFlammableMass({ isHeavyGas, scenarioBase, lowerExplosiveLimitPpm, upperExplosiveLimitPpm }) {
  if (!Number.isFinite(lowerExplosiveLimitPpm) || lowerExplosiveLimitPpm <= 0) {
    throw new Error("estimateFlammableMass: a lower explosive limit is required");
  }
  if (!Number.isFinite(upperExplosiveLimitPpm) || upperExplosiveLimitPpm <= 0) {
    throw new Error("estimateFlammableMass: an upper explosive limit is required");
  }
  if (upperExplosiveLimitPpm <= lowerExplosiveLimitPpm * LEL_PARTICIPATION_FRACTION) {
    throw new Error(
      "estimateFlammableMass: the upper explosive limit must be greater than 90% of the lower explosive limit"
    );
  }

  const lowThresholdKgM3 = ppmToMassConcentration(
    lowerExplosiveLimitPpm * LEL_PARTICIPATION_FRACTION,
    scenarioBase.molecularWeight,
    scenarioBase.temperature
  );
  const highThresholdKgM3 = ppmToMassConcentration(
    upperExplosiveLimitPpm,
    scenarioBase.molecularWeight,
    scenarioBase.temperature
  );

  const cloud = isHeavyGas
    ? heavyGasFlammableMass(scenarioBase, lowThresholdKgM3, highThresholdKgM3)
    : gaussianFlammableMass(scenarioBase, lowThresholdKgM3, highThresholdKgM3);
  return cloud.massKg;
}

/**
 * As estimateFlammableMass(), plus where the cloud's centre is (ADDED
 * 2026-10-02).
 *
 * ALOHA centres a vapour-cloud explosion on the centre of mass of the
 * flammable cloud (Tech Doc 5.2), and reports blast distances from the
 * release point, so they include that downwind offset. In ALOHA runs V2-V4
 * (propane 1 kg/s, D 5 m/s) the detonation distances 23 / 33 / 71 m are
 * reproduced exactly by HAZEL's explosive mass (4.6 kg — ALOHA's, to 0.1%)
 * plus a constant offset of 9.5 m. The centre used here is that of all
 * vapour above 90% of the LEL, including the over-rich core (12.6 m; the
 * centre of only the UEL-limited part would be 16.6 m) — the closer of the
 * two natural readings of "the flammable cloud", still a few metres on the
 * cautious side.
 *
 * @returns {{massKg: number, centreX: number}} kg between 90% LEL and UEL,
 *          and m downwind of the source
 */
export function estimateFlammableCloud(params) {
  const massKg = estimateFlammableMass(params); // validates the inputs
  if (!(massKg > 0)) return { massKg: 0, centreX: 0 };
  const { isHeavyGas, scenarioBase, lowerExplosiveLimitPpm } = params;
  const low = ppmToMassConcentration(lowerExplosiveLimitPpm * LEL_PARTICIPATION_FRACTION, scenarioBase.molecularWeight, scenarioBase.temperature);
  const whole = isHeavyGas
    ? heavyGasFlammableMass(scenarioBase, low, Infinity)
    : gaussianFlammableMass(scenarioBase, low, Infinity);
  return { massKg, centreX: whole.centreX };
}
