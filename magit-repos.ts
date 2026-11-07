// SPDX-License-Identifier: GPL-3.0-or-later
//
// Listing repositories, after magit-repos.el: magit-list-repositories
// shows the repositories magit-repository-directories names, a line each
// in a tabulated list whose columns magit-repolist-columns gives, with
// commands to show a repository's status and to mark, fetch and visit
// files in several; magit-read-repository reads one of them, as
// magit-status does outside a repository or with a prefix argument.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { forwardLine, truthy } from "subr";
import { tabulatedListGetId, tabulatedListInitHeader, tabulatedListPrint, tabulatedListPutTag } from "tabulated-list";
import { magitCompletingRead, magitConfirm } from "magit-base";
import {
  magitGetCurrentBranch,
  magitGetPushBranch,
  magitGetUpstreamBranch,
  magitGitString,
  magitListLocalBranches,
  magitListStashes,
  magitRevDiffCount,
  magitRevFormat,
  magitStagedFiles,
  magitToplevel,
  magitUnstagedFiles,
  magitUntrackedFiles,
} from "magit-git";
import { magitRunGit } from "magit-process";
import { magitStatusSetupBuffer } from "magit-status";

// Options.

e8.defineVariable({
  name: "magit-repository-directories",
  doc:
    "List of directories that are or contain Git repositories.\n\n" +
    "Each element has the form (DIRECTORY . DEPTH).  DIRECTORY has to be a directory or a directory file-name, a string.  DEPTH, an integer, specifies the maximum depth to look for Git repositories.  If it is 0, then only add DIRECTORY itself.\n\n" +
    "This option controls which repositories are being listed by magit-list-repositories.  It also affects magit-status (which see) in potentially surprising ways.",
  value: [],
});

/** A column: its header, width, the function giving its text, and its properties as [key, value] pairs. */
export type RepolistColumn = [string, number, string | ((spec: RepolistSpec) => unknown), [string, e8.Value][]];
/** What a column's function is given: [key, value] pairs, :id (or :path), :title, :width and the column's properties. */
export type RepolistSpec = [string, e8.Value][];
const specGet = (spec: RepolistSpec, key: string): e8.Value | undefined => spec.find((e) => e[0] === key)?.[1];

e8.defineVariable({
  name: "magit-repolist-columns",
  doc:
    "List of columns displayed by magit-list-repositories.\n\n" +
    "Each element has the form (HEADER WIDTH FORMAT PROPS).\n\n" +
    "HEADER is the string displayed in the header.  WIDTH is the width of the column.  FORMAT is a function that is called with one argument, the repository identification (usually its basename), and with default-directory bound to the toplevel of its working tree.  It has to return a string to be inserted or nil.  PROPS is an alist that supports the keys :right-align, :pad-right and :sort.\n\n" +
    "The :sort function has a weird interface described in the docstring of tabulated-list--get-sort.  Alternatively < and magit-repolist-version< can be used as those functions are automatically replaced with functions that satisfy the interface.  Set :sort to nil to inhibit sorting; if unspecified, then the column is sortable using the default sorter.\n\n" +
    'You may wish to display a range of numeric columns using just one character per column and without any padding between columns, in which case you should use an appropriate HEADER, set WIDTH to 1, and set :pad-right to 0.  "+" is substituted for numbers higher than 9.',
  value: [
    ["Name", 25, "magit-repolist-column-ident", []],
    ["Version", 25, "magit-repolist-column-version", [[":sort", "magit-repolist-version<"]]],
    ["B<U", 3, "magit-repolist-column-unpulled-from-upstream", [[":right-align", true], [":sort", "<"]]],
    ["B>U", 3, "magit-repolist-column-unpushed-to-upstream", [[":right-align", true], [":sort", "<"]]],
    ["Path", 99, "magit-repolist-column-path", []],
  ],
});
e8.defineVariable({
  name: "magit-repolist-column-flag-alist",
  doc:
    "Association list of predicates and flags for magit-repolist-column-flag.\n\n" +
    "Each element is of the form (FUNCTION . FLAG).  Each FUNCTION is called with no arguments, with default-directory bound to the top level of a repository working tree, until one of them returns a non-nil value.  FLAG corresponding to that function is returned as the value of magit-repolist-column-flag.",
  value: [
    ["magit-untracked-files", "N"],
    ["magit-unstaged-files", "U"],
    ["magit-staged-files", "S"],
  ],
});
e8.defineVariable({
  name: "magit-repolist-sort-key",
  doc: "Initial sort key for buffer created by magit-list-repositories.\nIf nil, no additional sorting is performed.  Otherwise, this should be a cons cell (NAME . FLIP).  NAME is a string matching one of the column names in magit-repolist-columns.  FLIP, if non-nil, means to invert the resulting sort.",
  value: ["Path", false],
});

