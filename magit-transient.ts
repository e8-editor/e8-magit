// SPDX-License-Identifier: GPL-3.0-or-later
//
// Magit's infixes for git variables, after magit-transient.el: a suffix
// that shows a git config variable's value in a menu and sets it, as a
// string read, one of some choices cycled through, true or false, a
// list of values, or a remote's urls; and the readers Magit's options
// share.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { magitCompletingRead } from "magit-base";
import { magitBranchOrCommitAtPoint, magitGetCurrentBranch, magitGitLines, magitGitString, magitListRefnames } from "magit-git";
import { magitCallGit } from "magit-process";
import { magitRefresh } from "magit-mode";
import { prefixArgP } from "magit-base";

/** What kind of git variable an infix sets, as magit--git-variable's subclasses. */
export interface GitVariableOptions {
  /** A string read (the default), one of some choices, true or false, or a remote's urls. */
  kind?: "string" | "choices" | "boolean" | "urls";
  /** The values cycled through, for choices. */
  choices?: string[] | (() => string[]);
  /** A variable whose value applies when this one is unset, shown as name:value. */
  fallback?: string;
  /** The value that applies when unset, or a function giving it, shown as default: or dwim:. */
  default?: string | (() => string | undefined);
  /** Several values, as git config --add sets them. */
  multiValue?: boolean;
  /** The global value rather than the repository's. */
  global?: boolean;
  /** What git remote set-url is given beside --add and --delete, as --push, for urls. */
  seturlArg?: string;
  /** The remote whose urls these are, for urls. */
  remote?: () => string | undefined;
  /** A description in place of the variable's name. */
  description?: string;
  /** Reads a new value, given the prompt and the value now. */
  reader?: (prompt: string, initial: string | undefined) => string;
  if?: () => unknown;
  level?: number;
}

const face = (text: string, f: string): e8.PropertizedString => e8.propertize(text, { face: f });
const scopeArg = (o: GitVariableOptions): string => (o.global ? "--global" : "--local");

/** The variable's value now, or values, as magit--git-variable's transient-init-value. */
function valueOf(variable: string, o: GitVariableOptions): string | string[] | undefined {
  if (o.multiValue || o.kind === "urls") return magitGitLines("config", scopeArg(o), "--get-all", variable);
  if (o.kind === "boolean") return magitGitString("config", scopeArg(o), "--bool", variable) === "true" ? "true" : "false";
  return magitGitString("config", scopeArg(o), variable);
}

const choicesOf = (o: GitVariableOptions): string[] => (typeof o.choices === "function" ? o.choices() : (o.choices ?? (o.kind === "boolean" ? ["true", "false"] : [])));

/** The choices as shown, the fallback or default first, each faced by whether it applies, as magit--git-variable-list-choices. */
export function magitGitVariableListChoices(variable: string, o: GitVariableOptions): [e8.PropertizedString | undefined, e8.PropertizedString[]] {
  const choices = choicesOf(o);
  let value: string | undefined;
  let global = magitGitString("config", "--global", variable);
  if (!o.global) value = magitGitString("config", "--local", variable);
  else {
    value = global;
    global = undefined;
  }
  const def = typeof o.default === "function" ? o.default() : o.default;
  const fallbackValue = o.fallback ? magitGitString("config", o.fallback) : undefined;
  const fallback = o.fallback && fallbackValue !== undefined ? `${o.fallback}:${fallbackValue}` : undefined;
  let first: e8.PropertizedString | undefined;
  if (global !== undefined) first = face(`global:${global}`, value !== undefined ? "transient-inactive-value" : choices.includes(global) ? "transient-value" : "font-lock-warning-face");
  else if (fallback) first = face(fallback, value !== undefined ? "transient-inactive-value" : "transient-value");
  else if (def !== undefined) first = face(`${typeof o.default === "function" ? "dwim:" : "default:"}${def}`, value !== undefined ? "transient-inactive-value" : "transient-value");
  const shown = value !== undefined && !choices.includes(value) ? [value, ...choices] : choices;
  return [first, shown.map((c) => face(c, c === value ? (choices.includes(c) ? "transient-value" : "font-lock-warning-face") : "transient-inactive-value"))];
}

