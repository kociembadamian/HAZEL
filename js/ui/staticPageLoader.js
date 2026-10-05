/**
 * staticPageLoader.js
 * -------------------
 * Loads the content of a standalone static page (about.html,
 * how-to-use.html) into an in-app view.
 *
 * WHY (2026-10-03): those two pages exist as ordinary HTML documents on
 * their own URLs so that search engines find real, crawlable content (see
 * the 2026-09-26 SEO review). Until now pageAbout.js and
 * pageSettings.js carried a second copy of the same text that had to be
 * kept in sync by hand — and had already drifted. The static pages are now
 * the single source: the in-app "About" and "How to use" views fetch the
 * page and show the element marked data-app-content from it.
 *
 * Offline: both pages are in sw.js's CACHE_FILES, so the fetch is answered
 * from the service-worker cache. If it still fails (first visit offline,
 * cache evicted), a short message with a link to the page is shown instead.
 */

const cache = new Map();

/**
 * @param {HTMLElement} container - the view's container
 * @param {string} url - e.g. "about.html"
 * @param {string} title - shown in the fallback message
 */
export async function renderStaticPage(container, url, title) {
  container.innerHTML = `<div class="panel"><p class="field__hint">Loading…</p></div>`;
  try {
    let html = cache.get(url);
    if (!html) {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const doc = new DOMParser().parseFromString(text, "text/html");
      const content = doc.querySelector("[data-app-content]");
      if (!content) throw new Error("no [data-app-content] element");
      html = content.innerHTML;
      cache.set(url, html);
    }
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `
      <div class="panel">
        <h1>${title}</h1>
        <div class="banner banner--info">
          <span>This page could not be loaded here (${String(error.message)}).
          It is also available on its own: <a href="${url}">${url}</a>.</span>
        </div>
      </div>`;
  }
}
