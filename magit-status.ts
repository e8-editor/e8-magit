// SPDX-License-Identifier: GPL-3.0-or-later
//
// The status buffer, after magit-status.el: magit-status, the buffer's
// sections as magit-status-sections-hook lists them, its headers as
// magit-status-headers-hook does (an error, the diff filter, Head, Merge
// or Rebase, Push, the tags), the lists of untracked, tracked, ignored,
// skip-worktree and assume-unchanged files, j to jump to a section, the
// section point starts on, and going to a file's position from its buffer.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import {
  currentSection,
  insertHeading,
  insertRoot,
  insertSection,
  magitGetSection,
  magitInsertHeaders,
  magitInsertSectionBody,
  magitSectionDefineType,
  magitSectionReveal,
  magitSectionSiblings,
  sections,
  show,
  hide,
  type Section,
} from "magit-section";
import { truthy } from "subr";
import { transientDefinePrefix } from "transient";
import {
  magitAssumeUnchangedFiles,
  magitFileRelativeName,
  magitGet,
  magitGetBoolean,
  magitGetCurrentBranch,
  magitGetCurrentTag,
  magitGetNextTag,
  magitGetPushBranch,
  magitGetPushRemote,
  magitGetUpstreamBranch,
  magitGitExitCode,
  magitGitItems,
  magitGitRun,
  magitIgnoredFiles,
  magitListFiles,
  magitListRemotes,
  magitRemoteP,
  magitRevFormat,
  magitRevVerify,
  magitSkipWorktreeFiles,
  magitToplevel,
  magitGitExecutable,
} from "magit-git";
import { magitBufferName, magitGetModeBuffer, magitDisplayBuffer, magitSetupBuffer, magitStatusMode } from "magit-mode";
import { inserters, magitDiffArguments, magitInsertStagedChanges, magitInsertUnstagedChanges, runSectionHook, type FileValue } from "magit-diff";
import {
  magitInsertRecentCommits,
  magitInsertUnpulledFromPushremote,
  magitInsertUnpulledFromUpstream,
  magitInsertUnpushedToPushremote,
  magitInsertUnpushedToUpstream,
  magitInsertUnpushedToUpstreamOrRecent,
  magitLogArguments,
  magitLogWashSummary,
} from "magit-log";
import { magitSetBufferMargins } from "magit-margin";
import { magitInsertAmSequence, magitInsertRebaseSequence, magitInsertSequencerSequence } from "magit-sequence";
import { magitInsertStashes } from "magit-stash";
import { magitInsertMergeLog } from "magit-merge";
import { magitInsertBisectLog, magitInsertBisectOutput, magitInsertBisectRest } from "magit-bisect";

e8.defineVariable({
  name: "magit-status-sections-hook",
  doc: "Hook run to insert sections into a status buffer.",
  value: [
    "magit-insert-status-headers",
    "magit-insert-merge-log",
    "magit-insert-rebase-sequence",
    "magit-insert-am-sequence",
    "magit-insert-sequencer-sequence",
    "magit-insert-bisect-output",
    "magit-insert-bisect-rest",
    "magit-insert-bisect-log",
    "magit-insert-untracked-files",
    "magit-insert-unstaged-changes",
    "magit-insert-staged-changes",
    "magit-insert-stashes",
    "magit-insert-unpushed-to-pushremote",
    "magit-insert-unpushed-to-upstream-or-recent",
    "magit-insert-unpulled-from-pushremote",
    "magit-insert-unpulled-from-upstream",
  ],
});
e8.defineVariable({
  name: "magit-status-headers-hook",
  doc: "Hook run to insert headers into the status buffer.",
  value: ["magit-insert-error-header", "magit-insert-diff-filter-header", "magit-insert-head-branch-header", "magit-insert-upstream-branch-header", "magit-insert-push-branch-header", "magit-insert-tags-header"],
});
e8.defineVariable({ name: "magit-status-initial-section", doc: "The section point is placed on when a status buffer is created: numbers for the nth top-level section, or section identities.", value: [1] });
e8.defineVariable({ name: "magit-status-goto-file-position", doc: "Whether magit-status goes to the position in the diff that corresponds to the position in the file visited.", value: false });
e8.defineVariable({ name: "magit-status-show-hashes-in-headers", doc: "Whether headers in the status buffer show hashes.", value: false });
e8.defineVariable({ name: "magit-status-show-untracked-files", doc: "Whether to list untracked files in the status buffer: t, all, or nil.", value: true });
e8.defineVariable({ name: "magit-status-file-list-limit", doc: "How many files to list in file list sections in the status buffer.", value: 100 });
e8.defineVariable({ name: "magit-status-use-buffer-arguments", doc: "Whether magit-status reuses the arguments of an existing status buffer: always, selected, current, never.", value: "selected" });
e8.defineHook("magit-status-mode-hook", "Hook run after entering Magit-Status mode.");

