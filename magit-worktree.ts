// SPDX-License-Identifier: GPL-3.0-or-later
//
// Worktrees, after magit-worktree.el: the worktree menu (Z), checking out
// a commit or a new branch in a new worktree, moving and deleting one,
// visiting one's status, and the section listing the worktrees, which a
// status buffer shows when magit-insert-worktrees is on its hook.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";
import { insertHeading, insertSection, magitSectionDefineType } from "magit-section";
import { transientDefinePrefix } from "transient";
import { magitCompletingRead, magitCompletingReadSilentDefault, magitConfirm, magitReadStringNs } from "magit-base";
import {
  magitBranchP,
  magitGetCurrentBranch,
  magitListLocalBranchNames,
  magitListRemoteBranchNames,
  magitListWorktrees,
  magitLocalBranchP,
  magitReadBranchOrCommit,
  magitReadStartingPoint,
  magitRevAbbrev,
  magitRevVerify,
  magitSectionValueIf,
  magitToplevel,
} from "magit-git";
import { magitCallGit, magitRunGit } from "magit-process";
import { magitRefresh } from "magit-mode";
import { inserters } from "magit-diff";
import { magitStatusSetupBuffer } from "magit-status";

// Options.

e8.defineVariable({
  name: "magit-read-worktree-directory-function",
  doc: "Function used to read the directory to be used as a new worktree.\nThis is called with two arguments, the prompt and the branch to be checked out.  When not checking out a branch then use nil for the second argument.",
  value: "magit-read-worktree-directory-sibling",
});
e8.defineVariable({
  name: "magit-read-worktree-offsite-directory",
  doc: "Base directory used by `magit-read-worktree-directory-offsite'.\nThat function is suitable as `magit-read-worktree-directory-function', but is not used by default.",
  value: e8.expandFileName("wtrees/", e8.getenv("XDG_DATA_HOME") ?? "~/.local/share"),
});
e8.defineVariable({
  name: "magit-worktree-read-directory-name-function",
  doc: "Like `magit-read-worktree-directory-function' but takes only one argument.\nObsolete since Magit 4.4.0; use `magit-read-worktree-directory-function'.",
  value: null,
});

// Functions.

const defaultDirectory = (): string => String(e8.variable("default-directory"));

/** Reads a directory, as read-directory-name: the minibuffer starts with DIR and INITIAL after it. */
function readDirectoryName(prompt: string, dir?: string, initial?: string): string {
  const d = e8.fileNameAsDirectory(e8.expandFileName(dir ?? defaultDirectory()));
  return e8.expandFileName(e8.readFileName(prompt, { dir: d, initial: initial !== undefined ? `${d}${initial}` : undefined }));
}

/** The name of a worktree up to its first underscore, as the sibling and offsite readers start new names with. */
const worktreePrefix = (name: string): string => (name.includes("_") ? name.slice(0, name.indexOf("_")) : name);

/** Calls read-directory-name with PROMPT, but ignoring _BRANCH, as magit-read-worktree-directory. */
export const magitReadWorktreeDirectory = (prompt: string, _branch?: string | null): string => readDirectoryName(prompt);
e8.defun("magit-read-worktree-directory", magitReadWorktreeDirectory);

/**
 * Call `read-directory-name' in current worktree.
 * For `read-directory-name's INITIAL argument use a string based on
 * BRANCH, replacing slashes with dashes.  If BRANCH is nil, use nil
 * as INITIAL.  Always forward PROMPT as-is.
 */
