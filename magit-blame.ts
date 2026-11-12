// SPDX-License-Identifier: GPL-3.0-or-later
//
// Blame support, after magit-blame.el: each line of a file-visiting or
// blob buffer annotated with the commit that last changed it, or the one
// that removed it, as chunks of overlays: a heading above each, a
// highlighted first line, or the left margin, as magit-blame-styles
// says; the blame menu (B), moving between chunks, showing their
// commits, and blaming the revision before a chunk's. Also
// magit-edit-line-commit and magit-diff-edit-hunk-commit from
// magit-extras.el, which need the chunks.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { transientArgs, transientDefinePrefix } from "transient";
import { truthy } from "subr";
import {
  magitAbbrevLength,
  magitBlameAtPoint,
  magitFileRelativeName,
  magitFileTrackedP,
  magitGitExecutable,
  magitGitRun,
  magitProcessGitArguments,
  magitRevAncestorP,
  magitRevBranch,
  magitRevFormat,
  magitToplevel,
  magitToplevelOrError,
  type GitArg,
} from "magit-git";
import { magitGetModeBuffer } from "magit-mode";
import { magitDiffArguments, magitShowCommitRev } from "magit-diff";
import { magitFindFileNoselect } from "magit-files";
import { magitRunGit, type Proc } from "magit-process";
import { magitRebaseEditCommitRev } from "magit-sequence";
import { magitFormatTimeString } from "magit-base";

// Options

/** A style, as an entry of magit-blame-styles: (IDENT (KEY . VALUE)...), as [IDENT, [KEY, VALUE]...]. */
type Style = [string, ...[string, e8.Value][]];

e8.defineVariable({
  name: "magit-blame-styles",
  doc:
    "List of styles used to visualize blame information.\n\nThe style used in the current buffer can be cycled from the blame\npopup.  Blame commands (except `magit-blame-echo') use the first\nstyle as the initial style when beginning to blame in a buffer.\n\nEach entry has the form (IDENT (KEY . VALUE)...), here [IDENT, [KEY, VALUE]...].  The KEYs\nrecognized are show-lines, show-message, highlight-face, heading-format,\nmargin-format, margin-width, margin-face and margin-body-face.\n\nThe following %-specs can be used in `heading-format' and\n`margin-format':\n\n  %H    hash              using face `magit-blame-hash'\n  %h    truncated hash    using face `magit-blame-hash'\n  %s    summary           using face `magit-blame-summary'\n  %a    author            using face `magit-blame-name'\n  %A    author time       using face `magit-blame-date'\n  %c    committer         using face `magit-blame-name'\n  %C    committer time    using face `magit-blame-date'\n\nAdditionally if `margin-format' ends with %f, then the string\nthat is displayed in the margin is made at least `margin-width'\ncharacters wide.  A margin style, which used to be part of the default:\n\n  [\"margin\", [\"margin-format\", [\" %s%f\", \" %C %a\", \" %H\"]], [\"margin-width\", 42],\n   [\"margin-face\", \"magit-blame-margin\"], [\"margin-body-face\", [\"magit-blame-dimmed\"]]]",
  value: [
    ["headings", ["heading-format", "%-20a %C %s\n"]],
    ["highlight", ["highlight-face", "magit-blame-highlight"]],
    ["lines", ["show-lines", true], ["show-message", true]],
  ],
});
e8.defineVariable({ name: "magit-blame-echo-style", doc: "The blame visualization style used by `magit-blame-echo'.\nA symbol that has to be used as the identifier for one of the\nstyles defined in `magit-blame-styles'.", value: "lines" });
e8.defineVariable({ name: "magit-blame-time-format", doc: "Format for time strings in blame headings.", value: "%F %H:%M" });
e8.defineVariable({ name: "magit-blame-read-only", doc: "Whether to initially make the blamed buffer read-only.", value: true });
e8.defineVariable({
  name: "magit-blame-disable-modes",
  doc: "List of modes not compatible with Magit-Blame mode.\nThis modes are turned off when Magit-Blame mode is turned on,\nand then turned on again when turning off the latter.",
  value: ["fci-mode", "yascroll-bar-mode"],
});
e8.defineVariable({ name: "magit-blame-mode-lighter", doc: "The mode-line lighter of the Magit-Blame mode.", value: " Blame" });
e8.defineVariable({ name: "magit-update-other-window-delay", doc: "Delay before automatically updating the other window.", value: 0.2 });
e8.defineHook("magit-blame-goto-chunk-hook", "Hook run after point entered another chunk.");
e8.setVariable("magit-blame-goto-chunk-hook", ["magit-blame-maybe-update-revision-buffer", "magit-blame-maybe-show-message"]);

// Faces

e8.defineFace({ name: "magit-blame-highlight", doc: "Face used for highlighting when blaming.\nAlso see option `magit-blame-styles'.", attributes: { extend: true }, light: { background: "grey80", foreground: "black" }, dark: { background: "grey25", foreground: "white" } });
e8.defineFace({ name: "magit-blame-margin", doc: "Face used for the blame margin by default when blaming.\nAlso see option `magit-blame-styles'.", attributes: { inherit: "magit-blame-highlight", weight: "normal", slant: "normal" } });
e8.defineFace({ name: "magit-blame-dimmed", doc: "Face used for the blame margin in some cases when blaming.\nAlso see option `magit-blame-styles'.", attributes: { inherit: "magit-dimmed", weight: "normal", slant: "normal" } });
e8.defineFace({ name: "magit-blame-heading", doc: "Face used for blame headings by default when blaming.\nAlso see option `magit-blame-styles'.", attributes: { extend: true, inherit: "magit-blame-highlight", weight: "normal", slant: "normal" } });
e8.defineFace({ name: "magit-blame-summary", doc: "Face used for commit summaries when blaming." });
e8.defineFace({ name: "magit-blame-hash", doc: "Face used for commit hashes when blaming." });
e8.defineFace({ name: "magit-blame-name", doc: "Face used for author and committer names when blaming." });
e8.defineFace({ name: "magit-blame-date", doc: "Face used for dates when blaming." });

// Variables, each buffer's own.

for (const [name, doc] of [
  ["magit-blame-buffer-read-only", "Whether the buffer was read-only before blaming."],
  ["magit-blame-disabled-modes", "The modes blaming turned off, to turn on again after."],
  ["magit-blame-process", "The git blame process running for the buffer."],
  ["magit-blame-recursive-p", "Whether the buffer was made by blaming recursively."],
  ["magit-blame-type", "What is blamed: addition, removal or final."],
  ["magit-blame-separator", "What the lines style shows above each chunk."],
  ["magit-blame--make-margin-overlays", "Whether some style uses the margin, so margin overlays are made."],
  ["magit-blame--style", "The style the buffer is shown in."],
  ["magit-blame--previous-margin-width", "The left margin's width before blaming."],
  ["magit-blame--abbrev-length", "How long the %h hashes are."],
] as const)
  e8.defineVariable({ name, doc, value: null });

