/**
 * pageSettings.js
 * ---------------
 * The in-app "How to use" view (sidebar link data-view="settings"; the id
 * stays "settings" so pageRouter.js and index.html need no change).
 *
 * NOTE (2026-10-03): the text now lives only in how-to-use.html — the
 * standalone, crawlable page — and is loaded from there (see
 * staticPageLoader.js). Edit how-to-use.html to change what this view
 * shows.
 */

import { renderStaticPage } from "./staticPageLoader.js";

export const settingsPage = {
  id: "settings",
  label: "How to use",

  render(container) {
    return renderStaticPage(container, "how-to-use.html", "How to use HAZEL");
  },
};
