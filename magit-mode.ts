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
import { magitProfile, magitProfileResults, magitProfiling, magitRefreshCacheCounts, magitToplevel, magitToplevelOrError, magitWithRefreshCache, magitZapGitVersionCache } from "magit-git";

/** A window as the E8 running gives one: an object, or in E8 0.5.8 and before a number. */
export type Win = ReturnType<typeof e8.selectedWindow>;
/** A frame as the E8 running gives one. */
type Frm = ReturnType<typeof e8.selectedFrame>;
/** Whether a value is a window, an object or, in older E8s, its number. */
export const isWindow = (v: unknown): v is Win =>
  typeof v === "number" || ("windowp" in e8 && (e8 as unknown as { windowp: (x: unknown) => boolean }).windowp(v));

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
e8.defineVariable({
  name: "magit-buffer-name-format",
  doc: "The format string used to name Magit buffers.\n\nThe following %-sequences are supported:\n\n%m The name of the major-mode, but with the -mode suffix removed.\n\n%M Like \"%m\" but abbreviate magit-status-mode as magit.\n\n%v The value the buffer is locked to, in parentheses, or an empty string if the buffer is not locked to a value.\n\n%V Like \"%v\", but the string is prefixed with a space, unless it is an empty string.\n\n%t The top-level directory of the working tree of the repository, or if magit-uniquify-buffer-names is non-nil an abbreviation of that.\n\n%x If magit-uniquify-buffer-names is nil \"*\", otherwise the empty string.  Due to limitations of the uniquify package, buffer names must end with the path.\n\nThe value should always contain \"%m\" or \"%M\", \"%v\" or \"%V\", and \"%t\".  If magit-uniquify-buffer-names is non-nil, then the value must end with \"%t\" or \"%t%x\".  See issue #2841.\n\nThis is used by magit-generate-buffer-name-default-function.  If another magit-generate-buffer-name-function is used, then it may not respect this option, or on the contrary it may support additional %-sequences.",
  value: "%x%M%v: %t%x",
});
e8.defineVariable({
  name: "magit-generate-buffer-name-function",
  doc: "The function used to generate the name for a Magit buffer.\n\nIt is called with the major mode and the value the buffer is locked to, if any, in the repository's top directory, and gives the name.",
  value: "magit-generate-buffer-name-default-function",
});
e8.defineVariable({ name: "magit-uniquify-buffer-names", doc: "Whether to uniquify the names of Magit buffers.", value: true });
e8.defineVariable({
  name: "magit-section-disable-line-numbers",
  doc: "In Magit buffers, whether to disable modes that display line numbers.\n\nSome users who turn on global-display-line-numbers-mode (or global-nlinum-mode or global-linum-mode) expect line numbers to be displayed everywhere except in Magit buffers.  Other users do not expect Magit buffers to be treated differently.  At least in theory users in the first group should not use the global mode, but that ship has sailed, thus this option.",
  value: true,
});
e8.defineVariable({
  name: "magit-direct-use-buffer-arguments",
  doc: "Whether certain commands reuse arguments active in relevant buffer.\n\nThis affects certain commands such as magit-show-commit that are suffixes of the diff or log transient prefix commands, but only if they are invoked directly, i.e., *not* as a suffix.\n\nValid values are:\n\nalways: Always use the set of arguments that is currently active in the respective buffer, provided that buffer exists of course.\nselected: Use the set of arguments from the respective buffer, but only if it is displayed in a window of the current frame.  This is the default.\ncurrent: Use the set of arguments from the respective buffer, but only if it is the current buffer.\nnever: Never use the set of arguments from the respective buffer.\n\nFor more information see info node (magit)Transient Arguments and Buffer Variables.",
  value: "selected",
});
e8.defineVariable({
  name: "magit-prefix-use-buffer-arguments",
  doc: "Whether certain prefix commands reuse arguments active in relevant buffer.\n\nThis affects the transient prefix commands magit-diff, magit-log and magit-show-refs.\n\nValid values are:\n\nalways: Always use the set of arguments that is currently active in the respective buffer, provided that buffer exists of course.\nselected: Use the set of arguments from the respective buffer, but only if it is displayed in a window of the current frame.  This is the default.\ncurrent: Use the set of arguments from the respective buffer, but only if it is the current buffer.\nnever: Never use the set of arguments from the respective buffer.\n\nFor more information see info node (magit)Transient Arguments and Buffer Variables.",
  value: "selected",
});
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
e8.defineHook("magit-create-buffer-hook", "Normal hook run while creating a new magit-mode buffer.\nRuns before the buffer is populated with sections.  Also see magit-post-create-buffer-hook.");
e8.defineVariable({
  name: "magit-post-create-buffer-hook",
  doc: "Normal hook run after creating a new magit-mode buffer.\nRuns after the buffer is populated with sections for the first time.  Also see magit-create-buffer-hook (which runs earlier) and magit-refresh-buffer-hook (which runs on every refresh).",
  value: [],
});
e8.defineVariable({
  name: "magit-setup-buffer-hook",
  doc: "Hook run by magit-setup-buffer.\n\nThis is run right after displaying the buffer and right before generating or updating its content.  magit-mode-hook and other, more specific, magit-mode-*-hooks on the other hand are run right before displaying the buffer.  Usually one of these hooks should be used instead of this one.",
  value: ["magit-maybe-save-repository-buffers", "magit-set-buffer-margins"],
});

