// SPDX-License-Identifier: GPL-3.0-or-later
//
// Editing a rebase's todo list, after git-rebase.el: git-rebase-mode, in
// which c, r, e, s, S, f, F and d set the action of the line or the
// region's lines, k comments a line out or back in, M-p and M-n move
// lines, x, l, t, u and M M insert exec, label, reset, update-ref and
// merge lines, b and z break and noop, y inserts a commit read, RET and
// SPC show the line's commit, and C-c C-c starts the rebase. The keys
// replace git's one-letter abbreviations in the instructions below.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { forwardLine, truthy } from "subr";
import { magitCompletingRead, magitConfirm } from "magit-base";
import { magitGet, magitGitVersionGe, magitListRefs, magitReadBranchOrCommit, magitRevFormat } from "magit-git";
import { magitShowCommitRev } from "magit-diff";

const faces: [string, string, e8.FaceAttributes][] = [
  ["git-rebase-hash", "Face for commit hashes.", { inherit: "magit-hash" }],
  ["git-rebase-description", "Face for commit descriptions.", { inherit: "default" }],
  ["git-rebase-action", "Face for action keywords.", { inherit: "font-lock-keyword-face" }],
  ["git-rebase-killed-action", "Face for commented commit action lines.", { inherit: "font-lock-comment-face", strikeThrough: true } as e8.FaceAttributes],
  ["git-rebase-comment-hash", "Face for commit hashes in commit message comments.", { inherit: "git-rebase-hash", weight: "bold" }],
  ["git-rebase-comment-heading", "Face for headings in rebase message comments.", { inherit: "font-lock-keyword-face" }],
];
for (const [name, doc, attributes] of faces) e8.defineFace({ name, doc, attributes });

e8.defineVariable({ name: "git-rebase-auto-advance", doc: "Whether to move to the next line after changing a line.", value: true });
e8.defineVariable({ name: "git-rebase-show-instructions", doc: "Whether to show usage instructions inside the rebase buffer.", value: true });
e8.defineVariable({ name: "git-rebase-confirm-cancel", doc: "Whether confirmation is required to cancel.", value: true });

/** The long names of the one-letter actions, as git-rebase-short-options. */
const shortOptions: { [k: string]: string } = { b: "break", d: "drop", e: "edit", f: "fixup", l: "label", m: "merge", p: "pick", r: "reword", s: "squash", t: "reset", u: "update-ref", x: "exec" };

/** A todo line as git-rebase-action has it: its type, action, options, target and trailer, and whether it is commented out. */
export interface GitRebaseAction {
  actionType?: "commit" | "exec" | "bare" | "label" | "merge";
  action?: string;
  actionOptions?: string;
  target?: string;
  trailer?: string;
  commentP?: boolean;
  /** The option's commit of a merge line, as group 22. */
  mergeCommit?: string;
}

