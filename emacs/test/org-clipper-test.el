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

(ert-deftest org-clipper-test-sanitize-text-strips-eight-bit-bytes ()
  ;; Raw eight-bit bytes (undecodable UTF-8 -> chars #x3fff80..#x3fffff) are the
  ;; classic `select-safe-coding-system' (raw-text) trigger; strip them too.
  (should (equal (org-clipper--sanitize-text (string #x3fff80 ?a #x3fffff ?b)) "ab"))
  ;; eight-bit + NUL interleaved with real multibyte text, which is preserved.
  (should (equal (org-clipper--sanitize-text
                  (concat "你好" (string 0) (string #x3fff85) "世界"))
                 "你好世界")))

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

;; Regression: a clipped inline SVG rasterizes to a `data:image/...;base64,'
;; URL that is easily tens of KB to several MB.  Rewriting it must NOT build a
;; `regexp-quote'd pattern from the URL: Emacs's compiled-pattern limit is well
;; under 50 KB, so that signals `invalid-regexp' ("Regular expression too big"),
;; which the HTTP handler surfaces as `HTTP 500'.  Use a literal search instead.
(ert-deftest org-clipper-test-insert-clip-rewrites-long-data-uri-image ()
  (org-clipper-test--with-target
   (lambda (tmp)
     (let* ((org-attach-id-dir (make-temp-name (expand-file-name "oc-attach-" temporary-file-directory)))
            ;; 60 KB data URL — past the compiled-pattern limit (~32-50 KB).
            (url (concat "data:image/png;base64," (make-string 60000 ?A))))
       (org-clipper--insert-clip
        (list :title "T" :url "u"
              :body (concat "see [[" url "]] here")
              :images (list (list :url url :filename "img.png"
                                  :contentType "image/png" :dataBase64 org-clipper-test--png))))
       (with-temp-buffer
         (insert-file-contents tmp)
         (let ((s (buffer-string)))
           (should (string-match-p "\\[\\[attachment:img.png\\]\\]" s))   ; rewritten
           (should-not (string-match-p "data:image/png" s))))))))          ; inline data URL gone

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


;;;; ===== remote-image localize (migrated from doom config) =====
;;;; org-clipper--image-source-url : unwrap CDN/proxy wrappers ----------------

(ert-deftest org-clipper-localize/source-url-direct ()
  "A plain image URL is returned unchanged."
  (should (equal (org-clipper--image-source-url
                  "https://developer-blogs.nvidia.com/wp-content/uploads/2026/05/image4-2.webp")
                 "https://developer-blogs.nvidia.com/wp-content/uploads/2026/05/image4-2.webp")))

(ert-deftest org-clipper-localize/source-url-nextjs-proxy ()
  "Next.js /_next/image?url= proxy resolves to the decoded inner URL."
  (should (equal (org-clipper--image-source-url
                  "https://www.anthropic.com/_next/image?url=https%3A%2F%2Fwww-cdn.anthropic.com%2Fimages%2F4zrzovbb%2Fwebsite%2F52a19d636c659cf4515dc0d7d70b8ceb1bbfd768-2200x1276.png&w=3840&q=75")
                 "https://www-cdn.anthropic.com/images/4zrzovbb/website/52a19d636c659cf4515dc0d7d70b8ceb1bbfd768-2200x1276.png")))

(ert-deftest org-clipper-localize/source-url-embedded-path ()
  "Substack image/fetch with a path-embedded encoded URL resolves to the inner URL."
  (should (equal (org-clipper--image-source-url
                  "https://substackcdn.com/image/fetch/$s_!NpOz!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F04d4f8f4-c0de-4a00-820b-c4e5c9cbe845_742x389.png")
                 "https://substack-post-media.s3.amazonaws.com/public/images/04d4f8f4-c0de-4a00-820b-c4e5c9cbe845_742x389.png")))

(ert-deftest org-clipper-localize/source-url-twitter-query ()
  "Twitter media URL (format in query, no inner URL) is returned unchanged."
  (should (equal (org-clipper--image-source-url
                  "https://pbs.twimg.com/media/HJxkZ_wbEAAHWLa?format=jpg&name=large")
                 "https://pbs.twimg.com/media/HJxkZ_wbEAAHWLa?format=jpg&name=large")))

;;;; org-clipper--image-url-p : which bare links are worth fetching -----------

(ert-deftest org-clipper-localize/image-p-extension ()
  "A URL whose path ends in an image extension is an image."
  (should (org-clipper--image-url-p
           "https://miro.medium.com/v2/resize:fit:1400/format:webp/1*LwW9inw66JSJfdVTaZH26Q.png")))

(ert-deftest org-clipper-localize/image-p-extensionless-known-host ()
  "An extension-less Medium CDN image is recognised by host."
  (should (org-clipper--image-url-p
           "https://miro.medium.com/v2/resize:fit:1400/format:webp/0*sNfsM7_ipBZxprqO")))

(ert-deftest org-clipper-localize/image-p-twitter-format-query ()
  "A Twitter media URL is recognised via its format= query (and host)."
  (should (org-clipper--image-url-p
           "https://pbs.twimg.com/media/HJxkZ_wbEAAHWLa?format=jpg&name=large")))

(ert-deftest org-clipper-localize/image-p-nextjs-proxy ()
  "A Next.js image proxy wrapping a .png is an image."
  (should (org-clipper--image-url-p
           "https://www.anthropic.com/_next/image?url=https%3A%2F%2Fwww-cdn.anthropic.com%2Fimages%2F4zrzovbb%2Fwebsite%2F52a19d636c659cf4515dc0d7d70b8ceb1bbfd768-2200x1276.png&w=3840&q=75")))

(ert-deftest org-clipper-localize/image-p-rejects-article-link ()
  "A non-image article URL is not treated as an image."
  (should-not (org-clipper--image-url-p
               "https://blog.roboflow.com/how-to-deploy-rf-detr-to-an-nvidia-jetson/")))

(ert-deftest org-clipper-localize/image-p-rejects-youtube ()
  "A YouTube watch URL is not treated as an image."
  (should-not (org-clipper--image-url-p
               "https://www.youtube.com/watch?v=-OvpdLAElFA")))

;;;; org-clipper--content-type-extension : Content-Type header → extension ----

(ert-deftest org-clipper-localize/ext-jpeg ()
  (should (equal (org-clipper--content-type-extension "image/jpeg") "jpg")))

(ert-deftest org-clipper-localize/ext-strips-params-and-case ()
  "Parameters after `;' are dropped and matching is case-insensitive."
  (should (equal (org-clipper--content-type-extension "IMAGE/PNG; charset=binary") "png")))

(ert-deftest org-clipper-localize/ext-webp ()
  (should (equal (org-clipper--content-type-extension "image/webp") "webp")))

(ert-deftest org-clipper-localize/ext-svg ()
  (should (equal (org-clipper--content-type-extension "image/svg+xml") "svg")))

(ert-deftest org-clipper-localize/ext-nonimage-nil ()
  "A non-image Content-Type yields nil (used as the fetch guard)."
  (should-not (org-clipper--content-type-extension "text/html; charset=utf-8")))

(ert-deftest org-clipper-localize/ext-nil-input ()
  (should-not (org-clipper--content-type-extension nil)))

;;;; Regression: match-data hygiene + link collection -----------------------
;;;; The first run placed every attachment marker at buffer position 1 because
;;;; `org-clipper--image-url-p' calls `string-match' internally (via
;;;; `--image-source-url'), clobbering the buffer match data the collection
;;;; loop read immediately afterwards.

(ert-deftest org-clipper-localize/image-url-p-preserves-match-data ()
  "The predicate must not disturb the caller's match data."
  (with-temp-buffer
    (insert "see [[https://miro.medium.com/v2/0*abc]] here")
    (goto-char (point-min))
    (should (re-search-forward "\\[\\[\\(https?://[^][]+\\)\\]\\]" nil t))
    (let ((mb (match-beginning 0)) (me (match-end 0)))
      (org-clipper--image-url-p (match-string-no-properties 1))
      (should (= (match-beginning 0) mb))
      (should (= (match-end 0) me)))))

(ert-deftest org-clipper-localize/collect-finds-links-at-correct-positions ()
  "Collected links carry the buffer span of the real link, not a stale
position left behind by the image predicate."
  (with-temp-buffer
    (insert "* Heading\nintro text\nsee [[https://miro.medium.com/v2/0*abc]] end\n")
    (let* ((links (org-clipper--collect-image-links (point-min) (point-max)))
           (link  (car links)))
      (should (= (length links) 1))
      (should (equal (nth 0 link) "https://miro.medium.com/v2/0*abc"))
      (should (> (nth 1 link) 10))      ; not clamped to position 1
      (should (string-prefix-p "[[https"
                               (buffer-substring (nth 1 link) (nth 2 link)))))))

(ert-deftest org-clipper-localize/collect-skips-described-links ()
  "Reference links `[[url][desc]]' are not image candidates."
  (with-temp-buffer
    (insert "* H\n[[https://pbs.twimg.com/media/x?format=jpg][a photo]] and "
            "[[https://example.com/article]]\n")
    (should (null (org-clipper--collect-image-links (point-min) (point-max))))))

