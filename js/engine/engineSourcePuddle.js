/**
 * engineSourcePuddle.js
 * ---------------------
 * Evaporation from a liquid puddle — the source term for every spill that
 * does not flash on release.
 *
 * Two coupled problems are solved together, because neither can be answered
 * alone: how fast the liquid evaporates depends on how warm it is, and how
 * warm it is depends on how fast it is evaporating (evaporation cools the
 * pool). The module therefore steps forward in time, recomputing both.
 *
 * Models implemented, following the ALOHA Technical Documentation
 * (NOAA TM NOS OR&R 43) sections 3.3.1 to 3.3.3:
 *
 *   Non-boiling evaporation   Brighton (1985), a boundary-layer model in
 *                             which vapour diffuses from a saturated layer
 *                             at the liquid surface into the turbulent
 *                             airstream above.
 *   Boiling evaporation       Steady state at the boiling point, with the
 *                             evaporation rate set by whatever balances the
 *                             heat fluxes into the pool.
 *   Energy balance            Six fluxes: solar, longwave down, longwave up,
 *                             conduction to the substrate, sensible heat from
 *                             the air, and evaporative cooling.
 *
 * Known simplification against ALOHA
 * -----------------------------------
 * ALOHA solves ground conduction with a forward-stepping finite difference
 * scheme over a slab of soil. This module uses the analytical error-function
 * solution for a semi-infinite solid instead — the same solution the Tech Doc
 * names as exact for a constant puddle temperature. Because the puddle
 * temperature does vary here, this is an approximation, and it is recorded in
 * engineLimitations.js rather than left implicit. It is most accurate where
 * it matters most: in the first minutes after a spill, when the temperature
 * difference driving conduction is largest and the release rate is highest.
 *
 * BOILING/NON-BOILING SWITCH — FIXED 2026-09-26
 * ------------------------------------------------
 * Reported by audit (the 2026-09-26 duration review,
 * finding #2), not by a user: a puddle of a liquefied gas at (or above) its
 * own boiling point — chlorine, propane, ammonia, anything routed here at
 * ambient temperature rather than flashing on release — produced NaN or
 * Infinity for its evaporation rate, corrupting everything downstream.
 *
 * The cause was in evaporationAtInstant() below. volatilityCorrection()
 * deliberately returns Infinity once vapour pressure reaches ambient
 * pressure — an explicit signal, stated in its own docstring, for the
 * caller to switch to the boiling model. But the switch condition compared
 * the two candidate fluxes directly: `boiling = atBoilingLimit &&
 * boilingFlux > nonBoilingFlux`. Once nonBoilingFlux was itself built from
 * that Infinity (saturation * uStar * Infinity), no finite boilingFlux could
 * ever compare greater than it, so the switch never fired and the Infinite
 * value was used as the actual flux instead of being replaced.
 *
 * The fix treats a non-finite nonBoilingFlux as its own unconditional
 * trigger to use the boiling branch — the only branch that produces a
 * meaningful answer once the non-boiling model has broken down this way —
 * rather than trying to compare against a value that is no longer a real
 * number.
 *
 * PUDDLE FED BY A LEAKING TANK — ADDED 2026-10-01
 * ------------------------------------------------
 * simulateSpreadingPuddle() at the end of this file: the puddle a tank of
 * non-boiling liquid forms as it drains (Tech Doc 3.4.4.2-3.4.4.3) —
 * Briscoe-Shaw spreading up to a maximum area or 5 mm depth, ground heat
 * summed over rings of different contact age, and the heat carried in by
 * liquid still arriving. Evaporation itself is evaporationAtInstant(),
 * shared with the stand-alone puddle. Before this the Source step passed the
 * tank's drain rate to the dispersion model as if it were airborne.
 */

import { UNIVERSAL_GAS_CONSTANT, STANDARD_PRESSURE } from "./engineConstants.js";

/* ========================================================================
   CONSTANTS
   ======================================================================== */

/** Von Karman constant. */
const VON_KARMAN = 0.4;

/**
 * Turbulent Schmidt number, fixed at 0.85 after measurements by Fackrell and
 * Robins (1982) — the value the Tech Doc specifies.
 */
const TURBULENT_SCHMIDT = 0.85;

/** Euler's constant, as used in Brighton's mass transfer expression. */
const EULER_GAMMA = 0.577;

/** Molecular diffusivity of water vapour in air, m^2/s (Tech Doc 3.3.1). */
const WATER_VAPOUR_DIFFUSIVITY = 2.39e-5;

/** Molecular weight of water, g/mol — the reference for Graham's law. */
const MOLECULAR_WEIGHT_OF_WATER = 18.015;

/** Kinematic viscosity of air at roughly 20 C, m^2/s. */
const AIR_KINEMATIC_VISCOSITY = 1.5e-5;

/** Thermal diffusivity of air at roughly 20 C, m^2/s. Used for sensible heat. */
const AIR_THERMAL_DIFFUSIVITY = 2.0e-5;

/** Density of air at roughly 20 C and 1 atm, kg/m^3. */
const AIR_DENSITY = 1.2;

/** Heat capacity of air, J/(kg*K). The Tech Doc treats this as constant. */
const AIR_HEAT_CAPACITY = 1004;

/** Emissivity of the puddle surface, taken as that of water (Tech Doc 3.3.3.2). */
const PUDDLE_EMISSIVITY = 0.97;

/** Reflectivity of the surface to longwave radiation, as water (Tech Doc 3.3.3.2). */
const LONGWAVE_REFLECTIVITY = 0.03;

/** Stefan-Boltzmann constant, W/(m^2*K^4). */
const STEFAN_BOLTZMANN = 5.67e-8;

/**
 * Thermal properties of substrates, from Tech Doc Table 9 (Briscoe and Shaw
 * 1980). Note these already include the correction factor the Tech Doc
 * describes: comparison with experiment showed the effective conductivity of
 * soil behaves as roughly nine times the measured value, and Table 9 is
 * published with that correction applied.
 */
