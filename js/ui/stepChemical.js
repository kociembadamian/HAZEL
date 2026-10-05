/**
 * stepChemical.js
 * ---------------
 * The Chemical step: which substance was released, and against which
 * thresholds the threat zones should be drawn.
 *
 * The step carries one responsibility beyond data entry: telling the user
 * when the substance they have chosen falls outside what the Gaussian model
 * can represent. Most of the dangerous goods that actually move by road —
 * chlorine, propane, ammonia — form clouds denser than air, and for those
 * the Gaussian model understates the hazard near the source. Saying so
 * plainly, at the moment of selection, matters more than any other single
 * message in the application.
 *
 * Search is offline once the database has loaded: the 492 KB index is a
 * static file the service worker caches like any other asset.
 *
 * CUSTOM CHEMICALS AND OVERRIDES (2026-09-23)
 * -----------------------------------------------
 * Search results now also include the user's own entries from
 * customChemicalStore.js — both wholly new substances (no matching CAS
 * number in the built-in database) and overrides that add missing
 * parameters to an EXISTING substance (a matching CAS number). Selecting a
 * built-in substance that has a saved override applies it automatically
 * (mergeCustomChemicalOntoBuiltIn()) — the fields the user filled in
 * supersede gaps in the DOE dataset (upper explosive limit, heat of
 * combustion, boiling point, ...); the official PAC-1/2/3 toxicity
 * thresholds are left alone unless the user chose to override those too.
 * Adding and editing these entries happens on the Chemical library page
 * (pageLibrary.js), not here — this step only needs to know they exist.
 *
 * NOTE (2026-09-23): fixed a race where the results list did not always
 * close after selecting a substance. See the comment above the
 * clearTimeout(searchTimer) call in wireEvents() for the mechanism — a
 * pending debounced search from the previous keystroke could still fire
 * after selection and repaint the just-cleared results list.
 */

import { state } from "./state.js";
import { wireOnce } from "./domUtils.js";
import {
  loadChemicalDatabase,
  searchChemicals,
  findByCas,
  describeVapourDensity,
  levelsOfConcern,
  isUsableForDispersion,
} from "../services/chemicalDatabase.js";
import {
  listCustomChemicals,
  normaliseCasForCompare,
  mergeCustomChemicalOntoBuiltIn,
  toDisplayRecord,
} from "../services/customChemicalStore.js";

/** Default shape stored in the scenario when the step is first opened. */
function defaultChemical() {
  return {
    selected: null, // the record chosen from the database
    selectedLevels: ["pac1", "pac2", "pac3"], // which thresholds to draw
    manualOverrides: {}, // user-supplied values for fields the database lacks
  };
}

function currentChemical() {
  return state.current.scenario.chemical ?? defaultChemical();
}

function updateChemical(changes) {
  const chemical = { ...currentChemical(), ...changes };
  state.update({ scenario: { ...state.current.scenario, chemical } });
}

/**
 * Loads every custom chemical entry once per render, split into overrides
 * (keyed by CAS number, for merging onto a built-in search result) and
 * standalone substances (shown as their own search results).
 *
 * Loaded once and cached on the container's dataset-adjacent closure below
 * rather than re-queried on every keystroke — IndexedDB reads are cheap but
 * not free, and a user's custom library does not change while they are
 * typing a search query.
 */
async function loadCustomChemicals() {
  let all = [];
  try {
    all = await listCustomChemicals();
  } catch {
    return { overridesByDigits: new Map(), standalone: [] };
  }

  const overridesByDigits = new Map();
  const standalone = [];

  for (const record of all) {
    if (record.casNumber && findByCas(record.casNumber)) {
      overridesByDigits.set(normaliseCasForCompare(record.casNumber), record);
    } else {
      standalone.push(toDisplayRecord(record));
    }
  }

  return { overridesByDigits, standalone };
}

/* ========================================================================
   RENDERING
   ======================================================================== */

