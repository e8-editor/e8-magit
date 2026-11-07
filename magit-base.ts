// SPDX-License-Identifier: GPL-3.0-or-later
//
// What Magit's packages share, after magit-base.el: reading with
// completion, reading strings, and asking for confirmation, as Magit asks.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";

e8.defineVariable({
  name: "magit-no-confirm",
  doc: "A list of symbols for actions Magit should not confirm, or t.\n\nAs Magit's: `discard', `reverse', `stage-all-changes', `unstage-all-changes', `delete-unmerged-branch', `drop-stashes', `kill-process', `abort-merge', `abort-rebase', `remove-modules', `trash', `safe-with-wip' and the rest.",
  value: [],
});
e8.defineVariable({
  name: "magit-verbose-messages",
  doc: "Whether to make certain prompts and messages more verbose.",
  value: false,
});
e8.defineVariable({
  name: "magit-delete-by-moving-to-trash",
  doc: "Whether Magit uses the system's trash can when it deletes files.",
  value: true,
});

e8.defineVariable({
  name: "magit-completing-read-function",
  doc: "Function to be called when requesting input from the user.\n\nThe default, magit-builtin-completing-read, support third-party completion frameworks, including vertico-mode, ivy-mode and helm-mode.\n\nHowever, if you would like to use Ivy or Helm completion with Magit but not enable the respective modes globally, then customize this option to use ivy-completing-read or helm--completing-read-default.\n\nIf you still use ido-mode, you'll likely need the magit-ido package.",
  value: "magit-builtin-completing-read",
});
e8.defineVariable({
  name: "magit-dwim-selection",
  doc: "When not to offer alternatives and ask for confirmation.\n\nMany commands by default ask the user to select from a list of possible candidates.  They do so even when there is a thing at point that they can act on, which is then offered as the default.\n\nThis option can be used to tell certain commands to use the thing at point instead of asking the user to select a candidate to act on, with or without confirmation.\n\nThe value has the form ((COMMAND nil|PROMPT DEFAULT)...).\n\n- COMMAND is the command that should not prompt for a choice.  To have an effect, the command has to use the function magit-completing-read or a utility function which in turn uses that function.\n\n- If the command uses magit-completing-read multiple times, then PROMPT can be used to only affect one of these uses.  PROMPT, if non-nil, is a regular expression that is used to match against the PROMPT argument passed to magit-completing-read.\n\n- DEFAULT specifies how to use the default.  If it is t, then the DEFAULT argument passed to magit-completing-read is used without confirmation.  If it is ask, then the user is given a chance to abort.  DEFAULT can also be nil, in which case the entry has no effect.",
  value: [
    ["magit-stash-apply", null, true],
    ["magit-ediff-resolve-all", null, true],
    ["magit-ediff-resolve-rest", null, true],
    ["magit-stash-branch", null, true],
    ["magit-stash-branch-here", null, true],
    ["magit-stash-format-patch", null, true],
    ["magit-stash-drop", null, "ask"],
    ["magit-stash-pop", null, "ask"],
  ],
});
e8.defineVariable({
  name: "magit-slow-confirm",
  doc: "Whether to ask user \"y or n\" or \"yes or no\" questions.\n\nWhen this is nil, then y-or-n-p is used when the user has to confirm a potentially destructive action.  When this is t, then yes-or-no-p is used instead.  If this is a list of symbols identifying actions, then yes-or-no-p is used for those, y-or-no-p for all others.  The list of actions is the same as for magit-no-confirm (which see).",
  value: ["drop-stashes"],
});
e8.defineVariable({
  name: "magit-no-message",
  doc: "A list of messages Magit should not display.\n\nMagit displays most echo area messages using message, but a few are displayed using magit-message instead, which takes the same arguments as the former, FORMAT-STRING and ARGS.  magit-message forgoes printing a message if any member of this list is a prefix of the respective FORMAT-STRING.\n\nIf Magit prints a message which causes you grief, then please first investigate whether there is another option which can be used to suppress it.  If that is not the case, then ask the Magit maintainers to start using magit-message instead of message in that case.  We are not proactively replacing all uses of message with magit-message, just in case someone *might* find some of these messages useless.\n\nMessages which can currently be suppressed using this option are:\n* \"Turning on magit-auto-revert-mode...\"",
  value: [],
});
e8.defineVariable({
  name: "magit-ellipsis",
  doc: "Characters or strings used to abbreviate text in some buffers.\n\nEach element has the form (WHERE (FANCY . UNIVERSAL)).\n\nFANCY is a single character or nil whereas UNIVERSAL is a string of any length.  The ellipsis produced by magit--ellipsis will be FANCY if it's a non-nil character that can be displayed with the available fonts, otherwise UNIVERSAL will be used.  FANCY is meant to be a rich character like a horizontal ellipsis symbol or an emoji whereas UNIVERSAL something simpler available in a less rich environment like the CLI.  WHERE determines the use-case for the ellipsis definition.  Currently the only acceptable values for WHERE are margin or t (representing the default).\n\nWhether collapsed sections are indicated using ellipsis is controlled by magit-section-visibility-indicator.\n\nAs E8 cannot yet tell whether a character can be displayed, FANCY is always used when it is given.",
  value: [
    ["margin", ["…", ">"]],
    [true, ["…", "..."]],
  ],
});

