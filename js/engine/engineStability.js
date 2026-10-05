/**
 * engineStability.js
 * ------------------
 * Determines the Pasquill-Gifford-Turner atmospheric stability class, which is
 * the single most influential input to the dispersion calculation: it selects
 * which set of Briggs coefficients the model uses, and thus how quickly the
 * plume spreads.
 *
 * This module implements the Turner (1964) lookup. Insolation can be supplied
 * two ways:
 *
 *   - from solar elevation, when the incident time and coordinates are known
 *     (the Location step provides both). This is what ALOHA does, per Tech Doc
 *     section 4.2.2, and is the more accurate path: a low winter sun and a
 *     high summer sun produce very different stability for otherwise identical
 *     weather.
 *
 *   - from cloud cover and a day/night flag alone, when coordinates have not
 *     been set. Coarser, but it keeps the Weather step usable on its own.
 *
 * Where more than one class fits the conditions, ALOHA selects the MORE STABLE
 * one, because a more stable atmosphere disperses the cloud less and therefore
 * produces a larger threat zone. HAZEL follows that convention: when in doubt,
 * overestimate the hazard.
 */

import { MIN_WIND_SPEED } from "./engineConstants.js";

/**
 * Daytime insolation categories used by the Turner method.
 * "strong"   - clear sky, high sun (solar elevation above ~60 degrees)
 * "moderate" - mid sun or light cloud
 * "slight"   - low sun or substantial cloud
 */
export const INSOLATION = ["strong", "moderate", "slight"];

/**
 * Night-time cloud cover categories used by the Turner method.
 * "cloudy" - cloud cover 4/8 or more (thinly overcast or greater)
 * "clear"  - cloud cover 3/8 or less
 */
export const NIGHT_CLOUD = ["cloudy", "clear"];

/**
 * Turner's stability class lookup, keyed by wind speed band at 10 m.
 * Bands follow [TechDoc Table 10]: "<2, 2-3, 3-5, 5-6, >6" (m/s).
 *
 * BUG FIX (2026-09-27): found by running the identical scenario (chlorine,
 * 10 kg/s, 600 s, wind 5 m/s, night, ~40% cloud cover) through real ALOHA
 * side-by-side with HAZEL. ALOHA reported stability class E; HAZEL reported D
 * for the same inputs — a difference that alone accounts for a large share of
 * the two tools' diverging threat distances, since E vs D changes both the
 * Briggs dispersion coefficients (engineGaussian.js) and the wind-profile
 * exponent used throughout the heavy-gas Richardson-number calculation
 * (engineDispersionChoice.js, engineHeavyGas.js).
 *
 * Root cause: the published table's band boundaries ("3-5", "5-6", ...) are
 * ambiguous about which side an exact boundary value belongs to, and this
 * lookup previously matched a station on the LOWER-wind side of a shared
 * boundary (`windSpeed10m < row.maxWind`, so wind == 5 fell into the "5-6"
 * row rather than "3-5"). ALOHA's manually-entered-weather stability method
 * evidently does the opposite for this table: it keeps a boundary value in
 * the band whose upper limit it equals ("3-5" includes 5), not the band
 * whose lower limit it equals. Confirmed empirically (real ALOHA run,
 * 2026-09-27), not merely inferred from the table's prose. Fixed by matching
 * `windSpeed10m <= row.maxWind` instead: a wind speed exactly ON a
 * boundary (2, 3, 5, or 6 m/s — all common, round, frequently-entered
 * values) now lands in the same band ALOHA puts it in.
 *
 * Where the original table gives a pair such as "A-B", the more stable of the
 * two is used (B in that example), per the ALOHA convention described above.
 *
 * SECOND FIX (2026-09-27, same day): while checking the boundary fix above
 * against the authoritative primary source — Turner, D.B. (1994) "Workbook of
 * Atmospheric Dispersion Estimates", 2nd ed., Table 2.2 "Key to Pasquill
 * stability categories" (the exact table ALOHA's own Tech Doc Table 10 cites
 * as its source) — a second, unrelated transcription error turned up: for the
 * 3-5 m/s wind band, daytime, SLIGHT insolation, Table 2.2 gives class D, but
 * this table had "C". Confirmed directly against a photographed page of the
 * cited 1994 edition (not inferred). Fixed below. This only affects daytime
 * scenarios with wind 3-5 m/s under light/hazy sun or heavy daytime cloud, so
 * it did not surface in the (night-time) ALOHA comparison run that found the
 * boundary bug above. Every other cell in this table was checked cell-by-cell
 * against Table 2.2 and matches.
 */
const TURNER_TABLE = [
  // maxWind is INCLUSIVE: the band applies while windSpeed <= maxWind (see
  // the bug-fix note above for why this is inclusive rather than exclusive).
  {
    maxWind: 2,
    day: { strong: "A", moderate: "B", slight: "B" },
    night: { cloudy: "F", clear: "F" },
  },
  {
    maxWind: 3,
    day: { strong: "B", moderate: "B", slight: "C" },
    night: { cloudy: "E", clear: "F" },
  },
  {
    maxWind: 5,
    day: { strong: "B", moderate: "C", slight: "D" },
    night: { cloudy: "D", clear: "E" },
  },
  {
    maxWind: 6,
    day: { strong: "C", moderate: "D", slight: "D" },
    night: { cloudy: "D", clear: "D" },
  },
  {
    maxWind: Infinity,
    day: { strong: "C", moderate: "D", slight: "D" },
    night: { cloudy: "D", clear: "D" },
  },
];

