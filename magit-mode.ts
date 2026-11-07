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

import { currentSection, magitGetSection, magitSectionIdent, magitSectionMode, magitSectionUpdateHighlight } from "magit-section";
import { PerBuffer, truthy } from "subr";
import { magitRefreshCacheCounts, magitToplevel, magitToplevelOrError, magitWithRefreshCache } from "magit-git";

e8.defineVariable({
  name: "magit-save-repository-buffers",
  doc: "Whether to save file-visiting buffers of the repository before running git: t asks nothing, dontask too; nil saves none.",
  value: true,
});
e8.defineVariable({
  name: "magit-display-buffer-function",
  doc:
    "The function used to display a Magit buffer.\n\n" +
    "All Magit buffers (buffers whose major-modes derive from magit-mode) are displayed using magit-display-buffer, which in turn uses the function specified here: magit-display-buffer-traditional, magit-display-buffer-same-window-except-diff-v1, magit-display-buffer-fullframe-status-v1, magit-display-buffer-fullframe-status-topleft-v1, magit-display-buffer-fullcolumn-most-v1, display-buffer, or another function of the buffer that gives the window it used.",
  value: "magit-display-buffer-traditional",
});
e8.defineVariable({ name: "magit-display-buffer-noselect", doc: "If non-nil, then magit-display-buffer doesn't call select-window.", value: false });
e8.defineVariable({
  name: "magit-bury-buffer-function",
  doc: "The function used to bury or kill the current Magit buffer: quit-window, magit-mode-quit-window, magit-restore-window-configuration, or another function of whether to kill it.",
  value: "magit-mode-quit-window",
});
e8.defineVariable({ name: "magit-refresh-verbose", doc: "Whether to revert Magit buffers verbosely.", value: false });
e8.defineVariable({
  name: "magit-refresh-status-buffer",
  doc: "Whether the status buffer is refreshed after running git.\n\nWhen this is non-nil, then the status buffer is automatically refreshed after running git for side-effects, in addition to the current Magit buffer, which is always refreshed automatically.\n\nOnly set this to nil after exhausting all other options to improve performance.",
  value: true,
});
e8.defineVariable({ name: "magit-inhibit-save-previous-winconf", doc: "Whether magit-save-window-configuration leaves the window configuration unsaved; unset forgets the one saved.", value: false });
e8.defineVariable({ name: "magit-inhibit-refresh", doc: "Whether to not refresh Magit buffers after git runs.", value: false });
e8.defineVariable({ name: "magit-buffer-name-format", doc: "The format of Magit buffers' names: %M the mode's name without -mode, %m with it, %t the repository's directory name.", value: "%M%v: %t" });
for (const [name, doc] of [
  ["magit-buffer-range", "The range a diff or log buffer shows."],
  ["magit-buffer-range-hashed", "The range a diff buffer shows, with hashes for its ends."],
  ["magit-buffer-typearg", "What a diff buffer compares with: --cached, --no-index, or nil for the working tree."],
  ["magit-buffer-diff-type", "What a diff buffer shows: staged, unstaged, committed or undefined."],
  ["magit-buffer-diff-args", "The arguments of git diff for a diff buffer."],
  ["magit-buffer-diff-files", "The files a diff buffer is limited to."],
  ["magit-buffer-revision", "The revision a revision or stash buffer shows."],
  ["magit-buffer-revision-hash", "The hash of the revision a revision buffer shows."],
  ["magit-buffer-refname", "The ref a blob buffer was visited from."],
  ["magit-buffer-file-name", "The file a blob buffer shows."],
  ["magit-buffer-log-args", "The arguments of git log for a log buffer."],
  ["magit-buffer-log-files", "The files a log buffer is limited to."],
  ["magit-buffer-revisions", "The revisions a log buffer shows."],
] as const) e8.defineVariable({ name, doc, value: null });

