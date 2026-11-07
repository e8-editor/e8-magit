// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bookmarks of Magit buffers, after magit-bookmark.el and the bookmark
// support of magit-section.el: a bookmark of a status, diff, revision,
// stash, log, cherry, reflog, references or stashes buffer records the
// repository, the mode, the buffer's arguments (each mode's
// magit-bookmark-variables) and the sections hidden, under a name such
// as magit-log(main -- a.txt) (magit--make-bookmark), and jumping to it
// makes the buffer again (magit--handle-bookmark). Magit's buffers set
// bookmark-make-record-function to magit--make-bookmark, as magit-mode
// does.
//
// E8's bookmark.ts keeps only a file and a position: it does not call
// bookmark-make-record-function, keep a record's other properties, or
// jump through a handler, so C-x r m in a Magit buffer still bookmarks
// no file. The records and the handler are here for when it does.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { hide, magitRootSection, show, type Section } from "magit-section";
import { magitRevAbbrev, magitRevFormat, magitToplevel } from "magit-git";
import { magitDiffSetupBuffer, magitDiffType, magitRevisionSetupBuffer, magitStashSetupBuffer } from "magit-diff";
import { magitCherrySetupBuffer, magitLogSetupBuffer, magitReflogSetupBuffer } from "magit-log";
import { magitRefsSetupBuffer } from "magit-refs";
import { magitStashesSetupBuffer } from "magit-stash";
import { magitStatusSetupBuffer } from "magit-status";

/** A bookmark record's properties, as bookmark.el's alist after the name. */
export type MagitBookmark = { [property: string]: e8.Value };

type Values = (e8.Value | undefined)[];
const strings = (v: e8.Value | undefined): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** What each mode's bookmark records and how its buffer is made again, as the modes' magit-bookmark-variables and -setup-buffer functions. */
const modes: { [mode: string]: { variables: string[]; setup: (v: Values) => unknown } } = {
  "magit-diff-mode": {
    variables: ["magit-buffer-range-hashed", "magit-buffer-typearg", "magit-buffer-diff-args", "magit-buffer-diff-files"],
    setup: ([range, typearg, args, files]) => magitDiffSetupBuffer((range as string | null) ?? undefined, (typearg as string | null) ?? undefined, strings(args), strings(files)),
  },
  "magit-revision-mode": {
    variables: ["magit-buffer-revision-hash", "magit-buffer-diff-args", "magit-buffer-diff-files"],
    setup: ([rev, args, files]) => magitRevisionSetupBuffer(String(rev), strings(args), strings(files)),
  },
  "magit-stash-mode": {
    variables: ["magit-buffer-revision-hash", "magit-buffer-diff-args", "magit-buffer-diff-files"],
    setup: ([rev, args, files]) => magitStashSetupBuffer(String(rev), strings(args), strings(files)),
  },
  "magit-log-mode": {
    variables: ["magit-buffer-revisions", "magit-buffer-log-args", "magit-buffer-log-files"],
    setup: ([revs, args, files]) => magitLogSetupBuffer(strings(revs), strings(args), strings(files)),
  },
  "magit-cherry-mode": {
    variables: ["magit-buffer-refname", "magit-buffer-upstream"],
    setup: ([head, upstream]) => magitCherrySetupBuffer(String(head), String(upstream)),
  },
  "magit-reflog-mode": { variables: ["magit-buffer-refname"], setup: ([ref]) => magitReflogSetupBuffer(String(ref)) },
  "magit-status-mode": { variables: [], setup: () => magitStatusSetupBuffer(String(e8.variable("default-directory"))) },
  "magit-refs-mode": {
    variables: ["magit-buffer-upstream", "magit-buffer-arguments"],
    setup: ([upstream, args]) => magitRefsSetupBuffer((upstream as string | null) ?? undefined, strings(args)),
  },
  "magit-stashes-mode": { variables: [], setup: () => magitStashesSetupBuffer() },
};

/** MODE's magit-bookmark-variables property, undefined for a mode bookmarking is not implemented for. */
export const magitBookmarkVariables = (mode = String(e8.variable("major-mode"))): string[] | undefined => modes[mode]?.variables;

const value = (name: string): e8.Value => e8.variable(name) ?? null;
const list = (name: string): string[] => strings(e8.variable(name));
/** A value as Lisp's format "%s" writes it: a list in parentheses. */
const lispFormat = (v: e8.Value): string => (Array.isArray(v) ? `(${v.map(lispFormat).join(" ")})` : String(v));

