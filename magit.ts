// SPDX-License-Identifier: GPL-3.0-or-later
//
// Magit, after Magit 4.4.0 (https://github.com/magit/magit): magit.el and
// the files of its lisp/ directory it draws on, among them magit-status.el,
// magit-diff.el, magit-log.el, magit-commit.el,
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
// Commit messages are written in a COMMIT_EDITMSG buffer, in
// git-commit-mode (git-commit.ts), C-c C-c to commit and C-c C-k to give
// up, and rebase todo lists in git-rebase-mode: git runs E8 as its
// editor through with-editor, as Magit has it run Emacs.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, magitRegionValues, insertHeading, insertRoot, insertSection, magitSectionMode, sectionAt, sections, show, type Section } from "magit-section";
import { transientArgs, transientDefinePrefix, type Group } from "transient";
import { forwardLine, PerBuffer, truthy } from "subr";
import { magitCompletingRead, magitConfirm, magitEllipsis, magitReadCharCase, magitReadStringNs, magitYOrNP, prefixArgP } from "magit-base";
import {
  magitAnythingModifiedP,
  magitBranchAtPoint,
  magitBranchP,
  magitGet,
  magitGetPushBranch,
  magitLocalBranchAtPoint,
  magitReadStartingPoint,
  magitRemoteBranchP,
  magitSet,
  magitSplitBranchName,
  magitAnythingStagedP,
  magitAnythingUnmergedP,
  magitAnythingUnstagedP,
  magitCommitAtPoint,
  magitGitdir,
  magitRevAncestorP,
  magitRevFormat,
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
  magitGitVersion,
} from "magit-git";
import {
  magitDiffMode,
  magitLogMode,
  magitMode,
  magitModeBuryBuffer,
  magitRefreshAll,
  magitRefreshAllCommand,
  magitRefreshBuffer,
  magitRefreshCommand,
  magitRepoName,
  magitRevisionMode,
  magitSetupBuffer,
  magitStatusMode,
  magitDeleteThing,
  magitDisplayBufferInhibitSameWindow,
  magitModeBuryBufferFn,
  magitRunHooks,
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
import {
  magitApplyCommand,
  magitDiscardCommand,
  magitReverseCommand,
  magitStageCommand,
  magitStageFilesCommand,
  magitStageModifiedCommand,
  magitUnstageAllCommand,
  magitUnstageCommand,
  magitUnstageFilesCommand,
} from "magit-apply";
import { magitLogPrefixValue, magitLogSelect } from "magit-log";
import "magit-bundle";
import "git-rebase";
import "git-commit";
import { magitAm, magitCherryApply, magitCherryPick, magitListPublishingBranches, magitRebase, magitRebaseInteractive1, magitRebaseInteractiveAssert, magitRevert, magitRevertNoCommit } from "magit-sequence";
import { magitTag } from "magit-tag";
import { magitBisect } from "magit-bisect";
import { magitShowRefs } from "magit-refs";
import { magitFileCheckout, magitFileRename, magitFileUntrack } from "magit-files";
import { magitGitignore } from "magit-gitignore";
import { magitNotes } from "magit-notes";
import { magitSubtree } from "magit-subtree";
import "magit-repos";
import "magit-sparse-checkout";
import { magitSubmodule } from "magit-submodule";
import { magitPatch } from "magit-patch";
import { magitBranchReadArgs, magitWorktree } from "magit-worktree";
import { magitRemote } from "magit-remote";
import { magitClone } from "magit-clone";
import "magit-blame";
import { magitGitMergetool, magitPopRevisionStackCommand, magitRunGitGui, magitRunGitk, magitRunGitkAll, magitRunGitkBranches } from "magit-extras";
import "magit-dired";
import "magit-autorevert";
import "magit-bookmark";
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
  ["magit-branch-remote-head", "Face for current branch.", { inherit: "magit-branch-remote", box: true } as e8.FaceAttributes],
  ["magit-branch-upstream", "Face for upstream branch.  This face is only used in logs and it gets combined with magit-branch-local, magit-branch-remote and/or magit-branch-remote-head.", { slant: "italic" } as e8.FaceAttributes],
  ["magit-branch-warning", "Face for warning about (missing) branch.", { inherit: "warning" }],
  ["magit-header-line", "Face for the header-line in some Magit modes.", { inherit: "magit-section-heading" }],
  ["magit-header-line-key", "Face for keys in the header-line.", { inherit: "font-lock-builtin-face" }],
  ["magit-refname", "Face for refnames without a dedicated face.", {}, { foreground: "grey30" }, { foreground: "grey80" }],
  ["magit-refname-stash", "Face for stash refnames.", { inherit: "magit-refname" }],
  ["magit-refname-wip", "Face for wip refnames.", { inherit: "magit-refname" }],
  ["magit-refname-pullreq", "Face for pullreq refnames.", { inherit: "magit-refname" }],
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

// Applying is magit-apply.ts's.

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

e8.defineVariable({ name: "magit-commit-ask-to-stage", doc: "Whether to ask to stage everything when committing and nothing is staged.\n\nnil: never ask; verbose: show the unstaged changes and ask; t: ask; stage: stage everything without asking.", value: "verbose" });
e8.defineVariable({ name: "magit-commit-show-diff", doc: "Whether the relevant diff is automatically shown when committing.", value: true });
e8.defineVariable({
  name: "magit-commit-diff-inhibit-same-window",
  doc: "Whether to inhibit use of same window when showing diff while committing.\n\nWhen writing a commit, then a diff of the changes to be committed is automatically shown.  The idea is that the diff is shown in a different window of the same frame and for most users that just works.  In other words most users can completely ignore this option because its value doesn't make a difference for them.\n\nHowever for users who configured Emacs to never create a new window even when the package explicitly tries to do so, then displaying two new buffers necessarily means that the first is immediately replaced by the second.  In our case the message buffer is immediately replaced by the diff buffer, which is of course highly undesirable.\n\nA workaround is to suppress this user configuration in this particular case.  Users have to explicitly opt-in by toggling this option.  We cannot enable the workaround unconditionally because that again causes issues for other users: if the frame is too tiny or the relevant settings too aggressive, then the diff buffer would end up being displayed in a new frame.\n\nAlso see https://github.com/magit/magit/issues/4132.",
  value: false,
});
e8.defineVariable({ name: "magit-commit-extend-override-date", doc: "Whether using magit-commit-extend changes the committer date.", value: true });
e8.defineVariable({ name: "magit-commit-reword-override-date", doc: "Whether using magit-commit-reword changes the committer date.", value: true });
e8.defineVariable({
  name: "magit-commit-squash-confirm",
  doc: "Whether the commit targeted by squash and fixup has to be confirmed.\nWhen non-nil then the commit at point (if any) is used as default choice, otherwise it has to be confirmed.  This option only affects magit-commit-squash and magit-commit-fixup.  The \"instant\" variants always require confirmation because making an error while using those is harder to recover from.",
  value: true,
});
e8.defineVariable({
  name: "magit-post-commit-hook",
  doc: "Hook run after creating a commit without the user editing a message.\n\nThis hook is run by magit-refresh if this-command is a member of magit-post-commit-hook-commands.  This only includes commands named magit-commit-* that do *not* require that the user edits the commit message in a buffer and then finishes by pressing C-c C-c.\n\nAlso see git-commit-post-finish-hook.",
  value: [],
});
e8.defineVariable({
  name: "magit-post-commit-hook-commands",
  doc: "The commands after which magit-post-commit-hook runs, once git is done.",
  value: ["magit-commit-extend", "magit-commit-fixup", "magit-commit-augment", "magit-commit-instant-fixup", "magit-commit-instant-squash"],
});

/** Runs magit-post-commit-hook after a refresh no command runs, if the last command made a commit without a message edited, as magit-run-post-commit-hook. */
function magitRunPostCommitHook(): void {
  const commands = e8.variable("magit-post-commit-hook-commands");
  const last = e8.lastCommand();
  if (e8.thisCommand() === undefined && last !== undefined && Array.isArray(commands) && commands.some((c) => String(c) === last)) magitRunHooks("magit-post-commit-hook");
}
e8.defun("magit-run-post-commit-hook", magitRunPostCommitHook);
e8.addHook("magit-post-refresh-hook", magitRunPostCommitHook);

/** The diff a commit makes, shown beside its message, as magit-commit-diff; the buffer, to take away when done. */
let commitDiff: string | undefined;
/** The command that started the commit being written in each repository, as Magit's repository-local this-commit-command. */
const thisCommitCommand = new Map<string, string>();
const setThisCommitCommand = (command: string): void => void thisCommitCommand.set(magitToplevel() ?? "", command);

/**
 * The arguments to commit with, or undefined to not commit, as
 * magit-commit-assert: with something staged, or ARGS that commit
 * anyway, ARGS; else with a rebase in progress offers to continue it,
 * with a merge in progress checks for conflicts, and else asks to stage
 * everything as magit-commit-ask-to-stage says.  NOPATCH commits
 * whatever there is; STRICT counts only --all as committing anyway.
 */
function magitCommitAssert(args: string[], nopatch = false, strict = false): string[] | undefined {
  const orArgs = (): string[] => (args.length > 0 ? args : ["--"]);
  if (nopatch) return orArgs();
  if (
    magitAnythingStagedP() ||
    (magitAnythingUnstagedP() && args.includes("--all")) ||
    (!strict && ["--amend", "--allow-empty", "--reset-author", "--signoff"].some((a) => args.includes(a))) ||
    (!strict && args.some((a) => a.startsWith("--author=") || a.startsWith("--date=")))
  )
    return orArgs();
  if (magitRebaseInProgressP() && !magitAnythingUnstagedP() && e8.yOrNP("Nothing staged.  Continue in-progress rebase? ")) {
    e8.call("magit-rebase-continue" as e8.CommandName);
    return undefined;
  }
  if (e8.fileExistsP(e8.expandFileName("MERGE_MSG", magitGitdir()))) {
    if (magitAnythingUnmergedP()) e8.userError("Unresolved conflicts");
    if (magitAnythingUnstagedP() && !e8.yOrNP("Proceed with merge despite unstaged changes? ")) e8.userError("Abort");
    return orArgs();
  }
  if (!magitAnythingUnstagedP()) e8.userError("Nothing staged (or unstaged)");
  const ask = e8.variable("magit-commit-ask-to-stage");
  if (!truthy(ask)) return e8.userError("Nothing staged");
  if (ask === "verbose") e8.call("magit-diff-unstaged" as e8.CommandName);
  let result: string[] | undefined;
  if (ask === "stage" || e8.yOrNP("Nothing staged.  Commit all uncommitted changes? ")) {
    setThisCommitCommand("magit-commit--all");
    result = ["--all", ...orArgs()];
  }
  if (ask === "verbose" && e8.derivedModeP("magit-diff-mode")) magitModeBuryBufferFn();
  return result;
}

/** Asks before modifying a commit already published, as magit-commit-amend-assert. */
export function magitCommitAmendAssert(commit?: string): void {
  const branches = magitListPublishingBranches(commit);
  if (branches.length === 0) return;
  const m1 = "This commit has already been published to ";
  const m2 = ".\nDo you really want to modify it";
  magitConfirm("amend-published", `${m1}%s${m2}`, `${m1}%d public branches${m2}`, branches);
}
e8.defun("magit-commit-amend-assert", (commit?: string | null) => magitCommitAmendAssert(commit ?? undefined));

/** Runs git commit with ARGS, its message written in COMMIT_EDITMSG through with-editor, as magit-run-git-with-editor; ENV adds to its environment. */
function editCommit(args: string[], env: { [name: string]: string } = {}): void {
  runGitAsync(["commit", ...args], "Committing", true, env);
}

/** The environment that keeps the committer date of HEAD, unless OVERRIDE-DATE, as magit-commit-extend and magit-commit-reword set it. */
const keepCommitterDate = (overrideDate: boolean): { [name: string]: string } => (overrideDate ? {} : { GIT_COMMITTER_DATE: magitRevFormat("%cD") ?? "" });

/** Whether DISPLAY-FUNCTION would show the diff without the selected window, for magit-commit-diff-inhibit-same-window. */
e8.defun("magit--display-buffer-inhibit-same-window", (buffer: string) => magitDisplayBufferInhibitSameWindow(buffer));

/**
 * Shows what the commit makes beside its message, as magit-commit-diff
 * does when COMMIT_EDITMSG is visited, with magit-commit-show-diff: the
 * staged changes, or what the command that started the commit makes, as
 * magit-commit-diff-1 works it out.
 */
function showCommitDiff(): void {
  if (!/\/COMMIT_EDITMSG$/.test(e8.bufferFileName() ?? "")) return;
  const top = magitToplevel() ?? "";
  const command = thisCommitCommand.get(top) ?? (magitRebaseInProgressP() ? "magit-commit--rebase" : undefined);
  if (!truthy(e8.variable("magit-commit-show-diff"))) return;
  const window = e8.selectedWindow();
  e8.message("Diffing changes to be committed (C-g to abort diffing)");
  const staged = magitAnythingStagedP();
  const unstaged = magitAnythingUnstagedP();
  const pending = e8.expandFileName("rebase-merge/rewritten-pending", magitGitdir());
  const squash = e8.fileExistsP(pending) ? e8.readTextFile(pending).split("\n").filter((l) => l !== "").length : undefined;
  let rev: string | undefined;
  let arg: string | undefined = "--cached";
  if (command === "magit-commit--rebase" && squash !== undefined) rev = `HEAD~${squash}`;
  else if (command === "magit-commit-amend") rev = "HEAD^";
  else if (!staged && !unstaged && command === "magit-commit--allow-empty") [rev, arg] = ["HEAD", undefined];
  else if (command === "magit-commit-reword" || (!staged && !unstaged)) [rev, arg] = ["HEAD^..HEAD", undefined];
  else if (unstaged && command === "magit-commit--all") [rev, arg] = ["HEAD", undefined];
  const [args] = magitDiffArguments();
  const bindings: { [variable: string]: e8.Value } = { "magit-inhibit-save-previous-winconf": "unset", "magit-display-buffer-noselect": true };
  if (truthy(e8.variable("magit-commit-diff-inhibit-same-window"))) bindings["magit-display-buffer-function"] = "magit--display-buffer-inhibit-same-window";
  commitDiff = e8.letBind(bindings, () => magitDiffSetupBuffer(rev, arg, args, [], rev === "HEAD" ? "staged" : rev === "HEAD^..HEAD" ? "committed" : "undefined"));
  if (e8.windowList().includes(window)) e8.selectWindow(window);
}

/** Takes the commit's diff away once the message is done with, and forgets the command, as magit-commit--reset-command. */
function hideCommitDiff(): void {
  thisCommitCommand.delete(magitToplevel() ?? "");
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
  ["/git-rebase-todo\\'", "git-rebase-mode"],
]);

