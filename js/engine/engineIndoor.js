/**
 * engineIndoor.js
 * ---------------
 * Indoor concentration: how much of an outdoor toxic cloud builds up inside
 * a nearby building, for someone sheltering in place instead of evacuating.
 *
 * Source: ALOHA 5.4.4 Technical Documentation (NOAA TM NOS OR&R 43),
 * section 4.6, after Wilson, D.J. (1987), "Stay Indoors or Evacuate to
 * Avoid Exposure to Toxic Gas?", and the building-leakage generalisation of
 * Sherman, M. (1980), "Air Infiltration in Buildings" (University of
 * California, Berkeley), as cited by the Tech Doc.
 *
 * CONCEPTUAL MODEL (Tech Doc 4.6)
 * --------------------------------
 * A well-sealed building is treated as a low-pass filter on the outdoor
 * concentration — the same mathematics as an electrical R-C circuit. The
 * indoor concentration obeys a single first-order ODE:
 *
 *     dCi/dt = (Co(t) - Ci(t)) / tau_E
 *
 * where Co is the outdoor concentration, Ci the indoor concentration, and
 * tau_E the infiltration time constant: the time for the indoor
 * concentration to reach 63% of a sudden step-change outdoors. The Tech
 * Doc states tau_E typically runs from about 0.1 hour (a leaky building)
 * to about 1 hour (a tightly sealed one).
 *
 * HAZEL's simplification: outdoor concentration is treated as held at its
 * PEAK value (from the existing dispersion engine) for an exposure duration,
 * then dropping to zero — a plain step pulse rather than the true
 * rise-and-fall profile a real cloud passage would show. This is exactly the
 * same "hold at the peak rate" conservative simplification already used
 * throughout this project for time-varying releases (see
 * engineLimitations.js and buildDispersionScenario() in stepSource.js) —
 * consistent, not a new kind of approximation. For a step input, the ODE
 * above has an exact closed form, implemented below rather than solved
 * numerically.
 *
 * EXPOSURE DURATION IS NOT SIMPLY THE RELEASE DURATION — FIXED 2026-09-26
 * ---------------------------------------------------------------------------
 * The step pulse's WIDTH used to be the release duration itself, handed
 * straight through from indoorPanel.js. That is right for a release long
 * enough to reach a genuine steady state at the building's distance, but
 * wrong for a brief one: the audit behind this fix
 * (the 2026-09-26 duration review, finding #4) found it
 * understated indoor exposure by up to about 37x for a short puff observed
 * several kilometres downwind. The outdoor concentration at a fixed point
 * does not rise and fall in exactly releaseDuration seconds; it takes time
 * to arrive and time to pass, governed by the same along-wind smearing
 * (Beals 1971's sigma_x) already used elsewhere in this project — see
 * finiteDurationFactor() in engineHeavyGas.js and peakConcentration() in
 * engineGaussian.js — and that smearing GROWS with distance, so the error
 * grows with it too. effectiveExposureDurationSeconds() below adds that same
 * sigma_x-derived residence time on top of the release duration, rather than
 * replacing it, so the correction is physically motivated (tied to the
 * actual downwind spreading at this specific distance, not an arbitrary
 * margin), always in the safe direction (it can only lengthen the modelled
 * exposure, never shorten it), and self-limiting for a genuinely long
 * release (where the added term is small next to the release duration
 * already dominating the sum) — exactly the "prefer overestimate to
 * underestimate, but stay logical" balance this fix was asked to strike.
 *
 * ESTIMATING tau_E (Sherman 1980, as summarised in Tech Doc 4.6)
 * -----------------------------------------------------------------
 * A user can specify tau_E directly (this module supports that — see
 * indoorPanel.js's "manual" mode), or it can be estimated from building
 * parameters and weather:
 *
 *     tau_E = Vs / sqrt(Qs^2 + Qw^2)
 *
 * Vs is the building volume; Qs and Qw are the stack (temperature-driven)
 * and wind-driven infiltration flow rates:
 *
 *     Qs = AE * fs * sqrt(|Ti - To|),   fs = ((1 + R/2) / 3) * sqrt(g * Hs / Ti)
 *     Qw = AE * Csh * (1 - R)^(1/3) * UH
 *     AE = 0.00059 * (building floor area)
 *
 * R = 0.5 (the fixed ratio of vertical to total leakage), Hs = structure
 * height, Ti/To = inside/outside temperature (K), UH = wind speed at the
 * building's height (the Tech Doc 4.2.3 log profile — see
 * logProfileWindSpeed() in engineGaussian.js), Csh = 0.24 (sheltered) or
 * 0.32 (unsheltered).
 *
 * A NOTE ON SOURCE QUALITY: the scanned copy of Tech Doc section 4.6
 * available to this project prints both parameter formulas with their
 * superscripts and fractions scattered by text extraction. They are the
 * Sherman-Grimsrud (Lawrence Berkeley Laboratory) infiltration model, whose
 * published stack and wind parameters are fs = ((1 + R/2)/3) sqrt(g Hs/Ti)
 * and fw = Csh (1 - R)^(1/3) — the "1 + R/2", the "3" and the "1/3" are
 * all visible in the scanned text.
 *
 * FIXED 2026-10-02: until then HAZEL read the stack parameter as
 * sqrt(R g Hs / Ti) and the wind factor as Csh (1 - R). Against ALOHA's own
 * printed air-exchange rates (ammonia comparison runs, Eindhoven, open
 * country) the old reading gave 0.68 / 0.36 / 0.39 ACH where ALOHA reports
 * 0.85 / 0.39 / 0.24 (single storey unsheltered at 5 m/s D; double storey
 * sheltered at 5 m/s D; double storey sheltered at 1.5 m/s F, 10 C). The
 * corrected parameters with the building-height wind from the Tech Doc
 * 4.2.3 log profile give 0.854 / 0.392 / 0.246 — within 0.5%, 0.5% and 2.5%.
 *
 * WHAT THIS MODULE DOES NOT DO
 * -----------------------------
 * It does not model multi-room airflow, filtration, HVAC systems that
 * actively draw in outdoor air, or a building any more complex than a
 * single well-mixed volume — the same "broad generalisation" scope ALOHA
 * itself explicitly limits this model to (Tech Doc 4.6: "because of the
 * extreme variability in weather and building types, ALOHA must make some
 * broad generalizations"). It also assumes the building sits directly on
 * the plume centreline, at a distance the user supplies — see
 * indoorPanel.js.
 */

