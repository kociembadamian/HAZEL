/**
 * pageAbout.js
 * ------------
 * The in-app "About" view.
 *
 * NOTE (2026-10-03): the text now lives only in about.html — the
 * standalone, crawlable page — and is loaded from there (see
 * staticPageLoader.js). Edit about.html to change what this view shows.
 * The two copies had drifted apart while each was maintained by hand.
 */

import { renderStaticPage } from "./staticPageLoader.js";

export const aboutPage = {
  id: "about",
  label: "About",

  render(container) {
    return renderStaticPage(container, "about.html", "About HAZEL");
  },
};