/**
 * Turns off the line numbers a global mode turned on in a Magit buffer,
 * as magit-section-mode does when magit-section-disable-line-numbers:
 * after the major mode's hooks, as E8's global modes turn on then.
 */
function magitSectionMaybeDisableLineNumbers(): void {
  if (!truthy(e8.variable("magit-section-disable-line-numbers"))) return;
  if (truthy(e8.variable("global-display-line-numbers-mode")) && truthy(e8.variable("display-line-numbers-mode"))) e8.callWithPrefix(-1, "display-line-numbers-mode");
}

// After the global mode's turn-on function, which after-change-major-mode-hook runs too.
e8.addHook("after-change-major-mode-hook", () => {
  if (e8.derivedModeP("magit-section-mode")) magitSectionMaybeDisableLineNumbers();
}, { append: true });

/**
 * Runs HOOK, a variable listing functions by name or as functions, and
 * those added with e8.addHook, as run-hooks does with a hook whose default
 * names functions.
 */
export function magitRunHooks(hook: string, ...args: e8.Value[]): void {
  const v = e8.variable(hook);
  for (const fn of Array.isArray(v) ? v : v !== null && v !== undefined && v !== false ? [v] : []) {
    if (typeof fn === "function") (fn as (...a: e8.Value[]) => void)(...args);
    else if (typeof fn === "string" && e8.fboundp(fn)) e8.funcall(fn, ...args);
  }
  e8.runHooks(hook, ...args);
}

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

/**
 * The name for a Magit buffer of MODE in the repository default-directory
 * is in, as magit-generate-buffer-name-default-function: from
 * magit-buffer-name-format, with the repository's directory name, or its
 * whole directory unless magit-uniquify-buffer-names, and VALUE, the
 * value the buffer is locked to, if any.
 */
export function magitGenerateBufferNameDefaultFunction(mode: string, value?: e8.Value): string {
  const m = mode.replace(/-mode$/, "");
  const v = value !== undefined && value !== null ? `(${(Array.isArray(value) ? value : [value]).map(String).join(" ")})` : undefined;
  const uniquify = truthy(e8.variable("magit-uniquify-buffer-names"));
  const dir = String(e8.variable("default-directory"));
  const n = uniquify ? magitRepoName(dir) : e8.abbreviateFileName(dir);
  const spec: { [c: string]: string } = { m, M: mode === "magit-status-mode" ? "magit" : m, v: v ?? "", V: v ? ` ${v}` : "", t: n, x: uniquify ? "" : "*", "%": "%" };
  return String(e8.variable("magit-buffer-name-format") ?? "%x%M%v: %t%x").replace(/%(.)/g, (all, c: string) => spec[c] ?? all);
}
e8.defun("magit-generate-buffer-name-default-function", (mode: string, value?: e8.Value) => magitGenerateBufferNameDefaultFunction(String(mode), value));

