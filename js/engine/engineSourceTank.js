/**
 * engineSourceTank.js
 * -------------------
 * Release rate from a ruptured tank.
 *
 * Which of three models applies depends on what is behind the hole, and that
 * in turn depends on where the hole is and how the contents are stored:
 *
 *   Liquid below its boiling point   Bernoulli flow driven by the head of
 *   (section 3.4.4)                  liquid above the hole plus any vapour
 *                                    pressure in the ullage. The liquid forms
 *                                    a puddle, which then evaporates — this
 *                                    model feeds engineSourcePuddle.js.
 *
 *   Superheated liquid or 2-phase    Homogeneous Nonequilibrium Model
 *   (section 3.4.5)                  (Fauske 1985, Henry and Fauske 1971).
 *                                    The liquid flashes as it leaves. ALOHA
 *                                    assumes it disperses directly rather
 *                                    than raining out, as a deliberate
 *                                    overestimate. This is the propane and
 *                                    chlorine case.
 *
 *   Gas                              Choked or unchoked compressible flow,
 *   (section 3.4.6)                  after the LEAKR algorithms (Belore and
 *                                    Buist 1986).
 *
 * All three drain the tank over time, and the rate falls as they do: the head
 * drops, the pressure drops, and for a gas the expansion cools what remains.
 * The integrator at the end of this file handles that.
 *
 * Reference throughout: ALOHA 5.4.4 Technical Documentation, NOAA TM NOS
 * OR&R 43, sections 3.4.1 to 3.4.6.
 *
 * A "DRY" HOLE IN THE TWO-PHASE MODEL — REVIEWED AND CONFIRMED 2026-09-26
 * ---------------------------------------------------------------------------
 * simulateTankRelease()'s two-phase (flashing liquid) branch uses the hole's
 * FULL area, submerged.totalArea, even when submergedHoleArea() reports the
 * hole as "dry" — sitting in the vapour space above the current liquid
 * level, per the tank's static fill geometry — rather than treating a dry
 * hole as venting vapour only (or the liquid branch's own, much stricter
 * `if (submerged.dry) break;`, which stops the release outright once the
 * level falls below a liquid-phase hole).
 *
 * This was flagged by an internal audit
 * (the 2026-09-26 duration review, finding #3) as an
 * undisclosed inconsistency between the two branches. Raised with the
 * person who scoped this project (a DGSA reviewing it against real
 * transport incidents), the answer was that this is not a gap to fix: for
 * a liquefied gas under pressure in a road or rail tanker, the tank sloshes
 * and rolls during a transport incident — exactly the ADR (transport of
 * dangerous goods) scenario this project targets — so a hole that would sit
 * in the vapour space of a perfectly still, level tank is, in practice,
 * repeatedly washed by liquid as the vehicle moves or the tank settles.
 * Treating that hole as a full liquid/two-phase release, rather than a
 * vapour-only or zero release, is judged the physically realistic choice for
 * the transport scenario this tool exists for, not merely a conservative
 * simplification standing in for unmodelled physics. The static, non-sloshed
 * liquid-phase branch's stricter behaviour is intentionally NOT mirrored
 * here for that reason — the two branches are handling genuinely different
 * physical pictures (a liquid below its boiling point simply drains and
 * stops; a superheated liquid under ADR transport conditions does not stay
 * put long enough for "dry" to mean "no liquid ever reaches this hole").
 * This decision is deliberately left as code, not surfaced as a disclosed
 * "limitation" in engineLimitations.js, because it is not considered a gap
 * against the model's own scope — see selectReleaseModel() and
 * simulateTankRelease() below for where it applies.
 */

import { UNIVERSAL_GAS_CONSTANT, STANDARD_PRESSURE } from "./engineConstants.js";
import {
  tankVolume,
  liquidVolumeAtDepth,
  depthForLiquidVolume,
  submergedHoleArea,
  headAboveHole,
} from "./engineTankGeometry.js";
import { vapourPressureAt } from "./engineSourcePuddle.js";

/** Standard gravity, m/s^2. */
const GRAVITY = 9.80665;

