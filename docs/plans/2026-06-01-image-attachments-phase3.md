# org-clipper Phase 3 (local image attachments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web clips embed their images as local Org attachments so org displays them natively, instead of bare remote `[[url]]`.

**Architecture:** The extension background (host_permissions `*://*/*`) collects image URLs from the converted Org body, fetches their bytes, and includes them base64-encoded in the HTTP POST (HTTP transport only). Emacs writes them into the clip's `org-attach` dir (keyed by the clip's `:ID:`) and rewrites `[[url]]` → `[[attachment:file]]`.

**Tech Stack:** Browser extension (MV3, ES modules; `fetch`/`atob`/`btoa`; Node for self-tests). Emacs Lisp (`org-attach`, `base64-decode-string`; ERT, `emacs --batch`).

Reference spec: `docs/design/2026-06-01-image-attachments-design.md`. Depends on Phase 2 (HTTP transport, shipped).

---

## File Structure

- `extension/src/fetch-images.js` (new): `collectImageUrls(orgBody)` + `fetchImages(urls, opts)`. Pure of `chrome`; testable with a mocked `fetch`.
- `extension/src/background.js` (modify): when `cfg.transport === "http"`, collect+fetch images and attach `payload.images`.
- `extension/manifest.json` (modify): add `host_permissions: ["*://*/*"]`.
- `emacs/org-clipper.el` (modify): `org-clipper--attach-images`, `org-clipper--rewrite-image-links`, wire into `org-clipper--insert-clip`; `org-clipper-http-max-body` → 128 MB.
- `emacs/test/org-clipper-test.el` (modify): ERT for attach + rewrite + insert-clip-with-images.

---

## Task 1: `collectImageUrls` (extension)

**Files:**
- Create: `extension/src/fetch-images.js`
- Test: self-test block in the same file (run with `node`)

- [ ] **Step 1: Write `collectImageUrls` + a self-test**

Create `extension/src/fetch-images.js`:
```js
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
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd extension && node src/fetch-images.js`
Expected: 2 × PASS.

- [ ] **Step 3: Commit**
```bash
cd .. && git add extension/src/fetch-images.js
git commit -m "feat(ext): collectImageUrls — image links from the Org body"
```

---

## Task 2: `fetchImages` (extension)

**Files:**
- Modify: `extension/src/fetch-images.js`

- [ ] **Step 1: Add `fetchImages` + helpers + self-tests**

Insert BEFORE the `const isMain` line in `fetch-images.js`:
```js
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
```

- [ ] **Step 2: Add the `fetchImages` self-tests inside the existing `if (isMain)` IIFE**

In `fetch-images.js`, inside the `(async () => { … })()` block (before `process.exitCode`), append:
```js
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
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd extension && node src/fetch-images.js`
Expected: all PASS (2 from Task 1 + 8 here).

- [ ] **Step 4: Commit**
```bash
cd .. && git add extension/src/fetch-images.js
git commit -m "feat(ext): fetchImages — fetch/base64/caps/data-url/fallback"
```

---

## Task 3: Wire into background + manifest permission

**Files:**
- Modify: `extension/src/background.js`, `extension/manifest.json`

- [ ] **Step 1: Add the host permission**

In `extension/manifest.json`, change `"host_permissions"` to include all hosts:
```json
  "host_permissions": [
    "http://127.0.0.1/*",
    "*://*/*"
  ],
```

- [ ] **Step 2: Collect + fetch images in background.js**

In `extension/src/background.js`, add the import at the top:
```js
import { collectImageUrls, fetchImages } from "./fetch-images.js";
```
Then in the `CLIP_TAB` listener and the `clip-page` command handler, after building `payload` and reading `cfg`, before `dispatchCapture`, add (HTTP transport only):
```js
    if ((cfg.transport || "org-protocol") === "http") {
      payload.images = await fetchImages(collectImageUrls(payload.body));
    }
```
(For the message listener this goes inside the existing async IIFE; for the command handler inside its `try`.)

- [ ] **Step 3: Sanity — modules still import + node tests pass**

