// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dired support for Magit, after magit-dired.el: from a Magit buffer,
// M-TAB (and C-x C-j in the status buffer) lists the directory of the
// file at point with point on it (magit-dired-jump), and & runs a shell
// command on the file at point (magit-do-async-shell-command); in Dired,
// staging, unstaging and the log of the marked files, which the file
// dispatch menu (C-c M-g) offers there, and applying them as patches
// with git am (magit-dired-am-apply-patches).
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";
import { markedFiles, markPrompt } from "dired";
import { shellStuffIt } from "dired-aux";
import { magitFileAtPoint, magitFileRelativeName, magitGetCurrentBranch, magitToplevel, magitToplevelOrError } from "magit-git";
import { magitLogArguments, magitLogSetupBuffer } from "magit-log";
import { magitStatusSetupBuffer } from "magit-status";
import { magitReadFile, magitStageFiles, magitUnstageFiles } from "magit-files";
import { magitAmApplyPatchesFiles } from "magit-sequence";

// Opening Dired from Magit.

/**
 * Lists the directory of the file at point in Dired, with point on it,
 * or default-directory without a file, in another window with
 * OTHER-WINDOW, as magit-dired-jump.
 */
export function magitDiredJump(otherWindow = false): void {
  let file = e8.derivedModeP("magit-repolist-mode") ? (e8.getTextProperty(e8.lineBeginningPosition(), "tabulated-list-id") as string | undefined) : magitFileAtPoint();
  if (file === undefined || file === null) {
    e8.call(otherWindow ? "dired-jump-other-window" : "dired-jump");
    return;
  }
  file = e8.expandFileName(file);
  if (e8.fileDirectoryP(file)) file = e8.fileNameAsDirectory(file);
  const target = file.endsWith("/") ? e8.directoryFileName(file) : file;
  e8.call(otherWindow ? "dired-other-window" : "dired", e8.fileNameDirectory(target) ?? "/");
  e8.call("dired-goto-file", target);
}

export const magitDiredJumpCommand = e8.defineCommand({
  name: "magit-dired-jump",
  doc: "Visit file at point using Dired.\nWith a prefix argument, visit in another window.  If there\nis no file at point, then instead visit `default-directory'.",
  params: [{ name: "other-window", kind: "prefix" }],
  run: (otherWindow: e8.Value) => magitDiredJump(truthy(otherWindow)),
});

// Commands for Dired buffers.

/** The marked files, or the file on this line, as (dired-get-marked-files). */
const diredFiles = (): string[] => markedFiles(null).files;

export const magitDiredStage = e8.defineCommand({
  name: "magit-dired-stage",
  doc: "In Dired, staged all marked files or the file at point.",
  run: () => magitStageFiles(diredFiles()),
});

export const magitDiredUnstage = e8.defineCommand({
  name: "magit-dired-unstage",
  doc: "In Dired, unstaged all marked files or the file at point.",
  run: () => magitUnstageFiles(diredFiles()),
});

/** Shows the log of the marked files, or of the directory with none marked, as magit-dired-log; FOLLOW adds --follow for one file. */
export function magitDiredLog(follow = false): string {
  const topdir = magitToplevel(String(e8.variable("default-directory")));
  if (!topdir) magitToplevelOrError();
  let [args] = magitLogArguments();
  const marked = markedFiles(null);
  const files = marked.marked ? marked.files : [String(e8.variable("default-directory"))];
  if (follow && !args.includes("--follow") && files.length === 1) args = ["--follow", ...args];
  return e8.letBind({ "default-directory": topdir! }, () =>
    magitLogSetupBuffer([magitGetCurrentBranch() ?? "HEAD"], args, files.map((f) => magitFileRelativeName(e8.expandFileName(f)) ?? f).map((f) => (f === "" ? "." : f))),
  );
}

export const magitDiredLogCommand = e8.defineCommand({
  name: "magit-dired-log",
  doc: "In Dired, show log for all marked files or the directory if none are marked.",
  params: [{ name: "follow", kind: "prefix" }],
  run: (follow: e8.Value) => void magitDiredLog(truthy(follow)),
});

/** Applies FILES as patches in the repository REPO, showing its status first, as magit-dired-am-apply-patches. */
export function magitDiredAmApplyPatches(repo: string, files: string[]): void {
  magitStatusSetupBuffer(repo);
  magitAmApplyPatchesFiles(files);
}

export const magitDiredAmApplyPatchesCommand = e8.defineCommand({
  name: "magit-dired-am-apply-patches",
  doc: "In Dired, apply the marked (or next ARG) files as patches.\nIf inside a repository, then apply in that.  Otherwise prompt\nfor a repository.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg | null) => {
    const files = markedFiles(arg ?? null).files;
    const repo =
      magitToplevel() ??
      (e8.fboundp("magit-read-repository")
        ? String(e8.funcall("magit-read-repository", true))
        : e8.fileNameAsDirectory(e8.expandFileName(e8.readFileName("Git repository: ", { mustMatch: true }))));
    magitDiredAmApplyPatches(repo, files);
  },
});

// Miscellaneous commands.

/** Runs a shell command read in the minibuffer on FILE in the background, as magit-do-async-shell-command. */
export function magitDoAsyncShellCommand(file: string): void {
  let command = e8.readString(`& on ${markPrompt(null, [file])}: `, { history: "shell-command-history" });
  if (!/&[ \t]*$/.test(command)) command += " &";
  e8.call("shell-command", shellStuffIt(command, [file], !/(^|\s)\*(\s|$)/.test(command)));
}

export const magitDoAsyncShellCommandCommand = e8.defineCommand({
  name: "magit-do-async-shell-command",
  doc: "Open FILE with `dired-do-async-shell-command'.\nInteractively, open the file at point.",
  run: () => magitDoAsyncShellCommand(magitFileAtPoint() ?? magitReadFile("Act on file")),
});

// Keys, as magit-mode-map, magit-status-mode-map and magit-diff-section-map bind them.

e8.defineKey("magit-mode-map", "M-TAB", magitDiredJumpCommand);
e8.remapCommand("magit-status-mode-map", "dired-jump", magitDiredJumpCommand);
e8.defineKey("magit-diff-section-map", "&", magitDoAsyncShellCommandCommand);
