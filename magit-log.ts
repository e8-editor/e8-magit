// SPDX-License-Identifier: GPL-3.0-or-later
//
// Logs, after magit-log.el and magit-reflog.el: git log's output washed
// into commit sections, as magit-log-wash-log washes it, with the graph,
// the refs' labels, signatures, and each commit's author and age in the
// margin; with ++header, --patch or --stat each commit's header or diff.
// The log buffer (magit-log-mode) and its commands, the current branch,
// others, related branches, all of them, a file's history, a definition's
// trace; limiting it, moving to a parent; the reflog buffer; the cherry
// buffer; selecting a commit from a log for another command; shortlogs;
// and the status buffer's sections of commits unpushed, unpulled and recent.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { currentSection, insertHeading, insertRoot, insertSection, magitCancelSection, magitSectionDefineType, magitSectionGoto, magitSectionMatch, magitSectionSiblings, sections, type Section } from "magit-section";
import { truthy } from "subr";
import { transientArgs } from "transient";
import { magitCompletingRead, magitReadString, magitWithMinibufferMap } from "magit-base";
import {
  magitAbbrevLength,
  magitBranchOrCommitAtPoint,
  magitCommitAtPoint,
  magitFileRelativeName,
  magitFormatRefLabels,
  magitGetCurrentBranch,
  magitGetCurrentTag,
  magitGetPreviousBranch,
  magitGetPushBranch,
  magitGetUpstreamBranch,
  magitGitExecutable,
  magitGitRun,
  magitGitString,
  magitGitSuccess,
  magitListRefnames,
  magitLocalBranchP,
  magitReadBranchOrCommit,
  magitReadLocalBranchOrRef,
  magitReadOtherBranch,
  magitReadRangeOrCommit,
  magitReadShelvedBranch,
  magitRefAbbrev,
  magitRevAbbrev,
  magitRevAncestorP,
  magitRevDiffCount,
  magitRevFormat,
  magitRevParse,
  magitRevVerify,
} from "magit-git";
import { magitBufferInfo, magitBufferName, magitGetModeBuffer, magitLogMode, magitModeBuryBuffer, magitRefresh, magitRefreshBuffer, magitReflogMode, magitSetupBuffer } from "magit-mode";
import { magitRunGit } from "magit-process";
import { inserters, magitDiffVisitFileNoselect, magitDiffWashDiffs, magitShowCommitRev, magitWithTempPosition, runSectionHook } from "magit-diff";
import { magitLogFormatMargin, magitMakeMarginOverlay, magitRightMarginActive, magitSetBufferMargins } from "magit-margin";

// Faces.

const faces: [string, string, e8.FaceAttributes, e8.FaceAttributes?, e8.FaceAttributes?][] = [
  ["magit-log-graph", "Face for the graph part of the log output.", {}, { foreground: "grey30" }, { foreground: "grey80" }],
  ["magit-log-author", "Face for the author part of the log output.", { slant: "normal", weight: "normal" }, { foreground: "firebrick" }, { foreground: "tomato" }],
  ["magit-log-date", "Face for the date part of the log output.", { slant: "normal", weight: "normal" }, { foreground: "grey30" }, { foreground: "grey80" }],
  ["magit-header-line-log-select", "Face for the header-line in magit-log-select-mode.", { inherit: "bold" }],
  ["magit-cherry-unmatched", "Face for unmatched cherry commits.", { foreground: "cyan" }],
  ["magit-cherry-equivalent", "Face for equivalent cherry commits.", { foreground: "magenta" }],
  ["magit-signature-good", "Face for good signatures.", { foreground: "green" }],
  ["magit-signature-bad", "Face for bad signatures.", { foreground: "red", weight: "bold" }],
  ["magit-signature-untrusted", "Face for good untrusted signatures.", { foreground: "medium aquamarine" }],
  ["magit-signature-expired", "Face for signatures that have expired.", { foreground: "orange" }],
  ["magit-signature-expired-key", "Face for signatures made by an expired key.", { inherit: "magit-signature-expired" }],
  ["magit-signature-revoked", "Face for signatures made by a revoked key.", { foreground: "violet red" }],
  ["magit-signature-error", "Face for signatures that cannot be checked.", { foreground: "light blue" }],
  ["magit-reflog-commit", "Face for commit commands in reflogs.", { foreground: "green" }],
  ["magit-reflog-amend", "Face for amend commands in reflogs.", { foreground: "magenta" }],
  ["magit-reflog-merge", "Face for merge, checkout and branch commands in reflogs.", { foreground: "green" }],
  ["magit-reflog-checkout", "Face for checkout commands in reflogs.", { foreground: "blue" }],
  ["magit-reflog-reset", "Face for reset commands in reflogs.", { foreground: "red" }],
  ["magit-reflog-rebase", "Face for rebase commands in reflogs.", { foreground: "magenta" }],
  ["magit-reflog-cherry-pick", "Face for cherry-pick commands in reflogs.", { foreground: "green" }],
  ["magit-reflog-remote", "Face for pull and clone commands in reflogs.", { foreground: "cyan" }],
  ["magit-reflog-other", "Face for other commands in reflogs.", { foreground: "cyan" }],
];
for (const [name, doc, attributes, light, dark] of faces) e8.defineFace({ name, doc, attributes, light, dark });

// Options.

e8.defineVariable({ name: "magit-log-section-commit-count", doc: "How many recent commits to show in certain log sections.", value: 10 });
e8.defineVariable({ name: "magit-log-merged-commit-count", doc: "How many surrounding commits to show for magit-log-merged.", value: 20 });
e8.defineVariable({ name: "magit-log-remove-graph-args", doc: "The log arguments that cause --graph to be dropped.", value: ["--follow", "-G", "-S", "-L"] });
e8.defineVariable({ name: "magit-log-revision-headers-format", doc: "Additional format string used with the ++header argument.", value: "%+b%+N\nAuthor:    %aN <%aE>\nCommitter: %cN <%cE>" });
e8.defineVariable({ name: "magit-log-auto-more", doc: "Insert more log entries automatically when moving past the last entry.", value: false });
e8.defineVariable({ name: "magit-log-show-refname-after-summary", doc: "Whether to show refnames after commit summaries.", value: false });
e8.defineVariable({ name: "magit-log-color-graph-limit", doc: "Number of commits over which log graphs are not colored.", value: 256 });
e8.defineVariable({ name: "magit-log-show-signatures-limit", doc: "Number of commits over which signatures are not verified.", value: 256 });
e8.defineVariable({ name: "magit-log-header-line-function", doc: "Function used to make the header line of log buffers.", value: "magit-log-header-line-sentence" });
e8.defineVariable({ name: "magit-reflog-limit", doc: "Maximal number of entries initially shown in reflog buffers.", value: 256 });
e8.defineVariable({ name: "magit-log-select-show-usage", doc: "Whether to show usage information when selecting a commit from a log: both, header-line, echo-area or nil.", value: "both" });
e8.defineVariable({ name: "magit-log-wash-summary-hook", doc: "Functions used to highlight parts of each commit summary.", value: ["magit-highlight-squash-markers", "magit-highlight-bracket-keywords"] });
e8.defineVariable({ name: "magit-cherry-sections-hook", doc: "Hook run to insert sections into the cherry buffer.", value: ["magit-insert-cherry-headers", "magit-insert-cherry-commits"] });

/** The log arguments each kind of buffer has by default, as Magit's modes' magit-log-default-arguments. */
const defaultLogArgs: { [mode: string]: string[] } = {
  "magit-log-mode": ["--graph", "-n256", "--decorate"],
  "magit-status-mode": ["-n256", "--decorate"],
  "magit-log-select-mode": ["--graph", "-n256", "--decorate"],
};

