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

import { insertHeading, insertSection, magitRegionValues } from "magit-section";
import { truthy } from "subr";
import * as transient from "transient";
import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingRead, magitConfirm, magitReadStringNs, prefixArgP } from "magit-base";
import { magitCallGit, magitGit, magitRunGit, magitRunGitSequencer, magitStartGitWith } from "magit-process";
import { magitRefresh } from "magit-mode";
import { magitLogSelect } from "magit-log";
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
  magitAnythingStagedP,
  magitAnythingUnstagedP,
  magitBranchP,
  magitCommitAtPoint,
  magitCommitParents,
  magitFileAtPoint,
  magitGetCurrentBranch,
  magitGetPushBranch,
  magitGetPushRemote,
  magitGetUpstreamBranch,
  magitGitString,
  magitListContainingBranches,
  magitListRemoteBranches,
  magitListRemotes,
  magitMergeCommitP,
  magitReadBranchOrCommit,
  magitReadOtherBranch,
  magitReadOtherBranchOrCommit,
  magitReadStartingPoint,
  magitReadUpstreamBranch,
  magitRefFullname,
  magitRevAbbrev,
  magitRevAncestorP,
  magitRevVerify,
  magitSequencerInProgressP,
  magitToplevel,
  magitUpstreamFace,
  type GitArg,
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

// The sequencer's commands, after magit-sequence.el: cherry-picking,
// reverting, applying patches by email, and rebasing, each a menu whose
// actions continue, skip or abort what is going on when something is.

e8.defineVariable({ name: "magit-perl-executable", doc: "The Perl executable.", value: "perl" });
e8.defineVariable({ name: "magit-published-branches", doc: "List of branches that are considered to be published.", value: ["origin/master", "origin/main"] });
e8.defineVariable({ name: "magit-rebase-interactive-include-selected", doc: "Whether an interactive rebase includes the commit selected.", value: true });

/** Reads a number, asking again until one is given, as read-number. */
function readNumber(prompt: string, def?: number): number {
  for (;;) {
    const p = def === undefined ? prompt : prompt.replace(/: $/, ` (default ${def}): `);
    const text = e8.readString(p).trim();
    if (text === "" && def !== undefined) return def;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    e8.message("Please enter a number.");
    e8.sitFor(1);
  }
}
const perl = (): string => String(e8.variable("magit-perl-executable") ?? "perl");
const quit = (msg: string): never => e8.userError(msg);
/** The commits the region selects, oldest first, as (nreverse (magit-region-values 'commit)). */
const regionCommits = (): string[] => ((magitRegionValues("commit", true) as string[] | undefined) ?? []).slice().reverse();

/** Starts git's sequencer with ARGS, then calls THEN with its exit code. */
const sequencer = (args: GitArg[], then?: (exit: number) => void, env?: { [k: string]: string }): string =>
  then || env ? magitStartGitWith(args, { editor: true, then, env }) : magitRunGitSequencer(...args);

export const magitSequencerContinue = e8.defineCommand({
  name: "magit-sequencer-continue",
  doc: "Resume the current cherry-pick or revert sequence.",
  run: () => {
    if (!magitSequencerInProgressP()) quit("No cherry-pick or revert in progress");
    if (magitAnythingUnmergedP()) quit("Cannot continue due to unresolved conflicts");
    sequencer([magitRevertInProgressP() ? "revert" : "cherry-pick", "--continue"]);
  },
});
export const magitSequencerSkip = e8.defineCommand({
  name: "magit-sequencer-skip",
  doc: "Skip the stopped at commit during a cherry-pick or revert sequence.",
  run: () => {
    if (!magitSequencerInProgressP()) quit("No cherry-pick or revert in progress");
    magitCallGit("reset", "--hard");
    e8.call(magitSequencerContinue);
  },
});
export const magitSequencerAbort = e8.defineCommand({
  name: "magit-sequencer-abort",
  doc: "Abort the current cherry-pick or revert sequence.  This discards all changes made since the sequence started.",
  run: () => {
    if (!magitSequencerInProgressP()) quit("No cherry-pick or revert in progress");
    if (magitRevertInProgressP()) {
      magitConfirm("abort-revert", "Really abort revert");
      sequencer(["revert", "--abort"]);
    } else {
      magitConfirm("abort-cherry-pick", "Really abort cherry-pick");
      sequencer(["cherry-pick", "--abort"]);
    }
  },
});

// Cherry-pick.

const cherryArgs = (): string[] => transientArgs("magit-cherry-pick");