function searchPanelHtml() {
  return `
    <div class="panel">
      <h2>Released substance</h2>
      <p>
        Search by name or CAS number. The database holds 3,148 substances from
        the US Department of Energy's Protective Action Criteria dataset, which
        combines AEGL, ERPG and TEEL exposure thresholds — plus any substances
        or data enrichments you have added yourself on the Chemical library
        page (sidebar).
      </p>

      <div class="field">
        <label for="chem-search">Substance</label>
        <input type="text" id="chem-search" placeholder="methanol, chlorine, 67-56-1…"
               autocomplete="off" />
        <div class="field__hint">
          Names follow the source dataset, which often inverts them — methanol
          appears as "Methyl alcohol; (Methanol)". Partial matches work.
        </div>
      </div>

      <div id="chem-results"></div>
    </div>
  `;
}

function resultsHtml(results, query) {
  if (results.length === 0) {
    return `
      <p class="field__hint">
        Nothing matching "${escapeHtml(query)}". Try a shorter fragment, a CAS
        number, or an alternative name — the dataset uses systematic names more
        often than trade names.
      </p>`;
  }

  return `
    <div class="result-list">
      ${results
        .map((record) => {
          const usable = isUsableForDispersion(record);
          const formula = record.molecularFormula
            ? `<span class="result-item__formula">${escapeHtml(record.molecularFormula)}</span>`
            : "";
          const customBadge = record.isCustom
            ? `<span class="threat-badge" style="background:var(--color-accent); color:var(--color-ink-on-accent);">Your entry</span>`
            : "";
          return `
            <button type="button" class="result-item" data-cas="${escapeHtml(record.casNumber)}"
                    ${record.isCustom ? `data-custom-id="${record.customId}"` : ""}
                    ${usable ? "" : 'data-unusable="true"'}>
              <span class="result-item__name">${escapeHtml(record.name)} ${customBadge}</span>
              <span class="result-item__meta">
                CAS ${escapeHtml(record.casNumber)} ${formula}
                ${record.molecularWeight ? `· M = ${record.molecularWeight} g/mol` : ""}
                ${usable ? "" : "· insufficient data for modelling"}
              </span>
            </button>`;
        })
        .join("")}
    </div>`;
}

/**
 * Renders the density banner, or nothing at all.
 *
 * Most substances produce no banner — see describeVapourDensity() for why
 * that restraint is deliberate. The density ratio itself is always visible in
 * the readout above, so nothing is hidden; what is avoided is a banner so
 * routine that it stops being read.
 */
function densityBannerHtml(assessment) {
  if (!assessment.message) return "";
  const bannerClass = assessment.severity === "blocking" ? "banner--warning" : "banner--info";
  return `
    <div class="banner ${bannerClass}">
      <span>${escapeHtml(assessment.message)}</span>
    </div>`;
}

/**
 * A note that this substance's record includes the user's own saved data —
 * an override on a built-in substance, or a fully custom one — so it is
 * clear on screen why a field like the upper explosive limit is filled in
 * when the built-in dataset never carries one. Edits happen on the Chemical
 * library page, linked here rather than duplicating the edit form in two
 * places.
 */
function customDataBannerHtml(chemical) {
  if (chemical.hasCustomOverride) {
    return `
      <div class="banner banner--info">
        <span>
          This substance includes your own saved supplementary data (shown
          below). Edit it on the Chemical library page (sidebar).
        </span>
      </div>`;
  }
  if (chemical.isCustom) {
    return `
      <div class="banner banner--info">
        <span>
          This is your own entry, added on the Chemical library page
          (sidebar) — it does not come from the public DOE dataset.
        </span>
      </div>`;
  }
  return "";
}

