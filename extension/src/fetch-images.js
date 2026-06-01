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

const PER_IMAGE_MAX = 10 * 1024 * 1024;   // 10 MB
const TOTAL_MAX      = 48 * 1024 * 1024;   // ~48 MB raw

const EXT_FOR = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp",
};

function extFor(ct) { return EXT_FOR[ct] || "img"; }

function filenameFor(url, ct) {
  let base = "image";
  try { base = new URL(url).pathname.split("/").pop() || "image"; } catch {}
  base = base.split("?")[0].replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "image";
  if (!/\.[A-Za-z0-9]+$/.test(base)) base += "." + extFor(ct);
  return base;
}

function toBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(url);
  if (!m || !m[1].startsWith("image/")) return null;
  const ct = m[1];
  const bytes = /;base64/i.test(url.slice(0, url.indexOf(",")))
    ? Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(m[2]));
  return { filename: "image." + extFor(ct), contentType: ct, bytes };
}

async function fetchOne(url, perMax) {
  try {
    if (url.startsWith("data:")) return parseDataUrl(url);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim();
    if (!ct.startsWith("image/")) return null;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > perMax) return null;
    return { filename: filenameFor(url, ct), contentType: ct, bytes };
  } catch { return null; }
}

// Returns [{ url, filename, contentType, dataBase64 }]. Failures/oversized are
// omitted (the caller keeps the remote link). Sequential with a total budget.
export async function fetchImages(urls, opts = {}) {
  const perMax = opts.perImageMax ?? PER_IMAGE_MAX;
  const totalMax = opts.totalMax ?? TOTAL_MAX;
  const images = [];
  let total = 0;
  for (const url of urls) {
    if (total >= totalMax) break;
    const r = await fetchOne(url, perMax);
    if (!r) continue;
    if (total + r.bytes.byteLength > totalMax) continue;
    total += r.bytes.byteLength;
    images.push({ url, filename: r.filename, contentType: r.contentType, dataBase64: toBase64(r.bytes) });
  }
  return images;
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

    const enc = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    const mk = (status, ct, body) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: (h) => (h.toLowerCase() === "content-type" ? ct : null) },
      arrayBuffer: async () => enc(body).buffer,
    });
    const saved = globalThis.fetch;
    globalThis.fetch = async (u) => {
      if (u === "https://x/a.png") return mk(200, "image/png", "PNGDATA");
      if (u === "https://x/big.png") return mk(200, "image/png", "X".repeat(20));
      if (u === "https://x/notimg") return mk(200, "text/html", "<html>");
      if (u === "https://x/404") return mk(404, "image/png", "");
      throw new TypeError("Failed to fetch");
    };
    const imgs = await fetchImages(
      ["https://x/a.png", "https://x/big.png", "https://x/notimg", "https://x/404", "https://x/dead",
       "data:image/gif;base64," + btoa("GIF")],
      { perImageMax: 10 });   // tiny per-image cap so big.png (20 bytes) is skipped
    globalThis.fetch = saved;
    const byUrl = Object.fromEntries(imgs.map((i) => [i.url, i]));
    check(!!byUrl["https://x/a.png"], "fetches a real image");
    check(atob(byUrl["https://x/a.png"].dataBase64) === "PNGDATA", "base64 round-trips the bytes");
    check(byUrl["https://x/a.png"].filename === "a.png", "derives filename from url");
    check(!byUrl["https://x/big.png"], "oversized image skipped");
    check(!byUrl["https://x/notimg"], "non-image content-type skipped");
    check(!byUrl["https://x/404"], "404 skipped");
    check(!byUrl["https://x/dead"], "network error skipped");
    check(!!byUrl["data:image/gif;base64," + btoa("GIF")], "data: image decoded without fetch");

    process.exitCode = ok ? 0 : 1;
  })();
}
