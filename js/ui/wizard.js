/**
 * wizard.js
 * ---------
 * Owns the wizard progress bar (always visible — see the rationale in
 * layout.css) and movement between steps.
 *
 * The contract every step module implements:
 *   id          - stable identifier, also used in the progress bar
 *   label       - what the user sees in the progress bar
 *   render(el)  - draw the step into the given container
 *   isComplete() - optional; whether the wizard may advance past this step
 *
 * wizard.js decides WHICH step is shown. It knows nothing about what any step
 * contains, which is what keeps steps independently testable and lets them be
 * built one at a time.
 *
 * Rendering rule that matters: a step is re-rendered only when the ACTIVE STEP
 * CHANGES, never on every state update. Steps own forms, and redrawing a form
 * while somebody is typing in it would move the cursor and lose focus. Steps
 * update their own derived readouts internally instead.
 *
 * NOTE (2026-09-25): a brief loading indicator (see domUtils.js's
 * loadingSpinnerHtml()) is now shown in the step content area the moment a
 * NEW step starts rendering, replaced the instant that step's own render()
 * finishes. Most steps render synchronously and the indicator is never even
 * painted; it only becomes visible for the ones that do real work before
 * their first paint (the Chemical step's database load, the Results step's
 * map setup) — those used to show a blank panel for a moment and then jump,
 * which read as a stall rather than as something loading.
 */

import { state } from "./state.js";
import { locationStep } from "./stepLocation.js";
import { chemicalStep } from "./stepChemical.js";
import { weatherStep } from "./stepWeather.js";
import { sourceStep } from "./stepSource.js";
import { resultsStep } from "./stepResults.js";
import { loadingSpinnerHtml } from "./domUtils.js";

/**
 * Placeholder for steps not yet built, so navigation works end to end while
 * the remaining steps are implemented.
 */
function placeholderStep(id, label) {
  return {
    id,
    label,
    render(container) {
      container.innerHTML = `
        <div class="panel">
          <h2>${label}</h2>
          <p>This step has not been built yet. Navigation and the steps that
          are finished can be exercised in the meantime.</p>
        </div>`;
    },
    isComplete: () => true, // do not block navigation during development
  };
}

/** The wizard, in order. Replace placeholders as each step is implemented. */
const STEPS = [
  locationStep,
  chemicalStep,
  weatherStep,
  sourceStep,
  resultsStep,
];

/** Index of the step currently drawn, so we only redraw when it changes. */
let renderedStepIndex = null;

/**
 * Forces the next render() call to redraw the current step's body, even if
 * its index has not changed.
 *
 * Needed whenever a scenario's DATA changes without its STEP changing —
 * which the normal "only redraw on index change" optimisation above does
 * not account for. Loading a saved scenario is the case that exposed this:
 * it always jumps to the Results step, so opening a second saved scenario
 * while already viewing Results left the wizard concluding nothing had
 * changed and showing the previous scenario's map under the newly loaded
 * one's data. Call this immediately before updating state in any situation
 * where the step index might stay the same but what should be drawn does not.
 */
export function invalidateStepRender() {
  renderedStepIndex = null;
}

function renderProgressBar(container) {
  const currentStep = state.current.wizard.currentStep;

  container.innerHTML = STEPS.map((step, index) => {
    let stepState = "upcoming";
    if (index === currentStep) stepState = "active";
    else if (index < currentStep) stepState = "done";

    const marker = stepState === "done" ? "✓" : String(index + 1);
    const connector =
      index < STEPS.length - 1 ? `<div class="wizard-progress__connector"></div>` : "";

    return `
      <div class="wizard-progress__step" data-state="${stepState}">
        <div class="wizard-progress__marker">${marker}</div>
        <span class="wizard-progress__label">${step.label}</span>
      </div>
      ${connector}`;
  }).join("");
}

function goToStep(index) {
  const clamped = Math.max(0, Math.min(index, STEPS.length - 1));
  state.update({ wizard: { ...state.current.wizard, currentStep: clamped } });
}

/**
 * Wipes the in-progress scenario and returns the wizard to step 0.
 *
 * Deliberately unconditional and always available, unlike the sidebar's
 * "New scenario" link (pageRouter.js's resetOrResumeWizard(), which resumes
 * an in-progress draft on ordinary navigation rather than destroying it —
 * see that module's 2026-09-23 note). This is for someone who explicitly
 * wants to throw the current draft away mid-wizard, so it always wipes,
 * behind a confirm() to guard against an accidental click.
 */
function resetScenario() {
  if (!window.confirm("Start a new scenario? This clears everything entered so far.")) {
    return;
  }
  state.update({
    scenario: { location: null, chemical: null, weather: null, source: null, fire: null, indoor: null },
    wizard: { ...state.current.wizard, currentStep: 0 },
    scenarioLoadedFromSaved: false,
  });
  invalidateStepRender();
}

export function initWizard() {
  const progressEl = document.querySelector(".wizard-progress");
  const stepContentEl = document.querySelector(".wizard-step-content");
  const prevBtn = document.querySelector("[data-wizard-prev]");
  const nextBtn = document.querySelector("[data-wizard-next]");
  const resetBtn = document.querySelector("[data-wizard-reset]");

  if (!progressEl || !stepContentEl) {
    console.warn("wizard.js: required elements are missing from the DOM");
    return;
  }

  function render() {
    const currentStep = state.current.wizard.currentStep;

    renderProgressBar(progressEl);

    // Only redraw the step body when the step itself changed.
    if (renderedStepIndex !== currentStep) {
      // Shown immediately, replaced the instant this step's render() call
      // below actually finishes writing its own markup — see the module
      // docstring's 2026-09-25 note.
      stepContentEl.innerHTML = loadingSpinnerHtml("Loading step…");

      // A step's render() may be asynchronous — the Chemical step loads its
      // database, for instance. The wizard deliberately does not await it:
      // each step draws its own shell immediately and fills in the rest, so
      // navigation never blocks on a download. Failures are logged rather
      // than left as unhandled promise rejections.
      Promise.resolve(STEPS[currentStep].render(stepContentEl)).catch((error) => {
        console.error(`Step "${STEPS[currentStep].id}" failed to render:`, error);
      });
      renderedStepIndex = currentStep;
    }

    if (prevBtn) prevBtn.disabled = currentStep === 0;

    if (nextBtn) {
      const isLastStep = currentStep === STEPS.length - 1;
      // This is the documented contract above, actually enforced: a step
      // that has no isComplete() is treated as always complete (the
      // placeholder steps relied on this before every step was built).
      const step = STEPS[currentStep];
      const complete = typeof step.isComplete === "function" ? step.isComplete() : true;
      nextBtn.disabled = isLastStep || !complete;
      // A disabled button with no explanation is exactly what prompted this
      // fix in the first place — a title tooltip costs nothing and says why.
      nextBtn.title = !isLastStep && !complete ? "Finish this step to continue" : "";
    }
  }

  prevBtn?.addEventListener("click", () => goToStep(state.current.wizard.currentStep - 1));
  nextBtn?.addEventListener("click", () => goToStep(state.current.wizard.currentStep + 1));
  resetBtn?.addEventListener("click", resetScenario);

  state.subscribe(render);
  render();
}

/** Exported for tests and for any future deep-linking to a step. */
export { STEPS };
