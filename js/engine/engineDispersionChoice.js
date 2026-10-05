/**
 * engineDispersionChoice.js
 * -------------------------
 * Decides whether a release disperses passively (Gaussian model) or as a
 * gravity-driven dense cloud (heavy gas model).
 *
 * Why this is not a property of the chemical
 * -------------------------------------------
 * The obvious approach — compare the vapour's density with air's and warn
 * about anything heavier — does not work. Almost every substance that travels
 * by road is heavier than air: air is 28.96 g/mol, and that threshold catches
 * roughly 98% of the chemicals in the PAC dataset. A warning that fires
 * almost always is one users learn to dismiss without reading, which makes it
 * worse than no warning at all.
 *
 * ALOHA's Tech Doc (section 4.1) is explicit that density alone is not the
 * criterion. What matters is whether gravity-driven slumping dominates over
 * the turbulent mixing the wind supplies, and that depends on three things
 * together: how much denser than air the cloud is, how fast the wind is
 * blowing, and how much material is being released. A slow leak of chlorine
 * disperses passively; a catastrophic tank failure of the same chlorine
 * slumps and flows along the ground.
 *
 * The measure is the critical Richardson number:
 *
 *     Ri_c = H * g_hat / U*^2
 *
 * where g_hat is the reduced gravity  g * (rho - rho_air) / rho_air,
 * H is a characteristic dimension of the source, and U* is the friction
 * velocity of the wind. Below 1 the release is passive and the Gaussian model
 * applies; above 1 it is not, and the heavy gas model is needed.
 *
 * Consequence for the architecture: this decision cannot be made when the
 * user picks a substance, because release rate is not known until the Source
 * step. The Chemical step therefore reports vapour density as information
 * only, and the real determination happens here, later.
 *
 * FRICTION VELOCITY FOR THIS SCREENING — CORRECTED 2026-09-30
 * -------------------------------------------------------------
 * State before this fix: this module computed U* for the Ric formula above
 * from the standard logarithmic wind profile —
 *
 *     U* = k * U(z) / ln(z / z0)
 *
 * — using the scenario's surface roughness length z0 (frictionVelocity(),
 * below, still implements exactly this formula and is still used elsewhere;
 * see "WHAT THIS FIX DOES NOT TOUCH"). That was a reasonable reading of the
 * Tech Doc: section 4.4.1 names "the friction velocity of the wind" as the
 * Ric input without printing its own formula, and the log-law with a
 * roughness length is the general-purpose friction-velocity relation used
 * elsewhere in atmospheric dispersion modelling (and elsewhere in this Tech
 * Doc, for the heavy-gas plume's own downwind wind profile).
 *
 * What testing found wrong with it: repeated side-by-side comparisons against
 * real ALOHA runs (worked scenarios, not just the Tech Doc's prose) showed
 * ALOHA choosing the Heavy Gas model in cases where this formula's Ric came
 * out consistently below 1 — i.e. this module said "passive, use Gaussian"
 * while ALOHA itself, given the identical release rate, wind, chemical and
 * terrain, used the dense-gas model. The gap was not explained by:
 *   - a stability-class-dependent correction to U* (Businger/Dyer similarity
 *     theory) — falsified by a neutral-stability (class D) control case,
 *     which should have been unaffected by any such correction but still
 *     showed the same disagreement ALOHA's F- and E-class runs did;
 *   - a systematic gap between this project's and ALOHA's own puddle
 *     evaporation rate — falsified by comparing against ALOHA's own reported
 *     release rate for the same scenario, which if anything ran slightly
 *     LOWER than this project's figure, the wrong direction to explain a
 *     higher Ric.
 *
 * What resolved it: the Tech Doc gives a SECOND, unrelated formula for
 * friction velocity, in section 3.3.1 (the puddle evaporation model), after
 * Deacon (1973), for neutral conditions:
 *
 *     U* = 0.03 * U(z) * (10 / z)^n
 *
 * (already implemented in this project as puddleFrictionVelocity() in
 * engineSourcePuddle.js, for the evaporation calculation it was written for).
 * When the reference wind speed is quoted at the standard 10 m height — which
 * it always is in this project, and in ALOHA's own inputs — this collapses to
 * a simple, roughness-independent, stability-independent U* = 0.03 * U10.
 *
 * Substituting THIS formula into the Ric screening below (screeningFrictionVelocity(),
 * new in this fix) reproduces ALOHA's actual model choice in every scenario
 * tested, across both source types this project supports:
 *
 *   | Test | Source type      | Varying              | Ri (old, log-law) | Ri (this fix) | ALOHA chose |
 *   |------|-------------------|----------------------|--------------------|----------------|-------------|
 *   | A1   | puddle            | baseline (z0=0.03)   | 0.82 -> Gaussian   | 4.32 -> HeavyGas | Heavy Gas |
 *   | A2   | puddle            | z0=1.0 (urban/forest)| 0.06 -> Gaussian   | 2.06 -> HeavyGas | Heavy Gas |
 *   | B    | puddle            | different substance  | 0.64 -> Gaussian   | 3.37 -> HeavyGas | Heavy Gas |
 *   | C    | puddle            | small puddle (floor) | 0.13 -> Gaussian   | 0.68 -> Gaussian | Gaussian  |
 *   | D    | direct/continuous | non-puddle source    | 0.98 -> Gaussian   | 5.19 -> HeavyGas | Heavy Gas |
 *   | E    | direct/continuous | small leak (floor)   | 0.13 -> Gaussian   | 0.70 -> Gaussian | Gaussian  |
 *
 * Six for six, including two deliberate "floor" checks (C, E) confirming this
 * is a genuine threshold and not just "always Heavy Gas now" — see
 * the 2026-09-30 ALOHA runs behind the Richardson/friction-velocity fix for
 * the full scenario parameters and the reasoning trail (two earlier, more
 * complicated hypotheses tried and ruled out first).
 *
 * WHAT THIS FIX DOES NOT TOUCH
 * -----------------------------
 * frictionVelocity() (the neutral log-law formula, below) is UNCHANGED and
 * still exported. Note (2026-09-30): engineHeavyGas.js's marchDownwind() no
 * longer uses it — the heavy-gas plume's own downwind physics now uses its
 * own stability-corrected friction velocity (heavyGasFrictionVelocity() in
 * that file, Tech Doc 4.2.3). That is a different calculation from the
 * initial Gaussian-vs-Heavy-Gas screening this file's fix addresses. Only
 * the U* fed into THIS module's Ric calculation is set here.
 *
 * One practical consequence: roughnessLength is still accepted as a parameter
 * of chooseDispersionModel() (existing call sites already pass it, and it may
 * matter again if this screening is revisited) but is no longer used inside
 * it — the Deacon formula at the 10 m reference height has no roughness
 * dependence. Test A2 above is exactly this: real ALOHA's model choice did
 * not change between open-country and urban/forest terrain, confirming this
 * is not an oversight but matches ALOHA's actual behaviour.
 *
 * REVERTING THIS FIX
 * -------------------
 * Should future evidence call this into question, reverting is a one-line
 * change: in chooseDispersionModel() below, swap the call back to
 * `frictionVelocity(windSpeed10m, 10, roughnessLength)`. Nothing else in this
 * file, or in engineHeavyGas.js, depends on which formula is used here.
 */

