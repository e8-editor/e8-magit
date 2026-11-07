// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diffs, after magit-diff.el and magit-stash.el's stash buffer: git's
// diff output washed into sections, as magit-diff-wash-diffs washes it:
// a diffstat, a section for each file with its status, a pseudo-hunk for a
// change of mode or a rename, and a section for each hunk; submodules,
// unmerged paths and combined diffs of merges. Hunks are painted in
// magit-diff-added, -removed and -context, and in their -highlight
// variants while the hunk is the current section, as Magit paints them,
// and with magit-diff-refine-hunk the words that changed are marked.
// The diff buffer (magit-diff-mode), the revision buffer
// (magit-revision-mode) with its headers, related refs and message, and
// the stash buffer (magit-stash-mode); the status buffer's unstaged and
// staged changes; and the commands that show and visit diffs, change
// their context and arguments, and scroll the diff shown.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import {
  currentSection,
  insertHeading,
  insertRoot,
  insertSection,
  magitCancelSection,
  magitGetSection,
  magitRegionSections,
  magitRegionValues,
  magitSectionInternalRegionP,
  magitSectionDefineType,
  magitSectionMatch,
  magitSectionParentValue,
  hide,
  magitSectionHiddenBody,
  magitSectionHideChildren,
  magitSectionShowChildren,
  magitSectionShowHeadings,
  sections,
  show,
  type Section,
} from "magit-section";
import { forwardLine, truthy } from "subr";
import { transientArgs } from "transient";
import { magitCompletingRead } from "magit-base";
import {
  magitAnythingModifiedP,
  magitBranchOrCommitAtPoint,
  magitBlameRevAtPoint,
  magitCommitAtPoint,
  magitCommitP,
  magitCommitParents,
  magitFileRelativeName,
  magitFileStatus,
  magitFormatRefLabels,
  magitGet,
  magitGetCurrentBranch,
  magitGetCurrentTag,
  magitGetNextTag,
  magitGetUpstreamBranch,
  magitGitExecutable,
  magitGitLines,
  magitGitRun,
  magitGitString,
  magitHashRange,
  magitListRelatedBranches,
  magitMergeInProgressP,
  magitObjectType,
  magitReadBranchOrCommit,
  magitReadRange,
  magitReadStash,
  magitRevEq,
  magitRevFormat,
  magitRevHeadP,
  magitRevParse,
  magitRevVerify,
  magitStashAtPoint,
  magitToplevel,
  magitToplevelOrError,
  type GitArg,
} from "magit-git";
import { magitBufferName, magitDiffMode, magitRefreshBuffer, magitRevisionMode, magitSetupBuffer, magitStashMode } from "magit-mode";

// Faces.

const faces: [string, string, e8.FaceAttributes, e8.FaceAttributes?, e8.FaceAttributes?][] = [
  ["magit-diff-file-heading", "Face for diff file headings.", { extend: true, weight: "bold" }],
  ["magit-diff-file-heading-highlight", "Face for current diff file headings.", { extend: true, inherit: "magit-section-highlight" }],
  ["magit-diff-file-heading-selection", "Face for selected diff file headings.", { extend: true, inherit: "magit-diff-file-heading-highlight" }, { foreground: "salmon4" }, { foreground: "LightSalmon3" }],
  ["magit-diff-hunk-heading", "Face for diff hunk headings.", { extend: true }, { background: "grey90", foreground: "grey20" }, { background: "grey25", foreground: "grey95" }],
  ["magit-diff-hunk-heading-highlight", "Face for current diff hunk headings.", { extend: true }, { background: "grey80", foreground: "grey20" }, { background: "grey35", foreground: "grey95" }],
  ["magit-diff-hunk-heading-selection", "Face for selected diff hunk headings.", { extend: true, inherit: "magit-diff-hunk-heading-highlight" }, { foreground: "salmon4" }, { foreground: "LightSalmon3" }],
  ["magit-diff-hunk-region", "Face used by magit-diff-highlight-hunk-region-using-face.", { inherit: "bold" }],
  ["magit-diff-conflict-heading-highlight", "Face for conflict markers.", { inherit: "magit-diff-hunk-heading-highlight" }],
  ["magit-diff-revision-summary", "Face for commit message summaries.", { inherit: "magit-diff-hunk-heading" }],
  ["magit-diff-revision-summary-highlight", "Face for highlighted commit message summaries.", { inherit: "magit-diff-hunk-heading-highlight" }],
  ["magit-diff-lines-heading", "Face for diff hunk heading when lines are marked.", { extend: true, inherit: "magit-diff-hunk-heading-highlight" }, { background: "LightSalmon3" }, { foreground: "grey80", background: "salmon4" }],
  ["magit-diff-lines-boundary", "Face for boundary of marked lines in diff hunk.", { extend: true, inherit: "magit-diff-lines-heading" }],
  ["magit-diff-conflict-heading", "Face for conflict markers.", { inherit: "magit-diff-hunk-heading" }],
  ["magit-diff-added", "Face for lines in a diff that have been added.", { extend: true }, { background: "#ddffdd", foreground: "#22aa22" }, { background: "#335533", foreground: "#ddffdd" }],
  ["magit-diff-removed", "Face for lines in a diff that have been removed.", { extend: true }, { background: "#ffdddd", foreground: "#aa2222" }, { background: "#553333", foreground: "#ffdddd" }],
  ["magit-diff-our", "Face for lines in a diff for our side in a conflict.", { inherit: "magit-diff-removed" }],
  ["magit-diff-base", "Face for lines in a diff for the base side in a conflict.", { extend: true }, { background: "#ffffcc", foreground: "#aaaa11" }, { background: "#555522", foreground: "#ffffcc" }],
  ["magit-diff-their", "Face for lines in a diff for their side in a conflict.", { inherit: "magit-diff-added" }],
  ["magit-diff-context", "Face for lines in a diff that are unchanged.", { extend: true }, { foreground: "grey50" }, { foreground: "grey70" }],
  ["magit-diff-added-highlight", "Face for lines in a diff that have been added.", { extend: true }, { background: "#cceecc", foreground: "#22aa22" }, { background: "#336633", foreground: "#cceecc" }],
  ["magit-diff-removed-highlight", "Face for lines in a diff that have been removed.", { extend: true }, { background: "#eecccc", foreground: "#aa2222" }, { background: "#663333", foreground: "#eecccc" }],
  ["magit-diff-our-highlight", "Face for lines in a diff for our side in a conflict.", { inherit: "magit-diff-removed-highlight" }],
  ["magit-diff-base-highlight", "Face for lines in a diff for the base side in a conflict.", { extend: true }, { background: "#eeeebb", foreground: "#aaaa11" }, { background: "#666622", foreground: "#eeeebb" }],
  ["magit-diff-their-highlight", "Face for lines in a diff for their side in a conflict.", { inherit: "magit-diff-added-highlight" }],
  ["magit-diff-context-highlight", "Face for lines in the current context in a diff.", { extend: true }, { background: "grey95", foreground: "grey50" }, { background: "grey20", foreground: "grey70" }],
  ["magit-diff-whitespace-warning", "Face for highlighting whitespace errors added lines.", { inherit: "trailing-whitespace" }],
  ["magit-diffstat-added", "Face for plus sign in diffstat.", {}, { foreground: "#22aa22" }, { foreground: "#448844" }],
  ["magit-diffstat-removed", "Face for minus sign in diffstat.", {}, { foreground: "#aa2222" }, { foreground: "#aa4444" }],
  ["magit-diff-refine-added", "Face for the words added within a refined hunk, as diff-refine-added.", { inherit: "diff-refine-added" }, { background: "#aaffaa" }, { background: "#22aa22" }],
  ["magit-diff-refine-removed", "Face for the words removed within a refined hunk, as diff-refine-removed.", { inherit: "diff-refine-removed" }, { background: "#ffbbbb" }, { background: "#aa2222" }],
  ["magit-keyword", "Face for parts of commit messages inside brackets.", { inherit: "font-lock-string-face" }],
  ["magit-keyword-squash", "Face for squash! and similar markers.", { inherit: "font-lock-warning-face" }],
];
for (const [name, doc, attributes, light, dark] of faces) e8.defineFace({ name, doc, attributes, light, dark });

// Options.

e8.defineVariable({ name: "magit-diff-highlight-hunk-body", doc: "Whether to highlight bodies of selected hunk sections.", value: true });
e8.defineVariable({ name: "magit-diff-refine-hunk", doc: "Whether to show word-granularity differences within diff hunks: nil, t for the current hunk, or all.", value: null });
e8.defineVariable({ name: "magit-diff-refine-ignore-whitespace", doc: "Whether to ignore whitespace changes in word-granularity differences.", value: true });
e8.defineVariable({ name: "magit-diff-paint-whitespace", doc: "Whether to highlight whitespace errors in added lines: t, nil, uncommitted or status.", value: true });
e8.defineVariable({ name: "magit-diff-paint-whitespace-lines", doc: "Which lines to paint whitespace errors on: t added only, both added and removed, all.", value: "t" });
e8.defineVariable({ name: "magit-diff-highlight-trailing", doc: "Whether to highlight whitespace at the end of a line in diffs.", value: true });
e8.defineVariable({ name: "magit-diff-hide-trailing-cr-characters", doc: "Whether to hide ^M characters at the end of a line in diffs.", value: true });
e8.defineVariable({ name: "magit-diff-extra-stat-arguments", doc: "Additional arguments to be used alongside --stat.", value: [] });
e8.defineVariable({ name: "magit-revision-insert-related-refs", doc: "Whether to show related branches in revision buffers: nil, t (local), all, or mixed.", value: true });
e8.defineVariable({ name: "magit-revision-insert-related-refs-display-alist", doc: "Which related branch types revision buffers show: parents, merged, contained, follows and precedes, each t or nil.", value: [] });
e8.defineVariable({ name: "magit-revision-use-hash-sections", doc: "Whether to turn hashes inside the commit message into sections: quickest, quicker, quick or slow, or nil.", value: "quicker" });
e8.defineVariable({
  name: "magit-revision-headers-format",
  doc: "Format string used to insert headers in revision buffers.",
  value: "Author:     %aN <%aE>\nAuthorDate: %ad\nCommit:     %cN <%cE>\nCommitDate: %cd\n",
});
e8.defineVariable({ name: "magit-diff-visit-prefer-worktree", doc: "Whether magit-diff-visit-file prefers the work tree's file over a blob.", value: false });
e8.defineVariable({ name: "magit-diff-default-context", doc: "How many lines of context -U gives by default; nil for git's.", value: null });
e8.defineHook("magit-diff-wash-diffs-hook", "Hook run before a diff is washed.");
e8.defineVariable({ name: "magit-diff-sections-hook", doc: "Functions inserting the sections of a diff buffer.", value: ["magit-insert-diff", "magit-insert-xref-buttons"] });
e8.defineVariable({
  name: "magit-revision-sections-hook",
  doc: "Functions inserting the sections of a revision buffer.",
  value: ["magit-insert-revision-tag", "magit-insert-revision-headers", "magit-insert-revision-message", "magit-insert-revision-notes", "magit-insert-revision-diff", "magit-insert-xref-buttons"],
});
e8.defineVariable({ name: "magit-stash-sections-hook", doc: "Functions inserting the sections of a stash buffer.", value: ["magit-insert-stash-notes", "magit-insert-stash-worktree", "magit-insert-stash-index", "magit-insert-stash-untracked"] });

