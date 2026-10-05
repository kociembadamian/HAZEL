/**
 * scenarioStorage.js
 * ------------------
 * Saves and loads complete scenarios on the user's own device.
 *
 * A separate IndexedDB database from weatherStorage.js's cache, deliberately.
 * Coordinating a shared database's version number across two independent
 * modules — each adding its own object store — is a well-known source of
 * fragile bugs (a version bump in one module can lock the other out with a
 * confusing VersionError). Two small databases are simpler to reason about
 * than one shared one with cross-module coupling, and the storage overhead
 * of a second database is negligible.
 *
 * As with the weather cache, everything here lives only on the device that
 * saved it. HAZEL has no server to send a saved scenario to even if it
 * wanted to.
 */

const DB_NAME = "hazel-scenarios";
const DB_VERSION = 1;
const STORE_NAME = "scenarios";

/**
 * Builds a short, human-readable description of a scenario — the substance
 * and the location, when either is known.
 *
 * Stored alongside the scenario at save time so the Saved page can list what
 * each entry is about without loading every full record just to show a list,
 * and reused by the Results step so a reopened scenario identifies itself
 * immediately rather than requiring a trip back to the Chemical step to find
 * out what it was modelling.
 *
 * @param {object} scenario - state.current.scenario
 * @returns {string}
 */
export function summariseScenario(scenario) {
  const parts = [];

  const chemical = scenario?.chemical?.selected;
  if (chemical) parts.push(chemical.name);

  const location = scenario?.location;
  if (location?.address) {
    parts.push(location.address);
  } else if (location && location.lat !== null && location.lat !== undefined) {
    parts.push(`${location.lat.toFixed(3)}, ${location.lng.toFixed(3)}`);
  }

  return parts.length > 0 ? parts.join(" — ") : "Untitled scenario";
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
        // Lets the Saved page list scenarios newest-first without loading
        // every record and sorting in memory.
        store.createIndex("savedAt", "savedAt");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Saves a scenario under a name the user chooses.
 *
 * The scenario object is stored as given — a deep clone of
 * state.current.scenario at the moment of saving — so loading it later
 * restores exactly what was there, not a live reference that could have
 * changed since.
 *
 * @param {string} name
 * @param {object} scenario - state.current.scenario
 * @returns {Promise<number>} the id assigned to the saved record
 */
export async function saveScenario(name, scenario) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const request = tx.objectStore(STORE_NAME).add({
      name,
      savedAt: Date.now(),
      summary: summariseScenario(scenario),
      scenario: structuredClone(scenario),
    });

    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/**
 * Lists saved scenarios, most recently saved first.
 *
 * @returns {Promise<Array<{id: number, name: string, savedAt: number}>>}
 *   Deliberately omits the full scenario payload — the Saved page only needs
 *   enough to show a list; loadScenario() fetches one in full when chosen.
 */
export async function listScenarios() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).index("savedAt").getAll();

    request.onsuccess = () => {
      const results = request.result
        .map(({ id, name, savedAt, summary }) => ({ id, name, savedAt, summary }))
        .sort((a, b) => b.savedAt - a.savedAt);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/** Loads one saved scenario in full, by id. */
export async function loadScenario(id) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/** Deletes one saved scenario, by id. */
export async function deleteScenario(id) {
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