import { UNIVERSAL_GAS_CONSTANT, STANDARD_PRESSURE } from "./engineConstants.js";

/** Standard gravity, m/s^2. */
const GRAVITY = 9.80665;

/** Von Karman constant, used in the logarithmic wind profile. */
const VON_KARMAN = 0.4;

/** Molecular weight of dry air, g/mol. */
const MOLECULAR_WEIGHT_OF_AIR = 28.96;

/**
 * Density of a gas or vapour, from the ideal gas law.
 *
 * @param {number} molecularWeight - g/mol
 * @param {number} temperature - K
 * @param {number} [pressure] - Pa
 * @returns {number} density in kg/m^3
 */
export function gasDensity(molecularWeight, temperature, pressure = STANDARD_PRESSURE) {
  // rho = P*M / (R*T), with M converted from g/mol to kg/mol
  return (pressure * (molecularWeight / 1000)) / (UNIVERSAL_GAS_CONSTANT * temperature);
}

/**
 * Friction velocity of the wind, from the logarithmic wind profile:
 *
 *     U* = k * U(z) / ln(z / z0)
 *
 * This is the velocity scale of the turbulence the wind generates at the
 * surface. It rises with wind speed and with surface roughness, which is
 * why a dense cloud disperses passively over a city but slumps over open
 * water in the same wind.
 *
 * NOT used for the Ric screening in chooseDispersionModel() below (see this
 * file's header comment, "FRICTION VELOCITY FOR THIS SCREENING") — kept here,
 * unchanged, because engineHeavyGas.js's marchDownwind() still uses exactly
 * this formula for the heavy-gas plume's own downwind wind profile once a
 * release has already been routed to that model.
 *
 * @param {number} windSpeed - m/s at the reference height
 * @param {number} referenceHeight - m
 * @param {number} roughnessLength - surface roughness z0, m
 * @returns {number} friction velocity, m/s
 */