import { sigmaX } from "./engineGaussian.js";

/** Sherman (1980): effective leakage area is this fraction of floor area,
 *  from a study of 196 houses. */
export const LEAKAGE_AREA_FRACTION = 0.00059;

/** ALOHA's own default assumption for an average house (Tech Doc 4.6):
 *  160 m^2 (1722 ft^2). */
export const DEFAULT_FLOOR_AREA_M2 = 160;

/** ALOHA's own default assumption for indoor temperature (Tech Doc 4.6): 20 C. */
export const DEFAULT_INTERNAL_TEMPERATURE_K = 293.15;

/** Fixed ratio of vertical to total building leakage (Tech Doc 4.6). */
export const VERTICAL_LEAKAGE_RATIO = 0.5;

/** Wind-sheltering coefficients (Tech Doc 4.6). */
export const SHELTERING_COEFFICIENTS = { sheltered: 0.24, unsheltered: 0.32 };

/** ALOHA's own default ceiling heights by building height (Tech Doc 4.6). */
export const STORY_CEILING_HEIGHTS_M = { 1: 2.5, 2: 5.0 };

const GRAVITY = 9.80665; // m/s^2

/* ========================================================================
   BUILDING LEAKAGE AND THE INFILTRATION TIME CONSTANT
   ======================================================================== */

/**
 * Effective leakage area, AE = 0.00059 * floor area (Sherman 1980).
 * @param {number} [floorAreaM2]
 * @returns {number} m^2
 */
export function effectiveLeakageArea(floorAreaM2 = DEFAULT_FLOOR_AREA_M2) {
  if (!(floorAreaM2 > 0)) {
    throw new Error("Floor area must be greater than zero.");
  }
  return LEAKAGE_AREA_FRACTION * floorAreaM2;
}

/**
 * The stack parameter, fs = ((1 + R/2) / 3) * sqrt(g * Hs / Ti) (Tech Doc 4.6).
 * @param {object} params
 * @param {number} params.structureHeightM - Hs, m
 * @param {number} [params.internalTemperatureK] - Ti, K
 * @param {number} [params.verticalLeakageRatio] - R
 * @returns {number} fs, in units of (m/s)/sqrt(K)
 */