/**
 * The name of the Magit buffer of MODE for the repository in DIR: the
 * buffer's if there is one, else one made by
 * magit-generate-buffer-name-function, as magit-generate-new-buffer, with
 * its directory added in angle brackets when magit-uniquify-buffer-names
 * and another repository's buffer has that name, as uniquify's
 * post-forward-angle-brackets style does.
 */
export function magitBufferName(mode: string, dir = magitToplevelOrError(), value?: string[]): string {
  return magitGetModeBuffer(mode, dir, value) ?? magitGenerateBufferName(mode, dir, value);
}

/**
 * A new name for a Magit buffer of MODE for the repository in DIR, locked
 * to VALUE if given, from magit-generate-buffer-name-function, made
 * unique as magit-generate-new-buffer and magit-toggle-buffer-lock do.
 */
export function magitGenerateBufferName(mode: string, dir: string, value?: string[]): string {
  const fn = (e8.variable("magit-generate-buffer-name-function") as string | ((mode: string, value?: e8.Value) => string) | null) ?? "magit-generate-buffer-name-default-function";
  const v = value && value.length > 0 ? value : undefined;
  const name = e8.letBind({ "default-directory": dir }, () =>
    fn === "magit-generate-buffer-name-default-function" ? magitGenerateBufferNameDefaultFunction(mode, v) : String(typeof fn === "function" ? fn(mode, v) : v ? e8.funcall(fn, mode, v) : e8.funcall(fn, mode)),
  );
  if (!truthy(e8.variable("magit-uniquify-buffer-names"))) return name;
  return magitUniquifyBufferName(name, dir);
}

/**
 * NAME for the buffer of the repository in DIR, made unique among the
 * Magit buffers of other repositories named so, as
 * magit--maybe-uniquify-buffer-names has uniquify do: each gets as many
 * of its parent directories' names, in angle brackets, as tell them
 * apart, and the others are renamed to match.
 */