/**
 * An ellipsis, as a string, for WHERE (margin, or the default), as
 * magit--ellipsis: from magit-ellipsis, a string or entries
 * (WHERE (FANCY . UNIVERSAL)), FANCY if it is given, else UNIVERSAL.
 */
export function magitEllipsis(where?: string): string {
  const v = e8.variable("magit-ellipsis");
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const entry = (key: unknown) => (v as unknown[]).find((e) => Array.isArray(e) && e[0] === key) as unknown[] | undefined;
    const found = entry(where ?? true) ?? entry(true);
    // (WHERE (FANCY . UNIVERSAL)) is [WHERE, [FANCY, UNIVERSAL]], and as a dotted pair [WHERE, FANCY, UNIVERSAL].
    const pair = found && (Array.isArray(found[1]) ? (found[1] as unknown[]) : found.slice(1));
    if (pair) {
      const [fancy, universal] = pair;
      const e = truthy(fancy as e8.Value) ? fancy : universal;
      if (typeof e === "string") return e;
      if (typeof e === "number") return String.fromCodePoint(e);
    }
  }
  return e8.userError("Variable magit-ellipsis is invalid");
}

/**
 * Shows a message, as message, unless a member of magit-no-message is a
 * prefix of FORMAT, as magit-message: FORMAT's %s and %d take ARGS.
 */
export function magitMessage(format: string, ...args: unknown[]): void {
  const no = e8.variable("magit-no-message");
  if (Array.isArray(no) && no.some((p) => typeof p === "string" && format.startsWith(p))) return;
  let i = 0;
  e8.message(format.replace(/%[sdS%]/g, (m) => (m === "%%" ? "%" : String(args[i++]))));
}

/**
 * Asks PROMPT as y-or-n-p, or as yes-or-no-p when magit-slow-confirm is t
 * or names ACTION, as magit-y-or-n-p.
 */
export function magitYOrNP(prompt: string, action?: string): boolean {
  const slow = e8.variable("magit-slow-confirm");
  if (slow === true || (action !== undefined && Array.isArray(slow) && slow.some((a) => String(a) === action))) return e8.yesOrNoP(prompt);
  return e8.yOrNP(prompt);
}

/**
 * The prompt Magit shows: PROMPT, the default in parentheses, and ": ",
 * as magit-builtin-completing-read formats it.
 */
export function magitFormatPrompt(prompt: string, def?: string): string {
  const base = prompt.replace(/: ?$/, "");
  return def !== undefined && def !== "" ? `${base} (default ${def}): ` : `${base}: `;
}

/** Whether magit-completing-read-function is Magit's own, as magit-completing-read-default-prompt-predicate asks. */
const builtinCompletingRead = (): boolean => {
  const fn = e8.variable("magit-completing-read-function");
  return fn === null || fn === "magit-builtin-completing-read";
};

/** Reads one of CHOICES with completion, keeping their order, as magit-builtin-completing-read. */
export function magitBuiltinCompletingRead(prompt: string, choices: string[], requireMatch?: e8.Value, initialInput?: string, hist?: string, def?: string, category?: string): string {
  return e8.completingRead(prompt, choices, {
    requireMatch: truthy(requireMatch ?? null),
    initial: initialInput,
    history: hist,
    default: def,
    category,
  });
}
e8.defun("magit-builtin-completing-read", (prompt: string, choices: string[], _predicate?: e8.Value, requireMatch?: e8.Value, initialInput?: string | null, hist?: string | null, def?: string | null) =>
  magitBuiltinCompletingRead(prompt, choices, requireMatch, initialInput ?? undefined, hist ?? undefined, def ?? undefined),
);