/** The arguments git diff gets in each kind of buffer by default, as Magit's modes' magit-diff-default-arguments. */
const defaultArguments: { [mode: string]: string[] } = {
  "magit-diff-mode": ["--stat", "--no-ext-diff"],
  "magit-revision-mode": ["--stat", "--no-ext-diff"],
  "magit-stash-mode": ["--no-ext-diff"],
  "magit-status-mode": ["--no-ext-diff"],
  "magit-log-mode": ["--no-ext-diff"],
};

/**
 * The diff arguments and files for a buffer of MODE, as magit-diff-arguments:
 * the menu's when run from it, the current buffer's when it is of MODE, else
 * MODE's defaults.
 */
export function magitDiffArguments(mode = "magit-diff-mode"): [string[], string[]] {
  const current = e8.variable("transient-current-command");
  if (current === "magit-diff" || current === "magit-diff-refresh") return splitFiles(transientArgs(String(current)));
  if (String(e8.variable("major-mode")) === mode && Array.isArray(e8.variable("magit-buffer-diff-args"))) {
    return [e8.variable("magit-buffer-diff-args") as string[], (e8.variable("magit-buffer-diff-files") as string[] | null) ?? []];
  }
  return [defaultArguments[mode] ?? ["--no-ext-diff"], []];
}
const splitFiles = (args: string[]): [string[], string[]] => {
  const files = args.filter((a) => a.startsWith("-- ")).flatMap((a) => a.slice(3).split(","));
  return [args.filter((a) => !a.startsWith("-- ")), files];
};

// Values of diff sections.

/** A file's diff: its status, its header lines and its hunks, as Magit's file sections keep them. */
export interface FileDiff {
  file: string;
  orig?: string;
  status: string;
  header: string[];
  hunks: Hunk[];
  binary?: boolean;
}

/** A hunk: its heading line, its body lines, and its ranges as magit-hunk-section's slots. */
export interface Hunk {
  heading: string;
  lines: string[];
  about?: string;
  fromRange: number[] | number[][];
  toRange: number[];
  combined: boolean;
}

/** The value of a file or hunk section: the file, which list it is in, its diff and, for a hunk, the hunk. */
export interface FileValue {
  file: string;
  kind: "untracked" | "unstaged" | "staged" | "commit" | "diffstat";
  diff?: FileDiff;
  hunk?: Hunk;
  ident?: string;
}

const fl = (text: string, face: string | string[]): e8.PropertizedString => e8.propertize(text, { "font-lock-face": face });

// Washing.

const conflictHeadlineRe = /^(merged|added in remote|added in both|added in local|removed in both|changed in both|removed in local|removed in remote)/;
const headlineRe = /^(@@@?|diff|Submodule|\* Unmerged path|merged|added in remote|added in both|added in local|removed in both|changed in both|removed in local|removed in remote)/;
const statlineRe = /^ ?(.*)( +\| +)([0-9]+|Bin(?: +[0-9]+ -> [0-9]+ bytes)?$) ?(\+*)(-*)$/;
const hunkRe = /^@{2,} (.+?) @{2,}(?: (.*))?/;

/** Lines being washed, and the next one. */
interface Wash {
  lines: string[];
  i: number;
  kind: FileValue["kind"];
  args: string[];
  /** The major mode of the buffer, as the washers ask derived-mode-p. */
  mode: string;
}

/** Formats a file as a diff heading or diffstat line names it, as magit-format-file-default. */
export function magitFormatFile(file: string, face: string, status?: string, orig?: string): e8.PropertizedString {
  return fl(`${status !== undefined ? status.padEnd(11) : ""}${orig ? `${orig} -> ${file}` : file}`, face);
}

/**
 * Inserts git's diff OUTPUT at point washed into sections, as
 * magit-diff-wash-diffs: a diffstat if ARGS has --stat, then a section
 * for each file. KIND says which list the files belong to.
 */
export function magitDiffWashDiffs(output: string, args: string[], kind: FileValue["kind"] = "commit"): FileDiff[] {
  e8.runHooks("magit-diff-wash-diffs-hook");
  const lines = output.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const w: Wash = { lines, i: 0, kind, args, mode: String(e8.variable("major-mode")) };
  if (args.includes("--stat")) washDiffstat(w);
  const files: FileDiff[] = [];
  let seen = false;
  while (w.i < lines.length) {
    if (!seen && !headlineRe.test(lines[w.i])) {
      e8.insert(`${lines[w.i++]}\n`);
      continue;
    }
    seen = true;
    const before = w.i;
    const f = washDiff(w);
    if (f) files.push(f);
    if (w.i === before) w.i++;
  }
  if (seen) e8.insert("\n");
  return files;
}

/** Inserts the diffstat, as magit-diff-wash-diffstat. */
function washDiffstat(w: Wash): void {
  const summaryAt = w.lines.findIndex((l, i) => i >= w.i && /^ ?[0-9]+ +files? change/.test(l));
  if (summaryAt < 0) return;
  const heading = w.lines[summaryAt].replace(/^ /, "");
  w.lines.splice(summaryAt, 1);
  insertSection("diffstat", undefined, false, () => {
    insertHeading(fl(`${heading}\n`, "magit-diff-file-heading"));
    const files: string[] = [];
    let m: RegExpExecArray | null;
    while (w.i < w.lines.length && (m = /^[-0-9]+\t[-0-9]+\t(.+)$/.exec(w.lines[w.i]))) {
      const file = m[1];
      const brace = /\{.* => (.*)\}/.exec(file);
      files.push(brace ? file.replace(/\{.* => (.*)\}/, brace[1]) : file.includes(" => ") ? file.slice(file.indexOf(" => ") + 4) : file);
      w.i++;
    }
    while (w.i < w.lines.length && (m = statlineRe.exec(w.lines[w.i]))) {
      let [, file, sep] = m;
      const [, , , cnt, add, del] = m;
      w.i++;
      const trailing = / +$/.exec(file);
      if (trailing) {
        sep = trailing[0] + sep;
        file = file.slice(0, trailing.index);
      }
      const value = files.shift() ?? file;
      insertSection("file", { file: value, kind: "diffstat" } as FileValue, false, () => {
        e8.insert(magitFormatFile(file, "magit-filename"));
        e8.insert(`${sep}${cnt} `);
        if (add) e8.insert(fl(add, "magit-diffstat-added"));
        if (del) e8.insert(fl(del, "magit-diffstat-removed"));
        e8.insert("\n");
      });
    }
    if (w.i < w.lines.length && w.lines[w.i] === "") {
      e8.insert("\n");
      w.i++;
    } else e8.insert("\n");
  });
}

/** Washes one file's diff, as magit-diff-wash-diff; gives its diff. */
function washDiff(w: Wash): FileDiff | undefined {
  const line = w.lines[w.i];
  if (line.startsWith("Submodule")) {
    washSubmodule(w);
    return undefined;
  }
  let m = /^\* Unmerged path (.*)/.exec(line);
  if (m) {
    const file = m[1];
    w.i++;
    if (!(w.mode === "magit-status-mode" && !w.args.includes("--cached"))) {
      const st = magitFileStatus(file)[0]?.slice(0, 2) ?? "UU";
      const suffix = ({ DD: " (both deleted)", DU: " (deleted by us)", UD: " (deleted by them)", AA: " (both added)", AU: " (added by us)", UA: " (added by them)" } as { [k: string]: string })[st] ?? "";
      insertSection("file", { file, kind: w.kind, ident: file } as FileValue, false, () => {
        e8.insert(fl(`unmerged   ${file}${suffix}`, "magit-diff-file-heading"));
        e8.insert("\n");
      });
    }
    return undefined;
  }
  m = conflictHeadlineRe.exec(line);
  if (m) {
    let longStatus: string | undefined = m[0];
    let status = "BUG";
    if (longStatus === "merged") {
      status = "merged";
      longStatus = undefined;
    } else status = ({ "added in remote": "new file", "added in both": "new file", "added in local": "new file", "removed in both": "removed", "changed in both": "changed", "removed in local": "removed", "removed in remote": "removed" } as { [k: string]: string })[longStatus];
    w.i++;
    let file: string | undefined;
    let orig: string | undefined;
    let base: string | undefined;
    let sm: RegExpExecArray | null;
    while (w.i < w.lines.length && (sm = /^ {2}([^ ]+) +[0-9]{6} ([a-z0-9]{40,}) (.+)$/.exec(w.lines[w.i]))) {
      if (sm[1] === "result" || sm[1] === "their") file = sm[3];
      else if (sm[1] === "our") orig = sm[3];
      else if (sm[1] === "base") base = sm[3];
      w.i++;
    }
    return insertFileSection(w, (file ?? base)!, orig, status, undefined, undefined, [], false, longStatus);
  }
  m = /^diff --(?:(git) (?:(.+?) \2)?|(?:cc|combined) (.+))/.exec(line);
  if (!m) return undefined;
  let status = m[1] === "git" ? "modified" : w.mode === "magit-revision-mode" ? "resolved" : "unmerged";
  let orig: string | undefined;
  let file = m[2] ?? m[3];
  const header: string[] = [line];
  let modes: string | undefined;
  let rename: string | undefined;
  let binary = false;
  w.i++;
  while (w.i < w.lines.length && !headlineRe.test(w.lines[w.i])) {
    const l = w.lines[w.i];
    const next = w.lines[w.i + 1] ?? "";
    if (l.startsWith("old mode ") && next.startsWith("new mode ")) {
      modes = `${l}\n${next}\n`;
      w.i += 2;
      continue;
    }
    if (l.startsWith("rename from ") && next.startsWith("rename to ")) {
      rename = `${l}\n${next}\n`;
      orig = l.slice(12);
      file = next.slice(10);
      status = "renamed";
      w.i += 2;
      continue;
    }
    if (l.startsWith("copy from ") && next.startsWith("copy to ")) {
      orig = l.slice(10);
      file = next.slice(8);
      status = "new file";
      header.push(l, next);
      w.i += 2;
      continue;
    }
    if (l.startsWith("deleted file ")) status = "deleted";
    else if (l.startsWith("new file ")) status = "new file";
    else if (/^--- (.+?)\t?$/.test(l)) {
      const o = /^--- (.+?)\t?$/.exec(l)![1];
      if (o !== "/dev/null") orig = o;
    } else if (/^\+\+\+ (.+?)\t?$/.test(l)) {
      const f = /^\+\+\+ (.+?)\t?$/.exec(l)![1];
      if (f !== "/dev/null") file = f;
    } else if (/^Binary files (.+ and .+ )?differ$/.test(l)) binary = true;
    header.push(l);
    w.i++;
  }
  return insertFileSection(w, file!, orig, status, modes, rename, header, binary, undefined);
}

