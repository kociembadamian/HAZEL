/**
 * chemicalDatabase.js
 * -------------------
 * Loads and searches the chemical database derived from the DOE Protective
 * Action Criteria dataset (see tools/convert_pac_data.py for how the JSON
 * is produced from DOE's published spreadsheet).
 *
 * Two files, loaded at different times
 * ------------------------------------
 * chemicals.slim.json (492 KB) holds what is needed to find a substance and
 * to run the dispersion calculation: name, CAS number, formula, physical
 * state, molecular weight, and the three PAC thresholds in ppm. This loads
 * when the Chemical step is first opened.
 *
 * chemicals.json (4.2 MB) holds the full records — boiling points, vapour
 * pressures, derived heats of vaporisation, and the placeholders for
 * properties a user must look up by hand. Nothing loads it yet; the Source
 * step will, once it exists. Keeping it separate means a phone downloads
 * 492 KB rather than 4.7 MB to do everything the application can currently do.
 *
 * Both files are static and identical for every user, so the service worker
 * caches them like any other asset and the database works offline from the
 * second visit onward.
 */

/** Molecular weight of dry air, g/mol. Used for the vapour density ratio. */
const MOLECULAR_WEIGHT_OF_AIR = 28.96;

let slimIndex = null;
let loadPromise = null;

/**
 * Loads the slim index, fetching it at most once per session.
 *
 * Concurrent callers share one in-flight request rather than triggering
 * several: the Chemical step can render and search in quick succession, and
 * without this the same half-megabyte would be fetched repeatedly.
 */
