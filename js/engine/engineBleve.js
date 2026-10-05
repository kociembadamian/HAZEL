/**
 * engineBleve.js
 * --------------
 * BLEVE (Boiling Liquid Expanding Vapour Explosion) fireball model:
 * thermal radiation from a fireball formed when a pressurised tank of
 * liquefied gas ruptures and its contents ignite immediately.
 *
 * Source: ALOHA 5.4.4 Technical Documentation (NOAA TM NOS OR&R 43),
 * section 6.3, cross-checked against sections 6.1-6.2 for the shared
 * radiation formula and Levels of Concern. Every constant here is quoted
 * directly from that document; none are estimated.
 *
 * Physical picture (Tech Doc 6.1, 6.3): the fireball is treated as a sphere
 * resting on the ground, radiating from its surface at a constant flux for
 * its whole (short) lifetime. The flux reaching a point downrange is:
 *
 *     q = E * F * tau
 *
 * where E is the emissive power at the fireball's surface, F is the
 * geometric view factor (how much of the observer's field of view the
 * fireball fills), and tau is the fraction of that radiation the
 * atmosphere transmits rather than absorbing.
 *
 * SCOPE
 * -----
 * This implements the default case ALOHA itself defaults to: the entire
 * mass of the tank's contents participates in the fireball. ALOHA also
 * offers a refinement — computing what fraction flashes at a user-specified
 * rupture pressure via Clausius-Clapeyron, with the rest forming a pool
 * fire instead (Tech Doc section 6.3.2) — which is not implemented here.
 * Treating the full contents as the fireball is the conservative direction
 * (a larger fireball radiates more, not less), consistent with the
 * conservative choices made throughout this project.
 */

/** Empirical emissive flux for a large hydrocarbon fireball, W/m^2
 *  [Tech Doc 6.3.1, after AIChE 1994]. */
const REFERENCE_EMISSIVE_FLUX = 350000;

/** Heat of combustion of propane, J/kg — the reference AIChE's 350 kW/m^2
 *  figure was derived for [Tech Doc 6.3.1]. */
const PROPANE_HEAT_OF_COMBUSTION = 46000000;

/** Maximum chemical mass ALOHA will model in a single BLEVE, kg (5000 metric
 *  tons — "of the order of the largest historical single BLEVE incident",
 *  Tech Doc 6.3). */
const MAX_FIREBALL_MASS_KG = 5000000;

/** Roberts' (1982) correlation for maximum fireball diameter [Tech Doc 6.3.2]. */
export function fireballDiameter(massKg) {
  return 5.8 * Math.cbrt(Math.min(massKg, MAX_FIREBALL_MASS_KG));
}

/** Dutch Committee for Prevention of Disasters (Duiser 1992) burn duration
 *  correlation [Tech Doc 6.3.4]. Informational only — ALOHA does not use it
 *  in the hazard-zone calculation, only displays it. */
export function fireballDuration(massKg) {
  return 0.852 * Math.pow(Math.min(massKg, MAX_FIREBALL_MASS_KG), 0.26);
}

/**
 * Emissive power at the fireball's surface [Tech Doc 6.3.1], scaled from the
 * 350 kW/m^2 hydrocarbon reference by how energetic this chemical's
 * combustion is relative to propane's.
 *
 * @param {number} heatOfCombustion - J/kg
 * @returns {number} W/m^2
 */
export function fireballEmissivePower(heatOfCombustion) {
  return REFERENCE_EMISSIVE_FLUX * (heatOfCombustion / PROPANE_HEAT_OF_COMBUSTION);
}

/**
 * Geometric view factor for a sphere resting on the ground, seen by a
 * vertical receiving surface at ground level [Tech Doc 6.3.2, after AIChE
 * 1994]:
 *
 *     F = x*(D/2)^2 / (x^2 + (D/2)^2)^(3/2)     for x > D/2
 *
 * Only defined beyond the fireball's own radius — inside that distance the
 * observer is, physically, inside or beneath the fireball itself, which is
 * not a location this formula (or this project) has anything meaningful to
 * say about.
 *
 * @param {number} groundDistance - horizontal distance from the point
 *        directly below the fireball's centre to the receptor, m
 * @param {number} maxDiameter - fireball diameter, m
 * @returns {number|null} dimensionless view factor, 0 to 1, or null if inside the fireball's radius
 */
export function fireballViewFactor(groundDistance, maxDiameter) {
  const radius = maxDiameter / 2;
  if (groundDistance <= radius) return null; // undefined this close in — see docstring
  return (groundDistance * radius * radius) / Math.pow(groundDistance * groundDistance + radius * radius, 1.5);
}

/**
 * Partial pressure of water vapour in the atmosphere, from Thibodeaux
 * (1979) [Tech Doc 6.3.3]:
 *
 *     P_w = 99.89 * (R_H/100) * exp(21.66 - 5431.3/T_a)
 *
 * @param {number} relativeHumidity - percent
 * @param {number} ambientTemperature - K
 * @returns {number} Pa
 */