// The predicates of magit-repolist-column-flag-alist, as functions a
// config's alist can name too.
for (const [name, fn] of [
  ["magit-untracked-files", () => magitUntrackedFiles()],
  ["magit-unstaged-files", () => magitUnstagedFiles()],
  ["magit-staged-files", () => magitStagedFiles()],
] as const) {
  if (!e8.fboundp(name)) e8.defun(name, fn);
}

/** The current buffer's directory. */
const defaultDirectory = (): string => String(e8.variable("default-directory") ?? ".");
/** Runs BODY with default-directory DIR. */
const inDirectory = <T>(dir: string, body: () => T): T => e8.letBind({ "default-directory": dir }, body);
/** Whether a function's answer is Lisp's non-nil: an empty list is nil. */
const nonNil = (v: unknown): boolean => truthy(v as e8.Value) && !(Array.isArray(v) && v.length === 0);

// List commands.

/** Displays the list of repositories, as magit-list-repositories. */
export function magitListRepositories(): void {
  magitRepolistSetup(e8.variable("magit-repolist-columns") as unknown as RepolistColumn[]);
}
export const magitListRepositoriesCommand = e8.defineCommand({
  name: "magit-list-repositories",
  doc: "Display a list of repositories.\n\nUse the option magit-repository-directories to control which repositories are displayed.",
  run: () => magitListRepositories(),
});

// Mode commands.

export const magitRepolistStatus = e8.defineCommand({
  name: "magit-repolist-status",
  doc: "Show the status for the repository at point.",
  run: () => {
    const id = tabulatedListGetId();
    if (typeof id !== "string") e8.userError("There is no repository at point");
    magitStatusSetupBuffer(e8.fileNameAsDirectory(e8.expandFileName(id)));
  },
});

export const magitRepolistMark = e8.defineCommand({
  name: "magit-repolist-mark",
  doc: "Mark a repository and move to the next line.",
  run: () => {
    magitRepolistEnsurePadding();
    tabulatedListPutTag("*", true);
  },
});

export const magitRepolistUnmark = e8.defineCommand({
  name: "magit-repolist-unmark",
  doc: "Unmark a repository and move to the next line.",
  run: () => tabulatedListPutTag(" ", true),
});

/** Fetches in each of REPOS, or in all listed with "all", as magit-repolist-fetch. */
export function magitRepolistFetch(repos: string[] | "all"): void {
  e8.runHooks("magit-credential-hook");
  magitRepolistMapc(() => magitRunGit("remote", "update"), repos, "Fetching in %s...");
}
export const magitRepolistFetchCommand = e8.defineCommand({
  name: "magit-repolist-fetch",
  doc: "Fetch all marked or listed repositories.",
  run: () => magitRepolistFetch(magitRepolistGetRepos("*")),
});

/** Visits FILE in each of REPOS, or in all listed with "all", in another frame, as magit-repolist-find-file-other-frame. */
export function magitRepolistFindFileOtherFrame(repos: string[] | "all", file: string): void {
  magitRepolistMapc(() => e8.call("find-file-other-frame", e8.expandFileName(file, defaultDirectory())), repos);
}
export const magitRepolistFindFileOtherFrameCommand = e8.defineCommand({
  name: "magit-repolist-find-file-other-frame",
  doc: "Find a file in all marked or listed repositories.",
  run: () => {
    const repos = magitRepolistGetRepos("*");
    magitRepolistFindFileOtherFrame(repos, e8.readString("Find file in repositories: "));
  },
});

