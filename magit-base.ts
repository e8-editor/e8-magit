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
  name: "magit-delete-by-moving-to-trash",
  doc: "Whether Magit uses the system's trash can when it deletes files.",
  value: true,
});

/**
 * The prompt Magit shows: PROMPT, the default in parentheses, and ": ",
 * as magit-builtin-completing-read formats it.
 */
export function magitFormatPrompt(prompt: string, def?: string): string {
  const base = prompt.replace(/: ?$/, "");
  return def !== undefined && def !== "" ? `${base} (default ${def}): ` : `${base}: `;
}

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
  const def = options.def ?? options.fallback;
  let choices = Array.from(collection);
  if (def !== undefined && !choices.includes(def)) choices = [def, ...choices];
  const reply = e8.completingRead(magitFormatPrompt(prompt, def), choices, {
    requireMatch: options.requireMatch === true,
    initial: options.initialInput,
    history: options.history,
    default: def,
    category: options.category,
  });
  if (reply === "" || reply === undefined) {
    if (options.requireMatch && !(def === "")) e8.userError("Nothing selected");
    return undefined;
  }
  return reply;
}

/** Reads a string, trimmed, as magit-read-string: empty input is the default, or an error without one. */
export function magitReadString(prompt: string, initialInput?: string, history?: string, def?: string, noWhitespace = false): string {
  let reply = e8.readString(magitFormatPrompt(prompt, def), { initial: initialInput, history, default: def }).trim();
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
  const ask = (q: string) => (useYesOrNo ? e8.yesOrNoP(q) : e8.yOrNP(q));
  let question: string;
  if (items && items.length > 1) question = (promptN ?? `${prompt ?? `${action}`} %d items`).replace("%d", String(items.length));
  else if (items && items.length === 1) question = (prompt ?? `${action} %s`).replace("%s", items[0]);
  else question = prompt ?? `${String(action).replace(/-/g, " ")}`;
  if (!question.endsWith("? ")) question = `${question.replace(/\??\s*$/, "")}? `;
  question = question.charAt(0).toUpperCase() + question.slice(1);
  if (!ask(question)) e8.signal("quit", "Quit");
  return items ?? true;
}

/** Whether the prefix argument was given, as current-prefix-arg in a command. */
export const prefixArgP = (): boolean => truthy(e8.prefixArg());
