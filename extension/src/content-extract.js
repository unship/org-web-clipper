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

(() => {
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

  let r;
  try {
    // Parse a DETACHED CLONE so extraction can never mutate the live page.
    // (Defuddle reads the live doc for shadow-roots/media-queries; cloning makes
    // even those reads operate on a throwaway copy.) Strip our own reading-mode
    // overlay from the clone so it is never treated as content.
    const clone = document.cloneNode(true);
    clone.getElementById("org-clipper-reader")?.remove();
    Object.defineProperty(clone, "URL", { value: location.href, configurable: true });
    self.OrgClipperDomPrep?.prepCloneForExtract(clone);
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

  const selection =
    (typeof window.getSelection === "function" && window.getSelection().toString()) || "";

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
    capturedAt: new Date().toISOString(),
  };
})();
