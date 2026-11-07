// SPDX-License-Identifier: GPL-3.0-or-later
//
// Merging, after magit-merge.el: the status buffer's section for a merge
// going on, with the commits being merged, and aborting it
// (magit-merge-abort). The other commands are step 8's, in magit.ts.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { insertHeading, insertSection } from "magit-section";
import { magitConfirm } from "magit-base";
import { magitGetShortname, magitGitdir, magitGitString, magitMergeInProgressP } from "magit-git";
import { magitRunGitAsync } from "magit-process";
import { magitInsertLog } from "magit-log";
import { magitFileLines } from "magit-sequence";

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

export const magitMergeAbort = e8.defineCommand({
  name: "magit-merge-abort",
  doc: "Abort the current merge operation.\n\n(git merge --abort)",
  run: () => {
    if (!e8.fileExistsP(e8.expandFileName("MERGE_HEAD", magitGitdir()))) e8.userError("No merge in progress");
    magitConfirm("abort-merge");
    magitRunGitAsync("merge", "--abort");
  },
});