/** The value as a menu shows it, as magit--git-variable's transient-format-value. */
function formatValue(variable: string, o: GitVariableOptions): e8.PropertizedString {
  if (o.kind === "choices" || o.kind === "boolean") {
    const [first, choices] = magitGitVariableListChoices(variable, o);
    const bar = face("|", "transient-inactive-value");
    const parts: (string | e8.PropertizedString)[] = [face("[", "transient-inactive-value")];
    choices.forEach((c, i) => parts.push(...(i > 0 ? [bar] : []), c));
    if (first) parts.push(bar, first);
    parts.push(face("]", "transient-inactive-value"));
    return e8.concat(...parts);
  }
  const value = valueOf(variable, o);
  if (Array.isArray(value) && value.length > 0) return value.length > 1 ? e8.concat(...value.map((v) => e8.concat("\n     ", face(v, "transient-value")))) : face(value[0], "transient-value");
  if (typeof value === "string") return face(value.split("\n")[0], "transient-value");
  const def = typeof o.default === "function" ? o.default() : o.default;
  if (def !== undefined) return e8.concat(face("default:", "transient-inactive-value"), face(def, "transient-value"));
  return face("unset", "transient-inactive-value");
}

/** Sets the variable to VALUE, or its values, or unsets it, as magit--git-variable's transient-infix-set. */
function setValue(variable: string, o: GitVariableOptions, value: string | string[] | undefined): void {
  if (o.kind === "urls") {
    const remote = o.remote?.();
    const previous = valueOf(variable, o) as string[];
    const values = (value as string[] | undefined) ?? [];
    for (const v of values.filter((x) => !previous.includes(x))) magitCallGit("remote", "set-url", o.seturlArg, "--add", remote, v);
    for (const v of previous.filter((x) => !values.includes(x))) magitCallGit("remote", "set-url", o.seturlArg, "--delete", remote, `^${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  } else if (o.multiValue) {
    magitCallGit("config", scopeArg(o), "--unset-all", variable);
    for (const v of (value as string[] | undefined) ?? []) magitCallGit("config", scopeArg(o), "--add", variable, v);
  } else if (value === undefined || value === "") magitCallGit("config", scopeArg(o), "--unset", variable);
  else magitCallGit("config", scopeArg(o), variable, value as string);
  magitRefresh();
  if (value === undefined) e8.message(`Unset ${variable}`);
}

/** The next value of a variable of choices, or one read with a prefix argument, as transient-infix-read for magit--git-variable:choices. */
function readChoice(variable: string, o: GitVariableOptions): string | undefined {
  const choices = choicesOf(o);
  if (prefixArgP()) {
    const fallbackValue = o.fallback ? magitGitString("config", o.fallback) : undefined;
    const fallback = o.fallback && fallbackValue !== undefined ? `${o.fallback}:${fallbackValue}` : undefined;
    const choice = magitCompletingRead(`Set \`${variable}' to`, fallback ? [...choices, fallback] : choices, { requireMatch: true });
    return choice === fallback ? undefined : choice;
  }
  const value = valueOf(variable, o) as string | undefined;
  if (value === undefined) return choices[0];
  const at = choices.indexOf(value);
  return at < 0 ? choices[0] : choices[at + 1];
}

let infixes = 0;

/**
 * A suffix showing and setting the git variable VARIABLE names, as Magit's
 * transient-define-infix with a magit--git-variable class: a string read,
 * a choice cycled to, or values read separated by commas.
 */