/** Discharge coefficient, 0.61 per Tech Doc section 3.4.4.1. */
const DISCHARGE_COEFFICIENT = 0.61;

/**
 * Reference pipe length in the Homogeneous Nonequilibrium Model, 0.1 m
 * (Tech Doc 3.4.5). A "hole" is a pipe of zero length; at 10 cm the model
 * reduces to the homogeneous equilibrium model.
 */
const HNM_REFERENCE_PIPE_LENGTH = 0.1;

/**
 * Floor on the pressure driving liquid flow, expressed as a multiple of
 * ambient.
 *
 * An unvented tank would, in principle, stop flowing once the internal
 * pressure fell to atmospheric. In practice air is drawn back in and the
 * contents continue to escape in surges. ALOHA approximates this by holding
 * the driving pressure at 1.01 times ambient once the computed value falls
 * that low (Tech Doc 3.4.4.1, after Belore and Buist 1986 and Dodge, Bowels
 * and White 1980), and HAZEL does the same.
 */
const MINIMUM_DRIVING_PRESSURE_RATIO = 1.01;

/* ========================================================================
   LIQUID RELEASE (Tech Doc 3.4.4)
   ======================================================================== */

/**
 * Mass flow rate of a liquid stored below its boiling point, from Bernoulli's
 * equation (Tech Doc 3.4.4.1):
 *
 *     Q = C_dis * A_f * sqrt(2 * (P_h - P_a) * rho_l)
 *
 * @param {object} params
 * @param {number} params.submergedArea - m^2, the wetted part of the hole
 * @param {number} params.pressureAtHole - Pa, absolute, inside the tank
 * @param {number} params.ambientPressure - Pa
 * @param {number} params.liquidDensity - kg/m^3
 * @returns {number} kg/s
 */
export function liquidMassFlowRate({
  submergedArea,
  pressureAtHole,
  ambientPressure,
  liquidDensity,
}) {
  const drivingPressure = Math.max(0, pressureAtHole - ambientPressure);
  if (submergedArea <= 0 || drivingPressure <= 0) return 0;

  return (
    DISCHARGE_COEFFICIENT *
    submergedArea *
    Math.sqrt(2 * drivingPressure * liquidDensity)
  );
}

/**
 * Absolute pressure inside the tank at the height of the hole.
 *
 * Two contributions: the vapour pressure of the liquid filling the ullage
 * above it, and the hydrostatic head of the liquid column. An unvented tank
 * holding a volatile liquid can therefore push material out even when the
 * hole is near the top of the remaining liquid.
 *
 * @returns {number} Pa, absolute
 */
export function pressureAtHole({
  vapourPressure,
  liquidDensity,
  headHeight,
  ambientPressure = STANDARD_PRESSURE,
}) {
  const hydrostatic = liquidDensity * GRAVITY * headHeight;
  const computed = vapourPressure + hydrostatic;

  // See MINIMUM_DRIVING_PRESSURE_RATIO above: flow does not simply stop when
  // the tank depressurises, because air is ingested and the contents surge out.
  return Math.max(computed, MINIMUM_DRIVING_PRESSURE_RATIO * ambientPressure);
}

/* ========================================================================
   TWO-PHASE AND SUPERHEATED LIQUID (Tech Doc 3.4.5)
   ======================================================================== */

/**
 * Specific volume of the vapour, from the ideal gas law.
 * @returns {number} m^3/kg
 */
export function vapourSpecificVolume(molecularWeight, temperature, pressure) {
  return (UNIVERSAL_GAS_CONSTANT * temperature) / (pressure * (molecularWeight / 1000));
}

