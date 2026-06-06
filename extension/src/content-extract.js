// org-clipper page-side extractor.
//
// Injected by background.js via chrome.scripting.executeScript({
//   target: { tabId },
//   files: ["lib/defuddle.js", "src/content-extract.js"]
// })
//
// The UMD bundle (lib/defuddle.js) attaches the constructor to `self.Defuddle`.
// This file's trailing expression becomes the InjectionResult.result, with the
// promise (if any) awaited by Chrome when world is ISOLATED.

(async () => {
  const Defuddle = self.Defuddle;
  if (typeof Defuddle !== "function") {
    throw new Error("org-clipper: Defuddle constructor not found on page context");
  }

  // Filter known-benign defuddle log noise during parse(). Defuddle catches
  // some recoverable failures (malformed JSON-LD blobs the page author
  // embedded, mostly) but reports them via `console.error', which Chrome's
  // extension-error UI then surfaces as a real "Error" for the user. We
  // demote those specific messages to `console.debug' so chrome://extensions
  // stays clean while still leaving a trace if you need to investigate.
  const ORIG_ERROR = console.error;
  const SUPPRESS_PREFIXES = [
    "Defuddle: Error parsing schema.org data",
    "Defuddle: Problematic JSON content",
  ];
  console.error = function patchedError(...args) {
    const head = typeof args[0] === "string" ? args[0] : "";
    if (SUPPRESS_PREFIXES.some((p) => head.startsWith(p))) {
      console.debug("[org-clipper] suppressed defuddle warning:", ...args);
      return;
    }
    return ORIG_ERROR.apply(console, args);
  };

  const DomPrep = self.OrgClipperDomPrep;
  // On Trusted-Types pages (e.g. YouTube) Defuddle's own innerHTML use throws
  // without this — install a permissive policy in our world before parsing.
  DomPrep?.installTrustedTypesPassthrough();
  let r;
  try {
    // Parse a DETACHED CLONE so extraction can never mutate the live page.
    // (Defuddle reads the live doc for shadow-roots/media-queries; cloning makes
    // even those reads operate on a throwaway copy.)
    const clone = document.cloneNode(true);
    // Best-effort clone enrichment — these touch arbitrary page DOM and can hit
    // engine restrictions (e.g. Trusted Types on YouTube), so each is wrapped:
    // a failure must never break the clip, only skip the nicety.
    // cloneNode drops shadow roots — copy open shadow-DOM content into the clone
    // first, while it is still structurally identical to the live tree.
    try { DomPrep?.inlineShadowRoots(document, clone); }
    catch (e) { console.debug("[org-clipper] shadow inline skipped:", e); }
    // Strip our own reading-mode overlay so it is never treated as content.
    clone.getElementById("org-clipper-reader")?.remove();
    Object.defineProperty(clone, "URL", { value: location.href, configurable: true });
    // Absolutise relative src/href/srcset so links and images survive out of page.
    try { DomPrep?.resolveUrls(clone, location.href); }
    catch (e) { console.debug("[org-clipper] url resolve skipped:", e); }
    DomPrep?.prepCloneForExtract(clone);
    const instance = new Defuddle(clone, {
      markdown: true,
      url: location.href,
      standardize: true,
      removeImages: false,
    });
    // parseAsync() (raced against a timeout, sync parse() fallback) honours site
    // extractors that fetch over the network — most importantly YouTube, whose
    // transcript/captions come from YoutubeExtractor.extractAsync(). The sync
    // parse() only reads an already-open transcript panel, so a normal clip never
    // captured captions. This file runs in the ISOLATED world, where Chrome awaits
    // a Promise returned as the InjectionResult.result.
    r = DomPrep
      ? await DomPrep.parseAsyncWithFallback(instance)
      : instance.parse();
  } finally {
    console.error = ORIG_ERROR;
  }

  // Selection capture. Take the selected range as HTML so links, emphasis and
  // images survive, then convert it to markdown with the very same engine Defuddle
  // uses (createMarkdownContent). `selection` keeps the plain-text form as a
  // fallback for when there is no rich content or the converter is unavailable.
  let selection = "";
  let selectionMarkdown = "";
  try {
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    selection = (sel && sel.toString()) || "";
    if (sel && sel.rangeCount > 0 && selection.trim()) {
      const holder = document.createElement("div");
      for (let i = 0; i < sel.rangeCount; i++) {
        holder.appendChild(sel.getRangeAt(i).cloneContents());
      }
      DomPrep?.resolveUrls(holder, location.href);
      selectionMarkdown =
        typeof Defuddle.createMarkdownContent === "function"
          ? Defuddle.createMarkdownContent(holder.innerHTML, location.href)
          : selection;
    }
  } catch (e) {
    console.debug("[org-clipper] selection capture failed:", e);
  }

  return {
    url: location.href,
    title: r.title || document.title || "",
    description: r.description || "",
    author: r.author || "",
    published: r.published || "",
    domain: r.domain || location.hostname || "",
    site: r.site || "",
    image: r.image || "",
    favicon: r.favicon || "",
    language: r.language || document.documentElement.lang || "",
    wordCount: typeof r.wordCount === "number" ? r.wordCount : 0,
    extractorType: r.extractorType || null,
    markdown: r.content || "",
    selection,
    selectionMarkdown,
    capturedAt: new Date().toISOString(),
  };
})();