/** Sets tabulated-list-padding to 2, unless that is already non-zero, as magit-repolist--ensure-padding. */
function magitRepolistEnsurePadding(): void {
  if (Number(e8.variable("tabulated-list-padding") ?? 0) !== 0) return;
  e8.setVariable("tabulated-list-padding", 2);
  tabulatedListInitHeader();
  tabulatedListPrint(true);
}

/**
 * The marked repositories, or "all" if none are marked, as
 * magit-repolist--get-repos: with CHAR only those marked with it. If none
 * are marked, asks whether to act on all of them instead.
 */
export function magitRepolistGetRepos(char?: string): string[] | "all" {
  const marked = magitRepolistMarkedRepos(char) as string[];
  if (marked.length > 0) return marked;
  magitConfirm("repolist-all", "Nothing selected.  Act on ALL displayed repositories");
  return "all";
}

/** The marked repositories, as magit-repolist--marked-repos: with CHAR their ids, else [mark, id] pairs. */
export function magitRepolistMarkedRepos(char?: string): string[] | [string, string][] {
  const list: (string | [string, string])[] = [];
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    while (e8.point() < e8.pointMax()) {
      const c = e8.charAfter(e8.point());
      if (c !== " " && c !== "\n") {
        const id = String(tabulatedListGetId() ?? "");
        if (char === undefined) list.unshift([c ?? "", id]);
        else if (c === char) list.unshift(id);
      }
      if (forwardLine(1) !== 0) break;
    }
  });
  return list as string[] | [string, string][];
}

/**
 * Calls FN in each of REPOS, or in every listed one with "all", with
 * default-directory its top, saying MSG around each call with the
 * directory for its %s, as magit-repolist--mapc.
 */
export function magitRepolistMapc(fn: () => void, repos: string[] | "all", msg?: string): void {
  if (repos === "all") {
    const all: string[] = [];
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMin());
      while (e8.point() < e8.pointMax()) {
        const id = tabulatedListGetId();
        if (typeof id === "string") all.push(id);
        if (forwardLine(1) !== 0) break;
      }
    });
    repos = all;
  }
  const base = defaultDirectory();
  const len = repos.length;
  let i = 0;
  for (const repo of repos) {
    const dir = e8.fileNameAsDirectory(e8.expandFileName(repo, base));
    inDirectory(dir, () => {
      if (msg === undefined) return fn();
      const m = `(${++i}/${len}) ${msg.replace("%s", dir)}`;
      e8.message(m);
      fn();
      e8.message(`${m}done`);
    });
  }
}

// The mode.

export const magitRepolistMode = e8.defineMajorMode({
  name: "magit-repolist-mode",
  modeName: "Repos",
  parent: "tabulated-list-mode" as e8.CommandName,
  doc: "Major mode for browsing a list of Git repositories.",
  bindings: {
    RET: magitRepolistStatus,
    m: magitRepolistMark,
    u: magitRepolistUnmark,
    f: magitRepolistFetchCommand,
    "5": magitRepolistFindFileOtherFrameCommand,
  },
  setup: () => {
    e8.setVariable("tabulated-list-padding", 0);
    e8.addHook("tabulated-list-revert-hook", magitRepolistRefresh, { local: true });
  },
});
e8.remapCommand("magit-repolist-mode-map", "dired-jump" as e8.CommandName, "magit-dired-jump" as e8.CommandName);

/** Shows the list of repositories with COLUMNS in *Magit Repositories*, as magit-repolist-setup. */
export function magitRepolistSetup(columns: RepolistColumn[]): void {
  const dirs = e8.variable("magit-repository-directories");
  if (!Array.isArray(dirs) || dirs.length === 0) e8.userError("You need to customize `magit-repository-directories' before you can list repositories");
  const name = "*Magit Repositories*";
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    e8.call(magitRepolistMode);
    e8.makeLocalVariable("magit-repolist-columns");
    e8.setVariable("magit-repolist-columns", columns as unknown as e8.Value);
    magitRepolistSetup1();
    magitRepolistRefresh();
  });
  e8.call("switch-to-buffer", name);
}

