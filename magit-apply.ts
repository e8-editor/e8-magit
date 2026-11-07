// SPDX-License-Identifier: GPL-3.0-or-later
//
// Applying git diffs, after magit-apply.el: the "apply variants" apply,
// stage, unstage, discard and reverse, on a file, the files the region
// selects, a hunk, the hunks it selects, or the lines of a hunk it
// selects, from the status buffer, a diff, a commit or a stash; staging
// and unstaging files read with completion; and keeping a side of a
// conflict, as Magit's magit-smerge-keep-* commands do.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, magitGetSection, magitRegionSections, magitRegionValues, magitSectionIdent, magitSectionMatch, magitSectionValueIf, sections, type Section } from "magit-section";
import { truthy } from "subr";
import { magitCompletingReadMultiple, magitConfirm, magitConfirmFiles, magitReadCharCase } from "magit-base";
import {
  magitAnythingStagedP,
  magitAnythingUnstagedP,
  magitBinaryFiles,
  magitFileAtPoint,
  magitFileRelativeName,
  magitGitItems,
  magitGitString,
  magitIgnoredFiles,
  magitNoCommitP,
  magitReadBranchOrCommit,
  magitGetCurrentBranch,
  magitStagedFiles,
  magitToplevelOrError,
  magitUnstagedFiles,
  magitUntrackedFiles,
  type GitArg,
} from "magit-git";
import { magitCallGit, magitRunGit, magitRunGitWithInput } from "magit-process";
import { magitWipCommitAfterApply, magitWipCommitBeforeChange } from "magit-wip";
import { magitRefresh } from "magit-mode";
import {
  magitDiffCombinedP,
  magitDiffContextP,
  magitDiffFileHeader,
  magitDiffGetContext,
  magitDiffHunkRegionPatch,
  magitDiffIgnoreAnySpaceP,
  magitDiffScope,
  magitDiffType,
  type FileValue,
  magitDiffVisitFileNoselect,
} from "magit-diff";
import { magitListUntrackedFiles } from "magit-status";
import { magitCheckoutReadStage, magitCheckoutStage } from "magit-merge";

// Options.

e8.defineVariable({
  name: "magit-unstage-committed",
  doc: "Whether unstaging a committed change reverts it instead.\n\nA committed change cannot be unstaged, because staging and unstaging are actions that are concerned with the differences between the index and the working tree, not with committed changes.\n\nIf this option is non-nil (the default), then typing \"u\" (`magit-unstage') on a committed change, causes it to be reversed in the index but not the working tree.  For more information see command `magit-reverse-in-index'.",
  value: true,
});
e8.defineVariable({
  name: "magit-reverse-atomically",
  doc: "Whether to reverse changes atomically.\n\nIf some changes can be reversed while others cannot, then nothing is reversed if the value of this option is non-nil.  But when it is nil, then the changes that can be reversed are reversed and for the other changes diff files are created that contain the rejected reversals.",
  value: false,
});
e8.defineHook("magit-post-stage-hook", "Hook run after staging changes.\nThis hook is run by `magit-refresh' if `this-command' is a member of `magit-post-stage-hook-commands'.");
e8.defineHook("magit-post-unstage-hook", "Hook run after unstaging changes.\nThis hook is run by `magit-refresh' if `this-command' is a member of `magit-post-unstage-hook-commands'.");

// What a section is.

/** A section's file: its value, or its file's, as Magit's file sections have the file as their value. */
const sectionFile = (s: Section): string => (typeof s.value === "string" ? s.value : (s.value as FileValue).file);
/** The file of a hunk's section, as magit-section-parent-value. */
const parentFile = (s: Section): string => sectionFile(s.parent!);
/** The value or values of the region's file sections, as file names, as magit-region-values with MULTIPLE. */
const regionFiles = (): string[] => (magitRegionValues(undefined, true) ?? []).map((v) => (typeof v === "string" ? v : (v as FileValue).file));
const isArray = (s: Selection): s is Section[] => Array.isArray(s);
const primus = (s: Section | Section[]): Section => (Array.isArray(s) ? s[0] : s);

/** What the apply variants act on: a section, sections, or true for the untracked files. */
type Selection = Section | Section[] | true;

/** Runs BODY in the repository's top directory, as magit-with-toplevel. */
const withToplevel = <T>(body: () => T): T => e8.letBind({ "default-directory": magitToplevelOrError() }, body);

/** FILE's status, as magit-file-status gives it: [file, orig, x, y] for each file git status lists. */
export function magitFileStatusList(...args: GitArg[]): [string, string | undefined, string, string][] {
  const items = magitGitItems("status", "-z", ...args);
  const out: [string, string | undefined, string, string][] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const [x, y, file] = [item.charAt(0), item.charAt(1), item.slice(3)];
    if (x === "R" || x === "C") out.push([file, items[++i], x, y]);
    else out.push([file, undefined, x, y]);
  }
  return out;
}

// Apply.

/**
 * Applies the change at point to the working tree, as magit-apply: with
 * "--3way" in ARGS falls back to a 3-way merge, which applies the change
 * to the index as well.
 */
export function magitApply(...args: string[]): void {
  const s = magitApplyGetSelection();
  if (!s) return;
  const type = magitDiffType();
  const scope = magitDiffScope();
  if (type === "unstaged" || type === "staged") e8.userError("Change is already in the working tree");
  if (type === "untracked" && (scope === "file" || scope === "files")) e8.call("magit-am" as e8.CommandName);
  else if (s === true) return;
  else if (scope === "region") magitApplyRegion(s as Section, ...args);
  else if (scope === "hunk") magitApplyHunk(s as Section, ...args);
  else if (scope === "hunks") magitApplyHunks(s as Section[], ...args);
  else if (type === "rebase-sequence" && scope === "file") e8.call("magit-patch-apply" as e8.CommandName);
  else if (scope === "file") magitApplyDiff(s as Section, ...args);
  else if (scope === "files") magitApplyDiffs(s as Section[], ...args);
}