export const magitReadWorktreeDirectoryNested = (prompt: string, branch?: string | null): string =>
  readDirectoryName(prompt, undefined, branch ? branch.replace(/\//g, "-") : undefined);
e8.defun("magit-read-worktree-directory-nested", magitReadWorktreeDirectoryNested);

/**
 * Call `read-directory-name' in parent directory of current worktree.
 * For `read-directory-name's INITIAL argument use a string based on the
 * name of the current worktree and BRANCH.  Use "PREFIX_BRANCH" where
 * PREFIX is the name of the current worktree, up to the first underscore,
 * and slashes in BRANCH are replaced with dashes.  If BRANCH is nil use
 * just "PREFIX_".  Always forward PROMPT as-is.
 */
export function magitReadWorktreeDirectorySibling(prompt: string, branch?: string | null): string {
  const path = e8.directoryFileName(defaultDirectory());
  const name = e8.fileNameNondirectory(path);
  return readDirectoryName(prompt, e8.fileNameDirectory(path), `${worktreePrefix(name)}_${branch ? branch.replace(/\//g, "-") : ""}`);
}
e8.defun("magit-read-worktree-directory-sibling", magitReadWorktreeDirectorySibling);

/** A name starting with PREFIX that no file has, as make-temp-name. */
function makeTempName(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (;;) {
    let name = prefix;
    for (let i = 0; i < 6; i++) name += chars[Math.floor(Math.random() * chars.length)];
    if (!e8.fileExistsP(name)) return name;
  }
}

/**
 * Call `read-directory-name' in a directory shared by all repositories.
 *
 * Option `magit-read-worktree-offsite-directory' specifies that shared
 * base directory.
 *
 * For `read-directory-name's INITIAL argument use a string based on the
 * name of the current worktree and BRANCH.  Use "PREFIX_BRANCH" where
 * PREFIX is the name of the current worktree, up to the first underscore,
 * and slashes in BRANCH are replaced with dashes.  If BRANCH is nil use
 * just "PREFIX_".  Always forward PROMPT as-is.
 */
export function magitReadWorktreeDirectoryOffsite(prompt: string, branch?: string | null): string {
  const base = String(e8.variable("magit-read-worktree-offsite-directory"));
  e8.makeDirectory(base, { parents: true });
  const name = `${worktreePrefix(e8.fileNameNondirectory(e8.directoryFileName(defaultDirectory())))}_`;
  return readDirectoryName(prompt, base, branch ? `${name}${branch.replace(/\//g, "-")}` : e8.fileNameNondirectory(makeTempName(e8.expandFileName(name, base))));
}
e8.defun("magit-read-worktree-directory-offsite", magitReadWorktreeDirectoryOffsite);

/** Reads where to check REV out, as magit--read-worktree-directory. */
function readWorktreeDirectory(rev: string, branchp: boolean): string {
  const prompt = `Checkout ${rev} in new worktree: `;
  return e8.letBind({ "default-directory": magitToplevel() ?? defaultDirectory() }, () => {
    const obsolete = e8.variable("magit-worktree-read-directory-name-function");
    if (truthy(obsolete)) return String(e8.funcall(obsolete as string, prompt));
    return String(e8.funcall(e8.variable("magit-read-worktree-directory-function") as string, prompt, branchp ? rev : null));
  });
}

/** A worktree as magit-list-worktrees gives it: its path, a directory name, as its toplevel, and what it has checked out. */
interface Worktree {
  path: string;
  commit?: string;
  branch?: string;
  bare: boolean;
}

/** The worktrees, each path a directory name as Magit's are, through magit-toplevel. */
const listWorktrees = (): Worktree[] =>
  magitListWorktrees().map((w) => ({ ...w, path: (e8.fileDirectoryP(w.path) ? magitToplevel(w.path) : undefined) ?? w.path }));

/** DIRECTORY expanded for git, as magit--expand-worktree. */
const expandWorktree = (directory: string): string => e8.expandFileName(directory);

/** The value of the worktree section at point. */
const worktreeAtPoint = (): string | undefined => {
  const v = magitSectionValueIf("worktree");
  return typeof v === "string" ? v : undefined;
};

/**
 * Visit DIRECTORY in some window, as magit-diff-visit-directory: if it is
 * the top-level directory of the current repository, then Dired lists the
 * directory containing it with point on it, otherwise its status shows.
 */
export function magitDiffVisitDirectory(directory: string): void {
  const dir = e8.fileNameAsDirectory(e8.expandFileName(directory));
  if (magitToplevel(dir) === magitToplevel()) {
    const file = e8.directoryFileName(dir);
    e8.call("dired", e8.fileNameDirectory(file) ?? "/");
    e8.call("dired-goto-file", file);
  } else magitStatusSetupBuffer(dir);
}

/** Reads a new branch's name and start, as magit-branch-read-args. */
export function magitBranchReadArgs(prompt: string, defaultStart?: string): [string, string] {
  let upstreamFirst: e8.Value | undefined = true;
  try {
    upstreamFirst = e8.variable("magit-branch-read-upstream-first") ?? true;
  } catch {
    // magit-branch is not loaded: its default, t.
  }
  if (truthy(upstreamFirst)) {
    const choice = magitReadStartingPoint(prompt, undefined, defaultStart);
    if (magitRevVerify(choice)) {
      const def = choice.split("/").slice(1).join("/");
      const namePrompt = magitCompletingReadSilentDefault ? `${prompt} (starting at \`${choice}')` : "Name for new branch";
      return [magitReadStringNs(namePrompt, magitListRemoteBranchNames().includes(choice) && !magitListLocalBranchNames().includes(def) ? def : undefined), choice];
    }
    if (upstreamFirst === "fallback") return [choice, magitReadStartingPoint(prompt, choice, defaultStart)];
    return e8.userError(`Not a valid starting-point: ${choice}`);
  }
  const branch = magitReadStringNs(`${prompt} named`);
  if (magitBranchP(branch)) return magitBranchReadArgs(`Branch \`${branch}' already exists; pick another name`, defaultStart);
  return [branch, magitReadStartingPoint(prompt, branch, defaultStart)];
}

// Commands.

/** Checks COMMIT out in a new worktree in DIRECTORY, as magit-worktree-checkout does once it has its arguments. */
export function magitWorktreeCheckoutIn(directory: string, commit: string): void {
  if (magitRunGit("worktree", "add", expandWorktree(directory), commit) === 0) magitDiffVisitDirectory(directory);
}

export const magitWorktreeCheckout = e8.defineCommand({
  name: "magit-worktree-checkout",
  doc: "Checkout COMMIT in a new worktree in DIRECTORY.\nCOMMIT may, but does not have to be, a local branch.\nInteractively, use `magit-read-worktree-directory-function'.",
  run: () => {
    const commit = magitReadBranchOrCommit("In new worktree; checkout", undefined, listWorktrees().flatMap((w) => (w.branch ? [w.branch] : [])));
    magitWorktreeCheckoutIn(readWorktreeDirectory(commit, magitLocalBranchP(commit) !== undefined), commit);
  },
});

/** Creates BRANCH at START-POINT and checks it out in a new worktree at DIRECTORY, as magit-worktree-branch does once it has its arguments. */
export function magitWorktreeBranchIn(directory: string, branch: string, startPoint?: string): void {
  if (magitRunGit("worktree", "add", "-b", branch, expandWorktree(directory), startPoint) === 0) magitDiffVisitDirectory(directory);
}

export const magitWorktreeBranch = e8.defineCommand({
  name: "magit-worktree-branch",
  doc: "Create a new BRANCH and check it out in a new worktree at DIRECTORY.\nInteractively, use `magit-read-worktree-directory-function'.",
  run: () => {
    const [branch, startPoint] = magitBranchReadArgs("In new worktree; checkout new branch");
    magitWorktreeBranchIn(readWorktreeDirectory(branch, true), branch, startPoint);
  },
});

/** Moves the existing WORKTREE directory to DIRECTORY, as magit-worktree-move does once it has its arguments. */
export function magitWorktreeMoveTo(worktree: string, directory: string): void {
  if (e8.fileDirectoryP(e8.expandFileName(".git", worktree))) e8.userError("You may not move the main working tree");
  const preexistingDirectory = e8.fileDirectoryP(directory);
  if (magitCallGit("worktree", "move", worktree, expandWorktree(directory)) === 0 && !e8.fileExistsP(defaultDirectory()) && e8.derivedModeP("magit-status-mode")) {
    e8.call("kill-buffer", e8.bufferName());
    magitDiffVisitDirectory(preexistingDirectory ? `${e8.fileNameAsDirectory(directory)}${e8.fileNameNondirectory(e8.directoryFileName(worktree))}` : directory);
  }
  magitRefresh();
}

export const magitWorktreeMove = e8.defineCommand({
  name: "magit-worktree-move",
  doc: "Move existing WORKTREE directory to DIRECTORY.",
  run: () => {
    const worktree = magitCompletingRead("Move worktree", listWorktrees().slice(1).map((w) => w.path), { requireMatch: true, def: worktreeAtPoint() })!;
    magitWorktreeMoveTo(worktree, readDirectoryName("Move worktree to: "));
  },
});

/** Deletes WORKTREE, after asking, and prunes it, as magit-worktree-delete does once it has its argument. */
export function magitWorktreeDeleteDirectory(worktree: string): void {
  if (e8.fileDirectoryP(e8.expandFileName(".git", worktree))) e8.userError(`Deleting ${worktree} would delete the shared .git directory`);
  const primary = e8.fileNameAsDirectory(listWorktrees()[0].path);
  const trash = truthy(e8.variable("magit-delete-by-moving-to-trash"));
  // As magit-confirm-files: the action's name, capitalised, as the prompt.
  const action = trash ? "Trash" : "Delete";
  magitConfirm(trash ? "trash" : "delete", `${action} "%s"`, `${action} %d files`, [worktree]);
  if (e8.fileExistsP(worktree)) e8.deleteDirectory(worktree, { recursive: true, trash });
  if (e8.fileExistsP(defaultDirectory())) magitRunGit("worktree", "prune");
  else {
    e8.letBind({ "default-directory": primary }, () => magitRunGit("worktree", "prune"));
    if (e8.derivedModeP("magit-status-mode")) {
      e8.call("kill-buffer", e8.bufferName());
      magitStatusSetupBuffer(primary);
    }
  }
}

export const magitWorktreeDelete = e8.defineCommand({
  name: "magit-worktree-delete",
  doc: "Delete a worktree, defaulting to the worktree at point.\nThe primary worktree cannot be deleted.",
  run: () => magitWorktreeDeleteDirectory(magitCompletingRead("Delete worktree", listWorktrees().slice(1).map((w) => w.path), { requireMatch: true, def: worktreeAtPoint() })!),
});

export const magitWorktreeStatus = e8.defineCommand({
  name: "magit-worktree-status",
  doc: "Show the status for the worktree at point.\nIf there is no worktree at point, then read one in the minibuffer.  If the worktree at point is the one whose status is already being displayed in the current buffer, then show it in Dired instead.",
  run: () => {
    const top = magitToplevel();
    const worktree =
      worktreeAtPoint() ??
      magitCompletingRead(
        "Show status for worktree",
        listWorktrees().filter((w) => w.path !== top).map((w) => w.path),
        { requireMatch: true },
      )!;
    magitDiffVisitDirectory(worktree);
  },
});

export const magitWorktree = transientDefinePrefix("magit-worktree", {
  doc: "Act on a worktree.",
  groups: [
    {
      class: "columns",
      items: [
        { description: "Create new", items: [["b", "worktree", magitWorktreeCheckout], ["c", "branch and worktree", magitWorktreeBranch]] },
        { description: "Commands", items: [["m", "Move worktree", magitWorktreeMove], ["k", "Delete worktree", magitWorktreeDelete], ["g", "Visit worktree", magitWorktreeStatus]] },
      ],
    },
  ],
});

// Sections.

e8.defineKeymap("magit-worktree-section-map", null);
e8.remapCommand("magit-worktree-section-map", "magit-delete-thing" as e8.CommandName, magitWorktreeDelete);
e8.remapCommand("magit-worktree-section-map", "magit-visit-thing" as e8.CommandName, magitWorktreeStatus);
magitSectionDefineType("worktree", { keymap: "magit-worktree-section-map" });

/**
 * Insert sections for all worktrees.
 * If there is only one worktree, then insert nothing.
 */
export function magitInsertWorktrees(): void {
  const worktrees = listWorktrees();
  if (worktrees.length <= 1) return;
  insertSection("worktrees", undefined, false, () => {
    insertHeading(true, "Worktrees");
    const current = magitGetCurrentBranch();
    const cols: [string | e8.PropertizedString, Worktree][] = worktrees.map((config) => {
      const { commit, branch, bare } = config;
      const head = branch
        ? e8.propertize(branch, { "font-lock-face": branch === current ? "magit-branch-current" : "magit-branch-local" })
        : commit
          ? e8.propertize(magitRevAbbrev(commit) ?? commit, { "font-lock-face": "magit-hash" })
          : bare
            ? "(bare)"
            : "";
      return [head, config];
    });
    const text = (h: string | e8.PropertizedString): string => (typeof h === "string" ? h : h.string);
    const align = 1 + Math.max(...cols.map(([h]) => e8.stringWidth(text(h))));
    for (const [head, config] of cols) magitInsertWorktree(config, head, " ".repeat(align - text(head).length));
    e8.insert("\n");
  }, "magit-insert-worktrees");
}

/**
 * Insert worktree section for CONFIG.
 * See `magit-list-worktrees' for the format of CONFIG.  HEAD is a
 * prettified reference or revision representing the worktree, with
 * PADDING after it for alignment.
 */
function magitInsertWorktree(config: Worktree, head: string | e8.PropertizedString, padding: string): void {
  const path = config.path;
  insertSection("worktree", path, false, () => {
    e8.insert(head);
    e8.insert(padding);
    const relative = fileRelativeName(path);
    const absolute = e8.abbreviateFileName(path);
    e8.insert(e8.stringWidth(relative) > e8.stringWidth(absolute) || relative === "./" ? absolute : relative);
    e8.insert("\n");
  });
}

/** The name of FILE relative to default-directory, a directory name if FILE is one, as file-relative-name. */
function fileRelativeName(file: string): string {
  const dir = file.endsWith("/");
  const a = e8.directoryFileName(e8.expandFileName(file)).split("/");
  const b = e8.directoryFileName(e8.expandFileName(defaultDirectory())).split("/");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rel = [...Array<string>(b.length - i).fill(".."), ...a.slice(i)].join("/") || ".";
  return dir ? e8.fileNameAsDirectory(rel) : rel;
}

inserters.set("magit-insert-worktrees", magitInsertWorktrees);
