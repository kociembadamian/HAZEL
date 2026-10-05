/**
 * engineJetFire.js
 * ----------------
 * Thermal radiation from a jet fire: a flammable gas or aerosol escaping
 * from a hole or pipe, igniting immediately at the exit.
 *
 * Source: Chamberlain, G.A. (1987), "Development in Design Methods for
 * Predicting Thermal Radiation from Flares", Chem Eng Res Des 65, 299-309
 * (the original source ALOHA's own Tech Doc section 6.4 is itself based
 * on), cross-checked against ALOHA 5.4.4 Technical Documentation (NOAA TM
 * NOS OR&R 43) section 6.4. Every constant is quoted directly from
 * Chamberlain (1987).
 *
 * RESOLVED (2026-09-22): frustum geometry now verified against the
 * original Chamberlain (1987) paper, including Figure 1 and section 4.1.3
 * (frustum lift-off, b) / 4.1.4 (frustum length, R_L) in full, at good
 * scan quality.
 *
 * Figure 1 confirms b is the distance measured ALONG THE HOLE AXIS from
 * the nozzle to point P (the intersection of the hole axis and the
 * frustum/cone axis) — exactly the placement this module already used.
 * The formula for the frustum's own slant length that Chamberlain's paper
 * actually gives (section 4.1.4, p. 303) is
 *
 *     R_L = sqrt(L_B^2 - b^2 * sin^2(alpha)) - b * cos(alpha)
 *
 * i.e. MINUS b^2*sin^2(alpha) under the square root. The ALOHA Tech Doc's
 * transcription of this same formula (section 6.4.2) has a PLUS there
 * instead — an apparent transcription error in the Tech Doc, not a
 * different model. This module previously followed the Tech Doc's (wrong)
 * plus-sign version, carried over with an honestly-documented uncertainty
 * about the frustum's spatial placement; both the sign and the placement
 * question are now resolved by the original paper, and frustumSlantLength()
 * below implements Chamberlain's own minus-sign formula. This also
 * resolves the numerical proof (done independently while investigating
 * this) that no planar two-segment placement (nozzle -> P along the hole
 * axis by b, then P -> tip along the frustum axis by R_L) could ever
 * reproduce a PLUS-sign formula for any b, L_B, alpha — the plus sign in
 * the Tech Doc was never geometrically realisable in the first place,
 * which is why two independent reconstruction attempts against the Tech
 * Doc's version failed.
 *
 * WHAT IS FAITHFULLY REPRODUCED HERE
 * -------------------------------------------------------
 * The compressible-jet mechanics (exit velocity, temperature, Mach number,
 * effective source diameter) and the flame's overall dimensions (length,
 * lift-off, tilt angle, base and tip widths, and the frustum's own slant
 * length R_L) are all implemented exactly as Chamberlain (1987) gives them,
 * cross-checked against Tech Doc 6.4.1-6.4.2, and are unit-tested against
 * hand calculations below.
 *
 * The view factor is computed over an actual tapered, tilted frustum
 * (engineViewFactor.js's tileTiltedFrustum()), at the base width, tip
 * width, slant length, tilt angle, and lift-off placement all now verified
 * directly against Chamberlain's own Figure 1 and section 4.1.3-4.1.4.
 */

import { computeViewFactor, tileTiltedFrustum } from "./engineViewFactor.js";
import { atmosphericTransmissivity, waterVapourPressure } from "./engineBleve.js";

const GRAVITY = 9.80665;
const UNIVERSAL_GAS_CONSTANT = 8.3144; // J/(K*mol) [Tech Doc 6.4.1]

/**
 * Correction factor for the fraction of heat radiated, by molecular weight
 * [Tech Doc 6.4.1, after Cook, Bahrami and Whitehouse 1990].
 */
export function molecularWeightCorrection(molecularWeightKgPerMol) {
  const mw = molecularWeightKgPerMol * 1000; // Tech Doc's cutoffs are in g/mol
  if (mw < 21) return 1;
  if (mw <= 60) return Math.sqrt(mw / 21);
  return 1.69;
}

/**
 * Fraction of heat radiated from the flame surface [Tech Doc 6.4.1, after
 * Chamberlain 1987]:
 *
 *     f_rad = 0.21 * C_MW * exp(-0.00323*u_j) + 0.11
 */
export function radiatedFraction(molecularWeightKgPerMol, jetVelocity) {
  const cMw = molecularWeightCorrection(molecularWeightKgPerMol);
  return 0.21 * cMw * Math.exp(-0.00323 * jetVelocity) + 0.11;
}

