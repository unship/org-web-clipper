// Collect + fetch a clip's images for the HTTP transport, so Emacs can write
// them into the clip's org-attach dir and rewrite [[url]] -> [[attachment:file]].
// Pure: the network `fetch` is injectable (default: the global), no `chrome` deps.

export interface EmacsImage {
  url: string;
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface FetchImagesOpts {
  fetchImpl?: typeof fetch;
  perImageMax?: number;
  totalMax?: number;
}

const IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:\?[^\]]*)?$/i;
// Extensionless CDN image URLs that declare their format in the query string,
// e.g. Twitter/X `?format=png&name=large`, Unsplash `&fm=jpg`. A false positive
// is harmless: fetchOne still skips any response whose content-type isn't image/*.
const IMG_FORMAT_QUERY = /[?&](?:format|fm)=(?:png|jpe?g|gif|webp|avif|bmp|svg)\b/i;

// Image URLs that Defuddle's MARKDOWN marks unambiguously as images via `![alt](url)`.
// md-to-org turns these into bare `[[url]]', discarding the `!' marker, so they must
// be captured from the markdown. The URL is captured exactly as md-to-org captures it,
// so the strings match the Org body's `[[url]]'. Plain links `[text](url)' are excluded.
export function collectMarkdownImageUrls(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(markdown || ''))) !== null) {
    const url = m[1];
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

// Image links from the converted Org body, in BOTH the bare `[[url]]' and the
// descriptive `[[url][desc]]' form (e.g. GitHub linked images, where md-to-org
// emits a link rather than a bare image). A URL is treated as an image when it is in
// KNOWNIMAGEURLS (the authoritative `![]()' markers from `collectMarkdownImageUrls'),
// or, as a fallback, looks like one (image extension, `?format=' query, or data:image).
// Non-image links are ignored. Emacs rewrites either form to `[[attachment:FILE]]'.
export function collectImageUrls(orgBody: string, knownImageUrls: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const known = new Set(knownImageUrls);
  const re = /\[\[((?:https?:|data:)[^\]]+?)\](?:\[[^\]]*\])?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(orgBody)) !== null) {
    const url = m[1];
    const isImg = url.startsWith('data:image/') || known.has(url)
      || IMG_EXT.test(url) || IMG_FORMAT_QUERY.test(url);
    if (isImg && !seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
}

const PER_IMAGE_MAX = 10 * 1024 * 1024;   // 10 MB
const TOTAL_MAX = 48 * 1024 * 1024;        // ~48 MB raw

const EXT_FOR: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
};

function extFor(ct: string): string { return EXT_FOR[ct] || 'img'; }

function filenameFor(url: string, ct: string): string {
  let base = 'image';
  try { base = new URL(url).pathname.split('/').pop() || 'image'; } catch { /* keep default */ }
  base = base.split('?')[0].replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'image';
  if (!/\.[A-Za-z0-9]+$/.test(base)) base += '.' + extFor(ct);
  return base;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

interface FetchedImage { filename: string; contentType: string; bytes: Uint8Array; }

function parseDataUrl(url: string): FetchedImage | null {
  const m = /^data:([^;,]+)[^,]*,([\s\S]*)$/.exec(url);
  if (!m || !m[1].startsWith('image/')) return null;
  const ct = m[1];
  const bytes = /;base64/i.test(url.slice(0, url.indexOf(',')))
    ? Uint8Array.from(atob(m[2]), c => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(m[2]));
  return { filename: 'image.' + extFor(ct), contentType: ct, bytes };
}

async function fetchOne(url: string, perMax: number, doFetch: typeof fetch): Promise<FetchedImage | null> {
  try {
    if (url.startsWith('data:')) return parseDataUrl(url);
    const resp = await doFetch(url);
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').split(';')[0].trim();
    if (!ct.startsWith('image/')) return null;
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > perMax) return null;
    return { filename: filenameFor(url, ct), contentType: ct, bytes };
  } catch { return null; }
}

// Returns [{ url, filename, contentType, dataBase64 }]. Failures/oversized are
// omitted (the caller keeps the remote link). Sequential with a total budget.
export async function fetchImages(urls: string[], opts: FetchImagesOpts = {}): Promise<EmacsImage[]> {
  const doFetch: typeof fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const perMax = opts.perImageMax ?? PER_IMAGE_MAX;
  const totalMax = opts.totalMax ?? TOTAL_MAX;
  const images: EmacsImage[] = [];
  let total = 0;
  for (const url of urls) {
    if (total >= totalMax) break;
    const r = await fetchOne(url, perMax, doFetch);
    if (!r) continue;
    if (total + r.bytes.byteLength > totalMax) continue;
    total += r.bytes.byteLength;
    images.push({ url, filename: r.filename, contentType: r.contentType, dataBase64: toBase64(r.bytes) });
  }
  return images;
}