export const magitApplyCommand = e8.defineCommand({
  name: "magit-apply",
  doc: "Apply the change at point to the working tree.\nWith a prefix argument fallback to a 3-way merge.  Doing so causes the change to be applied to the index as well.",
  params: [{ name: "args", kind: "prefix" }],
  run: (prefix: e8.Value) => magitApply(...(truthy(prefix) ? ["--3way"] : [])),
});

/** The text of SECTION a patch takes: a hunk's with its heading, a file's without, as magit-apply--section-content. */
const sectionContent = (s: Section): string => e8.bufferSubstringNoProperties(s.type === "hunk" ? s.start : s.content, s.end);

/** Applies the diffs of SECTIONS, files, with ARGS, as magit-apply-diffs. */
export function magitApplyDiffs(sections: Section[], ...args: string[]): void {
  const diffs = magitApplyGetDiffs(sections);
  magitApplyPatch(diffs, args, diffs.map((s) => `${magitDiffFileHeader(s) ?? ""}${sectionContent(s)}`).join(""));
}

/** Applies the diff of SECTION, a file, with ARGS, as magit-apply-diff. */
export function magitApplyDiff(section: Section, ...args: string[]): void {
  const s = magitApplyGetDiffs([section])[0];
  magitApplyPatch(s, args, `${magitDiffFileHeader(s) ?? ""}${sectionContent(s)}`);
}

const hunkHeaderRe = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/;

/**
 * HUNKS, ordered and contiguous hunks of a file, with the new line
 * numbers in their headers adjusted for applying only them, as
 * magit-apply--adjust-hunk-new-starts: "@@ -10,6 +11,7 @@" and
 * "@@ -18,6 +20,7 @@" become "@@ -10,6 +10,7 @@" and "@@ -18,6 +19,7 @@".
 */
export function magitApplyAdjustHunkNewStarts(hunks: string[]): string[] {
  const m = hunkHeaderRe.exec(hunks[0] ?? "");
  if (!m) e8.signal("error", "Header hunks have to be applied individually");
  const offset = Number(m[3]) - Number(m[1]);
  if (offset === 0) return hunks;
  return hunks.map((hunk) => {
    const h = hunkHeaderRe.exec(hunk);
    if (!h) e8.signal("error", "Hunk does not have expected header");
    return hunk.replace(hunkHeaderRe, (all, a: string, b: string | undefined, c: string, d: string | undefined) => `@@ -${a}${b !== undefined ? `,${b}` : ""} +${Number(c) - offset}${d !== undefined ? `,${d}` : ""} @@`);
  });
}

const adjustHunkNewStart = (hunk: string): string => magitApplyAdjustHunkNewStarts([hunk])[0];

const refuseCombined = (file: Section): void => {
  if (magitDiffCombinedP(file)) e8.userError("Cannot un-/stage resolution hunks.  Stage the whole file");
};

/** Applies HUNKS, hunks of one file, with ARGS, as magit-apply-hunks. */
export function magitApplyHunks(hunks: Section[], ...args: string[]): void {
  const file = hunks[0].parent!;
  refuseCombined(file);
  magitApplyPatch(file, args, `${magitDiffFileHeader(file) ?? ""}${magitApplyAdjustHunkNewStarts(hunks.map(sectionContent)).join("")}`);
}

/** Applies HUNK with ARGS, as magit-apply-hunk: a mode change or rename as it is, a hunk at its old place. */
export function magitApplyHunk(hunk: Section, ...args: string[]): void {
  const file = hunk.parent!;
  refuseCombined(file);
  const v = hunk.value as FileValue;
  const header = v.hunk ? undefined : v.ident;
  const content = sectionContent(hunk);
  magitApplyPatch(file, args, `${magitDiffFileHeader(hunk, header !== "rename") ?? ""}${header ? content : adjustHunkNewStart(content)}`);
}

/** Applies the lines of HUNK the region selects with ARGS, as magit-apply-region. */
export function magitApplyRegion(hunk: Section, ...args: string[]): void {
  const file = hunk.parent!;
  refuseCombined(file);
  magitApplyPatch(file, args, `${magitDiffFileHeader(hunk) ?? ""}${adjustHunkNewStart(magitDiffHunkRegionPatch(hunk, args))}`);
  e8.deactivateMark();
}

/** Runs git apply with ARGS on PATCH, from SECTIONS' diff, then refreshes, as magit-apply-patch. */
export function magitApplyPatch(sections: Section | Section[], args: GitArg[], patch: string): void {
  const files = [...new Set((Array.isArray(sections) ? sections : [sections]).map((s) => sectionFile(s)))];
  const command = /^magit-([^-]+)/.exec(String(e8.variable("this-command") ?? ""))?.[1] ?? "apply";
  const context = magitDiffGetContext();
  const ignoreContext = magitDiffIgnoreAnySpaceP();
  if (!magitDiffContextP()) e8.userError("Not enough context to apply patch.  Increase the context");
  const inhibit = truthy(e8.variable("magit-inhibit-refresh"));
  if (!inhibit) magitWipCommitBeforeChange(files, ` before ${command}`);
  e8.letBind({ "magit-inhibit-refresh": true }, () => magitRunGitWithInput(patch, "apply", args, "-p0", ignoreContext ? "-C0" : `-C${context}`, "--ignore-space-change", "-"));
  if (!inhibit) {
    magitWipCommitAfterApply(files, ` after ${command}`);
    magitRefresh();
  }
}

