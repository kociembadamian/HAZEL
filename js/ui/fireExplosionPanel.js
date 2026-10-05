/**
 * fireExplosionPanel.js
 * ---------------------
 * The optional "what if it ignites" section of the Results step: fireball
 * (BLEVE) thermal radiation, a vapour cloud explosion's overpressure, a
 * burning pool, or a jet fire.
 *
 * Kept as its own module rather than folded into stepResults.js because it
 * is a genuinely separate concern with its own inputs and its own drawing
 * convention: unlike the wind-blown toxic and flammable-area plumes, all
 * four of these radiate or blast outward from the source independent of
 * wind direction for BLEVE and VCE (concentric circles), or along the
 * downwind axis only for pool and jet fires (a wedge, since ALOHA itself
 * only reports these downwind — see enginePoolFire.js / engineJetFire.js).
 *
 * Data this needs that nothing else in HAZEL collects
 * -----------------------------------------------------
 * Heat of combustion is not in the PAC/TEEL dataset at all. Pool fire's
 * boiling point, heat of vaporisation and liquid heat capacity ARE already
 * collected by stepSource.js for puddle-type releases — reused here when
 * present, asked for again only if this scenario needs them and the Source
 * step never did (e.g. a tank or direct release feeding a pool fire).
 * Jet fire's specific heat ratio (gamma) is not collected anywhere else.
 *
 * VCE FLAMMABLE MASS — AUTOMATIC AS OF 2026-09-22
 * --------------------------------------------------
 * Previously the mass of fuel actually within flammable limits was a
 * manual entry here, because computing it properly requires integrating
 * the dispersion model's concentration field between 90% of the LEL and
 * the UEL (Tech Doc section 5.2) — real work this version did not do,
 * so the field asked the person to guess a number instead.
 *
 * That integration is now done automatically (engineFlammableMass.js),
 * reusing the EXACT dispersion scenario the Results step's own map is
 * drawing (buildDispersionScenario() in stepSource.js) — so the mass fed
 * into engineVce.js's blast calculation always matches the cloud on
 * screen. The one thing still asked for manually is the upper explosive
 * limit: the DOE PAC/TEEL dataset HAZEL ships carries a lower explosive
 * limit but never an upper one (see chemicalDatabase.js,
 * convert_pac_data.py — DOE's own source table has no such column), so
 * that single number is requested the same way heat of combustion already
 * is, with a hint on where to look it up. The lower explosive limit is
 * pre-filled from the chemical database when the substance has one, and
 * stays editable in case a more specific figure is available.
 *
 * CUSTOM CHEMICAL LIBRARY (2026-09-23)
 * ----------------------------------------
 * Heat of combustion and the upper explosive limit can now also be
 * pre-filled from a user's own Chemical library entry (customChemicalStore.js)
 * — the exact gap the paragraph above describes for the built-in dataset,
 * closed on a per-substance basis by whatever the user has saved for it.
 * Both fields still fall back to plain manual entry when nothing is saved.
 */

import { state } from "./state.js";
import { gatherModelInputs, buildDispersionScenario } from "./stepSource.js";
import { gasDensity } from "../engine/engineDispersionChoice.js";
import { gaussianTransportWindSpeed } from "../engine/engineGaussian.js";
import {
  findFireballRadiationDistance,
  THERMAL_RADIATION_LEVELS,
} from "../engine/engineBleve.js";
import {
  findOverpressureDistance,
  OVERPRESSURE_LEVELS,
  psiToPa,
} from "../engine/engineVce.js";
import { estimateFlammableCloud } from "../engine/engineFlammableMass.js";
import { findPoolFireRadiationDistance } from "../engine/enginePoolFire.js";
import { findJetFireRadiationDistance } from "../engine/engineJetFire.js";

