// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of applying, after magit-apply.el: a hunk, a file or lines of a
// commit's or a stash's diff applied to the worktree or reversed, files
// staged and unstaged by name, untracked directories staged and
// deleted, the lines of a region discarded, conflicts resolved by
// keeping a side, new and renamed files discarded, and a quick reset.
// Each test checks the worktree and index git shows afterwards.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitApplyAdjustHunkNewStarts } from "magit-apply";
import { changes, git, gotoText, init, read, repo, status, tempDir, typed, visible, withRepos, write } from "magit-test-helpers";

const lines = (n: number, change: (i: number) => string = (i) => `l${i}`): string => Array.from({ length: n }, (_, i) => `${change(i + 1)}\n`).join("");

/** A repository whose f.txt has twenty lines, and a branch topic changing the 2nd and 19th, two hunks; main is checked out. */
function topic(): string {
  const dir = tempDir();
  init(dir);
  write(dir, "f.txt", lines(20));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Twenty lines");
  git(dir, "checkout", "-q", "-b", "topic");
  write(dir, "f.txt", lines(20, (i) => (i === 2 || i === 19 ? `L${i}` : `l${i}`)));
  git(dir, "commit", "-q", "-am", "Two changes");
  git(dir, "checkout", "-q", "main");
  return dir;
}

/** A repository in a merge stopped on a conflict in f.txt, in diff3 style: main has B-ours, other B-theirs, their base b. */
function conflict(): string {
  const dir = tempDir();
  init(dir);
  write(dir, "f.txt", "a\nb\nc\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Base");
  git(dir, "checkout", "-q", "-b", "other");
  write(dir, "f.txt", "a\nB-theirs\nc\n");
  git(dir, "commit", "-q", "-am", "Theirs");
  git(dir, "checkout", "-q", "main");
  write(dir, "f.txt", "a\nB-ours\nc\n");
  git(dir, "commit", "-q", "-am", "Ours");
  git(dir, "config", "merge.conflictStyle", "diff3");
  git(dir, "merge", "-q", "other");
  return dir;
}

/** Shows the conflict's hunk in the status buffer. */
function showConflict(dir: string): void {
  status(dir);
  if (visible()[0].includes("@@@")) return;
  gotoText("unmerged   f.txt");
  e8.executeKbdMacro("TAB");
}

const showCommit = (rev: string): void => e8.executeKbdMacro(`M-x ${typed("magit-show-commit")} RET ${typed(rev)} RET`);
const porcelain = (dir: string): string => git(dir, "status", "--porcelain");

/** Runs BODY with VARIABLE set to VALUE, then sets it back. */
function withVariable(variable: string, value: e8.Value, body: () => void): void {
  const old = e8.variable(variable);
  e8.setVariable(variable, value);
  try {
    body();
  } finally {
    e8.setVariable(variable, old ?? null);
  }
}

ertDeftest("magit-apply-adjusts-the-new-starts-of-hunks", () => {
  shouldEqual(magitApplyAdjustHunkNewStarts(["@@ -10,6 +11,7 @@\n", "@@ -18,6 +20,7 @@ x\n"]), ["@@ -10,6 +10,7 @@\n", "@@ -18,6 +19,7 @@ x\n"]);
  shouldEqual(magitApplyAdjustHunkNewStarts(["@@ -2 +2 @@\n"]), ["@@ -2 +2 @@\n"]);
});

ertDeftest("magit-apply-a-hunk-a-file-and-lines-from-a-commit", () => {
  const dir = topic();
  withRepos([dir], () => {
    status(dir);
    showCommit("topic");
    shouldEqual(e8.variable("major-mode"), "magit-revision-mode");
    // a on the second hunk applies just it to the worktree, not the index.
    gotoText("+L19");
    e8.executeKbdMacro("a");
    shouldEqual(read(dir, "f.txt"), lines(20, (i) => (i === 19 ? "L19" : `l${i}`)));
    shouldEqual(git(dir, "diff", "--cached"), "");
    git(dir, "checkout", "--", "f.txt");
    // On the file, both hunks; with C-u, a 3-way merge, into the index too.
    gotoText("modified   f.txt");
    e8.executeKbdMacro("C-u a");
    shouldEqual(read(dir, "f.txt"), lines(20, (i) => (i === 2 || i === 19 ? `L${i}` : `l${i}`)));
    should(git(dir, "diff", "--cached").includes("+L2"), "--3way applies to the index too");
    git(dir, "reset", "-q", "--hard");
    // The lines of a region: only the +L2 line, its -l2 kept.
    gotoText("+L2\n");
    e8.setMark(e8.point());
    e8.gotoChar(e8.point() + 3);
    e8.activateMark();
    e8.executeKbdMacro("a");
    shouldEqual(read(dir, "f.txt"), lines(20, (i) => (i === 2 ? "l2\nL2" : `l${i}`)));
  });
});