/**
 * Mass flux through a hole or short pipe for a superheated liquid or a
 * two-phase mixture, from the Homogeneous Nonequilibrium Model (Tech Doc
 * 3.4.5, after Fauske 1985, Fauske and Epstein 1987, Henry and Fauske 1971):
 *
 *     G = L_c / (v_g - v_l) * (N * c_p * T)^(-1/2)
 *
 *     N = L_c^2 * v_l / (2 * dP * C_dis^2 * (v_g - v_l)^2 * T * c_p) + l / l_e
 *
 * The physical picture: as the superheated liquid passes through the opening
 * its pressure drops below its vapour pressure and it begins to flash. The
 * vapour generated occupies far more volume than the liquid it came from, and
 * that expansion chokes the opening, limiting the flow. The term N captures
 * how far the flashing proceeds, which is why it depends on the pipe length:
 * a bare hole gives the liquid no time to flash, a 10 cm pipe gives it enough
 * to reach equilibrium.
 *
 * @param {object} params
 * @param {number} params.latentHeat - J/kg
 * @param {number} params.vapourSpecificVolume - m^3/kg
 * @param {number} params.liquidSpecificVolume - m^3/kg
 * @param {number} params.heatCapacity - J/(kg*K)
 * @param {number} params.temperature - K
 * @param {number} params.pressureDifference - Pa
 * @param {number} [params.pipeLength] - m; 0 for a hole in the tank wall
 * @returns {number} mass flux, kg/(m^2*s)
 */
export function twoPhaseMassFlux({
  latentHeat,
  vapourSpecificVolume: vg,
  liquidSpecificVolume: vl,
  heatCapacity,
  temperature,
  pressureDifference,
  pipeLength = 0,
}) {
  const volumeDifference = vg - vl;
  if (volumeDifference <= 0 || pressureDifference <= 0) return 0;

  const flashingTerm =
    (latentHeat * latentHeat * vl) /
    (2 *
      pressureDifference *
      DISCHARGE_COEFFICIENT *
      DISCHARGE_COEFFICIENT *
      volumeDifference *
      volumeDifference *
      temperature *
      heatCapacity);

  const N = flashingTerm + pipeLength / HNM_REFERENCE_PIPE_LENGTH;

  return (latentHeat / volumeDifference) * Math.pow(N * heatCapacity * temperature, -0.5);
}

/**
 * Maximum quality (vapour mass fraction) for which the Homogeneous
 * Nonequilibrium Model remains valid (Tech Doc 3.4.5).
 *
 * A note on the published equation
 * ---------------------------------
 * The Tech Doc prints this as
 *
 *     X(max) = P * c_p * T * (v_g - v_l) / L_c
 *
 * which does not come out dimensionless, and quality — being a mass fraction
 * — must be. Working the units through:
 *
 *     (J/m^3)(J/(kg K))(K)(m^3/kg) / (J/kg)  =  J/kg,  not 1
 *
 * Evaluated for propane at typical road-tanker conditions it returns about
 * 93,000, where any value above 1 is meaningless.
 *
 * The underlying physics gives the consistent form directly. For an
 * isenthalpic flash the quality is x = c_p * dT / L_c, and Clausius-Clapeyron
 * relates the temperature drop to the pressure drop as dT/dP = T(v_g - v_l)/L_c.
 * Substituting:
 *
 *     X(max) = c_p * T * dP * (v_g - v_l) / L_c^2
 *
 * which is dimensionless and returns 0.19 for the same propane case — a
 * physically sensible 19% vapour.
 *
 * That corrected form is what this function implements. Either the printed
 * equation contains a typesetting slip (an L_c that should be squared, and a
 * P that should be a pressure difference), or it is a rendering artefact of
 * the PDF; the numbers make clear which reading is intended. This is recorded
 * here rather than silently corrected so a reviewer comparing HAZEL against
 * the Tech Doc can see the deviation and check the reasoning.
 *
 * @param {number} params.pressureDifference - Pa, inside minus outside
 * @returns {number} dimensionless mass fraction
 */
export function maximumQuality({
  pressureDifference,
  heatCapacity,
  temperature,
  vapourSpecificVolume: vg,
  liquidSpecificVolume: vl,
  latentHeat,
}) {
  return (
    (heatCapacity * temperature * pressureDifference * (vg - vl)) /
    (latentHeat * latentHeat)
  );
}

/* ========================================================================
   GAS RELEASE (Tech Doc 3.4.6)
   ======================================================================== */

