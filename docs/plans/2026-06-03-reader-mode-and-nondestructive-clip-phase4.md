# Reader Mode + Non-destructive Clip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop clipping from mutating the live page, and add a non-destructive reading-mode overlay (popup button + `Alt+R`) with a Clip-from-reader control.

**Architecture:** Clip extraction runs Defuddle on a detached `document.cloneNode(true)` so the page is never touched. Reading mode is a content script that renders Defuddle's cleaned HTML inside a full-viewport same-origin `iframe` layered over the intact page; exit removes the iframe (no reload). A small pure module (`reader-doc.js`) builds the iframe's static shell and is unit-tested in Node.

**Tech Stack:** Chrome MV3 (service worker + `chrome.scripting`), vendored Defuddle 0.18.1, plain ES/classic JS, Node `assertEq` self-tests, Emacs ERT (regression guard).

**Spec:** `docs/design/2026-06-03-reader-mode-and-nondestructive-clip-design.md`

**Testing reality:** The repo has no jsdom/browser harness. Only DOM-free logic is unit-testable (Node) — that is `reader-doc.js`. Content-script DOM glue (`content-extract.js`, `reader.js`) is verified manually in-browser (Task 7). The Emacs ERT suite must stay green (the Org output is unchanged).

---

## File structure

| File | Responsibility |
| --- | --- |
| `extension/src/reader-doc.js` | **new** — pure builder of the reader iframe's static shell HTML; classic-script global + Node self-test |
| `extension/src/reader.js` | **new** — reading-mode controller (extract on a clone, build/teardown iframe, wire Clip/Exit, idempotent toggle) |
| `extension/src/content-extract.js` | clip extraction runs on a clone (the bug fix) |
| `extension/src/background.js` | `toggleReaderInTab`, `TOGGLE_READER` message, `toggle-reader` command, `CLIP_TAB` accepts `sender.tab.id` |
| `extension/src/popup.html` | "Reading mode" button |
| `extension/src/popup.js` | button → `TOGGLE_READER` → close |
| `extension/manifest.json` | `toggle-reader` command |

---

## Task 1: `reader-doc.js` — pure shell builder (TDD)

The only Node-unit-testable unit. Classic-script-safe (no `import`/`export`) so it can be injected as a content script *and* run under Node. Assigns a global; runs self-tests only when executed as the main module under Node.

**Files:**
- Create: `extension/src/reader-doc.js`

- [ ] **Step 1: Write the file with the builder + Node self-test (test lives in the file, runs first to fail)**

```js
// org-clipper reader-doc.js
// Pure builder for the reading-mode iframe's STATIC shell (no <script>, empty
// <article>). The article HTML is injected later via innerHTML by reader.js, so
// nothing here executes page or content scripts. Classic-script safe: assigns a
// global (consumed by reader.js as a content script) and self-tests under Node.

(function (root) {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
    });
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/[&"<]/g, function (c) {
      return { "&": "&amp;", '"': "&quot;", "<": "&lt;" }[c];
    });
  }

  // { baseUrl, css, lang, title } -> full HTML document string for iframe.srcdoc
  function buildReaderShellHtml(opts) {
    opts = opts || {};
    var lang = String(opts.lang || "en").replace(/[^a-zA-Z-]/g, "") || "en";
    var base = escapeAttr(opts.baseUrl || "");
    var title = escapeHtml(opts.title || "");
    var css = String(opts.css || "");
    return (
      "<!doctype html>\n" +
      '<html lang="' + lang + '">\n' +
      "<head>\n" +
      '<meta charset="utf-8">\n' +
      '<base href="' + base + '" target="_top">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      "<title>" + title + "</title>\n" +
      "<style>" + css + "</style>\n" +
      "</head>\n" +
      "<body>\n" +
      '<div class="oc-reader-bar">\n' +
      '<button type="button" data-oc="clip">Clip</button>\n' +
      '<button type="button" data-oc="exit">Exit</button>\n' +
      "</div>\n" +
      '<div class="oc-reader-toast" role="status" style="display:none"></div>\n' +
      '<article class="oc-reader-article"></article>\n' +
      "</body>\n" +
      "</html>"
    );
  }

  root.OrgClipperReaderDoc = { buildReaderShellHtml: buildReaderShellHtml };
})(typeof globalThis !== "undefined" ? globalThis : this);

// --- Node self-test (skipped in the browser: `process` is undefined there) ---
if (typeof process !== "undefined" && process.argv && /reader-doc\.js$/.test(process.argv[1] || "")) {
  const { buildReaderShellHtml } = globalThis.OrgClipperReaderDoc;
  let failed = 0;
  const has = (s, sub, msg) => {
    if (!s.includes(sub)) { console.error("FAIL:", msg, "\n  missing:", sub); failed++; }
  };
  const hasNot = (s, sub, msg) => {
    if (s.includes(sub)) { console.error("FAIL:", msg, "\n  unexpected:", sub); failed++; }
  };

  const out = buildReaderShellHtml({
    baseUrl: "https://x/p?a=1&b=2", css: "body{color:red}", lang: "en", title: "Hi <b> & co",
  });
  has(out, '<base href="https://x/p?a=1&amp;b=2" target="_top">', "base href escaped + _top");
  has(out, 'data-oc="clip"', "clip button");
  has(out, 'data-oc="exit"', "exit button");
  has(out, 'class="oc-reader-article">', "empty article container");
  has(out, 'class="oc-reader-toast"', "toast container");
  has(out, "body{color:red}", "css inlined");
  has(out, "<title>Hi &lt;b&gt; &amp; co</title>", "title escaped");
  hasNot(out, "<script", "shell must contain no <script>");

  if (failed) { console.error("\nreader-doc: " + failed + " assertion(s) failed"); process.exit(1); }
  console.log("all reader-doc tests passed");
}
```

