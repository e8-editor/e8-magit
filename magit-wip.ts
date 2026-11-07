// SPDX-License-Identifier: GPL-3.0-or-later
//
// Work-in-progress refs, after magit-wip.el: magit-wip-mode and the four
// modes it is made of commit snapshots of the index and the working tree
// to refs of their own, refs/wip/index/refs/heads/BRANCH and
// refs/wip/wtree/refs/heads/BRANCH, before and after the changes that
// could lose work: after saving a tracked file
// (magit-wip-after-save-mode), before and after staging, unstaging,
// discarding and resetting (magit-wip-before-change-mode and
// magit-wip-after-apply-mode), and before a file is first saved
// (magit-wip-initial-backup-mode). magit-wip-commit (z r) commits on
// demand; magit-wip-log and magit-wip-log-current show a branch with its
// wip refs, and the log menu's Wiplog group (l i, l w) the wip refs
// alone; magit-wip-purge deletes those whose branch is gone.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";
import { magitCompletingRead, magitConfirm, magitReadString } from "magit-base";
import {
  magitBranchAtPoint,
  magitFileTrackedP,
  magitGetCurrentBranch,
  magitGitdir,
  magitGitExecutable,
  magitGitLines,
  magitGitRun,
  magitGitStr,
  magitInsideWorktreeP,
  magitListLocalBranchNames,
  magitListRefs,
  magitProcessGitArguments,
  magitRevAncestorP,
  magitRevVerify,
  magitToplevel,
  magitTrackedFiles,
  type GitArg,
} from "magit-git";
import { magitCallGit } from "magit-process";
import { magitRefresh } from "magit-mode";
import { magitLogArguments, magitLogSetupBuffer } from "magit-log";

// Options.

e8.defineVariable({ name: "magit-wip-mode-lighter", doc: "Lighter for Magit-Wip mode.", value: " Wip" });
e8.defineVariable({
  name: "magit-wip-merge-branch",
  doc:
    "Whether to merge the current branch into its wip ref.\n\nIf non-nil and the current branch has new commits, then it is\nmerged into the wip ref before creating a new wip commit.  This\nmakes it easier to inspect wip history and the wip commits are\nnever garbage collected.\n\nIf nil and the current branch has new commits, then the wip ref\nis reset to the tip of the branch before creating a new wip\ncommit.  With this setting wip commits are eventually garbage\ncollected.  This is currently the default.",
  value: false,
});
e8.defineVariable({
  name: "magit-wip-namespace",
  doc: "Namespace used for work-in-progress refs.\nThe wip refs are named \"<namespace/>index/<branchref>\"\nand \"<namespace/>wtree/<branchref>\".  When snapshots\nare created while the `HEAD' is detached then \"HEAD\"\nis used as `branch-ref'.",
  value: "refs/wip/",
});
e8.defineVariable({ name: "magit-wip-buffer-backed-up", doc: "Whether magit-wip-commit-initial-backup has backed up the buffer's file.", value: false });

// Running git with a temporary index.

/** Runs git with ARGS in the repository's top directory, with GIT_INDEX_FILE INDEX if given. */
function gitIn(top: string, index: string | undefined, ...args: GitArg[]): { exit: number; output: string } {
  if (index === undefined) return magitGitRun(args, { dir: top });
  // E8's call-process takes no environment: env sets it for git.
  return e8.callProcess(["env", `GIT_INDEX_FILE=${index}`, magitGitExecutable(), ...magitProcessGitArguments(args)], { directory: top });
}
const firstLine = (r: { exit: number; output: string }): string | undefined => (r.exit === 0 && r.output !== "" ? r.output.split("\n")[0] : undefined);

/**
 * Runs BODY with git using a temporary index read from TREE with ARG,
 * as magit-with-temp-index: BODY gets the runner to use.
 */