/**
 * Critical pressure ratio, below which gas flow through the opening is choked
 * — that is, it reaches the speed of sound at the throat and stops responding
 * to further reductions in downstream pressure (Tech Doc 3.4.6).
 *
 * Two forms, selected by how large the hole is relative to the tank:
 *
 *   big hole (beta > 0.2):    R_c = (2 / (gamma + 1))^(gamma / (gamma - 1))
 *   small hole (beta <= 0.2): solves
 *       R_c^((1-gamma)/gamma) + ((gamma-1)/2) * beta^4 * R_c^(2/gamma)
 *         = (gamma + 1) / 2
 *
 * The small-hole form has no closed-form solution, so it is solved by
 * bisection over the physically meaningful range (0, 1).
 *
 * @param {number} gamma - ratio of specific heats
 * @param {number} betaRatio - hole dimension / tank dimension
 * @returns {number} critical pressure ratio
 */
export function criticalPressureRatio(gamma, betaRatio) {
  const bigHoleValue = Math.pow(2 / (gamma + 1), gamma / (gamma - 1));

  if (betaRatio > 0.2) return bigHoleValue;

  const target = (gamma + 1) / 2;
  const residual = (rc) =>
    Math.pow(rc, (1 - gamma) / gamma) +
    ((gamma - 1) / 2) * Math.pow(betaRatio, 4) * Math.pow(rc, 2 / gamma) -
    target;

  // The left-hand side decreases as rc rises over (0,1), so bisect.
  let low = 1e-6;
  let high = 1 - 1e-9;

  for (let i = 0; i < 100 && high - low > 1e-10; i++) {
    const mid = (low + high) / 2;
    if (residual(mid) > 0) low = mid;
    else high = mid;
  }

  return (low + high) / 2;
}

/**
 * Mass flow rate of a gas under choked (sonic) conditions (Tech Doc 3.4.6.1):
 *
 *     Q = C_dis * A_h * sqrt( rho_g * P_T * gamma * (2/(gamma+1))^((gamma+1)/(gamma-1)) )
 */
export function chokedGasFlowRate({ holeArea, gasDensity, tankPressure, gamma }) {
  const factor = Math.pow(2 / (gamma + 1), (gamma + 1) / (gamma - 1));
  return (
    DISCHARGE_COEFFICIENT *
    holeArea *
    Math.sqrt(gasDensity * tankPressure * gamma * factor)
  );
}

/**
 * Mass flow rate of a gas under unchoked (subsonic) conditions
 * (Tech Doc 3.4.6.2):
 *
 *     Q = C_dis * A_h * sqrt( 2 * rho_g * P_T * (gamma/(gamma-1))
 *                             * [ (P_a/P_T)^(2/gamma) - (P_a/P_T)^((gamma+1)/gamma) ] )
 */
export function unchokedGasFlowRate({
  holeArea,
  gasDensity,
  tankPressure,
  ambientPressure,
  gamma,
}) {
  const ratio = ambientPressure / tankPressure;
  if (ratio >= 1) return 0;

  const bracket =
    Math.pow(ratio, 2 / gamma) - Math.pow(ratio, (gamma + 1) / gamma);
  if (bracket <= 0) return 0;

  return (
    DISCHARGE_COEFFICIENT *
    holeArea *
    Math.sqrt(2 * gasDensity * tankPressure * (gamma / (gamma - 1)) * bracket)
  );
}

/**
 * Temperature of gas after it has expanded to atmospheric pressure, treated
 * as adiabatic (Tech Doc 3.4.6.2):
 *
 *     T_g = T_T * (P_T / P_a)^((1 - gamma) / gamma)
 *
 * This matters beyond bookkeeping: released gas is colder than the tank it
 * came from, sometimes far colder, and a cold cloud is denser than its
 * molecular weight alone suggests. That feeds the heavy-gas determination in
 * engineDispersionChoice.js.
 */
export function expandedGasTemperature(tankTemperature, tankPressure, ambientPressure) {
  const gamma = 1.4; // placeholder; callers pass their own via the object form below
  return tankTemperature * Math.pow(tankPressure / ambientPressure, (1 - gamma) / gamma);
}