/** The log arguments and files for a buffer of MODE, as magit-log-arguments. */
export function magitLogArguments(mode = "magit-log-mode"): [string[], string[]] {
  const current = e8.variable("transient-current-command");
  if (current === "magit-log" || current === "magit-log-refresh") {
    const args = transientArgs(String(current));
    return [args.filter((a) => !a.startsWith("-- ")), args.filter((a) => a.startsWith("-- ")).flatMap((a) => a.slice(3).split(","))];
  }
  if (String(e8.variable("major-mode")) === mode && Array.isArray(e8.variable("magit-buffer-log-args"))) {
    return [e8.variable("magit-buffer-log-args") as string[], (e8.variable("magit-buffer-log-files") as string[] | null) ?? []];
  }
  return [defaultLogArgs[mode] ?? ["-n256", "--decorate"], []];
}

/** The commit limit -n of ARGS, as magit-log-get-commit-limit. */
export function magitLogGetCommitLimit(args = (e8.variable("magit-buffer-log-args") as string[] | null) ?? []): number | undefined {
  const n = args.find((a) => /^-n([0-9]+)?$/.test(a));
  return n ? Number(n.slice(2)) : undefined;
}

const fl = (text: string, face: string | string[]): e8.PropertizedString => e8.propertize(text, { "font-lock-face": face });

// Washing.

const headingRe = /^([-_/|\\*o<>. ]*)([0-9a-fA-F]+)?\f([^\f\n]+)?\f([BGUXYREN])?\f([^\f\n]*)\f([^\f\n]*)\f(.*)$/;
const cherryRe = /^([-+]) ([0-9a-fA-F]+) (.*)$/;
const moduleRe = /^(?:([<>]) )?([0-9a-fA-F]+) (.*)$/;
const bisectVisRe = /^([-_/|\\*o<>. ]*)([0-9a-fA-F]+)?\0([^\0\n]+)?\0(.*)$/;
const bisectLogRe = /^# ([^: \n]+:) \[([^\]\n]+)\] (.*)$/;
const reflogRe = /^([^\0\n]+)\0([^\0\n]*)\0(?:(?:[^@\n]+@\{([^}\n]+)\}\0(merge |autosave |restart |rewritten |[^:\n]+: )?(.*))|\0)$/;
const stashRe = /^([^\0\n]+)\0([^\0\n]*)\0([^\0\n]+)\0(.*)$/;

export type LogStyle = "log" | "cherry" | "module" | "reflog" | "stash" | "bisect-vis" | "bisect-log";

/** A washed line's parts, as magit-log-wash-rev's match groups name them. */
interface Rev {
  hash?: string;
  msg?: string;
  refs?: string;
  graph?: string;
  author?: string;
  date?: string;
  gpg?: string;
  cherry?: string;
  refsub?: string;
  side?: string;
}

function matchRev(style: LogStyle, line: string): Rev | undefined {
  let m: RegExpExecArray | null;
  switch (style) {
    case "log":
      m = headingRe.exec(line);
      return m ? { graph: m[1], hash: m[2], refs: m[3], gpg: m[4], author: m[5], date: m[6], msg: m[7] } : undefined;
    case "cherry":
      m = cherryRe.exec(line);
      return m ? { cherry: m[1], hash: m[2], msg: m[3] } : undefined;
    case "module":
      m = moduleRe.exec(line);
      return m ? { side: m[1], hash: m[2], msg: m[3] } : undefined;
    case "reflog":
      m = reflogRe.exec(line);
      return m ? { hash: m[1], author: m[2], date: m[3], refsub: m[4], msg: m[5] ?? "" } : undefined;
    case "stash":
      m = stashRe.exec(line);
      return m ? { hash: m[1], author: m[2], date: m[3], msg: m[4] } : undefined;
    case "bisect-vis":
      m = bisectVisRe.exec(line);
      return m ? { graph: m[1], hash: m[2], refs: m[3], msg: m[4] } : undefined;
    case "bisect-log":
      m = bisectLogRe.exec(line);
      return m ? { refs: m[1], hash: m[2], msg: m[3] } : undefined;
  }
}

/** The reflog labels' faces, as magit-reflog-labels. */
const reflogLabels: { [k: string]: string } = {
  commit: "magit-reflog-commit",
  amend: "magit-reflog-amend",
  merge: "magit-reflog-merge",
  checkout: "magit-reflog-checkout",
  branch: "magit-reflog-checkout",
  reset: "magit-reflog-reset",
  rebase: "magit-reflog-rebase",
  rewritten: "magit-reflog-rebase",
  "cherry-pick": "magit-reflog-cherry-pick",
  initial: "magit-reflog-commit",
  pull: "magit-reflog-remote",
  clone: "magit-reflog-remote",
  autosave: "magit-reflog-commit",
  restart: "magit-reflog-reset",
};

/** A reflog entry's subject, its command padded and in its face, as magit-reflog-format-subject. */
export function magitReflogFormatSubject(subject: string): e8.PropertizedString {
  const m = /^([^ ]+) ?((?: ?-[^ ]+)+)?(?: ?\(([^)]+)\))?/.exec(subject);
  const command = m?.[1] ?? "";
  const option = m?.[2];
  const type = m?.[3];
  const label = command === "commit" ? (type ?? command) : command;
  const text = command === "commit" ? label : [command, option, type].filter((x) => x).join(" ");
  // format's padding takes the face of the text it pads.
  return e8.concat(fl(text.padEnd(16), reflogLabels[label] ?? "magit-reflog-other"), " ");
}

/** A commit's summary with its markers and keywords highlighted, as magit-log--wash-summary. */
export function magitLogWashSummary(summary: string): e8.PropertizedString {
  const hooks = (e8.variable("magit-log-wash-summary-hook") as string[] | null) ?? [];
  const runs: [number, number, string][] = [];
  if (hooks.includes("magit-highlight-squash-markers")) {
    const m = /^(squash!|fixup!|amend!)/.exec(summary);
    if (m) runs.push([0, m[0].length, "magit-keyword-squash"]);
  }
  if (hooks.includes("magit-highlight-bracket-keywords")) for (const m of summary.matchAll(/\[[^\][]*\]/g)) runs.push([m.index!, m.index! + m[0].length, "magit-keyword"]);
  if (runs.length === 0) return e8.propertize(summary, {});
  runs.sort((a, b) => a[0] - b[0]);
  const parts: e8.PropertizedString[] = [];
  let at = 0;
  for (const [s, e, f] of runs) {
    if (s < at) continue;
    if (s > at) parts.push(e8.propertize(summary.slice(at, s), {}));
    parts.push(fl(summary.slice(s, e), f));
    at = e;
  }
  if (at < summary.length) parts.push(e8.propertize(summary.slice(at), {}));
  return e8.concat(...parts);
}

/** What a log being washed is: its lines, the next, its style and arguments, and how many commits so far. */
interface LogWash {
  lines: string[];
  i: number;
  style: LogStyle;
  args: string[];
  count: number;
  mode: string;
  abbrev: number;
}

/**
 * Inserts git's log OUTPUT washed into commit sections, as magit-log-wash-log:
 * one a commit, its hash, graph, refs and summary, its author and age in the
 * margin, and what follows it for ++header, --patch or --stat.
 */
