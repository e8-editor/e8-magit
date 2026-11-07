// SPDX-License-Identifier: GPL-3.0-or-later
//
// Magit's buffers, after magit-mode.el: magit-mode, the parent of every
// Magit buffer's mode; the buffers' names, as magit-buffer-name-format
// makes them; setting a buffer up and showing it, as magit-setup-buffer
// and magit-display-buffer; refreshing it and the repository's other
// buffers, with the refresh hooks and the refresh cache; and saving the
// repository's file buffers before git runs.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, magitGetSection, magitSectionIdent, magitSectionMode } from "magit-section";
import { PerBuffer, truthy } from "subr";
import { magitToplevel, magitToplevelOrError, magitWithRefreshCache } from "magit-git";

e8.defineVariable({
  name: "magit-save-repository-buffers",
  doc: "Whether to save file-visiting buffers of the repository before running git: t asks nothing, dontask too; nil saves none.",
  value: true,
});
e8.defineVariable({
  name: "magit-display-buffer-function",
  doc: "The function used to display a Magit buffer: magit-display-buffer-traditional, or another of Magit's or a config's.",
  value: "magit-display-buffer-traditional",
});
e8.defineVariable({ name: "magit-display-buffer-noselect", doc: "Whether to display Magit buffers without selecting their windows.", value: false });
e8.defineVariable({ name: "magit-refresh-verbose", doc: "Whether to say how long refreshing took.", value: false });
e8.defineVariable({ name: "magit-inhibit-refresh", doc: "Whether to not refresh Magit buffers after git runs.", value: false });
e8.defineVariable({ name: "magit-buffer-name-format", doc: "The format of Magit buffers' names: %M the mode's name without -mode, %m with it, %t the repository's directory name.", value: "%M%v: %t" });
e8.defineHook("magit-pre-refresh-hook", "Hook run before refreshing in magit-refresh.");
e8.defineHook("magit-post-refresh-hook", "Hook run after refreshing in magit-refresh.");
e8.defineHook("magit-refresh-buffer-hook", "Normal hook for magit-refresh-buffer to run after refreshing.");
e8.defineHook("magit-mode-setup-hook", "Hook run by magit-setup-buffer after the buffer is set up.");
e8.defineHook("magit-create-buffer-hook", "Normal hook run while creating a new magit-mode buffer.");

/** The parent of every Magit buffer's mode, as magit-mode. */
export const magitMode = e8.defineMajorMode({
  name: "magit-mode",
  modeName: "Magit",
  parent: magitSectionMode,
  doc: "Parent major mode of Magit's buffers.",
});

export const magitStatusMode = e8.defineMajorMode({ name: "magit-status-mode", modeName: "Magit", parent: magitMode, doc: "Mode for looking at Git status: the files changed, staged and untracked, and the commits." });
export const magitLogMode = e8.defineMajorMode({ name: "magit-log-mode", modeName: "Magit Log", parent: magitMode, doc: "Mode for looking at Git log." });
export const magitReflogMode = e8.defineMajorMode({ name: "magit-reflog-mode", modeName: "Magit Reflog", parent: magitLogMode, doc: "Mode for looking at Git reflog." });
export const magitRevisionMode = e8.defineMajorMode({ name: "magit-revision-mode", modeName: "Magit Rev", parent: magitMode, doc: "Mode for looking at a Git commit." });
export const magitStashMode = e8.defineMajorMode({ name: "magit-stash-mode", modeName: "Magit Stash", parent: magitMode, doc: "Mode for looking at a Git stash." });
export const magitDiffMode = e8.defineMajorMode({ name: "magit-diff-mode", modeName: "Magit Diff", parent: magitMode, doc: "Mode for looking at a Git diff." });
export const magitProcessMode = e8.defineMajorMode({ name: "magit-process-mode", modeName: "Magit Process", parent: magitMode, doc: "Mode for looking at Git process output." });

/** How each Magit buffer is made again, and what it shows. */
interface MagitBuffer {
  kind: string;
  refresh: () => void;
  /** The repository's top directory. */
  dir: string;
}
const buffers = new PerBuffer<MagitBuffer>();