/** Cherry-picks or reverts COMMITS, a range too, asking for a mainline for merges, as magit--cherry-pick. */
function cherryPick(commitsIn: string | string[], args: string[], revert = false, then?: (exit: number) => void, env?: { [k: string]: string }): string {
  const command = revert ? "revert" : "cherry-pick";
  const commits = typeof commitsIn === "string" ? (commitsIn.includes("..") ? commitsIn.split("..") : [commitsIn]) : commitsIn;
  const merges = commits.filter((c) => magitMergeCommitP(c));
  let a = args;
  if (merges.length === 0) a = args.filter((x) => !x.startsWith("--mainline="));
  else if (merges.length < commits.length) quit(`Cannot ${command} merge and non-merge commits at once`);
  else if (!args.some((x) => x.startsWith("--mainline="))) a = [`--mainline=${readNumber("Replay merges relative to parent: ")}`, ...args];
  return sequencer([command, ...a, ...commits], then, env);
}

/** The commits to move and the current branch, checking they are or are not reachable from it, as magit--cherry-move-read-args. */
function cherryMoveRead(verb: string, away: boolean, allowDetached = false): [string[], string] {
  const region = regionCommits();
  const commits = region.length > 0 ? region : [(away ? magitReadBranchOrCommit : magitReadOtherBranchOrCommit)(`${e8.capitalize(verb)} cherry`)];
  const current = magitGetCurrentBranch() ?? (allowDetached ? magitRevParse("HEAD") : undefined);
  if (!current) quit(`Cannot ${verb} cherries while HEAD is detached`);
  const reachable = magitRevAncestorP(commits[0], current!);
  if (!away && reachable) quit(`Cannot ${verb} cherries that are reachable from HEAD`);
  if (away && !reachable) quit(`Cannot ${verb} cherries that are not reachable from HEAD`);
  return [commits, current!];
}

/** Reads a new branch's name and starting point for COMMITS, as magit--cherry-spinoff-read-args. */
function spinoffRead(verb: string): [string[], string, string] {
  const [commits] = cherryMoveRead(verb, true);
  const prompt = `Create branch from ${commits.length} cherries`;
  const start = magitReadStartingPoint(prompt, undefined, magitGetUpstreamBranch());
  const branch = magitReadStringNs("Branch name");
  return [commits, branch, start];
}

/** Moves COMMITS from SRC to DST, making DST from START-POINT if need be, as magit--cherry-move. */
function cherryMove(commits: string[], src: string | undefined, dst: string, args: string[], startPoint?: string, checkoutDst = false): void {
  const current = magitGetCurrentBranch();
  if (!magitBranchP(dst)) {
    if (magitCallGit("branch", dst, startPoint) !== 0) quit(`Could not create ${dst}`);
    const upstream = startPoint && magitGetUpstreamBranch(startPoint) === undefined && magitBranchP(startPoint) ? startPoint : undefined;
    if (upstream && magitListRemoteBranches().includes(upstream)) magitCallGit("branch", "--set-upstream-to", upstream, dst);
  }
  if (dst !== current && magitCallGit("checkout", dst) !== 0) quit(`Could not check out ${dst}`);
  if (!src) {
    cherryPick(commits, args);
    return;
  }
  const tip = commits[commits.length - 1];
  const keep = `${commits[0]}^`;
  cherryPick(commits, args, false, (exit) => {
    if (exit !== 0) return;
    if (magitRevEqual(tip, src)) {
      magitCallGit("update-ref", "-m", `reset: moving to ${keep}`, magitRefFullname(src), keep, tip);
      if (!checkoutDst) magitRunGit("checkout", src);
      else magitRefresh();
    } else {
      magitGit("checkout", src);
      const abbrevs = commits.map((c) => magitRevAbbrev(c) ?? c).join("|");
      sequencer(["rebase", "-i", keep], checkoutDst ? (e) => void (e === 0 && magitRunGit("checkout", dst)) : undefined, {
        GIT_SEQUENCE_EDITOR: `${perl()} -i -ne '/^pick (${abbrevs})/ or print'`,
      });
    }
  });
}

const cherryCommits = (prompt: string): string[] => {
  const region = regionCommits();
  return region.length > 0 ? region : [magitReadOtherBranchOrCommit(prompt)];
};