/** The cell of column IDX of a tabulated list entry, as a string. */
const cell = (entry: e8.Value, idx: number): string => String(((entry as e8.Value[])[1] as e8.Value[])[idx] ?? "");

/**
 * A sorter for tabulated lists from SORT-PREDICATE on the cells of column
 * COLUMN-IDX, each turned by CONVERT-CELL first, as magit-repolist-make-sorter.
 */
export function magitRepolistMakeSorter<T>(sortPredicate: (a: T, b: T) => boolean, convertCell: (s: string) => T, columnIdx: number): (a: e8.Value, b: e8.Value) => boolean {
  return (a, b) => sortPredicate(convertCell(cell(a, columnIdx)), convertCell(cell(b, columnIdx)));
}

/** Sets the list's format and sort key from magit-repolist-columns, as magit-repolist-setup-1. */
export function magitRepolistSetup1(): void {
  const columns = (e8.variable("magit-repolist-columns") as unknown as RepolistColumn[] | null) ?? [];
  if (!truthy(e8.variable("tabulated-list-sort-key"))) {
    const key = e8.variable("magit-repolist-sort-key") as e8.Value[] | null;
    if (Array.isArray(key) && key.length > 0) {
      const column = columns.find((c) => c[0] === key[0])?.[0] ?? columns[0]?.[0];
      e8.setVariable("tabulated-list-sort-key", [column ?? null, key[1] ?? false]);
    }
  }
  const sym = (s: string) => Symbol.for(s) as unknown as e8.Value;
  e8.setVariable(
    "tabulated-list-format",
    columns.map(([title, width, , props], idx) => {
      const sortSet = (props ?? []).find((p) => p[0] === ":sort");
      const sortFn = sortSet?.[1];
      const sort: e8.Value =
        sortFn === "<"
          ? magitRepolistMakeSorter((a: number, b: number) => a < b, stringToNumber, idx)
          : sortFn === "magit-repolist-version<"
            ? magitRepolistMakeSorter(magitRepolistVersionLess, (s) => s, idx)
            : truthy(sortFn)
              ? (sortFn as e8.Value)
              : sortSet
                ? false
                : true;
      return [title, width, sort, ...(props ?? []).filter((p) => p[0] !== ":sort").flatMap(([k, v]) => [sym(k), v])];
    }),
  );
}

/** The number a string starts with, or 0, as string-to-number. */
const stringToNumber = (s: string): number => Number(/^\s*[-+]?[0-9]*\.?[0-9]+/.exec(s)?.[0] ?? 0);

/** Lists the repositories afresh, as magit-repolist-refresh. */
export function magitRepolistRefresh(): void {
  const columns = (e8.variable("magit-repolist-columns") as unknown as RepolistColumn[] | null) ?? [];
  const entries: e8.Value[] = [];
  for (const [id, path] of magitReposAlist()) {
    inDirectory(path, () => {
      entries.push([
        path,
        columns.map(([title, width, fn, props]) => {
          const spec: RepolistSpec = [[":id", id], [":title", title], [":width", width], ...(props ?? [])];
          const r = typeof fn === "function" ? fn(spec) : e8.funcall(fn, spec as unknown as e8.Value);
          return truthy(r as e8.Value) ? (r as e8.Value) : "";
        }),
      ]);
    });
  }
  e8.setVariable("tabulated-list-entries", entries);
  e8.message("Listing repositories...");
  tabulatedListInitHeader();
  tabulatedListPrint(true);
  e8.message("Listing repositories...done");
}

// Columns.

/** TEXT with FACES, one per character or undefined, as a string with face runs. */
function withFaces(text: string, faces: (string | undefined)[]): e8.PropertizedString {
  const runs: [number, number, { [name: string]: e8.Value }][] = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; ) {
    const face = faces[i];
    let j = i + 1;
    while (j < chars.length && faces[j] === face) j++;
    if (face !== undefined) runs.push([i, j, { face }]);
    i = j;
  }
  return new e8.PropertizedString(text, runs);
}