/** Sets VARIABLE in the current buffer only, as setq-local. */
const setLocal = (variable: string, value: e8.Value | undefined): void => {
  e8.makeLocalVariable(variable);
  e8.setVariable(variable, value ?? null);
};
const local = (variable: string): e8.Value | undefined => e8.variable(variable) ?? undefined;
const blameMode = (): boolean => e8.variable("magit-blame-mode") === true;
const blameType = (): string | undefined => (local("magit-blame-type") as string | null) ?? undefined;

// Chunks

/** A chunk of lines git blamed on one commit, as the class magit-blame-chunk. */
export interface MagitBlameChunk {
  id: number;
  origRev: string;
  origLine: number;
  finalLine: number;
  numLines: number;
  prevRev?: string;
  prevFile?: string;
  origFile?: string;
}
/** What git says of a commit, summary, author, author-time and the rest, and the strings made from it by format and face. */
interface Revinfo {
  fields: Map<string, string>;
  formats: Map<string, e8.PropertizedString | undefined>;
}

let nextChunkId = 1;
/** The chunks the overlays' magit-blame-chunk properties name, by id, and their commits' revinfo. */
const chunks = new Map<number, MagitBlameChunk>();
const revinfos = new Map<number, Revinfo>();
/** Each buffer's commits' revinfo, as magit-blame-cache. */
const caches = new Map<string, Map<string, Revinfo>>();
/** The chunk the point was last in, by buffer, as magit-blame-previous-chunk. */
const previousChunks = new Map<string, number>();

const isZeroRev = (rev: string): boolean => /^0{40,}$/.test(rev);

/** The chunk at point, as magit-current-blame-chunk: with TYPE, if the buffer is not blamed so, asks git for the line's. */
export function magitCurrentBlameChunk(type?: string, noerror = false): MagitBlameChunk | undefined {
  if (!(type && type !== blameType())) {
    const chunk = magitBlameChunkAt(e8.point());
    if (chunk) return chunk;
  }
  if (!type) return undefined;
  const rev = ((local("magit-buffer-refname") ?? local("magit-buffer-revision")) as string | null) ?? undefined;
  const file = String(local("major-mode")) === "dired-mode" ? undefined : blameFileRelativeName();
  const line = `${e8.lineOf(e8.point()) + 1},+1`;
  if (!file) {
    if (!noerror) e8.signal("error", "Buffer does not visit a tracked file");
    return undefined;
  }
  const btype = blameType();
  const out = magitGitRun(["blame", "--porcelain", btype === "final" || btype === "removal" ? ["--reverse", ...magitBlameArguments()] : magitBlameArguments(), "-L", line, rev, "--", file], { dir: magitToplevelOrError() });
  if (out.exit !== 0 || out.output === "") {
    if (!noerror) e8.signal("error", "Cannot get blame chunk at eob");
    return undefined;
  }
  const lines = out.output.split("\n");
  return parseChunk(lines, { i: 0 }, type)[0];
}

/** The chunk an overlay at POS belongs to, as magit-blame-chunk-at. */
export function magitBlameChunkAt(pos: number): MagitBlameChunk | undefined {
  if (pos < e8.pointMin() && pos < 0) return undefined;
  for (const ov of e8.overlaysAt(pos)) {
    const id = e8.overlayGet(ov, "magit-blame-chunk");
    if (typeof id === "number") return chunks.get(id);
  }
  return undefined;
}

/** The blame overlay at POS with KEY, as magit-blame--overlay-at. */
function overlayAt(pos = e8.point(), key = "magit-blame-chunk"): number | undefined {
  return [...e8.overlaysAt(pos), ...e8.overlaysIn(pos, pos)].find((ov) => truthy(e8.overlayGet(ov, key)));
}

magitBlameAtPoint.rev = () => magitCurrentBlameChunk()?.origRev;

// Modes

/** Blames the buffer again, as magit-blame--refresh. */
const blameRefresh = (): void => blameRun(magitBlameArguments());
/** Runs magit-blame-goto-chunk-hook when point moved into another chunk, as magit-blame-goto-chunk-hook the function. */
function gotoChunkHook(): void {
  const chunk = magitBlameChunkAt(e8.point());
  if (chunk) {
    const buf = e8.bufferName();
    if (previousChunks.get(buf) !== chunk.id) e8.runHooks("magit-blame-goto-chunk-hook");
    previousChunks.set(buf, chunk.id);
  }
}
/** Turns magit-blame-read-only-mode on or off with read-only-mode, as magit-blame-toggle-read-only. */
const toggleReadOnly = (): void => e8.callWithPrefix(e8.bufferReadOnly() ? 1 : -1, magitBlameReadOnlyMode);
const removeOverlaysHook = (): void => magitBlameRemoveOverlays();

export const magitBlameMode = e8.defineMinorMode({
  name: "magit-blame-mode",
  doc: "Display blame information inline.",
  lighter: String(e8.variable("magit-blame-mode-lighter") ?? " Blame"),
  bindings: { "C-c C-q": "magit-blame-quit" as e8.CommandName },
  onChange: (on) => {
    if (on) {
      e8.addHook("after-save-hook", blameRefresh, { local: true, append: true });
      e8.addHook("post-command-hook", gotoChunkHook, { local: true, append: true });
      e8.addHook("before-revert-hook", removeOverlaysHook, { local: true, append: true });
      e8.addHook("after-revert-hook", blameRefresh, { local: true, append: true });
      setLocal("magit-blame-buffer-read-only", e8.bufferReadOnly());
      if (truthy(e8.variable("magit-blame-read-only")) || truthy(local("magit-buffer-file-name"))) {
        e8.setReadOnly(true);
        toggleReadOnly();
      }
      const disabled: string[] = [];
      for (const mode of (e8.variable("magit-blame-disable-modes") as string[] | null) ?? []) {
        if (e8.variable(mode) === true && e8.fboundp(mode)) {
          e8.callWithPrefix(-1, mode as e8.CommandName);
          disabled.unshift(mode);
        }
      }
      setLocal("magit-blame-disabled-modes", disabled);
      setLocal("magit-blame-separator", formatSeparator());
      if (!local("magit-blame--style")) setLocal("magit-blame--style", styles()[0] as unknown as e8.Value);
      setLocal("magit-blame--make-margin-overlays", styles().some((s) => s.slice(1).some((kv) => (kv as [string, e8.Value])[0] === "margin-format")));
      updateMargin("enable");
    } else {
      const process = local("magit-blame-process") as Proc | null | undefined;
      if (process !== null && process !== undefined && e8.processLiveP(process)) {
        // Magit waits for the sentinel; here it is told the process is gone.
        killed.add(process);
        e8.deleteProcess(process);
      }
      setLocal("magit-blame-process", null);
      e8.removeHook("after-save-hook", blameRefresh, { local: true });
      e8.removeHook("post-command-hook", gotoChunkHook, { local: true });
      e8.removeHook("before-revert-hook", removeOverlaysHook, { local: true });
      e8.removeHook("after-revert-hook", blameRefresh, { local: true });
      if (!truthy(local("magit-blame-buffer-read-only"))) e8.setReadOnly(false);
      if (e8.variable("magit-blame-read-only-mode") === true) e8.callWithPrefix(-1, magitBlameReadOnlyMode);
      for (const mode of (local("magit-blame-disabled-modes") as string[] | null) ?? []) e8.call(mode as e8.CommandName);
      e8.killLocalVariable("magit-blame-disabled-modes");
      e8.killLocalVariable("magit-blame-type");
      e8.killLocalVariable("magit-blame--style");
      updateMargin("disable");
      magitBlameRemoveOverlays();
    }
  },
});