export const magitCherryCopy = e8.defineCommand({
  name: "magit-cherry-copy",
  doc: "Copy COMMITS from another branch onto the current branch.  Prompt for a commit, defaulting to the commit at point.  If the region selects multiple commits, then pick all of them, without prompting.",
  run: () => void cherryPick(cherryCommits("Cherry-pick"), cherryArgs()),
});
export const magitCherryApply = e8.defineCommand({
  name: "magit-cherry-apply",
  doc: "Apply the changes in COMMITS but do not commit them.",
  run: () => void cherryPick(cherryCommits("Apply changes from commit"), ["--no-commit", ...cherryArgs().filter((a) => a !== "--ff")]),
});
export const magitCherryHarvest = e8.defineCommand({
  name: "magit-cherry-harvest",
  doc: "Move COMMITS from another BRANCH onto the current branch.  Remove the COMMITS from BRANCH and stay on the current branch.",
  run: () => {
    const [commits, current] = cherryMoveRead("harvest", false);
    const branches = magitListContainingBranches(commits[0]);
    const n = commits.length;
    const branch = branches.length <= 1 ? branches[0] : magitCompletingRead(n === 1 ? "Remove 1 cherry from branch" : `Remove ${n} cherries from branch`, branches, { requireMatch: true });
    cherryMove(commits, branch, current, cherryArgs(), undefined, true);
  },
});
export const magitCherryDonate = e8.defineCommand({
  name: "magit-cherry-donate",
  doc: "Move COMMITS from the current branch onto another existing BRANCH.  Remove COMMITS from the current branch and stay on that branch.",
  run: () => {
    const [commits, current] = cherryMoveRead("donate", true, true);
    const n = commits.length;
    const branch = magitReadOtherBranch(n === 1 ? "Move 1 cherry to branch" : `Move ${n} cherries to branch`);
    cherryMove(commits, current, branch, cherryArgs());
  },
});
export const magitCherrySpinout = e8.defineCommand({
  name: "magit-cherry-spinout",
  doc: "Move COMMITS from the current branch onto a new BRANCH.  Remove COMMITS from the current branch and stay on that branch.",
  run: () => {
    const [commits, branch, start] = spinoffRead("spinout");
    cherryMove(commits, magitGetCurrentBranch(), branch, cherryArgs(), start);
  },
});
export const magitCherrySpinoff = e8.defineCommand({
  name: "magit-cherry-spinoff",
  doc: "Move COMMITS from the current branch onto a new BRANCH.  Remove COMMITS from the current branch and checkout BRANCH.",
  run: () => {
    const [commits, branch, start] = spinoffRead("spinoff");
    cherryMove(commits, magitGetCurrentBranch(), branch, cherryArgs(), start, true);
  },
});

/** Magit's --mainline option, as magit-cherry-pick:--mainline. */
const mainline: [string, string, string, { reader: (prompt: string, initial?: string) => string }] = [
  "-m",
  "Replay merge relative to parent",
  "--mainline=",
  { reader: (prompt, initial) => String(readNumber(prompt, initial ? Number(initial) : undefined)) },
];
const strategy: [string, string, string, { choices: string[] }] = ["=s", "Strategy", "--strategy=", { choices: ["resolve", "recursive", "octopus", "ours", "subtree"] }];
/**
 * Options putting a suffix at LEVEL, as :level does. A transient without
 * levels (E8 before 0.5) shows every suffix, so there those above the
 * default level 4 are left out, as Magit shows its menus at first.
 */
const hasLevels = "transientPrefixLevel" in transient;
const lvl = (level: number, options: object = {}) => ({ ...options, level, ...(hasLevels || level <= 4 ? {} : { if: () => false }) });
const gpgSign: [string, string, string, object] = ["-S", "Sign using gpg", "--gpg-sign=", lvl(5)];
const signoff: [string, string, string, object] = ["+s", "Add Signed-off-by lines", "--signoff", lvl(6)];

export const magitCherryPick = transientDefinePrefix("magit-cherry-pick", {
  doc: "Apply or transplant commits.",
  value: ["--ff"],
  groups: [
    { description: "Arguments", ifNot: magitSequencerInProgressP, items: [mainline, strategy, ["-F", "Attempt fast-forward", "--ff"], ["-x", "Reference cherry in commit message", "-x"], ["-e", "Edit commit messages", "--edit"], gpgSign, signoff] },
    {
      ifNot: magitSequencerInProgressP,
      class: "columns",
      items: [
        { description: "Apply here", items: [["A", "Pick", magitCherryCopy], ["a", "Apply", magitCherryApply], ["h", "Harvest", magitCherryHarvest], ["m", "Squash", "magit-merge-squash"]] },
        { description: "Apply elsewhere", items: [["d", "Donate", magitCherryDonate], ["n", "Spinout", magitCherrySpinout], ["s", "Spinoff", magitCherrySpinoff]] },
      ],
    },
    { description: "Actions", if: magitSequencerInProgressP, items: [["A", "Continue", magitSequencerContinue], ["s", "Skip", magitSequencerSkip], ["a", "Abort", magitSequencerAbort]] },
  ],
});