/** Insert the identification of the repository.  Usually this is just its basename. */
export const magitRepolistColumnIdent = (spec: RepolistSpec): e8.Value | undefined => specGet(spec, ":id");
e8.defun("magit-repolist-column-ident", magitRepolistColumnIdent);

/** Insert the absolute path of the repository. */
export const magitRepolistColumnPath = (): string => e8.abbreviateFileName(defaultDirectory());
e8.defun("magit-repolist-column-path", magitRepolistColumnPath);

e8.defineVariable({
  name: "magit-repolist-column-version-regexp",
  doc: "What magit-repolist-column-version shows in shadow after a release: the commits since it, the hash and -dirty.",
  value: "\\(?1:-\\(?2:[0-9]*\\)\\(?3:-g[a-z0-9]*\\)\\)?\\(?:-\\(?4:dirty\\)\\)?\\'",
});
e8.defineVariable({ name: "magit-repolist-column-version-resume-regexp", doc: "The message of a commit that resumes development after a release, which magit-repolist-column-version shows as +.", value: "\\`Resume development\\'" });

/** Insert a description of the repository's HEAD revision. */
export function magitRepolistColumnVersion(): e8.PropertizedString | undefined {
  let v = magitGitString("describe", "--tags", "--dirty") ?? magitRevFormat("%cd-g%h", "HEAD", "--date=format:%Y%m%d.%H%M");
  if (!v) return undefined;
  const chars = Array.from(v);
  let faces: (string | undefined)[] = chars.map(() => undefined);
  const re = String(e8.variable("magit-repolist-column-version-regexp"));
  if (e8.stringMatch(re, v) !== undefined) {
    const b = (n: number) => e8.matchBeginning(n);
    const e = (n: number) => e8.matchEnd(n);
    const put = (from: number, to: number, face: string) => {
      for (let i = from; i < to; i++) faces[i] = face;
    };
    put(b(0)!, e(0)!, "shadow");
    if (e(2) !== undefined) put(b(2)!, e(2)!, "bold");
    if (e(4) !== undefined) put(b(3) ?? b(4)!, e(4)!, "error");
    const resume = String(e8.variable("magit-repolist-column-version-resume-regexp"));
    if (e8.matchString(2, v) === "1" && e8.stringMatch(resume, magitRevFormat("%s") ?? "") !== undefined) {
      e8.stringMatch(re, v);
      const [s1, e1] = [b(1)!, e(1)!];
      v = chars.slice(0, s1).join("") + "+" + chars.slice(e1).join("");
      faces = [...faces.slice(0, s1), "shadow", ...faces.slice(e1)];
    }
  }
  if (/^[0-9]/.test(v)) return withFaces(` ${v}`, [undefined, ...faces]);
  const prefix = /^[^0-9]+/.exec(v);
  if (prefix) {
    for (let i = 0; i < Array.from(prefix[0]).length; i++) faces[i] = "shadow";
    return withFaces(v, faces);
  }
  return undefined;
}
e8.defun("magit-repolist-column-version", magitRepolistColumnVersion);

/** Whether version A is below version B, comparing the first dotted numbers in them, as magit-repolist-version<. */
export function magitRepolistVersionLess(a: string, b: string): boolean {
  const re = /[0-9]+(\.[0-9]*)*/;
  const x = re.exec(a)?.[0];
  const y = re.exec(b)?.[0];
  if (x !== undefined && y !== undefined) {
    const xs = x.split(".").map((n) => Number(n || 0));
    const ys = y.split(".").map((n) => Number(n || 0));
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) if ((xs[i] ?? 0) !== (ys[i] ?? 0)) return (xs[i] ?? 0) < (ys[i] ?? 0);
    return false;
  }
  return y === undefined;
}
e8.defun("magit-repolist-version<", magitRepolistVersionLess);

/** Insert the current branch. */
export function magitRepolistColumnBranch(): string | e8.PropertizedString | undefined {
  const branch = magitGetCurrentBranch();
  const main = ((e8.variable("magit-main-branch-names") as string[] | null) ?? []).map(String);
  return branch !== undefined && main.includes(branch) ? e8.propertize(branch, { face: "shadow" }) : branch;
}
e8.defun("magit-repolist-column-branch", magitRepolistColumnBranch);

