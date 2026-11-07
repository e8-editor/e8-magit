// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit-subtree's tests, with ERT: a local repository's branch or a
// commit is added as a subtree, new commits are merged and pulled into
// it, and its history is split out and pushed, the prefix read in the
// repository or taken from the menu's --prefix.

import { ertDeftest, should, shouldEqual, shouldError } from "ert";
import "magit";
import { magitThisProcess } from "magit-process";
import { git, bare, history, init, read, tempDir, status, withRepos, settle, typed, write } from "magit-test-helpers";
import { magitSubtreeAddCommit, magitSubtreeMerge, magitSubtreePull, magitSubtreePush, magitSubtreeSplit } from "magit-subtree";

/** Waits for COND, and then for the git Magit started last to end. */
function waitFor(cond: () => boolean): void {
  settle(cond);
  settle(() => magitThisProcess()?.exit !== undefined);
}

const exists = (dir: string, file: string): boolean => e8.fileExistsP(`${dir}${file}`);

/** Adds a commit making FILE in LIB. */
function commitIn(lib: string, file: string): void {
  write(lib, file, `${file}\n`);
  git(lib, "add", file);
  git(lib, "commit", "-q", "-m", `Add ${file}`);
}

/**
 * A library repository of three commits of its own: made as history()'s,
 * in the same second, its commits would be the very ones the repository
 * has, which git subtree cannot split.
 */
function library(): string {
  const lib = tempDir();
  init(lib);
  for (const file of ["one.txt", "two.txt", "three.txt"]) commitIn(lib, file);
  return lib;
}

ertDeftest("magit-subtree-add-adds-a-repositorys-ref", () => {
  const lib = library();
  const dir = history();
  withRepos([lib, dir], () => {
    status(dir);
    // The prefix is read relative to the top; the ref is completed from
    // the repository's.
    e8.executeKbdMacro(`M-x ${typed("magit-subtree-add")} RET ${typed("vendor/lib")} RET ${typed(lib)} RET ${typed("refs/heads/main")} RET`);
    waitFor(() => exists(dir, "vendor/lib/three.txt"));
    shouldEqual(read(dir, "vendor/lib/one.txt"), "one.txt\n");
    should(git(dir, "log", "-1", "--format=%s").startsWith("Add 'vendor/lib/' from commit"), git(dir, "log", "-1", "--format=%s"));
  });
});

ertDeftest("magit-subtree-import-menu-gives-prefix-and-squash", () => {
  const lib = library();
  const dir = history();
  withRepos([lib, dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-subtree-import")} RET - P ${typed("ext")} RET - s a ${typed(lib)} RET ${typed("main")} RET`);
    waitFor(() => git(dir, "log", "-1", "--format=%s").endsWith("as 'ext'\n"));
    should(exists(dir, "ext/two.txt"), "the subtree is at the menu's prefix");
    // --squash makes a squashed commit, merged in as the second parent.
    should(git(dir, "log", "-1", "--format=%s", "HEAD^2").startsWith("Squashed 'ext/' content"), git(dir, "log", "--format=%s", "-3", "HEAD^2"));
  });
});

ertDeftest("magit-subtree-add-commit-merge-and-pull", () => {
  const lib = library();
  const dir = history();
  withRepos([lib, dir], () => {
    // git subtree merge and pull ask an editor for the merge's message, as
    // Magit runs them without E8 as git's editor; CI has no EDITOR.
    git(dir, "config", "core.editor", "true");
    status(dir);
    git(dir, "fetch", "-q", lib, "main");
    const first = git(dir, "rev-parse", "FETCH_HEAD").trim();
    magitSubtreeAddCommit("lib", first);
    waitFor(() => exists(dir, "lib/one.txt"));
    should(exists(dir, "lib/three.txt"), "added");

    commitIn(lib, "four.txt");
    git(dir, "fetch", "-q", lib, "main");
    magitSubtreeMerge("lib", git(dir, "rev-parse", "FETCH_HEAD").trim());
    waitFor(() => exists(dir, "lib/four.txt"));
    should(exists(dir, "lib/four.txt"), "merged");

    commitIn(lib, "five.txt");
    magitSubtreePull("lib", lib, "main");
    waitFor(() => exists(dir, "lib/five.txt"));
    should(exists(dir, "lib/five.txt"), "pulled");
  });
});

ertDeftest("magit-subtree-split-and-push", () => {
  const lib = library();
  const dir = history();
  const remote = bare();
  withRepos([lib, dir, remote], () => {
    status(dir);
    git(dir, "fetch", "-q", lib, "main");
    git(dir, "subtree", "add", "-q", "--prefix=lib", "FETCH_HEAD");
    e8.executeKbdMacro(`M-x ${typed("magit-subtree-split")} RET ${typed("lib")} RET ${typed("HEAD")} RET`);
    waitFor(() => magitThisProcess()?.args.includes("split") === true);
    // Split, with --branch from the export menu, makes a branch of the
    // subtree's history.
    magitSubtreeSplit("lib", "HEAD", ["--branch=split"]);
    waitFor(() => git(dir, "rev-parse", "-q", "--verify", "split") !== "");
    shouldEqual(git(dir, "ls-tree", "--name-only", "split"), "one.txt\nthree.txt\ntwo.txt\n");
    shouldEqual(git(dir, "rev-parse", "split^{tree}"), git(lib, "rev-parse", "main^{tree}"));

    magitSubtreePush("lib", remote, "main");
    waitFor(() => git(remote, "rev-parse", "-q", "--verify", "main") !== "");
    shouldEqual(git(remote, "rev-parse", "main^{tree}"), git(lib, "rev-parse", "main^{tree}"));
  });
});

ertDeftest("magit-subtree-prefix-outside-the-repository-is-an-error", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    const err = shouldError(() => e8.executeKbdMacro(`M-x ${typed("magit-subtree-split")} RET ${typed("/tmp/elsewhere")} RET`), { type: "user-error" });
    shouldEqual(err.message, `/tmp/elsewhere isn't inside the repository at ${dir}`);
  });
});