/** The keys blaming has while the buffer is read-only, as magit-blame-read-only-mode-map. */
export const magitBlameReadOnlyMode = e8.defineMinorMode({
  name: "magit-blame-read-only-mode",
  doc: "Provide keybindings for Magit-Blame mode.\n\nThis minor-mode provides the key bindings for Magit-Blame mode,\nbut only when Read-Only mode is also enabled because these key\nbindings would otherwise conflict badly with regular bindings.\n\nWhen both Magit-Blame mode and Read-Only mode are enabled, then\nthis mode gets automatically enabled too and when one of these\nmodes is toggled, then this mode also gets toggled automatically.",
  bindings: {
    RET: "magit-show-commit" as e8.CommandName,
    p: "magit-blame-previous-chunk" as e8.CommandName,
    P: "magit-blame-previous-chunk-same-commit" as e8.CommandName,
    n: "magit-blame-next-chunk" as e8.CommandName,
    N: "magit-blame-next-chunk-same-commit" as e8.CommandName,
    b: "magit-blame-addition" as e8.CommandName,
    r: "magit-blame-removal" as e8.CommandName,
    f: "magit-blame-reverse" as e8.CommandName,
    B: "magit-blame" as e8.CommandName,
    c: "magit-blame-cycle-style" as e8.CommandName,
    q: "magit-blame-quit" as e8.CommandName,
    "M-w": "magit-blame-copy-hash" as e8.CommandName,
    SPC: "magit-diff-show-or-scroll-up" as e8.CommandName,
    "S-SPC": "magit-diff-show-or-scroll-down" as e8.CommandName,
    DEL: "magit-diff-show-or-scroll-down" as e8.CommandName,
  },
});

// read-only-mode has no hook in E8: toggling it while blaming toggles the
// keys, as Magit's read-only-mode-hook does.
e8.adviceAdd("read-only-mode", "after", () => {
  if (blameMode()) toggleReadOnly();
}, { name: "magit-blame-toggle-read-only" });

// Process

/** Each running blame's state: the buffer it blames, what it parsed and its output so far. */
interface BlameProcess {
  commandBuf: string;
  output: string;
  parsed: number;
  arguments: [string | undefined, string, string[]];
}
const processes = new Map<Proc, BlameProcess>();
/** Processes the mode killed, whose sentinels say nothing. */
const killed = new Set<Proc>();

/** Blames the buffer with ARGS, the lines shown first, then the whole of it, as magit-blame--run. */
function blameRun(args: string[]): void {
  e8.letBind({ "default-directory": magitToplevelOrError() }, () => {
    if (!blameMode()) e8.call(magitBlameMode);
    e8.message("Blaming...");
    const r = (local("magit-buffer-refname") ?? local("magit-buffer-revision")) as string | null;
    const rev = r && r !== "{index}" ? r : undefined;
    const type = blameType();
    const all = type === "final" || type === "removal" ? ["--reverse", ...args] : args;
    const first = e8.lineOf(e8.windowStart()) + 1;
    const last = e8.lineOf(Math.max(e8.windowStart(), e8.windowEnd() - 1)) + 1;
    // Batch and fresh windows have no lines shown yet: then all at once.
    const quick = e8.windowEnd() > e8.windowStart();
    const process = magitBlameRunProcess(rev, blameFileRelativeName()!, all, quick ? [first, last] : undefined);
    if (quick) quickstart.add(process);
  });
}
const quickstart = new Set<Proc>();

/** Starts git blame --incremental on FILE at REV with ARGS, for LINES only if given, as magit-blame-run-process. */
export function magitBlameRunProcess(rev: string | undefined, file: string, args: string[], lines?: [number, number]): Proc {
  const commandBuf = e8.bufferName();
  const gitArgs: GitArg[] = ["blame", "--incremental", args, lines && ["-L", `${lines[0]},${lines[1]}`], rev, "--", file];
  const state: BlameProcess = { commandBuf, output: "", parsed: 0, arguments: [rev, file, args] };
  const process = e8.makeProcess({
    name: "git",
    command: [magitGitExecutable(), ...magitProcessGitArguments(gitArgs)],
    directory: magitToplevel() ?? String(e8.variable("default-directory")),
    connectionType: "pipe",
    stderr: false,
    filter: (p, output) => processFilter(p, output),
    sentinel: (p, event) => processSentinel(p, event),
  });
  processes.set(process, state);
  caches.set(commandBuf, new Map());
  setLocal("magit-blame-process", process);
  return process;
}

/** The process's status from its sentinel's EVENT: exit with its code, or signal. */
const exitOf = (event: string): ["exit" | "signal", number] | undefined =>
  event.startsWith("finished") ? ["exit", 0] : /code (\d+)/.test(event) ? ["exit", Number(/code (\d+)/.exec(event)![1])] : /^(killed|terminated|interrupt|hangup|deleted|failed)/.test(event) ? ["signal", 1] : undefined;

/** When a blame ends, says so, or turns blaming off if it failed; after the lines shown, blames the rest, as magit-blame-process-sentinel and -quickstart-sentinel. */
function processSentinel(process: Proc, event: string): void {
  const status = exitOf(event);
  if (!status) return;
  const state = processes.get(process);
  processes.delete(process);
  const quick = quickstart.delete(process);
  if (!state || killed.delete(process)) return;
  if (!e8.bufferLiveP(e8.getBuffer(state.commandBuf))) e8.userError("Buffer being blamed has been killed");
  e8.withCurrentBuffer(state.commandBuf, () => {
    if (local("magit-blame-process") === process) setLocal("magit-blame-process", null);
    if (status[0] === "exit" && status[1] === 0) {
      if (!quick) e8.message("Blaming...done");
      else if (blameMode()) e8.letBind({ "default-directory": magitToplevelOrError() }, () => magitBlameRunProcess(...state.arguments));
    } else if (blameMode()) {
      e8.callWithPrefix(-1, magitBlameMode);
      e8.message("Blaming...failed");
    } else e8.message("Blaming...aborted");
  });
}

