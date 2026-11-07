// SPDX-License-Identifier: GPL-3.0-or-later
//
// Magit, after Magit 4.4.0 (https://github.com/magit/magit): magit.el and
// the files of its lisp/ directory it draws on, among them magit-status.el,
// magit-diff.el, magit-apply.el, magit-log.el, magit-commit.el,
// git-commit.el, magit-branch.el, magit-push.el, magit-pull.el,
// magit-fetch.el, magit-merge.el, magit-reset.el, magit-stash.el,
// magit-sequence.el, git-rebase.el and magit-process.el. Git in a status
// buffer of sections. C-x g shows the repository: the branch and its
// upstream, untracked files, unstaged and staged changes as diffs, stashes
// and the commits not pushed. s stages and u unstages the file or hunk at
// point, k discards it, c commits, P pushes, F pulls, f fetches, b
// branches, l shows the log, z stashes, m merges, d shows diffs, g
// refreshes, $ shows the git commands run, q quits. The prefix keys open
// transient menus, as Magit's do.
//
// Commit messages are written in a COMMIT_EDITMSG buffer, C-c C-c to
// commit and C-c C-k to give up, as git-commit.el's are, and rebase todo
// lists in git-rebase-mode: git runs E8 as its editor through with-editor,
// as Magit has it run Emacs.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, insertHeading, insertRoot, insertSection, magitSectionMode, sectionAt, sections, show, type Section } from "magit-section";
import { transientArgs, transientDefinePrefix, type Group } from "transient";
import { forwardLine, PerBuffer, truthy } from "subr";
import { magitCompletingRead, prefixArgP } from "magit-base";
import {
  magitFormatRefLabels,
  magitGetCurrentBranch,
  magitGetPushRemote,
  magitGetUpstreamBranch,
  magitGitExecutable,
  magitGitLines,
  magitGitRun,
  magitGitString,
  magitListLocalBranchNames,
  magitListRemoteBranchNames,
  magitListRemotes,
  magitNoCommitP,
  magitProcessGitArguments,
  magitRebaseInProgressP,
  magitReadBranchOrCommit,
  magitReadStash,
  magitToplevel,
  magitToplevelOrError,
  magitUntrackedFiles,
  magitWithRefreshCache,
} from "magit-git";
import {
  magitDiffMode,
  magitLogMode,
  magitMode,
  magitRefreshAll,
  magitRefreshAllCommand,
  magitRefreshBuffer,
  magitRefreshCommand,
  magitRepoName,
  magitRevisionMode,
  magitSetupBuffer,
  magitStatusMode,
} from "magit-mode";
import {
  magitDiffArguments,
  magitDiffDwim,
  magitDiffSetupBuffer,
  magitInsertStagedChanges,
  magitInsertUnstagedChanges,
  magitShowCommit,
  magitShowCommitRev,
  magitStashShow,
  type FileValue,
} from "magit-diff";
import { magitInitCommand, magitStatus } from "magit-status";
import "magit-log";
import "git-rebase";
import { magitAm, magitCherryApply, magitCherryPick, magitRebase, magitRevert, magitRevertNoCommit } from "magit-sequence";
import { magitTag } from "magit-tag";
import { magitBisect } from "magit-bisect";
import { magitShowRefs } from "magit-refs";
import { magitFileCheckout, magitFileRename, magitFileUntrack } from "magit-files";
import { magitGitignore } from "magit-gitignore";
import { magitNotes } from "magit-notes";
import { magitSubtree } from "magit-subtree";
import { magitSubmodule } from "magit-submodule";
import { magitPatch } from "magit-patch";
import { magitWorktree } from "magit-worktree";
import { magitRemote } from "magit-remote";
import { magitClone } from "magit-clone";
import { magitGitMergetool, magitPopRevisionStackCommand, magitRunGitGui, magitRunGitk, magitRunGitkAll, magitRunGitkBranches } from "magit-extras";
import "magit-dired";
import "magit-autorevert";
import { magitAnyWipModeEnabledP, magitWipCommitAfterApply, magitWipCommitBeforeChange, magitWipCommitCommand } from "magit-wip";
import { magitProcessBuffer, magitProcessBufferCommand, magitRunGit, magitRunGitWithInput, magitStartGitWith, magitStartProcess } from "magit-process";

// Faces.

const faces: [string, string, e8.FaceAttributes, e8.FaceAttributes?, e8.FaceAttributes?][] = [
  ["magit-branch-local", "Face for local branches.", {}, { foreground: "SkyBlue4" }, { foreground: "LightSkyBlue1" }],
  ["magit-branch-remote", "Face for remote branch head labels.", {}, { foreground: "DarkOliveGreen4" }, { foreground: "DarkSeaGreen2" }],
  ["magit-branch-current", "Face for the current branch.", { inherit: "magit-branch-local", box: true } as e8.FaceAttributes],
  ["magit-hash", "Face for the commit object name in the log output.", {}, { foreground: "grey60" }, { foreground: "grey40" }],
  ["magit-tag", "Face for tag labels shown in log buffer.", {}, { foreground: "Goldenrod4" }, { foreground: "LightGoldenrod2" }],
  ["magit-head", "Face for the symbolic ref HEAD.", { inherit: "magit-branch-local" }],
  ["magit-filename", "Face for filenames.", { weight: "normal" }],
  ["magit-dimmed", "Face for text that shouldn't stand out.", {}, { foreground: "grey50" }, { foreground: "grey50" }],
  ["magit-log-author", "Face for the author part of the log output.", {}, { foreground: "firebrick" }, { foreground: "tomato" }],
  ["magit-log-date", "Face for the date part of the log output.", {}, { foreground: "grey30" }, { foreground: "grey80" }],
  ["magit-process-ok", "Face for zero exit-status.", { inherit: "magit-section-heading", foreground: "green" } as e8.FaceAttributes],
  ["magit-process-ng", "Face for non-zero exit-status.", { inherit: "magit-section-heading", foreground: "red" } as e8.FaceAttributes],
];
for (const [name, doc, attributes, light, dark] of faces) e8.defineFace({ name, doc, attributes, light, dark });

e8.defineVariable({ name: "magit-log-section-commit-count", doc: "How many recent commits the status buffer shows.", value: 10 });
e8.defineVariable({ name: "magit-save-repository-buffers", doc: "Whether to save the repository's modified file buffers before running git, as Magit asks.", value: true });

// Running git.

/** The repository's top directory, as magit-toplevel. */
export const toplevel = (dir?: string): string | undefined => magitToplevel(dir);

/** The repository the current buffer belongs to, or an error. */
const repo = (): string => magitToplevelOrError();

/** Runs git with ARGS in the repository: its exit code and output. */
export function gitOutput(args: string[], input?: string, dir = repo()): { exit: number; output: string } {
  return magitGitRun(args, { input, dir });
}

const gitString = (args: string[]): string | undefined => magitGitString(...args);
const gitLines = (args: string[]): string[] => magitGitLines(...args);

/** Runs git for its effect and refreshes, as magit-run-git; whether it succeeded. */
export function runGit(args: string[], input?: string): boolean {
  return (input !== undefined ? magitRunGitWithInput(input, args) : magitRunGit(args)) === 0;
}

/** Runs git in the background, refreshing when it ends, as magit-run-git-async; with EDITOR, as magit-run-git-with-editor. */
export function runGitAsync(args: string[], _what: string, editor = false, env: { [name: string]: string } = {}): void {
  magitStartGitWith(args, { editor, env });
}

// The status buffer is magit-status.ts's.

const currentBranch = magitGetCurrentBranch;
const upstreamOf = (branch?: string): string | undefined => (branch ? magitGetUpstreamBranch(branch) : undefined);
const hasCommits = (): boolean => !magitNoCommitP();
const refreshCommand = magitRefreshCommand;
const refreshAllCommand = magitRefreshAllCommand;
const refreshAll = magitRefreshAll;
const setupBuffer = magitSetupBuffer;
const repoName = magitRepoName;

const face = (text: string, f: string): e8.PropertizedString => e8.propertize(text, { face: f });

// Applying: staging, unstaging and discarding.

/** The file or hunk at point, or the files of the section at point, as magit-apply's targets. */
function targets(): { section: Section; values: FileValue[] } | undefined {
  const s = currentSection();
  if (!s) return undefined;
  // An untracked file's section has its name as its value, as Magit's has.
  const asValue = (x: Section): FileValue => (typeof x.value === "string" ? { file: x.value, kind: "untracked" } : (x.value as FileValue));
  if (s.type === "file" || s.type === "hunk") return { section: s, values: [asValue(s)] };
  // The untracked list's files are inserted only when it is shown: ask git for them.
  if (s.type === "untracked") return { section: s, values: magitUntrackedFiles().map((file) => ({ file, kind: "untracked" as const })) };
  if (s.type === "unstaged" || s.type === "staged") return { section: s, values: s.children.map(asValue) };
  return { section: s, values: [] };
}

/** The files VALUES are of, for the wip commits made before and after applying, as magit-apply's. */
const applyFiles = (values: FileValue[]): string[] => [...new Set(values.map((v) => v.file))];