e8.defineHook("magit-pre-refresh-hook", "Hook run before refreshing in magit-refresh.\n\nThis hook, or magit-post-refresh-hook, should be used for functions that are not tied to a particular buffer.\n\nTo run a function with a particular buffer current, use magit-refresh-buffer-hook and use derived-mode-p inside your function.");
e8.defineHook("magit-post-refresh-hook", "Hook run after refreshing in magit-refresh.\n\nThis hook, or magit-pre-refresh-hook, should be used for functions that are not tied to a particular buffer.\n\nTo run a function with a particular buffer current, use magit-refresh-buffer-hook and use derived-mode-p inside your function.");
e8.defineHook("magit-unwind-refresh-hook", "Hook run when magit-refresh is done, even if it failed.");
e8.defineHook("magit-pre-display-buffer-hook", "Hook run by magit-display-buffer before displaying the buffer.");
e8.defineHook("magit-post-display-buffer-hook", "Hook run by magit-display-buffer after displaying the buffer.");
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
export function magitSetupBuffer(name: string, mode: e8.DefinedCommand | string, kind: string, refresh: () => void, select = true, locals: { [variable: string]: e8.Value } = {}): string {
  const dir = magitToplevelOrError();
  const existed = e8.bufferLiveP(e8.getBuffer(name));
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    if (!existed || String(e8.variable("major-mode")) !== String(mode)) {
      e8.call(mode as e8.DefinedCommand);
      e8.makeLocalVariable("default-directory");
      e8.setVariable("default-directory", dir);
      if (!existed) e8.runHooks("magit-create-buffer-hook");
    }
    // What the buffer shows, as magit-setup-buffer binds magit-buffer-range and the rest.
    for (const [variable, value] of Object.entries(locals)) {
      e8.makeLocalVariable(variable);
      e8.setVariable(variable, value);
    }
    buffers.set(e8.currentBuffer(), { kind, refresh, dir });
  });
  if (select) magitDisplayBuffer(name);
  e8.withCurrentBuffer(name, () => {
    magitRefreshBuffer(!existed);
    e8.runHooks("magit-mode-setup-hook");
  });
  return name;
}

// Displaying buffers.

/** The major mode of BUFFER. */
const modeOf = (buffer: string): string => e8.withCurrentBuffer(buffer, () => String(e8.variable("major-mode")));
/** Whether BUFFER's mode is one of MODES or built on one, as derived-mode-p in it. */
const derivedIn = (buffer: string, ...modes: string[]): boolean => e8.withCurrentBuffer(buffer, () => e8.derivedModeP(...modes));
/** The window showing BUFFER, the selected one first, as get-buffer-window. */
function bufferWindow(buffer: string): number | undefined {
  const selected = e8.selectedWindow();
  if (e8.windowBuffer(selected) === buffer) return selected;
  return e8.windowList().find((w) => e8.windowBuffer(w) === buffer);
}

/**
 * Displays BUFFER in some window and selects it, unless
 * magit-display-buffer-noselect, as magit-display-buffer: with
 * DISPLAY-FUNCTION, or magit-display-buffer-function, which gives the
 * window it used. Runs magit-pre-display-buffer-hook and
 * magit-post-display-buffer-hook in BUFFER around it.
 */
export function magitDisplayBuffer(buffer: string, displayFunction?: string | ((buffer: string) => unknown)): void {
  e8.withCurrentBuffer(buffer, () => e8.runHooks("magit-pre-display-buffer-hook"));
  const fn = displayFunction ?? (e8.variable("magit-display-buffer-function") as string | ((buffer: string) => unknown) | null) ?? "magit-display-buffer-traditional";
  let window = typeof fn === "function" ? fn(buffer) : fn === "display-buffer" ? displayBufferDefault(buffer) : e8.funcall(fn, buffer);
  if (typeof window !== "number" || !e8.windowList().includes(window)) window = bufferWindow(buffer);
  if (!truthy(e8.variable("magit-display-buffer-noselect")) && typeof window === "number") e8.selectWindow(window);
  e8.withCurrentBuffer(buffer, () => e8.runHooks("magit-post-display-buffer-hook"));
}

// The ways of display-buffer the functions below ask for.