(ert-deftest org-clipper-localize/collect-markers-track-edits ()
  "Collected spans must track buffer edits, so rewriting an earlier link
does not shift a later link off target — the file-corruption regression
where lazily-made markers read stale positions and mangled the file."
  (with-temp-buffer
    (insert "* H\n[[https://a.com/1.png]] AAAtext "
            "[[https://b.com/2.png]] BBBtext\n")
    (let* ((links (org-clipper--collect-image-links (point-min) (point-max)))
           (l1 (nth 0 links)) (l2 (nth 1 links)))
      (should (= (length links) 2))
      ;; Rewrite the FIRST link to a much longer string.
      (goto-char (nth 1 l1))
      (delete-region (nth 1 l1) (nth 2 l1))
      (insert "[[attachment:a-very-long-replacement-name.png]]")
      ;; The SECOND link's recorded span must still bracket exactly its link.
      (should (equal (buffer-substring (nth 1 l2) (nth 2 l2))
                     "[[https://b.com/2.png]]")))))

;;;; data: URL localization (inline base64 images -> attachments) -----------
;;;; The clip path already rewrites inline `data:' images to attachments at
;;;; capture time.  The SAME `localize' command must also rescue a `data:' link
;;;; already sitting in a file (e.g. left by a pre-fix failed clip that 500'd
;;;; mid-rewrite): decode the base64 locally (no network) and never
;;;; `regexp-quote' the megabyte-long URL.

(ert-deftest org-clipper-localize/data-url-decodes-base64 ()
  (let ((r (org-clipper--data-url-to-tempfile
            (concat "data:image/png;base64," org-clipper-test--png))))
    (should (equal (car r) "image/png"))
    (should (file-exists-p (cdr r)))
    (unwind-protect
        (with-temp-buffer
          (set-buffer-multibyte nil)
          (insert-file-contents-literally (cdr r))
          (should (equal (buffer-substring 2 5) "PNG")))   ; PNG magic after 0x89
      (delete-file (cdr r)))))

(ert-deftest org-clipper-localize/data-url-rejects-non-base64-and-non-data ()
  ;; Non-base64 data: (percent-encoded) and ordinary URLs are not our job here.
  (should-not (org-clipper--data-url-to-tempfile "data:image/svg+xml,%3Csvg%3E"))
  (should-not (org-clipper--data-url-to-tempfile "https://x/a.png")))

(ert-deftest org-clipper-localize/image-p-accepts-data-image ()
  (should (org-clipper--image-url-p (concat "data:image/png;base64," org-clipper-test--png)))
  (should (org-clipper--image-url-p "data:image/gif;base64,AAAA")))

(ert-deftest org-clipper-localize/collect-finds-large-data-link-without-overflow ()
  "A multi-hundred-KB inline `data:' link (the size that makes `org-element'
