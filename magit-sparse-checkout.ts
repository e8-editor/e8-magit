// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sparse checkouts, after magit-sparse-checkout.el: an interface to
// `git sparse-checkout' in cone mode, where the patterns are directories.
// The menu, magit-sparse-checkout, enables a sparse checkout, sets or adds
// the directories it includes, reapplies its rules, and disables it; the
// header magit-sparse-checkout-insert-header says what it includes, when
// added to magit-status-headers-hook. magit-clone-sparse, in
// magit-clone.ts, clones into one.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingReadMultiple } from "magit-base";
import { magitGetBoolean, magitGitLines, magitRevisionDirectories } from "magit-git";
import { magitRunGit, magitRunGitAsync, type Proc } from "magit-process";
import { inserters } from "magit-diff";

// Utilities.

/** Whether the working tree is a sparse checkout, as magit-sparse-checkout-enabled-p. */
export const magitSparseCheckoutEnabledP = (): boolean => magitGetBoolean("core.sparsecheckout");

/** Makes the working tree a sparse checkout in cone mode unless it is one, as magit-sparse-checkout--auto-enable. */
function magitSparseCheckoutAutoEnable(): void {
  if (magitSparseCheckoutEnabledP()) {
    if (!magitGetBoolean("core.sparsecheckoutcone")) e8.userError("Magit's sparse checkout functionality requires cone mode");
  }
  // Not magit-sparse-checkout-enable, which does not wait.
  else magitRunGit("sparse-checkout", "init", "--cone");
}

/**
 * The directories the sparse checkout includes recursively, each ending
 * in a slash, as magit-sparse-checkout-directories. See the
 * git-sparse-checkout manpage for "recursive" against "parent" directories
 * in cone mode.
 */
export function magitSparseCheckoutDirectories(): string[] {
  if (!magitGetBoolean("core.sparsecheckoutcone")) return [];
  return magitGitLines("sparse-checkout", "list").map((d) => e8.fileNameAsDirectory(d));
}

// Commands.

/** Converts the working tree to a sparse checkout, with ARGS such as --sparse-index, as magit-sparse-checkout-enable. */
export function magitSparseCheckoutEnable(args: string[] = []): Proc {
  return magitRunGitAsync("sparse-checkout", "init", "--cone", args);
}
export const magitSparseCheckoutEnableCommand = e8.defineCommand({
  name: "magit-sparse-checkout-enable",
  doc: "Convert the working tree to a sparse checkout.",
  run: () => void magitSparseCheckoutEnable(transientArgs("magit-sparse-checkout")),
});

/** Restricts the working tree to DIRECTORIES, as magit-sparse-checkout-set. */
export function magitSparseCheckoutSet(directories: string[]): Proc {
  magitSparseCheckoutAutoEnable();
  return magitRunGitAsync("sparse-checkout", "set", directories);
}
export const magitSparseCheckoutSetCommand = e8.defineCommand({
  name: "magit-sparse-checkout-set",
  doc: "Restrict working tree to DIRECTORIES.\nTo extend rather than override the currently configured directories, call magit-sparse-checkout-add instead.",
  run: () => {
    // As Magit notes, listing every directory may need reconsidering for the very large trees sparse checkouts are for.
    const directories = magitCompletingReadMultiple("Include these directories: ", magitRevisionDirectories("HEAD"));
    void magitSparseCheckoutSet(directories);
  },
});

/** Adds DIRECTORIES to the working tree, as magit-sparse-checkout-add. */
export function magitSparseCheckoutAdd(directories: string[]): Proc {
  magitSparseCheckoutAutoEnable();
  return magitRunGitAsync("sparse-checkout", "add", directories);
}
export const magitSparseCheckoutAddCommand = e8.defineCommand({
  name: "magit-sparse-checkout-add",
  doc: "Add DIRECTORIES to the working tree.\nTo override rather than extend the currently configured directories, call magit-sparse-checkout-set instead.",
  run: () => {
    const included = magitSparseCheckoutDirectories();
    const candidates = magitRevisionDirectories("HEAD").filter((d) => !included.some((i) => d.startsWith(i)));
    void magitSparseCheckoutAdd(magitCompletingReadMultiple("Add these directories: ", candidates));
  },
});

/** Reapplies the sparse checkout rules to the working tree, as magit-sparse-checkout-reapply. */
export const magitSparseCheckoutReapply = (): Proc => magitRunGitAsync("sparse-checkout", "reapply");
export const magitSparseCheckoutReapplyCommand = e8.defineCommand({
  name: "magit-sparse-checkout-reapply",
  doc: "Reapply the sparse checkout rules to the working tree.\nSome operations such as merging or rebasing may need to check out files that aren't included in the sparse checkout.  Call this command to reset to the sparse checkout state.",
  run: () => void magitSparseCheckoutReapply(),
});

/** Converts the sparse checkout to a full checkout, as magit-sparse-checkout-disable. */
export const magitSparseCheckoutDisable = (): Proc => magitRunGitAsync("sparse-checkout", "disable");
export const magitSparseCheckoutDisableCommand = e8.defineCommand({
  name: "magit-sparse-checkout-disable",
  doc: "Convert sparse checkout to full checkout.\nNote that disabling the sparse checkout does not clear the configured directories.  Call magit-sparse-checkout-enable to restore the previous sparse checkout.",
  run: () => void magitSparseCheckoutDisable(),
});

export const magitSparseCheckout = transientDefinePrefix("magit-sparse-checkout", {
  doc: "Create and manage sparse checkouts.",
  groups: [
    { description: "Arguments for enabling", ifNot: magitSparseCheckoutEnabledP, items: [["-i", "Use sparse index", "--sparse-index"]] },
    {
      description: "Actions",
      class: "columns",
      items: [
        { ifNot: magitSparseCheckoutEnabledP, items: [["e", "Enable sparse checkout", magitSparseCheckoutEnableCommand]] },
        {
          if: magitSparseCheckoutEnabledP,
          items: [
            ["d", "Disable sparse checkout", magitSparseCheckoutDisableCommand],
            ["r", "Reapply rules", magitSparseCheckoutReapplyCommand],
          ],
        },
        {
          items: [
            ["s", "Set directories", magitSparseCheckoutSetCommand],
            ["a", "Add directories", magitSparseCheckoutAddCommand],
          ],
        },
      ],
    },
  ],
});

// Miscellaneous.

/**
 * Inserts a header line saying what the sparse checkout includes, as
 * magit-sparse-checkout-insert-header.  This header is not inserted by
 * default.  To enable it, add it to magit-status-headers-hook.
 */
export function magitSparseCheckoutInsertHeader(): void {
  if (!magitSparseCheckoutEnabledP()) return;
  e8.insert(e8.propertize("Sparse! ".padEnd(10), { "font-lock-face": "magit-section-heading" }));
  const dirs = magitSparseCheckoutDirectories();
  e8.insert(dirs.length === 0 ? "top-level directory" : dirs.length === 1 ? dirs[0] : `${dirs.length} directories`);
  e8.insert("\n");
}
inserters.set("magit-sparse-checkout-insert-header", magitSparseCheckoutInsertHeader);
e8.defun("magit-sparse-checkout-insert-header", magitSparseCheckoutInsertHeader);
