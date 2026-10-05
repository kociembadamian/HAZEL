/**
 * stepSource.js
 * -------------
 * The Source step: what escaped, how fast, and for how long.
 *
 * This is where the scenario becomes a number the dispersion model can use.
 * It is also where the question deferred from the Chemical step is finally
 * answered: with a release rate in hand, the Richardson criterion in
 * engineDispersionChoice.js can say whether this particular release disperses
 * passively or slumps as a dense cloud — and therefore whether the Gaussian
 * model applies at all.
 *
 * Three source types, matching ALOHA:
 *
 *   Direct      the user states the rate outright. Useful when the release
 *               rate is known from elsewhere, and for teaching, where the
 *               point is to vary one number and watch the zones move.
 *   Puddle      a spill of known size evaporating from the ground.
 *   Tank        a ruptured vessel, which may drain as liquid, flash as a
 *               two-phase jet, or vent gas depending on its contents.
 *
 * On not shipping a catalogue of tank sizes: ADR sets minimum capacities and
 * leaves the rest to the manufacturer, so any built-in list of "standard"
 * road tankers would be wrong for some vessels from the day it shipped and
 * would go stale whenever the agreement added a type. Dimensions are entered
 * directly, as they are in ALOHA. The same reasoning applies to rupture
 * sizes: every incident tears metal differently, so the field starts empty.
 */

import { state } from "./state.js";
import {
  simulateTankRelease,
  expandedGasTemperatureWithGamma,
  pitzerCompressibility,
  edmisterAcentricFactor,
} from "../engine/engineSourceTank.js";
import {
  simulatePuddleEvaporation,
  simulateSpreadingPuddle,
  SUBSTRATE_PROPERTIES,
} from "../engine/engineSourcePuddle.js";
import { tankVolume } from "../engine/engineTankGeometry.js";
import { chooseDispersionModel, applyModelOverride } from "../engine/engineDispersionChoice.js";
import { releaseStepsFromSeries } from "../engine/engineHeavyGas.js";
import { deriveEngineInputs } from "./stepWeather.js";
import { solarElevation } from "../engine/solarPosition.js";
import { incidentMoment } from "./stepLocation.js";
import { WIND_PROFILE_EXPONENTS } from "../engine/engineConstants.js";

/** Starting values for the step. */
function defaultSource() {
  return {
    type: "direct", // "direct" | "puddle" | "tank"

    // Direct source
    directRate: 1, // kg/s
    directDuration: 600, // s
    directHeight: 0, // m above ground (2026-10-02)

    // Puddle
    puddleMass: 1000, // kg
    puddleArea: 100, // m^2
    substrate: "defaultSoil",

    // Tank
    tankShape: "horizontalCylinder",
    tankDiameter: 2.5,
    tankLength: 8,
    tankFillPercent: 80,
    holeShape: "circular",
    holeDiameter: 0.05,
    holeWidth: 0.5,
    holeHeight: 0.01,
    holeHeightAboveBottom: 0.1,
    pipeLength: 0,
    // Largest area the escaping liquid can cover (a bund, kerb or paved
    // yard), m^2. Empty = not known: the puddle spreads until it is 5 mm
    // deep, as ALOHA does when no limit is given. Only used for a liquid
    // stored below its boiling point; the ground type is the shared
    // "substrate" field above.
    tankMaxPuddleArea: "",
    // What the tank holds (2026-10-02): "liquid" (a liquid, or a gas
    // liquefied under pressure) or "gas" (a compressed gas only). Empty =
    // decided from the substance — see tankContentsFor(). For "gas", the
    // absolute tank pressure and the gas's heat capacity ratio.
    tankContents: "",
    tankPressureAtm: "",
    gasHeatCapacityRatio: 1.4,
    // Critical constants for the real-gas correction (2026-10-02); empty =
    // taken from the Chemical library record, if it has them.
    criticalTemperatureK: "",
    criticalPressureBar: "",
    acentricFactor: "",

    // Manually supplied physical properties the PAC dataset does not carry.
    // These unlock in the interface when a model needs them — see the
    // needsManualEntry pattern established in the chemical database.
    liquidDensity: null,
    liquidHeatCapacity: null,

    // Dispersion model: "" = chosen automatically (Richardson number),
    // "gaussian" or "heavyGas" = forced by the user (2026-10-04, see
    // applyModelOverride() in engineDispersionChoice.js).
    modelOverride: "",

    result: null,
  };
}

function currentSource() {
  return state.current.scenario.source ?? defaultSource();
}

function updateSource(changes) {
  const source = { ...currentSource(), ...changes };
  state.update({ scenario: { ...state.current.scenario, source } });
}

/* ========================================================================
   GATHERING INPUTS FROM EARLIER STEPS
   ======================================================================== */

/**
 * Collects everything the source models need from the rest of the scenario,
 * and reports what is missing rather than failing silently.
 *
 * Every source model needs the chemical; the puddle and tank models also need
 * the weather, and physical properties the PAC dataset does not carry. The
 * missing list drives what the interface asks for.
 *
 * @returns {{ ready: boolean, missing: string[], chemical: object|null, weather: object|null }}
 */
export function gatherModelInputs() {
  const scenario = state.current.scenario;
  const missing = [];

  const chemicalRecord = scenario.chemical?.selected ?? null;
  if (!chemicalRecord) missing.push("a substance, chosen in the Chemical step");

  let weather = null;
  if (scenario.weather) {
    try {
      weather = deriveEngineInputs(scenario.weather);
      if (weather.problems.length > 0) {
        missing.push("usable weather — " + weather.problems[0]);
      }
    } catch {
      missing.push("valid weather data");
    }
  } else {
    missing.push("weather conditions, entered in the Weather step");
  }

  return { ready: missing.length === 0, missing, chemical: chemicalRecord, weather };
}

/**
 * Solar elevation for the incident, or zero when the location is not set.
 * The puddle energy balance needs it; without a location the model still runs
 * with no solar input, which understates evaporation on a sunny day.
 */
function solarElevationForScenario() {
  const location = state.current.scenario.location;
  if (!location || location.lat === null || location.lng === null) return 0;
  // No usable date/time (an incomplete or older saved scenario) gives NaN
  // here, which would poison every step of the puddle energy balance. Treat
  // it as no sunshine — the cautious-neutral choice, the same as no location.
  const elevation = solarElevation(incidentMoment(location), location.lat, location.lng);
  return Number.isFinite(elevation) ? elevation : 0;
}

/* ========================================================================
   RUNNING THE MODELS
   ======================================================================== */

/*
 * COMPRESSED GAS IN A TANK (2026-10-02)
 * -------------------------------------
 * A gas above its critical temperature cannot be liquefied by any pressure:
 * carbon monoxide, nitrogen, oxygen, hydrogen, methane at ordinary
 * temperatures are carried as compressed gas only. The Tech Doc treats such
 * a tank separately (3.4.2: "Tanks containing only gas ... the user must
 * define the initial temperature and pressure of the tank"; 3.4.6: choked,
 * then unchoked flow; the gas then expands to atmospheric pressure and
 * cools, Tg = T (Pa/P)^((gamma-1)/gamma)). That cold gas is denser than its
 * molecular weight alone suggests and is screened for heavy-gas behaviour
 * at its expanded temperature. ALOHA comparison C1/C2 (CO, 20 atm,
 * 2026-10-02): ALOHA ran Heavy Gas; HAZEL without the cold source had run
 * Gaussian and drawn zones 24-33% short.
 *
 * The critical temperature is not in the substance data, so it is estimated
 * from the boiling point: Tc / Tb is 1.6-1.7 for the light gases this
 * concerns (CO 1.63, N2 1.63, O2 1.71, CH4 1.71, ethane 1.65).
 */
const CRITICAL_TO_BOILING_RATIO = 1.65;

