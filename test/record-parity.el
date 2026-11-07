;;; record-parity.el --- Record what Magit defines, for the parity audit  -*- lexical-binding: t -*-

;; SPDX-License-Identifier: GPL-3.0-or-later
;; Copyright (C) 2026 The E8 contributors
;;
;; This program is free software: you can redistribute it and/or modify it
;; under the terms of the GNU General Public License as published by the
;; Free Software Foundation, either version 3 of the License, or (at your
;; option) any later version.

;; emacs -Q --batch -l test/record-parity.el
;;
;; Loads all of Magit, as record.el does, and writes test/parity.json:
;; every command, option and face Magit's files define, the options'
;; defaults, and each of their keymaps' keys and commands.
;; test/parity-tests.ts compares E8's port with it, allowing the
;; exceptions test/parity-exceptions.json lists, each with its reason.

(require 'json)
(defvar mp-builds (file-name-as-directory (or (getenv "E8_ELPA_BUILDS") (expand-file-name "~/.emacs.d/elpaca/builds"))))
(dolist (p '("magit" "magit-section" "transient" "with-editor" "cond-let" "llama" "compat" "dash"))
  (add-to-list 'load-path (expand-file-name p mp-builds)))
(defvar mp-dir (file-name-directory (or load-file-name buffer-file-name)))
(defvar mp-magit-dir (file-truename (expand-file-name "magit" mp-builds)))

;; Every library of Magit's, not only those magit.el requires.
(dolist (file (directory-files mp-magit-dir nil "\\`\\(magit\\|git-\\).*\\.el\\'"))
  (let ((feature (intern (file-name-sans-extension file))))
    (unless (memq feature '(magit-autoloads magit-pkg))
      (condition-case err
          (require feature)
        (error (message "Could not load %s: %S" feature err))))))

(defun mp-magit-file-p (file)
  "Whether FILE is one of Magit's own."
  (and file (string-prefix-p mp-magit-dir (file-truename (file-name-sans-extension file)))))

(defun mp-defined-in-magit-p (symbol type)
  "Whether SYMBOL's definition of TYPE (nil for a function, defvar, defface) is in a Magit file."
  (mp-magit-file-p (symbol-file symbol type)))

(defun mp-name-p (symbol)
  (string-match-p "\\`\\(magit\\|git-\\)" (symbol-name symbol)))

(let (commands options faces keymaps)
  (mapatoms
   (lambda (s)
     (when (mp-name-p s)
       (when (and (commandp s) (mp-defined-in-magit-p s nil)
                  (not (get s 'byte-obsolete-info))
                  ;; Transient's infixes are commands too; menus list them.
                  (not (get s 'transient--suffix))
                  (not (string-match-p ":" (symbol-name s))))
         (push (symbol-name s) commands))
       (when (and (custom-variable-p s) (mp-defined-in-magit-p s 'defvar)
                  (not (get s 'byte-obsolete-variable)))
         (push (list (symbol-name s) (prin1-to-string (default-value s))) options))
       (when (and (facep s) (mp-defined-in-magit-p s 'defface))
         (push (symbol-name s) faces))
       (when (and (boundp s) (keymapp (symbol-value s)) (mp-defined-in-magit-p s 'defvar)
                  (string-suffix-p "-map" (symbol-name s)))
         (let (keys)
           (map-keymap
            (lambda (event binding)
              (when (and (symbolp binding) binding (not (eq binding 'undefined)))
                (push (list (key-description (vector event)) (symbol-name binding)) keys)))
            (symbol-value s))
           (push (list (symbol-name s) (sort keys (lambda (a b) (string< (car a) (car b))))) keymaps))))))
  (with-temp-file (expand-file-name "parity.json" mp-dir)
    (insert (json-encode
             `((commands . ,(vconcat (sort commands #'string<)))
               (options . ,(vconcat (mapcar #'vconcat (sort options (lambda (a b) (string< (car a) (car b)))))))
               (faces . ,(vconcat (sort faces #'string<)))
               (keymaps . ,(vconcat (mapcar (lambda (k) (vector (car k) (vconcat (mapcar #'vconcat (cadr k)))))
                                             (sort keymaps (lambda (a b) (string< (car a) (car b)))))))))))
    (insert "\n")
    (message "%d commands, %d options, %d faces, %d keymaps" (length commands) (length options) (length faces) (length keymaps)))
