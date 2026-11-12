// SPDX-License-Identifier: GPL-3.0-or-later
//
// Running git for its effect, after magit-process.el: synchronously, as
// magit-run-git and magit-call-git, or in the background, as
// magit-run-git-async and magit-start-git, logging each command and its
// output as a section of the repository's process buffer ($), saying what
// failed, as magit-process-finish, and refreshing when done. Git's
// questions while it runs, passwords, usernames and yes or no, are asked
// in the minibuffer and their answers sent back, as Magit forwards them.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { insertHeading, insertRoot, insertSection, sections, show } from "magit-section";
import { readPasswd, truthy } from "subr";
import { withEditorEnv, withEditorFilter } from "with-editor";
import { applyOnRegion as ansiColorApplyOnRegion } from "ansi-color";
import { magitConfirm, magitEllipsis, magitFormatTimeString } from "magit-base";
import { magitGitExecutable, magitProcessGitArguments, magitProcessRecord, magitSetGitDebugReporter, magitToplevel, type GitArg } from "magit-git";
import { magitBufferInfo, magitBufferName, magitModeGetBuffers, magitProcessMode, magitRefresh, magitRepoName, magitSaveRepositoryBuffers, magitSetupBuffer } from "magit-mode";

/** A process as the E8 running gives one: an object, or in E8 0.5.8 and before its name. */
export type Proc = ReturnType<typeof e8.makeProcess>;

e8.defineFace({ name: "magit-process-ok", doc: "Face for zero exit-status.", attributes: { inherit: "magit-section-heading", weight: "bold" }, light: { foreground: "green" }, dark: { foreground: "green" } });
e8.defineFace({ name: "magit-process-ng", doc: "Face for non-zero exit-status.", attributes: { inherit: "magit-section-heading", weight: "bold" }, light: { foreground: "red" }, dark: { foreground: "red" } });
e8.defineFace({ name: "magit-mode-line-process", doc: "Face for git-process status in the mode line.", attributes: { inherit: "mode-line-emphasis" } });
e8.defineFace({ name: "magit-mode-line-process-error", doc: "Face for git-process error status in the mode line.", attributes: { inherit: "error" } });

