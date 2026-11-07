// SPDX-License-Identifier: GPL-3.0-or-later
//
// The references buffer, after magit-refs.el: y lists the local branches
// with their upstreams and how far ahead and behind they are, each
// remote's branches and the tags, each with the commits it has that the
// focused one lacks; C-u y or y in the buffer shows the menu of what to
// compare with and which refs to list.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, insertHeading, insertRoot, insertSection, magitInsertSectionBody, magitSectionDefineType, magitSectionMatch } from "magit-section";
import { truthy } from "subr";
import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingRead, prefixArgP } from "magit-base";
import {
  magitAbbrevArg,
  magitGet,
  magitGetCurrentBranch,
  magitGitLines,
  magitGitRun,
  magitListRefs,
  magitListRemotes,
  magitReadOtherBranch,
  magitRefNamespaces,
  magitRevDiffCount,
  magitRevFormat,
  magitRevParse,
  magitRevVerify,
} from "magit-git";
import { magitBufferName, magitMode, magitRefresh, magitSetupBuffer } from "magit-mode";
import { inserters, magitShowCommit, magitUseBufferArguments, magitUseBufferArgumentsBuffer, runSectionHook } from "magit-diff";
import { magitLogWashLog, magitLogWashSummary } from "magit-log";
import { magitLogFormatMargin, magitMakeMarginOverlay, magitRightMarginActive, magitSetBufferMargins } from "magit-margin";
import { magitTransientReadRevision } from "magit-transient";

e8.defineVariable({
  name: "magit-refs-sections-hook",
  doc: "Hook run to insert sections into a references buffer.",
  value: ["magit-insert-error-header", "magit-insert-branch-description", "magit-insert-local-branches", "magit-insert-remote-branches", "magit-insert-tags"],
});
e8.defineVariable({ name: "magit-refs-show-commit-count", doc: "Whether to show commit counts in Magit-Refs mode buffers: all, branch (t), or nil.", value: null });
e8.defineVariable({ name: "magit-refs-pad-commit-counts", doc: "Whether to pad all counts on all sides in magit-refs-mode buffers.", value: false });
e8.defineVariable({ name: "magit-refs-show-push-remote", doc: "Whether to show the push-remotes of local branches.", value: false });
e8.defineVariable({ name: "magit-refs-show-remote-prefix", doc: "Whether to show the remote prefix in lists of remote branches.", value: false });
e8.defineVariable({ name: "magit-refs-show-branch-descriptions", doc: "Whether to show the description, if any, of local branches.", value: false });
e8.defineVariable({ name: "magit-refs-margin-for-tags", doc: "Whether to show information about tags in the margin.", value: false });
e8.defineVariable({ name: "magit-refs-primary-column-width", doc: "Width of the primary column in magit-refs-mode buffers: a number, or [min, max] to fit the local branches' names.", value: [16, 32] });
e8.defineVariable({ name: "magit-refs-focus-column-width", doc: "Width of the focus column in magit-refs-mode buffers.", value: 5 });
e8.defineVariable({ name: "magit-refs-filter-alist", doc: "Alist controlling which refs are omitted from magit-refs-mode buffers: [regexp or function, show] pairs, the first matching deciding.", value: null });
e8.defineVariable({ name: "magit-visit-ref-behavior", doc: "Control how magit-visit-ref behaves in magit-refs-mode buffers: a list of focus-on-ref, create-branch, checkout-any and checkout-branch.", value: null });
e8.defineVariable({ name: "magit-buffer-upstream", doc: "The ref a refs buffer compares the others with.", value: null });

export const magitRefsMode = e8.defineMajorMode({
  name: "magit-refs-mode",
  modeName: "Magit Refs",
  parent: magitMode,
  doc: "Mode which lists and compares references.",
});

const face = (text: string, f: string | string[]): e8.PropertizedString => e8.propertize(text, { "font-lock-face": f });
const upstreamRef = (): string => String(e8.variable("magit-buffer-upstream") ?? "HEAD");
const bufferArgs = (): string[] => (e8.variable("magit-buffer-arguments") as string[] | null) ?? [];

/** The primary column's width now: the buffer's own once the local branches set it. */
let primaryWidth = 16;
function primaryColumnWidth(): number {
  const def = e8.variable("magit-refs-primary-column-width") as unknown;
  return typeof def === "number" ? def : primaryWidth;
}

