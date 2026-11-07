// SPDX-License-Identifier: GPL-3.0-or-later
//
// Intentionally untracked files, after magit-gitignore.el: the gitignore
// menu (i), adding a rule to the top-level .gitignore, to one in a
// subdirectory, to $GIT_DIR/info/exclude or to core.excludesFile, and
// marking files to skip the worktree or to be assumed unchanged.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import * as transientModule from "transient";
import { transientDefinePrefix } from "transient";
import { magitCompletingRead } from "magit-base";
import { magitAssumeUnchangedFiles, magitCurrentFile, magitGet, magitGitdir, magitListFiles, magitSkipWorktreeFiles, magitToplevel, magitUntrackedFiles } from "magit-git";
import { magitRunGit } from "magit-process";
import { magitRefresh } from "magit-mode";

/** Runs BODY in the repository's top directory, as magit-with-toplevel. */
function magitWithToplevel<T>(body: () => T): T {
  const top = magitToplevel();
  if (!top) e8.userError(`Not inside a Git repository: ${e8.abbreviateFileName(String(e8.variable("default-directory")))}`);
  return e8.letBind({ "default-directory": top! }, body);
}

/** The extension of FILE's last part, without the dot, as file-name-extension. */
function fileNameExtension(file: string): string | undefined {
  const m = /^.+?\.([^.]*)$/.exec(e8.fileNameNondirectory(file));
  return m ? m[1] : undefined;
}

/** Adds RULE to FILE, its backslashes doubled, making FILE's directory if missing, as magit--gitignore. */
export function magitGitignoreWrite(rule: string, file: string): void {
  const path = e8.expandFileName(file);
  const directory = e8.fileNameDirectory(path);
  if (directory) e8.makeDirectory(directory, { parents: true });
  let text = e8.fileExistsP(path) ? e8.readTextFile(path) : "";
  if (text !== "" && !text.endsWith("\n")) text += "\n";
  text += `${rule.replace(/(\\+)/g, "$1$1")}\n`;
  e8.writeTextFile(path, text);
}

/**
 * Reads a rule to ignore, offering the untracked files and directories,
 * each also as a pattern of its extension, in its directory and anywhere,
 * as magit-gitignore-read-pattern.
 */
export function magitGitignoreReadPattern(): string {
  let def = magitCurrentFile();
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null | undefined) ?? [];
  const base = files[0] !== undefined && e8.fileDirectoryP(files[0]) ? files[0] : undefined;
  const candidates = [
    ...magitUntrackedFiles(false, base ? [base] : undefined),
    // The untracked section of the status buffer lists directories
    // containing only untracked files.  Add those as candidates.
    ...magitListFiles("--other", "--exclude-standard", "--directory", "--no-empty-directory", "--", base).filter((f) => f.endsWith("/")),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const choices: string[] = [];
  const add = (c: string) => {
    if (!choices.includes(c)) choices.push(c);
  };
  for (const file of candidates) {
    add(`/${file}`);
    const ext = fileNameExtension(file);
    if (ext !== undefined) {
      add(`/${e8.fileNameDirectory(file) ?? ""}*.${ext}`);
      add(`*.${ext}`);
    }
  }
  if (def !== undefined) {
    def = `/${def}`;
    if (!choices.includes(def)) {
      def = `*.${fileNameExtension(def) ?? ""}`;
      if (!choices.includes(def)) def = undefined;
    }
  }
  return magitCompletingRead("File or pattern to ignore", choices, { requireMatch: "any", def })!;
}

/** Reads one of FILES, or gives the only one, as magit-read-file-choice. */
export function magitReadFileChoice(prompt: string, files: string[], error?: string, def?: string): string {
  if (files.length === 0) e8.userError(error ?? "No file choices");
  if (files.length === 1) return files[0];
  const d = def ?? magitCurrentFile();
  return magitCompletingRead(prompt, files, { requireMatch: true, history: "magit-read-file-hist", def: d !== undefined && files.includes(d) ? d : undefined })!;
}

// Gitignore Commands
//
// Each command is a function taking Magit's arguments, magitGitignoreInTopdir,
// and a command reading them, magitGitignoreInTopdirCommand, as
// magit-process.ts has magitProcessBuffer and magitProcessBufferCommand.

/** Adds RULE to the top-level .gitignore and stages it, as magit-gitignore-in-topdir. */
export function magitGitignoreInTopdir(rule: string): void {
  magitWithToplevel(() => {
    magitGitignoreWrite(rule, ".gitignore");
    magitRunGit("add", ".gitignore");
  });
}
export const magitGitignoreInTopdirCommand = e8.defineCommand({
  name: "magit-gitignore-in-topdir",
  doc: 'Add the Git ignore RULE to the top-level ".gitignore" file.\nSince this file is tracked, it is shared with other clones of the\nrepository.  Also stage the file.',
  run: () => magitGitignoreInTopdir(magitGitignoreReadPattern()),
});

/** Adds RULE to the .gitignore in DIRECTORY and stages it, as magit-gitignore-in-subdir. */
export function magitGitignoreInSubdir(rule: string, directory: string): void {
  magitWithToplevel(() => {
    const file = e8.expandFileName(".gitignore", directory);
    magitGitignoreWrite(rule, file);
    magitRunGit("add", file);
  });
}
export const magitGitignoreInSubdirCommand = e8.defineCommand({
  name: "magit-gitignore-in-subdir",
  doc: 'Add the Git ignore RULE to a ".gitignore" file in DIRECTORY.\nPrompt the user for a directory and add the rule to the\n".gitignore" file in that directory.  Since such files are\ntracked, they are shared with other clones of the repository.\nAlso stage the file.',
  run: () => {
    const rule = magitGitignoreReadPattern();
    magitGitignoreInSubdir(rule, e8.expandFileName(e8.readFileName("Limit rule to files in: ")));
  },
});