e8.defineVariable({ name: "magit-process-popup-time", doc: "Seconds before the process buffer pops up while git runs: -1 never, 0 at once.", value: -1 });
e8.defineVariable({ name: "magit-process-log-max", doc: "How many git commands each repository's process buffer keeps.", value: 32 });
e8.defineVariable({ name: "magit-process-connection-type", doc: "Whether git runs on a pseudo-terminal (t) or pipes, when it has no input.", value: true });
e8.defineVariable({ name: "magit-show-process-buffer-hint", doc: "Whether an error message says which key shows the process buffer.", value: true });
e8.defineVariable({
  name: "magit-process-yes-or-no-prompt-regexp",
  doc: "Regexp matching yes-or-no prompts of git and its subprocesses.",
  value: " [([]\\([Yy]\\(?:es\\)?\\)[/|]\\([Nn]o?\\)\\(?:/\\[fingerprint\\]\\)?[])] ?[?:]? ?$",
});
e8.defineVariable({
  name: "magit-process-password-prompt-regexps",
  doc: "Regexps matching password prompts of git and its subprocesses; a host in submatch 99 is passed to magit-process-find-password-functions.",
  value: [
    "^\\(\\(Please e\\|E\\)nter \\(the \\)?p\\|P\\)assphrase.*: ?$",
    "^\\(\\(Please e\\|E\\)nter \\(the \\)?p\\|P\\)assword: ?$",
    "^\\(\\(Please e\\|E\\)nter \\(the \\)?p\\|P\\)assword for [\"']?\\(https?://\\)?\\(?99:[^\"']+\\)[\"']?: ?$",
    "^(\\(?1:[^) ]+\\)) Password for \\(?99:\\1\\): ?$",
    "^\\(?99:[^']+\\)\\('s\\)? password: ?$",
    "^Token: ?$",
    "^Yubikey for .*: ?$",
    "^Enter PIN for .*: ?$",
    "Please enter the passphrase for the ssh key",
    "Please enter the passphrase to unlock the OpenPGP secret key",
  ],
});
e8.defineVariable({ name: "magit-process-username-prompt-regexps", doc: "Regexps matching username prompts of git and its subprocesses.", value: ["^Username for '.*': ?$"] });
e8.defineVariable({ name: "magit-process-find-password-functions", doc: "Functions tried in turn for a password, given the host a prompt names; the first that gives one answers.", value: [] });
e8.defineVariable({ name: "magit-process-prompt-functions", doc: "Functions called with the process and its output, for questions the other options do not cover.", value: [] });
e8.defineVariable({
  name: "magit-process-error-message-regexps",
  doc: "Regexps that find the line saying what went wrong in a failed git's output.",
  value: ["^\\*ERROR\\*: Canceled by user$", "^\\(?:error\\|fatal\\|git\\): \\(.*\\)$", "^\\(Cannot rebase:.*\\)$"],
});
e8.defineVariable({
  name: "magit-process-apply-ansi-colors",
  doc: "Whether and when to apply color escapes in the process buffer.\n\nMagit instructs Git to not colorize its output, but third-party Git hooks may do so anyway.  We recommend you figure out how to prevent such hooks from colorizing their output instead of customizing this option.\n\nIf nil (the default), do not apply color escape sequences.  If t, apply them once the subprocess has finished.  If filter, apply them as input arrives (which is more expensive and potentially fragile).  This is a footgun; starter-kits should leave this option untouched.",
  value: null,
});
e8.defineVariable({
  name: "magit-process-display-mode-line-error",
  doc: "Whether Magit should retain and highlight process errors in the mode line.\n\nSee magit-show-process-buffer-hint for another way to display the complete output on demand.",
  value: true,
});
e8.defineVariable({
  name: "magit-process-error-tooltip-max-lines",
  doc: "The number of lines for magit-process-error-lines to return.\n\nThese are displayed in a tooltip for mode-line-process errors.\n\nIf magit-process-error-tooltip-max-lines is nil, the tooltip displays the text of magit-process-error-summary instead.",
  value: 20,
});
e8.defineVariable({
  name: "magit-process-timestamp-format",
  doc: "Format of timestamp for each process in the process buffer.\nIf non-nil, pass this to format-time-string when creating a process section in the process buffer, and insert the returned string in the heading of its section.",
  value: null,
});
e8.defineVariable({ name: "magit-this-error", doc: "The error the last git command in this repository ended with, as the status buffer shows it.", value: null });
e8.defineHook("magit-pre-call-git-hook", "Hook run before calling git synchronously.");
e8.defineHook("magit-pre-start-git-hook", "Hook run before starting git in the background.");
e8.defineHook("magit-credential-hook", "Hook run before git needs credentials.");
e8.defineError("magit-git-error", "error");

/** A git command run, its output so far and how it ended, as a section of the process buffer shows it. */
export interface ProcessEntry {
  id: number;
  dir: string;
  /** Where it ran, if not the repository's top. */
  pwd: string;
  program: string;
  args: string[];
  output: string;
  /** Its exit code, or undefined while it runs. */
  exit?: number;
  process?: Proc;
  /** The timestamp its heading shows, as magit-process-timestamp-format made it when it started. */
  timestamp?: string;
  /** Its output with color escapes applied, and the output that was from. */
  colored?: [string, e8.PropertizedString];
}
let nextId = 1;
/** Each repository's commands, oldest first. */
const logs = new Map<string, ProcessEntry[]>();

/** The repository's commands, as its process buffer lists them. */
export const magitProcessLog = (dir = magitToplevel() ?? ""): ProcessEntry[] => logs.get(dir) ?? [];

/** The last command's entry. */
export const magitThisProcess = (): ProcessEntry | undefined => lastStarted;
let lastStarted: ProcessEntry | undefined;