e8.defineKey("git-commit-mode-map", "C-c C-w", magitPopRevisionStackCommand);
const commitArgs = (): string[] => transientArgs("magit-commit");

const commitCreate = e8.defineCommand({
  name: "magit-commit-create",
  doc: "Create a new commit.",
  run: () => {
    const args = commitArgs();
    setThisCommitCommand(args.includes("--all") ? "magit-commit--all" : args.includes("--allow-empty") ? "magit-commit--allow-empty" : "magit-commit-create");
    const asserted = magitCommitAssert(args);
    if (asserted) editCommit(asserted);
  },
});

const commitAmend = e8.defineCommand({
  name: "magit-commit-amend",
  doc: "Amend staged changes (if any) to the last commit, and edit its message.",
  run: () => {
    magitCommitAmendAssert();
    setThisCommitCommand("magit-commit-amend");
    editCommit(["--amend", ...commitArgs()]);
  },
});

/** Whether to override the committer date: OPTION, or its opposite with a prefix argument, as magit-commit-extend and magit-commit-reword read it. */
const overrideDate = (option: string, prefix: e8.Value): boolean => (truthy(prefix) ? !truthy(e8.variable(option)) : truthy(e8.variable(option)));

const commitExtend = e8.defineCommand({
  name: "magit-commit-extend",
  doc: "Amend staged changes to the last commit, without editing its message.\n\nWith a prefix argument do not update the committer date; without an argument update it.  The option magit-commit-extend-override-date can be used to inverse the meaning of the prefix argument.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const args = magitCommitAssert(commitArgs());
    if (!args) return;
    magitCommitAmendAssert();
    setThisCommitCommand("magit-commit-extend");
    editCommit(["--amend", "--no-edit", ...args], keepCommitterDate(overrideDate("magit-commit-extend-override-date", prefix)));
  },
});

