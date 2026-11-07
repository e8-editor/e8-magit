// SPDX-License-Identifier: GPL-3.0-or-later
//
// Merging, after magit-merge.el: the status buffer's section for a merge
// going on, with the commits being merged. The commands are step 8's.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { insertHeading, insertSection } from "magit-section";
import { magitFileStatus, magitGetShortname, magitGitString, magitMergeInProgressP, magitTrackedFiles, magitUnmergedFiles, magitCurrentFile } from "magit-git";
import { magitCompletingRead, magitReadCharCase } from "magit-base";
import { magitCallGit, magitRunGit } from "magit-process";
import { magitInsertLog } from "magit-log";
import { magitFileLines } from "magit-sequence";
import { truthy } from "subr";

/** The range of what is being merged into HEAD, from their merge base, as magit--merge-range. */
export function magitMergeRange(head?: string): string | undefined {
  const h = head ?? (magitFileLines("MERGE_HEAD")[0] ? magitGetShortname(magitFileLines("MERGE_HEAD")[0]) : undefined);
  if (!h) return undefined;
  return `${magitGitString("merge-base", "--octopus", "HEAD", h) ?? ""}..${h}`;
}

/** Inserts the merge going on: the heads being merged and their commits, as magit-insert-merge-log. */
export function magitInsertMergeLog(): void {
  if (!magitMergeInProgressP()) return;
  const heads = magitFileLines("MERGE_HEAD").map(magitGetShortname);
  const range = magitMergeRange(heads[0]);
  insertSection("unmerged", range, false, () => {
    insertHeading(`Merging ${heads.join(", ")}:`);
    const args = (e8.variable("magit-buffer-log-args") as string[] | null) ?? ["-n256", "--decorate"];
    magitInsertLog(range, args.includes("--decorate=full") ? args : ["--decorate=full", ...args]);
  }, "magit-insert-merge-log");
}

// Conflicts.

/** Asks which stage of FILE to check out, as magit-checkout-read-stage. */
export const magitCheckoutReadStage = (file: string): string =>
  magitReadCharCase(`For ${file} checkout: `, true, [
    ["o", "[o]ur stage", "--ours"],
    ["t", "[t]heir stage", "--theirs"],
    ["c", truthy(e8.variable("magit-verbose-messages")) ? "restore [c]onflict" : "[c]onflict", "--merge"],
  ]);

/** During a conflict checkout and stage side, or restore conflict, as magit-checkout-stage: ARG is --ours, --theirs or --merge. */
export function magitCheckoutStage(file: string, arg: string): void {
  const st = magitFileStatus(file)[0] ?? "";
  const [x, y] = [st.charAt(0), st.charAt(1)];
  if ((arg === "--ours" && x === "D") || (arg === "--ours" && x === "U" && y === "A") || (arg === "--theirs" && y === "D") || (arg === "--theirs" && x === "A" && y === "U")) magitRunGit("rm", "--", file);
  else if (arg === "--merge") magitRunGit("checkout", "--merge", "--", file);
  else {
    magitCallGit("checkout", arg, "--", file);
    magitRunGit("add", "-u", "--", file);
  }
}

export const magitCheckoutStageCommand = e8.defineCommand({
  name: "magit-checkout-stage",
  doc: "During a conflict checkout and stage side, or restore conflict.",
  run: () => {
    const file = magitCompletingRead("Checkout file", magitTrackedFiles(), { requireMatch: "any", history: "magit-read-file-hist", def: magitCurrentFile() })!;
    if (magitUnmergedFiles().includes(file)) magitCheckoutStage(file, magitCheckoutReadStage(file));
    else if (e8.yesOrNoP(`Restore conflicts in ${file}? `)) magitCheckoutStage(file, "--merge");
    else e8.userError("Quit");
  },
});