ertDeftest("magit-apply-a-hunk-from-a-stash", () => {
  const dir = repo();
  withRepos([dir], () => {
    git(dir, "stash", "-q");
    shouldEqual(read(dir, "a.txt"), "one\ntwo\nthree\n");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-stash-show")} RET ${typed("stash@{0}")} RET`);
    shouldEqual(e8.variable("major-mode"), "magit-stash-mode");
    gotoText("+four");
    e8.executeKbdMacro("a");
    shouldEqual(read(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    // On an unstaged change it is already there.
    status(dir);
    gotoText("modified   a.txt");
    let error = "";
    try {
      e8.executeKbdMacro("a");
    } catch (e) {
      error = String(e);
    }
    should(error.includes("Change is already in the working tree"), error);
  });
});

ertDeftest("magit-reverse-a-commits-hunk-and-in-the-index", () => {
  const dir = topic();
  withRepos([dir], () => {
    git(dir, "merge", "-q", "topic");
    status(dir);
    showCommit("HEAD");
    // v reverses the hunk in the worktree, after asking.
    gotoText("+L19");
    e8.executeKbdMacro("v y");
    shouldEqual(read(dir, "f.txt"), lines(20, (i) => (i === 2 ? "L2" : `l${i}`)));
    shouldEqual(git(dir, "diff", "--cached"), "");
    git(dir, "checkout", "--", "f.txt");
    // u on a committed hunk reverses it in the index only, as magit-reverse-in-index.
    gotoText("+L2\n");
    e8.executeKbdMacro("u y");
    shouldEqual(changes(git(dir, "diff", "--cached")), ["--- a/f.txt", "+++ b/f.txt", "-L2", "+l2"]);
    shouldEqual(read(dir, "f.txt"), lines(20, (i) => (i === 2 || i === 19 ? `L${i}` : `l${i}`)));
  });
});

ertDeftest("magit-stage-files-and-unstage-files-read-names", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // On the headers, s and u read files, as magit-stage-files and magit-unstage-files.
    e8.gotoChar(e8.pointMin());
    e8.executeKbdMacro(`s ${typed("a.txt")} RET`);
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "a.txt\nb.txt\n");
    e8.gotoChar(e8.pointMin());
    e8.executeKbdMacro(`u ${typed("b.txt")} RET`);
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "a.txt\n");
    // M-x magit-unstage-files takes several, separated by commas.
    e8.executeKbdMacro(`s ${typed("b.txt")} RET`);
    e8.executeKbdMacro(`M-x ${typed("magit-unstage-files")} RET ${typed("a.txt,b.txt")} RET`);
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "");
  });
});

ertDeftest("magit-stage-modified-and-unstage-all-ask-as-magit-does", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // b.txt is staged already: S asks; C-u S stages the untracked c.txt too.
    e8.executeKbdMacro("C-u S y");
    shouldEqual(porcelain(dir), "M  a.txt\nM  b.txt\nA  c.txt\n");
    // Nothing unstaged or untracked: U does not ask.
    e8.executeKbdMacro("U");
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "");
    git(dir, "add", "b.txt");
    // With a change unstaged it asks, unless magit-no-confirm has unstage-all-changes.
    let error = "";
    try {
      e8.executeKbdMacro("U n");
    } catch (e) {
      error = String(e);
    }
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "b.txt\n");
    withVariable("magit-no-confirm", ["unstage-all-changes"], () => e8.executeKbdMacro("U"));
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "");
    void error;
  });
});

ertDeftest("magit-stage-untracked-directories-and-intent-to-add", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.makeDirectory(e8.expandFileName("sub", dir));
    write(dir, "sub/x.txt", "x\n");
    write(dir, "sub/y.txt", "y\n");
    status(dir);
    gotoText("Untracked files");
    e8.executeKbdMacro("TAB");
    gotoText("sub/");
    e8.executeKbdMacro("s");
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "b.txt\nsub/x.txt\nsub/y.txt\n");
    // With a prefix argument, the file's name only.
    gotoText("c.txt");
    e8.executeKbdMacro("C-u s");
    should(porcelain(dir).includes(" A c.txt"), porcelain(dir));
    // u on it, now unstaged as an intent to add, unstages it.
    gotoText("new file   c.txt");
    e8.executeKbdMacro("u");
    should(porcelain(dir).includes("?? c.txt"), porcelain(dir));
  });
});