/** Parses each whole chunk git has written and makes its overlays, as magit-blame-process-filter. */
function processFilter(process: Proc, output: string): void {
  const state = processes.get(process);
  if (!state) return;
  state.output += output;
  if (!e8.bufferLiveP(e8.getBuffer(state.commandBuf))) return;
  const [type, cache] = e8.withCurrentBuffer(state.commandBuf, () => [blameType(), caches.get(state.commandBuf) ?? new Map<string, Revinfo>()] as const);
  for (;;) {
    const rest = state.output.slice(state.parsed);
    const m = /^filename .+\n/m.exec(rest);
    if (!m) break;
    const text = rest.slice(0, m.index + m[0].length);
    const lines = text.split("\n");
    const [chunk, fields] = parseChunk(lines, { i: 0 }, type);
    let revinfo: Revinfo | undefined;
    if (fields) {
      revinfo = { fields, formats: new Map() };
      cache.set(chunk.origRev, revinfo);
    } else {
      revinfo = cache.get(chunk.origRev);
      if (!revinfo) {
        revinfo = { fields: commitAlist(chunk.origRev), formats: new Map() };
        cache.set(chunk.origRev, revinfo);
      }
    }
    makeOverlays(state.commandBuf, chunk, revinfo);
    state.parsed += text.length;
  }
}

/** Reads a chunk from LINES at AT, as magit-blame--parse-chunk: the chunk and what git said of its commit, if it did. */
function parseChunk(lines: string[], at: { i: number }, type: string | undefined): [MagitBlameChunk, Map<string, string> | undefined] {
  const m = /^(.{40,}) (\d+) (\d+) (\d+)/.exec(lines[at.i] ?? "");
  if (!m) e8.signal("error", `Blaming failed due to unexpected output: ${lines[at.i] ?? ""}`);
  const chunk: MagitBlameChunk = { id: nextChunkId++, origRev: m![1], origLine: Number(m![2]), finalLine: Number(m![3]), numLines: Number(m![4]) };
  let revinfo: Map<string, string> | undefined = new Map();
  at.i++;
  for (; at.i < lines.length; at.i++) {
    const line = lines[at.i];
    let r: RegExpExecArray | null;
    if ((r = /^filename (.+)/.exec(line))) {
      chunk.origFile = decodeGitPath(r[1]);
      at.i++;
      break;
    } else if ((r = /^previous (.{40,}) (.+)/.exec(line))) {
      chunk.prevRev = r[1];
      chunk.prevFile = decodeGitPath(r[2]);
    } else if ((r = /^([^ ]+) (.+)/.exec(line))) revinfo.set(r[1], r[2]);
  }
  if (revinfo.size === 0) revinfo = undefined;
  if (type === "removal" && chunk.prevRev) {
    [chunk.origRev, chunk.prevRev] = [chunk.prevRev, chunk.origRev];
    [chunk.origFile, chunk.prevFile] = [chunk.prevFile, chunk.origFile];
    revinfo = undefined;
  }
  chunks.set(chunk.id, chunk);
  return [chunk, revinfo];
}

/** A path as git quotes it, unquoted, as magit-decode-git-path. */
function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path.replace(/\\([0-7]{3})/g, (_m, o: string) => `\\u00${parseInt(o, 8).toString(16).padStart(2, "0")}`));
  } catch {
    return path.slice(1, -1);
  }
}

/** What git says of REV, as magit-blame--commit-alist. */
function commitAlist(rev: string): Map<string, string> {
  const values = (magitRevFormat("%s\v%an\v%ad\v%cn\v%cd", rev, "--date=format:%s\v%z") ?? "").split("\v");
  const keys = ["summary", "author", "author-time", "author-tz", "committer", "committer-time", "committer-tz"];
  return new Map(keys.map((k, i) => [k, values[i] ?? ""]));
}

// Display

const styles = (): Style[] => (e8.variable("magit-blame-styles") as unknown as Style[] | null) ?? [];
const currentStyle = (): Style | undefined => (local("magit-blame--style") as unknown as Style | null) ?? undefined;
/** KEY's value in the buffer's style, as magit-blame--style-get. */
function styleGet(key: string): e8.Value | undefined {
  const style = currentStyle();
  const entry = style?.slice(1).find((kv) => (kv as [string, e8.Value])[0] === key) as [string, e8.Value] | undefined;
  return entry ? (entry[1] ?? undefined) : undefined;
}

/** The position line LINE (from 1) starts at, as magit-blame--line-beginning-position. */
function lineBeginningPosition(line: number): number {
  const l = line - 1;
  return l < e8.lineCount() ? e8.lineStart(Math.max(0, l)) : e8.pointMax();
}

/** Puts CHUNK's overlays in BUF, joined with the chunk before if it is the same commit's, as magit-blame--make-overlays. */
function makeOverlays(buf: string, chunk: MagitBlameChunk, revinfo: Revinfo): void {
  e8.withCurrentBuffer(buf, () =>
    e8.saveExcursion(() =>
      e8.saveRestriction(() => {
        e8.widen();
        const line = chunk.finalLine;
        let beg = lineBeginningPosition(line);
        const end = lineBeginningPosition(line + chunk.numLines);
        const before = beg > e8.pointMin() ? magitBlameChunkAt(beg - 1) : undefined;
        if (before && before.origRev === chunk.origRev) {
          chunk.finalLine = before.finalLine;
          beg = lineBeginningPosition(chunk.finalLine);
          chunk.numLines += before.numLines;
        }
        magitBlameRemoveOverlays(beg, end);
        revinfos.set(chunk.id, revinfo);
        if (truthy(local("magit-blame--make-margin-overlays"))) makeMarginOverlays(chunk, beg, end);
        makeHeadingOverlay(chunk, beg, end);
        makeHighlightOverlay(chunk, beg);
      }),
    ),
  );
}