/** Shows BUFFER in the selected window, as display-buffer-same-window. */
function displayBufferSameWindow(buffer: string): number {
  const selected = e8.selectedWindow();
  if (e8.windowBuffer(selected) !== buffer) e8.call("switch-to-buffer", buffer);
  return selected;
}
/** Shows BUFFER as display-buffer does by default, in a window it shows in, else one split off, else another. */
function displayBufferDefault(buffer: string): number {
  e8.call("display-buffer", buffer);
  return bufferWindow(buffer)!;
}
/** Shows BUFFER as display-buffer does with inhibit-same-window: never in the selected window. */
function displayBufferInhibitSameWindow(buffer: string): number {
  const selected = e8.selectedWindow();
  const other = e8.windowList().find((w) => w !== selected && e8.windowBuffer(w) === buffer);
  if (other !== undefined) return other;
  e8.call("switch-to-buffer-other-window", buffer);
  const window = e8.selectedWindow();
  if (e8.windowList().includes(selected)) e8.selectWindow(selected);
  return window;
}
/** Shows BUFFER in a window that shows it, or the selected one, then deletes the frame's other windows, as magit--display-buffer-fullframe. */
function displayBufferFullframe(buffer: string): number {
  const window = bufferWindow(buffer) ?? displayBufferSameWindow(buffer);
  for (const w of e8.windowList()) if (w !== window) e8.deleteWindow(w);
  return window;
}
/**
 * Shows BUFFER in a new window, then swaps it with the selected window's
 * buffer, so BUFFER is above or left of it, as magit--display-buffer-topleft;
 * a window already showing BUFFER is used as it is.
 */
function displayBufferTopleft(buffer: string): number {
  const showing = bufferWindow(buffer);
  if (showing !== undefined) return showing;
  const before = e8.windowList();
  const window1 = e8.selectedWindow();
  const window2 = displayBufferDefault(buffer);
  if (before.includes(window2)) return window2;
  const buffer1 = e8.windowBuffer(window1)!;
  const restore = e8.windowParameter(window2, "quit-restore");
  e8.setWindowBuffer(window1, buffer);
  e8.setWindowBuffer(window2, buffer1);
  e8.selectWindow(window2);
  // Swap the window state that magit-mode-quit-window and quit-restore-window look at.
  e8.setWindowPrevBuffers(window2, e8.windowPrevBuffers(window1).slice(1));
  e8.setWindowPrevBuffers(window1, []);
  e8.setWindowParameter(window2, "magit-dedicated", e8.windowParameter(window1, "magit-dedicated") ?? null);
  e8.setWindowParameter(window1, "magit-dedicated", true);
  const r = Array.isArray(restore) ? restore : [];
  e8.setWindowParameter(window1, "quit-restore", ["window", "window", r[2] ?? window2, r[3] ?? buffer] as e8.Value);
  e8.setWindowParameter(window2, "quit-restore", null);
  return window1;
}
/** Each window's left edge and width, in columns, from the frame's window tree. */
function windowColumns(): Map<number, [number, number]> {
  const columns = new Map<number, [number, number]>();
  const width = (t: e8.WindowTreeNode): number => (typeof t === "number" ? (e8.windowSize(t)?.totalWidth ?? 0) : t[0] ? width(t[2]) + width(t[3]) : width(t[2]));
  const walk = (t: e8.WindowTreeNode, left: number): void => {
    if (typeof t === "number") columns.set(t, [left, width(t)]);
    else {
      walk(t[2], left);
      walk(t[3], t[0] ? left + width(t[2]) : left);
    }
  };
  walk(e8.windowTree(), 0);
  return columns;
}
/** Deletes the windows above and below WINDOW, those with its left and right edges, as delete-other-windows-vertically. */
function deleteOtherWindowsVertically(window: number): void {
  const columns = windowColumns();
  const [left, width] = columns.get(window) ?? [0, 0];
  for (const [w, [l, wd]] of columns) if (w !== window && l === left && wd === width) e8.deleteWindow(w);
}
/** Shows BUFFER in a window that shows it, or the selected one, then makes that the column's only window, as magit--display-buffer-fullcolumn. */
function displayBufferFullcolumn(buffer: string): number {
  const window = bufferWindow(buffer) ?? displayBufferSameWindow(buffer);
  deleteOtherWindowsVertically(window);
  return window;
}

/**
 * Displays BUFFER the way this has traditionally been done, as
 * magit-display-buffer-traditional: in the selected window from a Magit
 * buffer, unless BUFFER is a process, revision, diff, stash or status
 * buffer, which go in another window.
 */
export function magitDisplayBufferTraditional(buffer: string): number {
  const elsewhere = ["magit-process-mode", "magit-revision-mode", "magit-diff-mode", "magit-stash-mode", "magit-status-mode"].includes(modeOf(buffer));
  return e8.derivedModeP("magit-mode") && !elsewhere ? displayBufferSameWindow(buffer) : displayBufferDefault(buffer);
}
e8.defun("magit-display-buffer-traditional", magitDisplayBufferTraditional);