/** A command line as the process buffer shows it: git, an ellipsis for the global arguments, then the rest quoted, as magit-process--format-arguments. */
function formatArguments(program: string, args: string[]): e8.PropertizedString {
  const heading = (s: string) => e8.propertize(s, { "font-lock-face": "magit-section-heading" });
  if (program === magitGitExecutable() && args.length > 0) {
    const global = ((e8.variable("magit-git-global-arguments") as string[] | null) ?? []).length;
    return e8.concat(heading(e8.fileNameNondirectory(program)), " ", e8.propertize(magitEllipsis(), { "font-lock-face": "magit-section-heading", "help-echo": args.slice(0, global).join(" ") }), " ", heading(args.slice(global).map(shellQuote).join(" ")));
  }
  return e8.concat(heading(e8.fileNameNondirectory(program)), " ", heading(args.map(shellQuote).join(" ")));
}
const shellQuote = (s: string): string => (s === "" ? "''" : /^[\w@%+=:,./-]+$/.test(s) ? s : s.replace(/([^\w@%+=:,./-])/g, "\\$1"));

/** Inserts the process buffer's sections: one a command, its exit code or "run", its command line, and its output, as magit-process-insert-section. */
function insertProcessBuffer(dir: string): void {
  insertRoot("processbuf", () => {
    for (const p of magitProcessLog(dir)) {
      insertSection("process", String(p.id), p.exit === 0, () => {
        const code = p.exit === undefined ? "run " : e8.concat(e8.propertize(String(p.exit).padStart(3), { "font-lock-face": p.exit === 0 ? "magit-process-ok" : "magit-process-ng" }), " ");
        const where = p.pwd !== dir && p.pwd.startsWith(dir) ? `${p.pwd.slice(dir.length)} ` : p.pwd !== dir ? `${p.pwd} ` : "";
        insertHeading(code, p.timestamp !== undefined ? `${p.timestamp} ` : "", where, formatArguments(p.program, p.args), "\n");
        if (p.output !== "") {
          const output = p.output.endsWith("\n") ? p.output : `${p.output}\n`;
          // Color escapes are applied as output arrives, or once git has finished, as magit-process-apply-ansi-colors says.
          const ansi = e8.variable("magit-process-apply-ansi-colors");
          e8.insert(ansi === "filter" || (ansi === true && p.exit !== undefined) ? ansiColored(p, output) : output);
        }
        e8.insert("\n");
      });
    }
    e8.insert("\n");
  });
}

let ansiBuffers = 0;
/** OUTPUT, ENTRY's, with its color escapes applied, as ansi-color-apply-on-region does: kept until the output changes. */
function ansiColored(entry: ProcessEntry, output: string): e8.PropertizedString {
  if (entry.colored?.[0] === output) return entry.colored[1];
  const buffer = ` *magit-ansi-color-${++ansiBuffers}*`;
  e8.getBufferCreate(buffer);
  try {
    const colored = e8.withCurrentBuffer(buffer, () => {
      // Each section starts with no colors, as the text before it was already applied.
      e8.insert(`\x1b[0m${output}`);
      ansiColorApplyOnRegion(e8.pointMin(), e8.pointMax());
      return e8.bufferSubstring(e8.pointMin(), e8.pointMax());
    });
    entry.colored = [output, colored];
    return colored;
  } finally {
    e8.call("kill-buffer", buffer);
  }
}

/** The repository's process buffer, made if missing, and shown unless NODISPLAY, as magit-process-buffer. */
export function magitProcessBuffer(nodisplay = false): string {
  const dir = magitToplevel() ?? String(e8.variable("default-directory"));
  const name = magitBufferName("magit-process-mode", dir);
  e8.letBind({ "default-directory": dir }, () => magitSetupBuffer(name, magitProcessMode, "process", () => insertProcessBuffer(dir), false));
  if (!nodisplay) {
    e8.call("pop-to-buffer", name);
    const last = sections()?.root.children.at(-1);
    if (last) {
      show(last);
      e8.gotoChar(last.start);
    }
  }
  return name;
}

/** Makes the process buffer show the log again, if it is open. */
function redisplay(dir: string): void {
  const name = magitBufferName("magit-process-mode", dir);
  if (e8.bufferLiveP(e8.getBuffer(name)) && magitBufferInfo(name)) {
    e8.withCurrentBuffer(name, () => e8.letBind({ "inhibit-read-only": true }, () => insertProcessBuffer(dir)));
  }
}