/*
 * LIGHT GASES STAY GAUSSIAN (2026-10-02). ALOHA ran Heavy Gas for carbon
 * monoxide expanded from 20, 5 and 2 atm (1.18-2.3 times as dense as air
 * once cold) but Gaussian for methane expanded from 50 atm (-159 C, 1.4
 * times as dense as air). The cold density alone does not separate the two;
 * the molecular weight does — CO is 0.97 of air's, methane 0.55. HAZEL
 * therefore applies the cold-cloud density only to a gas whose molecular
 * weight is at least this fraction of air's. Acetylene (0.90 of air's,
 * from 15 atm) also ran Heavy Gas in ALOHA, so the cut-off lies between
 * 0.55 and 0.90; 0.75 is a middle value. No gas a tank would plausibly hold
 * falls in that gap with a cold expanded density above air's (ammonia, the
 * nearest, is still lighter than air when expanded from its own vapour
 * pressure), so the exact value has no practical effect.
 */
const COLD_DENSE_GAS_MIN_MW_FRACTION = 0.75;

/** A value from the Source step's own field, else the chemical record's. */
function criticalConstant(source, chemical, field) {
  const own = source?.[field];
  if (own !== "" && own !== null && own !== undefined && Number.isFinite(Number(own))) return Number(own);
  const fromRecord = chemical?.[field];
  return Number.isFinite(Number(fromRecord)) && fromRecord !== null && fromRecord !== "" ? Number(fromRecord) : null;
}

/** The critical temperature: entered (Source step or Chemical library), else estimated from the boiling point. */
function estimatedCriticalTemperatureK(source, chemical) {
  const tc = criticalConstant(source, chemical, "criticalTemperatureK");
  if (tc > 0) return tc;
  const tb = Number(source.boilingPointK) || Number(chemical?.boilingPointK);
  return tb > 0 ? CRITICAL_TO_BOILING_RATIO * tb : null;
}

/**
 * "liquid" or "gas": the user's explicit choice, or else gas for a substance
 * flagged as non-condensable in the Chemical library or above its
 * estimated critical temperature at the tank temperature.
 */
export function tankContentsFor(source, chemical, temperatureK) {
  if (source.tankContents === "gas" || source.tankContents === "liquid") return source.tankContents;
  if (chemical?.isNonCondensableGas) return "gas";
  const tc = estimatedCriticalTemperatureK(source, chemical);
  if (tc && Number.isFinite(temperatureK) && temperatureK > tc) return "gas";
  return "liquid";
}

function tankAndHoleFromSource(source) {
  const tank = {
    shape: source.tankShape,
    diameter: Number(source.tankDiameter),
    length: Number(source.tankLength),
    fillFraction: Number(source.tankFillPercent) / 100,
  };
  const hole =
    source.holeShape === "rectangular"
      ? {
          shape: "rectangular",
          width: Number(source.holeWidth),
          height: Number(source.holeHeight),
          heightAboveBottom: Number(source.holeHeightAboveBottom),
          pipeLength: Number(source.pipeLength),
        }
      : {
          shape: "circular",
          diameter: Number(source.holeDiameter),
          heightAboveBottom: Number(source.holeHeightAboveBottom),
          pipeLength: Number(source.pipeLength),
        };
  return { tank, hole };
}

function compressedGasTankResult({ source, chemical, weather, notes }) {
  const pressureAtm = Number(source.tankPressureAtm);
  if (!(pressureAtm > 1)) {
    return { error: ["the tank pressure (absolute, greater than 1 atm) — enter it under Vessel"] };
  }
  const gamma = Number(source.gasHeatCapacityRatio);
  if (!(gamma > 1 && gamma <= 1.67)) {
    return { error: ["the gas's heat capacity ratio, between 1.0 and 1.67 — enter it under Vessel"] };
  }
  const ambientPressure = 101325;
  const tankPressure = pressureAtm * ambientPressure;
  const { tank, hole } = tankAndHoleFromSource(source);

  // Real-gas correction (2026-10-02) when the critical constants are known.
  const tc = criticalConstant(source, chemical, "criticalTemperatureK");
  const pc = criticalConstant(source, chemical, "criticalPressureBar");
  const tbForOmega = Number(source.boilingPointK) || Number(chemical.boilingPointK);
  let omega = criticalConstant(source, chemical, "acentricFactor");
  const omegaEstimated = !Number.isFinite(omega) && tc > 0 && pc > 0;
  if (omegaEstimated) omega = edmisterAcentricFactor(tbForOmega, tc, pc);
  const compressibilityFactor = tc > 0 && pc > 0
    ? pitzerCompressibility({
        temperature: weather.temperature, pressurePa: tankPressure,
        criticalTemperatureK: tc, criticalPressureBar: pc, acentricFactor: omega,
      })
    : 1;

  const run = simulateTankRelease({
    tank,
    hole,
    // Only the molecular weight, gamma and pressure enter the gas branch;
    // the liquid properties are placeholders it never reads.
    chemical: {
      molecularWeight: chemical.molecularWeight,
      boilingPointK: 1,
      heatOfVaporizationJPerMol: 1,
      liquidDensity: 1,
      liquidHeatCapacityJPerKgK: 1,
      gammaRatio: gamma,
      tankPressure,
      compressibilityFactor,
    },
    temperature: weather.temperature,
    storedPhase: "gas",
    ambientPressure,
    durationSeconds: 3600,
    timeStepSeconds: 1,
  });

  // The gas cools as it expands to atmospheric pressure (Tech Doc 3.4.6).
  // Taken at the starting tank pressure — the coldest, densest moment —
  // and not below the boiling point, where it would start to condense.
  const tb = Number(source.boilingPointK) || Number(chemical.boilingPointK);
  const expanded = expandedGasTemperatureWithGamma(weather.temperature, tankPressure, ambientPressure, gamma);
  const cloudTemperature = tb > 0 ? Math.max(expanded, tb) : expanded;

  notes.push(
    `The tank holds compressed gas only. It leaves the opening at the speed ` +
      `of sound while the tank pressure is high, and expands and cools to about ` +
      `${(cloudTemperature - 273.15).toFixed(0)} °C as it reaches atmospheric ` +
      `pressure — making it ${(
        (chemical.molecularWeight / 28.96) * (weather.temperature / cloudTemperature)
      ).toFixed(1)} times as dense as the surrounding air at first. ` +
      `Heat taken up from the tank walls during the release is neglected.`
  );
  if (tc > 0 && pc > 0) {
    notes.push(
      `Real-gas correction applied: compressibility factor Z = ${compressibilityFactor.toFixed(3)} ` +
        `(critical temperature ${tc.toFixed(1)} K, critical pressure ${pc.toFixed(2)} bar, ` +
        `acentric factor ${omega.toFixed(3)}${omegaEstimated ? ", estimated from the boiling point" : ""}), ` +
        `so the tank holds ${((1 / compressibilityFactor - 1) * 100).toFixed(1)}% ` +
        `${compressibilityFactor <= 1 ? "more" : "less"} than an ideal gas would.`
    );
  } else if (pressureAtm >= 10) {
    notes.push(
      "The tank's contents are computed as an ideal gas. At this pressure a real gas " +
        "can hold noticeably more (about 11% for methane at 50 atm). Enter the critical " +
        "temperature and pressure below (NIST Chemistry WebBook, \"Phase change data\") " +
        "for the exact amount."
    );
  }
  if (!run.emptied) {
    notes.push(
      `The release ends when the tank pressure falls to atmospheric; ` +
        `${(run.initialMass - run.totalReleased).toFixed(0)} kg stay in the tank.`
    );
  }

  const coldDensityApplies = chemical.molecularWeight >= COLD_DENSE_GAS_MIN_MW_FRACTION * 28.96;
  if (!coldDensityApplies) {
    notes.push(
      "This gas is much lighter than air, so its dispersion is not treated as " +
        "that of a dense cloud even though it leaves the tank cold."
    );
  }

  return {
    peakRate: run.peakRate,
    averageRate: run.averageRate,
    durationSeconds: run.durationSeconds,
    totalMass: run.totalReleased,
    series: run.series,
    regime: run.regime,
    tankMass: run.initialMass,
    compressibilityFactor,
    cloudTemperature,
    coldDensityApplies,
    notes,
  };
}

