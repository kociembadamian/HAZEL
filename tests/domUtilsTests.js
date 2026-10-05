/**
 * domUtilsTests.js
 * ----------------
 * Verification for wireOnce(), the guard that stops delegated listeners
 * from stacking on containers HAZEL reuses across many renders. Run with:
 *   node tests/domUtilsTests.js
 *
 * Section 6 exists because of a real regression: an earlier version of this
 * function guarded purely by event type ("click"), which is not enough when
 * several different modules share one container — as every wizard step
 * does, via .wizard-step-content. Whichever step wired its click handler
 * FIRST silently won the guard for the container's entire lifetime, and
 * every step after it never got its own handler attached: clicking
 * anything on those steps did nothing, with no error to explain why. The
 * fix was a caller-supplied key identifying the listener itself, separate
 * from the DOM event type — section 6 pins that down so it cannot regress
 * silently again.
 */

import { wireOnce } from "../js/ui/domUtils.js";

let passed = 0, failed = 0;
function check(d, c, detail = "") {
  if (c) { passed++; console.log(`  PASS  ${d}`); }
  else { failed++; console.log(`  FAIL  ${d}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * A bare-bones stand-in for an HTMLElement, tracking only what wireOnce
 * touches.
 *
 * The dataset here is a real proxy enforcing the same restriction actual
 * browsers do (WHATWG HTML spec, DOMStringMap): setting a property whose
 * name contains a hyphen immediately followed by a lowercase ASCII letter
 * throws a SyntaxError. An earlier version of this fake used a plain object
 * for dataset, which accepted any key silently — and let a real regression
 * (wireOnce building a flag like "wired_location-click", which a real
 * browser refuses to set) pass every test here while failing in production.
 * A fake that is more permissive than the platform it stands in for is
 * worse than no fake at all.
 */
function fakeElement() {
  const store = {};
  const dataset = new Proxy(store, {
    set(target, prop, value) {
      if (typeof prop === "string" && /-[a-z]/.test(prop)) {
        throw new Error(
          `SyntaxError: Failed to set the '${prop}' property on 'DOMStringMap': ` +
            `'${prop}' is not a valid property name (hyphen followed by a lowercase letter)`
        );
      }
      target[prop] = value;
      return true;
    },
    get(target, prop) {
      return target[prop];
    },
  });

  return {
    dataset,
    listeners: [],
    addEventListener(type, handler) {
      this.listeners.push({ type, handler });
    },
  };
}

console.log("\n=== 1. Attaches on the first call ===");
const el1 = fakeElement();
wireOnce(el1, "some-key", "click", () => {});
check("one listener is registered", el1.listeners.length === 1);
check("it is registered for the right event type", el1.listeners[0].type === "click");

console.log("\n=== 2. Does not stack on repeated calls with the SAME key (revisiting one step) ===");
const el2 = fakeElement();
for (let i = 0; i < 5; i++) {
  wireOnce(el2, "location-click", "click", () => {});
}
check("five calls with the same key still leave exactly one listener", el2.listeners.length === 1,
  `got ${el2.listeners.length}`);

console.log("\n=== 3. Different keys on the same container both get through ===");
const el3 = fakeElement();
wireOnce(el3, "key-a", "click", () => {});
wireOnce(el3, "key-b", "change", () => {});
wireOnce(el3, "key-a", "click", () => {}); // repeat of key-a, should be ignored
check("key-a and key-b each got exactly one listener", el3.listeners.length === 2,
  `got ${el3.listeners.length}`);

console.log("\n=== 4. Different containers are independent ===");
const el4a = fakeElement();
const el4b = fakeElement();
wireOnce(el4a, "some-key", "click", () => {});
wireOnce(el4b, "some-key", "click", () => {});
check("each container gets its own listener", el4a.listeners.length === 1 && el4b.listeners.length === 1);

console.log("\n=== 5. The first handler passed for a key is the one that stays registered ===");
const el5 = fakeElement();
const firstHandler = () => "first";
const secondHandler = () => "second";
wireOnce(el5, "same-key", "click", firstHandler);
wireOnce(el5, "same-key", "click", secondHandler); // should be a no-op
check("the originally attached handler is retained", el5.listeners[0].handler === firstHandler);
check("the later handler was never attached", !el5.listeners.some((l) => l.handler === secondHandler));

console.log("\n=== 6. Regression: two 'steps' sharing one container both get their handler ===");
// This is the exact shape of the bug: several modules (Location, Chemical,
// Weather, ...) call wireOnce on the SAME shared container, one per render,
// each for the same DOM event type ("click") but with THEIR OWN key.
const sharedStepContainer = fakeElement();

let locationClicks = 0;
let chemicalClicks = 0;

function locationStepRender() {
  wireOnce(sharedStepContainer, "location-click", "click", () => locationClicks++);
}
function chemicalStepRender() {
  wireOnce(sharedStepContainer, "chemical-click", "click", () => chemicalClicks++);
}

// Simulate: user opens Location (rendered twice, as if visited, left, and
// returned), then Chemical.
locationStepRender();
locationStepRender();
chemicalStepRender();

check("both steps' click listeners are present on the shared container",
  sharedStepContainer.listeners.length === 2,
  `got ${sharedStepContainer.listeners.length} — if this is 1, Chemical's handler never attached`);

// Firing every registered listener (as a real click would) must reach BOTH
// steps' handlers, not just whichever attached first.
sharedStepContainer.listeners.forEach((l) => l.handler());
check("Location's handler fired", locationClicks === 1);
check("Chemical's handler also fired — this is what broke before the fix",
  chemicalClicks === 1, `got ${chemicalClicks}`);

// And revisiting Location again afterward must still not add a duplicate.
locationStepRender();
check("revisiting Location after Chemical was wired still adds nothing new",
  sharedStepContainer.listeners.length === 2);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