/** Inserts a file's section with its pseudo-hunks and hunks, as magit-diff-insert-file-section. */
function insertFileSection(w: Wash, file: string, orig: string | undefined, status: string, modes: string | undefined, rename: string | undefined, header: string[], binary: boolean, longStatus: string | undefined): FileDiff {
  const diff: FileDiff = { file, orig: orig !== file ? orig : undefined, status, header, hunks: [], binary };
  const value: FileValue = { file, kind: w.kind, diff, ident: file };
  insertSection("file", value, status === "deleted" || w.mode === "magit-status-mode", () => {
    const suffix = binary && longStatus ? ` (${longStatus}, binary)` : binary || longStatus ? ` (${binary ? "binary" : longStatus})` : undefined;
    insertHeading(magitFormatFile(file, "magit-diff-file-heading", status, orig !== file ? orig : undefined), ...(suffix ? [suffix] : []));
    if (modes) insertSection("hunk", { file, kind: w.kind, diff, ident: "chmod" } as FileValue, false, () => insertHeading(fl(modes, "default")));
    if (rename) insertSection("hunk", { file, kind: w.kind, diff, ident: "rename" } as FileValue, false, () => insertHeading(fl(rename, "default")));
    while (w.i < w.lines.length && washHunk(w, value)) {
      // Each hunk.
    }
  });
  return diff;
}

/** Washes one hunk, as magit-diff-wash-hunk; whether there was one. */
function washHunk(w: Wash, file: FileValue): boolean {
  const m = hunkRe.exec(w.lines[w.i]);
  if (!m) return false;
  const heading = m[0];
  const ranges = m[1].split(" ").map((str) => {
    const r = str.slice(1).split(",").map(Number);
    return r.length === 1 ? [r[0], 1] : r;
  });
  const combined = ranges.length === 3;
  const hunk: Hunk = { heading: w.lines[w.i], lines: [], about: m[2], fromRange: combined ? ranges.slice(0, -1) : ranges[0], toRange: ranges[ranges.length - 1], combined };
  w.i++;
  file.diff?.hunks.push(hunk);
  insertSection("hunk", { file: file.file, kind: file.kind, diff: file.diff, hunk, ident: `${heading}` } as FileValue, false, () => {
    insertHeading(fl(`${hunk.heading}\n`, "magit-diff-hunk-heading"));
    while (w.i < w.lines.length && !(w.lines[w.i] === "" || /^[^-+ \\]/.test(w.lines[w.i]))) {
      hunk.lines.push(w.lines[w.i]);
      e8.insert(`${w.lines[w.i]}\n`);
      w.i++;
    }
  });
  return true;
}

/** Washes a submodule's summary, as magit-diff-wash-submodule. */
function washSubmodule(w: Wash): void {
  let m = /^Submodule ([^ ]+)/.exec(w.lines[w.i]);
  if (!m) {
    w.i++;
    return;
  }
  const module = m[1];
  let untracked = false;
  let modified = false;
  if (/^Submodule [^ ]+ contains untracked content$/.test(w.lines[w.i])) {
    w.i++;
    untracked = true;
  }
  if (w.i < w.lines.length && /^Submodule [^ ]+ contains modified content$/.test(w.lines[w.i])) {
    w.i++;
    modified = true;
  }
  const content = (modified || untracked ? `, ${modified ? "modified" : ""}${modified && untracked ? " and " : ""}${untracked ? "untracked" : ""} content` : "");
  const line = w.lines[w.i] ?? "";
  if ((m = /^Submodule ([^ ]+) ([^ :]+)( \(rewind\))?:$/.exec(line)) && m[1] === module) {
    const [, , rangeRaw, rewind] = m;
    w.i++;
    while (w.i < w.lines.length && /^ {2}([<>]) (.*)$/.test(w.lines[w.i])) w.i++;
    const range = rewind ? rangeRaw.replace(/([^.])\.\.([^.])/, "$1...$2") : rangeRaw;
    insertSection("module", module, true, () => {
      insertHeading(magitFormatFile(module, "magit-diff-file-heading", "modified"), ` (${rewind ? "rewind" : range.includes("...") ? "non-ff" : "new commits"}${content})`);
      const dir = e8.fileNameAsDirectory(e8.expandFileName(module, magitToplevel()));
      for (const l of magitGitRun(["log", "--oneline", "--left-right", range], { dir }).output.split("\n").filter((x) => x !== "")) {
        const lm = /^([<>]?)([0-9a-f]+) (.*)$/.exec(l);
        if (!lm) continue;
        insertSection("module-commit", lm[2], false, () => insertHeading(fl(lm[2], "magit-hash"), ` ${lm[3]}`));
      }
    });
  } else if ((m = /^Submodule ([^ ]+) ([^ ]+) \(([^)]+)\)$/.exec(line)) && m[1] === module) {
    const msg = m[3];
    w.i++;
    insertSection("module", module, false, () => insertHeading(magitFormatFile(module, "magit-diff-file-heading", "submodule"), ` (${msg})`));
  } else {
    insertSection("module", module, false, () => insertHeading(magitFormatFile(module, "magit-diff-file-heading", "modified"), ` (${modified ? "modified" : ""}${modified && untracked ? " and " : ""}${untracked ? "untracked" : ""} content)`));
  }
}

/** Runs git with ARGS and inserts its diff washed, cancelling the section if there is none, as magit--insert-diff. */
export function magitInsertGitDiff(args: GitArg[], kind: FileValue["kind"] = "commit"): FileDiff[] {
  const flat = flattenArgs(args);
  const [cmd, ...rest] = flat;
  const gitArgs = [cmd, ...(cmd !== "merge-tree" ? ["--ita-visible-in-index"] : []), ...withStatArgs(rest)];
  const global = ((e8.variable("magit-git-global-arguments") as string[] | null) ?? []).filter((a) => a !== "--literal-pathspecs");
  const r = e8.callProcess([magitGitExecutable(), ...global, ...gitArgs], { directory: e8.expandFileName(String(e8.variable("default-directory"))) });
  const output = r.exit === 0 || r.output.startsWith("diff ") ? r.output : "";
  if (output === "") {
    magitCancelSection();
    return [];
  }
  return magitDiffWashDiffs(output, rest, kind);
}
const flattenArgs = (args: GitArg[]): string[] => args.flatMap((a) => (Array.isArray(a) ? flattenArgs(a) : a === undefined || a === null || a === false ? [] : [a]));
const withStatArgs = (args: string[]): string[] => (args.includes("--stat") ? [...((e8.variable("magit-diff-extra-stat-arguments") as string[] | null) ?? []), ...args] : args);

// Painting.

/** Paints a hunk's body plainly or highlighted, as magit-section-paint does for hunks. */
function paintHunk(section: Section, highlight: boolean): void {
  const on = highlight && truthy(e8.variable("magit-diff-highlight-hunk-body"));
  const merging = e8.bufferSubstringNoProperties(section.start, Math.min(section.start + 3, section.end)) === "@@@";
  let stage: string | undefined;
  // From the line after the heading's first, as Magit's painter goes forward a line from the start.
  let p = Math.min(e8.lineEnd(e8.lineOf(section.start)) + 1, section.end);
  const trailing = truthy(e8.variable("magit-diff-paint-whitespace")) && truthy(e8.variable("magit-diff-highlight-trailing"));
  for (const o of e8.overlaysIn(section.content, section.end)) if (e8.overlayGet(o, "magit-diff-whitespace") === true) e8.deleteOverlay(o);
  while (p < section.end) {
    const eol = e8.lineEnd(e8.lineOf(p));
    const line = e8.bufferSubstringNoProperties(p, eol);
    let face: string | undefined;
    const conflict = /^\+\+?([<=|>]){7}/.exec(line);
    if (conflict) {
      stage = ({ "<": on ? "magit-diff-our-highlight" : "magit-diff-our", "|": on ? "magit-diff-base-highlight" : "magit-diff-base", "=": on ? "magit-diff-their-highlight" : "magit-diff-their" } as { [k: string]: string })[conflict[1]];
      face = on ? "magit-diff-conflict-heading-highlight" : "magit-diff-conflict-heading";
    } else if ((merging ? /^(\+| \+)/ : /^\+/).test(line)) {
      face = stage ?? (on ? "magit-diff-added-highlight" : "magit-diff-added");
      if (trailing) paintTrailing(p, line, merging);
    } else if ((merging ? /^(-| -)/ : /^-/).test(line)) face = on ? "magit-diff-removed-highlight" : "magit-diff-removed";
    else face = on ? "magit-diff-context-highlight" : "magit-diff-context";
    e8.putTextProperty(p, Math.min(eol + 1, section.end), "font-lock-face", face);
    if (truthy(e8.variable("magit-diff-hide-trailing-cr-characters")) && line.endsWith("\r")) e8.putTextProperty(eol - 1, eol, "invisible", true);
    p = eol + 1;
  }
  const refine = e8.variable("magit-diff-refine-hunk");
  if (refine === "all" || (refine === true && on)) refineHunk(section);
}

/** Marks whitespace at the end of an added line, as magit-diff-paint-whitespace. */
function paintTrailing(start: number, line: string, merging: boolean): void {
  const m = (merging ? /^[-+ ]{2}.*?([ \t]+)$/ : /^[-+ ].*?([ \t]+)$/).exec(line);
  if (!m) return;
  const at = start + line.length - m[1].length;
  e8.makeOverlay(at, start + line.length, { face: "magit-diff-whitespace-warning", priority: 2, evaporate: true, "magit-diff-whitespace": true });
}

magitSectionDefineType("hunk", { headingHighlightFace: "magit-diff-hunk-heading-highlight", headingSelectionFace: "magit-diff-hunk-heading-selection", paint: paintHunk, keymap: "magit-hunk-section-map" });
magitSectionDefineType("file", { headingHighlightFace: "magit-diff-file-heading-highlight", headingSelectionFace: "magit-diff-file-heading-selection", keymap: "magit-file-section-map" });
magitSectionDefineType("module", { headingHighlightFace: "magit-diff-file-heading-highlight", headingSelectionFace: "magit-diff-file-heading-selection" });
magitSectionDefineType("commit-message", { headingHighlightFace: "magit-diff-revision-summary-highlight" });
magitSectionDefineType("notes", { headingHighlightFace: "magit-diff-hunk-heading-highlight" });
magitSectionDefineType("message", { headingHighlightFace: "magit-diff-revision-summary-highlight" });

// Refinement.

/** Marks the words that changed between a hunk's removed and added lines, as diff-refine-hunk does for magit-diff-update-hunk-refinement. */
function refineHunk(section: Section): void {
  for (const o of e8.overlaysIn(section.start, section.end)) if (e8.overlayGet(o, "diff-mode") === "fine") e8.deleteOverlay(o);
  const ignoreSpace = truthy(e8.variable("magit-diff-refine-ignore-whitespace"));
  let p = section.content;
  const lines: { start: number; text: string }[] = [];
  while (p < section.end) {
    const eol = e8.lineEnd(e8.lineOf(p));
    lines.push({ start: p, text: e8.bufferSubstringNoProperties(p, eol) });
    p = eol + 1;
  }
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].text.startsWith("-")) {
      i++;
      continue;
    }
    const removed: typeof lines = [];
    while (i < lines.length && lines[i].text.startsWith("-")) removed.push(lines[i++]);
    const added: typeof lines = [];
    while (i < lines.length && lines[i].text.startsWith("+")) added.push(lines[i++]);
    if (added.length === 0) continue;
    refineRegions(removed, added, ignoreSpace);
  }
}

