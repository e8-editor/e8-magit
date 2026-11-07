// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reverting the repository's buffers when git changes their files, after
// magit-autorevert.el: magit-auto-revert-mode turns on auto-revert-mode
// in each buffer visiting a file git tracks, and after each git command
// Magit runs, when magit-refresh runs magit-post-refresh-hook, reverts
// the repository's unmodified buffers whose files changed
// (magit-auto-revert-buffers), as magit-auto-revert-immediately has it.
//
// E8 has no file notification: auto-revert-mode otherwise looks every
// auto-revert-interval seconds, so a change git makes outside Magit is
// seen only then.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";
import { magitFileTrackedP, magitToplevel } from "magit-git";

// Options.

e8.defineVariable({
  name: "auto-revert-buffer-list-filter",
  doc:
    "Filter that determines which buffers `auto-revert-buffers' reverts.\n\nThis option is provided by Magit, which also advises\n`auto-revert-buffers' to respect it.  Magit users who do not turn\non the local mode `auto-revert-mode' themselves, are best served\nby setting the value to `magit-auto-revert-repository-buffer-p'.\n\nHowever the default is nil, so as not to disturb users who do use\nthe local mode directly.  If you experience delays when running\nMagit commands, then you should consider using one of the\npredicates provided by Magit - especially if you also use Tramp.\n\nUsers who do turn on `auto-revert-mode' in buffers in which Magit\ndoesn't do that for them, should likely not use any filter.\nUsers who turn on `global-auto-revert-mode', do not have to worry\nabout this option, because it is disregarded if the global mode\nis enabled.",
  value: null,
});
e8.defineVariable({ name: "magit-auto-revert-tracked-only", doc: "Whether `magit-auto-revert-mode' only reverts tracked files.", value: true });
e8.defineVariable({
  name: "magit-auto-revert-immediately",
  doc:
    "Whether Magit reverts buffers immediately.\n\nIf this is non-nil and either `global-auto-revert-mode' or\n`magit-auto-revert-mode' is enabled, then Magit immediately\nreverts buffers by explicitly calling `auto-revert-buffers'\nafter running Git for side-effects.\n\nIf `auto-revert-use-notify' is non-nil (and file notifications\nare actually supported), then `magit-auto-revert-immediately'\ndoes not have to be non-nil, because the reverts happen\nimmediately anyway.\n\nIf `magit-auto-revert-immediately' and `auto-revert-use-notify'\nare both nil, then reverts happen after `auto-revert-interval'\nseconds of user inactivity.  That is not desirable.",
  value: true,
});

// The mode.

const on = (variable: string): boolean => truthy(e8.variable(variable));

/** The buffer visiting FILE, if any, as find-buffer-visiting. */
const findBufferVisiting = (file: string): string | undefined => {
  const f = e8.expandFileName(file);
  return e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === f);
};

/**
 * Turns on auto-revert-mode in the buffer visiting FILE, or the current
 * buffer, if it visits a file git tracks, as
 * magit-turn-on-auto-revert-mode-if-desired.
 */
export function magitTurnOnAutoRevertModeIfDesired(file?: string): void {
  if (file !== undefined) {
    const buffer = findBufferVisiting(file);
    if (buffer) e8.withCurrentBuffer(buffer, () => magitTurnOnAutoRevertModeIfDesired());
    return;
  }
  const visited = e8.bufferFileName();
  if (on("auto-revert-mode") || on("global-auto-revert-mode") || visited === undefined || !e8.fileReadableP(visited) || !magitToplevel()) return;
  if (on("magit-auto-revert-tracked-only") && !magitFileTrackedP(visited)) return;
  e8.callWithPrefix(1, "auto-revert-mode");
}
e8.defun("magit-turn-on-auto-revert-mode-if-desired", (file?: string) => magitTurnOnAutoRevertModeIfDesired(file ?? undefined));