/**
 * What the apply variants act on, as magit-apply--get-selection: the
 * hunks, files or modules the region selects, the section at point if it
 * is one, the files of a list of changes, or true for the untracked files.
 */
export function magitApplyGetSelection(): Selection | undefined {
  const region = magitRegionSections(["hunk", "file", "module"], true);
  if (region) return region;
  const s = currentSection();
  if (!s) return undefined;
  switch (s.type) {
    case "hunk":
    case "file":
    case "module":
      return s;
    case "staged":
    case "unstaged":
    case "stashed-index":
    case "stashed-worktree":
    case "stashed-untracked":
      return s.children;
    case "untracked":
      return true;
  }
  e8.userError("Cannot apply this, it's not a change");
}

/** SECTIONS, with a diffstat's files replaced by their diffs, as magit-apply--get-diffs. */
function magitApplyGetDiffs(sections: Section[]): Section[] {
  if (!magitSectionMatch({ lineage: ["file", "diffstat"] })) return sections;
  const root = sectionsRoot();
  return sections.map((s) => magitGetSection([["file", sectionFile(s)], ...magitSectionIdent(root)]) ?? e8.signal("error", "Cannot get required diff headers"));
}
const sectionsRoot = (): Section => sections()!.root;

/**
 * Whether it is necessary and possible to ignore whitespace, as
 * magit-apply--ignore-whitespace-p: when the diff ignores whitespace
 * changes, whole files are applied, and none of them is binary.
 */
function magitApplyIgnoreWhitespaceP(selection: Selection, type: string | undefined, scope: string | undefined): boolean {
  const args = e8.variable("magit-buffer-diff-args");
  const list = Array.isArray(args) ? (args as string[]) : [];
  const selected = selection === true ? [] : isArray(selection) ? selection : [selection];
  return (
    (type === "unstaged" || type === "staged") &&
    (scope === "file" || scope === "files" || scope === "list") &&
    list.some((a) => ["--ignore-space-at-eol", "--ignore-space-change", "--ignore-all-space", "--ignore-blank-lines"].includes(a)) &&
    !selected.some((s) => (s.value as FileValue | undefined)?.diff?.binary)
  );
}

// Stage.

/** Adds the change at point to the staging area, as magit-stage: with INTENT an untracked file's name but not its content. */
export function magitStage(intent = false): void {
  const s = e8.derivedModeP("magit-mode") ? magitApplyGetSelection() : undefined;
  const type = s ? magitDiffType() : undefined;
  const scope = s ? magitDiffScope() : undefined;
  if (!s || !type || !scope) {
    e8.call(magitStageFilesCommand);
    return;
  }
  const ws = magitApplyIgnoreWhitespaceP(s, type, scope);
  if (type === "untracked") magitStageUntracked(intent);
  else if (type === "unstaged") {
    if (scope === "region") magitApplyRegion(s as Section, "--cached");
    else if (scope === "hunk") magitApplyHunk(s as Section, "--cached");
    else if (scope === "hunks") magitApplyHunks(s as Section[], "--cached");
    else if (scope === "file" && ws) magitApplyDiff(s as Section, "--cached");
    else if ((scope === "files" || scope === "list") && ws) magitApplyDiffs(s as Section[], "--cached");
    else if (scope === "file") magitStage1("-u", [sectionFile(s as Section)]);
    else if (scope === "files") magitStage1("-u", regionFiles());
    else if (scope === "list") magitStageModified();
  } else if (type === "staged") e8.userError("Already staged");
  else if (type === "committed") e8.userError("Cannot stage committed changes");
  else e8.userError("Cannot stage this change");
}

export const magitStageCommand = e8.defineCommand({
  name: "magit-stage",
  doc: "Add the change at point to the staging area.\nWith a prefix argument, INTENT, and an untracked file (or files) at point, stage the file but not its content.",
  params: [{ name: "intent", kind: "prefix" }],
  run: (intent: e8.Value) => magitStage(truthy(intent)),
});

/** Stages all changes in FILES, with FORCE ignored files too, as magit-stage-files. */
export function magitStageFiles(files: string[], force = false): void {
  withToplevel(() => magitStage1(force ? "--force" : undefined, files));
}

/** The file at point or visited, if one of CHOICES, as Magit's file readers default. */
const defaultFile = (choices: string[]): string | undefined => {
  const def = (magitSectionValueIf("file") as FileValue | string | undefined) ?? magitFileRelativeName();
  const name = typeof def === "object" ? def.file : def;
  return name !== undefined && choices.includes(name) ? name : undefined;
};

export const magitStageFilesCommand = e8.defineCommand({
  name: "magit-stage-files",
  doc: "Read one or more files and stage all changes in those files.\nWith prefix argument FORCE, offer ignored files for completion.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.Value) => {
    const f = truthy(force);
    const choices = f ? magitIgnoredFiles() : [...magitUnstagedFiles(), ...magitUntrackedFiles()];
    magitStageFiles(magitCompletingReadMultiple(f ? "Stage ignored file,s: " : "Stage file,s: ", choices, { requireMatch: true, def: defaultFile(choices) }), f);
  },
});

/**
 * Stages all changes to files modified in the worktree, as
 * magit-stage-modified: new content of tracked files, and tracked files
 * gone from the worktree removed from the index; with ALL untracked
 * (but not ignored) files too.
 */
export function magitStageModified(all = false): void {
  if (magitAnythingStagedP()) magitConfirm("stage-all-changes");
  withToplevel(() => magitStage1(all ? "--all" : "-u", (e8.variable("magit-buffer-diff-files") as string[] | null) ?? []));
}