export function stackParameter({
  structureHeightM,
  internalTemperatureK = DEFAULT_INTERNAL_TEMPERATURE_K,
  verticalLeakageRatio = VERTICAL_LEAKAGE_RATIO,
}) {
  if (!(structureHeightM > 0)) {
    throw new Error("Structure height must be greater than zero.");
  }
  if (!(internalTemperatureK > 0)) {
    throw new Error("Internal temperature must be given in kelvin and be greater than zero.");
  }
  return ((1 + verticalLeakageRatio / 2) / 3) * Math.sqrt((GRAVITY * structureHeightM) / internalTemperatureK);
}

/**
 * Stack (temperature-driven) infiltration flow, Qs = AE * fs * sqrt(|dT|)
 * (Tech Doc 4.6, after Grimsrud, Sherman and Sonderegger 1983).
 * @returns {number} m^3/s
 */
export function stackDrivenFlow({
  effectiveLeakageAreaM2,
  structureHeightM,
  internalTemperatureK = DEFAULT_INTERNAL_TEMPERATURE_K,
  outdoorTemperatureK,
  verticalLeakageRatio = VERTICAL_LEAKAGE_RATIO,
}) {
  if (!(effectiveLeakageAreaM2 > 0)) {
    throw new Error("Effective leakage area must be greater than zero.");
  }
  if (!Number.isFinite(outdoorTemperatureK) || outdoorTemperatureK <= 0) {
    throw new Error("Outdoor temperature must be given in kelvin and be greater than zero.");
  }
  const fs = stackParameter({ structureHeightM, internalTemperatureK, verticalLeakageRatio });
  const deltaT = Math.abs(internalTemperatureK - outdoorTemperatureK);
  return effectiveLeakageAreaM2 * fs * Math.sqrt(deltaT);
}

/**
 * Wind-driven infiltration flow, Qw = AE * Csh * (1-R)^(1/3) * UH (Tech Doc 4.6).
 * See the module docstring for how the source formula's OCR-garbled form
 * was verified.
 * @returns {number} m^3/s
 */
export function windDrivenFlow({
  effectiveLeakageAreaM2,
  windSpeedAtStructureHeight,
  sheltering = "unsheltered",
  verticalLeakageRatio = VERTICAL_LEAKAGE_RATIO,
}) {
  if (!(effectiveLeakageAreaM2 > 0)) {
    throw new Error("Effective leakage area must be greater than zero.");
  }
  const csh = SHELTERING_COEFFICIENTS[sheltering];
  if (!csh) {
    throw new Error(`Unknown sheltering category: ${sheltering}`);
  }
  if (!Number.isFinite(windSpeedAtStructureHeight) || windSpeedAtStructureHeight < 0) {
    throw new Error("Wind speed at the building must be zero or greater.");
  }
  return effectiveLeakageAreaM2 * csh * Math.cbrt(1 - verticalLeakageRatio) * windSpeedAtStructureHeight;
}

/**
 * The infiltration time constant itself, tau_E = Vs / sqrt(Qs^2 + Qw^2)
 * (Tech Doc 4.6).
 * @returns {number} seconds
 */
export function infiltrationTimeConstant({ buildingVolumeM3, stackFlowM3PerS, windFlowM3PerS }) {
  if (!(buildingVolumeM3 > 0)) {
    throw new Error("Building volume must be greater than zero.");
  }
  const totalFlow = Math.sqrt(stackFlowM3PerS * stackFlowM3PerS + windFlowM3PerS * windFlowM3PerS);
  if (!(totalFlow > 0)) {
    throw new Error(
      "Computed infiltration flow is zero — this happens only when both the wind speed at the " +
        "building and the indoor/outdoor temperature difference are zero. Check the weather inputs."
    );
  }
  return buildingVolumeM3 / totalFlow;
}

/**
 * Convenience wrapper: estimates tau_E directly from building parameters
 * and ambient conditions, composing every step above.
 *
 * Building volume is approximated as floor area times structure height —
 * the same broad generalisation the Tech Doc's own defaults imply (a
 * single footprint, no distinction between floors), not a claim that a
 * real building's volume is exactly this.
 *
 * @param {object} params
 * @param {number} [params.floorAreaM2]
 * @param {1|2} [params.stories]
 * @param {number} [params.structureHeightM] - overrides the story-based default
 * @param {number} [params.internalTemperatureK]
 * @param {number} params.outdoorTemperatureK
 * @param {number} params.windSpeedAtStructureHeight - m/s, wind speed at the building's height
 * @param {"sheltered"|"unsheltered"} [params.sheltering]
 * @param {number} [params.verticalLeakageRatio]
 * @returns {{tauSeconds: number, effectiveLeakageAreaM2: number, buildingVolumeM3: number,
 *            stackFlowM3PerS: number, windFlowM3PerS: number, structureHeightM: number}}
 */