function magitWithTempIndex<T>(tree: string | undefined, arg: string[], body: (git: (...args: GitArg[]) => { exit: number; output: string }) => T): T {
  const top = magitToplevel()!;
  const file = `${magitGitdir()}index.magit.${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (tree && gitIn(top, undefined, "read-tree", ...arg, tree, `--index-output=${file}`).exit !== 0) e8.signal("error", `Cannot read tree ${tree}`);
    return body((...args) => gitIn(top, file, ...args));
  } finally {
    if (e8.fileExistsP(file)) e8.deleteFile(file);
  }
}

/** Points REF at REV, logging MESSAGE, as magit-update-ref. */
function magitUpdateRef(ref: string, message: string, rev: string | undefined): void {
  if (rev === undefined || magitGitRun(["update-ref", "--create-reflog", "-m", message, ref, rev, magitRevVerify(ref) ?? ""]).exit !== 0) {
    e8.signal("error", `Cannot update ${ref} with ${rev}`);
  }
}

// Modes.

/** The repositories and their tracked files magit-wip-after-save-mode looked at while turning on, as magit--wip-activation-cache. */
let activationCache: [string, string | undefined, ...string[]][] | undefined;

/** Turns MODE on or off as ON says, as calling it with 1 or -1 does. */
function setMode(mode: string, on: boolean): void {
  if (truthy(e8.variable(mode)) !== on) e8.callWithPrefix(on ? 1 : 0, mode as e8.CommandName);
}

export const magitWipMode = e8.defineMinorMode({
  name: "magit-wip-mode",
  lighter: " Wip",
  global: true,
  doc:
    "Save uncommitted changes to work-in-progress refs.\n\nWhenever appropriate (i.e., when dataloss would be a possibility\notherwise) this mode causes uncommitted changes to be committed\nto dedicated work-in-progress refs.\n\nFor historic reasons this mode is implemented on top of four\nother `magit-wip-*' modes, which can also be used individually,\nif you want finer control over when the wip refs are updated;\nbut that is discouraged.",
  onChange: (on: boolean) => {
    activationCache = [];
    try {
      setMode("magit-wip-after-save-mode", on);
    } finally {
      activationCache = undefined;
    }
    setMode("magit-wip-after-apply-mode", on);
    setMode("magit-wip-before-change-mode", on);
    setMode("magit-wip-initial-backup-mode", on);
  },
});

/** The after-save-hook function of magit-wip-after-save-local-mode. */
const afterSave = (): void => magitWipCommitBufferFile();

export const magitWipAfterSaveLocalMode = e8.defineMinorMode({
  name: "magit-wip-after-save-local-mode",
  doc:
    "After saving, also commit to a worktree work-in-progress ref.\n\nAfter saving the current file-visiting buffer this mode also\ncommits the changes to the worktree work-in-progress ref for\nthe current branch.\n\nThis mode should be enabled globally by turning on the globalized\nvariant `magit-wip-after-save-mode'.",
  onChange: (on: boolean) => {
    if (on) {
      if (e8.bufferFileName() !== undefined && magitInsideWorktreeP()) e8.addHook("after-save-hook", afterSave, { local: true, append: true });
      else {
        e8.setVariable("magit-wip-after-save-local-mode", false);
        e8.userError("Need a worktree and a file");
      }
    } else e8.removeHook("after-save-hook", afterSave, { local: true });
  },
});

/** Turns on magit-wip-after-save-local-mode in a buffer visiting a tracked file, as magit-wip-after-save-local-mode-turn-on. */
export function magitWipAfterSaveLocalModeTurnOn(): void {
  const file = e8.bufferFileName();
  if (file === undefined || truthy(e8.variable("magit-wip-after-save-local-mode"))) return;
  let on: boolean;
  if (!activationCache) on = magitInsideWorktreeP() && magitFileTrackedP(file);
  else {
    const dir = String(e8.variable("default-directory"));
    const elt = activationCache.find((e) => e[0] === dir);
    const top = elt ? elt[1] : magitToplevel();
    if (elt) on = top !== undefined && elt.slice(2).includes(e8.expandFileName(file).slice(top.length));
    else if (top) {
      const known = activationCache.find((e) => e[0] === top);
      const files = known ? (known.slice(2) as string[]) : e8.letBind({ "default-directory": top }, () => magitTrackedFiles());
      if (!known) {
        activationCache.push([top, top, ...files]);
        if (dir !== top) activationCache.push([dir, top, ...files]);
      }
      on = files.includes(e8.expandFileName(file).slice(top.length));
    } else {
      activationCache.push([dir, undefined]);
      on = false;
    }
  }
  if (on) setMode("magit-wip-after-save-local-mode", true);
}

