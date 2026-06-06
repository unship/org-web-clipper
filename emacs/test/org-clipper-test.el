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
    (should (string-match-p "^:CREATED: <2026-03-28>$" txt))
    (should (string-match-p "^:DESCRIPTION: A SPSC queue.$" txt))
    (should-not (string-match-p ":PUBLISHED:" txt))   ; empty omitted
    (should (string-suffix-p "** body\ntext\n" txt))))

(ert-deftest org-clipper-test-created-defaults-to-today ()
  (should (string-match-p "\\`<[0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}"
                          (org-clipper--created-stamp nil))))

(ert-deftest org-clipper-test-published-stamp-active ()
  (should (equal (org-clipper--published-stamp "2024-01-15") "<2024-01-15>")))

(ert-deftest org-clipper-test-published-stamp-normalizes-iso-datetime ()
  ;; Defuddle often hands back a full ISO datetime; keep only the date.
  (should (equal (org-clipper--published-stamp "2024-01-15T08:00:00.000Z")
                 "<2024-01-15>")))

(ert-deftest org-clipper-test-published-stamp-empty-is-nil ()
  ;; nil => caller omits the :PUBLISHED: property entirely.
  (should (null (org-clipper--published-stamp nil)))
  (should (null (org-clipper--published-stamp "")))
  (should (null (org-clipper--published-stamp "   "))))

(ert-deftest org-clipper-test-published-stamp-passes-through-non-date ()
  ;; No parseable date => keep the raw value rather than fabricate a stamp.
  (should (equal (org-clipper--published-stamp "  sometime in 2024 ") "sometime in 2024")))

(ert-deftest org-clipper-test-format-entry-published-and-created-active ()
  (let ((txt (org-clipper--format-entry
              2 "T" '("clippings")
              (list :url "u" :published "2024-01-15T08:00:00.000Z"
                    :created "2026-03-28" :body "x"))))
    (should (string-match-p "^:PUBLISHED: <2024-01-15>$" txt))
    (should (string-match-p "^:CREATED: <2026-03-28>$" txt))))