/**
 * Runs whichever source model the user selected and returns a uniform result
 * shape, so the results view does not need to know which model produced it.
 *
 * @returns {{ peakRate: number, averageRate: number, durationSeconds: number,
 *            totalMass: number, series: Array, regime: string, notes: string[] }}
 */
export function runSourceModel() {
  const source = currentSource();
  const { ready, missing, chemical, weather } = gatherModelInputs();

  if (!ready) {
    return { error: missing };
  }

  const notes = [];

  if (source.type === "direct") {
    const rate = Number(source.directRate);
    const duration = Number(source.directDuration);
    if (Number(source.directHeight) > 0) {
      notes.push(
        `Released ${Number(source.directHeight)} m above the ground. The Gaussian model ` +
          "follows the plume from that height, carried by the wind there; if the " +
          "cloud is dense enough for the heavy-gas model, it is treated as released at " +
          "ground level instead — the cautious choice."
      );
    }
    return {
      peakRate: rate,
      averageRate: rate,
      durationSeconds: duration,
      totalMass: rate * duration,
      series: [
        { t: 0, rate },
        { t: duration, rate },
      ],
      regime: "constant rate, as entered",
      notes,
    };
  }

  // A tank of compressed gas needs none of the liquid properties below.
  if (source.type === "tank") {
    const contents = tankContentsFor(source, chemical, weather.temperature);
    if (contents === "gas") return compressedGasTankResult({ source, chemical, weather, notes });
    const tc = estimatedCriticalTemperatureK(source, chemical);
    if (tc && weather.temperature > 1.03 * tc) {
      return {
        error: [
          `the tank contents set to "Gas only": at ${(weather.temperature - 273.15).toFixed(0)} °C ` +
            `this substance is above its critical temperature (about ` +
            `${(tc - 273.15).toFixed(0)} °C, estimated from its boiling point), so no ` +
            `pressure can hold it as a liquid`,
        ],
      };
    }
  }

  // Both remaining models need properties the PAC dataset does not supply.
  // A custom chemical library entry (customChemicalStore.js) can carry these
  // directly — see the Chemical library page — so a value already saved
  // there fills the field automatically; the manual entry below is only
  // needed when neither this scenario nor the saved chemical record has it.
  const liquidDensity = Number(source.liquidDensity) || Number(chemical.liquidDensity);
  const liquidHeatCapacity = Number(source.liquidHeatCapacity) || Number(chemical.liquidHeatCapacity);

  if (!Number.isFinite(liquidDensity) || liquidDensity <= 0) {
    return { error: ["a liquid density — enter it below"] };
  }
  if (!Number.isFinite(liquidHeatCapacity) || liquidHeatCapacity <= 0) {
    return { error: ["a liquid heat capacity — enter it below"] };
  }

  // The PAC-derived record carries a boiling point and a heat of
  // vaporisation for most liquids; fall back to a saved custom-chemical
  // value next, and only then to the manual entry field / a generic default.
  const chemicalProperties = {
    molecularWeight: chemical.molecularWeight,
    boilingPointK: Number(source.boilingPointK) || Number(chemical.boilingPointK) || 373.15,
    heatOfVaporizationJPerMol: Number(source.heatOfVaporization) || Number(chemical.heatOfVaporization) || 40000,
    liquidDensity,
    liquidHeatCapacityJPerKgK: liquidHeatCapacity,
    gammaRatio: 1.3,
  };

  const weatherForModel = {
    windSpeed10m: weather.windSpeed10m,
    powerLawExponent: WIND_PROFILE_EXPONENTS[weather.stabilityClass],
    roughnessLength: weather.roughnessLength,
    airTemperatureK: weather.temperature,
    relativeHumidity: weather.relativeHumidity,
    cloudCoverOktas: Number(state.current.scenario.weather?.cloudCoverOktas ?? 4),
  };

  if (source.type === "puddle") {
    const run = simulatePuddleEvaporation({
      chemical: chemicalProperties,
      weather: weatherForModel,
      spillMass: Number(source.puddleMass),
      puddleArea: Number(source.puddleArea),
      substrateKey: source.substrate,
      solarElevationDegrees: solarElevationForScenario(),
      durationSeconds: 3600,
      timeStepSeconds: 1,
    });

    if (!run.fullyEvaporated) {
      notes.push(
        "The puddle had not fully evaporated after an hour. The rate shown is " +
          "what it sustained over that period."
      );
    }

    return {
      peakRate: run.peakRate,
      averageRate: run.averageRate,
      durationSeconds: run.durationSeconds,
      totalMass: run.totalEvaporated,
      series: run.series,
      regime: "evaporating puddle",
      notes,
    };
  }

  // Tank (liquid or liquefied gas)
  const { tank, hole } = tankAndHoleFromSource(source);

  const run = simulateTankRelease({
    tank,
    hole,
    chemical: chemicalProperties,
    temperature: weather.temperature,
    // Always "liquid" here — NOT derived from the chemical's natural state
    // at 25C/1atm. That distinction matters: propane, chlorine, ammonia,
    // and butane are all "gas" at 25C and 1 atm, but in an actual ADR tank
    // they are stored as LIQUID, kept that way by their own vapour
    // pressure — exactly the "liquefied gas under pressure" case
    // selectReleaseModel()'s own documentation names propane and chlorine
    // as examples of. An earlier version of this line used
    // chemical.state25C to decide, which sent every one of those — some of
    // the most common substances this tool exists to model — into the pure
    // compressed-gas venting equations instead, with a vapour pressure and
    // flow rate that made no physical sense for what is actually a liquid
    // in the tank. selectReleaseModel() already compares the tank
    // temperature against the substance's own boiling point to choose
    // between "liquid" (below its boiling point, an ordinary liquid spill)
    // and "twoPhase" (at or above it, a flashing liquefied gas) — passing
    // "liquid" here every time lets that comparison do the actual work, as
    // the wizard's own description of this step ("drains as liquid,
    // flashes as a two-phase jet, or vents gas depending on the contents")
    // already promised it would.
    storedPhase: "liquid",
    durationSeconds: 7200,
    timeStepSeconds: 1,
  });

  if (run.regime?.includes("two-phase")) {
    notes.push(
      "The contents are stored above their boiling point, so the release " +
        "flashes as it escapes. All of it is assumed to enter " +
        "the air rather than partly raining out — a deliberate overestimate."
    );
    // 2026-10-02 (ALOHA run N1, ammonia tank): ALOHA treats the cold
    // aerosol of a flashing gas lighter than air as a heavy gas; HAZEL
    // keeps the Gaussian model, whose zones were the closer of the two
    // (0.91 / 0.94 / 0.93 of ALOHA's, against 1.0-1.1 / 0.92 / 0.80 for
    // HAZEL's heavy-gas model).
    if (chemical.molecularWeight < 28.96) {
      notes.push(
        "The cold aerosol cloud of a flashing gas lighter than air (such as " +
          "ammonia) is often modelled as a dense gas. HAZEL uses the Gaussian " +
          "model here, which matched the reference results more closely in the " +
          "comparison tests (within 10% for an ammonia tank — see About); the " +
          "zone outline is narrower and longer than a dense-cloud model would draw."
      );
    }
  }

  // 2026-10-01: a liquid stored below its boiling point does not go into
  // the air as it leaves the hole — it forms a puddle that then evaporates
  // (Tech Doc 3.4: "for non-boiling liquids, the tank release rate is
  // linked to a puddle evaporation model"; 3.4.4: "ALOHA calculates the
  // release of the liquid from the tank, the puddle formation, and the
  // evaporation rate from the puddle"). Before this, the DRAIN rate was
  // passed on as the airborne rate — for acetone through a 5 cm hole,
  // 1.5 kg/s instead of the ~0.04 kg/s a 10 m2 puddle actually evaporates.
  if (run.regime === "liquid (Bernoulli)") {
    return tankFedPuddleResult({ run, source, chemicalProperties, weatherForModel, weather, notes });
  }

  if (!run.emptied) {
    notes.push("The tank had not emptied when the simulation ended.");
  }

  return {
    peakRate: run.peakRate,
    averageRate: run.averageRate,
    durationSeconds: run.durationSeconds,
    totalMass: run.totalReleased,
    series: run.series,
    regime: run.regime,
    notes,
  };
}