export const magitStageModifiedCommand = e8.defineCommand({
  name: "magit-stage-modified",
  doc: "Stage all changes to files modified in the worktree.\nStage all new content of tracked files and remove tracked files that no longer exist in the working tree from the index also.  With a prefix argument also stage previously untracked (but not ignored) files.",
  params: [{ name: "all", kind: "prefix" }],
  run: (all: e8.Value) => magitStageModified(truthy(all)),
});

/** Runs git add with ARG on FILES, or on everything, as magit-stage-1. */
export function magitStage1(arg: string | undefined, files: string[] = []): void {
  magitWipCommitBeforeChange(files, " before stage");
  magitRunGit("add", arg, files.length > 0 ? ["--", ...files] : ".");
  magitWipCommitAfterApply(files, " after stage");
}

/**
 * Stages the untracked files at point, as magit-stage-untracked: with
 * INTENT their names only. Repositories among them are left alone, as
 * Magit leaves them to borg.
 */
export function magitStageUntracked(intent = false): void {
  const section = currentSection();
  const scope = magitDiffScope();
  const files = scope === "file" ? [sectionFile(section!)] : scope === "files" ? regionFiles() : scope === "list" ? magitUntrackedFiles() : [];
  const plain: string[] = [];
  const top = magitToplevelOrError();
  for (const file of files) {
    const path = e8.expandFileName(file, top);
    const repo = !e8.fileSymlinkP(path.replace(/\/$/, "")) && e8.fileDirectoryP(path) && e8.fileExistsP(e8.expandFileName(".git", path));
    if (!repo) plain.push(file);
  }
  magitWipCommitBeforeChange(files, " before stage");
  if (plain.length > 0) magitRunGit("add", intent ? "--intent-to-add" : undefined, "--", plain);
  magitWipCommitAfterApply(files, " after stage");
}

e8.defineVariable({
  name: "magit-post-stage-hook-commands",
  doc: "The commands after which magit-refresh runs magit-post-stage-hook.",
  value: ["magit-stage", "magit-stage-files", "magit-stage-modified", "magit-file-stage"],
});

/** Runs magit-post-stage-hook after a staging command, as magit-run-post-stage-hook. */
export function magitRunPostStageHook(): void {
  const commands = (e8.variable("magit-post-stage-hook-commands") as string[] | null) ?? [];
  if (commands.includes(e8.thisCommand() ?? "")) e8.runHooks("magit-post-stage-hook");
}

// Unstage.

/** Removes the change at point from the staging area, as magit-unstage. */
export function magitUnstage(): void {
  const s = magitApplyGetSelection();
  if (!s) return;
  const type = magitDiffType();
  const scope = magitDiffScope();
  if (!type || !scope) return;
  const ws = magitApplyIgnoreWhitespaceP(s, type, scope);
  if (type === "untracked") e8.userError("Cannot unstage untracked changes");
  else if (type === "unstaged") {
    if (scope === "file") magitUnstageIntent([sectionFile(s as Section)]);
    else if (scope === "files") magitUnstageIntent(regionFiles());
    else e8.userError("Already unstaged");
  } else if (type === "staged") {
    if (scope === "region") magitApplyRegion(s as Section, "--reverse", "--cached");
    else if (scope === "hunk") magitApplyHunk(s as Section, "--reverse", "--cached");
    else if (scope === "hunks") magitApplyHunks(s as Section[], "--reverse", "--cached");
    else if (scope === "file" && ws) magitApplyDiff(s as Section, "--reverse", "--cached");
    else if ((scope === "files" || scope === "list") && ws) magitApplyDiffs(s as Section[], "--reverse", "--cached");
    else if (scope === "file") magitUnstage1([sectionFile(s as Section)]);
    else if (scope === "files") magitUnstage1(regionFiles());
    else if (scope === "list") magitUnstageAll();
  } else if (type === "committed") {
    if (truthy(e8.variable("magit-unstage-committed"))) magitReverseInIndex();
    else e8.userError("Cannot unstage committed changes");
  } else e8.userError("Cannot unstage this change");
}

export const magitUnstageCommand = e8.defineCommand({ name: "magit-unstage", doc: "Remove the change at point from the staging area.", run: () => magitUnstage() });

/** Unstages all changes to FILES, as magit-unstage-files. */
export function magitUnstageFiles(files: string[]): void {
  withToplevel(() => magitUnstage1(files));
}

export const magitUnstageFilesCommand = e8.defineCommand({
  name: "magit-unstage-files",
  doc: "Read one or more files and unstage all changes to those files.",
  run: () => {
    const choices = magitStagedFiles();
    magitUnstageFiles(magitCompletingReadMultiple("Unstage file,s: ", choices, { requireMatch: true, def: defaultFile(choices) }));
  },
});

/** Unstages FILES: git rm --cached before the first commit, else git reset, as magit-unstage-1. */
export function magitUnstage1(files: string[]): void {
  magitWipCommitBeforeChange(files, " before unstage");
  if (magitNoCommitP()) magitRunGit("rm", "--cached", "--", files);
  else magitRunGit("reset", "HEAD", "--", files);
  magitWipCommitAfterApply(files, " after unstage");
}

/** Unstages those of FILES added with intent to add, as magit-unstage-intent. */
function magitUnstageIntent(files: string[]): void {
  const staged = magitStagedFiles();
  const intent = files.filter((f) => staged.includes(f));
  if (intent.length === 0) e8.userError("Already unstaged");
  magitUnstage1(intent);
}

/** Removes all changes from the staging area, as magit-unstage-all: asks first if there are unstaged or untracked changes, unless magit-no-confirm says not to. */
export function magitUnstageAll(): void {
  if (!magitAnythingStagedP()) e8.userError("Nothing to unstage");
  if (magitAnythingUnstagedP() || magitUntrackedFiles().length > 0) magitConfirm("unstage-all-changes");
  magitWipCommitBeforeChange(undefined, " before unstage");
  magitRunGit("reset", "HEAD", "--", (e8.variable("magit-buffer-diff-files") as string[] | null) ?? []);
  magitWipCommitAfterApply(undefined, " after unstage");
}