export function magitLogWashLog(style: LogStyle, output: string, args: string[]): void {
  let lines = output.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  // Colours of a coloured graph are dropped: E8's logs are not coloured.
  lines = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  if (style === "cherry") lines.reverse();
  const w: LogWash = { lines, i: 0, style, args, count: 0, mode: String(e8.variable("major-mode")), abbrev: magitAbbrevLength() };
  if (lines[0]?.startsWith("...")) w.i++;
  while (w.i < lines.length && washRev(w)) {
    // Each commit.
  }
  if (w.mode === "magit-log-mode" || w.mode === "magit-reflog-mode" || w.mode === "magit-log-select-mode" || w.mode === "magit-stashes-mode") {
    const limit = magitLogGetCommitLimit();
    if (limit !== undefined && w.count === limit) {
      insertSection("longer", undefined, false, () => {
        e8.insert(e8.propertize("Type + to show more history", { "font-lock-face": "button", "mouse-face": "magit-section-highlight", "help-echo": "magit-log-double-commit-limit" }));
      });
    }
  } else e8.insert("\n");
}

/** Washes one commit, as magit-log-wash-rev; false when nothing is left. */
function washRev(w: LogWash): boolean {
  if (["magit-log-mode", "magit-reflog-mode", "magit-log-select-mode", "magit-stashes-mode"].includes(w.mode)) w.count++;
  const rev = matchRev(w.style, w.lines[w.i]);
  w.i++;
  if (!rev) {
    // A line that is not a commit, as git log's separators: kept as it is.
    return true;
  }
  if (w.style === "reflog" && rev.date === undefined) return true;
  const align = w.style === "cherry" || !((e8.variable("magit-buffer-log-args") as string[] | null) ?? []).includes("--stat");
  const type = w.style === "stash" ? "stash" : w.style === "module" ? "module-commit" : "commit";
  let hash = w.style === "bisect-log" ? (magitRevParse("--short", rev.hash!) ?? rev.hash!) : rev.hash ?? "";
  const nonGraph = w.style === "bisect-vis" ? bisectVisRe : headingRe;
  insertSection(type, hash, false, () => {
    const gpgFace = ({ G: "magit-signature-good", B: "magit-signature-bad", U: "magit-signature-untrusted", X: "magit-signature-expired", Y: "magit-signature-expired-key", R: "magit-signature-revoked", E: "magit-signature-error", N: "magit-hash" } as { [k: string]: string })[rev.gpg ?? ""] ?? "magit-hash";
    const hashText = fl(hash, gpgFace);
    if (rev.cherry) {
      e8.insert(fl(rev.cherry, rev.cherry === "-" ? "magit-cherry-equivalent" : "magit-cherry-unmatched"));
      e8.insert(" ");
    }
    if (rev.side) {
      e8.insert(fl(rev.side, rev.side === "<" ? "magit-cherry-equivalent" : "magit-cherry-unmatched"));
      e8.insert(" ");
    }
    if (align) e8.insert(e8.concat(hashText, " "));
    if (rev.graph) e8.insert(rev.graph);
    if (!align) e8.insert(e8.concat(hashText, " "));
    const afterSummary = truthy(e8.variable("magit-log-show-refname-after-summary"));
    if (rev.refs && !afterSummary) {
      const labels = magitFormatRefLabels(rev.refs);
      e8.insert(labels === "" ? " " : e8.concat(labels, " "));
    }
    if (w.style === "reflog") {
      e8.insert(`${String(w.count - 1).padEnd(2)} `);
      if (rev.refsub) e8.insert(magitReflogFormatSubject(rev.refsub.slice(0, rev.refsub.includes(":") ? -2 : -1)));
    }
    e8.insert(magitLogWashSummary(rev.msg ?? ""));
    if (rev.refs && afterSummary) {
      e8.insert(" ");
      e8.insert(magitFormatRefLabels(rev.refs));
    }
    e8.insert("\n");
    if (w.style === "log" || w.style === "reflog" || w.style === "stash") {
      let date: string | number | undefined = rev.date;
      if (rev.refsub && date) {
        const dm = /^([^ ]+) \+(..)(..)/.exec(date);
        if (dm) date = Number(dm[1]) + Number(dm[2]) * 3600 + Number(dm[3]) * 60;
      }
      if (date !== undefined) magitLogFormatMargin(hash, rev.author ?? "", date);
    }
    if (w.style === "cherry" && magitRightMarginActive()) {
      const [author, d] = (magitRevFormat("%aN%x00%ct", hash) ?? "\0").split("\0");
      magitLogFormatMargin(hash, author, d);
    }
    if (rev.graph !== undefined && w.i < w.lines.length && !nonGraph.test(w.lines[w.i])) {
      // ++header: the header between form feeds.
      if (w.lines[w.i].startsWith("\f") || w.lines[w.i] === "") {
        if (w.lines[w.i].startsWith("\f")) {
          insertHeading();
          insertSection("commit-header", undefined, false, () => {
            const end = w.lines.findIndex((l, i) => i > w.i && l.includes("\f"));
            const header = w.lines.slice(w.i, end < 0 ? w.lines.length : end + 1).join("\n").replace(/\f/g, "");
            e8.insert(`${header}\n`);
            w.i = end < 0 ? w.lines.length : end + 1;
          });
        }
      }
      if (w.i < w.lines.length && /^(---|\s*$|diff)/.test(w.lines[w.i]) && /^(---|diff|\s*$)/.test(w.lines[w.i]) && hasDiffAhead(w)) {
        insertHeading();
        const end = nextHeading(w, nonGraph);
        const chunk = w.lines.slice(w.i, end).join("\n").replace(/^---\n?/, "");
        w.i = end;
        magitDiffWashDiffs(chunk, ["--stat"], "commit");
      } else if (w.i < w.lines.length && !nonGraph.test(w.lines[w.i])) {
        const pad = align ? " ".repeat(w.abbrev + 1) : "";
        let last = "";
        while (w.i < w.lines.length && !nonGraph.test(w.lines[w.i])) {
          last = w.lines[w.i];
          e8.insert(`${pad}${last}\n`);
          magitMakeMarginOverlay();
          w.i++;
        }
        const graph = /^[-_/|\\*o<>. ]*/.exec(last)![0];
        if (!/[/\\.]/.test(graph)) e8.insert(`${graph}\n`);
      }
    }
  });
  hash = "";
  return true;
}
const hasDiffAhead = (w: LogWash): boolean => w.lines.slice(w.i, w.i + 4).some((l) => l.startsWith("diff ") || / \d+ files? changed/.test(l) || l.startsWith("---"));
const nextHeading = (w: LogWash, re: RegExp): number => {
  for (let i = w.i; i < w.lines.length; i++) if (re.test(w.lines[i]) && !w.lines[i].startsWith("diff")) return i;
  return w.lines.length;
};