/** Makes the references buffer comparing with REF, as magit-refs-setup-buffer. */
export function magitRefsSetupBuffer(ref: string | undefined, args: string[]): void {
  magitSetupBuffer(magitBufferName("magit-refs-mode"), magitRefsMode, "refs", magitRefsRefreshBuffer, true, {
    "magit-buffer-upstream": ref ?? "HEAD",
    "magit-buffer-arguments": args,
  });
}

/** Makes the references buffer's content, as magit-refs-refresh-buffer. */
export function magitRefsRefreshBuffer(): void {
  magitSetBufferMargins();
  if (!magitRevVerify(upstreamRef())) {
    e8.makeLocalVariable("magit-refs-show-commit-count");
    e8.setVariable("magit-refs-show-commit-count", null);
  }
  e8.makeLocalVariable("header-line-format");
  e8.setVariable("header-line-format", e8.propertize(` ${upstreamRef()} ${bufferArgs().join(" ")}`, { face: "magit-header-line" }));
  insertRoot("branchbuf", () => runSectionHook("magit-refs-sections-hook"));
}

// Commands.

/**
 * The arguments the references buffer uses, as magit-show-refs-arguments:
 * the menu's, the current references buffer's, or another's as
 * USE-BUFFER-ARGS allows, by default magit-direct-use-buffer-arguments.
 */
export function magitShowRefsArguments(useBufferArgs = "direct"): string[] {
  if (String(e8.variable("transient-current-command") ?? "") === "magit-show-refs") return transientArgs("magit-show-refs");
  return refsBufferArguments(useBufferArgs) ?? transientArgs("magit-show-refs");
}

/** The current references buffer's arguments, or another's as USE-BUFFER-ARGS allows. */
function refsBufferArguments(useBufferArgs: string): string[] | undefined {
  if (String(e8.variable("major-mode")) === "magit-refs-mode") return bufferArgs();
  const buffer = magitUseBufferArgumentsBuffer("magit-refs-mode", magitUseBufferArguments(useBufferArgs));
  const args = buffer && e8.bufferLocalValue("magit-buffer-arguments", buffer);
  return Array.isArray(args) ? (args as string[]) : undefined;
}

export const magitShowRefsHead = e8.defineCommand({
  name: "magit-show-refs-head",
  doc: "List and compare references in a dedicated buffer.  Compared with HEAD.",
  run: () => magitRefsSetupBuffer("HEAD", magitShowRefsArguments()),
});
export const magitShowRefsCurrent = e8.defineCommand({
  name: "magit-show-refs-current",
  doc: "List and compare references in a dedicated buffer.  Compare with the current branch or HEAD if it is detached.",
  run: () => magitRefsSetupBuffer(magitGetCurrentBranch(), magitShowRefsArguments()),
});
export const magitShowRefsOther = e8.defineCommand({
  name: "magit-show-refs-other",
  doc: "List and compare references in a dedicated buffer.  Compared with a branch read from the user.",
  run: () => magitRefsSetupBuffer(magitReadOtherBranch("Compare with"), magitShowRefsArguments()),
});
export const magitRefsSetShowCommitCount = e8.defineCommand({
  name: "magit-refs-set-show-commit-count",
  doc: "Change for which refs the commit count is shown.",
  run: () => {
    const c = e8.readCharChoice("Show commit counts for [a]ll refs, [b]ranches only, [n]othing ", "abn");
    e8.makeLocalVariable("magit-refs-show-commit-count");
    e8.setVariable("magit-refs-show-commit-count", c === "a" ? "all" : c === "b" ? true : null);
    magitRefresh();
  },
});

/** Reads a sort key, as magit-read-ref-sort. */
const readRefSort = (prompt: string, initial?: string): string => magitCompletingRead(prompt, ["-committerdate", "-authordate", "committerdate", "authordate"], { initialInput: initial }) ?? "";

