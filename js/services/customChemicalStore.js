/**
 * customChemicalStore.js
 * -----------------------
 * User-maintained additions to the chemical database: substances entirely
 * missing from the DOE PAC/TEEL dataset, and enrichments/overrides layered
 * onto substances that ARE in it but are missing a parameter HAZEL's models
 * need (upper explosive limit, heat of combustion, boiling point, liquid
 * density/heat capacity — the same gaps documented throughout this project,
 * see chemicalDatabase.js, convert_pac_data.py, engineLimitations.js).
 *
 * "Adding" vs. "editing an existing one" (both requested by the project
 * owner) turn out to be the SAME mechanism here, distinguished only by
 * whether a record's casNumber matches one already in the built-in
 * database:
 *
 *   - casNumber set, and it matches a built-in record -> an OVERRIDE. Only
 *     the fields the user actually filled in are used; everything else
 *     (including the official PAC-1/2/3 toxicity thresholds) still comes
 *     from the built-in record. See mergeCustomChemicalOntoBuiltIn().
 *   - casNumber unset, or it matches nothing built-in -> a wholly new,
 *     standalone substance. Every field the models need must come from the
 *     record itself.
 *
 * WHY THIS MATTERS FOR TANK RELEASES SPECIFICALLY
 * --------------------------------------------------
 * engineLimitations.js's "hazel-tank-phase-selection" entry describes a real
 * gap: the tank release model cannot tell a liquefied gas under pressure
 * (propane, chlorine — correctly modelled as a liquid that flashes) apart
 * from a genuinely non-condensable compressed gas (hydrogen, CNG) without
 * critical-temperature data the built-in dataset does not carry. A custom
 * entry can supply that data (critical temperature and pressure, acentric
 * factor — 2026-10-02) or simply declare the substance non-condensable with
 * the isNonCondensableGas checkbox; stepSource.js uses either to choose the
 * compressed-gas tank model, and the critical constants also give the
 * real-gas correction of the tank's contents.
 *
 * STORAGE
 * -------
 * IndexedDB, in its own database — same reasoning as scenarioStorage.js's
 * module comment: a separate database per concern avoids coordinating a
 * shared version number across independent modules. Lives only on the
 * device that created it; HAZEL has no server to sync it to. Because this
 * store can accumulate many detailed records over time (unlike a handful of
 * saved scenarios), estimateStorageUsage() and the export/import functions
 * below exist specifically so a user is not solely dependent on browser
 * storage surviving forever — see the module's export/import section.
 *
 * PURE VS. STORAGE-BACKED FUNCTIONS
 * ------------------------------------
 * validateCustomChemicalRecord(), sanitizeCustomChemicalRecord(),
 * mergeCustomChemicalOntoBuiltIn() and toDisplayRecord() do not touch
 * IndexedDB and are exercised directly in customChemicalTests.js. Everything
 * below the "STORAGE-BACKED" divider calls indexedDB and can only be
 * exercised in a browser (the same limitation scenarioStorage.js already
 * has — there is no dedicated test file for it either, for the same reason).
 */

const DB_NAME = "hazel-custom-chemicals";
const DB_VERSION = 1;
const STORE_NAME = "chemicals";

/** Fields a custom record may carry, beyond the required name/molecularWeight.
 *  Listed once so validation, sanitisation and the merge logic all agree on
 *  exactly which keys exist — a field added to one but not the others is a
 *  silent bug (an override that never overrides, or a field that survives
 *  sanitisation but not export). */
const OPTIONAL_NUMERIC_FIELDS = [
  "pac1Ppm",
  "pac2Ppm",
  "pac3Ppm",
  "lowerExplosiveLimitPpm",
  "upperExplosiveLimitPpm",
  "heatOfCombustion",
  "boilingPointK",
  "heatOfVaporization",
  "liquidDensity",
  "liquidHeatCapacity",
  // Critical constants (2026-10-02): used for the real-gas (compressibility)
  // correction of a compressed-gas tank and for deciding whether a tank can
  // hold the substance as a liquid at all — see stepSource.js.
  "criticalTemperatureK",
  "criticalPressureBar",
  "acentricFactor",
];

/* ========================================================================
   PURE FUNCTIONS — no IndexedDB, safe to unit test in Node
   ======================================================================== */

