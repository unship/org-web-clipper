# org-clipper — Markdown-marker image detection

- **Status:** Approved
- **Date:** 2026-06-03
- **Scope:** `extension/src/fetch-images.js`, `extension/src/background.js`. No Emacs changes.
- **Follows:** the twimg `?format=png` collection fix (`6f25234`) — this replaces URL guessing as the *primary* image signal.

## 1. Problem

`collectImageUrls` decides "is this body link an image?" by URL pattern (`IMG_EXT`, `IMG_FORMAT_QUERY`). It runs on the **converted Org body**, where `md-to-org` has already turned Markdown `![alt](url)` (image) and `[text](url)` (link) both into `[[…]]` forms — so the unambiguous Markdown image marker `!` is gone, forcing a guess. Extensionless CDN images (Twitter/X `?format=png`) slip through. Evidence: a clipped Twitter image left `#+CAPTION: Image\n[[https://pbs.twimg.com/…?format=png&name=large]]` — the `#+CAPTION:` proves `md-to-org` *knew* it was an image (`![Image](…)`) but that knowledge was discarded before collection.

## 2. Approach

Use the Markdown `![]()` marker — captured from Defuddle's `extract.markdown`, which `background.js` already holds — as the **authoritative** image signal. The URL inside `![](url)` is the exact string `md-to-org` emits as `[[url]]`, so matching is guaranteed (no normalization risk). URL heuristics remain as a **fallback** for images Defuddle renders as *links* (`[desc](img-url)`, e.g. GitHub), which `IMG_EXT` still catches.

```
extract.markdown ──collectMarkdownImageUrls──▶ knownImageUrls (definitive images)
payload.body (Org) ──collectImageUrls(body, known)──▶ url is image if:
     known.has(url)  ||  IMG_EXT  ||  IMG_FORMAT_QUERY  ||  data:image
                               │
                               ▼ fetchImages ▶ Emacs rewrites [[url]] → [[attachment:file]]
```

## 3. Changes

**`fetch-images.js`**
- New `collectMarkdownImageUrls(markdown)`: regex `/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g` (mirrors `md-to-org`'s own image-URL capture, so the strings match), deduped.
- `collectImageUrls(orgBody, knownImageUrls = [])`: add the param; `isImg = url.startsWith("data:image/") || known.has(url) || IMG_EXT.test(url) || IMG_FORMAT_QUERY.test(url)`. Backward compatible (default `[]`).

**`background.js`**
- Import `collectMarkdownImageUrls`.
- `buildCapturePayloadForTab` adds `imageUrls: collectMarkdownImageUrls(extract.markdown)` to the payload (collection-only field).
- New DRY helper consumed at both dispatch sites (popup message + `clip-page` command), which currently duplicate the image step:
  ```js
  async function maybeAttachImages(payload, cfg) {
    if ((cfg.transport || "org-protocol") === "http")
      payload.images = await fetchImages(collectImageUrls(payload.body, payload.imageUrls));
    delete payload.imageUrls;            // never dispatched to Emacs
  }
  ```

## 4. Testing (TDD, Node)

`fetch-images.js` self-tests:
- `collectMarkdownImageUrls("![a](u1) and [l](u2) and ![](u3)")` → `["u1","u3"]` (images, not the link).
- `collectImageUrls("[[https://cdn/opaque-id]]", ["https://cdn/opaque-id"])` → collected (known set; no extension); with `[]` → not collected.
- Twitter scenario: body `#+CAPTION: Image\n[[…twimg…?format=png&name=large]]` + `known=[that url]` → collected.
- All existing `collectImageUrls`/`fetchImages` tests stay green.

## 5. Notes / non-goals

- DOM `<img>` set (an earlier idea) is **not** included — the Markdown marker is simpler, exact-matching, and needs no `content-extract.js`/page changes. It would only add value for link-rendered images with non-image-looking URLs; easy to add later if needed.
- selection-only clips: `imageUrls` is still computed but the quoted-selection body has no `[[url]]` images, so nothing matches — harmless.
