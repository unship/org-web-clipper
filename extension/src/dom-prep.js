// org-clipper dom-prep.js
// Sanitizes a CLONED document before Defuddle extracts from it. Injected (as a
// classic content script) ahead of content-extract.js and reader.js; both call
// OrgClipperDomPrep.prepCloneForExtract(clone) right after cloning.
//
// Why: client-side diagram libraries (Mermaid, etc.) replace a <pre>/<code>'s
// text with a rendered <svg> carrying an injected <style id="mermaid-…">. Defuddle
// then serializes that <pre> as a code block whose text is the CSS plus the SVG's
// concatenated <text> labels — garbage in the clip. For each rendered diagram we
// recover the original source if the page preserved it (the common
// `data-mermaid-src` / `data-src` pattern), otherwise drop the rendered SVG.
// Finally we remove every <style> (CSS is never article content).
//
// DOM-dependent, so it is exercised by extension/test/dom-prep.fixture.html in a
// real engine (headless Chrome --dump-dom), not by the Node self-tests.

(function (root) {
  "use strict";

  function prepCloneForExtract(node) {
    if (!node || typeof node.querySelectorAll !== "function") return;

    node.querySelectorAll("pre svg, code svg").forEach(function (svg) {
      var host = svg.closest("pre, code");
      if (!host) return; // already detached by an earlier host in this pass
      var src =
        host.getAttribute("data-mermaid-src") ||
        host.getAttribute("data-src") ||
        "";
      if (src) {
        var isMermaid =
          /mermaid/i.test(host.className || "") || host.hasAttribute("data-mermaid-src");
        host.textContent = ""; // drops the rendered <svg> + injected <style>
        var code = host.ownerDocument.createElement("code");
        if (isMermaid) code.className = "language-mermaid";
        code.textContent = src;
        host.appendChild(code);
      } else {
        svg.remove();
      }
    });

    node.querySelectorAll("style").forEach(function (el) {
      el.remove();
    });
  }

  root.OrgClipperDomPrep = { prepCloneForExtract: prepCloneForExtract };
})(typeof globalThis !== "undefined" ? globalThis : this);