/** Insert the upstream branch of the current branch. */
export const magitRepolistColumnUpstream = (): string | undefined => magitGetUpstreamBranch();
e8.defun("magit-repolist-column-upstream", magitRepolistColumnUpstream);

/**
 * Insert a flag as specified by magit-repolist-column-flag-alist.
 *
 * By default this indicates whether there are uncommitted changes: N if
 * there is at least one untracked file, U if there is at least one
 * unstaged file, S if there is at least one staged file.  Only one letter
 * is shown, the first that applies.
 */
export function magitRepolistColumnFlag(): string | undefined {
  for (const [fn, flag] of flagAlist()) if (nonNil(e8.funcall(fn))) return flag;
  return undefined;
}
e8.defun("magit-repolist-column-flag", magitRepolistColumnFlag);

/** Insert all flags as specified by magit-repolist-column-flag-alist.  This is an alternative to function magit-repolist-column-flag, which only lists the first one found. */
export const magitRepolistColumnFlags = (): string => flagAlist().map(([fn, flag]) => (nonNil(e8.funcall(fn)) ? flag : " ")).join("");
e8.defun("magit-repolist-column-flags", magitRepolistColumnFlags);

const flagAlist = (): [string, string][] => ((e8.variable("magit-repolist-column-flag-alist") as unknown as [string, string][] | null) ?? []).map(([f, s]) => [String(f), String(s)]);

/** Insert number of upstream commits not in the current branch. */
export function magitRepolistColumnUnpulledFromUpstream(spec: RepolistSpec): e8.PropertizedString | undefined {
  const u = magitGetUpstreamBranch();
  return u ? magitRepolistInsertCount(magitRevDiffCount("HEAD", u)[1], spec) : undefined;
}
e8.defun("magit-repolist-column-unpulled-from-upstream", magitRepolistColumnUnpulledFromUpstream);

/** Insert number of commits in the push branch but not the current branch. */
export function magitRepolistColumnUnpulledFromPushremote(spec: RepolistSpec): e8.PropertizedString | undefined {
  const p = magitGetPushBranch(undefined, true);
  return p ? magitRepolistInsertCount(magitRevDiffCount("HEAD", p)[1], spec) : undefined;
}
e8.defun("magit-repolist-column-unpulled-from-pushremote", magitRepolistColumnUnpulledFromPushremote);

/** Insert number of commits in the current branch but not its upstream. */
export function magitRepolistColumnUnpushedToUpstream(spec: RepolistSpec): e8.PropertizedString | undefined {
  const u = magitGetUpstreamBranch();
  return u ? magitRepolistInsertCount(magitRevDiffCount("HEAD", u)[0], spec) : undefined;
}
e8.defun("magit-repolist-column-unpushed-to-upstream", magitRepolistColumnUnpushedToUpstream);

/** Insert number of commits in the current branch but not its push branch. */
export function magitRepolistColumnUnpushedToPushremote(spec: RepolistSpec): e8.PropertizedString | undefined {
  const p = magitGetPushBranch(undefined, true);
  return p ? magitRepolistInsertCount(magitRevDiffCount("HEAD", p)[0], spec) : undefined;
}
e8.defun("magit-repolist-column-unpushed-to-pushremote", magitRepolistColumnUnpushedToPushremote);

/** Insert number of branches. */
export const magitRepolistColumnBranches = (spec: RepolistSpec): e8.PropertizedString => magitRepolistInsertCount(magitListLocalBranches().length, [[":normal-count", 1], ...spec]);
e8.defun("magit-repolist-column-branches", magitRepolistColumnBranches);

/** Insert number of stashes. */
export const magitRepolistColumnStashes = (spec: RepolistSpec): e8.PropertizedString => magitRepolistInsertCount(magitListStashes().length, spec);
e8.defun("magit-repolist-column-stashes", magitRepolistColumnStashes);

/** N, bold above the column's :normal-count and shadow otherwise, "+" above 9 in a column one wide, as magit-repolist-insert-count. */
export function magitRepolistInsertCount(n: number, spec: RepolistSpec): e8.PropertizedString {
  const text = n > 9 && Number(specGet(spec, ":width")) === 1 ? "+" : String(n);
  return e8.propertize(text, { face: n > Number(specGet(spec, ":normal-count") ?? 0) ? "bold" : "shadow" });
}

