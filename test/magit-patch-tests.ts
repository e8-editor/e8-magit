// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of patches, after magit-patch.el: creating patches from a range
// or a single commit, into an output directory, applying a plain patch,
// and saving the diff a buffer shows as a patch.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitPatchSaveFile } from "magit-patch";
import { magitDiffSetupBuffer } from "magit-diff";
import { git, history, read, repo, status, typed, withRepos, write } from "magit-test-helpers";

const exists = (dir: string, file: string): boolean => e8.fileExistsP(e8.expandFileName(file, dir));

ertDeftest("magit-patch-create-writes-a-patch-for-each-commit-of-a-range", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-patch-create")} RET c ${typed("HEAD~2..HEAD")} RET`);
    should(exists(dir, "0001-Two.patch"), "the first commit's patch");
    should(exists(dir, "0002-Three.patch"), "the second commit's patch");
    should(!exists(dir, "0001-One.patch"), "no patch for the commit before the range");
    should(read(dir, "0002-Three.patch").includes("Subject: [PATCH 2/2] Three"), read(dir, "0002-Three.patch"));
  });
});

ertDeftest("magit-patch-create-of-one-commit-writes-its-patch-only", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-patch-create")} RET c ${typed("HEAD~")} RET`);
    should(exists(dir, "0001-Two.patch"), "HEAD~ is HEAD~~..HEAD~: Two's patch");
    should(!exists(dir, "0002-Three.patch"), "no patch for commits after it");
  });
});

ertDeftest("magit-patch-create-writes-into-the-output-directory", () => {
  const dir = history();
  withRepos([dir], () => {
    e8.makeDirectory(e8.expandFileName("out", dir));
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-patch-create")} RET C-m o ${typed("out")} RET c ${typed("HEAD")} RET`);
    should(exists(dir, "out/0001-Three.patch"), "the patch is in out/");
    should(!exists(dir, "0001-Three.patch"), "not in the top directory");
  });
});

ertDeftest("magit-patch-create-from-the-patch-menu", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-patch")} RET c C-m l c ${typed("HEAD")} RET`);
    should(exists(dir, "0001-Three.patch"), "the patch");
    should(exists(dir, "0000-cover-letter.patch"), "the cover letter");
    shouldEqual(e8.fileNameNondirectory(e8.bufferFileName() ?? ""), "0000-cover-letter.patch");
  });
});

ertDeftest("magit-patch-apply-applies-a-patch-file", () => {
  const dir = repo();
  withRepos([dir], () => {
    write(dir, "fix.patch", git(dir, "diff"));
    git(dir, "checkout", "--", "a.txt");
    shouldEqual(read(dir, "a.txt"), "one\ntwo\nthree\n");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-patch-apply")} RET a ${typed("fix.patch")} RET`);
    shouldEqual(read(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "b.txt\n", "the index is left alone");
  });
});

ertDeftest("magit-patch-apply-to-the-index-too", () => {
  const dir = repo();
  withRepos([dir], () => {
    write(dir, "fix.patch", git(dir, "diff"));
    git(dir, "checkout", "--", "a.txt");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-patch-apply")} RET - i a ${typed("fix.patch")} RET`);
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "a.txt\nb.txt\n");
  });
});

ertDeftest("magit-patch-save-writes-the-buffers-diff", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    magitDiffSetupBuffer(undefined, undefined, ["--stat", "--no-ext-diff"], []);
    should(e8.derivedModeP("magit-diff-mode"), "a diff buffer");
    e8.executeKbdMacro(`M-x ${typed("magit-patch-save")} RET ${typed("saved.patch")} RET`);
    const patch = read(dir, "saved.patch");
    should(patch.startsWith("diff --git a/a.txt b/a.txt"), patch);
    should(patch.includes("+TWO"), patch);
    should(!patch.includes("b.txt"), "only the unstaged changes");
    should(!patch.includes("|"), "--stat is left out");
    // The patch applies to what the diff is from.
    git(dir, "checkout", "--", "a.txt");
    shouldEqual(git(dir, "apply", "saved.patch"), "");
    shouldEqual(read(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
  });
});

ertDeftest("magit-patch-save-only-from-a-diff-buffer", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    const r = e8.conditionCase(() => {
      magitPatchSaveFile(e8.expandFileName("x.patch", dir));
      return false;
    }, { "user-error": () => true });
    should(r, "a user-error");
    should(!exists(dir, "x.patch"), "nothing written");
  });
});