export const SUBSTRATE_PROPERTIES = {
  defaultSoil: { label: "Default soil", conductivity: 8.64, diffusivity: 4.13e-6 },
  concrete: { label: "Concrete", conductivity: 8.28, diffusivity: 3.74e-6 },
  drySandySoil: { label: "Dry sandy soil", conductivity: 2.34, diffusivity: 1.74e-6 },
  moistSandySoil: { label: "Moist sandy soil", conductivity: 5.31, diffusivity: 3.02e-6 },
};

/**
 * Atmospheric radiation factor coefficients as a function of cloudiness,
 * from Tech Doc Table 8. Indexed by cloud cover in tenths (0 to 10), which is
 * the scale the Tech Doc uses for the cloudiness index — note this differs
 * from the oktas (eighths) used by the stability classification, so callers
 * must convert.
 */
const RADIATION_FACTOR_COEFFICIENTS = [
  { a: 0.740, b: 44.3e-6 },
  { a: 0.750, b: 44.3e-6 },
  { a: 0.760, b: 44.3e-6 },
  { a: 0.770, b: 44.2e-6 },
  { a: 0.783, b: 40.7e-6 },
  { a: 0.793, b: 40.5e-6 },
  { a: 0.800, b: 39.9e-6 },
  { a: 0.810, b: 38.4e-6 },
  { a: 0.820, b: 35.4e-6 },
  { a: 0.840, b: 31.0e-6 },
  { a: 0.870, b: 26.6e-6 },
];

/* ========================================================================
   MASS TRANSFER (Brighton 1985)
   ======================================================================== */

/**
 * Molecular diffusivity of the chemical's vapour in air, estimated by
 * Graham's law from that of water vapour (Tech Doc 3.3.1, after Thibodeaux
 * 1979):
 *
 *     kappa_c = kappa_w * sqrt(M_w / M_c)
 *
 * Measured diffusivities exist for very few chemicals, which is why an
 * estimate is used. A heavier molecule diffuses more slowly, hence the
 * inverse square root of molecular weight.
 *
 * @param {number} molecularWeight - g/mol
 * @returns {number} diffusivity, m^2/s
 */
export function molecularDiffusivity(molecularWeight) {
  return WATER_VAPOUR_DIFFUSIVITY * Math.sqrt(MOLECULAR_WEIGHT_OF_WATER / molecularWeight);
}

/**
 * Laminar Schmidt number: the ratio of the kinematic viscosity of air to the
 * molecular diffusivity of the contaminant, Sc = nu / kappa (Tech Doc 3.3.1).
 *
 * FIXED 2026-10-01: this returned the inverse, kappa / nu. That made the
 * evaporation rate depend on molecular weight the wrong way round (methanol,
 * the lightest substance compared, came out furthest below ALOHA). See
 * PUDDLE_ROUGHNESS_LENGTH below for the comparison that settled it.
 */
export function schmidtNumber(molecularWeight) {
  return AIR_KINEMATIC_VISCOSITY / molecularDiffusivity(molecularWeight);
}

/**
 * Friction velocity above the puddle, from Deacon (1973) for neutral
 * conditions (Tech Doc 3.3.1):
 *
 *     U* = 0.03 * U * (10 / z)^n
 *
 * Note this is a different formulation from the logarithmic one used in
 * engineDispersionChoice.js. Both appear in ALOHA, in different places, and
 * this module follows the Tech Doc's choice for the puddle model so that
 * results remain comparable with ALOHA's.
 *
 * @param {number} windSpeed - m/s at measurement height
 * @param {number} measurementHeight - m
 * @param {number} powerLawExponent - n, from the stability class
 */
export function puddleFrictionVelocity(windSpeed, measurementHeight, powerLawExponent) {
  return 0.03 * windSpeed * Math.pow(10 / measurementHeight, powerLawExponent);
}

/**
 * Roughness Reynolds number: Re0 = U* * z0 / nu (Tech Doc 3.3.1).
 * Distinguishes aerodynamically smooth flow from rough.
 */
export function roughnessReynoldsNumber(frictionVelocity, roughnessLength) {
  return (frictionVelocity * roughnessLength) / AIR_KINEMATIC_VISCOSITY;
}

/**
 * The function f(Sc) appearing in Brighton's expression, whose form depends on
 * whether the surface is aerodynamically smooth or rough (Tech Doc 3.3.1):
 *
 *   smooth (Re0 < 0.13):  (3.85 * Sc^(1/3) - 1.3)^2 + (Sc_T / k) * ln(0.13 * Sc)
 *   rough  (Re0 > 2):     7.3 * Re0^(1/4) * sqrt(Sc) - 5 * Sc_T
 *
 * Between those two limits ALOHA interpolates linearly, which is reproduced
 * here — without it the transition would be discontinuous and the evaporation
 * rate would jump for no physical reason as wind speed or roughness changed.
 */
export function fSc(schmidt, roughnessReynolds) {
  const smooth = () =>
    Math.pow(3.85 * Math.cbrt(schmidt) - 1.3, 2) +
    (TURBULENT_SCHMIDT / VON_KARMAN) * Math.log(0.13 * schmidt);

  const rough = (re0) =>
    7.3 * Math.pow(re0, 0.25) * Math.sqrt(schmidt) - 5 * TURBULENT_SCHMIDT;

  if (roughnessReynolds < 0.13) return smooth();
  if (roughnessReynolds > 2) return rough(roughnessReynolds);

  // Linear interpolation across the transition band
  const fractionOfBand = (roughnessReynolds - 0.13) / (2 - 0.13);
  return smooth() + fractionOfBand * (rough(2) - smooth());
}

/**
 * Lambda, Brutsaert's (1982) measure of the ratio between the scalar
 * roughness length of the puddle and the momentum roughness length of the
 * surrounding terrain (Tech Doc 3.3.1):
 *
 *     Lambda = 1/n + 1 + 2*ln(1+n) - 2*gamma_e + (k/Sc_T)*(1+n)*f(Sc)
 */
export function lambdaParameter(powerLawExponent, schmidt, roughnessReynolds) {
  const n = powerLawExponent;
  return (
    1 / n +
    1 +
    2 * Math.log(1 + n) -
    2 * EULER_GAMMA +
    (VON_KARMAN / TURBULENT_SCHMIDT) * (1 + n) * fSc(schmidt, roughnessReynolds)
  );
}

