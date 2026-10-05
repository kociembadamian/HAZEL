/**
 * weatherTests.js
 * ---------------
 * Verification for the Weather step's logic. Run with:
 *   node tests/weatherTests.js
 *
 * These cover the pure functions only — unit conversion, wind direction
 * parsing, roughness resolution and the derivation of engine inputs. The
 * rendering code is not exercised here because it needs a DOM; the logic it
 * depends on is all in the functions tested below, which is why they were
 * written as exports rather than closures inside the render function.
 *
 * The conversions matter more than they look. A wind direction read backwards
 * puts the threat zone on the wrong side of the incident, and a temperature
 * left in Celsius where the ideal gas law expects kelvin is wrong by a factor
 * of roughly twenty. Both are silent failures, so both are tested explicitly.
 */

import {
  windSpeedToMetresPerSecond,
  windSpeedFromMetresPerSecond,
  temperatureToKelvin,
  temperatureFromKelvin,
  compassPointToDegrees,
  degreesToCompassPoint,
  parseWindDirection,
  downwindDirection,
} from "../js/engine/units.js";
import { deriveEngineInputs, resolveRoughness } from "../js/ui/stepWeather.js";
import { roughnessForOpenWater } from "../js/engine/engineConstants.js";
import { determineStabilityClass } from "../js/engine/engineStability.js";

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

console.log("\n=== 1. Wind speed conversion ===");
check("10 m/s stays 10 m/s", closeTo(windSpeedToMetresPerSecond(10, "m/s"), 10, 1e-12));
check("36 km/h = 10 m/s", closeTo(windSpeedToMetresPerSecond(36, "km/h"), 10, 1e-9));
check("1 mph = 0.44704 m/s (exact definition)", closeTo(windSpeedToMetresPerSecond(1, "mph"), 0.44704, 1e-9));
check("1 knot = 0.514444 m/s", closeTo(windSpeedToMetresPerSecond(1, "knots"), 0.514444, 1e-6));
// The ALOHA benzene example used 7 mph — a figure worth being able to reproduce
check("7 mph ≈ 3.13 m/s (ALOHA example input)", closeTo(windSpeedToMetresPerSecond(7, "mph"), 3.129, 0.001));
check("round trip through mph is lossless", closeTo(windSpeedFromMetresPerSecond(windSpeedToMetresPerSecond(7, "mph"), "mph"), 7, 1e-9));
check("unknown unit is rejected", (() => { try { windSpeedToMetresPerSecond(1, "furlongs"); return false; } catch { return true; } })());

console.log("\n=== 2. Temperature conversion ===");
check("0 °C = 273.15 K", closeTo(temperatureToKelvin(0, "C"), 273.15, 1e-9));
check("25 °C = 298.15 K", closeTo(temperatureToKelvin(25, "C"), 298.15, 1e-9));
check("32 °F = 273.15 K", closeTo(temperatureToKelvin(32, "F"), 273.15, 1e-9));
// The ALOHA benzene example used 80 °F
check("80 °F ≈ 299.82 K (ALOHA example input)", closeTo(temperatureToKelvin(80, "F"), 299.817, 0.01));
check("-40 °C = -40 °F (the crossover point)", closeTo(temperatureToKelvin(-40, "C"), temperatureToKelvin(-40, "F"), 1e-9));
check("round trip through Fahrenheit is lossless", closeTo(temperatureFromKelvin(temperatureToKelvin(80, "F"), "F"), 80, 1e-9));

console.log("\n=== 3. Wind direction ===");
check("N = 0°", compassPointToDegrees("N") === 0);
check("E = 90°", compassPointToDegrees("E") === 90);
check("S = 180°", compassPointToDegrees("S") === 180);
check("W = 270°", compassPointToDegrees("W") === 270);
check("SW = 225°", compassPointToDegrees("SW") === 225);
check("ESE = 112.5°", compassPointToDegrees("ESE") === 112.5);
check("lower case is accepted", compassPointToDegrees("sw") === 225);
check("degrees back to compass point", degreesToCompassPoint(225) === "SW");
check("parse accepts a compass point", parseWindDirection("SW") === 225);
check("parse accepts degrees as text", parseWindDirection("225") === 225);
check("parse accepts degrees as a number", parseWindDirection(225) === 225);
check("parse normalises 360 to 0", parseWindDirection(360) === 0);
check("parse normalises negative bearings", parseWindDirection(-45) === 315);

// The convention check that prevents the whole threat zone being mirrored
check("wind FROM the south-west blows TOWARD the north-east", downwindDirection(225) === 45);
check("wind FROM the north blows TOWARD the south", downwindDirection(0) === 180);
check("downwind of 270° (W) is 90° (E)", downwindDirection(270) === 90);