const commitReword = e8.defineCommand({
  name: "magit-commit-reword",
  doc: "Reword the message of the last commit, without amending its tree.\n\nWith a prefix argument do not update the committer date; without an argument update it.  The option magit-commit-reword-override-date can be used to inverse the meaning of the prefix argument.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    magitCommitAmendAssert();
    const args = commitArgs();
    if (!args.includes("--allow-empty")) args.unshift("--allow-empty");
    setThisCommitCommand("magit-commit-reword");
    editCommit(["--amend", "--only", ...args], keepCommitterDate(overrideDate("magit-commit-reword-override-date", prefix)));
  },
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

e8.defineVariable({
  name: "magit-branch-read-upstream-first",
  doc: "Whether to read upstream before name of new branch when creating a branch.\n\nnil      Read the branch name first.\nt        Read the upstream first.\nfallback Read the upstream first, but if it turns out that the chosen value is not a valid upstream (because it cannot be resolved as an existing revision), then treat it as the name of the new branch and continue by reading the upstream next.",
  value: true,
});
e8.defineVariable({
  name: "magit-branch-prefer-remote-upstream",
  doc: "Whether to favor remote upstreams when creating new branches.\n\nWhen a new branch is created, then the branch, commit, or stash at point is suggested as the default starting point of the new branch, or if there is no such revision at point the current branch.  In either case the user may choose another starting point.\n\nIf the chosen starting point is a branch, then it may also be set as the upstream of the new branch, depending on the value of the Git variable branch.autoSetupMerge.  By default this is done for remote branches, but not for local branches.\n\nYou might prefer to always use some remote branch as upstream.  If the chosen starting point is (1) a local branch, (2) whose name matches a member of the value of this option, (3) the upstream of that local branch is a remote branch with the same name, and (4) that remote branch can be fast-forwarded to the local branch, then the chosen branch is used as starting point, but its own upstream is used as the upstream of the new branch.\n\nMembers of this option's value are treated as branch names that have to match exactly unless they contain a character that makes them invalid as a branch name.  Recommended characters to use to trigger interpretation as a regexp are \"*\" and \"^\".  Some other characters which you might expect to be invalid, actually are not, e.g., \".+$\" are all perfectly valid.  More precisely, if git check-ref-format --branch STRING exits with a non-zero status, then treat STRING as a regexp.\n\nAssuming the chosen branch matches these conditions you would end up with with e.g.:\n\n  feature --upstream--> origin/master\n\ninstead of\n\n  feature --upstream--> master --upstream--> origin/master\n\nWhich you prefer is a matter of personal preference.  If you do prefer the former, then you should add branches such as \"master\", \"next\", and \"maint\" to the value of this options.",
  value: [],
});
e8.defineVariable({
  name: "magit-branch-adjust-remote-upstream-alist",
  doc: "Alist of upstreams to be used when branching from remote branches.\n\nWhen creating a local branch from an ephemeral branch located on a remote, e.g., a feature or hotfix branch, then that remote branch should usually not be used as the upstream branch, since the push-remote already allows accessing it and having both the upstream and the push-remote reference the same related branch would be wasteful.  Instead a branch like \"maint\" or \"master\" should be used as the upstream.\n\nThis option allows specifying the branch that should be used as the upstream when branching certain remote branches.  The value is an alist of the form ((UPSTREAM . RULE)...).  The first element is used whose UPSTREAM exists and whose RULE matches the name of the new branch.  Subsequent elements are ignored.\n\nUPSTREAM is the branch to be used as the upstream for branches specified by RULE.  It can be a local or a remote branch.\n\nRULE can either be a regular expression, matching branches whose upstream should be the one specified by UPSTREAM.  Or it can be a list of the only branches that should *not* use UPSTREAM; all other branches will.  Matching is done after stripping the remote part of the name of the branch that is being branched from.\n\nIf you use a finite set of non-ephemeral branches across all your repositories, then you might use something like:\n\n  ((\"origin/master\" . (\"master\" \"next\" \"maint\")))\n\nOr if the names of all your ephemeral branches contain a slash, at least in some repositories, then a good value could be:\n\n  ((\"origin/master\" . \"/\"))\n\nUPSTREAM can be a local branch:\n\n  ((\"master\" . (\"master\" \"next\" \"maint\")))\n\nIf you use remote branches as UPSTREAM, then you might also want to set magit-branch-prefer-remote-upstream to a non-nil value.  However, I recommend that you use local branches as UPSTREAM.",
  value: [],
});
e8.defineVariable({
  name: "magit-branch-rename-push-target",
  doc: "Whether the push-remote setup is preserved when renaming a branch.\n\nThe command magit-branch-rename renames a branch named OLD to NEW.  This option controls how much of the push-remote setup is preserved when doing so.\n\nWhen nil, then preserve nothing and unset branch.OLD.pushRemote.\n\nWhen local-only, then first set branch.NEW.pushRemote to the same value as branch.OLD.pushRemote, provided the latter is actually set and unless the former already has another value.\n\nWhen t, then rename the branch named OLD on the remote specified by branch.OLD.pushRemote to NEW, provided OLD exists on that remote and unless NEW already exists on the remote.\n\nWhen forge-only and the forge package is available, then behave like t if the remote points to a repository on a forge (currently Github or Gitlab), otherwise like local-only.",
  value: true,
});
e8.defineVariable({
  name: "magit-branch-direct-configure",
  doc: "Whether the command magit-branch shows Git variables.\nWhen set to nil, no variables are displayed by this transient command, instead the sub-transient magit-branch-configure has to be used to view and change branch related variables.",
  value: true,
});

/**
 * The upstream of local BRANCH, when it tracks a remote branch of the same
 * name that can be fast-forwarded to it and FORCE or
 * magit-branch-prefer-remote-upstream names it, as
 * magit-get-indirect-upstream-branch.
 */
export function magitGetIndirectUpstreamBranch(branch: string, force = false): string | undefined {
  const remote = magitGet("branch", branch, "remote");
  if (!remote || remote === ".") return undefined;
  const prefer = e8.variable("magit-branch-prefer-remote-upstream");
  const optedIn =
    force ||
    (Array.isArray(prefer) &&
      prefer.some((p) => {
        const name = String(p);
        return gitOutput(["check-ref-format", "--branch", name]).exit === 0 ? name === branch : e8.stringMatch(name, branch) !== undefined;
      }));
  if (!optedIn) return undefined;
  const upstream = upstreamOf(branch);
  return upstream && upstream.slice(remote.length + 1) === branch && magitRevAncestorP(upstream, branch) ? upstream : undefined;
}

/**
 * Sets the upstream of BRANCH, made at START-POINT, to the indirect
 * upstream of START-POINT, or for a remote START-POINT to what
 * magit-branch-adjust-remote-upstream-alist names, as
 * magit-branch-maybe-adjust-upstream.
 */
export function magitBranchMaybeAdjustUpstream(branch: string, startPoint: string): void {
  let upstream = upstreamOf(branch) ? magitGetIndirectUpstreamBranch(startPoint) : undefined;
  if (!upstream && magitRemoteBranchP(startPoint)) {
    const name = magitSplitBranchName(startPoint)[1];
    const alist = e8.variable("magit-branch-adjust-remote-upstream-alist");
    for (const entry of Array.isArray(alist) ? alist : []) {
      if (!Array.isArray(entry)) continue;
      // (UPSTREAM . RULE): RULE a regexp, or a list of the branches not to use UPSTREAM.
      const [up, ...rest] = entry as e8.Value[];
      const rule = rest.length === 1 && typeof rest[0] === "string" ? rest[0] : rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
      const matches = Array.isArray(rule) ? !rule.map(String).includes(name) : e8.stringMatch(String(rule), name) !== undefined;
      if (magitBranchP(String(up)) && matches) {
        upstream = String(up);
        break;
      }
    }
  }
  if (upstream) gitOutput(["branch", `--set-upstream-to=${upstream}`, branch]);
}

const branchArgs = (): string[] => transientArgs("magit-branch");

const branchCreateCheckout = e8.defineCommand({
  name: "magit-branch-and-checkout",
  doc: "Create and checkout BRANCH at branch or revision START-POINT.",
  run: () => {
    const [branch, start] = magitBranchReadArgs("Create and checkout branch");
    if (/^stash@\{[0-9]+\}$/.test(start)) {
      runGit(["stash", "branch", branch, start]);
      return;
    }
    runGit(["checkout", ...branchArgs(), "-b", branch, start]);
    magitBranchMaybeAdjustUpstream(branch, start);
    refreshAll();
  },
});

const branchCreate = e8.defineCommand({
  name: "magit-branch-create",
  doc: "Create BRANCH at branch or revision START-POINT.",
  run: () => {
    const [branch, start] = magitBranchReadArgs("Create branch");
    runGit(["branch", branch, start]);
    magitBranchMaybeAdjustUpstream(branch, start);
    refreshAll();
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
  doc: "Rename the branch named OLD to NEW.\n\nWith a prefix argument FORCE, rename even if a branch named NEW already exists.\n\nIf branch.OLD.pushRemote is set, then unset it.  Depending on the value of magit-branch-rename-push-target (which see) maybe set branch.NEW.pushRemote and maybe rename the push-target on the remote.",
  params: [{ name: "force", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    let old = readBranch("Rename branch", localBranches(), magitLocalBranchAtPoint() ?? currentBranch());
    const name = magitReadStringNs(`Rename branch '${old}' to`, undefined, "magit-revision-history");
    const force = truthy(prefix);
    old = old.replace(/^heads\//, "");
    if (old === name) e8.userError("Old and new branch names are the same");
    gitOutput(["branch", force ? "-M" : "-m", old, name]);
    const pushTarget = e8.variable("magit-branch-rename-push-target");
    if (truthy(pushTarget)) {
      const remote = magitGetPushRemote(old);
      const oldSpecified = magitGet("branch", old, "pushRemote");
      const newSpecified = magitGet("branch", name, "pushRemote");
      if (oldSpecified && (force || !newSpecified)) magitSet(oldSpecified, "branch", name, "pushRemote");
      // forge-only is local-only here, as E8 has no forge.
      if (magitGetPushRemote(name) === remote && pushTarget !== "local-only" && pushTarget !== "forge-only") {
        const oldTarget = magitGetPushBranch(old, true);
        const newTarget = magitGetPushBranch(name, true);
        const target = magitGetPushRemote(name);
        if (oldTarget && !newTarget && target && magitYOrNP(`Also rename ${JSON.stringify(old)} to ${JSON.stringify(name)} on "${target}"?`))
          gitOutput(["push", "-v", target, `${oldTarget}:refs/heads/${name}`, `:refs/heads/${old}`]);
      }
    }
    magitSet(undefined, "branch", old, "pushRemote");
    refreshAll();
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

const stashBoth = e8.defineCommand({
  name: "magit-stash-both",
  doc: "Stash the changes in the index and the working tree, with a message.",
  run: () => {
    const msg = e8.readString(`Stash message (default: On${magitEllipsis()}:${magitEllipsis()}): `);
    runGit(["stash", "push", ...transientArgs("magit-stash"), ...(msg ? ["-m", msg] : [])]);
  },
});
// The stash at point is taken, or asked about, as magit-dwim-selection says for each command, as magit-read-stash does.
const stashApply = e8.defineCommand({ name: "magit-stash-apply", doc: "Apply a stash to the working tree.", run: () => void runGit(["stash", "apply", magitReadStash("Apply stash")]) });
const stashPop = e8.defineCommand({ name: "magit-stash-pop", doc: "Apply a stash to the working tree, on success remove it from the stash list.", run: () => void runGit(["stash", "pop", magitReadStash("Pop stash")]) });
const stashDrop = e8.defineCommand({
  name: "magit-stash-drop",
  doc: "Remove a stash from the stash list.\nWhen the region is active offer to drop all contained stashes.",
  run: () => {
    const values = magitRegionValues("stash") as string[] | undefined;
    const stashes = values && values.length > 0 ? (magitConfirm("drop-stashes", undefined, "Drop %d stashes", values) as string[]) : [magitReadStash("Drop stash")];
    for (const stash of [...stashes].reverse()) {
      e8.message(`Deleted refs/${stash} (was ${gitString(["rev-parse", "--short", stash]) ?? ""})`);
      gitOutput(["stash", "drop", stash]);
    }
    refreshAll();
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

/**
 * Makes a commit with OPTION, --fixup= or --squash= and the like, naming
 * COMMIT, as magit-commit-squash-internal: COMMIT is used at once when
 * CONFIRMED, or when it is not to be rebased, there is no prefix argument
 * and magit-commit-squash-confirm is nil; otherwise a commit is selected
 * in a log, the staged changes shown meanwhile as magit-commit-show-diff
 * says.  NOPATCH commits whatever there is; EDIT edits the message; REBASE
 * squashes the new commit into COMMIT at once.  Whether it made the commit.
 */
function magitCommitSquashInternal(option: string, commitIn: string | undefined, argsIn: string[], nopatch = false, edit = false, rebaseIn = false, confirmed = false): boolean {
  let commit = commitIn;
  let rebase = rebaseIn;
  const asserted = magitCommitAssert(argsIn, nopatch, !edit);
  if (!asserted) return false;
  let args = asserted;
  if (commit && rebase && !magitRevAncestorP(commit, "HEAD")) {
    const choice = magitReadCharCase(`${commit} isn't an ancestor of HEAD.  `, false, [
      ["c", "[c]reate without rebasing", "create"],
      ["s", "[s]elect other", "select"],
      ["a", "[a]bort", "abort"],
    ]);
    if (choice === "abort") e8.userError("Quit");
    if (choice === "create") rebase = false;
    else commit = undefined;
  }
  if (commit) commit = magitRebaseInteractiveAssert(commit, true);
  if (commit && (confirmed || !(rebase || prefixArgP() || truthy(e8.variable("magit-commit-squash-confirm"))))) {
    args = [edit ? "--edit" : "--no-edit", `${option}${commit}`, ...args];
    if (rebase) runGit(["commit", "--no-gpg-sign", ...args.filter((a) => !a.startsWith("--gpg-sign="))]);
    else e8.letBind({ "magit-commit-show-diff": false }, () => editCommit(args));
    return true;
  }
  const winconf = truthy(e8.variable("magit-commit-show-diff")) ? e8.currentWindowConfiguration() : undefined;
  magitLogSelect(
    (picked) => {
      if (magitCommitSquashInternal(option, picked, argsIn, nopatch, edit, rebase, true) && rebase) {
        magitCommitAmendAssert(picked);
        magitRebaseInteractive1(picked, ["--autosquash", "--autostash", "--keep-empty"], "", "true", false, true);
      }
      if (winconf) e8.setWindowConfiguration(winconf);
    },
    `Type . on a commit to ${option.slice(2)} into it, or C-c C-k to abort`,
    undefined,
    undefined,
    undefined,
    commit,
  );
  if (truthy(e8.variable("magit-commit-show-diff")) && !nopatch) e8.letBind({ "magit-display-buffer-noselect": true }, () => e8.call("magit-diff-staged" as e8.CommandName));
  return false;
}

/** A command making a commit with OPTION into the commit at point or one selected, as magit-commit-fixup and its kin. */
function fixupCommand(name: string, doc: string, option: string, nopatch: boolean, edit: boolean, rebase: boolean) {
  return e8.defineCommand({
    name,
    doc,
    run: () => {
      setThisCommitCommand(name);
      magitCommitSquashInternal(option, magitCommitAtPoint(), commitArgs(), nopatch, edit, rebase);
    },
  });
}

const squashDoc = (what: string, more = ""): string =>
  `${what}\n\nIf there is a reachable commit at point, target that.  Otherwise prompt for a commit.  If magit-commit-squash-confirm is non-nil, always make the user explicitly select a commit, in a buffer dedicated to that task.${more}`;
const commitFixup = fixupCommand("magit-commit-fixup", squashDoc("Create a fixup commit, leaving the original commit message untouched."), "--fixup=", false, false, false);
const commitSquash = fixupCommand("magit-commit-squash", squashDoc("Create a squash commit, without the user authoring a commit message.", "\n\nDuring a later rebase, when this commit gets squashed into its targeted commit, the original message of the targeted commit is used as the initial message of the squashed commit, and the user is given a chance to edit it."), "--squash=", false, false, false);
const commitAlter = fixupCommand("magit-commit-alter", squashDoc("Create a squash commit, authoring the final message now."), "--fixup=amend:", false, true, false);
const commitAugment = fixupCommand("magit-commit-augment", squashDoc("Create a squash commit, authoring a new temporary message."), "--squash=", false, true, false);
const commitRevise = fixupCommand("magit-commit-revise", squashDoc("Reword the message of an existing commit, without editing its tree."), "--fixup=reword:", true, true, false);
const commitInstantFixup = fixupCommand("magit-commit-instant-fixup", squashDoc("Create a fixup commit, and immediately combine it with its target.", "\n\nLike magit-commit-fixup but also run a --autofixup rebase."), "--fixup=", false, false, true);
const commitInstantSquash = fixupCommand("magit-commit-instant-squash", squashDoc("Create a squash commit, and immediately combine it with its target.", "\n\nLike magit-commit-squash but also run a --autofixup rebase."), "--squash=", false, false, true);

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

/** The branch the configure menu sets variables of, as magit-branch-configure's transient scope. */
let branchConfigureScope: string | undefined;
const branchScope = (): string => branchConfigureScope ?? branchOrHead();

const setVariables = e8.defineCommand({
  name: "magit-branch-configure",
  doc: "Configure a branch.\nWith a prefix argument, or when called from magit-branch with magit-branch-direct-configure, read the branch; else the current branch.",
  run: () => {
    const fromBranch = truthy(e8.variable("magit-branch-direct-configure")) && e8.variable("transient-current-command") === "magit-branch";
    const current = !prefixArgP() && !fromBranch ? currentBranch() : undefined;
    branchConfigureScope = current ?? readBranch("Configure branch", localBranches(), magitLocalBranchAtPoint() ?? currentBranch());
    try {
      e8.call(branchConfigureMenu);
    } finally {
      branchConfigureScope = undefined;
    }
  },
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

e8.defineVariable({ name: "magit-pull-or-fetch", doc: "Whether magit-pull also offers some fetch suffixes.", value: false });

const pullMenu = transientDefinePrefix("magit-pull", {
  doc: "Pull from another repository.",
  groups: [
    { description: () => (truthy(e8.variable("magit-pull-or-fetch")) ? "Pull arguments" : "Arguments"), items: [["-f", "Fast-forward only", "--ff-only"], ["-r", "Rebase local commits", "--rebase"], ["-F", "Force", "--force"]] },
    {
      description: () => `Pull into ${branchOrHead()} from`,
      items: [
        ["p", () => { const r = pushRemoteOf(currentBranch()); return r ? `${r}/${branchOrHead()}` : "pushRemote, setting that"; }, pullPushRemote],
        ["u", () => upstreamOf(currentBranch()) ?? "@{upstream}, setting that", pullUpstream],
        ["e", "elsewhere", pullElsewhere],
      ],
    },
    // With magit-pull-or-fetch, some of magit-fetch's suffixes too.
    { description: "Fetch from", if: () => truthy(e8.variable("magit-pull-or-fetch")), items: [["f", "remotes", "magit-fetch-all-no-prune"], ["F", "remotes and prune", "magit-fetch-all-prune"]] },
    { description: "Fetch", if: () => truthy(e8.variable("magit-pull-or-fetch")), items: [["o", "another branch", "magit-fetch-branch"], ["s", "explicit refspec", "magit-fetch-refspec"], ["m", "submodules", "magit-fetch-modules"]] },
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
  doc: "Checkout an existing or new local branch.\n\nRead a branch name from the user offering all local branches and a subset of remote branches as candidates.  Omit remote branches for which a local branch by the same name exists from the list of candidates.  The user can also enter a completely new branch name.\n\n- If the user selects an existing local branch, then check that out.\n\n- If the user selects a remote branch, then create and checkout a new local branch with the same name.  Configure the selected remote branch as push target.\n\n- If the user enters a new branch name, then create and check that out, after also reading the starting-point from the user.\n\nIn the latter two cases the upstream is also set.  Whether it is set to the chosen START-POINT or something else depends on the value of magit-branch-adjust-remote-upstream-alist, just like when using magit-branch-and-checkout.",
  run: () => {
    const current = currentBranch();
    const local = localBranches();
    const remote = remoteBranches().filter((b) => {
      const m = /^[^/]+\//.exec(b);
      return m !== null && ![...local, "HEAD"].includes(b.slice(m[0].length));
    });
    const choices = [...local.filter((b) => b !== current), ...remote];
    const atpoint = magitBranchAtPoint();
    const stripped = atpoint && /^[^/]+\//.test(atpoint) ? atpoint.replace(/^[^/]+\//, "") : undefined;
    const def = atpoint && choices.includes(atpoint) ? atpoint : stripped && choices.includes(stripped) ? stripped : undefined;
    const choice = magitCompletingRead("Checkout branch", choices, { history: "magit-revision-history", def }) ?? e8.userError("Nothing selected");
    let branch = choice;
    let start: string | undefined;
    if (remote.includes(choice)) [branch, start] = [choice.replace(/^[^/]+\//, ""), choice];
    else if (!local.includes(choice)) start = magitReadStartingPoint("Create", choice);
    if (!start) {
      runGit(["checkout", ...branchArgs(), branch.replace(/^heads\//, "")]);
      return;
    }
    if (magitAnythingModifiedP()) e8.userError("Cannot checkout when there are uncommitted changes");
    gitOutput(["checkout", ...branchArgs(), "-b", branch, start]);
    magitBranchMaybeAdjustUpstream(branch, start);
    if (magitRemoteBranchP(start)) {
      const [r, remoteBranch] = magitSplitBranchName(start);
      if (branch === remoteBranch && r !== magitGet("remote.pushDefault")) magitSet(r, "branch", branch, "pushRemote");
    }
    refreshAll();
  },
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

/** The groups of the branch configure menu, for the branch SCOPE names, as magit-branch-configure's and magit-branch's. */
function branchConfigureGroups(scope: () => string, direct = false) {
  const scoped = () => !direct || (truthy(e8.variable("magit-branch-direct-configure")) && currentBranch() !== undefined);
  return [
    {
      description: () => e8.concat(face("Configure ", "transient-heading"), face(scope(), "magit-branch-local")),
      if: scoped,
      items: [
        branchVariable("d", () => `branch.${scope()}.description`, () => e8.readString("Description: ")),
        branchVariable("u", () => `branch.${scope()}.merge`, () => {
          const up = readBranch("Upstream", remoteBranches());
          const [remote, ...rest] = up.split("/");
          gitOutput(["config", `branch.${scope()}.remote`, remote]);
          return `refs/heads/${rest.join("/")}`;
        }),
        [" ", { info: () => e8.concat(face(`branch.${scope()}.remote`, "transient-argument"), " ", ((r) => (r === undefined ? face("unset", "transient-inactive-value") : face(r, "transient-value")))(gitString(["config", `branch.${scope()}.remote`]))) }],
        configVariable("r", () => `branch.${scope()}.rebase`, () => ["true", "false"], "false"),
        configVariable("p", () => `branch.${scope()}.pushRemote`, () => remotes()),
      ],
    },
    {
      description: "Configure repository defaults",
      if: () => !direct || truthy(e8.variable("magit-branch-direct-configure")),
      items: [configVariable("R", () => "pull.rebase", () => ["true", "false"], "false"), configVariable("P", () => "remote.pushDefault", () => remotes()), ["B", "Update default branch", updateDefaultBranch]],
    },
  ] as Group[];
}

const branchConfigureMenu = transientDefinePrefix("magit:branch-configure", {
  doc: "Configure a branch.",
  groups: [
    ...branchConfigureGroups(branchScope),
    { description: "Configure branch creation", items: [configVariable("a m", () => "branch.autoSetupMerge", () => ["always", "true", "false"], "true"), configVariable("a r", () => "branch.autoSetupRebase", () => ["always", "local", "remote", "never"], "never")] },
  ],
});

const branchMenu = transientDefinePrefix("magit-branch", {
  doc: "Add, configure or remove a branch.",
  groups: [
    ...branchConfigureGroups(branchOrHead, true),
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
  value: magitLogPrefixValue,
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

/** Resets HEAD and the index to COMMIT, and with HARD the working tree too, as magit-reset-quickly. */
export function magitResetQuickly(commit: string, hard = false): void {
  runGit(["reset", hard ? "--hard" : "--mixed", commit, "--"]);
}

export const magitResetQuicklyCommand = e8.defineCommand({
  name: "magit-reset-quickly",
  doc: "Reset the `HEAD' and index to COMMIT, and possibly the working tree.\nWith a prefix argument reset the working tree otherwise don't.\n\n(git reset --mixed|--hard COMMIT)",
  params: [{ name: "hard", kind: "prefix" }],
  run: (hard: e8.Value) => {
    const h = truthy(hard);
    const branch = currentBranch() ?? "detached head";
    magitResetQuickly(magitReadBranchOrCommit(h ? `Hard reset ${branch} to` : `Reset ${branch} to`), h);
  },
});

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

// The menu does not start with magitDiffPrefixValue, as magit-diff's transient-init-value would have
// it: E8's transient takes any argument starting with -- as the value of the -- infix, so --stat
// would show as the files the diff is limited to.
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
    const s = magitReadStash("Branch stash");
    const name = magitReadStringNs("Branch name");
    runGit(["stash", "branch", name, s]);
  },
});
const stashBranchHere = e8.defineCommand({
  name: "magit-stash-branch-here",
  doc: "Create a branch at HEAD, check it out, apply a stash to it and drop the stash.",
  run: () => {
    const s = magitReadStash("Branch stash");
    const name = magitReadStringNs("Branch name");
    if (runGit(["checkout", "-b", name]) && runGit(["stash", "apply", s])) runGit(["stash", "drop", s]);
  },
});
const stashFormatPatch = e8.defineCommand({
  name: "magit-stash-format-patch",
  doc: "Write a stash as a patch file.",
  run: () => {
    const s = magitReadStash("Create patch from stash");
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
// The manual and the version, after magit-mode.el's magit-info and magit.el's magit-version.

e8.defineVariable({ name: "magit-manual-url", doc: "Where Magit's manual is on the web, which magit-info opens while E8 has no Info reader.", value: "https://magit.vc/manual/magit/" });

/**
 * Visits the Magit manual, as magit-info: in Info if E8 has an Info reader,
 * else the manual on the web, with browse-url if there is one, else with
 * the system's opener (open, xdg-open), saying where it is.
 */
export function magitInfo(): void {
  if (e8.fboundp("info")) return void e8.funcall("info", "magit");
  const url = String(e8.variable("magit-manual-url"));
  if (e8.fboundp("browse-url")) return void e8.funcall("browse-url", url);
  if (!truthy(e8.variable("noninteractive"))) {
    const opener = e8.callProcess(["uname", "-s"]).output.trim() === "Darwin" ? "open" : "xdg-open";
    e8.makeProcess({ name: "magit-info", command: [opener, url] });
  }
  e8.message(`The Magit manual is at ${url}`);
}
const help = e8.defineCommand({ name: "magit-info", doc: "Visit the Magit manual.", run: () => magitInfo() });

/** The directory Magit's package was loaded from: the first in load-path holding magit.ts, as locate-library finds magit.el. */
function magitPackageDirectory(): string | undefined {
  const path = (e8.variable("load-path") as string[] | null) ?? [];
  return path.map((d) => e8.fileNameAsDirectory(e8.expandFileName(String(d)))).find((d) => e8.fileExistsP(`${d}magit.ts`));
}

/** The system's type, as Emacs's system-type names it. */
function systemType(): string {
  const uname = e8.callProcess(["uname", "-s"]).output.trim();
  return uname === "Darwin" ? "darwin" : uname === "Linux" ? "gnu/linux" : uname.toLowerCase();
}

/**
 * The version of Magit in use, as magit-version: git describe in its
 * package directory if that is Magit's repository, as a package installed
 * from git is, else the version e8-package.json gives, else the version a
 * directory named magit-VERSION says. Undefined, with a message, if none.
 * With PRINT, also says the versions of Magit, Git and E8, and the system.
 */
export function magitVersion(print = false): string | undefined {
  const dir = magitPackageDirectory();
  let version: string | undefined;
  if (dir) {
    if (e8.fileExistsP(`${dir}.git`)) {
      const r = e8.callProcess(["git", "describe", "--tags", "--dirty", "--always"], { directory: dir });
      if (r.exit === 0) version = r.output.trim();
    }
    if (!version && e8.fileExistsP(`${dir}e8-package.json`)) {
      try {
        const v = (JSON.parse(e8.readTextFile(`${dir}e8-package.json`)) as { version?: unknown }).version;
        if (typeof v === "string") version = v;
      } catch {
        // A manifest that does not parse has no version.
      }
    }
    if (!version) version = /^(?:e8-)?magit-([0-9].*)$/.exec(e8.fileNameNondirectory(e8.directoryFileName(dir)))?.[1];
  }
  if (!version) {
    if (e8.getenv("CI") !== "true") e8.message(`Cannot determine Magit's version ${JSON.stringify(dir ?? null)}`);
    return undefined;
  }
  if (print) e8.message(magitVersionString(version));
  return version;
}

/** What magit-version prints: the versions of Magit, Git and E8, and the system, as Magit's names Magit, Transient, Git and Emacs; Transient ships with E8. */
const magitVersionString = (version: string): string => {
  let git = "(unknown)";
  try {
    git = magitGitVersion();
  } catch {
    // No git.
  }
  return `Magit ${version}, Git ${git}, E8 ${String(e8.variable("e8-version"))}, ${systemType()}`;
};

export const magitVersionCommand = e8.defineCommand({
  name: "magit-version",
  doc: "Show the version of Magit currently in use, with the versions of Git and E8, and put it in the kill ring.  With a prefix argument insert it into the current buffer instead.",
  params: [{ name: "here", kind: "prefix" }],
  run: (here: e8.Value) => {
    const version = magitVersion();
    if (version === undefined) return;
    const text = magitVersionString(version);
    e8.killNew(text);
    if (truthy(here)) e8.insert(text);
    else e8.message(text);
  },
});

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
        { items: [["a", "Apply", magitApplyCommand], ["v", "Reverse", magitReverseCommand], ["k", "Discard", magitDiscardCommand]] },
        { items: [["s", "Stage", magitStageCommand], ["u", "Unstage", magitUnstageCommand]] },
        { items: [["S", "Stage all", magitStageModifiedCommand], ["U", "Unstage all", magitUnstageAllCommand]] },
      ],
    },
    {
      description: "Essential commands",
      items: [
        {
          padKeys: true,
          items: [
            ["g", "Refresh current buffer", refreshCommand],
            ["q", "Bury current buffer", magitModeBuryBuffer],
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
  ["s", magitStageFilesCommand],
  ["S", magitStageModifiedCommand],
  ["u", magitUnstageFilesCommand],
  ["U", magitUnstageAllCommand],
  ["k", magitDeleteThing],
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
  ["x", magitResetQuicklyCommand],
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
  ["q", magitModeBuryBuffer],
];
for (const [key, command] of bindings) e8.defineKey("magit-mode-map", key, command as e8.DefinedCommand);

// M-x magit is magit-status, as Magit's defalias makes it.
e8.defalias("magit", "magit-status");

e8.defineVariable({
  name: "magit-define-global-key-bindings",
  doc: "Which set of key bindings to add to the global keymap, if any.\n\nThis option controls which set of Magit key bindings, if any, may be added to the global keymap, even before Magit is first used in the current Emacs session.\n\nIf the value is nil, no bindings are added.\n\nIf default, maybe add:\n\n    C-x g     magit-status\n    C-x M-g   magit-dispatch\n    C-c M-g   magit-file-dispatch\n\nIf recommended, maybe add:\n\n    C-x g     magit-status\n    C-c g     magit-dispatch\n    C-c f     magit-file-dispatch\n\n    These bindings are strongly recommended, but we cannot use them by default, because the C-c <LETTER> namespace is strictly reserved for bindings added by the user.\n\nThe bindings in the chosen set may be added when after-init-hook is run.  Each binding is added if, and only if, at that time no other key is bound to the same command, and no other command is bound to the same key.  In other words we try to avoid adding bindings that are unnecessary, as well as bindings that conflict with other bindings.\n\nAs E8 cannot tell whether after-init-hook has run, they are also added when Magit is loaded, so the variable must be set before then to have an effect then.",
  value: "default",
});

/**
 * Adds the global key bindings magit-define-global-key-bindings names,
 * each only if its key and command are unbound, or with FORCE, as
 * magit-maybe-define-global-key-bindings.
 */
export function magitMaybeDefineGlobalKeyBindings(force = false): void {
  const set = e8.variable("magit-define-global-key-bindings");
  if (!truthy(set)) return;
  const bindings: [string, string][] =
    set === "recommended"
      ? [["C-x g", "magit-status"], ["C-c g", "magit-dispatch"], ["C-c f", "magit-file-dispatch"]]
      : [["C-x g", "magit-status"], ["C-x M-g", "magit-dispatch"], ["C-c M-g", "magit-file-dispatch"]];
  for (const [key, command] of bindings) {
    const bound = e8.lookupKey("global-map", key);
    if (force || ((bound === undefined || bound === null) && !e8.whereIsInternal(command).some((k) => e8.lookupKey("global-map", k) === command))) e8.bindKey(key, command as e8.CommandName);
  }
}
e8.defun("magit-maybe-define-global-key-bindings", (force?: e8.Value) => magitMaybeDefineGlobalKeyBindings(truthy(force ?? null)));
magitMaybeDefineGlobalKeyBindings();
e8.addHook("after-init-hook", () => magitMaybeDefineGlobalKeyBindings());

void sectionAt;