/** The patch for a hunk, with its file's header, for git apply. */
function hunkPatch(v: FileValue): string {
  const header = v.diff!.header.filter((l) => /^(diff --git|--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|index )/.test(l));
  return [...header, v.hunk!.heading, ...v.hunk!.lines, ""].join("\n");
}

/**
 * The patch for the lines of a hunk the region covers, as
 * magit-diff-hunk-region-patch makes it: the other lines changed are left
 * as they are, a removal kept as context and an addition dropped, the other
 * way round for a patch applied in REVERSE, and the counts made again.
 */
function regionPatch(v: FileValue, from: number, to: number, reverse: boolean): string {
  const header = v.diff!.header.filter((l) => /^(diff --git|--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|index )/.test(l));
  const [drop, keep] = reverse ? ["-", "+"] : ["+", "-"];
  const lines: string[] = [];
  v.hunk!.lines.forEach((l, i) => {
    const inside = i >= from && i <= to;
    if (inside || l.startsWith(" ") || l.startsWith("\\")) lines.push(l);
    else if (l.startsWith(keep)) lines.push(` ${l.slice(1)}`);
    else if (l.startsWith(drop)) return;
    else lines.push(l);
  });
  const old = lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
  const now = lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(v.hunk!.heading);
  const start = m ? Number(m[1]) : 1;
  return [...header, `@@ -${start},${old} +${reverse ? Number(m?.[2] ?? start) : start},${now} @@${m?.[3] ?? ""}`, ...lines, ""].join("\n");
}

/** The lines of the hunk at point the active region covers, as indices of its lines, or undefined without a region in a hunk. */
function regionLines(s: Section): [number, number] | undefined {
  const mark = e8.mark();
  if (s.type !== "hunk" || !e8.regionActive() || mark === undefined) return undefined;
  const [a, b] = [Math.min(mark, e8.point()), Math.max(mark, e8.point())];
  const first = e8.lineOf(s.content);
  const from = Math.max(0, e8.lineOf(a) - first);
  // A region ending at the start of a line leaves that line out.
  const end = b > a && b === e8.lineBeginningPosition(b) ? b - 1 : b;
  const to = e8.lineOf(end) - first;
  return to >= 0 ? [from, to] : undefined;
}

export const magitStage = e8.defineCommand({
  name: "magit-stage",
  doc: "Add the change at point to the staging area: an untracked or changed file, or a hunk.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) e8.userError("Nothing to stage");
    const lines = regionLines(t.section);
    const files = applyFiles(t.values);
    magitWipCommitBeforeChange(files, " before stage");
    for (const v of t.values) {
      if (v.kind === "staged") e8.userError("Already staged");
      if (v.hunk && lines) {
        runGit(["apply", "--cached", "-p0", "--recount", "-"], regionPatch(v, lines[0], lines[1], false));
        e8.deactivateMark();
      } else if (v.hunk) runGit(["apply", "--cached", "-p0", "--ignore-space-change", "-"], hunkPatch(v));
      else runGit(["add", "--", v.file]);
    }
    magitWipCommitAfterApply(files, " after stage");
  },
});

export const magitUnstage = e8.defineCommand({
  name: "magit-unstage",
  doc: "Remove the change at point from the staging area: a staged file or hunk.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) e8.userError("Nothing to unstage");
    const lines = regionLines(t.section);
    const files = applyFiles(t.values);
    magitWipCommitBeforeChange(files, " before unstage");
    for (const v of t.values) {
      if (v.kind !== "staged") e8.userError("Already unstaged");
      if (v.hunk && lines) {
        runGit(["apply", "--cached", "--reverse", "-p0", "--recount", "-"], regionPatch(v, lines[0], lines[1], true));
        e8.deactivateMark();
      } else if (v.hunk) runGit(["apply", "--cached", "--reverse", "-p0", "-"], hunkPatch(v));
      else if (hasCommits()) runGit(["reset", "-q", "--", v.file]);
      else runGit(["rm", "--cached", "-q", "--", v.file]);
    }
    magitWipCommitAfterApply(files, " after unstage");
  },
});

const stageModified = e8.defineCommand({
  name: "magit-stage-modified",
  doc: "Stage all changes to files tracked in the repository; with a prefix argument, untracked files too.",
  params: [{ name: "all", kind: "prefix" }],
  run: (all: e8.Value) => {
    magitWipCommitBeforeChange(undefined, " before stage");
    runGit(["add", truthy(all) ? "--all" : "-u", "."]);
    magitWipCommitAfterApply(undefined, " after stage");
  },
});

const unstageAll = e8.defineCommand({
  name: "magit-unstage-all",
  doc: "Remove all changes from the staging area.",
  run: () => {
    magitWipCommitBeforeChange(undefined, " before unstage");
    runGit(hasCommits() ? ["reset", "-q", "HEAD", "--"] : ["rm", "--cached", "-r", "-q", "."]);
    magitWipCommitAfterApply(undefined, " after unstage");
  },
});

export const magitDiscard = e8.defineCommand({
  name: "magit-discard",
  doc: "Remove the change at point from the working tree, or the index for a staged one: an untracked file is deleted.",
  run: () => {
    const t = targets();
    if (!t || t.values.length === 0) e8.userError("Nothing to discard");
    const what = t.values.length === 1 ? (t.values[0].hunk ? "hunk" : t.values[0].file) : `${t.values.length} files`;
    const kind = t.values[0].kind;
    const verb = kind === "untracked" ? "Delete" : "Discard";
    if (!e8.yOrNP(`${verb} ${what}? `)) e8.userError("Abort");
    const files = applyFiles(t.values);
    magitWipCommitBeforeChange(files, " before discard");
    for (const v of t.values) {
      if (v.kind === "untracked") {
        e8.deleteFile(e8.expandFileName(v.file, repo()));
        refreshAll();
      } else if (v.hunk) {
        runGit(v.kind === "staged" ? ["apply", "--cached", "--reverse", "-p0", "-"] : ["apply", "--reverse", "-p0", "-"], hunkPatch(v));
      } else if (v.kind === "staged") {
        runGit(["reset", "-q", "--", v.file]);
        runGit(["checkout", "--", v.file]);
      } else {
        runGit(["checkout", "--", v.file]);
      }
    }
    magitWipCommitAfterApply(files, " after discard");
  },
});

/** Visits the file at point, at the line of the hunk line point is on, as magit-diff-visit-file. */
export const magitVisitThing = e8.defineCommand({
  name: "magit-visit-thing",
  doc: "Visit the thing at point: a file at the line point is on in its diff, a commit, a stash.",
  run: () => {
    const s = currentSection();
    if (!s) e8.userError("There is no thing at point that could be visited");
    if (s.type === "commit") {
      showCommit(String(s.value));
      return;
    }
    if (s.type === "stash") {
      showCommit(String(s.value));
      return;
    }
    const v = s.value as FileValue | undefined;
    if (!v?.file) e8.userError("There is no thing at point that could be visited");
    let line = 1;
    if (v.hunk) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(v.hunk.heading);
      line = Number(m?.[1] ?? 1);
      const here = e8.lineOf(e8.point());
      const first = e8.lineOf(s.content);
      for (let i = 0; i < here - first && i < v.hunk.lines.length; i++) if (!v.hunk.lines[i].startsWith("-")) line++;
    }
    const dir = repo();
    e8.call("find-file", e8.expandFileName(v.file, dir));
    e8.gotoChar(e8.lineStart(Math.max(0, Math.min(line - 1, e8.lineCount() - 1))));
  },
});

// Committing, after magit-commit.el and git-commit.el.

e8.defineVariable({ name: "git-commit-summary-max-length", doc: "Column beyond which characters in the summary line are highlighted.", value: 68 });
e8.defineFace({ name: "git-commit-summary", doc: "Face used for the summary in commit messages.", attributes: { inherit: "font-lock-type-face" } });
e8.defineFace({ name: "git-commit-comment-heading", doc: "Face used for headings in commit message comments.", attributes: { inherit: "git-commit-keyword" } });
e8.defineFace({ name: "git-commit-keyword", doc: "Face used for keywords in commit messages.", attributes: { inherit: "font-lock-string-face" } });

/** The diff a commit makes, shown beside its message, as magit-commit-diff; the buffer, to take away when done. */
let commitDiff: string | undefined;
/** Whether the commit being written amends the last one, for the diff to show. */
let amending = false;

/** Runs git commit with ARGS, its message written in COMMIT_EDITMSG through with-editor, as magit-commit-create. */
function editCommit(args: string[], amend = false): void {
  amending = amend;
  runGitAsync(["commit", ...args], "Committing", true);
}

/** Shows what the commit makes beside its message, as magit-commit-diff does when COMMIT_EDITMSG is visited. */
function showCommitDiff(): void {
  if (!/\/COMMIT_EDITMSG$/.test(e8.bufferFileName() ?? "")) return;
  const window = e8.selectedWindow();
  const staged = amending ? gitOutput(["diff", "--quiet", "HEAD^", "--cached"]) : gitOutput(["diff", "--cached", "--quiet"]);
  if (staged.exit === 0) return;
  const [args] = magitDiffArguments();
  commitDiff = e8.letBind({ "magit-display-buffer-noselect": true }, () => magitDiffSetupBuffer(amending ? "HEAD^" : undefined, "--cached", args, [], amending ? "committed" : "staged"));
  e8.selectWindow(window);
}