export const magitUnstageAllCommand = e8.defineCommand({ name: "magit-unstage-all", doc: "Remove all changes from the staging area.", run: () => magitUnstageAll() });

e8.defineVariable({
  name: "magit-post-unstage-hook-commands",
  doc: "The commands after which magit-refresh runs magit-post-unstage-hook.",
  value: ["magit-unstage", "magit-unstage-files", "magit-unstage-all", "magit-file-unstage"],
});

/** Runs magit-post-unstage-hook after an unstaging command, as magit-run-post-unstage-hook. */
export function magitRunPostUnstageHook(): void {
  const commands = (e8.variable("magit-post-unstage-hook-commands") as string[] | null) ?? [];
  if (commands.includes(e8.thisCommand() ?? "")) e8.runHooks("magit-post-unstage-hook");
}

e8.defun("magit-run-post-stage-hook", magitRunPostStageHook);
e8.defun("magit-run-post-unstage-hook", magitRunPostUnstageHook);
e8.addHook("magit-post-refresh-hook", magitRunPostStageHook, { append: true });
e8.addHook("magit-post-refresh-hook", magitRunPostUnstageHook, { append: true });

// Discard.

/**
 * Removes the change at point, as magit-discard. On a hunk or file with
 * unresolved conflicts asks which side to keep (while discarding the
 * other); if point is within the text of a side, keeps that side without
 * asking.
 */
export function magitDiscard(): void {
  const s = magitApplyGetSelection();
  if (!s) return;
  const type = magitDiffType();
  const scope = magitDiffScope();
  if (type === "committed") e8.userError("Cannot discard committed changes");
  if (type === undefined || type === "undefined") e8.userError("Cannot discard this change");
  if (type === "untracked" && scope === "list") magitDiscardUntracked();
  else if (s === true) return;
  else if (scope === "region") magitDiscardRegion(s as Section);
  else if (scope === "hunk") magitDiscardHunk(s as Section);
  else if (scope === "hunks") magitDiscardHunks(s as Section[]);
  else if (scope === "file") magitDiscardFiles([s as Section]);
  else if (scope === "files" || scope === "list") magitDiscardFiles(s as Section[]);
}

export const magitDiscardCommand = e8.defineCommand({
  name: "magit-discard",
  doc: "Remove the change at point.\n\nOn a hunk or file with unresolved conflicts prompt which side to keep (while discarding the other).  If point is within the text of a side, then keep that side without prompting.",
  run: () => magitDiscard(),
});

function magitDiscardUntracked(): void {
  magitDiscardFilesDelete(withToplevel(() => magitListUntrackedFiles()), []);
  magitRefresh();
}

function magitDiscardRegion(section: Section): void {
  magitConfirm("discard", "Discard region");
  magitDiscardApply(section, magitApplyRegion);
}

function magitDiscardHunk(section: Section): void {
  magitConfirm("discard", "Discard hunk");
  const status = magitFileStatusList(parentFile(section))[0];
  if (status && status[2] === "U" && status[3] === "U") magitCallSmerge("current", true);
  else magitDiscardApply(section, magitApplyHunk);
}

function magitDiscardHunks(sections: Section[]): void {
  magitConfirm("discard", `Discard ${sections.length} hunks from ${parentFile(sections[0])}`);
  magitDiscardApply(sections, magitApplyHunks);
}

type ApplyFn = (s: never, ...args: string[]) => void;

/** Applies SECTIONS in reverse with APPLY: to the worktree, the index, or both, as their changes are, as magit-discard-apply. */
function magitDiscardApply(sections: Section | Section[], apply: ApplyFn): void {
  const first = primus(sections);
  const call = (...args: string[]): void => (apply as (s: Section | Section[], ...args: string[]) => void)(sections, ...args);
  if (magitDiffType(first) === "unstaged") call("--reverse");
  else if (magitAnythingUnstagedP(first.type === "file" ? sectionFile(first) : parentFile(first))) {
    e8.letBind({ "magit-inhibit-refresh": true }, () => {
      call("--reverse", "--cached");
      call("--reverse", "--reject");
    });
    magitRefresh();
  } else call("--reverse", "--index");
}

/**
 * Discards the changes of the file sections SECTIONS, as
 * magit-discard-files: by what git status says of each, resolving a
 * conflict, bringing back a deleted file, deleting a new one, undoing a
 * rename, or reversing the changes.
 */
