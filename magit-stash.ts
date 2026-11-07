// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stashes, after magit-stash.el: the status buffer's list of stashes and
// a rebase's autostash. The stash buffer is in magit-diff.ts and the
// commands are step 8's.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { insertHeading, insertSection } from "magit-section";
import { magitGitLines, magitGitRun, magitRevVerify, magitSectionValueIf } from "magit-git";
import { magitConfirm } from "magit-base";
import { magitRunGit } from "magit-process";
import { magitLogWashLog } from "magit-log";
import { magitLogFormatMargin, magitMakeMarginOverlay } from "magit-margin";
import { magitFileLine } from "magit-sequence";

/** Inserts the stashes of REF, a rebase's autostash first, as magit-insert-stashes. */
export function magitInsertStashes(ref = "refs/stash", heading = "Stashes:"): void {
  const verified = magitRevVerify(ref);
  const autostash = magitFileLine("rebase-merge/autostash") ?? magitFileLine("rebase-apply/autostash");
  if (!autostash && !verified) return;
  insertSection("stashes", ref, false, () => {
    insertHeading(heading);
    if (autostash) {
      const [author, date, msg] = (magitGitLines("show", "-q", "--format=%aN%x00%at%x00%s", autostash)[0] ?? "").split("\0");
      insertSection("stash", autostash, false, () => {
        e8.insert(e8.propertize("AUTOSTASH", { "font-lock-face": "magit-hash" }));
        e8.insert(` ${msg ?? ""}\n`);
        magitLogFormatMargin(autostash, author ?? "", date ?? "0");
      });
    }
    if (verified) {
      const r = magitGitRun(["reflog", "--format=%gd%x00%aN%x00%at%x00%gs", ref]);
      magitLogWashLog("stash", r.output, []);
    } else {
      e8.insert("\n");
      magitMakeMarginOverlay();
    }
  }, "magit-insert-stashes");
}

// The stashes buffer.

import { insertRoot } from "magit-section";
import { magitBufferName, magitReflogMode, magitSetupBuffer } from "magit-mode";
import { magitSetBufferMargins } from "magit-margin";

export const magitStashesMode = e8.defineMajorMode({ name: "magit-stashes-mode", modeName: "Magit Stashes", parent: magitReflogMode, doc: "Mode for looking at lists of stashes." });

/** Lists the stashes of REF, as magit-stashes-setup-buffer. */
export function magitStashesSetupBuffer(ref = "refs/stash"): string {
  return magitSetupBuffer(magitBufferName("magit-stashes-mode"), magitStashesMode, "stashes", () => {
    const r = String(e8.variable("magit-buffer-refname"));
    magitSetBufferMargins();
    insertRoot("stashesbuf", () => {
      insertHeading(true, r === "refs/stash" ? "Stashes" : `Stashes [${r}]`);
      magitLogWashLog("stash", magitGitRun(["reflog", "--format=%gd%x00%aN%x00%at%x00%gs", r]).output, []);
    });
  }, true, { "magit-buffer-refname": ref });
}
e8.defineCommand({ name: "magit-stash-list", doc: "List all stashes in a buffer.", run: () => void magitStashesSetupBuffer() });

// Keys.

import { magitSectionDefineType } from "magit-section";

/** The keys of a stash's section, as magit-stash-section-map. */
e8.defineKeymap("magit-stash-section-map", null);
for (const [from, to] of [
  ["magit-cherry-pick", "magit-stash-pop"],
  ["magit-cherry-apply", "magit-stash-apply"],
  ["magit-delete-thing", "magit-stash-drop"],
  ["magit-visit-thing", "magit-stash-show"],
] as const)
  e8.remapCommand("magit-stash-section-map", from as e8.CommandName, to as e8.CommandName);
magitSectionDefineType("stash", { keymap: "magit-stash-section-map" });

// Clearing, after magit-stash.el's magit-stash-clear.

/** Removes all stashes saved in REF's reflog by deleting REF, as magit-stash-clear does once confirmed. */
export function magitStashClear(ref: string): void {
  magitRunGit("update-ref", "-d", ref);
}
export const magitStashClearCommand = e8.defineCommand({
  name: "magit-stash-clear",
  doc: "Remove all stashes saved in REF's reflog by deleting REF.",
  run: () => {
    const v = magitSectionValueIf("stashes");
    const ref = typeof v === "string" ? v : "refs/stash";
    magitConfirm(true, `Drop all stashes in ${ref}`);
    magitStashClear(ref);
  },
});

/** The keys of the stashes section, as magit-stashes-section-map. */
e8.defineKeymap("magit-stashes-section-map", null);
e8.remapCommand("magit-stashes-section-map", "magit-delete-thing" as e8.CommandName, magitStashClearCommand);
e8.remapCommand("magit-stashes-section-map", "magit-visit-thing" as e8.CommandName, "magit-stash-list" as e8.CommandName);
magitSectionDefineType("stashes", { keymap: "magit-stashes-section-map" });
