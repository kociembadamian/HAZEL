/**
 * customChemicalTests.js
 * ------------------------
 * Verification for the pure (non-IndexedDB) functions in
 * customChemicalStore.js: validation, sanitisation, the override-merge
 * logic, and the standalone-record display shape. Run with:
 *   node tests/customChemicalTests.js
 *
 * The IndexedDB-backed functions in that module (add/update/delete/list/
 * export/import) are not exercised here, for the same reason
 * scenarioStorage.js has no dedicated test file either: IndexedDB does not
 * exist outside a browser, and this project does not carry a fake-indexedDB
 * dependency. Every function that touches real chemistry/business logic
 * rather than plain storage plumbing is written as a pure function
 * specifically so it CAN be tested here — see the module's own docstring.
 */

import {
  normaliseCasForCompare,
  validateCustomChemicalRecord,
  sanitizeCustomChemicalRecord,
  mergeCustomChemicalOntoBuiltIn,
  toDisplayRecord,
} from "../js/services/customChemicalStore.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== 1. normaliseCasForCompare ===");
check("strips hyphens", normaliseCasForCompare("74-98-6") === "74986", `got ${normaliseCasForCompare("74-98-6")}`);
check("strips whitespace", normaliseCasForCompare(" 74 98 6 ") === "74986");
check("empty/undefined gives empty string", normaliseCasForCompare(null) === "" && normaliseCasForCompare(undefined) === "");

console.log("\n=== 2. validateCustomChemicalRecord — standalone substance ===");
check("rejects a record with no name",
  !validateCustomChemicalRecord({ molecularWeight: 44.1 }).valid);
check("rejects a standalone substance with no molecular weight",
  !validateCustomChemicalRecord({ name: "Fictional gas" }).valid);
check("rejects a non-numeric molecular weight",
  !validateCustomChemicalRecord({ name: "X", molecularWeight: "abc" }).valid);
check("accepts a minimal valid standalone substance",
  validateCustomChemicalRecord({ name: "Fictional gas", molecularWeight: 30 }).valid);
check("rejects UEL at or below LEL",
  !validateCustomChemicalRecord({ name: "X", molecularWeight: 30, lowerExplosiveLimitPpm: 50000, upperExplosiveLimitPpm: 40000 }).valid);
check("accepts UEL above LEL",
  validateCustomChemicalRecord({ name: "X", molecularWeight: 30, lowerExplosiveLimitPpm: 20000, upperExplosiveLimitPpm: 95000 }).valid);

console.log("\n=== 3. validateCustomChemicalRecord — override of an existing substance ===");
check("an override does not need its own molecular weight",
  validateCustomChemicalRecord({ name: "Propane (enrichment)", casNumber: "74-98-6", upperExplosiveLimitPpm: 95000 }, { isOverride: true }).valid);
check("an override still rejects a missing name",
  !validateCustomChemicalRecord({ casNumber: "74-98-6", upperExplosiveLimitPpm: 95000 }, { isOverride: true }).valid);

console.log("\n=== 4. sanitizeCustomChemicalRecord ===");
const sanitized = sanitizeCustomChemicalRecord({
  name: "  Propane (own data)  ",
  casNumber: "74-98-6",
  molecularWeight: "44.1",
  upperExplosiveLimitPpm: "95000",
  lowerExplosiveLimitPpm: "",
  isNonCondensableGas: "on", // simulates a raw checkbox truthy value
  notes: "   ",
});
check("trims the name", sanitized.name === "Propane (own data)");
check("coerces a numeric string field to an actual number", sanitized.molecularWeight === 44.1 && typeof sanitized.molecularWeight === "number");
check("an empty string field becomes null, not NaN or ''", sanitized.lowerExplosiveLimitPpm === null);
check("a whitespace-only note becomes null", sanitized.notes === null);
check("checkbox truthy value coerces to boolean true", sanitized.isNonCondensableGas === true);
check("every optional numeric field is present (even when null)", "heatOfCombustion" in sanitized && "boilingPointK" in sanitized);

console.log("\n=== 5. mergeCustomChemicalOntoBuiltIn ===");
const builtIn = {
  casNumber: "74-98-6",
  name: "Propane",
  molecularFormula: "C3H8",
  state25C: "gas",
  molecularWeight: 44.1,
  pac1Ppm: 700,
  pac2Ppm: 2000,
  pac3Ppm: 3000,
  lowerExplosiveLimitPpm: 21000,
  originalUnit: "ppm",
  searchName: "propane",
};
const override = sanitizeCustomChemicalRecord({
  name: "Propane — my data",
  casNumber: "74-98-6",
  upperExplosiveLimitPpm: 95000,
  heatOfCombustion: 46000000,
  isNonCondensableGas: false,
});
override.id = 7;
const merged = mergeCustomChemicalOntoBuiltIn(builtIn, override);
check("the official LEL from the built-in record is kept (not overridden)",
  merged.lowerExplosiveLimitPpm === 21000);
check("the official PAC thresholds are kept",
  merged.pac1Ppm === 700 && merged.pac2Ppm === 2000 && merged.pac3Ppm === 3000);
check("the custom UEL is layered on top",
  merged.upperExplosiveLimitPpm === 95000);
check("the custom heat of combustion is layered on top",
  merged.heatOfCombustion === 46000000);
check("the merged record is flagged as carrying an override",
  merged.hasCustomOverride === true && merged.customId === 7);
check("the built-in name is kept, not replaced by the override's memo name",
  merged.name === "Propane");

console.log("\n=== 6. mergeCustomChemicalOntoBuiltIn — overriding the molecular weight itself ===");
const mwOverride = sanitizeCustomChemicalRecord({ name: "x", casNumber: "74-98-6", molecularWeight: 44.5 });
mwOverride.id = 8;
const mergedMw = mergeCustomChemicalOntoBuiltIn(builtIn, mwOverride);
check("a custom molecular weight replaces the built-in one when explicitly set",
  mergedMw.molecularWeight === 44.5);

console.log("\n=== 7. toDisplayRecord — a standalone custom substance ===");
const standalone = sanitizeCustomChemicalRecord({
  name: "Fictional test gas",
  molecularWeight: 30,
  pac1Ppm: 10,
  isNonCondensableGas: true,
});
standalone.id = 12;
const display = toDisplayRecord(standalone);
check("gets a synthetic CAS-like identifier when none was given",
  display.casNumber === "CUSTOM-12");
check("is flagged as custom", display.isCustom === true && display.customId === 12);
check("carries a lower-cased searchName for the search index",
  display.searchName === "fictional test gas");
check("has the fields isUsableForDispersion()/levelsOfConcern() elsewhere in the app expect",
  "pac1Ppm" in display && "lowerExplosiveLimitPpm" in display && "molecularWeight" in display);
check("carries the non-condensable-gas flag through to the display shape",
  display.isNonCondensableGas === true);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
