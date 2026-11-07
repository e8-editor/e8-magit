// SPDX-License-Identifier: GPL-3.0-or-later
//
// Running git and asking it about the repository, after magit-git.el:
// git's output as a string, lines or items; the configuration; the
// repository, its files, revisions, refs, branches, upstreams and push
// targets, remotes, tags and stashes; what is at point in a Magit buffer;
// and reading branches, commits, ranges, remotes, tags and stashes with
// completion. A refresh of Magit's buffers runs inside magitWithRefreshCache,
// so each question is put to git once a refresh, as Magit caches them.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, type Section } from "magit-section";
import { magitCompletingRead } from "magit-base";

e8.defineVariable({ name: "magit-git-executable", doc: "The Git executable used by Magit.", value: "git" });
e8.defineVariable({
  name: "magit-git-global-arguments",
  doc: "Global Git arguments, placed after the executable and before the git command every time Magit runs git.",
  value: ["--no-pager", "--literal-pathspecs", "-c", "core.preloadindex=true", "-c", "log.showSignature=false", "-c", "color.ui=false", "-c", "color.diff=false", "-c", "diff.noPrefix=false"],
});
e8.defineVariable({ name: "magit-prefer-remote-upstream", doc: "Whether to favor remote branches when reading the upstream branch.", value: false });
e8.defineVariable({ name: "magit-list-refs-namespaces", doc: "List of ref namespaces considered when reading a ref.", value: ["refs/heads", "refs/remotes", "refs/tags"] });
e8.defineVariable({ name: "magit-list-refs-sortby", doc: "How to sort the ref collection in the prompt: a --sort key of git for-each-ref, or a list of them.", value: null });
e8.defineVariable({ name: "magit-primary-remote-names", doc: "Names of the remote that other repositories are forked from, in order of preference.", value: ["upstream", "origin"] });
e8.defineVariable({ name: "magit-main-branch-names", doc: "Branch names reserved for use by the primary branch.", value: ["main", "master", "trunk", "development"] });
e8.defineVariable({ name: "magit-revision-history", doc: "Branches and commits Magit read.", value: [] });
e8.defineVariable({ name: "magit-git-debug", doc: "Whether additional git errors are reported.", value: false });

// The refresh cache.

/** What a refresh has asked git, and how often the cache answered: hits and misses. */
interface RefreshCache {
  hits: number;
  misses: number;
  values: Map<string, unknown>;
}
let refreshCache: RefreshCache | undefined;

/** Runs BODY with git's answers cached, as magit-refresh binds magit--refresh-cache; gives the cache's counts afterwards. */
export function magitWithRefreshCache<T>(body: () => T): T {
  if (refreshCache) return body();
  refreshCache = { hits: 0, misses: 0, values: new Map() };
  try {
    return body();
  } finally {
    lastRefreshCache = { hits: refreshCache.hits, misses: refreshCache.misses };
    refreshCache = undefined;
  }
}
let lastRefreshCache = { hits: 0, misses: 0 };
/** The hits and misses of the last refresh's cache. */
export const magitRefreshCacheStats = (): { hits: number; misses: number } => lastRefreshCache;

/** BODY's value, cached by KEY while a refresh cache is active, as magit--with-refresh-cache. */
export function magitWithCache<T>(key: string, body: () => T): T {
  if (!refreshCache) return body();
  if (refreshCache.values.has(key)) {
    refreshCache.hits++;
    return refreshCache.values.get(key) as T;
  }
  refreshCache.misses++;
  const value = body();
  refreshCache.values.set(key, value);
  return value;
}

// Running git.

const defaultDirectory = (): string => String(e8.variable("default-directory") ?? ".");

/** The git executable, as magit-git-executable names it. */
export const magitGitExecutable = (): string => String(e8.variable("magit-git-executable") ?? "git");

/** ARGS flattened, without undefined and false, and after magit-git-global-arguments, as magit-process-git-arguments. */
export function magitProcessGitArguments(args: GitArg[]): string[] {
  const global = (e8.variable("magit-git-global-arguments") as string[] | null) ?? [];
  return [...global.map(String), ...flatten(args)];
}

export type GitArg = string | undefined | null | false | GitArg[];
const flatten = (args: GitArg[]): string[] => args.flatMap((a) => (Array.isArray(a) ? flatten(a) : a === undefined || a === null || a === false ? [] : [a]));

/** Runs git with ARGS in DIR, the current directory by default: its exit code and output. */
export function magitGitRun(args: GitArg[], options: { input?: string; dir?: string } = {}): { exit: number; output: string } {
  return e8.callProcess([magitGitExecutable(), ...magitProcessGitArguments(args)], { directory: e8.expandFileName(options.dir ?? defaultDirectory()), input: options.input });
}

/** Git's exit code for ARGS, as magit-git-exit-code. */
export const magitGitExitCode = (...args: GitArg[]): number => magitGitRun(args).exit;
/** Whether git succeeds with ARGS, as magit-git-success. */
export const magitGitSuccess = (...args: GitArg[]): boolean => magitGitExitCode(...args) === 0;
/** Whether git fails with ARGS, as magit-git-failure. */
export const magitGitFailure = (...args: GitArg[]): boolean => magitGitExitCode(...args) === 1;

/** Git's output for ARGS, all of it, or "" if it fails, as magit-git-output. */
export function magitGitOutput(...args: GitArg[]): string {
  const r = magitGitRun(args);
  return r.exit === 0 ? r.output : "";
}

/** The first line of git's output for ARGS, cached during a refresh, or undefined without output, as magit-git-string. */
export function magitGitString(...args: GitArg[]): string | undefined {
  const flat = flatten(args);
  return magitWithCache(`${defaultDirectory()}\0string\0${flat.join("\0")}`, () => {
    const r = magitGitRun(flat);
    if (r.exit !== 0 || r.output === "") return undefined;
    return r.output.split("\n")[0];
  });
}

/** As magitGitString, uncached, as magit-git-str. */
export function magitGitStr(...args: GitArg[]): string | undefined {
  const r = magitGitRun(args);
  if (r.exit !== 0 || r.output === "") return undefined;
  return r.output.split("\n")[0];
}

/** Git's output for ARGS as lines, empty ones left out, as magit-git-lines. */
export function magitGitLines(...args: GitArg[]): string[] {
  const r = magitGitRun(args);
  return r.exit === 0 ? r.output.split("\n").filter((l) => l !== "") : [];
}

/** Git's NUL-separated output for ARGS as items, empty ones left out, as magit-git-items. */
export function magitGitItems(...args: GitArg[]): string[] {
  const r = magitGitRun(args);
  return r.exit === 0 ? r.output.split("\0").filter((l) => l !== "") : [];
}

/** Whether git's output for ARGS is "true", as magit-git-true. */
export const magitGitTrue = (...args: GitArg[]): boolean => magitGitString(...args) === "true";
/** Whether git's output for ARGS is "false", as magit-git-false. */
export const magitGitFalse = (...args: GitArg[]): boolean => magitGitString(...args) === "false";

// The configuration.

/** The configuration as git config --list gives it, cached during a refresh, as magit-config-get-from-cached-list. */
function configList(): Map<string, string[]> {
  return magitWithCache(`${magitToplevel() ?? defaultDirectory()}\0config`, () => {
    const configs = new Map<string, string[]>();
    for (const conf of magitGitItems("config", "--list", "-z")) {
      const nl = conf.indexOf("\n");
      const key = nl < 0 ? conf : conf.slice(0, nl);
      const val = nl < 0 ? "" : conf.slice(nl + 1);
      configs.set(key, [...(configs.get(key) ?? []), val]);
    }
    return configs;
  });
}

/** A key as git config --list writes it: its first and last components downcased. */
const canonicalKey = (key: string): string => key.replace(/^[^.]+/, (m) => m.toLowerCase()).replace(/[^.]+$/, (m) => m.toLowerCase());

/** Splits off a leading option such as --global from KEYS. */
function configArgs(keys: string[]): [string | undefined, string] {
  const arg = keys[0]?.startsWith("--") ? keys[0] : undefined;
  return [arg, (arg ? keys.slice(1) : keys).join(".")];
}

