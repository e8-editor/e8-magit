// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sequences of commits being applied, after magit-sequence.el: the
// status buffer's sections for a rebase, git am, a cherry-pick or a
// revert going on, each listing the commits still to do, the one stopped
// at and those done, as Magit lists them. The commands are step 8's.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { insertHeading, insertSection } from "magit-section";
import {
  magitAmInProgressP,
  magitAnythingModifiedP,
  magitAnythingUnmergedP,
  magitCherryPickInProgressP,
  magitCommitP,
  magitGet,
  magitGitdir,
  magitGitLines,
  magitGitRun,
  magitPatchId,
  magitRebaseInProgressP,
  magitRevEqual,
  magitRevName,
  magitRevParse,
  magitRevertInProgressP,
} from "magit-git";

const faces: [string, string, e8.FaceAttributes][] = [
  ["magit-sequence-pick", "Face used in sequence sections.", { inherit: "default" }],
  ["magit-sequence-stop", "Face used in sequence sections.", { foreground: "DarkOliveGreen4" }],
  ["magit-sequence-part", "Face used in sequence sections.", { foreground: "Goldenrod4" }],
  ["magit-sequence-head", "Face used in sequence sections.", { foreground: "SkyBlue4" }],
  ["magit-sequence-drop", "Face used in sequence sections.", { foreground: "IndianRed" }],
  ["magit-sequence-done", "Face used in sequence sections.", { inherit: "magit-hash" }],
  ["magit-sequence-onto", "Face used in sequence sections.", { inherit: "magit-sequence-done" }],
  ["magit-sequence-exec", "Face used in sequence sections.", { inherit: "magit-hash" }],
  ["git-rebase-label", "Face for labels in rebase todo lists.", { inherit: "font-lock-variable-name-face" }],
];
for (const [name, doc, attributes] of faces) e8.defineFace({ name, doc, attributes });

const fl = (text: string, face: string): e8.PropertizedString => e8.propertize(text, { "font-lock-face": face });

/** A file in the git directory's first line, or undefined, as magit-file-line. */
export function magitFileLine(file: string): string | undefined {
  const g = magitGitdir();
  const f = g && e8.expandFileName(file, g);
  return f && e8.fileExistsP(f) ? e8.readTextFile(f).split("\n")[0] : undefined;
}
/** A file in the git directory's lines, as magit-file-lines. */
export function magitFileLines(file: string): string[] {
  const g = magitGitdir();
  const f = g && e8.expandFileName(file, g);
  return f && e8.fileExistsP(f) ? e8.readTextFile(f).split("\n").filter((l) => l !== "") : [];
}

/** Inserts a commit of a sequence: TYPE in FACE, its hash and summary, as magit-sequence-insert-commit. */
export function magitSequenceInsertCommit(type: string, hash: string, face: string, abbrev?: string, msg?: string): void {
  insertSection("commit", hash, false, () => {
    if (abbrev !== undefined) insertHeading(fl(type, face), " ", e8.concat(fl(abbrev, "magit-hash"), ` ${msg ?? ""}\n`));
    else {
      const line = magitGitRun(["log", "-1", "--no-patch", "--format=%h %s", hash, "--"]).output.split("\n")[0] ?? hash;
      const m = /^([^ ]+) (.*)$/.exec(line);
      insertHeading(fl(type, face), " ", e8.concat(fl(m?.[1] ?? line, "magit-hash"), ` ${m?.[2] ?? ""}\n`));
    }
  });
}

/** Inserts a todo step that names no commit: exec, label, break and the rest, as magit-sequence-insert-step. */
function insertStep(type: string, target?: string): void {
  insertSection("rebase-step", `${type} ${target ?? ""}`, false, () => insertHeading(fl(type, "magit-sequence-pick"), ...(target ? [" ", fl(target, "git-rebase-label")] : [])));
}

/**
 * Inserts the commits already done, the one stopped at and where it all
 * goes onto, as magit-sequence-insert-sequence: the stopped commit as join,
 * goal, same, work, poof or gone as its changes now stand.
 */
