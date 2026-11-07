// SPDX-License-Identifier: GPL-3.0-or-later
//
// Additional functionality for Magit, after magit-extras.el: launching
// gitk, git gui and git gui blame; magit-project-status, bound to m in
// project-prefix-map and offered by C-x p p; moving by lines with
// Magit's shift selection; removing untracked files (magit-clean);
// changing the dates of commits (magit-reshelve-since); the revision
// stack, which C-w and M-w push revisions onto and C-c C-w in a commit
// message pops them from; switching to a buffer of the repository; and
// aborting whatever is going on (magit-abort-dwim).
//
// Left out: magit-generate-changelog, magit-add-change-log-entry and
// magit-add-change-log-entry-other-window, which build on add-log.el and
// diff-mode's diff-add-log-current-defuns, which E8 does not have; the
// git-mergetool menu's settings (it runs git mergetool --gui); and
// magit-edit-line-commit and magit-diff-edit-hunk-commit, which come
// with blame.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, magitSectionInternalRegionP, magitSectionMatch, magitSectionParentValue, magitSectionPositionInHeadingP } from "magit-section";
import { forwardLine, truthy } from "subr";
import { transientArgs } from "transient";
import { current as projectCurrent } from "project";
import { magitCompletingRead } from "magit-base";
import {
  magitAmInProgressP,
  magitBisectInProgressP,
  magitCommitP,
  magitFileRelativeName,
  magitFileTrackedP,
  magitGetCurrentBranch,
  magitGitExecutable,
  magitGitLines,
  magitGitRun,
  magitGitString,
  magitMergeInProgressP,
  magitReadBranchOrCommit,
  magitRebaseInProgressP,
  magitRefP,
  magitRevFormat,
  magitRevParse,
  magitSequencerInProgressP,
  magitToplevel,
  magitToplevelOrError,
} from "magit-git";
import { magitRunGit, magitStartGitWith } from "magit-process";
import { magitBufferInfo, magitDisplayBuffer, magitGetModeBuffer } from "magit-mode";
import { magitStatusSetupBuffer } from "magit-status";
import { magitLogSelect } from "magit-log";
import { magitReadFileFromRev } from "magit-files";

e8.defineVariable({ name: "magit-gitk-executable", doc: "The Gitk executable.", value: "gitk" });

/** PROGRAM's file along exec-path, as executable-find. */
function executableFind(program: string): string | undefined {
  if (program.includes("/")) return e8.fileExecutableP(program) ? program : undefined;
  const path = (e8.variable("exec-path") as string[] | null) ?? (e8.getenv("PATH") ?? "").split(":");
  return path.map((d) => e8.expandFileName(program, d)).find((f) => e8.fileExecutableP(f));
}

/** Starts PROGRAM with ARGS in the repository, not waiting for it, as magit-process-file with destination 0. */
function launch(program: string, args: string[], directory = String(e8.variable("default-directory"))): void {
  if (!executableFind(program)) e8.userError(`Searching for program: No such file or directory, ${program}`);
  e8.makeProcess({ name: e8.fileNameNondirectory(program), command: [program, ...args], directory });
}

/** Runs BODY with default-directory the repository's top, as magit-with-toplevel. */
function withToplevel<T>(body: () => T): T {
  return e8.letBind({ "default-directory": magitToplevelOrError() }, body);
}

// Git tools.

/**
 * Runs git gui blame on FILENAME at COMMIT, centred on LINENUM if given,
 * as magit-run-git-gui-blame.
 */
export function magitRunGitGuiBlame(commit: string, filename: string, linenum?: number): void {
  launch(magitGitExecutable(), ["gui", "blame", ...(linenum !== undefined ? [`--line=${linenum}`] : []), commit, filename], magitToplevelOrError());
}

