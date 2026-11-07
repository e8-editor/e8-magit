// SPDX-License-Identifier: GPL-3.0-or-later
//
// Subtree support, after magit-subtree.el: the subtree menu (O) and its
// import and export menus, adding a repository's ref or a commit as a
// subtree, merging and pulling into one, and pushing and splitting out
// a subtree's history, with "git subtree".
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { transientArgs, transientDefinePrefix } from "transient";
import { magitReadStringNs } from "magit-base";
import { magitReadRefspec, magitReadRemoteOrUrl, magitToplevel } from "magit-git";
import { magitRunGitAsync } from "magit-process";
import { magitTransientReadRevision } from "magit-transient";

/**
 * Reads a directory in the repository, relative to its top, as
 * magit-subtree-read-prefix: one outside it is an error.
 */
export function magitSubtreeReadPrefix(prompt: string, def?: string, _history?: string): string {
  const topdir = magitToplevel() ?? e8.userError("Not inside a Git repository");
  // As read-directory-name with insert-default-directory nil: the input
  // starts empty, and a relative name is one in the top directory.
  const prefix = e8.readFileName(`${prompt}: `, { dir: topdir, initial: "", default: def });
  if (e8.fileNameAbsoluteP(prefix)) {
    const abs = e8.expandFileName(prefix);
    if (abs.startsWith(topdir)) return abs.slice(topdir.length) || ".";
    return e8.userError(`${prefix} isn't inside the repository at ${topdir}`);
  }
  return prefix;
}

/** The --prefix the menu TRANSIENT has, or one read, as magit-subtree-prefix. */
export function magitSubtreePrefix(transient: string, prompt: string): string {
  const arg = transientArgs(transient).find((a) => a.startsWith("--prefix="));
  return arg !== undefined ? arg.slice(9) : magitSubtreeReadPrefix(prompt);
}

/** The menu TRANSIENT's arguments but --prefix, as magit-subtree-arguments. */
export const magitSubtreeArguments = (transient: string): string[] => transientArgs(transient).filter((a) => !a.startsWith("--prefix="));

/** Runs git subtree SUBCMD on PREFIX in the background, as magit-git-subtree. */
export const magitGitSubtree = (subcmd: string, prefix: string, ...args: (string | string[])[]): string => magitRunGitAsync("subtree", subcmd, `--prefix=${prefix}`, ...args);

/** Reads the repository and ref to import, as the add and pull commands do. */
function readRemoteAndRef(): [string, string] {
  const remote = magitReadRemoteOrUrl("From repository");
  return [remote, magitReadRefspec("Ref", remote)];
}

// Each command is a function taking Magit's arguments, magitSubtreeAdd, and
// a command reading them, magitSubtreeAddCommand, as magit-process.ts has
// magitProcessBuffer and magitProcessBufferCommand.

/** Adds REF from REPOSITORY as a new subtree at PREFIX, as magit-subtree-add. */
export const magitSubtreeAdd = (prefix: string, repository: string, ref: string, args: string[] = []): string => magitGitSubtree("add", prefix, args, repository, ref);
export const magitSubtreeAddCommand = e8.defineCommand({
  name: "magit-subtree-add",
  doc: "Add REF from REPOSITORY as a new subtree at PREFIX.",
  run: () => {
    const prefix = magitSubtreePrefix("magit-subtree-import", "Add subtree");
    const [remote, ref] = readRemoteAndRef();
    magitSubtreeAdd(prefix, remote, ref, magitSubtreeArguments("magit-subtree-import"));
  },
});

/** Adds COMMIT as a new subtree at PREFIX, as magit-subtree-add-commit. */
export const magitSubtreeAddCommit = (prefix: string, commit: string, args: string[] = []): string => magitGitSubtree("add", prefix, args, commit);
export const magitSubtreeAddCommitCommand = e8.defineCommand({
  name: "magit-subtree-add-commit",
  doc: "Add COMMIT as a new subtree at PREFIX.",
  run: () => {
    const prefix = magitSubtreePrefix("magit-subtree-import", "Add subtree");
    magitSubtreeAddCommit(prefix, magitReadStringNs("Commit"), magitSubtreeArguments("magit-subtree-import"));
  },
});