/**
 * How magit-dwim-selection says to use DEF for PROMPT in the command
 * running: t to use it, ask to ask first, or undefined to read a choice.
 */
function dwimSelection(prompt: string): true | "ask" | undefined {
  const command = e8.thisCommand();
  const entries = e8.variable("magit-dwim-selection");
  if (!command || !Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (!Array.isArray(entry) || String(entry[0]) !== command) continue;
    const [, re, dwim] = entry;
    if (typeof re === "string" && e8.stringMatch(re, prompt) === undefined) continue;
    if (dwim === "ask") return "ask";
    if (truthy(dwim as e8.Value)) return true;
  }
  return undefined;
}

/** Whether the last magitCompletingRead used the default without asking, as magit-completing-read--silent-default. */
export let magitCompletingReadSilentDefault = false;

export interface MagitCompletingReadOptions {
  requireMatch?: boolean | "any";
  initialInput?: string;
  history?: string;
  def?: string;
  fallback?: string;
  category?: string;
}

/**
 * Reads one of COLLECTION, as magit-completing-read: the default is put
 * among the choices, empty input is the default, and with requireMatch
 * empty input with no default is an error: "Nothing selected". Gives
 * undefined for empty input otherwise.
 */
export function magitCompletingRead(prompt: string, collection: Iterable<string>, options: MagitCompletingReadOptions = {}): string | undefined {
  magitCompletingReadSilentDefault = false;
  if (options.def !== undefined) {
    const dwim = dwimSelection(prompt);
    if (dwim === "ask") {
      if (e8.yOrNP(`${prompt} ${options.def}? `)) return options.def;
      return e8.userError("Abort");
    }
    if (dwim === true) {
      magitCompletingReadSilentDefault = true;
      return options.def;
    }
  }
  const def = options.def ?? options.fallback;
  let choices = Array.from(collection);
  if (def !== undefined && !choices.includes(def)) choices = [def, ...choices];
  const builtin = builtinCompletingRead();
  const formatted = magitFormatPrompt(prompt, builtin ? def : undefined);
  const requireMatch = options.requireMatch === true;
  const reply: string | undefined | null = builtin
    ? magitBuiltinCompletingRead(formatted, choices, requireMatch, options.initialInput, options.history, def, options.category)
    : e8.funcall(e8.variable("magit-completing-read-function") as string, formatted, choices, null, requireMatch, options.initialInput ?? null, options.history ?? null, def ?? null);
  if (reply === "" || reply === undefined || reply === null) {
    if (options.requireMatch && !(def === "")) e8.userError("Nothing selected");
    return undefined;
  }
  return reply;
}

/**
 * Reads several of TABLE, separated by commas, as
 * magit-completing-read-multiple: each part after the last comma
 * completes against TABLE, which keeps its order. Gives the parts, or
 * with NO-SPLIT the input as it was typed.
 */
export function magitCompletingReadMultiple(prompt: string, table: Iterable<string>, options: { initialInput?: string; history?: string; def?: string; noSplit?: boolean; requireMatch?: boolean } = {}): string[] {
  const choices = Array.from(table);
  if (options.def !== undefined && !choices.includes(options.def)) choices.unshift(options.def);
  const separator = /[ \t]*,[ \t]*/;
  // Completes the last part, keeping those before it, as completing-read-multiple's table does.
  const complete = (input: string): string[] => {
    const before = /^(.*,[ \t]*)/s.exec(input)?.[1] ?? "";
    return choices.map((c) => before + c);
  };
  const reply = e8.completingRead(prompt, complete, { initial: options.initialInput, history: options.history, default: options.def });
  if (options.noSplit) return [reply];
  const items = reply.split(separator).filter((part) => part !== "");
  // Empty input is the default, if any.
  if (items.length === 0 && options.def !== undefined) return [options.def];
  if (options.requireMatch) for (const item of items) if (!choices.includes(item)) e8.userError(`No match for ${item}`);
  return items;
}