/** The log arguments git gets for ARGS, and the format, as magit--insert-log builds them. */
function logGitArgs(revs: string | string[] | undefined, args: string[], files: string[]): string[] {
  let a = [...args];
  let gpg = "";
  if (a.includes("--show-signature")) {
    a = a.filter((x) => x !== "--show-signature");
    const limit = magitLogGetCommitLimit(a);
    const max = Number(e8.variable("magit-log-show-signatures-limit") ?? 256);
    if (limit === undefined) e8.message("Dropping --show-signature because -n isn't set (see magit-log-show-signatures-limit)");
    else if (limit > max) e8.message(`Dropping --show-signature because -n is larger than ${max}`);
    else gpg = "%G?";
  }
  let header = "";
  if (a.includes("++header")) {
    a = a.filter((x) => x !== "++header");
    header = `\n${String(e8.variable("magit-log-revision-headers-format"))}\n`;
  }
  const date = truthy(e8.variable("magit-log-margin-show-committer-date")) ? "%ct" : "%at";
  const format = `--format=${a.includes("--left-right") && !a.includes("--graph") ? "%m " : ""}%h%x0c${a.includes("--decorate") ? "%D" : ""}%x0c${gpg}%x0c%aN%x0c${date}%x0c%s${header}`;
  const order = a.find((x) => /^\+\+order=(.+)$/.test(x));
  if (order) a = [`--${order.slice(8)}-order`, ...a.filter((x) => x !== order)];
  if (a.includes("--decorate")) a = ["--decorate=full", ...a.filter((x) => x !== "--decorate")];
  if (a.includes("--reverse")) a = a.filter((x) => x !== "--graph");
  if (a.includes("--color")) a = a.filter((x) => x !== "--color");
  return ["log", format, ...a, "--use-mailmap", "--no-prefix", ...(Array.isArray(revs) ? revs : revs ? [revs] : []), "--", ...files];
}

/** Runs git log for REVS with ARGS and FILES and inserts it washed, cancelling the section if empty, as magit--insert-log. */
export function magitInsertLog(revs: string | string[] | undefined, args: string[] = [], files: string[] = [], keepError = false): void {
  const global = ((e8.variable("magit-git-global-arguments") as string[] | null) ?? []).filter((a) => a !== "--literal-pathspecs");
  const r = e8.callProcess([magitGitExecutable(), ...global, ...logGitArgs(revs, args, files)], { directory: e8.expandFileName(String(e8.variable("default-directory"))) });
  if (r.exit !== 0 || r.output === "") {
    if (keepError && r.exit !== 0) {
      e8.insert(e8.propertize(r.output, { "font-lock-face": "error" }));
      return;
    }
    magitCancelSection();
    if (r.output === "" && r.exit === 0 && sections() === undefined) return;
    return;
  }
  magitLogWashLog("log", r.output, args);
}

// The status buffer's commits.

/** Puts the number of commits a log section has in its heading, as magit-log-insert-child-count. */
function insertLogChildCount(section: Section): void {
  if (!truthy(e8.variable("magit-section-show-child-count"))) return;
  let count: number | string = section.children.length;
  if (count === 0) return;
  if (count === magitLogGetCommitLimit()) count = `${count}+`;
  const colon = section.content - 2;
  if (e8.charAfter(colon) !== ".") return;
  e8.saveExcursion(() => {
    e8.deleteRegion(colon, colon + 1);
    e8.gotoChar(colon);
    e8.insert(` (${count})`);
  });
}

/** Inserts a log section of TYPE and VALUE with HEADING, the log of RANGE, and its count, as Magit's status inserters do. */
function insertLogSection(type: string, value: string, hidden: boolean, heading: e8.PropertizedString | string, range: string, inserter: string): void {
  let made: Section | undefined;
  e8.letBind({ "magit-section-show-child-count": false }, () => {
    made = insertSection(
      type,
      value,
      hidden,
      () => {
        insertHeading(heading);
        magitInsertLog(range, (e8.variable("magit-buffer-log-args") as string[] | null) ?? defaultLogArgs["magit-status-mode"]);
      },
      inserter,
    );
  });
  if (made && made.parent?.children.includes(made)) {
    const before = e8.pointMax();
    insertLogChildCount(made);
    const delta = e8.pointMax() - before;
    if (delta !== 0) {
      made.content += delta;
      made.end += delta;
      for (const c of made.children) {
        c.start += delta;
        c.content += delta;
        c.end += delta;
      }
    }
  }
}

/** Inserts the commits not pulled from the upstream, as magit-insert-unpulled-from-upstream. */
export function magitInsertUnpulledFromUpstream(): void {
  const upstream = magitGetUpstreamBranch();
  if (!upstream) return;
  insertLogSection("unpulled", "..@{upstream}", true, e8.concat(fl("Unpulled from ", "magit-section-heading"), fl(upstream, "magit-branch-remote"), fl(".", "magit-section-heading")), "..@{upstream}", "magit-insert-unpulled-from-upstream");
}

/** Inserts the commits not pulled from the push remote, as magit-insert-unpulled-from-pushremote. */
export function magitInsertUnpulledFromPushremote(): void {
  const target = magitGetPushBranch();
  if (!target || !insertPushremoteLogP()) return;
  const range = `..${target}`;
  insertLogSection("unpulled", range, true, e8.concat(fl("Unpulled from ", "magit-section-heading"), fl(target, "magit-branch-remote"), fl(".", "magit-section-heading")), range, "magit-insert-unpulled-from-pushremote");
}

/** Inserts the commits not pushed to the upstream, as magit-insert-unpushed-to-upstream. */
export function magitInsertUnpushedToUpstream(): void {
  if (!magitGitSuccess("rev-parse", "@{upstream}")) return;
  const upstream = magitGetUpstreamBranch()!;
  insertLogSection("unpushed", "@{upstream}..", false, e8.concat(fl("Unmerged into ", "magit-section-heading"), fl(upstream, "magit-branch-remote"), fl(".", "magit-section-heading")), "@{upstream}..", "magit-insert-unpushed-to-upstream");
}

/** Inserts the commits not pushed to the push remote, as magit-insert-unpushed-to-pushremote. */
export function magitInsertUnpushedToPushremote(): void {
  const target = magitGetPushBranch();
  if (!target || !insertPushremoteLogP()) return;
  const range = `${target}..`;
  insertLogSection("unpushed", range, true, e8.concat(fl("Unpushed to ", "magit-section-heading"), fl(target, "magit-branch-remote"), fl(".", "magit-section-heading")), range, "magit-insert-unpushed-to-pushremote");
}

/** Whether to show the push remote's sections: not when they would repeat the upstream's, as magit--insert-pushremote-log-p. */
function insertPushremoteLogP(): boolean {
  const hook = (e8.variable("magit-status-sections-hook") as string[] | null) ?? [];
  return !(magitGetPushBranch() === magitGetUpstreamBranch() && (hook.includes("magit-insert-unpulled-from-upstream") || hook.includes("magit-insert-unpulled-from-upstream-or-recent")));
}

/** Inserts the unpushed commits, or the recent ones without an upstream ahead, as magit-insert-unpushed-to-upstream-or-recent. */
export function magitInsertUnpushedToUpstreamOrRecent(): void {
  const upstream = magitGetUpstreamBranch();
  if (!upstream || magitRevAncestorP("HEAD", upstream)) magitInsertRecentCommits("unpushed", "@{upstream}..");
  else magitInsertUnpushedToUpstream();
}

/** Inserts the last magit-log-section-commit-count commits, as magit-insert-recent-commits. */
export function magitInsertRecentCommits(type = "recent", value?: string): void {
  const count = Number(e8.variable("magit-log-section-commit-count") ?? 10);
  const start = `HEAD~${count}`;
  const range = magitRevVerify(start) ? `${start}..HEAD` : undefined;
  const args = (e8.variable("magit-buffer-log-args") as string[] | null) ?? defaultLogArgs["magit-status-mode"];
  insertSection(
    type,
    value ?? range,
    true,
    () => {
      insertHeading("Recent commits");
      magitInsertLog(args.includes("--graph") ? range : undefined, [`-n${count}`, ...args.filter((a) => !a.startsWith("-n"))]);
    },
    "magit-insert-recent-commits",
  );
}