/** All values of the git variable KEYS names, as magit-get-all. */
export function magitGetAll(...keys: string[]): string[] {
  const [arg, key] = configArgs(keys);
  if (refreshCache && !arg) return configList().get(canonicalKey(key)) ?? [];
  return magitGitItems("config", arg, "-z", "--get-all", "--include", key).map((v) => v.replace(/\n$/, ""));
}

/** The value of the git variable KEYS names, the last if several, as magit-get. */
export function magitGet(...keys: string[]): string | undefined {
  const all = magitGetAll(...keys);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/** Whether the git variable KEYS names is true, as magit-get-boolean. */
export function magitGetBoolean(...keys: string[]): boolean {
  const [arg, key] = configArgs(keys);
  if (refreshCache && !arg) {
    const v = configList().get(canonicalKey(key));
    return v !== undefined && ["true", "yes", "on", "1", ""].includes(v[v.length - 1].toLowerCase());
  }
  return magitGitStr("config", arg, "--bool", "--include", key) === "true";
}

/** Sets the git variable KEYS names to VALUE, or unsets it for undefined, as magit-set; gives VALUE. */
export function magitSet(value: string | undefined, ...keys: string[]): string | undefined {
  const [arg, key] = configArgs(keys);
  if (value !== undefined) magitGitSuccess("config", arg, key, value);
  else magitGitSuccess("config", arg, "--unset", key);
  return value;
}

/** Sets all values of the git variable KEYS names to VALUES, as magit-set-all. */
export function magitSetAll(values: string[], ...keys: string[]): void {
  const [arg, key] = configArgs(keys);
  if (magitGet(key) !== undefined) magitGitSuccess("config", arg, "--unset-all", key);
  for (const v of values) magitGitSuccess("config", arg, "--add", key, v);
}

// The repository.

/** The repository's top directory, with a slash, for DIRECTORY or default-directory, as magit-toplevel. */
export function magitToplevel(directory?: string): string | undefined {
  // The nearest directory that exists, as magit--with-safe-default-directory.
  let dir = e8.expandFileName(directory ?? defaultDirectory());
  while (!e8.fileDirectoryP(dir) && e8.fileNameDirectory(e8.directoryFileName(dir)) !== dir) dir = e8.fileNameDirectory(e8.directoryFileName(dir)) ?? "/";
  return magitWithCache(`${dir}\0toplevel`, () => {
    const r = e8.callProcess([magitGitExecutable(), "rev-parse", "--show-toplevel"], { directory: dir });
    if (r.exit === 0 && r.output.trim() !== "") return e8.fileNameAsDirectory(r.output.trim());
    // A bare repository, or inside the .git directory: its git directory.
    const g = e8.callProcess([magitGitExecutable(), "rev-parse", "--is-bare-repository"], { directory: dir });
    if (g.exit === 0 && g.output.trim() === "true") {
      const d = e8.callProcess([magitGitExecutable(), "rev-parse", "--absolute-git-dir"], { directory: dir });
      return d.exit === 0 ? e8.fileNameAsDirectory(d.output.trim()) : undefined;
    }
    return undefined;
  });
}

/** The repository's git directory, with a slash, as magit-gitdir. */
export function magitGitdir(directory?: string): string | undefined {
  const dir = e8.expandFileName(directory ?? defaultDirectory());
  return magitWithCache(`${dir}\0gitdir`, () => {
    const r = e8.callProcess([magitGitExecutable(), "rev-parse", "--absolute-git-dir"], { directory: dir });
    return r.exit === 0 ? e8.fileNameAsDirectory(r.output.trim()) : undefined;
  });
}

/** The top directory, or an error that this is not a repository, as Magit's commands need one. */
export function magitToplevelOrError(): string {
  const top = magitToplevel();
  if (!top) e8.userError(`Not inside a Git repository: ${e8.abbreviateFileName(defaultDirectory())}`);
  return top!;
}

/** Whether default-directory is inside a work tree, as magit-inside-worktree-p. */
export const magitInsideWorktreeP = (): boolean => magitGitTrue("rev-parse", "--is-inside-work-tree");
/** Whether default-directory is inside the git directory, as magit-inside-gitdir-p. */
export const magitInsideGitdirP = (): boolean => magitGitTrue("rev-parse", "--is-inside-git-dir");
/** Whether the repository is bare, as magit-bare-repo-p. */
export const magitBareRepoP = (): boolean => magitGitTrue("rev-parse", "--is-bare-repository");
/** Whether DIRECTORY holds a repository, as magit-git-repo-p. */
export const magitGitRepoP = (directory: string): boolean => e8.fileExistsP(e8.expandFileName(".git", directory));

/** FILE relative to the repository's top, as magit-file-relative-name. */
export function magitFileRelativeName(file?: string): string | undefined {
  const f = file ?? e8.bufferFileName();
  const top = magitToplevel();
  if (!f || !top) return undefined;
  const abs = e8.expandFileName(f);
  return abs.startsWith(top) ? abs.slice(top.length) : undefined;
}

// Files.

/** Files git ls-files lists with ARGS, as magit-list-files. */
export const magitListFiles = (...args: GitArg[]): string[] => magitGitItems("ls-files", "-z", "--full-name", ...args);
/** The files git tracks, as magit-tracked-files. */
export const magitTrackedFiles = (): string[] => magitListFiles("--cached");
/** The files git does not track and does not ignore, as magit-untracked-files. */
export function magitUntrackedFiles(all = false, files?: string[]): string[] {
  return magitListFiles("--other", all ? undefined : "--exclude-standard", "--", ...(files ?? []));
}
/** The files git ignores, as magit-ignored-files. */
export const magitIgnoredFiles = (): string[] => magitListFiles("--others", "--ignored", "--exclude-standard", "--directory");
/** The files changed in the work tree, staged or not, as magit-modified-files. */
export const magitModifiedFiles = (nomodules = false, files?: string[]): string[] => magitGitItems("diff-index", "-z", "--name-only", nomodules ? "--ignore-submodules" : undefined, "--diff-filter=u", magitHeadishOrEmptyTree(), "--", ...(files ?? []));
/** The files changed and not staged, as magit-unstaged-files. */
export const magitUnstagedFiles = (nomodules = false, files?: string[]): string[] => magitGitItems("diff-files", "-z", "--name-only", "--diff-filter=u", nomodules ? "--ignore-submodules" : undefined, "--", ...(files ?? []));
/** The files staged, as magit-staged-files. */
export const magitStagedFiles = (nomodules = false, files?: string[]): string[] => magitGitItems("diff-index", "-z", "--name-only", "--cached", nomodules ? "--ignore-submodules" : undefined, magitHeadishOrEmptyTree(), "--", ...(files ?? []));
/** The binary files changed by a diff of ARGS, as magit-binary-files. */
export const magitBinaryFiles = (...args: GitArg[]): string[] =>
  magitGitLines("diff", ...args, "--numstat", "-z")
    .join("\0")
    .split("\0")
    .filter((l) => l.startsWith("-\t-\t"))
    .map((l) => l.slice(4));
/** The files with conflicts, as magit-unmerged-files. */
export const magitUnmergedFiles = (): string[] => magitGitItems("diff-files", "-z", "--name-only", "--diff-filter=U");
/** The files marked skip-worktree, as magit-skip-worktree-files. */
export const magitSkipWorktreeFiles = (): string[] => magitListFiles("-t").filter((l) => l.startsWith("S ")).map((l) => l.slice(2));
/** The files marked assume-unchanged, as magit-assume-unchanged-files. */
export const magitAssumeUnchangedFiles = (): string[] => magitListFiles("-v").filter((l) => /^[a-z] /.test(l)).map((l) => l.slice(2));
/** The files at REV, as magit-revision-files. */
export const magitRevisionFiles = (rev: string): string[] => magitGitItems("ls-tree", "-z", "-r", "--name-only", rev);
/** The directories at REV, as magit-revision-directories. */
export const magitRevisionDirectories = (rev: string): string[] => magitGitItems("ls-tree", "-z", "-r", "-d", "--name-only", rev);
/** The files changed between REV-OR-RANGE and the work tree, or OTHER-REV, as magit-changed-files. */
export const magitChangedFiles = (revOrRange: string, otherRev?: string): string[] => magitGitItems("diff", "-z", "--name-only", revOrRange, otherRev);
/** The renames between REV-A and REV-B as [from, to] pairs, as magit-renamed-files. */
export function magitRenamedFiles(revA: string, revB: string): [string, string][] {
  const items = magitGitItems("diff-tree", "-r", "--diff-filter=R", "-z", "-M", revA, revB);
  const out: [string, string][] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].startsWith(":")) {
      out.push([items[i + 1], items[i + 2]]);
      i += 2;
    }
  }
  return out;
}
/** FILE's status as git status --porcelain gives it, as magit-file-status. */
export const magitFileStatus = (...args: GitArg[]): string[] => magitGitItems("status", "--porcelain", "-z", "--", ...args);
/** Whether git tracks FILE, as magit-file-tracked-p. */
export const magitFileTrackedP = (file: string): boolean => magitGitSuccess("ls-files", "--error-unmatch", "--", file);
/** Whether git ignores FILE, as magit-file-ignored-p. */
export const magitFileIgnoredP = (file: string): boolean => magitGitString("ls-files", "--others", "--ignored", "--exclude-standard", "--", file) !== undefined;