/**
 * Mach number of the expanding jet for UNCHOKED flow [Tech Doc 6.4.1]:
 *
 *     Mj = [ ((1+2(g-1)F^2)^(1/2) - 1) / (g-1) ]^(1/2)
 *     F  = 3.6233e-5 * (Q/do^2) * sqrt(Ts / (g*Wgk))
 */
export function unchokedJetMachNumber(massFlowRate, orificeDiameter, specificHeatRatio, sourceTemperature, molecularWeightKgPerMol) {
  const F =
    3.6233e-5 *
    (massFlowRate / (orificeDiameter * orificeDiameter)) *
    Math.sqrt(sourceTemperature / (specificHeatRatio * molecularWeightKgPerMol));
  const inner = (Math.sqrt(1 + 2 * (specificHeatRatio - 1) * F * F) - 1) / (specificHeatRatio - 1);
  return Math.sqrt(Math.max(inner, 0));
}

/**
 * Mach number of the expanding jet for CHOKED flow [Tech Doc 6.4.2]:
 *
 *     Pc = 3.6713 * (Q/do^2) * sqrt(Tc/(g*Wgk)),   Tc = 2*Ts/(1+g)
 *     Mj = sqrt[ ((g+1)*(Pc/Po)^((g-1)/g) - 2) / (g+1) ]
 */
export function chokedJetMachNumber(massFlowRate, orificeDiameter, specificHeatRatio, sourceTemperature, molecularWeightKgPerMol, ambientPressurePa = 101325) {
  const Tc = (2 * sourceTemperature) / (1 + specificHeatRatio);
  const Pc =
    3.6713 *
    (massFlowRate / (orificeDiameter * orificeDiameter)) *
    Math.sqrt(Tc / (specificHeatRatio * molecularWeightKgPerMol));
  const inner =
    ((specificHeatRatio + 1) * Math.pow(Pc / ambientPressurePa, (specificHeatRatio - 1) / specificHeatRatio) - 2) /
    (specificHeatRatio + 1);
  return Math.sqrt(Math.max(inner, 0));
}

/** Jet temperature at the expansion plane [Tech Doc 6.4.1]:
 *     Tj = 2*Ts / (2 + (g-1)*Mj^2) */
export function jetTemperature(sourceTemperature, specificHeatRatio, machNumber) {
  return (2 * sourceTemperature) / (2 + (specificHeatRatio - 1) * machNumber * machNumber);
}

/** Jet exit velocity [Tech Doc 6.4.1]:
 *     uj = Mj * sqrt(g*Rc*Tj/Wgk) */
export function jetVelocity(machNumber, specificHeatRatio, jetTemp, molecularWeightKgPerMol) {
  return machNumber * Math.sqrt((specificHeatRatio * UNIVERSAL_GAS_CONSTANT * jetTemp) / molecularWeightKgPerMol);
}

/**
 * Effective source diameter [Tech Doc 6.4.2] — the throat diameter of an
 * imagined nozzle discharging ambient-density air at the same mass flow
 * rate and exit velocity as the real jet.
 */
export function effectiveSourceDiameter(orificeDiameter, jetDensity, ambientDensity) {
  return orificeDiameter * Math.sqrt(jetDensity / ambientDensity);
}

/**
 * Flame length in a crosswind [Chamberlain 1987 section 4.1.1, after
 * Kalghatgi 1983]:
 *
 *     LB = 105.4 * Ds * [1 - 6.07e-3*(thetaJ - 90)]
 *
 * thetaJ is the angle between the jet axis and the wind, in degrees
 * (90 = jet perpendicular to the wind; this project always uses a vertical
 * jet, so thetaJ = 90 throughout, per Tech Doc 6.4's own scope: "an upward
 * vertical jet release").
 */
export function flameLength(effectiveDiameter, jetAngleDegrees = 90) {
  return 105.4 * effectiveDiameter * (1 - 6.07e-3 * (jetAngleDegrees - 90));
}

/** Velocity ratio, wind to jet [Chamberlain 1987 section 4.1.2]: R = V/uj. */
export function velocityRatio(windSpeed, jetVel) {
  return windSpeed / jetVel;
}

/** Non-dimensional buoyancy parameter [Chamberlain 1987]: xi(L) = L*(g/(Ds^2*uj^2))^(1/3). */
function xiOf(length, effectiveDiameter, jetVel) {
  return length * Math.cbrt(GRAVITY / (effectiveDiameter * effectiveDiameter * jetVel * jetVel));
}

/** Flame tilt angle from the jet axis [Chamberlain 1987 section 4.1.2,
 *  piecewise in R]. Returns DEGREES, matching the natural units of theta_j
 *  in the source formula (theta_j - 90) — converted to radians by
 *  jetFireGeometry() before being used in any trigonometric calculation. */