/** Merges COMMIT into the PREFIX subtree, as magit-subtree-merge. */
export const magitSubtreeMerge = (prefix: string, commit: string, args: string[] = []): string => magitGitSubtree("merge", prefix, args, commit);
export const magitSubtreeMergeCommand = e8.defineCommand({
  name: "magit-subtree-merge",
  doc: "Merge COMMIT into the PREFIX subtree.",
  run: () => {
    const prefix = magitSubtreePrefix("magit-subtree-import", "Merge into subtree");
    magitSubtreeMerge(prefix, magitReadStringNs("Commit"), magitSubtreeArguments("magit-subtree-import"));
  },
});

/** Pulls REF from REPOSITORY into the PREFIX subtree, as magit-subtree-pull. */
export const magitSubtreePull = (prefix: string, repository: string, ref: string, args: string[] = []): string => magitGitSubtree("pull", prefix, args, repository, ref);
export const magitSubtreePullCommand = e8.defineCommand({
  name: "magit-subtree-pull",
  doc: "Pull REF from REPOSITORY into the PREFIX subtree.",
  run: () => {
    const prefix = magitSubtreePrefix("magit-subtree-import", "Pull into subtree");
    const [remote, ref] = readRemoteAndRef();
    magitSubtreePull(prefix, remote, ref, magitSubtreeArguments("magit-subtree-import"));
  },
});

/** Pushes the history of the subtree PREFIX to REF on REPOSITORY, as magit-subtree-push. */
export const magitSubtreePush = (prefix: string, repository: string, ref: string, args: string[] = []): string => magitGitSubtree("push", prefix, args, repository, ref);
export const magitSubtreePushCommand = e8.defineCommand({
  name: "magit-subtree-push",
  doc: "Extract the history of the subtree PREFIX and push it to REF on REPOSITORY.",
  run: () => {
    const prefix = magitSubtreePrefix("magit-subtree-export", "Push subtree");
    const repository = magitReadRemoteOrUrl("To repository");
    const ref = magitReadStringNs("To reference");
    magitSubtreePush(prefix, repository, ref, magitSubtreeArguments("magit-subtree-export"));
  },
});

/** Extracts the history of the subtree PREFIX, as magit-subtree-split. */
export const magitSubtreeSplit = (prefix: string, commit: string, args: string[] = []): string => magitGitSubtree("split", prefix, args, commit);
export const magitSubtreeSplitCommand = e8.defineCommand({
  name: "magit-subtree-split",
  doc: "Extract the history of the subtree PREFIX.",
  run: () => {
    const prefix = magitSubtreePrefix("magit-subtree-export", "Split subtree");
    magitSubtreeSplit(prefix, magitReadStringNs("Commit"), magitSubtreeArguments("magit-subtree-export"));
  },
});

// The menus

/** The --prefix option, as magit-subtree:--prefix. */
const prefixOption: [string, string, string, object] = ["-P", "Prefix", "--prefix=", { reader: (prompt: string, def?: string) => magitSubtreeReadPrefix(prompt.replace(/: ?$/, ""), def) }];

export const magitSubtreeImport = transientDefinePrefix("magit-subtree-import", {
  doc: "Import subtrees.",
  groups: [
    {
      description: "Arguments",
      items: [prefixOption, ["-m", "Message", "--message="], ["-s", "Squash", "--squash"]],
    },
    {
      description: "Subtree import actions",
      class: "columns",
      items: [
        { items: [["a", "Add", magitSubtreeAddCommand], ["c", "Add commit", magitSubtreeAddCommitCommand]] },
        { items: [["m", "Merge", magitSubtreeMergeCommand], ["f", "Pull", magitSubtreePullCommand]] },
      ],
    },
  ],
});

export const magitSubtreeExport = transientDefinePrefix("magit-subtree-export", {
  doc: "Export subtrees.",
  groups: [
    {
      description: "Arguments",
      items: [
        prefixOption,
        ["-a", "Annotate", "--annotate="],
        ["-b", "Branch", "--branch="],
        ["-o", "Onto", "--onto=", { reader: (prompt: string, initial?: string) => magitTransientReadRevision(prompt, initial) }],
        ["-i", "Ignore joins", "--ignore-joins"],
        ["-j", "Rejoin", "--rejoin"],
      ],
    },
    {
      description: "Subtree export actions",
      items: [
        ["p", "Push", magitSubtreePushCommand],
        ["s", "Split", magitSubtreeSplitCommand],
      ],
    },
  ],
});

export const magitSubtree = transientDefinePrefix("magit-subtree", {
  doc: "Import or export subtrees.",
  groups: [
    {
      description: "Subtree actions",
      items: [
        ["i", "Import", magitSubtreeImport],
        ["e", "Export", magitSubtreeExport],
      ],
    },
  ],
});