export const magitRunGitGuiBlameCommand = e8.defineCommand({
  name: "magit-run-git-gui-blame",
  doc:
    "Run `git gui blame' on the given FILENAME and COMMIT.\nInteractively run it for the current file and the `HEAD', with a\nprefix or when the current file cannot be determined let the user\nchoose.  When the current buffer is visiting FILENAME instruct\nblame to center around the line point is on.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    let revision: string;
    let filename = magitFileRelativeName();
    if (filename !== undefined && !magitFileTrackedP(filename)) filename = undefined;
    if (truthy(prefix) || filename === undefined) {
      revision = magitReadBranchOrCommit("Blame from revision");
      filename = magitReadFileFromRev(revision, "Blame file");
    } else revision = "HEAD";
    const visiting = e8.bufferFileName() !== undefined && magitFileRelativeName() === filename;
    magitRunGitGuiBlame(revision, filename, visiting ? e8.lineOf(e8.point()) + 1 : undefined);
  },
});

export const magitRunGitGui = e8.defineCommand({ name: "magit-run-git-gui", doc: "Run `git gui' for the current git repository.", run: () => launch(magitGitExecutable(), ["gui"], magitToplevelOrError()) });
const gitk = (): string => String(e8.variable("magit-gitk-executable") ?? "gitk");
export const magitRunGitk = e8.defineCommand({ name: "magit-run-gitk", doc: "Run `gitk' in the current repository.", run: () => launch(gitk(), []) });
export const magitRunGitkBranches = e8.defineCommand({ name: "magit-run-gitk-branches", doc: "Run `gitk --branches' in the current repository.", run: () => launch(gitk(), ["--branches"]) });
export const magitRunGitkAll = e8.defineCommand({ name: "magit-run-gitk-all", doc: "Run `gitk --all' in the current repository.", run: () => launch(gitk(), ["--all"]) });
export const magitGitMergetool = e8.defineCommand({ name: "magit-git-mergetool", doc: "Resolve conflicts using \"git mergetool --gui\".", run: () => launch(magitGitExecutable(), ["mergetool", "--gui"], magitToplevelOrError()) });

// Emacs tools.

export const magitProjectStatus = e8.defineCommand({
  name: "magit-project-status",
  doc: "Run `magit-status' in the current project's root.",
  run: () => {
    const root = projectCurrent() ?? e8.fileNameAsDirectory(e8.expandFileName(e8.readFileName("Select project: ", { mustMatch: true })));
    magitStatusSetupBuffer(root);
  },
});

e8.defineVariable({
  name: "magit-bind-magit-project-status",
  doc: "Whether to bind \"m\" to `magit-project-status' in `project-prefix-map'.\nIf so, then an entry is added to `project-switch-commands' as\nwell.  If you want to use another key, then you must set this\nto nil before loading Magit to prevent \"m\" from being bound.",
  value: true,
});

/** The value project.ts gives project-switch-commands, to leave alone one a config changed. */
const projectSwitchCommandsDefault = [
  ["f", "project-find-file", "Find file"],
  ["d", "project-find-dir", "Find directory"],
  ["D", "project-dired", "Dired"],
  ["b", "project-switch-to-buffer", "Buffer"],
  ["g", "project-find-regexp", "Find regexp"],
  ["k", "project-kill-buffers", "Kill buffers"],
];
if (truthy(e8.variable("magit-bind-magit-project-status")) && JSON.stringify(e8.variable("project-switch-commands")) === JSON.stringify(projectSwitchCommandsDefault)) {
  e8.defineKey("project-prefix-map", "m", magitProjectStatus);
  e8.setDefault("project-switch-commands", [...projectSwitchCommandsDefault, ["m", "magit-project-status", "Magit"]]);
}

// Shift selection.

/** Whether point is in the body of a hunk, as magit-diff-inside-hunk-body-p. */
function magitDiffInsideHunkBodyP(): boolean {
  const s = currentSection();
  return s !== undefined && magitSectionMatch("hunk", s) && e8.point() > s.content;
}

/** Whether the region was active before the command running, as pre-command-hook finds it. */
let markActiveBefore = false;
e8.addHook("pre-command-hook", () => {
  markActiveBefore = e8.regionActive();
});

/**
 * Whether this move starts a shift selection, as
 * magit--turn-on-shift-select-mode-p: E8 activates the mark where point
 * is for a shifted key before running the command, so a region active
 * and empty that was not active before the command is one just begun.
 */
const magitTurnOnShiftSelectModeP = (): boolean => !markActiveBefore && e8.regionActive() && e8.mark() === e8.point();