// Revert.

const revertCommits = (prompt: string): string[] => {
  const region = (magitRegionValues("commit", true) as string[] | undefined) ?? [];
  return region.length > 0 ? region : [magitReadBranchOrCommit(prompt)];
};
export const magitRevertAndCommit = e8.defineCommand({
  name: "magit-revert-and-commit",
  doc: "Revert COMMIT by creating a new commit.  Prompt for a commit, defaulting to the commit at point.  If the region selects multiple commits, then revert all of them, without prompting.",
  run: () => void cherryPick(revertCommits("Revert commit"), transientArgs("magit-revert"), true),
});
export const magitRevertNoCommit = e8.defineCommand({
  name: "magit-revert-no-commit",
  doc: "Revert COMMIT by applying it in reverse to the worktree.  Prompt for a commit, defaulting to the commit at point.",
  run: () => void cherryPick(revertCommits("Revert changes"), ["--no-commit", ...transientArgs("magit-revert")], true),
});
export const magitRevert = transientDefinePrefix("magit-revert", {
  doc: "Revert existing commits, with or without creating new commits.",
  value: ["--edit"],
  groups: [
    { description: "Arguments", ifNot: magitSequencerInProgressP, items: [mainline, ["-e", "Edit commit message", "--edit"], ["-E", "Don't edit commit message", "--no-edit"], strategy, gpgSign, signoff] },
    { description: "Actions", ifNot: magitSequencerInProgressP, items: [["V", "Revert commit(s)", magitRevertAndCommit], ["v", "Revert changes", magitRevertNoCommit]] },
    { description: "Actions", if: magitSequencerInProgressP, items: [["V", "Continue", magitSequencerContinue], ["s", "Skip", magitSequencerSkip], ["a", "Abort", magitSequencerAbort]] },
  ],
});

// Patches by email.

const amArgs = (): string[] => transientArgs("magit-am");
/** Applies the patches FILES with ARGS, as magit-am-apply-patches does given them. */
export const magitAmApplyPatchesFiles = (files: string[], args = amArgs()): string => sequencer(["am", ...args, "--", ...files.map((f) => e8.expandFileName(f))]);
export const magitAmApplyPatches = e8.defineCommand({
  name: "magit-am-apply-patches",
  doc: "Apply the patches FILES.",
  run: () => {
    const region = (magitRegionValues("file", true) as string[] | undefined) ?? [];
    const def = magitFileAtPoint();
    const files = region.length > 0 ? region : [e8.readFileName(def ? `Apply patch (${def}): ` : "Apply patch: ", { default: def })];
    magitAmApplyPatchesFiles(files);
  },
});
export const magitAmApplyMaildir = e8.defineCommand({
  name: "magit-am-apply-maildir",
  doc: "Apply the patches from MAILDIR.",
  run: () => void sequencer(["am", ...amArgs(), e8.expandFileName(e8.readFileName("Apply mbox or Maildir: "))]),
});
export const magitAmContinue = e8.defineCommand({
  name: "magit-am-continue",
  doc: "Resume the current patch applying sequence.",
  run: () => {
    if (!magitAmInProgressP()) quit("Not applying any patches");
    if (magitAnythingUnstagedP()) quit("Cannot continue due to unstaged changes");
    sequencer(["am", "--continue"]);
  },
});
export const magitAmSkip = e8.defineCommand({
  name: "magit-am-skip",
  doc: "Skip the stopped at patch during a patch applying sequence.",
  run: () => {
    if (!magitAmInProgressP()) quit("Not applying any patches");
    sequencer(["am", "--skip"]);
  },
});
export const magitAmAbort = e8.defineCommand({
  name: "magit-am-abort",
  doc: "Abort the current patch applying sequence.  This discards all changes made since the sequence started.",
  run: () => {
    if (!magitAmInProgressP()) quit("Not applying any patches");
    magitRunGit("am", "--abort");
  },
});
export const magitAm = transientDefinePrefix("magit-am", {
  doc: "Apply patches received by email.",
  value: ["--3way"],
  groups: [
    {
      description: "Arguments",
      ifNot: magitAmInProgressP,
      items: [
        ["-3", "Fall back on 3way merge", "--3way"],
        ["-p", "Remove leading slashes from paths", "-p", { reader: (prompt: string, initial?: string) => String(readNumber(prompt, initial ? Number(initial) : undefined)) }],
        ["-c", "Remove text before scissors line", "--scissors"],
        ["-k", "Inhibit removal of email cruft", "--keep"],
        ["-b", "Limit removal of email cruft", "--keep-non-patch"],
        ["-d", "Use author date as committer date", "--committer-date-is-author-date"],
        ["-t", "Use current time as author date", "--ignore-date"],
        gpgSign,
        signoff,
      ],
    },
    { description: "Apply", ifNot: magitAmInProgressP, items: [["m", "maildir", magitAmApplyMaildir], ["w", "patches", magitAmApplyPatches], ["a", "plain patch", "magit-patch-apply"]] },
    { description: "Actions", if: magitAmInProgressP, items: [["w", "Continue", magitAmContinue], ["s", "Skip", magitAmSkip], ["a", "Abort", magitAmAbort]] },
  ],
});