console.log("\n=== 4. Ground roughness ===");
check("open country = 0.03 m", resolveRoughness({ groundRoughnessPreset: "openCountry" }, 5) === 0.03);
check("urban or forest = 1.0 m", resolveRoughness({ groundRoughnessPreset: "urbanOrForest" }, 5) === 1.0);
check("custom value is used", resolveRoughness({ groundRoughnessPreset: "custom", customRoughness: 0.15 }, 5) === 0.15);
// Open water roughness rises with wind speed because the waves are the roughness
const water5 = resolveRoughness({ groundRoughnessPreset: "openWater" }, 5);
const water10 = resolveRoughness({ groundRoughnessPreset: "openWater" }, 10);
check("open water roughness increases with wind", water10 > water5, `5 m/s: ${water5.toExponential(2)}, 10 m/s: ${water10.toExponential(2)}`);
check("open water matches the published formula", closeTo(water5, roughnessForOpenWater(5), 1e-12));
check("open water roughness is small compared with land", water5 < 0.03);

console.log("\n=== 5. Deriving engine inputs ===");
const baseForm = {
  windSpeed: 5,
  windSpeedUnit: "m/s",
  windFromDirection: "SW",
  windMeasurementHeight: 10,
  temperature: 15,
  temperatureUnit: "C",
  cloudCoverOktas: 4,
  relativeHumidity: 60,
  isDaytime: true,
  groundRoughnessPreset: "openCountry",
  customRoughness: 0.03,
  inversionPresent: false,
  inversionHeight: 100,
  stabilityOverride: "",
};

const derived = deriveEngineInputs(baseForm);
check("wind speed reaches the engine in m/s", closeTo(derived.windSpeed10m, 5, 1e-9));
check("temperature reaches the engine in kelvin", closeTo(derived.temperature, 288.15, 1e-9));
check("wind direction is parsed", derived.windFromDegrees === 225);
check("downwind direction is computed", derived.downwindDegrees === 45);
check("a stability class is assigned", ["A","B","C","D","E","F"].includes(derived.stabilityClass), `got ${derived.stabilityClass}`);
check("no inversion means null, not zero", derived.inversionHeight === null);
check("a valid form produces no problems", derived.problems.length === 0);

// Stability must respond to conditions, not be a constant
const nightForm = { ...baseForm, isDaytime: false, cloudCoverOktas: 0, windSpeed: 1.5 };
const nightDerived = deriveEngineInputs(nightForm);
check("clear calm night gives the most stable class F", nightDerived.stabilityClass === "F", `got ${nightDerived.stabilityClass}`);

const windyForm = { ...baseForm, windSpeed: 10 };
check("strong wind gives neutral class D", deriveEngineInputs(windyForm).stabilityClass === "D");

// Override must win over the automatic determination
const overrideForm = { ...baseForm, stabilityOverride: "F" };
const overrideDerived = deriveEngineInputs(overrideForm);
check("a manual override is honoured", overrideDerived.stabilityClass === "F");
check("an override is flagged as such", overrideDerived.stabilityWasOverridden === true);
check("automatic determination is not flagged", derived.stabilityWasOverridden === false);

// Inversion
const inversionDerived = deriveEngineInputs({ ...baseForm, inversionPresent: true, inversionHeight: 150 });
check("inversion height is passed through", inversionDerived.inversionHeight === 150);

console.log("\n=== 6. Refusing conditions the model cannot handle ===");
const calmDerived = deriveEngineInputs({ ...baseForm, windSpeed: 0.5 });
check("near-calm wind is reported as a problem", calmDerived.problems.length === 1);
check("the problem explains why, not just that", calmDerived.problems[0].includes("not carried predictably"), `got: ${calmDerived.problems[0]}`);

// The same wind expressed in another unit must be caught identically —
// a check that validation happens after conversion, not before
const calmMph = deriveEngineInputs({ ...baseForm, windSpeed: 1, windSpeedUnit: "mph" });
check("1 mph is caught as too calm (0.45 m/s)", calmMph.problems.length === 1);
const okMph = deriveEngineInputs({ ...baseForm, windSpeed: 5, windSpeedUnit: "mph" });
check("5 mph is accepted (2.24 m/s)", okMph.problems.length === 0);

