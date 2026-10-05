/**
 * enginePoolFire.js
 * -----------------
 * Thermal radiation from a burning pool of liquid fuel.
 *
 * Source: ALOHA 5.4.4 Technical Documentation (NOAA TM NOS OR&R 43),
 * section 6.5. Every constant is quoted directly from that document.
 *
 * Physical picture (Tech Doc 6.5): flames rising from the pool form a
 * cylinder, tilted downwind by the wind. The cylinder's lateral surface
 * radiates; the flux reaching a point is q = E*F*tau, exactly the same
 * combination rule used for BLEVE (engineBleve.js) and, via the shared
 * numerical integrator, jet fire (engineJetFire.js).
 *
 * SCOPE
 * -----
 * Implements a pool of known, fixed diameter (Tech Doc 6.5.3's dynamic
 * pool-growth submodel — its own new ODE for spreading radius, layered on
 * top of the Bernoulli tank-release equation this project already has — is
 * not implemented; HAZEL's puddle source already treats pool area as a
 * fixed input rather than something that spreads over time, a limitation
 * already recorded in engineLimitations.js, and this model inherits it
 * rather than reimplementing it differently in one place only).
 */

import { computeViewFactor, tileTiltedCylinder } from "./engineViewFactor.js";
import { atmosphericTransmissivity, waterVapourPressure } from "./engineBleve.js";

/** Fraction of combustion energy radiated, a fixed value ALOHA uses
 *  [Tech Doc 6.5.1, after Roberts 1982]. */
const RADIATIVE_FRACTION = 0.3;

const GRAVITY = 9.80665;

/**
 * Mass burn rate per unit pool area [Tech Doc 6.5.1, after Mudan 1984,
 * with ALOHA's temperature correction]:
 *
 *     m_dot = 0.001 * Hc / (Hv + cp*(Tb - T))
 *
 * @param {number} heatOfCombustion - J/kg
 * @param {number} heatOfVaporization - J/kg
 * @param {number} specificHeatCapacity - J/(kg*K)
 * @param {number} boilingPoint - K
 * @param {number} poolTemperature - K
 * @returns {number} kg/(m^2 s)
 */
export function massBurnRatePerArea(
  heatOfCombustion,
  heatOfVaporization,
  specificHeatCapacity,
  boilingPoint,
  poolTemperature
) {
  return (
    (0.001 * heatOfCombustion) /
    (heatOfVaporization + specificHeatCapacity * (boilingPoint - poolTemperature))
  );
}

/**
 * Flame height, from a modified Thomas (1963) correlation [Tech Doc 6.5.2]:
 *
 *     u* = u * (rho_a / (g * m_dot * d))^(1/3)
 *     h = d * 55 * (m_dot / (rho_a * sqrt(g*d)))^0.67 * (u*)^(-0.21)
 */
export function poolFlameHeight(windSpeed, ambientAirDensity, massBurnRate, poolDiameter) {
  const uStar =
    windSpeed * Math.cbrt(ambientAirDensity / (GRAVITY * massBurnRate * poolDiameter));
  return (
    poolDiameter *
    55 *
    Math.pow(massBurnRate / (ambientAirDensity * Math.sqrt(GRAVITY * poolDiameter)), 0.67) *
    Math.pow(uStar, -0.21)
  );
}

/**
 * Flame tilt angle from vertical, from the American Gas Association (1973)
 * correlation [Tech Doc 6.5.2]:
 *
 *     theta = 0                  if u* <= 1
 *     theta = acos(1/sqrt(u*))   if u* > 1
 */
export function poolFlameTilt(windSpeed, ambientAirDensity, massBurnRate, poolDiameter) {
  const uStar =
    windSpeed * Math.cbrt(ambientAirDensity / (GRAVITY * massBurnRate * poolDiameter));
  if (uStar <= 1) return 0;
  return Math.acos(1 / Math.sqrt(uStar));
}

/**
 * Average emissive power at the flame surface [Tech Doc 6.5.1, after
 * Moorhouse and Pritchard 1982]:
 *
 *     E = f_rad * Hc * m_dot / (1 + 4h/d)
 */