function selectedChemicalHtml(chemical) {
  const record = chemical.selected;
  if (!record) return "";

  const assessment = describeVapourDensity(record);
  const levels = levelsOfConcern(record);

  const unitNote =
    record.originalUnit === "mg/m3"
      ? `<p class="field__hint">
           Thresholds were published in mg/m³ and converted to ppm using this
           substance's molecular weight. The engine works in ppm.
         </p>`
      : "";

  const levelRows = levels
    .map((level) => {
      const available = Number.isFinite(level.ppm);
      const checked = chemical.selectedLevels.includes(level.id) && available;
      return `
        <label class="level-row ${available ? "" : "level-row--unavailable"}">
          <input type="checkbox" data-level="${level.id}"
                 ${checked ? "checked" : ""} ${available ? "" : "disabled"} />
          <span class="threat-badge threat-badge--${level.colour}">${level.label}</span>
          <span class="level-row__desc">${level.description}</span>
          <span class="level-row__value">
            ${available ? `${formatPpm(level.ppm)} ppm` : "not published"}
          </span>
        </label>`;
    })
    .join("");

  return `
    <div class="panel" style="margin-top: var(--space-6);">
      <h3>${escapeHtml(record.name)}</h3>

      ${customDataBannerHtml(record)}

      <dl class="readout">
        <div><dt>CAS number</dt><dd>${escapeHtml(record.casNumber)}</dd></div>
        <div><dt>Formula</dt><dd>${escapeHtml(record.molecularFormula ?? "—")}</dd></div>
        <div><dt>Molecular weight</dt><dd>${record.molecularWeight ?? "—"} g/mol</dd></div>
        <div><dt>State at 25 °C</dt><dd>${record.state25C}</dd></div>
        <div><dt>Vapour density vs air</dt>
             <dd>${assessment.ratio ? assessment.ratio.toFixed(2) : "—"}</dd></div>
        ${
          Number.isFinite(record.upperExplosiveLimitPpm)
            ? `<div><dt>Upper explosive limit</dt><dd>${formatPpm(record.upperExplosiveLimitPpm)} ppm (your entry)</dd></div>`
            : ""
        }
      </dl>

      ${densityBannerHtml(assessment)}

      <p class="field__hint">
        Whether this release disperses passively or slumps along the ground as a
        dense cloud depends on the release rate and the wind as well as the
        density. HAZEL works that out at the Source step and will say plainly if
        the Gaussian model does not apply.
      </p>

      <h3 style="margin-top: var(--space-6);">Levels of concern</h3>
      <p>
        Each selected threshold is drawn as its own zone. Deselect any you do
        not want on the result.
      </p>
      <div class="level-list">${levelRows}</div>
      ${unitNote}

      <p class="attribution">
        Exposure thresholds from the US Department of Energy Protective Action
        Criteria dataset (AEGL / ERPG / TEEL hierarchy), a work of the US
        government in the public domain${record.hasCustomOverride || record.isCustom ? ", supplemented with your own saved data" : ""}.
      </p>
    </div>`;
}

/**
 * Formats a ppm value readably across the very wide range the dataset spans.
 *
 * BUG FIXED 2026-09-29: the trailing-zero trim below used to be
 * `.replace(/\.?0+$/, "")` — the optional `\.?` let it strip trailing zeros
 * from a plain integer with no decimal point at all, not just from the
 * fractional part it was meant to tidy up. `(200).toPrecision(3)` is the
 * string "200" (no decimal point at all), so that regex matched the
 * significant trailing "00" and cut it down to "2" — a tenfold-to-
 * hundredfold understatement of the real value. Found via a real
 * HAZEL/ALOHA comparison: hydrogen chloride's PAC-3 (published at 100 ppm)
 * displayed as "1 ppm", and acetone's PAC-1 (published at 200 ppm)
 * displayed as "2 ppm". Any published threshold landing on a "round" value
 * in [100, 999] ending in one or two zeros — 100, 110, ..., 900, 990 — was
 * affected the same way; values that fall into scientific notation (e.g.
 * 3200 -> "3.20e+3") or that do not end in "0" were not.
 *
 * The fix requires an actual decimal point immediately before the run of
 * zeros being trimmed, so a bare integer like "200" is left alone; a lone
 * trailing "." left behind by the first replace (e.g. "1.00" -> "1.") is
 * removed in a second pass.
 *
 * IMPORTANT: this bug was confined to this on-screen display. The actual
 * dispersion search (computeZones() in stepResults.js, via
 * levelsOfConcern()) always reads the chemical record's raw pac1Ppm /
 * pac2Ppm / pac3Ppm numbers directly — never this formatted string — so no
 * threat zone this project has ever computed used a wrong threshold because
 * of it. See chemicalTests.js for the regression coverage added alongside
 * this fix.
 */