// Reading a repository.

/**
 * Reads a Git repository in the minibuffer, with completion, as
 * magit-read-repository: the basenames of the repositories
 * magit-repository-directories finds, prefixed with their parents' names
 * where they clash. Gives the repository's directory. With
 * READ-DIRECTORY-NAME, or if none are found, reads any directory instead.
 */
export function magitReadRepository(readDirectoryName = false): string {
  const repos = !readDirectoryName && nonNil(e8.variable("magit-repository-directories")) ? magitReposAlist() : [];
  if (repos.length > 0) {
    const reply = magitCompletingRead("Git repository", repos.map(([name]) => name), { requireMatch: "any" })!;
    const found = repos.find(([name]) => name === reply)?.[1];
    if (found !== undefined) return e8.fileNameAsDirectory(found);
    const dir = e8.expandFileName(reply);
    if (e8.fileDirectoryP(dir)) return e8.fileNameAsDirectory(dir);
    e8.userError(`Not a repository or a directory: ${reply}`);
  }
  return e8.fileNameAsDirectory(e8.expandFileName(e8.readFileName("Git repository: ", { dir: magitToplevel() ?? defaultDirectory() })));
}
e8.defun("magit-read-repository", (readDirectoryName?: e8.Value) => magitReadRepository(truthy(readDirectoryName)));

/** The repositories magit-repository-directories names, each its directory, as magit-list-repos. */
export function magitListRepos(): string[] {
  const dirs = (e8.variable("magit-repository-directories") as unknown as [string, number][] | null) ?? [];
  return dirs.flatMap(([dir, depth]) => magitListReposOne(e8.expandFileName(String(dir)), Number(depth)));
}

/** The repositories in DIRECTORY, looking DEPTH directories down, as magit-list-repos-1. */
function magitListReposOne(directory: string, depth: number): string[] {
  if (e8.fileReadableP(e8.expandFileName(".git", directory))) return [e8.fileNameAsDirectory(directory)];
  if (depth > 0 && e8.fileAccessibleDirectoryP(directory)) {
    return e8
      .directoryFiles(directory, { full: true })
      .filter((f) => !/\/\.\.?$/.test(f) && e8.fileDirectoryP(f))
      .flatMap((f) => magitListReposOne(f, depth - 1));
  }
  return [];
}

/**
 * Names each repository of ALIST, [basename, directory] pairs, uniquely:
 * where names clash, by its parent directories' names after a backslash,
 * as magit-list-repos-uniquify.
 */
export function magitListReposUniquify(alist: [string, string][]): [string, string][] {
  let result: [string, string][] = [];
  const dict = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const [key, value] of alist) {
    if (seen.has(`${key}\0${value}`)) continue;
    seen.add(`${key}\0${value}`);
    dict.set(key, [value, ...(dict.get(key) ?? [])]);
  }
  for (const [key, values] of dict) {
    if (values.length === 1) result.unshift([key, values[0]]);
    else
      result = result.concat(
        magitListReposUniquify(
          values.map((v) => {
            const parent = Array.from(v).slice(0, -(Array.from(key).length + 1)).join("");
            return [`${key}\\${e8.fileNameNondirectory(e8.directoryFileName(parent))}`, v];
          }),
        ),
      );
  }
  return result;
}

/** Each repository magit-repository-directories finds, [name, directory], as magit-repos-alist. */
export const magitReposAlist = (): [string, string][] =>
  magitListReposUniquify(magitListRepos().map((d) => [e8.fileNameNondirectory(e8.directoryFileName(d)), d]));

// The button keys tabulated-list-mode-map has in Emacs, from button-buffer-map, which E8's lacks.
for (const [key, command] of [
  ["TAB", "forward-button"],
  ["<backtab>", "backward-button"],
  ["C-M-i", "backward-button"],
] as const)
  e8.defineKey("magit-repolist-mode-map", key, command as e8.CommandName);
