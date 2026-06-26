;;; org-clipper-migrate-test.el --- migration tests -*- lexical-binding: t; -*-
(require 'ert)
(add-to-list 'load-path (expand-file-name ".." (file-name-directory (or load-file-name buffer-file-name))))
(require 'org-clipper)
(require 'org-clipper-migrate)

(defconst org-clipper-migrate-test--inbox
  "* Web clips
** 介绍 tenferro-rs  :clippings:
:PROPERTIES:
:SOURCE: https://tensor4all.org/blog/introducing-tenferro-rs-zh/
:CREATED: <2026-06-26>
:ID:       8661d008-55ed-437f-a43f-064e2ff05b4f
:END:

*** 从 Julia 到 Rust
body text here
** Second Clip  :clippings:rust:
:PROPERTIES:
:SOURCE: https://example.com/second
:CREATED: <2026-06-25>
:ID: id-2
:READING_TIME: 5 min
:END:

plain body
")

(defconst org-clipper-migrate-test--llvim
  "#+TITLE: A leap year inequality
#+SOURCE: https://leancrew.com/all-this/2026/03/a-leap-year-inequality/
#+CREATED: 2026-03-21
#+DESCRIPTION: Calculating leap years.
#+TAGS: clippings

* A leap year inequality
:PROPERTIES:
:ID:       ea5f0b71-0987-457a-8faa-2c408c811bca
:SOURCE:   https://leancrew.com/all-this/2026/03/a-leap-year-inequality/
:CREATED:  <2026-03-21 Sat>
:DESCRIPTION: Calculating leap years.
:END:

I've been working through the book.
")

(defconst org-clipper-migrate-test--llvim-no-source
  "#+TITLE: make time slower
#+CREATED: 2026-02-01

* make time slower
:PROPERTIES:
:ID: no-src-id
:CREATED: <2026-02-01>
:END:

some body
")

(defun org-clipper-migrate-test--write (dir name content)
  (let ((f (expand-file-name name dir)))
    (make-directory (file-name-directory f) t)
    (let ((coding-system-for-write 'utf-8)) (write-region content nil f))
    f))

(ert-deftest org-clipper-migrate-test-parse-inbox ()
  (let* ((dir (make-temp-file "oc-mig-in-" t))
         (f (org-clipper-migrate-test--write dir "2026-06/2026-06-26.org"
                                             org-clipper-migrate-test--inbox)))
    (unwind-protect
        (let ((clips (org-clipper-migrate--parse-inbox-file f)))
          (should (= 2 (length clips)))
          (let ((c1 (nth 0 clips)) (c2 (nth 1 clips)))
            (should (equal (plist-get c1 :title) "介绍 tenferro-rs"))
            (should (equal (plist-get c1 :url) "https://tensor4all.org/blog/introducing-tenferro-rs-zh/"))
            (should (equal (plist-get c1 :id) "8661d008-55ed-437f-a43f-064e2ff05b4f"))
            (should (equal (plist-get c1 :created) "2026-06-26"))
            (should (string-match-p "\\`\\*\\*\\* 从 Julia 到 Rust" (plist-get c1 :body)))
            (should (member "rust" (plist-get c2 :tags)))
            (should (equal (plist-get (plist-get c2 :properties) :READING_TIME) "5 min"))))
      (delete-directory dir t))))

(ert-deftest org-clipper-migrate-test-parse-inbox-skips-non-webclips ()
  ;; A marginalia-style datetree (no `* Web clips') yields no clips.
  (let* ((dir (make-temp-file "oc-mig-mg-" t))
         (f (org-clipper-migrate-test--write dir "marginalia.org"
                                             "* 2026-05\n** a quote\nsome text\n")))
    (unwind-protect (should (null (org-clipper-migrate--parse-inbox-file f)))
      (delete-directory dir t))))

(ert-deftest org-clipper-migrate-test-parse-llvim ()
  (let* ((dir (make-temp-file "oc-mig-lv-" t))
         (f (org-clipper-migrate-test--write dir "leap.org" org-clipper-migrate-test--llvim)))
    (unwind-protect
        (let ((c (org-clipper-migrate--parse-llvim-file f)))
          (should (equal (plist-get c :title) "A leap year inequality"))
          (should (equal (plist-get c :url) "https://leancrew.com/all-this/2026/03/a-leap-year-inequality/"))
          (should (equal (plist-get c :id) "ea5f0b71-0987-457a-8faa-2c408c811bca"))
          (should (equal (plist-get c :created) "2026-03-21 Sat"))
          (should (string-match-p "\\`I've been working" (plist-get c :body))))
      (delete-directory dir t))))

(ert-deftest org-clipper-migrate-test-parse-llvim-no-source ()
  (let* ((dir (make-temp-file "oc-mig-ns-" t))
         (f (org-clipper-migrate-test--write dir "slow.org"
                                             org-clipper-migrate-test--llvim-no-source)))
    (unwind-protect
        (let ((c (org-clipper-migrate--parse-llvim-file f)))
          (should (equal (plist-get c :title) "make time slower"))
          (should (equal (plist-get c :url) "")))            ; no SOURCE anywhere
      (delete-directory dir t))))

(ert-deftest org-clipper-migrate-test-created-time-parses-dayname ()
  (should (org-clipper-migrate--created-time '(:created "2026-03-21 Sat")))
  (should (string-match-p "2026-03-21"
                          (format-time-string "%Y-%m-%d"
                                              (org-clipper-migrate--created-time
                                               '(:created "2026-03-21 Sat"))))))

(ert-deftest org-clipper-migrate-test-write-preserves-id-and-buckets ()
  (let* ((root (make-temp-file "oc-mig-w-" t))
         (org-clipper-clip-root root))
    (unwind-protect
        (let ((path (org-clipper-migrate--write-clip
                     (list :id "keep-me-123" :url "https://x/p" :title "Hello World"
                           :created "2026-03-21 Sat" :body "** sec\nbody"))))
          (should (string-match-p "/2026-03/2026-03-21/hello-world\\.org\\'" path))
          (with-temp-buffer
            (insert-file-contents path)
            (let ((s (buffer-string)))
              (should (string-match-p "^:ID: keep-me-123$" s))   ; id preserved
              (should (string-match-p "^:SOURCE: https://x/p$" s))
              (should (string-match-p "^:CREATED: <2026-03-21 Sat>$" s))
              (should (string-match-p "^#\\+title: Hello World$" s))
              (should (string-match-p "^\\* sec$" s)))))         ; body re-leveled
      (delete-directory root t))))

(ert-deftest org-clipper-migrate-test-collect-prefers-inbox-on-dup ()
  ;; Same URL in inbox and llvim: inbox wins, llvim dropped.
  (let* ((inbox (make-temp-file "oc-mig-ci-" t))
         (llvim (make-temp-file "oc-mig-cl-" t))
         (org-clipper-clip-root inbox)
         (org-clipper-migrate-llvim-dir llvim)
         (url "https://dup.example/x"))
    (unwind-protect
        (progn
          (org-clipper-migrate-test--write
           inbox "2026-06/2026-06-26.org"
           (format "* Web clips\n** Dup Inbox  :clippings:\n:PROPERTIES:\n:SOURCE: %s\n:CREATED: <2026-06-26>\n:ID: inbox-id\n:END:\n\nbody\n" url))
          (org-clipper-migrate-test--write
           llvim "dup.org"
           (format "#+TITLE: Dup Llvim\n#+SOURCE: %s\n#+CREATED: 2026-05-01\n\n* Dup Llvim\n:PROPERTIES:\n:ID: llvim-id\n:SOURCE: %s\n:CREATED: <2026-05-01>\n:END:\n\nbody\n" url url))
          (let* ((plan (org-clipper-migrate--collect nil))
                 (writes (plist-get plan :writes))
                 (drops (plist-get plan :drops)))
            (should (= 1 (length writes)))
            (should (eq 'inbox (plist-get (car writes) :kind)))   ; inbox kept
            (should (= 1 (length drops)))
            (should (eq 'llvim (plist-get (caar drops) :kind))))) ; llvim dropped
      (delete-directory inbox t)
      (delete-directory llvim t))))

(ert-deftest org-clipper-migrate-test-collect-no-source-flagged-and-written ()
  (let* ((inbox (make-temp-file "oc-mig-ni-" t))
         (llvim (make-temp-file "oc-mig-nl-" t))
         (org-clipper-clip-root inbox)
         (org-clipper-migrate-llvim-dir llvim))
    (unwind-protect
        (progn
          (org-clipper-migrate-test--write llvim "slow.org"
                                           org-clipper-migrate-test--llvim-no-source)
          (let* ((plan (org-clipper-migrate--collect nil)))
            (should (= 1 (length (plist-get plan :no-source))))
            (should (= 1 (length (plist-get plan :writes)))))     ; written with empty SOURCE
          ;; with an override (keyed by title) the url is filled and not flagged
          (let* ((plan (org-clipper-migrate--collect '(("make time slower" . "https://recovered/url")))))
            (should (= 0 (length (plist-get plan :no-source))))
            (should (equal "https://recovered/url"
                           (plist-get (car (plist-get plan :writes)) :url)))))
      (delete-directory inbox t)
      (delete-directory llvim t))))