export const magitShowRefsMenu = transientDefinePrefix("magit-show-refs-menu", {
  doc: "List and compare references in a dedicated buffer.",
  value: () => refsBufferArguments("prefix") ?? [],
  groups: [
    {
      description: "Arguments",
      items: [
        ["-c", "Contains", "--contains=", { reader: magitTransientReadRevision }],
        ["-M", "Merged", "--merged=", { reader: magitTransientReadRevision }],
        ["-m", "Merged to HEAD", "--merged"],
        ["-N", "Not merged", "--no-merged=", { reader: magitTransientReadRevision }],
        ["-n", "Not merged to HEAD", "--no-merged"],
        ["-s", "Sort", "--sort=", { reader: readRefSort }],
      ],
    },
    {
      description: "Actions",
      items: [
        ["y", "Show refs, comparing them with HEAD", magitShowRefsHead],
        ["c", "Show refs, comparing them with current branch", magitShowRefsCurrent],
        ["o", "Show refs, comparing them with other branch", magitShowRefsOther],
        ["r", "Show refs, changing commit count display", magitRefsSetShowCommitCount],
      ],
    },
  ],
});

export const magitShowRefs = e8.defineCommand({
  name: "magit-show-refs",
  doc: "List and compare references in a dedicated buffer.  In a references buffer, or with a prefix argument, show the menu of what to compare with.",
  run: () => {
    if (String(e8.variable("major-mode")) === "magit-refs-mode" || prefixArgP()) e8.call(magitShowRefsMenu);
    else magitRefsSetupBuffer("HEAD", magitShowRefsArguments());
  },
});

export const magitVisitRef = e8.defineCommand({
  name: "magit-visit-ref",
  doc: "Visit the reference or revision at point in another buffer.  This behaves like magit-show-commit, except on a reference in a refs buffer when magit-visit-ref-behavior says otherwise.",
  run: () => {
    const behavior = ((e8.variable("magit-visit-ref-behavior") as string[] | null) ?? []).map(String);
    const s = currentSection();
    if (String(e8.variable("major-mode")) !== "magit-refs-mode" || !s || !magitSectionMatch(["branch", "tag"], s)) return void e8.call(magitShowCommit);
    const ref = String(s.value);
    if (prefixArgP() && behavior.includes("focus-on-ref")) return magitRefsSetupBuffer(ref, magitShowRefsArguments());
    if (behavior.includes("create-branch") && magitSectionMatch([["branch", "remote"]], s)) {
      const branch = ref.slice(ref.indexOf("/") + 1);
      if (magitRevVerify(`refs/heads/${branch}`)) {
        if (magitRevParse(branch) === magitRevParse(ref)) magitGitRun(["checkout", branch]);
        else {
          const c = e8.readCharChoice(`Branch ${branch} already exists.\n  [c]heckout ${branch} as-is\n  [r]reset ${branch} to ${ref} and checkout ${branch}\n  [a]bort `, "cra");
          if (c === "a") e8.userError("Abort");
          magitGitRun(c === "c" ? ["checkout", branch] : ["checkout", "-B", branch, ref]);
        }
      } else magitGitRun(["checkout", "-b", branch, ref]);
      e8.setVariable("magit-buffer-upstream", branch);
      return magitRefresh();
    }
    if (behavior.includes("checkout-any") || (behavior.includes("checkout-branch") && magitSectionMatch([["branch", "local"]], s))) {
      magitGitRun(["checkout", ref]);
      e8.setVariable("magit-buffer-upstream", ref);
      return magitRefresh();
    }
    e8.call(magitShowCommit);
  },
});

// Sections.

magitSectionDefineType("branch", { keymap: "magit-branch-section-map" });
magitSectionDefineType("tag", { keymap: "magit-tag-section-map" });
magitSectionDefineType("remote", { keymap: "magit-remote-section-map" });
/** The keys of a shelved branch's section, as magit-shelved-branch-section-map. */
e8.defineKeymap("magit-shelved-branch-section-map", null);
e8.remapCommand("magit-shelved-branch-section-map", "magit-delete-thing" as e8.CommandName, "magit-delete-shelved-branch" as e8.CommandName);
magitSectionDefineType("shelved-branch", { keymap: "magit-shelved-branch-section-map" });
for (const map of ["magit-branch-section-map", "magit-tag-section-map", "magit-remote-section-map"]) e8.defineKeymap(map, null);
for (const [map, bindings] of [
  ["magit-branch-section-map", [["magit-file-rename", "magit-branch-rename"], ["magit-delete-thing", "magit-branch-delete"], ["magit-visit-thing", "magit-visit-ref"]]],
  ["magit-tag-section-map", [["magit-delete-thing", "magit-tag-delete"], ["magit-visit-thing", "magit-visit-ref"]]],
  ["magit-remote-section-map", [["magit-file-rename", "magit-remote-rename"], ["magit-delete-thing", "magit-remote-remove"]]],
] as [string, [string, string][]][]) {
  for (const [from, to] of bindings) e8.remapCommand(map, from as e8.CommandName, to as e8.CommandName);
}

