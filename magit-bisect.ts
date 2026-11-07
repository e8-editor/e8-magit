// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bisecting, after magit-bisect.el: the status buffer's sections while
// git bisect runs: its last output, the commits left to test, and its
// log. The commands are step 10's.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { insertHeading, insertSection } from "magit-section";
import { truthy } from "subr";
import { magitBisectInProgressP, magitGitRun } from "magit-git";
import { magitLogWashLog } from "magit-log";
import { magitFileLines } from "magit-sequence";

e8.defineVariable({ name: "magit-bisect-show-graph", doc: "Whether to use --graph in the log showing commits yet to be bisected.", value: true });

/** Inserts git bisect's last output, as magit-insert-bisect-output. */
export function magitInsertBisectOutput(): void {
  if (!magitBisectInProgressP()) return;
  const lines = magitFileLines("BISECT_CMD_OUTPUT");
  const out = lines.length > 0 ? lines : ["Bisecting: (no saved bisect output)", "It appears you have invoked `git bisect' from a shell.", "There is nothing wrong with that, we just cannot display", "anything useful here.  Consult the shell output instead."];
  const doneRe = /^([a-z0-9]{40,}) is the first bad commit$/;
  let badLine: string | undefined;
  if (doneRe.test(out[0])) badLine = out.shift();
  else badLine = out.find((l) => doneRe.test(l));
  insertSection(badLine ? "commit" : "bisect-output", badLine ? doneRe.exec(badLine)![1] : undefined, false, () => {
    insertHeading(e8.propertize(badLine ?? out.shift() ?? "", { "font-lock-face": "magit-section-heading" }));
    for (const line of out) e8.insert(`${line}\n`);
  }, "magit-insert-bisect-output");
  e8.insert("\n");
}

/** Inserts the commits left to test, as magit-insert-bisect-rest. */
export function magitInsertBisectRest(): void {
  if (!magitBisectInProgressP()) return;
  insertSection("bisect-view", undefined, false, () => {
    insertHeading(true, "Bisect Rest");
    const r = magitGitRun(["bisect", "visualize", "git", "log", "--format=%h%x00%D%x00%s", "--decorate=full", ...(truthy(e8.variable("magit-bisect-show-graph")) ? ["--graph"] : [])]);
    magitLogWashLog("bisect-vis", r.output, []);
  }, "magit-insert-bisect-rest");
}

/** Inserts git bisect's log, each step a section, as magit-insert-bisect-log and magit-wash-bisect-log. */
export function magitInsertBisectLog(): void {
  if (!magitBisectInProgressP()) return;
  insertSection("bisect-log", undefined, false, () => {
    insertHeading(true, "Bisect Log");
    const lines = magitGitRun(["bisect", "log"]).output.split("\n");
    let chunk: string[] = [];
    for (const line of lines) {
      if (line.startsWith("# status:")) continue;
      if (line.startsWith("git bisect ")) {
        const items = chunk;
        chunk = [];
        insertSection("bisect-item", line, true, () => {
          insertHeading(e8.propertize(line, { "font-lock-face": "magit-section-secondary-heading" }));
          magitLogWashLog("bisect-log", items.join("\n"), []);
          e8.insert("\n");
        });
        continue;
      }
      const first = /^# first bad commit: \[([a-z0-9]{40,})\] /.exec(line);
      if (first) {
        insertSection("bisect-item", undefined, false, () => e8.insert(`${first[1]} is the first bad commit\n`));
        continue;
      }
      if (line !== "") chunk.push(line);
    }
    e8.insert("\n");
  }, "magit-insert-bisect-log");
}
