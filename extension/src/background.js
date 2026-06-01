// org-clipper background service worker.
//
// Wiring after the v0.2 refactor (no more native messaging host):
//
//   popup (CLIP_TAB) ─┐
//   command "clip-page" ─┴─> clipTab(tabId, opts)
//          ├─ chrome.scripting.executeScript -> Defuddle on the page
//          ├─ md-to-org conversion
//          ├─ buildCaptureUrl -> org-protocol://capture?...
//          └─ chrome.tabs.create({active:false}) + tabs.remove after ~800ms
//             (the OS routes the URL to emacsclient before the stub tab
//              actually loads; we close it to leave no cruft behind).

import { mdToOrg }        from "./md-to-org.js";
import { buildCaptureUrl } from "./capture-url.js";

const DEFAULTS = {
  defaultTags:     "",
  captureTemplate: "w",
  // Lowest org-level the body's headings should occupy. Default 3 keeps
  // them contiguous under a capture-template headline filed at level 2
  // (`* Web clips' -> `** Page Title' -> body starts at ***).
  headingMin:      3,
  subprotocol:     "capture",
};

async function getConfig() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function extractFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files:  ["lib/defuddle.js", "src/content-extract.js"],
  });
  const last = results[results.length - 1];
  if (!last || last.result == null) {
    throw new Error("Defuddle returned no result (page may be empty or restricted)");
  }
  return last.result;
}

function bodyFromExtract(extract, { selectionOnly, headingMin }) {
  if (selectionOnly && extract.selection && extract.selection.trim()) {
    return `#+BEGIN_QUOTE\n${extract.selection.trim()}\n#+END_QUOTE\n`;
  }
  return mdToOrg(extract.markdown || "", { headingMin });
}

// Fallback dispatch for the keyboard-command path (no popup is open, so we
// cannot use the iframe trick). Opens an active tab so the user can see
// any first-time confirmation dialog Chrome decides to surface.
async function dispatchCaptureUrlFromBackground(url) {
  console.log("org-clipper: bg-dispatching", url.length, "byte URL",
              url.slice(0, 120) + (url.length > 120 ? "…" : ""));
  const tab = await chrome.tabs.create({ url, active: true });
  await new Promise((r) => setTimeout(r, 1500));
  try { await chrome.tabs.remove(tab.id); } catch {}
}

// Build the capture URL for a tab. Does NOT dispatch — for the popup path
// the popup itself dispatches via a hidden iframe (preserves user-gesture
// origin and avoids Chrome's per-initiator external-protocol prompts).
async function buildCaptureUrlForTab(tabId, { tags = [], selectionOnly = false } = {}) {
  const cfg = await getConfig();
  const extract = await extractFromTab(tabId);

  const mergedTags = Array.from(new Set([
    ...cfg.defaultTags.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    ...tags,
  ]));

  const body = bodyFromExtract(extract, {
    selectionOnly,
    headingMin: Number(cfg.headingMin) || DEFAULTS.headingMin,
  });

  const url = buildCaptureUrl(
    { url: extract.url, title: extract.title, body, tags: mergedTags },
    { template: cfg.captureTemplate, subprotocol: cfg.subprotocol },
  );

  if (url.length > 150000) {
    console.warn(`org-clipper: capture URL is ${url.length} bytes; some OS protocol handlers truncate around 256KB.`);
  }
  console.log("org-clipper: built", url.length, "byte URL",
              url.slice(0, 120) + (url.length > 120 ? "…" : ""));
  return { url, urlBytes: url.length, title: extract.title };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CLIP_TAB") return;
  buildCaptureUrlForTab(msg.tabId, { tags: msg.tags, selectionOnly: msg.selectionOnly })
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // async sendResponse
});

chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd !== "clip-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    const { url } = await buildCaptureUrlForTab(tab.id, {});
    await dispatchCaptureUrlFromBackground(url);
    await chrome.action.setBadgeBackgroundColor({ color: "#2E4A36" });
    await chrome.action.setBadgeText({ text: "OK", tabId: tab.id });
    setTimeout(
      () => chrome.action.setBadgeText({ text: "", tabId: tab.id }),
      1500,
    );
  } catch (e) {
    console.error("org-clipper:", e);
    await chrome.action.setBadgeBackgroundColor({ color: "#8A2222" });
    await chrome.action.setBadgeText({ text: "ERR", tabId: tab.id });
    setTimeout(
      () => chrome.action.setBadgeText({ text: "", tabId: tab.id }),
      3000,
    );
  }
});

// Surfaces for ad-hoc testing inside the service-worker devtools console.
self.__orgClipper = { buildCaptureUrlForTab, bodyFromExtract, buildCaptureUrl, mdToOrg };