const fl = (text: string, face: string | string[]): e8.PropertizedString => e8.propertize(text, { "font-lock-face": face });

// Headers.

/** Inserts the headers, or that there is no commit yet, as magit-insert-status-headers. */
export function magitInsertStatusHeaders(): void {
  if (!magitRevVerify("HEAD")) {
    e8.insert("In the beginning there was darkness\n\n");
    return;
  }
  // The first header is the parent of the rest, as magit-insert-headers makes it.
  magitInsertHeaders(() => runSectionHook("magit-status-headers-hook"));
}

/** Inserts the last git error, as magit-insert-error-header. */
function insertErrorHeader(): void {
  const err = e8.variable("magit-this-error");
  if (typeof err !== "string") return;
  insertSection("error", "git", false, () => {
    e8.insert(fl("GitError! ".padEnd(10), "magit-section-heading"));
    e8.insert(fl(err, "error"));
    if (truthy(e8.variable("magit-show-process-buffer-hint"))) e8.insert("  [Type `$' for details]");
    e8.insert("\n");
  });
  e8.setVariable("magit-this-error", null);
}

/** Inserts the diff filter in force, as magit-insert-diff-filter-header. */
function insertDiffFilterHeader(): void {
  const files = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  const ignore = ((e8.variable("magit-buffer-diff-args") as string[] | null) ?? []).find((a) => a.startsWith("--ignore-submodules"));
  if (!ignore && files.length === 0) return;
  e8.insert(fl("Filter! ".padEnd(10), "magit-section-heading"));
  if (ignore) {
    e8.insert(ignore);
    if (files.length > 0) e8.insert(" -- ");
  }
  if (files.length > 0) e8.insert(files.join(" "));
  e8.insert("\n");
}

/** Inserts the current branch, or the commit HEAD is at, as magit-insert-head-branch-header. */
export function magitInsertHeadBranchHeader(branchIn?: string): void {
  const output = magitRevFormat("%h %s", branchIn ?? "HEAD") ?? "";
  const m = /^([^ ]+) (.*)$/.exec(output);
  const commit = m?.[1] ?? output;
  const summary = m?.[2] === "" || m?.[2] === undefined ? "(no commit message)" : m[2];
  const branch = branchIn ?? magitGetCurrentBranch();
  const showHash = truthy(e8.variable("magit-status-show-hashes-in-headers"));
  if (branch) {
    insertSection("branch", branch, false, () => {
      e8.insert("Head: ".padEnd(10));
      if (showHash) e8.insert(e8.concat(fl(commit, "magit-hash"), " "));
      e8.insert(fl(branch, "magit-branch-local"));
      e8.insert(" ");
      e8.insert(magitLogWashSummary(summary));
      e8.insert("\n");
    });
  } else {
    insertSection("commit", commit, false, () => {
      e8.insert("Head: ".padEnd(10));
      e8.insert(fl(commit, "magit-hash"));
      e8.insert(" ");
      e8.insert(magitLogWashSummary(summary));
      e8.insert("\n");
    });
  }
}