export function formatPpm(value) {
  const trimTrailingZeros = (text) => text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (value >= 100) return trimTrailingZeros(value.toPrecision(3));
  if (value >= 1) return trimTrailingZeros(value.toFixed(2));
  if (value >= 0.001) return trimTrailingZeros(value.toFixed(4));
  return value.toExponential(2);
}

/**
 * Escapes text before it goes into innerHTML.
 *
 * Chemical names in this dataset contain characters that are meaningful in
 * HTML — "Butyl methyl-d3 ether, tert-" is harmless, but names with angle
 * brackets or ampersands appear too, and the manual-override fields accept
 * arbitrary user input. Escaping at the point of interpolation is simpler to
 * verify than sanitising at the point of entry.
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ========================================================================
   EVENT WIRING
   ======================================================================== */

/** Redraws the selected-substance panel without disturbing the search field. */
function refreshSelection(container) {
  const slot = container.querySelector("#chem-selected");
  if (!slot) return;
  slot.innerHTML = selectedChemicalHtml(currentChemical());
}

function wireEvents(container, customChemicals) {
  const searchInput = container.querySelector("#chem-search");
  const resultsSlot = container.querySelector("#chem-results");

  let searchTimer = null;

  searchInput?.addEventListener("input", () => {
    // Debounce: searching 3,148 records on every keystroke is fast enough on
    // a desktop but wasteful on a phone, and the results flicker distractingly
    // while a word is being typed.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = searchInput.value;
      if (query.trim().length < 2) {
        resultsSlot.innerHTML = "";
        return;
      }
      try {
        const builtInResults = searchChemicals(query);
        const lower = query.trim().toLowerCase();
        const customMatches = customChemicals.standalone.filter(
          (r) => r.searchName.includes(lower) || (r.casNumber || "").includes(query.trim())
        );
        resultsSlot.innerHTML = resultsHtml([...builtInResults, ...customMatches], query);
      } catch (error) {
        resultsSlot.innerHTML = `<div class="banner banner--warning"><span>${escapeHtml(error.message)}</span></div>`;
      }
    }, 150);
  });

  wireOnce(container, "chemical-click", "click", (event) => {
    const resultButton = event.target.closest(".result-item");
    if (resultButton) {
      let record;
      if (resultButton.dataset.customId) {
        // A standalone custom substance — already in the display shape.
        record = customChemicals.standalone.find(
          (r) => String(r.customId) === resultButton.dataset.customId
        );
      } else {
        const builtIn = findByCas(resultButton.dataset.cas);
        const override = builtIn
          ? customChemicals.overridesByDigits.get(normaliseCasForCompare(builtIn.casNumber))
          : null;
        record = override ? mergeCustomChemicalOntoBuiltIn(builtIn, override) : builtIn;
      }

      if (record) {
        // Selecting a substance preselects every threshold that has a
        // published value; the user can then deselect the ones they do not
        // want drawn.
        updateChemical({
          selected: record,
          selectedLevels: levelsOfConcern(record)
            .filter((l) => Number.isFinite(l.ppm))
            .map((l) => l.id),
        });
        refreshSelection(container);

        // Cancel any still-pending debounced search from the last keystroke
        // BEFORE clearing the results list below. Without this, tapping a
        // result quickly after typing (well within the 150ms debounce
        // window — the common case, since the list appears the moment
        // typing pauses and a tap often follows immediately) let that
        // pending timer fire a moment later and repaint #chem-results with
        // the stale query results, right after this handler had just
        // emptied it — from the outside, the list appeared to "not always"
        // close on selection. This was a timing race, not a mobile-only
        // touch issue, which is also why it was reported on desktop too.
        clearTimeout(searchTimer);

        // Close the results list and show what was chosen in the search box
        // — leaving the full list open after a selection is what made it
        // look like nothing had happened.
        const resultsSlot = container.querySelector("#chem-results");
        const searchInput = container.querySelector("#chem-search");
        if (resultsSlot) resultsSlot.innerHTML = "";
        if (searchInput) searchInput.value = record.name;
      }
      return;
    }

  });

  // Threshold checkboxes
  wireOnce(container, "chemical-change", "change", (event) => {
    const levelId = event.target.dataset?.level;
    if (!levelId) return;

    const current = currentChemical().selectedLevels;
    const next = event.target.checked
      ? [...new Set([...current, levelId])]
      : current.filter((id) => id !== levelId);

    updateChemical({ selectedLevels: next });
  });
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