/** Inserts the commits not pulled, cherry style, as magit-insert-unpulled-cherries. */
export function magitInsertUnpulledCherries(): void {
  const upstream = magitGetUpstreamBranch();
  if (!upstream) return;
  insertSection("unpulled", "..@{upstream}", false, () => {
    insertHeading(e8.concat(fl("Unpulled from ", "magit-section-heading"), fl(upstream, "magit-branch-remote"), fl(":", "magit-section-heading")));
    washCherry(["cherry", "-v", magitGetCurrentBranch() ?? "HEAD", upstream]);
  });
}
/** Inserts the commits not pushed, cherry style, as magit-insert-unpushed-cherries. */
export function magitInsertUnpushedCherries(): void {
  const upstream = magitGetUpstreamBranch();
  if (!upstream) return;
  insertSection("unpushed", "@{upstream}..", false, () => {
    insertHeading(e8.concat(fl("Unpushed to ", "magit-section-heading"), fl(upstream, "magit-branch-remote"), fl(":", "magit-section-heading")));
    washCherry(["cherry", "-v", upstream]);
  });
}
function washCherry(args: string[]): void {
  const r = magitGitRun(args);
  if (r.exit !== 0 || r.output === "") return magitCancelSection();
  magitLogWashLog("cherry", r.output, []);
}

// The log buffer.

/** What the log buffer's header line says, as magit-log-header-line-sentence. */
function headerLineSentence(revs: string[], args: string[], files: string[]): string {
  return `Commits in ${revs.join(" ")}${args.includes("--reverse") ? " in reverse" : ""}${files.length > 0 ? ` touching ${files.join(" ")}` : ""}${args.find((a) => a.startsWith("-L")) ? ` ${args.find((a) => a.startsWith("-L"))}` : ""}`;
}
/** The log buffer's header line as the arguments, as magit-log-header-line-arguments. */
function headerLineArguments(revs: string[], args: string[], files: string[]): string {
  return ["git", "log", ...args, ...revs, "--", ...files].map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
}

/** Shows the log of REVS in the log buffer, as magit-log-setup-buffer; then point on FOCUS's commit or the one it was on. */
export function magitLogSetupBuffer(revs: string[], args: string[], files: string[], focus?: string): string {
  const previous = currentSection();
  const name = magitBufferName("magit-log-mode");
  magitSetupBuffer(name, magitLogMode, "log", magitLogRefreshBuffer, true, {
    "magit-buffer-revisions": revs,
    "magit-buffer-log-args": args,
    "magit-buffer-log-files": files,
  });
  e8.withCurrentBuffer(name, () => {
    if (focus) magitLogGotoCommitSection(focus);
    else if (previous && (previous.type === "commit" || previous.type === "branch") && typeof previous.value === "string") magitLogGotoCommitSection(previous.value);
  });
  return name;
}

/** Makes the log buffer, as magit-log-refresh-buffer. */
export function magitLogRefreshBuffer(): void {
  let revs: string[] | string = (e8.variable("magit-buffer-revisions") as string[] | null) ?? [];
  let args = (e8.variable("magit-buffer-log-args") as string[] | null) ?? [];
  const files = (e8.variable("magit-buffer-log-files") as string[] | null) ?? [];
  const limit = magitLogGetCommitLimit(args);
  const headerFn = String(e8.variable("magit-log-header-line-function"));
  e8.setVariable("header-line-format", headerFn === "magit-log-header-line-arguments" ? headerLineArguments(revs, args, files) : headerLineSentence(revs, args, files));
  if (files.length !== 1) args = args.filter((a) => a !== "--follow");
  const remove = (e8.variable("magit-log-remove-graph-args") as string[] | null) ?? [];
  if (remove.length > 0 && args.some((a) => remove.some((r) => a.startsWith(r)))) args = args.filter((a) => a !== "--graph");
  if (limit && limit * 2 > 1024 && revs.length === 1 && !revs[0].includes("..") && !["--all", "--branches"].includes(revs[0])) {
    const count = magitGitString("rev-list", "--count", "--first-parent", ...args, revs[0]);
    if (count && Number(count) >= limit * 2) revs = `${revs[0]}~${limit * 2}..${revs[0]}`;
  }
  magitSetBufferMargins();
  insertRoot("logbuf", () => magitInsertLog(revs, args, files, true));
}

/** Moves to the commit REV in the log, as magit-log-goto-commit-section; whether it is there. */
export function magitLogGotoCommitSection(rev: string): boolean {
  const abbrev = magitRevFormat("%h", rev);
  const s = (sections()?.root.children ?? []).find((c) => c.value === abbrev);
  if (s) e8.gotoChar(s.start);
  return s !== undefined;
}

/**
 * The minibuffer's keymap while reading a log's revisions, as
 * magit-log-read-revs-map: SPC inserts itself, as revisions are separated
 * by commas, spaces and dots; and Emacs's completion keys that E8's
 * minibuffer map lacks.
 */
const magitLogReadRevsMap = e8.defineKeymap("magit-log-read-revs-map", "minibuffer-local-map");
for (const [key, command] of [
  ["SPC", "self-insert-command"],
  ["<backtab>", "minibuffer-complete"],
  ["<next>", "next-history-element"],
  ["<prior>", "previous-history-element"],
] as const)
  e8.defineKey(magitLogReadRevsMap, key, command as e8.CommandName);

/** Reads revisions for a log, as magit-log-read-revs. */
function magitLogReadRevs(useCurrent = false): string[] {
  if (useCurrent) {
    const b = magitGetCurrentBranch();
    if (b) return [b];
  }
  const reply = magitWithMinibufferMap("magit-log-read-revs-map", () =>
    magitCompletingRead("Log rev,s", magitListRefnames(undefined, true), { requireMatch: "any", history: "magit-revision-history", def: magitBranchOrCommitAtPoint() ?? (!useCurrent ? magitGetPreviousBranch() : undefined) }),
  );
  return (reply ?? "").split(/[, ]/).filter((r) => r !== "");
}

const logCommand = (name: string, doc: string, revs: () => string[]) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const [args, files] = magitLogArguments();
      magitLogSetupBuffer(revs(), args, files);
    },
  });

