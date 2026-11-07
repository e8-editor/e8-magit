// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of magit-wip.ts, after magit-wip.el: the wip modes commit the
// index and the worktree to refs/wip/ refs after saving, before and
// after staging and discarding, and before a file is first saved;
// magit-wip-commit does on demand; the wip logs show the refs; and
// magit-wip-purge deletes those left without a branch.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitWipLogGetTips, magitWipRef } from "magit-wip";
import { git, gotoText, read, repo, status, typed, withRepos, write } from "magit-test-helpers";

const WTREE = "refs/wip/wtree/refs/heads/main";
const INDEX = "refs/wip/index/refs/heads/main";
const subjects = (dir: string, ref: string): string[] => git(dir, "log", "--format=%s", ref).trim().split("\n");

/** Runs BODY with MODE on, turning it off after. */
function withMode(mode: string, body: () => void): void {
  e8.callWithPrefix(1, mode as e8.CommandName);
  should(e8.variable(mode) === true, `${mode} is on`);
  try {
    body();
  } finally {
    e8.callWithPrefix(0, mode as e8.CommandName);
  }
}

ertDeftest("magit-wip-refs-are-named-after-the-branch", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.letBind({ "default-directory": dir }, () => {
      shouldEqual(magitWipRef("wtree/"), WTREE);
      shouldEqual(magitWipRef("index/", "refs/heads/other"), "refs/wip/index/refs/heads/other");
      shouldEqual(magitWipRef("wtree/", "HEAD"), "refs/wip/wtree/HEAD");
    });
  });
});

ertDeftest("magit-wip-commit-snapshots-the-index-and-the-worktree", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-wip-commit")} RET`);
    shouldEqual(subjects(dir, WTREE), ["wip-save tracked files", "start autosaving worktree", "First commit"]);
    shouldEqual(subjects(dir, INDEX), ["wip-save tracked files", "start autosaving index", "First commit"]);
    // The worktree ref has a.txt as it is in the worktree, the index ref b.txt as staged.
    shouldEqual(git(dir, "show", `${WTREE}:a.txt`), read(dir, "a.txt"));
    shouldEqual(git(dir, "show", `${INDEX}:b.txt`), "keep\nmore\n");
    shouldEqual(git(dir, "show", `${INDEX}:a.txt`), "one\ntwo\nthree\n");
    // The real index is left alone.
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "b.txt\n");
    // Nothing changed, nothing committed.
    e8.executeKbdMacro(`M-x ${typed("magit-wip-commit")} RET`);
    shouldEqual(subjects(dir, WTREE).length, 3);
  });
});

ertDeftest("magit-wip-after-save-mode-commits-a-saved-file", () => {
  const dir = repo();
  withRepos([dir], () => {
    withMode("magit-wip-after-save-mode", () => {
      e8.call("switch-to-buffer", e8.findFileNoselect(e8.expandFileName("a.txt", dir)));
      should(e8.variable("magit-wip-after-save-local-mode") === true, "the local mode is on in a tracked file's buffer");
      e8.gotoChar(e8.pointMax());
      e8.insert("five\n");
      e8.call("save-buffer");
      shouldEqual(subjects(dir, WTREE), ["autosave a.txt after save", "start autosaving worktree", "First commit"]);
      shouldEqual(git(dir, "show", `${WTREE}:a.txt`), "one\nTWO\nthree\nfour\nfive\n");
      // An untracked file's buffer is left out.
      e8.call("switch-to-buffer", e8.findFileNoselect(e8.expandFileName("c.txt", dir)));
      should(e8.variable("magit-wip-after-save-local-mode") !== true, "not in an untracked file's buffer");
    });
  });
});

