/**
 * consentGate.js
 * --------------
 * A one-time (per browser, unless the person opts out of seeing it again)
 * acknowledgement shown before HAZEL is usable: the person confirms they
 * are professionally involved in dangerous goods transport and will use the
 * tool as intended.
 *
 * Why this exists: HAZEL models how a hazardous substance disperses after
 * an accidental release. Out of context, a tool that does that can look
 * like something built to plan causing harm rather than to plan defending
 * against it. This gate says plainly, before anything else is shown, what
 * HAZEL actually is and who it is for — it is a light-touch, honesty-based
 * checkpoint, not an access control (nothing here is technically enforced;
 * anyone can decline and then still open the browser's dev tools, which is
 * not what this is trying to prevent). Its purpose is to make the tool's
 * intended, professional use context unmistakable to a first-time visitor,
 * including a search engine crawler or a casual link-clicker who has not
 * read the About page's own disclaimer yet.
 *
 * Storage: a plain localStorage flag, not scenarioStorage.js's IndexedDB —
 * this is a per-browser UI flag ("has this browser already seen and
 * dismissed the gate"), not scenario data, and does not belong in the same
 * store as saved scenarios or the custom chemical library.
 */

const STORAGE_KEY = "hazel-consent-acknowledged";

function alreadyAcknowledged() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Private browsing, or storage disabled entirely: fail OPEN rather than
    // trap someone behind a gate that can never be permanently dismissed —
    // worst case the gate simply reappears next visit, which is a minor
    // repeat click, not a blocker.
    return false;
  }
}

function rememberAcknowledgement() {
  try {
    localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // Ignore — see alreadyAcknowledged() above. The person can still use
    // HAZEL this visit; they will just see the gate again next time.
  }
}

/**
 * Shows the gate as a full-page overlay if it has not already been
 * dismissed (and "don't ask again" was not checked last time). Call once,
 * before the rest of the app becomes interactive.
 */
export function initConsentGate() {
  if (alreadyAcknowledged()) return;

  const overlay = document.createElement("div");
  overlay.className = "consent-gate";
  overlay.innerHTML = `
    <div class="consent-gate__panel" role="dialog" aria-modal="true" aria-labelledby="consent-gate-title">
      <img src="assets/hazel_logo.png" alt="" aria-hidden="true" class="consent-gate__logo" />
      <h1 id="consent-gate-title">Before you continue</h1>
      <p>
        HAZEL models how a hazardous substance disperses after an accidental
        release, for dangerous-goods safety training, planning, and incident
        preparedness. It is built for people professionally involved in that
        work.
      </p>
      <label class="consent-gate__check">
        <input type="checkbox" id="consent-gate-agree" />
        <span>
          I am professionally involved in dangerous goods transport and
          declare that I will use this software as intended.
        </span>
      </label>
      <label class="consent-gate__check consent-gate__check--muted">
        <input type="checkbox" id="consent-gate-remember" />
        <span>Don't ask again on this device</span>
      </label>
      <button type="button" class="btn btn--primary" id="consent-gate-continue" disabled>
        Continue
      </button>
    </div>`;

  document.body.appendChild(overlay);
  // Prevent the page underneath from scrolling while the gate is open —
  // it is otherwise a normal document-flow element behind a full-page
  // overlay, not a separately scrollable region.
  document.body.style.overflow = "hidden";

  const agreeBox = overlay.querySelector("#consent-gate-agree");
  const rememberBox = overlay.querySelector("#consent-gate-remember");
  const continueBtn = overlay.querySelector("#consent-gate-continue");

  agreeBox.addEventListener("change", () => {
    continueBtn.disabled = !agreeBox.checked;
  });

  continueBtn.addEventListener("click", () => {
    if (!agreeBox.checked) return; // guarded by disabled above; belt and braces
    if (rememberBox.checked) rememberAcknowledgement();
    overlay.remove();
    document.body.style.overflow = "";
  });
}