export const magitLogCurrent = logCommand("magit-log-current", "Show log for the current branch, or HEAD if no branch is checked out.", () => [magitGetCurrentBranch() ?? "HEAD"]);
logCommand("magit-log-head", "Show log for HEAD.", () => ["HEAD"]);
logCommand("magit-log-related", "Show log for the current branch, its upstream and its push target.", () => {
  let current = magitGetCurrentBranch();
  let head: string | undefined;
  if (!current) {
    const g = magitGitString("rev-parse", "--absolute-git-dir");
    const headName = g && e8.fileExistsP(`${g}/rebase-merge/head-name`) ? e8.readTextFile(`${g}/rebase-merge/head-name`).trim() : undefined;
    if (headName) {
      current = magitRefAbbrev(headName);
      head = "HEAD";
    } else current = magitGetPreviousBranch();
  }
  if (!current) return ["HEAD"];
  const target = magitGetPushBranch(current, true);
  const upstream = magitGetUpstreamBranch(current);
  const upup = upstream && magitLocalBranchP(upstream) ? magitGetUpstreamBranch(upstream) : undefined;
  return [current, head, target, upstream, upup].filter((x): x is string => x !== undefined);
});
e8.defineCommand({
  name: "magit-log-other",
  doc: "Show log for one or more revs read from the minibuffer.",
  run: () => {
    const revs = magitLogReadRevs();
    const [args, files] = magitLogArguments();
    magitLogSetupBuffer(revs, args, files);
  },
});
logCommand("magit-log-branches", "Show log for all local branches and HEAD.", () => (magitGetCurrentBranch() ? ["--branches"] : ["HEAD", "--branches"]));
logCommand("magit-log-all-branches", "Show log for all local and remote branches and HEAD.", () => (magitGetCurrentBranch() ? ["--branches", "--remotes"] : ["HEAD", "--branches", "--remotes"]));
logCommand("magit-log-all", "Show log for all references and HEAD.", () => (magitGetCurrentBranch() ? ["--all"] : ["HEAD", "--all"]));
e8.defineCommand({
  name: "magit-log-matching-branches",
  doc: "Show log for all branches matching PATTERN and HEAD.",
  run: () => {
    const pattern = magitReadString("Type a pattern to pass to --branches");
    const [args, files] = magitLogArguments();
    magitLogSetupBuffer(["HEAD", `--branches=${pattern}`], args, files);
  },
});
e8.defineCommand({
  name: "magit-log-matching-tags",
  doc: "Show log for all tags matching PATTERN and HEAD.",
  run: () => {
    const pattern = magitReadString("Type a pattern to pass to --tags");
    const [args, files] = magitLogArguments();
    magitLogSetupBuffer(["HEAD", `--tags=${pattern}`], args, files);
  },
});
e8.defineCommand({
  name: "magit-log-buffer-file",
  doc: "Show log for the blob or file visited in the current buffer; with a prefix argument, follow renames; with a region, the lines it touches.",
  params: [{ name: "follow", kind: "prefix" }],
  run: (follow: e8.Value) => {
    const file = magitFileRelativeName() ?? (e8.variable("magit-buffer-file-name") ? magitFileRelativeName(String(e8.variable("magit-buffer-file-name"))) : undefined);
    if (!file) e8.userError("Buffer isn't visiting a file");
    let [args] = magitLogArguments();
    if (truthy(follow) && !args.includes("--follow")) args = ["--follow", ...args];
    let files = [file!];
    if (e8.regionActive()) {
      const beg = e8.lineOf(Math.min(e8.mark()!, e8.point())) + 1;
      const end = e8.lineOf(Math.max(e8.mark()!, e8.point()) - 1) + 1;
      args = [`-L${beg},${end}:${file}`, ...args.filter((a) => !a.startsWith("-L"))];
      files = [];
    }
    const refname = e8.variable("magit-buffer-refname");
    magitLogSetupBuffer([typeof refname === "string" ? refname : (magitGetCurrentBranch() ?? "HEAD")], args, files);
  },
});
e8.defineCommand({
  name: "magit-log-trace-definition",
  doc: "Show log for the definition at point.",
  run: () => {
    const file = magitFileRelativeName();
    if (!file) e8.userError("Buffer isn't visiting a file");
    const fn = e8.fboundp("which-function") ? (e8.funcall("which-function") as string | undefined) : undefined;
    if (!fn) e8.userError("No function at point found");
    const refname = e8.variable("magit-buffer-refname");
    const commit = typeof refname === "string" ? refname : (magitGetCurrentBranch() ?? "HEAD");
    const [args] = magitLogArguments();
    magitLogSetupBuffer([commit], [`-L:${fn!.replace(/:/g, "\\:")}:${file}`, ...args.filter((a) => !a.startsWith("-L"))], []);
  },
});
/** Deletes the shelved BRANCH, a ref magit-branch-shelve made, as magit-delete-shelved-branch. */
export function magitDeleteShelvedBranch(branch: string): void {
  magitRunGit("update-ref", "-d", `refs/shelved/${branch}`);
}
e8.defineCommand({
  name: "magit-delete-shelved-branch",
  doc: "Delete the shelved BRANCH.\nDelete a ref created by magit-branch-shelve.",
  run: () => magitDeleteShelvedBranch(magitReadShelvedBranch("Log shelved branch")),
});

/** Shows the log of the definition the line of point in a diff shows, as magit-diff-trace-definition. */
export function magitDiffTraceDefinition(): void {
  const [buf, pos] = magitDiffVisitFileNoselect();
  magitWithTempPosition(buf, pos, () => e8.callInteractively("magit-log-trace-definition" as e8.CommandName));
}
e8.defineCommand({ name: "magit-diff-trace-definition", doc: "Show log for the definition at point in a diff.", run: () => magitDiffTraceDefinition() });
e8.defineCommand({
  name: "magit-log-merged",
  doc: "Show log for the merge of COMMIT into BRANCH: the range M^1..M of the merge M that brought it in. Needs git-when-merged.",
  run: () => {
    const commit = magitReadBranchOrCommit("Log merge of commit");
    const branch = magitReadOtherBranch("Merged into", commit);
    const [args, files] = magitLogArguments();
    const r = magitGitRun(["when-merged", "-c", `--abbrev=${magitAbbrevLength()}`, commit, branch]);
    if (r.exit === 127 || /is not a git command/.test(r.output)) e8.userError("This command requires git-when-merged (https://github.com/mhagger/git-when-merged)");
    const m = r.output.split("\n")[0] ?? "";
    if (r.exit === 0) return void magitLogSetupBuffer([`${m}^1..${m}`], args, files, commit);
    const msg = m.slice(m.indexOf(" ")).trimStart();
    if (msg !== "Commit is directly on this branch.") e8.userError(`Could not find when ${commit} was merged into ${branch}: ${msg}`);
    const half = Math.floor(Number(e8.variable("magit-log-merged-commit-count") ?? 20) / 2);
    let from = `${commit}~${half}`;
    const to = magitRevDiffCount(branch, commit)[0] - half;
    if (!magitRevVerify(`${from}^{commit}`)) from = magitGitString("rev-list", "--max-parents=0", commit) ?? commit;
    magitLogSetupBuffer([`${from}..${to <= 0 ? branch : `${branch}~${to}`}`], ["--first-parent", ...args], files, commit);
  },
});

/** Sets the log buffer's commit limit with FN, as magit-log-set-commit-limit. */
function setCommitLimit(fn: (n: number) => number | undefined): void {
  const args = (e8.variable("magit-buffer-log-args") as string[] | null) ?? [];
  const arg = args.find((a) => /^-n([0-9]+)?$/.test(a));
  const num = arg ? fn(Number(arg.slice(2))) : 256;
  const rest = args.filter((a) => a !== arg);
  e8.setVariable("magit-buffer-log-args", num !== undefined && num > 0 ? [`-n${num}`, ...rest] : rest);
  magitRefresh();
}
e8.defineCommand({ name: "magit-log-toggle-commit-limit", doc: "Toggle the number of commits the current log buffer is limited to: none or 256.", run: () => setCommitLimit(() => undefined) });
e8.defineCommand({ name: "magit-log-double-commit-limit", doc: "Double the number of commits the current log buffer is limited to.", run: () => setCommitLimit((n) => n * 2) });
e8.defineCommand({ name: "magit-log-half-commit-limit", doc: "Half the number of commits the current log buffer is limited to.", run: () => setCommitLimit((n) => Math.floor(n / 2)) });

