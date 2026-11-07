;;; record.el --- Record what Magit shows, for e8-magit's tests  -*- lexical-binding: t -*-

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
;; ~/.emacs.d/elpaca/builds, each in a directory of its own name.  It was
;; recorded with Magit 4.4.0 in Emacs 30.
;;
;; Two recordings:
;;
;; - test/menus.json: the menu each prefix key shows in the status buffer
;;   of the basic fixture, which magit-the-menus-show-as-magits-do
;;   compares E8's menus with.
;;
;; - test/oracle/NAME.json for each case in test/oracle/cases.json: the
;;   buffer Magit shows after the case's keys, typed in the status buffer
;;   of the case's fixture (test/fixtures.sh): its name, its visible text,
;;   the faces of that text as runs, and point's line.  The tests type
;;   the same keys in E8 and compare.  E8_ORACLE_ONLY=STRING records only
;;   the cases whose names have STRING.

(require 'json)
(defvar mr-builds (file-name-as-directory (or (getenv "E8_ELPA_BUILDS") (expand-file-name "~/.emacs.d/elpaca/builds"))))
(dolist (p '("magit" "magit-section" "transient" "with-editor" "cond-let" "llama" "compat" "dash"))
  (add-to-list 'load-path (expand-file-name p mr-builds)))
(require 'magit)
(defvar mr-dir (file-name-directory (or load-file-name buffer-file-name)))
(defvar mr-menus nil)
(defvar mr-key nil)
(setq transient-show-popup t)
;; As E8's tests run: no global or system git configuration.
(setenv "GIT_CONFIG_GLOBAL" "/dev/null")
(setenv "GIT_CONFIG_NOSYSTEM" "1")

(defun mr-fixture (name)
  "Make fixture NAME in a new temporary directory; give the directory."
  (let ((dir (file-name-as-directory (make-temp-file "magit-oracle" t))))
    (unless (zerop (call-process "sh" nil nil nil (expand-file-name "fixtures.sh" mr-dir) name dir))
      (error "fixtures.sh %s failed" name))
    dir))

(defun mr-face-name (face)
  "FACE as a string: its name, or the names of a list of faces joined by spaces."
  (cond ((null face) nil)
        ((symbolp face) (symbol-name face))
        ((and (consp face) (keywordp (car face))) "anonymous")
        ((consp face) (mapconcat (lambda (f) (or (mr-face-name f) "")) (seq-filter (lambda (f) f) face) " "))
        (t "anonymous")))

(defun mr-buffer ()
  "The current buffer as the tests compare it."
  (let ((text "") (faces nil) (line 1) (col 0) (run nil) (point-line nil))
    (save-excursion
      (let ((pos (point-min)))
        (while (< pos (point-max))
          (when (= pos (window-point)) (setq point-line line))
          (unless (invisible-p pos)
            (let* ((c (char-after pos))
                   (f (mr-face-name (or (get-text-property pos 'font-lock-face) (get-text-property pos 'face)))))
              (if (eq c ?\n)
                  (progn (when run (push run faces) (setq run nil))
                         (setq line (1+ line) col 0))
                (if (and run (equal (nth 3 run) f) (= (nth 2 run) col))
                    (setcar (nthcdr 2 run) (1+ col))
                  (when run (push run faces))
                  (setq run (and f (list line col (1+ col) f))))
                (unless f (when run (push run faces) (setq run nil)))
                (setq col (1+ col)))
              (setq text (concat text (string c)))))
          (setq pos (1+ pos)))
        (when run (push run faces))))
    `((buffer . ,(buffer-name))
      (point . ,(or point-line line))
      (text . ,text)
      (faces . ,(vconcat (mapcar (lambda (r) (format "%d:%d-%d %s" (nth 0 r) (nth 1 r) (nth 2 r) (nth 3 r))) (nreverse faces)))))))

(defun mr-record-case (case)
  (let* ((name (alist-get 'name case))
         (dir (mr-fixture (alist-get 'fixture case)))
         (repo (expand-file-name "repo/" dir))
         (default-directory repo)
         (keys (alist-get 'keys case)))
    (message "Recording %s" name)
    (delete-other-windows)
    (magit-status-setup-buffer repo)
    (unless (string-empty-p keys)
      (execute-kbd-macro (kbd keys)))
    (let ((result (with-current-buffer (window-buffer (selected-window)) (mr-buffer))))
      (with-temp-file (expand-file-name (format "oracle/%s.json" name) mr-dir)
        (insert (json-encode result))
        (json-pretty-print-buffer)
        (goto-char (point-max))
        (insert "\n")))
    (dolist (b (buffer-list))
      (when (with-current-buffer b (derived-mode-p 'magit-mode))
        (kill-buffer b)))
    (delete-directory dir t)))

(let ((only (getenv "E8_ORACLE_ONLY"))
      (cases (let ((json-array-type 'list)) (json-read-file (expand-file-name "oracle/cases.json" mr-dir)))))
  (dolist (case cases)
    (when (or (null only) (string-match-p (regexp-quote only) (alist-get 'name case)))
      (condition-case err
          (mr-record-case case)
        (error (message "FAILED %s: %S" (alist-get 'name case) err))))))

(unless (getenv "E8_ORACLE_ONLY")
  (let* ((dir (mr-fixture "basic"))
         (repo (expand-file-name "repo/" dir))
         (default-directory repo))
    (advice-add 'transient--show :after
                (lambda (&rest _)
                  (push (cons mr-key (with-current-buffer (get-buffer " *transient*") (buffer-substring-no-properties (point-min) (point-max))))
                        mr-menus)))
    (magit-status-setup-buffer repo)
    (with-current-buffer (magit-get-mode-buffer 'magit-status-mode)
      (dolist (key (quote ("c" "P" "F" "f" "b" "l" "m" "X" "d" "z" "h" "r" "A" "V" "w" "t" "M" "!")))
        (setq mr-key key)
        (execute-kbd-macro (kbd (concat key " C-g")))))
    (delete-directory dir t))
  (with-temp-file (expand-file-name "menus.json" mr-dir)
    (insert (json-encode (nreverse mr-menus)))
    (json-pretty-print-buffer)))
