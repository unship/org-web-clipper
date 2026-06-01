// Collect + fetch a clip's images for the HTTP transport. No `chrome` deps.

const IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:\?[^\]]*)?$/i;

// Bare `[[url]]` image links from the converted Org body (md-to-org emits
// images as bare links; `[[url][desc]]` is a normal link and is NOT collected).
export function collectImageUrls(orgBody) {
  const out = [];
  const seen = new Set();
  const re = /\[\[((?:https?:|data:)[^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(orgBody)) !== null) {
    const url = m[1];
    const isImg = url.startsWith("data:image/") || IMG_EXT.test(url);
    if (isImg && !seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

// ---- self-tests (node src/fetch-images.js) ----
const isMain =
  typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  (async () => {
    let ok = true;
    const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };

    const body = "see [[https://x/a.png]] and [[https://x/a.png]] and\n" +
      "[[https://x/doc][docs]] and [[https://x/b.JPG?v=2]] and [[https://x/page]]";
    const urls = collectImageUrls(body);
    check(JSON.stringify(urls) === JSON.stringify(["https://x/a.png", "https://x/b.JPG?v=2"]),
          "collects image links, dedups, ignores [[url][desc]] and non-image urls");
    check(collectImageUrls("[[data:image/png;base64,AAA]]")[0] === "data:image/png;base64,AAA",
          "collects data:image urls");

    process.exitCode = ok ? 0 : 1;
  })();
}
