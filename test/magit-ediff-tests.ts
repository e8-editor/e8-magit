// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of Ediff support, after magit-ediff.el: the buffers each command
// compares, staging through the index's buffer, resolving a conflict,
// and what magit-ediff-dwim chooses.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { git, gotoText, init, read, repo, status, tempDir, typed, withRepos, write } from "magit-test-helpers";

const PANEL = "*Ediff Control Panel*";

/** The control panel's variable NAME. */
const ctl = (name: string): e8.Value | undefined => e8.withCurrentBuffer(PANEL, () => e8.variable(name));
/** The name and text of the buffer the control panel's variable NAME holds. */
function compared(name: string): [string, string] {
  const b = ctl(name) as e8.Buffer;
  should(b !== null && b !== undefined, `${name} is set`);
  return [b.name!, e8.withCurrentBuffer(b, () => e8.bufferText())];
}
const exists = (name: string): boolean => e8.getBuffer(name) !== undefined;

/** A repository whose a.txt was one, then two, then three. */
function versions(): string {
  const dir = tempDir();
  init(dir);
  for (const v of ["one", "two", "three"]) {
    write(dir, "a.txt", `${v}\n`);
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", `A ${v}`);
  }
  return dir;
}

/** A repository in the middle of a merge whose f.txt conflicts, with conflict markers in STYLE. */
function conflicted(style = "merge"): string {
  const dir = tempDir();
  init(dir);
  git(dir, "config", "merge.conflictStyle", style);
  write(dir, "f.txt", "a\nb\nc\n");
  git(dir, "add", "f.txt");
  git(dir, "commit", "-q", "-m", "Base");
  git(dir, "checkout", "-q", "-b", "other");
  write(dir, "f.txt", "a\ntheirs\nc\n");
  git(dir, "commit", "-q", "-am", "Theirs");
  git(dir, "checkout", "-q", "main");
  write(dir, "f.txt", "a\nmine\nc\n");
  git(dir, "commit", "-q", "-am", "Mine");
  git(dir, "merge", "-q", "other");
  return dir;
}

ertDeftest("magit-ediff-show-working-tree-compares-head-with-the-file", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-working-tree")} RET ${typed("a.txt")} RET`);
    shouldEqual(e8.bufferName(), PANEL);
    shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-buffers");
    shouldEqual(compared("ediff-buffer-A"), ["a.txt.~HEAD~", "one\ntwo\nthree\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["a.txt", "one\nTWO\nthree\nfour\n"]);
    // Quitting kills the buffers Magit made for it, and Ediff's own.
    e8.executeKbdMacro("q y");
    for (const gone of [PANEL, "a.txt.~HEAD~", "a.txt", "*ediff-diff*", "*ediff-errors*"]) should(!exists(gone), `${gone} is killed`);
  });
});

ertDeftest("magit-ediff-show-staged-and-unstaged-compare-the-index", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // One file is staged, so it is not asked for.
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-staged")} RET`);
    shouldEqual(compared("ediff-buffer-A"), ["b.txt.~HEAD~", "keep\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["b.txt.~{index}~", "keep\nmore\n"]);
    e8.executeKbdMacro("q y");
    should(!exists("b.txt.~{index}~"), "the index's buffer is killed");
    // A buffer that was there before is kept.
    e8.call("find-file", e8.expandFileName("a.txt", dir));
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-unstaged")} RET`);
    shouldEqual(compared("ediff-buffer-A"), ["a.txt.~{index}~", "one\ntwo\nthree\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["a.txt", "one\nTWO\nthree\nfour\n"]);
    e8.executeKbdMacro("q y");
    should(exists("a.txt"), "the file's buffer, visited before, is kept");
    should(!exists("a.txt.~{index}~"), "the index's buffer is killed");
  });
});

ertDeftest("magit-ediff-quitting-puts-the-windows-back", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    const before = e8.windowList().map((w) => e8.windowBuffer(w));
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-working-tree")} RET ${typed("a.txt")} RET`);
    should(e8.windowList().length >= 3, "Ediff shows A, B and its panel");
    e8.executeKbdMacro("q y");
    shouldEqual(
      e8.windowList().map((w) => e8.windowBuffer(w)),
      before,
    );
  });
});