export function jetFlameTiltDegrees(R, stillAirFlameLen, effectiveDiameter, jetVel, jetAngleDegrees = 90) {
  const xi = xiOf(stillAirFlameLen, effectiveDiameter, jetVel);
  const angleTerm = jetAngleDegrees - 90;
  if (R <= 0.05) {
    return (8000 * R + xi * angleTerm * (1 - Math.exp(-25.6 * R))) / xi;
  }
  return (1726 * Math.sqrt(Math.max(R - 0.026, 0)) + 134 * xi * angleTerm * (1 - Math.exp(-25.6 * R))) / xi;
}

/** Still-air flame length [Chamberlain 1987 section 4.1.1]. */
export function stillAirFlameLength(flameLen, windSpeed, jetAngleDegrees = 90) {
  return flameLen / ((0.51 * Math.exp(-0.4 * windSpeed) + 0.49) * (1 - 6.07e-3 * (jetAngleDegrees - 90)));
}

/**
 * Lift-off distance, b, measured ALONG THE HOLE AXIS from the nozzle to
 * point P, the intersection of the hole axis and the frustum (cone) axis
 * [Chamberlain 1987 section 4.1.3, confirmed by Figure 1]:
 *
 *     b = LB * sin(K*alpha) / sin(alpha),   K = 0.185*exp(-20R) + 0.015
 *
 * (Chamberlain writes this as b = LB*sin(alpha-alpha_b)/sin(alpha) with
 * K = (alpha-alpha_b)/alpha; the two forms are identical.) At alpha=0 this
 * reduces to b = K*LB (sin(x)/x -> 1), matching the paper's stated limit.
 */
export function flameLiftOff(R, flameLen, tiltAngleRad, isAerosol) {
  if (isAerosol) return 0.015 * flameLen;
  const K = 0.185 * Math.exp(-20 * R) + 0.015;
  if (tiltAngleRad === 0) return K * flameLen; // sin(x)/x -> 1 as x -> 0
  return (flameLen * Math.sin(K * tiltAngleRad)) / Math.sin(tiltAngleRad);
}

/**
 * Frustum slant length [Chamberlain 1987 section 4.1.4, p. 303 — verified
 * against the original paper, which has a MINUS sign under the square
 * root; the ALOHA Tech Doc's transcription of this formula has a plus
 * sign there, which is a transcription error in the Tech Doc, not an
 * alternative model]:
 *
 *     R_L = sqrt(LB^2 - b^2 * sin^2(alpha)) - b * cos(alpha)
 */
export function frustumSlantLength(flameLen, liftOff, tiltAngleRad) {
  return (
    Math.sqrt(flameLen * flameLen - liftOff * liftOff * Math.sin(tiltAngleRad) * Math.sin(tiltAngleRad)) -
    liftOff * Math.cos(tiltAngleRad)
  );
}

/**
 * Frustum base width [Chamberlain 1987 section 4.1.5, p. 303 — the Tech
 * Doc notes a discrepancy between Chamberlain's paper and Lees' (2001)
 * transcription of it, and states ALOHA uses Chamberlain's own version,
 * which is what is implemented here].
 */
export function frustumBaseWidth(R, effectiveDiameter, jetVel, jetDensity, ambientDensity) {
  const C = 1000 * Math.exp(-100 * R) + 0.8;
  // xi(Ds) = [g/(Ds^2 * uj^2)]^(1/3) * Ds [Chamberlain 1987]
  const xiDs = Math.cbrt(GRAVITY / (effectiveDiameter * effectiveDiameter * jetVel * jetVel)) * effectiveDiameter;
  return (
    effectiveDiameter *
    (13.5 * Math.exp(-6 * R) + 1.5) *
    (1 - (1 - Math.sqrt(ambientDensity / jetDensity) / 15) * Math.exp(-70 * Math.pow(xiDs, C)))
  );
}

/** Frustum tip width [Chamberlain 1987 section 4.1.6, p. 304]. */
export function frustumTipWidth(R, flameLen) {
  return flameLen * (0.18 * Math.exp(-1.5 * R) + 0.31) * (1 - 0.47 * Math.exp(-25 * R));
}

/**
 * Full jet fire flame geometry, given the jet's own exit conditions.
 *
 * @param {object} params
 * @param {number} params.massFlowRate - kg/s
 * @param {number} params.orificeDiameter - m
 * @param {number} params.specificHeatRatio - dimensionless (gamma)
 * @param {number} params.sourceTemperature - K, inside the vessel or pipe
 * @param {number} params.molecularWeightKgPerMol - kg/mol
 * @param {number} params.jetDensity - kg/m^3, at the expansion plane
 * @param {number} params.ambientDensity - kg/m^3
 * @param {number} params.windSpeed - m/s
 * @param {boolean} [params.choked]
 * @param {boolean} [params.isAerosol]
 * @returns {object} every intermediate quantity, for use by jetFireRadiationAt()
 */