/** Takes the commit's diff away once the message is done with. */
function hideCommitDiff(): void {
  if (!commitDiff || !e8.bufferLiveP(e8.getBuffer(commitDiff))) return;
  const w = e8.windowList().find((x) => e8.windowBuffer(x) === commitDiff);
  if (w !== undefined && e8.windowList().length > 1) e8.deleteWindow(w);
  e8.call("kill-buffer", commitDiff);
  commitDiff = undefined;
}

e8.addHook("with-editor-filter-visit-hook", showCommitDiff);
e8.addHook("with-editor-post-finish-hook", hideCommitDiff);
e8.addHook("with-editor-post-cancel-hook", hideCommitDiff);
e8.setDefault("with-editor-file-modes", [
  ...((e8.variable("with-editor-file-modes") as string[][] | null) ?? []),
  ["/\\(?:COMMIT\\|MERGE\\|TAG\\)_EDITMSG\\'", "git-commit-mode"],
  ["/git-rebase-todo\\'", "git-rebase-mode"],
]);

/** Highlights the summary line and comments, as git-commit-mode's font-lock keywords. */
function fontifyCommit(start: number, end: number): void {
  e8.withSilentModifications(() => {
    for (let line = e8.lineOf(start); line <= e8.lineOf(Math.max(start, end - 1)); line++) {
      const ls = e8.lineStart(line);
      const le = e8.lineEnd(line);
      const text = e8.lineText(line);
      if (text.startsWith("#")) e8.putTextProperty(ls, le, "face", "font-lock-comment-face");
      else if (line === 0) {
        const max = Number(e8.variable("git-commit-summary-max-length") ?? 68);
        e8.putTextProperty(ls, Math.min(le, ls + max), "face", "git-commit-summary");
        if (le > ls + max) e8.putTextProperty(ls + max, le, "face", "font-lock-warning-face");
      }
    }
  });
}

export const gitCommitMode = e8.defineMajorMode({
  name: "git-commit-mode",
  modeName: "Git-Commit",
  parent: "text-mode",
  doc: "Major mode for editing git commit messages: C-c C-c commits, C-c C-k cancels.",
  setup: () => {
    e8.makeLocalVariable("fill-column");
    e8.setVariable("fill-column", 72);
    e8.addHook("jit-lock-functions", fontifyCommit, { local: true });
  },
});

e8.defineKey("git-commit-mode-map", "C-c C-w", magitPopRevisionStackCommand);

const commitArgs = (): string[] => transientArgs("magit-commit");

const commitCreate = e8.defineCommand({
  name: "magit-commit-create",
  doc: "Create a new commit on HEAD, writing its message in a buffer.",
  run: () => {
    const args = commitArgs();
    if (!args.includes("--all") && !args.includes("--allow-empty") && gitOutput(["diff", "--cached", "--quiet"]).exit === 0) {
      if (gitOutput(["diff", "--quiet"]).exit !== 0 && e8.yOrNP("Nothing staged.  Commit all uncommitted changes? ")) args.push("--all");
      else e8.userError("Nothing staged");
    }
    editCommit(args);
  },
});

const commitAmend = e8.defineCommand({
  name: "magit-commit-amend",
  doc: "Amend the last commit, with the staged changes and an edited message.",
  run: () => editCommit(["--amend", ...commitArgs()], true),
});

const commitExtend = e8.defineCommand({
  name: "magit-commit-extend",
  doc: "Amend the last commit with the staged changes, keeping its message.",
  run: () => void runGit(["commit", "--amend", "--no-edit", ...commitArgs()]),
});

const commitReword = e8.defineCommand({
  name: "magit-commit-reword",
  doc: "Reword the last commit, ignoring the staged changes.",
  run: () => editCommit(["--amend", "--only", ...commitArgs()], true),
});


// Branches, after magit-branch.el.

const localBranches = magitListLocalBranchNames;
const remoteBranches = (): string[] => magitListRemoteBranchNames();

/** Reads one of CHOICES, as magit-completing-read with Magit's revision history. */
function readBranch(prompt: string, choices = [...localBranches(), ...remoteBranches()], def?: string): string {
  return magitCompletingRead(prompt, choices, { requireMatch: "any", history: "magit-revision-history", def }) ?? e8.userError("Nothing selected");
}