/** HEAD, or the empty tree in a repository without commits. */
export const magitHeadishOrEmptyTree = (): string => (magitRevVerify("HEAD") ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904");

/** Whether there is no commit yet, as magit-no-commit-p. */
export const magitNoCommitP = (): boolean => !magitRevVerify("HEAD");
/** Whether COMMIT is a merge, as magit-merge-commit-p. */
export const magitMergeCommitP = (commit: string): boolean => magitCommitParents(commit).length > 1;
/** Whether anything is staged, as magit-anything-staged-p. */
export const magitAnythingStagedP = (...files: string[]): boolean => magitGitFailure("diff", "--quiet", "--cached", "--", ...files);
/** Whether anything is unstaged, as magit-anything-unstaged-p. */
export const magitAnythingUnstagedP = (...files: string[]): boolean => magitGitFailure("diff", "--quiet", "--", ...files);
/** Whether anything is modified, staged or not, as magit-anything-modified-p. */
export const magitAnythingModifiedP = (...files: string[]): boolean => magitAnythingUnstagedP(...files) || magitAnythingStagedP(...files);
/** Whether any file has conflicts, as magit-anything-unmerged-p. */
export const magitAnythingUnmergedP = (...files: string[]): boolean => magitGitItems("ls-files", "-z", "--unmerged", "--", ...files).length > 0;

// What is going on: rebases, merges and the rest, after magit-sequence.el's predicates.

const inGitdir = (...names: string[]): boolean => {
  const g = magitGitdir();
  return g !== undefined && names.some((n) => e8.fileExistsP(e8.expandFileName(n, g)));
};
/** Whether a rebase is going on, as magit-rebase-in-progress-p. */
export const magitRebaseInProgressP = (): boolean => inGitdir("rebase-merge", "rebase-apply/onto");
/** Whether git am is going on, as magit-am-in-progress-p. */
export const magitAmInProgressP = (): boolean => inGitdir("rebase-apply/applying");
/** Whether a merge is going on, as magit-merge-in-progress-p. */
export const magitMergeInProgressP = (): boolean => inGitdir("MERGE_HEAD");
/** Whether a cherry-pick is going on, as magit-cherry-pick-in-progress-p. */
export const magitCherryPickInProgressP = (): boolean => inGitdir("CHERRY_PICK_HEAD") || (inGitdir("sequencer/todo") && /^pick/m.test(sequencerTodo()));
/** Whether a revert is going on, as magit-revert-in-progress-p. */
export const magitRevertInProgressP = (): boolean => inGitdir("REVERT_HEAD") || (inGitdir("sequencer/todo") && /^revert/m.test(sequencerTodo()));
/** Whether git bisect is going on, as magit-bisect-in-progress-p. */
export const magitBisectInProgressP = (): boolean => inGitdir("BISECT_LOG");
/** Whether a cherry-pick or revert is going on, as magit-sequencer-in-progress-p. */
export const magitSequencerInProgressP = (): boolean => magitCherryPickInProgressP() || magitRevertInProgressP();
function sequencerTodo(): string {
  const g = magitGitdir();
  const f = g && e8.expandFileName("sequencer/todo", g);
  return f && e8.fileExistsP(f) ? e8.readTextFile(f) : "";
}

// Revisions.

/** git rev-parse's answer for ARGS, as magit-rev-parse. */
export const magitRevParse = (...args: GitArg[]): string | undefined => magitGitString("rev-parse", ...args);
/** As magitRevParse, quietly, as magit-rev-parse-safe. */
export const magitRevParseSafe = (...args: GitArg[]): string | undefined => magitGitStr("rev-parse", ...args);
/** Whether git rev-parse says true for ARGS, as magit-rev-parse-true. */
export const magitRevParseTrue = (...args: GitArg[]): boolean => magitGitTrue("rev-parse", ...args);
/** Whether git rev-parse says false for ARGS, as magit-rev-parse-false. */
export const magitRevParseFalse = (...args: GitArg[]): boolean => magitGitFalse("rev-parse", ...args);
/** Whether git rev-parse succeeds for ARGS, as magit-rev-parse-p. */
export const magitRevParseP = (...args: GitArg[]): boolean => magitGitSuccess("rev-parse", ...args);
/** REV's full hash if it names an object, as magit-rev-verify. */
export const magitRevVerify = (rev: string): string | undefined => magitGitString("rev-parse", "-q", "--verify", rev);
/** REV's full hash if it names a commit, as magit-commit-p. */
export const magitCommitP = (rev: string): string | undefined => magitRevVerify(`${rev}^{commit}`);
/** Whether A and B name the same commit, as magit-rev-equal. */
export const magitRevEqual = (a: string, b: string): boolean => magitGitSuccess("diff", "--quiet", a, b);
/** Whether A and B name the same object, as magit-rev-eq. */
export function magitRevEq(a: string, b: string): boolean {
  const x = magitRevVerify(a);
  return x !== undefined && x === magitRevVerify(b);
}
/** Whether A is an ancestor of B, as magit-rev-ancestor-p. */
export const magitRevAncestorP = (a: string, b: string): boolean => magitGitSuccess("merge-base", "--is-ancestor", a, b);
/** Whether REV is HEAD, as magit-rev-head-p. */
export const magitRevHeadP = (rev: string): boolean => rev === "HEAD" || (magitRevVerify(rev) !== undefined && magitRevVerify(rev) === magitRevVerify("HEAD"));
/** A symbolic name for REV, as git name-rev gives it, as magit-rev-name. */
export function magitRevName(rev: string, pattern?: string, notAnchored = false): string | undefined {
  const name = magitGitString("name-rev", "--name-only", "--no-undefined", pattern ? `--refs=${notAnchored ? pattern : pattern}` : undefined, rev);
  return name?.replace(/\^0$/, "");
}
/** The branch REV is the tip of, as magit-rev-branch. */
export function magitRevBranch(rev: string): string | undefined {
  const name = magitRevName(rev, "refs/heads/*");
  return name && !/[~^]/.test(name) ? name : undefined;
}
/** How long git abbreviates hashes, as magit-abbrev-length. */
export function magitAbbrevLength(): number {
  const abbrev = magitGet("core.abbrev");
  if (abbrev !== undefined && abbrev !== "auto") return Number(abbrev);
  const head = magitRevParse("--short", "HEAD");
  if (!head) return 7;
  const prev = magitRevParse("--short", "HEAD~");
  return Math.min(head.length, prev ? prev.length : head.length);
}
/** git's --abbrev argument for the length it abbreviates to, as magit-abbrev-arg. */
export const magitAbbrevArg = (arg = "abbrev"): string => `--${arg}=${magitAbbrevLength()}`;
/** REV abbreviated, as magit-rev-abbrev. */
export const magitRevAbbrev = (rev: string): string | undefined => magitRevParse(magitAbbrevArg("short"), rev);
/** COMMIT's parents, as magit-commit-parents. */
export function magitCommitParents(commit: string): string[] {
  const line = magitGitString("rev-list", "-1", "--parents", commit);
  return line ? line.split(" ").slice(1) : [];
}
/** COMMIT's children reachable from the branches, as magit-commit-children. */
export function magitCommitChildren(commit: string, ...args: GitArg[]): string[] {
  return magitGitLines("rev-list", "--children", ...args, "--all", `^${commit}`)
    .map((l) => l.split(" "))
    .filter((p) => p.includes(commit) && p[0] !== commit)
    .map((p) => p[0]);
}
/** REV's patch id, as magit-patch-id. */
export function magitPatchId(rev: string): string | undefined {
  const diff = magitGitRun(["diff-tree", "-u", rev]).output;
  const r = e8.callProcess([magitGitExecutable(), "patch-id", "--stable"], { directory: e8.expandFileName(defaultDirectory()), input: diff });
  return r.exit === 0 ? r.output.split(" ")[0] : undefined;
}
/** REV formatted by git log's FORMAT, as magit-rev-format. */
export const magitRevFormat = (format: string, rev = "HEAD", ...args: GitArg[]): string | undefined =>
  magitGitString("-c", "log.showsignature=false", "log", "-1", "--no-patch", `--format=${format}`, ...args, rev, "--");
/** How many commits are in A but not B, and in B but not A, as magit-rev-diff-count. */
export function magitRevDiffCount(a: string, b: string): [number, number] {
  const line = magitGitString("rev-list", "--count", "--left-right", `${a}...${b}`);
  const [l, r] = (line ?? "0\t0").split("\t").map(Number);
  return [l, r];
}
/** The type of OBJECT, as magit-object-type. */
export const magitObjectType = (object: string): string | undefined => magitGitString("cat-file", "-t", object);
/** RANGE split into its two ends, as magit-split-range. */
export function magitSplitRange(range: string): [string, string] | undefined {
  const m = /^(.*?)(\.\.\.?)(.*)$/.exec(range);
  if (!m) return undefined;
  const beg = m[1] === "" ? "HEAD" : m[1];
  const end = m[3] === "" ? "HEAD" : m[3];
  return [m[2] === "..." ? (magitGitString("merge-base", beg, end) ?? beg) : beg, end];
}
/** RANGE with its ends as hashes, as magit-hash-range. */
export function magitHashRange(range: string): string | undefined {
  const m = /^(.*?)(\.\.\.?)(.*)$/.exec(range);
  if (!m) return magitCommitP(range);
  const a = m[1] === "" ? "" : magitCommitP(m[1]);
  const b = m[3] === "" ? "" : magitCommitP(m[3]);
  return a !== undefined && b !== undefined ? `${a}${m[2]}${b}` : undefined;
}

// Refs and branches.

/** REF abbreviated, as git rev-parse --abbrev-ref gives it, as magit-ref-abbrev. */
export const magitRefAbbrev = (ref: string): string | undefined => magitRevParse("--abbrev-ref", ref);
/** REF's full name, as magit-ref-fullname. */
export const magitRefFullname = (ref: string): string | undefined => magitRevParse("--symbolic-full-name", ref);
/** Whether REF exists, as magit-ref-exists-p. */
export const magitRefExistsP = (ref: string): boolean => magitGitSuccess("show-ref", "--verify", ref);
/** Whether REV names a ref, as magit-ref-p. */
export const magitRefP = (rev: string): boolean => magitListRefnames().includes(rev) || magitListRefs().includes(rev);
/** Whether REF is a symbolic ref, as magit-symbolic-ref-p. */
export const magitSymbolicRefP = (ref: string): boolean => magitGitSuccess("symbolic-ref", "-q", ref);
/** BRANCH if it names a branch, local or remote, as magit-branch-p. */
export const magitBranchP = (branch: string): string | undefined => (magitLocalBranchP(branch) ?? magitRemoteBranchP(branch));
/** BRANCH if it names a local branch, as magit-local-branch-p. */
export const magitLocalBranchP = (branch: string): string | undefined => (magitListLocalBranchNames().includes(branch) ? branch : undefined);
/** BRANCH if it names a remote branch, as magit-remote-branch-p. */
export const magitRemoteBranchP = (branch: string): string | undefined => (magitListRemoteBranchNames().includes(branch) ? branch : undefined);
/** Whether TAG names a tag, as magit-tag-p. */
export const magitTagP = (tag: string): boolean => magitListTags().includes(tag);
/** REMOTE if it names a remote, as magit-remote-p. */
export const magitRemoteP = (remote: string): string | undefined => (magitListRemotes().includes(remote) ? remote : undefined);
/** REV's short name: a branch or tag, else its abbreviated hash, as magit-get-shortname. */
export function magitGetShortname(rev: string): string {
  const name = magitGitString("name-rev", "--name-only", "--no-undefined", "--refs=refs/tags/*", "--refs=refs/heads/*", "--refs=refs/remotes/*", rev);
  if (name && !/[~^]/.test(name)) return name.replace(/^(tags|remotes)\//, "");
  return magitRevAbbrev(rev) ?? rev;
}

/** The branch HEAD is on, or undefined if detached, as magit-get-current-branch. */
export const magitGetCurrentBranch = (): string | undefined => magitGitString("symbolic-ref", "--short", "-q", "HEAD");
/** The branch checked out before, as @{-1} names it, as magit-get-previous-branch. */
export function magitGetPreviousBranch(): string | undefined {
  const current = magitGetCurrentBranch();
  for (let i = 1; i < 10; i++) {
    const prev = magitRevName(`@{-${i}}`, "refs/heads/*");
    if (prev === undefined) return undefined;
    if (prev !== current && !/[~^]/.test(prev)) return prev;
  }
  return undefined;
}
/** BRANCH's upstream as a full ref, as magit-get-upstream-ref. */
export const magitGetUpstreamRef = (branch?: string): string | undefined => {
  const b = branch ?? magitGetCurrentBranch();
  return b ? magitRefFullname(`${b}@{upstream}`) : undefined;
};
/** BRANCH's upstream branch, if it exists, as magit-get-upstream-branch. */
export function magitGetUpstreamBranch(branch?: string): string | undefined {
  return magitWithCache(`${defaultDirectory()}\0upstream\0${branch ?? ""}`, () => {
    const b = branch ?? magitGetCurrentBranch();
    return b ? magitRefAbbrev(`${b}@{upstream}`) : undefined;
  });
}
/** The face BRANCH's upstream is shown in: local if its remote is ".". */
export const magitUpstreamFace = (branch?: string): string => (magitGet("branch", branch ?? magitGetCurrentBranch() ?? "", "remote") === "." ? "magit-branch-local" : "magit-branch-remote");
/** BRANCH's upstream if it is a local branch, as magit-get-local-upstream-branch. */
export function magitGetLocalUpstreamBranch(branch?: string): string | undefined {
  const upstream = magitGetUpstreamBranch(branch);
  const local = upstream && magitSplitBranchName(upstream)[1];
  return local && magitBranchP(local) ? local : undefined;
}
/** The remote of BRANCH's upstream, if it is a remote's, as magit-get-upstream-remote. */
export function magitGetUpstreamRemote(branch?: string, allowUnnamed = false): string | undefined {
  const b = branch ?? magitGetCurrentBranch();
  const remote = b && magitGet("branch", b, "remote");
  if (!remote || remote === ".") return undefined;
  if (magitListRemotes().includes(remote)) return remote;
  if (allowUnnamed && /(^.{0,2}\/|[:@])/.test(remote)) return remote;
  return undefined;
}
/** The remote BRANCH's upstream is on, else the only or primary remote, as magit-get-current-remote. */
export function magitGetCurrentRemote(allowUnnamed = false): string | undefined {
  const r = magitGetUpstreamRemote(undefined, allowUnnamed);
  if (r) return r;
  const remotes = magitListRemotes();
  return remotes.length === 1 ? remotes[0] : magitPrimaryRemote();
}
/** The remote BRANCH pushes to, as magit-get-push-remote. */
export function magitGetPushRemote(branch?: string): string | undefined {
  const b = branch ?? magitGetCurrentBranch();
  return (b ? magitGet("branch", b, "pushRemote") : undefined) ?? magitGet("remote.pushDefault");
}
/** The branch BRANCH pushes to, REMOTE/BRANCH, if it exists when VERIFY, as magit-get-push-branch. */
export function magitGetPushBranch(branch?: string, verify = false): string | undefined {
  return magitWithCache(`${defaultDirectory()}\0push\0${branch ?? ""}\0${verify}`, () => {
    const b = branch ?? magitGetCurrentBranch();
    const remote = b && magitGetPushRemote(b);
    if (!b || !remote) return undefined;
    const target = `${remote}/${b}`;
    return !verify || magitRevVerify(target) ? target : undefined;
  });
}
/** The remote of BRANCH's upstream, unless ".", as magit-get-remote. */
export function magitGetRemote(branch?: string): string | undefined {
  const b = branch ?? magitGetCurrentBranch();
  const remote = b && magitGet("branch", b, "remote");
  return remote && remote !== "." ? remote : undefined;
}
/** Some remote: BRANCH's, the main branch's, the primary one, or the first, as magit-get-some-remote. */
export function magitGetSomeRemote(branch?: string): string | undefined {
  const main = magitMainBranch();
  return magitGetRemote(branch) ?? (main ? magitGetRemote(main) : undefined) ?? magitPrimaryRemote() ?? magitListRemotes()[0];
}
/** The primary remote, from magit.primaryRemote or magit-primary-remote-names, as magit-primary-remote. */
export function magitPrimaryRemote(): string | undefined {
  const remotes = magitListRemotes();
  const configured = magitGet("magit.primaryRemote");
  if (configured && remotes.includes(configured)) return configured;
  const names = (e8.variable("magit-primary-remote-names") as string[] | null) ?? [];
  return names.find((n) => remotes.includes(n));
}
/** The main branch: the first of magit-main-branch-names that exists, as magit-main-branch. */
export function magitMainBranch(): string | undefined {
  const configured = magitGet("init.defaultBranch");
  const names = [...(configured ? [configured] : []), ...((e8.variable("magit-main-branch-names") as string[] | null) ?? [])];
  const local = magitListLocalBranchNames();
  return names.find((n) => local.includes(n));
}
/** Whether BRANCH is merged into TARGET, HEAD by default, as magit-branch-merged-p. */
export function magitBranchMergedP(branch: string, target?: string): boolean {
  const t = target ?? magitGetCurrentBranch() ?? "HEAD";
  return magitRevAncestorP(branch, t) || magitGitLines("cherry", t, branch).every((l) => l.startsWith("-"));
}
/** BRANCH as [remote, name], "." for a local one, as magit-split-branch-name. */
export function magitSplitBranchName(branch: string): [string, string] {
  if (magitLocalBranchP(branch)) return [".", branch];
  const m = /^([^/]+)\/(.+)$/.exec(branch);
  if (m && magitListRemotes().includes(m[1])) return [m[1], m[2]];
  return [".", branch];
}
/** The closest tag reachable from REV, and with WITH-DISTANCE how many commits since, as magit-get-current-tag. */
export function magitGetCurrentTag(rev?: string): string | undefined;
export function magitGetCurrentTag(rev: string | undefined, withDistance: true): [string, number] | undefined;
export function magitGetCurrentTag(rev?: string, withDistance = false): string | [string, number] | undefined {
  const str = magitGitStr("describe", "--long", "--tags", rev);
  if (!str) return undefined;
  const m = /^(.+)-(?:0[0-9]*|([0-9]+))-g[0-9a-z]+(-dirty)?$/.exec(str);
  if (!m) return undefined;
  return withDistance ? [m[1], Number(m[2] ?? 0)] : m[1];
}
/** The closest tag REV is reachable from, as magit-get-next-tag. */
export function magitGetNextTag(rev?: string, withDistance = false): string | [string, number] | undefined {
  const str = magitGitStr("describe", "--contains", rev ?? "HEAD");
  const m = str && /^[^^~]+/.exec(str);
  if (!m || m[0] === magitGetCurrentTag(rev)) return undefined;
  return withDistance ? [m[0], magitRevDiffCount(m[0], rev ?? "HEAD")[0]] : m[0];
}

/** The refs in NAMESPACES, symbolic ones left out, formatted by FORMAT, as magit-list-refs. */
export function magitListRefs(namespaces?: string | string[], format?: string, sortby?: string | string[]): string[] {
  const ns = namespaces === undefined ? ((e8.variable("magit-list-refs-namespaces") as string[] | null) ?? []) : Array.isArray(namespaces) ? namespaces : [namespaces];
  const sortVar = e8.variable("magit-list-refs-sortby") as string | string[] | null;
  const sorts = (sortby ?? sortVar ?? undefined) === undefined ? [] : [sortby ?? sortVar!].flat().map((s) => `--sort=${s}`);
  return ns.flatMap((n) =>
    magitGitLines("for-each-ref", `--format=%(symref)\u0001${format ?? "%(refname)"}`, ...(sorts.length === 0 && n === "refs/tags" ? ["--sort=-version:refname"] : sorts), n)
      .map((l) => l.split("\u0001"))
      .filter(([sym]) => sym === "")
      .map(([, v]) => v),
  );
}
/** Local and remote branch refs, as magit-list-branches. */
export const magitListBranches = (): string[] => magitListRefs(["refs/heads", "refs/remotes"]);
/** Local branch refs, as magit-list-local-branches. */
export const magitListLocalBranches = (): string[] => magitListRefs("refs/heads");
/** Remote branch refs, of REMOTE or all, as magit-list-remote-branches. */
export const magitListRemoteBranches = (remote?: string): string[] => magitListRefs(remote ? `refs/remotes/${remote}` : "refs/remotes");
/** Branches containing COMMIT or contained by it, as magit-list-related-branches. */
export function magitListRelatedBranches(relation: "--contains" | "--merged" | "--no-merged" | "--no-contains", commit?: string, ...args: string[]): string[] {
  return magitGitLines("branch", ...args, relation, commit)
    .map((l) => l.slice(2))
    .filter((b) => !b.startsWith("(") && !/ -> /.test(b));
}
/** Branches containing COMMIT, HEAD by default, as magit-list-containing-branches. */
export const magitListContainingBranches = (commit = "HEAD", ...args: string[]): string[] => magitListRelatedBranches("--contains", commit, ...args);
/** Branches merged into COMMIT, as magit-list-merged-branches. */
export const magitListMergedBranches = (commit?: string, ...args: string[]): string[] => magitListRelatedBranches("--merged", commit, ...args);
/** Branches not merged into COMMIT, as magit-list-unmerged-branches. */
export const magitListUnmergedBranches = (commit?: string, ...args: string[]): string[] => magitListRelatedBranches("--no-merged", commit, ...args);
/** Branches pointing at COMMIT, as magit-list-branches-pointing-at. */
export function magitListBranchesPointingAt(commit: string): string[] {
  const hash = magitRevVerify(commit);
  return magitGitLines("for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads", "refs/remotes")
    .map((l) => l.split(" "))
    .filter(([h, n]) => h === hash && !n.endsWith("/HEAD"))
    .map(([, n]) => n);
}
/** Ref names, short, in NAMESPACES, as magit-list-refnames. */
export const magitListRefnames = (namespaces?: string | string[], includeSpecial = false): string[] => [
  ...magitListRefs(namespaces, "%(refname:short)").filter((n) => !n.endsWith("/HEAD")),
  ...(includeSpecial ? magitListSpecialRefnames() : []),
];
/** The special refs that exist, such as ORIG_HEAD and FETCH_HEAD, as magit-list-special-refnames. */
export function magitListSpecialRefnames(): string[] {
  const g = magitGitdir();
  return ["HEAD", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_HEAD", "AUTO_MERGE"].filter((n) => g && e8.fileExistsP(e8.expandFileName(n, g)));
}
/** Branch names, local and remote, as magit-list-branch-names. */
export const magitListBranchNames = (): string[] => magitListRefnames(["refs/heads", "refs/remotes"]);
/** Local branch names, as magit-list-local-branch-names. */
export const magitListLocalBranchNames = (): string[] => magitListRefnames("refs/heads");
/** Remote branch names, of REMOTE or all, with the remote's name unless RELATIVE, as magit-list-remote-branch-names. */
export function magitListRemoteBranchNames(remote?: string, relative = false): string[] {
  const names = magitListRefnames(remote ? `refs/remotes/${remote}` : "refs/remotes");
  return relative && remote ? names.map((n) => n.slice(remote.length + 1)) : names;
}
/** The remotes, as magit-list-remotes. */
export const magitListRemotes = (): string[] => magitWithCache(`${defaultDirectory()}\0remotes`, () => magitGitLines("remote"));
/** The tags, newest version first, as magit-list-tags. */
export const magitListTags = (): string[] => magitGitLines("tag", "--sort=-version:refname");
/** The stashes formatted by FORMAT, as magit-list-stashes. */
export const magitListStashes = (format = "%gd"): string[] => magitGitLines("stash", "list", `--format=${format}`);
/** The worktrees, each [path, commit, branch, bare, detached, locked, prunable], as magit-list-worktrees. */
export function magitListWorktrees(): { path: string; commit?: string; branch?: string; bare: boolean; detached: boolean }[] {
  const out: { path: string; commit?: string; branch?: string; bare: boolean; detached: boolean }[] = [];
  let cur: (typeof out)[number] | undefined;
  for (const line of magitGitLines("worktree", "list", "--porcelain")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), bare: false, detached: false };
      out.push(cur);
    } else if (cur && line.startsWith("HEAD ")) cur.commit = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line === "bare") cur.bare = true;
    else if (cur && line === "detached") cur.detached = true;
  }
  return out;
}
/** The submodules' paths, as magit-list-module-paths. */
export const magitListModulePaths = (): string[] =>
  magitGitLines("submodule--helper", "list")
    .map((l) => l.split("\t")[1])
    .filter((p): p is string => p !== undefined);

