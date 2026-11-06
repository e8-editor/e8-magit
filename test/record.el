;;; record.el --- Record Magit's menus, for e8-magit's tests  -*- lexical-binding: t -*-

;; SPDX-License-Identifier: GPL-3.0-or-later
;; Copyright (C) 2026 The E8 contributors
;;
;; This program is free software: you can redistribute it and/or modify it
;; under the terms of the GNU General Public License as published by the
;; Free Software Foundation, either version 3 of the License, or (at your
;; option) any later version.

;; emacs -Q --batch -l test/record.el
;;
;; Magit and its dependencies load from E8_ELPA_BUILDS, else
;; ~/.emacs.d/elpaca/builds, each in a directory of its own name.  This
;; makes the repository test/magit-tests.ts makes: one commit, a change
;; unstaged and one staged, an untracked file and no upstream; opens its
;; status buffer and records the menu each prefix key shows into
;; test/menus.json, which magit-the-menus-show-as-magits-do compares
;; E8's menus with.  It was recorded with Magit 4.4.0 in Emacs 30.

(require 'json)
(defvar mr-builds (file-name-as-directory (or (getenv "E8_ELPA_BUILDS") (expand-file-name "~/.emacs.d/elpaca/builds"))))
(dolist (p '("magit" "magit-section" "transient" "with-editor" "cond-let" "llama" "compat" "dash"))
  (add-to-list 'load-path (expand-file-name p mr-builds)))
(require 'magit)
(defvar mr-dir (file-name-directory (or load-file-name buffer-file-name)))
(defvar mr-menus nil)
(defvar mr-key nil)

(let* ((repo (file-name-as-directory (make-temp-file "magit-oracle" t)))
       (default-directory repo))
  (dolist (args '(("init" "-q" "-b" "main") ("config" "user.email" "t@example.com") ("config" "user.name" "Tester")))
    (apply #'call-process "git" nil nil nil args))
  (with-temp-file "a.txt" (insert "one\ntwo\nthree\n"))
  (with-temp-file "b.txt" (insert "keep\n"))
  (call-process "git" nil nil nil "add" ".")
  (call-process "git" nil nil nil "commit" "-q" "-m" "First commit")
  (with-temp-file "a.txt" (insert "one\nTWO\nthree\nfour\n"))
  (with-temp-file "c.txt" (insert "new\n"))
  (with-temp-file "b.txt" (insert "keep\nmore\n"))
  (call-process "git" nil nil nil "add" "b.txt")
  (advice-add 'transient--show :after
              (lambda (&rest _)
                (push (cons mr-key (with-current-buffer (get-buffer " *transient*") (buffer-substring-no-properties (point-min) (point-max))))
                      mr-menus)))
  (magit-status-setup-buffer repo)
  (with-current-buffer (magit-get-mode-buffer 'magit-status-mode)
    (dolist (key (quote ("c" "P" "F" "f" "b" "l" "m" "X" "d" "z" "h" "r")))
      (setq mr-key key)
      (execute-kbd-macro (kbd (concat key " C-g")))))
  (delete-directory repo t))

(with-temp-file (expand-file-name "menus.json" mr-dir)
  (insert (json-encode (nreverse mr-menus)))
  (json-pretty-print-buffer))