/** Inserts the current branch's upstream, as magit-insert-upstream-branch-header. */
export function magitInsertUpstreamBranchHeader(branchIn?: string, upstreamIn?: string, keyword?: string): void {
  const branch = branchIn ?? magitGetCurrentBranch();
  if (!branch) return;
  const remote = magitGet("branch", branch, "remote");
  const merge = magitGet("branch", branch, "merge");
  let rebase: boolean = magitGet("branch", branch, "rebase") === "true";
  if (magitGet("branch", branch, "rebase") === undefined) rebase = magitGetBoolean("pull.rebase");
  if (!remote && !merge) return;
  const upstream = upstreamIn ?? magitGetUpstreamBranch(branch);
  insertSection("branch", upstream, false, () => {
    e8.insert((keyword ?? (rebase ? "Rebase: " : "Merge: ")).padEnd(10));
    if (upstream) {
      if (truthy(e8.variable("magit-status-show-hashes-in-headers"))) e8.insert(e8.concat(fl(magitRevFormat("%h", upstream) ?? "", "magit-hash"), " "));
      e8.insert(fl(upstream, magitGet("branch", branch, "remote") === "." ? "magit-branch-local" : "magit-branch-remote"));
      e8.insert(" ");
      e8.insert(magitLogWashSummary(magitRevFormat("%s", upstream) ?? "(no commit message)"));
    } else if (remote && merge && /(^\.{0,2}\/|[:@])/.test(remote) && merge.startsWith("refs/")) {
      e8.insert(e8.concat(fl(merge, "magit-branch-remote"), " from ", fl(remote, "bold")));
    } else if (remote && merge && (remote === "." || magitListRemotes().includes(remote)) && merge.startsWith("refs/")) {
      if (remote === ".") e8.insert(e8.concat(fl(merge, "magit-branch-local"), " ", fl("does not exist", "magit-branch-warning")));
      else e8.insert(e8.concat(fl(merge, "magit-branch-remote"), " ", fl("does not exist on", "magit-branch-warning"), " ", fl(remote, "magit-branch-remote")));
    } else e8.insert(fl("invalid upstream configuration", "magit-branch-warning"));
    e8.insert("\n");
  });
}

/** Inserts where the current branch is pushed, as magit-insert-push-branch-header. */
export function magitInsertPushBranchHeader(): void {
  const branch = magitGetCurrentBranch();
  const target = branch && magitGetPushBranch(branch);
  if (!branch || !target) return;
  insertSection("branch", target, false, () => {
    e8.insert("Push: ".padEnd(10));
    if (magitRevVerify(target)) {
      if (truthy(e8.variable("magit-status-show-hashes-in-headers"))) e8.insert(e8.concat(fl(magitRevFormat("%h", target) ?? "", "magit-hash"), " "));
      e8.insert(fl(target, "magit-branch-remote"));
      e8.insert(" ");
      e8.insert(magitLogWashSummary(magitRevFormat("%s", target) ?? "(no commit message)"));
    } else {
      const remote = magitGetPushRemote(branch)!;
      if (magitRemoteP(remote)) e8.insert(e8.concat(target, " ", fl("does not exist", "magit-branch-warning")));
      else e8.insert(e8.concat(remote, " ", fl("remote does not exist", "magit-branch-warning")));
    }
    e8.insert("\n");
  });
}

/** Inserts the tag HEAD is after and the one before, as magit-insert-tags-header. */
export function magitInsertTagsHeader(): void {
  const thisTag = magitGetCurrentTag(undefined, true);
  const nextTag = magitGetNextTag(undefined, true) as [string, number] | undefined;
  if (!thisTag && !nextTag) return;
  insertSection("tag", (thisTag ?? nextTag)![0], false, () => {
    e8.insert((thisTag && nextTag ? "Tags: " : "Tag: ").padEnd(10));
    const insertCount = (tag: string, count: number, face: string) => {
      e8.insert(fl(tag, "magit-tag"));
      if (count > 0) e8.insert(e8.concat(" (", fl(String(count), face), ")"));
    };
    if (thisTag) insertCount(thisTag[0], thisTag[1], "magit-branch-local");
    if (thisTag && nextTag) e8.insert(", ");
    if (nextTag) insertCount(nextTag[0], nextTag[1], "magit-tag");
    e8.insert("\n");
  });
}

