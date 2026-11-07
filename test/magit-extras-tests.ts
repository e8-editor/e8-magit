// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of magit-extras.ts, after magit-extras.el: the revision stack
// (C-w, M-w and magit-pop-revision-stack), copying a hunk's lines,
// magit-abort-dwim, magit-reshelve-since, magit-project-status, Magit's
// line movement and back-to-indentation in hunks, and magit-clean.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitPopRevisionStack } from "magit-extras";
import { git, gotoText, history, init, repo, settle, status, tempDir, typed, withRepos, write } from "magit-test-helpers";

const hash = (dir: string, rev: string, short = false): string => git(dir, "rev-parse", ...(short ? ["--short"] : []), rev).trim();

ertDeftest("magit-copy-section-value-saves-a-commit-for-pop-revision-stack", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.setVariable("magit-revision-stack", []);
    e8.call("magit-log-current" as e8.CommandName);
    gotoText(hash(dir, "HEAD~1", true));
    e8.executeKbdMacro("C-w");
    const full = hash(dir, "HEAD~1");
    shouldEqual(e8.currentKill(0), full);
    shouldEqual(e8.variable("magit-revision-stack"), [[full, dir]]);
    // Popped into a buffer: a reference at point, the entry at the end.
    e8.call("switch-to-buffer", "*magit-extras-test*");
    e8.insert("See \n\nBody.\n");
    e8.gotoChar(e8.pointMin() + 4);
    e8.call("magit-pop-revision-stack" as e8.CommandName);
    const date = git(dir, "log", "-1", "--format=%cs", full).trim();
    shouldEqual(e8.bufferText(), `See [1: ${hash(dir, "HEAD~1", true)}] \n\nBody.\n\n1: ${date} ${full}\n   Two\n`);
    shouldEqual(e8.variable("magit-revision-stack"), []);
    // The next one is numbered 2.
    magitPopRevisionStack(hash(dir, "HEAD"), dir);
    should(e8.bufferText().includes(`[2: ${hash(dir, "HEAD", true)}]`), e8.bufferText());
    should(e8.bufferText().endsWith(`2: ${date} ${hash(dir, "HEAD")}\n   Three\n`), e8.bufferText());
    e8.call("kill-buffer", "*magit-extras-test*");
  });
});

ertDeftest("magit-copy-section-value-copies-a-branch-name-and-a-file", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.setVariable("magit-revision-stack", []);
    e8.executeKbdMacro("y");
    gotoText("main");
    // A branch's tip goes on the stack; with a prefix argument its name is copied.
    e8.executeKbdMacro("C-u C-w");
    shouldEqual(e8.currentKill(0), "main");
    shouldEqual(e8.variable("magit-revision-stack"), [[hash(dir, "main"), dir]]);
    e8.executeKbdMacro("C-w");
    shouldEqual(e8.currentKill(0), hash(dir, "main"));
    // A file section's value is its name.
    write(dir, "one.txt", "changed");
    status(dir);
    gotoText("modified   one.txt");
    e8.executeKbdMacro("C-w");
    shouldEqual(e8.currentKill(0), "one.txt");
  });
});

ertDeftest("magit-copy-section-value-keeps-the-added-lines-of-a-region", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("TAB");
    gotoText(" one");
    e8.setMark(e8.point());
    gotoText("+four");
    e8.gotoChar(e8.lineEndPosition());
    e8.activateMark();
    // With a prefix argument only the added lines, without their +.
    e8.executeKbdMacro("C-u C-w");
    shouldEqual(e8.currentKill(0), "one\nTWO\nthree\nfour");
    gotoText(" one");
    e8.setMark(e8.point());
    gotoText("+four");
    e8.gotoChar(e8.lineEndPosition());
    e8.activateMark();
    // A negative one, the removed lines.
    e8.executeKbdMacro("C-- C-w");
    shouldEqual(e8.currentKill(0), "one\ntwo\nthree\n");
  });
});