export function waterVapourPressure(relativeHumidity, ambientTemperature) {
  return 99.89 * (relativeHumidity / 100) * Math.exp(21.66 - 5431.3 / ambientTemperature);
}

/**
 * Atmospheric transmissivity to thermal radiation, from Cook, Bahrami and
 * Whitehouse (1990) [Tech Doc 6.3.3]:
 *
 *     tau = 1.389 - 0.135*log10(P_w * x)
 *
 * Accounts only for water vapour absorption (Tech Doc notes this
 * overestimates transmitted radiation whenever fog, rain, smoke or CO2 also
 * attenuate it — the conservative direction, since it means a HIGHER
 * predicted flux at distance, not a lower one).
 *
 * Clamped to [0, 1]: the empirical fit is not defined outside the range it
 * was built for, and transmissivity cannot physically leave that interval.
 *
 * @param {number} waterVapourPressurePa
 * @param {number} distance - m, between emitting and receiving surfaces
 * @returns {number} dimensionless, 0 to 1
 */
export function atmosphericTransmissivity(waterVapourPressurePa, distance) {
  const tau = 1.389 - 0.135 * Math.log10(waterVapourPressurePa * distance);
  return Math.max(0, Math.min(1, tau));
}

/**
 * Thermal radiation flux incident on a vertical surface at a given ground
 * distance from a BLEVE fireball [Tech Doc 6.1, 6.3].
 *
 * @param {object} params
 * @param {number} params.groundDistance - m, horizontal distance from the point below the fireball
 * @param {number} params.fireballMassKg - kg, mass of chemical in the fireball
 * @param {number} params.heatOfCombustion - J/kg
 * @param {number} params.relativeHumidity - percent
 * @param {number} params.ambientTemperature - K
 * @returns {number|null} W/m^2, or null if groundDistance is inside the fireball's own radius
 */
export function fireballRadiationAt({
  groundDistance,
  fireballMassKg,
  heatOfCombustion,
  relativeHumidity,
  ambientTemperature,
}) {
  const diameter = fireballDiameter(fireballMassKg);
  const viewFactor = fireballViewFactor(groundDistance, diameter);
  if (viewFactor === null) return null;

  const emissivePower = fireballEmissivePower(heatOfCombustion);
  const pWater = waterVapourPressure(relativeHumidity, ambientTemperature);
  const tau = atmosphericTransmissivity(pWater, groundDistance);

  return emissivePower * viewFactor * tau;
}

/**
 * Finds the distance at which incident thermal radiation from a BLEVE
 * fireball drops to a given Level of Concern.
 *
 * @param {object} scenario - same fields as fireballRadiationAt(), minus groundDistance
 * @param {number} scenario.thresholdWm2 - W/m^2
 * @param {number} [maxSearchDistance] - m
 * @returns {{ thresholdExceeded: boolean, maxDistance: number, fireballDiameter: number }}
 */
export function findFireballRadiationDistance(scenario, maxSearchDistance = 5000) {
  const diameter = fireballDiameter(scenario.fireballMassKg);
  const startDistance = diameter / 2 + 0.1;

  const fluxAt = (d) => fireballRadiationAt({ ...scenario, groundDistance: d });

  if (fluxAt(startDistance) < scenario.thresholdWm2) {
    return { thresholdExceeded: false, maxDistance: 0, fireballDiameter: diameter };
  }

  // Coarse-then-fine search, the same pattern used throughout the project's
  // other threat-zone functions (see findThreatZone() in engineGaussian.js):
  // flux falls off over a wide range of distances, so a logarithmic step
  // brackets the crossing point before a bisection refines it.
  let inside = startDistance;
  let outside = 0;
  let probe = startDistance;
  while (probe <= maxSearchDistance) {
    if (fluxAt(probe) >= scenario.thresholdWm2) {
      inside = probe;
    } else {
      outside = probe;
      break;
    }
    probe *= 1.3;
  }

  if (outside === 0) {
    return {
      thresholdExceeded: true,
      maxDistance: maxSearchDistance,
      fireballDiameter: diameter,
      reachedSearchLimit: true,
    };
  }

  let low = inside;
  let high = outside;
  for (let i = 0; i < 60 && high - low > 0.1; i++) {
    const mid = (low + high) / 2;
    if (fluxAt(mid) >= scenario.thresholdWm2) low = mid;
    else high = mid;
  }

  return { thresholdExceeded: true, maxDistance: low, fireballDiameter: diameter };
}

/**
 * Standard thermal radiation Levels of Concern [Tech Doc 6.2, after Mudan
 * and Croce, NFPA 1995]: fatality threshold, second-degree burns on
 * unprotected skin, and the onset of pain — each for an exposure of 60
 * seconds or less.
 */
export const THERMAL_RADIATION_LEVELS = [
  { id: "thermal3", label: "Thermal-3", description: "Potentially lethal", wPerM2: 10000, colour: "red" },
  { id: "thermal2", label: "Thermal-2", description: "Second-degree burns on unprotected skin", wPerM2: 5000, colour: "orange" },
  { id: "thermal1", label: "Thermal-1", description: "Pain within 60 seconds", wPerM2: 2000, colour: "yellow" },
];