/** Starts an entry for PROGRAM and ARGS in the repository's log, trimming it to magit-process-log-max, as magit-process-setup. */
function processSetup(program: string, args: string[]): ProcessEntry {
  const pwd = e8.fileNameAsDirectory(e8.expandFileName(String(e8.variable("default-directory") ?? ".")));
  const dir = magitToplevel() ?? pwd;
  const format = e8.variable("magit-process-timestamp-format");
  const timestamp = typeof format === "string" ? magitFormatTimeString(format, Date.now() / 1000) : undefined;
  const entry: ProcessEntry = { id: nextId++, dir, pwd, program, args, output: "", timestamp };
  const log = [...(logs.get(dir) ?? []), entry];
  const max = Number(e8.variable("magit-process-log-max") ?? 32);
  while (log.length > max && log[0].exit !== undefined) log.shift();
  logs.set(dir, log);
  lastStarted = entry;
  redisplay(dir);
  magitProcessSetModeLine(program, args, dir);
  return entry;
}

// The mode line, which shows the git command running, and the last one's error.

/** Each repository's mode-line-process, and whether it is kept until the next command, as Magit keeps them repository-local. */
const repositoryModeLines = new Map<string, { str?: e8.PropertizedString; inhibitUnset?: boolean }>();
const repositoryModeLine = (dir: string) => repositoryModeLines.get(dir) ?? repositoryModeLines.set(dir, {}).get(dir)!;

/** Sets mode-line-process to STR in each Magit buffer of the repository in DIR. */
function setModeLineProcess(dir: string, str: e8.PropertizedString | undefined): void {
  repositoryModeLine(dir).str = str;
  for (const b of magitModeGetBuffers(dir)) {
    e8.withCurrentBuffer(b, () => {
      e8.makeLocalVariable("mode-line-process");
      e8.setVariable("mode-line-process", str ?? null);
    });
  }
}

/** Shows the git command, without its arguments, in the mode line of the repository's Magit buffers, as magit-process-set-mode-line. */
export function magitProcessSetModeLine(program: string, args: string[], dir = magitToplevel() ?? ""): void {
  if (program === magitGitExecutable()) args = args.slice(((e8.variable("magit-git-global-arguments") as string[] | null) ?? []).length);
  const text = `${e8.fileNameNondirectory(program)}${args.length > 0 ? ` ${args[0]}` : ""}`;
  setModeLineProcess(dir, e8.concat(" ", e8.propertize(text, { "mouse-face": "highlight", "help-echo": "mouse-1: Show process buffer", "font-lock-face": "magit-mode-line-process" })));
}

/**
 * Shows the command in the mode line with an error face, ERROR in its
 * tooltip, as magit-process-set-mode-line-error-status: it stays until the
 * next command, though the buffers are refreshed meanwhile.
 */
export function magitProcessSetModeLineErrorStatus(dir: string, error?: string): void {
  const str = repositoryModeLine(dir).str;
  if (str === undefined) return;
  const tooltip = `${error !== undefined ? `${error}\n\n` : ""}mouse-1: Show process buffer`;
  const text = String(str).slice(1);
  setModeLineProcess(dir, e8.concat(" ", e8.propertize(text, { "mouse-face": "highlight", "help-echo": tooltip, "font-lock-face": "magit-mode-line-process-error" })));
  repositoryModeLine(dir).inhibitUnset = true;
  const enable = () => {
    e8.removeHook("pre-command-hook", enable);
    repositoryModeLine(dir).inhibitUnset = false;
  };
  e8.addHook("pre-command-hook", enable);
}

/** Takes the git command off the mode line, as magit-process-unset-mode-line. */
export function magitProcessUnsetModeLine(dir = magitToplevel() ?? ""): void {
  if (repositoryModeLine(dir).inhibitUnset) return;
  setModeLineProcess(dir, undefined);
}

/** Takes an error status off the mode line, as magit-process-unset-mode-line-error-status does when a buffer is refreshed. */
export function magitProcessUnsetModeLineErrorStatus(): void {
  const dir = magitToplevel() ?? "";
  const local = e8.variable("mode-line-process");
  const status = local !== null && local !== undefined && local !== "" ? local : repositoryModeLine(dir).str;
  if (status instanceof e8.PropertizedString && status.properties.some(([from, to, props]) => from <= 1 && 1 < to && props["font-lock-face"] === "magit-mode-line-process-error")) magitProcessUnsetModeLine(dir);
}
e8.addHook("magit-refresh-buffer-hook", magitProcessUnsetModeLineErrorStatus);
// A Magit buffer made while git runs shows it too, as magit-mode sets mode-line-process.
e8.addHook("magit-mode-hook", () => {
  const str = repositoryModeLine(magitToplevel() ?? "").str;
  if (str !== undefined) {
    e8.makeLocalVariable("mode-line-process");
    e8.setVariable("mode-line-process", str);
  }
});