function magitUniquifyBufferName(name: string, dir: string): string {
  const base = (b: string): string => b.replace(/<[^<>]*>$/, "");
  const others = e8.bufferList().filter((b) => {
    const info = magitBufferInfo(b);
    return info !== undefined && info.dir !== dir && (b === name || base(b) === name);
  });
  if (others.length === 0) return name;
  // The parent directories of each repository, nearest first.
  const parents = (d: string): string[] => e8.directoryFileName(e8.fileNameDirectory(e8.directoryFileName(d)) ?? "/").split("/").filter((p) => p !== "").reverse();
  const dirs = [dir, ...others.map((b) => magitBufferInfo(b)!.dir)];
  const suffix = (d: string, k: number): string => parents(d).slice(0, k).reverse().join("/");
  let k = 1;
  const most = Math.max(...dirs.map((d) => parents(d).length));
  while (k < most && new Set(dirs.map((d) => suffix(d, k))).size < dirs.length) k++;
  for (const b of others) {
    const renamed = `${name}<${suffix(magitBufferInfo(b)!.dir, k)}>`;
    if (renamed !== b) e8.withCurrentBuffer(b, () => e8.call("rename-buffer", renamed));
  }
  return `${name}<${suffix(dir, k)}>`;
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
export function magitSetupBuffer(nameIn: string, mode: e8.DefinedCommand | string, kind: string, refresh: () => void, select = true, locals: { [variable: string]: e8.Value } = {}, locked = false): string {
  const dir = magitToplevelOrError();
  // A buffer LOCKED to what LOCALS show, as magit-setup-buffer-internal's LOCKED: its own, named for that value.
  let value: string[] | undefined;
  if (locked) {
    valueLocals = locals;
    try {
      value = magitBufferValue(String(mode));
    } finally {
      valueLocals = undefined;
    }
  }
  const name = value ? magitBufferName(String(mode), dir, value) : nameIn;
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
    if (value) {
      e8.makeLocalVariable("magit-buffer-locked-p");
      e8.setVariable("magit-buffer-locked-p", true);
    }
    magitXrefSetup(existed, { kind, refresh, dir, locals });
    buffers.set(e8.currentBuffer(), { kind, refresh, dir });
  });
  if (select) magitDisplayBuffer(name);
  e8.withCurrentBuffer(name, () => {
    magitRunHooks("magit-setup-buffer-hook");
    magitRefreshBuffer(!existed);
    if (!existed) magitRunHooks("magit-post-create-buffer-hook");
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
function bufferWindow(buffer: string): Win | undefined {
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
  if (!isWindow(window) || !e8.windowList().includes(window)) window = bufferWindow(buffer);
  if (!truthy(e8.variable("magit-display-buffer-noselect")) && isWindow(window)) e8.selectWindow(window);
  e8.withCurrentBuffer(buffer, () => e8.runHooks("magit-post-display-buffer-hook"));
}

// The ways of display-buffer the functions below ask for.

/** Shows BUFFER in the selected window, as display-buffer-same-window. */
function displayBufferSameWindow(buffer: string): Win {
  const selected = e8.selectedWindow();
  if (e8.windowBuffer(selected) !== buffer) e8.call("switch-to-buffer", buffer);
  return selected;
}
/** Shows BUFFER as display-buffer does by default, in a window it shows in, else one split off, else another. */
function displayBufferDefault(buffer: string): Win {
  e8.call("display-buffer", buffer);
  return bufferWindow(buffer)!;
}
/** Shows BUFFER as display-buffer does with inhibit-same-window: never in the selected window. */
export function magitDisplayBufferInhibitSameWindow(buffer: string): Win {
  const selected = e8.selectedWindow();
  const other = e8.windowList().find((w) => w !== selected && e8.windowBuffer(w) === buffer);
  if (other !== undefined) return other;
  e8.call("switch-to-buffer-other-window", buffer);
  const window = e8.selectedWindow();
  if (e8.windowList().includes(selected)) e8.selectWindow(selected);
  return window;
}
/** Shows BUFFER in a window that shows it, or the selected one, then deletes the frame's other windows, as magit--display-buffer-fullframe. */
function displayBufferFullframe(buffer: string): Win {
  const window = bufferWindow(buffer) ?? displayBufferSameWindow(buffer);
  for (const w of e8.windowList()) if (w !== window) e8.deleteWindow(w);
  return window;
}
/**
 * Shows BUFFER in a new window, then swaps it with the selected window's
 * buffer, so BUFFER is above or left of it, as magit--display-buffer-topleft;
 * a window already showing BUFFER is used as it is.
 */
function displayBufferTopleft(buffer: string): Win {
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
function windowColumns(): Map<Win, [number, number]> {
  const columns = new Map<Win, [number, number]>();
  const width = (t: e8.WindowTreeNode): number => (!Array.isArray(t) ? (e8.windowSize(t)?.totalWidth ?? 0) : t[0] ? width(t[2]) + width(t[3]) : width(t[2]));
  const walk = (t: e8.WindowTreeNode, left: number): void => {
    if (!Array.isArray(t)) columns.set(t, [left, width(t)]);
    else {
      walk(t[2], left);
      walk(t[3], t[0] ? left + width(t[2]) : left);
    }
  };
  walk(e8.windowTree(), 0);
  return columns;
}
/** Deletes the windows above and below WINDOW, those with its left and right edges, as delete-other-windows-vertically. */
function deleteOtherWindowsVertically(window: Win): void {
  const columns = windowColumns();
  const [left, width] = columns.get(window) ?? [0, 0];
  for (const [w, [l, wd]] of columns) if (w !== window && l === left && wd === width) e8.deleteWindow(w);
}
/** Shows BUFFER in a window that shows it, or the selected one, then makes that the column's only window, as magit--display-buffer-fullcolumn. */
function displayBufferFullcolumn(buffer: string): Win {
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
export function magitDisplayBufferTraditional(buffer: string): Win {
  const elsewhere = ["magit-process-mode", "magit-revision-mode", "magit-diff-mode", "magit-stash-mode", "magit-status-mode"].includes(modeOf(buffer));
  return e8.derivedModeP("magit-mode") && !elsewhere ? displayBufferSameWindow(buffer) : displayBufferDefault(buffer);
}
e8.defun("magit-display-buffer-traditional", magitDisplayBufferTraditional);

/**
 * Displays BUFFER in the selected window except for some modes, as
 * magit-display-buffer-same-window-except-diff-v1: a buffer whose mode
 * derives from magit-diff-mode or magit-process-mode goes in another window.
 */
export function magitDisplayBufferSameWindowExceptDiffV1(buffer: string): Win {
  return derivedIn(buffer, "magit-diff-mode", "magit-process-mode") ? magitDisplayBufferInhibitSameWindow(buffer) : displayBufferSameWindow(buffer);
}
e8.defun("magit-display-buffer-same-window-except-diff-v1", magitDisplayBufferSameWindowExceptDiffV1);

/** Displays BUFFER, filling the entire frame if it is a status buffer, else as magit-display-buffer-traditional, as magit-display-buffer-fullframe-status-v1. */
export function magitDisplayBufferFullframeStatusV1(buffer: string): Win {
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
export function magitDisplayBufferFullframeStatusTopleftV1(buffer: string): Win {
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
export function magitDisplayBufferFullcolumnMostV1(buffer: string): Win {
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
const previousWindowConfigurations = new PerBuffer<[Frm, e8.WindowConfiguration]>();

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
  e8.letBind({ "inhibit-read-only": true, "magit--refresh-start-time": Date.now() / 1000 }, () => magitWithRefreshCache(entry.refresh));
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

/**
 * The Magit buffer of MODE for the repository in DIR, if there is one, as
 * magit-get-mode-buffer: the one not locked to its value, or with VALUE
 * the one locked to that value.
 */
export function magitGetModeBuffer(mode: string, dir = magitToplevel(), value?: string[]): string | undefined {
  return e8.bufferList().find((b) => {
    const info = magitBufferInfo(b);
    if (info === undefined || info.dir !== dir) return false;
    return e8.withCurrentBuffer(b, () => {
      if (String(e8.variable("major-mode")) !== mode) return false;
      const locked = truthy(e8.variable("magit-buffer-locked-p"));
      return value ? locked && JSON.stringify(magitBufferValue()) === JSON.stringify(value) : !locked;
    });
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

/** Saves the repository's file buffers, if magit-save-repository-buffers says to, as magit-maybe-save-repository-buffers. */
e8.defun("magit-maybe-save-repository-buffers", () => magitSaveRepositoryBuffers());

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

// Locking a buffer to its value, after magit-mode.el's magit-toggle-buffer-lock.

e8.defineVariable({ name: "magit-buffer-locked-p", doc: "Whether the current buffer is locked to its value, as magit-toggle-buffer-lock locks it.", value: false, local: true });

/** The locals a buffer is being set up with, which the value it is locked to is worked out from before it has them. */
let valueLocals: { [variable: string]: e8.Value } | undefined;
const valueOf = (name: string): e8.Value => (valueLocals && name in valueLocals ? valueLocals[name] : (e8.variable(name) ?? null));

/** A list variable's value as strings. */
const strings = (name: string): string[] => {
  const v = valueOf(name);
  return Array.isArray(v) ? v.map(String) : v === null || v === undefined || v === false ? [] : [String(v)];
};
const stringOr = (name: string): string | undefined => {
  const v = valueOf(name);
  return typeof v === "string" ? v : undefined;
};

/**
 * What the current buffer shows, which it can be locked to, as
 * magit-buffer-value: undefined for a buffer that cannot be locked, as a
 * status buffer.
 */
export function magitBufferValue(modeIn?: string): string[] | undefined {
  const mode = modeIn ?? String(e8.variable("major-mode"));
  const files = strings("magit-buffer-diff-files");
  switch (mode) {
    case "magit-diff-mode": {
      const range = stringOr("magit-buffer-range");
      const typearg = stringOr("magit-buffer-typearg");
      const head = range ? [range, ...(typearg ? [typearg] : [])] : typearg === "--cached" ? ["staged"] : ["unstaged", ...(typearg ? [typearg] : [])];
      return [...head, ...(files.length > 0 ? ["--", ...files] : [])];
    }
    case "magit-revision-mode":
      return [stringOr("magit-buffer-revision") ?? "", ...files];
    case "magit-stash-mode":
      return [stringOr("magit-buffer-revision") ?? ""];
    case "magit-log-mode": {
      const revs = strings("magit-buffer-revisions");
      const logFiles = strings("magit-buffer-log-files");
      return [...revs, ...(revs.length > 0 && logFiles.length > 0 ? ["--", ...logFiles] : logFiles)];
    }
    case "magit-log-select-mode":
      return strings("magit-buffer-revisions");
    case "magit-cherry-mode":
      return stringOr("magit-buffer-range") ? [stringOr("magit-buffer-range")!] : [stringOr("magit-buffer-refname") ?? "", stringOr("magit-buffer-upstream") ?? ""].filter((x) => x !== "");
    case "magit-reflog-mode":
      return stringOr("magit-buffer-refname") ? [stringOr("magit-buffer-refname")!] : undefined;
    default:
      return undefined;
  }
}

/** Renames the current buffer to a name for MODE and VALUE not taken yet. */
function renameForLock(mode: string, value?: string[]): void {
  const dir = magitBufferInfo()?.dir ?? magitToplevelOrError();
  e8.call("rename-buffer", e8.generateNewBufferName(magitGenerateBufferName(mode, dir, value)));
}

export const magitToggleBufferLock = e8.defineCommand({
  name: "magit-toggle-buffer-lock",
  doc:
    "Lock the current buffer to its value or unlock it.\n\n" +
    "Locking a buffer to its value prevents it from being reused to display another value.  The name of a locked buffer contains its value, which allows telling it apart from other locked buffers and the unlocked buffer.\n\n" +
    "Not all Magit buffers can be locked to their values, for example it wouldn't make sense to lock a status buffer.\n\n" +
    "There can only be a single unlocked buffer using a certain major-mode per repository.  So when a buffer is being unlocked and another unlocked buffer already exists for that mode and repository, then the former buffer is instead deleted and the latter is displayed in its place.",
  run: () => {
    const mode = String(e8.variable("major-mode"));
    const dir = magitBufferInfo()?.dir;
    if (truthy(e8.variable("magit-buffer-locked-p"))) {
      const unlocked = magitGetModeBuffer(mode, dir);
      if (unlocked) {
        const locked = e8.bufferName();
        e8.call("switch-to-buffer", unlocked);
        e8.call("kill-buffer", locked);
      } else {
        e8.setVariable("magit-buffer-locked-p", false);
        renameForLock(mode);
      }
      return;
    }
    const value = magitBufferValue();
    if (!value) return e8.userError("Buffer has no value it could be locked to");
    const locked = magitGetModeBuffer(mode, dir, value);
    if (locked) {
      const unlocked = e8.bufferName();
      e8.call("switch-to-buffer", locked);
      e8.call("kill-buffer", unlocked);
    } else {
      e8.setVariable("magit-buffer-locked-p", true);
      renameForLock(mode, value);
    }
  },
});

// Buffer history, after magit-mode.el's magit-xref-setup and help's xref stacks.

e8.defineVariable({ name: "magit-xref-modes", doc: "List of modes for which to insert navigation buttons.", value: ["magit-log-mode", "magit-reflog-mode", "magit-diff-mode", "magit-revision-mode"] });

/** What a buffer of the history showed: enough to show it again. */
interface XrefItem {
  kind: string;
  refresh: () => void;
  dir: string;
  locals: { [variable: string]: e8.Value };
}
/** Each buffer's history, as help-xref-stack-item, help-xref-stack and help-xref-forward-stack. */
const xrefs = new PerBuffer<{ item?: XrefItem; back: [number, XrefItem][]; forward: [number, XrefItem][] }>();

/**
 * Records what the current buffer shows now, ITEM, as magit-xref-setup:
 * in a buffer of a mode in magit-xref-modes that EXISTED and showed
 * something, that goes on its history, for magit-go-backward.
 */
function magitXrefSetup(existed: boolean, item: XrefItem): void {
  const modes = strings("magit-xref-modes");
  if (!modes.includes(String(e8.variable("major-mode")))) return;
  const x = (existed && xrefs.get(e8.currentBuffer())) || { back: [], forward: [] };
  if (x.item) {
    x.back.unshift([e8.point(), x.item]);
    x.forward = [];
  }
  x.back.splice(30);
  x.item = item;
  xrefs.set(e8.currentBuffer(), x);
}

/** Whether the current buffer has entries to go back or forward to, for magit-insert-xref-buttons. */
export function magitXrefStacks(): { back: boolean; forward: boolean } {
  const x = xrefs.get(e8.currentBuffer());
  return { back: (x?.back.length ?? 0) > 0, forward: (x?.forward.length ?? 0) > 0 };
}

/** Shows ITEM again in the current buffer, with point at POINT, as magit-xref-restore. */
function xrefRestore(point: number, item: XrefItem): void {
  e8.setVariable("default-directory", item.dir);
  for (const [variable, value] of Object.entries(item.locals)) {
    e8.makeLocalVariable(variable);
    e8.setVariable(variable, value);
  }
  buffers.set(e8.currentBuffer(), { kind: item.kind, refresh: item.refresh, dir: item.dir });
  magitRefreshBuffer();
  e8.gotoChar(Math.max(e8.pointMin(), Math.min(point, e8.pointMax())));
}

/** Goes back in the current buffer's history, as help-xref-go-back. */
export function magitGoBackward(): void {
  const x = xrefs.get(e8.currentBuffer());
  if (!x || x.back.length === 0) return e8.userError("No previous entry in buffer's history");
  const [point, item] = x.back.shift()!;
  if (x.item) x.forward.unshift([e8.point(), x.item]);
  x.item = item;
  xrefRestore(point, item);
}

/** Goes forward in the current buffer's history, as help-xref-go-forward. */
export function magitGoForward(): void {
  const x = xrefs.get(e8.currentBuffer());
  if (!x || x.forward.length === 0) return e8.userError("No next entry in buffer's history");
  const [point, item] = x.forward.shift()!;
  if (x.item) x.back.unshift([e8.point(), x.item]);
  x.item = item;
  xrefRestore(point, item);
}

export const magitGoBackwardCommand = e8.defineCommand({ name: "magit-go-backward", doc: "Move backward in current buffer's history.", run: () => magitGoBackward() });
export const magitGoForwardCommand = e8.defineCommand({ name: "magit-go-forward", doc: "Move forward in current buffer's history.", run: () => magitGoForward() });

// Commands acting on the thing at point, which section keymaps remap.

/** The URL at point, as (thing-at-point 'url). */
function urlAtPoint(): string | undefined {
  const start = e8.lineBeginningPosition();
  const line = e8.bufferSubstringNoProperties(start, e8.lineEndPosition());
  const column = e8.point() - start;
  const re = /\b(?:(?:https?|ftp|file|mailto|ssh|git):(?:\/\/)?|www\.)[^\s<>"'()]+/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index <= column && column <= m.index + m[0].length) return m[0].replace(/[.,;:]+$/, "");
  }
  return undefined;
}

/** Opens URL in a browser, as browse-url. */
export function magitBrowseUrl(url: string): void {
  if (e8.fboundp("browse-url")) return void e8.funcall("browse-url", url);
  if (!truthy(e8.variable("noninteractive"))) {
    const opener = e8.callProcess(["uname", "-s"]).output.trim() === "Darwin" ? "open" : "xdg-open";
    e8.makeProcess({ name: "browse-url", command: [opener, url] });
  }
  e8.message(`Browsing ${url}`);
}

export const magitBrowseThing = e8.defineCommand({
  name: "magit-browse-thing",
  doc: "This is a placeholder command, which may signal an error if called.\nWhere applicable, other keymaps remap this command to another, which actually visits thing at point using browse-url.",
  run: () => {
    const url = urlAtPoint();
    if (url) magitBrowseUrl(url);
    else e8.userError("There is no thing at point that could be browsed");
  },
});
export const magitEditThing = e8.defineCommand({
  name: "magit-edit-thing",
  doc: "This is a placeholder command, which may signal an error if called.\nWhere applicable, other keymaps remap this command to another, which actually lets you edit the thing at point, likely in another buffer.",
  run: () => e8.userError("There is no thing at point that could be edited"),
});
export const magitCopyThing = e8.defineCommand({
  name: "magit-copy-thing",
  doc: "This is a placeholder command, which signals an error if called.\nWhere applicable, other keymaps remap this command to another, which actually copies some representation of the thing at point to the kill ring.",
  run: () => e8.userError("There is no thing at point that we know how to copy"),
});

// Refreshing, saving and caches.

export const magitRefreshBufferCommand = e8.defineCommand({
  name: "magit-refresh-buffer",
  doc: "Refresh the current Magit buffer.\nThe arguments are for internal use.",
  run: () => magitRefreshBuffer(),
});

/**
 * Saves the file-visiting buffers of the current repository, as
 * magit-save-repository-buffers: asking about each modified one, unless
 * ARG, or the buffer's buffer-save-without-query, says to save it without
 * asking.
 */
export function magitSaveRepositoryBuffersInteractively(arg = false): void {
  const top = magitToplevel();
  if (!top) return;
  for (const b of e8.bufferList()) {
    e8.withCurrentBuffer(b, () => {
      const f = e8.bufferFileName();
      if (!f || !e8.bufferModified() || !e8.expandFileName(f).startsWith(top)) return;
      if (arg || truthy(e8.variable("buffer-save-without-query")) || e8.yOrNP(`Save file ${f}? `)) e8.call("save-buffer");
    });
  }
}
export const magitSaveRepositoryBuffersCommand = e8.defineCommand({
  name: "magit-save-repository-buffers",
  doc: "Save file-visiting buffers belonging to the current repository.\nAfter any buffer where buffer-save-without-query is non-nil is saved without asking, the user is asked about each modified buffer, which visits a file in the current repository.  Optional argument (the prefix) non-nil means save all with no questions.",
  params: [{ name: "arg", kind: "prefix" }],
  run: (arg: e8.Value) => magitSaveRepositoryBuffersInteractively(truthy(arg)),
});

/**
 * Zaps the caches for the current repository, as magit-zap-caches: the
 * git version's, and each of its buffers' history; with ALL, every
 * repository's.
 */
export function magitZapCaches(all = false): void {
  magitZapGitVersionCache();
  const targets = all ? e8.bufferList().filter((b) => magitBufferInfo(b) !== undefined) : magitModeGetBuffers();
  for (const b of targets) {
    const x = xrefs.get(b);
    if (x) x.back = x.forward = [];
  }
}
export const magitZapCachesCommand = e8.defineCommand({
  name: "magit-zap-caches",
  doc:
    "Zap caches for the current repository.\n\n" +
    "Remove the repository's entry from magit-repository-local-cache, remove the host's entry from magit--host-git-version-cache, and set magit-section-visibility-cache to nil for all Magit buffers of the repository.\n\n" +
    "With a prefix argument or if optional ALL is non-nil, discard the mentioned caches completely.",
  params: [{ name: "all", kind: "prefix" }],
  run: (all: e8.Value) => magitZapCaches(truthy(all)),
});

// Profiling, which in E8 times the git Magit runs, as elp times Magit's functions.

/** Shows the profile so far in a buffer, as elp-results. */
function profileResults(): void {
  const rows = magitProfileResults();
  const width = Math.max(13, ...rows.map((r) => r.name.length));
  const lines = [`${"Function Name".padEnd(width)}  Call Count  Elapsed Time  Average Time`, `${"=".repeat(width)}  ==========  ============  ============`];
  for (const r of rows) lines.push(`${r.name.padEnd(width)}  ${String(r.count).padEnd(10)}  ${(r.time / 1000).toFixed(6).padEnd(12)}  ${(r.time / 1000 / r.count).toFixed(6)}`);
  const buffer = "*ELP Profiling Results*";
  e8.getBufferCreate(buffer);
  e8.withCurrentBuffer(buffer, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insert(`${lines.join("\n")}\n`);
    e8.gotoChar(e8.pointMin());
  });
  e8.call("display-buffer", buffer);
}

export const magitToggleProfiling = e8.defineCommand({
  name: "magit-toggle-profiling",
  doc: "Start profiling Magit, or if in progress, stop and display the results.",
  run: () => {
    if (magitProfiling()) {
      e8.message("Stop profiling and display results...");
      profileResults();
      magitProfile(false);
    } else {
      e8.message("Start profiling Magit and Forge...");
      magitProfile(true);
    }
  },
});

export const magitProfileRefreshBuffer = e8.defineCommand({
  name: "magit-profile-refresh-buffer",
  doc: "Profile refreshing the current Magit buffer.",
  run: () => {
    magitProfile(true);
    e8.message("Profiling Magit and Forge...");
    try {
      magitRefreshBuffer();
    } finally {
      e8.message("Profiling Magit and Forge...done");
      profileResults();
      magitProfile(false);
    }
  },
});
