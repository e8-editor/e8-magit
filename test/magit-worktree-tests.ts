// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of worktrees, after magit-worktree.el: checking a commit out in a
// new worktree, a new branch in one, moving and deleting one, and the
// section listing them.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitInsertWorktrees, magitWorktreeDeleteDirectory, magitWorktreeMoveTo } from "magit-worktree";
import { inserters } from "magit-diff";
import { git, history, status, typed, withRepos } from "magit-test-helpers";

/** The directory beside DIR the sibling reader proposes, NAME after its prefix and an underscore. */
function sibling(dir: string, name: string): string {
  const path = dir.replace(/\/$/, "");
  const base = e8.fileNameNondirectory(path);
  const prefix = base.includes("_") ? base.slice(0, base.indexOf("_")) : base;
  return `${e8.fileNameDirectory(path)}${prefix}_${name}/`;
}

/** The paths of the worktrees git lists for DIR, as directory names. */
const worktrees = (dir: string): string[] => git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => `${l.slice(9)}/`);

ertDeftest("magit-worktree-checkout-checks-a-commit-out-beside-the-repository", () => {
  const dir = history();
  const wt = sibling(dir, "wt");
  withRepos([dir, wt], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-worktree-checkout")} RET ${typed("HEAD~1")} RET ${typed("wt")} RET`);
    shouldEqual(worktrees(dir), [dir, wt]);
    shouldEqual(git(wt, "rev-parse", "HEAD"), git(dir, "rev-parse", "HEAD~1"));
    should(e8.fileExistsP(`${wt}two.txt`) && !e8.fileExistsP(`${wt}three.txt`), "the worktree has HEAD~1's files");
    // The new worktree's status shows.
    shouldEqual(e8.variable("major-mode"), "magit-status-mode");
    shouldEqual(e8.fileNameAsDirectory(e8.fileTruename(String(e8.variable("default-directory")))), wt);
  });
});

ertDeftest("magit-worktree-branch-makes-a-branch-in-a-new-worktree", () => {
  const dir = history();
  const wt = sibling(dir, "feature");
  withRepos([dir, wt], () => {
    status(dir);
    // The start first, then the name, then the directory, which the
    // sibling reader proposes after the branch.
    e8.executeKbdMacro(`M-x ${typed("magit-worktree-branch")} RET ${typed("HEAD~2")} RET ${typed("feature")} RET RET`);
    shouldEqual(worktrees(dir), [dir, wt]);
    shouldEqual(git(wt, "symbolic-ref", "--short", "HEAD"), "feature\n");
    shouldEqual(git(dir, "rev-parse", "feature"), git(dir, "rev-parse", "HEAD~2"));
    shouldEqual(git(dir, "symbolic-ref", "--short", "HEAD"), "main\n", "the main worktree stays on main");
  });
});

ertDeftest("magit-worktree-move-moves-a-worktree", () => {
  const dir = history();
  const wt = sibling(dir, "old");
  const moved = sibling(dir, "new");
  // The old directory is gone once moved, so it is not one to clean up.
  withRepos([dir, moved], () => {
    git(dir, "worktree", "add", "-q", "--detach", wt, "HEAD");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-worktree-move")} RET ${typed(wt)} RET ${typed(`../${e8.fileNameNondirectory(moved.replace(/\/$/, ""))}`)} RET`);
    shouldEqual(worktrees(dir), [dir, moved]);
    should(!e8.fileExistsP(wt), "the old directory is gone");
  });
});

ertDeftest("magit-worktree-move-refuses-the-main-worktree", () => {
  const dir = history();
  const wt = sibling(dir, "wt");
  withRepos([dir, wt], () => {
    git(dir, "worktree", "add", "-q", "--detach", wt, "HEAD");
    status(dir);
    const refused = e8.conditionCase(() => {
      magitWorktreeMoveTo(dir, sibling(dir, "elsewhere"));
      return false;
    }, { "user-error": () => true });
    should(refused, "a user-error");
    shouldEqual(worktrees(dir), [dir, wt]);
  });
});

ertDeftest("magit-worktree-delete-deletes-a-worktree", () => {
  const dir = history();
  const wt = sibling(dir, "gone");
  withRepos([dir], () => {
    git(dir, "worktree", "add", "-q", "--detach", wt, "HEAD");
    status(dir);
    e8.letBind({ "magit-delete-by-moving-to-trash": false }, () => {
      e8.executeKbdMacro(`M-x ${typed("magit-worktree-delete")} RET ${typed(wt)} RET y`);
    });
    should(!e8.fileExistsP(wt), "the directory is deleted");
    shouldEqual(worktrees(dir), [dir], "and pruned");
  });
});

ertDeftest("magit-worktree-delete-refuses-the-main-worktree", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    const refused = e8.conditionCase(() => {
      magitWorktreeDeleteDirectory(dir);
      return false;
    }, { "user-error": () => true });
    should(refused, "a user-error");
    should(e8.fileExistsP(`${dir}.git`), "nothing deleted");
  });
});

ertDeftest("magit-insert-worktrees-lists-the-worktrees", () => {
  const dir = history();
  const wt = sibling(dir, "wt");
  const fb = sibling(dir, "fb");
  withRepos([dir, wt, fb], () => {
    should(inserters.get("magit-insert-worktrees") === magitInsertWorktrees, "registered as an inserter");
    // One worktree: nothing.
    status(dir);
    e8.withCurrentBuffer(e8.currentBuffer(), () => {
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.gotoChar(e8.pointMax());
        const before = e8.pointMax();
        magitInsertWorktrees();
        shouldEqual(e8.pointMax(), before);
      });
    });
    git(dir, "worktree", "add", "-q", "--detach", wt, "HEAD~1");
    git(dir, "worktree", "add", "-q", "-b", "feature", fb, "HEAD");
    const hook = e8.variable("magit-status-sections-hook") as string[];
    e8.letBind({ "magit-status-sections-hook": [...hook, "magit-insert-worktrees"] }, () => status(dir));
    const text = e8.bufferText();
    const at = text.indexOf("Worktrees (3)");
    should(at >= 0, text);
    const abbrev = git(dir, "rev-parse", "--short", "HEAD~1").trim();
    const name = (d: string) => `../${e8.fileNameNondirectory(d.replace(/\/$/, ""))}/`;
    const width = 1 + Math.max("main".length, "feature".length, abbrev.length);
    const pad = (h: string) => h + " ".repeat(width - h.length);
    // The main worktree first, the others in the order git lists them.
    const lines = text.slice(at).split("\n").slice(0, 5);
    shouldEqual(lines[0], "Worktrees (3)");
    shouldEqual(lines[1], `${pad("main")}${e8.abbreviateFileName(dir)}`);
    shouldEqual([...lines.slice(2, 4)].sort(), [`${pad(abbrev)}${name(wt)}`, `${pad("feature")}${name(fb)}`].sort());
    shouldEqual(lines[4], "");
  });
});

ertDeftest("magit-worktree-menu-visits-a-worktree", () => {
  const dir = history();
  const wt = sibling(dir, "seen");
  withRepos([dir, wt], () => {
    git(dir, "worktree", "add", "-q", "--detach", wt, "HEAD");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-worktree")} RET g ${typed(wt)} RET`);
    shouldEqual(e8.variable("major-mode"), "magit-status-mode");
    shouldEqual(e8.fileNameAsDirectory(e8.fileTruename(String(e8.variable("default-directory")))), wt);
  });
});