export function estimateInfiltrationTimeConstant({
  floorAreaM2 = DEFAULT_FLOOR_AREA_M2,
  stories = 1,
  structureHeightM = STORY_CEILING_HEIGHTS_M[stories] ?? STORY_CEILING_HEIGHTS_M[1],
  internalTemperatureK = DEFAULT_INTERNAL_TEMPERATURE_K,
  outdoorTemperatureK,
  windSpeedAtStructureHeight,
  sheltering = "unsheltered",
  verticalLeakageRatio = VERTICAL_LEAKAGE_RATIO,
}) {
  const effectiveLeakageAreaM2 = effectiveLeakageArea(floorAreaM2);
  const buildingVolumeM3 = floorAreaM2 * structureHeightM;

  const stackFlowM3PerS = stackDrivenFlow({
    effectiveLeakageAreaM2,
    structureHeightM,
    internalTemperatureK,
    outdoorTemperatureK,
    verticalLeakageRatio,
  });
  const windFlowM3PerS = windDrivenFlow({
    effectiveLeakageAreaM2,
    windSpeedAtStructureHeight,
    sheltering,
    verticalLeakageRatio,
  });
  const tauSeconds = infiltrationTimeConstant({ buildingVolumeM3, stackFlowM3PerS, windFlowM3PerS });

  return { tauSeconds, effectiveLeakageAreaM2, buildingVolumeM3, stackFlowM3PerS, windFlowM3PerS, structureHeightM };
}

/**
 * Checks building/weather parameters before they are used, so a bad input
 * produces a clear message rather than NaN propagating silently.
 * @returns {string[]} problems; empty means the parameters are usable
 */
export function validateBuildingParameters({
  floorAreaM2,
  stories,
  internalTemperatureK,
  outdoorTemperatureK,
  windSpeedAtStructureHeight,
}) {
  const problems = [];
  if (!Number.isFinite(floorAreaM2) || floorAreaM2 <= 0) {
    problems.push("Floor area must be greater than zero.");
  }
  if (![1, 2].includes(stories)) {
    problems.push("Number of stories must be 1 or 2.");
  }
  if (!Number.isFinite(internalTemperatureK) || internalTemperatureK <= 0) {
    problems.push("Internal temperature must be given in kelvin and be greater than zero.");
  }
  if (!Number.isFinite(outdoorTemperatureK) || outdoorTemperatureK <= 0) {
    problems.push("Outdoor temperature must be given in kelvin and be greater than zero.");
  }
  if (!Number.isFinite(windSpeedAtStructureHeight) || windSpeedAtStructureHeight < 0) {
    problems.push("Wind speed at the building must be zero or greater.");
  }
  return problems;
}

/* ========================================================================
   THE INDOOR CONCENTRATION ITSELF
   ======================================================================== */

/**
 * The step pulse's effective width fed to the R-C filter model below — see
 * the module docstring's "EXPOSURE DURATION IS NOT SIMPLY THE RELEASE
 * DURATION" section for the full account of why this is not just
 * releaseDuration.
 *
 *     exposureDurationSeconds = releaseDuration + 2*sigma_x(x)/windSpeed10m
 *
 * The added term is the same along-wind (Beals 1971) residence-time estimate
 * already used, in different guises, by finiteDurationFactor()
 * (engineHeavyGas.js) and peakConcentration() (engineGaussian.js): roughly
 * how long a brief pulse's elevated concentration actually lingers at a
 * fixed downwind point, once the leading and trailing edges have smeared out
 * over sigma_x(x). Because sigma_x and windSpeed10m are both positive
 * whenever there is a meaningful distance and wind to speak of, this term is
 * never negative — the correction can only lengthen the modelled exposure
 * relative to releaseDuration alone, never shorten it.
 *
 * A missing or non-finite releaseDuration (the heavy-gas branch has no
 * separate duration field of its own in scenarioBase — see
 * buildDispersionScenario() in stepSource.js) falls back to one hour, as
 * before, and skips the sigma_x correction entirely: that correction exists
 * specifically to correct for a BRIEF release's residence time, and adding
 * it on top of an already-long assumed duration would not change the result
 * in any way that matters.
 *
 * @param {object} params
 * @param {number} [params.releaseDuration] - seconds; missing/non-finite treated as 3600
 * @param {number} params.downwindDistance - x, m
 * @param {number} params.windSpeed10m - m/s at 10 m
 * @param {string} params.stabilityClass - "A".."F"
 * @returns {number} seconds, >= the input releaseDuration (or >= 3600 when
 *        releaseDuration was missing)
 */