// The labels of refs, after magit-format-ref-labels.

/** The ref namespaces and their faces, as magit-ref-namespaces. */
export const magitRefNamespaces: [RegExp, string][] = [
  [/^tag: refs\/tags\/(.+)$/, "magit-tag"],
  [/^refs\/tags\/(.+)$/, "magit-tag"],
  [/^HEAD$/, "magit-head"],
  [/^refs\/heads\/(.+)$/, "magit-branch-local"],
  [/^refs\/remotes\/(.+)$/, "magit-branch-remote"],
  [/^refs\/bisect\/(bad)$/, "magit-bisect-bad"],
  [/^refs\/bisect\/(skip.*)$/, "magit-bisect-skip"],
  [/^refs\/bisect\/(good.*)$/, "magit-bisect-good"],
  [/^refs\/stash$/, "magit-refname-stash"],
  [/^refs\/wip\/(.+)$/, "magit-refname-wip"],
  [/^refs\/pullreqs\/(.+)$/, "magit-refname-pullreq"],
  [/^(?:refs\/)?(.+)$/, "magit-refname"],
];

const fontify = (text: string, face: string | string[]): e8.PropertizedString => e8.propertize(text, { "font-lock-face": face });

/**
 * The labels of the refs git log's %D lists, as magit-format-ref-labels:
 * the current branch with its push remote's prefix, its upstream, the
 * tags, the other branches with their push remotes', and the remote
 * branches, each in its face, joined by spaces. Needs --decorate=full.
 */
