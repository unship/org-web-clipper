;;; org-clipper.el --- Emacs companion for the org-clipper Chrome extension  -*- lexical-binding: t; -*-

;; Author: org-clipper contributors
;; Version: 0.3.0
;; Package-Requires: ((emacs "27.1") (org "9.3"))
;; Keywords: hypermedia, org
;; URL: https://github.com/ed/org-clipper

;;; Commentary:

;; This package is the Emacs-side companion to the org-clipper Chrome
;; extension.  The extension dispatches each clip by opening
;;
;;     org-protocol://org-clipper?template=KEY&url=URL&title=TITLE&body=BODY&...
;;
;; URLs (or POSTing JSON to the local HTTP endpoint).  Each clip becomes its
;; own file -- a file-level vulpea node -- under a date bucket:
;;
;;     <org-clipper-clip-root>/YYYY-MM/YYYY-MM-DD/<slug>.org
;;
;; The file carries a top `:PROPERTIES:' drawer (`:ID:'/`:SOURCE:'/`:AUTHOR:'/
;; `:PUBLISHED:'/`:CREATED:'/`:DESCRIPTION:' + extra template props), a
;; `#+title:' and `#+filetags:', then the converted body.  There is no shared
;; `* Web clips' grouping heading; the file IS the node.  No `org-capture'
;; machinery is used.
;;
;; Before writing, the page's URL is looked up in vulpea by `:SOURCE:'.  If it
;; was already clipped, nothing is written and the existing file's path
;; (relative to `org-directory') is reported -- over the HTTP response (the
;; browser popup shows "Already clipped -> …") or as an Emacs message.
;;
;; This package adds:
;;
;;   * `org-clipper-clip-root' - directory clips are bucketed under;
;;   * `org-clipper-visit-target' - open the clip root in Dired;
;;   * `org-clipper-refile' - refile the current clip elsewhere.
;;
;; The package registers its own `org-clipper' `org-protocol'
;; sub-protocol (the extension's `transport' must match
;; `org-clipper-transport', default `org-protocol').

;;; Code:

(require 'org)
(eval-when-compile (require 'subr-x))

(defgroup org-clipper nil
  "Capture web pages clipped by the org-clipper Chrome extension."
  :group 'org
  :prefix "org-clipper-")

(defcustom org-clipper-transport 'org-protocol
  "Capture transport: `org-protocol' (default, zero extra process) or `http'
\(opt-in; see Phase 2).  Must match the browser extension's `transport'."
  :type '(choice (const org-protocol) (const http)) :group 'org-clipper)

(defcustom org-clipper-target-file
  (expand-file-name "inbox.org"
                    (or (bound-and-true-p org-directory) "~/org"))
  "Deprecated.  Unused since clips became one file per page (see
`org-clipper-clip-root').  Kept defined so existing user configuration that
sets it does not error."
  :type 'file
  :group 'org-clipper)

(defcustom org-clipper-target-headline "Web clips"
  "Deprecated.  No longer used: clips are one file per page with no shared
grouping heading.  Kept defined for backward compatibility."
  :type 'string
  :group 'org-clipper)

(defcustom org-clipper-auto-revert t
  "When non-nil, enable `auto-revert-mode' on a clip file when it is visited
via `org-clipper-visit-target'."
  :type 'boolean
  :group 'org-clipper)

(defcustom org-clipper-default-tags '("clippings")
  "Tags always merged into every clip (newest-first order preserved)."
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

(defun org-clipper--created-stamp (created)
  "Active Org timestamp for CREATED (a date string), or today if empty."
  (if (and created (string-match-p "[0-9]" created))
      (format "<%s>" (string-trim created))
    (format-time-string "<%Y-%m-%d %a>")))

(defun org-clipper--published-stamp (published)
  "Active Org timestamp <YYYY-MM-DD> for PUBLISHED, or nil when empty.
PUBLISHED may be a full ISO datetime (as Defuddle often returns); only the
date is kept.  A non-empty value with no parseable date is passed through
unchanged rather than wrapped, to avoid fabricating an invalid timestamp."
  (when (and published (> (length (string-trim published)) 0))
    (let ((s (string-trim published)))
      (if (string-match "[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}" s)
          (format "<%s>" (match-string 0 s))
        s))))

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

(defun org-clipper--clip-file-content (id title url tags clip)
  "Return the full text of a one-file-per-clip Org node.

A file-level vulpea node: a top `:PROPERTIES:' drawer, then `#+title:',
`#+filetags:', then CLIP's body re-leveled so its shallowest heading is
level 1.  Drawer keys ID, SOURCE and AUTHOR are ALWAYS written (AUTHOR as an
empty value when absent); CREATED is always written; PUBLISHED, DESCRIPTION
and extra template properties are written only when non-empty.  TAGS is a
list.  CLIP is the clip plist (see `org-clipper--insert-clip')."
  (let ((props '()))
    (push (cons "ID" id) props)
    (push (cons "SOURCE" (or url "")) props)
    ;; AUTHOR is always present (empty value when absent) for a uniform schema.
    (push (cons "AUTHOR" (let ((a (plist-get clip :author)))
                           (if a (string-trim a) "")))
          props)
    (let ((published (org-clipper--published-stamp (plist-get clip :published))))
      (when published (push (cons "PUBLISHED" published) props)))
    (push (cons "CREATED" (org-clipper--created-stamp (plist-get clip :created))) props)
    (let ((description (plist-get clip :description)))
      (when (and description (> (length (string-trim description)) 0))
        (push (cons "DESCRIPTION"
                    (replace-regexp-in-string "[\n\r]+" " " (string-trim description)))
              props)))
    ;; Extra (non-standard) template properties, a plist with keyword keys
    ;; (e.g. (:READING_TIME "5 min" :SECTION "News")), appended after the
    ;; standard keys.  Empty values are omitted.
    (let ((extra (plist-get clip :properties)))
      (while extra
        (let ((key (substring (symbol-name (car extra)) 1))
              (val (cadr extra)))
          (when (and (stringp val) (> (length (string-trim val)) 0))
            (push (cons key (replace-regexp-in-string "[\n\r]+" " " (string-trim val)))
                  props)))
        (setq extra (cddr extra))))
    (setq props (nreverse props))
    (let ((body (org-clipper--relevel-body (or (plist-get clip :body) "") 1)))
      (concat
       ":PROPERTIES:\n"
       (mapconcat (lambda (kv)
                    (if (string-empty-p (cdr kv))
                        (format ":%s:" (car kv))     ; empty value: no trailing space
                      (format ":%s: %s" (car kv) (cdr kv))))
                  props "\n")
       "\n:END:\n"
       "#+title: " (string-trim (or title "(untitled)")) "\n"
       "#+filetags: " (org-clipper--tags-string tags) "\n"
       "\n"
       (if (string-suffix-p "\n" body) body (concat body "\n"))))))


;;; Target directory + per-clip file path

(defcustom org-clipper-monthly-dir
  (expand-file-name "inbox" (or (bound-and-true-p org-directory) "~/org"))
  "Deprecated alias kept for backward compatibility; see `org-clipper-clip-root'."
  :type 'directory :group 'org-clipper)

(defcustom org-clipper-clip-root
  (expand-file-name "inbox" (or (bound-and-true-p org-directory) "~/org"))
  "Root directory under which clips are bucketed as YYYY-MM/YYYY-MM-DD/<slug>.org."
  :type 'directory :group 'org-clipper)

(defcustom org-clipper-filename-max-slug 80
  "Maximum length (characters) of the slug used for a clip's file name."
  :type 'integer :group 'org-clipper)

(defcustom org-clipper-lean-capture t
  "Open each clip file with `org-mode-hook' and `find-file-hook' suppressed,
so captures never run heavy org-mode setup or attach LSP/grammar tools.
Saving still runs normally, so vulpea/org-roam autosync is unaffected."
  :type 'boolean :group 'org-clipper)

(defun org-clipper--slug (title url)
  "Return a filesystem slug for TITLE (falling back to URL's host, then
\"untitled\").  Unicode letters and digits are preserved (so CJK titles
survive); every other run of characters collapses to a single hyphen.  The
result is lowercased and truncated to `org-clipper-filename-max-slug' chars."
  (let* ((s (downcase (string-trim (or title ""))))
         (s (replace-regexp-in-string "[^[:alnum:]]+" "-" s))
         (s (replace-regexp-in-string "\\`-+\\|-+\\'" "" s)))
    (when (string-empty-p s)
      (when (and url (string-match "\\`https?://\\([^/?#]+\\)" url))
        (setq s (replace-regexp-in-string
                 "\\`-+\\|-+\\'" ""
                 (replace-regexp-in-string "[^[:alnum:]]+" "-"
                                           (downcase (match-string 1 url)))))))
    (when (string-empty-p s) (setq s "untitled"))
    (when (> (length s) org-clipper-filename-max-slug)
      (setq s (replace-regexp-in-string
               "-+\\'" "" (substring s 0 org-clipper-filename-max-slug))))
    (if (string-empty-p s) "untitled" s)))

(defun org-clipper--bucket-dir (time)
  "Return (creating if needed) the YYYY-MM/YYYY-MM-DD bucket dir under
`org-clipper-clip-root' for TIME."
  (let ((dir (expand-file-name
              (concat (format-time-string "%Y-%m/%Y-%m-%d" time) "/")
              org-clipper-clip-root)))
    (unless (file-directory-p dir) (make-directory dir t))
    dir))

(defun org-clipper--unique-clip-file (dir slug)
  "Return an unused absolute path DIR/SLUG.org, suffixing -2, -3 … on collision."
  (let ((path (expand-file-name (concat slug ".org") dir)) (n 1))
    (while (file-exists-p path)
      (setq n (1+ n)
            path (expand-file-name (format "%s-%d.org" slug n) dir)))
    path))

(defun org-clipper--clip-file-path (title url time)
  "Absolute path the clip for TITLE/URL lands in, bucketed by TIME.  Makes dir."
  (org-clipper--unique-clip-file (org-clipper--bucket-dir time)
                                 (org-clipper--slug title url)))


;;; Duplicate detection (vulpea, by :SOURCE:)

(defvar org-clipper--clipped-this-session (make-hash-table :test 'equal)
  "URL -> path (relative to `org-directory') for clips written this session.
Covers the brief window before vulpea autosync indexes a freshly-saved clip,
so two rapid clips of the same URL are still deduplicated.")

(defun org-clipper--find-by-source (url)
  "Return the absolute path of an existing clip whose `:SOURCE:' equals URL, nil
otherwise.  Checks this session's just-clipped table first (covers autosync
lag), then queries vulpea.  The `vulpea-db-query' scan is O(notes) (~0.4s at a
few thousand notes) but runs at most once per clip; correctness is preferred
over a fragile direct-SQL path."
  (when (and url (> (length url) 0))
    (or (let ((rel (gethash url org-clipper--clipped-this-session)))
          (and rel (expand-file-name rel org-directory)))
        (and (fboundp 'vulpea-db-query)
             (let ((hit (seq-find
                         (lambda (n)
                           (equal url (cdr (assoc-string
                                            "SOURCE" (vulpea-note-properties n)))))
                         (vulpea-db-query))))
               (and hit (vulpea-note-path hit)))))))


;;; Capture core

(require 'org-id)

(defcustom org-clipper-prepend t
  "Deprecated.  No effect now that each clip is its own file."
  :type 'boolean :group 'org-clipper)

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

(defun org-clipper--rewrite-image-links (map)
  "In the current buffer, rewrite [[URL]] and [[URL][desc]] to
[[attachment:FILE]] for each (URL . FILE) in MAP.
Operates buffer-wide: a one-file-per-clip node has no enclosing subtree to
narrow to.  The URL is located with a literal `search-forward', never a
`regexp-quote'd pattern: a rasterized inline SVG (or any inline image)
arrives as a `data:...;base64,' URL that is easily tens of KB to several
MB, and compiling that into a regexp overflows Emacs's pattern-size limit
\(signalling `invalid-regexp' \"Regular expression too big\").  Only the
small, constant link tail \(an optional `][desc]' before the closing
`]]') is matched as a regexp."
  (save-excursion
    (dolist (pair map)
      (let ((needle (concat "[[" (car pair)))
            (repl   (concat "[[attachment:" (cdr pair) "]]")))
        (goto-char (point-min))
        (while (search-forward needle nil t)
          ;; Point now sits just past the URL.  Accept the bare `]]' close
          ;; or an optional `][desc]' first; both forms span from the `[['
          ;; (BEG) to the end of this constant tail match.
          (let ((beg (match-beginning 0)))
            (when (looking-at "\\(?:\\]\\[[^]]*\\)?\\]\\]")
              (delete-region beg (match-end 0))
              (goto-char beg)
              (insert repl))))))))

(defun org-clipper--sanitize-text (s)
  "Return string S stripped of bytes that force Org to be saved as *raw-text*.
Web clips occasionally carry stray control bytes (NUL, form-feed, …) or raw
EIGHT-BIT bytes -- undecodable UTF-8, which Emacs holds as chars
#x3fff80..#x3fffff.  Either one, once written into an Org file, makes Emacs
auto-detect the file as *binary* on the next read and load it UNDECODED --
every multibyte char becomes a raw eight-bit byte, which corrupts downstream
parsers \(vulpea/org-roam) and pops a `select-safe-coding-system' prompt on
the next save.  TAB, LF and CR are preserved; the rest of the C0 range, DEL,
and all eight-bit bytes are removed.  Non-strings pass through untouched."
  (if (stringp s)
      (replace-regexp-in-string
       (rx (any (?\C-@ . ?\C-h) ?\C-k ?\C-l (?\C-n . ?\C-_) ?\C-?
                (#x3fff80 . #x3fffff)))
       "" s t t)
    s))

(defun org-clipper--sanitize-clip (clip)
  "Return a copy of clip plist CLIP with its textual fields sanitized.
Strips control characters (see `org-clipper--sanitize-text') so no clip
can write a NUL into an Org file.  This is the single guard for every
transport: both the `org-protocol' and HTTP handlers funnel through
`org-clipper--insert-clip', which calls this first."
  (let ((out (copy-sequence clip)))
    (dolist (k '(:template :url :title :body :author :published
                 :description :created))
      (when (plist-member out k)
        (setq out (plist-put out k (org-clipper--sanitize-text (plist-get out k))))))
    (when (plist-member out :tags)
      (setq out (plist-put out :tags
                           (mapcar #'org-clipper--sanitize-text (plist-get out :tags)))))
    ;; Extra properties are a plist (:KEY "value" …); sanitize each value.
    (when (plist-member out :properties)
      (let ((src (plist-get out :properties)) (clean '()))
        (while src
          (setq clean (plist-put clean (car src) (org-clipper--sanitize-text (cadr src))))
          (setq src (cddr src)))
        (setq out (plist-put out :properties clean))))
    out))

(defun org-clipper--insert-clip (clip)
  "Write web-clip plist CLIP as a one-file-per-page Org node; return its path.
Plist keys: :template :url :title :body :tags :author :published
:description :created :properties (extra drawer props, a keyword-keyed plist)
:images.  If CLIP's URL is already clipped (matched in vulpea by `:SOURCE:'),
write nothing and return (:duplicate . RELPATH), RELPATH being the existing
file's path relative to `org-directory'.  Otherwise write a file-level vulpea
node with a fresh :ID: under `org-clipper-clip-root' and return its path.
Bypasses org-capture."
  (setq clip (org-clipper--sanitize-clip clip))
  (let* ((url (plist-get clip :url))
         (existing (org-clipper--find-by-source url)))
    (if existing
        (cons :duplicate (file-relative-name existing org-directory))
      (let* ((id    (org-id-new))
             (time  (current-time))
             (tags  (org-clipper--merge-tags (plist-get clip :tags)))
             (path  (org-clipper--clip-file-path (plist-get clip :title) url time))
             (content (org-clipper--clip-file-content
                       id (plist-get clip :title) url tags clip))
             (buf (if org-clipper-lean-capture
                      (let ((org-mode-hook nil) (find-file-hook nil)
                            (org-inhibit-startup t))
                        (find-file-noselect path))
                    (find-file-noselect path))))
        (with-current-buffer buf
          (erase-buffer)
          (insert content)
          (save-buffer)                 ; vulpea autosync indexes on save
          (let ((images (plist-get clip :images)))
            (when images
              (goto-char (point-min))
              (let ((map (org-clipper--attach-images images)))
                (when map
                  (org-clipper--rewrite-image-links map)
                  (save-buffer)))))
          (ignore-errors (org-display-inline-images)))
        (when (buffer-live-p buf)
          (with-current-buffer buf (set-buffer-modified-p nil))
          (kill-buffer buf))
        (puthash url (file-relative-name path org-directory)
                 org-clipper--clipped-this-session)
        path))))


;;; org-protocol sub-protocol

(require 'org-protocol)

(defun org-clipper--protocol-capture (info)
  "Handle `org-protocol://org-clipper?...'.  INFO is the raw query string;
`org-protocol-parse-parameters' percent-decodes each value to UTF-8.  On a
duplicate (no browser channel here), echoes the existing path as a message."
  (let* ((p (org-protocol-parse-parameters info t))
         (tags (let ((tg (plist-get p :tags)))
                 (and tg (split-string tg "[,]+" t "[ \t]+"))))
         (res (org-clipper--insert-clip
               (list :template (plist-get p :template) :url (plist-get p :url)
                     :title (plist-get p :title) :body (or (plist-get p :body) "")
                     :tags tags :author (plist-get p :author)
                     :published (plist-get p :published)
                     :description (plist-get p :description) :created (plist-get p :created)))))
    (when (and (consp res) (eq (car res) :duplicate))
      (message "org-clipper: already clipped → %s" (cdr res)))
    nil))

(add-to-list 'org-protocol-protocol-alist
             '("org-clipper" :protocol "org-clipper"
               :function org-clipper--protocol-capture :kill-client t))


;;; Visiting and refiling

;;;###autoload
(defun org-clipper-visit-target ()
  "Open the clip root directory (`org-clipper-clip-root') in Dired."
  (interactive)
  (let ((dir org-clipper-clip-root))
    (unless (file-directory-p dir) (make-directory dir t))
    (dired dir)))

;;;###autoload
(defun org-clipper-refile ()
  "Refile the clip in the current buffer using `org-refile'.
If point is on a heading, refile it; otherwise move to the file's first
heading.  Most useful when the clip file holds a single node."
  (interactive)
  (unless (derived-mode-p 'org-mode) (user-error "Not an Org buffer"))
  (unless (ignore-errors (org-at-heading-p))
    (goto-char (point-min))
    (unless (re-search-forward "^\\*+ " nil t)
      (user-error "No heading to refile in %s" (or buffer-file-name "this buffer"))))
  (org-refile))


;;; HTTP transport (opt-in: `org-clipper-transport' = `http')
;;
;; A tiny asynchronous 127.0.0.1 HTTP/1.1 endpoint.  The extension POSTs a
;; JSON payload (no URL-length limit -> super-long documents survive); the
;; daemon NEVER blocks (a `make-network-process' :filter handles bytes as they
;; arrive).  Security: bind 127.0.0.1, a shared token in `X-Org-Clipper-Token'
;; (a custom header forces a CORS preflight websites cannot satisfy; a local
;; process would still need the secret), an Origin allow-check, a body-size
;; cap, and the payload is treated strictly as data.  Response is sent only
;; AFTER the clip is saved (accurate success/failure; no silent loss).  A
;; duplicate is reported as HTTP 200 with {"ok":true,"duplicate":true,"path":…}.

(defcustom org-clipper-http-port 17654
  "TCP port for the local HTTP capture endpoint (bound to 127.0.0.1)."
  :type 'integer :group 'org-clipper)

(defcustom org-clipper-http-token-file
  (expand-file-name "org-clipper/token" (or (getenv "XDG_CONFIG_HOME") "~/.config"))
  "File holding the shared secret token for the HTTP transport (chmod 600)."
  :type 'file :group 'org-clipper)

(defcustom org-clipper-http-max-body (* 128 1024 1024)
  "Maximum accepted request-body size in bytes for the HTTP transport."
  :type 'integer :group 'org-clipper)

(defvar org-clipper--http-server nil
  "The HTTP server process, or nil when stopped.")

(defun org-clipper--gen-token ()
  "Generate a fresh random token string."
  (substring (secure-hash 'sha256 (format "%s-%s-%s" (float-time) (emacs-pid) (random)))
             0 40))

(defun org-clipper--http-token ()
  "Return the shared token, generating + persisting one (chmod 600) if absent."
  (let ((f (expand-file-name org-clipper-http-token-file)))
    (unless (and (file-exists-p f) (> (file-attribute-size (file-attributes f)) 0))
      (make-directory (file-name-directory f) t)
      (with-temp-file f (insert (org-clipper--gen-token)))
      (set-file-modes f #o600))
    (string-trim (with-temp-buffer (insert-file-contents f) (buffer-string)))))

(defun org-clipper--http-parse (buf)
  "Parse accumulated request BUF (a unibyte string).
Return (:incomplete) until the whole request is present, then
\(:complete HEADERS BODY-BYTES) with BODY-BYTES exactly Content-Length
bytes, or (:toobig N) when Content-Length exceeds `org-clipper-http-max-body'."
  (let ((sep (string-match "\r\n\r\n" buf)))
    (if (not sep)
        '(:incomplete)
      (let* ((headers (substring buf 0 sep))
             (body-start (+ sep 4))
             (case-fold-search t)
             (clen (and (string-match "^content-length:[ \t]*\\([0-9]+\\)" headers)
                        (string-to-number (match-string 1 headers)))))
        (cond
         ((null clen) (list :complete headers ""))
         ((> clen org-clipper-http-max-body) (list :toobig clen))
         ((>= (- (length buf) body-start) clen)
          (list :complete headers (substring buf body-start (+ body-start clen))))
         (t '(:incomplete)))))))

(defun org-clipper--http-handle (headers body-bytes)
  "Validate request (HEADERS string + BODY-BYTES unibyte) and, if OK, insert
the clip.  Return (CODE MESSAGE &optional EXTRA-PLIST); EXTRA carries
\(:duplicate t :path REL) for a duplicate.  Treats the payload strictly as data."
  (let ((case-fold-search t))
    (cond
     ((not (string-match "\\`POST[ \t]+/capture\\(?:[ \t?]\\|\\'\\)" headers))
      (list 404 "not found"))
     ((let ((tok (and (string-match "^x-org-clipper-token:[ \t]*\\([^\r\n]*\\)" headers)
                      (string-trim (match-string 1 headers)))))
        (not (and tok (> (length tok) 0) (string= tok (org-clipper--http-token)))))
      (list 403 "bad token"))
     ((let ((origin (and (string-match "^origin:[ \t]*\\([^\r\n]*\\)" headers)
                         (string-trim (match-string 1 headers)))))
        (and origin (> (length origin) 0)
             (not (string-prefix-p "chrome-extension://" origin))))
      (list 403 "bad origin"))
     (t
      (condition-case e
          (let* ((json (decode-coding-string body-bytes 'utf-8))
                 (p (json-parse-string json :object-type 'plist :array-type 'list
                                       :null-object nil))
                 (clip (list :template (plist-get p :template) :url (plist-get p :url)
                             :title (plist-get p :title) :body (or (plist-get p :body) "")
                             :tags (plist-get p :tags) :author (plist-get p :author)
                             :published (plist-get p :published)
                             :description (plist-get p :description)
                             :created (plist-get p :created)
                             :properties (plist-get p :properties)
                             :images (plist-get p :images))))
            (unless (and (plist-get clip :url) (> (length (plist-get clip :url)) 0))
              (error "missing url"))
            (let ((res (org-clipper--insert-clip clip)))  ; saves -> ACK-after-save
              (if (and (consp res) (eq (car res) :duplicate))
                  (list 200 "duplicate" (list :duplicate t :path (cdr res)))
                (list 200 "ok"))))
        (error (list 500 (error-message-string e))))))))

(defun org-clipper--http-respond (proc code message &optional extra)
  "Write an HTTP response to PROC and close it.
EXTRA is an optional plist; (:duplicate t :path REL) emits a 200 body of
{\"ok\":true,\"duplicate\":true,\"path\":REL}."
  (let* ((okp (= code 200))
         (reason (pcase code (200 "OK") (403 "Forbidden") (404 "Not Found")
                        (413 "Payload Too Large") (_ "Internal Server Error")))
         (msg (replace-regexp-in-string "[\"\\\n\r\t]" " " (format "%s" message)))
         (json (cond
                ((and okp (plist-get extra :duplicate))
                 (json-serialize (list :ok t :duplicate t
                                       :path (or (plist-get extra :path) ""))))
                (okp "{\"ok\":true}")
                (t (format "{\"ok\":false,\"error\":\"%s\"}" msg))))
         (body (encode-coding-string json 'utf-8))
         (head (format (concat "HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\n"
                               "Connection: close\r\nContent-Length: %d\r\n\r\n")
                       code reason (length body))))
    (ignore-errors
      (process-send-string proc (concat (encode-coding-string head 'utf-8) body)))
    (process-put proc 'oc-buf nil)
    (ignore-errors (delete-process proc))))

(defun org-clipper--http-filter (proc chunk)
  "Accumulate request bytes on PROC; dispatch once a full request arrives."
  (process-put proc 'oc-buf (concat (process-get proc 'oc-buf) chunk))
  (pcase (org-clipper--http-parse (process-get proc 'oc-buf))
    (`(:toobig . ,_) (org-clipper--http-respond proc 413 "payload too large"))
    (`(:complete ,headers ,body)
     (let ((res (org-clipper--http-handle headers body)))
       (org-clipper--http-respond proc (nth 0 res) (nth 1 res) (nth 2 res))))
    (_ nil)))

;;;###autoload
(defun org-clipper-start ()
  "Start the local HTTP capture endpoint on 127.0.0.1:`org-clipper-http-port'."
  (interactive)
  (org-clipper-stop)
  (org-clipper--http-token)             ; ensure the token file exists
  (setq org-clipper--http-server
        (make-network-process
         :name "org-clipper-http" :server t :host "127.0.0.1"
         :service org-clipper-http-port :family 'ipv4
         :coding 'binary :noquery t :filter #'org-clipper--http-filter))
  (when (called-interactively-p 'any)
    (message "org-clipper: HTTP endpoint live on 127.0.0.1:%d" org-clipper-http-port))
  org-clipper--http-server)

;;;###autoload
(defun org-clipper-stop ()
  "Stop the local HTTP capture endpoint."
  (interactive)
  (when (process-live-p org-clipper--http-server)
    (delete-process org-clipper--http-server))
  (setq org-clipper--http-server nil))

;;;###autoload
(defun org-clipper-show-token ()
  "Print (and copy) the HTTP shared token, for pasting into the extension."
  (interactive)
  (let ((tok (org-clipper--http-token)))
    (when (called-interactively-p 'any)
      (kill-new tok)
      (message "org-clipper token (copied to kill-ring): %s" tok))
    tok))



;;; Remote image preview + localize

;; Preview overlays remote image links inline (display-only); localize
;; downloads them and rewrites [[url]] -> [[attachment:FILE]] so clipped
;; articles stop depending on live CDN links.  Complements the base64
;; payload path in `org-clipper--attach-images'; reuses
;; `org-clipper--attach-filename'.

(defcustom org-clipper-image-cache-dir
  (expand-file-name "org-clipper-images/" temporary-file-directory)
  "Directory used to cache downloaded remote images.  Files are named
by MD5 of the URL plus the original extension."
  :type 'directory)

(defcustom org-clipper-image-max-width 720
  "Max-width (pixels) for inline previews of remote images."
  :type 'integer)

(defconst org-clipper--remote-image-link-re
  "\\[\\[\\(https?://[^][[:space:]]+\\.\\(?:png\\|jpe?g\\|gif\\|webp\\|svg\\|avif\\|bmp\\)\\(?:\\?[^][]*\\)?\\)\\(?:\\]\\[\\([^]]*\\)\\]\\)?\\]\\]"
  "Match an Org link whose URL is a remote image.
Capture 1: the URL.  Capture 2 (optional): the description.  Both the
plain `[[url]]' and the descriptive `[[url][desc]]' forms are caught.")

(defun org-clipper--cached-image-path (url)
  "Return the cache path where URL would be stored (independent of
whether the file exists yet)."
  (let ((ext (or (file-name-extension
                  (url-filename (url-generic-parse-url url)))
                 "img")))
    (expand-file-name (concat (md5 url) "." ext)
                      org-clipper-image-cache-dir)))

(defun org-clipper--make-image-overlay (buf link-beg link-end local-path)
  "Place an image overlay in BUF spanning [LINK-BEG, LINK-END] showing
the image at LOCAL-PATH."
  (when (and (buffer-live-p buf) (file-exists-p local-path))
    (with-current-buffer buf
      (when (and (<= link-beg (point-max))
                 (<= link-end (point-max)))
        (let* ((img (create-image local-path nil nil
                                  :max-width  org-clipper-image-max-width
                                  :max-height org-clipper-image-max-width))
               (ov  (make-overlay link-beg link-end)))
          (overlay-put ov 'display img)
          (overlay-put ov 'face 'default)
          (overlay-put ov 'keymap image-map)
          (overlay-put ov 'org-clipper-image-overlay t)
          (overlay-put ov 'modification-hooks
                       (list (lambda (ov &rest _) (delete-overlay ov)))))))))

(defun org-clipper--fetch-and-overlay-async (url buf link-beg link-end)
  "Asynchronously fetch URL into the cache then place an overlay
in BUF over [LINK-BEG, LINK-END].  Never blocks: uses
`url-retrieve' which schedules a process and returns immediately,
so the daemon stays responsive even on slow / dead URLs."
  (let ((local (org-clipper--cached-image-path url)))
    (if (file-exists-p local)
        (org-clipper--make-image-overlay buf link-beg link-end local)
      (url-retrieve
       url
       (lambda (status &rest _)
         (cond
          ((plist-get status :error)
           (message "org-clipper: failed %s: %s" url (plist-get status :error)))
          (t
           (goto-char (point-min))
           (when (re-search-forward "\r?\n\r?\n" nil t)  ; skip HTTP headers
             (let ((coding-system-for-write 'binary))
               (write-region (point) (point-max) local nil 'silent)))
           (kill-buffer (current-buffer))
           (org-clipper--make-image-overlay buf link-beg link-end local))))
       nil 'silent 'inhibit-cookies))))

;;;###autoload
(defun org-clipper-preview-remote-images (&optional beg end)
  "Asynchronously fetch + overlay remote image links between BEG and
END (default: whole buffer).  Idempotent: removes any prior overlays we
laid down first.  Fetches happen via `url-retrieve' so this command
returns immediately and the daemon never blocks on slow URLs — images
appear as their downloads complete."
  (interactive)
  (unless (file-directory-p org-clipper-image-cache-dir)
    (make-directory org-clipper-image-cache-dir t))
  (let ((beg (or beg (point-min)))
        (end (or end (point-max)))
        (buf (current-buffer))
        (queued 0))
    (dolist (ov (overlays-in beg end))
      (when (overlay-get ov 'org-clipper-image-overlay)
        (delete-overlay ov)))
    (save-excursion
      (goto-char beg)
      (while (re-search-forward org-clipper--remote-image-link-re end t)
        (org-clipper--fetch-and-overlay-async
         (match-string 1) buf (match-beginning 0) (match-end 0))
        (cl-incf queued)))
    (when (called-interactively-p 'any)
      (message "org-clipper: %d image%s queued" queued (if (= queued 1) "" "s")))
    queued))

;;;###autoload
(defun org-clipper-toggle-image-at-point ()
  "Toggle inline preview of the remote image link at point.
Intended for `org-ctrl-c-ctrl-c-hook': returns non-nil when it
handled point, nil otherwise (so org's other C-c C-c actions still
run on non-image links). Mirrors `markdown-toggle-inline-images'."
  (let ((elem (and (derived-mode-p 'org-mode) (org-element-context))))
    (when (and elem
               (eq (org-element-type elem) 'link)
               (member (org-element-property :type elem) '("http" "https"))
               (string-match-p
                "\\.\\(?:png\\|jpe?g\\|gif\\|webp\\|svg\\|avif\\|bmp\\)\\(?:\\?[^]]*\\)?\\'"
                (or (org-element-property :path elem) "")))
      (let* ((url (concat (org-element-property :type elem) ":"
                          (org-element-property :path elem)))
             (beg (org-element-property :begin elem))
             ;; :end usually includes trailing whitespace; trim so the
             ;; overlay doesn't swallow the following blank line.
             (end (save-excursion
                    (goto-char (org-element-property :end elem))
                    (skip-chars-backward " \t\n")
                    (point)))
             (existing nil))
        (dolist (ov (overlays-in beg end))
          (when (overlay-get ov 'org-clipper-image-overlay)
            (delete-overlay ov)
            (setq existing t)))
        (if existing
            (message "Image preview hidden.")
          (unless (file-directory-p org-clipper-image-cache-dir)
            (make-directory org-clipper-image-cache-dir t))
          (org-clipper--fetch-and-overlay-async url (current-buffer) beg end)
          (message "Loading image preview…"))
        t))))

;;;; --- Localize remote images into org attachments --------------------
;;;; `org-clipper-preview-remote-images' only *overlays* remote images; this
;;;; downloads them and rewrites each `[[https://…]]' to `[[attachment:FILE]]'
;;;; the same way the capture flow does, so clipped articles stop depending on
;;;; live CDN links.  Storage follows the repo convention: the surrounding
;;;; entry's ID-bucketed org-attach dir (resolved via inheritance).

(defun org-clipper--image-source-url (url)
  "Resolve URL to the underlying image URL, unwrapping CDN/proxy wrappers.
Image proxies either pass the real URL in a `url=' query parameter
(Next.js `/_next/image', Vercel, …) or embed its percent-encoded form in
their own path (Substack `image/fetch/…').  Return that inner URL when
present, else URL unchanged.  Used only to derive a meaningful filename
and extension — the original URL is still what gets fetched."
  (require 'url-util)
  (cond
   ;; Proxy passes the real URL in a ?url= query param (Next.js, Vercel…).
   ((string-match "[?&]url=\\(https?%3[Aa]%2[Ff]%2[Ff][^&]+\\|https?://[^&]+\\)" url)
    (url-unhex-string (match-string 1 url)))
   ;; Proxy embeds the percent-encoded real URL in its own path (Substack…):
   ;; after decoding, take everything from the LAST http(s):// occurrence.
   (t
    (let ((decoded (url-unhex-string url)))
      (if (and (string-match ".*\\(https?://\\)" decoded)
               (> (match-beginning 1) 0))
          (substring decoded (match-beginning 1))
        url)))))

(defconst org-clipper--image-extension-re
  "\\.\\(?:png\\|jpe?g\\|gif\\|webp\\|svg\\|avif\\|bmp\\|tiff?\\|heic\\)\\'"
  "Match a trailing image-file extension.")

(defun org-clipper--image-url-p (url)
  "Non-nil when bare link URL is worth fetching as an image.
True when the resolved source URL's path carries an image extension, the
URL has a `format=<imgext>' query (Twitter media), or the host is a known
image CDN/proxy.  The Content-Type check at download time is the final
authority; this only avoids fetching obvious non-images (article links)."
  (require 'url-parse)
  (or
   ;; Inline data image: definitionally an image.  Checked first so a
   ;; megabyte-long URL never reaches `--image-source-url' (which url-unhexes
   ;; the whole string).
   (string-prefix-p "data:image/" url)
   (save-match-data                    ; `--image-source-url' uses `string-match'
     (let* ((src  (org-clipper--image-source-url url))
            (path (car (url-path-and-query (url-generic-parse-url src))))
            (case-fold-search t))
       (or (string-match-p org-clipper--image-extension-re (or path ""))
           (string-match-p "[?&]format=\\(?:png\\|jpe?g\\|gif\\|webp\\|avif\\)\\b" url)
           (string-match-p "\\`https?://\\(?:pbs\\.twimg\\.com\\|miro\\.medium\\.com\\|[^/]*\\.substackcdn\\.com\\)/" url)
           (string-match-p "/_next/image\\?" url))))))

(defun org-clipper--content-type-extension (content-type)
  "Map an HTTP CONTENT-TYPE header value to a file extension, or nil.
Parameters after `;' are ignored and matching is case-insensitive.  A nil
or non-image type yields nil, which the caller also uses as the \"this is
not really an image\" guard."
  (when (stringp content-type)
    (cdr (assoc (downcase (string-trim (car (split-string content-type ";"))))
                '(("image/jpeg"     . "jpg")
                  ("image/jpg"      . "jpg")
                  ("image/png"      . "png")
                  ("image/webp"     . "webp")
                  ("image/gif"      . "gif")
                  ("image/svg+xml"  . "svg")
                  ("image/avif"     . "avif")
                  ("image/bmp"      . "bmp")
                  ("image/x-ms-bmp" . "bmp")
                  ("image/tiff"     . "tiff"))))))

(defcustom org-clipper-localize-user-agent
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  "User-Agent sent when downloading remote images, so hotlink-sensitive
hosts (Twitter, Medium, …) don't reject the fetch."
  :type 'string :group 'org-clipper)

(defun org-clipper--download-image (url)
  "Fetch URL synchronously.  Return (CONTENT-TYPE . TEMPFILE) on a 2xx
response with a body — TEMPFILE holds the raw bytes — or nil on any
failure.  Follows redirects and sends a desktop User-Agent so hotlink-
sensitive CDNs cooperate."
  (require 'url)
  (let* ((url-request-extra-headers
          (list (cons "User-Agent" org-clipper-localize-user-agent)))
         (url-mime-accept-string "image/avif,image/webp,image/png,image/*,*/*;q=0.8")
         (url-mime-encoding-string "identity") ; raw image bytes, never gzip
         (buf (ignore-errors (url-retrieve-synchronously url t t 30))))
    (when (buffer-live-p buf)
      (unwind-protect
          (with-current-buffer buf
            (goto-char (point-min))
            (let ((status (and (looking-at "HTTP/[0-9.]+ +\\([0-9]+\\)")
                               (string-to-number (match-string 1))))
                  (ctype nil))
              (save-excursion
                (when (re-search-forward "^Content-Type:[ \t]*\\(.*?\\)[ \t]*$" nil t)
                  (setq ctype (match-string 1))))
              (when (and status (>= status 200) (< status 300)
                         (re-search-forward "\r?\n\r?\n" nil t)
                         (< (point) (point-max)))
                (let ((tmp (make-temp-file "oclr-img-"))
                      (coding-system-for-write 'binary))
                  (write-region (point) (point-max) tmp nil 'silent)
                  (cons ctype tmp)))))
        (kill-buffer buf)))))

(defun org-clipper--abbrev-url (url &optional n)
  "URL truncated to N characters (default 70) for logging.
A clipped `data:' URL can be megabytes long; never echo it whole."
  (let ((n (or n 70)))
    (if (and (stringp url) (> (length url) n)) (concat (substring url 0 n) "…") url)))

(defun org-clipper--data-url-to-tempfile (url)
  "Decode a base64 `data:' URL into a temp file, with NO network access.
Return (CONTENT-TYPE . TEMPFILE) on success, else nil — for a non-`data:'
URL, a non-base64 (percent-encoded) one, or any decode failure.  This is
the inline-image counterpart to `org-clipper--download-image': both yield
the same shape so the localize loop treats them identically."
  (save-match-data
    (when (string-prefix-p "data:" url)
      (let ((comma (string-match "," url)))
        (when comma
          (let* ((meta (substring url 5 comma))     ; e.g. "image/png;base64"
                 (ct   (car (split-string meta ";"))))   ; "image/png"
            (when (string-match-p ";base64" meta)
              (ignore-errors
                (let ((bytes (base64-decode-string (substring url (1+ comma))))
                      (tmp   (make-temp-file "oclr-data-"))
                      (coding-system-for-write 'binary))
                  (with-temp-file tmp
                    (set-buffer-multibyte nil)
                    (insert bytes))
                  (cons ct tmp))))))))))

(defun org-clipper--acquire-image (url)
  "Obtain image bytes for URL as (CONTENT-TYPE . TEMPFILE), or nil.
Inline `data:' URLs are decoded locally; everything else is downloaded."
  (if (string-prefix-p "data:" url)
      (org-clipper--data-url-to-tempfile url)
    (org-clipper--download-image url)))

(defun org-clipper--collect-image-links (beg end)
  "Return a list of (URL START END) for bare remote image links between
BEG and END in the current buffer, in buffer order.  START and END are
*markers* on the whole `[[…]]' link, created up front so they track the
rewrites done while the list is processed — converting an earlier link
must not shift a later link's span (else the file is corrupted).  The
buffer positions are read before the image predicate runs, so its internal
`string-match' use cannot leak into the caller's match data."
  (let ((acc '()))
    (save-excursion
      (goto-char beg)
      (while (re-search-forward "\\[\\[\\(\\(?:https?://\\|data:\\)[^][]+\\)\\]\\]" end t)
        (let ((url (match-string-no-properties 1))
              (mb  (match-beginning 0))
              (me  (match-end 0)))
          (when (org-clipper--image-url-p url)
            (push (list url (copy-marker mb) (copy-marker me)) acc)))))
    (nreverse acc)))

;;;###autoload
(defun org-clipper-localize-remote-images (&optional beg end)
  "Turn bare inline image links into org attachments.

Scan the buffer (or the active region BEG..END) for *bare* image links —
`[[url][desc]]' reference links are left alone — attach each to the
surrounding entry (its inherited ID-bucketed `org-attach' dir, matching
the repo's `[[attachment:…]]' convention), and rewrite the link to
`[[attachment:FILE]]'.  Two link kinds are handled:

  * `[[https://…]]' remote images — downloaded; and
  * `[[data:image/…;base64,…]]' inline images — decoded locally (no
    network).  This rescues a `data:' link already written into a file,
    e.g. by a pre-fix failed clip; such links are also what makes
    `org-element' \(and so Vulpea/org-roam) stack-overflow when long.

Comprehensive: Twitter media, Next.js image proxies and extension-less CDN
images are handled, with the file extension taken from the response
Content-Type.  A fetch that isn't a 2xx image is skipped untouched and
listed in `*org-localize-remote-images*'.  Idempotent and safe to re-run;
`~/org' is git-tracked, so results are reviewable."
  (interactive (when (use-region-p)
                 (list (region-beginning) (region-end))))
  (require 'org-attach)
  (require 'org-clipper)
  (require 'url-parse)
  (unless (derived-mode-p 'org-mode) (user-error "Not an Org buffer"))
  (let ((beg (or beg (point-min)))
        (end (or end (point-max)))
        (n-done 0) (skipped '()))
    ;; Collect first; markers track positions across the rewrites below.
    (dolist (link (org-clipper--collect-image-links beg end))
      (let ((url  (nth 0 link))
            (mbeg (nth 1 link))         ; markers from collection; they track
            (mend (nth 2 link)))        ; edits, so later links stay on target
        (message "org-clipper: localizing %s …" (org-clipper--abbrev-url url))
        (condition-case err
            (let ((dl (org-clipper--acquire-image url)))
              (cond
               ((null dl) (push (cons (org-clipper--abbrev-url url) "could not read image") skipped))
               ((not (org-clipper--content-type-extension (car dl)))
                (ignore-errors (delete-file (cdr dl)))
                (push (cons (org-clipper--abbrev-url url)
                            (format "not an image (%s)" (or (car dl) "no Content-Type")))
                      skipped))
               (t
                (let ((ext (org-clipper--content-type-extension (car dl)))
                      (tmp (cdr dl)))
                  (save-excursion
                    (goto-char mbeg)
                    (let* ((dir (or (org-attach-dir)
                                    (progn (org-back-to-heading t)
                                           (org-id-get-create)
                                           (org-attach-dir-get-create))))
                           (used (let ((h (make-hash-table :test 'equal)))
                                   (dolist (f (ignore-errors
                                                (directory-files dir nil "\\`[^.]"))
                                              h)
                                     (puthash f t h))))
                           ;; A `data:' URL has no meaningful path; never feed
                           ;; the (possibly megabyte-long) string to the parser.
                           (stem (if (string-prefix-p "data:" url) "image"
                                   (file-name-base
                                    (or (car (url-path-and-query
                                              (url-generic-parse-url
                                               (org-clipper--image-source-url url))))
                                        ""))))
                           (stem (if (string-empty-p stem) "image" stem))
                           (name (org-clipper--attach-filename
                                  (concat stem "." ext) used))
                           (dest (expand-file-name name dir)))
                      (copy-file tmp dest t)
                      (ignore-errors (delete-file tmp))
                      (goto-char mbeg)
                      (delete-region mbeg mend)
                      (insert (concat "[[attachment:" name "]]"))
                      (cl-incf n-done)))))))
          (error (push (cons (org-clipper--abbrev-url url) (error-message-string err)) skipped)))
        (set-marker mbeg nil)
        (set-marker mend nil)))
    (when (derived-mode-p 'org-mode)
      (ignore-errors (org-display-inline-images nil t)))
    (when skipped
      (with-current-buffer (get-buffer-create "*org-localize-remote-images*")
        (erase-buffer)
        (insert (format "Skipped %d remote image(s):\n\n" (length skipped)))
        (dolist (s (nreverse skipped))
          (insert (format "  %s\n    → %s\n" (car s) (cdr s))))
        (goto-char (point-min))
        (display-buffer (current-buffer))))
    (message "org-clipper: localized %d image%s%s"
             n-done (if (= n-done 1) "" "s")
             (if skipped (format ", skipped %d (see *org-localize-remote-images*)"
                                 (length skipped))
               ""))
    (list :localized n-done :skipped (length skipped))))

(provide 'org-clipper)
;;; org-clipper.el ends here