/**
 * Displays BUFFER in the selected window except for some modes, as
 * magit-display-buffer-same-window-except-diff-v1: a buffer whose mode
 * derives from magit-diff-mode or magit-process-mode goes in another window.
 */
export function magitDisplayBufferSameWindowExceptDiffV1(buffer: string): number {
  return derivedIn(buffer, "magit-diff-mode", "magit-process-mode") ? displayBufferInhibitSameWindow(buffer) : displayBufferSameWindow(buffer);
}
e8.defun("magit-display-buffer-same-window-except-diff-v1", magitDisplayBufferSameWindowExceptDiffV1);

/** Displays BUFFER, filling the entire frame if it is a status buffer, else as magit-display-buffer-traditional, as magit-display-buffer-fullframe-status-v1. */
export function magitDisplayBufferFullframeStatusV1(buffer: string): number {
  return modeOf(buffer) === "magit-status-mode" ? displayBufferFullframe(buffer) : magitDisplayBufferTraditional(buffer);
}
e8.defun("magit-display-buffer-fullframe-status-v1", magitDisplayBufferFullframeStatusV1);

/**
 * Displays BUFFER, filling the entire frame if it is a status buffer, as
 * magit-display-buffer-fullframe-status-topleft-v1: a buffer whose mode
 * derives from magit-diff-mode or magit-process-mode goes above or left of
 * the current buffer rather than below or right of it, and any other in
 * the selected window.
 */
export function magitDisplayBufferFullframeStatusTopleftV1(buffer: string): number {
  if (modeOf(buffer) === "magit-status-mode") return displayBufferFullframe(buffer);
  if (derivedIn(buffer, "magit-diff-mode", "magit-process-mode")) return displayBufferTopleft(buffer);
  return displayBufferSameWindow(buffer);
}
e8.defun("magit-display-buffer-fullframe-status-topleft-v1", magitDisplayBufferFullframeStatusTopleftV1);

/**
 * Displays BUFFER using the full column except in some cases, as
 * magit-display-buffer-fullcolumn-most-v1: in the selected window, grown
 * to the frame's height by deleting the other windows in its column; but
 * a process buffer, or a diff buffer shown from a log or a commit message,
 * goes in another window.
 */
export function magitDisplayBufferFullcolumnMostV1(buffer: string): number {
  const fromLog = truthy(e8.variable("git-commit-mode")) || e8.derivedModeP("magit-log-mode", "magit-cherry-mode", "magit-reflog-mode");
  if ((fromLog && derivedIn(buffer, "magit-diff-mode")) || derivedIn(buffer, "magit-process-mode")) return displayBufferDefault(buffer);
  return displayBufferFullcolumn(buffer);
}
e8.defun("magit-display-buffer-fullcolumn-most-v1", magitDisplayBufferFullcolumnMostV1);

/**
 * Marks the window showing the current buffer as dedicated, if it was made
 * to show it, as magit-maybe-set-dedicated: magit-mode-quit-window then
 * deletes it when its last Magit buffer is buried.
 */
export function magitMaybeSetDedicated(): void {
  const window = bufferWindow(e8.bufferName());
  if (window !== undefined && e8.windowPrevBuffers(window).length === 0) e8.setWindowParameter(window, "magit-dedicated", true);
}
e8.defun("magit-maybe-set-dedicated", magitMaybeSetDedicated);
e8.addHook("magit-post-display-buffer-hook", magitMaybeSetDedicated);

// Restoring the window configuration.

/** Each Magit buffer's window configuration from before it was shown, as magit-previous-window-configuration. */
const previousWindowConfigurations = new PerBuffer<[number, e8.WindowConfiguration]>();

/**
 * Saves the current window configuration, as magit-save-window-configuration,
 * for magit-restore-window-configuration to put back when the buffer is
 * buried: unless the buffer is already shown in the selected frame.
 */