export const magitAutoRevertMode = e8.defineMinorMode({
  name: "magit-auto-revert-mode",
  global: true,
  doc:
    "Toggle Magit Auto Revert mode.\n\nMagit Auto Revert mode is a global minor mode that reverts\nbuffers associated with a file that is located inside a Git\nrepository when the file changes on disk.  Use `auto-revert-mode'\nto revert a particular buffer.  Or use `global-auto-revert-mode'\nto revert all file-visiting buffers, not just those that visit\na file located inside a Git repository.\n\nThis global mode works by turning on the buffer-local mode\n`auto-revert-mode' at the time a buffer is first created.  The\nlocal mode is turned on if the visited file is being tracked in\na Git repository at the time when the buffer is created.\n\nIf `magit-auto-revert-tracked-only' is non-nil (the default),\nthen only tracked files are reverted.  But if you stage a\npreviously untracked file using `magit-stage', then this mode\nnotices that.\n\nUnlike `global-auto-revert-mode', this mode never reverts any\nbuffers that are not visiting files.\n\nIn E8, which has no file notification, Magit reverts the buffers\nafter each git command it runs, and auto-revert-mode otherwise\nevery `auto-revert-interval' seconds.",
  onChange: (enabled: boolean) => {
    for (const b of e8.bufferList()) {
      e8.withCurrentBuffer(b, () => {
        if (enabled) magitTurnOnAutoRevertModeIfDesired();
        else if (on("auto-revert-mode")) e8.callWithPrefix(0, "auto-revert-mode");
      });
    }
  },
});
// The globalized mode turns the local one on in each file visited.
e8.addHook("find-file-hook", () => {
  if (on("magit-auto-revert-mode")) magitTurnOnAutoRevertModeIfDesired();
});

// Reverting.

/** The repository magit-auto-revert-repository-buffer-p looked up for this round, as magit-auto-revert-toplevel. */
let autoRevertToplevel: [string | null, number] | undefined;
/** Incremented each time the buffers are reverted, as magit-auto-revert-counter. */
let autoRevertCounter = 1;

/**
 * Whether BUFFER visits a file inside the current repository, as
 * magit-auto-revert-repository-buffer-p; FALLBACK outside a repository.
 */
export function magitAutoRevertRepositoryBufferP(buffer: string, fallback = false): boolean {
  if (!autoRevertToplevel || autoRevertToplevel[1] !== autoRevertCounter) autoRevertToplevel = [magitToplevel() ?? null, autoRevertCounter];
  const top = autoRevertToplevel[0];
  if (top === null) return fallback;
  const dir = e8.withCurrentBuffer(buffer, () => e8.bufferFileName() ?? String(e8.variable("default-directory")));
  return e8.expandFileName(dir).startsWith(top);
}
e8.defun("magit-auto-revert-repository-buffer-p", (buffer: string, fallback?: boolean) => magitAutoRevertRepositoryBufferP(buffer, truthy(fallback)));

/** Whether BUFFER visits a file inside the current repository, or anything outside one, as magit-auto-revert-buffer-p. */
export const magitAutoRevertBufferP = (buffer: string): boolean => magitAutoRevertRepositoryBufferP(buffer, true);
e8.defun("magit-auto-revert-buffer-p", (buffer: string) => magitAutoRevertBufferP(buffer));

/** Reverts BUFFER if it auto-reverts, is unmodified, and its file changed, as auto-revert-handler. */
function autoRevertHandler(buffer: string): void {
  e8.withCurrentBuffer(buffer, () => {
    const file = e8.bufferFileName();
    if (file === undefined || e8.bufferModified() || !e8.visitedFileChanged() || !e8.fileExistsP(file)) return;
    e8.runHooks("before-revert-hook");
    e8.revertToVisitedFile();
    e8.runHooks("after-revert-hook");
    if (on("auto-revert-verbose")) e8.message(`Reverting buffer ‘${buffer}’`);
  });
}

/**
 * Reverts the repository's buffers whose files git changed, as
 * magit-auto-revert-buffers calls auto-revert-buffers with
 * auto-revert-buffer-list-filter, after git runs.
 */
export function magitAutoRevertBuffers(): void {
  if (!on("magit-auto-revert-immediately")) return;
  const global = on("global-auto-revert-mode");
  const list = e8.bufferList().filter((b) => e8.withCurrentBuffer(b, () => on("auto-revert-mode")));
  if (!global && !(on("magit-auto-revert-mode") && list.length > 0)) return;
  autoRevertCounter++;
  const filter = e8.variable("auto-revert-buffer-list-filter") ?? "magit-auto-revert-repository-buffer-p";
  const buffers = global ? e8.bufferList().filter((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName() !== undefined)) : list.filter((b) => truthy(e8.funcall(filter as string, b)));
  for (const b of buffers) autoRevertHandler(b);
}
e8.defun("magit-auto-revert-buffers", () => magitAutoRevertBuffers());
e8.addHook("magit-post-refresh-hook", magitAutoRevertBuffers);

// On unless global-auto-revert-mode is or E8 runs in batch, as Magit's
// :init-value and magit-auto-revert-mode--init-kludge have it.
if (!on("global-auto-revert-mode") && !on("noninteractive")) e8.callWithPrefix(1, magitAutoRevertMode);