/**
 * The first magit-process-error-tooltip-max-lines lines of ENTRY's
 * output, trailing whitespace removed, as magit-process-error-tooltip; or
 * undefined if that is not a positive number.
 */
export function magitProcessErrorTooltip(entry: ProcessEntry): string | undefined {
  const max = e8.variable("magit-process-error-tooltip-max-lines");
  if (typeof max !== "number" || !Number.isInteger(max) || max <= 0) return undefined;
  return entry.output.split("\n").slice(0, max).join("\n").replace(/\s+$/, "");
}

/** The line saying what went wrong in ENTRY's output, as magit-process-error-summary. */
export function magitProcessErrorSummary(entry: ProcessEntry): string | undefined {
  const regexps = (e8.variable("magit-process-error-message-regexps") as string[] | null) ?? [];
  const lines = entry.output.split("\n").reverse();
  for (const re of regexps) {
    const r = e8.emacsRegexp(re);
    for (const line of lines) {
      const m = r.exec(line);
      if (m) return m[1] ?? m[0];
    }
  }
  return undefined;
}

/**
 * Ends ENTRY with EXIT, as magit-process-finish: on failure says what went
 * wrong and where to see the rest, and remembers it as the repository's
 * last error, or signals magit-git-error when RAISE. Gives EXIT.
 */
function processFinish(entry: ProcessEntry, exit: number, raise = false): number {
  entry.exit = exit;
  redisplay(entry.dir);
  if (exit === 0) magitProcessUnsetModeLine(entry.dir);
  else {
    const msg = magitProcessErrorSummary(entry) ?? `git exited with code ${exit}`;
    if (truthy(e8.variable("magit-process-display-mode-line-error"))) magitProcessSetModeLineErrorStatus(entry.dir, magitProcessErrorTooltip(entry) ?? msg);
    else magitProcessUnsetModeLine(entry.dir);
    const status = e8.bufferList().find((b) => magitBufferInfo(b)?.kind === "status" && magitBufferInfo(b)?.dir === entry.dir);
    if (status) e8.withCurrentBuffer(status, () => e8.setVariable("magit-this-error", msg));
    const name = magitBufferName("magit-process-mode", entry.dir);
    const usage = truthy(e8.variable("magit-show-process-buffer-hint")) ? `Type $ to see "${name}" for details` : undefined;
    if (raise) e8.signal("magit-git-error", `${msg}${usage ? ` [${usage}]` : ""}`);
    e8.message(`Git error: ${msg}${usage ? ` [${usage}]` : ""}`);
  }
  if (exit === 0) {
    const status = e8.bufferList().find((b) => magitBufferInfo(b)?.kind === "status" && magitBufferInfo(b)?.dir === entry.dir);
    if (status) e8.withCurrentBuffer(status, () => e8.setVariable("magit-this-error", null));
  }
  return exit;
}

/** Runs PROGRAM with ARGS to the end, logging it, as magit-call-process; gives the exit code. */
export function magitCallProcess(program: string, args: string[], input?: string, raise = false): number {
  const entry = processSetup(program, args);
  magitProcessRecord(program, args, entry.pwd);
  const r = e8.callProcess([program, ...args], { directory: entry.pwd, input });
  entry.output = removeBogusErrors(r.output);
  return processFinish(entry, r.exit, raise);
}

/** Runs git with ARGS to the end, logging it, as magit-call-git; gives the exit code. */
export function magitCallGit(...args: GitArg[]): number {
  e8.runHooks("magit-pre-call-git-hook");
  magitSaveRepositoryBuffers();
  return magitCallProcess(magitGitExecutable(), magitProcessGitArguments(args));
}