// Rebase.

const rebaseArgs = (): string[] => transientArgs("magit-rebase");
/** Rebases onto TARGET, as magit-git-rebase. */
const gitRebase = (target: string, args: string[]): string => sequencer(["rebase", ...args, target]);
/** rbr when a recursive rebase is going on, as magit--rebase-resume-command. */
const resumeCommand = (): string => (e8.fileExistsP(e8.expandFileName("rebase-recursive", magitGitdir())) ? "rbr" : "rebase");

/** Branches Magit treats as published that contain COMMIT, as magit-list-publishing-branches. */
const publishingBranches = (commit: string): string[] =>
  ((e8.variable("magit-published-branches") as string[] | null) ?? []).filter((b) => magitRevVerify(b) && magitRevAncestorP(commit, b));
/** Repositories in which editing a published commit was confirmed, as magit--rebase-public-edit-confirmed. */
const publicEditConfirmed = new Set<string>();

/** SINCE without the ^ the rebase adds, as magit-rebase--target-commit. */
const targetCommit = (since: string): string => (since.endsWith("^") ? since.slice(0, -1) : since);

/** Asks before rewriting published commits or a range with merges, giving SINCE or undefined to select another, as magit-rebase-interactive-assert. */
function interactiveAssert(since: string, delayEditConfirm = false, rebaseMerges = false): string | undefined {
  const commit = targetCommit(since);
  const branches = publishingBranches(commit);
  const top = magitToplevel() ?? "";
  publicEditConfirmed.delete(top);
  if (branches.length > 0 && (!delayEditConfirm || !branches.every((b) => magitRevEqual(b, commit)))) {
    const m1 = "Some of these commits have already been published to ";
    const m2 = ".\nDo you really want to modify them";
    magitConfirm(rebasePublishedSymbol, `${m1}%s${m2}`, `${m1}%d public branches${m2}`, branches);
    publicEditConfirmed.add(top);
  }
  if (magitGitLines("rev-list", "--merges", `${since}..HEAD`).length > 0 && !rebaseMerges) {
    const c = e8.readCharChoice("Proceed despite merge in rebase range?  [c]ontinue, [s]elect other, [a]bort ", "csa");
    if (c === "a") quit("Quit");
    return c === "c" ? since : undefined;
  }
  return since;
}

/** The action magitConfirm asks about before rewriting published commits, as magit--rebase-published-symbol. */
let rebasePublishedSymbol = "rebase-published";

/** Starts an interactive rebase from COMMIT, or from one selected in a log, as magit-rebase-interactive-1; THEN runs when git ends. */
function rebaseInteractive1(commitIn: string | undefined, argsIn: string[], message: string, editor?: string | ((since: string) => string), delayEditConfirm = false, noassert = false, confirm = false, includeSelected = true, then?: (exit: number) => void): void {
  let commit = commitIn;
  let args = argsIn;
  if (commit) {
    if (!magitRevAncestorP(commit, "HEAD")) quit(`${commit} isn't an ancestor of HEAD`);
    if (magitCommitParents(commit).length > 0) {
      if (includeSelected) commit = `${commit}^`;
    } else args = ["--root", ...args];
  }
  if (commit && !noassert) commit = interactiveAssert(commit, delayEditConfirm, args.some((a) => a.startsWith("--rebase-merges")));
  if (commit && !confirm) {
    const env = editor ? { GIT_SEQUENCE_EDITOR: typeof editor === "function" ? editor(commit) : editor } : undefined;
    sequencer(["rebase", "-i", ...args, args.includes("--root") ? undefined : commit], then, env);
    return;
  }
  const global = e8.variable("magit-git-global-arguments") ?? null;
  magitLogSelect(
    (rev) => e8.letBind({ "magit-git-global-arguments": global }, () => rebaseInteractive1(rev, argsIn, message, editor, delayEditConfirm, noassert)),
    message.replace("%p", "."),
  );
}