export const chemicalStep = {
  id: "chemical",
  label: "Chemical",

  async render(container) {
    if (!state.current.scenario.chemical) {
      state.update({
        scenario: { ...state.current.scenario, chemical: defaultChemical() },
      });
    }

    container.innerHTML = `
      ${searchPanelHtml()}
      <div id="chem-selected"></div>`;

    const resultsSlot = container.querySelector("#chem-results");

    // Load the database after the shell is on screen, so the step appears
    // immediately rather than after a half-megabyte download.
    let customChemicals = { overridesByDigits: new Map(), standalone: [] };
    try {
      await loadChemicalDatabase();
      customChemicals = await loadCustomChemicals();

      // A previously-selected built-in substance may now have a saved
      // override that did not exist the last time it was chosen (added on
      // the Library page in the meantime), or its override may since have
      // been edited or deleted — re-derive the selection fresh so the panel
      // never carries stale merged data forward.
      //
      // Deliberately re-merges onto a FRESH findByCas() lookup rather than
      // onto chemical.selected itself: chemical.selected may already be a
      // merged record from an earlier render or a previous session, and
      // mergeCustomChemicalOntoBuiltIn() only ever overwrites fields the
      // override still supplies. Re-merging onto an already-merged record
      // means a value the user cleared back to blank on the Library page
      // would never actually clear, and deleting the override outright
      // would leave the last merge (including hasCustomOverride: true)
      // stuck in state forever, since "no override" would simply skip the
      // update instead of resetting anything.
      const chemical = currentChemical();
      if (chemical.selected && !chemical.selected.isCustom) {
        const builtIn = findByCas(chemical.selected.casNumber);
        if (builtIn) {
          const override = customChemicals.overridesByDigits.get(
            normaliseCasForCompare(builtIn.casNumber)
          );
          const refreshed = override ? mergeCustomChemicalOntoBuiltIn(builtIn, override) : builtIn;
          updateChemical({ selected: refreshed });
        }
      }
    } catch (error) {
      if (resultsSlot) {
        resultsSlot.innerHTML = `
          <div class="banner banner--warning">
            <span>
              ${escapeHtml(error.message)}. Search is unavailable until the
              database loads; everything else in the wizard still works.
            </span>
          </div>`;
      }
    }

    wireEvents(container, customChemicals);
    refreshSelection(container);
  },

  isComplete() {
    const chemical = state.current.scenario.chemical;
    if (!chemical?.selected) return false;
    if (!isUsableForDispersion(chemical.selected)) return false;
    return chemical.selectedLevels.length > 0;
  },
};