function makeMarginOverlays(chunk: MagitBlameChunk, beg: number, end: number): void {
  let line = 0;
  for (let l = e8.lineOf(beg); l < e8.lineCount() && e8.lineStart(l) < end; l++, line++) {
    const eol = e8.lineEnd(l);
    // If possible avoid putting this on the first character
    // of the line to avoid a conflict with the line overlay.
    const ov = e8.makeOverlay(Math.min(e8.lineStart(l) + 1, eol), eol, { "magit-blame-chunk": chunk.id, "magit-blame-margin": line });
    updateMarginOverlay(ov);
  }
}
function makeHeadingOverlay(chunk: MagitBlameChunk, beg: number, end: number): void {
  const ov = e8.makeOverlay(beg, end, { "magit-blame-chunk": chunk.id, "magit-blame-heading": true });
  updateHeadingOverlay(ov);
}
function makeHighlightOverlay(chunk: MagitBlameChunk, beg: number): void {
  const ov = e8.makeOverlay(beg, Math.min(e8.lineEnd(e8.lineOf(beg)) + 1, e8.pointMax()), { "magit-blame-chunk": chunk.id, "magit-blame-highlight": true });
  updateHighlightOverlay(ov);
}

/** Sets the left margin for the style, keeping the width it had before, as magit-blame--update-margin. */
function updateMargin(action?: "enable" | "disable"): void {
  if (action === "enable") setLocal("magit-blame--previous-margin-width", e8.variable("left-margin-width") ?? null);
  let width: e8.Value | undefined;
  if (action === "disable") {
    width = local("magit-blame--previous-margin-width");
    setLocal("magit-blame--previous-margin-width", null);
  } else width = styleGet("margin-width") ?? local("magit-blame--previous-margin-width");
  setLocal("left-margin-width", width ?? 0);
  if (e8.windowBuffer(e8.selectedWindow()) === e8.bufferName()) e8.setWindowBuffer(e8.selectedWindow(), e8.bufferName());
}

/** Makes each overlay show the current style, as magit-blame--update-overlays. */
function updateOverlays(): void {
  e8.saveRestriction(() => {
    e8.widen();
    for (const ov of e8.overlaysIn(e8.pointMin(), e8.pointMax())) {
      if (truthy(e8.overlayGet(ov, "magit-blame-heading"))) updateHeadingOverlay(ov);
      else if (typeof e8.overlayGet(ov, "magit-blame-margin") === "number") updateMarginOverlay(ov);
      else if (truthy(e8.overlayGet(ov, "magit-blame-highlight"))) updateHighlightOverlay(ov);
    }
  });
}

function updateMarginOverlay(ov: number): void {
  let string: e8.PropertizedString | null = null;
  if (styleGet("margin-width") !== undefined) {
    const line = Number(e8.overlayGet(ov, "magit-blame-margin"));
    const format = styleGet("margin-format");
    const face = styleGet("margin-face");
    const f = !Array.isArray(format) ? format : (format[line] ?? format[format.length - 1]);
    const text = formatString(ov, (f as string | undefined) ?? undefined, (line !== 0 ? styleGet("margin-body-face") : undefined) ?? face ?? "magit-blame-margin");
    string = e8.propertize("o", { display: [["margin", "left-margin"], text ?? ""] });
  }
  e8.overlayPut(ov, "before-string", string);
}

function updateHeadingOverlay(ov: number): void {
  const format = styleGet("heading-format");
  let string: e8.Value = null;
  if (typeof format === "string") {
    // Use `default' as the last face to avoid picking up any face
    // attributes from the first character of the text on which we
    // put the overlay.  See #5233.
    string = formatString(ov, format, ["magit-blame-heading", "default"]) ?? null;
  } else if (truthy(styleGet("show-lines"))) {
    const start = e8.overlayStart(ov) ?? 0;
    // Special case of the special case described in
    // `magit-blame--make-margin-overlay'.  For empty lines it is not
    // possible to show both overlays without the line being too high.
    if (styleGet("margin-format") === undefined || start !== e8.lineEnd(e8.lineOf(start))) string = local("magit-blame-separator") ?? null;
  }
  e8.overlayPut(ov, "before-string", string);
}

const updateHighlightOverlay = (ov: number): void => e8.overlayPut(ov, "font-lock-face", styleGet("highlight-face") ?? null);

/** The string FORMAT makes for OV's chunk in FACE, made once for each commit, as magit-blame--format-string. */
function formatString(ov: number, format: string | undefined, face: e8.Value): e8.PropertizedString | undefined {
  const id = Number(e8.overlayGet(ov, "magit-blame-chunk"));
  const chunk = chunks.get(id);
  const revinfo = revinfos.get(id);
  if (!chunk || !revinfo) return undefined;
  const key = JSON.stringify([format ?? null, face]);
  if (!revinfo.formats.has(key)) revinfo.formats.set(key, format ? formatString1(chunk.origRev, revinfo, format, face) : undefined);
  return revinfo.formats.get(key);
}

/** FACE, a face or a list, as a list. */
const ensureList = (face: e8.Value): e8.Value[] => (Array.isArray(face) ? face : [face]);
/** S with font-lock-face FACE, none if FACE is nil. */
const withFace = (s: string, face: e8.Value | undefined): e8.PropertizedString => (face === null || face === undefined ? e8.propertize(s) : e8.propertize(s, { "font-lock-face": face }));

function formatString1(rev: string, revinfo: Revinfo, format: string, face: e8.Value): e8.PropertizedString {
  let str: e8.PropertizedString;
  if (isZeroRev(rev)) str = withFace(`${format.startsWith(" ") ? " " : ""}Not Yet Committed${format.endsWith("\n") ? "\n" : ""}`, face);
  else {
    const p0 = (s: string, f: string): e8.PropertizedString => e8.propertize(s, { "font-lock-face": face ? [f, ...ensureList(face)] : f });
    const p1 = (k: string, f: string): e8.PropertizedString => p0(revinfo.fields.get(k) ?? "", f);
    const p2 = (k1: string, k2: string, f: string): e8.PropertizedString => p0(formatTimeString(revinfo.fields.get(k1) ?? "0", revinfo.fields.get(k2) ?? "+0000"), f);
    const spec: { [c: string]: () => e8.PropertizedString | string } = {
      H: () => p0(rev, "magit-blame-hash"),
      h: () => p0(abbrevHash(rev), "magit-blame-hash"),
      s: () => p1("summary", "magit-blame-summary"),
      a: () => p1("author", "magit-blame-name"),
      c: () => p1("committer", "magit-blame-name"),
      A: () => p2("author-time", "author-tz", "magit-blame-date"),
      C: () => p2("committer-time", "committer-tz", "magit-blame-date"),
      f: () => "",
    };
    str = formatSpec(format, face, spec);
  }
  const width = format.endsWith("%f") ? styleGet("margin-width") : undefined;
  if (typeof width === "number") return e8.concat(str, withFace(" ".repeat(Math.max(0, width - str.string.length)), face));
  return str;
}