ertDeftest("magit-discard-untracked-directories-new-and-renamed-files", () => {
  const dir = repo();
  withRepos([dir], () => {
    withVariable("magit-delete-by-moving-to-trash", false, () => {
      e8.makeDirectory(e8.expandFileName("sub", dir));
    write(dir, "sub/x.txt", "x\n");
      status(dir);
      gotoText("Untracked files");
      e8.executeKbdMacro("TAB");
      gotoText("sub/");
      e8.executeKbdMacro(`k y ${typed("yes")} RET`);
      should(!e8.fileExistsP(e8.expandFileName("sub", dir)), "sub is deleted");
      // A new file staged and changed no more: deleted, from the index too.
      git(dir, "add", "c.txt");
      status(dir);
      gotoText("new file   c.txt");
      e8.executeKbdMacro("k y");
      should(!e8.fileExistsP(e8.expandFileName("c.txt", dir)), "c.txt is deleted");
      should(!porcelain(dir).includes("c.txt"), porcelain(dir));
      // A rename staged: undone.
      git(dir, "reset", "-q", "--hard");
      git(dir, "mv", "b.txt", "d.txt");
      status(dir);
      gotoText("renamed    b.txt -> d.txt");
      e8.executeKbdMacro("k y");
      shouldEqual(porcelain(dir), "");
      shouldEqual(read(dir, "b.txt"), "keep\n");
    });
  });
});

ertDeftest("magit-discard-the-lines-of-a-region-and-staged-hunks", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("TAB");
    gotoText("+four");
    e8.setMark(e8.point());
    e8.gotoChar(e8.point() + 5);
    e8.activateMark();
    e8.executeKbdMacro("k y");
    shouldEqual(read(dir, "a.txt"), "one\nTWO\nthree\n");
    // A staged hunk with nothing unstaged in its file goes from the index and worktree.
    gotoText("modified   b.txt");
    e8.executeKbdMacro("TAB");
    gotoText("+more");
    e8.executeKbdMacro("k y");
    shouldEqual(read(dir, "b.txt"), "keep\n");
    shouldEqual(git(dir, "diff", "--cached"), "");
  });
});

ertDeftest("magit-smerge-keep-a-side-of-a-conflict", () => {
  const dir = conflict();
  withRepos([dir], () => {
    showConflict(dir);
    // C-c ^ u on the hunk keeps the upper version, ours.
    gotoText("@@@");
    e8.executeKbdMacro("C-c ^ u");
    shouldEqual(read(dir, "f.txt"), "a\nB-ours\nc\n");
    git(dir, "checkout", "--merge", "--", "f.txt");
    showConflict(dir);
    // k in theirs keeps theirs without asking which.
    gotoText("B-theirs");
    e8.executeKbdMacro("k y");
    shouldEqual(read(dir, "f.txt"), "a\nB-theirs\nc\n");
    git(dir, "checkout", "--merge", "--", "f.txt");
    showConflict(dir);
    // k on a line of the hunk outside the conflict asks which side; b, the base.
    gotoText("  a\n");
    e8.executeKbdMacro("k y b");
    shouldEqual(read(dir, "f.txt"), "a\nb\nc\n");
    git(dir, "checkout", "--merge", "--", "f.txt");
    showConflict(dir);
    // C-c ^ a keeps them all.
    gotoText("@@@");
    e8.executeKbdMacro("C-c ^ a");
    shouldEqual(read(dir, "f.txt"), "a\nB-ours\nb\nB-theirs\nc\n");
  });
});

ertDeftest("magit-discard-an-unmerged-file-checks-out-a-stage", () => {
  const dir = conflict();
  withRepos([dir], () => {
    status(dir);
    gotoText("unmerged   f.txt");
    e8.executeKbdMacro("k t");
    shouldEqual(read(dir, "f.txt"), "a\nB-theirs\nc\n");
    shouldEqual(git(dir, "diff", "--name-only", "--diff-filter=U"), "");
    shouldEqual(porcelain(dir), "M  f.txt\n");
  });
});

ertDeftest("magit-reset-quickly-resets-head-and-the-index", () => {
  const dir = topic();
  withRepos([dir], () => {
    git(dir, "merge", "-q", "topic");
    status(dir);
    e8.executeKbdMacro(`x ${typed("HEAD~")} RET`);
    shouldEqual(git(dir, "log", "-1", "--format=%s"), "Twenty lines\n");
    shouldEqual(porcelain(dir), " M f.txt\n");
    e8.executeKbdMacro(`C-u x ${typed("HEAD")} RET`);
    shouldEqual(porcelain(dir), "");
  });
});

ertDeftest("magit-post-stage-hook-runs-after-staging", () => {
  const dir = repo();
  withRepos([dir], () => {
    let staged = 0;
    let unstaged = 0;
    const onStage = (): void => void staged++;
    const onUnstage = (): void => void unstaged++;
    e8.addHook("magit-post-stage-hook", onStage);
    e8.addHook("magit-post-unstage-hook", onUnstage);
    try {
      status(dir);
      gotoText("modified   a.txt");
      e8.executeKbdMacro("s");
      gotoText("modified   a.txt");
      e8.executeKbdMacro("u");
    } finally {
      e8.removeHook("magit-post-stage-hook", onStage);
      e8.removeHook("magit-post-unstage-hook", onUnstage);
    }
    shouldEqual([staged, unstaged], [1, 1]);
  });
});
