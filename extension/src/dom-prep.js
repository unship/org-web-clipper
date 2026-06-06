// org-clipper dom-prep.js
// Shared page-side helpers, injected (as a classic content script) ahead of
// content-extract.js and reader.js. Everything here operates on a DETACHED CLONE
// of the live document so extraction is non-destructive — the live page is never
// mutated. Exposed as `OrgClipperDomPrep`.
//
//   inlineShadowRoots(live, clone) — copy open shadow-DOM content into the clone
//       (document.cloneNode(true) does NOT clone shadow roots, so component-based
//       sites would otherwise extract as empty).
//   resolveUrls(clone, baseHref)   — rewrite relative src/href/srcset to absolute
//       (including responsive srcset), so links/images survive out of page context.
//   prepCloneForExtract(clone)     — recover diagram source, drop rendered SVGs/styles.
//   parseAsyncWithFallback(inst)   — Defuddle.parseAsync() raced against a timeout,
//       falling back to sync parse(); needed for network extractors (YouTube
//       captions etc.). See content-extract.js for the full rationale.
//
// DOM-dependent, so the clone transforms are also exercised by
// extension/test/dom-prep.fixture.html in a real engine (headless Chrome --dump-dom).

(function (root) {
  "use strict";

  // Some pages (e.g. YouTube) enforce Trusted Types (`require-trusted-types-for
  // 'script'`). Defuddle's own parsing (it assigns innerHTML to decode HTML
  // entities in schema.org data) and DOM cleanup hit those sinks and throw under
  // enforcement. Install a permissive 'default' policy in OUR realm so string
  // assignments pass. This is isolated to the content-script world and never
  // touches the page's realm; it is best-effort — if a default policy already
  // exists or creation is disallowed we simply proceed.
  let ttInstalled = false;
  function installTrustedTypesPassthrough() {
    if (ttInstalled) return;
    ttInstalled = true;
    try {
      const tt = root.trustedTypes;
      if (tt && typeof tt.createPolicy === "function" && !tt.defaultPolicy) {
        tt.createPolicy("default", {
          createHTML: function (s) { return s; },
          createScript: function (s) { return s; },
          createScriptURL: function (s) { return s; },
        });
      }
    } catch (e) { /* default policy already present or disallowed */ }
  }

  // cloneNode(true) drops shadow roots. Walk the live tree and its freshly-made
  // clone in lockstep (identical structure at clone time) and inline every OPEN
  // shadow root's content into the corresponding clone element as light DOM, so
  // Defuddle can see component-rendered article text. Closed roots are
  // unreachable (shadowRoot === null) and are skipped. MUST run on the pristine
  // clone, before any other clone mutation, so the index correspondence holds.
  //
  // BOUNDED by a node budget: component-heavy pages (YouTube/Polymer and other
  // web-component SPAs) render hundreds of thousands of nodes across nested shadow
  // roots. Inlining all of them runs synchronously on the page's MAIN THREAD and
  // then hands a giant clone to Defuddle — freezing the tab. We inline at most
  // SHADOW_INLINE_BUDGET elements and then stop; that is plenty for an article
  // living inside a few components, and for true SPAs Defuddle's normal/site
  // extraction (e.g. YouTube reads ytInitialPlayerResponse from a <script>, not
  // the rendered DOM) does the real work anyway.
  const SHADOW_INLINE_BUDGET = 15000;

  function inlineShadowRoots(live, clone) {
    inlineShadowRootsBounded(live, clone, { remaining: SHADOW_INLINE_BUDGET });
  }

  function inlineShadowRootsBounded(liveEl, cloneEl, budget) {
    if (!liveEl || !cloneEl || budget.remaining <= 0) return;
    // 1) Recurse the light DOM FIRST, while indices still align (we are about to
    //    prepend shadow children to cloneEl, which would shift its indices).
    const liveKids = liveEl.children ? Array.prototype.slice.call(liveEl.children) : [];
    const cloneKids = cloneEl.children ? Array.prototype.slice.call(cloneEl.children) : [];
    const n = Math.min(liveKids.length, cloneKids.length);
    for (let i = 0; i < n && budget.remaining > 0; i++) {
      inlineShadowRootsBounded(liveKids[i], cloneKids[i], budget);
    }
    // 2) This element's OWN open shadow root.
    const shadow = liveEl.shadowRoot;
    if (shadow && shadow.children && shadow.children.length && budget.remaining > 0) {
      const doc = cloneEl.ownerDocument;
      const frag = doc.createDocumentFragment();
      const shadowKids = Array.prototype.slice.call(shadow.children);
      for (let j = 0; j < shadowKids.length && budget.remaining > 0; j++) {
        const sc = shadowKids[j];
        let copy;
        try { copy = doc.importNode(sc, true); }
        catch (e) { copy = sc.cloneNode(true); }
        // Charge the budget by the imported subtree size before recursing deeper.
        const subtree = sc.getElementsByTagName ? sc.getElementsByTagName("*").length : 0;
        budget.remaining -= 1 + subtree;
        inlineShadowRootsBounded(sc, copy, budget); // sc's own shadow + descendants' shadows
        frag.appendChild(copy);
      }
      // Shadow content renders before slotted light children — prepend it.
      cloneEl.insertBefore(frag, cloneEl.firstChild);
    }
  }

  // Rewrite relative URLs to absolute against baseHref. Mirrors Obsidian Clipper:
  // src/href plus responsive srcset (comma-separated "url descriptor" entries).
  // Leaves already-absolute, data:, blob:, in-page (#…) and scheme (mailto:/tel:/
  // javascript:) URLs untouched. Protocol-relative //host/… is resolved to the
  // page's scheme via the URL constructor.
  function resolveUrls(node, baseHref) {
    if (!node || typeof node.querySelectorAll !== "function") return;
    const abs = function (u) {
      try { return new URL(u, baseHref).href; } catch (e) { return u; }
    };
    const skip = function (u) {
      return !u || /^\s*(?:[a-z][a-z0-9+.-]*:(?!\/\/)|https?:|data:|blob:|#)/i.test(u);
    };
    // Never rewrite <script>/<link>/<base> URLs: they aren't content, and on a
    // Trusted-Types page (e.g. YouTube, which sets require-trusted-types-for
    // 'script') assigning a string to <script src> THROWS. Also wrap setAttribute
    // so any other unexpected sink can never abort the clip — URL resolution is a
    // best-effort nicety on top of what Defuddle already does.
    const setSafely = function (el, attr, value) {
      const tag = el.tagName;
      if (tag === "SCRIPT" || tag === "LINK" || tag === "BASE") return;
      try { el.setAttribute(attr, value); } catch (e) { /* trusted-types / readonly */ }
    };
    const fixAttr = function (sel, attr) {
      node.querySelectorAll(sel).forEach(function (el) {
        const v = el.getAttribute(attr);
        if (v && !skip(v)) setSafely(el, attr, abs(v.trim()));
      });
    };
    fixAttr("[src]", "src");
    fixAttr("[href]", "href");
    node.querySelectorAll("[srcset]").forEach(function (el) {
      const v = el.getAttribute("srcset");
      if (!v) return;
      const out = v.split(",").map(function (part) {
        const seg = part.trim();
        if (!seg) return "";
        const sp = seg.split(/\s+/);
        const url = sp[0];
        const desc = sp.slice(1).join(" ");
        const resolved = skip(url) ? url : abs(url);
        return desc ? resolved + " " + desc : resolved;
      }).filter(Boolean).join(", ");
      setSafely(el, "srcset", out);
    });
  }

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

  // Defuddle.parseAsync() honours site extractors that fetch over the network
  // (most importantly YouTube captions). Race it against a timeout and fall back
  // to the sync parse() if async extraction hangs or fails. Mirrors Obsidian
  // Clipper (src/content.ts). Runs in the ISOLATED world, where Chrome awaits a
  // Promise returned as the InjectionResult.result.
  function parseAsyncWithFallback(instance, timeoutMs) {
    var ms = timeoutMs || 8000;
    if (typeof instance.parseAsync !== "function") {
      return Promise.resolve(instance.parse());
    }
    var timeout = new Promise(function (_resolve, reject) {
      setTimeout(function () {
        reject(new Error("org-clipper: parseAsync timeout"));
      }, ms);
    });
    return Promise.race([instance.parseAsync(), timeout]).catch(function () {
      return instance.parse();
    });
  }

  root.OrgClipperDomPrep = {
    installTrustedTypesPassthrough: installTrustedTypesPassthrough,
    inlineShadowRoots: inlineShadowRoots,
    resolveUrls: resolveUrls,
    prepCloneForExtract: prepCloneForExtract,
    parseAsyncWithFallback: parseAsyncWithFallback,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
