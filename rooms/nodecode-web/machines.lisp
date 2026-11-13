;;;; machines.lisp --- the other organisms this one can switch to.
;;;;
;;;; SPDX-License-Identifier: MIT
;;;;
;;;; The page's machines panel (page/machines.js) lists three things: the
;;;; organism serving it, the other homes on this machine, and the instances
;;;; the operator's tailnet answers for. Choosing one moves the tab to that
;;;; instance's own page.
;;;;
;;;; Only the first two are reachable as they stand. A gateway answers at
;;;; 127.0.0.1 or localhost and refuses every other Host (DNS rebinding), so a
;;;; peer cannot be reached over its tailnet address at all -- not through a
;;;; tunnel, not through TLS termination. What makes a peer reachable is a
;;;; loopback forward on this machine, which is what this file builds: it reads
;;;; the peer's port and operator token over the operator's own ssh, opens
;;;;     ssh -N -L 127.0.0.1:PORT:127.0.0.1:PEER-PORT peer
;;;; and hands the page the loopback link to navigate to. The peer keeps
;;;; answering loopback only, and its token crosses the operator's own ssh, never
;;;; a network service: it is handed to the page once and never written down.

(in-package #:nodecode-web)

;; Parameters, not constants: a cell whose file is reloaded in a running image
;; meets each of these again, and a constant's redefinition stops the file there.
(defparameter *machines-body-max* (* 64 1024)
  "The largest POST body read, in bytes.")
(defparameter *machine-host-max* 253
  "The longest name a machine is asked for by.")
(defparameter *connect-wait-seconds* 8
  "How long a forward is given to answer.")
(defparameter +token-marker+ "---nodecode-token---"
  "What the remote probe prints between the owner file and the token.")

(defvar *tunnels* (make-hash-table :test #'equal)
  "Machine name -> (:process P :port LOCAL :peer-port REMOTE), one forward each.")
(defvar *tunnels-lock* (sb-thread:make-mutex :name "web machines"))

;;; --- what is here -------------------------------------------------------

(defun home-directory ()
  "This organism's home as a directory."
  (make-pathname :name nil :type nil :defaults (nlk:home "x")))

(defun this-machine-name ()
  "What this machine calls itself, without the local domain Bonjour appends."
  (let ((name (or (ignore-errors (uiop:hostname)) "localhost")))
    (subseq name 0 (or (position #\. name) (length name)))))

(defun gateway-token ()
  "The operator token this gateway answers for."
  (or (ignore-errors nle::*gateway-operator-token*)
      (ignore-errors
       (string-trim '(#\Space #\Tab #\Newline #\Return)
                    (uiop:read-file-string (nlk:home "operator-token"))))
      ""))

(defun gateway-port ()
  "The port this gateway listens on."
  (or (ignore-errors nle::*gateway-bound-port*) 0))

(defun page-link (port token)
  "The page at PORT, with TOKEN in the fragment."
  (format nil "http://127.0.0.1:~d/web/#t=~a" port (url-encode token)))

(defun url-encode (text)
  "TEXT safe in a URL's fragment or query."
  (with-output-to-string (out)
    (loop for char across text
          do (if (or (alphanumericp char) (find char "-._~"))
                 (write-char char out)
                 (format out "%~2,'0X" (char-code char))))))

(defun home-label (directory)
  "DIRECTORY named as the operator knows it: `default' for the first home, the
profile's own name for one of those, and the folder's name for any other."
  (let* ((parts (rest (pathname-directory (pathname directory))))
         (last (and parts (car (last parts)))))
    (cond ((null parts) "default")
          ((and (stringp last)
                (string-equal (string-left-trim "." last) "nodecode")
                (= (length parts) 3))
           "default")
          (t (string last)))))

(defun owner-port (home)
  "The port the organism in HOME published, or NIL when none is running there."
  (let ((file (merge-pathnames "history.db.owner" (pathname home))))
    (when (probe-file file)
      (let ((owner (ignore-errors (nlk:decode-json (uiop:read-file-string file)))))
        (and (hash-table-p owner) (nlk:json-value owner :integer "port"))))))

(defun home-token (home)
  "The operator token of the organism in HOME, or \"\"."
  (or (ignore-errors
       (string-trim '(#\Space #\Tab #\Newline #\Return)
                    (uiop:read-file-string (merge-pathnames "operator-token" (pathname home)))))
      ""))

(defun answers-p (url token)
  "Does URL answer its page to TOKEN?"
  (handler-case
      (let ((answer (dex:get url
                             :headers (if (zerop (length token)) '() (list (cons "Authorization" (format nil "Bearer ~a" token))))
                             :connect-timeout 1 :read-timeout 2 :force-string t :keep-alive nil)))
        (declare (ignore answer))
        t)
    (error () nil)))

(defun local-homes ()
  "Every home this machine has: this one, the default one, and each profile."
  (let* ((home (home-directory))
         (default (merge-pathnames ".nodecode/" (user-homedir-pathname)))
         (profiles (merge-pathnames "profiles/" home))
         (all (list home default)))
    (dolist (each (ignore-errors (directory (merge-pathnames "*/" profiles))))
      (pushnew each all :test #'equal))
    (remove-duplicates all :test (lambda (a b) (string-equal (namestring a) (namestring b))))))

(defun local-machines ()
  "The organisms on this machine, this one first."
  (let ((here (home-directory))
        (rows '()))
    (dolist (home (local-homes))
      (let* ((port (owner-port home))
             (current (string-equal (namestring home) (namestring here)))
             (token (if current (gateway-token) (home-token home)))
             (live (and port (> port 0) (answers-p (format nil "http://127.0.0.1:~d/web/" port) token))))
        (when (or current live)
          (push (nlk:json-object
                 "name" (if current (this-machine-name) (home-label home))
                 "home" (namestring home)
                 "label" (home-label home)
                 "port" (or port 0)
                 "current" (and current t)
                 "running" (and live t)
                 "link" (and live (page-link port token)))
                rows))))
    (sort rows (lambda (a b)
                 (cond ((gethash "current" a) t)
                       ((gethash "current" b) nil)
                       (t (string-lessp (gethash "label" a) (gethash "label" b))))))))

;;; --- what the tailnet answers for --------------------------------------

(defun tailscale-binary ()
  "Where tailscale is, or NIL when this machine has none."
  (or (loop for candidate in '("tailscale"
                              "/usr/local/bin/tailscale"
                              "/opt/homebrew/bin/tailscale"
                              "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
            when (handler-case (progn (uiop:run-program (list candidate "version") :output :string
                                                       :error-output nil :ignore-error-status t)
                                      t)
                   (error () nil))
              return candidate)
      nil))

(defun tailnet-status ()
  "Tailscale's own view of the tailnet, as it answers --json; NIL when this
machine has no tailscale, or it is not running."
  (let ((binary (tailscale-binary)))
    (when binary
      (handler-case
          (let* ((text (uiop:run-program (list binary "status" "--json")
                                         :output :string :error-output nil :ignore-error-status t))
                 (status (and text (plusp (length text)) (nlk:decode-json text))))
            (and (hash-table-p status) status))
        (error () nil)))))

(defun peer-name (peer)
  "What to call PEER: its MagicDNS label when it has one, else its host name."
  (let* ((dns (nlk:json-value peer :text "DNSName"))
         (label (and dns (plusp (length dns))
                     (subseq dns 0 (or (position #\. dns) (length dns))))))
    (or (and label (plusp (length label)) label)
        (nlk:json-value peer :text "HostName")
        "")))

(defun tailnet-machines ()
  "The peers this tailnet knows, online first => (values PEERS PRESENTP)."
  (let* ((status (tailnet-status))
         (peers (and status (gethash "Peer" status)))
         (rows '()))
    (when (hash-table-p peers)
      (maphash
       (lambda (key peer)
         (declare (ignore key))
         (when (hash-table-p peer)
           (let* ((dns (nlk:json-value peer :text "DNSName"))
                  (name (peer-name peer))
                  (addresses (nlk:json-value peer :array "TailscaleIPs")))
             (when (plusp (length name))
               (push (nlk:json-object
                      "name" name
                      "host" (if (and dns (plusp (length dns)))
                                  (string-right-trim "." dns)
                                  name)
                      "os" (or (nlk:json-value peer :text "OS") "")
                      "address" (if (plusp (length addresses)) (aref addresses 0) "")
                      "online" (and (eq (gethash "Online" peer) t) t)
                      "tunnel" (tunnel-json name))
                     rows)))))
       peers))
    (values (coerce (sort rows (lambda (a b)
                                 (let ((ao (gethash "online" a)) (bo (gethash "online" b)))
                                   (if (eq ao bo)
                                       (string-lessp (gethash "name" a) (gethash "name" b))
                                       ao))))
                   'simple-vector)
            (and status t))))

;;; --- the forward -------------------------------------------------------

(defun tunnel-of (name)
  "The forward to NAME as kept, or NIL."
  (sb-thread:with-mutex (*tunnels-lock*)
    (gethash name *tunnels*)))

(defun forget-tunnel (name)
  "Take NAME's forward out of the table => it, or NIL."
  (sb-thread:with-mutex (*tunnels-lock*)
    (let ((tunnel (gethash name *tunnels*)))
      (when tunnel (remhash name *tunnels*))
      tunnel)))

(defun drop-tunnel (name)
  "Close the forward to NAME."
  (let ((tunnel (forget-tunnel name)))
    (when tunnel
      (ignore-errors (uiop:terminate-process (getf tunnel :process) :urgent t)))))

(defun tunnel-json (name)
  "The forward to NAME as the page reads it, or :NULL when there is none --
and one whose port stopped answering is closed and read as none."
  (let ((tunnel (tunnel-of name)))
    (cond ((null tunnel) :null)
          ((answers-p (format nil "http://127.0.0.1:~d/web/" (getf tunnel :port)) "")
           (nlk:json-object "port" (getf tunnel :port) "up" t))
          (t (drop-tunnel name) :null))))

(defun free-loopback-port ()
  "A port on 127.0.0.1 nothing is listening on: bound and released, as the
gateway picks its own."
  (let ((socket (usocket:socket-listen "127.0.0.1" 0 :reuse-address nil)))
    (unwind-protect (usocket:get-local-port socket)
      (usocket:socket-close socket))))

(defun peer-names (peer)
  "The names ssh may know PEER by, in the order to try them: the MagicDNS label
the operator calls it, then its full name, then the host name it reports."
  (let ((label (peer-name peer))
        (dns (nlk:json-value peer :text "DNSName"))
        (host (nlk:json-value peer :text "HostName")))
    (remove-duplicates
     (remove nil (list label
                       (and dns (plusp (length dns)) (string-right-trim "." dns))
                       host))
     :test #'string-equal)))

(defun known-peer (host)
  "The peer HOST names, or NIL. The one allowlist a forward is opened for."
  (let* ((status (tailnet-status))
         (peers (and (hash-table-p status) (gethash "Peer" status))))
    (and (hash-table-p peers)
         (loop for peer being the hash-values of peers
               when (and (hash-table-p peer)
                         (member host (peer-names peer) :test #'string-equal))
                 return peer))))

(defun first-line (text)
  "TEXT's first line that says something, or NIL."
  (when (and (stringp text) (plusp (length text)))
    (find-if (lambda (line) (plusp (length line)))
             (uiop:split-string (string-trim '(#\Space #\Newline #\Return) text)
                                :separator '(#\Newline)))))

(defun remote-organism-at (target)
  "The gateway of the organism TARGET's default home, read over ssh =>
(values PORT TOKEN REASON). The owner file is JSON over several lines, so the
probe frames the token behind a marker rather than guessing at lines."
  (handler-case
      (multiple-value-bind (output error code)
          (uiop:run-program (list "ssh" "-o" "BatchMode=yes" "-o" "ConnectTimeout=6" target
                                  (concatenate 'string
                                               "cat ~/.nodecode/history.db.owner 2>/dev/null; echo; echo "
                                               +token-marker+
                                               "; cat ~/.nodecode/operator-token 2>/dev/null"))
                            :output :string :error-output :string :ignore-error-status t)
        (declare (ignore code))
        (let* ((lines (uiop:split-string (or output "") :separator '(#\Newline)))
               (marker (position +token-marker+ lines :test #'string-equal))
               (owner-text (and marker (format nil "~{~a~^~%~}" (subseq lines 0 marker))))
               (owner (and owner-text (ignore-errors (nlk:decode-json owner-text))))
               (port (and (hash-table-p owner) (nlk:json-value owner :integer "port")))
               (token (string-trim '(#\Space #\Tab #\Newline #\Return)
                                   (if marker (format nil "~{~a~^~%~}" (subseq lines (1+ marker))) ""))))
          (cond ((and port (plusp port) (plusp (length token))) (values port token nil))
                ((and port (plusp port)) (values nil nil (format nil "~a has no operator token" target)))
                (t (values nil nil (or (first-line error) "nothing answered"))))))
    (error (condition) (values nil nil (princ-to-string condition)))))

(defun remote-organism (names)
  "The organism behind the first of NAMES that answers => (values PORT TOKEN
REASON TARGET): the operator's own known_hosts decides which name opens it."
  (let ((why "it did not answer"))
    (dolist (target names (values nil nil why nil))
      (multiple-value-bind (port token reason) (remote-organism-at target)
        (cond (port (return-from remote-organism (values port token nil target)))
              (reason (setf why reason)))))))

(defun open-forward (host)
  "A loopback link to HOST's page => the machines answer."
  (unless (and (stringp host) (plusp (length host)) (<= (length host) *machine-host-max*)
               (every (lambda (char) (or (alphanumericp char) (find char "-._"))) host))
    (return-from open-forward (tasks-refused 400 "bad_host" "host: the machine's name on the tailnet")))
  (let ((peer (known-peer host)))
    (unless peer
      (return-from open-forward (tasks-refused 404 "no_machine" "no machine of yours answers to that name")))
    (drop-tunnel host)
    (open-forward-to host (peer-names peer))))

(defun open-forward-to (host names)
  "Open HOST's forward, asking ssh for it under each of NAMES in turn. A name
ssh already knows it by is what opens the forward -- the operator's own
known_hosts is the authority here, not this file."
  (multiple-value-bind (peer-port token why target) (remote-organism names)
    (unless peer-port
      (return-from open-forward-to (tasks-refused 502 "unreachable"
                                                  (format nil "~a could not be reached: ~a" host why))))
    (let* ((port (free-loopback-port))
           (process (uiop:launch-program
                     (list "ssh" "-N" "-o" "BatchMode=yes" "-o" "ConnectTimeout=6"
                           "-o" "ExitOnForwardFailure=yes" "-o" "ServerAliveInterval=20"
                           "-L" (format nil "127.0.0.1:~d:127.0.0.1:~d" port peer-port) target)
                     :output nil :error-output nil))
           (url (format nil "http://127.0.0.1:~d/web/" port))
           (deadline (+ (get-internal-real-time)
                        (round (* *connect-wait-seconds* internal-time-units-per-second)))))
      (loop (when (answers-p url token) (return t))
            (when (> (get-internal-real-time) deadline)
              (ignore-errors (uiop:terminate-process process :urgent t))
              (return-from open-forward-to
                (tasks-refused 504 "no_answer"
                               (format nil "~a answered nothing on its page" host))))
            (sleep 0.2))
      (sb-thread:with-mutex (*tunnels-lock*)
        (setf (gethash host *tunnels*) (list :process process :port port :peer-port peer-port)))
      (json-answer 200 (nlk:json-object "ok" t "host" host "port" port
                                        "url" (page-link port token))))))

;;; --- the route ---------------------------------------------------------

(defun machines-json ()
  "Everything the panel lists."
  (let ((here (home-directory)))
    (multiple-value-bind (peers tailnet) (tailnet-machines)
      (nlk:json-object
       "self" (nlk:json-object
               "name" (this-machine-name)
               "home" (namestring here)
               "port" (gateway-port)
               "link" (if (plusp (gateway-port)) (page-link (gateway-port) (gateway-token)) :null))
       "local" (coerce (local-machines) 'simple-vector)
       "peers" peers
       "tailnet" (and tailnet t)))))

(defun machines-act (env)
  "POST {action, host}: connect opens a forward to HOST and answers its link;
disconnect closes it."
  (let ((octets (request-octets env *machines-body-max*)))
    (unless octets
      (return-from machines-act (tasks-refused 413 "too_large" "over the request ceiling")))
    (let* ((sent (handler-case (nlk:decode-json octets :whole t) (error () :bad)))
           (action (and (hash-table-p sent) (nlk:json-value sent :text "action")))
           (host (and (hash-table-p sent) (nlk:json-value sent :text "host"))))
      (unless (hash-table-p sent)
        (return-from machines-act (tasks-refused 400 "not_json" "the body is not a JSON object")))
      (cond ((and action (string-equal action "connect")) (open-forward host))
            ((and action (string-equal action "disconnect"))
             (when host (drop-tunnel host))
             (json-answer 200 (nlk:json-object "ok" t)))
            (t (tasks-refused 400 "no_action" "action: connect or disconnect"))))))

(defun machines-route (env)
  "/api/web/machines: GET the machines this organism can switch to; POST
{action, host} opens or closes the forward to one of them."
  (case (getf env :request-method)
    ((:get :head) (machines-json))
    (:post (machines-act env))
    (t (tasks-refused 405 "method" "GET lists the machines; POST connects or disconnects one"))))
