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
import { magitGitLines, magitGitRun, magitRevVerify } from "magit-git";
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
