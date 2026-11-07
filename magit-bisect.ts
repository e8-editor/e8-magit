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
import * as transientModule from "transient";
import { transientArgs, transientDefinePrefix } from "transient";
import { magitConfirm } from "magit-base";
import {
  magitAnythingModifiedP,
  magitBisectInProgressP,
  magitGitdir,
  magitGitRun,
  magitGitVersionGe,
  magitReadBranchOrCommit,
  magitReadOtherBranchOrCommit,
  magitRevAncestorP,
  magitToplevel,
  magitToplevelOrError,
} from "magit-git";
import { magitProcessSentinel, magitRunGit, magitStartGitWith } from "magit-process";
import { magitRefresh } from "magit-mode";
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

// The bisect commands, after magit-bisect.el.

for (const [name, doc, attributes] of [
  ["magit-bisect-good", "Face for good bisect revisions.", { foreground: "DarkOliveGreen" }],
  ["magit-bisect-skip", "Face for skipped bisect revisions.", { foreground: "DarkGoldenrod" }],
  ["magit-bisect-bad", "Face for bad bisect revisions.", { foreground: "IndianRed4" }],
] as [string, string, e8.FaceAttributes][]) e8.defineFace({ name, doc, attributes });

/** The new and old terms, as BISECT_TERMS has them, as magit-bisect-terms. */
export const magitBisectTerms = (): string[] => magitFileLines(e8.expandFileName("BISECT_TERMS", magitGitdir()));

/** Whether each repository's bisect follows the first parent, as magit-repository-local-set of bisect--first-parent. */
const firstParent = new Map<string, boolean>();
export const magitBisectFirstParentP = (): boolean => firstParent.get(magitToplevel() ?? "") === true;

const bisectArgs = (): string[] => transientArgs("magit-bisect");
const argValue = (prefix: string, args: string[]): string | undefined => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

/** Runs git bisect SUBCOMMAND in the background, keeping its output for the status buffer, as magit-git-bisect. */
export function magitGitBisect(subcommand: string, args: (string | undefined)[] = [], noAssert = false): void {
  if (!noAssert && !magitBisectInProgressP()) e8.userError("Not bisecting");
  e8.message("Bisecting...");
  const top = magitToplevelOrError();
  e8.letBind({ "default-directory": top }, () =>
    magitStartGitWith(["bisect", subcommand, ...args], {
      sentinel: (entry, exit) => {
        magitProcessSentinel(entry, exit);
        if (exit === 0) e8.writeTextFile(e8.expandFileName("BISECT_CMD_OUTPUT", magitGitdir(top)), entry.output);
        e8.message("Bisecting...done");
      },
    }),
  );
}

/** Reads the bad and good revisions, as magit-bisect-start-read-args. */
function startReadArgs(): [string, string, string[]] {
  const args = bisectArgs();
  const bad = magitReadBranchOrCommit(`Start bisect with ${argValue("--term-new=", args) ?? "bad"} revision`);
  const good = magitReadOtherBranchOrCommit(`${argValue("--term-old=", args) ?? "Good"} revision`, bad);
  return [bad, good, args];
}

/** Checks GOOD is below BAD and the tree is clean, as magit-bisect-start--assert. */
function startAssert(bad: string, good: string, args: string[]): void {
  if (!magitRevAncestorP(good, bad)) e8.userError(`The ${argValue("--term-old=", args) ?? "good"} revision (${good}) has to be an ancestor of the ${argValue("--term-new=", args) ?? "bad"} one (${bad})`);
  if (magitAnythingModifiedP()) e8.userError("Cannot bisect with uncommitted changes");
}

