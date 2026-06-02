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