/** The words of LINES, each with where it is in the buffer, the diff marker left out. */
function words(lines: { start: number; text: string }[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (const l of lines) {
    const re = /\w+|\s+|[^\w\s]/g;
    let m: RegExpExecArray | null;
    const body = l.text.slice(1);
    while ((m = re.exec(body))) out.push({ text: m[0], start: l.start + 1 + m.index, end: l.start + 1 + m.index + m[0].length });
    out.push({ text: "\n", start: l.start + l.text.length, end: l.start + l.text.length });
  }
  return out;
}

/** Marks what differs between two runs of lines, word by word, as smerge-refine-regions. */
function refineRegions(removed: { start: number; text: string }[], added: { start: number; text: string }[], ignoreSpace: boolean): void {
  const a = words(removed);
  const b = words(added);
  if (a.length * b.length > 1_000_000) return;
  const key = (t: string) => (ignoreSpace && /^\s+$/.test(t) && t !== "\n" ? " " : t);
  // The longest common subsequence of the words, by dynamic programming.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = key(a[i].text) === key(b[j].text) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const inA = new Array<boolean>(n).fill(false);
  const inB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (key(a[i].text) === key(b[j].text)) {
      inA[i++] = true;
      inB[j++] = true;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const mark = (ws: typeof a, kept: boolean[], face: string) => {
    for (let i = 0; i < ws.length; i++) {
      if (kept[i] || ws[i].end === ws[i].start) continue;
      let j = i;
      while (j + 1 < ws.length && !kept[j + 1] && ws[j + 1].end > ws[j + 1].start && ws[j + 1].start === ws[j].end) j++;
      if (!(ignoreSpace && ws.slice(i, j + 1).every((w) => /^\s+$/.test(w.text)))) e8.makeOverlay(ws[i].start, ws[j].end, { face, "diff-mode": "fine", priority: 1, evaporate: true });
      i = j;
    }
  };
  mark(a, inA, "magit-diff-refine-removed");
  mark(b, inB, "magit-diff-refine-added");
}

/** Refines the hunks as magit-diff-refine-hunk now says, or removes refinement, as magit-diff-update-hunk-refinement. */
export function magitDiffUpdateHunkRefinement(): void {
  const refine = e8.variable("magit-diff-refine-hunk");
  const at = currentSection();
  for (const s of sections()?.all ?? []) {
    if (s.type !== "hunk" || s.hidden) continue;
    if (refine === "all" || (refine === true && s === at)) refineHunk(s);
    else for (const o of e8.overlaysIn(s.start, s.end)) if (e8.overlayGet(o, "diff-mode") === "fine") e8.deleteOverlay(o);
  }
}

// The status buffer's changes.

/** Inserts the unstaged changes, as magit-insert-unstaged-changes. */
export function magitInsertUnstagedChanges(): void {
  insertSection(
    "unstaged",
    undefined,
    false,
    () => {
      insertHeading(true, "Unstaged changes");
      magitInsertGitDiff(["diff", statusDiffArgs(), "--no-prefix", "--", (e8.variable("magit-buffer-diff-files") as string[] | null) ?? []], "unstaged");
    },
    "magit-insert-unstaged-changes",
  );
}

/** Inserts the staged changes, as magit-insert-staged-changes. */
export function magitInsertStagedChanges(): void {
  if (magitGitString("rev-parse", "--is-bare-repository") === "true") return;
  insertSection(
    "staged",
    undefined,
    false,
    () => {
      insertHeading(true, "Staged changes");
      magitInsertGitDiff(["diff", "--cached", statusDiffArgs(), "--no-prefix", "--", (e8.variable("magit-buffer-diff-files") as string[] | null) ?? []], "staged");
    },
    "magit-insert-staged-changes",
  );
}

const statusDiffArgs = (): string[] => (Array.isArray(e8.variable("magit-buffer-diff-args")) ? (e8.variable("magit-buffer-diff-args") as string[]) : defaultArguments["magit-status-mode"]);

// The diff buffer.

/** Shows a diff in the diff buffer, as magit-diff-setup-buffer. */
export function magitDiffSetupBuffer(range: string | undefined, typearg: string | undefined, args: string[], files: string[], type?: string): string {
  const name = magitBufferName("magit-diff-mode");
  return magitSetupBuffer(name, magitDiffMode, "diff", magitDiffRefreshBuffer, true, {
    "magit-buffer-range": range ?? null,
    "magit-buffer-typearg": typearg ?? null,
    "magit-buffer-diff-type": type ?? null,
    "magit-buffer-diff-args": args,
    "magit-buffer-diff-files": files,
  });
}

/** What the diff buffer's header line says, as magit-diff-refresh-buffer sets it. */
function diffHeaderLine(): string {
  const range = e8.variable("magit-buffer-range") as string | null;
  const typearg = e8.variable("magit-buffer-typearg") as string | null;
  const args = (e8.variable("magit-buffer-diff-args") as string[] | null) ?? [];
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  if (typearg === "--no-index") return `Differences between ${files[0]} and ${files[1]}`;
  let head: string;
  if (range) {
    if (/(\.\.|\^-)/.test(range)) head = `Changes in ${range}`;
    else {
      const end = typearg === "--cached" ? "index" : "working tree";
      head = args.includes("-R") ? `Changes from ${end} to ${range}` : `Changes from ${range} to ${end}`;
    }
  } else head = typearg === "--cached" ? "Staged changes" : "Unstaged changes";
  return `${head}${files.length === 1 ? ` in file ${files[0]}` : files.length > 1 ? ` in files ${files.join(", ")}` : ""}`;
}

/** Makes the diff buffer, as magit-diff-refresh-buffer: its header line and the sections of magit-diff-sections-hook. */
export function magitDiffRefreshBuffer(): void {
  e8.setVariable("header-line-format", diffHeaderLine());
  const range = e8.variable("magit-buffer-range") as string | null;
  e8.makeLocalVariable("magit-buffer-range-hashed");
  e8.setVariable("magit-buffer-range-hashed", range ? (magitHashRange(range) ?? null) : null);
  insertRoot("diffbuf", () => runSectionHook("magit-diff-sections-hook"));
}

/** Runs the inserters a section hook names, as magit-run-section-hook. */
export function runSectionHook(hook: string): void {
  const fns = (e8.variable(hook) as unknown[] | null) ?? [];
  for (const fn of fns) {
    if (typeof fn === "string" && inserters.has(fn)) inserters.get(fn)!();
    else if (typeof fn === "string" && e8.fboundp(fn)) e8.funcall(fn);
    else if (typeof fn === "function") (fn as () => void)();
  }
}

/** The section inserters by name, as the functions Magit's section hooks list. */
export const inserters = new Map<string, () => void>();

/** Inserts the diff of the diff buffer, as magit-insert-diff. */
function magitInsertDiff(): void {
  const args = (e8.variable("magit-buffer-diff-args") as string[] | null) ?? [];
  const range = e8.variable("magit-buffer-range") as string | null;
  const typearg = e8.variable("magit-buffer-typearg") as string | null;
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  const type = String(e8.variable("magit-buffer-diff-type") ?? "");
  magitInsertGitDiff(["diff", range ?? undefined, "-p", "--no-prefix", args.includes("--stat") ? "--numstat" : undefined, typearg ?? undefined, args, "--", files], type === "staged" ? "staged" : type === "unstaged" ? "unstaged" : "commit");
}
inserters.set("magit-insert-diff", magitInsertDiff);
inserters.set("magit-insert-xref-buttons", () => {});
inserters.set("magit-insert-unstaged-changes", magitInsertUnstagedChanges);
inserters.set("magit-insert-staged-changes", magitInsertStagedChanges);

// The revision buffer.

/** Shows REV in the revision buffer, as magit-revision-setup-buffer. */
export function magitRevisionSetupBuffer(rev: string, args: string[], files: string[]): string {
  const name = magitBufferName("magit-revision-mode");
  return magitSetupBuffer(name, magitRevisionMode, "revision", magitRevisionRefreshBuffer, true, {
    "magit-buffer-revision": rev,
    "magit-buffer-range": `${rev}^..${rev}`,
    "magit-buffer-diff-type": "committed",
    "magit-buffer-diff-args": args,
    "magit-buffer-diff-files": files,
  });
}

/** Makes the revision buffer, as magit-revision-refresh-buffer. */
export function magitRevisionRefreshBuffer(): void {
  const rev = String(e8.variable("magit-buffer-revision"));
  const hash = magitRevParse(rev) ?? rev;
  e8.makeLocalVariable("magit-buffer-revision-hash");
  e8.setVariable("magit-buffer-revision-hash", hash);
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  e8.setVariable("header-line-format", `${magitObjectType(hash) ?? "commit"} ${rev}${files.length === 1 ? ` limited to file ${files[0]}` : files.length > 1 ? ` limited to files ${files.join(", ")}` : ""}`);
  insertRoot("commitbuf", () => runSectionHook("magit-revision-sections-hook"));
}

/** The commit a tag or ref names, as magit--rev-dereference. */
const dereference = (rev: string): string => (magitObjectType(rev) === "tag" ? `${rev}^{commit}` : rev);

/** Inserts a tag's message and tagger, when the revision is an annotated tag, as magit-insert-revision-tag. */
function magitInsertRevisionTag(): void {
  const rev = String(e8.variable("magit-buffer-revision"));
  if (magitObjectType(rev) !== "tag") return;
  const raw = magitGitRun(["cat-file", "tag", rev]).output.split("\n");
  const rest = raw.slice(3);
  const tagger = /^tagger ([^<]+) <([^>]+)>/.exec(rest[0] ?? "");
  insertSection("taginfo", undefined, false, () => {
    insertHeading(fl(`Tagger: ${tagger?.[1] ?? ""} <${tagger?.[2] ?? ""}>`, "magit-section-secondary-heading"));
    // The blank line after the tagger stays, as Magit leaves it.
    const body = rest.slice(1);
    if (body[0] === "") {
      e8.insert("\n");
      body.shift();
    }
    const sig = body.findIndex((l) => l === "-----BEGIN PGP SIGNATURE-----");
    const message = (sig >= 0 ? body.slice(0, sig) : body).join("\n").replace(/\n+$/, "");
    const lines = message.split("\n");
    insertSection("message", undefined, false, () => {
      e8.insert(fl(`${lines[0] ?? ""}\n`, "magit-diff-revision-summary"));
      insertHeading();
      if (lines.length > 1) e8.insert(`${lines.slice(1).join("\n")}\n`);
      e8.insert("\n");
    });
    e8.insert("\n");
  });
}

/** Inserts the commit's headers: its refs and hash, author and committer, parents and related branches, as magit-insert-revision-headers. */
function magitInsertRevisionHeaders(): void {
  const rev = String(e8.variable("magit-buffer-revision"));
  insertSection(
    "headers",
    undefined,
    false,
    () => {
      const decorations = magitRevFormat("%D", rev, "--decorate=full");
      const labels = decorations ? magitFormatRefLabels(decorations) : "";
      insertHeading(...(labels !== "" ? [labels, " "] : []), fl(magitRevParse(dereference(rev)) ?? rev, "magit-hash"));
      const format = String(e8.variable("magit-revision-headers-format"));
      const headers = magitGitRun(["-c", "log.showsignature=false", "log", "-1", "--no-patch", `--format=${format}`, rev, "--"]).output;
      e8.insert(headers);
      const related = e8.variable("magit-revision-insert-related-refs");
      if (truthy(related)) {
        const display = (sym: string): boolean => {
          const alist = (e8.variable("magit-revision-insert-related-refs-display-alist") as unknown[][] | null) ?? [];
          const entry = alist.find((e) => e[0] === sym);
          return entry ? truthy(entry[1] as e8.Value) : true;
        };
        if (display("parents")) {
          for (const parent of magitCommitParents(rev)) {
            insertSection("commit", parent, false, () => {
              const line = magitRevFormat("%h %s", parent) ?? parent;
              const m = /^([^ ]+) (.*)$/.exec(line);
              e8.insert("Parent:     ");
              e8.insert(fl(m?.[1] ?? line, "magit-hash"));
              e8.insert(` ${m?.[2] ?? ""}\n`);
            });
          }
        }
        if (display("merged")) insertRelatedRefs(rev, "--merged", "Merged", related === "all");
        if (display("contained")) insertRelatedRefs(rev, "--contains", "Contained", related === "all" || related === "mixed");
        if (display("follows")) {
          const follows = magitGetCurrentTag(rev, true);
          if (follows)
            insertSection("tag", follows[0], false, () => {
              e8.insert("Follows:    ");
              e8.insert(fl(follows[0], "magit-tag"));
              e8.insert(" (");
              e8.insert(fl(String(follows[1]), "magit-branch-local"));
              e8.insert(")\n");
            });
        }
        if (display("precedes")) {
          const precedes = magitGetNextTag(rev, true) as [string, number] | undefined;
          if (precedes)
            insertSection("tag", precedes[0], false, () => {
              e8.insert("Precedes:   ");
              e8.insert(fl(precedes[0], "magit-tag"));
              e8.insert(" (");
              e8.insert(fl(String(precedes[1]), "magit-tag"));
              e8.insert(")\n");
            });
        }
      }
      e8.insert("\n");
    },
    "magit-insert-revision-headers",
  );
}

/** Inserts the branches merged into or containing REV, as magit--insert-related-refs, wrapped to the window's width. */
function insertRelatedRefs(rev: string, arg: "--merged" | "--contains", title: string, remote: boolean): void {
  const refs = magitListRelatedBranches(arg, rev, ...(remote ? ["-a"] : []));
  if (refs.length === 0) return;
  insertSection("related-refs", undefined, false, () => {
    const width = e8.windowSize()?.width ?? 80;
    let col = `${title}:`.length + 10 - title.length;
    e8.insert(`${title}:${" ".repeat(10 - title.length)}`);
    for (const branch of refs) {
      if (col + 1 + branch.length <= width) {
        e8.insert(" ");
        col++;
      } else {
        e8.insert(`\n${" ".repeat(12)}`);
        col = 12;
      }
      e8.insert(fl(branch, branch.startsWith("remotes/") ? "magit-branch-remote" : "magit-branch-local"));
      col += branch.length;
    }
    e8.insert("\n");
  });
}

/** Inserts the commit message, its summary as the heading, hashes in it as sections, as magit-insert-revision-message. */
function magitInsertRevisionMessage(): void {
  const rev = String(e8.variable("magit-buffer-revision"));
  insertSection(
    "commit-message",
    undefined,
    false,
    () => {
      const msg = magitGitRun(["-c", "log.showsignature=false", "log", "-1", "--no-patch", "--format=%B", rev, "--"]).output.replace(/\r\n/g, "\n");
      if (msg.trim() === "") {
        e8.insert("(no message)\n");
        return;
      }
      const lines = msg.split("\n");
      const start = e8.point();
      e8.insert(fl(`${lines[0]}\n`, "magit-diff-revision-summary"));
      washMessageKeywords(start);
      insertHeading();
      const bodyStart = e8.point();
      e8.insert(lines.slice(1).join("\n"));
      washMessageKeywords(bodyStart);
      washMessageHashes(start);
    },
    "magit-insert-revision-message",
  );
}

/** Highlights squash markers and bracketed keywords in a message, as magit-highlight-squash-markers and -bracket-keywords. */
function washMessageKeywords(from: number): void {
  const text = e8.bufferSubstringNoProperties(from, e8.point());
  const squash = /^(squash!|fixup!|amend!)/.exec(text);
  if (squash) e8.addFaceTextProperty(from, from + squash[0].length, "magit-keyword-squash");
  for (const m of text.matchAll(/\[[^\][]*\]/g)) e8.putTextProperty(from + m.index!, from + m.index! + m[0].length, "font-lock-face", "magit-keyword");
}

/** Makes the hashes in a message sections of their own, as magit-revision--wash-message-hashes. */
function washMessageHashes(from: number): void {
  const how = e8.variable("magit-revision-use-hash-sections");
  if (!truthy(how)) return;
  const end = e8.point();
  const text = e8.bufferSubstringNoProperties(from, end);
  for (const m of text.matchAll(/[\w-]+/g)) {
    const word = m[0];
    const ok =
      how === "quickest" ? word.length >= 7 && /[0-9]/.test(word) && /[a-z]/.test(word)
      : how === "quicker" ? word.length >= 7 && /[0-9]/.test(word) && magitCommitP(word) !== undefined
      : how === "quick" ? word.length >= 7 && magitCommitP(word) !== undefined
      : magitCommitP(word) !== undefined;
    if (ok && m.index! > 0) e8.putTextProperty(from + m.index!, from + m.index! + word.length, "font-lock-face", "magit-hash");
  }
}

/** Inserts the commit's notes, as magit-insert-revision-notes. */
function magitInsertRevisionNotes(): void {
  const rev = String(e8.variable("magit-buffer-revision"));
  const def = magitGet("core.notesRef") ?? "refs/notes/commits";
  const refs = magitGitLines("for-each-ref", "--format=%(refname)", "refs/notes");
  const active = refs.filter((r) => r === def || (magitGet("notes.displayRef") ?? "") === r);
  for (const ref of active) {
    const r = magitGitRun(["-c", `core.notesRef=${ref}`, "notes", "show", rev]);
    if (r.exit !== 0 || r.output.trim() === "") continue;
    insertSection("notes", ref, ref !== def, () => {
      const lines = r.output.replace(/\n+$/, "").split("\n");
      e8.insert(fl(lines[0], "magit-diff-revision-summary"));
      e8.insert(" (");
      e8.insert(fl(ref.startsWith("refs/notes/") ? ref.slice(11) : ref, "magit-refname"));
      e8.insert(")\n");
      insertHeading();
      if (lines.length > 1) e8.insert(`${lines.slice(1).join("\n")}\n`);
      e8.insert("\n");
    });
  }
}

/** Inserts the commit's diff, as magit-insert-revision-diff. */
function magitInsertRevisionDiff(): void {
  const rev = String(e8.variable("magit-buffer-revision"));
  const args = (e8.variable("magit-buffer-diff-args") as string[] | null) ?? [];
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  magitInsertGitDiff(["show", "-p", "--format=", "--no-prefix", args.includes("--stat") ? "--numstat" : undefined, args, dereference(rev), "--", files], "commit");
}

inserters.set("magit-insert-revision-tag", magitInsertRevisionTag);
inserters.set("magit-insert-revision-headers", magitInsertRevisionHeaders);
inserters.set("magit-insert-revision-message", magitInsertRevisionMessage);
inserters.set("magit-insert-revision-notes", magitInsertRevisionNotes);
inserters.set("magit-insert-revision-diff", magitInsertRevisionDiff);

// The stash buffer.

/** Shows STASH in the stash buffer, as magit-stash-setup-buffer. */
export function magitStashSetupBuffer(stash: string, args: string[], files: string[]): string {
  const name = magitBufferName("magit-stash-mode");
  return magitSetupBuffer(name, magitStashMode, "stash", magitStashRefreshBuffer, true, {
    "magit-buffer-revision": stash,
    "magit-buffer-range": `${stash}^..${stash}`,
    "magit-buffer-diff-args": args,
    "magit-buffer-diff-files": files,
  });
}

/** Makes the stash buffer, as magit-stash-refresh-buffer. */
function magitStashRefreshBuffer(): void {
  const stash = String(e8.variable("magit-buffer-revision"));
  e8.setVariable("header-line-format", `${e8.capitalize(stash)} ${magitRevFormat("%s", stash) ?? ""}`);
  e8.makeLocalVariable("magit-buffer-revision-hash");
  e8.setVariable("magit-buffer-revision-hash", magitRevParse(stash) ?? null);
  insertRoot("stash", () => runSectionHook("magit-stash-sections-hook"));
}

/** Inserts one part of a stash: a commit section with MESSAGE and the diff of RANGE, as magit-stash-insert-section. */
function stashInsertSection(rev: string, range: string, message: string, files?: string[]): void {
  insertSection("commit", rev, false, () => {
    insertHeading(message);
    const args = (e8.variable("magit-buffer-diff-args") as string[] | null) ?? [];
    magitInsertGitDiff(["diff", range, "-p", "--no-prefix", args, "--", files ?? ((e8.variable("magit-buffer-diff-files") as string[] | null) ?? [])], "commit");
  });
}
inserters.set("magit-insert-stash-notes", () => {
  const stash = String(e8.variable("magit-buffer-revision"));
  insertSection("note", undefined, false, () => {
    insertHeading(true, "Notes");
    const r = magitGitRun(["notes", "show", stash]);
    if (r.exit === 0) e8.insert(r.output);
    magitCancelSection(true);
    e8.insert("\n");
  });
});
inserters.set("magit-insert-stash-worktree", () => {
  const s = String(e8.variable("magit-buffer-revision"));
  stashInsertSection(s, `${s}^2..${s}`, "Unstaged");
});
inserters.set("magit-insert-stash-index", () => {
  const s = String(e8.variable("magit-buffer-revision"));
  stashInsertSection(`${s}^2`, `${s}^..${s}^2`, "Staged");
});
inserters.set("magit-insert-stash-untracked", () => {
  const s = String(e8.variable("magit-buffer-revision"));
  if (!magitRevVerify(`${s}^3`)) return;
  const files = magitGitRun(["ls-tree", "-z", "--name-only", "-r", "--full-tree", `${s}^3`]).output.split("\0").filter((f) => f !== "");
  stashInsertSection(`${s}^3`, `${s}^..${s}^3`, "Untracked files", files);
});

// What a diff is.

/** The diff type of SECTION: staged, unstaged, committed, untracked or undefined, as magit-diff-type. */
export function magitDiffType(section = currentSection()): string | undefined {
  if (!section) return undefined;
  const mode = String(e8.variable("major-mode"));
  if (mode === "magit-revision-mode" || mode === "magit-stash-mode") return "committed";
  if (mode === "magit-diff-mode" || mode === "magit-merge-preview-mode") {
    const range = e8.variable("magit-buffer-range") as string | null;
    const typearg = e8.variable("magit-buffer-typearg") as string | null;
    const type = e8.variable("magit-buffer-diff-type");
    if (typeof type === "string") return type;
    if (typearg === "--no-index") return "undefined";
    if (!range || range === "HEAD" || magitRevEq(range, "HEAD")) return typearg === "--cached" ? "staged" : "unstaged";
    if (typearg === "--cached") return magitRevHeadP(range) ? "staged" : "undefined";
    return "committed";
  }
  if (mode === "magit-status-mode") {
    if (["staged", "unstaged", "tracked", "untracked"].includes(section.type)) return section.type;
    if (section.type === "file" || section.type === "module") {
      const parent = section.parent;
      return parent && (parent.type === "file" || parent.type === "module") ? magitDiffType(parent) : parent?.type;
    }
    if (section.type === "hunk") return section.parent?.parent?.type;
    return undefined;
  }
  if (mode === "magit-log-mode") return (magitSectionMatch("commit", section) && section.children.length > 0) || magitSectionMatch({ lineage: ["*", "file", "commit"] }, section) ? "committed" : "undefined";
  return "undefined";
}

/**
 * The scope of SECTION, or of the sections the region selects or the
 * current one: region, hunk, hunks, file, files or list, as
 * magit-diff-scope. With STRICT, none for untracked files or a diffstat.
 */
export function magitDiffScope(section?: Section, strict = false): string | undefined {
  const ssection = section !== undefined;
  const siblings = ssection ? undefined : magitRegionSections(undefined, true);
  const s = section ?? siblings?.[0] ?? currentSection();
  if (!s) return undefined;
  if (strict && (magitDiffType(s) === "untracked" || s.parent?.type === "diffstat")) return undefined;
  const sib = siblings !== undefined;
  const useRegion = magitDiffUseHunkRegionP();
  switch (s.type) {
    case "hunk":
      if (!sib && useRegion) return magitSectionInternalRegionP(s) ? "region" : "hunk";
      return sib && useRegion && !ssection ? "hunks" : "hunk";
    case "file":
    case "module":
      return sib && useRegion && !ssection ? "files" : "file";
    case "staged":
    case "unstaged":
    case "untracked":
      return sib ? undefined : "list";
  }
  return undefined;
}

/** Whether the region selects lines or sections, as magit-diff-use-hunk-region-p. */
export const magitDiffUseHunkRegionP = (): boolean => e8.regionActive() && e8.mark() !== undefined;

const bufferDiffArgs = (): string[] => {
  const args = e8.variable("magit-buffer-diff-args");
  return Array.isArray(args) ? (args as string[]) : [];
};

/** The lines of context the diff has, as magit-diff-get-context. */
export function magitDiffGetContext(): number {
  const arg = bufferDiffArgs().map((a) => /^-U([0-9]+)?$/.exec(a)?.[1]).find((n) => n !== undefined);
  return Number(arg ?? magitGet("diff.context") ?? "3");
}

/** Whether the diff has context to apply its hunks with, as magit-diff-context-p. */
export function magitDiffContextP(): boolean {
  const arg = bufferDiffArgs().find((a) => /^-U([0-9]+)$/.test(a));
  return arg === undefined || arg !== "-U0";
}

/** Whether the diff ignores any whitespace, as magit-diff-ignore-any-space-p. */
export const magitDiffIgnoreAnySpaceP = (): boolean =>
  ["--ignore-cr-at-eol", "--ignore-space-at-eol", "--ignore-space-change", "-b", "--ignore-all-space", "-w", "--ignore-blank-space"].some((a) => bufferDiffArgs().includes(a));

/** Whether the file section's diff is a combined one, as magit-diff--combined-p. */
export const magitDiffCombinedP = (section: Section): boolean => /^diff --(combined|cc)/.test((section.value as FileValue | undefined)?.diff?.header[0] ?? "");

/**
 * The header of the file of SECTION, a file or a hunk, as git apply
 * takes it, as magit-diff-file-header; with NO-RENAME, its "---" line
 * names the file as it is now.
 */
export function magitDiffFileHeader(section: Section, noRename = false): string | undefined {
  const file = section.type === "hunk" ? section.parent : section;
  const v = file?.value as FileValue | undefined;
  if (!file || file.type !== "file" || !v?.diff) return undefined;
  const header = v.diff.header.map((l) => `${l}\n`).join("");
  return noRename ? header.replace(/^--- (.+)/m, `--- ${v.file}`) : header;
}

/**
 * The patch for the lines of the hunk SECTION the region selects, as
 * magit-diff-hunk-region-patch: the other lines changed are dropped or
 * kept as context, by whether ARGS reverse it, and the counts made again
 * as diff-fixup-modifs makes them.
 */
export function magitDiffHunkRegionPatch(section: Section, args: string[] = []): string {
  const op = args.includes("--reverse") ? "+" : "-";
  const rbeg = e8.lineBeginningPosition(Math.min(e8.mark()!, e8.point()));
  const rend = Math.max(e8.mark()!, e8.point());
  const patch: string[] = [];
  for (let p = section.start; p < section.end; p = e8.lineEndPosition(p) + 1) {
    const line = e8.bufferSubstringNoProperties(p, e8.lineEndPosition(p));
    const c = line.charAt(0);
    if (c === "@" || c === " " || (p >= rbeg && p <= rend)) patch.push(line);
    else if (c === op) patch.push(` ${line.slice(1)}`);
  }
  return diffFixupModifs(patch).map((l) => `${l}\n`).join("");
}

/** LINES, a hunk, with the counts of its heading made again, as diff-fixup-modifs. */
function diffFixupModifs(lines: string[]): string[] {
  const m = /^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@(.*)$/.exec(lines[0] ?? "");
  if (!m) return lines;
  const body = lines.slice(1);
  const old = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
  const now = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
  return [`@@ -${m[1]},${old} +${m[2]},${now} @@${m[3]}`, ...body];
}

// Visiting.

/**
 * The line of the file the line of point in a hunk shows, on the side
 * removed from with GOTO-FROM, as magit-diff-hunk-line: on the heading,
 * the hunk's first changed line's.
 */
export function magitDiffHunkLine(section: Section, gotoFrom = false): number {
  const v = section.value as FileValue;
  const hunk = v.hunk;
  if (!hunk) return 1;
  let target = e8.lineBeginningPosition(e8.point());
  if (target < section.content) {
    target = section.content;
    while (target < section.end && !/^[-+]/.test(e8.bufferSubstringNoProperties(target, Math.min(target + 1, section.end)))) target = e8.lineEndPosition(target) + 1;
  }
  const prefix = hunk.combined ? (hunk.fromRange as number[][]).length : 1;
  const range = gotoFrom ? (hunk.combined ? (hunk.fromRange as number[][])[0] : (hunk.fromRange as number[])) : hunk.toRange;
  let offset = 0;
  for (let p = section.content; p < target && p < section.end; p = e8.lineEndPosition(p) + 1) {
    if (!e8.bufferSubstringNoProperties(p, Math.min(p + prefix, section.end)).includes(gotoFrom ? "+" : "-")) offset++;
  }
  return range[0] + offset;
}

/** The column of point in the file, the diff marker left out, as magit-diff-hunk-column. */
const hunkColumn = (section: Section): number => {
  const merging = e8.bufferSubstringNoProperties(section.start, section.start + 3) === "@@@";
  return Math.max(0, e8.point() - e8.lineStart(e8.lineOf(e8.point())) - (merging ? 2 : 1));
};

/** Visits FILE, in REV if given as a blob, at LINE and COLUMN, in another window if OTHER, as magit-diff-visit-file--internal. */
function visitFile(file: string, rev: string | undefined, line?: number, column?: number, other = false): void {
  const top = magitToplevelOrError();
  if (rev === undefined || rev === "{worktree}") {
    const path = e8.expandFileName(file, top);
    e8.call(other ? "find-file-other-window" : "find-file", path);
  } else {
    magitFindFileNoselectDisplay(rev, file, other);
  }
  if (line !== undefined) {
    e8.gotoChar(e8.pointMin());
    forwardLine(line - 1);
    if (column !== undefined) e8.gotoChar(Math.min(e8.point() + column, e8.lineEnd(e8.lineOf(e8.point()))));
  }
}

/** Shows FILE as it is at REV in a buffer of its own, as magit-find-file-noselect; magit-files.ts gives it its mode. */
export function magitFindFileNoselectDisplay(rev: string, file: string, other = false): string {
  const top = magitToplevelOrError();
  const name = `${e8.fileNameNondirectory(file)}.~${rev.replace(/\//g, "_")}~`;
  const exists = e8.bufferLiveP(e8.getBuffer(name));
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    if (!exists) {
      const text = magitGitRun(["cat-file", "-p", `${rev}:${file}`], { dir: top }).output;
      e8.letBind({ "inhibit-read-only": true }, () => {
        e8.deleteRegion(e8.pointMin(), e8.pointMax());
        e8.insert(text);
      });
      e8.makeLocalVariable("default-directory");
      e8.setVariable("default-directory", e8.fileNameDirectory(e8.expandFileName(file, top)) ?? top);
      for (const [v, value] of [
        ["magit-buffer-refname", rev],
        ["magit-buffer-revision", magitRevParse(rev) ?? rev],
        ["magit-buffer-file-name", e8.expandFileName(file, top)],
      ] as const) {
        e8.makeLocalVariable(v);
        e8.setVariable(v, value);
      }
      e8.setBufferModified(false);
      e8.setVariable("buffer-read-only", true);
      if (e8.fboundp("magit-blob-mode")) e8.funcall("magit-blob-mode");
    }
  });
  e8.call(other ? "switch-to-buffer-other-window" : "pop-to-buffer", name);
  return name;
}