/** Inserts the user, as magit-insert-user-header. */
function insertUserHeader(): void {
  const name = magitGet("user.name");
  const email = magitGet("user.email");
  if (!name || !email) return;
  insertSection("user", name, false, () => {
    e8.insert("User: ".padEnd(10));
    e8.insert(fl(name, "magit-log-author"));
    e8.insert(` <${email}>\n`);
  });
}
/** Inserts the repository's directory, as magit-insert-repo-header. */
function insertRepoHeader(): void {
  const top = magitToplevel()!;
  insertSection("repo", top, false, () => e8.insert(`${"Repo: ".padEnd(10)}${e8.abbreviateFileName(top)}\n`));
}
/** Inserts the current branch's remote, as magit-insert-remote-header. */
function insertRemoteHeader(): void {
  const remotes = magitListRemotes();
  const name = magitGet("branch", magitGetCurrentBranch() ?? "", "remote") ?? (remotes.includes("origin") ? "origin" : remotes[0]);
  const url = name && magitGet("remote", name, "url");
  if (!name || !url) return;
  insertSection("remote", name, false, () => {
    e8.insert("Remote: ".padEnd(10));
    e8.insert(fl(name, "magit-branch-remote"));
    e8.insert(` ${url}\n`);
  });
}

// Lists of files.

/** The untracked files as magit-status-show-untracked-files and status.showUntrackedFiles say, as magit-list-untracked-files. */
function listUntrackedFiles(files: string[]): string[] {
  let value = e8.variable("magit-status-show-untracked-files") as string | boolean | null;
  const local = magitGet("--local", "status.showUntrackedFiles");
  if (local !== undefined && value === true) value = local === "no" ? false : local === "all" ? "all" : true;
  if (value === false || value === null || value === "no") return [];
  return magitGitItems("status", "-z", "--porcelain", `--untracked-files=${value === "all" ? "all" : "normal"}`, "--", ...files)
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3));
}

/** Inserts a section of TYPE listing FILES, as magit-insert-files: hidden at first, its body inserted when shown. */
function insertFiles(type: string, list: (files: string[]) => string[]): void {
  const filter = (e8.variable("magit-buffer-diff-files") as string[] | null) ?? [];
  const files = list(filter);
  if (files.length === 0) return;
  insertSection(type, undefined, true, () => {
    insertHeading(files.length, `${type.charAt(0).toUpperCase()}${type.slice(1)} files`);
    magitInsertSectionBody(() => {
      let limit = Number(e8.variable("magit-status-file-list-limit") ?? 100);
      const rest = [...files];
      while (rest.length > 0 && limit > 0) {
        limit--;
        const file = rest.shift()!;
        insertSection("file", file, false, () => {
          e8.insert(fl(file, "magit-filename"));
          e8.insert("\n");
        });
      }
      if (rest.length > 0) insertSection("info", undefined, false, () => e8.insert(e8.propertize(`${rest.length} files not listed\n`, { face: "warning" })));
      e8.insert("\n");
    });
  }, `magit-insert-${type}-files`);
}

export const magitInsertUntrackedFiles = (): void => insertFiles("untracked", listUntrackedFiles);
export const magitInsertTrackedFiles = (): void => insertFiles("tracked", (f) => magitListFiles("--", ...f));
export const magitInsertIgnoredFiles = (): void => insertFiles("ignored", () => magitIgnoredFiles());
export const magitInsertSkipWorktreeFiles = (): void => insertFiles("skip-worktree", () => magitSkipWorktreeFiles());
export const magitInsertAssumeUnchangedFiles = (): void => insertFiles("assume-unchanged", () => magitAssumeUnchangedFiles());