export function magitSequenceInsertSequence(stopIn: string | undefined, ontoIn: string | undefined, orig?: string): void {
  const head = magitRevParse("HEAD")!;
  const onto = ontoIn ? (magitRevParse(ontoIn) ?? ontoIn) : head;
  const done = magitGitLines("log", "--format=%H%x00%h%x00%s", `${onto}..HEAD`).map((l) => l.split("\0"));
  let stop = stopIn;
  if (stop && !done.some(([rev]) => rev === magitRevParse(stop!))) {
    const id = magitPatchId(stop);
    const matched = done.find(([rev]) => magitPatchId(rev) === id);
    if (matched) stop = matched[0];
    else {
      if (done.some(([rev]) => magitRevEqual(rev, stop!))) magitSequenceInsertCommit("void", stop, "magit-sequence-drop");
      else if (magitAnythingUnmergedP()) magitSequenceInsertCommit("join", stop, "magit-sequence-part");
      else if (magitAnythingModifiedP()) magitSequenceInsertCommit("work", stop, "magit-sequence-part");
      else if (done.some(([rev]) => magitRevEqual(rev, stop!))) magitSequenceInsertCommit("poof", stop, "magit-sequence-drop");
      else magitSequenceInsertCommit("gone", stop, "magit-sequence-drop");
      stop = undefined;
    }
  }
  for (const [rev, abbrev, msg] of done) {
    if (rev === stop) magitSequenceInsertCommit(rev === head && magitPatchId(rev) === (orig ? magitPatchId(orig) : undefined) ? "stop" : "like", rev, rev === head ? "magit-sequence-head" : "magit-sequence-stop", abbrev, msg);
    else if (rev === head) magitSequenceInsertCommit("done", rev, "magit-sequence-head", abbrev, msg);
    else magitSequenceInsertCommit("done", rev, "magit-sequence-done", abbrev, msg);
  }
  magitSequenceInsertCommit("onto", onto, onto === head ? "magit-sequence-head" : "magit-sequence-onto");
}

/** A line of a rebase todo list, as git-rebase-action. */
export interface RebaseAction {
  action: string;
  type: "commit" | "merge" | "exec" | "label" | "bare";
  target?: string;
  options?: string;
  trailer?: string;
  abbrev?: string;
}

const actionAbbrevs: { [k: string]: string } = { p: "pick", r: "reword", e: "edit", s: "squash", f: "fixup", x: "exec", b: "break", d: "drop", l: "label", t: "reset", m: "merge", u: "update-ref" };