export function magitFormatRefLabels(decorations: string): e8.PropertizedString | string {
  const refs = decorations
    .replace(/(tag: |HEAD -> )/g, "")
    .split(", ")
    .filter((r) => r !== "");
  let state: e8.PropertizedString | undefined;
  let head: e8.PropertizedString | undefined;
  let upstream: e8.PropertizedString | undefined;
  const tags: e8.PropertizedString[] = [];
  const branches: string[] = [];
  let remotes: string[] = [];
  const other: e8.PropertizedString[] = [];
  const remoteFaces = new Map<string, string>();
  for (const ref of refs) {
    const found = magitRefNamespaces.find(([re]) => re.test(ref));
    const face = found?.[1] ?? "magit-refname";
    const m = found?.[0].exec(ref);
    let name = m?.[1] ?? ref;
    if (m?.[1] && !ref.startsWith("refs/tags/") && magitRevVerify(`refs/tags/${name}`)) name = magitRefAbbrev(ref) ?? name;
    if (face === "magit-bisect-bad" || face === "magit-bisect-skip" || face === "magit-bisect-good") state = fontify(name, face);
    else if (face === "magit-head") head = fontify("@", "magit-head");
    else if (face === "magit-tag") tags.push(fontify(name, face));
    else if (face === "magit-branch-local") branches.push(name);
    else if (face === "magit-branch-remote") remotes.push(name);
    else other.push(fontify(name, face));
  }
  remotes = remotes.filter((name) => {
    const m = /^([^/]*)\/(.*)$/.exec(name);
    if (!m) return true;
    if (m[2] === "HEAD") return false;
    if (`refs/remotes/${name}` === magitGitString("symbolic-ref", `refs/remotes/${m[1]}/HEAD`)) remoteFaces.set(name, "magit-branch-remote-head");
    return true;
  });
  const remoteLabel = (name: string): e8.PropertizedString => fontify(name, remoteFaces.get(name) ?? "magit-branch-remote");
  const current = magitGetCurrentBranch();
  const target = current ? magitGetUpstreamBranch(current) : undefined;
  const combined: e8.PropertizedString[] = [];
  let upstreamName: string | undefined;
  for (const name of branches) {
    const pushBranch = magitGetPushBranch(name);
    let push: e8.PropertizedString | undefined;
    if (pushBranch && remotes.includes(pushBranch)) {
      remotes = remotes.filter((r) => r !== pushBranch);
      const prefix = /^[^/]*\//.exec(pushBranch)![0];
      push = fontify(prefix, remoteFaces.get(pushBranch) ?? "magit-branch-remote");
    }
    const withPush = (label: e8.PropertizedString): e8.PropertizedString => (push ? e8.concat(push, label) : label);
    if (name === current) head = withPush(fontify(name, "magit-branch-current"));
    else if (name === target) {
      // The upstream keeps the face magit-get-upstream-branch gives it.
      upstream = withPush(fontify(name, ["magit-branch-upstream", magitUpstreamFace(current)]));
      upstreamName = name;
    } else combined.push(withPush(fontify(name, "magit-branch-local")));
  }
  if (!upstream && target) {
    if (remotes.includes(target)) {
      upstream = fontify(target, ["magit-branch-upstream", magitUpstreamFace(current)]);
      remotes = remotes.filter((r) => r !== target);
    } else if (upstreamName === undefined) {
      const i = combined.findIndex((c) => c.string === target);
      if (i >= 0) {
        upstream = fontify(target, ["magit-branch-upstream", magitUpstreamFace(current)]);
        combined.splice(i, 1);
      }
    }
  }
  const parts = [state, head, upstream, ...tags, ...combined, ...remotes.map(remoteLabel), ...other].filter((p): p is e8.PropertizedString => p !== undefined);
  if (parts.length === 0) return "";
  return e8.concat(...parts.flatMap((p, i) => (i === 0 ? [p] : [" ", p])));
}

