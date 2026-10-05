/**
 * locationService.js
 * ------------------
 * Optional network lookups for the Location step: address search, ground
 * elevation, and a terrain-based roughness suggestion.
 *
 * Every function here is an enrichment, not a dependency. Each one can fail —
 * no relay configured, no network, service unreachable — and the Location step
 * carries on, because coordinates can always be typed in directly and that
 * path touches no network at all. Nothing downstream ever assumes a lookup
 * succeeded.
 *
 * Data sources, both openly licensed and both requiring attribution where
 * their data is shown:
 *   - Nominatim / OpenStreetMap for geocoding and terrain (ODbL)
 *   - Copernicus DEM for elevation, served via OpenTopoData
 */

import { config } from "../../config.js";
import { validateCoordinates } from "../engine/coordinates.js";

/* ---------- Availability ---------- */

export function isGeocodingAvailable() {
  return Boolean(config.geocodingRelayUrl);
}

export function isElevationAvailable() {
  return Boolean(config.elevationRelayUrl);
}

export function isTerrainLookupAvailable() {
  return Boolean(config.terrainRelayUrl);
}

/* ---------- Address search ---------- */

/**
 * Searches for a place by name or address.
 *
 * @param {string} query - free text, e.g. "A2 motorway Eindhoven"
 * @returns {Promise<Array<{label: string, lat: number, lng: number}>>}
 * @throws {Error} when geocoding is unavailable or the request fails
 */
export async function searchPlaces(query) {
  if (!isGeocodingAvailable()) {
    throw new Error(
      "Address search is not configured for this installation. Enter coordinates directly."
    );
  }

  const trimmed = query.trim();
  if (trimmed.length < 3) {
    throw new Error("Enter at least three characters to search");
  }

  const url = new URL(config.geocodingRelayUrl);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error(
      "Could not reach the address search service. Enter coordinates directly instead."
    );
  }

  if (!response.ok) {
    throw new Error(`Address search returned an error (${response.status}).`);
  }

  const results = await response.json();

  return results.map((item) => ({
    label: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
  }));
}

/* ---------- Elevation ---------- */

/**
 * Looks up ground elevation above sea level.
 *
 * Note this does not feed the Gaussian model, which assumes flat terrain — see
 * the "terrain" entry in engineLimitations.js. It is recorded because it
 * belongs in the incident record, and because the heavy gas model does use
 * slope once it exists.
 *
 * @returns {Promise<number>} metres above sea level
 */
export async function lookupElevation(lat, lng) {
  if (!isElevationAvailable()) {
    throw new Error("Elevation lookup is not configured for this installation.");
  }

  validateCoordinates(lat, lng);

  const url = new URL(config.elevationRelayUrl);
  url.searchParams.set("lat", lat.toFixed(5));
  url.searchParams.set("lon", lng.toFixed(5));

  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Could not reach the elevation service.");
  }

  if (!response.ok) {
    throw new Error(`Elevation lookup returned an error (${response.status}).`);
  }

  const payload = await response.json();
  const elevation = payload?.elevation ?? payload?.results?.[0]?.elevation;

  if (!Number.isFinite(elevation)) {
    throw new Error("The elevation service returned no usable value.");
  }

  return elevation;
}

/* ---------- Terrain, for a roughness suggestion ---------- */

/**
 * Maps an OpenStreetMap land use tag to one of the ground roughness presets
 * the Weather step offers.
 *
 * This is deliberately coarse. Surface roughness is a continuum and OSM tags
 * describe land use rather than aerodynamic roughness, so the mapping can only
 * ever be an informed guess. That is why the result is presented as a
 * suggestion for the user to accept, never applied silently — a wrong
 * roughness quietly substituted for the right one would shift the threat
 * distance with nothing on screen to explain why.
 *
 * @param {string} landuse - an OSM landuse, natural or place tag value
 * @returns {{ preset: string, reason: string } | null}
 */
export function roughnessSuggestionFromLanduse(landuse) {
  if (!landuse) return null;

  const urbanTags = [
    "residential", "commercial", "industrial", "retail",
    "construction", "city", "town", "suburb", "village",
  ];
  const forestTags = ["forest", "wood", "scrub"];
  const openTags = [
    "farmland", "meadow", "grass", "grassland", "heath",
    "orchard", "vineyard", "allotments", "farmyard", "cemetery",
  ];
  const waterTags = ["water", "bay", "strait", "sea", "reservoir", "wetland"];

  if (urbanTags.includes(landuse)) {
    return {
      preset: "urbanOrForest",
      reason: `built-up area (OSM: ${landuse})`,
    };
  }
  if (forestTags.includes(landuse)) {
    return {
      preset: "urbanOrForest",
      reason: `woodland (OSM: ${landuse})`,
    };
  }
  if (openTags.includes(landuse)) {
    return {
      preset: "openCountry",
      reason: `open ground (OSM: ${landuse})`,
    };
  }
  if (waterTags.includes(landuse)) {
    return {
      preset: "openWater",
      reason: `water (OSM: ${landuse})`,
    };
  }

  return null;
}

/**
 * Looks up the dominant land use around a point and turns it into a roughness
 * suggestion.
 *
 * @returns {Promise<{preset: string, reason: string} | null>}
 */
export async function suggestRoughness(lat, lng) {
  if (!isTerrainLookupAvailable()) return null;

  validateCoordinates(lat, lng);

  const url = new URL(config.terrainRelayUrl);
  url.searchParams.set("lat", lat.toFixed(5));
  url.searchParams.set("lon", lng.toFixed(5));

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;

    const payload = await response.json();
    return roughnessSuggestionFromLanduse(payload?.landuse);
  } catch {
    // A failed suggestion is not worth interrupting the user over — the
    // roughness selector already has a sensible default.
    return null;
  }
}
