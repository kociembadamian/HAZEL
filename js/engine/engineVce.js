/**
 * engineVce.js
 * ------------
 * Vapour cloud explosion (VCE) overpressure model: the blast wave produced
 * when a flammable vapour cloud ignites as a fast deflagration or
 * detonation, as opposed to a slow flash fire (engineHeavyGas.js /
 * engineGaussian.js already cover the flammable-area extent of a flash fire
 * via the 60%-LEL threshold — see levelsOfConcern() in chemicalDatabase.js).
 *
 * Source: ALOHA 5.4.4 Technical Documentation (NOAA TM NOS OR&R 43),
 * chapter 5, "Models for Calculating Blast Effects from Vapor Cloud
 * Explosions." Every constant here — Table 14's flame speeds, Table 15's
 * curve-fit coefficients — is quoted directly from that document.
 *
 * METHOD (Tech Doc 5.2, after Pierorazio et al. 2005 — the Baker-Strehlow-
 * Tang, or BST, model)
 * -----------------------------------------------------------------------
 * 1. Classify the fuel's reactivity (low/medium/high) and the level of
 *    congestion at the site (low/medium/high, or a hard/triggered
 *    detonation), and look up the resulting flame Mach number (Table 14).
 * 2. Compute the mass of fuel that participates: the mass of vapour within
 *    the flammable cloud between 90% of the LEL and the UEL, times a fixed
 *    20% efficiency factor (or 100% if a detonation is triggered).
 * 3. Convert that mass and the fuel's heat of combustion into blast energy,
 *    and non-dimensionalise distance by that energy and ambient pressure.
 * 4. Look up the overpressure at that non-dimensional distance from the
 *    Table 15 curve fits, interpolated to the flame Mach number.
 *
 * STEP 4 — CHANGED 2026-10-02
 * ----------------------------
 * Table 14 lists flame speeds at seven discrete values (0.026 to 0.5, plus
 * "DDT" for a deflagration-to-detonation transition, taken as Mach 5.2),
 * while Table 15 supplies curve-fit constants for only four Mach numbers
 * (0.2, 0.35, 0.7, 5.2). The Tech Doc does not spell out how the seven
 * Table 14 speeds map onto the four Table 15 curves. This module first
 * took the NEAREST curve. For medium reactivity in a congested area
 * (Mach 0.5) that meant the Mach 0.35 curve, and the 3.5 psi zone vanished
 * altogether, while ALOHA (run V2: propane 1 kg/s, congested, spark)
 * reports 18 m. The overpressure is now interpolated linearly between the
 * two bracketing curves, which gives 18 m (3.5 psi) and 35 m (1 psi)
 * against ALOHA's 18 and 34 m. Below Mach 0.2 the 0.2 curve is used, not
 * extrapolated: its plateau (0.065 atm) is under 1 psi, matching ALOHA's
 * "never exceeded" for an uncongested, spark-ignited cloud (run V3).
 *
 * WHERE THE BLAST IS CENTRED (2026-10-02)
 * ----------------------------------------
 * distanceM here is measured from the centre of the exploding cloud. ALOHA
 * centres it on the flammable cloud's centre of mass (Tech Doc 5.2) and
 * reports distances from the release point; fireExplosionPanel.js adds the
 * cloud-centre offset from estimateFlammableCloud() (engineFlammableMass.js).
 *
 * SCOPE
 * -----
 * Implements a single, user-supplied congested region with a known fuel
 * mass already computed (from the flammable-area calculation) — not
 * ALOHA's full handling of multiple simultaneous explosions from one
 * time-varying release (Tech Doc 5.2, final paragraph).
 */

/**
 * Flame Mach number by reactivity and congestion [Tech Doc Table 14].
 * "dtt" (deflagration-to-detonation transition) is used whenever congestion
 * indicates a transition, or whenever the ignition source is a hard
 * (high-power) trigger — see chooseFlameSpeed() below.
 */
const FLAME_SPEED_TABLE = {
  low: { low: 0.026, medium: 0.23, high: 0.34 },
  medium: { low: 0.11, medium: 0.44, high: 0.5 },
  high: { low: 0.36, medium: "dtt", high: "dtt" },
};

/** Flame Mach number used for a confirmed deflagration-to-detonation transition or hard ignition. */
const DETONATION_MACH = 5.2;