/** As magitCallGit, with INPUT as git's standard input, as magit-run-git-with-input; refreshes after. */
export function magitRunGitWithInput(input: string, ...args: GitArg[]): number {
  e8.runHooks("magit-pre-call-git-hook");
  magitSaveRepositoryBuffers();
  const exit = magitCallProcess(magitGitExecutable(), magitProcessGitArguments(args), input);
  magitRefresh();
  return exit;
}

/** Runs git with ARGS, signalling magit-git-error if it fails, as magit-git. */
export function magitGit(...args: GitArg[]): number {
  e8.runHooks("magit-pre-call-git-hook");
  magitSaveRepositoryBuffers();
  return magitCallProcess(magitGitExecutable(), magitProcessGitArguments(args), undefined, true);
}

/** Runs git with ARGS to the end and refreshes, as magit-run-git; gives the exit code. */
export function magitRunGit(...args: GitArg[]): number {
  const exit = magitCallGit(...args);
  magitRefresh();
  return exit;
}

/** Text git's editor reports that Magit leaves out, as magit-process-remove-bogus-errors. */
function removeBogusErrors(s: string): string {
  return s
    .replace(/^(\*ERROR\*: )Canceled by user/m, "Canceled by user")
    .replace(/^error: There was a problem with the editor.*\n/m, "")
    .replace(/^Please supply the message using either -m or -F option\.\n/m, "");
}

/** What a background process should do when it ends. */
interface StartOptions {
  input?: string;
  /** Run with E8 as git's editor, as magit-run-git-with-editor. */
  editor?: boolean;
  env?: { [name: string]: string };
  /** Called after it ends and the buffers are refreshed. */
  then?: (exit: number) => void;
  /** The sentinel: magitProcessSentinel by default. */
  sentinel?: (entry: ProcessEntry, exit: number) => void;
}

/**
 * Starts PROGRAM with ARGS in the background, logging its output as it
 * comes and answering its questions, then refreshing the buffer that
 * was current and the status buffer when it ends, as magit-start-process.
 * Gives the process.
 */
export function magitStartProcess(program: string, args: string[], options: StartOptions = {}): Proc {
  const entry = processSetup(program, args);
  magitProcessRecord(program, args, entry.pwd);
  const commandBuffer = e8.currentBuffer();
  const connectionType = options.input === undefined && truthy(e8.variable("magit-process-connection-type")) ? "pty" : "pipe";
  const collect = (proc: Proc, output: string) => processFilter(entry, proc, output);
  const process = e8.makeProcess({
    name: e8.fileNameNondirectory(program),
    command: [program, ...args],
    directory: entry.pwd,
    env: { INSIDE_EMACS: "30.2,magit", ...(options.editor ? withEditorEnv() : {}), ...(options.env ?? {}) },
    connectionType,
    // The pinned with-editor declares its filter's process a string, as E8 0.5.8 gives it.
    filter: options.editor ? (withEditorFilter(collect as unknown as (p: string, o: string) => void) as unknown as typeof collect) : collect,
    sentinel: (_p, event) => {
      if (!/^(finished|exited|failed|killed|terminated)/.test(event)) return;
      const exit = event.startsWith("finished") ? 0 : Number(/code (\d+)/.exec(event)?.[1] ?? 1);
      (options.sentinel ?? magitProcessSentinel)(entry, exit);
      if (e8.bufferLiveP(e8.getBuffer(commandBuffer))) e8.withCurrentBuffer(commandBuffer, () => magitRefresh());
      else e8.letBind({ "default-directory": entry.dir }, () => magitRefresh());
      options.then?.(exit);
    },
  });
  entry.process = process;
  if (options.input !== undefined) {
    e8.processSendString(process, options.input);
    e8.processSendEof(process);
  }
  const popup = Number(e8.variable("magit-process-popup-time") ?? -1);
  if (popup === 0) magitProcessBuffer();
  else if (popup > 0)
    e8.runWithTimer(popup, null, () => {
      if (entry.exit === undefined) e8.letBind({ "default-directory": entry.dir }, () => magitProcessBuffer());
    });
  return process;
}

/** Ends ENTRY when its process ends, as magit-process-sentinel. */
export function magitProcessSentinel(entry: ProcessEntry, exit: number): void {
  if (exit === 0) e8.message(`${e8.capitalize(e8.fileNameNondirectory(entry.program))} finished`);
  processFinish(entry, exit);
}