/**
 * The airborne source for a tank holding a liquid below its boiling point:
 * the liquid drained from the tank (simulateTankRelease) feeds a spreading,
 * evaporating puddle (simulateSpreadingPuddle), and it is the puddle's
 * EVAPORATION rate that reaches the dispersion model.
 *
 * The tank's drain series is sampled once a minute; the rate is held over
 * each minute (it changes slowly — the head above the hole falls only
 * gradually) and drops to zero once the tank stops delivering. Like every
 * other source here, the airborne release is followed for one hour.
 */
function tankFedPuddleResult({ run, source, chemicalProperties, weatherForModel, weather, notes }) {
  const drainSeries = run.series;
  const inflowAt = (t) => {
    if (t >= run.durationSeconds || drainSeries.length === 0) return 0;
    const sample = drainSeries[Math.min(Math.floor(t / 60), drainSeries.length - 1)];
    return sample.rate;
  };

  const maxArea = Number(source.tankMaxPuddleArea);
  const hasLimit = source.tankMaxPuddleArea !== "" && source.tankMaxPuddleArea != null &&
    Number.isFinite(maxArea) && maxArea > 0;

  const puddle = simulateSpreadingPuddle({
    chemical: chemicalProperties,
    weather: weatherForModel,
    inflowAt,
    inflowTemperature: weather.temperature,
    maxPuddleArea: hasLimit ? maxArea : null,
    sourceInventory: run.initialMass,
    substrateKey: source.substrate,
    solarElevationDegrees: solarElevationForScenario(),
    durationSeconds: 3600,
    timeStepSeconds: 1,
  });

  notes.push(
    `The liquid leaves the tank at up to ${run.peakRate.toFixed(2)} kg/s and forms a ` +
      `puddle (${puddle.puddleArea.toFixed(0)} m², ${puddle.puddleDiameter.toFixed(1)} m across). ` +
      "Only what evaporates from the puddle enters the air, and that is the rate shown here."
  );
  if (!hasLimit) {
    notes.push(
      "No maximum puddle area was given, so the puddle spreads until it is 5 mm deep. " +
        "If a bund, kerb or the edge of a paved area would stop it, enter that area — " +
        "the evaporation rate scales with it."
    );
  }
  if (puddle.puddleMassLeft > 1) {
    notes.push(
      `After an hour ${puddle.puddleMassLeft.toFixed(0)} kg of liquid is still on the ground ` +
        "and still evaporating; the release is followed for one hour."
    );
  }

  return {
    peakRate: puddle.peakRate,
    averageRate: puddle.averageRate,
    durationSeconds: puddle.durationSeconds,
    totalMass: puddle.totalEvaporated,
    series: puddle.series,
    regime: "liquid (Bernoulli) feeding an evaporating puddle",
    puddleArea: puddle.puddleArea,
    puddleDiameter: puddle.puddleDiameter,
    tankDrainPeakRate: run.peakRate,
    tankDrainedMass: puddle.totalInflow,
    notes,
  };
}

/**
 * Applies the Richardson criterion to the computed release, answering the
 * question the Chemical step deliberately left open.
 *
 * @param {object} result - output of runSourceModel()
 * @returns {object|null} the dispersion model verdict, or null if not computable
 */
export function assessDispersionModel(result) {
  const { chemical, weather, ready } = gatherModelInputs();
  if (!ready || !result || result.error || !result.peakRate) return null;

  const source = currentSource();

  // A characteristic source dimension is needed. For a puddle it is the
  // puddle diameter; for a tank, the hole's own diameter — both are real
  // physical dimensions of the opening the material escapes through.
  //
  // A direct release is different: per the ALOHA Tech Doc (section 4.4.3,
  // "Secondary Source in ALOHA"), "Most of the Primary Sources in ALOHA are
  // point sources; however, the evaporating puddle has a defined area" — a
  // direct/continuous source is explicitly NOT one of the sources ALOHA
  // gives an area to. It has no physical opening size at all: the number
  // entered on this step is a rate, not a hole. Earlier versions of this
  // function stood in a fictional 1 m nominal diameter here (to have
  // *something* to hand to a formula written for a puddle), which does not
  // affect the Richardson-number screening below — see
  // characteristicSourceHeight() in engineDispersionChoice.js, whose
  // non-puddle formula has no diameter term — but does leak downstream:
  // buildDispersionScenario() turns this same value into the heavy-gas
  // march's STARTING footprint radius (sourceHalfWidth), where a fictional
  // half-metre floor measurably shrinks the computed threat zone for a
  // fast, short direct release compared to ALOHA's true point-source
  // treatment. Zero here (clamped to a small positive floor just below,
  // and again by buildDispersionScenario()'s own floor) is the correct,
  // Tech-Doc-faithful value.
  let sourceDiameter;
  if (source.type === "puddle") {
    sourceDiameter = Math.sqrt((4 * Number(source.puddleArea)) / Math.PI);
  } else if (source.type === "tank" && Number.isFinite(result.puddleDiameter)) {
    // A liquid tank release whose airborne source is the puddle it forms
    // (see tankFedPuddleResult()): the puddle, not the hole, is the source.
    sourceDiameter = result.puddleDiameter;
  } else if (source.type === "tank") {
    sourceDiameter =
      source.holeShape === "rectangular"
        ? Math.sqrt(Number(source.holeWidth) * Number(source.holeHeight))
        : Number(source.holeDiameter);
  } else {
    sourceDiameter = 0;
  }

  const dispersion = chooseDispersionModel({
    molecularWeight: chemical.molecularWeight,
    releaseRate: result.peakRate,
    sourceDiameter: Math.max(sourceDiameter, 0.01),
    windSpeed10m: weather.windSpeed10m,
    roughnessLength: weather.roughnessLength,
    temperature: weather.temperature,
    // An expanded compressed gas enters the air cold (compressedGasTankResult()).
    cloudTemperature:
      Number.isFinite(result.cloudTemperature) && result.coldDensityApplies !== false ? result.cloudTemperature : null,
    isPuddle: source.type === "puddle" || Number.isFinite(result.puddleDiameter),
  });

  // Exposed so the Results step's heavy-gas branch does not need to
  // re-derive the source geometry from the raw source-type fields itself.
  // The user's model choice (source.modelOverride, 2026-10-04) is applied
  // here, so the Source step, Results, the VCE flammable mass and the PDF
  // all follow the same, possibly overridden, verdict.
  return {
    ...applyModelOverride(dispersion, source.modelOverride),
    sourceDiameter: Math.max(sourceDiameter, 0.01),
  };
}

/**
 * Assembles the shared inputs that BOTH the Results step's threat-zone
 * drawing (stepResults.js's computeZones()) and the fire/explosion panel's
 * VCE flammable-mass integration (fireExplosionPanel.js, via
 * engineFlammableMass.js) need: which dispersion model applies (the
 * Richardson-number verdict from assessDispersionModel()) and the exact
 * parameter object that model's own functions expect.
 *
 * Factored out here — rather than each of those two call sites building
 * its own copy of this object, as stepResults.js used to do alone before
 * the VCE panel also needed it (2026-09-22) — because the two calculations
 * must agree on exactly which dispersion field they are each drawing from.
 * A flammable mass integrated over a scenarioBase that had quietly drifted
 * out of sync with the one the map draws would not describe the same cloud
 * a person is looking at on screen.
 *
 * @returns {{status: "incomplete", missing: string[]}
 *          |{status: "ok", isHeavyGas: boolean, scenarioBase: object,
 *            dispersion: object, chemical: object, weather: object}}
 */
