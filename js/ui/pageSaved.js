/**
 * pageSaved.js
 * ------------
 * Lists scenarios saved on this device (see scenarioStorage.js) and lets the
 * user reopen one — which drops them back into the wizard at the Results
 * step, since a saved scenario is by definition one that already had enough
 * filled in to produce a result — or delete one they no longer need.
 *
 * NOTE (2026-09-23): loading a scenario here now also sets
 * state.current.scenarioLoadedFromSaved = true. That flag is what lets the
 * sidebar's "New scenario" link (pageRouter.js) tell the difference between
 * "the user just opened something from this list and now wants a genuinely
 * blank scenario" (wipe it) and "the user has an unsaved draft in progress
 * and only navigated away and back" (leave it alone) — see pageRouter.js's
 * module docstring for the bug this fixes.
 */

import { state } from "./state.js";
import { listScenarios, loadScenario, deleteScenario } from "../services/scenarioStorage.js";
import { switchToView } from "./pageRouter.js";
import { invalidateStepRender } from "./wizard.js";
import { wireOnce } from "./domUtils.js";

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatSavedAt(timestamp) {
  return new Date(timestamp).toLocaleString();
}

async function renderList(container) {
  const listEl = container.querySelector("#saved-list");
  if (!listEl) return;

  let scenarios;
  try {
    scenarios = await listScenarios();
  } catch (error) {
    listEl.innerHTML = `<div class="banner banner--warning"><span>Could not read saved scenarios: ${escapeHtml(error.message)}</span></div>`;
    return;
  }

  if (scenarios.length === 0) {
    listEl.innerHTML = `<p class="field__hint">No scenarios saved yet. Save one from the Results step once you have run a calculation.</p>`;
    return;
  }

  listEl.innerHTML = scenarios
    .map(
      (s) => `
      <div class="saved-item">
        <div>
          <span class="saved-item__name">${escapeHtml(s.name)}</span>
          <span class="saved-item__summary">${escapeHtml(s.summary ?? "")}</span>
          <span class="saved-item__date">${formatSavedAt(s.savedAt)}</span>
        </div>
        <div class="saved-item__actions">
          <button type="button" class="btn btn--secondary btn--small" data-load="${s.id}">Open</button>
          <button type="button" class="btn btn--secondary btn--small" data-delete="${s.id}">Delete</button>
        </div>
      </div>`
    )
    .join("");
}

export const savedPage = {
  id: "saved",
  label: "Saved scenarios",

  render(container) {
    container.innerHTML = `
      <div class="panel">
        <h1>Saved scenarios</h1>
        <p>Scenarios saved on this device. Nothing here is sent anywhere else.</p>
        <div id="saved-list"></div>
      </div>`;

    wireOnce(container, "saved-click", "click", async (event) => {
      const loadId = event.target.closest("[data-load]")?.dataset.load;
      const deleteId = event.target.closest("[data-delete]")?.dataset.delete;

      if (loadId) {
        const record = await loadScenario(Number(loadId));
        if (record) {
          // Loading a scenario always lands on the Results step. If the
          // wizard was already showing Results (from a previous scenario),
          // the step INDEX does not change even though the DATA does — and
          // the wizard's redraw guard only watches the index, so the old
          // scenario's map would otherwise stay on screen under the new
          // scenario's data until the user navigated away and back.
          invalidateStepRender();
          state.update({
            scenario: record.scenario,
            wizard: { ...state.current.wizard, currentStep: state.current.wizard.steps.length - 1 },
            // Marks this scenario as "loaded", not "a draft in progress" —
            // see pageRouter.js's resetOrResumeWizard() and its module
            // docstring's 2026-09-23 note.
            scenarioLoadedFromSaved: true,
          });
          switchToView("wizard");
        }
      }

      if (deleteId) {
        await deleteScenario(Number(deleteId));
        renderList(container);
      }
    });

    renderList(container);
  },
};