/**
 * Dimensionless downwind distance evaluated at the trailing edge of the
 * puddle (Tech Doc 3.3.1):
 *
 *     X1 = n * k^2 * D_p / (Sc_T * z0 * e^(1/n))
 */
export function dimensionlessDistance(powerLawExponent, puddleDiameter, roughnessLength) {
  const n = powerLawExponent;
  return (
    (n * VON_KARMAN * VON_KARMAN * puddleDiameter) /
    (TURBULENT_SCHMIDT * roughnessLength * Math.exp(1 / n))
  );
}

/**
 * The spatially averaged dimensionless mass transfer coefficient, j-bar.
 *
 * This is the central result of Brighton's analysis: it collapses the whole
 * boundary-layer problem into one number relating the evaporative flux to the
 * friction velocity and the saturation concentration. The expression is
 * reproduced from Tech Doc section 3.3.1 term by term; the grouping below
 * follows the printed equation's structure so it can be checked against the
 * source line by line.
 *
 * @returns {number} dimensionless
 */
export function averageMassTransferCoefficient({
  powerLawExponent,
  puddleDiameter,
  roughnessLength,
  molecularWeight,
  frictionVelocity,
}) {
  const n = powerLawExponent;
  const schmidt = schmidtNumber(molecularWeight);
  const re0 = roughnessReynoldsNumber(frictionVelocity, roughnessLength);

  const lambda = lambdaParameter(n, schmidt, re0);
  const x1 = dimensionlessDistance(n, puddleDiameter, roughnessLength);

  // The quantity e^Lambda * X1 appears throughout; compute it once.
  const expLambdaX1 = Math.exp(lambda) * x1;
  const lnTerm = Math.log(expLambdaX1);
  const lnSquaredPlusPiSquared = lnTerm * lnTerm + Math.PI * Math.PI;

  const firstTerm = 0.5 - (1 / Math.PI) * Math.atan(lnTerm / Math.PI);
  const secondTerm = (1 - EULER_GAMMA) / lnSquaredPlusPiSquared;
  const thirdTerm =
    ((Math.pow(1 - EULER_GAMMA, 2) + 1 + (Math.PI * Math.PI) / 6) * lnTerm) /
    (lnSquaredPlusPiSquared * lnSquaredPlusPiSquared);

  return (VON_KARMAN / TURBULENT_SCHMIDT) * (1 + n) * (firstTerm + secondTerm + thirdTerm);
}

/**
 * Correction to the mass transfer coefficient for highly volatile liquids
 * (Tech Doc 3.3.1):
 *
 *     j_c = -j * (P_a / P_v) * ln(1 - P_v / P_a)
 *
 * As the liquid's vapour pressure approaches ambient pressure the escaping
 * vapour itself disturbs the boundary layer, and the uncorrected coefficient
 * would understate the flux. As P_v tends to zero the correction tends to 1,
 * leaving the uncorrected value — a useful check on the implementation.
 *
 * The Tech Doc notes ALOHA switches to the boiling model once this correction
 * factor reaches 4, which is the upper limit of Brighton's model; that
 * threshold is applied by the caller.
 */
export function volatilityCorrection(massTransferCoefficient, vapourPressure, ambientPressure) {
  if (vapourPressure <= 0) return massTransferCoefficient;
  if (vapourPressure >= ambientPressure) return Infinity; // boiling; caller switches model

  return (
    -massTransferCoefficient *
    (ambientPressure / vapourPressure) *
    Math.log(1 - vapourPressure / ambientPressure)
  );
}

/**
 * Saturation concentration of the vapour immediately above the liquid
 * surface: the mass of vapour per unit volume in air that is in equilibrium
 * with the liquid, from the ideal gas law.
 *
 *     C_s = P_v * M / (R * T)
 *
 * @param {number} vapourPressure - Pa
 * @param {number} molecularWeight - g/mol
 * @param {number} temperature - K, the puddle surface temperature
 * @returns {number} kg/m^3
 */
export function saturationConcentration(vapourPressure, molecularWeight, temperature) {
  return (vapourPressure * (molecularWeight / 1000)) / (UNIVERSAL_GAS_CONSTANT * temperature);
}

/**
 * Ratio of the normal boiling point to the critical temperature, Tb/Tc,
 * from Guldberg's rule (Guldberg 1890): about 2/3 for most organic liquids.
 * Used only to estimate how the heat of vaporisation grows below the
 * boiling point (see vapourPressureAt()), where the critical temperature is
 * not otherwise known.
 */
const GULDBERG_RATIO = 2 / 3;

/** Watson's exponent for the temperature dependence of the heat of vaporisation (Watson 1943). */
const WATSON_EXPONENT = 0.38;

/**
 * Vapour pressure of the liquid at a given temperature, from the
 * Clausius-Clapeyron relation anchored at the normal boiling point:
 *
 *     d ln P / dT = L(T) / (R T^2),   P(T_boil) = 1 atm
 *
 * ABOVE the boiling point (a liquefied gas in a tank, a boiling puddle) the
 * heat of vaporisation is held at its boiling-point value, the classic
 * two-point form
 *
 *     P(T) = P_atm * exp( -(L/R) * (1/T - 1/T_boil) )
 *
 * which reproduces ALOHA's chlorine tank release rates to 1-3%.
 *
 * BELOW the boiling point (CHANGED 2026-10-01) the heat of vaporisation is
 * allowed to grow as the liquid gets colder, by Watson's correlation
 *
 *     L(T) = L_b * ((T_c - T) / (T_c - T_b))^0.38
 *
 * with the critical temperature from Guldberg's rule (T_c = 1.5 T_b) unless
 * one is supplied, and the relation integrated numerically. Holding L at
 * its boiling-point value all the way down to ambient over-predicted the
 * vapour pressure, and so the evaporation rate, by 10-60% against ALOHA
 * (toluene at 5 C: 1.61x; methanol at 15 C: 1.19x). With Watson's L(T) the
 * same comparisons — methanol 5-35 C, benzene 15-30 C, toluene 5-30 C,
 * acetone 5-15 C — fall within about 10%, mostly within 5%.
 *
 * The heat of vaporisation passed in must be the value AT THE BOILING POINT
 * (the Source step's help text says so).
 *
 * @param {number} temperature - K
 * @param {number} boilingPoint - K at 1 atm
 * @param {number} heatOfVaporization - J/mol, at the boiling point
 * @param {number} [criticalTemperature] - K; estimated from the boiling point if omitted
 * @returns {number} vapour pressure, Pa
 */
