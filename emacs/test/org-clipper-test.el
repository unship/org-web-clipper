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
