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

(ert-deftest org-clipper-test-fill-body-removed ()
  (should-not (fboundp 'org-clipper--fill-body-on-finalize))
  (should-not (boundp 'org-clipper-fill-body)))

(ert-deftest org-clipper-test-transport-defcustom-defaults-orgprotocol ()
  (should (boundp 'org-clipper-transport))
  (should (eq (default-value 'org-clipper-transport) 'org-protocol)))

(ert-deftest org-clipper-test-no-org-capture-template-registration ()
  (should-not (fboundp 'org-clipper-register-capture-template)))

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