export function effectiveExposureDurationSeconds({
  releaseDuration,
  downwindDistance,
  windSpeed10m,
  stabilityClass,
}) {
  const baseDurationSeconds = Number.isFinite(releaseDuration) ? releaseDuration : 3600;

  if (!Number.isFinite(releaseDuration) || !(windSpeed10m > 0) || !(downwindDistance > 0)) {
    return baseDurationSeconds;
  }

  const alongwindResidenceSeconds = (2 * sigmaX(downwindDistance, stabilityClass)) / windSpeed10m;
  return baseDurationSeconds + alongwindResidenceSeconds;
}

/**
 * Indoor concentration while the outdoor concentration is held at a
 * constant value (the "charging" phase of the R-C filter): the exact
 * solution of dCi/dt = (Co - Ci) / tau for constant Co and Ci(0) = 0.
 *
 *     Ci(t) = Co * (1 - exp(-t / tau))
 *
 * At t = tau this is Co * (1 - 1/e) ≈ 0.632 * Co — the "63% after one time
 * constant" the Tech Doc uses to define tau_E in the first place.
 *
 * @param {number} t - seconds since the outdoor concentration stepped up
 * @param {number} outdoorConcentration - Co, held constant (any consistent unit)
 * @param {number} tauSeconds
 * @returns {number} indoor concentration, in the same unit as outdoorConcentration
 */
export function indoorConcentrationDuringExposure(t, outdoorConcentration, tauSeconds) {
  if (t <= 0) return 0;
  if (!(tauSeconds > 0)) {
    throw new Error("Infiltration time constant must be greater than zero.");
  }
  return outdoorConcentration * (1 - Math.exp(-t / tauSeconds));
}

/**
 * The highest indoor concentration reached — at the moment the outdoor
 * concentration drops back to zero (the end of the modelled exposure),
 * since indoor concentration only rises while there is more to "charge"
 * toward outdoors and only falls once the outdoor cloud has passed.
 *
 * @returns {number} peak indoor concentration
 */
export function peakIndoorConcentration(outdoorConcentration, exposureDurationSeconds, tauSeconds) {
  return indoorConcentrationDuringExposure(exposureDurationSeconds, outdoorConcentration, tauSeconds);
}

/**
 * Indoor concentration after the outdoor cloud has passed (the
 * "discharging" phase): exponential decay from the peak reached at the end
 * of the exposure.
 *
 *     Ci(t) = Ci_peak * exp(-(t - exposureDuration) / tau),   t > exposureDuration
 *
 * @param {number} t - seconds since the outdoor concentration first stepped up
 * @returns {number} indoor concentration
 */
export function indoorConcentrationAfterExposure(t, outdoorConcentration, exposureDurationSeconds, tauSeconds) {
  if (!(tauSeconds > 0)) {
    throw new Error("Infiltration time constant must be greater than zero.");
  }
  if (t <= exposureDurationSeconds) {
    return indoorConcentrationDuringExposure(t, outdoorConcentration, tauSeconds);
  }
  const peak = peakIndoorConcentration(outdoorConcentration, exposureDurationSeconds, tauSeconds);
  return peak * Math.exp(-(t - exposureDurationSeconds) / tauSeconds);
}

/**
 * Indoor concentration at any time, dispatching between the charging and
 * discharging phases — the one function most callers actually want.
 * @returns {number} indoor concentration
 */
export function indoorConcentrationAtTime(t, outdoorConcentration, exposureDurationSeconds, tauSeconds) {
  return t <= exposureDurationSeconds
    ? indoorConcentrationDuringExposure(t, outdoorConcentration, tauSeconds)
    : indoorConcentrationAfterExposure(t, outdoorConcentration, exposureDurationSeconds, tauSeconds);
}