function magitMoveLine(command: "previous-line" | "next-line", arg: number): void {
  const stay = magitDiffInsideHunkBodyP() || magitSectionPositionInHeadingP();
  if (stay && arg === 1 && magitTurnOnShiftSelectModeP()) return;
  e8.call(command, stay ? Math.max(arg - 1, 1) : arg);
}

export const magitPreviousLine = e8.defineCommand({
  name: "magit-previous-line",
  doc:
    "Like `previous-line' but with Magit-specific shift-selection.\n\nMagit's selection mechanism is based on the region but selects an\narea that is larger than the region.  This causes `previous-line'\nwhen invoked while holding the shift key to move up one line and\nthereby select two lines.  When invoked inside a hunk body this\ncommand does not move point on the first invocation and thereby\nit only selects a single line.  Which inconsistency you prefer\nis a matter of preference.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => magitMoveLine("previous-line", arg ?? 1),
});

export const magitNextLine = e8.defineCommand({
  name: "magit-next-line",
  doc:
    "Like `next-line' but with Magit-specific shift-selection.\n\nMagit's selection mechanism is based on the region but selects\nan area that is larger than the region.  This causes `next-line'\nwhen invoked while holding the shift key to move down one line\nand thereby select two lines.  When invoked inside a hunk body\nthis command does not move point on the first invocation and\nthereby it only selects a single line.  Which inconsistency you\nprefer is a matter of preference.",
  params: [{ name: "arg", kind: "count" }],
  shiftSelect: true,
  run: (arg: number) => magitMoveLine("next-line", arg ?? 1),
});

// Clean.

/** Removes untracked files, ignored ones too with ARG 4, only ignored ones with 16, as magit-clean. */
export function magitClean(arg = 1): void {
  if (!e8.yesOrNoP(`Remove ${arg === 1 ? "untracked" : arg === 4 ? "untracked and ignored" : "ignored"} files? `)) return;
  if (e8.fboundp("magit-wip-commit-before-change")) e8.funcall("magit-wip-commit-before-change");
  magitRunGit("clean", "-f", "-d", arg === 4 ? "-x" : arg === 16 ? "-X" : undefined);
}

export const magitCleanCommand = e8.defineCommand({
  name: "magit-clean",
  doc: "Remove untracked files from the working tree.\nWith a prefix argument also remove ignored files,\nwith two prefix arguments remove ignored files only.\n\n(git clean -f -d [-x|-X])",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => magitClean(arg ?? 1),
});

// Reshelve.

e8.defineVariable({
  name: "magit-reshelve-since-committer-only",
  doc: "Whether `magit-reshelve-since' changes only the committer dates.\nOtherwise the author dates are also changed.",
  value: false,
});
e8.defineVariable({ name: "magit--reshelve-history", doc: "The dates answered to magit-reshelve-since, newest first.", value: [] });

/** TIME's minute, OFFSET minutes on, formatted as "%F %T %z", as magit-reshelve-since's adjust. */
function reshelveAdjust(time: number, offset: number): string {
  const t = Math.floor(time);
  const minute = t + offset * 60 - new Date(t * 1000).getSeconds();
  const m = new Date(minute * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -m.getTimezoneOffset();
  const zone = `${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())} ${pad(m.getHours())}:${pad(m.getMinutes())}:${pad(m.getSeconds())} ${zone}`;
}

/** Seconds since the epoch of a date as "%F %T %z" writes it, or as Date.parse reads it, as date-to-time. */
function dateToTime(date: string): number {
  const m = /^\s*(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?\s*(?:([+-])(\d\d):?(\d\d)|(Z|UTC))?\s*$/.exec(date);
  if (m) {
    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? 0, m[5] ?? 0, m[6] ?? 0].map(Number);
    const utc = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
    if (m[7]) return utc - (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 3600 + Number(m[9]) * 60);
    if (m[10]) return utc;
    return new Date(y, mo - 1, d, h, mi, s).getTime() / 1000;
  }
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) e8.signal("error", `Invalid date: ${date}`);
  return parsed / 1000;
}

/**
 * Changes the author and committer dates of the commits since COMMIT, as
 * magit-reshelve-since: without COMMIT, selects it from a log first.
 * KEYID signs the commits.
 */
