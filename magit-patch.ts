// SPDX-License-Identifier: GPL-3.0-or-later
//
// Patches, after magit-patch.el: the patch menu (W), creating patches with
// git format-patch from its own menu of mail, patch and diff arguments,
// applying a plain patch with git apply, saving the diff a buffer shows as
// a patch file, and asking upstream to pull.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { magitRegionValues } from "magit-section";
import * as transient from "transient";
import { transientArgs, transientArgValue, transientDefinePrefix } from "transient";
import { magitCompletingRead, prefixArgP } from "magit-base";
import {
  magitFileAtPoint,
  magitGet,
  magitGetUpstreamBranch,
  magitGitRun,
  magitListRefnames,
  magitReadBranchOrCommit,
  magitReadRangeOrCommit,
  magitReadRemote,
  magitToplevel,
  type GitArg,
} from "magit-git";
import { magitRunGit } from "magit-process";
import { magitRefresh } from "magit-mode";
import { magitTransientReadPerson, magitTransientReadRevision } from "magit-transient";
import { magitAm } from "magit-sequence";

// Options.

e8.defineVariable({
  name: "magit-patch-save-arguments",
  doc:
    "Control arguments used by the command `magit-patch-save'.\n\n`magit-patch-save' (which see) saves a diff for the changes shown in the current buffer in a patch file.  It may use the same arguments as used in the buffer or a subset thereof, or a constant list of arguments, depending on this option and the prefix argument.\n\nThe value is the symbol `buffer', a list beginning with `exclude' followed by the arguments to leave out, or a list of arguments.",
  value: ["exclude", "--stat"],
});

// Reading.

/**
 * Options putting a suffix at LEVEL, as :level does. A transient without
 * levels (E8 before 0.5) shows every suffix, so there those above the
 * default level 4 are left out, as Magit shows its menus at first.
 */
const hasLevels = "transientPrefixLevel" in transient;
const lvl = (level: number, options: object = {}) => ({ ...options, level, ...(hasLevels || level <= 4 ? {} : { if: () => false }) });

/** Asks with CLAUSES, each [char, description, value], as magit-read-char-case with VERBOSE t. */
function readCharCase(prompt: string, clauses: [string, string, string][]): string {
  const parts = [...clauses.map((c) => c[1]), "[C-g] to abort"];
  const c = e8.readCharChoice(`${prompt}${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]} `, clauses.map((c) => c[0]).join(""));
  e8.message("");
  return clauses.find((cl) => cl[0] === c)![2];
}

/** Reads a positive number, as transient-read-number-N+. */
function readNumberNPlus(prompt: string, initial?: string): string {
  for (;;) {
    const text = e8.readString(prompt, { initial }).trim();
    if (text === "") return "";
    if (/^[0-9]+$/.test(text) && Number(text) > 0) return text;
    e8.message("Please enter a natural number (excluding zero).");
    e8.sitFor(1);
  }
}

/** Reads an existing directory, as transient-read-existing-directory. */
function readExistingDirectory(prompt: string, initial?: string): string {
  const dir = e8.expandFileName(e8.readFileName(prompt, { initial, mustMatch: true }));
  if (!e8.fileDirectoryP(dir)) e8.userError(`${dir} is not a directory`);
  return dir;
}

/** Reads a thread style, as magit-format-patch-select-thread-style. */
export const magitFormatPatchSelectThreadStyle = (): string => readCharCase("Thread style ", [["d", "[d]eep", "deep"], ["s", "[s]hallow", "shallow"]]);

/** Reads the base commit, as magit-format-patch-select-base. */
export const magitFormatPatchSelectBase = (prompt: string, initial?: string): string =>
  magitCompletingRead(prompt, ["auto", ...magitListRefnames()], { requireMatch: "any", initialInput: initial, def: "auto" }) ?? "";

/** Reads the range-diff's range, as magit-format-patch-select-range-diff. */
export const magitFormatPatchSelectRangeDiff = (prompt: string): string => magitReadRangeOrCommit(prompt);