/** As above, with the ratio of specific heats supplied explicitly. */
export function expandedGasTemperatureWithGamma(
  tankTemperature,
  tankPressure,
  ambientPressure,
  gamma
) {
  return tankTemperature * Math.pow(tankPressure / ambientPressure, (1 - gamma) / gamma);
}

/**
 * Selects between choked and unchoked flow and returns the rate, together
 * with which regime applied.
 */
export function gasReleaseRate({
  holeArea,
  holeDimension,
  tankDimension,
  gasDensity,
  tankPressure,
  ambientPressure,
  gamma,
}) {
  const pressureRatio = ambientPressure / tankPressure;
  const betaRatio = holeDimension / tankDimension;
  const critical = criticalPressureRatio(gamma, betaRatio);

  if (pressureRatio <= critical) {
    return {
      rate: chokedGasFlowRate({ holeArea, gasDensity, tankPressure, gamma }),
      choked: true,
      criticalRatio: critical,
    };
  }

  return {
    rate: unchokedGasFlowRate({
      holeArea,
      gasDensity,
      tankPressure,
      ambientPressure,
      gamma,
    }),
    choked: false,
    criticalRatio: critical,
  };
}

/* ========================================================================
   REAL-GAS CORRECTION FOR A COMPRESSED-GAS TANK (2026-10-02)
   ======================================================================== */

/**
 * Compressibility factor Z = PV/(nRT) from the Pitzer (Tsonopoulos/Abbott)
 * second-virial correlation:
 *
 *     Z = 1 + (B0 + omega B1) Pr / Tr,
 *     B0 = 0.083 - 0.422 / Tr^1.6,   B1 = 0.139 - 0.172 / Tr^4.2
 *
 * (Smith, Van Ness & Abbott, "Introduction to Chemical Engineering
 * Thermodynamics", ch. 3). Reliable for moderate reduced pressures, which
 * covers transport tanks. ALOHA's tank masses for gas-only tanks are
 * reproduced with it: CO 20 atm 1/Z = 1.009 (ALOHA/ideal 1.012), chlorine
 * 3 atm 1.043 (1.040), methane 50 atm 1.108 (1.107), acetylene 15 atm 1.118
 * (1.122).
 *
 * Returns 1 (ideal gas) when the critical constants are not known, and is
 * clamped to [0.3, 1.2] so a correlation pushed outside its range cannot
 * produce a nonsensical mass.
 */
export function pitzerCompressibility({ temperature, pressurePa, criticalTemperatureK, criticalPressureBar, acentricFactor = 0 }) {
  if (!(criticalTemperatureK > 0) || !(criticalPressureBar > 0) || !(temperature > 0) || !(pressurePa > 0)) return 1;
  const tr = temperature / criticalTemperatureK;
  const pr = pressurePa / (criticalPressureBar * 1e5);
  const b0 = 0.083 - 0.422 / Math.pow(tr, 1.6);
  const b1 = 0.139 - 0.172 / Math.pow(tr, 4.2);
  const omega = Number.isFinite(acentricFactor) ? acentricFactor : 0;
  const z = 1 + (b0 + omega * b1) * (pr / tr);
  return Math.min(1.2, Math.max(0.3, z));
}

/**
 * Edmister's estimate of the acentric factor from the normal boiling point
 * and the critical constants:  omega = (3/7) [theta/(1-theta)] log10(Pc/Pa) - 1,
 * theta = Tb/Tc. Within ~0.02 of tabulated values for the gases concerned
 * (methane 0.005 vs 0.012, acetylene 0.21 vs 0.19).
 */
export function edmisterAcentricFactor(boilingPointK, criticalTemperatureK, criticalPressureBar) {
  if (!(boilingPointK > 0) || !(criticalTemperatureK > boilingPointK) || !(criticalPressureBar > 1.01325)) return 0;
  const theta = boilingPointK / criticalTemperatureK;
  return (3 / 7) * (theta / (1 - theta)) * Math.log10(criticalPressureBar / 1.01325) - 1;
}

