/**
 * state.js
 * --------
 * The single source of truth for the whole application. Instead of a
 * framework (React/Vue) HAZEL uses one state object plus render functions
 * that read it. That is enough for a five-step wizard with no need for
 * real-time recalculation.
 *
 * The pattern: any module that wants to react to a change subscribes with
 * state.subscribe(fn). Any module that changes state does so ONLY through
 * state.update(partial) — never by mutating state.current directly. Every
 * change therefore passes through one place, which makes debugging and
 * auditing straightforward: logging every state transition means adding one
 * line here rather than tracing calls across the codebase.
 */

const listeners = [];

/**
 * Initial application state. Later steps (chemical, weather, source,
 * results) will add their own sections here — keep the shape flat and
 * predictable so the code stays easy to audit.
 */
const initialState = {
  // Which top-level view is shown: "wizard", or a page key from pageRouter.js
  // ("saved", "library", "about", "settings").
  view: "wizard",

  // Which wizard step is active (index 0-4)
  wizard: {
    currentStep: 0,
    steps: [
      { id: "location", label: "Location" },
      { id: "chemical", label: "Chemical" },
      { id: "weather", label: "Weather" },
      { id: "source", label: "Source" },
      { id: "results", label: "Results" },
    ],
  },

  // Whether the mobile navigation drawer is open
  drawerOpen: false,

  // True only for the moment right after a scenario was opened from Saved
  // scenarios — NOT part of `scenario` itself, since it describes where the
  // current wizard data came from, not the data. It is what lets the
  // sidebar's "New scenario" link tell a just-loaded scenario (safe to wipe)
  // apart from an unsaved draft the user is still building (must not be
  // wiped just by navigating to another page and back) — see
  // pageRouter.js's resetOrResumeWizard() and pageSaved.js.
  scenarioLoadedFromSaved: false,

  // Scenario data, filled in step by step. Empty for now; each step will add
  // its own fields as it is built.
  scenario: {
    location: null, // { lat, lng, elevation, roughness, address }
    chemical: null, // { unNumber, name, casNumber, ... }
    weather: null,  // { source: "live" | "manual", windSpeed, windDirection, ... }
    source: null,   // { type: "tank" | "puddle" | "direct", ... }
    fire: null,     // { enabled, scenarioType: "bleve" | "vce", ... } — see fireExplosionPanel.js
    indoor: null,   // { enabled, downwindDistance, tauMode, ... } — see indoorPanel.js
  },
};

export const state = {
  current: structuredClone(initialState),

  /**
   * Merges a partial object into the current state (shallow merge at the
   * top level) and notifies every subscriber.
   * Example: state.update({ drawerOpen: true }).
   */
  update(partial) {
    this.current = { ...this.current, ...partial };
    listeners.forEach((fn) => fn(this.current));
  },

  /**
   * Registers a function to be called on every state change.
   * Returns an unsubscribe function — useful if a component is ever created
   * and destroyed dynamically.
   */
  subscribe(fn) {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  },
};