export function magitDiscardFiles(sections: Section[]): void {
  const type = magitDiffType(sections[0]);
  const status = magitFileStatusList();
  const files: string[] = [];
  const del: string[] = [];
  const resurrect: string[] = [];
  const rename: string[] = [];
  const discard: Section[] = [];
  const discardNew: string[] = [];
  const resolve: string[] = [];
  const t = type === "staged" ? "X" : type === "unstaged" ? "Y" : type === "untracked" ? "Z" : undefined;
  for (const section of sections) {
    const file = sectionFile(section);
    files.push(file);
    const st = status.find((x) => x[0] === file);
    if (!st) {
      if (t === "Z") del.push(...magitUntrackedFiles(false, [file]));
      continue;
    }
    const [, , x, y] = st;
    if (t === "Z" && ((x === "?" && y === "?") || (x === "!" && y === "!"))) del.push(file);
    else if (t === "Z" && x === "D" && y === " ") del.push(file);
    else if (x === "D" && y === "D") resolve.push(file);
    else if (x === "U" || y === "U") resolve.push(file);
    else if (x === "A" && y === "A") resolve.push(file);
    else if (t === "X" && x === "M" && " MD".includes(y)) discard.push(section);
    else if (t === "Y" && y === "M") discard.push(section);
    else if (t === "X" && (x === "A" || x === "C") && y === "M") discardNew.push(file);
    else if (t === "X" && (x === "A" || x === "C") && " D".includes(y)) del.push(file);
    else if (t === "X" && x === "D" && " M".includes(y)) resurrect.push(file);
    else if (t === "Y" && y === "D") resurrect.push(file);
    else if (t === "X" && x === "R" && " MD".includes(y)) rename.push(file);
  }
  try {
    e8.letBind({ "magit-inhibit-refresh": true }, () => {
      magitWipCommitBeforeChange(files, " before discard");
      if (resolve.length > 0) magitDiscardFilesResolve(resolve);
      if (resurrect.length > 0) magitDiscardFilesResurrect(resurrect);
      if (del.length > 0) magitDiscardFilesDelete(del, status);
      if (rename.length > 0) magitDiscardFilesRename(rename, status);
      if (discard.length > 0 || discardNew.length > 0) magitDiscardFilesDiscard(discard, discardNew);
      magitWipCommitAfterApply(files, " after discard");
    });
  } finally {
    magitRefresh();
  }
}

/** Resolves the conflicts in FILES by checking out a stage, asked for all or each, as magit-discard-files--resolve. */
function magitDiscardFilesResolve(files: string[]): void {
  const arg =
    files.length > 1
      ? magitReadCharCase<string | undefined>(`For these ${files.length} files\n${files.map((f) => `  ${f}`).join("\n")}\ncheckout:\n`, true, [
          ["o", "[o]ur stage", "--ours"],
          ["t", "[t]heir stage", "--theirs"],
          ["c", "[c]onflict", "--merge"],
          ["i", "decide [i]ndividually", undefined],
        ])
      : undefined;
  for (const file of files) magitCheckoutStage(file, arg ?? magitCheckoutReadStage(file));
}

/** Brings back FILES deleted, as magit-discard-files--resurrect. */
function magitDiscardFilesResurrect(files: string[]): void {
  magitConfirmFiles("resurrect", files);
  if (magitDiffType() === "staged") magitCallGit("reset", "--", files);
  else magitCallGit("checkout", "--", files);
}