export const magitBisectStart = e8.defineCommand({
  name: "magit-bisect-start",
  doc: "Start a bisect session.  Bisecting a bug means to find the commit that introduced it.  This command starts such a bisect session by asking for a known good and a known bad commit.",
  run: () => {
    if (magitBisectInProgressP()) e8.userError("Already bisecting");
    const [bad, good, args] = startReadArgs();
    startAssert(bad, good, args);
    firstParent.set(magitToplevel() ?? "", args.includes("--first-parent"));
    magitGitBisect("start", [...args, bad, good], true);
  },
});
export const magitBisectReset = e8.defineCommand({
  name: "magit-bisect-reset",
  doc: "After bisecting, cleanup bisection state and return to original HEAD.",
  run: () => {
    magitConfirm("reset-bisect");
    magitRunGit("bisect", "reset");
    firstParent.delete(magitToplevel() ?? "");
    const out = e8.expandFileName("BISECT_CMD_OUTPUT", magitGitdir());
    if (e8.fileExistsP(out)) e8.deleteFile(out);
  },
});
export const magitBisectGood = e8.defineCommand({
  name: "magit-bisect-good",
  doc: "While bisecting, mark the current commit as good.  Use this after you have asserted that the commit does not contain the bug in question.",
  run: () => magitGitBisect(magitBisectTerms()[1] ?? e8.userError("Not bisecting")),
});
export const magitBisectBad = e8.defineCommand({
  name: "magit-bisect-bad",
  doc: "While bisecting, mark the current commit as bad.  Use this after you have asserted that the commit does contain the bug in question.",
  run: () => magitGitBisect(magitBisectTerms()[0] ?? e8.userError("Not bisecting")),
});
export const magitBisectMark = e8.defineCommand({
  name: "magit-bisect-mark",
  doc: "While bisecting, mark the current commit with a bisect term.",
  run: () => {
    const terms = magitBisectTerms();
    if (terms.length < 2) e8.userError("Not bisecting");
    const [termNew, termOld] = terms;
    magitGitBisect(e8.readCharChoice(`Mark HEAD as ${termNew} ([n]ew) or ${termOld} ([o]ld)`, "no") === "n" ? termNew : termOld);
  },
});
export const magitBisectSkip = e8.defineCommand({
  name: "magit-bisect-skip",
  doc: "While bisecting, skip the current commit.  Use this if for some reason the current commit is not a good one to test.  This command lets Git choose a different one.",
  run: () => magitGitBisect("skip"),
});
export const magitBisectRun = e8.defineCommand({
  name: "magit-bisect-run",
  doc: "Bisect automatically by running commands after each step.  Unlike git bisect run this can be used before bisecting has begun.  In that case it behaves like git bisect start; git bisect run.",
  run: () => {
    const start = magitBisectInProgressP() ? undefined : startReadArgs();
    const cmdline = e8.readString("Bisect shell command: ");
    if (start) {
      const [bad, good, args] = start;
      startAssert(bad, good, args);
      // Not magitGitBisect, which does not wait: git bisect run needs the bisect started.
      const top = magitToplevelOrError();
      e8.letBind({ "default-directory": top }, () => {
        const r = magitGitRun(["bisect", "start", bad, good, ...args]);
        e8.writeTextFile(e8.expandFileName("BISECT_CMD_OUTPUT", magitGitdir()), r.output);
      });
      magitRefresh();
    }
    const shell = String(e8.variable("shell-file-name") ?? "/bin/sh");
    magitGitBisect("run", [shell, String(e8.variable("shell-command-switch") ?? "-c"), cmdline]);
  },
});

const hasLevels = "transientPrefixLevel" in transientModule;
const lvl = (level: number, options: object = {}) => ({ ...options, level, ...(hasLevels || level <= 4 ? {} : { if: () => false }) });

export const magitBisect = transientDefinePrefix("magit-bisect", {
  doc: "Narrow in on the commit that introduced a bug.",
  groups: [
    {
      class: "subgroups",
      ifNot: magitBisectInProgressP,
      items: [
        {
          description: "Arguments",
          items: [
            ["-n", "Don't checkout commits", "--no-checkout"],
            ["-p", "Follow only first parent of a merge", "--first-parent", { if: () => magitGitVersionGe("2.29") }],
            ["=o", "Old/good term", "--term-old=", lvl(6)],
            ["=n", "New/bad term", "--term-new=", lvl(6)],
          ],
        },
        { description: "Actions", items: [["B", "Start", magitBisectStart], ["s", "Start script", magitBisectRun]] },
      ],
    },
    {
      description: "Actions",
      if: magitBisectInProgressP,
      items: [["B", "Bad", magitBisectBad], ["g", "Good", magitBisectGood], ["m", "Mark", magitBisectMark, lvl(6)], ["k", "Skip", magitBisectSkip], ["r", "Reset", magitBisectReset], ["s", "Run script", magitBisectRun]],
    },
  ],
});