for (const [name, fn] of [
  ["magit-insert-status-headers", magitInsertStatusHeaders],
  ["magit-insert-error-header", insertErrorHeader],
  ["magit-insert-diff-filter-header", insertDiffFilterHeader],
  ["magit-insert-head-branch-header", () => magitInsertHeadBranchHeader()],
  ["magit-insert-upstream-branch-header", () => magitInsertUpstreamBranchHeader()],
  ["magit-insert-push-branch-header", magitInsertPushBranchHeader],
  ["magit-insert-tags-header", magitInsertTagsHeader],
  ["magit-insert-user-header", insertUserHeader],
  ["magit-insert-repo-header", insertRepoHeader],
  ["magit-insert-remote-header", insertRemoteHeader],
  ["magit-insert-cherry-headers", () => {
    const head = String(e8.variable("magit-buffer-refname"));
    magitInsertHeadBranchHeader(head);
    magitInsertUpstreamBranchHeader(head, String(e8.variable("magit-buffer-upstream")), "Upstream: ");
    e8.insert("\n");
  }],
  ["magit-insert-merge-log", magitInsertMergeLog],
  ["magit-insert-rebase-sequence", magitInsertRebaseSequence],
  ["magit-insert-am-sequence", magitInsertAmSequence],
  ["magit-insert-sequencer-sequence", magitInsertSequencerSequence],
  ["magit-insert-bisect-output", magitInsertBisectOutput],
  ["magit-insert-bisect-rest", magitInsertBisectRest],
  ["magit-insert-bisect-log", magitInsertBisectLog],
  ["magit-insert-untracked-files", magitInsertUntrackedFiles],
  ["magit-insert-tracked-files", magitInsertTrackedFiles],
  ["magit-insert-ignored-files", magitInsertIgnoredFiles],
  ["magit-insert-skip-worktree-files", magitInsertSkipWorktreeFiles],
  ["magit-insert-assume-unchanged-files", magitInsertAssumeUnchangedFiles],
  ["magit-insert-unstaged-changes", magitInsertUnstagedChanges],
  ["magit-insert-staged-changes", magitInsertStagedChanges],
  ["magit-insert-stashes", () => magitInsertStashes()],
  ["magit-insert-unpushed-to-pushremote", magitInsertUnpushedToPushremote],
  ["magit-insert-unpushed-to-upstream-or-recent", magitInsertUnpushedToUpstreamOrRecent],
  ["magit-insert-unpushed-to-upstream", magitInsertUnpushedToUpstream],
  ["magit-insert-recent-commits", () => magitInsertRecentCommits()],
  ["magit-insert-unpulled-from-pushremote", magitInsertUnpulledFromPushremote],
  ["magit-insert-unpulled-from-upstream", magitInsertUnpulledFromUpstream],
] as const)
  inserters.set(name, fn);

// The buffer.

/** Makes the status buffer, as magit-status-refresh-buffer. */
export function magitStatusRefreshBuffer(): void {
  magitGitExitCode("update-index", "--refresh");
  magitSetBufferMargins();
  insertRoot("status", () => runSectionHook("magit-status-sections-hook"));
}

/** Moves to the section magit-status-initial-section names, as magit-status-goto-initial-section. */
function gotoInitialSection(): void {
  const initial = (e8.variable("magit-status-initial-section") as unknown[] | null) ?? [];
  const tree = sections();
  if (!tree) return;
  let found: Section | undefined;
  for (const i of initial) {
    if (typeof i === "number") {
      const at = currentSection() ?? tree.root.children[0];
      const next = at && at.parent ? magitSectionSiblings(at, "next") : tree.root.children;
      found = next[i - 1];
    } else if (Array.isArray(i)) found = magitGetSection(i as [string, unknown][]);
    if (found) break;
  }
  if (!found) return;
  e8.gotoChar(found.start);
  const alist = (e8.variable("magit-section-initial-visibility-alist") as unknown[][] | null) ?? [];
  const vis = alist.find((e) => e[0] === "magit-status-initial-section")?.[1];
  if (vis === "hide") hide(found);
  else if (vis === "show") show(found);
}