/** Starts git with ARGS in the background, as magit-start-git. */
export function magitStartGit(input: string | undefined, ...args: GitArg[]): Proc {
  e8.runHooks("magit-pre-start-git-hook");
  magitSaveRepositoryBuffers();
  return magitStartProcess(magitGitExecutable(), magitProcessGitArguments(args), { input });
}

/** Starts git with ARGS in the background, saying so, as magit-run-git-async. */
export function magitRunGitAsync(...args: GitArg[]): Proc {
  e8.message(`Running ${magitGitExecutable()} ${flat(args).join(" ")}`);
  return magitStartGit(undefined, ...args);
}

/** Starts git with ARGS in the background with E8 as its editor, as magit-run-git-with-editor. */
export function magitRunGitWithEditor(...args: GitArg[]): Proc {
  e8.message(`Running ${magitGitExecutable()} ${flat(args).join(" ")}`);
  e8.runHooks("magit-pre-start-git-hook");
  magitSaveRepositoryBuffers();
  return magitStartProcess(magitGitExecutable(), magitProcessGitArguments(args), { editor: true });
}

/** Starts git's sequencer (rebase, cherry-pick, revert, am) with E8 as its editor, as magit-run-git-sequencer. */
export function magitRunGitSequencer(...args: GitArg[]): Proc {
  return magitRunGitWithEditor(...args);
}

/** Starts git with ARGS in the background with extra options, for callers that need them. */
export function magitStartGitWith(args: GitArg[], options: StartOptions): Proc {
  e8.runHooks("magit-pre-start-git-hook");
  magitSaveRepositoryBuffers();
  e8.message(`Running ${magitGitExecutable()} ${flat(args).join(" ")}`);
  return magitStartProcess(magitGitExecutable(), magitProcessGitArguments(args), options);
}

const flat = (args: GitArg[]): string[] => args.flatMap((a) => (Array.isArray(a) ? flat(a) : a === undefined || a === null || a === false ? [] : [a]));

/** Takes a process's OUTPUT into its entry, after any carriage return, and answers its questions, as magit-process-filter. */
function processFilter(entry: ProcessEntry, process: Proc, output: string): void {
  // A pseudo-terminal ends lines with CR LF, which Magit decodes as LF.
  let text = removeBogusErrors(output.replace(/\r\n/g, "\n"));
  const cr = text.lastIndexOf("\r");
  if (cr >= 0) {
    // What follows the last carriage return replaces the line so far.
    entry.output = entry.output.replace(/[^\n]*$/, "");
    text = text.slice(cr + 1);
  }
  entry.output += text;
  redisplay(entry.dir);
  yesOrNoPrompt(process, text);
  usernamePrompt(process, text);
  passwordPrompt(process, text);
  const fns = (e8.variable("magit-process-prompt-functions") as unknown[] | null) ?? [];
  for (const fn of fns) if (truthy(e8.funcall(fn as string, process, text))) break;
}

/** Forwards a yes-or-no question, as magit-process-yes-or-no-prompt. */
function yesOrNoPrompt(process: Proc, text: string): void {
  const re = e8.emacsRegexp(String(e8.variable("magit-process-yes-or-no-prompt-regexp")));
  const m = re.exec(text);
  if (!m) return;
  const yes = e8.yesOrNoP(text.slice(0, m.index));
  e8.processSendString(process, `${(yes ? m[1] : m[2]).toLowerCase()}\n`);
}

/** The prompt a regexp of PROMPTS finds in TEXT, ending in ": ", its match and the regexp, as magit-process-match-prompt. */
function matchPrompt(prompts: string[], text: string): [string, RegExpExecArray, string] | undefined {
  for (const p of prompts) {
    const m = e8.emacsRegexp(p).exec(text);
    if (m) {
      const prompt = m[0].endsWith(": ") ? m[0] : m[0].endsWith(":") ? `${m[0]} ` : `${m[0]}: `;
      return [prompt, m, p];
    }
  }
  return undefined;
}

/**
 * Group N of an Emacs regexp's match, where the regexp numbers it
 * explicitly, as \\(?99:...\\): E8's regexps count such a group by its
 * place, so it is found by counting the capturing groups before it.
 */
