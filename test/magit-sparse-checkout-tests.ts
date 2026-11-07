// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit-sparse-checkout's tests, with ERT: the menu as the checkout is
// sparse or not, enabling, setting, adding, reapplying and disabling,
// each checked by what git and the working tree say afterwards, and the
// status header saying what the checkout includes.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { git, init, settle, status, tempDir, typed, withRepos, write } from "magit-test-helpers";
import { magitSparseCheckoutDirectories, magitSparseCheckoutEnabledP, magitSparseCheckoutSet } from "magit-sparse-checkout";

/** A repository with top.txt and the directories a, b and c/d, a file in each. */
function tree(): string {
  const dir = tempDir();
  init(dir);
  for (const f of ["top.txt", "a/a.txt", "b/b.txt", "c/d/d.txt"]) {
    e8.makeDirectory(e8.fileNameDirectory(`${dir}${f}`)!, { parents: true });
    write(dir, f, `${f}\n`);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Tree");
  return dir;
}

const exists = (dir: string, file: string): boolean => e8.fileExistsP(`${dir}${file}`);
/** Runs BODY, which starts git without waiting, and waits for git to finish. */
function awaitingGit(body: () => void): void {
  const before = e8.messages().length;
  body();
  settle(() => e8.messages().slice(before).some((m) => m === "Git finished" || m.startsWith("Git error")));
}
const sparseList = (dir: string): string[] => git(dir, "sparse-checkout", "list").split("\n").filter((l) => l !== "");
/** The menu's text, closed again. */
function menu(): string {
  e8.call("magit-sparse-checkout" as e8.CommandName);
  const text = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
  e8.executeKbdMacro("C-g");
  return text;
}

ertDeftest("magit-sparse-checkout-the-menu-follows-whether-the-checkout-is-sparse", () => {
  const dir = tree();
  withRepos([dir], () => {
    status(dir);
    let text = menu();
    for (const line of ["Arguments for enabling", " -i Use sparse index (--sparse-index)", "Actions", " e Enable sparse checkout", " s Set directories", " a Add directories"])
      should(text.includes(line), `the menu has ${JSON.stringify(line)}:\n${text}`);
    should(!text.includes("Disable sparse checkout"), text);
    git(dir, "sparse-checkout", "init", "--cone");
    text = menu();
    for (const line of [" d Disable sparse checkout", " r Reapply rules", " s Set directories", " a Add directories"])
      should(text.includes(line), `the menu has ${JSON.stringify(line)}:\n${text}`);
    should(!text.includes("Arguments for enabling") && !text.includes("Enable sparse checkout"), text);
  });
});

ertDeftest("magit-sparse-checkout-enable-makes-a-sparse-checkout-in-cone-mode", () => {
  const dir = tree();
  withRepos([dir], () => {
    status(dir);
    shouldEqual(magitSparseCheckoutEnabledP(), false);
    awaitingGit(() => e8.executeKbdMacro(`M-x ${typed("magit-sparse-checkout")} RET - i e`));
    shouldEqual(magitSparseCheckoutEnabledP(), true);
    shouldEqual(git(dir, "config", "core.sparseCheckoutCone").trim(), "true");
    shouldEqual(git(dir, "config", "index.sparse").trim(), "true");
    should(exists(dir, "top.txt") && !exists(dir, "a/a.txt") && !exists(dir, "c/d/d.txt"), "only the top-level files are left");
    shouldEqual(magitSparseCheckoutDirectories(), []);
  });
});

ertDeftest("magit-sparse-checkout-set-and-add-choose-the-directories", () => {
  const dir = tree();
  withRepos([dir], () => {
    status(dir);
    // Setting enables the sparse checkout first.
    awaitingGit(() => e8.executeKbdMacro(`M-x ${typed("magit-sparse-checkout-set")} RET ${typed("a, c/d")} RET`));
    shouldEqual(sparseList(dir), ["a", "c/d"]);
    shouldEqual(magitSparseCheckoutDirectories(), ["a/", "c/d/"]);
    should(exists(dir, "a/a.txt") && exists(dir, "c/d/d.txt") && !exists(dir, "b/b.txt"), "a and c/d are checked out, b is not");
    awaitingGit(() => e8.executeKbdMacro(`M-x ${typed("magit-sparse-checkout-add")} RET ${typed("b")} RET`));
    shouldEqual(sparseList(dir), ["a", "b", "c/d"]);
    // Setting again overrides the directories.
    awaitingGit(() => e8.executeKbdMacro(`M-x ${typed("magit-sparse-checkout-set")} RET ${typed("b")} RET`));
    shouldEqual(sparseList(dir), ["b"]);
  });
});

ertDeftest("magit-sparse-checkout-set-refuses-a-sparse-checkout-without-cone-mode", () => {
  const dir = tree();
  withRepos([dir], () => {
    status(dir);
    git(dir, "sparse-checkout", "init", "--no-cone");
    let error = "";
    try {
      magitSparseCheckoutSet(["a"]);
    } catch (e) {
      error = String(e);
    }
    should(error.includes("Magit's sparse checkout functionality requires cone mode"), error);
  });
});

ertDeftest("magit-sparse-checkout-reapply-and-disable", () => {
  const dir = tree();
  withRepos([dir], () => {
    status(dir);
    awaitingGit(() => magitSparseCheckoutSet(["a"]));
    // A file outside the sparse checkout comes back, as a merge may bring it; reapplying takes it away again.
    git(dir, "update-index", "--no-skip-worktree", "b/b.txt");
    e8.makeDirectory(`${dir}b`, { parents: true });
    write(dir, "b/b.txt", "b/b.txt\n");
    git(dir, "update-index", "--refresh");
    should(exists(dir, "b/b.txt"), "b.txt is back");
    awaitingGit(() => e8.executeKbdMacro(`M-x ${typed("magit-sparse-checkout")} RET r`));
    should(!exists(dir, "b/b.txt"), "reapplying the rules removes b.txt");
    awaitingGit(() => e8.executeKbdMacro(`M-x ${typed("magit-sparse-checkout")} RET d`));
    shouldEqual(magitSparseCheckoutEnabledP(), false);
    should(exists(dir, "b/b.txt") && exists(dir, "c/d/d.txt"), "a full checkout again");
    // The directories are kept for enabling again.
    should(e8.readTextFile(`${dir}.git/info/sparse-checkout`).includes("/a/"), "the rules are kept");
  });
});

ertDeftest("magit-sparse-checkout-insert-header-says-what-is-included", () => {
  const dir = tree();
  withRepos([dir], () => {
    e8.letBind({ "magit-status-headers-hook": ["magit-insert-head-branch-header", "magit-sparse-checkout-insert-header"] }, () => {
      status(dir);
      should(!e8.bufferText().includes("Sparse!"), "no header without a sparse checkout");
      git(dir, "sparse-checkout", "init", "--cone");
      e8.executeKbdMacro("g");
      should(e8.bufferText().includes("\nSparse!   top-level directory\n"), e8.bufferText());
      git(dir, "sparse-checkout", "set", "a");
      e8.executeKbdMacro("g");
      should(e8.bufferText().includes("\nSparse!   a/\n"), e8.bufferText());
      git(dir, "sparse-checkout", "set", "a", "b");
      e8.executeKbdMacro("g");
      should(e8.bufferText().includes("\nSparse!   2 directories\n"), e8.bufferText());
      const at = e8.bufferText().indexOf("Sparse!");
      shouldEqual(e8.getTextProperty(e8.pointMin() + at, "font-lock-face"), "magit-section-heading");
    });
  });
});
