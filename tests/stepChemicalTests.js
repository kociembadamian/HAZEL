/**
 * stepChemicalTests.js
 * --------------------
 * Verification for stepChemical.js's display formatting. Run with:
 *   node tests/stepChemicalTests.js
 *
 * REGRESSION (2026-09-29): formatPpm() used to strip trailing zeros from a
 * plain integer, not just from a decimal fraction, because its regex made
 * the decimal point itself optional (`/\.?0+$/`). A value that happened to
 * be a "round" number in [100, 999] ending in one or two zeros — most
 * consequentially, a published PAC/AEGL threshold like hydrogen chloride's
 * PAC-3 (100 ppm) or acetone's PAC-1 (200 ppm) — was silently displayed as
 * 1/10th to 1/100th of its real value ("1 ppm", "2 ppm"). Found via a real
 * HAZEL/ALOHA comparison, where the on-screen threshold no longer matched
 * either the built-in dataset or ALOHA's own report.
 *
 * This is a pure display bug: the actual threat-zone search in
 * stepResults.js's computeZones() reads the chemical record's raw
 * pac1Ppm/pac2Ppm/pac3Ppm fields directly, via levelsOfConcern() in
 * chemicalDatabase.js, and never touches formatPpm() — so no calculation
 * this project has produced was ever affected. This file exists so a
 * future edit to the trimming logic cannot reintroduce the same mistake
 * without a visible test failure.
 */

import { formatPpm } from "../js/ui/stepChemical.js";

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

console.log("\n=== 1. The exact reported cases ===");
check("hydrogen chloride's PAC-3 (100 ppm) displays in full, not '1'",
  formatPpm(100) === "100", `got "${formatPpm(100)}"`);
check("acetone's PAC-1 (200 ppm) displays in full, not '2'",
  formatPpm(200) === "200", `got "${formatPpm(200)}"`);

console.log("\n=== 2. Every 'round hundred' in the affected range ===");
// The bug hit every value in [100, 999] with a trailing zero, not just the
// two that happened to surface it — spot-checking a spread of them.
for (const [value, expected] of [
  [100, "100"], [110, "110"], [200, "200"], [300, "300"],
  [500, "500"], [900, "900"], [990, "990"], [120, "120"],
]) {
  check(`${value} formats as "${expected}"`, formatPpm(value) === expected,
    `got "${formatPpm(value)}"`);
}

console.log("\n=== 3. Values that were already safe (must stay unaffected) ===");
check("3200 (goes to scientific notation) is unaffected",
  formatPpm(3200) === "3.20e+3", `got "${formatPpm(3200)}"`);
check("5700 (goes to scientific notation) is unaffected",
  formatPpm(5700) === "5.70e+3", `got "${formatPpm(5700)}"`);
check("22 (below the 100 branch, no trailing zero) is unaffected",
  formatPpm(22) === "22", `got "${formatPpm(22)}"`);
check("1.8 (decimal, below 100) is unaffected",
  formatPpm(1.8) === "1.8", `got "${formatPpm(1.8)}"`);

console.log("\n=== 4. Trailing-zero trimming still works where it's meant to ===");
// The fix must not throw the baby out with the bathwater: a genuine decimal
// trailing zero (from toFixed's fixed digit count) should still be trimmed.
check("1.50 trims to 1.5", formatPpm(1.5) === "1.5", `got "${formatPpm(1.5)}"`);
check("0.5000 (the toFixed(4) branch) trims to 0.5",
  formatPpm(0.5) === "0.5", `got "${formatPpm(0.5)}"`);
check("a value needing no trimming at all is untouched",
  formatPpm(58.08) === "58.08", `got "${formatPpm(58.08)}"`);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