export function frictionVelocity(windSpeed, referenceHeight, roughnessLength) {
  if (roughnessLength <= 0 || referenceHeight <= roughnessLength) {
    throw new Error(
      "frictionVelocity: reference height must exceed the roughness length, and both must be positive"
    );
  }
  return (VON_KARMAN * windSpeed) / Math.log(referenceHeight / roughnessLength);
}

/**
 * Friction velocity used for the Ric (Gaussian vs. Heavy Gas) screening in
 * chooseDispersionModel(), below — Deacon (1973), for neutral conditions,
 * exactly as the Tech Doc's section 3.3.1 gives it for the puddle
 * evaporation model (implemented there as puddleFrictionVelocity() in
 * engineSourcePuddle.js):
 *
 *     U* = 0.03 * U(z) * (10 / z)^n
 *
 * This project always supplies the wind speed already referenced to the
 * standard 10 m height (U10), so z = 10 m and (10/z)^n = 1 for any n —
 * the formula collapses to the simple form below, with no dependence on
 * surface roughness or atmospheric stability. See this file's header
 * comment for why this formula, not the general log-law one
 * (frictionVelocity(), above), is the right one for this specific
 * screening: six independent test scenarios against real ALOHA runs, across
 * both puddle and direct/continuous source types, confirmed it and none
 * disagreed.
 *
 * @param {number} windSpeed10m - m/s at the standard 10 m reference height
 * @returns {number} friction velocity, m/s
 */
export function screeningFrictionVelocity(windSpeed10m) {
  return 0.03 * windSpeed10m;
}

/**
 * Reduced gravity: the buoyancy the density difference produces.
 *
 *     g_hat = g * (rho_cloud - rho_air) / rho_air
 *
 * Negative for a cloud lighter than air, which then rises rather than slumps.
 *
 * @returns {number} m/s^2
 */
export function reducedGravity(cloudDensity, airDensity) {
  return (GRAVITY * (cloudDensity - airDensity)) / airDensity;
}

/**
 * Characteristic height of the source, used by the Richardson-number
 * screening below.
 *
 * Two different formulas apply, per [TechDoc section 4.4.1] — NOT one
 * formula used everywhere:
 *
 *   - For a puddle source: H = E / (rho * U10 * D), where D is the
 *     puddle's own diameter.
 *   - For any other continuous or semi-continuous source (a tank or direct
 *     release, forming a small jet or hole rather than a wide puddle):
 *     H = sqrt(E*pi / (4*rho*U10)) — notably, NOT divided by the source's
 *     physical diameter at all.
 *
 * Using the puddle formula for a tank release was an actual bug this
 * project shipped with: dividing by a small hole's diameter (a few
 * centimetres, rather than a puddle's metres) inflates the characteristic
 * height by one or two orders of magnitude, which in turn inflates the
 * Richardson number's height term and, downstream, the heavy-gas model's
 * seed value for its own vertical dispersion parameter — the practical
 * effect was a cloud predicted to dilute below any threshold within
 * centimetres of the source, reporting "0 m" threat zones for a scenario
 * that should have had a substantial one.
 *
 * @param {number} releaseRate - kg/s
 * @param {number} cloudDensity - kg/m^3
 * @param {number} windSpeed10m - m/s
 * @param {number} sourceDiameter - m; used only when isPuddle is true
 * @param {boolean} [isPuddle] - whether this source is a puddle
 * @returns {number} characteristic height, m
 */
export function characteristicSourceHeight(releaseRate, cloudDensity, windSpeed10m, sourceDiameter, isPuddle = false) {
  if (windSpeed10m <= 0 || cloudDensity <= 0) {
    throw new Error("characteristicSourceHeight: all inputs must be positive");
  }
  if (isPuddle) {
    if (sourceDiameter <= 0) {
      throw new Error("characteristicSourceHeight: sourceDiameter must be positive for a puddle");
    }
    return releaseRate / (cloudDensity * windSpeed10m * sourceDiameter);
  }
  return Math.sqrt((releaseRate * Math.PI) / (4 * cloudDensity * windSpeed10m));
}

