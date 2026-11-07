// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of magit-dired.ts, after magit-dired.el: jumping to Dired from a
// Magit buffer, staging, unstaging, the log and git am from Dired, and a
// shell command on the file at point.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { git, gotoText, history, read, repo, settle, status, typed, withRepos } from "magit-test-helpers";

ertDeftest("magit-dired-jump-lists-the-directory-of-the-file-at-point", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("C-M-i");
    shouldEqual(String(e8.variable("major-mode")), "dired-mode");
    should(e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), e8.lineEndPosition()).endsWith("a.txt"), e8.bufferText());
    // In the status buffer, C-x C-j does too, without a file at point listing the repository.
    status(dir);
    e8.executeKbdMacro("C-x C-j");
    shouldEqual(String(e8.variable("major-mode")), "dired-mode");
    shouldEqual(e8.fileNameAsDirectory(e8.fileTruename(String(e8.variable("default-directory")))), dir);
  });
});

ertDeftest("magit-dired-stage-and-unstage-the-marked-files", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.call("dired", dir);
    e8.call("dired-goto-file", e8.expandFileName("c.txt", dir));
    e8.executeKbdMacro(`M-x ${typed("magit-dired-stage")} RET`);
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "b.txt\nc.txt\n");
    e8.call("dired-goto-file", e8.expandFileName("b.txt", dir));
    e8.executeKbdMacro(`m M-x ${typed("magit-dired-unstage")} RET`);
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "c.txt\n");
  });
});

ertDeftest("magit-dired-log-shows-the-log-of-the-marked-files", () => {
  const dir = history();
  withRepos([dir], () => {
    e8.call("dired", dir);
    e8.call("dired-goto-file", e8.expandFileName("two.txt", dir));
    e8.executeKbdMacro(`m M-x ${typed("magit-dired-log")} RET`);
    shouldEqual(String(e8.variable("major-mode")), "magit-log-mode");
    shouldEqual(e8.variable("magit-buffer-log-files"), ["two.txt"]);
    should(e8.bufferText().includes("Two") && !e8.bufferText().includes("Three"), e8.bufferText());
  });
});

ertDeftest("magit-dired-am-apply-patches-applies-the-file-at-point", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "format-patch", "-q", "-1", "HEAD", "-o", "patches");
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    e8.call("dired", e8.expandFileName("patches/", dir));
    e8.call("dired-goto-file", e8.expandFileName("patches/0001-Three.patch", dir));
    e8.executeKbdMacro(`M-x ${typed("magit-dired-am-apply-patches")} RET`);
    settle(() => git(dir, "log", "-1", "--format=%s").trim() === "Three" && e8.processList().length === 0);
    shouldEqual(git(dir, "log", "-1", "--format=%s").trim(), "Three");
  });
});

ertDeftest("magit-do-async-shell-command-runs-a-command-on-the-file-at-point", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro(`& ${typed("cp * copy.txt")} RET`);
    settle(() => e8.fileExistsP(e8.expandFileName("copy.txt", dir)) && e8.processList().length === 0);
    shouldEqual(read(dir, "copy.txt"), read(dir, "a.txt"));
  });
});