export function defaultFireScenario() {
  return {
    enabled: false,
    scenarioType: "bleve", // "bleve" | "vce" | "pool" | "jet"
    heatOfCombustion: null, // J/kg — shared by all four scenario types
    // VCE
    reactivity: "medium", // "low" | "medium" | "high"
    congestion: "medium", // "low" | "medium" | "high"
    hardIgnition: false,
    // Explosive limits, ppm. lowerExplosiveLimitPpm overrides the chemical
    // database's own value when set; leave it null to use that value.
    // upperExplosiveLimitPpm has no database source at all (see the module
    // docstring) and must always be supplied here.
    lowerExplosiveLimitPpm: null,
    upperExplosiveLimitPpm: null,
    // Pool fire — only asked for if the Source step did not already collect them
    poolDiameter: null,
    boilingPoint: null,
    heatOfVaporization: null,
    liquidHeatCapacity: null,
    // Jet fire
    orificeDiameter: null,
    specificHeatRatio: null,
    choked: false,
    isAerosol: false,
  };
}

function currentFire() {
  return state.current.scenario.fire ?? defaultFireScenario();
}

function updateFire(changes) {
  const fire = { ...currentFire(), ...changes };
  state.update({ scenario: { ...state.current.scenario, fire } });
}

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Reads a form control's value in the type it should actually be stored as.
 *
 * Exported specifically so it can be unit-tested against fake input objects
 * without a real DOM — see fireExplosionIntegrationTests.js. The bug this
 * exists to prevent from recurring: input.value is ALWAYS a string in the
 * DOM, even for <input type="number">, so storing it as-is silently turned
 * every numeric field in this panel (heat of combustion, pool diameter, and
 * the rest) into a string that then failed every Number.isFinite() check
 * downstream in computeFireResults() — the field looked filled in on
 * screen, but the "still needed" message never went away.
 *
 * @param {{type?: string, tagName?: string, value: string, checked?: boolean}} input
 * @returns {string|number|boolean}
 */
export function fireFieldValueFromInput(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.tagName === "SELECT") return input.value;
  return Number(input.value);
}

/** A number the user entered here, one the Source step already has, or one
 *  saved on the chemical itself (a custom chemical library entry — see
 *  customChemicalStore.js), in that order — used for the pool/liquid
 *  properties stepSource.js's puddle form also collects, so the person is
 *  not asked for them twice, and not asked at all when their own saved
 *  chemical record already has the value. */
function fireOrSourceValue(fire, fireField, sourceField) {
  const source = state.current.scenario.source;
  const chemical = state.current.scenario.chemical?.selected;
  if (Number.isFinite(fire[fireField])) return fire[fireField];
  if (Number.isFinite(source?.[sourceField])) return source[sourceField];
  if (Number.isFinite(chemical?.[sourceField])) return chemical[sourceField];
  return null;
}

/**
 * Heat of vaporisation for the pool fire, in J/KG.
 *
 * FIXED 2026-10-01: this panel's own field is per kilogram, but the Source
 * step and the Chemical library store the heat of vaporisation per MOLE
 * (stepSource.js's field and the puddle/tank models use J/mol). Reusing that
 * value unconverted would have put, say, toluene's 33,180 J/mol into the
 * burning-rate formula as 33,180 J/kg — about eleven times too small — and
 * made the burning rate several times too high. A value taken from there is
 * now converted with the molecular weight.
 */
function poolHeatOfVaporizationPerKg(fire) {
  if (Number.isFinite(fire.heatOfVaporization)) return fire.heatOfVaporization;
  const source = state.current.scenario.source;
  const chemical = state.current.scenario.chemical?.selected;
  const perMole = Number(source?.heatOfVaporization) || Number(chemical?.heatOfVaporization);
  const molecularWeight = Number(chemical?.molecularWeight);
  if (!(perMole > 0) || !(molecularWeight > 0)) return null;
  return perMole / (molecularWeight / 1000);
}

/* ========================================================================
   COMPUTATION
   ======================================================================== */

/**
 * Computes results for whichever fire/explosion scenario is enabled, for
 * every standard Level of Concern, or explains what is still needed.
 *
 * @returns {{status: "disabled"|"incomplete"|"ok", missing?: string[], scenarioType?: string, results?: Array}}
 */