/**
 * Curve-fit constants for normalised overpressure vs normalised distance
 * [Tech Doc Table 15], keyed by the flame Mach number they were fit for.
 *
 *   dP/Patm = D                    for x < x0
 *   dP/Patm = A * B^(1/x) * x^C    for x >= x0
 */
const CURVE_FIT_TABLE = [
  { mach: 0.2, A: 0.0335, B: 0.8359, C: -1.1192, D: 0.065, x0: 0.35 },
  { mach: 0.35, A: 0.1041, B: 0.8642, C: -1.0568, D: 0.22, x0: 0.32 },
  { mach: 0.7, A: 0.3764, B: 0.7439, C: -1.2728, D: 0.65, x0: 0.3 },
  { mach: 5.2, A: 0.2932, B: 1.399, C: -1.1591, D: 20, x0: 0.16 },
];

/** Ground reflection factor ALOHA uses, consistent with the BST treatment
 *  of an explosive cloud as a ground-level hemisphere [Tech Doc 5.2]. */
const GROUND_REFLECTION_FACTOR = 2;

/** Fraction of the flammable mass ALOHA assumes participates in an
 *  ordinary (non-detonating) explosion [Tech Doc 5.2, after AIChE 1994]. */
const EXPLOSION_EFFICIENCY = 0.2;

/**
 * Looks up the flame Mach number for a reactivity/congestion combination
 * [Tech Doc Table 14].
 *
 * @param {"low"|"medium"|"high"} reactivity
 * @param {"low"|"medium"|"high"} congestion
 * @param {boolean} [hardIgnition] - a high-power trigger, assumed capable of
 *        detonating the whole cloud regardless of congestion [Tech Doc 5.2]
 * @returns {number} flame Mach number
 */
export function flameMachNumber(reactivity, congestion, hardIgnition = false) {
  if (hardIgnition) return DETONATION_MACH;

  const entry = FLAME_SPEED_TABLE[reactivity]?.[congestion];
  if (entry === undefined) {
    throw new Error(`flameMachNumber: unknown reactivity "${reactivity}" or congestion "${congestion}"`);
  }
  return entry === "dtt" ? DETONATION_MACH : entry;
}

/**
 * Normalised overpressure for any flame Mach number: linear interpolation
 * between the two bracketing Table 15 curves, clamped to the first and last
 * curve outside their range — see the module docstring, "STEP 4".
 */
export function overpressureForMach(x, machNumber) {
  const fits = CURVE_FIT_TABLE;
  if (machNumber <= fits[0].mach) return normalisedOverpressure(x, fits[0]);
  if (machNumber >= fits[fits.length - 1].mach) return normalisedOverpressure(x, fits[fits.length - 1]);
  let i = 0;
  while (machNumber > fits[i + 1].mach) i++;
  const a = fits[i];
  const b = fits[i + 1];
  const f = (machNumber - a.mach) / (b.mach - a.mach);
  return (1 - f) * normalisedOverpressure(x, a) + f * normalisedOverpressure(x, b);
}

/**
 * Blast energy contributing to the explosion [Tech Doc 5.2]:
 *
 *     E = ref * H_c * Mass
 *
 * @param {number} heatOfCombustion - J/kg
 * @param {number} massKg - kg of fuel participating (see explosiveMass())
 * @returns {number} J
 */
export function blastEnergy(heatOfCombustion, massKg) {
  return GROUND_REFLECTION_FACTOR * heatOfCombustion * massKg;
}

/**
 * Mass of fuel participating in the explosion.
 *
 * ALOHA's departure from the original BST method [Tech Doc 5.2]: rather
 * than defining participating mass by physical congestion, it uses all the
 * vapour within the flammable cloud between 90% of the LEL and the UEL,
 * times a fixed efficiency factor — 100% if the ignition detonates the
 * whole cloud, otherwise 20%.
 *
 * @param {number} flammableMassKg - mass of vapour between 90% LEL and UEL
 * @param {boolean} isDetonation
 * @returns {number} kg
 */
export function explosiveMass(flammableMassKg, isDetonation) {
  return flammableMassKg * (isDetonation ? 1 : EXPLOSION_EFFICIENCY);
}

