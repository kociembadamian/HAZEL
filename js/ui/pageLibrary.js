/**
 * pageLibrary.js
 * --------------
 * Browsable, searchable view of the chemical database, with an export —
 * anyone is free to take the data and use it elsewhere. HAZEL's exposure
 * thresholds come from a public-domain US government dataset, so there is no
 * licensing reason to gate this; the export exists because a self-contained
 * open dataset is more useful to the wider community sitting in a downloadable
 * file than trapped behind a search box.
 *
 * YOUR OWN ENTRIES AND OVERRIDES (2026-09-23)
 * -----------------------------------------------
 * This page is also where a user adds a substance the DOE dataset does not
 * carry at all, or ENRICHES one that IS in the dataset with a parameter it
 * does not carry (upper explosive limit, heat of combustion, boiling point,
 * liquid density/heat capacity — the gaps documented throughout this project;
 * see customChemicalStore.js's module docstring for the full account,
 * including why "add a new substance" and "edit an existing one" turn out
 * to be the same mechanism here). Everything saved is stored only in this
 * browser (IndexedDB) — see the storage-usage readout and the export/import
 * buttons below, which exist specifically because that store has no server
 * backup and, unlike a handful of saved scenarios, can genuinely grow large
 * for a user who curates many substances over time.
 *
 * NOTE (2026-09-23, later the same day): the add/edit form's Save and
 * Cancel buttons (data-action="cc-save"/"cc-cancel") are injected into
 * #cc-form dynamically, by openForm(), well after wireCustomSection() runs
 * its one-time querySelector-based wiring. Binding those two listeners at
 * wiring time therefore found nothing yet and silently attached to
 * nothing — the buttons rendered but did nothing when clicked. Fixed by
 * wiring them inside openForm() itself, right after the form's HTML is
 * inserted, so a listener always exists for the buttons that actually
 * exist at that moment (the fields, cc-add/cc-edit/cc-delete were fine —
 * everything else lives in the page's initial render, before wiring runs).
 */

import { loadChemicalDatabase, searchChemicals, findByCas } from "../services/chemicalDatabase.js";
import {
  listCustomChemicals,
  addCustomChemical,
  updateCustomChemical,
  deleteCustomChemical,
  exportCustomChemicalsJson,
  importCustomChemicalsJson,
  estimateStorageUsage,
} from "../services/customChemicalStore.js";