/** A sequence editor turning the selected commit's pick into ACTION, as magit-rebase--perl-editor. */
const perlEditor = (action: "edit" | "remove" | "reword") => (since: string): string => {
  const commit = magitRevAbbrev(targetCommit(since)) ?? targetCommit(since);
  const replacement = { edit: "edit", remove: "noop\\n# pick", reword: "reword" }[action];
  return `${perl()} -i -p -e '++$x if not $x and s/^pick ${commit}/${replacement} ${commit}/'`;
};

export const magitRebaseOntoPushremote = e8.defineCommand({
  name: "magit-rebase-onto-pushremote",
  doc: "Rebase the current branch onto its push-remote branch.  With a prefix argument or when the push-remote is either not configured or unusable, then let the user first configure the push-remote.",
  run: () => {
    const branch = magitGetCurrentBranch() ?? quit("No branch is checked out");
    let remote = magitGetPushRemote(branch);
    if (!remote || prefixArgP() || !magitListRemotes().includes(remote)) {
      remote = magitCompletingRead(`Set push-remote of ${branch} and rebase onto that`, magitListRemotes(), { requireMatch: true }) ?? quit("No remote");
      magitCallGit("config", `branch.${branch}.pushRemote`, remote);
    }
    gitRebase(`${remote}/${branch}`, rebaseArgs());
  },
});
export const magitRebaseOntoUpstream = e8.defineCommand({
  name: "magit-rebase-onto-upstream",
  doc: "Rebase the current branch onto its upstream branch.  With a prefix argument or when the upstream is either not configured or unusable, then let the user first configure the upstream.",
  run: () => {
    const branch = magitGetCurrentBranch() ?? quit("No branch is checked out");
    let upstream = magitGetUpstreamBranch(branch);
    if (prefixArgP() || !upstream) {
      upstream = magitReadUpstreamBranch(branch, `Set upstream of ${branch} and rebase onto that`);
      magitCallGit("branch", `--set-upstream-to=${upstream}`, branch);
    }
    gitRebase(upstream, rebaseArgs());
  },
});
export const magitRebaseBranch = e8.defineCommand({
  name: "magit-rebase-branch",
  doc: "Rebase the current branch onto a branch read in the minibuffer.  All commits that are reachable from HEAD but not from the selected branch TARGET are being rebased.",
  run: () => {
    const target = magitReadOtherBranchOrCommit("Rebase onto");
    e8.message("Rebasing...");
    gitRebase(target, rebaseArgs());
    e8.message("Rebasing...done");
  },
});
/** Rebases from START onto NEWBASE, selecting START in a log if not given, as magit-rebase-subset. */
function rebaseSubset(newbase: string, start: string | undefined, args: string[]): void {
  if (start) {
    e8.message("Rebasing...");
    sequencer(["rebase", "--onto", newbase, start, ...args]);
    e8.message("Rebasing...done");
  } else magitLogSelect((commit) => rebaseSubset(newbase, `${commit}^`, args), `Type . on a commit to rebase it and commits above it onto ${newbase},`);
}
export const magitRebaseSubset = e8.defineCommand({
  name: "magit-rebase-subset",
  doc: "Rebase a subset of the current branch's history onto a new base.  Rebase commits from START to HEAD onto NEWBASE.  START has to be selected from a list of recent commits.",
  run: () => rebaseSubset(magitReadOtherBranchOrCommit("Rebase subset onto", undefined, magitGetUpstreamBranch()), undefined, rebaseArgs()),
});
export const magitRebaseInteractive = e8.defineCommand({
  name: "magit-rebase-interactive",
  doc: "Start an interactive rebase sequence.",
  run: () => rebaseInteractive1(magitCommitAtPoint(), rebaseArgs(), "Type %p on a commit to rebase it and all commits above it,", undefined, true, false, false, truthy(e8.variable("magit-rebase-interactive-include-selected"))),
});
export const magitRebaseAutosquash = e8.defineCommand({
  name: "magit-rebase-autosquash",
  doc: "Combine squash and fixup commits with their intended targets.  By default only squash into commits that are not reachable from the upstream branch.  If no upstream is configured or with a prefix argument, prompt for the first commit to potentially squash into.",
  run: () => {
    const upstream = prefixArgP() ? undefined : magitGetUpstreamBranch();
    const base = upstream ? magitGitString("merge-base", upstream, "HEAD") : undefined;
    rebaseInteractive1(base, ["--autosquash", "--keep-empty", ...rebaseArgs()], "Type %p on a commit to squash into it and then rebase as necessary,", "true", false, true);
  },
});
export const magitRebaseEditCommit = e8.defineCommand({
  name: "magit-rebase-edit-commit",
  doc: "Edit a single older commit using rebase.",
  run: () => rebaseInteractive1(magitCommitAtPoint(), rebaseArgs(), "Type %p on a commit to edit it,", perlEditor("edit"), true),
});
/**
 * Edits COMMIT with a rebase, with ARGS, then calling THEN when git ends,
 * as magit-rebase-edit-commit called with a commit; PUBLISHED-SYMBOL is
 * what magitConfirm asks about if COMMIT is published, as
 * magit--rebase-published-symbol bound around it.
 */