export const magitWipAfterSaveMode = e8.defineMinorMode({
  name: "magit-wip-after-save-mode",
  global: true,
  doc: "Toggle Magit-Wip-After-Save-Local mode in all buffers.\nMagit-Wip-After-Save-Local mode is enabled in all buffers where\n`magit-wip-after-save-local-mode-turn-on' would do it.",
  onChange: (on: boolean) => {
    for (const b of e8.bufferList()) {
      e8.withCurrentBuffer(b, () => {
        if (on) magitWipAfterSaveLocalModeTurnOn();
        else setMode("magit-wip-after-save-local-mode", false);
      });
    }
  },
});
// The globalized mode turns the local one on in each file visited.
e8.addHook("find-file-hook", () => {
  if (truthy(e8.variable("magit-wip-after-save-mode"))) magitWipAfterSaveLocalModeTurnOn();
});

/** Commits the visited file to the worktree wip ref, as magit-wip-commit-buffer-file; MSG has %s for the file. */
export function magitWipCommitBufferFile(msg?: string): void {
  const ref = magitWipGetRef();
  const top = magitToplevel();
  const file = e8.bufferFileName();
  if (!ref || !top || file === undefined) return;
  e8.letBind({ "default-directory": top }, () => {
    const rel = e8.expandFileName(file).slice(top.length);
    magitWipCommitWorktree(ref, [rel], (msg ?? "autosave %s after save").replace("%s", rel));
  });
}

export const magitWipCommitBufferFileCommand = e8.defineCommand({
  name: "magit-wip-commit-buffer-file",
  doc: "Commit visited file to a worktree work-in-progress ref.\n\nAlso see `magit-wip-after-save-mode' which calls this function\nautomatically whenever a buffer visiting a tracked file is saved.",
  run: () => magitWipCommitBufferFile("wip-save %s after save"),
});

export const magitWipAfterApplyMode = e8.defineMinorMode({
  name: "magit-wip-after-apply-mode",
  global: true,
  doc:
    "Commit to work-in-progress refs.\n\nAfter applying a change using any \"apply variant\"\ncommand (apply, stage, unstage, discard, and reverse) commit the\naffected files to the current wip refs.  For each branch there\nmay be two wip refs; one contains snapshots of the files as found\nin the worktree and the other contains snapshots of the entries\nin the index.",
});

/** Commits FILES to the wip refs if magit-wip-after-apply-mode is on, as magit-wip-commit-after-apply. */
export function magitWipCommitAfterApply(files?: string[], msg?: string): void {
  if (truthy(e8.variable("magit-wip-after-apply-mode"))) magitWipCommit(files, msg);
}
e8.defun("magit-wip-commit-after-apply", (files?: string[], msg?: string) => magitWipCommitAfterApply(files ?? undefined, msg ?? undefined));

export const magitWipBeforeChangeMode = e8.defineMinorMode({
  name: "magit-wip-before-change-mode",
  global: true,
  doc:
    "Commit to work-in-progress refs before certain destructive changes.\n\nBefore invoking a revert command or an \"apply variant\"\ncommand (apply, stage, unstage, discard, and reverse) commit the\naffected tracked files to the current wip refs.  For each branch\nthere may be two wip refs; one contains snapshots of the files\nas found in the worktree and the other contains snapshots of the\nentries in the index.\n\nOnly changes to files which could potentially be affected by the\ncommand which is about to be called are committed.",
});