/** The name of a bookmark of the current buffer, as magit-bookmark-name and its methods. */
export function magitBookmarkName(): string {
  const mode = String(e8.variable("major-mode"));
  const files = (variable: string, sep: string): string => (list(variable).length > 0 ? `${sep}${list(variable).join(" ")}` : "");
  const revisionName = (kind: string): string => {
    const rev = String(value("magit-buffer-revision"));
    return `${kind}(${magitRevAbbrev(rev) ?? rev} ${list("magit-buffer-diff-files").length > 0 ? list("magit-buffer-diff-files").join(" ") : (magitRevFormat("%s", rev) ?? "")})`;
  };
  switch (mode) {
    case "magit-diff-mode": {
      const type = magitDiffType(magitRootSection());
      const what =
        type === "staged" || type === "unstaged"
          ? type
          : type === "committed"
            ? String(value("magit-buffer-range"))
            : lispFormat([value("magit-buffer-typearg"), value("magit-buffer-range-hashed")].filter((v) => v !== null));
      return `magit-diff(${what}${files("magit-buffer-diff-files", " -- ")})`;
    }
    case "magit-revision-mode":
      return revisionName("magit-revision");
    case "magit-stash-mode":
      return revisionName("magit-stash");
    case "magit-log-mode":
      return `magit-log(${list("magit-buffer-revisions").join(" ")}${files("magit-buffer-log-files", " -- ")})`;
    case "magit-cherry-mode":
      return `magit-cherry(${String(value("magit-buffer-refname"))} > ${String(value("magit-buffer-upstream"))})`;
    case "magit-reflog-mode":
      return `magit-reflog(${String(value("magit-buffer-refname"))})`;
    case "magit-stashes-mode":
      return `magit-states(${String(value("magit-buffer-refname"))})`;
    default: {
      const values = (modes[mode]?.variables ?? []).flatMap((v) => {
        const x = value(v);
        return Array.isArray(x) ? x : x === null ? [] : [x];
      });
      return `${mode.replace(/-mode$/, "")}${values.length > 0 ? lispFormat(values) : ""}`;
    }
  }
}

/** A section's value in a bookmark, as magit-bookmark--get-child-value: a stash's revision as its hash. */
function childValue(s: Section): e8.Value {
  let v = s.value as unknown;
  if (v && typeof v === "object" && typeof (v as { file?: unknown }).file === "string") v = (v as { file: string }).file;
  if (String(e8.variable("major-mode")) === "magit-stash-mode" && typeof v === "string") {
    v = v.replaceAll(String(value("magit-buffer-revision")), String(value("magit-buffer-revision-hash")));
  }
  return (v ?? null) as e8.Value;
}

/**
 * A bookmark of the current Magit buffer, as magit--make-bookmark: its
 * handler, mode, repository, default name, the mode's bookmark variables
 * and the top-level sections hidden.
 */
export function magitMakeBookmark(): MagitBookmark {
  const mode = String(e8.variable("major-mode"));
  const variables = magitBookmarkVariables(mode);
  if (!variables) e8.userError(`Bookmarking is not implemented for ${mode} buffers`);
  const bookmark: MagitBookmark = {
    handler: "magit--handle-bookmark",
    mode,
    filename: magitToplevel() ?? e8.bufferName(),
    defaults: [magitBookmarkName()],
  };
  for (const v of variables!) bookmark[v] = value(v);
  bookmark["magit-hidden-sections"] = (magitRootSection()?.children ?? []).filter((s) => s.hidden).map((s) => [s.type, childValue(s)]);
  return bookmark;
}
e8.defun("magit--make-bookmark", () => magitMakeBookmark());

/** Shows a buffer nowhere, as magit-bookmark-get-buffer-create binds magit-display-buffer-function to identity. */
e8.defun("magit--bookmark-display-nowhere", () => undefined);

/**
 * Makes the buffer BOOKMARK records again, without showing it, hiding
 * the sections it had hidden, as magit--handle-bookmark; gives the
 * buffer, which Magit makes current for bookmark-jump to show.
 */
export function magitHandleBookmark(bookmark: MagitBookmark): string {
  const mode = String(bookmark.mode);
  const entry = modes[mode];
  if (!entry) e8.userError(`Bookmarking is not implemented for ${mode} buffers`);
  // As magit-bookmark-get-buffer-create: in the repository, displayed nowhere.
  const buffer = e8.letBind({ "default-directory": String(bookmark.filename), "magit-display-buffer-function": "magit--bookmark-display-nowhere" }, () => entry!.setup(entry!.variables.map((v) => bookmark[v])) as string);
  const hidden = (bookmark["magit-hidden-sections"] as [string, e8.Value][] | null) ?? [];
  e8.withCurrentBuffer(buffer, () => {
    for (const child of magitRootSection()?.children ?? []) {
      const isHidden = hidden.some(([type, v]) => type === child.type && JSON.stringify(v) === JSON.stringify(childValue(child)));
      if (isHidden) hide(child);
      else show(child);
    }
  });
  return buffer;
}
e8.defun("magit--handle-bookmark", (bookmark: MagitBookmark) => magitHandleBookmark(bookmark));

// Magit's buffers make their bookmarks so, as magit-mode sets the variable.
if (!e8.variableNames().includes("bookmark-make-record-function")) {
  e8.defineVariable({ name: "bookmark-make-record-function", doc: "The function that makes a bookmark record of the current buffer, as bookmark.el's.", value: null });
}
e8.addHook("magit-mode-hook", () => {
  e8.makeLocalVariable("bookmark-make-record-function");
  e8.setVariable("bookmark-make-record-function", "magit--make-bookmark");
});