/** FORMAT with its %-specs replaced from SPEC, keeping their properties, the rest in FACE, as magit--format-spec. */
function formatSpec(format: string, face: e8.Value, spec: { [c: string]: () => e8.PropertizedString | string }): e8.PropertizedString {
  const parts: e8.PropertizedString[] = [];
  let literal = "";
  const flush = () => {
    if (literal !== "") parts.push(withFace(literal, face));
    literal = "";
  };
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") {
      literal += format[i];
      continue;
    }
    if (format[i + 1] === "%") {
      literal += "%";
      i++;
      continue;
    }
    const m = /^([-0-9.]*)([a-zA-Z])/.exec(format.slice(i + 1));
    if (!m) e8.signal("error", "Invalid format string");
    const make = spec[m![2]];
    if (!make) e8.signal("error", `Invalid format character: \`%${m![2]}'`);
    const raw = make();
    const val = typeof raw === "string" ? e8.propertize(raw) : raw;
    // As format's "%NUMs": PRECISION truncates, WIDTH pads, on the right
    // with the value's properties if left-aligned, else on the left
    // with none.
    const [, flagsWidth = "", precision] = /^([-0-9]*)(?:\.(\d*))?$/.exec(m![1]) ?? [];
    let text = precision !== undefined ? sliceProps(val, 0, Number(precision || 0)) : val;
    const width = Math.abs(Number(flagsWidth.replace(/^-+/, "") || 0));
    const pad = Math.max(0, width - text.string.length);
    if (pad > 0) {
      if (flagsWidth.startsWith("-")) text = e8.concat(text, new e8.PropertizedString(" ".repeat(pad), text.properties.length ? [[0, pad, text.properties[text.properties.length - 1][2]]] : []));
      else text = e8.concat(" ".repeat(pad), text);
    }
    flush();
    // Text with properties keeps them; text without inherits FORMAT's.
    parts.push(text.properties.some((r) => Object.keys(r[2]).length > 0) ? text : withFace(text.string, face));
    i += m![0].length;
  }
  flush();
  return e8.concat(...parts);
}

/** S from START to END with its properties. */
function sliceProps(s: e8.PropertizedString, start: number, end: number): e8.PropertizedString {
  const e = Math.min(end, s.string.length);
  const runs = s.properties.filter(([a, b]) => b > start && a < e).map(([a, b, p]) => [Math.max(a, start) - start, Math.min(b, e) - start, p] as [number, number, { [k: string]: e8.Value }]);
  return new e8.PropertizedString(s.string.slice(start, e), runs);
}

/** The thin line the lines style shows above each chunk, as magit-blame--format-separator. */
function formatSeparator(): e8.PropertizedString {
  const background = e8.faceAttribute("magit-blame-heading", ":background", true);
  return e8.concat(
    e8.propertize(" ", { display: ["space", ":height", [2]], "font-lock-face": [":extend", true, ":background", background] }),
    e8.propertize("\n", { "line-height": true, "font-lock-face": [":extend", true, ":background", background] }),
  );
}

/** TIME, seconds since the epoch, as the style's time-format or magit-blame-time-format, in TZ if the format shows the zone, as magit-blame--format-time-string. */
function formatTimeString(time: string, tz: string): string {
  const format = String(styleGet("time-format") ?? e8.variable("magit-blame-time-format") ?? "%F %H:%M");
  const seconds = Number(time);
  if (!format.includes("%z")) return magitFormatTimeString(format, seconds);
  // In the commit's own zone: shifted so local time shows it, %z its offset.
  const m = /^([-+])(\d\d)(\d\d)$/.exec(tz);
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60) : 0;
  const localOffset = -new Date(seconds * 1000).getTimezoneOffset() * 60;
  return magitFormatTimeString(format.replace(/%z/g, m ? tz : "+0000"), seconds + offset - localOffset);
}

/** REV cut to the repository's abbreviation length, as magit-blame--abbrev-hash. */
function abbrevHash(rev: string): string {
  let n = local("magit-blame--abbrev-length");
  if (typeof n !== "number") {
    n = magitAbbrevLength();
    setLocal("magit-blame--abbrev-length", n);
  }
  return rev.slice(0, n);
}

/** Deletes the blame overlays from BEG to END, all by default, as magit-blame--remove-overlays. */
export function magitBlameRemoveOverlays(beg?: number, end?: number): void {
  e8.saveRestriction(() => {
    e8.widen();
    for (const ov of e8.overlaysIn(beg ?? e8.pointMin(), end ?? e8.pointMax())) {
      if (e8.overlayGet(ov, "magit-blame-chunk") !== undefined && e8.overlayGet(ov, "magit-blame-chunk") !== null) e8.deleteOverlay(ov);
    }
  });
}

/** Says the summary of the commit of the chunk point entered, as magit-blame-maybe-show-message. */
export function magitBlameMaybeShowMessage(): void {
  if (!truthy(styleGet("show-message"))) return;
  const chunk = magitCurrentBlameChunk();
  const msg = chunk && caches.get(e8.bufferName())?.get(chunk.origRev)?.fields.get("summary");
  if (msg !== undefined) e8.message(`"${msg.replace(/[\\"]/g, "\\$&")}"`);
  else e8.message("Commit data not available yet.  Still blaming.");
}
e8.defun("magit-blame-maybe-show-message", magitBlameMaybeShowMessage);

// Commands

/** The arguments of the blame menu, as magit-blame-arguments. */
export const magitBlameArguments = (): string[] => transientArgs("magit-blame");

/** The visited file or blob's file relative to the top, tracked unless a blob, as magit-file-relative-name with TRACKED. */
function blameFileRelativeName(): string | undefined {
  const blob = local("magit-buffer-file-name");
  const rel = magitFileRelativeName(typeof blob === "string" ? blob : undefined);
  if (rel === undefined || typeof blob === "string") return rel;
  return magitFileTrackedP(rel) ? rel : undefined;
}

/** For each line show the revision in which it was added; say the chunk's summary when moving between chunks, as magit-blame-echo. */
export function magitBlameEcho(args: string[]): void {
  if (truthy(local("magit-buffer-file-name"))) e8.userError("Blob buffers aren't supported");
  const echo = String(e8.variable("magit-blame-echo-style") ?? "lines");
  setLocal("magit-blame--style", (styles().find((s) => s[0] === echo) ?? null) as unknown as e8.Value);
  setLocal("magit-blame-disable-modes", ["eldoc-mode", ...((e8.variable("magit-blame-disable-modes") as string[] | null) ?? [])]);
  if (!blameMode()) {
    e8.letBind({ "magit-blame-read-only": false }, () => {
      preBlameAssert("addition");
      preBlameSetup("addition");
      blameRun(args);
    });
  } else {
    e8.setReadOnly(false);
    toggleReadOnly();
    updateOverlays();
  }
}
export const magitBlameEchoCommand = e8.defineCommand({
  name: "magit-blame-echo",
  doc: "For each line show the revision in which it was added.\nShow the information about the chunk at point in the echo area\nwhen moving between chunks.  Unlike other blaming commands, do\nnot turn on `read-only-mode'.",
  run: () => magitBlameEcho(magitBlameArguments()),
});