export function magitRebaseEditCommitRev(commit: string, args: string[] = rebaseArgs(), then?: (exit: number) => void, publishedSymbol = "rebase-published"): void {
  const outer = rebasePublishedSymbol;
  rebasePublishedSymbol = publishedSymbol;
  try {
    rebaseInteractive1(commit, args, "Type %p on a commit to edit it,", perlEditor("edit"), true, false, false, true, then);
  } finally {
    rebasePublishedSymbol = outer;
  }
}
export const magitRebaseRewordCommit = e8.defineCommand({
  name: "magit-rebase-reword-commit",
  doc: "Reword a single older commit using rebase.",
  run: () => rebaseInteractive1(magitCommitAtPoint(), rebaseArgs(), "Type %p on a commit to reword its message,", perlEditor("reword")),
});
export const magitRebaseRemoveCommit = e8.defineCommand({
  name: "magit-rebase-remove-commit",
  doc: "Remove a single older commit using rebase.",
  run: () => {
    // The perl editor assumes that the comment character is "#".
    const global = (e8.variable("magit-git-global-arguments") as string[] | null) ?? [];
    e8.letBind({ "magit-git-global-arguments": ["-c", "core.commentChar=#", ...global] }, () =>
      rebaseInteractive1(magitCommitAtPoint(), rebaseArgs(), "Type %p on a commit to remove it,", perlEditor("remove"), false, false, true),
    );
  },
});
export const magitRebaseContinue = e8.defineCommand({
  name: "magit-rebase-continue",
  doc: "Restart the current rebasing operation.  In some cases this pops up a commit message buffer for you do edit.  With a prefix argument the old message is reused as-is.",
  run: () => {
    if (!magitRebaseInProgressP()) quit("No rebase in progress");
    if (magitAnythingUnstagedP()) quit("Cannot continue rebase with unstaged changes");
    const dir = magitGitdir() ?? "";
    if (magitAnythingStagedP() && e8.fileExistsP(e8.expandFileName("rebase-merge", dir)) && !publicEditConfirmed.has(magitToplevel() ?? "")) {
      const orig = magitFileLine(e8.expandFileName("rebase-merge/orig-head", dir));
      if (orig && e8.fboundp("magit-commit-amend-assert")) e8.funcall("magit-commit-amend-assert", orig);
    }
    if (prefixArgP()) sequencer([resumeCommand(), "--continue"], undefined, { GIT_EDITOR: "true" });
    else sequencer([resumeCommand(), "--continue"]);
  },
});
export const magitRebaseSkip = e8.defineCommand({
  name: "magit-rebase-skip",
  doc: "Skip the current commit and restart the current rebase operation.",
  run: () => {
    if (!magitRebaseInProgressP()) quit("No rebase in progress");
    sequencer([resumeCommand(), "--skip"]);
  },
});
export const magitRebaseEdit = e8.defineCommand({
  name: "magit-rebase-edit",
  doc: "Edit the todo list of the current rebase operation.",
  run: () => {
    if (!magitRebaseInProgressP()) quit("No rebase in progress");
    sequencer(["rebase", "--edit-todo"]);
  },
});
export const magitRebaseAbort = e8.defineCommand({
  name: "magit-rebase-abort",
  doc: "Abort the current rebase operation, restoring the original branch.",
  run: () => {
    if (!magitRebaseInProgressP()) quit("No rebase in progress");
    magitConfirm("abort-rebase", "Abort this rebase");
    magitRunGit(resumeCommand(), "--abort");
  },
});