export function magitSaveWindowConfiguration(): void {
  const inhibit = e8.variable("magit-inhibit-save-previous-winconf");
  if (truthy(inhibit)) {
    if (inhibit === "unset") previousWindowConfigurations.delete(e8.currentBuffer());
  } else if (bufferWindow(e8.bufferName()) === undefined) {
    previousWindowConfigurations.set(e8.currentBuffer(), [e8.selectedFrame(), e8.currentWindowConfiguration()]);
  }
}
e8.defun("magit-save-window-configuration", magitSaveWindowConfiguration);
e8.addHook("magit-pre-display-buffer-hook", magitSaveWindowConfiguration);

/** Buries or kills the current buffer and restores the previous window configuration, as magit-restore-window-configuration. */
export function magitRestoreWindowConfiguration(killBuffer = false): void {
  const buffer = e8.currentBuffer();
  const saved = previousWindowConfigurations.get(buffer);
  quitWindow(killBuffer);
  if (saved && saved[0] === e8.selectedFrame()) {
    e8.setWindowConfiguration(saved[1]);
    if (e8.bufferLiveP(buffer)) previousWindowConfigurations.delete(buffer);
  }
}
e8.defun("magit-restore-window-configuration", (kill?: e8.Value) => magitRestoreWindowConfiguration(truthy(kill)));

/** Makes the current Magit buffer again, keeping point on the same section or line, as magit-refresh-buffer; CREATED says it is new. */
export function magitRefreshBuffer(created = false): void {
  const entry = magitBufferInfo();
  if (!entry) return;
  const verbose = truthy(e8.variable("magit-refresh-verbose"));
  const action = created ? "Creating" : "Refreshing";
  const start = Date.now();
  if (verbose) e8.message(`${action} buffer \`${e8.bufferName()}'...`);
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
  magitSectionUpdateHighlight(true);
  if (verbose) e8.message(`${action} buffer \`${e8.bufferName()}'...done (${seconds(start)}s)`);
}

/** The seconds since START, a time in milliseconds, to three places. */
const seconds = (start: number): string => ((Date.now() - start) / 1000).toFixed(3);

/**
 * Runs HOOK, as magit-run-hook-with-benchmark: with magit-refresh-verbose,
 * saying how long it and each of its functions took.
 */
export function magitRunHookWithBenchmark(hook: string): void {
  if (!truthy(e8.variable("magit-refresh-verbose"))) return void e8.runHooks(hook);
  e8.message(`Running ${hook}...`);
  const start = Date.now();
  const fns = (e8.variable(hook) as unknown[] | null) ?? [];
  for (const fn of Array.isArray(fns) ? fns : [fns]) {
    if (fn === true || fn === null || fn === undefined) continue;
    const t = Date.now();
    if (typeof fn === "function") (fn as () => void)();
    else e8.funcall(String(fn));
    const name = typeof fn === "function" ? (fn as { name?: string }).name || "(lambda)" : String(fn);
    e8.message(`  ${name.padEnd(50)} ${((Date.now() - t) / 1000).toFixed(6)}`);
  }
  e8.message(`Running ${hook}...done (${seconds(start)}s)`);
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
  try {
    magitWithRefreshCache(() => {
      const start = Date.now();
      const verbose = truthy(e8.variable("magit-refresh-verbose"));
      if (verbose) e8.message("Refreshing magit...");
      magitRunHookWithBenchmark("magit-pre-refresh-hook");
      const current = magitBufferInfo() ? e8.bufferName() : undefined;
      if (current) magitRefreshBuffer();
      else if (e8.derivedModeP("tabulated-list-mode")) e8.call("tabulated-list-revert");
      const status = truthy(e8.variable("magit-refresh-status-buffer")) && String(e8.variable("major-mode")) !== "magit-status-mode" ? magitGetModeBuffer("magit-status-mode") : undefined;
      if (status && status !== current) e8.withCurrentBuffer(status, () => magitRefreshBuffer());
      magitRunHookWithBenchmark("magit-post-refresh-hook");
      if (verbose) {
        const { hits, misses } = magitRefreshCacheCounts();
        const all = hits + misses;
        e8.message(`Refreshing magit...done (${seconds(start)}s, cached ${hits}/${all} (${all === 0 ? "NaN" : Math.round((hits / all) * 100)}%))`);
      }
    });
  } finally {
    e8.runHooks("magit-unwind-refresh-hook");
  }
}