// What is at point.

/** The value of the section at point, or of its parent, if it is of TYPE, as magit-section-value-if. */
export function magitSectionValueIf(types: string | string[], section = currentSection()): unknown {
  const ts = Array.isArray(types) ? types : [types];
  return section && ts.includes(section.type) ? section.value : undefined;
}

/** The section at point's value as a string, if it is of TYPES. */
const valueAt = (types: string | string[], section?: Section): string | undefined => {
  const v = magitSectionValueIf(types, section);
  return typeof v === "string" ? v : undefined;
};

/** The branch at point, local or remote, as magit-branch-at-point. */
export const magitBranchAtPoint = (): string | undefined => valueAt("branch") ?? magitPaintedBranchAtPoint();
/** The branch painted on the commit line at point, as magit--painted-branch-at-point. */
export function magitPaintedBranchAtPoint(type?: "local" | "remote"): string | undefined {
  const face = e8.getTextProperty(e8.point(), "font-lock-face") ?? e8.getTextProperty(e8.point(), "face");
  const faces = (Array.isArray(face) ? face : [face]).map(String);
  if ((type !== "remote" && faces.some((f) => f === "magit-branch-local" || f === "magit-branch-current")) || (type !== "local" && faces.some((f) => f === "magit-branch-remote" || f === "magit-branch-remote-head"))) {
    const bounds = symbolBounds();
    return bounds ? e8.bufferSubstringNoProperties(bounds[0], bounds[1]) : undefined;
  }
  return undefined;
}
function symbolBounds(): [number, number] | undefined {
  const at = e8.point();
  const line = e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), e8.lineEndPosition());
  const col = at - e8.lineBeginningPosition();
  let s = col;
  let e = col;
  while (s > 0 && line[s - 1] !== " ") s--;
  while (e < line.length && line[e] !== " ") e++;
  return s < e ? [e8.lineBeginningPosition() + s, e8.lineBeginningPosition() + e] : undefined;
}
/** The local branch at point, as magit-local-branch-at-point. */
export function magitLocalBranchAtPoint(): string | undefined {
  const b = valueAt("branch");
  if (b !== undefined) return magitLocalBranchP(b) ?? (magitRemoteBranchP(b) ? magitSplitBranchName(b)[1] : undefined);
  return magitPaintedBranchAtPoint("local");
}
/** The remote branch at point, as magit-remote-branch-at-point. */
export function magitRemoteBranchAtPoint(): string | undefined {
  const b = valueAt("branch");
  if (b !== undefined) return magitRemoteBranchP(b) ? b : undefined;
  return magitPaintedBranchAtPoint("remote");
}
/** The commit at point, as magit-commit-at-point. */
export function magitCommitAtPoint(): string | undefined {
  const c = valueAt("commit");
  if (c !== undefined) return c;
  const revision = e8.variable("magit-buffer-revision");
  return typeof revision === "string" && ["magit-revision-mode", "magit-stash-mode"].includes(String(e8.variable("major-mode"))) ? revision : undefined;
}
/** The branch or commit at point, as magit-branch-or-commit-at-point. */
export function magitBranchOrCommitAtPoint(): string | undefined {
  const s = currentSection();
  if (s?.type === "branch" && typeof s.value === "string") return s.value;
  if (s?.type === "commit" && typeof s.value === "string") return magitPaintedBranchAtPoint() ?? magitRevName(s.value, "refs/heads/*")?.replace(/^(.*?)$/, (n) => (/[~^]/.test(n) ? s.value as string : n)) ?? (s.value as string);
  return magitPaintedBranchAtPoint() ?? magitCommitAtPoint();
}
/** The tag at point, as magit-tag-at-point. */
export function magitTagAtPoint(): string | undefined {
  const t = valueAt("tag");
  if (t !== undefined) return t;
  const face = e8.getTextProperty(e8.point(), "font-lock-face") ?? e8.getTextProperty(e8.point(), "face");
  if ((Array.isArray(face) ? face : [face]).map(String).includes("magit-tag")) {
    const b = symbolBounds();
    return b ? e8.bufferSubstringNoProperties(b[0], b[1]) : undefined;
  }
  return undefined;
}
/** The stash at point, as magit-stash-at-point. */
export const magitStashAtPoint = (): string | undefined => valueAt("stash");
/** The remote at point, as magit-remote-at-point. */
export function magitRemoteAtPoint(): string | undefined {
  const s = currentSection();
  if (s?.type === "remote" && typeof s.value === "string") return s.value;
  if (s?.type === "branch" && typeof s.value === "string" && magitRemoteBranchP(s.value)) return magitSplitBranchName(s.value)[0];
  return undefined;
}
/** The submodule at point, as magit-module-at-point. */
export const magitModuleAtPoint = (): string | undefined => valueAt("module");
/** The file at point: a file section's, or a hunk's file, as magit-file-at-point. */
export function magitFileAtPoint(expand = false): string | undefined {
  const s = currentSection();
  let file: string | undefined;
  if (s?.type === "file") file = typeof s.value === "string" ? s.value : (s.value as { file?: string } | undefined)?.file;
  else if (s?.type === "hunk") file = typeof s.parent?.value === "string" ? s.parent.value : (s.parent?.value as { file?: string } | undefined)?.file;
  if (file !== undefined && expand) return e8.expandFileName(file, magitToplevel());
  return file;
}
/** The file at point, or the file the buffer visits, or that a blob buffer shows, as magit-current-file. */
export function magitCurrentFile(): string | undefined {
  return magitFileAtPoint() ?? magitFileRelativeName() ?? (e8.variable("magit-buffer-file-name") as string | undefined) ?? undefined;
}