/** Which revision and file a diff section's lines come from, as magit-diff-visit--sides gives the one to visit. */
function visitTarget(section: Section, forceWorktree: boolean): { file: string; rev?: string; goner: boolean } {
  const v = section.value as FileValue | string;
  const file = typeof v === "string" ? v : v.file;
  const type = magitDiffType(section);
  const onRemoved = section.type === "hunk" && /^-/.test(e8.lineText(e8.lineOf(e8.point())) ?? "");
  if (forceWorktree || type === "unstaged" || type === "untracked") return { file, goner: false };
  if (type === "staged") return { file, goner: false, rev: truthy(e8.variable("magit-diff-visit-prefer-worktree")) ? undefined : undefined };
  const rev = String(e8.variable("magit-buffer-revision") ?? "") || ((e8.variable("magit-buffer-range") as string | null) ?? "HEAD").replace(/^.*\.\.\.?/, "") || "HEAD";
  if (onRemoved) return { file: (typeof v === "string" ? undefined : v.diff?.orig) ?? file, rev: `${rev}~`, goner: true };
  return { file, rev: truthy(e8.variable("magit-diff-visit-prefer-worktree")) ? undefined : rev, goner: false };
}

function diffVisit(forceWorktree: boolean, other: boolean): void {
  const s = currentSection();
  if (!s || !["file", "hunk", "module"].includes(s.type)) e8.userError("No file at point");
  const target = visitTarget(s!, forceWorktree);
  if (s!.type === "hunk") {
    const line = magitDiffHunkLine(s!, target.goner);
    visitFile(target.file, target.rev, line, hunkColumn(s!), other);
  } else visitFile(target.file, target.rev, undefined, undefined, other);
}