ertDeftest("magit-ediff-stage-copies-a-change-into-the-index", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-stage")} RET ${typed("a.txt")} RET`);
    shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-buffers3");
    shouldEqual(compared("ediff-buffer-A"), ["a.txt.~HEAD~", "one\ntwo\nthree\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["a.txt.~{index}~", "one\ntwo\nthree\n"]);
    shouldEqual(compared("ediff-buffer-C"), ["a.txt", "one\nTWO\nthree\nfour\n"]);
    should(e8.withCurrentBuffer("a.txt.~{index}~", () => !e8.bufferReadOnly()), "the index's buffer can be edited");
    // The first difference, TWO, copied from the file to the index's
    // buffer; quitting updates the index with it, asking first.
    e8.executeKbdMacro("n c b q y y");
    shouldEqual(git(dir, "show", ":a.txt"), "one\nTWO\nthree\n");
    shouldEqual(read(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    should(!exists(PANEL), "the panel is killed");
    should(!exists("a.txt.~{index}~"), "the index's buffer is killed");
  });
});

ertDeftest("magit-ediff-resolve-all-merges-the-sides-into-the-file-and-stages-it", () => {
  const dir = conflicted();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-resolve-all")} RET ${typed("f.txt")} RET`);
    shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-merge-buffers-with-ancestor");
    shouldEqual(compared("ediff-buffer-A"), ["f.txt.~main~", "a\nmine\nc\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["f.txt.~other~", "a\ntheirs\nc\n"]);
    shouldEqual(compared("ediff-ancestor-buffer")[1], "a\nb\nc\n");
    // Git's file is moved out of the way; the merge starts from A.
    shouldEqual(read(dir, "f.txt.ORIG"), "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\nc\n");
    shouldEqual(compared("ediff-buffer-C")[1], "a\nmine\nc\n");
    // Git's markers are what + combines with.
    e8.executeKbdMacro("n +");
    shouldEqual(compared("ediff-buffer-C")[1], `a\n<<<<<<< HEAD\nmine\n||||||| ${git(dir, "merge-base", "main", "other").trim()}\nb\n=======\ntheirs\n>>>>>>> other\nc\n`);
    // Taking B's side and quitting saves the file and stages it.
    e8.executeKbdMacro("b q y");
    shouldEqual(read(dir, "f.txt"), "a\ntheirs\nc\n");
    shouldEqual(git(dir, "ls-files", "-u"), "");
    shouldEqual(git(dir, "status", "--porcelain", "--untracked-files=no"), "M  f.txt\n");
    should(e8.fileExistsP(e8.expandFileName(".git/MERGE_HEAD", dir)), "the merge is still to be committed");
    for (const gone of [PANEL, "f.txt.~main~", "f.txt.~other~"]) should(!exists(gone), `${gone} is killed`);
  });
});

ertDeftest("magit-ediff-resolve-all-leaves-a-file-with-markers-unstaged", () => {
  const dir = conflicted();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-resolve-all")} RET ${typed("f.txt")} RET n + q y`);
    should(read(dir, "f.txt").includes("<<<<<<< HEAD\n"), read(dir, "f.txt"));
    should(git(dir, "ls-files", "-u") !== "", "f.txt is still unmerged");
  });
});

ertDeftest("magit-ediff-resolve-rest-merges-the-conflicts-left-in-the-file", () => {
  const dir = conflicted("diff3");
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-resolve-rest")} RET ${typed("f.txt")} RET`);
    // smerge-ediff's buffers: the upper, lower and base versions.
    shouldEqual(compared("ediff-buffer-A"), ["*f.txt UPPER=HEAD*", "a\nmine\nc\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["*f.txt LOWER=other*", "a\ntheirs\nc\n"]);
    should(compared("ediff-ancestor-buffer")[0].startsWith("*f.txt BASE="), compared("ediff-ancestor-buffer")[0]);
    shouldEqual(compared("ediff-ancestor-buffer")[1], "a\nb\nc\n");
    // Taking A's side; quitting asks to save the file, then kills
    // smerge's buffers. The file is not staged.
    e8.executeKbdMacro("n a q y yes RET");
    shouldEqual(read(dir, "f.txt"), "a\nmine\nc\n");
    should(git(dir, "ls-files", "-u") !== "", "f.txt is left for the user to stage");
    for (const gone of [PANEL, "*f.txt UPPER=HEAD*", "*f.txt LOWER=other*", "*ediff-merge*"]) should(!exists(gone), `${gone} is killed`);
  });
});