- [ ] **Step 2: Run it to verify the tests RUN and PASS**

Run: `node extension/src/reader-doc.js`
Expected: `all reader-doc tests passed` (exit 0).

> Note: this file is written test-first in the sense that the assertions encode the contract before any consumer exists. If you prefer a strict red phase, temporarily break one branch (e.g. change `target="_top"` to `target="x"`), run, watch it FAIL with the `base href` assertion, then restore.

- [ ] **Step 3: Verify the red phase once**

Edit `target="_top"` → `target="_blank"`, run `node extension/src/reader-doc.js`.
Expected: `FAIL: base href escaped + _top` and exit 1. Then restore `_top` and re-run → passes.

- [ ] **Step 4: Commit**

```bash
git add extension/src/reader-doc.js
git commit -m "feat(ext): reader-doc.js — pure builder for the reader iframe shell"
```

---

## Task 2: Non-destructive clip — extract on a clone (`content-extract.js`)

**Files:**
- Modify: `extension/src/content-extract.js:38-49`

- [ ] **Step 1: Replace the live-document parse with a clone parse**

Find (around lines 38-49):

```js
  let r;
  try {
    const instance = new Defuddle(document, {
      markdown: true,
      url: location.href,
      standardize: true,
      removeImages: false,
    });
    r = instance.parse();
  } finally {
    console.error = ORIG_ERROR;
  }
```

Replace with:

```js
  let r;
  try {
    // Parse a DETACHED CLONE so extraction can never mutate the live page.
    // (Defuddle reads the live doc for shadow-roots/media-queries; cloning makes
    // even those reads operate on a throwaway copy.) Strip our own reading-mode
    // overlay from the clone so it is never treated as content.
    const clone = document.cloneNode(true);
    clone.getElementById("org-clipper-reader")?.remove();
    Object.defineProperty(clone, "URL", { value: location.href, configurable: true });
    const instance = new Defuddle(clone, {
      markdown: true,
      url: location.href,
      standardize: true,
      removeImages: false,
    });
    r = instance.parse();
  } finally {
    console.error = ORIG_ERROR;
  }
```

- [ ] **Step 2: Sanity-check syntax**