/** Parses a rebase todo LINE, comments left out, as git-rebase-current-line. */
export function gitRebaseParseLine(line: string, commentChar = "#"): RebaseAction | undefined {
  if (line.trim() === "" || line.startsWith(commentChar)) return undefined;
  const [first, ...rest] = line.split(" ");
  const action = actionAbbrevs[first] ?? first;
  if (["pick", "reword", "edit", "squash", "fixup", "drop"].includes(action)) {
    const opts = rest[0]?.startsWith("-") ? rest.shift() : undefined;
    // Newer git writes the subject after "# ".
    return { action, type: "commit", target: rest[0], options: opts, trailer: rest.slice(1).join(" ").replace(/^# /, "") };
  }
  if (action === "merge") {
    const opts: string[] = [];
    while (rest[0]?.startsWith("-")) opts.push(rest.shift()!, rest.shift() ?? "");
    return { action, type: "merge", options: opts.join(" "), target: rest[0], trailer: rest.slice(1).join(" ").replace(/^# /, "") };
  }
  if (action === "exec") return { action, type: "exec", target: rest.join(" ") };
  if (["label", "reset", "update-ref"].includes(action)) return { action, type: "label", target: rest[0] };
  if (action === "break" || action === "noop") return { action, type: "bare" };
  return undefined;
}

/** The rebase's remaining actions, last first as the status buffer lists them, as magit-rebase--todo. */
function rebaseTodo(): RebaseAction[] {
  const comment = magitGet("core.commentChar") ?? "#";
  const actions = magitFileLines("rebase-merge/git-rebase-todo").map((l) => gitRebaseParseLine(l, comment)).filter((a): a is RebaseAction => a !== undefined);
  const commits = actions.filter((a) => a.type === "commit" || a.type === "merge");
  const targets = commits.map((a) => (a.type === "merge" ? /-[cC] ([^ ]+)/.exec(a.options ?? "")?.[1] : a.target)).filter((t): t is string => t !== undefined);
  const abbrevs = targets.length > 0 ? magitGitLines("log", "--no-walk=unsorted", "--format=%h", ...targets) : [];
  commits.forEach((a, i) => (a.abbrev = abbrevs[i]));
  return actions.reverse();
}

/** Inserts the rebase going on, as magit-insert-rebase-sequence. */
export function magitInsertRebaseSequence(): void {
  if (!magitRebaseInProgressP()) return;
  const g = magitGitdir()!;
  const mergep = e8.fileExistsP(e8.expandFileName("rebase-merge", g)) && e8.fileDirectoryP?.(e8.expandFileName("rebase-merge", g)) !== false;
  const dir = mergep ? "rebase-merge/" : "rebase-apply/";
  const headName = magitFileLine(`${dir}head-name`) ?? "HEAD";
  const ontoRaw = magitFileLine(`${dir}onto`) ?? "";
  const onto = magitRevName(ontoRaw, headName) ?? magitRevName(ontoRaw, "refs/heads/*") ?? ontoRaw;
  const name = magitRevName(headName, "refs/heads/*") ?? headName;
  insertSection("rebase-sequence", undefined, false, () => {
    insertHeading(`Rebasing ${name} onto ${onto}`);
    if (mergep) {
      for (const a of rebaseTodo()) {
        if (a.type === "commit" || (a.type === "merge" && a.abbrev)) magitSequenceInsertCommit(a.action, a.target!, "magit-sequence-pick", a.abbrev, a.trailer);
        else insertStep(a.action, a.target);
      }
      const done = magitFileLines("rebase-merge/done");
      magitSequenceInsertSequence(magitFileLine("rebase-merge/stopped-sha"), onto, done.length > 0 ? done[done.length - 1].split(" ")[1] : undefined);
    } else {
      const rewritten = magitFileLines("rebase-apply/rewritten").map((l) => l.split(" ")[0]);
      const stop = magitFileLine("rebase-apply/original-commit");
      for (const patch of rebasePatches().slice(1).reverse()) {
        const hash = (e8.readTextFile(patch).split("\n")[0] ?? "").split(" ")[1];
        if (hash && !rewritten.includes(hash) && hash !== stop) magitSequenceInsertCommit("pick", hash, "magit-sequence-pick");
      }
      magitSequenceInsertSequence(stop, onto);
    }
    e8.insert("\n");
  }, "magit-insert-rebase-sequence");
}

/** The patches of git am or a patch-based rebase, as magit-rebase-patches. */
function rebasePatches(): string[] {
  const g = magitGitdir()!;
  const dir = e8.expandFileName("rebase-apply", g);
  return e8.directoryFiles(dir, { full: true, match: "^[0-9]{4}$" });
}

/** Inserts the patches git am is applying, as magit-insert-am-sequence. */
export function magitInsertAmSequence(): void {
  if (!magitAmInProgressP()) return;
  insertSection("rebase-sequence", undefined, false, () => {
    insertHeading("Applying patches");
    const patches = rebasePatches().reverse();
    let i = Number(magitFileLine("rebase-apply/last") ?? 0);
    const cur = Number(magitFileLine("rebase-apply/next") ?? 0);
    while (patches.length > 0 && i >= cur) {
      const patch = patches.shift()!;
      const commit = magitCommitP((e8.readTextFile(patch).split("\n")[0] ?? "").split(" ")[1] ?? "");
      if (commit && i === cur) magitSequenceInsertCommit("stop", commit, "magit-sequence-stop");
      else if (i === cur) insertAmPatch("stop", patch, "magit-sequence-stop");
      else if (commit) magitSequenceInsertCommit("pick", commit, "magit-sequence-pick");
      else insertAmPatch("pick", patch, "magit-sequence-pick");
      i--;
    }
    magitSequenceInsertSequence(undefined, "ORIG_HEAD");
    e8.insert("\n");
  }, "magit-insert-am-sequence");
}
function insertAmPatch(type: string, patch: string, face: string): void {
  insertSection("file", patch, false, () => {
    const text = e8.readTextFile(patch);
    const title = /^Subject: (.*)$/m.exec(text)?.[1] ?? text.split("\n")[0];
    e8.insert(fl(type, face));
    e8.insert(" ");
    e8.insert(fl(e8.fileNameNondirectory(patch), "magit-hash"));
    e8.insert(` ${title}\n`);
  });
}

/** Inserts the cherry-pick or revert going on, as magit-insert-sequencer-sequence. */
export function magitInsertSequencerSequence(): void {
  const picking = magitCherryPickInProgressP();
  if (!picking && !magitRevertInProgressP()) return;
  insertSection("sequence", undefined, false, () => {
    insertHeading(picking ? "Cherry Picking" : "Reverting");
    const lines = magitFileLines("sequencer/todo").slice(1).reverse();
    for (const line of lines) {
      const m = /^(pick|revert) ([^ ]+) (.*)$/.exec(line);
      if (!m) continue;
      insertSection("commit", m[2], false, () => {
        e8.insert(fl(m[1], "magit-sequence-pick"));
        e8.insert(" ");
        e8.insert(fl(m[2], "magit-hash"));
        e8.insert(` ${m[3]}\n`);
      });
    }
    magitSequenceInsertSequence(magitFileLine(picking ? "CHERRY_PICK_HEAD" : "REVERT_HEAD"), magitFileLine("sequencer/head"));
    e8.insert("\n");
  }, "magit-insert-sequencer-sequence");
}