function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toCsv(records) {
  const header = ["CAS", "Name", "Formula", "State", "Molecular weight (g/mol)", "PAC-1 (ppm)", "PAC-2 (ppm)", "PAC-3 (ppm)"];
  const escapeCsv = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = records.map((r) =>
    [r.casNumber, r.name, r.molecularFormula, r.state25C, r.molecularWeight, r.pac1Ppm, r.pac2Ppm, r.pac3Ppm]
      .map(escapeCsv)
      .join(",")
  );
  return [header.join(","), ...rows].join("\n");
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resultsTableHtml(records) {
  if (records.length === 0) return `<p class="field__hint">No matches.</p>`;

  return `
    <p class="field__hint">Scroll sideways to see every column.</p>
    <div class="library-table-wrap">
      <table class="library-table">
        <thead>
          <tr><th>Name</th><th>CAS</th><th>Formula</th><th>M (g/mol)</th><th>PAC-1</th><th>PAC-2</th><th>PAC-3</th></tr>
        </thead>
        <tbody>
          ${records
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td>${escapeHtml(r.casNumber)}</td>
              <td>${escapeHtml(r.molecularFormula)}</td>
              <td>${r.molecularWeight ?? "—"}</td>
              <td>${Number.isFinite(r.pac1Ppm) ? r.pac1Ppm : "—"}</td>
              <td>${Number.isFinite(r.pac2Ppm) ? r.pac2Ppm : "—"}</td>
              <td>${Number.isFinite(r.pac3Ppm) ? r.pac3Ppm : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

/* ========================================================================
   YOUR OWN ENTRIES — list, add/edit form, delete, export/import
   ======================================================================== */

/** Numeric fields the add/edit form collects, mapped to their on-screen
 *  label, unit and help text. Kept as one list so the form, the read-back
 *  of submitted values, and the field ordering can never drift apart. */
const CUSTOM_NUMERIC_FIELDS = [
  { field: "molecularWeight", label: "Molecular weight", unit: "g/mol", step: "0.01" },
  { field: "pac1Ppm", label: "PAC-1 (mild, transient effects)", unit: "ppm", step: "0.001" },
  { field: "pac2Ppm", label: "PAC-2 (impaired ability to escape)", unit: "ppm", step: "0.001" },
  { field: "pac3Ppm", label: "PAC-3 (life-threatening)", unit: "ppm", step: "0.001" },
  { field: "lowerExplosiveLimitPpm", label: "Lower explosive limit (LEL)", unit: "ppm", step: "1" },
  { field: "upperExplosiveLimitPpm", label: "Upper explosive limit (UEL)", unit: "ppm", step: "1" },
  { field: "heatOfCombustion", label: "Heat of combustion", unit: "J/kg", step: "1000" },
  { field: "boilingPointK", label: "Boiling point", unit: "K", step: "0.1" },
  { field: "heatOfVaporization", label: "Heat of vaporisation", unit: "J/mol", step: "100" },
  { field: "liquidDensity", label: "Liquid density", unit: "kg/m³", step: "1" },
  { field: "liquidHeatCapacity", label: "Liquid heat capacity", unit: "J/(kg·K)", step: "1" },
  { field: "criticalTemperatureK", label: "Critical temperature (Tc)", unit: "K", step: "0.1" },
  { field: "criticalPressureBar", label: "Critical pressure (Pc)", unit: "bar", step: "0.01" },
  { field: "acentricFactor", label: "Acentric factor (ω, optional)", unit: "–", step: "0.001" },
];

function customEntryFormHtml(editing) {
  const record = editing ?? {};
  const isEditing = Boolean(editing?.id);

  return `
    <div class="panel" style="margin-top: var(--space-4);">
      <h3>${isEditing ? "Edit entry" : "Add new entry"}</h3>
      <p>
        Leave the CAS number blank (or enter one that is not yet in the
        database) to add a wholly new substance. Enter the CAS number of a
        substance ALREADY in the DOE database (e.g. propane — 74-98-6) to
        only ENRICH it with missing parameters — the official PAC-1/2/3
        thresholds are kept as-is unless you also override them below.
      </p>

      <div class="field-grid">
        <div class="field">
          <label for="cc-name">Name</label>
          <input type="text" id="cc-name" value="${escapeHtml(record.name ?? "")}" data-cc-field="name" />
        </div>
        <div class="field">
          <label for="cc-cas">CAS number (optional)</label>
          <input type="text" id="cc-cas" value="${escapeHtml(record.casNumber ?? "")}" data-cc-field="casNumber"
                 placeholder="e.g. 74-98-6" />
          <div class="field__hint">Blank = a new, standalone substance.</div>
        </div>
        <div class="field">
          <label for="cc-formula">Chemical formula (optional)</label>
          <input type="text" id="cc-formula" value="${escapeHtml(record.molecularFormula ?? "")}" data-cc-field="molecularFormula" />
        </div>
        <div class="field">
          <label for="cc-state">State at 25°C</label>
          <select id="cc-state" data-cc-field="state25C">
            <option value="">— leave unchanged / not applicable —</option>
            <option value="gas"${record.state25C === "gas" ? " selected" : ""}>Gas</option>
            <option value="liquid"${record.state25C === "liquid" ? " selected" : ""}>Liquid</option>
            <option value="solid"${record.state25C === "solid" ? " selected" : ""}>Solid</option>
          </select>
        </div>

        ${CUSTOM_NUMERIC_FIELDS.map(
          ({ field, label, unit, step }) => `
        <div class="field">
          <label for="cc-${field}">${label}</label>
          <div class="input-pair">
            <input type="number" id="cc-${field}" step="${step}"
                   value="${record[field] ?? ""}" data-cc-field="${field}" />
            <span class="input-suffix">${unit}</span>
          </div>
        </div>`
        ).join("")}
      </div>

      <div class="field">
        <label>
          <input type="checkbox" data-cc-field="isNonCondensableGas" ${record.isNonCondensableGas ? "checked" : ""}
                 style="width:auto; display:inline-block; margin-right: var(--space-2);" />
          This is a genuinely non-condensable compressed gas (not a liquefied gas under pressure)
        </label>
        <div class="field__hint">
          Only check this for a gas that does NOT liquefy in a tank under
          normal working pressure (e.g. hydrogen, compressed natural gas) —
          unlike propane, chlorine or ammonia, which in an ADR tank are
          actually a liquid under their own vapour pressure. A tank of this
          substance then defaults to "Gas only (compressed)" at the Source
          step. Entering the critical temperature above does the same
          automatically whenever the tank is warmer than it.
        </div>
        <div class="field__hint">
          Critical temperature and pressure: NIST Chemistry WebBook
          (webbook.nist.gov) → search by name or CAS number → "Phase change
          data" → Tc (K) and Pc (bar). They make the mass of a compressed gas
          in a tank exact at high pressure (a gas is not ideal there — e.g.
          methane at 50 atm holds about 11% more than the ideal-gas value).
          The acentric factor is not on the WebBook; leave it empty and HAZEL
          estimates it from the boiling point, Tc and Pc, or take it from a
          data book (e.g. Poling, Prausnitz &amp; O'Connell, "The Properties
          of Gases and Liquids", Appendix A).
        </div>
      </div>

      <div class="field">
        <label for="cc-notes">Notes (optional, for your own reference)</label>
        <input type="text" id="cc-notes" value="${escapeHtml(record.notes ?? "")}" data-cc-field="notes"
               placeholder="e.g. data source, date checked" />
      </div>

      <div id="cc-form-errors"></div>

      <div class="results-actions">
        <button type="button" class="btn btn--primary" data-action="cc-save">${isEditing ? "Save changes" : "Add entry"}</button>
        <button type="button" class="btn btn--secondary" data-action="cc-cancel">Cancel</button>
      </div>
    </div>`;
}

function customEntryListHtml(entries) {
  if (entries.length === 0) {
    return `<p class="field__hint">You don't have any entries of your own yet.</p>`;
  }

  return `
    <div class="library-table-wrap">
      <table class="library-table">
        <thead>
          <tr><th>Name</th><th>CAS</th><th>Type</th><th>Saved parameters</th><th></th></tr>
        </thead>
        <tbody>
          ${entries
            .map((r) => {
              const isOverride = Boolean(r.casNumber && findByCas(r.casNumber));
              const savedFields = CUSTOM_NUMERIC_FIELDS.map(({ field }) => field)
                .filter((f) => Number.isFinite(r[f])).length;
              return `
            <tr>
              <td>${escapeHtml(r.name)}</td>
              <td>${escapeHtml(r.casNumber ?? "—")}</td>
              <td>${isOverride ? "Enrichment of existing" : "New substance"}</td>
              <td>${savedFields} fields</td>
              <td>
                <button type="button" class="btn btn--secondary btn--small" data-action="cc-edit" data-id="${r.id}">Edit</button>
                <button type="button" class="btn btn--secondary btn--small" data-action="cc-delete" data-id="${r.id}">Delete</button>
              </td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function storageUsageHtml(usage) {
  if (!usage.supported) {
    return `<p class="field__hint">Your browser does not expose local storage usage information.</p>`;
  }
  const pct = usage.quotaBytes ? Math.min(100, (usage.usageBytes / usage.quotaBytes) * 100) : null;
  return `
    <p class="field__hint">
      HAZEL is currently using about ${formatBytes(usage.usageBytes)}
      ${usage.quotaBytes ? `of the ${formatBytes(usage.quotaBytes)} available (${pct.toFixed(1)}%)` : ""}
      of local browser storage (this covers the whole app, not just your
      entries — the browser does not break it down more precisely). This
      storage is local to this device and this browser: clearing the site's
      data/cookies removes it. Download a copy of your entries regularly
      with the button below if your library is growing.
    </p>`;
}

async function renderCustomSection(container) {
  const slot = container.querySelector("#lib-custom-section");
  if (!slot) return;

  let entries = [];
  let usage = { supported: false, usageBytes: null, quotaBytes: null };
  try {
    [entries, usage] = await Promise.all([listCustomChemicals(), estimateStorageUsage()]);
  } catch (error) {
    slot.innerHTML = `<div class="banner banner--warning"><span>${escapeHtml(error.message)}</span></div>`;
    return;
  }

  slot.innerHTML = `
    <h2 style="margin-top: var(--space-6);">Your library: own entries and enrichments</h2>
    <p>
      Add substances that are not in the DOE database, or enrich existing
      ones with missing parameters (upper explosive limit, heat of
      combustion, liquid density and others) — see the hint in the form
      below. Saved data will appear automatically in the Chemical step and
      fill in the relevant fields in the Source and Fire/explosion steps.
    </p>

    ${storageUsageHtml(usage)}

    <div class="results-actions" style="margin-bottom: var(--space-4);">
      <button type="button" class="btn btn--primary btn--small" data-action="cc-add">Add new entry</button>
      <button type="button" class="btn btn--secondary btn--small" data-action="cc-export">Download your entries (JSON)</button>
      <label class="btn btn--secondary btn--small" style="cursor:pointer;">
        Upload entries from a file (JSON)
        <input type="file" accept="application/json" data-action="cc-import" style="display:none;" />
      </label>
    </div>

    <div id="cc-import-feedback"></div>
    <div id="cc-list">${customEntryListHtml(entries)}</div>
    <div id="cc-form"></div>`;

  wireCustomSection(container, entries);
}

function wireCustomSection(container, entries) {
  const formSlot = container.querySelector("#cc-form");

  function closeForm() {
    formSlot.innerHTML = "";
  }

  function openForm(editing) {
    formSlot.innerHTML = customEntryFormHtml(editing);
    // The id of the record being edited (if any) is not itself a form
    // field — tracked here instead of re-matching by name, since two
    // entries can share a name.
    if (editing?.id) formSlot.dataset.editingId = String(editing.id);
    else delete formSlot.dataset.editingId;
    formSlot.scrollIntoView({ behavior: "smooth", block: "nearest" });

    // Save/Cancel are wired HERE, right after the form's HTML lands in the
    // DOM, rather than once up front in wireCustomSection(): at the time
    // wireCustomSection() runs, #cc-form is still empty (the form is only
    // injected once "Add new entry" or "Edit" is clicked), so any listener
    // attached to these buttons earlier would have found nothing to attach
    // to. See the module docstring's 2026-09-23 note.
    formSlot.querySelector('[data-action="cc-cancel"]')?.addEventListener("click", closeForm);

    formSlot.querySelector('[data-action="cc-save"]')?.addEventListener("click", async () => {
      const errorsSlot = formSlot.querySelector("#cc-form-errors");
      const values = {};
      formSlot.querySelectorAll("[data-cc-field]").forEach((input) => {
        const field = input.dataset.ccField;
        values[field] = input.type === "checkbox" ? input.checked : input.value;
      });

      const idAttr = formSlot.dataset.editingId;

      try {
        if (idAttr) {
          await updateCustomChemical(Number(idAttr), values);
        } else {
          await addCustomChemical(values);
        }
        if (errorsSlot) errorsSlot.innerHTML = "";
        await renderCustomSection(container);
      } catch (error) {
        if (errorsSlot) {
          errorsSlot.innerHTML = `<div class="banner banner--warning"><span>${escapeHtml(error.message)}</span></div>`;
        }
      }
    });
  }

  container.querySelector('[data-action="cc-add"]')?.addEventListener("click", () => openForm(null));

  container.querySelectorAll('[data-action="cc-edit"]').forEach((button) => {
    button.addEventListener("click", () => {
      const record = entries.find((r) => String(r.id) === button.dataset.id);
      if (record) openForm(record);
    });
  });

  container.querySelectorAll('[data-action="cc-delete"]').forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Delete this entry? This cannot be undone.")) return;
      try {
        await deleteCustomChemical(Number(button.dataset.id));
        await renderCustomSection(container);
      } catch (error) {
        window.alert(`Could not delete the entry: ${error.message}`);
      }
    });
  });

  container.querySelector('[data-action="cc-export"]')?.addEventListener("click", async () => {
    try {
      const json = await exportCustomChemicalsJson();
      downloadTextFile("hazel-my-chemicals.json", json, "application/json");
    } catch (error) {
      window.alert(`Could not prepare the file: ${error.message}`);
    }
  });

  const importInput = container.querySelector('[data-action="cc-import"]');
  importInput?.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    const feedback = container.querySelector("#cc-import-feedback");
    try {
      const text = await file.text();
      const { added, skipped } = await importCustomChemicalsJson(text);
      if (feedback) {
        feedback.innerHTML = `
          <div class="banner ${skipped.length > 0 ? "banner--warning" : "banner--info"}">
            <span>
              Added ${added} ${added === 1 ? "entry" : "entries"}.
              ${skipped.length > 0 ? `Skipped ${skipped.length} invalid: ${skipped.map((s) => escapeHtml(s.name)).join(", ")}.` : ""}
            </span>
          </div>`;
      }
      await renderCustomSection(container);
    } catch (error) {
      if (feedback) {
        feedback.innerHTML = `<div class="banner banner--warning"><span>${escapeHtml(error.message)}</span></div>`;
      }
    } finally {
      importInput.value = "";
    }
  });
}