/** Reads what the cover letter takes from the branch description, as magit-format-patch-select-description-mode. */
export const magitFormatPatchSelectDescriptionMode = (): string =>
  readCharCase("Use description as ", [["m", "[m]essage", "message"], ["s", "[s]ubject", "subject"], ["a", "[a]uto", "auto"], ["n", "[n]othing", "none"]]);

/** The notes refs, without refs/notes/, as magit-list-notes-refnames. */
const magitListNotesRefnames = (): string[] => magitListRefnames("refs/notes").map((r) => r.slice(6));

/** Reads a notes ref, as magit-notes-read-ref. */
export function magitNotesReadRef(prompt: string): string {
  const def = magitGet("core.notesRef");
  const ref = magitCompletingRead(prompt, magitListNotesRefnames(), { requireMatch: true, initialInput: def?.startsWith("refs/notes/") ? def.slice(11) : def });
  if (!ref) return "";
  return ref.startsWith("refs/") ? ref : `refs/notes/${ref}`;
}

// The menus.

export const magitPatchCreateCommand = (): void => {
  // Run from its own menu, as magit-patch-create's interactive form when
  // transient-current-command is magit-patch-create.
  const revs = (magitRegionValues("commit", true) as string[] | undefined) ?? [];
  let range: string;
  if (revs.length > 0) range = `${revs[revs.length - 1]}^..${revs[0]}`;
  else {
    const r = magitReadRangeOrCommit("Create patches for range or commit");
    range = r.includes("..") ? r : `${r}~..${r}`;
  }
  const all = transientArgs("magit-patch-create");
  const files = all.filter((a) => a.startsWith("-- ")).flatMap((a) => a.slice(3).split(",")).filter((f) => f !== "");
  magitPatchCreateRange(range, all.filter((a) => !a.startsWith("-- ")), files);
};

/**
 * Creates patches for the commits in RANGE with ARGS, limited to FILES,
 * and visits the cover letter if there is one, as magit-patch-create does
 * once it has its arguments.
 */
export function magitPatchCreateRange(range: string, args: string[] = [], files: string[] = []): void {
  magitRunGit("format-patch", range, args, "--", files);
  if (args.includes("--cover-letter")) {
    const reroll = transientArgValue("--reroll-count=", args);
    const topdir = magitToplevel() ?? String(e8.variable("default-directory"));
    const dir = transientArgValue("--output-directory=", args);
    const file = e8.expandFileName(`${typeof reroll === "string" ? `v${reroll}-` : ""}0000-cover-letter.patch`, typeof dir === "string" ? e8.expandFileName(dir, topdir) : topdir);
    e8.call("find-file", file);
  }
}