console.log("\n=== 7. Reproducing the ALOHA example inputs ===");
// From ALOHA_Examples.pdf, example 1: Baton Rouge benzene release.
// Inputs: 7 mph from SW at 10 m, 80 °F, open country, 7/8 cloud, no inversion.
// This confirms HAZEL can express an ALOHA scenario exactly, which is the
// precondition for comparing outputs between the two tools.
const alohaForm = {
  ...baseForm,
  windSpeed: 7,
  windSpeedUnit: "mph",
  windFromDirection: "SW",
  temperature: 80,
  temperatureUnit: "F",
  cloudCoverOktas: 7,
  relativeHumidity: 75,
  isDaytime: false, // the release was at 22:30 local time
  groundRoughnessPreset: "openCountry",
};
const alohaDerived = deriveEngineInputs(alohaForm);
console.log(`  Wind: ${alohaDerived.windSpeed10m.toFixed(2)} m/s from ${alohaDerived.windFromDegrees}°`);
console.log(`  Temperature: ${alohaDerived.temperature.toFixed(2)} K`);
console.log(`  Roughness: ${alohaDerived.roughnessLength} m`);
console.log(`  Stability class: ${alohaDerived.stabilityClass}`);
check("ALOHA example wind converts correctly", closeTo(alohaDerived.windSpeed10m, 3.129, 0.001));
check("ALOHA example temperature converts correctly", closeTo(alohaDerived.temperature, 299.82, 0.01));
check("ALOHA example produces no problems", alohaDerived.problems.length === 0);
// ALOHA reported class D for this scenario. Overcast night with moderate wind
// gives D here too, which is a genuine cross-check of the stability lookup.
check("stability class matches ALOHA's reported class D", alohaDerived.stabilityClass === "D", `got ${alohaDerived.stabilityClass}`);

console.log("\n=== 8. Wind-band boundary matches ALOHA (2026-09-27 regression) ===");
// Real ALOHA run, chlorine release, Eindhoven area, 2026-09-27: wind EXACTLY
// 5 m/s from SW at night, cloud cover 4/10 (= 40%, "<50%" in ALOHA's Table 10,
// i.e. HAZEL's "clear" category), open country. ALOHA reported stability
// class E. Before the 2026-09-27 fix, HAZEL's TURNER_TABLE lookup put an
// exact wind==5 into the NEXT band ("5-6") instead of "3-5", reporting D —
// silently understating stability (and therefore the threat distance) for
// every scenario with wind speed exactly 2, 3, 5, or 6 m/s, all common,
// round, frequently-entered values. See engineStability.js's own note on
// the fix for the full explanation.
const chlorineEindhovenForm = {
  ...baseForm,
  windSpeed: 5,
  windSpeedUnit: "m/s",
  windFromDirection: "SW",
  temperature: 15,
  temperatureUnit: "C",
  cloudCoverOktas: 3, // 4/10 ≈ 3.2 oktas, ALOHA's "<50%" (clear) side
  relativeHumidity: 60,
  isDaytime: false,
  groundRoughnessPreset: "openCountry",
};
const chlorineEindhovenDerived = deriveEngineInputs(chlorineEindhovenForm);
check(
  "wind == 5 m/s exactly now matches ALOHA's class E, not D",
  chlorineEindhovenDerived.stabilityClass === "E",
  `got ${chlorineEindhovenDerived.stabilityClass}`
);

console.log("\n=== 9. Table 2.2 cell fix: 3-5 m/s, day, slight insolation -> D (2026-09-27) ===");
// Turner (1994) "Workbook of Atmospheric Dispersion Estimates", 2nd ed.,
// Table 2.2 "Key to Pasquill stability categories" (the source ALOHA's own
// Tech Doc Table 10 cites) gives class D for the 3-5 m/s wind band under
// slight daytime insolation. HAZEL's table had "C" for this cell, found and
// fixed while checking the wind-band boundary fix above against this same
// primary source. Verified directly against a photograph of the cited page.
check(
  "3-5 m/s, day, slight insolation -> D (was C)",
  determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "slight" }) === "D",
  `got ${determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "slight" })}`
);
// Neighbouring cells in the same row/column must be unaffected by the fix.
check(
  "3-5 m/s, day, strong insolation unaffected -> B",
  determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "strong" }) === "B",
  `got ${determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "strong" })}`
);
check(
  "3-5 m/s, day, moderate insolation unaffected -> C",
  determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "moderate" }) === "C",
  `got ${determineStabilityClass({ windSpeed10m: 4, isDaytime: true, insolation: "moderate" })}`
);
check(
  "5-6 m/s, day, slight insolation unaffected -> D",
  determineStabilityClass({ windSpeed10m: 6, isDaytime: true, insolation: "slight" }) === "D",
  `got ${determineStabilityClass({ windSpeed10m: 6, isDaytime: true, insolation: "slight" })}`
);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
