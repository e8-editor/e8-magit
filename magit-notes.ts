// SPDX-License-Identifier: GPL-3.0-or-later
//
// Notes support, after magit-notes.el: the notes menu (T), setting
// core.notesRef and notes.displayRef locally and globally, editing and
// removing the note attached to a commit, merging notes refs, committing
// or aborting such a merge, and pruning notes about unreachable commits.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingRead, magitReadStringNs } from "magit-base";
import { magitGet, magitGetAll, magitSet, magitSetAll, magitGitdir, magitListRefnames, magitReadBranchOrCommit, magitStashAtPoint } from "magit-git";
import { magitProcessBuffer, magitRunGitWithEditor } from "magit-process";
import { magitRefresh } from "magit-mode";
import { magitGitVariable } from "magit-transient";

/** The notes refs, without refs/notes/, as magit-list-notes-refnames. */
export const magitListNotesRefnames = (): string[] => magitListRefnames("refs/notes").map((r) => r.slice(6));

/** Whether a notes merge is waiting to be committed, as magit-notes-merging-p. */
export function magitNotesMergingP(): boolean {
  const gitdir = magitGitdir();
  if (!gitdir) return false;
  const dir = e8.expandFileName("NOTES_MERGE_WORKTREE", gitdir);
  return e8.fileDirectoryP(dir) && e8.directoryFiles(dir).some((f) => !f.startsWith("."));
}

// Readers

/** Reads a notes ref, completing the short names, giving it in full, as magit-notes-read-ref. */
export function magitNotesReadRef(prompt: string, _initialInput?: string, history?: string): string | undefined {
  const def = magitGet("core.notesRef");
  const ref = magitCompletingRead(prompt, magitListNotesRefnames(), {
    requireMatch: true,
    initialInput: def === undefined ? undefined : def.startsWith("refs/notes/") ? def.slice(11) : def,
    history,
  });
  if (ref === undefined) return undefined;
  return ref.startsWith("refs/") ? ref : `refs/notes/${ref}`;
}

/** Reads notes refs separated by commas, each given in full, as magit-notes-read-refs with completing-read-multiple. */
export function magitNotesReadRefs(prompt: string, _initialInput?: string, _history?: string): string[] {
  const initial = magitGetAll("notes.displayRef")
    .map((ref) => (ref.startsWith("refs/notes/") ? ref.slice(11) : ref))
    .join(",");
  return e8
    .readString(`${prompt}: `, { initial })
    .split(/[ \t]*,[ \t]*/)
    .filter((ref) => ref !== "")
    .map((ref) => (ref.startsWith("refs/") ? ref : `refs/notes/${ref}`));
}

/** The commit to act on and the --ref the menu has, as magit-notes-read-args. */
export function magitNotesReadArgs(prompt: string): [string, string | undefined] {
  const ref = transientArgs("magit-notes")
    .map((a) => /^--ref=(.+)/.exec(a)?.[1])
    .find((r) => r !== undefined);
  return [magitReadBranchOrCommit(prompt, magitStashAtPoint()), ref];
}

// Infixes

type Infix = [string, () => e8.PropertizedString, e8.DefinedCommand, object];

/**
 * The infix showing and setting VARIABLE, local or GLOBAL, as Magit's
 * magit-core.notesRef and its kin: shown as magitGitVariable shows it,
 * and set by a command of the same name reading it with
 * magit-notes-read-ref, or magit-notes-read-refs for MULTI values.
 */
function notesInfix(name: string, key: string, variable: string, global: boolean, multi: boolean, options: { if?: () => unknown } = {}): Infix {
  const [k, describe, , extra] = magitGitVariable(key, () => variable, { global, multiValue: multi, ...options });
  const scope = global ? "--global" : "--local";
  const prompt = `Set ${global ? "global" : "local"} ${variable}`;
  const command = e8.defineCommand({
    name,
    doc: `${prompt}.`,
    run: () => {
      if (multi) magitSetAll(magitNotesReadRefs(prompt), scope, variable);
      else {
        const value = magitNotesReadRef(prompt);
        magitSet(value, scope, variable);
        if (value === undefined) e8.message(`Unset ${variable}`);
      }
      magitRefresh();
    },
  });
  return [k, describe, command, extra];
}

// Commands
//
// Each command is a function taking Magit's arguments, magitNotesEdit, and
// a command reading them, magitNotesEditCommand, as magit-process.ts has
// magitProcessBuffer and magitProcessBufferCommand.

/** Edits the note attached to COMMIT in notes ref REF, as magit-notes-edit. */
export const magitNotesEdit = (commit: string, ref?: string): string => magitRunGitWithEditor("notes", ref && `--ref=${ref}`, "edit", commit);
export const magitNotesEditCommand = e8.defineCommand({
  name: "magit-notes-edit",
  doc: 'Edit the note attached to COMMIT.\nREF is the notes ref used to store the notes.\n\nInteractively or when optional REF is nil use the value of Git\nvariable `core.notesRef\' or "refs/notes/commits" if that is\nundefined.',
  run: () => void magitNotesEdit(...magitNotesReadArgs("Edit notes")),
});