export function vapourPressureAt(temperature, boilingPoint, heatOfVaporization, criticalTemperature = null) {
  if (temperature >= boilingPoint) {
    const exponent =
      -(heatOfVaporization / UNIVERSAL_GAS_CONSTANT) * (1 / temperature - 1 / boilingPoint);
    return STANDARD_PRESSURE * Math.exp(exponent);
  }

  const Tc = Number.isFinite(criticalTemperature) && criticalTemperature > boilingPoint
    ? criticalTemperature
    : boilingPoint / GULDBERG_RATIO;

  // ln(P/P_atm) = -integral from T to T_b of L(t) / (R t^2) dt, by Simpson's
  // rule (the integrand is smooth; 32 intervals is far more than enough).
  const intervals = 32;
  const h = (boilingPoint - temperature) / intervals;
  const integrand = (t) =>
    (heatOfVaporization * Math.pow((Tc - t) / (Tc - boilingPoint), WATSON_EXPONENT)) /
    (UNIVERSAL_GAS_CONSTANT * t * t);
  let sum = integrand(temperature) + integrand(boilingPoint);
  for (let i = 1; i < intervals; i++) {
    sum += (i % 2 === 1 ? 4 : 2) * integrand(temperature + i * h);
  }
  return STANDARD_PRESSURE * Math.exp(-(h / 3) * sum);
}

/* ========================================================================
   ENERGY BALANCE (Tech Doc 3.3.3)
   ======================================================================== */

/**
 * Net shortwave solar flux reaching the puddle, after Raphael (1962)
 * (Tech Doc 3.3.3.1):
 *
 *     F_s = 1111 * (1 - 0.0071 * C_I^2) * (sin(phi_S) - 0.1)   when sin(phi_S) > 0.1
 *     F_s = 0                                                   otherwise
 *
 * The formula already includes a correction for the fraction of sunlight
 * reflected back to the atmosphere, using an average value for the Earth's
 * albedo. The cutoff at sin(phi_S) = 0.1 corresponds to a solar elevation of
 * about 5.7 degrees: below that the sun contributes essentially nothing.
 *
 * @param {number} solarElevationDegrees - from solarPosition.js
 * @param {number} cloudinessIndex - 0 to 10 (tenths, not oktas)
 * @returns {number} W/m^2
 */
export function solarFlux(solarElevationDegrees, cloudinessIndex) {
  const sinElevation = Math.sin((solarElevationDegrees * Math.PI) / 180);
  if (sinElevation <= 0.1) return 0;
  return 1111 * (1 - 0.0071 * cloudinessIndex * cloudinessIndex) * (sinElevation - 0.1);
}

/**
 * Longwave radiation emitted upward by the puddle, from the Stefan-Boltzmann
 * law (Tech Doc 3.3.3.2). Negative, because the puddle loses this energy.
 *
 *     F_up = -epsilon * sigma * T_p^4
 */
export function longwaveUpFlux(puddleTemperature) {
  return -PUDDLE_EMISSIVITY * STEFAN_BOLTZMANN * Math.pow(puddleTemperature, 4);
}

/**
 * Longwave radiation received from the atmosphere, after Thibodeaux (1979)
 * (Tech Doc 3.3.3.2):
 *
 *     F_down = (1 - r) * B * sigma * T_a^4,   B = a + b * e_w
 *
 * where e_w is the partial pressure of water vapour in the air and the
 * coefficients a and b come from Table 8, indexed by cloud cover. A humid,
 * overcast sky radiates far more energy downward than a dry clear one, which
 * is why both humidity and cloud enter here.
 *
 * @param {number} airTemperature - K
 * @param {number} waterVapourPartialPressure - Pa
 * @param {number} cloudinessIndex - 0 to 10 (tenths)
 * @returns {number} W/m^2
 */
export function longwaveDownFlux(airTemperature, waterVapourPartialPressure, cloudinessIndex) {
  const index = Math.max(0, Math.min(10, Math.round(cloudinessIndex)));
  const { a, b } = RADIATION_FACTOR_COEFFICIENTS[index];
  const B = a + b * waterVapourPartialPressure;
  return (1 - LONGWAVE_REFLECTIVITY) * B * STEFAN_BOLTZMANN * Math.pow(airTemperature, 4);
}

/**
 * Partial pressure of water vapour in the air, from relative humidity and the
 * saturation vapour pressure of water (Magnus formula).
 *
 * Needed only as an input to the longwave flux above, which is why it lives
 * here rather than in a general-purpose module.
 *
 * @param {number} airTemperature - K
 * @param {number} relativeHumidity - percent
 * @returns {number} Pa
 */
export function waterVapourPartialPressure(airTemperature, relativeHumidity) {
  const tCelsius = airTemperature - 273.15;
  // Magnus formula for saturation vapour pressure over water, in Pa
  const saturation = 610.94 * Math.exp((17.625 * tCelsius) / (tCelsius + 243.04));
  return saturation * (relativeHumidity / 100);
}

/**
 * Heat conducted between the puddle and the ground beneath it.
 *
 * ALOHA solves the time-dependent heat equation numerically over a soil slab.
 * This uses the analytical solution for a semi-infinite solid subjected to a
 * step change in surface temperature, which the Tech Doc identifies as exact
 * for a constant puddle temperature:
 *
 *     F_G = k_G * (T_ground - T_puddle) / sqrt(pi * kappa_G * t)
 *
 * The 1/sqrt(t) dependence captures the important behaviour: conduction is
 * intense in the first moments after a cold liquid touches warm ground, then
 * falls away as the ground immediately beneath the pool cools toward the
 * pool's own temperature. For a volatile spill this early period is also when
 * most of the material evaporates, so the approximation is at its best where
 * it matters most.
 *
 * @param {number} groundTemperature - K
 * @param {number} puddleTemperature - K
 * @param {number} elapsedSeconds - since the spill began
 * @param {object} substrate - an entry from SUBSTRATE_PROPERTIES
 * @returns {number} W/m^2, positive when the ground warms the puddle
 */
