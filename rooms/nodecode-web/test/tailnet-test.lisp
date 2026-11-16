;;;; tailnet-test.lisp --- the Tailnet pill at the head of the page (page/tailnet.js).
;;;;
;;;; SPDX-License-Identifier: MIT

(in-package #:nodecode.test)

(deftest web-cell-tailnet-pill-says-where-and-acts ()
  ;; tailnet-test.mjs runs the page's own module in node: the pill's colour
  ;; for loopback and the tailnet, what its panel offers in each, and what each
  ;; of its buttons asks the tailnet access cell.
  (let* ((runner (asdf:system-relative-pathname "nodecode-web" "test/tailnet-test.mjs"))
         (module (merge-pathnames "tailnet.js" nodecode-web::*page-directory*))
         (output (uiop:run-program (list "node" (namestring runner) (namestring module))
                                   :output :string :error-output :output :ignore-error-status t))
         (last (car (last (uiop:split-string (string-trim '(#\Newline) output) :separator '(#\Newline))))))
    (is (and (search "TAILNET " last) (search " 0 failed" last)) (format nil "tailnet.js: ~a" output))))