/**
 * Digits-only CAS comparison, matching chemicalDatabase.js's own
 * normaliseCas() (not exported there, so reimplemented here rather than
 * reaching into that module's internals for a one-line helper). People type
 * CAS numbers with and without hyphens and stray whitespace; comparing
 * digits only makes all of those match.
 */
export function normaliseCasForCompare(text) {
  if (!text) return "";
  return String(text).replace(/[^\d]/g, "");
}

/**
 * Checks a custom chemical record before it is stored.
 *
 * Deliberately permissive about which fields are present — a record whose
 * only purpose is to add an upper explosive limit to an existing chemical
 * legitimately has nothing else set — but strict about the two things every
 * downstream engine needs regardless: a name to show, and (for a standalone
 * substance) a molecular weight, since every dispersion calculation in this
 * project converts between mass and ppm concentration using it. An override
 * record (casNumber matches a built-in substance) can omit molecular weight
 * — the built-in record's own value is used, see mergeCustomChemicalOntoBuiltIn().
 *
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateCustomChemicalRecord(input, { isOverride = false } = {}) {
  const errors = [];
  const name = String(input?.name ?? "").trim();

  if (name.length === 0) {
    errors.push("A substance name is required.");
  }

  const molecularWeight = input?.molecularWeight;
  const hasMolecularWeight = molecularWeight !== null && molecularWeight !== undefined && molecularWeight !== "";
  if (!isOverride && !hasMolecularWeight) {
    errors.push("A molecular weight is required for a new, standalone substance.");
  }
  if (hasMolecularWeight && (!Number.isFinite(Number(molecularWeight)) || Number(molecularWeight) <= 0)) {
    errors.push("Molecular weight must be a positive number.");
  }

  for (const field of OPTIONAL_NUMERIC_FIELDS) {
    const value = input?.[field];
    if (value === null || value === undefined || value === "") continue;
    if (!Number.isFinite(Number(value))) {
      errors.push(`The "${field}" field must be a number, if filled in.`);
    }
  }

  const lel = input?.lowerExplosiveLimitPpm;
  const uel = input?.upperExplosiveLimitPpm;
  const hasLel = lel !== null && lel !== undefined && lel !== "";
  const hasUel = uel !== null && uel !== undefined && uel !== "";
  if (hasLel && hasUel && Number(uel) <= Number(lel)) {
    errors.push("The upper explosive limit must be greater than the lower one.");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Coerces a raw form/import object into the exact shape stored in
 * IndexedDB: every optional numeric field is either a finite number or
 * null (never an empty string, never NaN — both of which would silently
 * poison every Number.isFinite() check downstream in the engines that
 * consume this record, the exact bug fireFieldValueFromInput() exists to
 * prevent elsewhere in this project — see fireExplosionPanel.js).
 *
 * Does not validate — call validateCustomChemicalRecord() first and refuse
 * to sanitise/store an invalid record.
 */
export function sanitizeCustomChemicalRecord(input) {
  const trimmedOrNull = (value) => {
    const text = String(value ?? "").trim();
    return text.length > 0 ? text : null;
  };
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const record = {
    name: String(input?.name ?? "").trim(),
    casNumber: trimmedOrNull(input?.casNumber),
    molecularFormula: trimmedOrNull(input?.molecularFormula),
    state25C: trimmedOrNull(input?.state25C),
    molecularWeight: numberOrNull(input?.molecularWeight),
    isNonCondensableGas: Boolean(input?.isNonCondensableGas),
    notes: trimmedOrNull(input?.notes),
  };

  for (const field of OPTIONAL_NUMERIC_FIELDS) {
    record[field] = numberOrNull(input?.[field]);
  }

  return record;
}

/**
 * Layers a custom record's non-null fields onto a built-in database record,
 * producing what stepChemical.js should treat as "the selected chemical"
 * from then on — every existing consumer (levelsOfConcern(),
 * isUsableForDispersion(), describeVapourDensity(), the Source and
 * fire/explosion steps) already reads exactly this shape, so nothing
 * downstream needs to know an override happened.
 *
 * Official toxicity thresholds (PAC-1/2/3) are only overridden if the user
 * explicitly set them — the default is to trust the DOE dataset for the
 * numbers it actually publishes, and use the custom record only to ADD what
 * it does not.
 */