/** The repository's directory name, as %t names it. */
export const magitRepoName = (dir: string): string => e8.fileNameNondirectory(dir.replace(/\/$/, ""));

/** The name of a Magit buffer of MODE for the repository in DIR, as magit-generate-buffer-name-default-function. */
export function magitBufferName(mode: string, dir = magitToplevelOrError()): string {
  const format = String(e8.variable("magit-buffer-name-format") ?? "%M%v: %t");
  const short = mode === "magit-status-mode" ? "magit" : mode.replace(/-mode$/, "");
  return format
    .replace("%M", short)
    .replace("%m", mode)
    .replace("%v", "")
    .replace("%t", magitRepoName(dir))
    .replace("%x", "");
}

/** What a Magit buffer is: its kind and repository, or undefined for another buffer. */
export const magitBufferInfo = (buffer: string | e8.Buffer = e8.currentBuffer()): MagitBuffer | undefined => {
  const b = typeof buffer === "string" ? e8.getBuffer(buffer) : buffer;
  return b ? buffers.get(b) : undefined;
};

/**
 * Makes or reuses the Magit buffer NAME of MODE for the repository, has
 * REFRESH make its content, and shows it, as magit-setup-buffer: KIND
 * names what it shows, as Magit's modes do.
 */
export function magitSetupBuffer(name: string, mode: e8.DefinedCommand | string, kind: string, refresh: () => void, select = true): string {
  const dir = magitToplevelOrError();
  const existed = e8.bufferLiveP(e8.getBuffer(name));
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    if (!existed) {
      e8.call(mode as e8.DefinedCommand);
      e8.makeLocalVariable("default-directory");
      e8.setVariable("default-directory", dir);
      e8.runHooks("magit-create-buffer-hook");
    }
    buffers.set(e8.currentBuffer(), { kind, refresh, dir });
  });
  if (select) magitDisplayBuffer(name);
  e8.withCurrentBuffer(name, () => {
    magitRefreshBuffer();
    e8.runHooks("magit-mode-setup-hook");
  });
  return name;
}

/** Shows BUFFER as magit-display-buffer-function says, selecting its window unless magit-display-buffer-noselect. */
export function magitDisplayBuffer(buffer: string): void {
  const fn = e8.variable("magit-display-buffer-function");
  if (typeof fn === "function" || (typeof fn === "string" && fn !== "magit-display-buffer-traditional" && e8.fboundp(fn))) {
    e8.funcall(fn as string, buffer);
    return;
  }
  magitDisplayBufferTraditional(buffer);
}

/**
 * Shows BUFFER as Magit did traditionally: in the selected window if that
 * shows a Magit buffer and BUFFER is not a diff, process, revision, stash
 * or status buffer, else in another window, as magit-display-buffer-traditional.
 */
export function magitDisplayBufferTraditional(buffer: string): void {
  const mode = e8.withCurrentBuffer(buffer, () => String(e8.variable("major-mode")));
  const inMagit = magitBufferInfo() !== undefined;
  const elsewhere = ["magit-process-mode", "magit-revision-mode", "magit-diff-mode", "magit-stash-mode", "magit-status-mode"].includes(mode);
  if (inMagit && !elsewhere) e8.call("switch-to-buffer", buffer);
  else if (truthy(e8.variable("magit-display-buffer-noselect"))) e8.call("display-buffer", buffer);
  else if (mode === "magit-status-mode") e8.call("switch-to-buffer", buffer);
  else e8.call("pop-to-buffer", buffer);
}
e8.defun("magit-display-buffer-traditional", (buffer: string) => magitDisplayBufferTraditional(buffer));
e8.defun("magit-display-buffer-same-window-except-diff-v1", (buffer: string) => {
  const mode = e8.withCurrentBuffer(buffer, () => String(e8.variable("major-mode")));
  if (["magit-process-mode", "magit-revision-mode", "magit-diff-mode", "magit-stash-mode"].includes(mode)) e8.call("pop-to-buffer", buffer);
  else e8.call("switch-to-buffer", buffer);
});
e8.defun("magit-display-buffer-fullframe-status-v1", (buffer: string) => {
  const mode = e8.withCurrentBuffer(buffer, () => String(e8.variable("major-mode")));
  if (mode === "magit-status-mode") {
    e8.call("switch-to-buffer", buffer);
    e8.call("delete-other-windows");
  } else magitDisplayBufferTraditional(buffer);
});