/** Whether REFNAME is listed, as magit-refs-filter-alist says, as magit-refs--insert-refname-p. */
function insertRefnameP(refname: string): boolean {
  for (const [key, show] of (e8.variable("magit-refs-filter-alist") as unknown as [unknown, unknown][] | null) ?? []) {
    const match = typeof key === "string" ? e8.stringMatch(key, refname) !== undefined : truthy(e8.funcall(key as never, refname));
    if (match) return truthy(show as e8.Value);
  }
  return true;
}

/** BRANCH faced as its ref's namespace says, with HEADFACE too, as magit-refs--propertize-branch. */
function propertizeBranch(branch: string, ref: string, headFace?: string): e8.PropertizedString {
  const f = magitRefNamespaces.find(([re]) => re.test(ref))?.[1] ?? "magit-refname";
  return face(branch, headFace ? [f, headFace] : f);
}

/** The focus column: * or @ for the focused ref, or how far REF is ahead or behind it, as magit-refs--format-focus-column. */
function formatFocusColumn(ref: string | undefined, type?: "tag" | true): e8.PropertizedString {
  const focus = upstreamRef();
  const count = e8.variable("magit-refs-show-commit-count");
  const width = truthy(count) ? Number(e8.variable("magit-refs-focus-column-width") ?? 5) : 1;
  let text = "";
  let f = "magit-dimmed";
  if (ref === focus || (type === true && focus === "HEAD")) {
    text = `${focus === "HEAD" ? "@" : "*"}${" ".repeat(width - 1)}`;
    f = "magit-section-heading";
  } else if (ref !== undefined && (type === "tag" ? count === "all" : truthy(count))) {
    const [behind, ahead] = magitRevDiffCount(focus, ref);
    text = ahead > 0 ? `<${ahead}` : behind > 0 ? `${behind}>` : "=";
  }
  return e8.concat(" ".repeat(Math.max(0, width - text.length)), text === "" ? "" : face(text, f), " ");
}

/** The commits REF has that the focused ref lacks, as the section's body, as magit-refs--insert-cherry-commits. */
function insertCherryCommits(ref: string): void {
  magitInsertSectionBody(() => {
    const r = magitGitRun(["cherry", "-v", magitAbbrevArg(), upstreamRef(), ref]);
    if (r.exit !== 0 || r.output === "") return void e8.message(`No cherries for ${ref}`);
    magitLogWashLog("cherry", r.output, []);
    magitMakeMarginOverlay();
  });
}

/** Shows REV's committer and date in the margin, as magit-refs--maybe-format-margin. */
function maybeFormatMargin(rev: string | undefined): void {
  if (!magitRightMarginActive()) return;
  const line = rev ? magitRevFormat("%cN%x00%ct", rev) : undefined;
  if (line) {
    const [author, date] = line.split("\0");
    magitLogFormatMargin(rev!, author, date);
  } else magitMakeMarginOverlay();
}

/** Inserts the current branch's description, as magit-insert-branch-description. */
export function magitInsertBranchDescription(): void {
  const branch = magitGetCurrentBranch();
  const descText = branch ? magitGet("branch", branch, "description") : undefined;
  if (!branch || !descText) return;
  const desc = descText.split("\n");
  if (desc[desc.length - 1] === "") desc.pop();
  insertSection("branchdesc", branch, true, () => {
    insertHeading(branch, ": ", desc[0]);
    if (desc.length > 1) {
      e8.insert(desc.slice(1).join("\n"));
      e8.insert("\n\n");
    }
  });
}