export function magitReshelveSince(commit: string | undefined, keyid?: string): void {
  const current = magitGetCurrentBranch() ?? e8.userError("Refusing to reshelve detached head");
  const backup = `refs/original/refs/heads/${current}`;
  if (!commit) {
    if (magitRefP(backup) && !e8.yOrNP(`Backup ref ${backup} already exists.  Override? `)) e8.userError("Abort");
    magitLogSelect((rev) => magitReshelveSince(rev, keyid), "Type . on a commit to reshelve it and the commits above it,");
    return;
  }
  const start = `${commit}^`;
  const range = `${start}..${current}`;
  const timeRev = reshelveAdjust(Number(magitRevFormat("%at", start) ?? 0), 1);
  const timeNow = reshelveAdjust(Date.now() / 1000, -Number(magitGitString("rev-list", "--count", range) ?? 0));
  e8.setVariable("magit--reshelve-history", [timeRev, ...((e8.variable("magit--reshelve-history") as string[] | null) ?? [])]);
  let date = Math.floor(dateToTime(e8.readString("Date for first commit: ", { initial: timeNow, history: "magit--reshelve-history" })));
  const committerOnly = truthy(e8.variable("magit-reshelve-since-committer-only"));
  const cases = magitGitLines("rev-list", "--reverse", range)
    .map((rev) => {
      const entry = `${rev}) ${committerOnly ? "" : `export GIT_AUTHOR_DATE="${date}"; `}export GIT_COMMITTER_DATE="${date}";;`;
      date += 60;
      return entry;
    })
    .join(" ");
  withToplevel(() =>
    magitStartGitWith(["filter-branch", "--force", "--env-filter", `case $GIT_COMMIT in ${cases}\nesac`, keyid ? ["--commit-filter", `git commit-tree --gpg-sign=${keyid} "$@";`] : undefined, range, "--"], {
      env: { FILTER_BRANCH_SQUELCH_WARNING: "1" },
      then: (exit) => {
        if (exit === 0) withToplevel(() => magitRunGit("update-ref", "-d", backup));
      },
    }),
  );
}

export const magitReshelveSinceCommand = e8.defineCommand({
  name: "magit-reshelve-since",
  doc:
    "Change the author and committer dates of the commits since COMMIT.\n\nAsk the user for the first reachable commit whose dates should\nbe changed.  Then read the new date for that commit.  The initial\nminibuffer input and the previous history element offer good\nvalues.  The next commit will be created one minute later and so\non.\n\nThis command is only intended for interactive use and should only\nbe used on highly rearranged and unpublished history.\n\nIf KEYID is non-nil, then use that to sign all reshelved commits.\nInteractively use the value of the \"--gpg-sign\" option in the\nlist returned by `magit-rebase-arguments'.",
  run: () => {
    const sign = transientArgs("magit-rebase").find((a) => a.startsWith("--gpg-sign="));
    magitReshelveSince(undefined, sign?.slice("--gpg-sign=".length));
  },
});

// The revision stack.

e8.defineVariable({ name: "magit-revision-stack", doc: "Revisions saved by magit-copy-section-value and magit-copy-buffer-revision, newest first, each [HASH, TOPLEVEL].", value: [] });
e8.defineVariable({
  name: "magit-pop-revision-stack-format",
  doc:
    "Control how `magit-pop-revision-stack' inserts a revision.\n\nThe command `magit-pop-revision-stack' inserts a representation\nof the revision last pushed to the `magit-revision-stack' into\nthe current buffer.  It inserts text at point and/or near the end\nof the buffer, and removes the consumed revision from the stack.\n\nThe entries on the stack have the format (HASH TOPLEVEL) and this\noption has the format (POINT-FORMAT EOB-FORMAT INDEX-REGEXP), all\nof which may be nil or a string (though either one of EOB-FORMAT\nor POINT-FORMAT should be a string, and if INDEX-REGEXP is\nnon-nil, then the two formats should be too).\n\nFirst INDEX-REGEXP is used to find the previously inserted entry,\nby searching backward from point.  The first submatch must match\nthe index number.  That number is incremented by one, and becomes\nthe index number of the entry to be inserted.  If you don't want\nto number the inserted revisions, then use nil for INDEX-REGEXP.\n\nIf INDEX-REGEXP is non-nil, then both POINT-FORMAT and EOB-FORMAT\nshould contain \"%N\", which is replaced with the number that was\ndetermined in the previous step.\n\nBoth formats, if non-nil and after removing %N, are then expanded\nusing `git show --format=FORMAT ...' inside TOPLEVEL.\n\nThe expansion of POINT-FORMAT is inserted at point, and the\nexpansion of EOB-FORMAT is inserted at the end of the buffer (if\nthe buffer ends with a comment, then it is inserted right before\nthat).",
  value: ["[%N: %h] ", "%N: %cs %H\n   %s\n", "\\[\\([0-9]+\\)[]:]"],
});
e8.defineVariable({
  name: "magit-copy-revision-abbreviated",
  doc: "Whether to save abbreviated revision to `kill-ring' and `magit-revision-stack'.",
  value: false,
});

