/**
 * locationTests.js
 * ----------------
 * Verification for the Location step. Run with:
 *   node tests/locationTests.js
 *
 * Three groups of checks, all of which guard against silent failures:
 *
 * Coordinate parsing, because a transposed or misread pair produces a threat
 * zone drawn confidently in the wrong country.
 *
 * Solar position, because the stability class derived from it changes threat
 * distances by a large factor, and a sign error in the equations would be
 * invisible in the interface.
 *
 * The roughness mapping, because it is the one place where OpenStreetMap tags
 * are interpreted, and a wrong interpretation would quietly shift results.
 */

import {
  parseCoordinateComponent,
  parseCoordinatePair,
  validateCoordinates,
  formatDecimal,
  formatDms,
  distanceBetween,
} from "../js/engine/coordinates.js";
import { solarElevation, isDaylight, describeSolarElevation } from "../js/engine/solarPosition.js";
import { roughnessSuggestionFromLanduse } from "../js/services/locationService.js";
import { insolationFromSolarElevation, determineStabilityClass } from "../js/engine/engineStability.js";
import { incidentMoment } from "../js/ui/stepLocation.js";

let passed = 0;
let failed = 0;

function check(description, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${description}`);
  } else {
    failed++;
    console.log(`  FAIL  ${description}${detail ? ` — ${detail}` : ""}`);
  }
}

const closeTo = (a, b, tol) => Math.abs(a - b) <= tol;

console.log("\n=== 1. Coordinate components ===");
check("plain decimal", closeTo(parseCoordinateComponent("51.4416"), 51.4416, 1e-9));
check("negative decimal", closeTo(parseCoordinateComponent("-51.4416"), -51.4416, 1e-9));
check("decimal with N", closeTo(parseCoordinateComponent("51.4416 N"), 51.4416, 1e-9));
check("decimal with S is negative", closeTo(parseCoordinateComponent("51.4416 S"), -51.4416, 1e-9));
check("degrees and decimal minutes", closeTo(parseCoordinateComponent("51 26.5 N"), 51 + 26.5 / 60, 1e-9));
check("degrees minutes seconds", closeTo(parseCoordinateComponent("51 26 30 N"), 51 + 26 / 60 + 30 / 3600, 1e-9));
check("DMS with symbols", closeTo(parseCoordinateComponent("51°26'30\"N"), 51 + 26 / 60 + 30 / 3600, 1e-9));
check("W is negative", closeTo(parseCoordinateComponent("5°28'11\"W"), -(5 + 28 / 60 + 11 / 3600), 1e-9));
check("gibberish is rejected", (() => { try { parseCoordinateComponent("north-ish"); return false; } catch { return true; } })());
check("empty is rejected", (() => { try { parseCoordinateComponent(""); return false; } catch { return true; } })());

console.log("\n=== 2. Coordinate pairs ===");
const eindhoven = { lat: 51.4416, lng: 5.4697 };
let pair = parseCoordinatePair("51.4416, 5.4697");
check("comma separated", closeTo(pair.lat, eindhoven.lat, 1e-9) && closeTo(pair.lng, eindhoven.lng, 1e-9));
pair = parseCoordinatePair("51.4416 5.4697");
check("space separated", closeTo(pair.lat, eindhoven.lat, 1e-9) && closeTo(pair.lng, eindhoven.lng, 1e-9));
pair = parseCoordinatePair("51°26'29.8\"N 5°28'10.9\"E");
check("DMS pair", closeTo(pair.lat, eindhoven.lat, 0.0001) && closeTo(pair.lng, eindhoven.lng, 0.0001), `got ${formatDecimal(pair.lat, pair.lng)}`);
pair = parseCoordinatePair("-33.8688, 151.2093");
check("southern and eastern hemisphere (Sydney)", closeTo(pair.lat, -33.8688, 1e-9) && closeTo(pair.lng, 151.2093, 1e-9));
pair = parseCoordinatePair("40.7128, -74.0060");
check("northern and western hemisphere (New York)", closeTo(pair.lat, 40.7128, 1e-9) && closeTo(pair.lng, -74.006, 1e-9));
check("a single value is rejected", (() => { try { parseCoordinatePair("51.4416"); return false; } catch { return true; } })());

console.log("\n=== 3. Coordinate validation ===");
check("latitude above 90 is rejected", (() => { try { validateCoordinates(95, 0); return false; } catch { return true; } })());
check("longitude above 180 is rejected", (() => { try { validateCoordinates(0, 200); return false; } catch { return true; } })());
check("the poles are accepted", (() => { try { validateCoordinates(90, 0); return true; } catch { return false; } })());
check("the antimeridian is accepted", (() => { try { validateCoordinates(0, 180); return true; } catch { return false; } })());

console.log("\n=== 4. Formatting ===");
check("decimal format", formatDecimal(51.4416, 5.4697) === "51.44160, 5.46970");
check("DMS format round trips", closeTo(parseCoordinatePair(formatDms(51.4416, 5.4697)).lat, 51.4416, 0.0001));
check("southern hemisphere formats as S", formatDms(-33.8688, 151.2093).includes("S"));
check("western hemisphere formats as W", formatDms(40.7128, -74.006).includes("W"));

console.log("\n=== 5. Distance ===");
// Eindhoven to Amsterdam is roughly 111 km in a straight line
const d = distanceBetween(51.4416, 5.4697, 52.3676, 4.9041);
check("Eindhoven to Amsterdam ≈ 111 km", closeTo(d, 111000, 5000), `got ${(d / 1000).toFixed(1)} km`);
check("distance to self is zero", distanceBetween(51.44, 5.47, 51.44, 5.47) === 0);

console.log("\n=== 6. Solar position ===");
// At solar noon the elevation equals (90 - latitude + declination). Declination
// reaches +23.44° at the June solstice and -23.44° at the December one, which
// makes these two dates checkable without consulting an ephemeris.
const summerNoon = solarElevation(new Date("2024-06-21T11:38:00Z"), 51.44, 5.47);
check("Eindhoven, June solstice, solar noon ≈ 62°", closeTo(summerNoon, 90 - 51.44 + 23.44, 1), `got ${summerNoon.toFixed(2)}°`);

const winterNoon = solarElevation(new Date("2024-12-21T11:38:00Z"), 51.44, 5.47);
check("Eindhoven, December solstice, solar noon ≈ 15°", closeTo(winterNoon, 90 - 51.44 - 23.44, 1), `got ${winterNoon.toFixed(2)}°`);

check("sun is below the horizon at midnight", solarElevation(new Date("2024-06-21T00:00:00Z"), 51.44, 5.47) < 0);
check("isDaylight agrees with elevation at noon", isDaylight(new Date("2024-06-21T11:38:00Z"), 51.44, 5.47) === true);
check("isDaylight agrees with elevation at midnight", isDaylight(new Date("2024-06-21T00:00:00Z"), 51.44, 5.47) === false);

// The Arctic in midsummer: the sun should never set
const tromsoMidnight = solarElevation(new Date("2024-06-21T23:00:00Z"), 69.65, 18.96);
check("midnight sun above the Arctic Circle", tromsoMidnight > 0, `got ${tromsoMidnight.toFixed(2)}°`);

// Southern hemisphere: seasons reversed
const sydneyJune = solarElevation(new Date("2024-06-21T02:00:00Z"), -33.87, 151.21);
const sydneyDecember = solarElevation(new Date("2024-12-21T01:00:00Z"), -33.87, 151.21);
check("Sydney sun is higher in December than June", sydneyDecember > sydneyJune, `Jun ${sydneyJune.toFixed(1)}°, Dec ${sydneyDecember.toFixed(1)}°`);

check("description of a high sun", describeSolarElevation(70) === "high");
check("description of a sun below the horizon", describeSolarElevation(-5) === "below the horizon");

console.log("\n=== 7. Insolation from solar elevation ===");
check("high sun, clear sky → strong", insolationFromSolarElevation(70, 0).insolation === "strong");
check("mid sun, clear sky → moderate", insolationFromSolarElevation(45, 0).insolation === "moderate");
check("low sun, clear sky → slight", insolationFromSolarElevation(20, 0).insolation === "slight");
check("high sun, overcast → reduced to slight", insolationFromSolarElevation(70, 8).insolation === "slight");
check("high sun, broken cloud → reduced to moderate", insolationFromSolarElevation(70, 6).insolation === "moderate");
check("sun below horizon → night", insolationFromSolarElevation(-5, 0).isDaytime === false);
check("clear night → clear category", insolationFromSolarElevation(-5, 1).nightCloud === "clear");
check("cloudy night → cloudy category", insolationFromSolarElevation(-5, 6).nightCloud === "cloudy");

console.log("\n=== 8. Why solar elevation matters for the result ===");
// The same weather on the same day, at two different hours, must not produce
// the same stability class — that is the whole reason for computing the sun's
// position rather than using a day/night switch.
const lightWind = 2.5;
const clearSky = 0;

const middayCategory = insolationFromSolarElevation(
  solarElevation(new Date("2024-06-21T11:38:00Z"), 51.44, 5.47),
  clearSky
);
const middayClass = determineStabilityClass({
  windSpeed10m: lightWind,
  isDaytime: middayCategory.isDaytime,
  insolation: middayCategory.insolation,
});

const eveningCategory = insolationFromSolarElevation(
  solarElevation(new Date("2024-06-21T18:30:00Z"), 51.44, 5.47),
  clearSky
);
const eveningClass = determineStabilityClass({
  windSpeed10m: lightWind,
  isDaytime: eveningCategory.isDaytime,
  insolation: eveningCategory.insolation,
});

console.log(`  Midday (sun high):    class ${middayClass}`);
console.log(`  Evening (sun low):    class ${eveningClass}`);
check("midday and evening give different stability classes", middayClass !== eveningClass);
check("midday is the more unstable of the two", middayClass < eveningClass, `${middayClass} vs ${eveningClass}`);

console.log("\n=== 9. Roughness suggestion from OSM tags ===");
check("residential → urban", roughnessSuggestionFromLanduse("residential").preset === "urbanOrForest");
check("industrial → urban", roughnessSuggestionFromLanduse("industrial").preset === "urbanOrForest");
check("forest → urban roughness band", roughnessSuggestionFromLanduse("forest").preset === "urbanOrForest");
check("farmland → open country", roughnessSuggestionFromLanduse("farmland").preset === "openCountry");
check("meadow → open country", roughnessSuggestionFromLanduse("meadow").preset === "openCountry");
check("water → open water", roughnessSuggestionFromLanduse("water").preset === "openWater");
check("an unknown tag yields no suggestion", roughnessSuggestionFromLanduse("quarry") === null);
check("a missing tag yields no suggestion", roughnessSuggestionFromLanduse(undefined) === null);
check("the suggestion explains its basis", roughnessSuggestionFromLanduse("forest").reason.includes("forest"));

console.log("\n=== 10. Incident time ===");
const fixedTime = incidentMoment({ useCurrentTime: false, date: "2024-06-21", time: "14:30" });
check("a specific time is honoured", fixedTime.getHours() === 14 && fixedTime.getMinutes() === 30);
const nowish = incidentMoment({ useCurrentTime: true });
check("'now' returns the present moment", Math.abs(nowish.getTime() - Date.now()) < 1000);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