/** Commits FILES to the wip refs if magit-wip-before-change-mode is on, as magit-wip-commit-before-change. */
export function magitWipCommitBeforeChange(files?: string[], msg?: string): void {
  if (!truthy(e8.variable("magit-wip-before-change-mode"))) return;
  const top = magitToplevel();
  if (top) e8.letBind({ "default-directory": top }, () => magitWipCommit(files, msg));
}
e8.defun("magit-wip-commit-before-change", (files?: string[], msg?: string) => magitWipCommitBeforeChange(files ?? undefined, msg ?? undefined));

export const magitWipInitialBackupMode = e8.defineMinorMode({
  name: "magit-wip-initial-backup-mode",
  global: true,
  doc: "Before saving a buffer for the first time, commit to a wip ref.",
  onChange: (on: boolean) => {
    if (on) e8.addHook("before-save-hook", magitWipCommitInitialBackup);
    else e8.removeHook("before-save-hook", magitWipCommitInitialBackup);
  },
});

/** Whether any global wip mode is on, as magit--any-wip-mode-enabled-p. */
export const magitAnyWipModeEnabledP = (): boolean =>
  ["magit-wip-mode", "magit-wip-after-save-mode", "magit-wip-after-apply-mode", "magit-wip-before-change-mode", "magit-wip-initial-backup-mode"].some((m) => truthy(e8.variable(m)));

/** Whether any wip mode is on, the local one too, as magit-wip-any-enabled-p. */
export const magitWipAnyEnabledP = (): boolean => magitAnyWipModeEnabledP() || truthy(e8.variable("magit-wip-after-save-local-mode"));

/**
 * Before saving, commits the visited file as it is on disk to the
 * worktree wip ref, once a buffer, as magit-wip-commit-initial-backup.
 */
export function magitWipCommitInitialBackup(): void {
  const file = e8.bufferFileName();
  if (truthy(e8.variable("magit-wip-buffer-backed-up")) || file === undefined || !magitInsideWorktreeP() || !magitFileTrackedP(file)) return;
  e8.letBind({ "magit-save-repository-buffers": false }, () => magitWipCommitBufferFile("autosave %s before save"));
  e8.makeLocalVariable("magit-wip-buffer-backed-up");
  e8.setVariable("magit-wip-buffer-backed-up", true);
}
e8.defun("magit-wip-commit-initial-backup", () => magitWipCommitInitialBackup());

// Core.

/**
 * Commits FILES, all tracked files without, to the work-in-progress
 * refs of the index and the worktree, with MSG, as magit-wip-commit.
 */
export function magitWipCommit(files?: string[], msg?: string): void {
  const ref = magitWipGetRef();
  if (!ref) return;
  magitWipCommitIndex(ref, files, msg);
  magitWipCommitWorktree(ref, files, msg);
}

export const magitWipCommitCommand = e8.defineCommand({
  name: "magit-wip-commit",
  doc:
    "Commit all tracked files to the work-in-progress refs.\n\nInteractively, commit all changes to all tracked files using\na generic commit message.  With a prefix-argument the commit\nmessage is read in the minibuffer.\n\nNon-interactively, only commit changes to FILES using MSG as\ncommit message.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => magitWipCommit(undefined, truthy(prefix) ? magitReadString("Wip commit message") : "wip-save tracked files"),
});

/** Commits the index to REF's index wip ref, as magit-wip-commit-index. */
export function magitWipCommitIndex(ref: string, files: string[] | undefined, msg: string | undefined): void {
  const wipref = magitWipIndexRef(ref);
  const parent = magitWipGetParent(ref, wipref);
  const tree = magitGitStr("write-tree");
  magitWipUpdateWipref(ref, wipref, tree, parent, files, msg, "index");
}

/** Commits the worktree's FILES, or all tracked files, to REF's worktree wip ref, as magit-wip-commit-worktree. */
export function magitWipCommitWorktree(ref: string, files: string[] | undefined, msg: string | undefined): void {
  const top = magitToplevel();
  if (!top) return;
  if (files && files.length > 0) {
    // update-index fails when given directories.
    files = files.filter((f) => !e8.fileDirectoryP(e8.expandFileName(f, top)));
    if (files.length === 0) return;
  }
  const wipref = magitWipWtreeRef(ref);
  const parent = magitWipGetParent(ref, wipref);
  const tree = magitWithTempIndex(parent, ["--reset", "-i"], (git) => {
    // update-index rather than add, which fails for a file already deleted in the temporary index.
    if (files && files.length > 0) git("update-index", "--add", "--remove", "--ignore-skip-worktree-entries", "--", files);
    else git("add", "-u", ".");
    return firstLine(git("write-tree"));
  });
  magitWipUpdateWipref(ref, wipref, tree, parent, files, msg, "worktree");
}