/** Removes the note attached to COMMIT from notes ref REF, as magit-notes-remove. */
export const magitNotesRemove = (commit: string, ref?: string): string => magitRunGitWithEditor("notes", ref && `--ref=${ref}`, "remove", commit);
export const magitNotesRemoveCommand = e8.defineCommand({
  name: "magit-notes-remove",
  doc: 'Remove the note attached to COMMIT.\nREF is the notes ref from which the note is removed.\n\nInteractively or when optional REF is nil use the value of Git\nvariable `core.notesRef\' or "refs/notes/commits" if that is\nundefined.',
  run: () => void magitNotesRemove(...magitNotesReadArgs("Remove notes")),
});

/** Merges notes ref REF into the current notes ref, as magit-notes-merge. */
export const magitNotesMerge = (ref: string): string => magitRunGitWithEditor("notes", "merge", ref);
export const magitNotesMergeCommand = e8.defineCommand({
  name: "magit-notes-merge",
  doc: "Merge the notes ref REF into the current notes ref.\n\nThe current notes ref is the value of Git variable\n`core.notesRef' or \"refs/notes/commits\" if that is undefined.\n\nWhen there are conflicts, then they have to be resolved in the\ntemporary worktree \".git/NOTES_MERGE_WORKTREE\".  When\ndone use `magit-notes-merge-commit' to finish.  To abort\nuse `magit-notes-merge-abort'.",
  run: () => void magitNotesMerge(magitReadStringNs("Merge reference")),
});

export const magitNotesMergeCommit = e8.defineCommand({
  name: "magit-notes-merge-commit",
  doc: "Commit the current notes ref merge.\nAlso see `magit-notes-merge'.",
  run: () => void magitRunGitWithEditor("notes", "merge", "--commit"),
});

export const magitNotesMergeAbort = e8.defineCommand({
  name: "magit-notes-merge-abort",
  doc: "Abort the current notes ref merge.\nAlso see `magit-notes-merge'.",
  run: () => void magitRunGitWithEditor("notes", "merge", "--abort"),
});

/** Removes notes about unreachable commits, only saying which with DRY-RUN, as magit-notes-prune. */
export function magitNotesPrune(dryRun = false): string {
  if (dryRun) magitProcessBuffer();
  return magitRunGitWithEditor("notes", "prune", dryRun && "--dry-run");
}
export const magitNotesPruneCommand = e8.defineCommand({
  name: "magit-notes-prune",
  doc: "Remove notes about unreachable commits.",
  run: () => void magitNotesPrune(transientArgs("magit-notes").includes("--dry-run")),
});

// The menu

const notMerging = () => !magitNotesMergingP();

export const magitNotes = transientDefinePrefix("magit-notes", {
  doc: "Edit notes attached to commits.",
  groups: [
    // While merging, c commits the merge, binding over core.notesRef's
    // c as transient's later binding does; this transient binds the
    // first, so core.notesRef's goes while merging.
    {
      description: "Configure local settings",
      items: [notesInfix("magit-core.notesRef", "c", "core.notesRef", false, false, { if: notMerging }), notesInfix("magit-notes.displayRef", "d", "notes.displayRef", false, true)],
    },
    {
      description: "Configure global settings",
      items: [notesInfix("magit-global-core.notesRef", "C", "core.notesRef", true, false), notesInfix("magit-global-notes.displayRef", "D", "notes.displayRef", true, true)],
    },
    { description: "Arguments for prune", ifNot: magitNotesMergingP, items: [["-n", "Dry run", "--dry-run"]] },
    {
      description: "Arguments for edit and remove",
      ifNot: magitNotesMergingP,
      items: [["-r", "Manipulate ref", "--ref=", { reader: (prompt: string, initial?: string) => magitNotesReadRef(prompt, initial) ?? "" }]],
    },
    {
      description: "Arguments for merge",
      ifNot: magitNotesMergingP,
      items: [["-s", "Merge strategy", "--strategy=", { choices: ["manual", "ours", "theirs", "union", "cat_sort_uniq"] }]],
    },
    {
      description: "Actions",
      ifNot: magitNotesMergingP,
      items: [
        ["T", "Edit", magitNotesEditCommand],
        ["r", "Remove", magitNotesRemoveCommand],
        ["m", "Merge", magitNotesMergeCommand],
        ["p", "Prune", magitNotesPruneCommand],
      ],
    },
    {
      description: "Actions",
      if: magitNotesMergingP,
      items: [
        ["c", "Commit merge", magitNotesMergeCommit],
        ["a", "Abort merge", magitNotesMergeAbort],
      ],
    },
  ],
});