export function mergeCustomChemicalOntoBuiltIn(builtInRecord, customRecord) {
  const merged = { ...builtInRecord };

  for (const field of OPTIONAL_NUMERIC_FIELDS) {
    if (customRecord[field] !== null && customRecord[field] !== undefined) {
      merged[field] = customRecord[field];
    }
  }
  if (customRecord.molecularWeight !== null && customRecord.molecularWeight !== undefined) {
    merged.molecularWeight = customRecord.molecularWeight;
  }
  if (customRecord.molecularFormula) merged.molecularFormula = customRecord.molecularFormula;
  if (customRecord.state25C) merged.state25C = customRecord.state25C;

  merged.isNonCondensableGas = customRecord.isNonCondensableGas;
  merged.hasCustomOverride = true;
  merged.customId = customRecord.id;
  merged.customNotes = customRecord.notes;

  return merged;
}

/**
 * Shapes a standalone custom record (no matching built-in substance) into
 * the same record shape chemicalDatabase.js's slim index produces, so every
 * function written against "a chemical record" — levelsOfConcern(),
 * isUsableForDispersion(), the search result rendering in stepChemical.js —
 * works on it unmodified.
 */
export function toDisplayRecord(customRecord) {
  return {
    casNumber: customRecord.casNumber ?? `CUSTOM-${customRecord.id}`,
    name: customRecord.name,
    molecularFormula: customRecord.molecularFormula,
    state25C: customRecord.state25C ?? "unknown",
    molecularWeight: customRecord.molecularWeight,
    pac1Ppm: customRecord.pac1Ppm,
    pac2Ppm: customRecord.pac2Ppm,
    pac3Ppm: customRecord.pac3Ppm,
    lowerExplosiveLimitPpm: customRecord.lowerExplosiveLimitPpm,
    upperExplosiveLimitPpm: customRecord.upperExplosiveLimitPpm,
    heatOfCombustion: customRecord.heatOfCombustion,
    boilingPointK: customRecord.boilingPointK,
    heatOfVaporization: customRecord.heatOfVaporization,
    liquidDensity: customRecord.liquidDensity,
    liquidHeatCapacity: customRecord.liquidHeatCapacity,
    criticalTemperatureK: customRecord.criticalTemperatureK,
    criticalPressureBar: customRecord.criticalPressureBar,
    acentricFactor: customRecord.acentricFactor,
    isNonCondensableGas: customRecord.isNonCondensableGas,
    originalUnit: null,
    searchName: String(customRecord.name || "").toLowerCase(),
    isCustom: true,
    customId: customRecord.id,
    hasCustomOverride: false,
  };
}

/* ========================================================================
   STORAGE-BACKED FUNCTIONS — IndexedDB, browser only
   ======================================================================== */

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        // Lets an override lookup for a selected CAS number avoid loading
        // and scanning every record in memory on every chemical selection.
        store.createIndex("casNumber", "casNumber");
        store.createIndex("updatedAt", "updatedAt");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Adds a new custom chemical (standalone substance or override), after
 * validating and sanitising it.
 *
 * @param {object} input - raw form values
 * @returns {Promise<number>} the id assigned to the new record
 * @throws {Error} if the record fails validation — message lists every problem
 */