ertDeftest("magit-ediff-show-commit-compares-a-commit-with-its-parent", () => {
  const dir = versions();
  withRepos([dir], () => {
    status(dir);
    const head = git(dir, "rev-parse", "--short", "HEAD").trim();
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-commit")} RET ${typed(head)} RET`);
    shouldEqual(compared("ediff-buffer-A"), [`a.txt.~${head}^~`, "two\n"]);
    shouldEqual(compared("ediff-buffer-B"), [`a.txt.~${head}~`, "three\n"]);
    e8.executeKbdMacro("q y");
  });
});

ertDeftest("magit-ediff-show-stash-shows-the-index-as-a-third-buffer", () => {
  const dir = repo();
  withRepos([dir], () => {
    write(dir, "a.txt", "staged\n");
    git(dir, "add", "a.txt");
    write(dir, "a.txt", "worktree\n");
    git(dir, "reset", "-q", "b.txt");
    git(dir, "checkout", "-q", "b.txt");
    git(dir, "stash", "-q");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-stash")} RET ${typed("stash@{0}")} RET`);
    shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-buffers3");
    shouldEqual(compared("ediff-buffer-A"), ["a.txt.~stash@{0}^1~", "one\ntwo\nthree\n"]);
    shouldEqual(compared("ediff-buffer-B"), ["a.txt.~stash@{0}^2~", "staged\n"]);
    shouldEqual(compared("ediff-buffer-C"), ["a.txt.~stash@{0}~", "worktree\n"]);
    e8.executeKbdMacro("q y");
    // Without the index, two buffers.
    e8.setVariable("magit-ediff-show-stash-with-index", false);
    try {
      e8.executeKbdMacro(`M-x ${typed("magit-ediff-show-stash")} RET ${typed("stash@{0}")} RET`);
      shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-buffers");
      shouldEqual(compared("ediff-buffer-B"), ["a.txt.~stash@{0}~", "worktree\n"]);
      e8.executeKbdMacro("q y");
    } finally {
      e8.setVariable("magit-ediff-show-stash-with-index", true);
    }
  });
});

ertDeftest("magit-ediff-dwim-stages-an-uncommitted-file-and-shows-a-commit", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("e");
    shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-buffers3");
    shouldEqual(compared("ediff-buffer-B")[0], "a.txt.~{index}~");
    e8.executeKbdMacro("q y");
    // With magit-ediff-dwim-show-on-hunks, the unstaged changes are shown.
    e8.setVariable("magit-ediff-dwim-show-on-hunks", true);
    try {
      gotoText("modified   a.txt");
      e8.executeKbdMacro("e");
      shouldEqual(String(ctl("ediff-job-name") as symbol | string), "ediff-buffers");
      shouldEqual(compared("ediff-buffer-A")[0], "a.txt.~{index}~");
      e8.executeKbdMacro("q y");
    } finally {
      e8.setVariable("magit-ediff-dwim-show-on-hunks", false);
    }
    // On a commit, its changes: the first commit has no parent, so a
    // second one is made.
    write(dir, "b.txt", "keep\nmore\nstill\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-q", "-m", "Second");
    e8.executeKbdMacro("g");
    const head = git(dir, "rev-parse", "--short", "HEAD").trim();
    gotoText(`${head} main Second`);
    e8.executeKbdMacro("e");
    shouldEqual(compared("ediff-buffer-A"), [`b.txt.~${head}^~`, "keep\n"]);
    shouldEqual(compared("ediff-buffer-B"), [`b.txt.~${head}~`, "keep\nmore\nstill\n"]);
    e8.executeKbdMacro("q y");
  });
});

ertDeftest("magit-ediff-dwim-resolves-a-conflicted-file", () => {
  const dir = conflicted();
  withRepos([dir], () => {
    status(dir);
    gotoText("unmerged   f.txt");
    e8.executeKbdMacro("e");
    // magit-ediff-resolve-rest, as magit-ediff-dwim-resolve-function says.
    shouldEqual(compared("ediff-buffer-A")[0], "*f.txt UPPER=HEAD*");
    e8.executeKbdMacro("n b q y yes RET");
    shouldEqual(read(dir, "f.txt"), "a\ntheirs\nc\n");
  });
});

ertDeftest("magit-ediff-the-e-menu-runs-its-commands", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`E w ${typed("a.txt")} RET`);
    shouldEqual(compared("ediff-buffer-A")[0], "a.txt.~HEAD~");
    e8.executeKbdMacro("q y");
  });
});