// Reading branches, commits and the rest.

const history = "magit-revision-history";

/** Reads a branch, local or remote, as magit-read-branch. */
export const magitReadBranch = (prompt: string, secondaryDefault?: string): string =>
  magitCompletingRead(prompt, magitListBranchNames(), { requireMatch: true, history, def: magitBranchAtPoint() ?? secondaryDefault ?? magitGetCurrentBranch() })!;

/** Reads a branch or a commit, as magit-read-branch-or-commit. */
export function magitReadBranchOrCommit(prompt: string, secondaryDefault?: string, exclude: string[] = []): string {
  let current = magitGetCurrentBranch();
  let branchAtPoint = magitBranchAtPoint();
  const commitAtPoint = magitCommitAtPoint();
  let choices = magitListRefnames(undefined, true).filter((c) => !exclude.includes(c));
  if (current && exclude.includes(current)) current = undefined;
  if (branchAtPoint && exclude.includes(branchAtPoint)) branchAtPoint = undefined;
  if (commitAtPoint && !branchAtPoint) choices = [commitAtPoint, ...choices];
  return magitCompletingRead(prompt, choices, { requireMatch: "any", history, def: branchAtPoint ?? commitAtPoint ?? secondaryDefault ?? current })!;
}

/** Reads a range or a commit: the region's commits as a range, else the branch or commit at point, as magit-read-range-or-commit. */
export function magitReadRangeOrCommit(prompt: string, secondaryDefault?: string, regionValues?: () => string[]): string {
  const revs = regionValues?.() ?? [];
  const def = revs.length > 1 ? `${revs[revs.length - 1]}..${revs[0]}` : (magitBranchOrCommitAtPoint() ?? secondaryDefault ?? magitGetCurrentBranch());
  return magitReadRange(prompt, def);
}

/** Reads a range, as magit-read-range. */
export const magitReadRange = (prompt: string, def?: string): string => magitCompletingRead(prompt, magitListRefnames(), { requireMatch: "any", history, def })!;

/** Reads a remote branch, REMOTE/BRANCH, as magit-read-remote-branch. */
export function magitReadRemoteBranch(prompt: string, remote?: string, def?: string, localBranch?: string, requireMatch: boolean | "any" = "any"): string {
  const choices = new Set<string>([...(localBranch ? (remote ? [localBranch] : magitListRemotes().map((r) => `${r}/${localBranch}`)) : []), ...magitListRemoteBranchNames(remote, true)]);
  const choice = magitCompletingRead(prompt, choices, { requireMatch, history, def })!;
  if (remote || /^[^/]+\/.+$/.test(choice)) return choice;
  return e8.userError(`\`${choice}' doesn't have the form REMOTE/BRANCH`);
}

/** Reads a refspec of REMOTE, as magit-read-refspec. */
export function magitReadRefspec(prompt: string, remote: string): string {
  e8.message("Determining available refs...");
  const refs = magitGitLines("ls-remote", remote).map((l) => l.split("\t")[1]).filter((r): r is string => r !== undefined);
  e8.message("Determining available refs...done");
  return magitCompletingRead(prompt, refs, { requireMatch: "any" })!;
}

/** Reads a local branch, as magit-read-local-branch. */
export const magitReadLocalBranch = (prompt: string, secondaryDefault?: string): string =>
  magitCompletingRead(prompt, magitListLocalBranchNames(), { requireMatch: true, history, def: magitLocalBranchAtPoint() ?? secondaryDefault ?? magitGetCurrentBranch() })!;