/** Adds RULE to $GIT_DIR/info/exclude, as magit-gitignore-in-gitdir. */
export function magitGitignoreInGitdir(rule: string): void {
  const gitdir = magitGitdir() ?? e8.userError("Not inside a Git repository");
  magitGitignoreWrite(rule, e8.expandFileName("info/exclude", gitdir));
  magitRefresh();
}
export const magitGitignoreInGitdirCommand = e8.defineCommand({
  name: "magit-gitignore-in-gitdir",
  doc: 'Add the Git ignore RULE to "$GIT_DIR/info/exclude".\nRules in that file only affects this clone of the repository.',
  run: () => magitGitignoreInGitdir(magitGitignoreReadPattern()),
});

/** Adds RULE to the file core.excludesFile names, as magit-gitignore-on-system. */
export function magitGitignoreOnSystem(rule: string): void {
  const file = magitGet("core.excludesFile") ?? (e8.signal("error", "Variable `core.excludesFile' isn't set") as never);
  magitGitignoreWrite(rule, file);
  magitRefresh();
}
export const magitGitignoreOnSystemCommand = e8.defineCommand({
  name: "magit-gitignore-on-system",
  doc: "Add the Git ignore RULE to the file specified by `core.excludesFile'.\nRules that are defined in that file affect all local repositories.",
  run: () => magitGitignoreOnSystem(magitGitignoreReadPattern()),
});

// Skip Worktree Commands

const difference = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x));

/** Runs git update-index FLAG -- FILE in the top directory. */
const updateIndex = (flag: string, file: string): void => void magitWithToplevel(() => magitRunGit("update-index", flag, "--", file));

/** Calls git update-index --skip-worktree -- FILE, as magit-skip-worktree. */
export const magitSkipWorktree = (file: string): void => updateIndex("--skip-worktree", file);
export const magitSkipWorktreeCommand = e8.defineCommand({
  name: "magit-skip-worktree",
  doc: 'Call "git update-index --skip-worktree -- FILE".',
  run: () => magitSkipWorktree(magitReadFileChoice("Skip worktree for", magitWithToplevel(() => difference(magitListFiles(), magitSkipWorktreeFiles())))),
});

/** Calls git update-index --no-skip-worktree -- FILE, as magit-no-skip-worktree. */
export const magitNoSkipWorktree = (file: string): void => updateIndex("--no-skip-worktree", file);
export const magitNoSkipWorktreeCommand = e8.defineCommand({
  name: "magit-no-skip-worktree",
  doc: 'Call "git update-index --no-skip-worktree -- FILE".',
  run: () => magitNoSkipWorktree(magitReadFileChoice("Do not skip worktree for", magitWithToplevel(() => magitSkipWorktreeFiles()))),
});

// Assume Unchanged Commands

/** Calls git update-index --assume-unchanged -- FILE, as magit-assume-unchanged. */
export const magitAssumeUnchanged = (file: string): void => updateIndex("--assume-unchanged", file);
export const magitAssumeUnchangedCommand = e8.defineCommand({
  name: "magit-assume-unchanged",
  doc: 'Call "git update-index --assume-unchanged -- FILE".',
  run: () => magitAssumeUnchanged(magitReadFileChoice("Assume file to be unchanged", magitWithToplevel(() => difference(magitListFiles(), magitAssumeUnchangedFiles())))),
});

/** Calls git update-index --no-assume-unchanged -- FILE, as magit-no-assume-unchanged. */
export const magitNoAssumeUnchanged = (file: string): void => updateIndex("--no-assume-unchanged", file);
export const magitNoAssumeUnchangedCommand = e8.defineCommand({
  name: "magit-no-assume-unchanged",
  doc: 'Call "git update-index --no-assume-unchanged -- FILE".',
  run: () => magitNoAssumeUnchanged(magitReadFileChoice("Do not assume file to be unchanged", magitWithToplevel(() => magitAssumeUnchangedFiles()))),
});

// Transient

/** Hidden in a transient without levels when LEVEL is above the default 4, as Magit shows the menu at first. */
const hasLevels = "transientPrefixLevel" in transientModule;
const lvl = (level: number, options: object = {}) => ({ ...options, level, ...(hasLevels || level <= 4 ? {} : { if: () => false }) });

export const magitGitignore = transientDefinePrefix("magit-gitignore", {
  doc: "Instruct Git to ignore a file or pattern.",
  groups: [
    {
      description: "Gitignore",
      items: [
        ["t", "shared at toplevel (.gitignore)", magitGitignoreInTopdirCommand],
        ["s", "shared in subdirectory (path/to/.gitignore)", magitGitignoreInSubdirCommand],
        ["p", "privately (.git/info/exclude)", magitGitignoreInGitdirCommand],
        [
          "g",
          () => `privately for all repositories (${magitGet("core.excludesfile")})`,
          magitGitignoreOnSystemCommand,
          { if: () => magitGet("core.excludesfile") !== undefined },
        ],
      ],
    },
    {
      description: "Skip worktree",
      // Its suffixes are all at level 7: Magit still shows the heading.
      items: [
        ["w", "do skip worktree", magitSkipWorktreeCommand, lvl(7)],
        ["W", "do not skip worktree", magitNoSkipWorktreeCommand, lvl(7)],
      ],
    },
    {
      description: "Assume unchanged",
      items: [
        ["u", "do assume unchanged", magitAssumeUnchangedCommand, lvl(7)],
        ["U", "do not assume unchanged", magitNoAssumeUnchangedCommand, lvl(7)],
      ],
    },
  ],
});