/** One local branch's row: its width, name, and the strings of its heading, as magit-refs--format-local-branch. */
interface LocalRow {
  /** The width the row's primary column wants, as the car of Magit's rows. */
  width: number;
  branch: string | undefined;
  /** The width of the name and counts before the padding. */
  used: number;
  before: (string | e8.PropertizedString | undefined)[];
  after: (string | e8.PropertizedString | undefined)[];
}
function formatLocalBranch(line: string): LocalRow | undefined {
  const [head, branchIn, ref, upstream, uRef, uTrack, push, pRef, pTrack, msg] = line.split("\0").map((x) => (x === "" ? undefined : x));
  const branch = branchIn;
  if (branch && !insertRefnameP(branch)) return undefined;
  const pad = truthy(e8.variable("magit-refs-pad-commit-counts"));
  const headp = head === "*";
  const pushp = push !== undefined && truthy(e8.variable("magit-refs-show-push-remote")) && pRef !== undefined && magitRevVerify(pRef) !== undefined && pRef !== uRef;
  const branchPretty = branch ? propertizeBranch(branch, ref ?? "", headp ? "magit-branch-current" : undefined) : face("(detached)", "magit-branch-warning");
  const m = (re: RegExp, s?: string) => (s ? re.exec(s)?.[1] : undefined);
  const uAheadN = m(/ahead ([0-9]+)/, uTrack);
  const uBehindN = m(/behind ([0-9]+)/, uTrack);
  const pAheadN = pushp ? m(/ahead ([0-9]+)/, pTrack) : undefined;
  const pBehindN = pushp ? m(/behind ([0-9]+)/, pTrack) : undefined;
  const uAhead = uAheadN ? face(`${pad ? " " : ""}${uAheadN}>`, "magit-dimmed") : undefined;
  const uBehind = uBehindN ? face(`<${uBehindN}${pad ? " " : ""}`, "magit-dimmed") : undefined;
  const pAhead = pAheadN ? face(`${pAheadN}>${pad ? " " : ""}`, "magit-branch-remote") : undefined;
  const pBehind = pBehindN ? face(`<${pBehindN}${pad ? " " : ""}`, "magit-dimmed") : undefined;
  const plain = (x: string | undefined, prefix = "", suffix = "") => (x === undefined ? "" : `${prefix}${x}${suffix}`);
  const widthText = (branch ?? "(detached)") + plain(uAheadN, pad ? " " : "", ">") + plain(pAheadN, "", pad ? "> " : ">") + plain(uBehindN, "<", pad ? " " : "");
  const description = branch && truthy(e8.variable("magit-refs-show-branch-descriptions")) ? magitGet("branch", branch, "description") : undefined;
  return {
    width: 1 + widthText.length,
    branch,
    used: widthText.length,
    before: [formatFocusColumn(branch, headp || undefined), branchPretty, uAhead, pAhead],
    after: [
      uBehind,
      upstream ? e8.concat(uTrack === "[gone]" ? face(upstream, "error") : propertizeBranch(upstream, uRef ?? ""), " ") : undefined,
      pushp ? e8.concat(pBehind ?? "", face(push!, "magit-branch-remote"), " ") : undefined,
      description ? face(description, "bold") : msg ? magitLogWashSummary(msg) : undefined,
    ],
  };
}

/** The local branches' rows, padded to the primary column, as magit-refs--format-local-branches. */
function formatLocalBranches(): [string | undefined, (string | e8.PropertizedString)[]][] {
  const format = `--format=%(HEAD)%00%(refname:short)%00%(refname)%00%(upstream:short)%00%(upstream)%00%(upstream:track)%00${truthy(e8.variable("magit-refs-show-push-remote")) ? "%(push:remotename)%00%(push)%00%(push:track)%00%(subject)" : "%00%00%00%(subject)"}`;
  const rows = magitGitLines("for-each-ref", format, "refs/heads", ...bufferArgs())
    .map(formatLocalBranch)
    .filter((r): r is LocalRow => r !== undefined);
  if (!magitGetCurrentBranch()) {
    const detached = formatLocalBranch(`*\0\0\0\0\0\0\0\0${magitRevFormat("%s") ?? ""}`);
    if (detached) rows.unshift(detached);
  }
  const def = e8.variable("magit-refs-primary-column-width") as unknown;
  primaryWidth = typeof def === "number" ? def : Math.min((def as number[])[1], Math.max((def as number[])[0], ...rows.map((r) => r.width)));
  const present = (x: string | e8.PropertizedString | undefined): x is string | e8.PropertizedString => x !== undefined;
  return rows.map((r) => [r.branch, [...r.before.filter(present), " ".repeat(Math.max(1, primaryWidth - r.used)), ...r.after.filter(present)]]);
}

/** Inserts the local branches, as magit-insert-local-branches. */
export function magitInsertLocalBranches(): void {
  insertSection("local", undefined, false, () => {
    insertHeading(true, "Branches");
    for (const [branch, strings] of formatLocalBranches()) {
      insertSection(branch ? "branch" : "commit", branch ?? magitRevParse("HEAD"), true, () => {
        insertHeading(...strings, "\n");
        maybeFormatMargin(branch);
        if (branch) insertCherryCommits(branch);
      });
    }
    e8.insert("\n");
    magitMakeMarginOverlay();
  });
}