/** Reads a string, trimmed, as magit-read-string: empty input is the default, or an error without one. */
export function magitReadString(prompt: string, initialInput?: string, history?: string, def?: string, noWhitespace = false): string {
  const read = () => e8.readString(magitFormatPrompt(prompt, def), { initial: initialInput, history, default: def });
  let reply = (noWhitespace ? magitWithMinibufferMap("magit-minibuffer-local-ns-map", read) : read()).trim();
  if (reply === "" && def !== undefined) reply = def;
  if (noWhitespace) reply = reply.replace(/\s+/g, "-");
  if (reply === "") e8.userError("Need non-empty input");
  return reply;
}

/** As magitReadString, with whitespace turned into dashes, as magit-read-string-ns. */
export const magitReadStringNs = (prompt: string, initialInput?: string, history?: string, def?: string): string => magitReadString(prompt, initialInput, history, def, true);

/** Whether ACTION is one magit-no-confirm says not to confirm. */
function noConfirm(action: string | true): boolean {
  const v = e8.variable("magit-no-confirm");
  if (v === true) return true;
  return Array.isArray(v) && action !== true && v.some((x) => String(x) === action);
}

/**
 * Asks before ACTION, as magit-confirm: PROMPT names one item, with %s
 * for it; PROMPTN names several, with %d for their number. Gives the
 * items, or true without any, if the answer is yes, and signals quit if
 * no. ACTION true always asks.
 */
export function magitConfirm(action: string | true, prompt?: string, promptN?: string, items?: string[], useYesOrNo = false): string[] | true {
  if (action !== true && noConfirm(action)) return items ?? true;
  const ask = (q: string) => (useYesOrNo ? e8.yesOrNoP(q) : magitYOrNP(q, action === true ? undefined : action));
  let question: string;
  if (items && items.length > 1) question = (promptN ?? `${prompt ?? `${action}`} %d items`).replace("%d", String(items.length));
  else if (items && items.length === 1) question = (prompt ?? `${action} %s`).replace("%s", items[0]);
  else question = prompt ?? `${String(action).replace(/-/g, " ")}`;
  if (!question.endsWith("? ")) question = `${question.replace(/\??\s*$/, "")}? `;
  question = question.charAt(0).toUpperCase() + question.slice(1);
  if (!ask(question)) e8.signal("quit", "Quit");
  return items ?? true;
}

/** ACTION as a prompt, its dashes spaces and its first letter capital, as magit-confirm-make-prompt. */
export const magitConfirmMakePrompt = (action: string): string => `${action.charAt(0).toUpperCase()}${action.slice(1)}`.replace(/-/g, " ");

/** Asks before ACTION on FILES, naming them, as magit-confirm-files; nothing without files. */
export function magitConfirmFiles(action: string, files: string[], prompt?: string): string[] | undefined {
  if (files.length === 0) return undefined;
  const p = prompt ?? magitConfirmMakePrompt(action);
  return magitConfirm(action, `${p} "%s"`, `${p} %d files`, files) as string[];
}

/**
 * Asks with CLAUSES, each [char, description, value], as
 * magit-read-char-case: the prompt lists the descriptions, with VERBOSE
 * "[C-g] to abort" too, and the value of the clause of the key typed is
 * the answer.
 */
export function magitReadCharCase<T>(prompt: string, verbose: boolean, clauses: [string, string, T][]): T {
  const parts = [...clauses.map((c) => c[1]), ...(verbose ? ["[C-g] to abort"] : [])];
  const c = e8.readCharChoice(`${prompt}${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]} `, clauses.map((cl) => cl[0]).join(""));
  e8.message("");
  return clauses.find((cl) => cl[0] === c)![2];
}

export const prefixArgP = (): boolean => truthy(e8.prefixArg());

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number, w = 2, c = "0"): string => String(n).padStart(w, c);

