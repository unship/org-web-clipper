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
;;     org-protocol://capture?template=KEY&url=URL&title=TITLE&body=BODY
;;
;; URLs.  Provided you have `org-protocol' loaded and Emacs registered as
;; the OS handler for the `org-protocol' scheme, Emacs receives the URL,
;; parses it, and invokes `org-capture' with the requested template.
;; The built-in `capture' sub-protocol exposes the parameters to your
;; template via the standard placeholders %:link, %:description, %i.
;;
;; This package adds:
;;
;;   * `org-clipper-target-file' - file the starter template captures to;
;;   * `org-clipper-visit-target' - jump to it, with `auto-revert-mode';
;;   * `org-clipper-refile' - refile the most recent clip elsewhere;
;;   * `org-clipper-register-capture-template' - opt-in starter
;;     `org-capture-templates' entry.
;;
;; The package does *not* register its own `org-protocol' sub-protocol;
;; the extension uses the built-in `capture' handler.

;;; Code:

(require 'org)
(require 'org-capture)
(eval-when-compile (require 'subr-x))

(defgroup org-clipper nil
  "Capture web pages clipped by the org-clipper Chrome extension."
  :group 'org
  :prefix "org-clipper-")

(defcustom org-clipper-target-file
  (expand-file-name "inbox.org"
                    (or (bound-and-true-p org-directory) "~/org"))
  "Org file the starter capture template appends clips to.
The Chrome extension's `captureTemplate' setting must match the key of
the template that captures to this file (see
`org-clipper-register-capture-template')."
  :type 'file
  :group 'org-clipper)

(defcustom org-clipper-target-headline "Web clips"
  "Heading under which the starter template files clips."
  :type 'string
  :group 'org-clipper)

(defcustom org-clipper-capture-template-key "w"
  "Key of the `org-capture-templates' entry created by
`org-clipper-register-capture-template'.  Must match the
`captureTemplate' setting in the Chrome extension's options page."
  :type 'string
  :group 'org-clipper)

(defcustom org-clipper-immediate-finish t
  "If non-nil, the starter template uses `:immediate-finish t' so clips
land without raising a capture buffer for confirmation."
  :type 'boolean
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


;;; Capture template registration

;;;###autoload
(defun org-clipper-register-capture-template ()
  "Register an `org-capture' template under
`org-clipper-capture-template-key' that captures clips arriving via
`org-protocol://capture?template=KEY&...' to `org-clipper-target-file'
under `org-clipper-target-headline'.

The template uses the placeholders the built-in `capture' sub-protocol
populates:
  %:description - the page title (with the extension's tag suffix)
  %:link        - the page URL
  %i            - the converted Org body

If a template with the same key already exists it is replaced."
  (interactive)
  (let* ((key  org-clipper-capture-template-key)
         (file org-clipper-target-file)
         (head org-clipper-target-headline)
         (entry
          `(,key "Web clip (org-clipper)" entry
                 (file+headline ,file ,head)
                 ,(concat
                   "* %:description\n"
                   ":PROPERTIES:\n"
                   ":URL:       %:link\n"
                   ":CAPTURED:  %U\n"
                   ":END:\n\n"
                   "%i\n")
                 :empty-lines 1
                 ,@(when org-clipper-immediate-finish
                     '(:immediate-finish t)))))
    (setq org-capture-templates
          (cons entry (assoc-delete-all key org-capture-templates)))))


(provide 'org-clipper)
;;; org-clipper.el ends here