/** Commits TREE to WIPREF on PARENT, starting or merging the wip ref first, as magit-wip-update-wipref. */
export function magitWipUpdateWipref(ref: string, wipref: string, tree: string | undefined, parent: string, files: string[] | undefined, msg: string | undefined, startMsg: string): void {
  const mergeBranch = truthy(e8.variable("magit-wip-merge-branch"));
  if (parent !== wipref && (!mergeBranch || !magitRevVerify(wipref))) {
    startMsg = `start autosaving ${startMsg}`;
    magitUpdateRef(wipref, startMsg, magitGitStr("commit-tree", "--no-gpg-sign", "-p", parent, "-m", startMsg, `${parent}^{tree}`));
    parent = wipref;
  } else if (mergeBranch && (!magitRevAncestorP(ref, wipref) || !magitRevAncestorP(`${magitGitStr("log", "--format=%H", "-1", "--merges", wipref) ?? ""}^2`, ref))) {
    startMsg = `merge ${ref} into ${startMsg}`;
    magitUpdateRef(wipref, startMsg, magitGitStr("commit-tree", "--no-gpg-sign", "-p", wipref, "-p", ref, "-m", startMsg, `${ref}^{tree}`));
    parent = wipref;
  }
  if (tree === undefined) return;
  if (magitGitRun(["diff-tree", "--quiet", parent, tree, "--", files ?? []]).exit === 1) {
    if (!(msg && msg[0] !== " ")) {
      const len = files?.length ?? 0;
      const top = magitToplevel() ?? "";
      const what = len === 0 ? "autosave tracked files" : len > 1 ? `autosave ${len} files` : `autosave ${e8.expandFileName(files![0], top).slice(top.length)}`;
      msg = what + (msg ?? "");
    }
    magitUpdateRef(wipref, msg, magitGitStr("commit-tree", "--no-gpg-sign", "-p", parent, "-m", msg, tree));
  }
}

/** The ref HEAD is on, or HEAD when detached, if it has a commit, as magit-wip-get-ref. */
export function magitWipGetRef(): string | undefined {
  const ref = magitGitStr("symbolic-ref", "HEAD") ?? "HEAD";
  return magitRevVerify(ref) ? ref : undefined;
}

/** WIPREF if it is based on REF's tip, else REF, as magit-wip-get-parent. */
export function magitWipGetParent(ref: string, wipref: string): string {
  return magitRevVerify(wipref) && magitGitStr("merge-base", wipref, ref) === magitRevVerify(ref) ? wipref : ref;
}

/** The index wip ref of REF, as magit--wip-index-ref. */
export const magitWipIndexRef = (ref?: string): string => magitWipRef("index/", ref);
/** The worktree wip ref of REF, as magit--wip-wtree-ref. */
export const magitWipWtreeRef = (ref?: string): string => magitWipRef("wtree/", ref);

/** The wip ref in NAMESPACE of REF, a full ref or a branch, the current branch by default, as magit--wip-ref. */
export function magitWipRef(namespace: string, ref?: string): string {
  const base = String(e8.variable("magit-wip-namespace") ?? "refs/wip/") + namespace;
  if (ref && ref.startsWith("refs/")) return base + ref;
  const branch = ref !== "HEAD" ? (ref ?? magitGetCurrentBranch()) : undefined;
  return base + (branch ? `refs/heads/${branch}` : "HEAD");
}

// Log.

export const magitWipLogIndex = e8.defineCommand({
  name: "magit-wip-log-index",
  doc: "Show log for the index wip ref of the current branch.",
  run: () => {
    const [args, files] = magitLogArguments();
    magitLogSetupBuffer([magitWipIndexRef()], args, files);
  },
});