type StackEntry = [string, string];
const revisionStack = (): StackEntry[] => (e8.variable("magit-revision-stack") as StackEntry[] | null) ?? [];
const pushRevision = (rev: string, dir: string): void => e8.setVariable("magit-revision-stack", [[rev, dir], ...revisionStack()]);

/** Inserts REV formatted by FORMAT, as magit-rev-insert-format. */
function magitRevInsertFormat(format: string, rev: string, args: string[] = []): void {
  const r = magitGitRun(["log", "--no-walk", `--format=${format}`, ...args, rev.startsWith(":/") ? rev : `${rev}^{commit}`, "--"]);
  if (r.exit === 0) e8.insert(r.output);
}

/** A format of magit-pop-revision-stack-format: a string, or a list of the string and arguments to git show. */
function formatAndArgs(format: unknown): [string | undefined, string[]] {
  if (Array.isArray(format)) return [format[0] as string, format.slice(1) as string[]];
  return [typeof format === "string" ? format : undefined, []];
}

/**
 * Inserts REV, from the repository TOPLEVEL, at point and near the end
 * of the buffer, as magit-pop-revision-stack-format says, as
 * magit-pop-revision-stack.
 */
export function magitPopRevisionStack(rev: string | undefined, toplevel: string): void {
  if (!rev) e8.userError("Revision stack is empty");
  const [pnt, eob, idxFormat] = (e8.variable("magit-pop-revision-stack-format") as unknown[] | null) ?? [];
  let [pntFormat, pntArgs] = formatAndArgs(pnt);
  let [eobFormat, eobArgs] = formatAndArgs(eob);
  e8.letBind({ "default-directory": toplevel }, () => {
    let idx: string | undefined;
    if (typeof idxFormat === "string") {
      const found = e8.saveExcursion(() => (e8.reSearchBackward(idxFormat, { noerror: true }) !== undefined ? e8.matchString(1) : undefined));
      idx = found !== undefined ? String(Number(found) + 1) : "1";
    }
    if (pntFormat) {
      if (idx) pntFormat = pntFormat.replaceAll("%N", idx);
      magitRevInsertFormat(pntFormat, rev!, pntArgs);
      e8.deleteRegion(e8.point() - 1, e8.point());
    }
    if (eobFormat) {
      if (idx) eobFormat = eobFormat.replaceAll("%N", idx);
      const format = eobFormat;
      e8.saveExcursion(() => {
        e8.gotoChar(e8.pointMax());
        e8.skipSyntaxBackward(">-");
        e8.gotoChar(e8.lineBeginningPosition());
        const commentStart = e8.variable("comment-start");
        if (typeof commentStart === "string" && commentStart !== "" && e8.lookingAt(commentStart)) {
          while (e8.lookingAt(commentStart) && e8.lineOf(e8.point()) > 0) forwardLine(-1);
        } else {
          forwardLine(1);
          if (e8.currentColumn() !== 0) e8.insert("\n");
        }
        e8.insert("\n");
        magitRevInsertFormat(format, rev!, eobArgs);
        e8.deleteRegion(e8.point() - 1, e8.point());
      });
    }
  });
}