export const magitDiffVisitFile = e8.defineCommand({
  name: "magit-diff-visit-file",
  doc: "From a diff visit the appropriate version of the file at point: the work tree's for unstaged changes, the blob for committed ones, on the hunk's line.",
  run: () => diffVisit(false, false),
});
e8.defineCommand({ name: "magit-diff-visit-file-other-window", doc: "From a diff visit the appropriate version of the file in another window.", run: () => diffVisit(false, true) });
e8.defineCommand({ name: "magit-diff-visit-file-other-frame", doc: "From a diff visit the appropriate version of the file in another frame.", run: () => diffVisit(false, true) });
export const magitDiffVisitWorktreeFile = e8.defineCommand({ name: "magit-diff-visit-worktree-file", doc: "From a diff visit the work tree's version of the file at point.", run: () => diffVisit(true, false) });
e8.defineCommand({ name: "magit-diff-visit-worktree-file-other-window", doc: "From a diff visit the work tree's version of the file in another window.", run: () => diffVisit(true, true) });
e8.defineCommand({ name: "magit-diff-visit-worktree-file-other-frame", doc: "From a diff visit the work tree's version of the file in another frame.", run: () => diffVisit(true, true) });

// Commands that show diffs.

/** What a dwim diff shows: a type, a commit or stash, or a range, as magit-diff--dwim. */
export function magitDiffDwimTarget(): string | ["commit" | "stash", string] | undefined {
  const commits = magitRegionValues(["commit", "branch"], true) as string[] | undefined;
  if (commits && commits.length > 1) {
    e8.deactivateMark();
    return `${commits[commits.length - 1]}..${commits[0]}`;
  }
  const refname = e8.variable("magit-buffer-refname");
  if (typeof refname === "string") return ["commit", refname];
  const mode = String(e8.variable("major-mode"));
  const s = currentSection();
  if (mode === "magit-stash-mode" && s) {
    const v = s.type === "commit" ? s.value : s.type === "file" ? s.parent?.value : s.type === "hunk" ? s.parent?.parent?.value : undefined;
    return ["commit", String(v)];
  }
  if (mode === "magit-revision-mode") return ["commit", String(e8.variable("magit-buffer-revision"))];
  if (mode === "magit-diff-mode") {
    const type = String(e8.variable("magit-buffer-diff-type") ?? "");
    return type === "committed" ? ((e8.variable("magit-buffer-range") as string | null) ?? undefined) : type || undefined;
  }
  if (!s) return undefined;
  if (magitSectionMatch({ lineage: ["*", "unstaged"] }, s)) return "unstaged";
  if (magitSectionMatch({ lineage: ["*", "staged"] }, s)) return "staged";
  if (s.type === "unmerged") return "unmerged";
  if (s.type === "unpushed" || s.type === "unpulled") return rangeToEndpoints(String(s.value));
  if (s.type === "branch") {
    const current = magitGetCurrentBranch();
    const atpoint = String(s.value);
    if (atpoint !== current) return `${current ?? "HEAD"}...${atpoint}`;
    const upstream = magitGetUpstreamBranch();
    if (upstream) return `${upstream}...${current}`;
    if (magitAnythingModifiedP()) return current;
    return ["commit", current!];
  }
  if (s.type === "commit") return ["commit", String(s.value)];
  if (s.type === "file" && s.parent?.type === "commit") return ["commit", String(s.parent.value)];
  if (s.type === "hunk" && s.parent?.parent?.type === "commit") return ["commit", String(s.parent.parent.value)];
  if (s.type === "stash") return ["stash", String(s.value)];
  return undefined;
}
const rangeToEndpoints = (range: string): string => (range.includes("...") ? range.replace("...", "..") : range.includes("..") ? range.replace("..", "...") : range);