/* ========================================================================
   INTEGRATION
   ======================================================================== */

/**
 * Determines which release model applies to a scenario.
 *
 * The decision follows Tech Doc section 3.4.3. The key question is whether
 * the stored liquid is above its boiling point at ambient pressure — a
 * liquefied gas under pressure, such as propane or chlorine in a road tanker,
 * is — because such a liquid flashes as it escapes rather than pooling.
 *
 * @returns {"liquid" | "twoPhase" | "gas"}
 */
export function selectReleaseModel({ storedPhase, temperature, boilingPointK, holeIsSubmerged }) {
  if (storedPhase === "gas") return "gas";

  // A rupture above the liquid level in a tank of ordinary liquid releases
  // only vapour, which the Tech Doc treats as insignificant for liquids
  // stored below their boiling point. Callers handle that as a zero rate.
  if (!holeIsSubmerged && temperature < boilingPointK) return "liquid";

  return temperature >= boilingPointK ? "twoPhase" : "liquid";
}

/**
 * Simulates a tank draining through a rupture.
 *
 * Steps forward in time, recomputing the rate as the tank empties: the liquid
 * level falls, the head above the hole shrinks, the pressure drops, and for a
 * gas release the remaining contents cool and depressurise. The result is the
 * time-varying source term the dispersion model needs, not a single number.
 *
 * @param {object} params
 * @param {object} params.tank - { shape, diameter, length, fillFraction }
 * @param {object} params.hole - { shape, diameter|width+height, heightAboveBottom, pipeLength }
 * @param {object} params.chemical - physical properties
 * @param {number} params.temperature - K, tank contents
 * @param {string} params.storedPhase - "liquid" | "gas"
 * @param {number} [params.ambientPressure] - Pa
 * @param {number} [params.durationSeconds]
 * @param {number} [params.timeStepSeconds]
 * @returns {object} release summary and time series
 */