/** The todo line regexps, as git-rebase-line-regexps: 1 action, 2 option, 3 target, 4 "# ", 5 description. */
const lineRegexps: [GitRebaseAction["actionType"], RegExp][] = [
  ["commit", /^(drop|d|edit|e|fixup -C|f -C|fixup -c|f -c|fixup|f|pick|p|reword|r|squash|s) ([^ \n]+)(?: (# )?(.*))?/],
  ["exec", /^(x|exec) (.*)/],
  ["bare", /^(b|break|noop) *$/],
  ["label", /^(l|label|t|reset|u|update-ref) ([^ \n]+)(?: (# )?(.*))?/],
  ["merge", /^(m|merge) (?:((-[cC]) ([^ \n]+)) )?([^ \n]+)(?: (# )?(.*))?/],
];

const commentStart = (): string => String(e8.variable("comment-start") ?? "#").trim() || "#";

/** Parses LINE, as git-rebase-current-line: a commented-out line too unless BATCH. */
export function gitRebaseParseLine(line: string, batch = false): GitRebaseAction | undefined {
  let text = line;
  let commentP = false;
  if (!batch) {
    const c = commentStart();
    if (text.startsWith(c)) {
      commentP = true;
      text = text.slice(c.length).replace(/^ */, "");
    }
  }
  for (const [type, re] of lineRegexps) {
    const m = re.exec(text);
    if (!m) continue;
    const action = shortOptions[m[1]] ?? m[1];
    if (type === "commit") return { actionType: type, action: action.replace(/^f /, "fixup "), target: m[2], trailer: m[4], commentP };
    if (type === "exec") return { actionType: type, action, target: m[2], commentP };
    if (type === "bare") return { actionType: type, action, commentP };
    if (type === "label") return { actionType: type, action, target: m[2], trailer: m[4], commentP };
    return { actionType: type, action, actionOptions: m[2], mergeCommit: m[4], target: m[5], trailer: m[7], commentP };
  }
  return batch ? undefined : {};
}

/** The line at point, parsed. */
const currentLine = (): GitRebaseAction => gitRebaseParseLine(e8.lineText(e8.lineOf(e8.point())) ?? "") ?? {};
/** Whether the line at POS is a todo line, as git-rebase-line-p. */
const lineP = (pos = e8.point()): boolean => gitRebaseParseLine(e8.lineText(e8.lineOf(pos)) ?? "")?.actionType !== undefined;

/** The region's lines if both ends are on todo lines, or with FALLBACK the line at point, as git-rebase-region-bounds. */
function regionBounds(fallback = false): [number, number] | undefined {
  if (e8.regionActive() && e8.mark() !== undefined) {
    const beg = e8.lineStart(e8.lineOf(Math.min(e8.mark()!, e8.point())));
    const end = e8.lineEnd(e8.lineOf(Math.max(e8.mark()!, e8.point())));
    return lineP(beg) && lineP(end) ? [beg, end + 1] : undefined;
  }
  if (fallback && lineP()) return [e8.lineStart(e8.lineOf(e8.point())), e8.lineEnd(e8.lineOf(e8.point())) + 1];
  return undefined;
}

/** Deletes the line at point, its newline too, as magit-delete-line. */
function deleteLine(): void {
  const line = e8.lineOf(e8.point());
  e8.deleteRegion(e8.lineStart(line), Math.min(e8.lineEnd(line) + 1, e8.pointMax()));
}

/** Sets the action of the line or the region's lines to ACTION, or comments them out or in for undefined, as git-rebase-set-action. */
export function gitRebaseSetAction(action: string | undefined): void {
  const bounds = regionBounds(true);
  if (!bounds) return e8.ding();
  const [beg, endIn] = bounds;
  const below = e8.regionActive() && e8.mark() !== undefined && e8.mark()! < e8.point();
  const endMarker = e8.makeMarker(endIn, { advances: true });
  e8.gotoChar(beg);
  e8.letBind({ "inhibit-read-only": true }, () => {
    while (e8.point() < e8.markerPosition(endMarker)!) {
      const a = currentLine();
      if (action && a.actionType === "commit") {
        deleteLine();
        // Newer git writes the subject as a comment, and Magit then does too.
        e8.insert(`${action} ${a.target} ${magitGitVersionGe("2.50.0") ? "# " : ""}${a.trailer ?? ""}\n`);
      } else if (!action && a.actionType) {
        const ls = e8.lineStart(e8.lineOf(e8.point()));
        if (a.commentP) e8.deleteRegion(ls, ls + commentStart().length + 1);
        else {
          e8.gotoChar(ls);
          e8.insert(`${commentStart()} `);
        }
        forwardLine(1);
      } else forwardLine(1);
    }
  });
  const end = e8.markerPosition(endMarker)!;
  e8.deleteMarker(endMarker);
  e8.gotoChar(truthy(e8.variable("git-rebase-auto-advance")) ? end : below ? end - 1 : beg);
  e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
}

/** Moves the line or the region's lines N lines down, as git-rebase-move-line-down. */
function moveLineDown(n: number): void {
  const [beg, end] = regionBounds() ?? [e8.lineStart(e8.lineOf(e8.point())), e8.lineEnd(e8.lineOf(e8.point())) + 1];
  const ptOffset = e8.point() - beg;
  // The todo lines end where the instructions start.
  let limit = e8.pointMax();
  if (truthy(e8.variable("git-rebase-show-instructions"))) {
    let l = 0;
    while (l < e8.lineCount() && (lineP(e8.lineStart(l)) || (e8.lineText(l) ?? "") === "" || (e8.lineText(l) ?? "").startsWith(`${commentStart()} Branch`))) l++;
    limit = e8.lineStart(Math.min(l, e8.lineCount() - 1));
  }
  if ((n < 0 && beg === e8.pointMin()) || (n > 0 && end >= limit) || end > limit) return e8.ding();
  e8.letBind({ "inhibit-read-only": true }, () => {
    const text = e8.bufferSubstring(beg, end);
    e8.gotoChar(n < 0 ? beg : end);
    forwardLine(n);
    const at = e8.point();
    const insertAt = at > end ? at - (end - beg) : at;
    e8.deleteRegion(beg, end);
    e8.gotoChar(insertAt);
    e8.insert(text);
    e8.gotoChar(insertAt + ptOffset);
  });
}

/** Inserts or changes a line of ACTION with the value VALUE-FN reads, as git-rebase-set-noncommit-action. */
function setNoncommitAction(action: string, valueFn: (initial?: string) => string, arg: boolean): void {
  e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
  const a = currentLine();
  const same = !arg && a.action === action;
  const initial = same ? a.target : undefined;
  const trailer = same ? a.trailer : undefined;
  const value = valueFn(initial);
  e8.letBind({ "inhibit-read-only": true }, () => {
    if (value === "" && initial === undefined) return e8.ding();
    if (value === "") return deleteLine();
    if (initial !== undefined) deleteLine();
    else forwardLine(1);
    e8.insert(`${action} ${value}${value === initial && trailer ? ` ${trailer}` : ""}\n`);
    if (!truthy(e8.variable("git-rebase-auto-advance"))) forwardLine(-1);
  });
}

/** Inserts a bare ACTION line, break or noop, as git-rebase-set-bare-action. */
function setBareAction(action: string, arg: boolean): void {
  e8.gotoChar(e8.lineStart(e8.lineOf(e8.point())));
  const a = currentLine();
  const same = a.action === action;
  e8.letBind({ "inhibit-read-only": true }, () => {
    if (arg || !a.action || !same || (same && a.commentP)) {
      if (!(arg || !same)) deleteLine();
      e8.insert(`${action}\n`);
      if (!truthy(e8.variable("git-rebase-auto-advance"))) forwardLine(-1);
    }
  });
}

/** The labels of the todo list, as git-rebase-buffer-labels. */
const bufferLabels = (): string[] => [...e8.bufferText().matchAll(/^(?:l|label) ([^ \n]+)/gm)].map((m) => m[1]);

const actionCommand = (name: string, action: string | undefined, doc: string) => e8.defineCommand({ name, doc, run: () => gitRebaseSetAction(action) });

const commands = {
  pick: actionCommand("git-rebase-pick", "pick", "Use commit on current line.  If the region is active, act on all lines touched by the region."),
  drop: actionCommand("git-rebase-drop", "drop", "Drop commit on current line.  If the region is active, act on all lines touched by the region."),
  reword: actionCommand("git-rebase-reword", "reword", "Edit message of commit on current line.  If the region is active, act on all lines touched by the region."),
  edit: actionCommand("git-rebase-edit", "edit", "Stop at the commit on the current line.  If the region is active, act on all lines touched by the region."),
  squash: actionCommand("git-rebase-squash", "squash", "Fold commit on current line into previous commit, edit combined message."),
  squish: actionCommand("git-rebase-squish", "fixup -c", "Fold current into previous commit, discard previous message and edit current."),
  fixup: actionCommand("git-rebase-fixup", "fixup", "Fold commit on current line into previous commit, discard current message."),
  alter: actionCommand("git-rebase-alter", "fixup -C", "Meld current into previous commit, discard previous message and use current."),
  killLine: actionCommand("git-rebase-kill-line", undefined, "Comment the current action line, or uncomment it.  If the region is active, act on all lines touched by the region."),
  moveDown: e8.defineCommand({ name: "git-rebase-move-line-down", doc: "Move the current commit (or command) N lines down.", params: [{ name: "n", kind: "count" }], run: (n: number) => moveLineDown(n ?? 1) }),
  moveUp: e8.defineCommand({ name: "git-rebase-move-line-up", doc: "Move the current commit (or command) N lines up.", params: [{ name: "n", kind: "count" }], run: (n: number) => moveLineDown(-(n ?? 1)) }),
  insert: e8.defineCommand({
    name: "git-rebase-insert",
    doc: "Read an arbitrary commit and insert it below current line.",
    run: () => {
      const rev = magitReadBranchOrCommit("Insert revision");
      forwardLine(1);
      const info = magitRevFormat("%h %s", rev);
      if (!info) e8.userError("Unknown revision");
      e8.letBind({ "inhibit-read-only": true }, () => e8.insert(`pick ${info}\n`));
    },
  }),
  exec: e8.defineCommand({
    name: "git-rebase-exec",
    doc: "Insert a shell command to be run after the current commit, or edit the one on this line; with a prefix argument, a new one.",
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.Value) => setNoncommitAction("exec", (initial) => e8.readString("Execute: ", { initial }), truthy(arg)),
  }),
  label: e8.defineCommand({
    name: "git-rebase-label",
    doc: "Add a label after the current commit, or edit the one on this line; with a prefix argument, a new one.",
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.Value) => setNoncommitAction("label", (initial) => e8.readString("Label: ", { initial }).replace(/\s+/g, "-"), truthy(arg)),
  }),
  reset: e8.defineCommand({
    name: "git-rebase-reset",
    doc: "Reset the current HEAD to a label, or edit the reset on this line; with a prefix argument, a new one.",
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.Value) => setNoncommitAction("reset", (initial) => magitCompletingRead("Label", bufferLabels(), { requireMatch: true, initialInput: initial }) ?? "", truthy(arg)),
  }),
  updateRef: e8.defineCommand({
    name: "git-rebase-update-ref",
    doc: "Insert an update-ref action after the current line, or edit the one on this line; with a prefix argument, a new one.",
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.Value) => setNoncommitAction("update-ref", (initial) => magitCompletingRead("Ref", magitListRefs(), { initialInput: initial }) ?? "", truthy(arg)),
  }),
  merge: e8.defineCommand({
    name: "git-rebase-merge",
    doc: "Add a merge command after the current commit, or replace the one on this line; with a prefix argument, a new one.",
    params: [{ name: "arg", kind: "prefix" }],
    run: (arg: e8.Value) => setNoncommitAction("merge", () => magitCompletingRead("Merge", bufferLabels()) ?? "", truthy(arg)),
  }),
  mergeToggleEditmsg: e8.defineCommand({
    name: "git-rebase-merge-toggle-editmsg",
    doc: "Toggle whether an editor is invoked when performing the merge at point: -c opens the message, -C uses it as is.",
    run: () => {
      const a = currentLine();
      if (a.actionType !== "merge") return e8.ding();
      e8.letBind({ "inhibit-read-only": true }, () => {
        deleteLine();
        e8.insert(`merge ${(a.actionOptions ?? "").replace(/-[cC]/, (m) => (m === "-c" ? "-C" : "-c"))} ${a.target} ${a.trailer ?? ""}\n`);
      });
    },
  }),
  noop: e8.defineCommand({ name: "git-rebase-noop", doc: "Add noop action at point; with a prefix argument, another.", params: [{ name: "arg", kind: "prefix" }], run: (arg: e8.Value) => setBareAction("noop", truthy(arg)) }),
  break: e8.defineCommand({ name: "git-rebase-break", doc: "Add break action at point; with a prefix argument, another.", params: [{ name: "arg", kind: "prefix" }], run: (arg: e8.Value) => setBareAction("break", truthy(arg)) }),
  undo: e8.defineCommand({ name: "git-rebase-undo", doc: "Undo some previous changes, even in this read-only buffer.", run: () => e8.letBind({ "inhibit-read-only": true }, () => e8.call("undo")) }),
  showCommit: e8.defineCommand({ name: "git-rebase-show-commit", doc: "Show the commit on the current line if any.", run: () => showCommit() }),
  showOrScrollUp: e8.defineCommand({ name: "git-rebase-show-or-scroll-up", doc: "Show the commit on the current line, or scroll the buffer showing it up.", run: () => showCommit("up") }),
  showOrScrollDown: e8.defineCommand({ name: "git-rebase-show-or-scroll-down", doc: "Show the commit on the current line, or scroll the buffer showing it down.", run: () => showCommit("down") }),
  backwardLine: e8.defineCommand({ name: "git-rebase-backward-line", doc: "Move N lines backward.", params: [{ name: "n", kind: "count" }], run: (n: number) => void forwardLine(-(n ?? 1)) }),
};

// n is forward-line, as in Emacs, which E8 does not have as a command.
if (!e8.fboundp("forward-line")) {
  e8.defineCommand({ name: "forward-line", doc: "Move N lines forward (backward if N is negative).", params: [{ name: "n", kind: "count" }], run: (n: number) => void forwardLine(n ?? 1) });
}

/** Shows the line's commit, or scrolls the buffer showing it, as git-rebase--show-commit. */
function showCommit(scroll?: "up" | "down"): void {
  const a = currentLine();
  if (a.actionType !== "commit" || !a.target) return e8.ding();
  const here = e8.selectedWindow();
  if (scroll) {
    // The revision buffer, shown or scrolled as SPC does in a log.
    const name = e8.bufferList().find((b) => b.startsWith("magit-revision:"));
    const win = name && e8.windowList().find((w) => e8.windowBuffer(w) === name);
    if (win && e8.withCurrentBuffer(name!, () => String(e8.variable("magit-buffer-revision"))) === a.target) {
      e8.selectWindow(win);
      try {
        e8.call(scroll === "up" ? "scroll-up-command" : "scroll-down-command");
      } catch {
        e8.gotoChar(scroll === "up" ? e8.pointMin() : e8.pointMax());
      }
      e8.selectWindow(here);
      return;
    }
    e8.letBind({ "magit-display-buffer-noselect": true }, () => magitShowCommitRev(a.target!));
    e8.selectWindow(here);
    return;
  }
  magitShowCommitRev(a.target);
}

/** Highlights the todo list, as git-rebase-mode-font-lock-keywords. */
function fontify(start: number, end: number): void {
  const c = commentStart();
  e8.withSilentModifications(() => {
    for (let line = e8.lineOf(start); line <= e8.lineOf(Math.max(start, end - 1)); line++) {
      const ls = e8.lineStart(line);
      const text = e8.lineText(line) ?? "";
      e8.removeTextProperty(ls, e8.lineEnd(line), "font-lock-face");
      const put = (s: number, e: number, face: string) => e8.putTextProperty(ls + s, ls + e, "font-lock-face", face);
      if (text.startsWith(c)) {
        const rest = text.slice(c.length).replace(/^ */, "");
        if (gitRebaseParseLine(rest, true)?.actionType === "commit") put(0, text.length, "git-rebase-killed-action");
        else put(0, text.length, "font-lock-comment-face");
        const branch = new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Branch (.*)`).exec(text);
        if (branch) put(text.length - branch[1].length, text.length, "magit-branch-local");
        const rb = / Rebase ([^ ]*) onto ([^ ]*)/.exec(text);
        if (rb) {
          put(rb.index + 8, rb.index + 8 + rb[1].length, "git-rebase-comment-hash");
          put(text.length - rb[2].length - (text.length - rb.index - rb[0].length), rb.index + rb[0].length, "git-rebase-comment-hash");
        }
        const cmds = / (Commands:)/.exec(text);
        if (cmds) put(cmds.index + 1, cmds.index + 1 + cmds[1].length, "git-rebase-comment-heading");
        continue;
      }
      const a = gitRebaseParseLine(text, true);
      if (!a) continue;
      const actionWord = /^\S+(?: -[cC])?/.exec(text)![0];
      if (a.action === "drop") {
        put(0, actionWord.length, "git-rebase-action");
        put(actionWord.length + 1, text.length, "git-rebase-killed-action");
        continue;
      }
      put(0, actionWord.length, "git-rebase-action");
      if (a.actionType === "commit" || a.actionType === "label") {
        const t = actionWord.length + 1;
        put(t, t + (a.target ?? "").length, a.actionType === "commit" ? "git-rebase-hash" : "git-rebase-label");
        const after = t + (a.target ?? "").length + 1;
        if (text.slice(after).startsWith("# ")) {
          put(after, after + 2, "font-lock-comment-face");
          put(after + 2, text.length, "git-rebase-description");
        } else if (after < text.length) put(after, text.length, "git-rebase-description");
      } else if (a.actionType === "exec") put(actionWord.length + 1, text.length, "git-rebase-description");
      else if (a.actionType === "merge") {
        const m = /^(\S+) (?:(-[cC]) ([^ ]+) )?([^ ]+)/.exec(text);
        if (m) {
          let at = m[1].length + 1;
          if (m[2]) {
            put(at, at + 2, "git-rebase-action");
            put(at + 3, at + 3 + m[3].length, "git-rebase-hash");
            at += 3 + m[3].length + 1;
          }
          put(at, at + m[4].length, "magit-branch-local");
        }
      }
      for (const k of text.matchAll(/\[[^[]*\]/g)) put(k.index!, k.index! + k[0].length, "magit-keyword");
      for (const k of text.matchAll(/(?:fixup!|squash!|amend!)/g)) put(k.index!, k.index! + k[0].length, "magit-keyword-squash");
    }
  });
}

/** What each key does, for the instructions, as git-rebase-command-descriptions. */
const commandDescriptions: [string, string, string][] = [
  ["C-c C-c", "with-editor-finish", "tell Git to make it happen"],
  ["C-c C-k", "with-editor-cancel", "tell Git that you changed your mind, i.e., abort"],
  ["p", "git-rebase-backward-line", "move point to previous line"],
  ["n", "forward-line", "move point to next line"],
  ["M-p", "git-rebase-move-line-up", "move the commit at point up"],
  ["M-n", "git-rebase-move-line-down", "move the commit at point down"],
  ["SPC", "git-rebase-show-or-scroll-up", "show the commit at point in another buffer"],
  ["RET", "git-rebase-show-commit", "show the commit at point in another buffer and select its window"],
  ["C-/", "undo", "undo last change"],
  ["d", "git-rebase-drop", "drop the commit at point"],
  ["k", "git-rebase-kill-line", "un-/comment current line"],
  ["y", "git-rebase-insert", "insert a line for an arbitrary commit"],
  ["z", "git-rebase-noop", "add noop action at point"],
];
const fixupDescriptions: [string, string][] = [
  ["S", "fixup -c <commit> = use commit, but meld into previous commit,\n#          dropping previous commit's message, and open the editor"],
  ["f", "fixup <commit> = use commit, but meld into previous commit,\n#          dropping <commit>'s message"],
  ["F", "fixup -C <commit> = use commit, but meld into previous commit,\n#          dropping previous commit's message"],
];
/** The key each of git's actions has here: the same letter but for pick. */
const actionKeys: { [k: string]: string } = { pick: "c", reword: "r", edit: "e", squash: "s", fixup: "f", exec: "x", break: "b", drop: "d", label: "l", reset: "t", merge: "M M", "update-ref": "u" };

/** Puts this mode's keys in place of git's letters in the instructions, as git-rebase-mode-show-keybindings. */
function showKeybindings(): void {
  if (!truthy(e8.variable("git-rebase-show-instructions"))) return;
  const c = commentStart();
  e8.letBind({ "inhibit-read-only": true }, () =>
    e8.saveExcursion(() => {
      const text = e8.bufferText();
      const at = text.search(new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+p, pick`, "m"));
      if (at < 0) return;
      const startLine = e8.lineOf(e8.pointMin() + at);
      const lines = (e8.lineText(startLine) !== undefined ? text.slice(at).split("\n") : []).slice(0, 60);
      // The block of commands runs to the first line that is not one, or its continuation.
      let n = 0;
      while (n < lines.length && lines[n].startsWith(c) && (/^.\s+[a-z], [a-z-]+ /.test(lines[n]) || /^.\s{2,}\S/.test(lines[n]) || /^.\s+\.\s/.test(lines[n]))) n++;
      const out: string[] = commandDescriptions.map(([key, , desc]) => `${c} ${key.padEnd(8)} ${desc}`);
      let skipping = false;
      for (const l of lines.slice(0, n)) {
        const m = /^.\s+([a-z]), ([a-z-]+) (.*)$/.exec(l);
        if (!m) {
          if (!skipping) out.push(`${c}${" ".repeat(10)}${l.replace(/^.\s+/, "")}`);
          continue;
        }
        const action = m[2];
        skipping = false;
        if (action === "fixup") {
          for (const [key, desc] of fixupDescriptions) out.push(`${c} ${key.padEnd(8)} ${desc.replace(/#/g, c)}`);
          skipping = true;
          continue;
        }
        const key = actionKeys[action];
        if (!key || !e8.fboundp(`git-rebase-${action}`)) {
          skipping = true;
          continue;
        }
        out.push(`${c} ${key.padEnd(8)} ${action} ${m[3]}`);
      }
      const from = e8.pointMin() + at;
      const to = e8.lineEnd(startLine + n - 1) + 1;
      e8.deleteRegion(from, Math.min(to, e8.pointMax()));
      e8.gotoChar(from);
      e8.insert(e8.propertize(`${out.join("\n")}\n`, { "font-lock-face": "font-lock-comment-face" }));
    }),
  );
  e8.setBufferModified(false);
}

export const gitRebaseMode = e8.defineMajorMode({
  name: "git-rebase-mode",
  modeName: "Git Rebase",
  parent: "special-mode",
  doc: "Major mode for editing of a Git rebase file.",
  bindings: {
    RET: commands.showCommit,
    p: commands.backwardLine,
    n: "forward-line" as e8.CommandName,
    "M-p": commands.moveUp,
    "M-n": commands.moveDown,
    c: commands.pick,
    d: commands.drop,
    k: commands.killLine,
    "C-k": commands.killLine,
    b: commands.break,
    e: commands.edit,
    l: commands.label,
    "M M": commands.merge,
    "M t": commands.mergeToggleEditmsg,
    m: commands.edit,
    s: commands.squash,
    S: commands.squish,
    f: commands.fixup,
    F: commands.alter,
    A: commands.alter,
    q: "undefined" as e8.CommandName,
    r: commands.reword,
    w: commands.reword,
    t: commands.reset,
    u: commands.updateRef,
    x: commands.exec,
    y: commands.insert,
    z: commands.noop,
    SPC: commands.showOrScrollUp,
    DEL: commands.showOrScrollDown,
    "C-x C-t": commands.moveUp,
    "M-<up>": commands.moveUp,
    "M-<down>": commands.moveDown,
  },
  setup: () => {
    e8.makeLocalVariable("comment-start");
    e8.setVariable("comment-start", magitGet("core.commentChar") ?? "#");
    if (!truthy(e8.variable("git-rebase-show-instructions"))) {
      e8.letBind({ "inhibit-read-only": true }, () => {
        const c = commentStart();
        const kept = e8.bufferText().split("\n").filter((l) => !l.startsWith(c)).join("\n");
        e8.deleteRegion(e8.pointMin(), e8.pointMax());
        e8.insert(kept);
        e8.gotoChar(e8.pointMin());
      });
    }
    e8.addHook("jit-lock-functions", fontify, { local: true });
    e8.remapCommand("git-rebase-mode-map", "undo" as e8.CommandName, commands.undo);
    showKeybindings();
    e8.makeLocalVariable("before-save-hook");
    e8.setVariable("before-save-hook", null);
    if (truthy(e8.variable("git-rebase-confirm-cancel"))) {
      e8.addHook("with-editor-cancel-query-functions", (force: unknown) => truthy(force as e8.Value) || !e8.bufferModified() || magitConfirm("abort-rebase", "Abort this rebase") !== undefined, { local: true });
    }
  },
});