function numberedGroup(regexp: string, m: RegExpExecArray, n: number): string | undefined {
  let index = 0;
  for (let i = 0; i < regexp.length - 1; i++) {
    if (regexp[i] === "\\" && regexp[i + 1] === "(") {
      const explicit = /^\?(\d+):/.exec(regexp.slice(i + 2));
      if (regexp[i + 2] === "?" && !explicit) continue;
      index++;
      if (explicit && Number(explicit[1]) === n) return m[index] ?? undefined;
      if (!explicit && index === n) return m[index] ?? undefined;
    } else if (regexp[i] === "\\") i++;
  }
  return undefined;
}

/** Forwards a username question, as magit-process-username-prompt. */
function usernamePrompt(process: Proc, text: string): void {
  const found = matchPrompt((e8.variable("magit-process-username-prompt-regexps") as string[] | null) ?? [], text);
  if (!found) return;
  const user = e8.readString(found[0], { default: e8.getenv("USER") });
  e8.processSendString(process, `${user}\n`);
}

/** Answers a password question, from magit-process-find-password-functions or the minibuffer, as magit-process-password-prompt. */
function passwordPrompt(process: Proc, text: string): void {
  const found = matchPrompt((e8.variable("magit-process-password-prompt-regexps") as string[] | null) ?? [], text);
  if (!found) return;
  const host = numberedGroup(found[2], found[1], 99);
  if (host) {
    for (const fn of (e8.variable("magit-process-find-password-functions") as unknown[] | null) ?? []) {
      const pw = e8.funcall(fn as string, host);
      if (typeof pw === "string") {
        e8.processSendString(process, `${pw}\n`);
        return;
      }
    }
  }
  void readPasswd(found[0]).then((pw) => e8.processSendString(process, `${pw}\n`));
}

/** Kills the process at point, after asking, as magit-process-kill. */
export const magitProcessKill = e8.defineCommand({
  name: "magit-process-kill",
  doc: "Kill the process at point.",
  run: () => {
    const name = e8.bufferName();
    const info = magitBufferInfo();
    if (!info || info.kind !== "process") e8.userError("Not in a process buffer");
    const s = (sections()?.all ?? []).filter((x) => x.type === "process" && x.start <= e8.point()).at(-1);
    const entry = s && magitProcessLog(info!.dir).find((p) => String(p.id) === s.value);
    if (!entry || entry.exit !== undefined || !entry.process) e8.userError("Process isn't running");
    magitConfirm("kill-process");
    e8.deleteProcess(entry!.process!);
    void name;
  },
});

export const magitProcessBufferCommand = e8.defineCommand({
  name: "magit-process-buffer",
  doc: "Display the current repository's process buffer.",
  run: () => void magitProcessBuffer(),
});

/** The name of the repository's process buffer, as Magit's messages name it. */
export const magitProcessBufferName = (dir = magitToplevel() ?? ""): string => magitBufferName("magit-process-mode", dir);
void magitRepoName;

// Debugging, after magit-process.el's magit-toggle-subprocess-record and
// magit-git.el's reporting of git's errors with magit-git-debug.

export const magitToggleSubprocessRecord = e8.defineCommand({
  name: "magit-toggle-subprocess-record",
  doc:
    "Toggle whether subprocess invocations are recorded.\n\n" +
    "When enabled, all subprocesses started by magit-process-file are logged into the buffer specified by magit-process-record-buffer-name using the format magit-process-record-entry-format.  This is for debugging purposes.\n\n" +
    "This is in addition to and distinct from the default logging done by default, and additional logging enabled with magit-toggle-git-debug.",
  run: () => {
    const on = !truthy(e8.variable("magit-process-record-invocations"));
    e8.setVariable("magit-process-record-invocations", on);
    e8.message(`Recording of subprocess invocations ${on ? "enabled" : "disabled"}`);
  },
});

// A git whose output Magit consumes, failing with magit-git-debug on, goes
// in the process buffer with its error, as magit--git-insert does.
magitSetGitDebugReporter((program, args, dir, exit, output) => {
  e8.letBind({ "default-directory": dir }, () => {
    const entry = processSetup(program, args);
    entry.output = output;
    entry.exit = exit;
    redisplay(entry.dir);
  });
});