/** Makes the current Magit buffer again, keeping point on the same section or line, as magit-refresh-buffer. */
export function magitRefreshBuffer(): void {
  const entry = magitBufferInfo();
  if (!entry) return;
  const at = currentSection();
  const line = e8.lineOf(e8.point());
  const column = e8.point() - e8.lineStart(line);
  const id = at && at.parent ? magitSectionIdent(at) : undefined;
  const offset = at ? e8.lineOf(e8.point()) - e8.lineOf(at.start) : 0;
  e8.letBind({ "inhibit-read-only": true }, () => magitWithRefreshCache(entry.refresh));
  const again = id ? magitGetSection(id) : undefined;
  if (again) {
    const target = Math.min(e8.lineOf(again.start) + offset, e8.lineOf(Math.max(again.start, again.end - 1)));
    e8.gotoChar(Math.min(e8.lineStart(target) + column, e8.lineEnd(target)));
  } else e8.gotoChar(e8.lineStart(Math.min(line, e8.lineCount() - 1)));
  e8.setBufferModified(false);
  e8.runHooks("magit-refresh-buffer-hook");
}

/** The Magit buffer of MODE for the repository in DIR, if there is one, as magit-get-mode-buffer. */
export function magitGetModeBuffer(mode: string, dir = magitToplevel()): string | undefined {
  return e8.bufferList().find((b) => {
    const info = magitBufferInfo(b);
    return info !== undefined && info.dir === dir && e8.withCurrentBuffer(b, () => String(e8.variable("major-mode"))) === mode;
  });
}

/**
 * Refreshes the current Magit buffer and the repository's status buffer,
 * with the refresh hooks around them and git's answers cached, as
 * magit-refresh does after a command.
 */
export function magitRefresh(): void {
  if (truthy(e8.variable("magit-inhibit-refresh"))) return;
  magitWithRefreshCache(() => {
    e8.runHooks("magit-pre-refresh-hook");
    const current = magitBufferInfo() ? e8.bufferName() : undefined;
    if (current) magitRefreshBuffer();
    const status = magitGetModeBuffer("magit-status-mode");
    if (status && status !== current) e8.withCurrentBuffer(status, magitRefreshBuffer);
    e8.runHooks("magit-post-refresh-hook");
  });
}

/** Refreshes every Magit buffer of the repository in DIR, as magit-refresh-all. */
export function magitRefreshAll(dir = magitToplevel()): void {
  magitWithRefreshCache(() => {
    e8.runHooks("magit-pre-refresh-hook");
    for (const b of e8.bufferList()) {
      const info = magitBufferInfo(b);
      if (info && info.dir === dir) e8.withCurrentBuffer(b, magitRefreshBuffer);
    }
    e8.runHooks("magit-post-refresh-hook");
  });
}

/** Saves the repository's modified file buffers, as magit-save-repository-buffers does before git runs. */
export function magitSaveRepositoryBuffers(): void {
  if (!truthy(e8.variable("magit-save-repository-buffers"))) return;
  const top = magitToplevel();
  if (!top) return;
  for (const b of e8.bufferList()) {
    e8.withCurrentBuffer(b, () => {
      const f = e8.bufferFileName();
      if (f && e8.bufferModified() && e8.expandFileName(f).startsWith(top)) e8.call("save-buffer");
    });
  }
}

export const magitRefreshCommand = e8.defineCommand({
  name: "magit-refresh",
  doc: "Refresh the current buffer, and the repository's status buffer.",
  run: () => magitRefresh(),
});
export const magitRefreshAllCommand = e8.defineCommand({
  name: "magit-refresh-all",
  doc: "Refresh all buffers belonging to the current repository.",
  run: () => magitRefreshAll(),
});
export const magitModeBuryBuffer = e8.defineCommand({
  name: "magit-mode-bury-buffer",
  doc: "Bury or kill the current buffer: with a prefix argument, kill it, as magit-mode-bury-buffer.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill: e8.Value) => e8.call("quit-window", truthy(kill)),
});