/** Blames the buffer for TYPE with ARGS, as magit-blame-addition and its kin do. */
function blameAs(type: string, args: string[]): void {
  preBlameAssert(type);
  preBlameSetup(type);
  blameRun(args);
}
/** For each line show the revision in which it was added, as magit-blame-addition. */
export const magitBlameAddition = (args: string[]): void => blameAs("addition", args);
export const magitBlameAdditionCommand = e8.defineCommand({ name: "magit-blame-addition", doc: "For each line show the revision in which it was added.", run: () => magitBlameAddition(magitBlameArguments()) });

/** For each line show the revision in which it was removed, as magit-blame-removal. */
export function magitBlameRemoval(args: string[]): void {
  if (!truthy(local("magit-buffer-file-name"))) e8.userError("Only blob buffers can be blamed in reverse");
  blameAs("removal", args);
}
export const magitBlameRemovalCommand = e8.defineCommand({ name: "magit-blame-removal", doc: "For each line show the revision in which it was removed.", run: () => magitBlameRemoval(magitBlameArguments()) });

/** For each line show the last revision in which it still exists, as magit-blame-reverse. */
export function magitBlameReverse(args: string[]): void {
  if (!truthy(local("magit-buffer-file-name"))) e8.userError("Only blob buffers can be blamed in reverse");
  blameAs("final", args);
}
export const magitBlameReverseCommand = e8.defineCommand({ name: "magit-blame-reverse", doc: "For each line show the last revision in which it still exists.", run: () => magitBlameReverse(magitBlameArguments()) });

/** Refuses to blame what cannot be, as magit-blame--pre-blame-assert. */
function preBlameAssert(type: string): void {
  magitToplevelOrError();
  if (blameMode() && type === blameType()) {
    const chunk = magitCurrentBlameChunk();
    if (!chunk) e8.userError("Still blaming, commit data not available yet");
    if (!chunk!.prevRev) e8.userError("Chunk has no further history");
  } else if (blameFileRelativeName() === undefined) {
    if (e8.bufferFileName()) e8.userError("Buffer isn't visiting a tracked file");
    e8.userError("Buffer isn't visiting a file");
  }
}

/** Blaming again the same way visits the revision before the chunk's, otherwise starts afresh, as magit-blame--pre-blame-setup. */
function preBlameSetup(type: string): void {
  if (blameMode()) {
    if (type === blameType()) {
      const style = local("magit-blame--style");
      magitBlameVisitOtherFile();
      setLocal("magit-blame--style", style ?? null);
      setLocal("magit-blame-recursive-p", true);
    } else magitBlameRemoveOverlays();
  }
  setLocal("magit-blame-type", type);
}

/** Visits REV:FILE at LINE, as magit-find-file and forward-line. */
function visitBlob(rev: string, file: string, line: number): void {
  const buf = e8.letBind({ "default-directory": magitToplevelOrError() }, () => magitFindFileNoselect(rev, file));
  e8.call("switch-to-buffer", buf);
  e8.gotoChar(e8.pointMin());
  e8.gotoChar(lineBeginningPosition(line));
}

/** Visit another blob related to the current chunk, as magit-blame-visit-other-file. */
export function magitBlameVisitOtherFile(): void {
  const chunk = magitCurrentBlameChunk();
  if (!chunk) e8.userError("No blame chunk at point");
  if (!chunk!.prevRev) e8.userError("Chunk has no further history");
  // TODO Adjust line like magit-diff-visit-file.
  visitBlob(chunk!.prevRev!, chunk!.prevFile!, chunk!.origLine);
}
e8.defineCommand({ name: "magit-blame-visit-other-file", doc: "Visit another blob related to the current chunk.", run: () => magitBlameVisitOtherFile() });
e8.defineCommand({
  name: "magit-blame-visit-file",
  doc: "Visit the blob related to the current chunk.",
  run: () => {
    const chunk = magitCurrentBlameChunk();
    if (!chunk) e8.userError("No blame chunk at point");
    visitBlob(chunk!.origRev, chunk!.origFile!, chunk!.origLine);
  },
});

export const magitBlameQuit = e8.defineCommand({
  name: "magit-blame-quit",
  doc: "Turn off Magit-Blame mode.\nIf the buffer was created during a recursive blame,\nthen also kill the buffer.",
  run: () => {
    e8.callWithPrefix(-1, magitBlameMode);
    if (truthy(local("magit-blame-recursive-p"))) e8.call("kill-buffer", e8.bufferName());
  },
});

export const magitBlameNextChunk = e8.defineCommand({
  name: "magit-blame-next-chunk",
  doc: "Move to the next chunk.",
  run: () => e8.gotoChar(e8.nextSingleCharPropertyChange(e8.point(), "magit-blame-chunk")),
});
export const magitBlamePreviousChunk = e8.defineCommand({
  name: "magit-blame-previous-chunk",
  doc: "Move to the previous chunk.",
  run: () => e8.gotoChar(e8.previousSingleCharPropertyChange(e8.point(), "magit-blame-chunk")),
});

/** Moves to the next chunk from the same commit, or the previous if PREVIOUS, as magit-blame-next-chunk-same-commit. */
function nextChunkSameCommit(previous = false): void {
  const rev = magitCurrentBlameChunk()?.origRev;
  if (!rev) e8.userError("This chunk hasn't been blamed yet");
  let pos = e8.point();
  let ov: number | undefined;
  while (ov === undefined && pos !== (previous ? e8.pointMin() : e8.pointMax())) {
    pos = previous ? e8.previousSingleCharPropertyChange(pos, "magit-blame-chunk") : e8.nextSingleCharPropertyChange(pos, "magit-blame-chunk");
    const o = overlayAt(pos);
    if (o !== undefined && magitBlameChunkAt(pos)?.origRev === rev) ov = o;
  }
  if (ov === undefined) e8.userError("No more chunks from same commit");
  e8.gotoChar(e8.overlayStart(ov!)!);
}
e8.defineCommand({ name: "magit-blame-next-chunk-same-commit", doc: "Move to the next chunk from the same commit.", run: () => nextChunkSameCommit() });
e8.defineCommand({ name: "magit-blame-previous-chunk-same-commit", doc: "Move to the previous chunk from the same commit.", run: () => nextChunkSameCommit(true) });

export const magitBlameCycleStyle = e8.defineCommand({
  name: "magit-blame-cycle-style",
  doc: "Change how blame information is visualized.\nCycle through the elements of option `magit-blame-styles'.",
  run: () => {
    const all = styles();
    const at = all.findIndex((s) => s[0] === currentStyle()?.[0]);
    setLocal("magit-blame--style", (all[at + 1] ?? all[0] ?? null) as unknown as e8.Value);
    updateMargin();
    updateOverlays();
  },
});