export function buildDispersionScenario() {
  const { ready, missing, chemical, weather } = gatherModelInputs();
  if (!ready) return { status: "incomplete", missing };

  const source = currentSource();
  if (!source?.result?.peakRate) {
    return { status: "incomplete", missing: ["a computed release rate, from the Source step"] };
  }

  const dispersion = assessDispersionModel(source.result);
  const isHeavyGas = dispersion?.model === "heavyGas";

  // The release rate varies over time (see the puddle and tank models). Both
  // dispersion engines receive the peak rate (used for the Richardson
  // screening and as a fallback) and, for a puddle or tank, the release as
  // up to five steady steps (releaseSteps) which they follow in time.
  const scenarioBase = isHeavyGas
    ? {
        releaseRate: source.result.peakRate,
        // As of 2026-09-26: engineHeavyGas.js's marchDownwind() now applies
        // a finite-duration correction (see its module docstring), so this
        // needs to reach it exactly the way it already reaches the
        // Gaussian branch below — same field, same 1-hour cap.
        releaseDuration: Math.min(source.result.durationSeconds, 3600),
        molecularWeight: chemical.molecularWeight,
        temperature: weather.temperature,
        windSpeed10m: weather.windSpeed10m,
        roughnessLength: weather.roughnessLength,
        stabilityClass: weather.stabilityClass,
        // Half of the same characteristic source dimension the Richardson
        // number screening already used — see assessDispersionModel()
        // above, which exposes it for exactly this purpose. For a tank or
        // puddle this is a real physical half-width; for a direct release
        // assessDispersionModel() now hands through a near-zero value (a
        // true point source, per the ALOHA Tech Doc — see the comment
        // there), and the 0.05 m here is only a numerical floor to avoid
        // starting the march at a literal zero radius, not a stand-in
        // physical size the way the old 0.5 m (half of a fictional 1 m
        // nominal diameter) used to be.
        sourceHalfWidth: Math.max(dispersion.sourceDiameter / 2, 0.05),
        characteristicHeight: dispersion.characteristicHeight,
        // 2026-09-30: a puddle or tank release is passed on as up to five
        // steady steps rather than its one-second peak held for the whole
        // duration — see heavyGasReleaseSteps() below and compositeMarch()
        // in engineHeavyGas.js. A direct release (constant by definition)
        // gets no steps and behaves exactly as before.
        releaseSteps: heavyGasReleaseSteps(source, dispersion),
        // A compressed gas enters the air cold and dense (2026-10-02).
        sourceTemperature: Number.isFinite(source.result.cloudTemperature) && source.result.coldDensityApplies !== false
          ? source.result.cloudTemperature
          : undefined,
      }
    : {
        releaseRate: source.result.peakRate,
        releaseDuration: Math.min(source.result.durationSeconds, 3600),
        // Only a direct release can be elevated (as in ALOHA, Tech Doc 3.2);
        // the transport wind is then taken at that height (2026-10-02, see
        // gaussianTransportWindSpeed() in engineGaussian.js).
        releaseHeight: source.type === "direct" ? Math.max(0, Number(source.directHeight) || 0) : 0,
        stabilityClass: weather.stabilityClass,
        roughnessLength: weather.roughnessLength,
        temperature: weather.temperature,
        molecularWeight: chemical.molecularWeight,
        windSpeed10m: weather.windSpeed10m,
        inversionHeight: weather.inversionHeight,
        // 2026-10-01: a puddle (or the puddle a tank forms) is an area
        // source — its diameter widens the plume near the source (see
        // AREA_SOURCE_NOTE in engineGaussian.js); a hole or direct release
        // stays a point. And, as for the heavy-gas model, a time-varying
        // release is passed as up to five steady steps rather than its peak
        // held throughout (Tech Doc 4.3).
        sourceWidth:
          source.type === "puddle" || Number.isFinite(source.result.puddleDiameter)
            ? dispersion.sourceDiameter
            : 0,
        releaseSteps: heavyGasReleaseSteps(source, dispersion),
      };

  return { status: "ok", isHeavyGas, scenarioBase, dispersion, chemical, weather };
}


/**
 * The time-varying source, reduced to at most five steady steps for the
 * heavy-gas model (engineHeavyGas.js's releaseStepsFromSeries() and
 * compositeMarch()). Returns undefined for a direct release, or when there is
 * no usable time series, so the dispersion model falls back to its
 * single-rate behaviour.
 *
 * Each step needs its own characteristic height: for a puddle the Tech Doc
 * formula H = E / (rho U10 D) is linear in the rate E; for a jet or hole
 * release, H = sqrt(E pi / (4 rho U10)), it scales with sqrt(E) — see
 * characteristicSourceHeight() in engineDispersionChoice.js. Both are taken
 * here by scaling the value already computed for the peak rate.
 *
 * The mass at t = 0 is recovered from the first recorded sample (mass left
 * after the first second, plus the rate during that second), so a result
 * saved before this field existed still works.
 */
