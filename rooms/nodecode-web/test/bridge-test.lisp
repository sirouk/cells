;;;; bridge-test.lisp --- the bridge's parts that are only functions.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; What a request becomes on its way to the gateway, and what a pairing code
;;;; is when it comes back typed: both are pure, so both are checked here. The
;;;; rest of bridge.lisp is a listener and cannot be a test's: it is proved by
;;;; a browser at the node's own https name, which is a real device pairing.

(in-package #:nodecode-web/test)

(deftest web-cell-a-forwarded-request-speaks-loopback ()
  (let* ((headers '(("host" . "cyberneticconsole.tail77f45e.ts.net")
                    ("origin" . "https://cyberneticconsole.tail77f45e.ts.net")
                    ("tailscale-user-login" . "someone@example.com")
                    ("x-forwarded-for" . "100.66.29.103")
                    ("cookie" . "nodecode-bridge=abc")))
         (head (nodecode-web::forwarded-head "GET" "/api/web/tasks" headers t))
         (lines (uiop:split-string head :separator (list #\Return #\Newline))))
    ;; The gateway refuses any Host but loopback and any socket whose Origin is
    ;; not that same authority, so both are what the request says on the way in.
    (is (string= (format nil "host: 127.0.0.1:~d" (nodecode-web::gateway-port))
                 (find "host" lines :test (lambda (wanted line)
                                            (and (uiop:string-prefix-p wanted line) t))))
        "Host is the loopback authority")
    (is (string= (format nil "origin: http://127.0.0.1:~d" (nodecode-web::gateway-port))
                 (find "origin" lines :test (lambda (wanted line)
                                              (and (uiop:string-prefix-p wanted line) t))))
        "Origin is that same authority, over http")
    ;; What only the front door said is not the gateway's business, and the
    ;; device's own cookie still is.
    (is (null (find "tailscale-" lines :test (lambda (wanted line)
                                               (and (search wanted line) t))))
        "nothing the tailnet planted is passed on")
    (is (null (find "x-forwarded-" lines :test (lambda (wanted line)
                                                 (and (search wanted line) t))))
        "nor the address it came from")
    (is (find "cookie: nodecode-bridge=abc" lines :test (lambda (wanted line) (and (string= wanted line) t)))
        "the device's cookie goes through")
    (is (string= (format nil "~c~c" #\Return #\Newline) (subseq head (- (length head) 2)))
        "and the head ends its blank line: a head without one waits forever")))

(deftest web-cell-a-pairing-code-reads-back-as-typed ()
  (let ((code (nodecode-web::new-code)))
    (is (= 9 (length code)) "a code is XXXX-XXXX")
    (is (char= #\- (char code 4)) "with its dash where it is read")
    (is (every (lambda (char) (or (char= char #\-) (find char nodecode-web::+code-alphabet+))) code)
        "in an alphabet with no look-alikes")
    (is (string= (nodecode-web::normalize-code code)
                 (nodecode-web::normalize-code (string-downcase (remove #\- code))))
        "and a code typed without its dash, in lower case, is that code")))

(deftest web-cell-a-paired-device-keeps-a-cookie ()
  (let* ((headers '(("cookie" . "other=1; nodecode-bridge=abc123; last=2"))))
    (is (string= "abc123" (nodecode-web::cookie-value headers nodecode-web::*bridge-cookie*))
        "the device's cookie is read out of the header")
    (is (null (nodecode-web::cookie-value headers "nodecode-bridge-other"))
        "and a name that is not it is not")))

(deftest web-cell-the-page-is-handed-its-token ()
  (let ((html (nodecode-web::with-token "<html><head><title>t</title></head></html>")))
    (is (search (nodecode-web::page-tag) html) "the tag is in the page")
    (is (< (search "<head>" html) (search (nodecode-web::page-tag) html))
        "and it is in the head, before the page's own scripts run")
    (is (search (format nil "~s" nodecode-web::*bridge-script-path*) (nodecode-web::page-tag))
        "the script it loads is this bridge's own")))