/** Deletes FILES, to the trash if magit-delete-by-moving-to-trash, as magit-discard-files--delete. */
function magitDiscardFilesDelete(files: string[], status: [string, string | undefined, string, string][]): void {
  const trash = truthy(e8.variable("magit-delete-by-moving-to-trash"));
  magitConfirmFiles(trash ? "trash" : "delete", files);
  const top = magitToplevelOrError();
  const type = magitDiffType();
  for (const file of files) {
    if (/^\\?~/.test(file)) e8.signal("error", `Refusing to delete ${JSON.stringify(file)}, too dangerous`);
    const path = e8.expandFileName(file, top);
    const y = status.find((s) => s[0] === file)?.[3];
    if (type === "unstaged" || type === "untracked") diredDeleteFile(file, path, trash);
    else if (y === " ") {
      e8.deleteFile(path, { trash });
      magitCallGit("rm", "--cached", "--", file);
    } else if (y === "M") {
      const temp = magitGitString("checkout-index", "--temp", file) ?? "";
      const m = new RegExp(`^(.+?)\\t${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(temp);
      if (m) {
        const index = `${path}.~{index}~`;
        e8.renameFile(e8.expandFileName(m[1], top), index, { okIfExists: true });
        e8.deleteFile(index, { trash });
      }
      magitCallGit("rm", "--cached", "--force", "--", file);
    } else if (y === "D") {
      magitCallGit("checkout", "--", file);
      e8.deleteFile(path, { trash });
      magitCallGit("rm", "--cached", "--force", "--", file);
    }
  }
}

/** Deletes FILE at PATH, a directory with what it holds after asking, as dired-delete-file with dired-recursive-deletes top. */
function diredDeleteFile(file: string, path: string, trash: boolean): void {
  if (!e8.fileDirectoryP(path)) {
    e8.deleteFile(path, { trash });
    return;
  }
  let recursive = e8.directoryFiles(path).some((f) => f !== "." && f !== "..");
  if (recursive) {
    const answer = e8.readAnswer(`Recursively ${trash ? "trash" : "delete"} ${file}? `, ["yes", "no", "all", "quit", "help"]);
    if (answer === "no") recursive = false;
    else if (answer !== "yes" && answer !== "all") e8.signal("quit", "Quit");
  }
  e8.deleteDirectory(path, { recursive, trash });
}

/** Undoes the renames of FILES, as magit-discard-files--rename. */
function magitDiscardFilesRename(files: string[], status: [string, string | undefined, string, string][]): void {
  const orig = (file: string): string => status.find((s) => s[0] === file)?.[1] ?? file;
  magitConfirm("rename", "Undo rename %s", "Undo %d renames", files.map((f) => `${orig(f)} -> ${f}`));
  const top = magitToplevelOrError();
  for (const file of files) {
    const o = orig(file);
    if (e8.fileExistsP(e8.expandFileName(file, top))) {
      const dir = e8.fileNameDirectory(o);
      if (dir) e8.makeDirectory(e8.expandFileName(dir, top), { parents: true });
      magitCallGit("mv", file, o);
    } else {
      magitCallGit("rm", "--cached", "--", file);
      magitCallGit("reset", "--", o);
    }
  }
}

/** Discards the changes of SECTIONS and of the new files NEW-FILES, as magit-discard-files--discard. */
function magitDiscardFilesDiscard(sections: Section[], newFiles: string[]): void {
  const files = sections.map(sectionFile);
  const type = magitDiffType(sections[0] ?? currentSection());
  magitConfirmFiles("discard", [...files, ...newFiles], `Discard ${magitDiffType()} changes in`);
  if (type === "unstaged") {
    magitCallGit("checkout", "--", files);
    return;
  }
  if (newFiles.length > 0) {
    magitCallGit("add", "--", newFiles);
    magitCallGit("reset", "--", newFiles);
  }
  let binaries = magitBinaryFiles("--cached");
  const rest = binaries.length > 0 ? sections.filter((s) => !binaries.includes(sectionFile(s))) : sections;
  if (rest.length > 0) magitDiscardApply(rest, magitApplyDiffs);
  if (binaries.length > 0) {
    const modified = magitUnstagedFiles(true);
    const both = binaries.filter((b) => modified.includes(b));
    binaries = binaries.filter((b) => !modified.includes(b));
    if (binaries.length > 0) magitCallGit("reset", "--", binaries);
    if (both.length > 0) e8.userError("Cannot discard staged changes to binary files, which also have unstaged changes.  Unstage instead.");
  }
}

// Reverse.

/**
 * Reverses the change at point in the working tree, as magit-reverse:
 * with "--3way" in ARGS falls back to a 3-way merge, which applies the
 * change to the index as well.
 */
export function magitReverse(...args: string[]): void {
  const s = magitApplyGetSelection();
  if (!s) return;
  const type = magitDiffType();
  const scope = magitDiffScope();
  if (type === "untracked") e8.userError("Cannot reverse untracked changes");
  if (type === "unstaged") e8.userError("Cannot reverse unstaged changes");
  if (s === true) return;
  if (scope === "region") magitReverseRegion(s as Section, args);
  else if (scope === "hunk") magitReverseHunk(s as Section, args);
  else if (scope === "hunks") magitReverseHunks(s as Section[], args);
  else if (scope === "file") magitReverseFiles([s as Section], args);
  else if (scope === "files" || scope === "list") magitReverseFiles(s as Section[], args);
}

export const magitReverseCommand = e8.defineCommand({
  name: "magit-reverse",
  doc: "Reverse the change at point in the working tree.\nWith a prefix argument fallback to a 3-way merge.  Doing so causes the change to be applied to the index as well.",
  params: [{ name: "args", kind: "prefix" }],
  run: (prefix: e8.Value) => magitReverse(...(truthy(prefix) ? ["--3way"] : [])),
});

function magitReverseRegion(section: Section, args: string[]): void {
  magitConfirm("reverse", "Reverse region");
  magitReverseApply(section, magitApplyRegion, args);
}

function magitReverseHunk(section: Section, args: string[]): void {
  magitConfirm("reverse", "Reverse hunk");
  magitReverseApply(section, magitApplyHunk, args);
}

function magitReverseHunks(sections: Section[], args: string[]): void {
  magitConfirm("reverse", `Reverse ${sections.length} hunks from ${parentFile(sections[0])}`);
  magitReverseApply(sections, magitApplyHunks, args);
}

function magitReverseFiles(sections: Section[], args: string[]): void {
  const mode = String(e8.variable("major-mode"));
  const range = mode === "magit-revision-mode" || mode === "magit-diff-mode" || mode === "magit-stash-mode" ? ((e8.variable("magit-buffer-range") as string | null) ?? undefined) : "--cached";
  const bs = magitBinaryFiles(range);
  const binaries = sections.filter((s) => bs.includes(sectionFile(s)));
  const rest = sections.filter((s) => !bs.includes(sectionFile(s)));
  magitConfirmFiles("reverse", rest.map(sectionFile));
  if (rest.length === 1) magitReverseApply(rest[0], magitApplyDiff, args);
  else if (rest.length > 0) magitReverseApply(rest, magitApplyDiffs, args);
  if (binaries.length > 0) e8.userError("Cannot reverse binary files");
}

/** Applies SECTIONS reversed with APPLY and ARGS, rejecting what does not apply unless magit-reverse-atomically, as magit-reverse-apply. */
function magitReverseApply(sections: Section | Section[], apply: ApplyFn, args: string[]): void {
  const reject = !truthy(e8.variable("magit-reverse-atomically")) && !args.includes("--3way");
  (apply as (s: Section | Section[], ...args: string[]) => void)(sections, "--reverse", ...args, ...(reject ? ["--reject"] : []));
}

/**
 * Reverses the change at point in the index but not the working tree, as
 * magit-reverse-in-index: to take a change out of HEAD, leaving it in the
 * working tree, for a commit of its own. Visit HEAD, go to the change, u
 * (with magit-unstage-committed), c e to extend HEAD, then stage the rest
 * and commit it with c c.
 */
export function magitReverseInIndex(...args: string[]): void {
  magitReverse("--cached", ...args);
}

export const magitReverseInIndexCommand = e8.defineCommand({
  name: "magit-reverse-in-index",
  doc: "Reverse the change at point in the index but not the working tree.\n\nUse this command to extract a change from `HEAD', while leaving it in the working tree, so that it can later be committed using a separate commit.  A typical workflow would be:\n\n0. Optionally make sure that there are no uncommitted changes.\n1. Visit the `HEAD' commit and navigate to the change that should not have been included in that commit.\n2. Type \"u\" (`magit-unstage') to reverse it in the index.  This assumes that `magit-unstage-committed' is non-nil.\n3. Type \"c e\" to extend `HEAD' with the staged changes, including those that were already staged before.\n4. Optionally stage the remaining changes using \"s\" or \"S\" and then type \"c c\" to create a new commit.",
  run: () => magitReverseInIndex(),
});

// Smerge support.

/** A conflict: where it starts and ends, and its upper, base and lower versions, as smerge-match-conflict's match data. */
interface Conflict {
  start: number;
  end: number;
  versions: ([number, number] | undefined)[];
}

/** The conflict around POS in the current buffer, as smerge-match-conflict. */
function smergeMatchConflict(pos: number): Conflict {
  const fail = (): never => e8.userError("Point not in conflict region");
  const bol = (p: number): number => e8.lineBeginningPosition(p);
  const next = (p: number): number => Math.min(e8.lineEndPosition(p) + 1, e8.pointMax());
  const line = (p: number): string => e8.bufferSubstringNoProperties(p, e8.lineEndPosition(p));
  let begin: number | undefined;
  for (let p = bol(pos); ; p = bol(p - 1)) {
    if (/^<<<<<<< .+/.test(line(p))) {
      begin = p;
      break;
    }
    if (p <= e8.pointMin()) break;
  }
  if (begin === undefined) return fail();
  let endLine: number | undefined;
  for (let p = next(begin); p < e8.pointMax(); p = next(p)) {
    if (/^>>>>>>> ?/.test(line(p)) && line(p).startsWith(">>>>>>>")) {
      endLine = p;
      break;
    }
  }
  if (endLine === undefined) return fail();
  const end = next(endLine);
  if (end < pos) return fail();
  let sep: number | undefined;
  let base: number | undefined;
  for (let p = next(begin); p < endLine; p = next(p)) {
    const l = line(p);
    if (/^<<<<<<< /.test(l)) e8.signal("error", "There is a nested conflict");
    if (l === "=======") sep = p;
    else if (/^\|{7}( .*)?$/.test(l) && sep === undefined) base = p;
  }
  if (sep === undefined) return fail();
  const upperStart = next(begin);
  return {
    start: begin,
    end,
    versions: [undefined, [upperStart, base ?? sep], base !== undefined ? [next(base), sep] : undefined, [next(sep), endLine]],
  };
}

/** Keeps version N of conflict C, as smerge-keep-n. */
function smergeKeepN(c: Conflict, n: number): void {
  const [b, e] = c.versions[n]!;
  e8.deleteRegion(e, c.end);
  e8.deleteRegion(c.start, b);
}

/** Keeps all the versions of conflict C, as smerge-keep-all. */
function smergeKeepAll(c: Conflict): void {
  const [u, base, l] = [c.versions[1]!, c.versions[2], c.versions[3]!];
  const mb2 = base?.[0] ?? e8.pointMax();
  const me2 = base?.[1] ?? e8.pointMin();
  e8.deleteRegion(l[1], c.end);
  e8.deleteRegion(Math.max(me2, u[1]), l[0]);
  if (base && u[1] !== l[1]) e8.deleteRegion(u[1], base[0]);
  e8.deleteRegion(c.start, Math.min(u[0], mb2));
}

type Side = "current" | "upper" | "base" | "lower" | "all";

/** Keeps SIDE of conflict C, POS being point, as smerge-keep-current and the rest. */
function smergeKeep(side: Side, c: Conflict, pos: number): void {
  if (side === "all") smergeKeepAll(c);
  else if (side === "current") {
    let i = 3;
    while (i > 0 && (!c.versions[i] || pos < c.versions[i]![0] || pos > c.versions[i]![1])) i--;
    if (i <= 0) e8.signal("error", "Not inside a version");
    smergeKeepN(c, i);
  } else {
    const n = { upper: 1, base: 2, lower: 3 }[side];
    if (!c.versions[n]) e8.signal("error", "No base version");
    smergeKeepN(c, n);
  }
}

/**
 * Keeps SIDE of the conflict the line of point in a hunk shows, in the
 * file, then saves it, as magit-call-smerge: outside a conflict, the next
 * one's; for DISCARD keeping the current side outside one, asks which.
 */
export function magitCallSmerge(side: Side, discard = false): void {
  const file = magitFileAtPoint(true)!;
  const kept = e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === file);
  const [buf, pos] = magitDiffVisitFileNoselect();
  e8.withCurrentBuffer(buf, () => {
    e8.saveExcursion(() => {
      let at = pos;
      let fn = side;
      let c: Conflict | undefined;
      try {
        c = smergeMatchConflict(at);
      } catch {
        e8.gotoChar(at);
        if (fn === "current") {
          if (discard) {
            at = e8.reSearchForward("^<<<<<<< \\(.+\\)\n", { noerror: true }) ?? at;
            fn = magitReadCharCase<Side>("Keep side: ", true, [
              ["o", "[o]urs/upper", "upper"],
              ["b", "[b]ase", "base"],
              ["t", "[t]heirs/lower", "lower"],
            ]);
          }
        } else at = e8.reSearchForward("^<<<<<<< \\(.+\\)\n", { noerror: true }) ?? at;
        c = smergeMatchConflict(at);
      }
      smergeKeep(fn, c, at);
    });
    e8.call("save-buffer");
  });
  if (!kept) e8.call("kill-buffer", buf);
  magitRefresh();
}

const smergeCommand = (side: Exclude<Side, "current"> | "current", doc: string) =>
  e8.defineCommand({ name: `magit-smerge-keep-${side}`, doc, run: () => magitCallSmerge(side) });

export const magitSmergeKeepCurrent = smergeCommand("current", "Keep the current version of the conflict at point.");
export const magitSmergeKeepUpper = smergeCommand("upper", "Keep the upper/our version of the conflict at point.");
export const magitSmergeKeepBase = smergeCommand("base", "Keep the base version of the conflict at point.");
export const magitSmergeKeepLower = smergeCommand("lower", "Keep the lower/their version of the conflict at point.");
export const magitSmergeKeepAll = smergeCommand("all", "Keep all versions of the conflict at point.");