const branchCheckout = e8.defineCommand({
  name: "magit-checkout",
  doc: "Check out a branch or commit.",
  run: () => {
    const cur = currentBranch();
    const target = readBranch("Checkout", [...localBranches().filter((b) => b !== cur), ...remoteBranches()]);
    const local = remoteBranches().includes(target) && !localBranches().includes(target.replace(/^[^/]+\//, "")) ? ["-b", target.replace(/^[^/]+\//, ""), "--track", target] : [target];
    runGit(["checkout", ...local]);
  },
});

const branchCreateCheckout = e8.defineCommand({
  name: "magit-branch-and-checkout",
  doc: "Create a branch starting at a commit and check it out.",
  run: () => {
    const start = readBranch("Create and checkout branch starting at", [...localBranches(), ...remoteBranches()], currentBranch());
    const name = e8.readString("Name for new branch: ");
    if (name === "") e8.userError("No name given");
    runGit(["checkout", "-b", name, start]);
  },
});

const branchCreate = e8.defineCommand({
  name: "magit-branch-create",
  doc: "Create a branch starting at a commit, without checking it out.",
  run: () => {
    const start = readBranch("Create branch starting at", [...localBranches(), ...remoteBranches()], currentBranch());
    const name = e8.readString("Name for new branch: ");
    if (name === "") e8.userError("No name given");
    runGit(["branch", name, start]);
  },
});

const branchDelete = e8.defineCommand({
  name: "magit-branch-delete",
  doc: "Delete a branch; one not merged is deleted only if confirmed.",
  run: () => {
    const name = readBranch("Delete branch", localBranches().filter((b) => b !== currentBranch()));
    if (!runGit(["branch", "-d", name]) && e8.yOrNP(`Delete unmerged branch ${name}? `)) runGit(["branch", "-D", name]);
  },
});

const branchRename = e8.defineCommand({
  name: "magit-branch-rename",
  doc: "Rename a branch.",
  run: () => {
    const old = readBranch("Rename branch", localBranches(), currentBranch());
    const name = e8.readString(`Rename branch '${old}' to: `);
    if (name === "") e8.userError("No name given");
    runGit(["branch", "-m", old, name]);
  },
});


// Pushing, pulling and fetching, after magit-push.el, magit-pull.el and magit-fetch.el.

const remotes = magitListRemotes;

/** The upstream of the current branch, asking for one to set if there is none, as magit-push-current-to-upstream does. */
function ensureUpstream(verb: string): [string, string, boolean] {
  const branch = currentBranch();
  if (!branch) e8.userError("No branch is checked out");
  const upstream = upstreamOf(branch);
  if (upstream) {
    const [remote, ...rest] = upstream.split("/");
    return [remote, rest.join("/"), false];
  }
  const choice = readBranch(`Set upstream of ${branch} and ${verb} there`, remoteBranches().length > 0 ? remoteBranches() : remotes().map((r) => `${r}/${branch}`), remotes()[0] ? `${remotes()[0]}/${branch}` : undefined);
  const [remote, ...rest] = choice.split("/");
  return [remote, rest.join("/") || branch!, true];
}

const pushArgs = (): string[] => transientArgs("magit-push");

const pushUpstream = e8.defineCommand({
  name: "magit-push-current-to-upstream",
  doc: "Push the current branch to its upstream, setting one first if there is none.",
  run: () => {
    const branch = currentBranch()!;
    const [remote, target, set] = ensureUpstream("push");
    runGitAsync(["push", "-v", ...pushArgs(), ...(set ? ["--set-upstream"] : []), remote, `${branch}:refs/heads/${target}`], `Pushing to ${remote}/${target}`);
  },
});

const pushPushRemote = e8.defineCommand({
  name: "magit-push-current-to-pushremote",
  doc: "Push the current branch to its push remote, by default the upstream's remote.",
  run: () => {
    const branch = currentBranch();
    if (!branch) e8.userError("No branch is checked out");
    const remote = gitString(["config", `branch.${branch}.pushRemote`]) ?? gitString(["config", "remote.pushDefault"]) ?? upstreamOf(branch)?.split("/")[0] ?? remotes()[0];
    if (!remote) e8.userError("No remote to push to");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${branch}`], `Pushing to ${remote}/${branch}`);
  },
});


const pullUpstream = e8.defineCommand({
  name: "magit-pull-from-upstream",
  doc: "Pull from the upstream of the current branch, setting one first if there is none.",
  run: () => {
    const [remote, target, set] = ensureUpstream("pull");
    if (set) gitOutput(["branch", `--set-upstream-to=${remote}/${target}`]);
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, target], `Pulling from ${remote}/${target}`);
  },
});


const fetchAll = e8.defineCommand({ name: "magit-fetch-all", doc: "Fetch from all remotes.", run: () => runGitAsync(["fetch", "--all", ...transientArgs("magit-fetch")], "Fetching all remotes") });
const fetchUpstream = e8.defineCommand({
  name: "magit-fetch-from-upstream",
  doc: "Fetch from the remote of the current branch's upstream.",
  run: () => {
    const remote = upstreamOf(currentBranch())?.split("/")[0] ?? remotes()[0];
    if (!remote) e8.userError("No remote to fetch from");
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});


// Merging, resetting and stashing.

const mergeCommand = e8.defineCommand({
  name: "magit-merge-plain",
  doc: "Merge a branch into the current one.",
  run: () => void runGit(["merge", ...transientArgs("magit-merge"), readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()])]),
});

const resetCommand = (mode: string, doc: string) =>
  e8.defineCommand({
    name: `magit-reset-${mode}`,
    doc,
    run: () => {
      const s = currentSection();
      const def = s?.type === "commit" ? String(s.value) : "HEAD";
      magitWipCommitBeforeChange(undefined, " before reset");
      runGit(["reset", `--${mode}`, readBranch(`${mode[0].toUpperCase()}${mode.slice(1)} reset ${currentBranch() ?? "HEAD"} to`, [...localBranches(), ...remoteBranches()], def)]);
    },
  });

/** The stash at point, or one read. */
function stashAt(prompt: string): string {
  const s = currentSection();
  if (s?.type === "stash") return String(s.value);
  return magitReadStash(prompt);
}

const stashBoth = e8.defineCommand({
  name: "magit-stash-both",
  doc: "Stash the changes in the index and the working tree, with a message.",
  run: () => {
    const msg = e8.readString(`Stash message (default: On ${currentBranch() ?? "HEAD"}: ...): `);
    runGit(["stash", "push", ...transientArgs("magit-stash"), ...(msg ? ["-m", msg] : [])]);
  },
});
const stashApply = e8.defineCommand({ name: "magit-stash-apply", doc: "Apply a stash to the working tree.", run: () => void runGit(["stash", "apply", stashAt("Apply stash")]) });
const stashPop = e8.defineCommand({ name: "magit-stash-pop", doc: "Apply a stash and remove it.", run: () => void runGit(["stash", "pop", stashAt("Pop stash")]) });
const stashDrop = e8.defineCommand({
  name: "magit-stash-drop",
  doc: "Remove a stash.",
  run: () => {
    const s = stashAt("Drop stash");
    if (e8.yOrNP(`Drop ${s}? `)) runGit(["stash", "drop", s]);
  },
});

// The log is magit-log.ts's.

const logCurrent = "magit-log-current";
const logAll = "magit-log-all";
const logOther = "magit-log-other";

/** Shows a commit in the revision buffer, as magit-show-commit. */
export const showCommit = (rev: string): void => magitShowCommitRev(rev);
const diffDwim = magitDiffDwim;
const diffStaged = "magit-diff-staged";
const diffUnstaged = "magit-diff-unstaged";

// The process buffer.

const processBuffer = magitProcessBufferCommand;

// The dispatch menu and the keys.

// The menus, after Magit's transient-define-prefix forms, laid out as
// Magit 4 lays them out, and the commands behind their suffixes.

/** A command that runs git with the arguments ARGS gives, as Magit's many small commands do. */
const gitCommand = (name: string, doc: string, args: () => string[] | undefined) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const a = args();
      if (a) runGit(a);
    },
  });

/** A command E8's Magit does not have yet, which says so. */
const notYet = (name: string, what: string) =>
  e8.defineCommand({ name, doc: `${what}: not in E8's Magit yet.`, run: () => e8.userError(`${what} is not in E8's Magit yet`) });

/** The commit at point, or one read from the log, as magit-read-branch-or-commit. */
function readCommit(prompt: string): string {
  return magitReadBranchOrCommit(prompt);
}

/** A commit fixing up or squashing into a commit read, then rebasing them together if INSTANT, as magit-commit-fixup and its kin. */
function fixupCommand(name: string, doc: string, option: (rev: string) => string, edit: boolean, instant = false) {
  return e8.defineCommand({
    name,
    doc,
    run: () => {
      const rev = readCommit(doc.replace(/\.$/, ""));
      if (edit) {
        editCommit([option(rev), ...commitArgs()]);
        return;
      }
      if (!runGit(["commit", "--no-edit", option(rev), ...commitArgs()])) return;
      // Onto the commit's parent, or from the root for the first commit, as magit-rebase-autosquash does.
      const onto = gitOutput(["rev-parse", "--verify", "-q", `${rev}^`]).exit === 0 ? `${rev}^` : "--root";
      if (instant) runGit(["-c", "sequence.editor=:", "rebase", "-i", "--autosquash", "--autostash", "--keep-empty", onto]);
    },
  });
}

const commitFixup = fixupCommand("magit-commit-fixup", "Create a fixup commit.", (r) => `--fixup=${r}`, false);
const commitSquash = fixupCommand("magit-commit-squash", "Create a squash commit.", (r) => `--squash=${r}`, false);
const commitAlter = fixupCommand("magit-commit-alter", "Create a commit changing a commit and its message.", (r) => `--fixup=amend:${r}`, true);
const commitAugment = fixupCommand("magit-commit-augment", "Create a squash commit, writing its message.", (r) => `--squash=${r}`, true);
const commitRevise = fixupCommand("magit-commit-revise", "Create a commit rewording a commit.", (r) => `--fixup=reword:${r}`, true);
const commitInstantFixup = fixupCommand("magit-commit-instant-fixup", "Create a fixup commit and rebase it into place at once.", (r) => `--fixup=${r}`, false, true);
const commitInstantSquash = fixupCommand("magit-commit-instant-squash", "Create a squash commit and rebase it into place at once.", (r) => `--squash=${r}`, false, true);

const commitMenu = transientDefinePrefix("magit-commit", {
  doc: "Create a new commit or replace an existing commit.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-a", "Stage all modified and deleted files", "--all"],
        ["-e", "Allow empty commit", "--allow-empty"],
        ["-v", "Show diff of changes to be committed", "--verbose"],
        ["-n", "Disable hooks", "--no-verify"],
        ["-R", "Claim authorship and reset author date", "--reset-author"],
        ["-A", "Override the author", "--author=", { prompt: "Author: " }],
        ["-C", "Reuse commit message", "--reuse-message=", { reader: (p) => readCommit(p) }],
      ],
    },
    {
      items: [
        { description: "Create", items: [["c", "Commit", commitCreate]] },
        { description: "Edit HEAD", items: [["e", "Extend", commitExtend], "", ["a", "Amend", commitAmend], "", ["w", "Reword", commitReword]] },
        { description: "Edit", items: [["f", "Fixup", commitFixup], ["s", "Squash", commitSquash], ["A", "Alter", commitAlter], ["n", "Augment", commitAugment], ["W", "Revise", commitRevise]] },
        { description: "Edit and rebase", items: [["F", "Instant fixup", commitInstantFixup], ["S", "Instant squash", commitInstantSquash], "", ""] },
        { description: "Spread across commits", items: [] },
      ],
    },
  ],
});

// Push.

const branchOrHead = (): string => currentBranch() ?? "HEAD";
const pushRemoteOf = (branch?: string): string | undefined => (branch ? magitGetPushRemote(branch) : undefined);

/** Reads a remote, setting it as the branch's push remote, as magit-push-current-to-pushremote with no push remote does. */
function ensurePushRemote(): string {
  const branch = currentBranch();
  if (!branch) e8.userError("No branch is checked out");
  const remote = pushRemoteOf(branch);
  if (remote) return remote;
  const all = remotes();
  if (all.length === 0) e8.userError("No remote to push to");
  const chosen = e8.completingRead(`Set push-remote of ${branch} and push there: `, all, { requireMatch: true, default: all[0] });
  gitOutput(["config", `branch.${branch}.pushRemote`, chosen]);
  return chosen;
}

const pushPushRemoteSetting = e8.defineCommand({
  name: "magit-push-current-to-pushremote",
  doc: "Push the current branch to its push remote, setting one first if there is none.",
  run: () => {
    const branch = currentBranch()!;
    const remote = ensurePushRemote();
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${branch}`], `Pushing to ${remote}/${branch}`);
  },
});