Run: `node --check extension/src/content-extract.js`
Expected: no output (exit 0). (It won't *run* — `document` is undefined in Node — but `--check` validates syntax.)

- [ ] **Step 3: Commit**

```bash
git add extension/src/content-extract.js
git commit -m "fix(ext): clip on a document clone so the live page is never mutated"
```

> Behavioral verification (page unchanged after clip) happens in Task 7 — there is no Node DOM harness.

---

## Task 3: `reader.js` — reading-mode overlay controller

**Files:**
- Create: `extension/src/reader.js`

- [ ] **Step 1: Write the controller**

```js
// org-clipper reading-mode controller (content script).
// Injected AFTER lib/defuddle.js and src/reader-doc.js by background.toggleReaderInTab.
// Non-destructive: renders Defuddle's cleaned HTML in a full-viewport same-origin
// iframe layered over the INTACT page. Exit removes the iframe (no reload).
// Idempotent: a re-injection just toggles the existing controller.

(() => {
  const READER_ID = "org-clipper-reader";

  if (globalThis.__orgClipperReader) {
    globalThis.__orgClipperReader.toggle();
    return;
  }

  const READER_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: #fdfdf7; color: #1d1f24;
  font: 18px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Georgia, serif;
}
a { color: #2e4a36; }
@media (prefers-color-scheme: dark) {
  body { background: #1b1d18; color: #e9e6da; }
  a { color: #b6d6b9; }
  .oc-reader-bar { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.10); }
  .oc-reader-article pre, .oc-reader-article code { background: rgba(255,255,255,0.08); }
}
.oc-reader-bar {
  position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; justify-content: flex-end;
  padding: 10px 16px; background: rgba(0,0,0,0.03);
  border-bottom: 1px solid rgba(0,0,0,0.08); backdrop-filter: blur(6px);
}
.oc-reader-bar button {
  font: 600 13px/1 system-ui, sans-serif; padding: 8px 14px; cursor: pointer;
  border-radius: 6px; border: 1px solid #2e4a36; background: #2e4a36; color: #f5f1e8;
}
.oc-reader-bar button[data-oc="exit"] {
  background: transparent; color: inherit; border-color: currentColor; opacity: 0.75;
}
.oc-reader-toast {
  max-width: 70ch; margin: 10px auto 0; padding: 8px 12px; border-radius: 6px;
  background: #e9f3ec; color: #1f5732; font: 13px/1.4 system-ui, sans-serif;
}
.oc-reader-article { max-width: 70ch; margin: 0 auto; padding: 28px 20px 120px; }
.oc-reader-article img, .oc-reader-article video { max-width: 100%; height: auto; }
.oc-reader-article pre { overflow: auto; padding: 12px; background: rgba(0,0,0,0.06); border-radius: 6px; }
.oc-reader-article h1 { font-size: 1.8em; line-height: 1.25; }
`;

  let savedOverflow = null;

  function extractArticle() {
    const clone = document.cloneNode(true);
    clone.getElementById(READER_ID)?.remove();
    Object.defineProperty(clone, "URL", { value: location.href, configurable: true });
    const r = new self.Defuddle(clone, {
      url: location.href, standardize: true, removeImages: false,
    }).parse();
    return { html: r.content || "", title: r.title || document.title || "" };
  }

  function onTopKey(e) {
    if (e.key === "Escape") close();
  }

  function setToast(doc, text) {
    const t = doc.querySelector(".oc-reader-toast");
    if (!t) return;
    t.textContent = text;
    t.style.display = "block";
  }

  function clip(doc) {
    setToast(doc, "Clipping…");
    chrome.runtime.sendMessage({ type: "CLIP_TAB", tags: [], selectionOnly: false }, (resp) => {
      if (chrome.runtime.lastError) {
        setToast(doc, "Error: " + chrome.runtime.lastError.message);
      } else if (resp && resp.ok) {
        setToast(doc, `Sent to Emacs (${resp.urlBytes ?? ""} bytes).`);
      } else {
        setToast(doc, "Error: " + ((resp && resp.error) || "unknown"));
      }
    });
  }

  function open() {
    if (document.getElementById(READER_ID)) return;
    let article;
    try {
      article = extractArticle();
    } catch (e) {
      console.error("org-clipper reader:", e);
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.id = READER_ID;
    iframe.setAttribute(
      "style",
      "position:fixed;inset:0;width:100vw;height:100vh;border:0;margin:0;z-index:2147483647;background:#fdfdf7;"
    );
    iframe.srcdoc = OrgClipperReaderDoc.buildReaderShellHtml({
      baseUrl: location.href,
      css: READER_CSS,
      lang: document.documentElement.lang || "en",
      title: article.title,
    });
    iframe.addEventListener(
      "load",
      () => {
        const doc = iframe.contentDocument;
        if (!doc) return;
        doc.querySelector(".oc-reader-article").innerHTML = article.html; // innerHTML: no script exec
        doc.querySelector('[data-oc="exit"]').addEventListener("click", close);
        doc.querySelector('[data-oc="clip"]').addEventListener("click", () => clip(doc));
        doc.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
      },
      { once: true }
    );
    document.documentElement.appendChild(iframe);
    savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("keydown", onTopKey, true);
  }

  function close() {
    const iframe = document.getElementById(READER_ID);
    if (iframe) iframe.remove();
    document.documentElement.style.overflow = savedOverflow || "";
    window.removeEventListener("keydown", onTopKey, true);
  }

  function toggle() {
    if (document.getElementById(READER_ID)) close();
    else open();
  }

  globalThis.__orgClipperReader = { toggle, open, close };

  // First injection performs the first toggle (opens). Subsequent injections hit
  // the guard at the top and toggle there — so every executeScript = one toggle.
  toggle();
})();
```

- [ ] **Step 2: Sanity-check syntax**

Run: `node --check extension/src/reader.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add extension/src/reader.js
git commit -m "feat(ext): reader.js — non-destructive reading-mode iframe overlay"
```

---

## Task 4: `background.js` — wiring (toggle, message, command, sender tab)

**Files:**
- Modify: `extension/src/background.js:65-79` (message listener) and `:81-107` (command listener); add `toggleReaderInTab`.

- [ ] **Step 1: Add `toggleReaderInTab` above the message listener (after line 63)**

Insert after the `buildCapturePayloadForTab` function (just before `chrome.runtime.onMessage.addListener`):

```js
// Inject + (re)run the reading-mode controller. reader.js is idempotent: each
// run toggles. defuddle + reader-doc are cheap to re-define on re-injection.
async function toggleReaderInTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/defuddle.js", "src/reader-doc.js", "src/reader.js"],
  });
}
```

- [ ] **Step 2: Replace the message listener (lines 65-79) to handle TOGGLE_READER and use the sender's tab**

Replace:

```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CLIP_TAB") return;
  (async () => {
    const payload = await buildCapturePayloadForTab(msg.tabId, { tags: msg.tags, selectionOnly: msg.selectionOnly });
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
```

With:

```js
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
```

- [ ] **Step 3: Add a `toggle-reader` branch to the command listener (top of the listener at line 81)**

Replace the opening of the command listener:

```js
chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd !== "clip-page") return;
```

With:

```js
chrome.commands?.onCommand.addListener(async (cmd) => {
  if (cmd === "toggle-reader") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await toggleReaderInTab(tab.id);
    return;
  }
  if (cmd !== "clip-page") return;
```

- [ ] **Step 4: Sanity-check syntax**

Run: `node --check extension/src/background.js`
Expected: no output (exit 0).

> `node --check` may error on the ESM `import` lines only if run without module context; if so, run `node --input-type=module --check < extension/src/background.js`. Either way, fix any reported syntax error.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background.js
git commit -m "feat(ext): background wiring for reading mode (toggle, command, sender tab)"
```

---

## Task 5: Popup — "Reading mode" button

**Files:**
- Modify: `extension/src/popup.html:153-156` (actions)
- Modify: `extension/src/popup.js`

- [ ] **Step 1: Add the button to `popup.html`**

Replace:

```html
    <div class="actions">
      <button id="clip-btn" type="button">Clip page</button>
      <button id="cancel-btn" type="button" class="ghost">Close</button>
    </div>
```

With:

```html
    <div class="actions">
      <button id="reader-btn" type="button">Reading mode</button>
      <button id="clip-btn" type="button">Clip page</button>
    </div>
    <div class="actions">
      <button id="cancel-btn" type="button" class="ghost" style="flex:1">Close</button>
    </div>
```

- [ ] **Step 2: Wire the button in `popup.js`**

In the `els` object (after the `clip:` line, around line 13), add:

```js
  reader: $("reader-btn"),
```

Add this function after `clip()` (before the `els.clip.addEventListener` lines near the bottom):

```js
async function toggleReader() {
  const tabId = Number(els.clip.dataset.tabId);
  if (!Number.isFinite(tabId)) {
    setStatus("err", "Lost reference to the active tab.");
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: "TOGGLE_READER", tabId });
    window.close();
  } catch (e) {
    setStatus("err", String(e && e.message ? e.message : e));
  }
}
```

Add the listener next to the other `addEventListener` calls (after `els.clip.addEventListener("click", clip);`):

```js
els.reader.addEventListener("click", toggleReader);
```

- [ ] **Step 3: Sanity-check syntax**

Run: `node --check extension/src/popup.js`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add extension/src/popup.html extension/src/popup.js
git commit -m "feat(ext): popup 'Reading mode' button"
```

---

## Task 6: Manifest — `toggle-reader` command

**Files:**
- Modify: `extension/manifest.json:44-51`

- [ ] **Step 1: Add the command**

Replace:

```json
  "commands": {
    "_execute_action": {
      "description": "Open the org-clipper popup"
    },
    "clip-page": {
      "description": "Clip the current page to Org without opening the popup"
    }
  }
```

With:

```json
  "commands": {
    "_execute_action": {
      "description": "Open the org-clipper popup"
    },
    "clip-page": {
      "description": "Clip the current page to Org without opening the popup"
    },
    "toggle-reader": {
      "suggested_key": { "default": "Alt+R" },
      "description": "Toggle reading mode"
    }
  }
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest OK')"`
Expected: `manifest OK`.

- [ ] **Step 3: Commit**

```bash
git add extension/manifest.json
git commit -m "feat(ext): add toggle-reader command (Alt+R)"
```

---

## Task 7: Verification — automated guards + manual browser pass

**Files:** none (verification only).

- [ ] **Step 1: Re-run the Node unit test**

Run: `node extension/src/reader-doc.js`
Expected: `all reader-doc tests passed`.

- [ ] **Step 2: Confirm Emacs ERT is still green (Org output unchanged)**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit 2>&1 | tail -2`
Expected: `Ran 31 tests, 31 results as expected, 0 unexpected`.

- [ ] **Step 3: Syntax-check all touched JS**

Run: `for f in content-extract reader reader-doc popup background; do node --check extension/src/$f.js && echo "$f ok"; done`
Expected: `... ok` for each (background may need `--input-type=module`; see Task 4 Step 4).

- [ ] **Step 4: Load unpacked + manual smoke test**

Load `extension/` at `chrome://extensions` (Developer mode → Load unpacked), then on a normal article page (e.g. a news/blog article):

1. **Clip is non-destructive:** click the toolbar icon → **Clip page**. The visible page must NOT change (no reflow, no stripped content). Confirm the clip reached Emacs (status shows "Sent to Emacs").
2. **Reader opens:** click **Reading mode** in the popup → a clean article overlay covers the page; the underlying page is intact (visible briefly at the edges if the overlay had transparency — it shouldn't).
3. **Reader exits cleanly:** click **Exit** (and separately test `Esc`) → overlay vanishes instantly, no page reload, scroll position preserved.
4. **Keyboard toggle:** press `Alt+R` → reader opens; `Alt+R` again → closes. (If `Alt+R` is taken, rebind at `chrome://extensions/shortcuts`.)
5. **Clip from reader:** open reader → click **Clip** → toast shows "Sent to Emacs (… bytes)"; confirm the Org entry matches a normal Clip page of the same article.
6. **Overlay not self-clipped:** while reader is open, open the popup and click **Clip page** → the clip contains the article, not the reader iframe.

- [ ] **Step 5: Mark the plan done / note any deviations**

If any manual step fails, switch to `superpowers:systematic-debugging`. If the iframe is blocked by a site CSP (`frame-src`), implement the shadow-DOM fallback from spec §5 (host `<div>` + `attachShadow({mode:"closed"})`, same `buildReaderShellHtml` content rendered into the shadow root, identical button wiring) — that is the only anticipated structural deviation.

- [ ] **Step 6: Final commit (docs/status only, if anything changed)**

```bash
git add -A
git commit -m "chore(ext): reader mode + non-destructive clip verified" || echo "nothing to commit"
```

---

## Self-review

- **Spec coverage:** §4 clone fix → Task 2; §5 reader overlay/enter/exit/clip → Tasks 1+3; §6 triggers/messaging → Tasks 4+5; §7 manifest → Task 6; §9 testing → Tasks 1 & 7. All spec sections map to a task. ✓
- **Placeholders:** none — every code step shows complete code; commands have expected output. ✓
- **Type/name consistency:** `org-clipper-reader` (iframe id), `OrgClipperReaderDoc.buildReaderShellHtml`, `__orgClipperReader`, `TOGGLE_READER`/`toggleReader`/`toggleReaderInTab`, `data-oc="clip"`/`"exit"`, `.oc-reader-article`/`.oc-reader-toast`/`.oc-reader-bar` are used identically across Tasks 1, 3, 4, 5. `CLIP_TAB` response shape `{ok, urlBytes}` matches existing popup usage. ✓
- **Idempotency/protocol:** "each executeScript = one toggle" — `toggleReaderInTab` only injects (no follow-up message), and reader.js toggles on every run (guard-toggle or first-run toggle). No double-toggle. ✓