export const magitDiffDwim = e8.defineCommand({
  name: "magit-diff-dwim",
  doc: "Show changes for the thing at point: a commit's, the staged or unstaged changes, a stash's, or a range's.",
  run: () => {
    const [args, files] = magitDiffArguments();
    const target = magitDiffDwimTarget();
    if (target === "unmerged") return diffUnmerged(args, files);
    if (target === "unstaged") return void magitDiffSetupBuffer(undefined, undefined, args, files, "unstaged");
    if (target === "staged") return void magitDiffSetupBuffer(undefined, "--cached", args, files, "staged");
    if (Array.isArray(target) && target[0] === "stash") return void magitStashSetupBuffer(target[1], args.filter((a) => a !== "--stat"), files);
    if (Array.isArray(target)) return void magitDiffSetupBuffer(`${target[1]}^..${target[1]}`, undefined, args, files, "committed");
    if (typeof target === "string") return void magitDiffSetupBuffer(target, undefined, args, files, "committed");
    e8.call("magit-diff-range" as e8.CommandName);
  },
});

/** Reads a range or commit for a diff, as magit-diff-read-range-or-commit. */
export function magitDiffReadRangeOrCommit(prompt: string, secondaryDefault?: string): string {
  const commits = magitRegionValues(["commit", "branch"], true) as string[] | undefined;
  if (commits && commits.length > 1) {
    e8.deactivateMark();
    return `${commits[commits.length - 1]}..${commits[0]}`;
  }
  const target = magitDiffDwimTarget();
  const def = Array.isArray(target) && target[0] === "commit" ? `${target[1]}^..${target[1]}` : typeof target === "string" && !["staged", "unstaged", "unmerged", "undefined"].includes(target) ? target : (secondaryDefault ?? magitGetCurrentBranch());
  return magitReadRange(prompt, def);
}

e8.defineCommand({
  name: "magit-diff-range",
  doc: "Show differences between two commits: a range, or a revision against the working tree.",
  run: () => {
    const [args, files] = magitDiffArguments();
    magitDiffSetupBuffer(magitDiffReadRangeOrCommit("Diff for range"), undefined, args, files, "committed");
  },
});
e8.defineCommand({
  name: "magit-diff-working-tree",
  doc: "Show changes between the working tree and HEAD; with a prefix argument, a commit read.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const rev = truthy(prefix) ? magitReadBranchOrCommit("Diff working tree and commit") : "HEAD";
    const [args, files] = magitDiffArguments();
    magitDiffSetupBuffer(rev, undefined, args, files, "committed");
  },
});
e8.defineCommand({
  name: "magit-diff-staged",
  doc: "Show changes between the index and HEAD; with a prefix argument, a commit read.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const rev = truthy(prefix) ? magitReadBranchOrCommit("Diff index and commit") : undefined;
    const [args, files] = magitDiffArguments();
    magitDiffSetupBuffer(rev, "--cached", args, files, "staged");
  },
});
e8.defineCommand({
  name: "magit-diff-unstaged",
  doc: "Show changes between the working tree and the index.",
  run: () => {
    const [args, files] = magitDiffArguments();
    magitDiffSetupBuffer(undefined, undefined, args, files, "unstaged");
  },
});
function diffUnmerged(args: string[], files: string[]): void {
  if (!magitMergeInProgressP()) e8.userError("No merge is in progress");
  const head = magitGitString("merge-base", "HEAD", "MERGE_HEAD");
  magitDiffSetupBuffer(head ? `${head}...MERGE_HEAD` : "HEAD...MERGE_HEAD", undefined, args, files, "committed");
}
e8.defineCommand({ name: "magit-diff-unmerged", doc: "Show changes that are being merged.", run: () => diffUnmerged(...magitDiffArguments()) });
e8.defineCommand({
  name: "magit-diff-paths",
  doc: "Show changes between any two files on disk.",
  run: () => {
    const a = e8.readFileName("First file: ", { mustMatch: true });
    const b = e8.readFileName("Second file: ", { mustMatch: true });
    magitDiffSetupBuffer(undefined, "--no-index", [], [e8.expandFileName(a), e8.expandFileName(b)], "undefined");
  },
});
e8.defineCommand({
  name: "magit-diff-buffer-file",
  doc: "Show the diff for the file visited in the current buffer: HEAD against the working tree, limited to the file.",
  run: () => {
    const file = magitFileRelativeName();
    if (!file) e8.userError("Buffer isn't visiting a file");
    const refname = e8.variable("magit-buffer-refname");
    if (typeof refname === "string") return magitShowCommitRev(refname, magitDiffArguments("magit-revision-mode")[0], [file!]);
    if (e8.bufferModified()) e8.call("save-buffer");
    magitDiffSetupBuffer(magitGetCurrentBranch() ?? "HEAD", undefined, magitDiffArguments()[0], [file!], "unstaged");
  },
});

/** Shows REV in the revision buffer, as magit-show-commit. */
export function magitShowCommitRev(rev: string, args?: string[], files?: string[]): void {
  if (!magitCommitP(rev)) e8.userError(`${rev} is not a commit`);
  const [a, f] = magitDiffArguments("magit-revision-mode");
  magitRevisionSetupBuffer(rev, args ?? a, files ?? (String(e8.variable("major-mode")) === "magit-log-mode" ? ((e8.variable("magit-buffer-log-files") as string[] | null) ?? []) : f));
}

export const magitShowCommit = e8.defineCommand({
  name: "magit-show-commit",
  doc: "Visit the revision at point in another buffer; with a prefix argument, or with none at point, read one.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const atpoint = (magitSectionValueModuleCommit() ?? magitBranchOrCommitAtPoint()) as string | undefined;
    const rev = !truthy(prefix) && atpoint ? atpoint : magitReadBranchOrCommit("Show commit", atpoint);
    magitShowCommitRev(rev);
  },
});
const magitSectionValueModuleCommit = (): unknown => {
  const s = currentSection();
  return s?.type === "module-commit" ? s.value : undefined;
};

export const magitStashShow = e8.defineCommand({
  name: "magit-stash-show",
  doc: "Show all diffs of a stash in a buffer.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const stash = (!truthy(prefix) ? magitStashAtPoint() : undefined) ?? magitReadStash("Show stash");
    const [args, files] = magitDiffArguments("magit-stash-mode");
    magitStashSetupBuffer(stash, args.filter((a) => a !== "--stat"), files);
  },
});

// Changing what a diff buffer shows.

/** Changes the current diff buffer's arguments with FN and refreshes it. */
function changeArgs(fn: (args: string[]) => string[]): void {
  const args = (e8.variable("magit-buffer-diff-args") as string[] | null) ?? defaultArguments[String(e8.variable("major-mode"))] ?? [];
  e8.makeLocalVariable("magit-buffer-diff-args");
  e8.setVariable("magit-buffer-diff-args", fn([...args]));
  magitRefreshBuffer();
}