/**
 * Computes the critical Richardson number and, with it, which dispersion
 * model applies.
 *
 * @param {object} params
 * @param {number} params.molecularWeight - g/mol
 * @param {number} params.releaseRate - kg/s
 * @param {number} params.sourceDiameter - m; for a puddle, its diameter
 * @param {number} params.windSpeed10m - m/s
 * @param {number} params.roughnessLength - m. Accepted for backward
 *        compatibility with existing call sites and in case this screening
 *        is revisited, but NOT used below — see this file's header comment,
 *        "FRICTION VELOCITY FOR THIS SCREENING".
 * @param {number} params.temperature - K
 * @param {number} [params.cloudTemperature] - K, if the cloud is not at ambient
 *        temperature (a flashing liquid releases vapour far colder than the
 *        air, which makes it denser than its molecular weight alone implies)
 * @returns {{
 *   richardsonNumber: number,
 *   model: "gaussian" | "heavyGas",
 *   densityRatio: number,
 *   explanation: string
 * }}
 */
/**
 * The Richardson number above which the Heavy Gas model is chosen.
 *
 * THRESHOLD 1.95, NOT 1 (2026-10-02). The Tech Doc (4.4.1) states Ri < 1
 * as passive. With this file's Ri (Deacon friction velocity, see
 * screeningFrictionVelocity(); peak release rate) ALOHA's own choices fall
 * on either side of a cut-off between 1.85 and 2.06: Gaussian at Ri 0.68,
 * 0.70, 1.03 (benzene puddle 1 m², F), 1.35, 1.57 and 1.85 (acetone
 * puddles 100 / 140 / 200 m², D — ALOHA runs P1, R1, R2); Heavy Gas at
 * 2.06 (MEK puddle 60 m², urban), 2.80, 3.37, 4.32, 5.19, 7.8. 1.95 is the
 * middle of that gap. (A first try at 1.7, from P1 alone, was moved after
 * R2.) Before this, HAZEL ran Heavy Gas for the acetone puddles (14 / 40 m
 * for P1) where ALOHA ran Gaussian (< 10 / 20 m; HAZEL as Gaussian:
 * 3 / 18 m).
 */
export const RICHARDSON_THRESHOLD = 1.95;

export function chooseDispersionModel({
  molecularWeight,
  releaseRate,
  sourceDiameter,
  windSpeed10m,
  roughnessLength,
  temperature,
  cloudTemperature = null,
  isPuddle = false,
}) {
  const airDensity = gasDensity(MOLECULAR_WEIGHT_OF_AIR, temperature);

  // A cold cloud is denser than its molecular weight alone suggests, which is
  // why a flashing liquefied gas behaves as a heavy gas even when its vapour
  // would be near-neutral at ambient temperature.
  const effectiveCloudTemperature = cloudTemperature ?? temperature;
  const cloudDensity = gasDensity(molecularWeight, effectiveCloudTemperature);

  const densityRatio = cloudDensity / airDensity;

  // A cloud lighter than air cannot slump; the Gaussian model is the right
  // choice regardless of release rate.
  if (cloudDensity <= airDensity) {
    return {
      richardsonNumber: 0,
      model: "gaussian",
      densityRatio,
      explanation:
        `The cloud is lighter than the surrounding air (density ratio ` +
        `${densityRatio.toFixed(2)}), so it cannot slump under gravity. The Gaussian ` +
        `model applies. Note that it does not model buoyant rise either, so ` +
        `ground-level concentrations may be overstated.`,
    };
  }

  // See this file's header comment, "FRICTION VELOCITY FOR THIS SCREENING":
  // this used to be frictionVelocity(windSpeed10m, 10, roughnessLength) (the
  // logarithmic, roughness-dependent formula). It is now
  // screeningFrictionVelocity(windSpeed10m) — Deacon (1973), matching the
  // formula the Tech Doc actually gives for friction velocity elsewhere in
  // ALOHA (the puddle evaporation model, section 3.3.1) — after six
  // independent scenarios tested against real ALOHA runs confirmed it, and
  // the old formula's Ric verdict disagreed with ALOHA's actual model choice
  // in four of those six.
  const uStar = screeningFrictionVelocity(windSpeed10m);
  const gHat = reducedGravity(cloudDensity, airDensity);
  const height = characteristicSourceHeight(
    releaseRate,
    cloudDensity,
    windSpeed10m,
    sourceDiameter,
    isPuddle
  );

  const richardsonNumber = (height * gHat) / (uStar * uStar);

  if (richardsonNumber < RICHARDSON_THRESHOLD) {
    return {
      richardsonNumber,
      model: "gaussian",
      densityRatio,
      // Carried here too (2026-10-04) so a user override to the Heavy Gas
      // model (applyModelOverride() below) has the source height it needs.
      characteristicHeight: height,
      cloudDensity,
      explanation:
        `The cloud is ${densityRatio.toFixed(2)} times denser than air, but at this ` +
        `release rate and wind speed the turbulence the wind supplies dominates over ` +
        `gravity (Richardson number ${richardsonNumber.toFixed(2)}, below the threshold ` +
        `of ${RICHARDSON_THRESHOLD}). The release disperses passively and the Gaussian model applies.`,
    };
  }

  return {
    richardsonNumber,
    model: "heavyGas",
    densityRatio,
    characteristicHeight: height,
    cloudDensity,
    explanation:
      `The cloud is ${densityRatio.toFixed(2)} times denser than air, and at this ` +
      `release rate and wind speed gravity dominates over wind-driven mixing ` +
      `(Richardson number ${richardsonNumber.toFixed(1)}, above the threshold of ${RICHARDSON_THRESHOLD}). ` +
      `The cloud will slump and spread sideways along the ground rather than ` +
      `drifting with the wind, so HAZEL uses its heavy-gas model (see How to use).`,
  };
}