export async function loadChemicalDatabase() {
  if (slimIndex) return slimIndex;
  if (loadPromise) return loadPromise;

  loadPromise = fetch("data/chemicals.slim.json")
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load the chemical database (${response.status})`);
      }
      return response.json();
    })
    .then((data) => {
      slimIndex = data.map(normaliseSlimRecord);
      loadPromise = null;
      return slimIndex;
    })
    .catch((error) => {
      loadPromise = null;
      throw error;
    });

  return loadPromise;
}

/**
 * Expands the abbreviated keys used in the slim file into readable ones.
 *
 * The abbreviation exists purely to keep the file small — at 3,148 records
 * the key names themselves are a sizeable fraction of the bytes. Everything
 * downstream of this function works with full names, so the compression is
 * invisible outside this module.
 */
function normaliseSlimRecord(raw) {
  return {
    casNumber: raw.cas,
    name: raw.n,
    molecularFormula: raw.f,
    state25C: raw.s,
    molecularWeight: raw.mw,
    pac1Ppm: raw.p[0],
    pac2Ppm: raw.p[1],
    pac3Ppm: raw.p[2],
    lowerExplosiveLimitPpm: raw.lel ?? null,
    originalUnit: raw.u,
    // Lower-cased once at load time so searching does not repeat the work on
    // every keystroke across 3,148 records.
    searchName: (raw.n || "").toLowerCase(),
  };
}

/**
 * Normalises a CAS number for comparison.
 *
 * People type CAS numbers with and without hyphens, and copy them with stray
 * whitespace. Comparing digits only makes all of those match.
 */
function normaliseCas(text) {
  return String(text).replace(/[^\d]/g, "");
}

/**
 * Searches the database by name or CAS number.
 *
 * Results are ordered by how well they match rather than alphabetically,
 * because the substance someone typed the exact name of should not be buried
 * under every compound that happens to contain that word. The ranking is:
 *
 *   1. exact CAS number match      — unambiguous, always first
 *   2. name starts with the query  — "methanol" finds methanol before
 *                                    "sodium methanolate"
 *   3. name contains the query     — everything else
 *
 * Note the DOE dataset writes many names in an inverted form, for example
 * "Methyl alcohol; (Methanol)" or "Dichloro-1,1,1-trifluoroethane, 2,2-".
 * A substring match handles those, which is why the second and third tiers
 * are not merged.
 *
 * @param {string} query
 * @param {number} [limit] - maximum results to return
 * @returns {Array<object>}
 */
export function searchChemicals(query, limit = 25) {
  if (!slimIndex) {
    throw new Error("The chemical database has not been loaded yet");
  }

  const trimmed = String(query || "").trim();
  if (trimmed.length < 2) return [];

  const lower = trimmed.toLowerCase();
  const digits = normaliseCas(trimmed);
  const looksLikeCas = digits.length >= 4 && /^[\d-]+$/.test(trimmed);

  const exactCas = [];
  const startsWith = [];
  const contains = [];

  for (const record of slimIndex) {
    if (looksLikeCas && normaliseCas(record.casNumber) === digits) {
      exactCas.push(record);
      continue;
    }

    const position = record.searchName.indexOf(lower);
    if (position === 0) {
      startsWith.push(record);
    } else if (position > 0) {
      contains.push(record);
    }
  }

  return [...exactCas, ...startsWith, ...contains].slice(0, limit);
}

/** Finds one record by exact CAS number, or null. */
export function findByCas(casNumber) {
  if (!slimIndex) return null;
  const digits = normaliseCas(casNumber);
  return slimIndex.find((r) => normaliseCas(r.casNumber) === digits) ?? null;
}

/**
 * Loads the full record for one substance, including the physical properties
 * the slim index omits.
 *
 * Fetches the 4.2 MB file, so this is called only when something genuinely
 * needs those fields — currently nothing does, but the Source step will.
 * The whole file is fetched because it is static and cacheable; a per-record
 * API would mean a server, which HAZEL deliberately does not require.
 */
export async function loadFullRecord(casNumber) {
  const response = await fetch("data/chemicals.json");
  if (!response.ok) {
    throw new Error(`Could not load the full chemical record (${response.status})`);
  }
  const records = await response.json();
  const digits = normaliseCas(casNumber);
  return records.find((r) => normaliseCas(r.casNumber) === digits) ?? null;
}

/* ========================================================================
   DERIVED PROPERTIES
   ======================================================================== */

/**
 * Ratio of the vapour's density to that of air, at the same temperature and
 * pressure. For an ideal gas this is simply the ratio of molecular weights.
 *
 * This is the single most important check on whether the Gaussian model
 * applies at all: a value meaningfully above 1 means the cloud is denser than
 * the air around it and will slump and spread under gravity rather than
 * drifting passively with the wind.
 *
 * @returns {number|null} the ratio, or null when molecular weight is unknown
 */
export function vapourDensityRatio(molecularWeight) {
  if (!Number.isFinite(molecularWeight) || molecularWeight <= 0) return null;
  return molecularWeight / MOLECULAR_WEIGHT_OF_AIR;
}

/**
 * Describes what the substance's vapour density implies, WITHOUT deciding
 * which dispersion model applies.
 *
 * That decision is deliberately not made here. It depends on release rate and
 * wind speed as well as density — see engineDispersionChoice.js for the
 * Richardson-number criterion that implements it — and neither is known when
 * the user is choosing a substance.
 *
 * Two earlier versions of this function got the presentation wrong, both in
 * the same way, and the history is worth recording because the trap is easy
 * to fall into twice:
 *
 *   1. Gating on density alone at a 1.1 ratio produced a WARNING on 98.6% of
 *      the database — air is only 28.96 g/mol, so almost everything carried
 *      by road is heavier.
 *   2. Softening that to an informational note at a 1.5 ratio still produced
 *      a banner on 98.0%.
 *
 * Both fail for the same reason: anything that appears almost every time
 * stops being read. The fix is not a better threshold but a different
 * channel. The density ratio is now shown as an ordinary row in the
 * substance's data readout, where a user can look at it when they want it,
 * and a banner appears ONLY when there is something the reader could not work
 * out from that number alone:
 *
 *   - no molecular weight at all, which blocks modelling outright
 *   - a vapour lighter than air, because the relevant caveat there (buoyant
 *     rise is not modelled) is not something the ratio itself conveys
 *
 * Everything else gets no banner. Whether the Gaussian model applies to a
 * dense vapour is answered properly at the Source step, with the release rate
 * in hand, rather than guessed at here.
 *
 * @param {object} chemical - a record from the slim index
 * @returns {{ usable: boolean, severity: string, ratio: number|null, message: string|null }}
 */
export function describeVapourDensity(chemical) {
  const ratio = vapourDensityRatio(chemical.molecularWeight);

  if (ratio === null) {
    return {
      usable: false,
      severity: "blocking",
      ratio: null,
      message:
        "No molecular weight is recorded for this substance, so concentrations " +
        "cannot be converted between mass and ppm. Choose a different substance, " +
        "or supply a molecular weight.",
    };
  }

  if (ratio < 0.9) {
    return {
      usable: true,
      severity: "note",
      ratio,
      message:
        `This vapour is lighter than air (${ratio.toFixed(2)} times its density) and will ` +
        `tend to rise. The Gaussian model does not account for buoyant rise, so ` +
        `ground-level concentrations may be overstated — the conservative direction, ` +
        `but worth knowing when reading the result.`,
    };
  }

  // Denser than air, or close to it. No banner: the ratio is in the readout,
  // and the model choice is made at the Source step.
  return { usable: true, severity: "ok", ratio, message: null };
}

/**
 * The Levels of Concern available for a substance, formatted for display and
 * for handing to the dispersion engine.
 *
 * PAC-1, PAC-2 and PAC-3 correspond to increasing severity: mild and
 * transient effects, effects serious enough to impair escape, and
 * life-threatening effects. They map onto the yellow, orange and red threat
 * zones that ALOHA popularised and that HAZEL follows.
 */
/**
 * Fraction of the lower explosive limit ALOHA uses as the flash-fire /
 * flammable-area threshold (Tech Doc section 6.6): 60%, chosen by the
 * project's external review team to account for the time-averaging in the
 * concentration calculation — a location whose AVERAGE concentration sits
 * just under the LEL can still have brief excursions above it.
 */
const FLAMMABLE_AREA_FRACTION_OF_LEL = 0.6;

export function levelsOfConcern(chemical) {
  const levels = [
    {
      id: "pac3",
      label: "PAC-3",
      description: "Life-threatening health effects",
      ppm: chemical.pac3Ppm,
      colour: "red",
    },
    {
      id: "pac2",
      label: "PAC-2",
      description: "Serious effects, or impaired ability to escape",
      ppm: chemical.pac2Ppm,
      colour: "orange",
    },
    {
      id: "pac1",
      label: "PAC-1",
      description: "Mild, transient effects",
      ppm: chemical.pac1Ppm,
      colour: "yellow",
    },
  ];

  // Only offered for substances the dataset actually records an LEL for —
  // which, correctly, excludes non-flammable toxics like chlorine (an
  // oxidiser) even though they have PAC thresholds above.
  //
  // This is not a fourth toxicity severity level — it answers a different
  // question (where could the cloud catch fire, not where could it poison
  // someone) — which is why it gets its own colour rather than extending
  // the red/orange/yellow toxicity gradient. Reuses whichever dispersion
  // engine the scenario already selected (Gaussian or heavy gas); ALOHA
  // does not model flash-fire thermal radiation separately (Tech Doc
  // section 6.6) — ground-level concentration crossing 60% of the LEL IS
  // the hazard boundary.
  if (Number.isFinite(chemical.lowerExplosiveLimitPpm)) {
    levels.push({
      id: "flash",
      label: "Flash fire",
      description: "Flammable area — 60% of the lower explosive limit",
      ppm: chemical.lowerExplosiveLimitPpm * FLAMMABLE_AREA_FRACTION_OF_LEL,
      colour: "flame",
    });
  }

  return levels;
}

/** True when the substance has at least one usable threshold and a molecular weight. */
export function isUsableForDispersion(chemical) {
  if (!chemical) return false;
  if (!Number.isFinite(chemical.molecularWeight)) return false;
  return [chemical.pac1Ppm, chemical.pac2Ppm, chemical.pac3Ppm].some((v) =>
    Number.isFinite(v)
  );
}