export function magitGitVariable(key: string, variable: () => string, options: GitVariableOptions = {}): [string, () => e8.PropertizedString, e8.DefinedCommand, object] {
  const o = options;
  const command = e8.defineCommand({
    name: `magit:git-variable:${variable.toString().length}:${infixes++}`,
    doc: "Set a git variable.",
    run: () => {
      const name = variable();
      if (o.kind === "choices" || o.kind === "boolean") return setValue(name, o, readChoice(name, o));
      const now = valueOf(name, o);
      if (o.multiValue || o.kind === "urls") {
        const text = e8.readString(`${name}: `, { initial: ((now as string[]) ?? []).join(",") });
        const values = text.split(",").map((v) => v.trim()).filter(Boolean).map((v) => (o.kind === "urls" && v.startsWith("~") ? e8.expandFileName(v) : v));
        return setValue(name, o, values);
      }
      const text = o.reader ? o.reader(`${name}: `, now as string | undefined) : e8.readString(`${name}: `, { initial: now as string | undefined });
      setValue(name, o, text === "" ? undefined : text);
    },
  });
  const describe = (): e8.PropertizedString => {
    const name = variable();
    return e8.concat(face(o.description ?? name, "transient-argument"), " ", formatValue(name, o));
  };
  const extra: { transient: boolean; if?: () => unknown; level?: number } = { transient: true };
  if (o.if) extra.if = o.if;
  if (o.level !== undefined) extra.level = o.level;
  return [key, describe, command, extra];
}

/** Reads an author, from those of HEAD's history, as magit-transient-read-person. */
export function magitTransientReadPerson(prompt: string, initial?: string): string {
  const people = magitGitLines("shortlog", "-n", "-s", "-e", "HEAD").map((l) => /^[\s\t]+[0-9]+\t(.*)$/.exec(l)?.[1]).filter((p): p is string => p !== undefined);
  return magitCompletingRead(prompt, people, { initialInput: initial }) ?? "";
}

/** Reads a revision, as magit-transient-read-revision. */
export function magitTransientReadRevision(prompt: string, initial?: string): string {
  return magitCompletingRead(prompt, ["HEAD", ...magitListRefnames()], { requireMatch: "any", initialInput: initial, def: magitBranchOrCommitAtPoint() ?? magitGetCurrentBranch() }) ?? "";
}

e8.defineVariable({
  name: "magit-openpgp-default-signing-key",
  doc: "Fingerprint of your default Openpgp key used for signing.\nIf the specified primary key has signing capacity then it is used as the value of the --gpg-sign argument without prompting, even when other such keys exist.  To be able to select another key you must then use a prefix argument.",
  value: null,
});

/** The fingerprints of the secret keys that can sign, from gpg --list-secret-keys --with-colons OUTPUT. */
export function magitGpgSigningKeys(output: string): string[] {
  const keys: string[] = [];
  let canSign = false;
  let primary = false;
  for (const line of output.split("\n")) {
    const fields = line.split(":");
    if (fields[0] === "sec") {
      // The primary key's capabilities, the whole key's in capitals.
      canSign = /S/.test(fields[11] ?? "");
      primary = true;
    } else if (fields[0] === "fpr" && primary) {
      if (canSign) keys.push(fields[9]);
      primary = false;
    } else if (fields[0] === "ssb") primary = false;
  }
  return keys;
}

/**
 * Reads a gpg key to sign with, as magit-read-gpg-signing-key: without a
 * prefix argument, the only key that can sign, or
 * magit-openpgp-default-signing-key if it is one of them, without asking.
 */
export function magitReadGpgSigningKey(prompt: string, initial?: string, keys?: string[]): string {
  if (keys === undefined) {
    const r = e8.callProcess(["gpg", "--list-secret-keys", "--with-colons"]);
    keys = r.exit === 0 ? magitGpgSigningKeys(r.output) : [];
  }
  const def = e8.variable("magit-openpgp-default-signing-key");
  if (!prefixArgP()) {
    if (keys.length === 1) return keys[0];
    if (typeof def === "string" && keys.includes(def)) return def;
  }
  return e8.completingRead(prompt, keys, { initial, history: "magit-gpg-secret-key-hist" });
}