/**
 * Non-dimensional (Sachs-scaled) distance [Tech Doc 5.2]:
 *
 *     x = r * (P_atm / E)^(1/3)
 */
export function normalisedDistance(distanceM, blastEnergyJ, ambientPressurePa = 101325) {
  return distanceM * Math.cbrt(ambientPressurePa / blastEnergyJ);
}

/**
 * Normalised overpressure at a given normalised distance, for one Table 15
 * curve [Tech Doc 5.2]:
 *
 *     dP/Patm = D                 for x < x0
 *     dP/Patm = A * B^(1/x) * x^C otherwise
 */
export function normalisedOverpressure(x, curve) {
  if (x < curve.x0) return curve.D;
  return curve.A * Math.pow(curve.B, 1 / x) * Math.pow(x, curve.C);
}

/**
 * Peak overpressure at a given real distance from the centre of an
 * exploding cloud.
 *
 * @param {object} params
 * @param {number} params.distanceM - m, from the centre of the flammable mass
 * @param {number} params.flammableMassKg - kg, vapour between 90% LEL and UEL
 * @param {number} params.heatOfCombustion - J/kg
 * @param {string} params.reactivity - "low" | "medium" | "high"
 * @param {string} params.congestion - "low" | "medium" | "high"
 * @param {boolean} [params.hardIgnition]
 * @param {number} [params.ambientPressurePa]
 * @returns {number} Pa, overpressure above ambient
 */
export function overpressureAt({
  distanceM,
  flammableMassKg,
  heatOfCombustion,
  reactivity,
  congestion,
  hardIgnition = false,
  ambientPressurePa = 101325,
}) {
  const mach = flameMachNumber(reactivity, congestion, hardIgnition);
  const isDetonation = mach === DETONATION_MACH;

  const mass = explosiveMass(flammableMassKg, isDetonation);
  const energy = blastEnergy(heatOfCombustion, mass);

  const x = normalisedDistance(distanceM, energy, ambientPressurePa);
  return overpressureForMach(x, mach) * ambientPressurePa;
}

/**
 * Finds the distance at which peak overpressure drops to a given Level of
 * Concern.
 *
 * @param {object} scenario - same fields as overpressureAt(), minus distanceM
 * @param {number} scenario.thresholdPa - Pa, overpressure above ambient
 * @param {number} [maxSearchDistance] - m
 * @returns {{ thresholdExceeded: boolean, maxDistance: number }}
 */
export function findOverpressureDistance(scenario, maxSearchDistance = 20000) {
  const pressureAt = (d) => overpressureAt({ ...scenario, distanceM: d });

  if (pressureAt(0.1) < scenario.thresholdPa) {
    return { thresholdExceeded: false, maxDistance: 0 };
  }

  let inside = 0.1;
  let outside = 0;
  let probe = 0.1;
  while (probe <= maxSearchDistance) {
    if (pressureAt(probe) >= scenario.thresholdPa) {
      inside = probe;
    } else {
      outside = probe;
      break;
    }
    probe *= 1.3;
  }

  if (outside === 0) {
    return { thresholdExceeded: true, maxDistance: maxSearchDistance, reachedSearchLimit: true };
  }

  let low = inside;
  let high = outside;
  for (let i = 0; i < 60 && high - low > 0.1; i++) {
    const mid = (low + high) / 2;
    if (pressureAt(mid) >= scenario.thresholdPa) low = mid;
    else high = mid;
  }

  return { thresholdExceeded: true, maxDistance: low };
}

/**
 * Standard overpressure Levels of Concern [Tech Doc 5.1, after Baker 1983]:
 * window glass breakage, serious injury from flying debris and eardrum
 * rupture, and structural collapse of unreinforced buildings with ear/lung
 * damage.
 */
export const OVERPRESSURE_LEVELS = [
  { id: "blast3", label: "Blast-3", description: "Serious injury; risk of unreinforced building collapse", psi: 8, colour: "red" },
  { id: "blast2", label: "Blast-2", description: "Serious injury from flying debris; risk of eardrum rupture", psi: 3.5, colour: "orange" },
  { id: "blast1", label: "Blast-1", description: "Glass breakage", psi: 1, colour: "yellow" },
];

/** Converts psi (as the Tech Doc states its Levels of Concern) to Pa. */
export function psiToPa(psi) {
  return psi * 6894.76;
}