/**
 * Determines the stability class from conditions a user can enter manually.
 *
 * @param {object} options
 * @param {number} options.windSpeed10m - wind speed at 10 m, in m/s
 * @param {boolean} options.isDaytime - true for daytime, false for night
 * @param {string} [options.insolation] - "strong" | "moderate" | "slight" (daytime only)
 * @param {string} [options.nightCloud] - "cloudy" | "clear" (night only)
 * @returns {string} one of "A".."F"
 */
export function determineStabilityClass({
  windSpeed10m,
  isDaytime,
  insolation = "moderate",
  nightCloud = "cloudy",
}) {
  if (!Number.isFinite(windSpeed10m) || windSpeed10m < 0) {
    throw new Error("determineStabilityClass: windSpeed10m must be a positive number");
  }

  const band = TURNER_TABLE.find((row) => windSpeed10m <= row.maxWind);

  if (isDaytime) {
    if (!INSOLATION.includes(insolation)) {
      throw new Error(`determineStabilityClass: unknown insolation "${insolation}"`);
    }
    return band.day[insolation];
  }

  if (!NIGHT_CLOUD.includes(nightCloud)) {
    throw new Error(`determineStabilityClass: unknown nightCloud "${nightCloud}"`);
  }
  return band.night[nightCloud];
}

/**
 * Converts a cloud cover reading in eighths (oktas, 0-8) into the day/night
 * category the Turner table expects. This is the bridge between what a weather
 * API returns (cloud cover as a percentage or in oktas) and what the stability
 * lookup needs.
 *
 * The daytime mapping here is a coarse one based on cloud cover alone. It is
 * intentionally conservative: heavy cloud is treated as "slight" insolation,
 * which yields a more stable class and a larger threat zone. Once solar
 * altitude is available from the Weather step this mapping will be refined.
 *
 * @param {number} oktas - cloud cover, 0 (clear) to 8 (overcast)
 * @param {boolean} isDaytime
 * @returns {{ insolation?: string, nightCloud?: string }}
 */
export function cloudCoverToCategory(oktas, isDaytime) {
  if (!Number.isFinite(oktas) || oktas < 0 || oktas > 8) {
    throw new Error("cloudCoverToCategory: oktas must be between 0 and 8");
  }

  if (isDaytime) {
    if (oktas <= 2) return { insolation: "strong" };
    if (oktas <= 5) return { insolation: "moderate" };
    return { insolation: "slight" };
  }

  return { nightCloud: oktas >= 4 ? "cloudy" : "clear" };
}

/**
 * Reports whether the wind speed is inside the range where the dispersion
 * models are considered valid. Kept here rather than inside the dispersion
 * code so the Weather step can warn the user at data entry, before they have
 * filled in the rest of the scenario.
 */
export function isWindSpeedUsable(windSpeed10m) {
  return Number.isFinite(windSpeed10m) && windSpeed10m >= MIN_WIND_SPEED;
}

/**
 * Derives the daytime insolation category from solar elevation and cloud cover.
 *
 * The elevation bands follow Turner (1964), the same scheme ALOHA uses:
 *   above 60 degrees   strong
 *   35 to 60           moderate
 *   15 to 35           slight
 *   0 to 15            slight, and weakly so — the sun is barely heating the ground
 *
 * Cloud then reduces the category, because cloud cover cuts the radiation
 * reaching the surface. The reduction here is one step for broken cloud (5 to
 * 7 oktas) and two for full overcast (8 oktas), which reproduces the direction
 * and rough magnitude of Turner's net radiation index adjustment without
 * requiring a cloud ceiling height that a user is unlikely to have.
 *
 * Below the horizon the result is night, and the caller should use the
 * night-time branch of the table instead.
 *
 * @param {number} solarElevationDegrees
 * @param {number} cloudCoverOktas - 0 (clear) to 8 (overcast)
 * @returns {{ isDaytime: boolean, insolation?: string, nightCloud?: string }}
 */
export function insolationFromSolarElevation(solarElevationDegrees, cloudCoverOktas) {
  if (solarElevationDegrees <= 0) {
    return {
      isDaytime: false,
      nightCloud: cloudCoverOktas >= 4 ? "cloudy" : "clear",
    };
  }

  // Order matters: index 0 is the strongest insolation, so "reducing" the
  // category means stepping toward the end of this array.
  const ladder = ["strong", "moderate", "slight"];

  let index;
  if (solarElevationDegrees > 60) index = 0;
  else if (solarElevationDegrees > 35) index = 1;
  else index = 2;

  if (cloudCoverOktas >= 8) index += 2;
  else if (cloudCoverOktas >= 5) index += 1;

  return {
    isDaytime: true,
    insolation: ladder[Math.min(index, ladder.length - 1)],
  };
}