export function groundHeatFlux(groundTemperature, puddleTemperature, elapsedSeconds, substrate) {
  // Guard the singularity at t = 0. One second is well below the time step
  // used by the integrator, so this does not distort the result.
  const t = Math.max(elapsedSeconds, 1);
  return (
    (substrate.conductivity * (groundTemperature - puddleTemperature)) /
    Math.sqrt(Math.PI * substrate.diffusivity * t)
  );
}

/**
 * Sensible heat conducted from the air to the puddle (Tech Doc 3.3.3.5,
 * after Brighton 1985, 1990):
 *
 *     F_H = rho_a * c_p,a * C_H * U* * (T_a - T_p)
 *
 * with the sensible heat transfer coefficient
 *
 *     C_H = j_c * (thermal diffusivity / molecular diffusivity)^(2/3)
 *
 * The same boundary layer carries both vapour away and heat toward the pool,
 * which is why the mass transfer coefficient reappears here.
 *
 * @returns {number} W/m^2, positive when the air warms the puddle
 */
export function sensibleHeatFlux({
  airTemperature,
  puddleTemperature,
  frictionVelocity,
  correctedMassTransferCoefficient,
  molecularWeight,
}) {
  const diffusivityRatio = AIR_THERMAL_DIFFUSIVITY / molecularDiffusivity(molecularWeight);
  const heatTransferCoefficient =
    correctedMassTransferCoefficient * Math.pow(diffusivityRatio, 2 / 3);

  return (
    AIR_DENSITY *
    AIR_HEAT_CAPACITY *
    heatTransferCoefficient *
    frictionVelocity *
    (airTemperature - puddleTemperature)
  );
}

/**
 * Heat removed from the puddle by evaporation (Tech Doc 3.3.3.4):
 *
 *     F_E = -L_c * E
 *
 * Negative because evaporation always cools the liquid left behind. This is
 * the feedback that makes the problem coupled: a faster evaporation rate
 * cools the pool, which lowers its vapour pressure, which slows evaporation.
 *
 * @param {number} evaporationFlux - kg/(m^2*s)
 * @param {number} latentHeat - J/kg
 * @returns {number} W/m^2, always negative or zero
 */
export function evaporativeHeatFlux(evaporationFlux, latentHeat) {
  return -latentHeat * evaporationFlux;
}

/* ========================================================================
   TIME INTEGRATION
   ======================================================================== */

/**
 * Upper limit on the volatility correction factor. The Tech Doc states that
 * ALOHA defines the upper temperature limit of Brighton's non-boiling model
 * as the point where this correction reaches 4; beyond that the boiling model
 * takes over.
 */
const BRIGHTON_CORRECTION_LIMIT = 4;

/**
 * Roughness length used in the evaporation (mass transfer) calculation, m.
 * ADDED 2026-10-01.
 *
 * Brighton's mass transfer coefficient is written in terms of a surface
 * roughness z0, and HAZEL used the terrain roughness the user chose for the
 * dispersion (0.03 m open country, 1 m urban). Side-by-side ALOHA runs show
 * that ALOHA's puddle evaporation does NOT depend on the terrain setting:
 * acetone, 10 m2, typical night — 2.58 kg/min with open country AND with
 * urban/forest; worst-case night, 0.613 kg/min urban (stand-alone puddle)
 * against 0.601 kg/min open country (tank-fed puddle). The airflow that
 * matters for evaporation is the one over the liquid surface and the paved
 * ground around it, not the town or forest that sets the dispersion.
 *
 * With the Tech Doc's own Schmidt number (see schmidtNumber()), one fixed
 * value of z0 then reproduces ALOHA in every comparison available, to within
 * about 7%: acetone typical and worst case, methanol typical (at ALOHA's
 * vapour pressure), and ALOHA's published benzene example. The best match
 * lies between 1 and 2 mm (the order of a smooth paved surface); 1 mm is
 * used because it is a round value and sits on the cautious side — HAZEL's
 * evaporation slightly at or above ALOHA's rather than below it.
 * Record: the 2026-10-01 ALOHA comparison (tank releases, puddle step).
 */
export const PUDDLE_ROUGHNESS_LENGTH = 0.001;

/**
 * Evaporation rate and puddle temperature at one instant.
 *
 * Separated from the time loop so it can be tested directly against hand
 * calculations, and so the boiling and non-boiling branches can be compared
 * at the same conditions — which is what ALOHA does when deciding between them.
 *
 * @returns {{ flux: number, boiling: boolean, correction: number, fluxes: object }}
 */