stack-overflow) must still be collected, with its true buffer span."
  (with-temp-buffer
    (insert "* H\nbefore [[data:image/png;base64," (make-string 200000 ?A) "]] after\n")
    (let ((links (org-clipper--collect-image-links (point-min) (point-max))))
      (should (= (length links) 1))
      (should (string-prefix-p "data:image/png;base64,AAAA" (nth 0 (car links))))
      (should (string-prefix-p "[[data:" (buffer-substring (nth 1 (car links))
                                                           (+ 7 (nth 1 (car links)))))))))

(ert-deftest org-clipper-localize/localize-rewrites-inline-data-image ()
  "End-to-end: an inline base64 `data:' image is decoded, attached, and the
link rewritten to [[attachment:FILE]] — with no network access."
  (org-clipper-test--with-target
   (lambda (tmp)
     (let ((org-attach-id-dir (make-temp-name (expand-file-name "oc-attach-" temporary-file-directory))))
       (with-current-buffer (find-file-noselect tmp)
         (let ((org-mode-hook nil)) (org-mode))
         (goto-char (point-max))
         (insert "* clip\n:PROPERTIES:\n:ID: oc-data-test\n:END:\n"
                 "see [[data:image/png;base64," org-clipper-test--png "]] here\n")
         (org-clipper-localize-remote-images (point-min) (point-max))
         (let ((s (buffer-string)))
           (should (string-match-p "\\[\\[attachment:image\\.png\\]\\]" s))
           (should-not (string-match-p "data:image/png" s)))
         (set-buffer-modified-p nil)
         (kill-buffer))))))