export async function addCustomChemical(input) {
  const isOverride = Boolean(String(input?.casNumber ?? "").trim());
  const { valid, errors } = validateCustomChemicalRecord(input, { isOverride });
  if (!valid) throw new Error(errors.join(" "));

  const now = Date.now();
  const record = { ...sanitizeCustomChemicalRecord(input), createdAt: now, updatedAt: now };

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const request = tx.objectStore(STORE_NAME).add(record);
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Updates an existing custom chemical by id, re-validating the merged result. */
export async function updateCustomChemical(id, changes) {
  const existing = await getCustomChemical(id);
  if (!existing) throw new Error(`No custom chemical entry with id ${id}`);

  const merged = { ...existing, ...changes };
  const isOverride = Boolean(String(merged.casNumber ?? "").trim());
  const { valid, errors } = validateCustomChemicalRecord(merged, { isOverride });
  if (!valid) throw new Error(errors.join(" "));

  const record = {
    ...sanitizeCustomChemicalRecord(merged),
    id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => {
      db.close();
      resolve(record);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Deletes one custom chemical entry by id. */
export async function deleteCustomChemical(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Loads one custom chemical entry in full, by id, or null. */
export async function getCustomChemical(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/** Lists every custom chemical entry, alphabetically by name. */
export async function listCustomChemicals() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => {
      const results = [...request.result].sort((a, b) => a.name.localeCompare(b.name));
      resolve(results);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Finds the custom override (if any) for a built-in CAS number.
 *
 * Used by stepChemical.js at selection time, and nowhere else — the search
 * results list itself does not need to know which built-in substances have
 * an override until one is actually opened, keeping every keystroke of a
 * search cheap.
 */
export async function findCustomOverrideByCas(casNumber) {
  const digits = normaliseCasForCompare(casNumber);
  if (!digits) return null;
  const all = await listCustomChemicals();
  return all.find((r) => r.casNumber && normaliseCasForCompare(r.casNumber) === digits) ?? null;
}

/* ========================================================================
   EXPORT / IMPORT — the user's own backup, independent of "download the
   whole database" in pageLibrary.js (which is the public DOE dataset and
   never includes anything from this store)
   ======================================================================== */

const EXPORT_FORMAT_VERSION = 1;

/**
 * Serialises every custom entry to a JSON string suitable for downloading.
 *
 * A user's custom library can grow into a genuinely large, hand-curated
 * dataset over time (see the module docstring) and lives ONLY in this
 * browser's IndexedDB — clearing site data, switching browsers, or a
 * cleared profile loses it outright, with no server copy to recover it
 * from. This export is that user's own backup and portability mechanism,
 * independent of anything HAZEL itself does automatically.
 */
export async function exportCustomChemicalsJson() {
  const chemicals = await listCustomChemicals();
  return JSON.stringify(
    {
      format: "hazel-custom-chemicals",
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      count: chemicals.length,
      chemicals: chemicals.map(({ id, ...rest }) => rest), // ids are local to this device's database; re-imported records get new ones
    },
    null,
    2
  );
}

/**
 * Imports custom chemicals from a previously exported JSON file.
 *
 * Every record is added as a NEW entry (never overwriting an existing one
 * by matching id or CAS number) — ids are assigned per-device by IndexedDB's
 * autoincrement, so an id from an export cannot safely be reused as an
 * update target on a different device or after the store has changed since
 * export. A user re-importing their own backup onto the same device will
 * end up with duplicates if entries were never deleted meanwhile; the
 * returned summary's `skipped` list is exactly the entries invalid enough
 * to refuse, so the caller can show the user what needs attention rather
 * than silently dropping rows.
 *
 * @param {string} jsonText
 * @returns {Promise<{added: number, skipped: Array<{name: string, errors: string[]}>}>}
 */
export async function importCustomChemicalsJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("This file does not contain valid JSON.");
  }

  const chemicals = Array.isArray(parsed?.chemicals) ? parsed.chemicals : Array.isArray(parsed) ? parsed : null;
  if (!chemicals) {
    throw new Error(
      "Unexpected file format — expected an export produced by the " +
        '"Download your entries" button in this app.'
    );
  }

  let added = 0;
  const skipped = [];

  for (const raw of chemicals) {
    const isOverride = Boolean(String(raw?.casNumber ?? "").trim());
    const { valid, errors } = validateCustomChemicalRecord(raw, { isOverride });
    if (!valid) {
      skipped.push({ name: raw?.name ?? "(unnamed)", errors });
      continue;
    }
    await addCustomChemical(raw);
    added++;
  }

  return { added, skipped };
}

/* ========================================================================
   STORAGE FOOTPRINT
   ======================================================================== */

/**
 * Estimates how much of the browser's storage quota HAZEL is using.
 *
 * The custom chemical store is the one part of HAZEL's local storage a
 * heavy user can grow without bound (saved scenarios and the weather cache
 * are both self-limiting in practice; a personal chemical library is not),
 * so this is surfaced in pageLibrary.js specifically alongside it — not
 * because IndexedDB usage is otherwise a concern for this application.
 *
 * navigator.storage.estimate() reports usage for the WHOLE origin (every
 * IndexedDB database HAZEL has, plus the service worker's cache), not just
 * this store — there is no browser API to attribute usage to one database —
 * so the figure shown is "how much of your device's storage HAZEL as a
 * whole is using", with that caveat stated in the UI rather than implied.
 *
 * @returns {Promise<{supported: boolean, usageBytes: number|null, quotaBytes: number|null}>}
 */
export async function estimateStorageUsage() {
  if (!navigator?.storage?.estimate) {
    return { supported: false, usageBytes: null, quotaBytes: null };
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { supported: true, usageBytes: usage ?? null, quotaBytes: quota ?? null };
  } catch {
    return { supported: false, usageBytes: null, quotaBytes: null };
  }
}