/**
 * Applies the user's choice of dispersion model (Source step, "Dispersion
 * model" select; 2026-10-04) on top of the automatic verdict above.
 *
 * override: "" or undefined = automatic; "gaussian" or "heavyGas" = forced.
 *
 * - Forcing Gaussian is always allowed: it simply ignores the cloud's
 *   density (as the automatic choice does below the threshold).
 * - Forcing Heavy Gas is refused for a cloud that is not denser than air
 *   (densityRatio <= 1): the heavy-gas model has no meaning for a buoyant
 *   cloud (its gravity term would change sign), so the automatic Gaussian
 *   verdict stands and the explanation says why.
 *
 * The returned verdict keeps the automatic one in `automaticModel`, and
 * `overridden` says whether the user's choice changed anything, so the
 * Results banner and the PDF can state it plainly.
 */
export function applyModelOverride(verdict, override) {
  if (!verdict) return verdict;
  const automaticModel = verdict.model;
  const label = (m) => (m === "heavyGas" ? "Heavy Gas" : "Gaussian");

  if (override !== "gaussian" && override !== "heavyGas") {
    return { ...verdict, automaticModel, overridden: false, overrideRefused: false };
  }
  if (override === automaticModel) {
    return { ...verdict, automaticModel, overridden: false, overrideRefused: false };
  }
  if (override === "heavyGas" && !(verdict.densityRatio > 1)) {
    return {
      ...verdict,
      automaticModel,
      overridden: false,
      overrideRefused: true,
      explanation:
        `The Heavy Gas model was requested, but this cloud is not denser than air ` +
        `(density ratio ${verdict.densityRatio.toFixed(2)}), so it cannot be used here; ` +
        `the Gaussian model is kept. ` + verdict.explanation,
    };
  }
  return {
    ...verdict,
    model: override,
    automaticModel,
    overridden: true,
    overrideRefused: false,
    explanation:
      `Model chosen by the user: ${label(override)}. The automatic screening would ` +
      `have chosen ${label(automaticModel)} — ` + verdict.explanation,
  };
}

/**
 * Vapour density relative to air at the same temperature — the quantity to
 * show when release rate is not yet known.
 *
 * This is information, not a verdict. It tells the user what kind of substance
 * they are dealing with; whether the Gaussian model applies to their
 * particular release is decided by chooseDispersionModel() once the Source
 * step supplies a release rate.
 */
export function vapourDensityRatio(molecularWeight) {
  if (!Number.isFinite(molecularWeight) || molecularWeight <= 0) return null;
  return molecularWeight / MOLECULAR_WEIGHT_OF_AIR;
}