export function computeFireResults() {
  const fire = currentFire();
  if (!fire.enabled) return { status: "disabled" };

  const { missing: modelMissing, weather, chemical } = gatherModelInputs();
  const source = state.current.scenario.source;
  const missing = [...modelMissing];

  const chemicalRecordForDefaults = state.current.scenario.chemical?.selected;
  const heatOfCombustion = Number.isFinite(fire.heatOfCombustion)
    ? fire.heatOfCombustion
    : chemicalRecordForDefaults?.heatOfCombustion;

  const needsHeatOfCombustion = ["bleve", "vce", "pool", "jet"].includes(fire.scenarioType);
  if (needsHeatOfCombustion && (!Number.isFinite(heatOfCombustion) || heatOfCombustion <= 0)) {
    missing.push("a heat of combustion for the substance");
  }

  if (fire.scenarioType === "bleve") {
    const massKg = source?.result?.totalMass;
    if (!Number.isFinite(massKg) || massKg <= 0) {
      missing.push("a computed release mass, from the Source step");
    }
    if (missing.length > 0) return { status: "incomplete", missing };

    const scenario = {
      fireballMassKg: massKg,
      heatOfCombustion,
      relativeHumidity: Number(state.current.scenario.weather?.relativeHumidity ?? 50),
      ambientTemperature: weather.temperature,
    };
    const results = THERMAL_RADIATION_LEVELS.map((level) => ({
      level,
      ...findFireballRadiationDistance({ ...scenario, thresholdWm2: level.wPerM2 }),
    }));
    return { status: "ok", scenarioType: "bleve", results, mass: massKg };
  }

  if (fire.scenarioType === "vce") {
    const chemicalRecord = chemicalRecordForDefaults;
    const lowerExplosiveLimitPpm = Number.isFinite(fire.lowerExplosiveLimitPpm)
      ? fire.lowerExplosiveLimitPpm
      : chemicalRecord?.lowerExplosiveLimitPpm;
    // Built-in database records never carry a UEL (see the module
    // docstring), but a custom chemical library entry can — an override on
    // an existing substance, or a fully custom one — so the same
    // field-or-database fallback used for the LEL above applies here too.
    const upperExplosiveLimitPpm = Number.isFinite(fire.upperExplosiveLimitPpm)
      ? fire.upperExplosiveLimitPpm
      : chemicalRecord?.upperExplosiveLimitPpm;

    if (!Number.isFinite(lowerExplosiveLimitPpm) || lowerExplosiveLimitPpm <= 0) {
      missing.push("a lower explosive limit for the substance (not on file — enter it below)");
    }
    if (!Number.isFinite(upperExplosiveLimitPpm) || upperExplosiveLimitPpm <= 0) {
      missing.push("an upper explosive limit for the substance");
    }

    const dispersionScenario = buildDispersionScenario();
    if (dispersionScenario.status !== "ok") missing.push(...dispersionScenario.missing);

    if (missing.length > 0) return { status: "incomplete", missing };

    let flammableMassKg;
    let cloudCentreM = 0;
    try {
      ({ massKg: flammableMassKg, centreX: cloudCentreM } = estimateFlammableCloud({
        isHeavyGas: dispersionScenario.isHeavyGas,
        scenarioBase: dispersionScenario.scenarioBase,
        lowerExplosiveLimitPpm,
        upperExplosiveLimitPpm,
      }));
    } catch (error) {
      return { status: "incomplete", missing: [error.message] };
    }

    if (!(flammableMassKg > 0)) {
      return {
        status: "incomplete",
        missing: [
          "the modelled cloud never reaches a concentration between 90% of the LEL and the " +
            "UEL entered — double-check those two values",
        ],
      };
    }

    const scenario = {
      flammableMassKg,
      heatOfCombustion,
      reactivity: fire.reactivity,
      congestion: fire.congestion,
      hardIgnition: fire.hardIgnition,
    };
    // Distances are reported from the release point, as ALOHA does: the
    // blast is centred on the flammable cloud, cloudCentreM downwind
    // (estimateFlammableCloud(), 2026-10-02). The map draws the circle
    // around the source with this radius — slightly larger than the true
    // offset circle, on the cautious side.
    const results = OVERPRESSURE_LEVELS.map((level) => {
      const found = findOverpressureDistance({ ...scenario, thresholdPa: psiToPa(level.psi) });
      return {
        level,
        ...found,
        maxDistance: found.thresholdExceeded ? found.maxDistance + cloudCentreM : 0,
      };
    });
    return { status: "ok", scenarioType: "vce", results, flammableMassKg, cloudCentreM };
  }

  if (fire.scenarioType === "pool") {
    const poolDiameter = fire.poolDiameter;
    const boilingPoint = fireOrSourceValue(fire, "boilingPoint", "boilingPointK");
    const heatOfVaporization = poolHeatOfVaporizationPerKg(fire);
    const liquidHeatCapacity = fireOrSourceValue(fire, "liquidHeatCapacity", "liquidHeatCapacity");

    if (!Number.isFinite(poolDiameter) || poolDiameter <= 0) missing.push("a pool diameter");
    if (!Number.isFinite(boilingPoint)) missing.push("the substance's boiling point");
    if (!Number.isFinite(heatOfVaporization)) missing.push("the substance's heat of vaporisation");
    if (!Number.isFinite(liquidHeatCapacity)) missing.push("the substance's liquid heat capacity");
    if (missing.length > 0) return { status: "incomplete", missing };

    const scenario = {
      poolDiameter,
      heatOfCombustion,
      heatOfVaporization,
      specificHeatCapacity: liquidHeatCapacity,
      boilingPoint,
      poolTemperature: weather.temperature,
      // The wind at 3 m (Tech Doc 4.2.3 profile), as for the Gaussian
      // plume (gaussianTransportWindSpeed()): ALOHA's printed flame lengths
      // (toluene, 20 and 200 m2, 5 m/s) are reproduced with it — 10 and 23 m
      // against 9.2 and 21.4 m with the 10 m wind. 2026-10-01.
      windSpeed: gaussianTransportWindSpeed(weather.windSpeed10m, weather.roughnessLength, weather.stabilityClass),
      ambientAirDensity: gasDensity(28.96, weather.temperature),
      relativeHumidity: Number(state.current.scenario.weather?.relativeHumidity ?? 50),
      ambientTemperature: weather.temperature,
    };
    const results = THERMAL_RADIATION_LEVELS.map((level) => ({
      level,
      ...findPoolFireRadiationDistance({ ...scenario, thresholdWm2: level.wPerM2 }),
    }));
    return { status: "ok", scenarioType: "pool", results };
  }

  // Jet fire
  const orificeDiameter = fireOrSourceValue(fire, "orificeDiameter", "holeDiameter");
  const massFlowRate = source?.result?.peakRate;
  if (!Number.isFinite(orificeDiameter) || orificeDiameter <= 0) missing.push("an orifice diameter");
  if (!Number.isFinite(massFlowRate) || massFlowRate <= 0) missing.push("a computed release rate, from the Source step");
  if (!Number.isFinite(fire.specificHeatRatio) || fire.specificHeatRatio <= 1) missing.push("a specific heat ratio (gamma) for the gas");
  if (missing.length > 0) return { status: "incomplete", missing };

  const sourceTemperature = weather.temperature;
  const jetDensity = gasDensity(chemical.molecularWeight, sourceTemperature);
  const ambientDensity = gasDensity(28.96, weather.temperature);

  const scenario = {
    massFlowRate,
    orificeDiameter,
    specificHeatRatio: fire.specificHeatRatio,
    sourceTemperature,
    molecularWeightKgPerMol: chemical.molecularWeight / 1000,
    jetDensity,
    ambientDensity,
    windSpeed: weather.windSpeed10m,
    choked: fire.choked,
    isAerosol: fire.isAerosol,
    heatOfCombustion,
    relativeHumidity: Number(state.current.scenario.weather?.relativeHumidity ?? 50),
    ambientTemperature: weather.temperature,
  };
  const results = THERMAL_RADIATION_LEVELS.map((level) => ({
    level,
    ...findJetFireRadiationDistance({ ...scenario, thresholdWm2: level.wPerM2 }),
  }));
  return { status: "ok", scenarioType: "jet", results };
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function heatOfCombustionFieldHtml(fire) {
  const chemical = state.current.scenario.chemical?.selected;
  const chemicalHc = chemical?.heatOfCombustion;
  const value = Number.isFinite(fire.heatOfCombustion) ? fire.heatOfCombustion : chemicalHc;

  return `
    <div class="field">
      <label for="fire-hc">
        Heat of combustion
        <button type="button" class="help-button" data-help="hc" aria-label="Where to find this">?</button>
      </label>
      <div class="input-pair">
        <input type="number" id="fire-hc" step="100000" min="1"
               value="${value ?? ""}" data-fire-field="heatOfCombustion"
               placeholder="e.g. 46000000" />
        <span class="input-suffix">J/kg</span>
      </div>
      <div class="field__hint" data-help-text="hc" hidden>
        ${
          Number.isFinite(chemicalHc)
            ? `Taken from your Chemical library entry for this substance (${chemicalHc} J/kg). Edit this only if you have a more specific figure.`
            : "Not in HAZEL's exposure-threshold dataset. Look for \"heat of combustion\" " +
              "or \"delta-c H\" on the substance's safety data sheet, or NIST Chemistry " +
              "WebBook, Gas phase thermochemistry data. Propane's is about " +
              "46,000,000 J/kg, for scale — or save it once on the Chemical library " +
              "page so it fills in automatically next time."
        }
      </div>
    </div>`;
}

function bleveFormHtml(fire) {
  const source = state.current.scenario.source;
  const massKg = source?.result?.totalMass;
  return `
    ${heatOfCombustionFieldHtml(fire)}
    <p class="field__hint">
      ${
        Number.isFinite(massKg)
          ? `Fireball mass: the full computed release mass from the Source step, ${massKg.toFixed(0)} kg — the usual default assumption for a BLEVE.`
          : "Fireball mass will use the release mass computed in the Source step."
      }
    </p>`;
}

function vceFormHtml(fire) {
  const chemical = state.current.scenario.chemical?.selected;
  const chemicalLel = chemical?.lowerExplosiveLimitPpm;
  const lelValue = Number.isFinite(fire.lowerExplosiveLimitPpm) ? fire.lowerExplosiveLimitPpm : chemicalLel;
  const chemicalUel = chemical?.upperExplosiveLimitPpm;
  const uelValue = Number.isFinite(fire.upperExplosiveLimitPpm) ? fire.upperExplosiveLimitPpm : chemicalUel;

  return `
    ${heatOfCombustionFieldHtml(fire)}

    <div class="field-grid">
      <div class="field">
        <label for="fire-reactivity">Fuel reactivity</label>
        <select id="fire-reactivity" data-fire-field="reactivity">
          <option value="low"${fire.reactivity === "low" ? " selected" : ""}>Low (burning velocity under 45 cm/s)</option>
          <option value="medium"${fire.reactivity === "medium" ? " selected" : ""}>Medium (most substances, default)</option>
          <option value="high"${fire.reactivity === "high" ? " selected" : ""}>High (burning velocity over 75 cm/s)</option>
        </select>
      </div>

      <div class="field">
        <label for="fire-congestion">Site congestion</label>
        <select id="fire-congestion" data-fire-field="congestion">
          <option value="low"${fire.congestion === "low" ? " selected" : ""}>Low, open and unobstructed</option>
          <option value="medium"${fire.congestion === "medium" ? " selected" : ""}>Medium</option>
          <option value="high"${fire.congestion === "high" ? " selected" : ""}>High, dense obstacles (pipe racks, dense trees)</option>
        </select>
        <div class="field__hint">
          A congested zone is one so full of closely spaced obstacles it is
          difficult to walk through.
        </div>
      </div>

      <div class="field">
        <label>
          <input type="checkbox" data-fire-field="hardIgnition" ${fire.hardIgnition ? "checked" : ""}
                 style="width:auto; display:inline-block; margin-right: var(--space-2);" />
          Hard ignition (a high-power source capable of detonating the whole cloud)
        </label>
      </div>

      <div class="field">
        <label for="fire-lel">
          Lower explosive limit
          <button type="button" class="help-button" data-help="lel" aria-label="Where this value comes from">?</button>
        </label>
        <div class="input-pair">
          <input type="number" id="fire-lel" step="0.01" min="0.0001"
                 value="${lelValue ?? ""}" data-fire-field="lowerExplosiveLimitPpm"
                 placeholder="e.g. 33000" />
          <span class="input-suffix">ppm</span>
        </div>
        <div class="field__hint" data-help-text="lel" hidden>
          ${
            Number.isFinite(chemicalLel)
              ? `Taken from HAZEL's chemical database (${chemicalLel} ppm). Edit this only if you have a more specific figure for the substance as actually stored.`
              : "Not on file for this substance in HAZEL's chemical database. Look for \"lower explosive limit\" or \"LEL\" on CAMEO Chemicals or the substance's safety data sheet, section 9."
          }
        </div>
      </div>

      <div class="field">
        <label for="fire-uel">
          Upper explosive limit
          <button type="button" class="help-button" data-help="uel" aria-label="Where to find this">?</button>
        </label>
        <div class="input-pair">
          <input type="number" id="fire-uel" step="0.01" min="0.0001"
                 value="${uelValue ?? ""}" data-fire-field="upperExplosiveLimitPpm"
                 placeholder="e.g. 190000" />
          <span class="input-suffix">ppm</span>
        </div>
        <div class="field__hint" data-help-text="uel" hidden>
          ${
            Number.isFinite(chemicalUel)
              ? `Taken from your Chemical library entry for this substance (${chemicalUel} ppm). Edit this only if you have a more specific figure.`
              : "Not in HAZEL's exposure-threshold dataset — the DOE PAC/TEEL table " +
                "this project uses does not carry an upper limit at all. Look for " +
                "\"upper explosive limit\" or \"UEL\" on CAMEO Chemicals " +
                "(cameochemicals.noaa.gov, search by CAS number, Physical " +
                "Properties) or the substance's safety data sheet, section 9 — or " +
                "save it once on the Chemical library page so it fills in " +
                "automatically next time."
          }
        </div>
      </div>
    </div>

    <p class="field__hint">
      With both limits entered, HAZEL computes the mass of vapour sitting
      between 90% of the LEL and the UEL directly from the modelled
      dispersion cloud shown on the map above — no manual mass estimate
      needed.
    </p>`;
}

function poolFormHtml(fire) {
  const source = state.current.scenario.source;
  const boilingPoint = fireOrSourceValue(fire, "boilingPoint", "boilingPointK");
  const heatOfVaporization = poolHeatOfVaporizationPerKg(fire);
  const liquidHeatCapacity = fireOrSourceValue(fire, "liquidHeatCapacity", "liquidHeatCapacity");

  const reusedHint = (fromSource, label) =>
    fromSource ? `<div class="field__hint">Reused from the Source step: ${label}.</div>` : "";

  return `
    ${heatOfCombustionFieldHtml(fire)}

    <div class="field-grid">
      <div class="field">
        <label for="fire-pool-diameter">Pool diameter</label>
        <div class="input-pair">
          <input type="number" id="fire-pool-diameter" step="0.1" min="0.1"
                 value="${fire.poolDiameter ?? ""}" data-fire-field="poolDiameter"
                 placeholder="e.g. 10" />
          <span class="input-suffix">m</span>
        </div>
      </div>

      <div class="field">
        <label for="fire-pool-boiling">Boiling point</label>
        <div class="input-pair">
          <input type="number" id="fire-pool-boiling" step="0.1"
                 value="${boilingPoint ?? ""}" data-fire-field="boilingPoint" placeholder="e.g. 353.25" />
          <span class="input-suffix">K</span>
        </div>
        ${reusedHint(Number.isFinite(source?.boilingPointK), `${source?.boilingPointK} K`)}
      </div>

      <div class="field">
        <label for="fire-pool-hvap">Heat of vaporisation</label>
        <div class="input-pair">
          <input type="number" id="fire-pool-hvap" step="1000" min="1"
                 value="${heatOfVaporization ?? ""}" data-fire-field="heatOfVaporization" placeholder="e.g. 425000" />
          <span class="input-suffix">J/kg</span>
        </div>
        ${reusedHint(!Number.isFinite(fire.heatOfVaporization) && Number.isFinite(heatOfVaporization),
          `${Math.round(heatOfVaporization)} J/kg, converted from ${source?.heatOfVaporization} J/mol`)}
      </div>

      <div class="field">
        <label for="fire-pool-cp">Liquid heat capacity</label>
        <div class="input-pair">
          <input type="number" id="fire-pool-cp" step="10" min="1"
                 value="${liquidHeatCapacity ?? ""}" data-fire-field="liquidHeatCapacity" placeholder="e.g. 2400" />
          <span class="input-suffix">J/(kg K)</span>
        </div>
        ${reusedHint(Number.isFinite(source?.liquidHeatCapacity), `${source?.liquidHeatCapacity} J/(kg K)`)}
      </div>
    </div>`;
}

function jetFormHtml(fire) {
  const source = state.current.scenario.source;
  const orificeDiameter = fireOrSourceValue(fire, "orificeDiameter", "holeDiameter");

  return `
    ${heatOfCombustionFieldHtml(fire)}

    <div class="field-grid">
      <div class="field">
        <label for="fire-jet-orifice">Orifice diameter</label>
        <div class="input-pair">
          <input type="number" id="fire-jet-orifice" step="0.001" min="0.001"
                 value="${orificeDiameter ?? ""}" data-fire-field="orificeDiameter" placeholder="e.g. 0.05" />
          <span class="input-suffix">m</span>
        </div>
        ${
          Number.isFinite(source?.holeDiameter)
            ? `<div class="field__hint">Reused from the Source step: ${source.holeDiameter} m.</div>`
            : ""
        }
      </div>

      <div class="field">
        <label for="fire-jet-gamma">
          Specific heat ratio (gamma)
          <button type="button" class="help-button" data-help="gamma" aria-label="Typical values">?</button>
        </label>
        <input type="number" id="fire-jet-gamma" step="0.01" min="1.01" max="1.8"
               value="${fire.specificHeatRatio ?? ""}" data-fire-field="specificHeatRatio" placeholder="e.g. 1.13" />
        <div class="field__hint" data-help-text="gamma" hidden>
          Roughly 1.1-1.2 for most hydrocarbon gases (propane is about 1.13),
          1.4 for diatomic gases like nitrogen or oxygen, 1.67 for monatomic
          gases like helium or argon. Check a reference table for the exact
          substance if precision matters.
        </div>
      </div>

      <div class="field">
        <label>
          <input type="checkbox" data-fire-field="choked" ${fire.choked ? "checked" : ""}
                 style="width:auto; display:inline-block; margin-right: var(--space-2);" />
          Flow is choked (sonic at the orifice — typical for a significant pressure difference)
        </label>
      </div>

      <div class="field">
        <label>
          <input type="checkbox" data-fire-field="isAerosol" ${fire.isAerosol ? "checked" : ""}
                 style="width:auto; display:inline-block; margin-right: var(--space-2);" />
          Release is an aerosol (two-phase) mist, not a pure gas
        </label>
      </div>
    </div>`;
}

const SCENARIO_FORMS = { bleve: bleveFormHtml, vce: vceFormHtml, pool: poolFormHtml, jet: jetFormHtml };

/** Redraws only the fire/explosion results readout, without touching the map. */
function refreshFireResults(container) {
  const slot = container.querySelector("#fire-results");
  if (!slot) return;

  const computed = computeFireResults();

  if (computed.status === "disabled") {
    slot.innerHTML = "";
    return;
  }

  if (computed.status === "incomplete") {
    slot.innerHTML = `
      <div class="banner banner--info">
        <span>Still needed: ${computed.missing.map(escapeHtml).join("; ")}.</span>
      </div>`;
    return;
  }

  const massReadoutHtml =
    computed.scenarioType === "vce"
      ? `<p class="field__hint" style="margin-top: var(--space-4);">
           Computed flammable mass (vapour between 90% of the LEL and the UEL,
           integrated from the modelled cloud above): ${computed.flammableMassKg.toFixed(1)} kg.
         </p>`
      : "";

  slot.innerHTML = `
    ${massReadoutHtml}
    <dl class="readout" style="margin-top: var(--space-4);">
      ${computed.results
        .map(
          ({ level, thresholdExceeded, maxDistance }) => `
        <div>
          <dt>
            <span class="threat-badge threat-badge--${level.colour}">${escapeHtml(level.label)}</span>
            ${escapeHtml(level.description)}
          </dt>
          <dd>${thresholdExceeded ? `${maxDistance.toFixed(0)} m` : "not exceeded"}</dd>
        </div>`
        )
        .join("")}
    </dl>`;
}

/**
 * Renders the fire/explosion panel into a container, and wires it to redraw
 * itself (and to call onChange, so the caller can update the map circles)
 * whenever an input changes.
 *
 * @param {HTMLElement} container - a fresh container, unique to this render
 *        of the Results step (see stepResults.js — not the persistent
 *        wizard-step-content element, so ordinary addEventListener here
 *        does not accumulate across visits).
 * @param {() => void} onChange
 */
export function renderFireExplosionPanel(container, onChange) {
  const fire = currentFire();

  const typeCard = (type, title, desc) => `
    <button type="button" class="choice-card" data-fire-type="${type}"
            aria-pressed="${fire.scenarioType === type}">
      <span class="choice-card__title">${title}</span>
      <span class="choice-card__desc">${desc}</span>
    </button>`;

  container.innerHTML = `
    <div class="panel" style="margin-top: var(--space-6);">
      <h3>Fire and explosion, if it ignites</h3>
      <p>
        Independent of the toxic and flammable-area results above: what if
        the release ignites? These four scenarios radiate or blast outward
        from the source rather than drifting downwind with the dispersing
        cloud.
      </p>

      <label style="display:flex; align-items:center; gap: var(--space-2);">
        <input type="checkbox" id="fire-enabled" ${fire.enabled ? "checked" : ""}
               style="width:auto;" />
        Consider ignition
      </label>

      <div id="fire-form" style="${fire.enabled ? "" : "display:none"}; margin-top: var(--space-4);">
        <div class="mode-grid" style="margin-bottom: var(--space-4);">
          ${typeCard("bleve", "Fireball (BLEVE)", "Immediate ignition of a catastrophic tank rupture.")}
          ${typeCard("vce", "Vapour cloud explosion", "Delayed ignition of the dispersing flammable cloud.")}
          ${typeCard("pool", "Pool fire", "A pool of spilled liquid fuel burns in place.")}
          ${typeCard("jet", "Jet fire", "Escaping gas or aerosol ignites at the point of release.")}
        </div>

        <div id="fire-type-form">
          ${SCENARIO_FORMS[fire.scenarioType](fire)}
        </div>

        <div id="fire-results"></div>
      </div>
    </div>`;

  container.querySelector("#fire-enabled")?.addEventListener("change", (event) => {
    updateFire({ enabled: event.target.checked });
    renderFireExplosionPanel(container, onChange);
    onChange();
  });

  container.querySelectorAll("[data-fire-type]").forEach((button) => {
    button.addEventListener("click", () => {
      updateFire({ scenarioType: button.dataset.fireType });
      renderFireExplosionPanel(container, onChange);
      onChange();
    });
  });

  container.querySelectorAll("[data-fire-field]").forEach((input) => {
    input.addEventListener("change", () => {
      const field = input.dataset.fireField;
      updateFire({ [field]: fireFieldValueFromInput(input) });
      refreshFireResults(container);
      onChange();
    });
  });

  container.querySelectorAll(".help-button").forEach((button) => {
    button.addEventListener("click", () => {
      const target = container.querySelector(`[data-help-text="${button.dataset.help}"]`);
      if (target) target.hidden = !target.hidden;
    });
  });

  refreshFireResults(container);
}