export function jetFireGeometry(params) {
  const {
    massFlowRate, orificeDiameter, specificHeatRatio, sourceTemperature,
    molecularWeightKgPerMol, jetDensity, ambientDensity, windSpeed,
    choked = false, isAerosol = false,
  } = params;

  const machNumber = choked
    ? chokedJetMachNumber(massFlowRate, orificeDiameter, specificHeatRatio, sourceTemperature, molecularWeightKgPerMol)
    : unchokedJetMachNumber(massFlowRate, orificeDiameter, specificHeatRatio, sourceTemperature, molecularWeightKgPerMol);

  const tempAtExit = jetTemperature(sourceTemperature, specificHeatRatio, machNumber);
  const velocity = jetVelocity(machNumber, specificHeatRatio, tempAtExit, molecularWeightKgPerMol);
  const effDiameter = effectiveSourceDiameter(orificeDiameter, jetDensity, ambientDensity);

  const flameLen = flameLength(effDiameter);
  const stillAirLen = stillAirFlameLength(flameLen, windSpeed);
  const R = velocityRatio(windSpeed, velocity);
  const tiltAngleDegrees = jetFlameTiltDegrees(R, stillAirLen, effDiameter, velocity);
  const tiltAngle = (tiltAngleDegrees * Math.PI) / 180;
  const liftOff = flameLiftOff(R, flameLen, tiltAngle, isAerosol);
  const slantLength = frustumSlantLength(flameLen, liftOff, tiltAngle);
  const baseWidth = frustumBaseWidth(R, effDiameter, velocity, jetDensity, ambientDensity);
  const tipWidth = frustumTipWidth(R, flameLen);

  return {
    machNumber, tempAtExit, velocity, effDiameter, flameLen, stillAirLen,
    R, tiltAngle, tiltAngleDegrees, liftOff, slantLength, baseWidth, tipWidth,
  };
}

/**
 * Thermal radiation flux incident at a point from a jet fire.
 *
 * @param {object} params - jetFireGeometry() params, plus:
 * @param {[number,number,number]} params.receptorPoint - m
 * @param {number} params.heatOfCombustion - J/kg
 * @param {number} params.relativeHumidity - percent
 * @param {number} params.ambientTemperature - K
 * @returns {{ flux: number, geometry: object, viewFactor: number }}
 */
export function jetFireRadiationAt(params) {
  const geometry = jetFireGeometry(params);
  const { slantLength, baseWidth, tipWidth, tiltAngle, liftOff, velocity } = geometry;

  const fRad = radiatedFraction(params.molecularWeightKgPerMol, velocity);
  const area =
    (Math.PI / 4) * (baseWidth * baseWidth + tipWidth * tipWidth) +
    (Math.PI / 2) * (baseWidth + tipWidth) * Math.sqrt(slantLength * slantLength + Math.pow((tipWidth - baseWidth) / 2, 2));
  const emissivePower = (fRad * params.massFlowRate * params.heatOfCombustion) / area;

  // Tapered, tilted frustum at the correct dimensions and placement
  // (see module docstring — verified directly against Chamberlain 1987
  // Figure 1 and sections 4.1.3-4.1.4).
  const tiles = tileTiltedFrustum(baseWidth, tipWidth, slantLength, liftOff, tiltAngle);
  const { viewFactor } = computeViewFactor(tiles, params.receptorPoint);

  const distance = Math.hypot(...params.receptorPoint);
  const pWater = waterVapourPressure(params.relativeHumidity, params.ambientTemperature);
  const tau = atmosphericTransmissivity(pWater, distance);

  return { flux: emissivePower * viewFactor * tau, geometry, viewFactor };
}

/**
 * Finds the downwind ground distance at which incident thermal radiation
 * from a jet fire drops to a given Level of Concern. Same downwind-axis
 * convention as findPoolFireRadiationDistance() in enginePoolFire.js.
 *
 * @param {object} scenario - jetFireRadiationAt() params, minus receptorPoint
 * @param {number} scenario.thresholdWm2 - W/m^2
 * @param {number} [maxSearchDistance] - m
 * @returns {{ thresholdExceeded: boolean, maxDistance: number }}
 */
export function findJetFireRadiationDistance(scenario, maxSearchDistance = 2000) {
  const fluxAt = (d) => jetFireRadiationAt({ ...scenario, receptorPoint: [d, 0, 0] }).flux;

  if (fluxAt(1) < scenario.thresholdWm2) {
    return { thresholdExceeded: false, maxDistance: 0 };
  }

  let inside = 1;
  let outside = 0;
  let probe = 1;
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