export const magitPatchCreate = transientDefinePrefix("magit-patch-create", {
  doc:
    "Create patches for the commits in RANGE.\nWhen a single commit is given for RANGE, create a patch for the changes introduced by that commit (unlike 'git format-patch' which creates patches for all commits that are reachable from `HEAD' but not from the specified commit).",
  // :incompatible '(("--subject-prefix=" "--rfc")) is not enforced: E8's transient has no :incompatible yet.
  groups: [
    {
      description: "Mail arguments",
      ...(hasLevels ? {} : { if: () => false }),
      items: [
        ["C-m C-r", "In reply to", "--in-reply-to=", lvl(6, { class: "option" })],
        ["C-m s", "Thread style", "--thread=", lvl(6, { reader: magitFormatPatchSelectThreadStyle })],
        ["C-m C-f", "From", "--from=", lvl(6, { reader: magitTransientReadPerson })],
        ["C-m C-t", "To", "--to=", lvl(6, { reader: magitTransientReadPerson })],
        ["C-m C-c", "CC", "--cc=", lvl(6, { reader: magitTransientReadPerson })],
      ],
    },
    {
      description: "Patch arguments",
      items: [
        ["C-m b", "Insert base commit", "--base=", { reader: magitFormatPatchSelectBase }],
        ["C-m v", "Reroll count", "--reroll-count=", { reader: readNumberNPlus }],
        ["C-m d i", "Insert interdiff", "--interdiff=", lvl(5, { reader: magitTransientReadRevision })],
        ["C-m d r", "Insert range-diff", "--range-diff=", { reader: magitFormatPatchSelectRangeDiff }],
        ["C-m p", "Subject Prefix", "--subject-prefix=", { class: "option" }],
        ["C-m r", "RFC subject prefix", "--rfc"],
        ["C-m l", "Add cover letter", "--cover-letter"],
        ["C-m D", "Use branch description", "--cover-from-description=", lvl(5, { reader: magitFormatPatchSelectDescriptionMode })],
        ["C-m n", "Insert commentary from notes", "--notes=", lvl(5, { reader: magitNotesReadRef })],
        ["C-m o", "Output directory", "--output-directory=", { reader: readExistingDirectory }],
      ],
    },
    {
      description: "Diff arguments",
      items: [
        ["-U", "Context lines", "-U", { class: "option", prompt: "Context lines: " }],
        ["-M", "Detect renames", "-M", { class: "option", prompt: "Detect renames: " }],
        ["-C", "Detect copies", "-C", { class: "option", prompt: "Detect copies: " }],
        ["-A", "Diff algorithm", "--diff-algorithm=", { choices: ["default", "minimal", "patience", "histogram"] }],
        ["--", "Limit to files", "-- ", { class: "option", prompt: "Limit to files: " }],
        ["-b", "Ignore whitespace changes", "--ignore-space-change", lvl(7)],
        ["-w", "Ignore all whitespace", "--ignore-all-space", lvl(7)],
      ],
    },
    // Its own command as the suffix: a function, so the menu runs it
    // rather than showing itself again.
    { description: "Actions", items: [["c", "Create patches", magitPatchCreateCommand]] },
  ],
});

/** Applies the patch FILE with ARGS, as magit-patch-apply does once it has its arguments. */
export const magitPatchApplyFile = (file: string, args: string[] = []): number => magitRunGit("apply", args, "--", e8.expandFileName(file));

/** The name of FILE relative to DIR, as file-relative-name. */
function fileRelativeName(file: string, dir = String(e8.variable("default-directory"))): string {
  const a = e8.expandFileName(file).split("/");
  const b = e8.directoryFileName(e8.expandFileName(dir)).split("/");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rel = [...Array(b.length - i).fill(".."), ...a.slice(i)].join("/");
  return rel === "" ? "." : rel;
}

export const magitPatchApplyCommand = (): void => {
  const at = magitFileAtPoint();
  const dir = e8.fileNameAsDirectory(String(e8.variable("default-directory")));
  const file = e8.expandFileName(e8.readFileName("Apply patch: ", { dir, initial: at ? `${dir}${fileRelativeName(at)}` : undefined }));
  magitPatchApplyFile(file, transientArgs("magit-patch-apply"));
};

export const magitPatchApply = transientDefinePrefix("magit-patch-apply", {
  doc: "Apply the patch file FILE.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-i", "Also apply to index", "--index"],
        ["-c", "Only apply to index", "--cached"],
        ["-3", "Fall back on 3way merge", "--3way"],
      ],
    },
    { description: "Actions", items: [["a", "Apply patch", magitPatchApplyCommand]] },
  ],
});

/** The arguments magit-patch-save uses, from the buffer's ARGS and whether ARG, the prefix argument, was given. */
function patchSaveArgs(args: string[], arg: boolean): string[] {
  const option = e8.variable("magit-patch-save-arguments");
  if (option === "buffer") return arg ? [] : args;
  if (Array.isArray(option) && option[0] === "exclude") {
    const exclude = option.slice(1).map(String);
    return arg ? args : args.filter((a) => !exclude.includes(a));
  }
  return arg ? args : Array.isArray(option) ? option.map(String) : [];
}

