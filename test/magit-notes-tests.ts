// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit-notes' tests, with ERT: a note is written in a buffer and kept,
// removed from the default notes ref or another, notes refs are merged,
// a conflicted merge is seen, committed or aborted, notes about commits
// gone are pruned, and the menu sets core.notesRef and notes.displayRef.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitThisProcess } from "magit-process";
import { git, history, status, withRepos, settle, typed } from "magit-test-helpers";
import { magitListNotesRefnames, magitNotesMerge, magitNotesMergeAbort, magitNotesMergeCommit, magitNotesPruneCommand, magitNotesMergingP, magitNotesPrune, magitNotesRemove } from "magit-notes";

/** Waits for COND, and then for the git Magit started last to end. */
function waitFor(cond: () => boolean): void {
  settle(cond);
  settle(() => magitThisProcess()?.exit !== undefined);
}

ertDeftest("magit-notes-edit-writes-the-note-in-a-buffer", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    // The commit defaults to the current branch.
    e8.executeKbdMacro(`M-x ${typed("magit-notes-edit")} RET RET`);
    settle(() => e8.bufferName() === "NOTES_EDITMSG");
    shouldEqual(e8.bufferName(), "NOTES_EDITMSG");
    e8.executeKbdMacro(`${typed("A note")} C-c C-c`);
    waitFor(() => git(dir, "notes", "show", "HEAD") === "A note\n");
    shouldEqual(git(dir, "notes", "show", "HEAD"), "A note\n");
  });
});

ertDeftest("magit-notes-remove-removes-the-note", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "notes", "add", "-m", "Gone soon", "HEAD~1");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-notes-remove")} RET ${typed("HEAD~1")} RET`);
    waitFor(() => git(dir, "notes", "list") === "");
    shouldEqual(git(dir, "notes", "list"), "");
  });
});

ertDeftest("magit-notes-remove-from-another-ref", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "notes", "add", "-m", "Kept", "HEAD");
    git(dir, "notes", "--ref=other", "add", "-m", "Gone soon", "HEAD");
    status(dir);
    shouldEqual(magitListNotesRefnames(), ["commits", "other"]);
    magitNotesRemove("HEAD", "refs/notes/other");
    waitFor(() => git(dir, "notes", "--ref=other", "list") === "");
    shouldEqual(git(dir, "notes", "--ref=other", "list"), "");
    shouldEqual(git(dir, "notes", "show", "HEAD"), "Kept\n");
  });
});

ertDeftest("magit-notes-merge-merges-another-ref", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "notes", "--ref=other", "add", "-m", "Theirs", "HEAD");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-notes-merge")} RET ${typed("refs/notes/other")} RET`);
    waitFor(() => git(dir, "notes", "show", "HEAD") === "Theirs\n");
    shouldEqual(git(dir, "notes", "show", "HEAD"), "Theirs\n");
  });
});

ertDeftest("magit-notes-a-conflicted-merge-is-committed-or-aborted", () => {
  const dir = history();
  withRepos([dir], () => {
    const head = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "notes", "add", "-m", "Ours", "HEAD");
    git(dir, "notes", "--ref=other", "add", "-m", "Theirs", "HEAD");
    status(dir);
    should(!magitNotesMergingP(), "no merge before");
    magitNotesMerge("refs/notes/other");
    waitFor(() => magitNotesMergingP());
    should(magitNotesMergingP(), "the merge stops at the conflict");
    e8.call(magitNotesMergeAbort);
    waitFor(() => !magitNotesMergingP());
    should(!magitNotesMergingP(), "aborted");
    shouldEqual(git(dir, "notes", "show", "HEAD"), "Ours\n");

    magitNotesMerge("refs/notes/other");
    waitFor(() => magitNotesMergingP());
    e8.writeTextFile(`${dir}.git/NOTES_MERGE_WORKTREE/${head}`, "Both\n");
    e8.call(magitNotesMergeCommit);
    waitFor(() => git(dir, "notes", "show", "HEAD") === "Both\n");
    shouldEqual(git(dir, "notes", "show", "HEAD"), "Both\n");
    should(!magitNotesMergingP(), "committed");
  });
});

ertDeftest("magit-notes-prune-removes-notes-of-commits-gone", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "notes", "add", "-m", "Stays", "HEAD~1");
    git(dir, "notes", "add", "-m", "Pruned", "HEAD");
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    git(dir, "reflog", "expire", "--expire=now", "--all");
    git(dir, "gc", "-q", "--prune=now");
    status(dir);
    shouldEqual(git(dir, "notes", "list").trim().split("\n").length, 2);
    magitNotesPrune(true);
    waitFor(() => true);
    shouldEqual(git(dir, "notes", "list").trim().split("\n").length, 2);
    e8.call("switch-to-buffer", "*magit-test*");
    e8.call(magitNotesPruneCommand);
    waitFor(() => git(dir, "notes", "list").trim().split("\n").length === 1);
    shouldEqual(git(dir, "notes", "show", "HEAD"), "Stays\n");
  });
});

ertDeftest("magit-notes-menu-and-its-infixes", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "notes", "--ref=other", "add", "-m", "Other", "HEAD");
    status(dir);
    // Batch's frame is too short for the menu, which is laid out all the
    // same, as magit-tests.ts finds for the tallest menus.
    let tooTall = false;
    try {
      e8.executeKbdMacro(`M-x ${typed("magit-notes")} RET`);
    } catch (e) {
      if (!String(e).includes("Size of window too small")) throw e;
      tooTall = true;
    }
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    if (tooTall) e8.call("kill-buffer", " *transient*");
    else e8.executeKbdMacro("C-g");
    for (const want of ["Configure local settings", "Configure global settings", "Arguments for prune", "-n Dry run (--dry-run)", "-r Manipulate ref (--ref=)", "-s Merge strategy (--strategy=)", "T Edit", "r Remove", "m Merge", "p Prune"]) {
      should(menu.includes(want), `${want} in\n${menu}`);
    }
    should(!menu.includes("Commit merge"), "no merge to commit");
    // The infixes are commands of Magit's names.
    e8.executeKbdMacro(`M-x ${typed("magit-core.notesRef")} RET ${typed("other")} RET`);
    shouldEqual(git(dir, "config", "--local", "core.notesRef"), "refs/notes/other\n");
    e8.executeKbdMacro(`M-x ${typed("magit-notes.displayRef")} RET ${typed("other,refs/notes/commits")} RET`);
    shouldEqual(git(dir, "config", "--local", "--get-all", "notes.displayRef"), "refs/notes/other\nrefs/notes/commits\n");
  });
});
