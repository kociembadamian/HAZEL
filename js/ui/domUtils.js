/**
 * domUtils.js
 * -----------
 * Tiny shared helpers for DOM wiring patterns used across several step and
 * page modules.
 *
 * Several containers in HAZEL are long-lived across many renders: the
 * wizard's step-content element is reused by every step in turn every time
 * the user navigates, and each standalone page's container is reused every
 * time its sidebar link is clicked. A DELEGATED listener — one that reads
 * `event.target.closest(selector)` inside a handler attached to the
 * container itself, rather than to a specific element — does not need to be
 * re-attached after the container's innerHTML is replaced: it keeps working
 * against whatever children exist at the moment an event actually fires,
 * because the container node itself never changes.
 *
 * Calling addEventListener again on every render() therefore does not
 * refresh anything — it just adds another copy of the same listener
 * alongside the ones from every previous visit to that step or page.
 *
 * The key matters as much as the container
 * --------------------------------------------
 * The wizard's step-content element is shared by every step, not just
 * revisits of the same one — Location, Chemical, Weather, Source and
 * Results all render into the identical node in turn. Guarding purely by
 * event type (e.g. "click") would mean whichever step wires its click
 * handler FIRST claims that guard for the container's whole lifetime, and
 * every other step's click handler silently never attaches — exactly the
 * failure this function must not have: Location's listener would work,
 * and every step after it would look like clicking had stopped doing
 * anything.
 *
 * The key is therefore a caller-chosen string identifying THIS listener
 * specifically (a natural choice is "<module>-<eventType>", e.g.
 * "chemical-click"), kept separate from the actual DOM event type it
 * subscribes to. Two different keys on the same container and event type
 * both get attached; the same key attached twice does not stack.
 *
 * @param {HTMLElement} container
 * @param {string} key - a name unique to this listener, e.g. "chemical-click"
 * @param {string} eventType - the real DOM event to subscribe to, e.g. "click"
 * @param {(event: Event) => void} handler
 */
export function wireOnce(container, key, eventType, handler) {
  // dataset property names follow a real, enforced restriction (WHATWG
  // HTML spec, DOMStringMap): a name containing a hyphen immediately
  // followed by a lowercase ASCII letter throws a SyntaxError when set,
  // because that shape is reserved for the automatic camelCase<->kebab-case
  // conversion between dataset.someKey and the data-some-key attribute.
  // Every key used in this codebase (e.g. "chemical-click") is exactly that
  // shape, so building the flag as "wired_" + key would throw the moment it
  // ran — not a hypothetical edge case but the literal keys this function
  // is actually called with. Replacing hyphens before use sidesteps the
  // restriction entirely, for any key a future caller might pass.
  const safeKey = key.replace(/-/g, "_");
  const flag = `wired_${safeKey}`;
  if (container.dataset[flag]) return;
  container.dataset[flag] = "true";
  container.addEventListener(eventType, handler);
}

/**
 * Markup for a small inline loading indicator (2026-09-25), used by
 * wizard.js and pageRouter.js while a step or page's render() is in
 * flight — mainly the Chemical step's first load of the chemical database
 * and the Results step's map/tile setup, which can take a perceptible
 * moment. It is written into the container immediately before a render()
 * call; any step/page whose own render() finishes synchronously simply
 * overwrites it before the browser ever paints it, so it costs nothing
 * there and only becomes visible for the renders that actually take time.
 *
 * A pure CSS spinner (border-based, no image/font dependency) so it works
 * fully offline like everything else in HAZEL, coloured with the ADR amber
 * accent to match the rest of the app's "this needs your attention /
 * this is in progress" language.
 */
export function loadingSpinnerHtml(label = "Loading…") {
  return `
    <div class="loading-indicator" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span>${label}</span>
    </div>`;
}