function evaporationAtInstant({
  puddleTemperature,
  airTemperature,
  groundTemperature,
  elapsedSeconds,
  puddleDiameter,
  chemical,
  weather,
  substrate,
  solarElevationDegrees,
  groundFluxOverride = null,
  additionalFlux = 0,
}) {
  const { molecularWeight, boilingPointK, heatOfVaporizationJPerMol } = chemical;
  const latentHeatPerKg = (heatOfVaporizationJPerMol / molecularWeight) * 1000; // J/kg

  const uStar = puddleFrictionVelocity(
    weather.windSpeed10m,
    10,
    weather.powerLawExponent
  );

  // Vapour pressure is evaluated at the puddle temperature, not the air
  // temperature — this is the coupling that makes evaporative cooling matter.
  const vapourPressure = vapourPressureAt(
    puddleTemperature,
    boilingPointK,
    heatOfVaporizationJPerMol
  );

  const jBar = averageMassTransferCoefficient({
    powerLawExponent: weather.powerLawExponent,
    puddleDiameter,
    roughnessLength: PUDDLE_ROUGHNESS_LENGTH,
    molecularWeight,
    frictionVelocity: uStar,
  });

  const rawCorrection = volatilityCorrection(jBar, vapourPressure, STANDARD_PRESSURE);
  const rawCorrectionFactor = jBar === 0 ? 1 : rawCorrection / jBar;

  // FIXED 2026-09-26 (see module docstring "BOILING/NON-BOILING SWITCH"):
  // Brighton's own model is only valid up to a correction factor of 4 (the
  // Tech Doc's own stated limit, BRIGHTON_CORRECTION_LIMIT below) — beyond
  // that, volatilityCorrection() itself signals outright boiling by
  // returning Infinity once vapour pressure reaches ambient pressure. Using
  // that Infinite (or any beyond-the-limit) value anywhere downstream — not
  // just in nonBoilingFlux, but in sensibleHeatFlux's own coefficient, which
  // this file's boiling-branch heat balance also depends on — corrupted the
  // BOILING branch's answer too, since Infinity * 0 (or Infinity times a
  // small temperature difference) collapses to NaN. Clamping at the
  // documented validity limit keeps every downstream quantity finite and
  // matches what the Tech Doc actually says happens at that limit: Brighton's
  // model stops applying, not that its coefficient becomes physically
  // infinite.
  const atBoilingLimit =
    puddleTemperature >= boilingPointK || rawCorrectionFactor >= BRIGHTON_CORRECTION_LIMIT;
  const jCorrected = atBoilingLimit ? jBar * BRIGHTON_CORRECTION_LIMIT : rawCorrection;
  const correctionFactor = atBoilingLimit ? BRIGHTON_CORRECTION_LIMIT : rawCorrectionFactor;

  const saturation = saturationConcentration(
    vapourPressure,
    molecularWeight,
    puddleTemperature
  );

  // Brighton's non-boiling flux — now always finite, thanks to the clamp above.
  const nonBoilingFlux = saturation * uStar * jCorrected;

  // Shared energy fluxes, independent of which evaporation branch applies
  const cloudinessIndex = weather.cloudCoverOktas * (10 / 8); // oktas -> tenths
  const ew = waterVapourPartialPressure(airTemperature, weather.relativeHumidity);

  const solar = solarFlux(solarElevationDegrees, cloudinessIndex);
  const longwaveDown = longwaveDownFlux(airTemperature, ew, cloudinessIndex);
  const longwaveUp = longwaveUpFlux(puddleTemperature);
  // A puddle fed from a tank spreads over fresh ground as it grows, so its
  // ground flux is the sum over rings of different contact ages; the caller
  // (simulateSpreadingPuddle) works that out and passes it in.
  const ground =
    groundFluxOverride ?? groundHeatFlux(groundTemperature, puddleTemperature, elapsedSeconds, substrate);
  const sensible = sensibleHeatFlux({
    airTemperature,
    puddleTemperature,
    frictionVelocity: uStar,
    correctedMassTransferCoefficient: jCorrected,
    molecularWeight,
  });

  // additionalFlux: heat carried in by liquid still arriving from a tank
  // (Tech Doc 3.4.4.3, F_dM); zero for a stand-alone puddle.
  const nonEvaporativeFlux = solar + longwaveDown + longwaveUp + ground + sensible + additionalFlux;

  // The boiling branch: at the boiling point the temperature is pinned, and
  // the evaporation rate is whatever consumes the incoming heat exactly
  // (Tech Doc 3.3.2).
  const boilingFlux = Math.max(0, nonEvaporativeFlux / latentHeatPerKg);

  // ALOHA compares the two and takes the larger, which also handles the
  // transition in both directions as conditions change (Tech Doc 3.3.2).
  // Both fluxes are guaranteed finite by the clamp above, so this comparison
  // — unlike before the 2026-09-26 fix — can never silently fail to trigger
  // because one side had already become Infinity or NaN.
  const boiling = atBoilingLimit && boilingFlux > nonBoilingFlux;
  const flux = boiling
    ? boilingFlux
    : Number.isFinite(nonBoilingFlux)
      ? nonBoilingFlux
      : boilingFlux; // defensive fallback; should be unreachable given the clamp above

  return {
    flux,
    boiling,
    correction: correctionFactor,
    fluxes: {
      solar,
      longwaveDown,
      longwaveUp,
      ground,
      sensible,
      inflow: additionalFlux,
      evaporative: evaporativeHeatFlux(flux, latentHeatPerKg),
    },
  };
}

/**
 * Integrates puddle evaporation forward in time.
 *
 * The two state variables — how much liquid remains and how warm it is —
 * are stepped together with a simple forward Euler scheme. Euler is adequate
 * here because the time step is small relative to the thermal response time
 * of the pool, and because the inputs (weather held constant, an idealised
 * flat circular puddle) carry far more uncertainty than the integration
 * scheme does. Spending effort on a higher-order integrator would be
 * precision applied to the wrong part of the problem.
 *
 * The puddle temperature is clamped at the boiling point, as the Tech Doc
 * specifies: a pool can absorb enough heat to boil, but not to exceed its
 * boiling point.
 *
 * @param {object} params
 * @param {object} params.chemical - { molecularWeight, boilingPointK,
 *        heatOfVaporizationJPerMol, liquidDensity, liquidHeatCapacityJPerKgK }
 * @param {object} params.weather - { windSpeed10m, powerLawExponent,
 *        roughnessLength, airTemperatureK, relativeHumidity, cloudCoverOktas }
 * @param {number} params.spillMass - kg of liquid spilled
 * @param {number} params.puddleArea - m^2
 * @param {number} [params.initialTemperature] - K; defaults to air temperature
 * @param {number} [params.groundTemperature] - K; defaults to air temperature
 * @param {string} [params.substrateKey] - key into SUBSTRATE_PROPERTIES
 * @param {number} [params.solarElevationDegrees]
 * @param {number} [params.durationSeconds] - how long to simulate
 * @param {number} [params.timeStepSeconds]
 * @returns {{
 *   series: Array<{t: number, rate: number, temperature: number, remaining: number, boiling: boolean}>,
 *   totalEvaporated: number,
 *   peakRate: number,
 *   averageRate: number,
 *   durationSeconds: number,
 *   fullyEvaporated: boolean
 * }}
 */
