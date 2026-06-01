# org-clipper Phase 1 (capture-core + org-protocol) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace org-capture with a shared `org-clipper--insert-clip` core that writes a full Obsidian-parity metadata drawer, drive it from the default `org-protocol` transport, and remove the fill-on-finalize feature.

**Architecture:** One capture core (`org-clipper--insert-clip`, plist in → lean persistent buffer → prepend entry → save). A dedicated `org-clipper` org-protocol sub-protocol decodes its params and calls the core. The extension builds the same logical payload (incl. metadata) and dispatches it as an `org-protocol://org-clipper?…` URL. HTTP transport is Phase 2.

**Tech Stack:** Emacs Lisp (`org`, `org-id`, `org-protocol`; ERT for tests, `emacs --batch`). Browser extension (MV3, ES modules; Node for self-tests).

Reference spec: `docs/design/2026-06-01-pluggable-transport-design.md`.

---

## File Structure

**Emacs — `emacs/org-clipper.el`** (rewritten): defcustoms (`org-clipper-transport` default `org-protocol`, monthly target, headline, prepend, `org-clipper-default-tags` `("clippings")`), target helpers (`--current-target-file`, `--capture-target-file` lean buffer), tag/format helpers, the `--insert-clip` core, the `org-clipper` org-protocol handler, and the existing visit/refile commands. No fill-body, no org-capture template registration.

**Emacs tests — `emacs/test/org-clipper-test.el`** (new): ERT tests run in batch.

**Extension:**
- `extension/src/transport-orgproto.js` (new; absorbs `capture-url.js`): `buildOrgProtocolUrl(payload, cfg)` + `dispatchOrgProtocol(payload, cfg)`.
- `extension/src/transport.js` (new): `dispatchCapture(payload, cfg)` selects by `cfg.transport`.
- `extension/src/background.js` (modify): `buildCapturePayloadForTab` returns a metadata payload; dispatch via `transport.js`.
- `extension/src/popup.js` (modify): background performs dispatch; popup only renders status.
- `extension/src/options.{html,js}` (modify): add `transport` (default `org-protocol`); drop `subprotocol`.
- `extension/src/capture-url.js` (delete after T7).

---

## Task 1: Tag merge + default tags (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Create `emacs/test/org-clipper-test.el`:
```elisp
;;; org-clipper-test.el --- tests -*- lexical-binding: t; -*-
(require 'ert)
(add-to-list 'load-path (expand-file-name ".." (file-name-directory (or load-file-name buffer-file-name))))
(require 'org-clipper)

(ert-deftest org-clipper-test-merge-tags-prepends-defaults ()
  (let ((org-clipper-default-tags '("clippings")))
    (should (equal (org-clipper--merge-tags '("ai" "read")) '("clippings" "ai" "read")))))

(ert-deftest org-clipper-test-merge-tags-dedupes-and-sanitizes ()
  (let ((org-clipper-default-tags '("clippings")))
    (should (equal (org-clipper--merge-tags '("clippings" "c++ stuff" "  read-later "))
                   '("clippings" "c_stuff" "read_later")))))

(ert-deftest org-clipper-test-tags-string ()
  (should (equal (org-clipper--tags-string '("a" "b")) ":a:b:"))
  (should (equal (org-clipper--tags-string nil) "")))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--merge-tags` / `org-clipper--tags-string` void (or `require` fails because functions absent).

- [ ] **Step 3: Add the helpers to `emacs/org-clipper.el`**

After the `defcustom` block, add:
```elisp
(defcustom org-clipper-default-tags '("clippings")
  "Tags always merged into every clip's headline (newest-first order preserved)."
  :type '(repeat string)
  :group 'org-clipper)

(defun org-clipper--sanitize-tag (tag)
  "Return TAG reduced to a valid Org tag, or nil if it becomes empty."
  (let* ((s (replace-regexp-in-string "[^[:alnum:]_@#%]+" "_" (string-trim (or tag ""))))
         (s (replace-regexp-in-string "\\`_+\\|_+\\'" "" s)))
    (and (> (length s) 0) s)))