function heavyGasReleaseSteps(source, dispersion) {
  const result = source?.result;
  if (!result || source.type === "direct") return undefined;
  const series = result.series;
  if (!Array.isArray(series) || series.length < 3) return undefined;

  const first = series[0];
  const remainingFirst = first.remaining ?? first.remainingMass;
  if (!Number.isFinite(remainingFirst) || !Number.isFinite(first.rate)) return undefined;
  const initialMass = remainingFirst + first.rate;

  const peak = result.peakRate;
  const peakHeight = dispersion.characteristicHeight;
  const isPuddle = source.type === "puddle" || Number.isFinite(result.puddleDiameter);
  const heightOf =
    Number.isFinite(peakHeight) && peak > 0
      ? (rate) => (isPuddle ? peakHeight * (rate / peak) : peakHeight * Math.sqrt(rate / peak))
      : undefined;

  const steps = releaseStepsFromSeries({
    series,
    initialMass,
    totalMass: result.totalMass,
    durationSeconds: result.durationSeconds,
    heightOf,
  });
  return steps.length > 1 ? steps : undefined;
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function typeSelectorHtml(source) {
  const types = [
    {
      id: "direct",
      title: "Direct",
      desc: "State the release rate and duration outright. Use when the rate is known, or to explore how the zones respond to it.",
    },
    {
      id: "puddle",
      title: "Evaporating puddle",
      desc: "A spill of known size evaporating from the ground. Rate falls as the liquid cools itself by evaporating.",
    },
    {
      id: "tank",
      title: "Ruptured tank",
      desc: "A vessel draining through a hole. Drains as liquid, flashes as a two-phase jet, or vents gas depending on the contents.",
    },
  ];

  return `
    <div class="source-type-grid">
      ${types.map((t) => `
        <button type="button" class="choice-card" data-source-type="${t.id}"
                aria-pressed="${source.type === t.id}">
          <span class="choice-card__title">${t.title}</span>
          <span class="choice-card__desc">${t.desc}</span>
        </button>`).join("")}
    </div>`;
}

function directFormHtml(source) {
  return `
    <div class="field-grid">
      <div class="field">
        <label for="src-rate">Release rate</label>
        <div class="input-pair">
          <input type="number" id="src-rate" step="0.01" min="0"
                 value="${source.directRate}" data-field="directRate" />
          <span class="input-suffix">kg/s</span>
        </div>
      </div>
      <div class="field">
        <label for="src-duration">Duration</label>
        <div class="input-pair">
          <input type="number" id="src-duration" step="10" min="1"
                 value="${source.directDuration}" data-field="directDuration" />
          <span class="input-suffix">s</span>
        </div>
        <div class="field__hint">The dispersion model covers releases up to one hour.</div>
      </div>
      <div class="field">
        <label for="src-height">Source height</label>
        <div class="input-pair">
          <input type="number" id="src-height" step="1" min="0"
                 value="${source.directHeight ?? 0}" data-field="directHeight" />
          <span class="input-suffix">m</span>
        </div>
        <div class="field__hint">
          Height of the release above the ground (a stack, a vent on a
          roof). Only the Gaussian model can use it; a dense gas is always
          treated as released at ground level.
        </div>
      </div>
    </div>`;
}

function substrateOptionsHtml(source) {
  return Object.entries(SUBSTRATE_PROPERTIES)
    .map(([key, s]) => `<option value="${key}"${source.substrate === key ? " selected" : ""}>${s.label}</option>`)
    .join("");
}

function puddleFormHtml(source) {
  const substrateOptions = substrateOptionsHtml(source);

  return `
    <div class="field-grid">
      <div class="field">
        <label for="src-puddle-mass">Spilled mass</label>
        <div class="input-pair">
          <input type="number" id="src-puddle-mass" step="1" min="0"
                 value="${source.puddleMass}" data-field="puddleMass" />
          <span class="input-suffix">kg</span>
        </div>
      </div>
      <div class="field">
        <label for="src-puddle-area">Puddle area</label>
        <div class="input-pair">
          <input type="number" id="src-puddle-area" step="1" min="0.1"
                 value="${source.puddleArea}" data-field="puddleArea" />
          <span class="input-suffix">m²</span>
        </div>
        <div class="field__hint">
          The area the spill actually covers. Where bunding, kerbs or a spill
          tray confine it, use that area.
        </div>
      </div>
      <div class="field">
        <label for="src-substrate">Ground surface</label>
        <select id="src-substrate" data-field="substrate">${substrateOptions}</select>
        <div class="field__hint">Determines how much heat the ground feeds the puddle.</div>
      </div>
    </div>`;
}

function tankFormHtml(source) {
  const volume = (() => {
    try {
      return tankVolume({
        shape: source.tankShape,
        diameter: Number(source.tankDiameter),
        length: Number(source.tankLength),
      });
    } catch { return null; }
  })();

  const isRect = source.holeShape === "rectangular";
  const { chemical, weather } = gatherModelInputs();
  const isGas = tankContentsFor(source, chemical, weather?.temperature) === "gas";
  const autoNote = !source.tankContents
    ? `<div class="field__hint">Chosen automatically from the substance${isGas
        ? " — it is above its critical temperature, so it can only be held as a compressed gas"
        : ""}; change it if the tank holds something else.</div>`
    : "";

  return `
    <h3>Vessel</h3>
    <div class="field-grid">
      <div class="field">
        <label for="src-tank-contents">Contents</label>
        <select id="src-tank-contents" data-field="tankContents">
          <option value="liquid"${!isGas ? " selected" : ""}>Liquid, or gas liquefied under pressure</option>
          <option value="gas"${isGas ? " selected" : ""}>Gas only (compressed)</option>
        </select>
        ${autoNote}
      </div>
      <div class="field" ${isGas ? "" : 'style="display:none"'}>
        <label for="src-tank-pressure">Tank pressure (absolute)</label>
        <div class="input-pair">
          <input type="number" id="src-tank-pressure" step="0.1" min="1"
                 value="${source.tankPressureAtm ?? ""}" data-field="tankPressureAtm" placeholder="required" />
          <span class="input-suffix">atm</span>
        </div>
        <div class="field__hint">1 atm = 1.013 bar. A gauge reading plus one atmosphere.</div>
      </div>
      <div class="field" ${isGas ? "" : 'style="display:none"'}>
        <label for="src-gas-gamma">Heat capacity ratio (γ)</label>
        <input type="number" id="src-gas-gamma" step="0.01" min="1.01" max="1.67"
               value="${source.gasHeatCapacityRatio ?? 1.4}" data-field="gasHeatCapacityRatio" />
        <div class="field__hint">1.4 for carbon monoxide, nitrogen, oxygen, hydrogen and air; about 1.3 for methane.</div>
      </div>
      <div class="field" ${isGas ? "" : 'style="display:none"'}>
        <label for="src-tc">Critical temperature (optional)</label>
        <div class="input-pair">
          <input type="number" id="src-tc" step="0.1" min="1"
                 value="${source.criticalTemperatureK ?? ""}" data-field="criticalTemperatureK"
                 placeholder="${Number.isFinite(Number(chemical?.criticalTemperatureK)) && chemical?.criticalTemperatureK !== null ? chemical.criticalTemperatureK : "not known"}" />
          <span class="input-suffix">K</span>
        </div>
      </div>
      <div class="field" ${isGas ? "" : 'style="display:none"'}>
        <label for="src-pc">Critical pressure (optional)</label>
        <div class="input-pair">
          <input type="number" id="src-pc" step="0.01" min="1"
                 value="${source.criticalPressureBar ?? ""}" data-field="criticalPressureBar"
                 placeholder="${Number.isFinite(Number(chemical?.criticalPressureBar)) && chemical?.criticalPressureBar !== null ? chemical.criticalPressureBar : "not known"}" />
          <span class="input-suffix">bar</span>
        </div>
        <div class="field__hint">
          Both from the NIST Chemistry WebBook (webbook.nist.gov) → the
          substance → "Phase change data" → Tc and Pc. With them HAZEL
          corrects the tank's contents for real-gas behaviour, which matters
          at high pressure (methane at 50 atm: +11%). Values saved in the
          Chemical library are used automatically.
        </div>
      </div>
      <div class="field" ${isGas ? "" : 'style="display:none"'}>
        <label for="src-omega">Acentric factor ω (optional)</label>
        <input type="number" id="src-omega" step="0.001"
               value="${source.acentricFactor ?? ""}" data-field="acentricFactor" placeholder="estimated if empty" />
        <div class="field__hint">Not on the WebBook. Leave empty to estimate it from the boiling point, Tc and Pc.</div>
      </div>
      <div class="field">
        <label for="src-tank-shape">Shape</label>
        <select id="src-tank-shape" data-field="tankShape">
          <option value="horizontalCylinder"${source.tankShape === "horizontalCylinder" ? " selected" : ""}>Horizontal cylinder</option>
          <option value="verticalCylinder"${source.tankShape === "verticalCylinder" ? " selected" : ""}>Vertical cylinder</option>
          <option value="sphere"${source.tankShape === "sphere" ? " selected" : ""}>Sphere</option>
        </select>
      </div>
      <div class="field">
        <label for="src-tank-diameter">Diameter</label>
        <div class="input-pair">
          <input type="number" id="src-tank-diameter" step="0.1" min="0.1"
                 value="${source.tankDiameter}" data-field="tankDiameter" />
          <span class="input-suffix">m</span>
        </div>
      </div>
      <div class="field" ${source.tankShape === "sphere" ? 'style="display:none"' : ""}>
        <label for="src-tank-length">Length</label>
        <div class="input-pair">
          <input type="number" id="src-tank-length" step="0.1" min="0.1"
                 value="${source.tankLength}" data-field="tankLength" />
          <span class="input-suffix">m</span>
        </div>
      </div>
      <div class="field" ${isGas ? 'style="display:none"' : ""}>
        <label for="src-tank-fill">Filled to</label>
        <div class="input-pair">
          <input type="number" id="src-tank-fill" step="1" min="0" max="100"
                 value="${source.tankFillPercent}" data-field="tankFillPercent" />
          <span class="input-suffix">%</span>
        </div>
        ${volume ? `<div class="field__hint" id="tank-capacity-hint">Capacity ${volume.toFixed(1)} m³ (${(volume * 1000).toFixed(0)} litres)</div>` : `<div class="field__hint" id="tank-capacity-hint"></div>`}
      </div>
    </div>

    <h3 style="margin-top: var(--space-6);">Rupture</h3>
    <div class="field-grid">
      <div class="field">
        <label for="src-hole-shape">Opening shape</label>
        <select id="src-hole-shape" data-field="holeShape">
          <option value="circular"${!isRect ? " selected" : ""}>Circular</option>
          <option value="rectangular"${isRect ? " selected" : ""}>Rectangular</option>
        </select>
      </div>

      <div class="field" ${isRect ? 'style="display:none"' : ""} data-hole="circular">
        <label for="src-hole-diameter">Opening diameter</label>
        <div class="input-pair">
          <input type="number" id="src-hole-diameter" step="0.001" min="0.001"
                 value="${source.holeDiameter}" data-field="holeDiameter" />
          <span class="input-suffix">m</span>
        </div>
      </div>

      <div class="field" ${isRect ? "" : 'style="display:none"'} data-hole="rectangular">
        <label for="src-hole-width">Opening length</label>
        <div class="input-pair">
          <input type="number" id="src-hole-width" step="0.01" min="0.001"
                 value="${source.holeWidth}" data-field="holeWidth" />
          <span class="input-suffix">m</span>
        </div>
      </div>

      <div class="field" ${isRect ? "" : 'style="display:none"'} data-hole="rectangular">
        <label for="src-hole-height">Opening width</label>
        <div class="input-pair">
          <input type="number" id="src-hole-height" step="0.001" min="0.0001"
                 value="${source.holeHeight}" data-field="holeHeight" />
          <span class="input-suffix">m</span>
        </div>
      </div>

      <div class="field">
        <label for="src-hole-position">Height above tank bottom</label>
        <div class="input-pair">
          <input type="number" id="src-hole-position" step="0.01" min="0"
                 value="${source.holeHeightAboveBottom}" data-field="holeHeightAboveBottom" />
          <span class="input-suffix">m</span>
        </div>
        <div class="field__hint">
          A low opening drains more of the tank and under greater head. Liquid
          below the opening cannot escape.
        </div>
      </div>

      <div class="field">
        <label for="src-pipe">Pipe or valve length</label>
        <div class="input-pair">
          <input type="number" id="src-pipe" step="0.01" min="0" max="0.1"
                 value="${source.pipeLength}" data-field="pipeLength" />
          <span class="input-suffix">m</span>
        </div>
        <div class="field__hint">Zero for a hole in the wall. Up to 0.10 m for a short pipe or valve.</div>
      </div>
    </div>

    <div ${isGas ? 'style="display:none"' : ""}>
    <h3 style="margin-top: var(--space-6);">Where the liquid lands</h3>
    <p class="field__hint">
      Used only when the contents are a liquid below their boiling point
      (acetone, methanol, petrol): such a liquid forms a puddle, and it is
      the puddle's evaporation that enters the air. A liquefied gas
      (chlorine, ammonia, propane) flashes as it escapes and ignores these.
    </p>
    <div class="field-grid">
      <div class="field">
        <label for="src-tank-max-puddle">Maximum puddle area</label>
        <div class="input-pair">
          <input type="number" id="src-tank-max-puddle" step="1" min="0.1"
                 value="${source.tankMaxPuddleArea ?? ""}" data-field="tankMaxPuddleArea"
                 placeholder="not known" />
          <span class="input-suffix">m²</span>
        </div>
        <div class="field__hint">
          The area a bund, kerb or the edge of a paved yard would confine the
          liquid to. Leave empty if not known: the puddle then spreads until
          it is 5 mm deep, which can be very large.
        </div>
      </div>
      <div class="field">
        <label for="src-tank-substrate">Ground surface</label>
        <select id="src-tank-substrate" data-field="substrate">${substrateOptionsHtml(source)}</select>
        <div class="field__hint">Determines how much heat the ground feeds the puddle.</div>
      </div>
    </div>
    </div>`;
}

/**
 * Fields for properties the PAC dataset does not carry.
 *
 * These follow the pattern set in the chemical database: rather than guessing
 * a value or refusing to run, the interface says what is missing and where to
 * find it. The help text is the same wording used in the database records, so
 * it cannot drift out of step with them.
 */
function manualPropertiesHtml(source) {
  const chemical = state.current.scenario.chemical?.selected;
  const name = chemical ? escapeHtml(chemical.name) : "the selected substance";

  return `
    <div class="panel panel--derived" style="margin-top: var(--space-6);">
      <h3>Properties that must be supplied</h3>
      <p>
        The exposure-threshold dataset HAZEL ships does not carry these, and
        they cannot be derived from what it does carry. Look them up for
        ${name} and enter them here.
      </p>

      <div class="field-grid">
        <div class="field">
          <label for="src-density">
            Liquid density
            <button type="button" class="help-button" data-help="density" aria-label="Where to find this">?</button>
          </label>
          <div class="input-pair">
            <input type="number" id="src-density" step="1" min="1"
                   value="${source.liquidDensity ?? ""}" data-field="liquidDensity"
                   placeholder="e.g. 876" />
            <span class="input-suffix">kg/m³</span>
          </div>
          <div class="field__hint" data-help-text="density" hidden>
            NIST Chemistry WebBook → search by CAS number → Phase change data,
            or CAMEO Chemicals → Physical Properties → Specific Gravity
            (multiply by 1000 to get kg/m³).
          </div>
        </div>

        <div class="field">
          <label for="src-heat-capacity">
            Liquid heat capacity
            <button type="button" class="help-button" data-help="cp" aria-label="Where to find this">?</button>
          </label>
          <div class="input-pair">
            <input type="number" id="src-heat-capacity" step="1" min="1"
                   value="${source.liquidHeatCapacity ?? ""}" data-field="liquidHeatCapacity"
                   placeholder="e.g. 1740" />
            <span class="input-suffix">J/(kg·K)</span>
          </div>
          <div class="field__hint" data-help-text="cp" hidden>
            NIST Chemistry WebBook → Condensed phase thermochemistry data →
            "Constant pressure heat capacity of liquid" → average the values
            listed at 298.15 K, then divide by the molecular weight in kg/mol
            to convert from J/(mol·K).
          </div>
        </div>

        <div class="field">
          <label for="src-boiling">
            Boiling point
            <button type="button" class="help-button" data-help="boiling" aria-label="Where to find this">?</button>
          </label>
          <div class="input-pair">
            <input type="number" id="src-boiling" step="0.1"
                   value="${source.boilingPointK ?? ""}" data-field="boilingPointK"
                   placeholder="e.g. 353.25" />
            <span class="input-suffix">K</span>
          </div>
          <div class="field__hint" data-help-text="boiling" hidden>
            CAMEO Chemicals → search by CAS number → Physical Properties →
            Boiling Point. Convert °C to K by adding 273.15 (°F: see the
            Weather step's unit converter for the general formula).
          </div>
        </div>

        <div class="field">
          <label for="src-hvap">
            Heat of vaporisation
            <button type="button" class="help-button" data-help="hvap" aria-label="Where to find this">?</button>
          </label>
          <div class="input-pair">
            <input type="number" id="src-hvap" step="100" min="1"
                   value="${source.heatOfVaporization ?? ""}" data-field="heatOfVaporization"
                   placeholder="e.g. 30720" />
            <span class="input-suffix">J/mol</span>
          </div>
          <div class="field__hint" data-help-text="hvap" hidden>
            NIST Chemistry WebBook → search by CAS number → Phase change data →
            the summary table near the top lists "ΔvapH°" (enthalpy of
            vaporisation) in kJ/mol, sometimes at more than one temperature —
            use the value AT (or closest to) the boiling point above, not the
            25 °C value, which is several kJ/mol higher and would make the
            evaporation too low. Multiply by 1000 to convert kJ/mol to the
            J/mol this field expects.
          </div>
        </div>
      </div>
    </div>`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function resultHtml(result, dispersion) {
  if (!result) return "";

  if (result.error) {
    return `
      <div class="banner banner--info">
        <span>To compute a release rate HAZEL still needs: ${result.error.map(escapeHtml).join("; ")}.</span>
      </div>`;
  }

  const notes = result.notes
    .map((n) => `<div class="banner banner--info"><span>${escapeHtml(n)}</span></div>`)
    .join("");

  // The dispersion verdict is the most consequential line on this screen: it
  // says whether the numbers that follow can be trusted at all.
  const verdict = dispersion
    ? `<div class="banner banner--${dispersion.model === "heavyGas" ? "warning" : "info"}">
         <span>${escapeHtml(dispersion.explanation)}</span>
       </div>`
    : "";

  return `
    <div class="panel" style="margin-top: var(--space-6);">
      <h3>Computed source strength</h3>

      <dl class="readout">
        <div><dt>Model used</dt><dd>${escapeHtml(result.regime)}</dd></div>
        <div><dt>Peak rate</dt><dd>${result.peakRate.toFixed(3)} kg/s</dd></div>
        <div><dt>Average rate</dt><dd>${result.averageRate.toFixed(3)} kg/s</dd></div>
        <div><dt>Duration</dt><dd>${formatDuration(result.durationSeconds)}</dd></div>
        <div><dt>Total released</dt><dd>${result.totalMass.toFixed(0)} kg</dd></div>
        ${Number.isFinite(result.tankMass)
          ? `<div><dt>Gas in the tank</dt><dd>${result.tankMass.toFixed(0)} kg${
               Number.isFinite(result.compressibilityFactor) && result.compressibilityFactor !== 1
                 ? ` (real gas, Z = ${result.compressibilityFactor.toFixed(3)})` : " (ideal gas)"}</dd></div>
             <div><dt>Temperature after expansion</dt><dd>${(result.cloudTemperature - 273.15).toFixed(0)} °C</dd></div>`
          : ""}
        ${Number.isFinite(result.puddleDiameter)
          ? `<div><dt>Puddle formed</dt><dd>${result.puddleArea.toFixed(0)} m² (${result.puddleDiameter.toFixed(1)} m across)</dd></div>
             <div><dt>Drained from tank</dt><dd>${result.tankDrainedMass.toFixed(0)} kg in the first hour (up to ${result.tankDrainPeakRate.toFixed(2)} kg/s)</dd></div>`
          : ""}
      </dl>

      ${verdict}
      ${modelChoiceHtml(dispersion)}
      ${notes}
    </div>`;
}

/**
 * The dispersion-model select (2026-10-04). Automatic by default; the user
 * may force either model, e.g. to compare a borderline case both ways or to
 * match another tool's choice. Heavy Gas is offered only for a cloud
 * denser than air — see applyModelOverride().
 */
function modelChoiceHtml(dispersion) {
  if (!dispersion) return "";
  const current = currentSource().modelOverride ?? "";
  const label = (m) => (m === "heavyGas" ? "Heavy Gas" : "Gaussian");
  const heavyAllowed = dispersion.densityRatio > 1;
  const option = (value, text, disabled = false) =>
    `<option value="${value}"${current === value ? " selected" : ""}${disabled ? " disabled" : ""}>${text}</option>`;
  return `
    <div class="field" style="margin-top: var(--space-4);">
      <label for="src-model-override">Dispersion model</label>
      <select id="src-model-override" data-model-override>
        ${option("", `Automatic (${label(dispersion.automaticModel ?? dispersion.model)})`)}
        ${option("gaussian", "Gaussian")}
        ${option("heavyGas", heavyAllowed ? "Heavy Gas" : "Heavy Gas — not for a cloud lighter than air", !heavyAllowed)}
      </select>
      <div class="field__hint">
        Leave on Automatic unless you have a reason to change it: near the
        threshold (Richardson number about 1.8–2.1) either model can be
        defended, and forcing one lets you compare both. A forced model is
        stated on the Results page and in the PDF report.
      </div>
    </div>`;
}

/* ========================================================================
   EVENTS
   ======================================================================== */

/**
 * Recomputes the source strength and redraws the result panel.
 *
 * This runs automatically after every relevant field change — see
 * wireEvents() below — not on a separate "compute" button. An earlier
 * version had one; it was confusing, because it duplicated what already
 * happened live and gave no sign it had done anything when the numbers
 * happened not to change.
 *
 * The puddle and tank models integrate second-by-second for up to two
 * hours of simulated time, which is enough real computation to be
 * noticeable on a slower device. Running it synchronously inside the event
 * handler would freeze the page for that moment with no visible cause — it
 * would look like typing had stopped working, not like something was being
 * calculated. Showing "Calculating…" first, then deferring the actual work
 * by one tick (setTimeout 0), lets the browser paint that message before
 * the blocking work begins.
 */
/**
 * Updates just the "Capacity X m³" hint under the tank's fill-percentage
 * field, without a full form re-render.
 *
 * The tank form's diameter/length/fill fields only trigger recompute()
 * (see wireEvents() below) rather than a full render() — deliberately, so
 * typing in one field does not lose focus or cursor position. That form
 * HTML embeds the capacity figure as plain text computed once, though, so
 * without this, editing diameter or length left it showing whatever value
 * was true when the form was last fully drawn — silently stale, and
 * confusing precisely because it looks like a live readout.
 */
function refreshTankCapacity(container) {
  const hint = container.querySelector("#tank-capacity-hint");
  if (!hint) return; // not a tank source, or the form has not rendered yet

  const source = currentSource();
  try {
    const volume = tankVolume({
      shape: source.tankShape,
      diameter: Number(source.tankDiameter),
      length: Number(source.tankLength),
    });
    hint.textContent = `Capacity ${volume.toFixed(1)} m³ (${(volume * 1000).toFixed(0)} litres)`;
  } catch {
    hint.textContent = "";
  }
}

function recompute(container) {
  const slot = container.querySelector("#src-result");
  if (!slot) return;

  refreshTankCapacity(container);

  slot.innerHTML = `<p class="field__hint" style="margin-top: var(--space-4);">Calculating…</p>`;

  // Captured so the deferred write below can detect whether the scenario
  // this calculation was FOR still matches the one now current — see the
  // check inside the timeout.
  const scenarioAtRequestTime = state.current.scenario;

  setTimeout(() => {
    // If a different scenario is current now — someone loaded a saved one,
    // or started a new one, while this was pending — these numbers no
    // longer belong to what is on screen. Writing them anyway would mean a
    // stray calculation from an abandoned scenario silently overwriting
    // part of a different one.
    if (state.current.scenario !== scenarioAtRequestTime) return;

    const result = runSourceModel();
    const dispersion = assessDispersionModel(result);

    updateSource({ result: result.error ? null : result });
    slot.innerHTML = resultHtml(result, dispersion);

    // The model select lives inside the result panel, which is redrawn on
    // every recompute, so it is wired here rather than in wireEvents().
    slot.querySelector("[data-model-override]")?.addEventListener("change", (event) => {
      updateSource({ modelOverride: event.target.value });
      recompute(container);
    });
  }, 0);
}

function wireEvents(container) {
  container.querySelectorAll("[data-source-type]").forEach((button) => {
    button.addEventListener("click", () => {
      updateSource({ type: button.dataset.sourceType });
      sourceStep.render(container);
    });
  });

  container.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("change", () => {
      updateSource({ [input.dataset.field]: input.value });

      // Fields that change which other fields are visible
      if (input.dataset.field === "holeShape" || input.dataset.field === "tankShape" ||
          input.dataset.field === "tankContents") {
        sourceStep.render(container);
        return;
      }
      recompute(container);
    });
  });

  // Help toggles on the manual property fields
  container.querySelectorAll(".help-button").forEach((button) => {
    button.addEventListener("click", () => {
      const target = container.querySelector(`[data-help-text="${button.dataset.help}"]`);
      if (target) target.hidden = !target.hidden;
    });
  });

}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

export const sourceStep = {
  id: "source",
  label: "Source",

  render(container) {
    if (!state.current.scenario.source) {
      state.update({ scenario: { ...state.current.scenario, source: defaultSource() } });
    }

    const source = currentSource();

    let form = "";
    if (source.type === "direct") form = directFormHtml(source);
    else if (source.type === "puddle") form = puddleFormHtml(source);
    else form = tankFormHtml(source);

    // A tank of compressed gas needs none of the liquid properties.
    const { chemical, weather } = gatherModelInputs();
    const needsProperties = source.type !== "direct" &&
      !(source.type === "tank" && tankContentsFor(source, chemical, weather?.temperature) === "gas");

    container.innerHTML = `
      <div class="panel">
        <h2>Release source</h2>
        <p>
          How the substance enters the air. This determines the release rate
          and how long it lasts, which together with the weather set the size
          of the threat zones.
        </p>

        ${typeSelectorHtml(source)}
        ${form}
      </div>

      ${needsProperties ? manualPropertiesHtml(source) : ""}

      <div id="src-result"></div>
    `;

    wireEvents(container);
    recompute(container);
  },

  isComplete() {
    const source = state.current.scenario.source;
    return Boolean(source?.result?.peakRate > 0);
  },
};
