/**
 * weatherStorage.js
 * -----------------
 * Caches fetched weather on the user's own device, in IndexedDB.
 *
 * The privacy position this implements: whoever fetched the data keeps it.
 * Nothing about a location a user asked about is ever stored on a server —
 * the relay (see config.js) passes requests through without retaining them,
 * and the answer lives only here, in the browser, under the user's control.
 *
 * IndexedDB rather than localStorage because it stores structured objects
 * without serialising by hand, works asynchronously so it never blocks
 * rendering, and has a far larger quota — which will matter once saved
 * scenarios are added alongside this.
 *
 * Every entry carries a fetchedAt timestamp. Age, not just presence, decides
 * what the user is shown: the Weather step tells them how old the reading is
 * and lets them decide whether to refresh or proceed with what they have.
 * That choice belongs to the user, especially offline.
 */

const DB_NAME = "hazel";
const DB_VERSION = 1;
const STORE_NAME = "weatherCache";

/** Opens the database, creating the object store on first use. */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Keyed by a rounded lat/lon string — see cacheKeyFor() below.
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Builds the cache key for a location.
 *
 * Coordinates are rounded to two decimal places, roughly one kilometre. Two
 * reasons: weather does not vary meaningfully below that scale for dispersion
 * purposes, and it means repeated lookups around the same incident reuse one
 * cache entry instead of filling the store with near-duplicates.
 */
export function cacheKeyFor(latitude, longitude) {
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

/**
 * Stores a weather reading for a location.
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {object} weather - normalised weather object (see weatherService.js)
 * @returns {Promise<void>}
 */
export async function saveWeather(latitude, longitude, weather) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      key: cacheKeyFor(latitude, longitude),
      latitude,
      longitude,
      weather,
      fetchedAt: Date.now(),
    });
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

/**
 * Reads the cached weather for a location, if any.
 *
 * @returns {Promise<{weather: object, fetchedAt: number, ageMinutes: number}|null>}
 */
export async function loadWeather(latitude, longitude) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(cacheKeyFor(latitude, longitude));

    request.onsuccess = () => {
      db.close();
      const record = request.result;
      if (!record) {
        resolve(null);
        return;
      }
      resolve({
        weather: record.weather,
        fetchedAt: record.fetchedAt,
        ageMinutes: Math.floor((Date.now() - record.fetchedAt) / 60000),
      });
    };

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

/**
 * Deletes everything in the weather cache.
 *
 * Exposed so the Settings screen can offer it. A user who can see that data is
 * held on their device should also be able to remove it without clearing
 * their whole browser profile.
 */
export async function clearWeatherCache() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
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

/**
 * Formats an age in minutes as something a person reads at a glance.
 * Used by the staleness banner in the Weather step.
 */
export function describeAge(ageMinutes) {
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${ageMinutes} min ago`;

  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