/** Reads a repository, as magit-read-repository, which magit-repos.el has; a directory without it. */
function readRepository(): string {
  if (e8.fboundp("magit-read-repository")) return String(e8.funcall("magit-read-repository"));
  return e8.fileNameAsDirectory(e8.expandFileName(e8.readFileName("Git repository: ", { dir: magitToplevel() ?? String(e8.variable("default-directory")), mustMatch: true })));
}

export const magitPopRevisionStackCommand = e8.defineCommand({
  name: "magit-pop-revision-stack",
  doc:
    "Insert a representation of a revision into the current buffer.\n\nPop a revision from the `magit-revision-stack' and insert it into\nthe current buffer according to `magit-pop-revision-stack-format'.\nRevisions can be put on the stack using `magit-copy-section-value'\nand `magit-copy-buffer-revision'.\n\nIf the stack is empty or with a prefix argument, instead read a\nrevision in the minibuffer.  By using the minibuffer history this\nallows selecting an item which was popped earlier or to insert an\narbitrary reference or revision without first pushing it onto the\nstack.\n\nWhen reading the revision from the minibuffer, then it might not\nbe possible to guess the correct repository.  When this command\nis called inside a repository (e.g., while composing a commit\nmessage), then that repository is used.  Otherwise (e.g., while\ncomposing an email) then the repository recorded for the top\nelement of the stack is used (even though we insert another\nrevision).  If not called inside a repository and with an empty\nstack, or with two prefix arguments, then read the repository in\nthe minibuffer too.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.PrefixArg | null) => {
    const stack = revisionStack();
    if (truthy(prefix) || stack.length === 0) {
      let dir = e8.prefixNumericValue(prefix ?? null) !== 16 ? (magitToplevel() ?? stack[0]?.[1]) : undefined;
      dir ??= readRepository();
      const top = dir;
      e8.letBind({ "default-directory": top }, () => magitPopRevisionStack(magitReadBranchOrCommit("Insert revision"), top));
      return;
    }
    const [rev, dir] = stack[0];
    e8.setVariable("magit-revision-history", [rev, ...((e8.variable("magit-revision-history") as string[] | null) ?? [])]);
    e8.setVariable("magit-revision-stack", stack.slice(1));
    magitPopRevisionStack(rev, dir);
  },
});

/** A section's value as Magit has it: a file section's is its file's name, a hunk's its heading. */
function plainValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { file?: unknown }).file === "string") {
    const v = value as { file: string; hunk?: { heading: string } };
    return v.hunk ? v.hunk.heading : v.file;
  }
  return value;
}

/**
 * Saves the value of the section at point to the kill ring, and a
 * revision's to the revision stack, as magit-copy-section-value; with a
 * region, what it covers, and with ARG in a hunk only its added or,
 * negative, removed lines.
 */
export function magitCopySectionValue(arg: e8.PrefixArg | null): void {
  const section = currentSection();
  if (arg !== null && magitSectionInternalRegionP() && section && magitSectionMatch("hunk", section)) {
    const sign = e8.prefixNumericValue(arg) < 0 ? "+" : "-";
    const [b, e] = [Math.min(e8.mark()!, e8.point()), Math.max(e8.mark()!, e8.point())];
    const text = e8
      .bufferSubstringNoProperties(b, e)
      .replace(new RegExp(`^\\${sign}.*\\n?`, "gm"), "")
      .replace(/^[ +-]/gm, "");
    e8.killNew(text);
    e8.deactivateMark();
    return;
  }
  if (e8.regionActive() && e8.mark() !== e8.point()) {
    e8.call("copy-region-as-kill");
    return;
  }
  if (!section) return;
  const value = plainValue(section.value);
  if (value === undefined || value === null) return;
  if (magitSectionMatch(["branch", "commit", "module-commit", "tag"], section)) {
    let dir = String(e8.variable("default-directory"));
    let ref: string | undefined;
    if (magitSectionMatch(["branch", "tag"], section)) ref = String(value);
    else if (magitSectionMatch("module-commit", section)) dir = e8.fileNameAsDirectory(e8.expandFileName(String(magitSectionParentValue(section)), magitToplevel()));
    const rev = e8.letBind({ "default-directory": dir }, () => magitRevParse(truthy(e8.variable("magit-copy-revision-abbreviated")) ? "--short" : undefined, String(value)));
    if (rev === undefined) return;
    pushRevision(rev, dir);
    const text = arg !== null && ref ? ref : rev;
    e8.message(text);
    e8.killNew(text);
  } else {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    e8.message(text);
    e8.killNew(text);
  }
}

