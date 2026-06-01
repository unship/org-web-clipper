;;; org-clipper.el --- Emacs companion for the org-clipper Chrome extension  -*- lexical-binding: t; -*-

;; Author: org-clipper contributors
;; Version: 0.2.0
;; Package-Requires: ((emacs "27.1") (org "9.3"))
;; Keywords: hypermedia, org
;; URL: https://github.com/ed/org-clipper

;;; Commentary:

;; This package is the Emacs-side companion to the org-clipper Chrome
;; extension.  The extension dispatches each clip by opening
;;
;;     org-protocol://org-clipper?template=KEY&url=URL&title=TITLE&body=BODY&...
;;
;; URLs.  Provided you have `org-protocol' loaded and Emacs registered as
;; the OS handler for the `org-protocol' scheme, Emacs receives the URL,
;; decodes its parameters, and inserts the clip via the shared capture
;; core `org-clipper--insert-clip' -- a full Obsidian-parity metadata
;; drawer (`:ID:'/`:SOURCE:'/`:AUTHOR:'/`:PUBLISHED:'/`:CREATED:'/
;; `:DESCRIPTION:') is written and the entry is prepended under
;; `org-clipper-target-headline'.  No `org-capture' machinery is used.
;;
;; This package adds:
;;
;;   * `org-clipper-target-file' - file clips are inserted into;
;;   * `org-clipper-visit-target' - jump to it, with `auto-revert-mode';
;;   * `org-clipper-refile' - refile the most recent clip elsewhere.
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
  "Org file clips are inserted into.
When nil, a monthly file under `org-clipper-monthly-dir' is used instead."
  :type 'file
  :group 'org-clipper)

(defcustom org-clipper-target-headline "Web clips"
  "Heading under which clips are filed."
  :type 'string
  :group 'org-clipper)

(defcustom org-clipper-auto-revert t
  "When non-nil, enable `auto-revert-mode' on the target file when it
is visited via `org-clipper-visit-target', so new clips appear without
manual `g'."
  :type 'boolean
  :group 'org-clipper)

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

(defun org-clipper--created-stamp (created)
  "Inactive Org timestamp for CREATED (a date string), or today if empty."
  (if (and created (string-match-p "[0-9]" created))
      (format "[%s]" (string-trim created))
    (format-time-string "[%Y-%m-%d %a]")))

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
    (let ((body (org-clipper--relevel-body (or (plist-get clip :body) "") (1+ level))))
      (concat
       (make-string level ?*) " " (string-trim (or title "(untitled)"))
       (let ((ts (org-clipper--tags-string tags)))
         (if (> (length ts) 0) (concat "  " ts) ""))
       "\n:PROPERTIES:\n"
       (mapconcat (lambda (kv) (format ":%s: %s" (car kv) (cdr kv))) props "\n")
       "\n:END:\n\n"
       (if (string-suffix-p "\n" body) body (concat body "\n"))))))


;;; Target file + lean persistent buffer

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
  "Ensure the target file is visited in a lean, kept-alive buffer; return path.
The lean open binds `org-mode-hook' AND `find-file-hook' to nil so heavy
per-buffer setup (LSP/grammar tools, project/VCS scans, etc.) never runs on --
or blocks the daemon at -- capture time.  Saving still runs normally, so e.g.
org-roam/vulpea autosync is unaffected."
  (let ((file (org-clipper--current-target-file)))
    (when (and org-clipper-lean-capture (not (find-buffer-visiting file)))
      (let ((org-mode-hook nil) (find-file-hook nil) (org-inhibit-startup t))
        (find-file-noselect file)))
    file))


;;; Capture core

(require 'org-id)

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


;;; org-protocol sub-protocol

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


;;; Visiting and refiling

;;;###autoload
(defun org-clipper-visit-target ()
  "Open `org-clipper-target-file', creating it if missing."
  (interactive)
  (let ((file org-clipper-target-file))
    (unless (file-exists-p file)
      (make-directory (file-name-directory file) t)
      (with-temp-buffer (write-region (point-min) (point-max) file)))
    (find-file file)
    (when org-clipper-auto-revert
      (unless (bound-and-true-p auto-revert-mode)
        (auto-revert-mode 1)))))

;;;###autoload
(defun org-clipper-refile ()
  "Refile a clip from `org-clipper-target-file' using `org-refile'.
If point is already on a heading inside the target file, refile that
heading.  Otherwise jump to the most recently appended (last) heading."
  (interactive)
  (let ((in-target
         (and buffer-file-name
              (file-equal-p buffer-file-name org-clipper-target-file))))
    (unless (and in-target (ignore-errors (org-at-heading-p)))
      (org-clipper-visit-target)
      (goto-char (point-max))
      (unless (re-search-backward "^\\* " nil t)
        (user-error "No clips in %s yet" org-clipper-target-file))))
  (org-refile))


(provide 'org-clipper)
;;; org-clipper.el ends here