/* ========================================================================
   PUBLIC INTERFACE
   ======================================================================== */

export const libraryPage = {
  id: "library",
  label: "Chemical library",

  async render(container) {
    container.innerHTML = `
      <div class="panel">
        <h1>Chemical library</h1>
        <p>
          3,148 substances from the US Department of Energy's Protective
          Action Criteria dataset — public domain, free to reuse. Search
          below, or download the whole thing.
        </p>

        <div class="field">
          <label for="lib-search">Search</label>
          <input type="text" id="lib-search" placeholder="methanol, chlorine, 67-56-1…" autocomplete="off" />
        </div>

        <div class="results-actions" style="margin-bottom: var(--space-4);">
          <button type="button" class="btn btn--secondary btn--small" data-action="export-csv">Download results as CSV</button>
          <button type="button" class="btn btn--secondary btn--small" data-action="export-json">Download full database as JSON</button>
        </div>

        <div id="lib-results"></div>

        <div id="lib-custom-section"></div>
      </div>`;

    const resultsEl = container.querySelector("#lib-results");
    const searchInput = container.querySelector("#lib-search");

    let currentResults = [];
    let fullIndex = [];

    try {
      fullIndex = await loadChemicalDatabase();
      currentResults = fullIndex.slice(0, 50);
      resultsEl.innerHTML = resultsTableHtml(currentResults) +
        `<p class="field__hint">Showing the first 50 of ${fullIndex.length}. Search to narrow this down.</p>`;
    } catch (error) {
      resultsEl.innerHTML = `<div class="banner banner--warning"><span>${escapeHtml(error.message)}</span></div>`;
    }

    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const query = searchInput.value.trim();
        currentResults = query.length >= 2 ? searchChemicals(query, 100) : fullIndex.slice(0, 50);
        resultsEl.innerHTML = resultsTableHtml(currentResults);
      }, 150);
    });

    container.querySelector('[data-action="export-csv"]')?.addEventListener("click", () => {
      downloadTextFile("hazel-chemicals.csv", toCsv(currentResults), "text/csv");
    });

    container.querySelector('[data-action="export-json"]')?.addEventListener("click", () => {
      downloadTextFile("hazel-chemicals.json", JSON.stringify(fullIndex, null, 2), "application/json");
    });

    await renderCustomSection(container);
  },
};