/** The file position of the current buffer, if magit-status-goto-file-position says to go there, as magit-status--get-file-position. */
function getFilePosition(force: boolean): [string, number, number] | undefined {
  if (!force && !truthy(e8.variable("magit-status-goto-file-position"))) return undefined;
  const file = magitFileRelativeName();
  if (!file) return undefined;
  return [file, e8.lineOf(e8.point()) + 1, e8.point() - e8.lineStart(e8.lineOf(e8.point()))];
}

/** Goes to the line of FILE in the unstaged or staged diff, as magit-status--goto-file-position. */
function gotoFilePosition(file: string, line: number): void {
  for (const parent of ["unstaged", "staged"]) {
    const list = magitGetSection([[parent, undefined], ["status", undefined]]);
    const diff = list?.children.find((c) => (c.value as FileValue | undefined)?.file === file);
    if (!diff) continue;
    show(diff);
    for (const hunk of diff.children) {
      const v = hunk.value as FileValue;
      const range = v.hunk?.toRange;
      if (!range) continue;
      const [beg, len] = range;
      if (beg > line) {
        e8.gotoChar(diff.start);
        return magitSectionReveal(diff);
      }
      if (line <= beg + len) {
        // The line within the hunk: count the lines that are not removals.
        let p = hunk.content;
        let n = beg;
        while (p < hunk.end && n < line) {
          if (e8.charAfter(p) !== "-") n++;
          p = e8.lineEnd(e8.lineOf(p)) + 1;
        }
        e8.gotoChar(Math.min(p, hunk.end - 1));
        return magitSectionReveal(hunk);
      }
    }
    e8.gotoChar(diff.start);
    return magitSectionReveal(diff);
  }
}

/** Shows the status buffer of DIRECTORY's repository, as magit-status-setup-buffer. */
export function magitStatusSetupBuffer(directory?: string, forceFilePosition = false): string {
  const dir = directory ?? String(e8.variable("default-directory"));
  const position = getFilePosition(forceFilePosition);
  return e8.letBind({ "default-directory": dir }, () => {
    const name = magitBufferName("magit-status-mode");
    const existed = e8.bufferLiveP(e8.getBuffer(name));
    const [dargs, dfiles] = statusArgs(name, "diff");
    const [largs, lfiles] = statusArgs(name, "log");
    magitSetupBuffer(name, magitStatusMode, "status", magitStatusRefreshBuffer, true, {
      "magit-buffer-diff-args": dargs,
      "magit-buffer-diff-files": dfiles,
      "magit-buffer-log-args": largs,
      "magit-buffer-log-files": lfiles,
    });
    e8.withCurrentBuffer(name, () => {
      if (position) gotoFilePosition(position[0], position[1]);
      else if (!existed) gotoInitialSection();
    });
    return name;
  });
}

/** The diff or log arguments of an existing status buffer as magit-status-use-buffer-arguments allows, or the defaults. */
function statusArgs(name: string, kind: "diff" | "log"): [string[], string[]] {
  const use = String(e8.variable("magit-status-use-buffer-arguments") ?? "selected");
  const live = e8.bufferLiveP(e8.getBuffer(name));
  const shown = live && e8.windowList().some((w) => e8.windowBuffer(w) === name);
  const current = e8.bufferName() === name;
  if (live && (use === "always" || (use === "selected" && shown) || (use === "current" && current))) {
    return e8.withCurrentBuffer(name, () =>
      kind === "diff"
        ? [(e8.variable("magit-buffer-diff-args") as string[] | null) ?? ["--no-ext-diff"], (e8.variable("magit-buffer-diff-files") as string[] | null) ?? []]
        : [(e8.variable("magit-buffer-log-args") as string[] | null) ?? ["-n256", "--decorate"], (e8.variable("magit-buffer-log-files") as string[] | null) ?? []],
    );
  }
  return kind === "diff" ? [magitDiffArguments("magit-status-mode")[0], []] : [magitLogArguments("magit-status-mode")[0], []];
}