e8.defineCommand({
  name: "magit-log-bury-buffer",
  doc: "Bury the current buffer or, with a negative prefix argument, the revision buffer in the same frame.",
  params: [{ name: "arg", kind: "count" }],
  run: (arg: number) => {
    const n = arg ?? 1;
    if (n < 0) {
      const buf = magitGetModeBuffer("magit-revision-mode");
      const win = buf && e8.windowList().find((w) => e8.windowBuffer(w) === buf);
      if (!win) e8.userError("No revision buffer in this frame");
      const here = e8.selectedWindow();
      e8.selectWindow(win!);
      e8.call(magitModeBuryBuffer, Math.abs(n) > 1);
      if (e8.windowList().includes(here)) e8.selectWindow(here);
    } else e8.call(magitModeBuryBuffer, n > 1);
  },
});
e8.defineCommand({
  name: "magit-log-move-to-parent",
  doc: "Move to the Nth parent of the current commit.",
  params: [{ name: "n", kind: "count" }],
  run: (n: number) => {
    if (String(e8.variable("major-mode")) !== "magit-log-mode" || !magitSectionMatch("commit")) return;
    const section = currentSection()!;
    const parentRev = `${String(section.value)}^${n ?? 1}`;
    const hash = magitRevParse("--short", parentRev);
    if (!hash) e8.userError(`Parent ${parentRev} does not exist`);
    const parent = magitSectionSiblings(section, "next").find((s) => s.value === hash);
    if (!parent) e8.userError(`Parent ${hash} not found.  Try typing + first`);
    magitSectionGoto(parent!);
  },
});
e8.defineCommand({
  name: "magit-log-move-to-revision",
  doc: "Read a commit and move to it in the current log buffer, showing the log first if needed.",
  run: () => {
    const commit = magitCompletingRead("In log, jump to", magitListRefnames(undefined, true), { requireMatch: "any", history: "magit-revision-history", def: magitCommitAtPoint() ?? magitGetCurrentBranch() })!;
    if (String(e8.variable("major-mode")) !== "magit-log-mode") {
      const buf = magitGetModeBuffer("magit-log-mode");
      if (buf) e8.call("switch-to-buffer", buf);
      else e8.call("magit-log-all-branches" as e8.CommandName);
    }
    if (!magitLogGotoCommitSection(magitRevAbbrev(commit) ?? commit)) e8.userError(`${commit} isn't visible in the current log buffer`);
  },
});
e8.defineCommand({
  name: "magit-log-refresh",
  doc: "Change the arguments used for the log in the current buffer, from the menu's.",
  run: () => {
    const mode = String(e8.variable("major-mode"));
    if (mode === "magit-reflog-mode") e8.userError("Cannot change log arguments in reflog buffers");
    if (mode === "magit-cherry-mode") e8.userError("Cannot change log arguments in cherry buffers");
    const [args, files] = magitLogArguments(mode);
    e8.makeLocalVariable("magit-buffer-log-args");
    e8.setVariable("magit-buffer-log-args", args);
    if (mode !== "magit-log-select-mode") {
      e8.makeLocalVariable("magit-buffer-log-files");
      e8.setVariable("magit-buffer-log-files", files);
    }
    magitRefresh();
  },
});

// Shortlogs.

/** Shows git shortlog for REV in a buffer of its own, as magit-git-shortlog. */
function gitShortlog(rev: string, args: string[]): void {
  const dir = String(e8.variable("default-directory"));
  e8.getBufferCreate("*magit-shortlog*");
  e8.withCurrentBuffer("*magit-shortlog*", () => {
    e8.setVariable("default-directory", dir);
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.deleteRegion(e8.pointMin(), e8.pointMax());
      e8.insert(magitGitRun(["shortlog", ...args, rev], { dir }).output);
      e8.gotoChar(e8.pointMin());
    });
    e8.setVariable("buffer-read-only", true);
  });
  e8.call("switch-to-buffer-other-window", "*magit-shortlog*");
}
e8.defineCommand({
  name: "magit-shortlog-since",
  doc: "Show a history summary for commits since a revision.",
  run: () => gitShortlog(`${magitReadBranchOrCommit("Shortlog since", magitGetCurrentTag())}..`, transientArgs("magit-shortlog")),
});
e8.defineCommand({
  name: "magit-shortlog-range",
  doc: "Show a history summary for a commit or range.",
  run: () => gitShortlog(magitReadRangeOrCommit("Shortlog for revision or range"), transientArgs("magit-shortlog")),
});

// References.

const referenceFaces = ["magit-tag", "magit-branch-remote", "magit-branch-remote-head", "magit-branch-local", "magit-branch-current", "magit-branch-upstream", "magit-branch-warning", "magit-head", "magit-refname", "magit-refname-stash", "magit-refname-wip", "magit-refname-pullreq"];
const faceAt = (pos: number): string[] => {
  const f = e8.getTextProperty(pos, "font-lock-face") ?? e8.getTextProperty(pos, "face");
  return (Array.isArray(f) ? f : [f]).map(String);
};
/** Moves to the next or previous ref label, as magit-next-reference. */
function nextReference(previous: boolean): void {
  const isRef = (p: number) => faceAt(p).some((f) => referenceFaces.includes(f));
  let p = e8.point();
  // Leave the label point is on first.
  while (p >= e8.pointMin() && p < e8.pointMax() && isRef(p)) p += previous ? -1 : 1;
  while (p >= e8.pointMin() && p < e8.pointMax() && !isRef(p)) p += previous ? -1 : 1;
  if (p < e8.pointMin() || p >= e8.pointMax()) e8.userError(`No ${previous ? "previous" : "next"} reference`);
  if (previous) while (p > e8.pointMin() && isRef(p - 1)) p--;
  e8.gotoChar(p);
}
/** The keys that repeat moving between references, as magit-reference-navigation-repeat-map, when repeat-mode is on. */
const magitReferenceNavigationRepeatMap = e8.defineKeymap("magit-reference-navigation-repeat-map", null);
/** Moves to the next or previous reference, then with repeat-mode lets the repeat map's keys move on, as :repeat t makes the commands do. */
function navigateReferences(previous: boolean): void {
  nextReference(previous);
  if (truthy(e8.variable("repeat-mode"))) e8.setTransientMap(magitReferenceNavigationRepeatMap);
}
e8.defineCommand({ name: "magit-next-reference", doc: "Move to the next Git reference appearing in the current buffer.\n\nMove to the next location that uses a face appearing in magit-reference-movement-faces.  If repeat-mode is enabled, this command and its counterpart can be repeated using p and n.", run: () => navigateReferences(false) });
e8.defineCommand({ name: "magit-previous-reference", doc: "Move to the previous Git reference appearing in the current buffer.\n\nMove to the previous location that uses a face appearing in magit-reference-movement-faces.  If repeat-mode is enabled, this command and its counterpart can be repeated using p and n.", run: () => navigateReferences(true) });
for (const [key, command] of [
  ["p", "magit-previous-reference"],
  ["n", "magit-next-reference"],
  ["r", "magit-next-reference"],
] as const)
  e8.defineKey(magitReferenceNavigationRepeatMap, key, command as e8.CommandName);

// The reflog buffer.

/** Shows REF's reflog, as magit-reflog-setup-buffer. */
export function magitReflogSetupBuffer(ref: string): string {
  return magitSetupBuffer(magitBufferName("magit-reflog-mode"), magitReflogMode, "reflog", magitReflogRefreshBuffer, true, {
    "magit-buffer-refname": ref,
    "magit-buffer-log-args": [`-n${Number(e8.variable("magit-reflog-limit") ?? 256)}`],
  });
}
/** Makes the reflog buffer, as magit-reflog-refresh-buffer. */
function magitReflogRefreshBuffer(): void {
  const ref = String(e8.variable("magit-buffer-refname"));
  e8.setVariable("header-line-format", `Reflog for ${ref}`);
  magitSetBufferMargins();
  insertRoot("reflogbuf", () => {
    const r = magitGitRun(["reflog", "show", "--format=%h%x00%aN%x00%gd%x00%gs", "--date=raw", ...((e8.variable("magit-buffer-log-args") as string[] | null) ?? []), ref, "--"]);
    if (r.exit === 0) magitLogWashLog("reflog", r.output, []);
  });
}
e8.defineCommand({ name: "magit-reflog-current", doc: "Display the reflog of the current branch, or of HEAD if detached.", run: () => void magitReflogSetupBuffer(magitGetCurrentBranch() ?? "HEAD") });
e8.defineCommand({ name: "magit-reflog-other", doc: "Display the reflog of a branch or another ref.", run: () => void magitReflogSetupBuffer(magitReadLocalBranchOrRef("Show reflog for")) });
e8.defineCommand({ name: "magit-reflog-head", doc: "Display the HEAD reflog.", run: () => void magitReflogSetupBuffer("HEAD") });

