;;; org-clipper-migrate.el --- one-time migration to one-file-per-clip  -*- lexical-binding: t; -*-

;;; Commentary:

;; A one-time tool that converts existing clips into the one-file-per-page
;; format produced by `org-clipper--insert-clip' (a file-level vulpea node under
;; <clip-root>/YYYY-MM/YYYY-MM-DD/<slug>.org).  Two source shapes are handled:
;;
;;   * inbox daily files (`org-clipper-clip-root'/**.org): `** <title>' clip
;;     headings under a `* Web clips' heading.  Files/headings not under
;;     `* Web clips' (e.g. marginalia datetrees) are ignored.
;;   * `org-clipper-migrate-llvim-dir' (an Obsidian vault folder): one `* <title>'
;;     node per file, with `#+TITLE/#+SOURCE/#+CREATED' keyword fallbacks.
;;
;; Each clip is re-emitted through the shared writer, PRESERVING its `:ID:' (so
;; vulpea links and ID-keyed org-attach attachments keep resolving) and WITHOUT
;; re-fetching images (links are copied verbatim).  Bucketing uses each clip's
;; `:CREATED:' date (fallbacks: PUBLISHED, then file mtime).
;;
;; Duplicates are keyed by `:SOURCE:' and resolved PREFER-INBOX: inbox files are
;; processed before llvim, and the first clip seen for a URL wins; later copies
;; are dropped and logged.  Empty-`:SOURCE:' clips are never deduped.
;;
;; `org-clipper-migrate' is DRY-RUN by default (writes/deletes nothing, returns
;; and displays the plan).  Call with APPLY non-nil to execute; `~/org' is
;; git-tracked, so the result is reviewable with `git diff' and revertable.
;; Files are written with `with-temp-file' (no per-file autosync); run a single
;; `vulpea-db-sync' afterwards to reindex.

;;; Code:

(require 'org-clipper)
(require 'org)
(require 'org-id)

(defcustom org-clipper-migrate-llvim-dir
  (expand-file-name "llvim/Clippings" (or (bound-and-true-p org-directory) "~/org"))
  "Directory of one-file-per-clip Org notes to fold into the inbox."
  :type 'directory :group 'org-clipper)

(defconst org-clipper-migrate--standard-props
  '("ID" "SOURCE" "AUTHOR" "PUBLISHED" "CREATED" "DESCRIPTION"
    "CATEGORY" "ITEM" "FILE" "PRIORITY" "TODO" "TAGS" "ALLTAGS"
    "BLOCKED" "CLOSED" "DEADLINE" "SCHEDULED" "TIMESTAMP" "TIMESTAMP_IA")
  "Drawer keys handled explicitly or org-internal; excluded from extra props.")

(defun org-clipper-migrate--norm-date (s)
  "Strip surrounding <>/[] from date string S; return nil when empty."
  (when (and s (stringp s))
    (let ((d (string-trim (replace-regexp-in-string "[][<>]" "" s))))
      (and (> (length d) 0) d))))

(defun org-clipper-migrate--date-time (s)
  "Parse the first YYYY-MM-DD in S to an Emacs time, or nil."
  (when (and s (string-match "[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}" s))
    (ignore-errors (org-time-string-to-time (match-string 0 s)))))

(defun org-clipper-migrate--created-time (clip)
  "Bucketing time for CLIP: from :created, then :published, then file mtime."
  (or (org-clipper-migrate--date-time (plist-get clip :created))
      (org-clipper-migrate--date-time (plist-get clip :published))
      (let ((f (plist-get clip :src-file)))
        (and f (file-exists-p f) (file-attribute-modification-time (file-attributes f))))
      (current-time)))

(defun org-clipper-migrate--keyword (key)
  "Return the `#+KEY:' value in the current buffer (trimmed), or nil."
  (save-excursion
    (goto-char (point-min))
    (when (re-search-forward (format "^#\\+%s:[ \t]*\\(.*\\)$" (regexp-quote key)) nil t)
      (let ((v (string-trim (match-string 1)))) (and (> (length v) 0) v)))))

(defun org-clipper-migrate--extra-props (props)
  "From alist PROPS (`org-entry-properties' standard) return a keyword plist of
non-standard, non-empty properties, e.g. (:READING_TIME \"5 min\")."
  (let (out)
    (dolist (kv props)
      (let ((k (car kv)) (v (cdr kv)))
        (unless (member (upcase k) org-clipper-migrate--standard-props)
          (when (and v (> (length (string-trim v)) 0))
            (setq out (append out (list (intern (concat ":" (upcase k))) v)))))))
    out))

(defun org-clipper-migrate--heading-body ()
  "Return the body under the heading at point (after its drawer/meta), with
sub-headings at their original levels (the writer re-levels), or \"\"."
  (save-excursion
    (org-back-to-heading t)
    (let ((end (save-excursion (org-end-of-subtree t t) (point))))
      (org-end-of-meta-data t)
      (if (< (point) end)
          (string-trim-right (buffer-substring-no-properties (point) end))
        ""))))

(defun org-clipper-migrate--heading-clip (kind src-file)
  "With point on a clip heading, return a clip plist.  KIND is `inbox' or `llvim'."
  (let* ((title (org-get-heading t t t t))
         (props (org-entry-properties nil 'standard))
         (get (lambda (k) (cdr (assoc-string k props t)))))
    (list :kind kind :src-file src-file
          :id (funcall get "ID")
          :url (or (funcall get "SOURCE") "")
          :title title
          :author (funcall get "AUTHOR")
          :created (org-clipper-migrate--norm-date (funcall get "CREATED"))
          :published (org-clipper-migrate--norm-date (funcall get "PUBLISHED"))
          :description (funcall get "DESCRIPTION")
          :tags (org-get-tags nil t)
          :properties (org-clipper-migrate--extra-props props)
          :body (org-clipper-migrate--heading-body))))

(defun org-clipper-migrate--parse-inbox-file (file)
  "Return the list of clip plists under `* Web clips' in FILE (possibly empty)."
  (with-temp-buffer
    (let ((org-mode-hook nil) (org-inhibit-startup t))
      (insert-file-contents file) (org-mode))
    (let ((clips '()))
      (goto-char (point-min))
      (when (re-search-forward "^\\* +Web clips[ \t]*$" nil t)
        (let ((wc-end (save-excursion (org-back-to-heading t)
                                      (org-end-of-subtree t t) (point))))
          (while (re-search-forward "^\\*\\* " wc-end t)
            (org-back-to-heading t)
            (push (org-clipper-migrate--heading-clip 'inbox file) clips)
            (org-end-of-subtree t t))))
      (nreverse clips))))

(defun org-clipper-migrate--parse-llvim-file (file)
  "Return the single clip plist for llvim FILE, or nil when it has no heading.
Fills :url/:created/:description/:title from `#+SOURCE/#+CREATED/...' keywords
when the heading drawer lacks them."
  (with-temp-buffer
    (let ((org-mode-hook nil) (org-inhibit-startup t))
      (insert-file-contents file) (org-mode))
    (goto-char (point-min))
    (when (re-search-forward "^\\* " nil t)
      (org-back-to-heading t)
      (let ((clip (org-clipper-migrate--heading-clip 'llvim file)))
        (when (string-empty-p (or (plist-get clip :url) ""))
          (setq clip (plist-put clip :url (or (org-clipper-migrate--keyword "SOURCE") ""))))
        (unless (plist-get clip :created)
          (setq clip (plist-put clip :created
                                (org-clipper-migrate--norm-date
                                 (org-clipper-migrate--keyword "CREATED")))))
        (unless (plist-get clip :published)
          (setq clip (plist-put clip :published
                                (org-clipper-migrate--norm-date
                                 (org-clipper-migrate--keyword "PUBLISHED")))))
        (unless (and (plist-get clip :description)
                     (> (length (string-trim (plist-get clip :description))) 0))
          (setq clip (plist-put clip :description (org-clipper-migrate--keyword "DESCRIPTION"))))
        (when (string-empty-p (or (plist-get clip :title) ""))
          (setq clip (plist-put clip :title (or (org-clipper-migrate--keyword "TITLE") ""))))
        clip))))

(defun org-clipper-migrate--planned-path (clip)
  "Pre-collision target path for CLIP (dry-run; does NOT create directories)."
  (let* ((time (org-clipper-migrate--created-time clip))
         (dir (expand-file-name (concat (format-time-string "%Y-%m/%Y-%m-%d" time) "/")
                                org-clipper-clip-root))
         (slug (org-clipper--slug (plist-get clip :title) (plist-get clip :url))))
    (expand-file-name (concat slug ".org") dir)))

(defun org-clipper-migrate--write-clip (clip)
  "Write CLIP as a one-file-per-page node, PRESERVING its :ID:; return the path.
Buckets by `:CREATED:'; copies the body (and any image links) verbatim."
  (let* ((id (or (plist-get clip :id) (org-id-new)))
         (time (org-clipper-migrate--created-time clip))
         (tags (org-clipper--merge-tags (plist-get clip :tags)))
         (path (org-clipper--clip-file-path (plist-get clip :title)
                                            (plist-get clip :url) time))
         (content (org-clipper--clip-file-content
                   id (plist-get clip :title) (plist-get clip :url) tags clip))
         (coding-system-for-write 'utf-8))
    (with-temp-file path (insert content))
    path))

(defun org-clipper-migrate--collect (source-overrides)
  "Collect and classify all source clips.  SOURCE-OVERRIDES is an alist of
\(CLIP-TITLE . URL) filling missing `:SOURCE:'.  Returns a plist plan:
\(:writes WRITES :drops DROPS :no-source NS :errors ERRS :src-files FILES)
where WRITES/DROPS/NS hold clip plists, ERRS holds (file . reason), and FILES
is a hash SRC-FILE -> (total . errored)."
  (let ((seen (make-hash-table :test 'equal))
        (files (make-hash-table :test 'equal))
        (writes '()) (drops '()) (no-source '()) (errors '()))
    (cl-labels
        ((bump (f errored)
           (let ((cell (or (gethash f files) (cons 0 0))))
             (puthash f (cons (1+ (car cell)) (+ (cdr cell) (if errored 1 0))) files)))
         (classify (clip)
           (let ((f (plist-get clip :src-file)))
             ;; apply override for missing url, keyed by the clip's title
             ;; (unique; a daily file holds many clips so its name is not)
             (when (string-empty-p (or (plist-get clip :url) ""))
               (let ((ov (cdr (assoc (plist-get clip :title) source-overrides))))
                 (when ov (setq clip (plist-put clip :url ov)))))
             (cond
              ((string-empty-p (string-trim (or (plist-get clip :title) "")))
               (push (cons f "empty title") errors) (bump f t))
              ((string-empty-p (or (plist-get clip :url) ""))
               (push clip no-source) (push clip writes) (bump f nil))  ; write, flag
              ((gethash (plist-get clip :url) seen)
               (push (cons clip (gethash (plist-get clip :url) seen)) drops) (bump f nil))
              (t (puthash (plist-get clip :url) (plist-get clip :title) seen)
                 (push clip writes) (bump f nil))))))
      ;; INBOX FIRST (prefer-inbox), sorted for determinism.
      (dolist (file (sort (and (file-directory-p org-clipper-clip-root)
                               (directory-files-recursively org-clipper-clip-root "\\.org\\'"))
                          #'string<))
        (condition-case e
            (mapc #'classify (org-clipper-migrate--parse-inbox-file file))
          (error (push (cons file (error-message-string e)) errors) (bump file t))))
      ;; THEN LLVIM.
      (dolist (file (sort (and (file-directory-p org-clipper-migrate-llvim-dir)
                               (directory-files-recursively org-clipper-migrate-llvim-dir "\\.org\\'"))
                          #'string<))
        (condition-case e
            (let ((clip (org-clipper-migrate--parse-llvim-file file)))
              (if clip (classify clip)
                (push (cons file "no heading") errors) (bump file t)))
          (error (push (cons file (error-message-string e)) errors) (bump file t)))))
    (list :writes (nreverse writes) :drops (nreverse drops)
          :no-source (nreverse no-source) :errors (nreverse errors)
          :src-files files)))

(defun org-clipper-migrate--deletable-files (plan)
  "Source files all of whose clips were handled (none errored) -> safe to delete."
  (let ((files (plist-get plan :src-files)) (out '()))
    (maphash (lambda (f cell)
               (when (and (> (car cell) 0) (= (cdr cell) 0)) (push f out)))
             files)
    out))

;;;###autoload
(defun org-clipper-migrate (&optional apply source-overrides)
  "Migrate existing clips into the one-file-per-page layout.
DRY-RUN unless APPLY is non-nil.  SOURCE-OVERRIDES is an alist
\(CLIP-TITLE . URL) used to fill clips that lack `:SOURCE:'.
Returns a summary plist and pops up a `*org-clipper-migrate*' report."
  (interactive "P")
  (let* ((plan (org-clipper-migrate--collect source-overrides))
         (writes (plist-get plan :writes))
         (drops (plist-get plan :drops))
         (no-source (plist-get plan :no-source))
         (errors (plist-get plan :errors))
         (deletable (org-clipper-migrate--deletable-files plan))
         (written 0) (deleted 0))
    (when apply
      (dolist (clip writes)
        (condition-case e (progn (org-clipper-migrate--write-clip clip) (cl-incf written))
          (error (push (cons (plist-get clip :src-file)
                             (format "write failed: %s" (error-message-string e)))
                       errors))))
      ;; Delete sources ONLY when EVERY write succeeded — a partial write must
      ;; never orphan a deletion (no data loss; content always lands first).
      (if (= written (length writes))
          (dolist (f (org-clipper-migrate--deletable-files plan))
            (when (file-exists-p f) (delete-file f) (cl-incf deleted)))
        (push (cons "*" (format "%d of %d writes failed — NO sources deleted"
                                (- (length writes) written) (length writes)))
              errors)))
    (with-current-buffer (get-buffer-create "*org-clipper-migrate*")
      (erase-buffer)
      (insert (format "org-clipper migration — %s\n\n" (if apply "APPLIED" "DRY RUN")))
      (insert (format "  clips to write : %d\n" (length writes)))
      (insert (format "  dup drops      : %d\n" (length drops)))
      (insert (format "  no :SOURCE:     : %d\n" (length no-source)))
      (insert (format "  source files   : %d (deletable: %d)\n"
                      (hash-table-count (plist-get plan :src-files)) (length deletable)))
      (insert (format "  errors         : %d\n" (length errors)))
      (when apply (insert (format "\n  WROTE %d files, DELETED %d sources.\n" written deleted)))
      (when no-source
        (insert "\n— clips missing :SOURCE: (recover via web search) —\n")
        (dolist (c no-source)
          (insert (format "  %s\n    %s\n" (plist-get c :title)
                          (file-name-nondirectory (plist-get c :src-file))))))
      (when drops
        (insert "\n— dropped as duplicate (winner kept) —\n")
        (dolist (d drops)
          (insert (format "  %s  [%s]\n    dup of: %s\n"
                          (plist-get (car d) :title)
                          (file-name-nondirectory (plist-get (car d) :src-file))
                          (cdr d)))))
      (when errors
        (insert "\n— errors (left untouched) —\n")
        (dolist (e errors) (insert (format "  %s\n    → %s\n"
                                           (file-name-nondirectory (car e)) (cdr e)))))
      (goto-char (point-min))
      (display-buffer (current-buffer)))
    (list :writes (length writes) :drops (length drops)
          :no-source (length no-source) :errors (length errors)
          :deletable (length deletable) :written written :deleted deleted
          :no-source-files (mapcar (lambda (c)
                                     (cons (file-name-nondirectory (plist-get c :src-file))
                                           (plist-get c :title)))
                                   no-source)
          :error-list errors)))

(provide 'org-clipper-migrate)
;;; org-clipper-migrate.el ends here