export function simulatePuddleEvaporation({
  chemical,
  weather,
  spillMass,
  puddleArea,
  initialTemperature = null,
  groundTemperature = null,
  substrateKey = "defaultSoil",
  solarElevationDegrees = 0,
  durationSeconds = 3600,
  timeStepSeconds = 1,
}) {
  const substrate = SUBSTRATE_PROPERTIES[substrateKey] ?? SUBSTRATE_PROPERTIES.defaultSoil;
  const airTemperature = weather.airTemperatureK;

  let temperature = initialTemperature ?? airTemperature;
  const ground = groundTemperature ?? airTemperature;

  // A circular puddle is assumed, as in ALOHA, with the diameter along the
  // wind axis taken as the puddle dimension (Tech Doc 3.3.1 footnote 4).
  const puddleDiameter = Math.sqrt((4 * puddleArea) / Math.PI);

  let remaining = spillMass;
  const series = [];
  let totalEvaporated = 0;
  let peakRate = 0;
  let fullyEvaporated = false;
  let elapsed = 0;

  const heatCapacityPerKg = chemical.liquidHeatCapacityJPerKgK;

  while (elapsed < durationSeconds && remaining > 0) {
    const instant = evaporationAtInstant({
      puddleTemperature: temperature,
      airTemperature,
      groundTemperature: ground,
      elapsedSeconds: elapsed,
      puddleDiameter,
      chemical,
      weather,
      substrate,
      solarElevationDegrees,
    });

    // Mass evaporated this step, limited by what is actually left
    const massRate = instant.flux * puddleArea; // kg/s
    const massThisStep = Math.min(massRate * timeStepSeconds, remaining);
    const actualRate = massThisStep / timeStepSeconds;

    // Temperature change from the net energy flux. The puddle depth shrinks
    // as liquid evaporates, so the same flux changes the temperature of an
    // ever-smaller mass faster — captured by using the remaining mass rather
    // than a fixed depth.
    const netFlux = Object.values(instant.fluxes).reduce((sum, f) => sum + f, 0); // W/m^2
    const thermalMass = Math.max(remaining, 1e-6) * heatCapacityPerKg; // J/K
    const temperatureChange = (netFlux * puddleArea * timeStepSeconds) / thermalMass;

    temperature = Math.min(temperature + temperatureChange, chemical.boilingPointK);

    remaining -= massThisStep;
    totalEvaporated += massThisStep;
    peakRate = Math.max(peakRate, actualRate);

    // Record once a minute rather than once a second: a 60-point series is
    // enough to plot and keeps the returned object small.
    if (elapsed % 60 === 0) {
      series.push({
        t: elapsed,
        rate: actualRate,
        temperature,
        remaining,
        boiling: instant.boiling,
      });
    }

    elapsed += timeStepSeconds;

    if (remaining <= 0) {
      fullyEvaporated = true;
      break;
    }
  }

  return {
    series,
    totalEvaporated,
    peakRate,
    averageRate: elapsed > 0 ? totalEvaporated / elapsed : 0,
    durationSeconds: elapsed,
    fullyEvaporated,
  };
}

/* ========================================================================
   A PUDDLE FED FROM A LEAKING TANK (Tech Doc 3.4.4.2 and 3.4.4.3)
   ======================================================================== */

/** Standard gravity, m/s^2 — for the spreading law below. */
const GRAVITY = 9.80665;

/**
 * Depth at which a spreading puddle stops spreading, 5 mm (Tech Doc
 * 3.4.4.2: "terminates the spreading when the depth drops to 5 mm").
 */
const MINIMUM_SPREADING_DEPTH = 0.005;

/**
 * Radius the puddle starts from in the first second. Only a numerical seed:
 * the Briscoe-Shaw spreading law below grows it to its real size within a
 * few seconds, so the value does not affect the result.
 */
const INITIAL_PUDDLE_RADIUS = 0.1;

/**
 * Evaporation from a puddle that a leaking tank keeps filling — the source
 * term ALOHA uses for a liquid stored below its boiling point (Tech Doc
 * 3.4.4: "ALOHA calculates the release of the liquid from the tank, the
 * puddle formation, and the evaporation rate from the puddle").
 *
 * Without this step the tank's liquid DRAIN rate would be handed to the
 * dispersion model as if all of it went straight into the air. For a
 * volatile liquid that is wrong by more than an order of magnitude: a 5 cm
 * hole drains acetone at about 1.5 kg/s, while a 10 m2 acetone puddle
 * evaporates a few tens of grams per second.
 *
 * What is modelled, each one-second step:
 *
 *   Spreading     Briscoe and Shaw (1980), dr/dt = sqrt(2 g d), with d the
 *                 uniform puddle depth. Spreading stops at the maximum
 *                 area the user gives (a bund, a kerb, the edge of a
 *                 paved yard) or when the depth falls to 5 mm. The area
 *                 never shrinks; the puddle thins instead.
 *   Ground heat   Conduction from the ground, summed over concentric rings
 *                 each with its own contact time: newly wetted ground is
 *                 still at its initial temperature and gives up heat
 *                 fastest (Tech Doc 3.4.4.3). Each ring uses the same
 *                 semi-infinite-solid solution as groundHeatFlux().
 *   Inflow heat   Liquid arriving from the tank at the tank temperature,
 *                 F_dM = Q c (T_tank - T_puddle) / (pi r^2) (Tech Doc
 *                 3.4.4.3).
 *   Evaporation   Exactly the stand-alone puddle model above (Brighton,
 *                 or the boiling energy balance near the boiling point),
 *                 at the current puddle diameter.
 *
 * @param {object} params
 * @param {object} params.chemical - as simulatePuddleEvaporation()
 * @param {object} params.weather - as simulatePuddleEvaporation()
 * @param {(t: number) => number} params.inflowAt - liquid arriving from
 *        the tank during second t, kg/s
 * @param {number} [params.inflowTemperature] - K; defaults to air temperature
 * @param {number|null} [params.maxPuddleArea] - m^2; null = spread freely
 *        until the depth reaches 5 mm
 * @param {number} [params.sourceInventory] - kg in the tank at t = 0. Only
 *        used to report `remaining` (mass not yet airborne) in the series,
 *        which the heavy-gas step builder reads.
 * @param {number} [params.groundTemperature] - K; defaults to air temperature
 * @param {string} [params.substrateKey]
 * @param {number} [params.solarElevationDegrees]
 * @param {number} [params.durationSeconds] - capped at one hour by the caller
 * @param {number} [params.timeStepSeconds]
 */