e8.defineCommand({
  name: "magit-blame-copy-hash",
  doc: "Save hash of the current chunk's commit to the kill ring.\n\nWhen the region is active, then save the region's content\ninstead of the hash, like `kill-ring-save' would.",
  run: () => {
    if (e8.regionActive()) return void e8.call("copy-region-as-kill");
    const rev = magitCurrentBlameChunk()?.origRev;
    if (!rev) e8.userError("No blame chunk at point");
    e8.message(rev!);
    e8.killNew(rev!);
  },
});

// The menu

const readNumber = (prompt: string, initial?: string): string => {
  for (;;) {
    const s = e8.readString(`${prompt}`, { initial });
    if (s === "" || /^[1-9]\d*$/.test(s)) return s;
    e8.message("Please enter a positive number.");
  }
};

export const magitBlame = transientDefinePrefix("magit-blame", {
  doc: "Show the commits that added or removed lines in the visited file.",
  value: ["-w"],
  groups: [
    {
      description: "Arguments",
      items: [
        ["-w", "Ignore whitespace", "-w"],
        ["-r", "Do not treat root commits as boundaries", "--root"],
        ["-P", "Follow only first parent", "--first-parent"],
        ["-M", "Detect lines moved or copied within a file", "-M", { class: "option", reader: readNumber }],
        ["-C", "Detect lines moved or copied between files", "-C", { class: "option", reader: readNumber }],
      ],
    },
    {
      description: "Actions",
      items: [
        ["b", "Show commits adding lines", magitBlameAdditionCommand],
        ["r", "Show commits removing lines", magitBlameRemovalCommand, { if: () => !e8.bufferFileName() }],
        ["f", "Show last commits that still have lines", magitBlameReverseCommand, { if: () => !e8.bufferFileName() }],
        ["m", "Blame echo", magitBlameEchoCommand, { if: () => e8.bufferFileName() && (!blameMode() || e8.bufferReadOnly()) }],
        ["q", "Quit blaming", magitBlameQuit, { if: blameMode }],
      ],
    },
    { description: "Refresh", if: blameMode, items: [["c", "Cycle style", magitBlameCycleStyle, { transient: true }]] },
  ],
});

// Utilities

/** The revision buffer's next commit, while its update waits, as magit--update-revision-buffer. */
let updateRevisionBuffer: [string, string] | undefined;

/** Shows the chunk's commit in the revision buffer, if one is shown, after a delay, as magit-blame-maybe-update-revision-buffer. */
export function magitBlameMaybeUpdateRevisionBuffer(): void {
  const commit = magitCurrentBlameChunk()?.origRev;
  const buffer = commit && magitGetModeBuffer("magit-revision-mode");
  if (!commit || !buffer || !e8.windowList().some((w) => e8.windowBuffer(w) === buffer)) return;
  const pending = updateRevisionBuffer !== undefined;
  updateRevisionBuffer = [commit, buffer];
  if (pending) return;
  e8.runWithIdleTimer(Number(e8.variable("magit-update-other-window-delay") ?? 0.2), false, () => {
    const [rev, buf] = updateRevisionBuffer ?? [];
    updateRevisionBuffer = undefined;
    if (rev && buf && e8.bufferLiveP(e8.getBuffer(buf))) {
      e8.letBind({ "magit-display-buffer-noselect": true }, () => magitShowCommitRev(rev, magitDiffArguments("magit-revision-mode")[0]));
    }
  });
}
e8.defun("magit-blame-maybe-update-revision-buffer", magitBlameMaybeUpdateRevisionBuffer);

// Edit Line Commit, from magit-extras.el.

/**
 * Edits the commit that added the current line, or with TYPE removal the
 * one that removed it, as magit-edit-line-commit: with an interactive
 * rebase if it is reachable from HEAD, else by checking it out, then
 * visiting the file, blamed again as it was.
 */
export function magitEditLineCommit(type?: "removal"): void {
  const chunk = magitCurrentBlameChunk(type ?? "addition");
  const rev = chunk!.origRev;
  if (isZeroRev(rev)) return void e8.message("This line has not been committed yet");
  const rebase = magitRevAncestorP(rev, "HEAD");
  const file = e8.expandFileName(chunk!.origFile!, magitToplevel());
  const visiting = e8.bufferFileName();
  const sameFile = visiting !== undefined && e8.fileTruename(file) === e8.fileTruename(visiting);
  const btype = blameMode() ? blameType() : undefined;
  const visit = () => {
    e8.call("find-file", file);
    if (btype) {
      preBlameSetup(btype);
      blameRun(magitBlameArguments());
    }
  };
  e8.letBind({ "default-directory": magitToplevelOrError() }, () => {
    if (rebase) magitRebaseEditCommitRev(rev, transientArgs("magit-rebase"), sameFile ? undefined : (exit) => void (exit >= 0 && visit()), "edit-published");
    else magitRunGit("checkout", magitRevBranch(rev) ?? rev);
  });
  if (!rebase && !sameFile) visit();
}
export const magitEditLineCommitCommand = e8.defineCommand({
  name: "magit-edit-line-commit",
  doc: "Edit the commit that added the current line.\n\nWith a prefix argument edit the commit that removes the line,\nif any.  The commit is determined using `git blame' and made\neditable using `git rebase --interactive' if it is reachable\nfrom `HEAD', or by checking out the commit (or a branch that\npoints at it) otherwise.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => magitEditLineCommit(truthy(prefix) ? "removal" : undefined),
});

export const magitDiffEditHunkCommit = e8.defineCommand({
  name: "magit-diff-edit-hunk-commit",
  doc: "From a hunk, edit the respective commit and visit the file.\n\nFirst visit the file being modified by the hunk at the correct\nlocation using `magit-diff-visit-file'.  This actually visits a\nblob.  When point is on a diff header, not within an individual\nhunk, then this visits the blob the first hunk is about.\n\nThen invoke `magit-edit-line-commit', which uses an interactive\nrebase to make the commit editable, or if that is not possible\nbecause the commit is not reachable from `HEAD' by checking out\nthat commit directly.  This also causes the actual worktree file\nto be visited.\n\nNeither the blob nor the file buffer are killed when finishing\nthe rebase.  If that is undesirable, then it might be better to\nuse `magit-rebase-edit-commit' instead of this command.",
  run: () => {
    e8.letBind({ "magit-diff-visit-previous-blob": false }, () => e8.call("magit-diff-visit-file" as e8.CommandName));
    magitEditLineCommit();
  },
});
e8.defineKey("magit-diff-section-map", "C-c C-e", magitDiffEditHunkCommit);