/** Writes the current diff into patch FILE, ARG as the prefix argument, as magit-patch-save does once it has its arguments. */
export function magitPatchSaveFile(file: string, arg = false): void {
  if (!e8.derivedModeP("magit-diff-mode")) e8.userError("Only diff buffers can be saved as patches");
  const rev = e8.variable("magit-buffer-range") as string | null;
  const typearg = e8.variable("magit-buffer-typearg") as string | null;
  const args = patchSaveArgs((e8.variable("magit-buffer-diff-args") as string[] | null) ?? [], arg);
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  const r = magitGitRun(["diff", rev, "-p", typearg, args, "--", files] as GitArg[]);
  e8.writeTextFile(e8.expandFileName(file), r.exit === 0 ? r.output : "");
  magitRefresh();
}

export const magitPatchSave = e8.defineCommand({
  name: "magit-patch-save",
  doc:
    "Write current diff into patch FILE.\n\nWhat arguments are used to create the patch depends on the value of `magit-patch-save-arguments' and whether a prefix argument is used.\n\nIf the value is the symbol `buffer', then use the same arguments as the buffer.  With a prefix argument use no arguments.\n\nIf the value is a list beginning with the symbol `exclude', then use the same arguments as the buffer except for those matched by entries in the cdr of the list.  The comparison is done using `string-prefix-p'.  With a prefix argument use the same arguments as the buffer.\n\nIf the value is a list of strings (including the empty list), then use those arguments.  With a prefix argument use the same arguments as the buffer.\n\nOf course the arguments that are required to actually show the same differences as those shown in the buffer are always used.",
  run: () => magitPatchSaveFile(e8.readFileName("Write patch file: ", { dir: e8.fileNameAsDirectory(String(e8.variable("default-directory"))) }), prefixArgP()),
});

/**
 * Puts the request that upstream pull END, from START, from the public
 * repository at URL, in a buffer, as magit-request-pull does once it has
 * its arguments. Magit composes a mail with compose-mail and inserts the
 * request in its body; E8 has no mail composition, so the request goes
 * into a buffer of its own, *magit-request-pull*, to copy into a mail.
 */
export function magitRequestPullBuffer(url: string, start: string, end?: string): string {
  const r = magitGitRun(["request-pull", start, url, end]);
  const dir = String(e8.variable("default-directory"));
  const buffer = e8.getBufferCreate("*magit-request-pull*");
  e8.withCurrentBuffer(buffer, () => {
    e8.setVariable("default-directory", dir);
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insert(r.output);
    e8.gotoChar(e8.pointMin());
    e8.setBufferModified(false);
  });
  const name = e8.bufferName(buffer) ?? "*magit-request-pull*";
  e8.call("pop-to-buffer", name);
  return name;
}

export const magitRequestPull = e8.defineCommand({
  name: "magit-request-pull",
  doc:
    "Request upstream to pull from your public repository.\n\nURL is the url of your publicly accessible repository.\nSTART is a commit that already is in the upstream repository.\nEND is the last commit, usually a branch name, which upstream is asked to pull.  START has to be reachable from that commit.",
  run: () => {
    const url = magitGet("remote", magitReadRemote("Remote"), "url") ?? "";
    const start = magitReadBranchOrCommit("Start", magitGetUpstreamBranch());
    const end = magitReadBranchOrCommit("End");
    magitRequestPullBuffer(url, start, end);
  },
});

export const magitPatch = transientDefinePrefix("magit-patch", {
  doc: "Create or apply patches.",
  groups: [
    {
      description: "Actions",
      items: [
        { items: [["c", "Create patches", magitPatchCreate], ["w", "Apply patches", magitAm]] },
        { items: [["a", "Apply plain patch", magitPatchApply], ["s", "Save diff as patch", magitPatchSave]] },
        { items: [["r", "Request pull", magitRequestPull]] },
      ],
    },
  ],
});