const pushElsewhere = e8.defineCommand({
  name: "magit-push-current",
  doc: "Push the current branch to a branch read.",
  run: () => {
    const branch = currentBranch()!;
    const target = readBranch(`Push ${branch} to`, remoteBranches(), upstreamOf(branch));
    const [remote, ...rest] = target.split("/");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${branch}:refs/heads/${rest.join("/")}`], `Pushing to ${target}`);
  },
});

const pushOther = e8.defineCommand({
  name: "magit-push-other",
  doc: "Push a branch or commit to a remote branch, both read.",
  run: () => {
    const source = readBranch("Push", localBranches(), currentBranch());
    const target = readBranch(`Push ${source} to`, remoteBranches());
    const [remote, ...rest] = target.split("/");
    runGitAsync(["push", "-v", ...pushArgs(), remote, `${source}:refs/heads/${rest.join("/")}`], `Pushing to ${target}`);
  },
});

const pushRefspecs = e8.defineCommand({
  name: "magit-push-refspecs",
  doc: "Push refspecs read to a remote read.",
  run: () => {
    const remote = e8.completingRead("Push to remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    const specs = e8.readString(`Push refspec,s to ${remote}: `);
    runGitAsync(["push", "-v", ...pushArgs(), remote, ...specs.split(/[ ,]+/).filter(Boolean)], `Pushing to ${remote}`);
  },
});

const pushMatching = e8.defineCommand({
  name: "magit-push-matching",
  doc: "Push all branches that have a branch of the same name on a remote.",
  run: () => {
    const remote = e8.completingRead("Push matching branches to: ", remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["push", "-v", ...pushArgs(), remote, ":"], `Pushing to ${remote}`);
  },
});

const pushTag = e8.defineCommand({
  name: "magit-push-tag",
  doc: "Push a tag to a remote.",
  run: () => {
    const tag = e8.completingRead("Push tag: ", gitLines(["tag"]), { requireMatch: true });
    const remote = e8.completingRead(`Push ${tag} to remote: `, remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["push", ...pushArgs(), remote, tag], `Pushing ${tag}`);
  },
});

const pushTags = e8.defineCommand({
  name: "magit-push-tags",
  doc: "Push all tags to a remote.",
  run: () => {
    const remote = e8.completingRead("Push tags to remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["push", ...pushArgs(), remote, "--tags"], `Pushing tags to ${remote}`);
  },
});

const setVariables = e8.defineCommand({
  name: "magit-branch-configure",
  doc: "Configure the current branch's upstream, push remote and rebasing.",
  run: () => e8.call(branchMenu),
});

const pushMenu = transientDefinePrefix("magit-push", {
  doc: "Push to another repository.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-f", "Force with lease", "--force-with-lease"],
        ["-F", "Force", "--force"],
        ["-h", "Disable hooks", "--no-verify"],
        ["-n", "Dry run", "--dry-run"],
        ["-T", "Include all tags", "--tags"],
        ["-t", "Include related annotated tags", "--follow-tags"],
      ],
    },
    {
      description: () => `Push ${branchOrHead()} to`,
      items: [
        ["p", () => { const r = pushRemoteOf(currentBranch()); return r ? `${r}/${branchOrHead()}` : "pushRemote, setting that"; }, pushPushRemoteSetting],
        ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, creating it", pushUpstream],
        ["e", "elsewhere", pushElsewhere],
      ],
    },
    {
      description: "Push",
      items: [
        { items: [["o", "another branch", pushOther], ["r", "explicit refspecs", pushRefspecs], ["m", "matching branches", pushMatching]] },
        { items: [["T", "a tag", pushTag], ["t", "all tags", pushTags]] },
      ],
    },
    { description: "Configure", items: [["C", "Set variables...", setVariables]] },
  ],
});

// Pull and fetch.

const pullPushRemote = e8.defineCommand({
  name: "magit-pull-from-pushremote",
  doc: "Pull from the push remote of the current branch, setting one first if there is none.",
  run: () => {
    const remote = ensurePushRemote();
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, branchOrHead()], `Pulling from ${remote}`);
  },
});

const pullElsewhere = e8.defineCommand({
  name: "magit-pull-branch",
  doc: "Pull a branch read into the current one.",
  run: () => {
    const target = readBranch("Pull", remoteBranches());
    const [remote, ...rest] = target.split("/");
    runGitAsync(["pull", ...transientArgs("magit-pull"), remote, rest.join("/")], `Pulling from ${target}`);
  },
});

/** A git config variable a suffix cycles through CHOICES, shown as Magit shows one: name [a|b|default:x]. */
let configVariables = 0;
function configVariable(key: string, variable: () => string, choices: () => string[], fallback?: string): [string, () => e8.PropertizedString, e8.DefinedCommand] {
  // Named without asking git which variable it is: that waits for the menu.
  const command = e8.defineCommand({
    name: `magit:config-variable:${key}:${configVariables++}`,
    doc: "Cycle a git variable through its values.",
    run: () => {
      const name = variable();
      const now = gitString(["config", name]);
      const all = choices();
      const at = now === undefined ? -1 : all.indexOf(now);
      if (at + 1 < all.length) gitOutput(["config", name, all[at + 1]]);
      else gitOutput(["config", "--unset", name]);
      refreshAll();
    },
  });
  const describe = () => {
    const name = variable();
    const now = gitString(["config", name]);
    const parts = choices().flatMap((c, i) => [...(i > 0 ? [face("|", "transient-delimiter")] : []), face(c, c === now ? "transient-value" : "transient-inactive-value")]);
    const def = fallback !== undefined ? [face("|", "transient-delimiter"), face(`default:${fallback}`, now === undefined ? "transient-value" : "transient-inactive-value")] : [];
    return e8.concat(face(name, "transient-argument"), " ", face("[", "transient-delimiter"), ...parts, ...def, face("]", "transient-delimiter"));
  };
  return [key, describe, command];
}

const pullMenu = transientDefinePrefix("magit-pull", {
  doc: "Pull from another repository.",
  groups: [
    { description: "Arguments", items: [["-f", "Fast-forward only", "--ff-only"], ["-r", "Rebase local commits", "--rebase"], ["-F", "Force", "--force"]] },
    {
      description: () => `Pull into ${branchOrHead()} from`,
      items: [
        ["p", () => { const r = pushRemoteOf(currentBranch()); return r ? `${r}/${branchOrHead()}` : "pushRemote, setting that"; }, pullPushRemote],
        ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, setting that", pullUpstream],
        ["e", "elsewhere", pullElsewhere],
      ],
    },
    {
      description: "Configure",
      items: [configVariable("r", () => `branch.${branchOrHead()}.rebase`, () => ["true", "false"], "false"), ["C", "variables...", setVariables]],
    },
  ],
});

const fetchPushRemote = e8.defineCommand({
  name: "magit-fetch-from-pushremote",
  doc: "Fetch from the push remote of the current branch, setting one first if there is none.",
  run: () => {
    const remote = ensurePushRemote();
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});
const fetchElsewhere = e8.defineCommand({
  name: "magit-fetch-other",
  doc: "Fetch from a remote read.",
  run: () => {
    const remote = e8.completingRead("Fetch remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote], `Fetching ${remote}`);
  },
});
const fetchBranch = e8.defineCommand({
  name: "magit-fetch-branch",
  doc: "Fetch a branch from a remote.",
  run: () => {
    const remote = e8.completingRead("Fetch from remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    const branch = e8.readString(`Fetch branch from ${remote}: `);
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote, branch], `Fetching ${remote} ${branch}`);
  },
});
const fetchRefspec = e8.defineCommand({
  name: "magit-fetch-refspec",
  doc: "Fetch a refspec read from a remote read.",
  run: () => {
    const remote = e8.completingRead("Fetch from remote: ", remotes(), { requireMatch: true, default: remotes()[0] });
    const spec = e8.readString(`Fetch using refspec from ${remote}: `);
    runGitAsync(["fetch", ...transientArgs("magit-fetch"), remote, spec], `Fetching ${remote}`);
  },
});
const fetchModules = gitCommand("magit-fetch-modules", "Fetch all submodules.", () => ["fetch", "--recurse-submodules"]);

const fetchMenu = transientDefinePrefix("magit-fetch", {
  doc: "Fetch from another repository.",
  groups: [
    { description: "Arguments", items: [["-p", "Prune deleted branches", "--prune"], ["-t", "Fetch all tags", "--tags"], ["-F", "Force", "--force"]] },
    {
      description: "Fetch from",
      items: [
        ["p", () => pushRemoteOf(currentBranch()) ?? "pushRemote, setting that", fetchPushRemote],
        ["u", () => upstreamOf(currentBranch())?.split("/")[0] ?? "", fetchUpstream, { if: () => upstreamOf(currentBranch()) !== undefined }],
        ["e", "elsewhere", fetchElsewhere],
        ["a", "all remotes", fetchAll],
      ],
    },
    { description: "Fetch", items: [["o", "another branch", fetchBranch], ["r", "explicit refspec", fetchRefspec], ["m", "submodules", fetchModules]] },
    { description: "Configure", items: [["C", "variables...", setVariables]] },
  ],
});

// Branch.

/** A branch variable read and set, shown as Magit shows it: branch.main.description unset. */
function branchVariable(key: string, name: () => string, read: () => string | undefined): [string, () => e8.PropertizedString, e8.DefinedCommand] {
  const command = e8.defineCommand({
    name: `magit:branch-variable:${key}`,
    doc: "Set a variable of the current branch.",
    run: () => {
      const value = read();
      if (value === undefined || value === "") gitOutput(["config", "--unset", name()]);
      else gitOutput(["config", name(), value]);
      refreshAll();
    },
  });
  const describe = () => {
    const now = gitString(["config", name()]);
    return e8.concat(face(name(), "transient-argument"), " ", now === undefined ? face("unset", "transient-inactive-value") : face(now, "transient-value"));
  };
  return [key, describe, command];
}

const branchLocal = e8.defineCommand({
  name: "magit-branch-checkout",
  doc: "Check out a local branch, or create one from a remote branch.",
  run: () => runGit(["checkout", readBranch("Checkout branch", localBranches().filter((b) => b !== currentBranch()))]) as unknown as void,
});

const branchSpinoff = e8.defineCommand({
  name: "magit-branch-spinoff",
  doc: "Create a branch from the current one and check it out, taking the current one back to its upstream.",
  run: () => {
    const name = e8.readString("Spin off branch: ");
    if (name === "") e8.userError("No name given");
    const from = currentBranch();
    const upstream = upstreamOf(from);
    if (!runGit(["checkout", "-b", name])) return;
    if (from && upstream) runGit(["update-ref", `refs/heads/${from}`, gitString(["merge-base", from, upstream]) ?? upstream]);
  },
});

const branchSpinout = e8.defineCommand({
  name: "magit-branch-spinout",
  doc: "Create a branch from the current one, taking the current one back to its upstream, without checking the new one out.",
  run: () => {
    const name = e8.readString("Spin out branch: ");
    if (name === "") e8.userError("No name given");
    const from = currentBranch();
    const upstream = upstreamOf(from);
    if (!runGit(["branch", name])) return;
    if (from && upstream) runGit(["reset", "--keep", gitString(["merge-base", from, upstream]) ?? upstream]);
  },
});

const branchReset = e8.defineCommand({
  name: "magit-branch-reset",
  doc: "Reset a branch to a commit read.",
  run: () => {
    const branch = readBranch("Reset branch", localBranches(), currentBranch());
    const to = readBranch(`Reset ${branch} to`, [...localBranches(), ...remoteBranches()], upstreamOf(branch));
    if (branch === currentBranch()) runGit(["reset", "--hard", to]);
    else runGit(["update-ref", `refs/heads/${branch}`, to]);
  },
});

const updateDefaultBranch = gitCommand("magit-update-default-branch", "Update the default branch from the remote's HEAD.", () => {
  const remote = remotes()[0];
  return remote ? ["remote", "set-head", remote, "--auto"] : undefined;
});

const branchMenu = transientDefinePrefix("magit-branch", {
  doc: "Add, configure or remove a branch.",
  groups: [
    {
      description: () => `Configure ${branchOrHead()}`,
      items: [
        branchVariable("d", () => `branch.${branchOrHead()}.description`, () => e8.readString("Description: ")),
        branchVariable("u", () => `branch.${branchOrHead()}.merge`, () => {
          const up = readBranch("Upstream", remoteBranches());
          const [remote, ...rest] = up.split("/");
          gitOutput(["config", `branch.${branchOrHead()}.remote`, remote]);
          return `refs/heads/${rest.join("/")}`;
        }),
        [" ", { info: () => e8.concat(face(`branch.${branchOrHead()}.remote`, "transient-argument"), " ", ((r) => (r === undefined ? face("unset", "transient-inactive-value") : face(r, "transient-value")))(gitString(["config", `branch.${branchOrHead()}.remote`]))) }],
        configVariable("r", () => `branch.${branchOrHead()}.rebase`, () => ["true", "false"], "false"),
        configVariable("p", () => `branch.${branchOrHead()}.pushRemote`, () => remotes()),
      ],
    },
    {
      description: "Configure repository defaults",
      items: [configVariable("R", () => "pull.rebase", () => ["true", "false"], "false"), configVariable("P", () => "remote.pushDefault", () => remotes()), ["B", "Update default branch", updateDefaultBranch]],
    },
    { description: "Arguments", items: [] },
    {
      items: [
        { description: "Checkout", items: [["b", "branch/revision", branchCheckout], ["l", "local branch", branchLocal]] },
        { description: "", items: [["c", "new branch", branchCreateCheckout], ["s", "new spin-off", branchSpinoff]] },
        { description: "Create", items: [["n", "new branch", branchCreate], ["S", "new spin-out", branchSpinout]] },
        { description: "Do", items: [["C", "configure...", setVariables], ["m", "rename", branchRename], ["x", "reset", branchReset], ["k", "delete", branchDelete]] },
        { description: "", items: [] },
      ],
    },
  ],
});

// Log.

const logRelated = "magit-log-related";

/** The shortlog menu, as magit-shortlog. */
const shortlog = transientDefinePrefix("magit-shortlog", {
  doc: "Show a history summary.",
  value: ["--numbered", "--summary"],
  groups: [
    {
      description: "Arguments",
      items: [
        ["-n", "Sort by number of commits", "--numbered"],
        ["-s", "Show commit count summary only", "--summary"],
        ["-e", "Show email addresses", "--email"],
        ["-g", "Group commits by", "--group=", { choices: ["author", "committer", "trailer:"] }],
      ],
    },
    { description: "Shortlog", items: [["s", "since", "magit-shortlog-since"], ["r", "range", "magit-shortlog-range"]] },
  ],
});

/** The log arguments, those that change what git log lists rather than how it draws it. */
const logArgs = (): string[] => transientArgs("magit-log").filter((a) => !["--graph", "--color", "--decorate", "++header", "--show-signature"].includes(a));

const logMenu = transientDefinePrefix("magit-log", {
  doc: "Show a commit or reference log.",
  value: ["-n256", "--graph", "--decorate"],
  groups: [
    {
      description: "Commit limiting",
      items: [
        ["-n", "Limit number of commits", "-n", { class: "option", prompt: "Limit number of commits: " }],
        ["-A", "Limit to author", "--author=", { prompt: "Limit to author: " }],
        ["-F", "Search messages", "--grep=", { prompt: "Search messages: " }],
        ["-G", "Search changes", "-G", { class: "option", prompt: "Search changes: " }],
        ["-S", "Search occurrences", "-S", { class: "option", prompt: "Search occurrences: " }],
        ["-L", "Trace line evolution", "-L", { class: "option", prompt: "Trace line evolution: " }],
      ],
    },
    {
      description: "History simplification",
      items: [
        ["-D", "Simplify by decoration", "--simplify-by-decoration"],
        ["--", "Limit to files", "--", { class: "option", prompt: "Limit to files: " }],
        ["-f", "Follow renames when showing single-file log", "--follow"],
      ],
    },
    {
      description: "Commit ordering",
      items: [
        ["-o", "Order commits by", "--", { class: "switches", argumentFormat: "--%s-order", choices: ["topo", "author-date", "date"] }],
        ["-r", "Reverse order", "--reverse"],
      ],
    },
    {
      description: "Formatting",
      items: [
        ["-g", "Show graph", "--graph"],
        ["-c", "Show graph in color", "--color"],
        ["-d", "Show refnames", "--decorate"],
        ["=S", "Show signatures", "--show-signature"],
        ["-h", "Show header", "++header", { class: "switch" }],
        ["-p", "Show diffs", "--patch"],
        ["-s", "Show diffstats", "--stat"],
      ],
    },
    {
      items: [
        { description: "Log", items: [["l", "current", logCurrent], ["o", "other", logOther], ["u", "related", logRelated]] },
        {
          description: "",
          items: [
            ["L", "local branches", "magit-log-branches"],
            ["b", "all branches", "magit-log-all-branches"],
            ["a", "all references", logAll],
          ],
        },
        {
          description: "Reflog",
          items: [
            ["r", "current", "magit-reflog-current"],
            ["O", "other", "magit-reflog-other"],
            ["H", "HEAD", "magit-reflog-head"],
          ],
        },
        { description: "Wiplog", if: magitAnyWipModeEnabledP, items: [["i", "index", "magit-wip-log-index"], ["w", "worktree", "magit-wip-log-worktree"]] },
        { description: "Other", items: [["s", "shortlog", shortlog]] },
      ],
    },
  ],
});

// Merge.

const mergeWith = (name: string, doc: string, extra: string[]) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const branch = readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()]);
      runGit(["merge", ...transientArgs("magit-merge"), ...extra, branch]);
    },
  });
const mergePlain = mergeWith("magit-merge-plain", "Merge a branch into the current one.", ["--no-edit"]);
const mergeEdit = e8.defineCommand({
  name: "magit-merge-editmsg",
  doc: "Merge a branch into the current one, writing the merge commit's message.",
  run: () => {
    const branch = readBranch("Merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()]);
    runGitAsync(["merge", "--edit", ...transientArgs("magit-merge"), branch], "Merging", true);
  },
});
const mergeNocommit = mergeWith("magit-merge-nocommit", "Merge a branch into the current one, without committing.", ["--no-commit", "--no-ff"]);
const mergeSquash = mergeWith("magit-merge-squash", "Squash the changes of a branch into the index, without committing.", ["--squash"]);
const mergeAbsorb = e8.defineCommand({
  name: "magit-merge-absorb",
  doc: "Merge a branch into the current one and delete it.",
  run: () => {
    const branch = readBranch("Absorb branch", localBranches().filter((b) => b !== currentBranch()));
    if (runGit(["merge", "--no-edit", ...transientArgs("magit-merge"), branch])) runGit(["branch", "-D", branch]);
  },
});
const mergeDissolve = e8.defineCommand({
  name: "magit-merge-into",
  doc: "Merge the current branch into another and delete the current one.",
  run: () => {
    const from = currentBranch();
    if (!from) e8.userError("No branch is checked out");
    const into = readBranch(`Merge ${from} into`, localBranches().filter((b) => b !== from), upstreamOf(from)?.replace(/^[^/]+\//, ""));
    if (runGit(["checkout", into]) && runGit(["merge", "--no-edit", ...transientArgs("magit-merge"), from])) runGit(["branch", "-D", from]);
  },
});
const mergePreview = e8.defineCommand({
  name: "magit-merge-preview",
  doc: "Show the changes merging a branch would make.",
  run: () => {
    const branch = readBranch("Preview merge", [...localBranches().filter((b) => b !== currentBranch()), ...remoteBranches()]);
    const [args] = magitDiffArguments();
    magitDiffSetupBuffer(`HEAD...${branch}`, undefined, args, [], "committed");
  },
});

const mergeMenu = transientDefinePrefix("magit-merge", {
  doc: "Merge branches.",
  groups: [
    { description: "Arguments", items: [["-f", "Fast-forward only", "--ff-only"], ["-n", "No fast-forward", "--no-ff"], ["-s", "Strategy", "--strategy=", { choices: ["resolve", "recursive", "octopus", "ours", "subtree", "ort"] }]] },
    {
      description: "Actions",
      items: [
        { items: [["m", "Merge", mergePlain], ["e", "Merge and edit message", mergeEdit], ["n", "Merge but don't commit", mergeNocommit], ["a", "Absorb", mergeAbsorb]] },
        { items: [["p", "Preview merge", mergePreview], "", ["s", "Squash merge", mergeSquash], ["d", "Dissolve", mergeDissolve]] },
      ],
    },
  ],
});

// Reset.

const resetMenu = transientDefinePrefix("magit-reset", {
  doc: "Reset the current branch.",
  groups: [
    {
      items: [
        { description: "Reset", items: [["b", "branch", branchReset], ["f", "file", magitFileCheckout]] },
        {
          description: "Reset this",
          items: [
            ["m", "mixed    (HEAD and index)", resetCommand("mixed", "Reset HEAD and the index to a commit, keeping the working tree.")],
            ["s", "soft     (HEAD only)", resetCommand("soft", "Reset HEAD to a commit, keeping the index and working tree.")],
            ["h", "hard     (HEAD, index and worktree)", resetCommand("hard", "Reset HEAD, the index and the working tree to a commit.")],
            ["k", "keep     (HEAD and index, keeping uncommitted)", resetCommand("keep", "Reset HEAD and the index to a commit, keeping uncommitted changes.")],
            ["i", "index    (only)", gitCommand("magit-reset-index", "Reset the index to a commit, keeping HEAD and the working tree.", () => ["reset", readBranch("Reset index to", [...localBranches(), ...remoteBranches()], "HEAD"), "--", "."])],
            ["w", "worktree (only)", gitCommand("magit-reset-worktree", "Reset the working tree to a commit, keeping HEAD and the index.", () => ["checkout", readBranch("Reset worktree to", [...localBranches(), ...remoteBranches()], "HEAD"), "--", "."])],
          ],
        },
      ],
    },
  ],
});

// Diff.

const diffRange = "magit-diff-range";
const diffPaths = "magit-diff-paths";
const diffWorktree = "magit-diff-working-tree";
const showCommitCommand = magitShowCommit;
const showStash = magitStashShow;

const diffMenu = transientDefinePrefix("magit-diff", {
  doc: "Show changes between different versions.",
  groups: [
    {
      description: "Limit arguments",
      items: [
        ["--", "Limit to files", "--", { class: "option", prompt: "Limit to files: " }],
        ["-i", "Ignore submodules", "--ignore-submodules=", { choices: ["untracked", "dirty", "all"] }],
        ["-b", "Ignore whitespace changes", "--ignore-space-change"],
        ["-w", "Ignore all whitespace", "--ignore-all-space"],
      ],
    },
    { description: "Context arguments", items: [["-U", "Context lines", "-U", { class: "option", prompt: "Context lines: " }], ["-W", "Show surrounding functions", "--function-context"]] },
    {
      description: "Tune arguments",
      items: [
        ["-A", "Diff algorithm", "--diff-algorithm=", { choices: ["default", "minimal", "patience", "histogram"] }],
        ["-X", "Diff merges", "--diff-merges=", { choices: ["off", "on", "first-parent", "separate", "combined", "dense-combined", "remerge"] }],
        ["-M", "Detect renames", "-M", { class: "option", prompt: "Detect renames: " }],
        ["-C", "Detect copies", "-C", { class: "option", prompt: "Detect copies: " }],
        ["-x", "Disallow external diff drivers", "--no-ext-diff"],
        ["-s", "Show stats", "--stat"],
        ["=g", "Show signature", "--show-signature"],
      ],
    },
    {
      description: "Actions",
      items: [
        { items: [["d", "Dwim", diffDwim], ["r", "Diff range", diffRange], ["p", "Diff paths", diffPaths]] },
        { items: [["u", "Diff unstaged", diffUnstaged], ["s", "Diff staged", diffStaged], ["w", "Diff worktree", diffWorktree]] },
        { items: [["c", "Show commit", showCommitCommand], ["t", "Show stash", showStash]] },
      ],
    },
  ],
});

// Stash.

const stashIndex = gitCommand("magit-stash-index", "Stash the changes in the index only.", () => ["stash", "push", "--staged", ...transientArgs("magit-stash")]);
const stashWorktree = gitCommand("magit-stash-worktree", "Stash the changes in the working tree only, keeping the index.", () => ["stash", "push", "--keep-index", ...transientArgs("magit-stash")]);
const stashKeepIndex = gitCommand("magit-stash-keep-index", "Stash the changes in the index and the working tree, keeping the index.", () => ["stash", "push", "--keep-index", ...transientArgs("magit-stash")]);
const snapshot = (name: string, doc: string, extra: string[]) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const r = gitOutput(["stash", "create", ...extra]);
      const hash = r.output.trim();
      if (hash === "") e8.userError("No local changes to save");
      runGit(["stash", "store", "-m", `Snapshot of ${branchOrHead()}`, hash]);
    },
  });
const stashToWip = magitWipCommitCommand;
const stashList = "magit-stash-list";
const stashBranch = e8.defineCommand({
  name: "magit-stash-branch",
  doc: "Create a branch from a stash's commit, apply the stash to it and drop the stash.",
  run: () => {
    const s = stashAt("Branch from stash");
    const name = e8.readString("Branch name: ");
    runGit(["stash", "branch", name, s]);
  },
});
const stashBranchHere = e8.defineCommand({
  name: "magit-stash-branch-here",
  doc: "Create a branch at HEAD, check it out, apply a stash to it and drop the stash.",
  run: () => {
    const s = stashAt("Branch from stash");
    const name = e8.readString("Branch name: ");
    if (runGit(["checkout", "-b", name]) && runGit(["stash", "apply", s])) runGit(["stash", "drop", s]);
  },
});
const stashFormatPatch = e8.defineCommand({
  name: "magit-stash-format-patch",
  doc: "Write a stash as a patch file.",
  run: () => {
    const s = stashAt("Format patch from stash");
    const out = gitOutput(["stash", "show", "-p", s]).output;
    const file = e8.expandFileName(`${s.replace(/[@{}]/g, "")}.patch`, repo());
    e8.writeTextFile(file, out);
    e8.message(`Wrote ${file}`);
  },
});

const stashMenu = transientDefinePrefix("magit-stash", {
  doc: "Stash uncommitted changes.",
  groups: [
    { description: "Arguments", items: [["-u", "Also save untracked files", "--include-untracked"], ["-a", "Also save untracked and ignored files", "--all"]] },
    {
      items: [
        { description: "Stash", items: [["z", "both", stashBoth], ["i", "index", stashIndex], ["w", "worktree", stashWorktree], ["x", "keeping index", stashKeepIndex]] },
        {
          description: "Snapshot",
          items: [
            ["Z", "both", snapshot("magit-snapshot-both", "Save a stash of the index and working tree, keeping them.", [])],
            ["I", "index", snapshot("magit-snapshot-index", "Save a stash of the index, keeping it.", [])],
            ["W", "worktree", snapshot("magit-snapshot-worktree", "Save a stash of the working tree, keeping it.", [])],
            ["r", "to wip ref", stashToWip],
          ],
        },
        { description: "Use", items: [["a", "Apply", stashApply], ["p", "Pop", stashPop], ["k", "Drop", stashDrop]] },
        { description: "Inspect", items: [["l", "List", stashList], ["v", "Show", showStash]] },
        { description: "Transform", items: [["b", "Branch", stashBranch], ["B", "Branch here", stashBranchHere], ["f", "Format patch", stashFormatPatch]] },
      ],
    },
  ],
});

// The other menus and commands the dispatch menu names.

const cherries = "magit-cherry";
const jumpToSection = e8.defineCommand({
  name: "magit-status-jump",
  doc: "Jump to a section of the status buffer, chosen by its heading.",
  run: () => {
    const top = sections()?.root.children ?? [];
    const names = top.map((s) => e8.bufferSubstringNoProperties(s.start, e8.lineEndPosition(s.start)));
    const chosen = e8.completingRead("Jump to section: ", names, { requireMatch: true });
    const s = top[names.indexOf(chosen)];
    if (s) e8.gotoChar(s.start);
  },
});
const displayRepositoryBuffer = e8.defineCommand({
  name: "magit-display-repository-buffer",
  doc: "Show one of the repository's Magit buffers.",
  run: () => {
    const names = e8.bufferList().filter((b) => /^magit[-a-z]*: /.test(b));
    e8.call("switch-to-buffer", e8.completingRead("Display buffer: ", names, { requireMatch: true }));
  },
});
const sectionInfo = e8.defineCommand({
  name: "magit-describe-section",
  doc: "Say what the section at point is.",
  run: () => {
    const s = currentSection();
    if (!s) e8.userError("No section at point");
    const chain: string[] = [];
    for (let x: Section | undefined = s; x && x.parent; x = x.parent) chain.push(x.type);
    e8.message(`(${chain.join(" ")}) [${s.start}-${s.end}]`);
  },
});
const help = e8.defineCommand({ name: "magit-info", doc: "Show what Magit's keys do.", run: () => e8.call("describe-mode") });

// Running git and shell commands, after magit.el's magit-run.

e8.defineVariable({ name: "magit-shell-command-verbose-prompt", doc: "Whether to show the working directory when reading a command.", value: true });

/** Reads a shell command, in the repository's top with TOPLEVEL or a prefix argument, as magit-read-shell-command; gives it and the directory. */
function readShellCommand(toplevel: boolean, initial?: string): [string, string] {
  const dir = toplevel || prefixArgP() ? magitToplevelOrError() : String(e8.variable("default-directory"));
  const prompt = truthy(e8.variable("magit-shell-command-verbose-prompt")) ? `Async shell command in ${e8.abbreviateFileName(dir)}: ` : "Async shell command: ";
  return [e8.readString(prompt, { initial, history: "magit-git-command-history" }), dir];
}

/** Runs COMMAND in a shell in DIRECTORY, showing its output in the process buffer, as magit--shell-command. */
function shellCommand(command: string, directory: string): void {
  e8.letBind({ "default-directory": directory }, () => {
    const shell = String(e8.variable("shell-file-name") ?? e8.getenv("SHELL") ?? "/bin/sh");
    magitStartProcess(shell, [String(e8.variable("shell-command-switch") ?? "-c"), command], { editor: true, env: { GIT_PAGER: "cat" } });
    magitProcessBuffer();
  });
}

const gitCommandCommand = (name: string, doc: string, toplevel: boolean, initial?: string) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const [command, dir] = readShellCommand(toplevel, initial);
      shellCommand(command, dir);
    },
  });
const magitGitCommand = gitCommandCommand("magit-git-command", "Execute COMMAND asynchronously; display output.  Interactively, prompt for COMMAND in the minibuffer.  \"git \" is used as initial input, but can be deleted to run another command.  With a prefix argument COMMAND is run in the top-level directory of the current working tree, otherwise in default-directory.", false, "git ");
const magitGitCommandTopdir = gitCommandCommand("magit-git-command-topdir", "Execute COMMAND asynchronously in the top-level directory of the current working tree; display output.", true, "git ");
const magitShellCommand = gitCommandCommand("magit-shell-command", "Execute COMMAND asynchronously; display output.  With a prefix argument COMMAND is run in the top-level directory of the current working tree, otherwise in default-directory.", false);
const magitShellCommandTopdir = gitCommandCommand("magit-shell-command-topdir", "Execute COMMAND asynchronously in the top-level directory of the current working tree; display output.", true);

const magitRun = transientDefinePrefix("magit-run", {
  doc: "Run git or another command, or launch a graphical utility.",
  groups: [
    {
      class: "columns",
      items: [
        { description: "Run git subcommand", items: [["!", "in repository root", magitGitCommandTopdir], ["p", "in working directory", magitGitCommand]] },
        { description: "Run shell command", items: [["s", "in repository root", magitShellCommandTopdir], ["S", "in working directory", magitShellCommand]] },
        { description: "Launch", items: [["k", "gitk", magitRunGitk], ["a", "gitk --all", magitRunGitkAll], ["b", "gitk --branches", magitRunGitkBranches], ["g", "git gui", magitRunGitGui], ["m", "git mergetool --gui", magitGitMergetool]] },
      ],
    },
  ],
});


const dispatch = transientDefinePrefix("magit-dispatch", {
  doc: "Invoke a Magit command from a list of available commands.",
  groups: [
    {
      description: "Transient and dwim commands",
      items: [
        {
          items: [
            ["A", "Apply", magitCherryPick],
            ["b", "Branch", branchMenu],
            ["B", "Bisect", magitBisect],
            ["c", "Commit", commitMenu],
            ["C", "Clone", magitClone],
            ["d", "Diff", diffMenu],
            ["D", "Diff (change)", diffMenu],
            ["e", "Ediff (dwim)", notYet("magit-ediff-dwim", "Ediff")],
            ["E", "Ediff", notYet("magit-ediff", "Ediff")],
            ["f", "Fetch", fetchMenu],
            ["F", "Pull", pullMenu],
            ["h", "Help", help],
            ["H", "Section info", sectionInfo],
          ],
        },
        {
          items: [
            ["i", "Ignore", magitGitignore],
            ["I", "Init", magitInitCommand],
            ["j", "Jump to section", jumpToSection],
            ["J", "Display buffer", displayRepositoryBuffer],
            ["l", "Log", logMenu],
            ["L", "Log (change)", logMenu],
            ["m", "Merge", mergeMenu],
            ["M", "Remote", magitRemote],
            ["o", "Submodule", magitSubmodule],
            ["O", "Subtree", magitSubtree],
            ["P", "Push", pushMenu],
            ["Q", "Command", magitGitCommand],
          ],
        },
        {
          items: [
            ["r", "Rebase", magitRebase],
            ["t", "Tag", magitTag],
            ["T", "Note", magitNotes],
            ["V", "Revert", magitRevert],
            ["w", "Apply patches", magitAm],
            ["W", "Format patches", magitPatch],
            ["X", "Reset", resetMenu],
            ["y", "Show Refs", magitShowRefs],
            ["Y", "Cherries", cherries],
            ["z", "Stash", stashMenu],
            ["Z", "Worktree", magitWorktree],
            ["!", "Run", magitRun],
          ],
        },
      ],
    },
    {
      description: "Applying changes",
      items: [
        { items: [["a", "Apply", notYet("magit-apply", "Applying a change from elsewhere")], ["v", "Reverse", notYet("magit-reverse", "Reversing a change")], ["k", "Discard", magitDiscard]] },
        { items: [["s", "Stage", magitStage], ["u", "Unstage", magitUnstage]] },
        { items: [["S", "Stage all", stageModified], ["U", "Unstage all", unstageAll]] },
      ],
    },
    {
      description: "Essential commands",
      items: [
        {
          padKeys: true,
          items: [
            ["g", "Refresh current buffer", refreshCommand],
            ["q", "Bury current buffer", "quit-window"],
            ["<tab>", "Toggle section at point", "magit-section-toggle"],
            ["<return>", "Visit thing at point", magitVisitThing],
          ],
        },
        { items: [["C-x m", "Show all key bindings", "describe-mode"], ["C-x i", "Show Info manual", help]] },
      ],
    },
  ],
});

const bindings: [string, e8.DefinedCommand | string][] = [
  ["s", magitStage],
  ["S", stageModified],
  ["u", magitUnstage],
  ["U", unstageAll],
  ["k", magitDiscard],
  ["RET", magitVisitThing],
  ["g", refreshCommand],
  ["G", refreshAllCommand],
  ["$", processBuffer],
  ["c", commitMenu],
  ["b", branchMenu],
  ["P", pushMenu],
  ["F", pullMenu],
  ["f", fetchMenu],
  ["m", mergeMenu],
  ["X", resetMenu],
  ["z", stashMenu],
  ["r", magitRebase],
  ["A", magitCherryPick],
  ["V", magitRevert],
  ["w", magitAm],
  ["a", magitCherryApply],
  ["v", magitRevertNoCommit],
  ["C", magitClone],
  ["I", magitInitCommand],
  ["M", magitRemote],
  ["Q", magitGitCommand],
  ["t", magitTag],
  ["B", magitBisect],
  ["y", magitShowRefs],
  ["K", magitFileUntrack],
  ["R", magitFileRename],
  ["i", magitGitignore],
  ["T", magitNotes],
  ["O", magitSubtree],
  ["o", magitSubmodule],
  ["W", magitPatch],
  ["Z", magitWorktree],
  ["!", magitRun],
  ["l", logMenu],
  ["d", diffMenu],
  ["h", dispatch],
  ["?", dispatch],
  ["q", "quit-window"],
];
for (const [key, command] of bindings) e8.defineKey("magit-mode-map", key, command as e8.DefinedCommand);

// M-x magit is magit-status, as Magit's defalias makes it.
e8.defalias("magit", "magit-status");
e8.bindKey("C-x g", magitStatus);
e8.bindKey("C-x M-g", dispatch);

void sectionAt;