export const magitCopySectionValueCommand = e8.defineCommand({
  name: "magit-copy-section-value",
  doc:
    "Save the value of the current section for later use.\n\nSave the section value to the `kill-ring', and, provided that\nthe current section is a commit, branch, or tag section, push\nthe (referenced) revision to the `magit-revision-stack' for use\nwith `magit-pop-revision-stack'.\n\nWhen `magit-copy-revision-abbreviated' is non-nil, save the\nabbreviated revision to the `kill-ring' and the\n`magit-revision-stack'.\n\nWhen the current section is a branch or a tag, and a prefix\nargument is used, then save the revision at its tip to the\n`kill-ring' instead of the reference name.\n\nWhen the region is active, then save that to the `kill-ring',\nlike `kill-ring-save' would, instead of behaving as described\nabove.  If a prefix argument is used and the region is within\na hunk, then strip the diff marker column and keep only either\nthe added or removed lines, depending on the sign of the prefix\nargument.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.PrefixArg | null) => magitCopySectionValue(arg ?? null),
});

/** Saves the revision the buffer shows to the kill ring and the revision stack, as magit-copy-buffer-revision. */
export function magitCopyBufferRevision(): void {
  if (e8.regionActive() && e8.mark() !== e8.point()) {
    e8.call("copy-region-as-kill");
    return;
  }
  const mode = String(e8.variable("major-mode"));
  let rev = e8.variable("magit-buffer-revision") as string | null | undefined;
  if (!rev && mode === "magit-diff-mode") {
    const range = (e8.variable("magit-buffer-range") as string | null) ?? undefined;
    const m = range !== undefined ? /\.\.\.?(.+)/.exec(range) : null;
    rev = m ? m[1] : range;
  } else if (!rev && mode === "magit-status-mode") rev = "HEAD";
  if (!rev || !magitCommitP(rev)) return;
  const hash = magitRevParse(truthy(e8.variable("magit-copy-revision-abbreviated")) ? "--short" : undefined, rev);
  if (!hash) return;
  pushRevision(hash, String(e8.variable("default-directory")));
  e8.message(hash);
  e8.killNew(hash);
}

export const magitCopyBufferRevisionCommand = e8.defineCommand({
  name: "magit-copy-buffer-revision",
  doc:
    "Save the revision of the current buffer for later use.\n\nSave the revision shown in the current buffer to the `kill-ring'\nand push it to the `magit-revision-stack'.\n\nThis command is mainly intended for use in `magit-revision-mode'\nbuffers, the only buffers where it is always unambiguous exactly\nwhich revision should be saved.\n\nMost other Magit buffers usually show more than one revision, in\nsome way or another, so this command has to select one of them,\nand that choice might not always be the one you think would have\nbeen the best pick.\n\nIn such buffers it is often more useful to save the value of\nthe current section instead, using `magit-copy-section-value'.\n\nWhen the region is active, then save that to the `kill-ring',\nlike `kill-ring-save' would, instead of behaving as described\nabove.\n\nWhen `magit-copy-revision-abbreviated' is non-nil, save the\nabbreviated revision to the `kill-ring' and the\n`magit-revision-stack'.",
  run: () => magitCopyBufferRevision(),
});

// Buffer switching.

/** Reads a Magit buffer of the current repository, as magit--read-repository-buffer. */
function magitReadRepositoryBuffer(prompt: string): string {
  const topdir = magitToplevel();
  if (!topdir) e8.userError("Not inside a Git repository");
  const candidates = e8.bufferList().filter((b) =>
    e8.withCurrentBuffer(b, () => {
      const file = e8.bufferFileName();
      const ours =
        magitBufferInfo() !== undefined ||
        e8.derivedModeP("magit-mode", "magit-repolist-mode", "magit-submodule-list-mode", "git-rebase-mode") ||
        (file !== undefined && /\/(?:(?:COMMIT|NOTES|PULLREQ|MERGEREQ|TAG)_EDIT|MERGE_|)MSG$/.test(file));
      return ours && magitToplevel() === topdir;
    }),
  );
  return magitCompletingRead(prompt.replace(/: $/, ""), candidates, { requireMatch: true, def: magitGetModeBuffer("magit-status-mode") })!;
}

