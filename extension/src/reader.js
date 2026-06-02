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