export function simulateTankRelease({
  tank,
  hole,
  chemical,
  temperature,
  storedPhase = "liquid",
  ambientPressure = STANDARD_PRESSURE,
  durationSeconds = 3600,
  timeStepSeconds = 1,
}) {
  const totalVolume = tankVolume(tank);
  const {
    molecularWeight,
    boilingPointK,
    heatOfVaporizationJPerMol,
    liquidDensity,
    liquidHeatCapacityJPerKgK,
    gammaRatio = 1.3,
  } = chemical;

  const latentHeatPerKg = (heatOfVaporizationJPerMol / molecularWeight) * 1000;
  const liquidSpecificVolume = 1 / liquidDensity;

  // Starting inventory
  let liquidVolume = storedPhase === "liquid" ? totalVolume * tank.fillFraction : 0;
  let remainingMass =
    storedPhase === "liquid"
      ? liquidVolume * liquidDensity
      : (totalVolume * molecularWeight * vapourPressureAtOrGiven()) /
        (1000 * UNIVERSAL_GAS_CONSTANT * temperature *
          (Number.isFinite(chemical.compressibilityFactor) && chemical.compressibilityFactor > 0
            ? chemical.compressibilityFactor
            : 1));

  function vapourPressureAtOrGiven() {
    return chemical.tankPressure ?? vapourPressureAt(temperature, boilingPointK, heatOfVaporizationJPerMol);
  }

  let tankPressure = vapourPressureAtOrGiven();
  const initialMass = remainingMass;

  const series = [];
  let elapsed = 0;
  let totalReleased = 0;
  let peakRate = 0;
  let regime = null;

  const holeDimension =
    hole.shape === "rectangular" ? Math.sqrt(hole.width * hole.height) : hole.diameter;
  const tankDimension = tank.diameter;

  while (elapsed < durationSeconds && remainingMass > 1e-9) {
    let rate = 0;

    if (storedPhase === "gas") {
      // Density of the gas still in the tank (mass over volume).
      const gasDensity = remainingMass / totalVolume;
      const holeArea =
        hole.shape === "rectangular"
          ? hole.width * hole.height
          : Math.PI * Math.pow(hole.diameter / 2, 2);

      const result = gasReleaseRate({
        holeArea,
        holeDimension,
        tankDimension,
        gasDensity,
        tankPressure,
        ambientPressure,
        gamma: gammaRatio,
      });
      rate = result.rate;
      regime = result.choked ? "gas (choked)" : "gas (unchoked)";

      // The tank depressurises as gas escapes. POLYTROPIC (2026-10-02):
      // P = P0 (m/m0)^n with n = (1 + gamma)/2, half way between an
      // isothermal tank (n = 1, the earlier treatment) and a fully adiabatic
      // one (n = gamma; the Tech Doc, 3.4.6, says adiabatic expansion cools
      // the contents and further reduces the pressure). With this exponent
      // the share of the contents ALOHA reports as released is reproduced
      // in all five gas-only comparisons: CO at 20 / 5 / 2 atm (0.918 /
      // 0.738 / 0.439 vs ALOHA 0.906 / 0.721 / 0.420), chlorine at 3 atm
      // (0.611 vs 0.613) and methane at 50 atm (0.966 vs 0.966). The
      // isothermal tank had released 4-20% too much.
      const massFraction = (remainingMass - Math.min(rate * timeStepSeconds, remainingMass)) / initialMass;
      const n = (1 + gammaRatio) / 2;
      tankPressure = vapourPressureAtOrGiven() * Math.pow(Math.max(massFraction, 0), n);
    } else {
      const depth = depthForLiquidVolume(tank, liquidVolume);
      const submerged = submergedHoleArea(hole, depth);
      const head = headAboveHole(depth, hole);

      if (temperature >= boilingPointK) {
        // Superheated liquid: flashes on release.
        //
        // Uses the FULL hole area even when submerged.dry is true — see the
        // module docstring's "A 'DRY' HOLE IN THE TWO-PHASE MODEL" section
        // for why this is a deliberate, reviewed choice (matching ADR
        // transport reality: a sloshing or rolling tank keeps washing a hole
        // that a static fill-level calculation would call "dry") rather than
        // an oversight, and why the liquid branch below does NOT use the
        // same reasoning for its own, differently-scoped case.
        const vg = vapourSpecificVolume(molecularWeight, temperature, tankPressure);
        const flux = twoPhaseMassFlux({
          latentHeat: latentHeatPerKg,
          vapourSpecificVolume: vg,
          liquidSpecificVolume,
          heatCapacity: liquidHeatCapacityJPerKgK,
          temperature,
          pressureDifference: Math.max(tankPressure - ambientPressure, 1),
          pipeLength: hole.pipeLength ?? 0,
        });
        const area = submerged.dry ? submerged.totalArea : submerged.submergedArea;
        rate = flux * area;
        regime = "two-phase (flashing liquid)";
      } else {
        if (submerged.dry) break; // level has fallen below the hole
        const pressure = pressureAtHole({
          vapourPressure: tankPressure,
          liquidDensity,
          headHeight: head,
          ambientPressure,
        });
        rate = liquidMassFlowRate({
          submergedArea: submerged.submergedArea,
          pressureAtHole: pressure,
          ambientPressure,
          liquidDensity,
        });
        regime = "liquid (Bernoulli)";
      }
    }

    const massThisStep = Math.min(rate * timeStepSeconds, remainingMass);
    const actualRate = massThisStep / timeStepSeconds;

    remainingMass -= massThisStep;
    totalReleased += massThisStep;
    if (storedPhase === "liquid") liquidVolume = remainingMass / liquidDensity;
    peakRate = Math.max(peakRate, actualRate);

    if (elapsed % 60 === 0) {
      series.push({
        t: elapsed,
        rate: actualRate,
        remainingMass,
        regime,
      });
    }

    elapsed += timeStepSeconds;
    if (actualRate <= 0) break;
  }

  return {
    series,
    regime,
    totalReleased,
    peakRate,
    averageRate: elapsed > 0 ? totalReleased / elapsed : 0,
    durationSeconds: elapsed,
    initialMass,
    emptied: remainingMass <= 1e-9,
  };
}