/** Makes a repository in DIRECTORY and shows its status, as magit-init. */
export function magitInit(directory: string): void {
  const dir = e8.fileNameAsDirectory(e8.expandFileName(directory));
  const top = magitToplevel(dir);
  if (top) {
    if (top === dir) e8.userError(`${dir} is already a repository`);
    if (!e8.yOrNP(`${dir} is inside a repository.  Create another? `)) e8.userError("Abort");
  }
  e8.makeDirectory(dir, { parents: true });
  e8.callProcess([magitGitExecutable(), "init", dir], { directory: dir });
  magitStatusSetupBuffer(dir);
}

export const magitStatus = e8.defineCommand({
  name: "magit-status",
  doc: "Show the status of the current Git repository in a buffer; outside one, offer to make one.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const top = magitToplevel();
    if (top && !truthy(prefix)) return void magitStatusSetupBuffer(top);
    const answer = e8.readFileName(truthy(prefix) ? "Git repository: " : "Initialize Git repository: ", { dir: String(e8.variable("default-directory")) });
    const dir = e8.fileNameAsDirectory(e8.expandFileName(answer));
    const toplevel = magitToplevel(dir);
    if (toplevel && toplevel === dir) return void magitStatusSetupBuffer(dir);
    if (!e8.yOrNP(toplevel ? `${toplevel} is a repository.  Create another in ${dir}? ` : `Create repository in ${dir}? `)) return;
    magitInit(dir);
  },
});
e8.defineCommand({
  name: "magit-init",
  doc: "Initialize a Git repository, then show its status.",
  run: () => magitInit(e8.readFileName("Create repository in: ", { dir: String(e8.variable("default-directory")) })),
});
e8.defineCommand({
  name: "magit-status-here",
  doc: "Like magit-status, going to the position in the status buffer that corresponds to the position in the file.",
  run: () => {
    for (const b of e8.bufferList()) {
      e8.withCurrentBuffer(b, () => {
        const f = e8.bufferFileName();
        const top = magitToplevel();
        if (f && top && e8.bufferModified() && e8.expandFileName(f).startsWith(top)) e8.call("save-buffer");
      });
    }
    magitStatusSetupBuffer(undefined, true);
  },
});
e8.defineCommand({
  name: "magit-status-quick",
  doc: "Show the status of the current Git repository, without refreshing it unless it is already shown.",
  params: [{ name: "prefix", kind: "prefix" }],
  run: (prefix: e8.Value) => {
    const buf = magitGetModeBuffer("magit-status-mode");
    const shown = buf && e8.windowList().some((w) => e8.windowBuffer(w) === buf);
    if (!truthy(prefix) && buf && !shown) magitDisplayBuffer(buf);
    else e8.call(magitStatus);
  },
});
e8.defalias("magit", "magit-status");

// Jumping to a section.

