# org-clipper Phase 3 — Local image attachments (HTTP transport)

- **Status:** Draft for review
- **Date:** 2026-06-01
- **Scope:** `extension/` (background image fetch + payload, manifest) and `emacs/org-clipper.el` (insert-clip image handling)
- **Depends on:** Phase 2 HTTP transport.

## 1. Goals

- Web clips embed their images as **local Org attachments** → org displays them **natively** (auto, persistent, offline, export-correct), instead of bare remote `[[url]]` that org won't show by default.
- **Non-blocking:** image bytes are fetched in the **browser**; Emacs only base64-decodes + writes local files.
- **HTTP transport only** (a POST can carry bytes); the org-protocol transport keeps remote links.

### Non-goals

- Image embedding over org-protocol (the transport can't carry bytes).
- Re-processing already-captured clips.
- Any image transformation/optimization (stored as fetched).

## 2. Permission

- manifest **`host_permissions: ["*://*/*"]`** (always-on) so the background `fetch` can read any image cross-origin (bypasses page CORS). The install shows "read your data on all websites" — accepted.

## 3. Architecture & data flow

```
browser background (has *://*/*)                          Emacs (HTTP transport)
 1. Defuddle -> md->org body                              5. insert-clip receives :images
 2. collect [[url]] image links (dedup)                   6. org-attach-dir for the clip's :ID:
 3. fetch each (parallel, capped) -> base64               7. base64-decode -> write files there
 4. POST {…payload…, images:[{url,filename,                8. rewrite body [[url]] -> [[attachment:file]]
            contentType,dataBase64}]}     ── HTTP POST ──► 9. save + org-display-inline-images
```

- The background collects image URLs from the **converted Org body** (bare `[[url]]` whose URL has an image extension — `png|jpe?g|gif|webp|svg|avif|bmp`), dedups, and fetches each.
- The extension sends a **URL→bytes map**; the **body keeps `[[url]]`**. Link rewriting is **Emacs-side** (filenames/paths are Emacs-determined). Emacs rewrites by **exact-URL match** against the received map (no regex guessing).

## 4. Payload + size budget

The HTTP JSON payload gains:
```json
"images": [
  { "url": "https://cdn/x.png", "filename": "x.png",
    "contentType": "image/png", "dataBase64": "iVBOR..." }
]
```
- base64 (~+33%); the extension fetches in parallel with a concurrency cap, then POSTs.
- **`data:` images** are decoded inline (no network fetch).
- **Dedup** by URL: fetch once, one attachment, all occurrences rewritten to it.
- **Caps (extension side; defaults, tunable):** per-image **10 MB** (larger → skipped, stays remote); total budget **~48 MB** raw ≈ 64 MB base64 (once exceeded, remaining images stay remote).
- **Emacs:** raise `org-clipper-http-max-body` to **128 MB** (headroom over the base64 budget).
- **content-type → extension:** from the response header; else inferred from the URL; else `.img`.

## 5. Emacs side (`org-clipper--insert-clip`)

Order matters (the attach dir depends on the entry's `:ID:`):

1. Insert the entry + generate `:ID:` (existing flow) — body still has `[[url]]`.
2. If `:images` is non-empty, with point on the new heading: `(org-attach-dir t)` creates the clip's attachment dir (the existing `~/org/.attach/<id>/` layout, via org-attach's own API).
3. For each image: base64-decode → write into that dir (filename = the extension's sanitized name; on collision, append an md5 suffix). Build a `url→filename` map.
4. Narrow to the new subtree; rewrite mapped `[[url]]` and `[[url][desc]]` → `[[attachment:filename]]` (unmapped URLs stay remote).
5. `save-buffer`; `org-display-inline-images` in the (live, lean) buffer so they show immediately.

**Non-blocking:** the network fetch happened in the browser; Emacs does only base64-decode + local file writes (fast, no network) — the daemon never blocks.

## 6. Transport scoping & fallback

- **HTTP transport → embed**; **org-protocol transport → keep remote `[[url]]`** (can't carry bytes).
- **Fallback to remote `[[url]]`** for any image that is: fetch-failed, over a cap, a non-image content-type, or fails to write on the Emacs side. Partial embedding is fine.
- The overlay commands **`org-clipper-preview-remote-images` / `org-clipper-toggle-image-at-point` are KEPT** — still useful for remote images (org-protocol transport, or images that fell back to remote).

## 7. Auto-display & sizing

- insert-clip calls `org-display-inline-images` so images show immediately in the live buffer.
- For images to show when the file is **re-opened**, recommend `org-startup-with-inline-images t` (currently nil) or a per-file `#+STARTUP: inlineimages`. (Config recommendation, not part of the package.)
- Width is already capped by the user's `org-image-actual-width '(400)`.

## 8. Components / file changes

**Extension**
- `src/fetch-images.js` (new): `collectImageUrls(orgBody)` + `fetchImages(urls, opts)` → `images[]` (parallel, caps, data: handling, dedup). Unit-testable with a mocked `fetch`.
- `src/background.js`: after building the payload, collect+fetch images and attach `payload.images` (HTTP transport only — skip the fetch when `cfg.transport !== "http"`).
- `manifest.json`: add `host_permissions: ["*://*/*"]`.
- `transport-http.js`: unchanged (already serializes the whole payload, images included).

**Emacs (`emacs/org-clipper.el`)**
- `org-clipper--insert-clip`: pass `:images` through; new `org-clipper--attach-images` helper (org-attach write + `url→filename` map); rewrite the subtree's links; `org-display-inline-images`.
- `org-clipper-http-max-body` → 128 MB.

**Config (recommendation)**
- `(setq org-startup-with-inline-images t)`.

## 9. Testing

- **Extension (node):** `fetch-images` with a mocked `fetch` — ok / 404 / oversized-skip / non-image content-type / `data:` URL / dedup → asserts the `images[]` shape and that skipped URLs are omitted. `collectImageUrls` over a sample Org body (only image-extension links collected).
- **Emacs (ERT):** `insert-clip` with an `:images` list (a tiny 1×1 PNG base64) into a temp target → asserts the file is written under the entry's `org-attach-dir`, the body link became `[[attachment:…]]`, an unmapped URL stayed remote, and Chinese/levels still intact.
- **Integration:** `curl` POST with a small base64 image to the live server (batch) → assert the attachment file exists + the link was rewritten.

## 10. Open items / future

- Per-image / total caps could become options later (constants for now).
- A toggle to disable embedding (always-remote) could be added if wanted.