ertDeftest("magit-wip-mode-commits-before-and-after-staging-and-discarding", () => {
  const dir = repo();
  withRepos([dir], () => {
    withMode("magit-wip-mode", () => {
      for (const m of ["magit-wip-after-save-mode", "magit-wip-after-apply-mode", "magit-wip-before-change-mode", "magit-wip-initial-backup-mode"]) should(e8.variable(m) === true, `${m} is on`);
      status(dir);
      gotoText("modified   a.txt");
      e8.executeKbdMacro("s");
      shouldEqual(subjects(dir, INDEX), ["autosave a.txt after stage", "start autosaving index", "First commit"]);
      shouldEqual(git(dir, "show", `${INDEX}:a.txt`), "one\nTWO\nthree\nfour\n");
      // The worktree's version, saved before staging, is kept when discarded.
      gotoText("modified   a.txt");
      e8.executeKbdMacro("u");
      gotoText("modified   a.txt");
      e8.executeKbdMacro("k y");
      shouldEqual(read(dir, "a.txt"), "one\ntwo\nthree\n");
      shouldEqual(subjects(dir, WTREE), ["autosave a.txt after discard", "autosave a.txt before stage", "start autosaving worktree", "First commit"]);
      shouldEqual(git(dir, "show", `${WTREE}~1:a.txt`), "one\nTWO\nthree\nfour\n");
    });
    should(e8.variable("magit-wip-after-apply-mode") !== true, "turning magit-wip-mode off turns its modes off");
  });
});

ertDeftest("magit-wip-initial-backup-mode-commits-before-the-first-save", () => {
  const dir = repo();
  withRepos([dir], () => {
    withMode("magit-wip-initial-backup-mode", () => {
      e8.call("switch-to-buffer", e8.findFileNoselect(e8.expandFileName("b.txt", dir)));
      e8.gotoChar(e8.pointMax());
      e8.insert("again\n");
      e8.call("save-buffer");
      shouldEqual(subjects(dir, WTREE), ["autosave b.txt before save", "start autosaving worktree", "First commit"]);
      shouldEqual(git(dir, "show", `${WTREE}:b.txt`), "keep\nmore\n");
      // Only once a buffer.
      e8.insert("and again\n");
      e8.call("save-buffer");
      shouldEqual(subjects(dir, WTREE).length, 3);
    });
  });
});

ertDeftest("magit-wip-log-current-shows-the-branch-and-its-wip-refs", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-wip-commit")} RET`);
    e8.letBind({ "default-directory": dir }, () => shouldEqual(magitWipLogGetTips(WTREE, 1), [WTREE]));
    e8.executeKbdMacro(`M-x ${typed("magit-wip-log-current")} RET`);
    shouldEqual(String(e8.variable("major-mode")), "magit-log-mode");
    shouldEqual(e8.variable("magit-buffer-revisions"), ["main", WTREE, INDEX]);
    should(e8.bufferText().includes("wip-save tracked files"), e8.bufferText());
    // The log menu's Wiplog group shows only while a wip mode is on.
    status(dir);
    withMode("magit-wip-after-apply-mode", () => {
      e8.executeKbdMacro(`M-x ${typed("magit-wip-log-worktree")} RET`);
      shouldEqual(e8.variable("magit-buffer-revisions"), [WTREE]);
    });
  });
});

ertDeftest("magit-wip-purge-deletes-wip-refs-without-a-branch", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    git(dir, "branch", "gone");
    git(dir, "update-ref", "refs/wip/wtree/refs/heads/gone", "HEAD");
    e8.executeKbdMacro(`M-x ${typed("magit-wip-commit")} RET`);
    e8.executeKbdMacro(`M-x ${typed("magit-wip-purge")} RET`);
    should(git(dir, "show-ref", "refs/wip/wtree/refs/heads/gone") !== "", "a wip ref with its branch is kept");
    git(dir, "branch", "-D", "gone");
    e8.executeKbdMacro(`M-x ${typed("magit-wip-purge")} RET y`);
    shouldEqual(git(dir, "show-ref", "refs/wip/wtree/refs/heads/gone"), "");
    should(git(dir, "show-ref", WTREE) !== "", "main's wip ref is kept");
  });
});