export const magitDisplayRepositoryBuffer = e8.defineCommand({
  name: "magit-display-repository-buffer",
  doc: "Display a Magit buffer belonging to the current Git repository.\nThe buffer is displayed using `magit-display-buffer', which see.",
  run: () => magitDisplayBuffer(magitReadRepositoryBuffer("Display magit buffer: ")),
});
export const magitSwitchToRepositoryBuffer = e8.defineCommand({
  name: "magit-switch-to-repository-buffer",
  doc: "Switch to a Magit buffer belonging to the current Git repository.",
  run: () => void e8.call("switch-to-buffer", magitReadRepositoryBuffer("Switch to magit buffer: ")),
});
export const magitSwitchToRepositoryBufferOtherWindow = e8.defineCommand({
  name: "magit-switch-to-repository-buffer-other-window",
  doc: "Switch to a Magit buffer belonging to the current Git repository.",
  run: () => void e8.call("switch-to-buffer-other-window", magitReadRepositoryBuffer("Switch to magit buffer in another window: ")),
});
export const magitSwitchToRepositoryBufferOtherFrame = e8.defineCommand({
  name: "magit-switch-to-repository-buffer-other-frame",
  doc: "Switch to a Magit buffer belonging to the current Git repository.",
  run: () => void e8.call("switch-to-buffer-other-frame", magitReadRepositoryBuffer("Switch to magit buffer in another frame: ")),
});

// Miscellaneous.

export const magitAbortDwim = e8.defineCommand({
  name: "magit-abort-dwim",
  doc: "Abort current operation.\nDepending on the context, this will abort a merge, a rebase, a\npatch application, a cherry-pick, a revert, or a bisect.",
  run: () => {
    if (magitMergeInProgressP()) e8.call("magit-merge-abort" as e8.CommandName);
    else if (magitRebaseInProgressP()) e8.call("magit-rebase-abort" as e8.CommandName);
    else if (magitAmInProgressP()) e8.call("magit-am-abort" as e8.CommandName);
    else if (magitSequencerInProgressP()) e8.call("magit-sequencer-abort" as e8.CommandName);
    else if (magitBisectInProgressP()) e8.call("magit-bisect-reset" as e8.CommandName);
  },
});

export const magitBackToIndentation = e8.defineCommand({
  name: "magit-back-to-indentation",
  doc: "Move point to the first non-whitespace character on this line.\nIn Magit diffs, also skip over - and + at the beginning of the line.",
  shiftSelect: true,
  run: () => {
    e8.gotoChar(e8.lineBeginningPosition());
    const s = currentSection();
    if (s && magitSectionMatch("hunk", s)) {
      const combined = (s.value as { hunk?: { heading?: string } } | undefined)?.hunk?.heading?.startsWith("@@@") === true;
      const m = (combined ? /^ ?[-+]+/ : /^[-+]/).exec(e8.bufferSubstringNoProperties(e8.point(), e8.lineEndPosition()));
      if (m) e8.gotoChar(e8.point() + m[0].length);
    }
    e8.skipSyntaxForward(" ", e8.lineEndPosition());
    e8.backwardPrefixChars();
  },
});

// Keys, as magit-mode-map binds them; magit.ts binds C-c C-w in
// git-commit-mode-map once the mode is defined.

for (const [key, command] of [
  ["C-w", magitCopySectionValueCommand],
  ["M-w", magitCopyBufferRevisionCommand],
] as const)
  e8.defineKey("magit-mode-map", key, command);
for (const [from, to] of [
  ["back-to-indentation", magitBackToIndentation],
  ["previous-line", magitPreviousLine],
  ["next-line", magitNextLine],
] as const)
  e8.remapCommand("magit-mode-map", from as e8.CommandName, to);