/** Defines a command that jumps to the section of TYPE and VALUE, expanding it with a prefix argument, as magit-define-section-jumper. */
function sectionJumper(name: string, heading: string, type: string, value?: unknown): e8.DefinedCommand {
  return e8.defineCommand({
    name,
    doc: `Jump to the section "${heading}".  With a prefix argument also expand it.`,
    params: [{ name: "expand", kind: "prefix" }],
    run: (expand: e8.Value) => {
      const root = sections()?.root;
      const s = root && magitGetSection([[type, value], [root.type, root.value]]);
      if (!s) return e8.message(`Section "${heading}" wasn't found`);
      e8.gotoChar(s.start);
      if (truthy(expand)) show(s);
    },
  });
}
const jumpers = {
  stashes: sectionJumper("magit-jump-to-stashes", "Stashes", "stashes", "refs/stash"),
  tracked: sectionJumper("magit-jump-to-tracked", "Tracked files", "tracked"),
  untracked: sectionJumper("magit-jump-to-untracked", "Untracked files", "untracked"),
  ignored: sectionJumper("magit-jump-to-ignored", "Ignored files", "ignored"),
  unstaged: sectionJumper("magit-jump-to-unstaged", "Unstaged changes", "unstaged"),
  staged: sectionJumper("magit-jump-to-staged", "Staged changes", "staged"),
  unpulledUpstream: sectionJumper("magit-jump-to-unpulled-from-upstream", "Unpulled from @{upstream}", "unpulled", "..@{upstream}"),
  unpulledPush: e8.defineCommand({
    name: "magit-jump-to-unpulled-from-pushremote",
    doc: 'Jump to the section "Unpulled from <push-remote>".  With a prefix argument also expand it.',
    params: [{ name: "expand", kind: "prefix" }],
    run: (expand: e8.Value) => jumpTo("unpulled", `..${magitGetPushBranch() ?? ""}`, "Unpulled from <push-remote>", expand),
  }),
  unpushedUpstream: sectionJumper("magit-jump-to-unpushed-to-upstream", "Unpushed to @{upstream}", "unpushed", "@{upstream}.."),
  unpushedPush: e8.defineCommand({
    name: "magit-jump-to-unpushed-to-pushremote",
    doc: 'Jump to the section "Unpushed to <push-remote>".  With a prefix argument also expand it.',
    params: [{ name: "expand", kind: "prefix" }],
    run: (expand: e8.Value) => jumpTo("unpushed", `${magitGetPushBranch() ?? ""}..`, "Unpushed to <push-remote>", expand),
  }),
  assumeUnchanged: sectionJumper("magit-jump-to-assume-unchanged", "Assume-unchanged files", "assume-unchanged"),
  skipWorktree: sectionJumper("magit-jump-to-skip-worktree", "Skip-worktree files", "skip-worktree"),
};
function jumpTo(type: string, value: string, heading: string, expand: e8.Value): void {
  const root = sections()?.root;
  const s = root && magitGetSection([[type, value], [root.type, root.value]]);
  if (!s) return e8.message(`Section "${heading}" wasn't found`);
  e8.gotoChar(s.start);
  if (truthy(expand)) show(s);
}

export const magitStatusJump = transientDefinePrefix("magit-status-jump", {
  doc: "In a Magit-Status buffer, jump to a section.",
  groups: [
    {
      items: [
        {
          description: "Jump to",
          items: [
            ["z ", "Stashes", jumpers.stashes],
            ["t ", "Tracked files", jumpers.tracked],
            ["n ", "Untracked files", jumpers.untracked],
            ["i ", "Ignored files", jumpers.ignored],
            ["u ", "Unstaged changes", jumpers.unstaged],
            ["s ", "Staged changes", jumpers.staged],
          ],
        },
        {
          description: "",
          items: [
            ["fu", "Unpulled from @{upstream}", jumpers.unpulledUpstream],
            ["fp", "Unpulled from <push-remote>", jumpers.unpulledPush],
            ["pu", "Unpushed to @{upstream}", jumpers.unpushedUpstream],
            ["pp", "Unpushed to <push-remote>", jumpers.unpushedPush],
            ["a ", "Assume-unchanged files", jumpers.assumeUnchanged],
            ["w ", "Skip-worktree files", jumpers.skipWorktree],
          ],
        },
        { description: "Jump using", items: [["j", "Imenu", "imenu"]] },
      ],
    },
  ],
});
e8.defineKey("magit-status-mode-map", "j", magitStatusJump);

e8.defineKeymap("magit-untracked-section-map", null);
e8.defineKeymap("magit-unstaged-section-map", null);
e8.defineKeymap("magit-staged-section-map", null);
e8.defineKeymap("magit-error-section-map", null);
e8.remapCommand("magit-unstaged-section-map", "magit-visit-thing" as e8.CommandName, "magit-diff-unstaged" as e8.CommandName);
e8.remapCommand("magit-staged-section-map", "magit-visit-thing" as e8.CommandName, "magit-diff-staged" as e8.CommandName);
e8.remapCommand("magit-error-section-map", "magit-visit-thing" as e8.CommandName, "magit-process-buffer" as e8.CommandName);
for (const t of ["untracked", "unstaged", "staged", "error"]) magitSectionDefineType(t, { keymap: `magit-${t}-section-map` });

void magitGitRun;