Run:
```bash
cd extension && node src/fetch-images.js && node --input-type=module -e "import('./src/fetch-images.js').then(()=>console.log('import OK'))"
node -e "console.log('manifest', JSON.stringify(require('./manifest.json').host_permissions))"
```
Expected: PASS + `import OK` + `["http://127.0.0.1/*","*://*/*"]`. (background.js can't be node-imported — it uses `chrome` at top level — but it has no top-level await; verify by eye that the new `await` calls are inside the async IIFE / async handler.)

- [ ] **Step 4: Commit**
```bash
cd .. && git add extension/src/background.js extension/manifest.json
git commit -m "feat(ext): attach fetched images to the HTTP payload; host_permissions *://*/*"
```

---

## Task 4: `org-clipper--attach-images` (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append to `emacs/test/org-clipper-test.el`:
```elisp
;;; --- Phase 3: image attachments ---
;; 1x1 transparent PNG, base64.
(defconst org-clipper-test--png
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

(ert-deftest org-clipper-test-attach-images-writes-and-maps ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (let ((org-attach-id-dir (make-temp-name (expand-file-name "oc-attach-" temporary-file-directory))))
       (with-current-buffer (find-file-noselect tmp)
         (let ((org-mode-hook nil)) (org-mode))
         (goto-char (point-max)) (insert "* clip\n") (org-back-to-heading t)
         (org-id-get-create)
         (let ((map (org-clipper--attach-images
                     (list (list :url "https://x/a.png" :filename "a.png"
                                 :contentType "image/png" :dataBase64 org-clipper-test--png)))))
           (should (equal map '(("https://x/a.png" . "a.png"))))
           (should (file-exists-p (expand-file-name "a.png" (org-attach-dir))))
           (should (> (file-attribute-size (file-attributes (expand-file-name "a.png" (org-attach-dir)))) 0)))
         (set-buffer-modified-p nil))))))
```

- [ ] **Step 2: Run to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--attach-images` void.

- [ ] **Step 3: Add the helper to `emacs/org-clipper.el`** (before `org-clipper--insert-clip`)

```elisp
(defun org-clipper--attach-filename (raw used)
  "A safe, unique filename for RAW given USED (hash of taken names)."
  (let* ((base (file-name-nondirectory (or raw "image")))
         (base (replace-regexp-in-string "[^A-Za-z0-9._-]+" "_" base))
         (base (if (string-empty-p base) "image" base))
         (name base) (n 1))
    (while (gethash name used)
      (setq name (format "%s-%d%s"
                         (file-name-sans-extension base) n
                         (if (file-name-extension base)
                             (concat "." (file-name-extension base)) ""))
            n (1+ n)))
    name))

(defun org-clipper--attach-images (images)
  "With point on the current entry, write IMAGES (plists :url :filename
:dataBase64) into the entry's org-attach dir.  Return an alist (URL . FILE)
of successfully-written images; failures are skipped."
  (require 'org-attach)
  (let ((dir (org-attach-dir t)) (used (make-hash-table :test 'equal)) (map '()))
    (dolist (img images)
      (let ((url (plist-get img :url))
            (b64 (plist-get img :dataBase64))
            (name (org-clipper--attach-filename (plist-get img :filename)
                                                (make-hash-table :test 'equal))))
        (setq name (org-clipper--attach-filename name used))
        (condition-case nil
            (when (and url b64 (> (length b64) 0))
              (let ((coding-system-for-write 'binary)
                    (path (expand-file-name name dir)))
                (with-temp-file path
                  (set-buffer-multibyte nil)
                  (insert (base64-decode-string b64))))
              (puthash name t used)
              (push (cons url name) map))
          (error nil))))
    (nreverse map)))
```

- [ ] **Step 4: Run to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): org-clipper--attach-images (write to org-attach dir)"
```

---

## Task 5: Rewrite links + wire into insert-clip (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(ert-deftest org-clipper-test-insert-clip-embeds-images ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (let ((org-attach-id-dir (make-temp-name (expand-file-name "oc-attach-" temporary-file-directory))))
       (org-clipper--insert-clip
        (list :title "T" :url "u"
              :body "[[https://x/a.png]] and [[https://x/missing.png]]"
              :images (list (list :url "https://x/a.png" :filename "a.png"
                                  :contentType "image/png" :dataBase64 org-clipper-test--png))))
       (with-temp-buffer
         (insert-file-contents tmp)
         (let ((s (buffer-string)))
           (should (string-match-p "\\[\\[attachment:a.png\\]\\]" s))        ; embedded
           (should (string-match-p "\\[\\[https://x/missing.png\\]\\]" s))))))))  ; unmapped stays remote

(ert-deftest org-clipper-test-http-max-body-raised ()
  (should (>= org-clipper-http-max-body (* 128 1024 1024))))
```

- [ ] **Step 2: Run to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — insert-clip doesn't yet handle `:images`; `org-clipper-http-max-body` is 20 MB.

- [ ] **Step 3: Add the rewrite helper + wire into insert-clip + raise the cap**

Add the rewrite helper to `emacs/org-clipper.el` (before `org-clipper--insert-clip`):
```elisp
(defun org-clipper--rewrite-image-links (map)
  "In the current subtree, rewrite [[URL]] and [[URL][desc]] to
[[attachment:FILE]] for each (URL . FILE) in MAP."
  (save-excursion
    (save-restriction
      (org-back-to-heading t)
      (org-narrow-to-subtree)
      (dolist (pair map)
        (goto-char (point-min))
        (while (re-search-forward
                (concat "\\[\\[" (regexp-quote (car pair)) "\\(?:\\]\\[[^]]*\\)?\\]\\]")
                nil t)
          (replace-match (concat "[[attachment:" (cdr pair) "]]") t t))))))
```
In `org-clipper--insert-clip`, the tail currently is:
```elisp
         (goto-char pos)
         (org-back-to-heading t)
         (org-id-get-create)))
      (save-buffer))
    file))