export function simulateSpreadingPuddle({
  chemical,
  weather,
  inflowAt,
  inflowTemperature = null,
  maxPuddleArea = null,
  sourceInventory = null,
  groundTemperature = null,
  substrateKey = "defaultSoil",
  solarElevationDegrees = 0,
  durationSeconds = 3600,
  timeStepSeconds = 1,
}) {
  const substrate = SUBSTRATE_PROPERTIES[substrateKey] ?? SUBSTRATE_PROPERTIES.defaultSoil;
  const airTemperature = weather.airTemperatureK;
  const ground = groundTemperature ?? airTemperature;
  const tankTemperature = inflowTemperature ?? airTemperature;
  const areaLimit = Number.isFinite(maxPuddleArea) && maxPuddleArea > 0 ? maxPuddleArea : Infinity;
  const { liquidDensity, liquidHeatCapacityJPerKgK: heatCapacity, boilingPointK } = chemical;

  let temperature = Math.min(tankTemperature, boilingPointK);
  let puddleMass = 0;
  let radius = 0;
  let area = 0;
  // Rings of wetted ground: { area (m^2), since (s) }.
  const rings = [];

  const series = [];
  let totalEvaporated = 0;
  let totalInflow = 0;
  let peakRate = 0;
  let elapsed = 0;
  let lastActive = 0;

  while (elapsed < durationSeconds) {
    const inflowRate = Math.max(0, inflowAt(elapsed) || 0);
    const inflowMass = inflowRate * timeStepSeconds;

    // Liquid arriving this step mixes into the puddle (energy-weighted).
    if (inflowMass > 0) {
      if (puddleMass <= 0) temperature = Math.min(tankTemperature, boilingPointK);
      puddleMass += inflowMass;
      totalInflow += inflowMass;
      if (radius === 0) {
        radius = Math.min(INITIAL_PUDDLE_RADIUS, Math.sqrt(areaLimit / Math.PI));
      }
    }

    if (puddleMass <= 0 && inflowRate <= 0) {
      // Nothing on the ground and nothing arriving: finished, unless the
      // tank is still due to deliver more later (it never pauses, so no).
      break;
    }

    // Spreading (Briscoe-Shaw), whenever the puddle is deeper than 5 mm and
    // still smaller than the area limit. With liquid still arriving the
    // puddle deepens again and resumes spreading, as the Tech Doc describes
    // ("when the tank release rate is greater than the computed evaporation
    // rate, ALOHA predicts that the puddle will spread"). The growth in one
    // step is capped so that it cannot overshoot the 5 mm depth — an
    // explicit one-second step would otherwise thin a small, fast-spreading
    // puddle far below 5 mm in a single jump.
    const radiusLimit = Math.sqrt(areaLimit / Math.PI);
    if (puddleMass > 0 && radius < radiusLimit) {
      const depth = puddleMass / (liquidDensity * Math.PI * radius * radius);
      if (depth > MINIMUM_SPREADING_DEPTH) {
        const radiusAtMinimumDepth = Math.sqrt(puddleMass / (liquidDensity * Math.PI * MINIMUM_SPREADING_DEPTH));
        const grown = radius + Math.sqrt(2 * GRAVITY * depth) * timeStepSeconds;
        radius = Math.min(grown, radiusAtMinimumDepth, radiusLimit);
      }
    }
    const newArea = Math.PI * radius * radius;
    if (newArea > area) {
      rings.push({ area: newArea - area, since: elapsed });
      area = newArea;
    }

    // Ground conduction, ring by ring.
    let groundPower = 0;
    for (const ring of rings) {
      groundPower += ring.area * groundHeatFlux(ground, temperature, elapsed - ring.since, substrate);
    }
    const groundFlux = area > 0 ? groundPower / area : 0;
    const inflowFlux = area > 0 ? (inflowRate * heatCapacity * (tankTemperature - temperature)) / area : 0;

    const instant = evaporationAtInstant({
      puddleTemperature: temperature,
      airTemperature,
      groundTemperature: ground,
      elapsedSeconds: elapsed,
      puddleDiameter: 2 * radius,
      chemical,
      weather,
      substrate,
      solarElevationDegrees,
      groundFluxOverride: groundFlux,
      additionalFlux: inflowFlux,
    });

    const massThisStep = Math.min(instant.flux * area * timeStepSeconds, puddleMass);
    const actualRate = massThisStep / timeStepSeconds;

    const netFlux = Object.values(instant.fluxes).reduce((sum, f) => sum + f, 0);
    const thermalMass = Math.max(puddleMass, 1e-6) * heatCapacity;
    temperature = Math.min(temperature + (netFlux * area * timeStepSeconds) / thermalMass, boilingPointK);

    puddleMass -= massThisStep;
    totalEvaporated += massThisStep;
    peakRate = Math.max(peakRate, actualRate);
    if (actualRate > 0) lastActive = elapsed + timeStepSeconds;

    if (elapsed % 60 === 0) {
      series.push({
        t: elapsed,
        rate: actualRate,
        temperature,
        remaining: Number.isFinite(sourceInventory)
          ? Math.max(sourceInventory - totalEvaporated, 0)
          : puddleMass,
        puddleMass,
        puddleArea: area,
        inflowRate,
        boiling: instant.boiling,
      });
    }

    elapsed += timeStepSeconds;
  }

  return {
    series,
    totalEvaporated,
    totalInflow,
    peakRate,
    averageRate: lastActive > 0 ? totalEvaporated / lastActive : 0,
    durationSeconds: lastActive,
    fullyEvaporated: puddleMass <= 1e-9,
    puddleArea: area,
    puddleDiameter: 2 * radius,
    puddleMassLeft: puddleMass,
  };
}