(ert-deftest org-clipper-test-format-entry-extra-properties ()
  "Non-standard template properties land in the drawer, after the standard keys."
  (let ((txt (org-clipper--format-entry
              2 "T" '("clippings")
              (list :url "https://x" :created "2026-03-28" :body "x"
                    :properties '(:READING_TIME "5 min" :SECTION "News")))))
    (should (string-match-p "^:READING_TIME: 5 min$" txt))
    (should (string-match-p "^:SECTION: News$" txt))
    (should (string-match-p "^:SOURCE: https://x$" txt))
    (should (< (string-match ":SOURCE:" txt) (string-match ":READING_TIME:" txt)))))

(ert-deftest org-clipper-test-format-entry-skips-empty-extra-properties ()
  (let ((txt (org-clipper--format-entry
              2 "T" nil
              (list :url "u" :created "2026-03-28" :body "x"
                    :properties '(:EMPTY "" :KEEP "v")))))
    (should-not (string-match-p ":EMPTY:" txt))
    (should (string-match-p "^:KEEP: v$" txt))))

(ert-deftest org-clipper-test-sanitize-clip-strips-control-chars-from-properties ()
  (let ((out (org-clipper--sanitize-clip
              (list :title "t"
                    :properties (list :K (concat "a" (char-to-string ?\C-@) "b"))))))
    (should (equal (plist-get (plist-get out :properties) :K) "ab"))))

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


;;; --- Phase 2: HTTP transport ---

(defmacro org-clipper-test--with-token (&rest body)
  "Run BODY with a throwaway HTTP token file."
  `(let ((org-clipper-http-token-file
          (make-temp-name (expand-file-name "oc-token-" temporary-file-directory))))
     (unwind-protect (progn ,@body)
       (ignore-errors (delete-file org-clipper-http-token-file)))))

(ert-deftest org-clipper-test-http-parse-incomplete-then-complete ()
  (should (eq :incomplete (car (org-clipper--http-parse
                                "POST /capture HTTP/1.1\r\nContent-Length: 5\r\n"))))
  (let ((r (org-clipper--http-parse
            "POST /capture HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello")))
    (should (eq :complete (car r)))
    (should (equal (nth 2 r) "hello"))))

(ert-deftest org-clipper-test-http-parse-byte-accurate-cjk ()
  ;; Content-Length is BYTES; a CJK body must be sliced by bytes, not chars.
  (let* ((body (encode-coding-string "你好世界" 'utf-8))     ; 12 bytes, 4 chars
         (req (concat "POST /capture HTTP/1.1\r\nContent-Length: "
                      (number-to-string (length body)) "\r\n\r\n" body))
         (r (org-clipper--http-parse req)))
    (should (eq :complete (car r)))
    (should (equal (decode-coding-string (nth 2 r) 'utf-8) "你好世界"))))

(ert-deftest org-clipper-test-http-parse-toobig ()
  (let ((org-clipper-http-max-body 10))
    (should (eq :toobig (car (org-clipper--http-parse
                              "POST /capture HTTP/1.1\r\nContent-Length: 999\r\n\r\n"))))))

(ert-deftest org-clipper-test-http-handle-valid-inserts-with-gapless-levels ()
  (org-clipper-test--with-token
   (org-clipper-test--with-target
    (lambda (tmp)
      (let* ((tok (org-clipper--http-token))
             (json (json-serialize '(:template "w" :url "https://x/测试" :title "标题 ☕"
                                     :tags ["clippings" "rust"] :author "Rosa"
                                     :body "** 引言\n\n正文 café 😀\n\n**** 深入")))
             (body (encode-coding-string json 'utf-8))
             (headers (concat "POST /capture HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                              "X-Org-Clipper-Token: " tok "\r\n"
                              "Origin: chrome-extension://abc\r\n"
                              "Content-Length: " (number-to-string (length body)) "\r\n"))
             (res (org-clipper--http-handle headers body)))
        (should (= 200 (car res)))
        (with-temp-buffer
          (insert-file-contents tmp)
          (let ((s (buffer-string)))
            (should (string-match-p "^\\*\\* 标题 ☕  :clippings:rust:$" s))
            (should (string-match-p "^:AUTHOR: Rosa$" s))
            (should (string-match-p "^:SOURCE: https://x/测试$" s))
            (should (string-match-p "^\\*\\*\\* 引言$" s))       ; base = clip-level+1 = 3
            (should (string-match-p "^\\*\\*\\*\\* 深入$" s))     ; gap 2->4 compressed
            (should-not (string-match-p "^\\*\\*\\*\\*\\* " s)))))))))

(ert-deftest org-clipper-test-http-handle-bad-token-no-insert ()
  (org-clipper-test--with-token
   (org-clipper-test--with-target
    (lambda (tmp)
      (org-clipper--http-token)         ; generate the real token (differs from WRONG)
      (let* ((body (encode-coding-string "{\"url\":\"x\"}" 'utf-8))
             (headers (concat "POST /capture HTTP/1.1\r\nX-Org-Clipper-Token: WRONG\r\n"
                              "Content-Length: " (number-to-string (length body)) "\r\n")))
        (should (= 403 (car (org-clipper--http-handle headers body))))
        (should (equal "" (with-temp-buffer (insert-file-contents tmp) (buffer-string)))))))))

(ert-deftest org-clipper-test-http-handle-website-origin-rejected ()
  (org-clipper-test--with-token
   (let* ((tok (org-clipper--http-token))
          (body (encode-coding-string "{\"url\":\"x\"}" 'utf-8))
          (headers (concat "POST /capture HTTP/1.1\r\nX-Org-Clipper-Token: " tok "\r\n"
                           "Origin: https://evil.example\r\n"
                           "Content-Length: " (number-to-string (length body)) "\r\n")))
     (should (= 403 (car (org-clipper--http-handle headers body)))))))


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

;; Regression: the HTTP handler must thread :images from the JSON payload
;; through to --insert-clip so links are actually rewritten.  A direct
;; --insert-clip call masks a dropped :images key in --http-handle.
(ert-deftest org-clipper-test-http-handle-embeds-images ()
  (org-clipper-test--with-token
   (org-clipper-test--with-target
    (lambda (tmp)
      (let* ((org-attach-id-dir (make-temp-name (expand-file-name "oc-attach-" temporary-file-directory)))
             (tok (org-clipper--http-token))
             (json (json-serialize
                    `(:template "w" :url "https://x/p" :title "img test"
                      :body "[[https://x/a.png]] and [[https://x/missing.png]]"
                      :images [(:url "https://x/a.png" :filename "a.png"
                                :contentType "image/png" :dataBase64 ,org-clipper-test--png)])))
             (body (encode-coding-string json 'utf-8))
             (headers (concat "POST /capture HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                              "X-Org-Clipper-Token: " tok "\r\n"
                              "Origin: chrome-extension://abc\r\n"
                              "Content-Length: " (number-to-string (length body)) "\r\n"))
             (res (org-clipper--http-handle headers body)))
        (should (= 200 (car res)))
        (with-temp-buffer
          (insert-file-contents tmp)
          (let ((s (buffer-string)))
            (should (string-match-p "\\[\\[attachment:a.png\\]\\]" s))         ; embedded
            (should (string-match-p "\\[\\[https://x/missing.png\\]\\]" s))     ; unmapped stays remote
            (should-not (string-match-p "\\[\\[https://x/a.png\\]\\]" s)))))))))  ; rewritten away

(ert-deftest org-clipper-test-http-max-body-raised ()
  (should (>= org-clipper-http-max-body (* 128 1024 1024))))

;; Hybrid payload: the extension sends standard fields plus a `properties`
;; object of non-standard template props; the handler must thread it through
;; so they appear in the drawer.
(ert-deftest org-clipper-test-http-handle-writes-extra-properties ()
  (org-clipper-test--with-token
   (org-clipper-test--with-target
    (lambda (tmp)
      (let* ((tok (org-clipper--http-token))
             (json (json-serialize '(:template "w" :url "https://x" :title "T"
                                     :body "x" :properties (:READING_TIME "5 min"))))
             (body (encode-coding-string json 'utf-8))
             (headers (concat "POST /capture HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                              "X-Org-Clipper-Token: " tok "\r\n"
                              "Origin: chrome-extension://abc\r\n"
                              "Content-Length: " (number-to-string (length body)) "\r\n"))
             (res (org-clipper--http-handle headers body)))
        (should (= 200 (car res)))
        (with-temp-buffer
          (insert-file-contents tmp)
          (should (string-match-p "^:READING_TIME: 5 min$" (buffer-string)))))))))
