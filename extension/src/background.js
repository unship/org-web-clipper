// org-clipper background service worker.
//
// Wiring after the v0.2 refactor (no more native messaging host):
//
//   popup (CLIP_TAB) ─┐
//   command "clip-page" ─┴─> buildCapturePayloadForTab(tabId, opts)
//          ├─ chrome.scripting.executeScript -> Defuddle on the page
//          ├─ md-to-org conversion
//          ├─ build a metadata payload {template,url,title,body,tags,...}
//          └─ dispatchCapture(payload, cfg) -> transport.js selects by
//             cfg.transport (org-protocol default; HTTP is Phase 2).

import { mdToOrg }        from "./md-to-org.js";
import { dispatchCapture } from "./transport.js";
import { collectImageUrls, fetchImages } from "./fetch-images.js";

const DEFAULTS = {
  defaultTags:     "",
  captureTemplate: "w",
  transport:       "org-protocol",
  endpoint:        "127.0.0.1:17654",   // HTTP transport endpoint (host:port)
  token:           "",                  // HTTP transport shared secret
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

function bodyFromExtract(extract, { selectionOnly } = {}) {
  if (selectionOnly && extract.selection && extract.selection.trim()) {
    return `#+BEGIN_QUOTE\n${extract.selection.trim()}\n#+END_QUOTE\n`;
  }
  return mdToOrg(extract.markdown || "");
}

// Build the capture payload for a tab. Does NOT dispatch — the transport
// layer (transport.js) selects and performs dispatch by `cfg.transport`.
async function buildCapturePayloadForTab(tabId, { tags = [], selectionOnly = false } = {}) {
  const cfg = await getConfig();
  const extract = await extractFromTab(tabId);
  const mergedTags = Array.from(new Set([
    ...cfg.defaultTags.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    ...tags,
  ]));
  const body = bodyFromExtract(extract, { selectionOnly });
  return {
    template: cfg.captureTemplate, url: extract.url, title: extract.title,
    body, tags: mergedTags, author: extract.author, published: extract.published,
    description: extract.description, created: (extract.capturedAt || "").slice(0, 10),
  };
}

// Inject + (re)run the reading-mode controller. reader.js is idempotent: each
// run toggles. defuddle + reader-doc are cheap to re-define on re-injection.
async function toggleReaderInTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/defuddle.js", "src/reader-doc.js", "src/reader.js"],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "TOGGLE_READER") {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId == null) { sendResponse({ ok: false, error: "no tab" }); return; }
    toggleReaderInTab(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async sendResponse
  }

  if (msg.type !== "CLIP_TAB") return;
  const tabId = msg.tabId ?? sender.tab?.id;   // reader-initiated clips have no tabId
  (async () => {
    const payload = await buildCapturePayloadForTab(tabId, { tags: msg.tags, selectionOnly: msg.selectionOnly });
    const cfg = await getConfig();
    if ((cfg.transport || "org-protocol") === "http") {
      payload.images = await fetchImages(collectImageUrls(payload.body));
    }
    const r = await dispatchCapture(payload, cfg);   // returns {ok, urlBytes?}
    return r;
  })()
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // async sendResponse
});

chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd === "toggle-reader") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await toggleReaderInTab(tab.id);
    return;
  }
  if (cmd !== "clip-page") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    const payload = await buildCapturePayloadForTab(tab.id, {});
    const cfg = await getConfig();
    if ((cfg.transport || "org-protocol") === "http") {
      payload.images = await fetchImages(collectImageUrls(payload.body));
    }
    await dispatchCapture(payload, cfg);
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
self.__orgClipper = { buildCapturePayloadForTab, bodyFromExtract, dispatchCapture, mdToOrg };