export function poolFireEmissivePower(heatOfCombustion, massBurnRate, flameHeight, poolDiameter) {
  return (RADIATIVE_FRACTION * heatOfCombustion * massBurnRate) / (1 + (4 * flameHeight) / poolDiameter);
}

/**
 * Thermal radiation flux incident on a vertical surface at a given point,
 * from a pool fire.
 *
 * @param {object} params
 * @param {[number,number,number]} params.receptorPoint - m, in the pool-centred frame (see enginePoolFireTests.js for the convention)
 * @param {number} params.poolDiameter - m
 * @param {number} params.heatOfCombustion - J/kg
 * @param {number} params.heatOfVaporization - J/kg
 * @param {number} params.specificHeatCapacity - J/(kg*K)
 * @param {number} params.boilingPoint - K
 * @param {number} params.poolTemperature - K
 * @param {number} params.windSpeed - m/s
 * @param {number} params.ambientAirDensity - kg/m^3
 * @param {number} params.relativeHumidity - percent
 * @param {number} params.ambientTemperature - K
 * @returns {{ flux: number, flameHeight: number, tiltAngle: number, viewFactor: number }}
 */
export function poolFireRadiationAt(params) {
  const {
    receptorPoint,
    poolDiameter,
    heatOfCombustion,
    heatOfVaporization,
    specificHeatCapacity,
    boilingPoint,
    poolTemperature,
    windSpeed,
    ambientAirDensity,
    relativeHumidity,
    ambientTemperature,
  } = params;

  const massBurnRate = massBurnRatePerArea(
    heatOfCombustion, heatOfVaporization, specificHeatCapacity, boilingPoint, poolTemperature
  );
  const flameHeight = poolFlameHeight(windSpeed, ambientAirDensity, massBurnRate, poolDiameter);
  const tiltAngle = poolFlameTilt(windSpeed, ambientAirDensity, massBurnRate, poolDiameter);
  const emissivePower = poolFireEmissivePower(heatOfCombustion, massBurnRate, flameHeight, poolDiameter);

  const tiles = tileTiltedCylinder(poolDiameter, flameHeight, tiltAngle);
  const { viewFactor } = computeViewFactor(tiles, receptorPoint);

  const distance = Math.hypot(receptorPoint[0], receptorPoint[1], receptorPoint[2]);
  const pWater = waterVapourPressure(relativeHumidity, ambientTemperature);
  const tau = atmosphericTransmissivity(pWater, distance);

  return { flux: emissivePower * viewFactor * tau, flameHeight, tiltAngle, viewFactor };
}

/**
 * Finds the downwind ground distance at which incident thermal radiation
 * from a pool fire drops to a given Level of Concern.
 *
 * The receptor is placed at ground level (z=0), downwind (+x) of the pool
 * centre — the pool's own tilt (toward +x, matching engineViewFactor.js's
 * convention) means this is the direction the flame leans toward and where
 * the flux is strongest, matching how ALOHA reports a single downwind
 * threat distance for a pool fire.
 *
 * @param {object} scenario - same fields as poolFireRadiationAt() minus receptorPoint
 * @param {number} scenario.thresholdWm2 - W/m^2
 * @param {number} [maxSearchDistance] - m
 * @returns {{ thresholdExceeded: boolean, maxDistance: number }}
 */
export function findPoolFireRadiationDistance(scenario, maxSearchDistance = 2000) {
  const fluxAt = (d) =>
    poolFireRadiationAt({ ...scenario, receptorPoint: [d, 0, 0] }).flux;

  const startDistance = Math.max(scenario.poolDiameter, 1);

  if (fluxAt(startDistance) < scenario.thresholdWm2) {
    return { thresholdExceeded: false, maxDistance: 0 };
  }

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
    return { thresholdExceeded: true, maxDistance: maxSearchDistance, reachedSearchLimit: true };
  }

  let low = inside;
  let high = outside;
  for (let i = 0; i < 50 && high - low > 0.1; i++) {
    const mid = (low + high) / 2;
    if (fluxAt(mid) >= scenario.thresholdWm2) low = mid;
    else high = mid;
  }

  return { thresholdExceeded: true, maxDistance: low };
}
