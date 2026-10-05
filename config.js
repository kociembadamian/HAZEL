/**
 * config.js
 * ---------
 * Deployment configuration. This is the ONE file someone hosting their own
 * copy of HAZEL has to edit.
 *
 * Why the weather relay URL is empty by default
 * ---------------------------------------------
 * HAZEL can fetch current weather from MET Norway (api.met.no), whose data is
 * published under CC BY 4.0 / NLOD 2.0 — free to use, including commercially,
 * with attribution.
 *
 * Their Terms of Service require every client to identify itself in the
 * User-Agent header with an application name and a working contact address,
 * and they block generic or spoofed headers. A browser cannot set User-Agent:
 * it is a forbidden header name in the Fetch specification, so JavaScript
 * running in a page physically cannot comply. The request therefore has to
 * pass through a small server-side relay that adds the header.
 *
 * That relay must carry YOUR contact details, not someone else's. If you fork
 * HAZEL and deploy it, any traffic from your users counts against whoever is
 * named in that header — so shipping a default would mean one project's
 * contact address absorbing the consequences of everyone else's traffic.
 *
 * Leaving this empty is therefore deliberate, not an oversight. With no relay
 * configured HAZEL still works completely: the Weather step falls back to
 * manual entry, which is a first-class mode rather than a degraded one.
 *
 * See docs/RELAY.md for a worked example of a relay that stores nothing.
 */

export const config = {
  /**
   * Full URL of your weather relay endpoint, e.g.
   *   "https://weather-relay.example.org/forecast"
   * The relay is expected to accept ?lat=..&lon=.. and return the MET Norway
   * Locationforecast 2.0 compact JSON payload unchanged.
   *
   * Leave as an empty string to run HAZEL in manual-entry-only mode.
   */
  weatherRelayUrl: "",

  /**
   * How long cached weather is considered current, in minutes.
   * MET Norway's Locationforecast updates roughly hourly, so refreshing more
   * often than that gains nothing and only adds load to their servers.
   * Past this age HAZEL shows the data with its age and offers a refresh —
   * it does not discard it, because stale weather is still better than no
   * weather when offline.
   */
  weatherFreshnessMinutes: 60,

  /**
   * Minimum time between live fetches to the weather relay, in minutes.
   *
   * This exists so a well-meaning user cannot accidentally hammer the relay
   * (and, behind it, MET Norway) by clicking "check weather" repeatedly. The
   * UI enforces this as a soft limit: clicking the check button within this
   * window shows a warning and a second "check anyway" button, rather than
   * silently blocking the request. The choice to proceed always belongs to
   * the person using the tool, not the software.
   */
  weatherMinRefreshIntervalMinutes: 10,

  /**
   * Attribution shown wherever fetched weather data is displayed.
   * Required by the CC BY 4.0 licence. Do not remove it if you use the relay.
   */
  weatherAttribution: {
    text: "Weather data from MET Norway",
    url: "https://api.met.no/",
    licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
  },

  /**
   * Full URL of your geocoding relay endpoint, e.g.
   *   "https://geo-relay.example.org/search"
   * Expected to accept ?q=.. and return Nominatim JSON unchanged.
   *
   * The same reasoning as the weather relay applies. The OpenStreetMap
   * Nominatim usage policy requires an identifying User-Agent with contact
   * details and caps automated use at one request per second; a browser
   * cannot set that header, and the contact address must be the operator's
   * own. Leave empty to disable address search — coordinates can always be
   * entered directly, which needs no network at all.
   */
  geocodingRelayUrl: "",

  /**
   * Full URL of your elevation relay endpoint, e.g.
   *   "https://geo-relay.example.org/elevation"
   * Expected to accept ?lat=..&lon=.. and return { elevation: <metres> }.
   *
   * The recommended backing dataset is Copernicus DEM GLO-30: European,
   * openly licensed, 30 m resolution, and self-hostable behind OpenTopoData
   * so the deployment depends on no third-party service at all.
   *
   * Elevation is not used by the Gaussian model, which assumes flat terrain.
   * It is recorded because it belongs in the incident record, and because the
   * heavy gas model, when it arrives, does depend on slope.
   */
  elevationRelayUrl: "",

  /**
   * Full URL of your terrain relay endpoint, e.g.
   *   "https://geo-relay.example.org/terrain"
   * Expected to accept ?lat=..&lon=.. and return
   *   { landuse: "residential" | "forest" | "farmland" | ... }
   * derived from an OpenStreetMap Overpass query.
   *
   * Used only to SUGGEST a ground roughness category in the Weather step. The
   * suggestion is never applied silently: the user sees it and confirms.
   * Leave empty to disable.
   */
  terrainRelayUrl: "",

  /**
   * Attribution for OpenStreetMap-derived data. Required by the ODbL when
   * geocoding or terrain lookup is enabled.
   */
  osmAttribution: {
    text: "Geocoding and terrain data © OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
  },
};