// Selecting a commit from a log.

export const magitLogSelectMode = e8.defineMajorMode({ name: "magit-log-select-mode", modeName: "Magit Select", parent: magitLogMode, doc: "Mode for selecting a commit from history." });

/** What to do with the commit selected, and when the selection is given up. */
interface Selecting {
  pick: (rev: string) => void;
  quit?: () => void;
  buffer: string;
}
let selecting: Selecting | undefined;

/**
 * Shows a log to select a commit from, calling PICK with it, as magit-log-select:
 * . or C-c C-c picks the commit at point, q or C-c C-k gives up.
 */
export function magitLogSelect(pick: (rev: string) => void, msg?: string, quit?: () => void, branch?: string, args?: string[], initial?: string): void {
  const name = magitBufferName("magit-log-select-mode");
  const revs = [branch ?? magitGetCurrentBranch() ?? "HEAD"];
  magitSetupBuffer(name, magitLogSelectMode, "log-select", magitLogRefreshBuffer, true, {
    "magit-buffer-revisions": revs,
    "magit-buffer-log-args": args ?? defaultLogArgs["magit-log-select-mode"],
    "magit-buffer-log-files": [],
  });
  selecting = { pick, quit, buffer: name };
  e8.withCurrentBuffer(name, () => {
    if (initial) magitLogGotoCommitSection(initial);
    const usage = String(e8.variable("magit-log-select-show-usage") ?? "both");
    const text = msg ?? "Type . to select commit at point, or C-c C-k to abort";
    if (usage === "both" || usage === "header-line") e8.setVariable("header-line-format", e8.propertize(text, { "font-lock-face": "magit-header-line-log-select" }));
    if (usage === "both" || usage === "echo-area") e8.message(text);
  });
}
export const magitLogSelectPick = e8.defineCommand({
  name: "magit-log-select-pick",
  doc: "Select the commit at point and act on it.",
  run: () => {
    const s = selecting;
    const rev = magitCommitAtPoint();
    if (!s || !rev) e8.userError("No commit at point");
    selecting = undefined;
    e8.call("quit-window", true);
    s!.pick(rev!);
  },
});
export const magitLogSelectQuit = e8.defineCommand({
  name: "magit-log-select-quit",
  doc: "Abort selecting a commit, don't act on any commit.",
  run: () => {
    const s = selecting;
    selecting = undefined;
    e8.call("quit-window", true);
    s?.quit?.();
  },
});
for (const [key, command] of [
  [".", magitLogSelectPick],
  ["e", magitLogSelectPick],
  ["C-c C-c", magitLogSelectPick],
  ["q", magitLogSelectQuit],
  ["C-c C-k", magitLogSelectQuit],
] as const)
  e8.defineKey("magit-log-select-mode-map", key, command);

// The cherry buffer.

export const magitCherryMode = e8.defineMajorMode({ name: "magit-cherry-mode", modeName: "Magit Cherry", parent: "magit-mode", doc: "Mode for looking at commits not merged upstream." });

/** Shows the commits of HEAD not in UPSTREAM, as magit-cherry-setup-buffer: the sections of magit-cherry-sections-hook. */
export function magitCherrySetupBuffer(head: string, upstream: string): string {
  return magitSetupBuffer(
    magitBufferName("magit-cherry-mode"),
    magitCherryMode,
    "cherry",
    () => {
      magitSetBufferMargins();
      insertRoot("cherry", () => runSectionHook("magit-cherry-sections-hook"));
    },
    true,
    { "magit-buffer-refname": head, "magit-buffer-upstream": upstream },
  );
}
e8.defineVariable({ name: "magit-buffer-upstream", doc: "The upstream a cherry buffer compares with.", value: null });
inserters.set("magit-insert-cherry-commits", () => {
  insertSection("cherries", undefined, false, () => {
    insertHeading(true, "Cherry commits");
    washCherry(["cherry", "-v", "--abbrev", String(e8.variable("magit-buffer-upstream")), String(e8.variable("magit-buffer-refname"))]);
  });
});
e8.defineCommand({
  name: "magit-cherry",
  doc: "Show commits in a branch that are not merged in the upstream branch.",
  run: () => {
    const head = magitReadBranchOrCommit("Cherry head", magitGetCurrentBranch());
    const upstream = magitCompletingRead("Cherry upstream", magitListRefnames(), { requireMatch: "any", history: "magit-revision-history", def: magitGetUpstreamBranch(head) })!;
    magitCherrySetupBuffer(head, upstream);
  },
});

// Sections and keys.

e8.defineKeymap("magit-commit-section-map", null);
e8.remapCommand("magit-commit-section-map", "magit-visit-thing" as e8.CommandName, "magit-show-commit" as e8.CommandName);
e8.defineKeymap("magit-module-commit-section-map", "magit-commit-section-map");
magitSectionDefineType("commit", { keymap: "magit-commit-section-map" });
magitSectionDefineType("module-commit", { keymap: "magit-module-commit-section-map" });
e8.defineKeymap("magit-log-section-map", null);
for (const t of ["unpulled", "unpushed", "recent"]) magitSectionDefineType(t, { keymap: "magit-log-section-map" });
e8.remapCommand("magit-log-section-map", "magit-visit-thing" as e8.CommandName, "magit-diff-dwim" as e8.CommandName);

/** Shows more of the log when a movement command lands on the button at its end, as magit-log-maybe-show-more-commits. */
e8.addHook("magit-section-movement-hook", (section: Section | undefined) => {
  if (section?.type === "longer" && truthy(e8.variable("magit-log-auto-more"))) {
    e8.call("magit-log-double-commit-limit" as e8.CommandName);
  }
});

for (const [key, command] of [
  ["C-c C-b", "magit-go-backward"],
  ["C-c C-f", "magit-go-forward"],
  ["C-c C-n", "magit-log-move-to-parent"],
  ["j", "magit-log-move-to-revision"],
  ["=", "magit-log-toggle-commit-limit"],
  ["+", "magit-log-double-commit-limit"],
  ["-", "magit-log-half-commit-limit"],
  ["q", "magit-log-bury-buffer"],
] as const)
  e8.defineKey("magit-log-mode-map", key, command as e8.CommandName);
e8.defineKey("magit-reflog-mode-map", "L", "magit-margin-settings" as e8.CommandName);
e8.defineKey("magit-cherry-mode-map", "q", "magit-log-bury-buffer" as e8.CommandName);
// Keys of the log the reflog and selecting a commit have no use for, as Magit undefines them.
e8.defineKey("magit-reflog-mode-map", "C-c C-n", "undefined" as e8.CommandName);
e8.defineKey("magit-log-select-mode-map", "C-c C-b", "undefined" as e8.CommandName);
e8.defineKey("magit-log-select-mode-map", "C-c C-f", "undefined" as e8.CommandName);
e8.defineKey("magit-cherry-mode-map", "L", "magit-margin-settings" as e8.CommandName);

void magitBufferInfo;
void magitRefreshBuffer;
void magitShowCommitRev;