(defun org-clipper--merge-tags (tags)
  "Merge `org-clipper-default-tags' with TAGS; sanitize, dedupe, keep order."
  (let ((seen (make-hash-table :test 'equal)) out)
    (dolist (tg (append org-clipper-default-tags tags))
      (let ((s (org-clipper--sanitize-tag tg)))
        (when (and s (not (gethash s seen)))
          (puthash s t seen)
          (push s out))))
    (nreverse out)))

(defun org-clipper--tags-string (tags)
  "Render TAGS (a list) as Org's `:a:b:' suffix, or empty string."
  (if tags (concat ":" (mapconcat #'identity tags ":") ":") ""))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): tag merge + default-tags helper"
```

---

## Task 2: Entry formatter — metadata drawer (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(ert-deftest org-clipper-test-format-entry-full ()
  (let ((org-clipper-default-tags '("clippings"))
        (txt (org-clipper--format-entry
              2 "Lock-Free Ring Buffer"
              '("clippings" "rust")
              (list :url "https://x/p" :author "David Rosa"
                    :published "" :description "A SPSC queue."
                    :created "2026-03-28" :body "** body\ntext"))))
    (should (string-match-p "\\`\\*\\* Lock-Free Ring Buffer  :clippings:rust:\n" txt))
    (should (string-match-p ":PROPERTIES:\n" txt))
    (should (string-match-p "^:SOURCE: https://x/p$" txt))
    (should (string-match-p "^:AUTHOR: David Rosa$" txt))
    (should (string-match-p "^:CREATED: \\[2026-03-28\\]$" txt))
    (should (string-match-p "^:DESCRIPTION: A SPSC queue.$" txt))
    (should-not (string-match-p ":PUBLISHED:" txt))   ; empty omitted
    (should (string-suffix-p "** body\ntext\n" txt))))

(ert-deftest org-clipper-test-created-defaults-to-today ()
  (should (string-match-p "\\`\\[[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}"
                          (org-clipper--created-stamp nil))))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--format-entry` / `org-clipper--created-stamp` void.

- [ ] **Step 3: Add the formatter**

```elisp
(defun org-clipper--created-stamp (created)
  "Inactive Org timestamp for CREATED (a date string), or today if empty."
  (if (and created (string-match-p "[0-9]" created))
      (format "[%s]" (string-trim created))
    (format-time-string "[%Y-%m-%d %a]")))

(defun org-clipper--format-entry (level title tags clip)
  "Return the Org entry text for CLIP at heading LEVEL. No :ID: yet (added
after insertion).  Empty optional properties are omitted.  TAGS is a list."
  (let ((props '()))
    (push (cons "SOURCE" (or (plist-get clip :url) "")) props)
    (let ((author (plist-get clip :author)))
      (when (and author (> (length (string-trim author)) 0))
        (push (cons "AUTHOR" (string-trim author)) props)))
    (let ((published (plist-get clip :published)))
      (when (and published (> (length (string-trim published)) 0))
        (push (cons "PUBLISHED" (string-trim published)) props)))
    (push (cons "CREATED" (org-clipper--created-stamp (plist-get clip :created))) props)
    (let ((description (plist-get clip :description)))
      (when (and description (> (length (string-trim description)) 0))
        (push (cons "DESCRIPTION"
                    (replace-regexp-in-string "[\n\r]+" " " (string-trim description)))
              props)))
    (setq props (nreverse props))
    (let ((body (or (plist-get clip :body) "")))
      (concat
       (make-string level ?*) " " (string-trim (or title "(untitled)"))
       (let ((ts (org-clipper--tags-string tags)))
         (if (> (length ts) 0) (concat "  " ts) ""))
       "\n:PROPERTIES:\n"
       (mapconcat (lambda (kv) (format ":%s: %s" (car kv) (cdr kv))) props "\n")
       "\n:END:\n\n"
       (if (string-suffix-p "\n" body) body (concat body "\n"))))))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): metadata-drawer entry formatter"
```

---

## Task 3: Target file + lean persistent buffer (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(ert-deftest org-clipper-test-capture-target-buffer-is-lean-and-reused ()
  (let* ((tmp (make-temp-file "oc-t" nil ".org"))
         (org-clipper-target-file tmp)
         (sentinel-ran nil)
         (org-mode-hook (list (lambda () (setq sentinel-ran t)))))
    (unwind-protect
        (let ((f1 (org-clipper--capture-target-file)))
          (should (equal f1 tmp))
          (should (find-buffer-visiting tmp))          ; opened + kept alive
          (should-not sentinel-ran)                    ; org-mode-hook suppressed
          (let ((b (find-buffer-visiting tmp)))
            (should (eq b (progn (org-clipper--capture-target-file)
                                 (find-buffer-visiting tmp))))))  ; reused
      (let ((b (find-buffer-visiting tmp)))
        (when b (with-current-buffer b (set-buffer-modified-p nil)) (kill-buffer b)))
      (delete-file tmp))))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--capture-target-file` / `org-clipper--current-target-file` void.

- [ ] **Step 3: Add target helpers**

Add defcustoms (if not already present) and helpers:
```elisp
(defcustom org-clipper-target-file nil
  "Override file for clips.  When nil, a monthly file under
`org-clipper-monthly-dir' is used."
  :type '(choice (const :tag "Monthly file" nil) file) :group 'org-clipper)

(defcustom org-clipper-monthly-dir
  (expand-file-name "inbox" (or (bound-and-true-p org-directory) "~/org"))
  "Directory holding monthly clip files (YYYY-MM.org)."
  :type 'directory :group 'org-clipper)

(defcustom org-clipper-lean-capture t
  "Open the clip target with `org-mode-hook' suppressed and keep it alive,
so captures never re-run heavy org-mode setup or attach LSP/grammar tools."
  :type 'boolean :group 'org-clipper)

(defun org-clipper--current-target-file ()
  "Absolute path the next clip lands in (override or monthly).  Makes its dir."
  (let* ((path (if org-clipper-target-file
                   (expand-file-name org-clipper-target-file)
                 (expand-file-name (format-time-string "%Y-%m.org")
                                   org-clipper-monthly-dir)))
         (dir (file-name-directory path)))
    (unless (file-directory-p dir) (make-directory dir t))
    path))

(defun org-clipper--capture-target-file ()
  "Ensure the target file is visited in a lean, kept-alive buffer; return path."
  (let ((file (org-clipper--current-target-file)))
    (when (and org-clipper-lean-capture (not (find-buffer-visiting file)))
      (let ((org-mode-hook nil) (org-inhibit-startup t))
        (find-file-noselect file)))
    file))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): lean persistent target buffer"
```

---

## Task 4: Capture core `org-clipper--insert-clip` (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(defun org-clipper-test--with-target (fn)
  (let* ((tmp (make-temp-file "oc-i" nil ".org"))
         (org-clipper-target-file tmp)
         (org-clipper-default-tags '("clippings")))
    (unwind-protect (funcall fn tmp)
      (let ((b (find-buffer-visiting tmp)))
        (when b (with-current-buffer b (set-buffer-modified-p nil)) (kill-buffer b)))
      (delete-file tmp))))

(ert-deftest org-clipper-test-insert-clip-writes-metadata-and-id ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (org-clipper--insert-clip
      (list :title "中文标题 café ☕" :url "https://x/测试"
            :author "David Rosa" :description "Desc." :created "2026-03-28"
            :tags '("rust") :body "*** sec\n你好,世界 😀"))
     (with-temp-buffer
       (insert-file-contents tmp)
       (let ((s (buffer-string)))
         (should (string-match-p "^\\* Web clips$" s))
         (should (string-match-p "^\\*\\* 中文标题 café ☕  :clippings:rust:$" s))
         (should (string-match-p "^:ID: +[-0-9a-fA-F]+$" s))
         (should (string-match-p "^:SOURCE: https://x/测试$" s))
         (should (string-match-p "^:AUTHOR: David Rosa$" s))
         (should (string-match-p "你好,世界 😀" s)))))))

(ert-deftest org-clipper-test-insert-clip-prepends-newest-first ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (org-clipper--insert-clip (list :title "First" :url "u1" :body "b1"))
     (org-clipper--insert-clip (list :title "Second" :url "u2" :body "b2"))
     (with-temp-buffer
       (insert-file-contents tmp)
       (goto-char (point-min))
       (re-search-forward "^\\*\\* \\(First\\|Second\\)")
       (should (equal (match-string 1) "Second"))))))   ; newest on top
```

- [ ] **Step 2: Run test to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--insert-clip` void.

- [ ] **Step 3: Add the core**

```elisp
(require 'org-id)

(defcustom org-clipper-target-headline "Web clips"
  "Heading under which clips are filed." :type 'string :group 'org-clipper)

(defcustom org-clipper-prepend t
  "When non-nil insert each clip as the FIRST child of the headline."
  :type 'boolean :group 'org-clipper)

(defun org-clipper--goto-target-headline ()
  "Move point to `org-clipper-target-headline', creating it if missing.
Return its outline level."
  (goto-char (point-min))
  (let ((case-fold-search t))
    (unless (re-search-forward
             (format "^\\*+[ \t]+%s[ \t]*$" (regexp-quote org-clipper-target-headline))
             nil t)
      (goto-char (point-max))
      (unless (bolp) (insert "\n"))
      (insert "* " org-clipper-target-headline "\n"))
    (beginning-of-line)
    (when (looking-at "^\\*") (org-current-level))))

(defun org-clipper--insert-clip (clip)
  "Insert web-clip plist CLIP into the target file; return the file path.
Plist keys: :template :url :title :body :tags :author :published
:description :created.  Bypasses org-capture; writes a metadata drawer and a
fresh :ID:."
  (let* ((file (org-clipper--capture-target-file))
         (buf  (find-buffer-visiting file))
         (tags (org-clipper--merge-tags (plist-get clip :tags))))
    (with-current-buffer buf
      (org-with-wide-buffer
       (let* ((hlevel (or (org-clipper--goto-target-headline) 1))
              (entry  (org-clipper--format-entry
                       (1+ hlevel) (plist-get clip :title) tags clip))
              (pos    (save-excursion
                        (if org-clipper-prepend
                            (progn (org-end-of-meta-data t) (point))
                          (org-end-of-subtree t t)
                          (unless (bolp) (insert "\n"))
                          (point)))))
         (goto-char pos)
         (insert entry)
         (goto-char pos)
         (org-back-to-heading t)
         (org-id-get-create)))
      (save-buffer))
    file))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS. If `org-end-of-meta-data` leaves point mid-line on a brand-new headline, the `pos` save-excursion still resolves to content start; verify both prepend tests pass.

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): insert-clip capture core (metadata + :ID: + prepend)"
```

---

## Task 5: org-protocol `org-clipper` sub-protocol (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(ert-deftest org-clipper-test-protocol-capture-decodes-and-inserts ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (let ((info (concat "template=w"
                         "&url=" (url-hexify-string "https://x/测试")
                         "&title=" (url-hexify-string "标题 ☕")
                         "&tags=clippings,rust"
                         "&author=" (url-hexify-string "David Rosa")
                         "&body=" (url-hexify-string "*** s\n你好"))))
       (org-clipper--protocol-capture info)
       (with-temp-buffer
         (insert-file-contents tmp)
         (let ((s (buffer-string)))
           (should (string-match-p "^\\*\\* 标题 ☕  :clippings:rust:$" s))
           (should (string-match-p "^:SOURCE: https://x/测试$" s))
           (should (string-match-p "^:AUTHOR: David Rosa$" s))
           (should (string-match-p "你好" s))))))))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--protocol-capture` void.

- [ ] **Step 3: Add the handler + registration**

```elisp
(require 'org-protocol)

(defun org-clipper--protocol-capture (info)
  "Handle `org-protocol://org-clipper?...'.  INFO is the raw query string;
`org-protocol-parse-parameters' percent-decodes each value to UTF-8."
  (let* ((p (org-protocol-parse-parameters info t))
         (tags (let ((tg (plist-get p :tags)))
                 (and tg (split-string tg "[,]+" t "[ \t]+")))))
    (org-clipper--insert-clip
     (list :template (plist-get p :template) :url (plist-get p :url)
           :title (plist-get p :title) :body (or (plist-get p :body) "")
           :tags tags :author (plist-get p :author)
           :published (plist-get p :published)
           :description (plist-get p :description) :created (plist-get p :created)))
    nil))

(add-to-list 'org-protocol-protocol-alist
             '("org-clipper" :protocol "org-clipper"
               :function org-clipper--protocol-capture :kill-client t))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS. (If `org-protocol-parse-parameters` returns a non-`:author` key for arbitrary params, the test fails on `:AUTHOR:` — adjust the handler to read from the returned plist's actual keys, then re-run.)

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): org-clipper org-protocol sub-protocol -> insert-clip"
```

---

## Task 6: Remove fill-body + old template registration; wire transport (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el`
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(ert-deftest org-clipper-test-fill-body-removed ()
  (should-not (fboundp 'org-clipper--fill-body-on-finalize))
  (should-not (boundp 'org-clipper-fill-body)))

(ert-deftest org-clipper-test-transport-defcustom-defaults-orgprotocol ()
  (should (boundp 'org-clipper-transport))
  (should (eq (default-value 'org-clipper-transport) 'org-protocol)))

(ert-deftest org-clipper-test-no-org-capture-template-registration ()
  (should-not (fboundp 'org-clipper-register-capture-template)))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper-transport` unbound (and, if the old file still had them, the removed-symbol assertions fail).

- [ ] **Step 3: Edit `emacs/org-clipper.el`**

Add near the top defcustoms:
```elisp
(defcustom org-clipper-transport 'org-protocol
  "Capture transport: `org-protocol' (default, zero extra process) or `http'
\(opt-in; see Phase 2).  Must match the browser extension's `transport'."
  :type '(choice (const org-protocol) (const http)) :group 'org-clipper)
```
Delete, if present from the old version: `org-clipper-fill-body` (defcustom), `org-clipper--fill-body-on-finalize` (defun), `org-clipper-register-capture-template` (defun) and any `:before-finalize`/`org-capture-templates` wiring. The org-protocol handler from Task 5 is the only capture entry point.

- [ ] **Step 4: Run test to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS (all tests so far).

- [ ] **Step 5: Byte-compile clean, then commit**

Run: `emacs -Q --batch -L emacs -f batch-byte-compile emacs/org-clipper.el`
Expected: no errors; warnings acceptable. Then:
```bash
rm -f emacs/org-clipper.elc
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "refactor(emacs): drop fill-body + org-capture template; add transport defcustom"
```

---

## Task 7: Extension org-protocol transport module

**Files:**
- Create: `extension/src/transport-orgproto.js`
- Delete: `extension/src/capture-url.js` (folded in)
- Test: self-tests inside `transport-orgproto.js` (run with `node`).

- [ ] **Step 1: Write the failing test (self-test block) + module skeleton**

Create `extension/src/transport-orgproto.js`:
```js
// Build + dispatch an `org-protocol://org-clipper?…` URL from a capture payload.
export function buildOrgProtocolUrl(payload = {}) {
  if (!payload.url) throw new Error("buildOrgProtocolUrl: 'url' is required");
  const enc = encodeURIComponent;
  const pairs = [
    ["template", payload.template || "w"],
    ["url", payload.url],
    ["title", (payload.title || "(untitled)").replace(/\s+/g, " ").trim()],
  ];
  if (payload.body)        pairs.push(["body", payload.body]);
  if (payload.tags?.length) pairs.push(["tags", payload.tags.join(",")]);
  for (const k of ["author", "published", "description", "created"]) {
    if (payload[k]) pairs.push([k, String(payload[k])]);
  }
  const qs = pairs.map(([k, v]) => `${k}=${enc(v)}`).join("&");
  return `org-protocol://org-clipper?${qs}`;
}

const isMain = typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const dec = (u, k) => decodeURIComponent(u.match(new RegExp(`[?&]${k}=([^&]*)`))[1]);
  const u = buildOrgProtocolUrl({
    url: "https://x/测试", title: "标题 ☕", body: "*** s\n你好",
    tags: ["clippings", "rust"], author: "David Rosa", description: "Desc.",
  });
  let ok = true;
  const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };
  check(u.startsWith("org-protocol://org-clipper?template=w&"), "scheme + default template");
  check(dec(u, "url") === "https://x/测试", "url round-trips UTF-8");
  check(dec(u, "title") === "标题 ☕", "title round-trips");
  check(dec(u, "tags") === "clippings,rust", "tags csv");
  check(dec(u, "author") === "David Rosa", "author param");
  check(dec(u, "body") === "*** s\n你好", "body round-trips");
  try { buildOrgProtocolUrl({}); check(false, "missing url throws"); }
  catch { check(true, "missing url throws"); }
  process.exitCode = ok ? 0 : 1;
}
```

- [ ] **Step 2: Run to verify it fails (then passes)**

Run: `cd extension && node src/transport-orgproto.js`
Expected: initially you are writing the impl and tests together; run and confirm all `PASS`. If any `FAIL`, fix `buildOrgProtocolUrl` until green.

- [ ] **Step 3: Add the dispatcher (browser-only)**

Append to `transport-orgproto.js`:
```js
// Dispatch in the background service worker: open the URL in a throwaway tab
// (the OS routes it to the handler before the stub tab finishes loading).
export async function dispatchOrgProtocol(payload) {
  const url = buildOrgProtocolUrl(payload);
  const tab = await chrome.tabs.create({ url, active: false });
  await new Promise((r) => setTimeout(r, 1000));
  try { await chrome.tabs.remove(tab.id); } catch {}
  return { ok: true, urlBytes: url.length };
}
```

- [ ] **Step 4: Delete the obsolete module**

Run: `git rm extension/src/capture-url.js`

- [ ] **Step 5: Commit**
```bash
cd .. && git add extension/src/transport-orgproto.js
git commit -m "feat(ext): org-protocol transport module (payload incl. metadata)"
```

---

## Task 8: Transport selector + payload builder (Extension)

**Files:**
- Create: `extension/src/transport.js`
- Modify: `extension/src/background.js`
- Test: self-tests in `transport.js`.

- [ ] **Step 1: Write `transport.js` with a self-test**

Create `extension/src/transport.js`:
```js
import { dispatchOrgProtocol } from "./transport-orgproto.js";
// HTTP transport arrives in Phase 2.
export async function dispatchCapture(payload, cfg = {}) {
  switch (cfg.transport || "org-protocol") {
    case "org-protocol": return dispatchOrgProtocol(payload);
    case "http": throw new Error("HTTP transport not implemented yet (Phase 2)");
    default: throw new Error(`unknown transport: ${cfg.transport}`);
  }
}

const isMain = typeof process !== "undefined" && process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let ok = true; const check = (c, m) => { if (!c) { ok = false; console.error("FAIL:", m); } else console.log("PASS:", m); };
  try { await dispatchCapture({ url: "u" }, { transport: "http" }); check(false, "http throws"); }
  catch (e) { check(/Phase 2/.test(e.message), "http throws Phase-2 error"); }
  try { await dispatchCapture({ url: "u" }, { transport: "nope" }); check(false, "unknown throws"); }
  catch (e) { check(/unknown transport/.test(e.message), "unknown transport throws"); }
  process.exitCode = ok ? 0 : 1;
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd extension && node src/transport.js`
Expected: 2 × PASS. (`dispatchOrgProtocol` is not exercised here — no `chrome` global.)

- [ ] **Step 3: Modify `background.js` — payload builder + dispatch**

In `extension/src/background.js`: replace `import { buildCaptureUrl } from "./capture-url.js";` with `import { dispatchCapture } from "./transport.js";`. Rename `buildCaptureUrlForTab` → `buildCapturePayloadForTab` and have it return a payload object:
```js
async function buildCapturePayloadForTab(tabId, { tags = [], selectionOnly = false } = {}) {
  const cfg = await getConfig();
  const extract = await extractFromTab(tabId);
  const mergedTags = Array.from(new Set([
    ...cfg.defaultTags.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    ...tags,
  ]));
  const body = bodyFromExtract(extract, {
    selectionOnly, headingMin: Number(cfg.headingMin) || DEFAULTS.headingMin,
  });
  return {
    template: cfg.captureTemplate, url: extract.url, title: extract.title,
    body, tags: mergedTags, author: extract.author, published: extract.published,
    description: extract.description, created: (extract.capturedAt || "").slice(0, 10),
  };
}
```
Update the message listener and the `clip-page` command handler to call:
```js
const payload = await buildCapturePayloadForTab(tabId, { tags, selectionOnly });
const cfg = await getConfig();
const r = await dispatchCapture(payload, cfg);   // returns {ok, urlBytes?}
```
Update `DEFAULTS` to include `transport: "org-protocol"` and drop `subprotocol`. Remove `dispatchCaptureUrlFromBackground` and the `self.__orgClipper` line's `buildCaptureUrl` reference.

- [ ] **Step 4: Sanity-run existing md-to-org tests (unchanged) + new transport tests**

Run: `cd extension && node src/md-to-org.js && node src/transport-orgproto.js && node src/transport.js`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
cd .. && git add extension/src/transport.js extension/src/background.js
git commit -m "feat(ext): transport selector + metadata payload builder"
```

---

## Task 9: Popup dispatch via background + options field

**Files:**
- Modify: `extension/src/popup.js`, `extension/src/options.html`, `extension/src/options.js`

- [ ] **Step 1: Simplify `popup.js`**

Remove the hidden-iframe dispatch. The popup sends `CLIP_TAB` and renders the background's `{ ok, urlBytes?, error }`. Delete `els.dispatcher` and the `els.dispatcher.src = resp.url` block; on `resp.ok` show e.g. `Sent to Emacs (${resp.urlBytes ?? ""} bytes).`. Delete the `<iframe id="dispatcher">` from `popup.html`.

- [ ] **Step 2: Add `transport` to options**

In `options.html` add a select:
```html
<label>Transport
  <select id="transport">
    <option value="org-protocol">org-protocol (default)</option>
    <option value="http">HTTP (Phase 2)</option>
  </select>
</label>
```
In `options.js`: add `transport: "org-protocol"` to `DEFAULTS`, remove `subprotocol`, and ensure the select is read/written (it already iterates `FIELDS = Object.keys(DEFAULTS)`; `el.value` handles `<select>`).

- [ ] **Step 3: Manual smoke test**

Load the unpacked extension; with Emacs running and `org-clipper.el` loaded (`(require 'org-clipper)`), clip a page. Expected: a new `** <title>` with the full `:PROPERTIES:` drawer appears under `* Web clips` in the monthly file within ~2 s.

- [ ] **Step 4: Commit**
```bash
git add extension/src/popup.js extension/src/popup.html extension/src/options.html extension/src/options.js
git commit -m "feat(ext): popup status via background; transport option; drop subprotocol"
```

---

## Task 10: README + manifest review

**Files:**
- Modify: `README.md`, `extension/manifest.json`

- [ ] **Step 1: README**

Document the two transports (org-protocol default; HTTP = Phase 2, link the spec), the metadata drawer (`:ID:`/`:SOURCE:`/`:AUTHOR:`/`:PUBLISHED:`/`:CREATED:`/`:DESCRIPTION:`), `org-clipper-default-tags`, and that fill-body is gone. Replace the old `capture` template instructions with `(require 'org-clipper)` (the `org-clipper` sub-protocol auto-registers).

- [ ] **Step 2: Manifest**

`extension/manifest.json` needs no new permission for org-protocol (Phase 1). Leave `host_permissions` out until Phase 2. Confirm `permissions` still `["activeTab","scripting","storage"]`.

- [ ] **Step 3: Full test sweep**

Run:
```bash
cd extension && node src/md-to-org.js && node src/transport-orgproto.js && node src/transport.js && cd ..
emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit
```
Expected: all PASS.

- [ ] **Step 4: Commit**
```bash
git add README.md extension/manifest.json
git commit -m "docs: README for pluggable transport + metadata drawer (Phase 1)"
```

---

## Task 11: Gapless heading normalization (Emacs)

**Files:**
- Modify: `emacs/org-clipper.el` (add `org-clipper--relevel-body`; update `org-clipper--format-entry` to call it)
- Test: `emacs/test/org-clipper-test.el`

- [ ] **Step 1: Write the failing test**

Append:
```elisp
(ert-deftest org-clipper-test-relevel-compresses-gaps ()
  ;; source jumps ** -> **** (h2 -> h4); base 3 => *** -> **** (gapless, no *****)
  (should (equal (org-clipper--relevel-body "** A\n\ntext\n\n**** deep\n\n** B" 3)
                 "*** A\n\ntext\n\n**** deep\n\n*** B")))

(ert-deftest org-clipper-test-relevel-base-follows-level ()
  (should (equal (org-clipper--relevel-body "** A\n\n*** B" 4)
                 "**** A\n\n***** B")))

(ert-deftest org-clipper-test-relevel-ignores-src-blocks ()
  (should (equal (org-clipper--relevel-body "** H\n#+BEGIN_SRC org\n** not-a-heading\n#+END_SRC" 3)
                 "*** H\n#+BEGIN_SRC org\n** not-a-heading\n#+END_SRC")))

(ert-deftest org-clipper-test-insert-clip-headings-contiguous ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (org-clipper--insert-clip (list :title "T" :url "u" :body "** Sec\n\nx\n\n**** Deep"))
     (with-temp-buffer
       (insert-file-contents tmp)
       (let ((s (buffer-string)))
         (should (string-match-p "^\\*\\* T " s))           ; clip title at level 2
         (should (string-match-p "^\\*\\*\\* Sec$" s))       ; body starts at level 3
         (should (string-match-p "^\\*\\*\\*\\* Deep$" s))   ; gap 2->4 compressed to 3->4
         (should-not (string-match-p "^\\*\\*\\*\\*\\* " s))))))) ; no level-5
```

- [ ] **Step 2: Run to verify it fails**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: FAIL — `org-clipper--relevel-body` void; contiguity test fails (body still raw-level).

- [ ] **Step 3: Add `org-clipper--relevel-body` and wire it into `org-clipper--format-entry`**

Add:
```elisp
(defun org-clipper--relevel-body (body base)
  "Re-level Org headings in BODY so the shallowest becomes BASE and nesting is
gapless: each deeper source level maps to parent-output + 1, regardless of
skips.  Lines inside #+BEGIN_.../#+END_... blocks and non-heading lines are
left untouched."
  (let ((stack '()) (in-block nil) out)
    (dolist (ln (split-string body "\n"))
      (cond
       ((string-match "\\`[ \t]*#\\+BEGIN_" ln) (setq in-block t) (push ln out))
       ((string-match "\\`[ \t]*#\\+END_" ln)   (setq in-block nil) (push ln out))
       ((and (not in-block) (string-match "\\`\\(\\*+\\)[ \t]+\\(.*\\)\\'" ln))
        (let ((src (length (match-string 1 ln))) (text (match-string 2 ln)) lvl)
          (while (and stack (> (caar stack) src)) (pop stack))
          (let ((top (car stack)))
            (cond ((null top)        (setq lvl base) (push (cons src base) stack))
                  ((= (car top) src) (setq lvl (cdr top)))
                  (t                 (setq lvl (1+ (cdr top))) (push (cons src lvl) stack))))
          (push (concat (make-string lvl ?*) " " text) out)))
       (t (push ln out))))
    (mapconcat #'identity (nreverse out) "\n")))
```
Then change the body binding in `org-clipper--format-entry` from
```elisp
    (let ((body (or (plist-get clip :body) "")))
```
to
```elisp
    (let ((body (org-clipper--relevel-body (or (plist-get clip :body) "") (1+ level))))
```

- [ ] **Step 4: Run to verify it passes**

Run: `emacs -Q --batch -L emacs -l emacs/test/org-clipper-test.el -f ert-run-tests-batch-and-exit`
Expected: PASS (all). Note: Task 2's `format-entry-full` still passes (its `** body` is releveled to `*** body`, which still satisfies the `string-suffix-p "** body\ntext\n"` check); if you find that brittle, change that test's `:body` to plain text with no heading.

- [ ] **Step 5: Commit**
```bash
git add emacs/org-clipper.el emacs/test/org-clipper-test.el
git commit -m "feat(emacs): gapless heading re-leveling (base = clip-level+1)"
```

---

## Task 12: Emit natural heading levels in md-to-org; drop headingMin (Extension)

**Files:**
- Modify: `extension/src/md-to-org.js`, `extension/src/background.js`, `extension/src/options.html`, `extension/src/options.js`

> Supersedes the `headingMin` usage introduced in Task 8 (`bodyFromExtract`): Emacs now owns level normalization (Task 11), so the browser emits verbatim levels.

- [ ] **Step 1: Update md-to-org self-tests**

In `md-to-org.js` `runTests()`: delete the assertions that use `{ headingShift: … }` or `{ headingMin: … }` (the cases labeled "headingShift pushes level down" and all "headingMin …" cases). Keep `mdToOrg("# Title\n\n## Sub\n\nbody")` → `* Title\n\n** Sub\n\nbody`. Add:
```js
assertEq(mdToOrg("## A\n\n#### Deep"), "** A\n\n**** Deep",
  "heading levels emitted verbatim (Emacs normalizes)");
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node src/md-to-org.js`
Expected: FAIL — `emitHeading` still shifts/floors (and removed-option tests error).

- [ ] **Step 3: Simplify `md-to-org.js`**

Replace the heading-shift machinery (the `let shift = …`, the `let floorLevel = 0;` + `if (typeof options.headingMin …)` block, and the `emitHeading` definition) with:
```js
  const emitHeading = (rawLevel) => "*".repeat(Math.max(1, Math.min(8, rawLevel)));
```
In the blockquote branch change `mdToOrg(body.join("\n"), { headingShift: shift })` to `mdToOrg(body.join("\n"))`. Delete the `findMinHeadingLevel` function entirely.

- [ ] **Step 4: Run to verify it passes**

Run: `cd extension && node src/md-to-org.js`
Expected: PASS.

- [ ] **Step 5: Drop `headingMin` from background + options**

- `background.js`: remove `headingMin` from `DEFAULTS`; `bodyFromExtract` → `return mdToOrg(extract.markdown || "");` (and drop the `headingMin` arg it receives); remove the `headingMin` line in `buildCapturePayloadForTab`.
- `options.html`: remove the heading-min input. `options.js`: remove `headingMin` from `DEFAULTS` and its clamp in `readForm`.

- [ ] **Step 6: Full sweep + commit**

Run: `cd extension && node src/md-to-org.js && node src/transport-orgproto.js && node src/transport.js`
Expected: all PASS.
```bash
cd .. && git add extension/src/md-to-org.js extension/src/background.js extension/src/options.html extension/src/options.js
git commit -m "refactor(ext): emit natural heading levels; drop headingMin (Emacs normalizes)"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage (Phase 1):** transport abstraction (T8/T9 selector + option, T5 emacs handler), default org-protocol (T6), shared `insert-clip` (T4), metadata drawer + `:ID:` (T2/T4), `:SOURCE:` naming + plain-text author + default `clippings` tag (T1/T2/T4), fill-body removal (T6), lean buffer (T3), **gapless heading normalization (T11)**, **md-to-org natural levels + drop headingMin (T12)**. HTTP (spec §6) is intentionally deferred to Phase 2.
- **Risk points to watch:** (a) `org-end-of-meta-data`/`org-current-level` behavior on a freshly-created headline — the T4 prepend test guards it; (b) `org-protocol-parse-parameters` key names for non-standard params (`author`/`tags`/etc.) — the T5 test guards it, adjust the handler to the actual returned keys if needed; (c) `org-id-get-create` writes `~/.emacs.d/.../org-id-locations` — harmless in batch, but tests use temp files so registrations are throwaway.
- **Type/name consistency:** payload keys (`template,url,title,body,tags,author,published,description,created`) are identical across `buildCapturePayloadForTab` (T8), `buildOrgProtocolUrl` (T7), the org-protocol handler (T5), and `org-clipper--insert-clip`/`--format-entry` (T2/T4).