ertDeftest("magit-copy-buffer-revision-saves-the-revision-shown", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.setVariable("magit-revision-stack", []);
    e8.setVariable("magit-copy-revision-abbreviated", true);
    try {
      e8.executeKbdMacro("M-w");
      shouldEqual(e8.currentKill(0), hash(dir, "HEAD", true));
      e8.call("magit-log-current" as e8.CommandName);
      gotoText(hash(dir, "HEAD~2", true));
      e8.executeKbdMacro("RET");
      should(String(e8.variable("major-mode")) === "magit-revision-mode", String(e8.variable("major-mode")));
      e8.executeKbdMacro("M-w");
      shouldEqual(e8.currentKill(0), hash(dir, "HEAD~2", true));
      shouldEqual(e8.variable("magit-revision-stack"), [[hash(dir, "HEAD~2", true), dir], [hash(dir, "HEAD", true), dir]]);
    } finally {
      e8.setVariable("magit-copy-revision-abbreviated", false);
    }
  });
});

ertDeftest("magit-abort-dwim-aborts-a-merge", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "checkout", "-q", "-b", "other");
    write(dir, "one.txt", "theirs");
    git(dir, "commit", "-q", "-am", "Theirs");
    git(dir, "checkout", "-q", "main");
    write(dir, "one.txt", "ours");
    git(dir, "commit", "-q", "-am", "Ours");
    git(dir, "merge", "other");
    should(git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD") !== "", "a merge is going on");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-abort-dwim")} RET y`);
    settle(() => git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD") === "");
    shouldEqual(git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "");
    shouldEqual(git(dir, "status", "--porcelain"), "");
  });
});

ertDeftest("magit-reshelve-since-changes-the-dates-of-commits", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-reshelve-since")} RET`);
    shouldEqual(String(e8.variable("major-mode")), "magit-log-select-mode");
    gotoText(hash(dir, "HEAD~1", true));
    e8.executeKbdMacro(`. C-a C-k ${typed("2020-01-02 10:00:00 +0000")} RET`);
    settle(() => git(dir, "log", "-1", "--format=%at", "HEAD~1").trim() === "1577959200");
    shouldEqual(git(dir, "log", "--format=%at %ct", "-2"), "1577959260 1577959260\n1577959200 1577959200\n");
    should(git(dir, "log", "-1", "--format=%at", "HEAD~2").trim() !== "1577959140", "the first commit is left alone");
    // The backup ref filter-branch leaves is deleted.
    settle(() => git(dir, "show-ref", "refs/original/refs/heads/main") === "");
    shouldEqual(git(dir, "show-ref", "refs/original/refs/heads/main"), "");
  });
});

ertDeftest("magit-project-status-shows-the-projects-status", () => {
  const dir = history();
  withRepos([dir], () => {
    const commands = e8.variable("project-switch-commands") as string[][];
    should(commands.some((c) => c[0] === "m" && c[1] === "magit-project-status"), JSON.stringify(commands));
    e8.call("switch-to-buffer", e8.findFileNoselect(e8.expandFileName("one.txt", dir)));
    e8.executeKbdMacro("C-x p m");
    shouldEqual(String(e8.variable("major-mode")), "magit-status-mode");
    shouldEqual(e8.bufferName(), `magit: ${e8.fileNameNondirectory(dir.replace(/\/$/, ""))}`);
  });
});

ertDeftest("magit-next-line-starts-a-shift-selection-on-the-line-at-point", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("TAB");
    gotoText("-two");
    const at = e8.point();
    // Shifted, the first move selects the line point is on only.
    e8.executeKbdMacro("S-<down>");
    shouldEqual(e8.point(), at);
    should(e8.regionActive(), "the region is active");
    e8.executeKbdMacro("S-<down>");
    shouldEqual(e8.lineOf(e8.point()), e8.lineOf(at) + 1);
    // Unshifted, it moves as next-line does.
    e8.deactivateMark();
    e8.executeKbdMacro("<down>");
    shouldEqual(e8.lineOf(e8.point()), e8.lineOf(at) + 2);
  });
});

ertDeftest("magit-back-to-indentation-skips-a-hunk-lines-marker", () => {
  const dir = tempDir();
  init(dir);
  write(dir, "a.txt", "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "A");
  write(dir, "a.txt", "one\n    indented\n");
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("TAB");
    gotoText("+    indented");
    e8.gotoChar(e8.lineEndPosition());
    e8.executeKbdMacro("M-m");
    shouldEqual(e8.bufferSubstringNoProperties(e8.point(), e8.lineEndPosition()), "indented");
  });
});

ertDeftest("magit-clean-removes-untracked-files", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-clean")} RET ${typed("yes")} RET`);
    should(!e8.fileExistsP(e8.expandFileName("c.txt", dir)), "c.txt is removed");
    should(e8.fileExistsP(e8.expandFileName("a.txt", dir)), "a.txt is kept");
  });
});