/** Refreshes every Magit buffer of the repository in DIR, as magit-refresh-all. */
export function magitRefreshAll(dir = magitToplevel()): void {
  magitWithRefreshCache(() => {
    magitRunHookWithBenchmark("magit-pre-refresh-hook");
    for (const b of magitModeGetBuffers(dir)) e8.withCurrentBuffer(b, () => magitRefreshBuffer());
    magitRunHookWithBenchmark("magit-post-refresh-hook");
  });
}

/** The Magit buffers of the repository in DIR, as magit-mode-get-buffers. */
export function magitModeGetBuffers(dir = magitToplevel()): string[] {
  return e8.bufferList().filter((b) => magitBufferInfo(b)?.dir === dir);
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
export const magitToggleVerboseRefresh = e8.defineCommand({
  name: "magit-toggle-verbose-refresh",
  doc: "Toggle whether Magit refreshes buffers verbosely.\nEnabling this helps figuring out which sections are bottlenecks.\nThe additional output can be found in the *Messages* buffer.",
  run: () => {
    const on = !truthy(e8.variable("magit-refresh-verbose"));
    e8.setVariable("magit-refresh-verbose", on);
    e8.message(`${on ? "Enabled" : "Disabled"} verbose refreshing`);
  },
});

/** Quits the selected window, burying or with KILL killing its buffer, as quit-window. */
const quitWindow = (kill: boolean): void => void e8.call("quit-window", kill ? true : null);

/**
 * Quits the selected window and buries its buffer, as magit-mode-quit-window:
 * as quit-window, but when the window was made to show a Magit buffer and
 * the current buffer is the last Magit buffer ever shown in it, deletes
 * the window.
 */
export function magitModeQuitWindow(killBuffer = false): void {
  const window = e8.selectedWindow();
  const current = e8.bufferName();
  const dedicated = truthy(e8.windowParameter(window, "magit-dedicated"));
  const keep =
    e8.windowList().length === 1 ||
    e8.windowPrevBuffers(window).some(([b]) => b !== current && e8.bufferLiveP(e8.getBuffer(b)) && (!dedicated || derivedIn(b, "magit-mode", "magit-process-mode")));
  quitWindow(killBuffer);
  if (!keep && e8.windowList().includes(window) && e8.windowList().length > 1) e8.deleteWindow(window);
}
e8.defun("magit-mode-quit-window", (kill?: e8.Value) => magitModeQuitWindow(truthy(kill)));

/**
 * Buries or kills the current buffer, as magit-mode-bury-buffer: with
 * magit-bury-buffer-function, which kills it given KILL-BUFFER, a single
 * prefix argument; with two, kills every Magit buffer of the repository.
 */
export function magitModeBuryBufferFn(killBuffer: e8.Value = null): void {
  if (truthy(killBuffer) && killBuffer !== true && e8.prefixNumericValue(killBuffer as e8.PrefixArg) >= 16) {
    for (const b of magitModeGetBuffers(magitBufferInfo()?.dir ?? magitToplevel())) e8.call("kill-buffer", b);
    return;
  }
  const fn = (e8.variable("magit-bury-buffer-function") as string | ((kill: boolean) => void) | null) ?? "magit-mode-quit-window";
  const kill = truthy(killBuffer);
  if (typeof fn === "function") fn(kill);
  else if (fn === "magit-mode-quit-window") magitModeQuitWindow(kill);
  else if (fn === "magit-restore-window-configuration") magitRestoreWindowConfiguration(kill);
  else if (fn === "quit-window") quitWindow(kill);
  else e8.funcall(fn, kill);
}
export const magitModeBuryBuffer = e8.defineCommand({
  name: "magit-mode-bury-buffer",
  doc: "Bury or kill the current buffer.\n\nUse magit-bury-buffer-function to bury the buffer when called without a prefix argument or to kill it when called with a single prefix argument.\n\nWith two prefix arguments, always kill the current and all other Magit buffers, associated with this repository.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill: e8.Value) => magitModeBuryBufferFn(kill),
});

/** A placeholder that keymaps of sections remap to what deletes the thing at point, as magit-delete-thing. */
export const magitDeleteThing = e8.defineCommand({
  name: "magit-delete-thing",
  doc: "This is a placeholder command, which signals an error if called.\nWhere applicable, other keymaps remap this command to another, which actually deletes the thing at point.",
  run: () => e8.userError("There is no thing at point that could be deleted"),
});