const bold = (s: string): e8.PropertizedString => e8.propertize(s, { face: "bold" });
/** The push-remote suffix's description, as magit-pull--pushbranch-description. */
function pushbranchDescription(): string | e8.PropertizedString {
  const branch = magitGetCurrentBranch()!;
  const target = magitGetPushBranch(branch, true);
  if (target) return e8.propertize(target, { face: "magit-branch-remote" });
  const remote = magitGetPushRemote(branch);
  const v = bold("pushRemote");
  if (remote && !magitListRemotes().includes(remote)) return e8.concat(v, ", replacing non-existent");
  if (remote) return e8.concat(v, ", replacing invalid");
  return e8.concat(v, ", setting that");
}
/** The upstream suffix's description, as magit-rebase--upstream-description. */
function upstreamDescription(): string | e8.PropertizedString | undefined {
  const branch = magitGetCurrentBranch();
  if (!branch) return undefined;
  const upstream = magitGetUpstreamBranch(branch);
  if (upstream) return e8.propertize(upstream, { face: magitUpstreamFace(branch) });
  const remote = magitGet("branch", branch, "remote");
  const merge = magitGet("branch", branch, "merge");
  const u = bold("@{upstream}");
  if (remote || merge) return e8.concat(u, ", replacing non-existent");
  return e8.concat(u, ", setting that");
}

export const magitRebase = transientDefinePrefix("magit-rebase", {
  doc: "Transplant commits and/or modify existing commits.",
  value: ["--autostash"],
  groups: [
    {
      description: "Arguments",
      ifNot: magitRebaseInProgressP,
      items: [
        ["-k", "Keep empty commits", "--keep-empty"],
        ["-r", "Rebase merges", "--rebase-merges=", { choices: ["no-rebase-cousins", "rebase-cousins"] }],
        ["-u", "Update branches", "--update-refs"],
        ["-s", "Strategy", "--strategy=", lvl(7, { choices: ["resolve", "recursive", "octopus", "ours", "subtree"] })],
        ["-X", "Strategy Option", "--strategy-option=", lvl(7, { choices: ["ours", "theirs", "patience"] })],
        ["=X", "Diff algorithm", "-Xdiff-algorithm=", lvl(7, { choices: ["default", "minimal", "patience", "histogram"] })],
        ["-f", "Force rebase", "--force-rebase", lvl(7)],
        ["-d", "Use author date as committer date", "--committer-date-is-author-date"],
        ["-t", "Use current time as author date", "--ignore-date"],
        ["-a", "Autosquash", "--autosquash"],
        ["-A", "Autostash", "--autostash"],
        ["-i", "Interactive", "--interactive"],
        ["-h", "Disable hooks", "--no-verify"],
        ["-x", "Run command after commits", "--exec=", lvl(7, { reader: (prompt: string, initial?: string) => e8.readString(prompt, { initial }) })],
        gpgSign,
        signoff,
      ],
    },
    {
      ifNot: magitRebaseInProgressP,
      description: () => e8.concat(e8.propertize("Rebase ", { face: "transient-heading" }), e8.propertize(magitGetCurrentBranch() ?? "HEAD", { face: "magit-branch-local" }), e8.propertize(" onto", { face: "transient-heading" })),
      items: [
        ["p", pushbranchDescription, magitRebaseOntoPushremote, { if: magitGetCurrentBranch }],
        ["u", () => upstreamDescription() ?? "", magitRebaseOntoUpstream, { if: magitGetCurrentBranch }],
        ["e", "elsewhere", magitRebaseBranch],
      ],
    },
    {
      description: "Rebase",
      ifNot: magitRebaseInProgressP,
      class: "columns",
      items: [
        { items: [["i", "interactively", magitRebaseInteractive], ["s", "a subset", magitRebaseSubset]] },
        { items: [["m", "to modify a commit", magitRebaseEditCommit], ["w", "to reword a commit", magitRebaseRewordCommit], ["k", "to remove a commit", magitRebaseRemoveCommit]] },
        { items: [["f", "to autosquash", magitRebaseAutosquash], ["t", "to change dates", "magit-reshelve-since", lvl(6)]] },
      ],
    },
    { description: "Actions", if: magitRebaseInProgressP, items: [["r", "Continue", magitRebaseContinue], ["s", "Skip", magitRebaseSkip], ["e", "Edit", magitRebaseEdit], ["a", "Abort", magitRebaseAbort]] },
  ],
});