/** Reads a local branch or a commit, as magit-read-local-branch-or-commit. */
export function magitReadLocalBranchOrCommit(prompt: string): string {
  const commit = magitCommitAtPoint();
  const choices = [...(commit ? [commit] : []), ...magitListLocalBranchNames(), ...magitListSpecialRefnames()];
  return magitCompletingRead(prompt, choices, { requireMatch: "any", history, def: magitLocalBranchAtPoint() ?? commit })!;
}

/** Reads a local branch or a ref, as magit-read-local-branch-or-ref. */
export const magitReadLocalBranchOrRef = (prompt: string, secondaryDefault?: string): string =>
  magitCompletingRead(prompt, [...magitListLocalBranchNames(), ...magitListRefs("refs/")], { requireMatch: true, history, def: magitLocalBranchAtPoint() ?? secondaryDefault ?? magitGetCurrentBranch() })!;

/** Reads a branch other than EXCLUDE, the current one by default, as magit-read-other-branch. */
export function magitReadOtherBranch(prompt: string, exclude?: string, secondaryDefault?: string): string {
  const current = magitGetCurrentBranch();
  const atpoint = magitBranchAtPoint();
  const ex = exclude ?? current;
  const def = (atpoint !== ex ? atpoint : undefined) ?? (current !== ex ? current : undefined) ?? secondaryDefault ?? magitGetPreviousBranch();
  return magitCompletingRead(prompt, magitListBranchNames().filter((b) => b !== ex), { requireMatch: true, history, def })!;
}

/** Reads a branch or commit other than EXCLUDE, as magit-read-other-branch-or-commit. */
export function magitReadOtherBranchOrCommit(prompt: string, exclude?: string, secondaryDefault?: string): string {
  const current = magitGetCurrentBranch();
  const atpoint = magitBranchOrCommitAtPoint();
  const ex = exclude ?? current;
  const def = (atpoint !== undefined && atpoint !== ex && !(!current && magitRevEqual(atpoint, "HEAD")) ? atpoint : undefined) ?? (current !== ex ? current : undefined) ?? secondaryDefault ?? magitGetPreviousBranch();
  return magitCompletingRead(prompt, magitListRefnames().filter((b) => b !== ex), { requireMatch: "any", history, def })!;
}

/** Reads a local branch other than EXCLUDE, as magit-read-other-local-branch. */
export function magitReadOtherLocalBranch(prompt: string, exclude?: string, secondaryDefault?: string): string {
  const current = magitGetCurrentBranch();
  const atpoint = magitLocalBranchAtPoint();
  const ex = exclude ?? current;
  const def = (atpoint !== ex ? atpoint : undefined) ?? (current !== ex ? current : undefined) ?? secondaryDefault ?? magitGetPreviousBranch();
  return magitCompletingRead(prompt, magitListLocalBranchNames().filter((b) => b !== ex), { requireMatch: true, history, def })!;
}

/** Reads a branch, preferring one other than the current, as magit-read-branch-prefer-other. */
export function magitReadBranchPreferOther(prompt: string): string {
  const current = magitGetCurrentBranch();
  const commit = magitCommitAtPoint();
  const atrev = commit ? magitListBranchesPointingAt(commit) : [];
  const def = valueAt("branch") ?? magitPaintedBranchAtPoint() ?? (atrev.length === 1 ? atrev[0] : undefined) ?? atrev.find((b) => b !== current) ?? magitGetPreviousBranch() ?? atrev[0];
  return magitCompletingRead(prompt, magitListBranchNames(), { requireMatch: true, history, def })!;
}

/** Reads the upstream for BRANCH, as magit-read-upstream-branch. */
export function magitReadUpstreamBranch(branch?: string, prompt?: string): string {
  const b = branch ?? magitGetCurrentBranch() ?? e8.signal("error", "Need a branch to set its upstream");
  const branches = magitListBranchNames().filter((x) => x !== b);
  const preferRemote = Boolean(e8.variable("magit-prefer-remote-upstream"));
  const pick = (r?: string, l?: string) => (preferRemote ? (r ?? l) : (l ?? r));
  const inList = (x?: string) => (x !== undefined && branches.includes(x) ? x : undefined);
  const main = magitMainBranch();
  const prev = magitGetPreviousBranch();
  const def = pick(inList(magitRemoteBranchAtPoint()), inList(magitLocalBranchAtPoint())) ?? (main ? pick(inList(`origin/${main}`), inList(main)) : undefined) ?? inList(prev);
  return magitCompletingRead(prompt ?? `Change upstream of ${b} to`, branches, { requireMatch: true, history, def })!;
}

/** Reads where a new branch starts, as magit-read-starting-point. */
export function magitReadStartingPoint(prompt: string, branch?: string, def?: string): string {
  const g = magitGitdir();
  const heads = g ? e8.directoryFiles(g, { match: "_HEAD$" }) : [];
  const reply = magitCompletingRead(`${prompt}${branch ? ` ${branch}` : ""} starting at`, ["HEAD", ...magitListRefnames(), ...heads], { requireMatch: "any", history, def: def ?? magitDefaultStartingPoint() });
  return reply ?? e8.userError("Nothing selected");
}

/** Where a new branch starts by default: the branch, commit or stash at point, or the current branch, as magit--default-starting-point. */
export function magitDefaultStartingPoint(): string | undefined {
  const preferRemote = Boolean(e8.variable("magit-prefer-remote-upstream"));
  const r = magitRemoteBranchAtPoint();
  const l = magitLocalBranchAtPoint();
  return (preferRemote ? (r ?? l) : (l ?? r)) ?? magitCommitAtPoint() ?? magitStashAtPoint() ?? magitGetCurrentBranch();
}

/** Reads a tag, as magit-read-tag. */
export const magitReadTag = (prompt: string): string => magitCompletingRead(prompt, magitListTags(), { requireMatch: true, history, def: magitTagAtPoint() })!;

/** Reads a stash, as magit-read-stash: the stash at point by default, else the newest. */
export function magitReadStash(prompt: string): string {
  const atpoint = magitStashAtPoint();
  const def = atpoint ? `${atpoint}${magitRevFormat(" %s", atpoint) ?? ""}` : undefined;
  const choices = magitListStashes("%gd%x00%s").map((c) => c.replace("\0", " "));
  const choice = magitCompletingRead(prompt, choices, { requireMatch: true, def, fallback: choices[0] });
  const m = choice && /^([^ ]+) (.+)$/.exec(choice);
  return m ? m[1] : e8.userError("Nothing selected");
}

/** Reads a remote, as magit-read-remote; with USE-ONLY, the only one without asking. */
export function magitReadRemote(prompt: string, def?: string, useOnly = false): string {
  const remotes = magitListRemotes();
  if (useOnly && remotes.length === 1) return remotes[0];
  return magitCompletingRead(prompt, remotes, { requireMatch: true, def: def ?? magitRemoteAtPoint() ?? magitGetRemote() })!;
}

/** Reads a remote or a URL, as magit-read-remote-or-url. */
export const magitReadRemoteOrUrl = (prompt: string, def?: string): string =>
  magitCompletingRead(prompt, [...magitListRemotes(), "https://", "git://", "git@"], { requireMatch: "any", def: def ?? magitRemoteAtPoint() ?? magitGetRemote() })!;

/** Reads a submodule's path, as magit-read-module-path. */
export const magitReadModulePath = (prompt: string): string => magitCompletingRead(prompt, magitListModulePaths(), { requireMatch: true, def: magitModuleAtPoint() })!;

let gitVersion: string | undefined;
/** Git's version, as 2.51.2, as magit-git-version. */
export function magitGitVersion(): string {
  gitVersion ??= /(\d+(?:\.\d+)*)/.exec(magitGitString("version") ?? "")?.[1] ?? "0";
  return gitVersion;
}
/** Whether git's version is at least N, as magit-git-version>=. */
export function magitGitVersionGe(n: string): boolean {
  const a = magitGitVersion().split(".").map(Number);
  const b = n.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