export const magitWipLogWorktree = e8.defineCommand({
  name: "magit-wip-log-worktree",
  doc: "Show log for the worktree wip ref of the current branch.",
  run: () => {
    const [args, files] = magitLogArguments();
    magitLogSetupBuffer([magitWipWtreeRef()], args, files);
  },
});

/**
 * Shows the log of BRANCH and its wip refs, COUNT of each's "branches",
 * the worktree's only if COUNT is negative, as magit-wip-log.
 */
export function magitWipLog(branch: string, args: string[], files: string[], count: number): string {
  return magitLogSetupBuffer(
    [branch, ...magitWipLogGetTips(magitWipWtreeRef(branch), Math.abs(count)), ...(count >= 0 ? magitWipLogGetTips(magitWipIndexRef(branch), Math.abs(count)) : [])],
    args,
    files,
  );
}

export const magitWipLogCurrent = e8.defineCommand({
  name: "magit-wip-log-current",
  doc: "Show log for the current branch and its wip refs.\nWith a negative prefix argument only show the worktree wip ref.\nThe absolute numeric value of the prefix argument controls how\nmany \"branches\" of each wip ref are shown.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => {
    const [args, files] = magitLogArguments();
    magitWipLog(magitGetCurrentBranch() ?? "HEAD", args, files, count ?? 1);
  },
});

export const magitWipLogCommand = e8.defineCommand({
  name: "magit-wip-log",
  doc: "Show log for a branch and its wip refs.\nWith a negative prefix argument only show the worktree wip ref.\nThe absolute numeric value of the prefix argument controls how\nmany \"branches\" of each wip ref are shown.",
  params: [{ name: "count", kind: "count" }],
  run: (count: number) => {
    const branch = magitCompletingRead("Log branch and its wip refs", [...magitListLocalBranchNames(), "HEAD"], {
      requireMatch: true,
      history: "magit-revision-history",
      def: magitBranchAtPoint() ?? magitGetCurrentBranch() ?? "HEAD",
    })!;
    const [args, files] = magitLogArguments();
    magitWipLog(branch, args, files, count ?? 1);
  },
});

/** WIPREF and the tips of its earlier "branches", COUNT in all, from its reflog, as magit-wip-log-get-tips. */
export function magitWipLogGetTips(wipref: string, count: number): string[] {
  let reflog = magitGitLines("reflog", wipref);
  if (reflog.length === 0) return [];
  const tips: string[] = [];
  while (reflog.length > 0 && count > 1) {
    // "start autosaving ..." now, "restart autosaving ..." once.
    const i = reflog.findIndex((l) => /^[^ ]+ [^:]+: (?:re)?start autosaving/.test(l));
    reflog = i >= 0 ? reflog.slice(i) : [];
    const m = reflog[1] !== undefined ? /^[^ ]+ ([^:]+)/.exec(reflog[1]) : null;
    if (m) tips.push(m[1]);
    reflog = reflog.slice(2);
    count--;
  }
  return [wipref, ...tips];
}

export const magitWipPurge = e8.defineCommand({
  name: "magit-wip-purge",
  doc: "Ask to delete all wip-refs that no longer have a corresponding ref.",
  run: () => {
    const refs = magitListRefs();
    const wiprefs = magitListRefs("refs/wip/").filter((w) => !refs.includes(w.slice(15)) && w !== "refs/wip/index/HEAD" && w !== "refs/wip/wtree/HEAD");
    if (wiprefs.length === 0) {
      e8.message("All wip-refs have a corresponding ref");
      return;
    }
    magitConfirm("purge-dangling-wiprefs", "Delete wip-ref %s without corresponding ref", "Delete %d wip-refs without corresponding ref", wiprefs);
    e8.message("Deleting wip-refs...");
    for (const wipref of wiprefs) magitCallGit("update-ref", "-d", wipref);
    e8.message("Deleting wip-refs...done");
    magitRefresh();
  },
});