```
Replace it with:
```elisp
         (goto-char pos)
         (org-back-to-heading t)
         (org-id-get-create)
         (let ((images (plist-get clip :images)))
           (when images
             (let ((map (org-clipper--attach-images images)))
               (when map
                 (org-clipper--rewrite-image-links map)))))))
      (save-buffer)
      (ignore-errors (org-display-inline-images)))
    file))
```
And raise the cap — change the `org-clipper-http-max-body` defcustom default:
```elisp
(defcustom org-clipper-http-max-body (* 128 1024 1024)
  "Maximum accepted request-body size in bytes for the HTTP transport."
  :type 'integer :group 'org-clipper)
```

- [ ] **Step 4: Run to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS (all prior tests + the two new ones).

- [ ] **Step 5: Byte-compile clean + commit**

Run: `emacs -Q --batch -L emacs -f batch-byte-compile emacs/org-clipper.el` (no errors), then `rm -f emacs/org-clipper.elc`.
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): embed clip images via org-attach + rewrite links; max-body 128MB"
```

---

## Task 6: Integration + config + README

**Files:**
- Modify: `README.md`
- (no code change; verification + docs)

- [ ] **Step 1: Socket integration with a real image**

Create `/tmp/oc-img-integ.el`:
```elisp
(set-language-environment "UTF-8")
(add-to-list 'load-path (expand-file-name "emacs"))
(require 'org-clipper)
(setq org-clipper-http-token-file (make-temp-name (expand-file-name "oc-tok-" temporary-file-directory))
      org-clipper-target-file     (make-temp-file "oc-img-target" nil ".org")
      org-attach-id-dir           (make-temp-name (expand-file-name "oc-attach-" temporary-file-directory))
      org-clipper-http-port       17790)
(let* ((tok (org-clipper--http-token))
       (curl-out (make-temp-file "oc-curl"))
       (json-file (make-temp-file "oc-json"))
       (png "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
       (json (format "{\"template\":\"w\",\"url\":\"https://x/p\",\"title\":\"img test\",\"body\":\"[[https://x/a.png]]\",\"images\":[{\"url\":\"https://x/a.png\",\"filename\":\"a.png\",\"contentType\":\"image/png\",\"dataBase64\":\"%s\"}]}" png)))
  (let ((coding-system-for-write 'utf-8)) (with-temp-file json-file (insert json)))
  (org-clipper-start)
  (let ((p (start-process "curl" "*curl*" "curl" "-s" "-o" curl-out "-w" "%{http_code}"
                          "-X" "POST" "-H" (concat "X-Org-Clipper-Token: " tok)
                          "-H" "Origin: chrome-extension://t" "--data-binary" (concat "@" json-file)
                          (format "http://127.0.0.1:%d/capture" org-clipper-http-port))))
    (let ((end (+ (float-time) 8))) (while (and (process-live-p p) (< (float-time) end)) (accept-process-output nil 0.1))))
  (org-clipper-stop)
  (princ (format "http_code=%s\n" (with-current-buffer "*curl*" (string-trim (buffer-string)))))
  (princ "----- file -----\n")
  (princ (with-temp-buffer (insert-file-contents org-clipper-target-file) (buffer-string))))
```
Run: `cd <repo> && emacs -Q --batch -l /tmp/oc-img-integ.el`
Expected: `http_code=200` and the file shows `[[attachment:a.png]]` (not the remote URL).

- [ ] **Step 2: README + config note**

In `README.md`, document: HTTP transport embeds images as `org-attach` attachments (`*://*/*` permission); org-protocol keeps remote links; recommend `(setq org-startup-with-inline-images t)` for auto-display; the overlay commands remain for remote images.

- [ ] **Step 3: Full sweep + commit**

Run:
```bash
cd extension && node src/md-to-org.js && node src/fetch-images.js && node src/transport-orgproto.js && node src/transport.js && node src/transport-http.js && cd ..
emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit
```
Expected: all PASS.
```bash
git add README.md
git commit -m "docs: README for Phase 3 image attachments"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** background fetch + `*://*/*` (T2/T3), HTTP-only embedding (T3 gate `cfg.transport === "http"`), payload `images[]` (T2), caps + data: + dedup + fallback (T1/T2), org-attach write (T4), link rewrite + insert-clip wiring + 128 MB cap (T5), display + integration (T5/T6), README + auto-display config (T6). org-protocol fallback = unchanged (no images sent). Overlay commands untouched (kept).
- **Risk points:** (a) `btoa`/`atob` are global in Node 16+ and in SW — fine; (b) `org-attach-dir t` needs point on the entry with an `:ID:` — insert-clip generates the ID first; the test mirrors that; (c) `org-display-inline-images` on a big monthly file shows all images — acceptable in the lean buffer, wrapped in `ignore-errors`; (d) background.js gains `await fetchImages(...)` — must stay inside the async IIFE/handler (no new top-level await → SW stays loadable).
- **Type/name consistency:** payload image keys `url/filename/contentType/dataBase64` are identical across `fetchImages` (T2), the JSON (T6), and `org-clipper--attach-images` (T4).