/** Inserts each remote's branches, as magit-insert-remote-branches. */
export function magitInsertRemoteBranches(): void {
  for (const remote of magitListRemotes()) {
    insertSection("remote", remote, false, () => {
      const pull = magitGet("remote", remote, "url");
      const push = magitGet("remote", remote, "pushurl");
      insertHeading(e8.concat(face("Remote ", "magit-section-heading"), face(remote, "magit-branch-remote"), face(` (${pull ?? ""}${pull && push ? ", " : ""}${push ?? ""}):`, "magit-section-heading")), "\n");
      let head: string | undefined;
      for (const line of magitGitLines("for-each-ref", "--format=%(symref:short)%00%(refname:short)%00%(refname)%00%(subject)", `refs/remotes/${remote}`, ...bufferArgs())) {
        const [headBranch, branch, ref, msg] = line.split("\0").map((x) => (x === "" ? undefined : x));
        if (headBranch) {
          head = headBranch;
          continue;
        }
        if (ref === `refs/remotes/${remote}/HEAD` || !branch || !insertRefnameP(branch)) continue;
        insertSection("branch", branch, true, () => {
          const abbrev = truthy(e8.variable("magit-refs-show-remote-prefix")) ? branch : branch.slice(remote.length + 1);
          insertHeading(
            formatFocusColumn(branch),
            propertizeBranch(abbrev, ref ?? "", branch === head ? "magit-branch-remote-head" : undefined),
            " ".repeat(Math.max(1, primaryColumnWidth() - abbrev.length)),
            msg ? magitLogWashSummary(msg) : "",
            "\n",
          );
          maybeFormatMargin(branch);
          insertCherryCommits(branch);
        });
      }
      e8.insert("\n");
      magitMakeMarginOverlay();
    });
  }
}

/** Inserts the tags, as magit-insert-tags. */
export function magitInsertTags(): void {
  const tags = magitGitLines("tag", "--list", "-n", ...bufferArgs());
  if (tags.length === 0) return;
  insertSection("tags", undefined, false, () => {
    insertHeading(tags.length, "Tags");
    for (const line of tags) {
      const m = /^([^ \t]+)[ \t]+([^ \t\n].*)?/.exec(line);
      const tag = m?.[1] ?? line;
      const msg = m?.[2];
      if (!insertRefnameP(tag)) continue;
      insertSection("tag", tag, true, () => {
        insertHeading(formatFocusColumn(tag, "tag"), face(tag, "magit-tag"), " ".repeat(Math.max(1, primaryColumnWidth() - tag.length)), msg ? magitLogWashSummary(msg) : "", "\n");
        if (truthy(e8.variable("magit-refs-margin-for-tags"))) maybeFormatMargin(tag);
        insertCherryCommits(tag);
      });
    }
    e8.insert("\n");
    magitMakeMarginOverlay();
  });
}

/** Inserts the shelved branches, as magit-insert-shelved-branches. */
export function magitInsertShelvedBranches(): void {
  const refs = magitListRefs("refs/shelved/");
  if (refs.length === 0) return;
  insertSection("shelved", undefined, true, () => {
    insertHeading(true, "Shelved branches");
    for (const ref of refs.slice().reverse()) {
      insertSection("shelved-branch", ref, true, () => {
        insertHeading("  ", face(ref.slice(13), "magit-refname"), "\n");
        maybeFormatMargin(ref);
        insertCherryCommits(ref);
      });
    }
    e8.insert("\n");
    magitMakeMarginOverlay();
  });
}

for (const [name, fn] of [
  ["magit-insert-branch-description", magitInsertBranchDescription],
  ["magit-insert-local-branches", magitInsertLocalBranches],
  ["magit-insert-remote-branches", magitInsertRemoteBranches],
  ["magit-insert-tags", magitInsertTags],
  ["magit-insert-shelved-branches", magitInsertShelvedBranches],
] as const)
  inserters.set(name, fn);

// Keys, as magit-refs-mode-map binds them.
e8.defineKey("magit-refs-mode-map", "C-y", magitRefsSetShowCommitCount);
e8.defineKey("magit-refs-mode-map", "L", "magit-margin-settings" as e8.CommandName);
