/**
 * pageRouter.js
 * -------------
 * Switches the main content area between the scenario wizard and the
 * standalone pages reachable from the sidebar (Saved scenarios, Chemical
 * library, Settings, About).
 *
 * This is deliberately not a general-purpose client-side router — there is
 * no URL history, no deep linking. HAZEL is a single-purpose tool used in one
 * sitting; the sidebar is the only navigation surface, and a page is
 * identified by nothing more than the string state.current.view already
 * holds. Building more than that would be solving a problem HAZEL does not have.
 *
 * NOTE (2026-09-23): "New scenario" used to unconditionally wipe the
 * in-progress scenario every time it was clicked, including when the user
 * had simply navigated away to another sidebar page (e.g. "How to use") and
 * clicked it again only to get back to the wizard — that silently destroyed
 * unsaved work the user never asked to discard. The original reason this
 * link resets anything at all is a different, narrower case: reopening a
 * saved scenario always lands on Results with that scenario's data loaded,
 * and clicking "New scenario" afterwards must actually clear that data
 * rather than leaving it sitting there. resetOrResumeWizard() below now
 * distinguishes the two: a scenario just loaded from Saved scenarios
 * (state.current.scenarioLoadedFromSaved, set by pageSaved.js) is wiped, as
 * before; an in-progress draft the user is actively building is left alone
 * and the click simply returns to the wizard where it was left, exactly as
 * the wizard's own Back/Next buttons already let someone revisit and edit
 * earlier steps.
 */

import { state } from "./state.js";
import { savedPage } from "./pageSaved.js";
import { libraryPage } from "./pageLibrary.js";
import { aboutPage } from "./pageAbout.js";
import { settingsPage } from "./pageSettings.js";
import { invalidateStepRender } from "./wizard.js";
import { loadingSpinnerHtml } from "./domUtils.js";

const PAGES = {
  saved: savedPage,
  library: libraryPage,
  about: aboutPage,
  settings: settingsPage,
};

/** Switches to a view by name — "wizard", or a key of PAGES. */
export function switchToView(view) {
  state.update({ view });
}

/**
 * What the sidebar's "New scenario" link does: returns to the wizard,
 * wiping the current scenario only when there is a real reason to — see the
 * module docstring's 2026-09-23 note for why this is no longer unconditional.
 */
function resetOrResumeWizard() {
  const scenario = state.current.scenario;
  const hasDraftInProgress = Boolean(
    scenario.location || scenario.chemical || scenario.weather || scenario.source
  );

  if (hasDraftInProgress && !state.current.scenarioLoadedFromSaved) {
    // An unsaved, in-progress scenario already exists and nothing loaded it
    // from Saved scenarios — this click is just navigation back to the
    // wizard, not a request to discard anything. Whoever wants a genuinely
    // blank scenario while one is mid-draft can still get there through
    // Saved scenarios (which does set scenarioLoadedFromSaved) or by
    // clearing the fields themselves; this link no longer does it silently.
    switchToView("wizard");
    return;
  }

  // Same reasoning as loadScenario() in pageSaved.js: if the wizard was
  // already sitting on step 0 (Location), the index would not change even
  // though the scenario data just did, and the redraw guard only watches
  // the index — without this, "New scenario" clicked from Location would
  // silently leave the previous scenario's location on screen.
  invalidateStepRender();
  state.update({
    view: "wizard",
    wizard: { ...state.current.wizard, currentStep: 0 },
    scenario: { location: null, chemical: null, weather: null, source: null, fire: null, indoor: null },
    scenarioLoadedFromSaved: false,
  });
}

export function initPageRouter() {
  const wizardContainer = document.querySelector(".wizard-container");
  const pageContainer = document.querySelector(".page-container");
  const navLinks = document.querySelectorAll("[data-view]");

  if (!wizardContainer || !pageContainer) {
    console.warn("pageRouter.js: required containers are missing from the DOM");
    return;
  }

  // Tracks which standalone page was last drawn, so the loading indicator
  // below only flashes on an actual NAVIGATION to a page, not on every one
  // of the (many) other state updates that also trigger this render() while
  // the person stays on the same page — e.g. Saved scenarios re-rendering
  // itself after a delete. Re-flashing the indicator on those would just be
  // visual noise, not a genuine loading state.
  let lastRenderedView = null;

  function render() {
    const view = state.current.view;

    navLinks.forEach((link) => {
      if (link.dataset.view === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });

    if (view === "wizard") {
      wizardContainer.hidden = false;
      pageContainer.hidden = true;
      return;
    }

    wizardContainer.hidden = true;
    pageContainer.hidden = false;

    const page = PAGES[view];
    if (!page) {
      pageContainer.innerHTML = `<div class="panel"><p>Unknown page.</p></div>`;
      return;
    }

    // Same reasoning as wizard.js's step render (2026-09-25): shown
    // immediately on a page switch, overwritten the instant this page's own
    // render() call below finishes. Only pages that actually take a moment
    // (e.g. Library, whose chemical database load can be perceptible) ever
    // show it — see lastRenderedView's comment for why this only fires on
    // an actual navigation, not on every re-render while already here.
    if (lastRenderedView !== view) {
      pageContainer.innerHTML = loadingSpinnerHtml("Loading…");
    }
    lastRenderedView = view;

    Promise.resolve(page.render(pageContainer)).catch((error) => {
      console.error(`Page "${view}" failed to render:`, error);
    });
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();

      // "New scenario" is the only nav link pointing at the wizard view —
      // loading a saved scenario reaches the wizard view a different way
      // (switchToView() called directly from pageSaved.js), so treating
      // every click on this one link as "return to (or start) the wizard"
      // is unambiguous.
      if (link.dataset.view === "wizard") {
        resetOrResumeWizard();
      } else {
        switchToView(link.dataset.view);
      }

      // Closing the mobile drawer on any sidebar link click (this one
      // included) is now handled centrally in appShell.js, since it also
      // has to cover the sidebar's external links (Full documentation,
      // Other tools), which this file never sees a click event for.
    });
  });

  state.subscribe(render);
  render();
}