/** The -U context of ARGS, or undefined, as magit-diff-get-context. */
const getContext = (args: string[]): number | undefined => {
  const u = args.find((a) => /^-U[0-9]+$/.test(a));
  return u ? Number(u.slice(2)) : undefined;
};
/** ARGS with -U set to what FN makes of the context, as magit-diff-set-context. */
const setContext = (args: string[], fn: (n: number) => number | undefined): string[] => {
  const def = Number(e8.variable("magit-diff-default-context") ?? magitGet("diff.context") ?? 3);
  const now = getContext(args) ?? def;
  const next = fn(now);
  const rest = args.filter((a) => !/^-U[0-9]+$/.test(a));
  return next === undefined || next === def ? rest : [...rest, `-U${next}`];
};
e8.defineCommand({ name: "magit-diff-less-context", doc: "Decrease the context for diff hunks by COUNT lines.", params: [{ name: "count", kind: "count" }], run: (count: number) => changeArgs((a) => setContext(a, (n) => Math.max(0, n - (count ?? 1)))) });
e8.defineCommand({ name: "magit-diff-more-context", doc: "Increase the context for diff hunks by COUNT lines.", params: [{ name: "count", kind: "count" }], run: (count: number) => changeArgs((a) => setContext(a, (n) => n + (count ?? 1))) });
e8.defineCommand({ name: "magit-diff-default-context", doc: "Reset context for diff hunks to the default height.", run: () => changeArgs((a) => setContext(a, () => undefined)) });
e8.defineCommand({
  name: "magit-diff-toggle-refine-hunk",
  doc: "Turn diff-hunk refining on or off; with a prefix argument, refine all hunks.",
  params: [{ name: "style", kind: "prefix" }],
  run: (style: e8.Value) => {
    const now = e8.variable("magit-diff-refine-hunk");
    const next = truthy(style) ? (now === "all" ? null : "all") : now ? null : true;
    e8.makeLocalVariable("magit-diff-refine-hunk");
    e8.setVariable("magit-diff-refine-hunk", next);
    magitDiffUpdateHunkRefinement();
    e8.message(`Hunk refinement ${next === "all" ? "enabled for all hunks" : next ? "enabled" : "disabled"}`);
  },
});
e8.defineCommand({
  name: "magit-diff-flip-revs",
  doc: "Swap revisions in the diff range: A..B becomes B..A.",
  run: () => {
    const range = e8.variable("magit-buffer-range") as string | null;
    const m = range && /^(.*?)(\.\.\.?)(.*)$/.exec(range);
    if (!m) e8.userError("No range to swap");
    e8.setVariable("magit-buffer-range", `${m![3]}${m![2]}${m![1]}`);
    magitRefreshBuffer();
  },
});
e8.defineCommand({
  name: "magit-diff-switch-range-type",
  doc: "Convert the diff range type: A..B becomes A...B and back.",
  run: () => {
    const range = e8.variable("magit-buffer-range") as string | null;
    if (!range || !range.includes("..")) e8.userError("No range to change");
    e8.setVariable("magit-buffer-range", rangeToEndpoints(range!));
    magitRefreshBuffer();
  },
});
e8.defineCommand({
  name: "magit-diff-toggle-file-filter",
  doc: "Toggle the file restriction of the current buffer's diffs.",
  run: () => {
    const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
    const suspended = (e8.variable("magit-buffer-diff-files-suspended") as string[] | null) ?? null;
    e8.makeLocalVariable("magit-buffer-diff-files-suspended");
    if (files.length > 0) {
      e8.setVariable("magit-buffer-diff-files-suspended", files);
      e8.setVariable("magit-buffer-diff-files", []);
    } else if (suspended) {
      e8.setVariable("magit-buffer-diff-files", suspended);
      e8.setVariable("magit-buffer-diff-files-suspended", null);
    } else {
      const file = magitFileRelativeName() ?? currentSection()?.value;
      e8.setVariable("magit-buffer-diff-files", typeof file === "string" ? [file] : []);
    }
    magitRefreshBuffer();
  },
});

// Scrolling a diff shown from a log or the status buffer.

/** Shows the commit or stash at point, or scrolls the buffer showing it, as magit-diff-show-or-scroll. */
function showOrScroll(up: boolean): void {
  const s = currentSection();
  let rev: string | undefined;
  let kind: "revision" | "stash" | undefined;
  const blamed = magitBlameRevAtPoint();
  if (blamed !== undefined) {
    rev = blamed;
    kind = "revision";
  } else if (s?.type === "commit" || s?.type === "module-commit") {
    rev = String(s.value);
    kind = "revision";
  } else if (s?.type === "stash") {
    rev = String(s.value);
    kind = "stash";
  } else if (s?.type === "branch") {
    rev = String(s.value);
    kind = "revision";
  }
  if (!rev || !kind) return e8.call(up ? "scroll-up-command" : "scroll-down-command");
  const name = magitBufferName(kind === "revision" ? "magit-revision-mode" : "magit-stash-mode");
  const shown = e8.bufferLiveP(e8.getBuffer(name)) && e8.windowList().some((w) => e8.windowBuffer(w) === name);
  const showing = shown && e8.withCurrentBuffer(name, () => String(e8.variable("magit-buffer-revision")));
  if (showing === rev || (shown && magitRevParse(String(showing)) === magitRevParse(rev))) {
    const win = e8.windowList().find((w) => e8.windowBuffer(w) === name)!;
    const here = e8.selectedWindow();
    e8.selectWindow(win);
    try {
      e8.call(up ? "scroll-up-command" : "scroll-down-command");
    } catch {
      // At the end, as Magit wraps around.
      e8.gotoChar(up ? e8.pointMin() : e8.pointMax());
    }
    e8.selectWindow(here);
    return;
  }
  const here = e8.selectedWindow();
  if (kind === "revision") magitShowCommitRev(rev);
  else magitStashSetupBuffer(rev, magitDiffArguments("magit-stash-mode")[0].filter((a) => a !== "--stat"), []);
  e8.selectWindow(here);
}
e8.defineCommand({ name: "magit-diff-show-or-scroll-up", doc: "Update the commit or diff buffer for the thing at point, or scroll it up.", run: () => showOrScroll(true) });
e8.defineCommand({ name: "magit-diff-show-or-scroll-down", doc: "Update the commit or diff buffer for the thing at point, or scroll it down.", run: () => showOrScroll(false) });

e8.defineCommand({
  name: "magit-jump-to-diffstat-or-diff",
  doc: "Jump to the diffstat or diff: from the diffstat to the file's diff, else to the diffstat.",
  run: () => {
    const s = currentSection();
    const root = sections()?.root;
    if (!root) return;
    if (s?.parent?.type === "diffstat") {
      const file = (s.value as FileValue).file;
      const target = root.children.find((c) => c.type === "file" && (c.value as FileValue).file === file);
      if (target) return e8.gotoChar(target.start);
    }
    const stat = magitGetSection([["diffstat", undefined], [root.type, root.value]]);
    if (stat) e8.gotoChar(stat.start);
    else e8.userError("No diffstat in this buffer");
  },
});

e8.defineCommand({
  name: "magit-section-cycle-diffs",
  doc: "Cycle visibility of diff-related sections in the current buffer.",
  run: () => {
    const mode = String(e8.variable("major-mode"));
    const root = sections()?.root;
    if (!root) return;
    // In the status buffer, the files of the staged and unstaged changes, those shown first.
    const targets =
      mode === "magit-status-mode"
        ? [magitGetSection([["staged", undefined], ["status", undefined]]), magitGetSection([["unstaged", undefined], ["status", undefined]])]
            .filter((x): x is Section => x !== undefined)
            .flatMap((x) => {
              if (x.hidden) show(x);
              return x.children;
            })
        : root.children.filter((c) => c.type === "file");
    if (targets.length === 0) return;
    if (targets.some((t) => t.hidden)) {
      for (const t of targets) {
        show(t);
        magitSectionHideChildren(t);
      }
      return;
    }
    const children = targets.flatMap((t) => t.children);
    if (children.some((c) => c.hidden) && children.some((c) => c.children.length > 0)) targets.forEach(magitSectionShowHeadings);
    else if (children.some((c) => magitSectionHiddenBody(c))) targets.forEach((t) => magitSectionShowChildren(t));
    else targets.forEach(hide);
  },
});

e8.defineCommand({
  name: "magit-diff-while-committing",
  doc: "While committing, show the changes that are about to be committed.",
  run: () => {
    if (!e8.bufferList().some((b) => e8.fileNameNondirectory(b) === "COMMIT_EDITMSG")) e8.userError("No commit in progress");
    const [args] = magitDiffArguments();
    magitDiffSetupBuffer(undefined, "--cached", args, [], "staged");
  },
});

void magitCompletingRead;
void magitSectionParentValue;

// Keys.

/** The keys diff sections have, as magit-diff-section-map and the file and hunk maps built on it. */
e8.defineKeymap("magit-diff-section-map", null);
for (const [key, command] of [
  ["C-j", "magit-diff-visit-worktree-file"],
  ["C-<return>", "magit-diff-visit-worktree-file"],
  ["C-x 4 <return>", "magit-diff-visit-file-other-window"],
  ["C-x 5 <return>", "magit-diff-visit-file-other-frame"],
] as const)
  e8.defineKey("magit-diff-section-map", key, command as e8.CommandName);
e8.remapCommand("magit-diff-section-map", "magit-visit-thing" as e8.CommandName, "magit-diff-visit-file" as e8.CommandName);
for (const [from, to] of [
  ["magit-revert-no-commit", "magit-reverse"],
  ["magit-delete-thing", "magit-discard"],
  ["magit-unstage-files", "magit-unstage"],
  ["magit-stage-files", "magit-stage"],
  ["magit-cherry-apply", "magit-apply"],
] as const)
  e8.remapCommand("magit-diff-section-map", from as e8.CommandName, to as e8.CommandName);
e8.defineKeymap("magit-file-section-map", "magit-diff-section-map");
e8.defineKeymap("magit-hunk-section-map", "magit-diff-section-map");
/** The keys of smerge-command-prefix in a hunk, as magit-hunk-section-smerge-map. */
for (const [key, command] of [
  ["RET", "magit-smerge-keep-current"],
  ["a", "magit-smerge-keep-all"],
  ["u", "magit-smerge-keep-upper"],
  ["b", "magit-smerge-keep-base"],
  ["l", "magit-smerge-keep-lower"],
] as const)
  e8.defineKey("magit-hunk-section-map", `C-c ^ ${key}`, command as e8.CommandName);
e8.defineKeymap("magit-commit-message-section-map", null);
e8.remapCommand("magit-commit-message-section-map", "magit-visit-thing" as e8.CommandName, "magit-show-commit" as e8.CommandName);
magitSectionDefineType("commit-message", { keymap: "magit-commit-message-section-map" });

/** The keys every Magit buffer has for diffs, as magit-mode-map binds them. */
for (const [key, command] of [
  ["SPC", "magit-diff-show-or-scroll-up"],
  ["S-SPC", "magit-diff-show-or-scroll-down"],
  ["DEL", "magit-diff-show-or-scroll-down"],
  ["+", "magit-diff-more-context"],
  ["-", "magit-diff-less-context"],
  ["0", "magit-diff-default-context"],
] as const)
  e8.defineKey("magit-mode-map", key, command as e8.CommandName);
for (const [key, command] of [
  ["C-c C-d", "magit-diff-while-committing"],
  ["j", "magit-jump-to-diffstat-or-diff"],
] as const)
  e8.defineKey("magit-diff-mode-map", key, command as e8.CommandName);
