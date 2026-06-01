// Build an `org-protocol://capture?...` URL for the extension to dispatch.
//
// This is the *only* outward edge of the extension now that the native
// messaging host has been removed: background.js packages the clip up via
// `buildCaptureUrl` and hands the resulting URL to chrome to open, which
// the OS routes to emacsclient + org-protocol + org-capture.
//
// Public API:
//   buildCaptureUrl({ url, title, body, tags }, opts?) -> string
//   formatTitleWithTags(title, tags)                  -> string

export function buildCaptureUrl(parts = {}, opts = {}) {
  const { url, title, body, tags } = parts;
  if (!url || typeof url !== "string") {
    throw new Error("buildCaptureUrl: 'url' is required");
  }

  const template    = opts.template    || "w";
  const subprotocol = opts.subprotocol || "capture";

  // Tags ride along inside the title as Org's `:tag:` suffix — that is what
  // org-capture sees via %:description, and Org auto-recognises the suffix.
  const safeTitle = formatTitleWithTags(title || "(untitled)", tags || []);

  // Required: template, url, title. Optional: body.
  const params = [
    ["template", template],
    ["url",      url],
    ["title",    safeTitle],
  ];
  if (body && body.length > 0) params.push(["body", body]);

  const qs = params
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `org-protocol://${subprotocol}?${qs}`;
}

export function formatTitleWithTags(title, tags) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const safeTags = (tags || [])
    .map((t) => String(t).trim().replace(/[^A-Za-z0-9_@#]+/g, "_"))
    .map((t) => t.replace(/^_+|_+$/g, ""))
    .filter(Boolean);
  return safeTags.length
    ? `${cleanTitle}  :${safeTags.join(":")}:`
    : cleanTitle;
}

// ---------------- self-tests ----------------
// Run with `node src/capture-url.js` from the extension directory.

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) runTests();

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    console.error("--- expected ---\n" + expected);
    console.error("--- actual ---\n" + actual);
    process.exitCode = 1;
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`FAIL: ${label} (no throw)`);
    process.exitCode = 1;
  } catch {
    console.log(`PASS: ${label}`);
  }
}

function runTests() {
  // 1. missing url throws
  assertThrows(() => buildCaptureUrl({}), "missing url throws");

  // 2. minimal happy path: template defaults to 'w'
  assertEq(
    buildCaptureUrl({ url: "https://example.com/a", title: "Hi" }),
    "org-protocol://capture?template=w&url=https%3A%2F%2Fexample.com%2Fa&title=Hi",
    "minimal happy path with default template",
  );

  // 3. body is included and url-encoded; '&', '#', '%' must escape
  const u3 = buildCaptureUrl({
    url:   "https://example.com/?q=a&b=c",
    title: "Title with & and ?",
    body:  "* Heading\nA paragraph with ~code~ & a #hash and a [[link][label]].\n",
  });
  // Body round-trip-decodes back to the original string.
  const decodedBody3 = decodeURIComponent(u3.match(/&body=(.*)$/)[1]);
  assertEq(
    decodedBody3,
    "* Heading\nA paragraph with ~code~ & a #hash and a [[link][label]].\n",
    "body round-trip-decodes losslessly",
  );
  // Title is percent-encoded inside the URL.
  if (!u3.includes("title=Title%20with%20%26%20and%20%3F")) {
    console.error("FAIL: title percent-encoding");
    console.error(u3);
    process.exitCode = 1;
  } else {
    console.log("PASS: title percent-encoding (&, ?, space)");
  }

  // 4. tags appended as :tag: suffix in title
  assertEq(
    decodeURIComponent(
      buildCaptureUrl({ url: "https://x", title: "Hi", tags: ["webclip", "ai"] })
        .match(/title=([^&]*)/)[1],
    ),
    "Hi  :webclip:ai:",
    "tags appended as :tag: suffix in title",
  );

  // 5. empty body is omitted from URL
  const u5 = buildCaptureUrl({ url: "https://x", title: "Hi", body: "" });
  if (u5.includes("body=")) {
    console.error("FAIL: empty body should be omitted");
    console.error(u5);
    process.exitCode = 1;
  } else {
    console.log("PASS: empty body omitted from URL");
  }

  // 6. tag sanitisation: spaces/punct become _
  assertEq(
    formatTitleWithTags("Hi", ["c++ stuff", "  read-later "]),
    "Hi  :c_stuff:read_later:",
    "tag sanitisation strips disallowed chars",
  );

  // 7. custom template + subprotocol
  assertEq(
    buildCaptureUrl(
      { url: "https://x", title: "T" },
      { template: "p", subprotocol: "capture-eww" },
    ),
    "org-protocol://capture-eww?template=p&url=https%3A%2F%2Fx&title=T",
    "custom template + subprotocol",
  );

  // 8. title collapse: multi-line/whitespace title becomes a single line
  assertEq(
    formatTitleWithTags("foo\n  bar\tbaz   ", []),
    "foo bar baz",
    "title whitespace collapses to single spaces",
  );

  console.log("\nall capture-url tests done");
}