/** TIME, seconds since the epoch, formatted by FORMAT in local time, as format-time-string's common conversions. */
export function magitFormatTimeString(format: string, time: number): string {
  const d = new Date(time * 1000);
  return format.replace(/%([a-zA-Z%])/g, (_m, c: string) => {
    switch (c) {
      case "Y": return String(d.getFullYear());
      case "y": return pad(d.getFullYear() % 100);
      case "m": return pad(d.getMonth() + 1);
      case "d": return pad(d.getDate());
      case "e": return pad(d.getDate(), 2, " ");
      case "H": return pad(d.getHours());
      case "I": return pad(((d.getHours() + 11) % 12) + 1);
      case "M": return pad(d.getMinutes());
      case "S": return pad(d.getSeconds());
      case "p": return d.getHours() < 12 ? "AM" : "PM";
      case "b": case "h": return months[d.getMonth()];
      case "B": return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getMonth()];
      case "a": return days[d.getDay()];
      case "A": return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()];
      case "j": return pad(Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000) + 1, 3);
      case "s": return String(Math.floor(time));
      case "F": return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      case "T": return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      case "R": return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      case "z": {
        const off = -d.getTimezoneOffset();
        return `${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
      }
      case "%": return "%";
      default: return `%${c}`;
    }
  });
}

// Reading text without whitespace, after magit-base.el's
// magit-minibuffer-local-ns-map.

/** The minibuffer's keymap while reading text in which whitespace is not allowed, as magit-minibuffer-local-ns-map. */
export const magitMinibufferLocalNsMap = e8.defineKeymap("magit-minibuffer-local-ns-map", "minibuffer-local-map");

export const magitWhitespaceDisallowed = e8.defineCommand({
  name: "magit-whitespace-disallowed",
  doc: "Beep to tell the user that whitespace is not allowed.",
  run: () => {
    e8.ding();
    e8.message("Whitespace isn't allowed here");
    if (truthy(e8.variable("defining-kbd-macro"))) e8.setVariable("defining-kbd-macro", null);
  },
});

for (const [key, command] of [
  ["SPC", magitWhitespaceDisallowed],
  ["TAB", magitWhitespaceDisallowed],
  // What Emacs's minibuffer-local-map binds that E8's lacks.
  ["<next>", "next-history-element"],
  ["<prior>", "previous-history-element"],
] as const)
  e8.defineKey(magitMinibufferLocalNsMap, key, command as e8.CommandName);

/** BODY's value, the minibuffer it opens having MAP as its local keymap, as Lisp binds minibuffer-local-map or passes a keymap to read-from-minibuffer. */
export function magitWithMinibufferMap<T>(map: string | e8.Keymap, body: () => T): T {
  const setup = (): void => {
    e8.removeHook("minibuffer-setup-hook", setup);
    e8.useLocalMap(map);
  };
  e8.addHook("minibuffer-setup-hook", setup);
  try {
    return body();
  } finally {
    e8.removeHook("minibuffer-setup-hook", setup);
  }
}

// Debugging, after magit-base.el's magit-emacs-Q-command.

/** The directory along load-path holding LIBRARY, as locate-library finds it. */
function locateLibraryDirectory(library: string): string | undefined {
  const path = (e8.variable("load-path") as string[] | null) ?? [];
  return path.map((d) => e8.fileNameAsDirectory(e8.expandFileName(String(d)))).find((d) => e8.fileExistsP(`${d}${library}.ts`));
}

/** A word quoted for the shell, as shell-quote-argument. */
const shellQuoteArgument = (s: string): string => (s === "" ? "''" : /^[\w@%+=:,./-]+$/.test(s) ? s : s.replace(/([^\w@%+=:,./-])/g, "\\$1"));

/** A shell command that runs an uncustomized E8 with only Magit loaded, as magit-emacs-Q-command makes for Emacs. */
export function magitEmacsQCommand(): string {
  const dirs: string[] = [];
  for (const lib of ["magit-section", "with-editor", "magit"]) {
    const dir = locateLibraryDirectory(lib);
    if (!dir) e8.signal("error", `Cannot find mandatory dependency ${lib}`);
    if (!dirs.includes(dir!)) dirs.push(dir!);
  }
  const program = `${String(e8.variable("invocation-directory") ?? "")}${String(e8.variable("invocation-name") ?? "e8")}`;
  return [program, "-q", ...dirs.flatMap((d) => ["-L", d]), "-l", `${locateLibraryDirectory("magit")}magit.ts`].map(shellQuoteArgument).join(" ");
}

export const magitEmacsQCommandCommand = e8.defineCommand({
  name: "magit-emacs-Q-command",
  doc: "Show a shell command that runs an uncustomized Emacs with only Magit loaded.\nIn E8 that is E8, without init.ts, loading Magit and the packages it requires.",
  run: () => {
    const cmd = magitEmacsQCommand();
    e8.message("Uncustomized Magit command saved to kill-ring, please run it in a terminal.");
    e8.killNew(cmd);
  },
});
