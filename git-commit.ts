// SPDX-License-Identifier: GPL-3.0-or-later
//
// Editing Git commit messages, after git-commit.el of Magit 4.4.0
// (https://github.com/magit/magit). When git asks E8 to edit a commit
// message, .git/COMMIT_EDITMSG or another of the files
// git-commit-filename-regexp names, git-commit-setup turns on
// git-commit-major-mode, text-mode by default, and the minor mode
// git-commit-mode, whose keys are these:
//
//   C-c C-c  finish: git makes the commit (with-editor's key)
//   C-c C-k  cancel: git gives the commit up (with-editor's key)
//   M-p M-n  the previous and next messages of the message history,
//            after saving the one being written; C-c M-p and C-c M-n
//            search the history, C-c M-s saves the message to it
//   C-c C-i  insert a trailer, from a menu; C-c C-a, C-c C-r, C-c C-s,
//            C-c C-t, C-c C-m, C-c C-o, C-c C-p and C-c M-i insert one
//            trailer each: Acked-by, Reviewed-by, Signed-off-by and so on
//   C-c C-d  show the changes being committed
//
// The summary line is highlighted, its part past
// git-commit-summary-max-length as overlong, a second line that is not
// empty as an error, and the comments, trailers and [keywords] each in
// faces of their own. Finishing asks before committing a message whose
// summary is too long or whose second line is not empty, as
// git-commit-style-convention-checks says, and a message canceled is
// kept in the history.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
// Ported to E8 in 2026.
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { forwardLine, PerBuffer, truthy } from "subr";
import { magitCompletingRead, magitFormatPrompt, prefixArgP } from "magit-base";
import { magitGet, magitGitLines, magitListLocalBranchNames, magitRevParse, magitToplevel } from "magit-git";
import { transientDefinePrefix } from "transient";
import { withEditorMode } from "with-editor";

// Helpers.

/** Quotes TEXT for an Emacs regexp, as regexp-quote. */
const regexpQuote = (text: string): string => text.replace(/[[*.\\?+^$]/g, "\\$&");
/** Quotes TEXT for a JavaScript regexp. */
const jsQuote = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The comment start, core.commentChar, as git-commit-setup-font-lock sets comment-start. */
const commentStart = (): string => {
  const c = e8.variable("comment-start");
  return typeof c === "string" && c !== "" ? c : "#";
};
/** The list a variable holds, as strings. */
const listOf = (name: string): string[] => {
  const v = e8.variable(name);
  return Array.isArray(v) ? v.map(String) : [];
};
/** Sets NAME in the current buffer only, as setq-local. */
function setLocal(name: string, value: e8.Value): void {
  e8.makeLocalVariable(name);
  e8.setVariable(name, value);
}
/** The functions, by name, added to each buffer's own hooks by addLocalHookName. */
const localHookNames = new PerBuffer<Map<string, Set<string>>>();
/** Adds the function named NAME to the current buffer's HOOK, as add-hook with LOCAL, remembering it by name. */
function addLocalHookName(hook: string, name: string): void {
  let hooks = localHookNames.get(e8.currentBuffer());
  if (!hooks) localHookNames.set(e8.currentBuffer(), (hooks = new Map()));
  if (!hooks.has(hook)) hooks.set(hook, new Set());
  if (hooks.get(hook)!.has(name)) return;
  hooks.get(hook)!.add(name);
  e8.addHook(hook, (...args: unknown[]) => e8.funcall(name, ...args), { local: true });
}
/** Whether the function named NAME is on the current buffer's own HOOK, as memq of the hook's local value. */
const localHookHas = (hook: string, name: string): boolean => localHookNames.get(e8.currentBuffer())?.get(hook)?.has(name) ?? false;
/** Puts the keys bound to commands in TEXT, as substitute-command-keys does with \\[command]. */
const substituteCommandKeys = (text: string): string => text.replace(/\\\\?\[([^\]]+)\]/g, (_, c: string) => e8.whereIs(c) ?? `M-x ${c}`);

// Options.

e8.defineMinorMode({
  name: "global-git-commit-mode",
  global: true,
  doc:
    "Edit Git commit messages.\n\nThis global mode arranges for `git-commit-setup' to be called when a Git commit message file is opened.  " +
    "That usually happens when Git uses E8 as $GIT_EDITOR to have the user provide such a commit message.",
  onChange: (on) => {
    if (on) {
      e8.addHook("find-file-hook", gitCommitSetupCheckBuffer);
      e8.addHook("after-change-major-mode-hook", gitCommitSetupFontLockInBuffer);
    } else {
      e8.removeHook("find-file-hook", gitCommitSetupCheckBuffer);
      e8.removeHook("after-change-major-mode-hook", gitCommitSetupFontLockInBuffer);
    }
  },
});

e8.defineVariable({ name: "git-commit-major-mode", doc: "Major mode used to edit Git commit messages.\n\nThe major mode configured here is turned on by the minor mode `git-commit-mode'.", value: "text-mode" });

e8.defineHook("git-commit-setup-hook", "Hook run at the end of `git-commit-setup'.");
e8.defineHook(
  "git-commit-post-finish-hook",
  "Hook run after the user finished writing a commit message.\n\nThis hook is only run after pressing C-c C-c in a buffer used to edit a commit message.  " +
    "If a commit is created without the user typing a message into a buffer, then this hook is not run.\n\n" +
    "This hook is not run until the new commit has been created.  If that takes Git longer than `git-commit-post-finish-hook-timeout' seconds, then this hook isn't run at all.  " +
    "For certain commands such as `magit-rebase-continue' this hook is never run because doing so would lead to a race condition.",
);
e8.defineVariable({
  name: "git-commit-post-finish-hook-timeout",
  doc: "Time in seconds to wait for git to create a commit.\n\nThe hook `git-commit-post-finish-hook' (which see) is run only after git is done creating a commit.  If it takes longer than `git-commit-post-finish-hook-timeout' seconds to create the commit, then the hook is not run at all.",
  value: 2,
});
e8.defineHook(
  "git-commit-finish-query-functions",
  "List of functions called to query before performing commit.\n\nThe commit message buffer is current while the functions are called.  If any of them returns nil, then the commit is not performed and the buffer is not killed.  " +
    "The user should then fix the issue and try again.\n\nThe functions are called with one argument.  If it is non-nil, then that indicates that the user used a prefix argument to force finishing the session despite issues.  " +
    "Functions should usually honor this wish and return non-nil.",
);
e8.defineVariable({
  name: "git-commit-style-convention-checks",
  doc: "List of checks performed by `git-commit-check-style-conventions'.\n\nValid members are `non-empty-second-line' and `overlong-summary-line'.  That function is a member of `git-commit-finish-query-functions'.",
  value: ["non-empty-second-line"],
});
e8.defineVariable({
  name: "git-commit-summary-max-length",
  doc:
    "Column beyond which characters in the summary lines are highlighted.\n\nThe highlighting indicates that the summary is getting too long by some standards.  " +
    "It does in no way imply that going over the limit a few characters or in some cases even many characters is anything that deserves shaming.  " +
    "It's just a friendly reminder that if you can make the summary shorter, then you might want to consider doing so.",
  value: 68,
});
e8.defineVariable({
  name: "git-commit-trailers",
  doc: "A list of Git trailers to be highlighted.\n\nSee also manpage git-interpret-trailer(1).  This package does not use that Git command, but the initial description still serves as a good introduction.",
  value: ["Acked-by", "Modified-by", "Reviewed-by", "Signed-off-by", "Tested-by", "Cc", "Reported-by", "Suggested-by", "Co-authored-by", "Co-developed-by"],
});
e8.defineVariable({
  name: "git-commit-use-local-message-ring",
  doc: "Whether to use a local message ring instead of the global one.\n\nThis can be set globally, in which case every repository gets its own commit message ring, or locally for a single repository.",
  value: false,
});
e8.defineVariable({
  name: "git-commit-cd-to-toplevel",
  doc:
    "Whether to set `default-directory' to the worktree in message buffer.\n\nEditing a commit message is done by visiting a file located in the git directory, usually \"COMMIT_EDITMSG\".  " +
    "If this option is non-nil, then the local `default-directory' is changed to the working tree from which the commit command was invoked.",
  value: false,
});
e8.defineVariable({
  name: "git-commit-need-summary-line",
  local: true,
  doc: "Whether the text should have a heading that is separated from the body.\n\nFor commit messages that is a convention that should not be violated.  For notes it is up to the user.",
  value: true,
});
e8.defineVariable({
  name: "git-commit-filename-regexp",
  doc: "The files git asks to have edited that are commit messages, as the Emacs regexp their names match.",
  value: "/\\(\\(\\(COMMIT\\|NOTES\\|PULLREQ\\|MERGEREQ\\|TAG\\)_EDIT\\|MERGE_\\|\\)MSG\\|\\(BRANCH\\|EDIT\\)_DESCRIPTION\\)\\'",
});
const GIT_COMMIT_DEFAULT_USAGE_MESSAGE =
  "Type \\[with-editor-finish] to finish, \\[with-editor-cancel] to cancel, and \\[git-commit-prev-message] and \\[git-commit-next-message] to recover older messages";
e8.defineVariable({ name: "git-commit-default-usage-message", doc: "The message git-commit-usage-message is by default.", value: GIT_COMMIT_DEFAULT_USAGE_MESSAGE });
e8.defineVariable({
  name: "git-commit-usage-message",
  doc: "Message displayed when editing a commit message.\nWhen this is nil, then `with-editor-usage-message' is displayed instead.",
  value: GIT_COMMIT_DEFAULT_USAGE_MESSAGE,
});
e8.defineVariable({
  name: "git-commit-header-line-format",
  doc: "If non-nil, header line format used by `git-commit-mode'.\nUsed as the local value of `header-line-format', in buffer using `git-commit-mode'.  If it is a string, then it is passed through `substitute-command-keys' first.",
  value: null,
});
e8.defineVariable({
  name: "git-commit-comment-headings",
  doc: "Also fontified outside of comments in `git-commit-font-lock-keywords-2'.",
  value: ["Changes to be committed:", "Untracked files:", "Changed but not updated:", "Changes not staged for commit:", "Unmerged paths:", "Author:", "Date:"],
});
e8.defineVariable({ name: "git-commit-read-ident-history", doc: "The names and emails git-commit-read-ident was given.", value: [] });
e8.defineVariable({ name: "git-commit--branch-name-regexp", local: true, doc: "The local branches, as the comments' keywords match them.", value: null });

// log-edit's message history, which git-commit keeps its messages in.
e8.defineVariable({ name: "log-edit-maximum-comment-ring-size", doc: "Maximum number of saved comments in the comment ring.", value: 32 });
e8.defineVariable({ name: "log-edit-comment-ring-index", local: true, doc: "The index of the comment last shown from the comment ring, or nil.", value: null });
e8.defineVariable({ name: "log-edit-last-comment-match", doc: "The last substring searched for in the comment ring.", value: "" });

// with-editor's query functions and hooks, which e8-with-editor 0.1.0 does
// not have yet: they run here, as advice of its finish and cancel.
if (!e8.isHook("with-editor-finish-query-functions")) {
  e8.defineHook("with-editor-finish-query-functions", "List of functions called to query before finishing session.\n\nIf any of them returns nil, then the session is not finished.  The functions are called with one argument: whether the user gave a prefix argument, to force finishing.");
  e8.defineHook("with-editor-cancel-query-functions", "List of functions called to query before canceling session.\n\nIf any of them returns nil, then the session is not canceled.  The functions are called with one argument: whether the user gave a prefix argument, to force canceling.");
  e8.defineHook("with-editor-pre-finish-hook", "Hook run before finishing the session, in the buffer being edited.");
  e8.defineHook("with-editor-pre-cancel-hook", "Hook run before canceling the session, in the buffer being edited.");
  e8.defineVariable({ name: "with-editor-cancel-message", local: true, doc: "The message shown when the session is canceled, or a function giving it.", value: null });
  e8.adviceAdd(
    "with-editor-finish",
    "around",
    (orig: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      if (!e8.runHookWithArgsUntilFailure("with-editor-finish-query-functions", truthy(e8.prefixArg()))) return;
      e8.runHooks("with-editor-pre-finish-hook");
      return orig(...args);
    },
    { name: "with-editor-finish-query", depth: -50 },
  );
  e8.adviceAdd(
    "with-editor-cancel",
    "around",
    (orig: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      if (!e8.runHookWithArgsUntilFailure("with-editor-cancel-query-functions", truthy(e8.prefixArg()))) return;
      let message = e8.variable("with-editor-cancel-message");
      if (typeof message === "function" || (typeof message === "string" && e8.fboundp(message))) message = e8.funcall(message as string);
      e8.runHooks("with-editor-pre-cancel-hook");
      const result = orig(...args);
      e8.message(typeof message === "string" && message !== "" ? message : "Canceled by user");
      return result;
    },
    { name: "with-editor-cancel-query", depth: -50 },
  );
}
e8.defineVariable({ name: "with-editor-usage-message", local: true, doc: "The message shown when a file a program asked to have edited is visited.", value: "Type \\[with-editor-finish] to finish, or \\[with-editor-cancel] to cancel" });
e8.defineVariable({ name: "with-editor-show-usage", local: true, doc: "Whether to show the usage message when visiting a file a program asked to have edited.", value: true });

// Faces.

const faces: [string, string, e8.FaceAttributes][] = [
  ["git-commit-summary", "Face used for the summary in commit messages.", { inherit: "font-lock-type-face" }],
  ["git-commit-overlong-summary", "Face used for the tail of overlong commit message summaries.", { inherit: "font-lock-warning-face" }],
  ["git-commit-nonempty-second-line", "Face used for non-whitespace on the second line of commit messages.", { inherit: "font-lock-warning-face" }],
  ["git-commit-keyword", 'Face used for keywords in commit messages.\nIn this context a "keyword" is text surrounded by brackets.', { inherit: "font-lock-string-face" }],
  ["git-commit-trailer-token", "Face used for Git trailer tokens in commit messages.", { inherit: "font-lock-keyword-face" }],
  ["git-commit-trailer-value", "Face used for Git trailer values in commit messages.", { inherit: "font-lock-string-face" }],
  ["git-commit-comment-branch-local", "Face used for names of local branches in commit message comments.", { inherit: "magit-branch-local" }],
  ["git-commit-comment-branch-remote", "Face used for names of remote branches in commit message comments.", { inherit: "magit-branch-remote" }],
  ["git-commit-comment-detached", "Face used for detached `HEAD' in commit message comments.", { inherit: "git-commit-comment-branch-local" }],
  ["git-commit-comment-heading", "Face used for headings in commit message comments.", { inherit: "git-commit-trailer-token" }],
  ["git-commit-comment-file", "Face used for file names in commit message comments.", { inherit: "git-commit-trailer-value" }],
  ["git-commit-comment-action", "Face used for actions in commit message comments.", { inherit: "bold" }],
  // The faces' names before git-commit 4.0.0.
  ["git-commit-pseudo-header", "Obsolete face; use `git-commit-trailer-value' instead.", { inherit: "git-commit-trailer-value" }],
  ["git-commit-known-pseudo-header", "Obsolete face; use `git-commit-trailer-token' instead.", { inherit: "git-commit-trailer-token" }],
];
for (const [name, doc, attributes] of faces) e8.defineFace({ name, doc, attributes });

// The message history, as log-edit-comment-ring.

/** A ring of messages, the newest at index 0, as Emacs's ring.el rings. */
class Ring {
  items: string[] = [];
  get length(): number {
    return this.items.length;
  }
  insert(item: string): void {
    this.items.unshift(item);
    const size = Number(e8.variable("log-edit-maximum-comment-ring-size") ?? 32);
    if (this.items.length > size) this.items.length = size;
  }
  ref(index: number): string {
    const n = this.items.length;
    return this.items[((index % n) + n) % n];
  }
  member(item: string): number | undefined {
    const i = this.items.indexOf(item);
    return i < 0 ? undefined : i;
  }
  remove(index: number): void {
    this.items.splice(index, 1);
  }
}

/** The ring every repository shares, as log-edit-comment-ring's global value. */
const logEditCommentRing = new Ring();
/** Each repository's ring, with git-commit-use-local-message-ring, as magit-repository-local-get keeps it. */
const repositoryRings = new Map<string, Ring>();
/** The ring each message buffer uses. */
const bufferRings = new PerBuffer<Ring>();
const ring = (): Ring => bufferRings.get(e8.currentBuffer()) ?? logEditCommentRing;

/** The messages of the ring the current buffer uses, the newest first: for tests and for code. */
export const gitCommitMessageRing = (): string[] => [...ring().items];

function gitCommitPrepareMessageRing(): void {
  e8.makeLocalVariable("log-edit-comment-ring-index");
  e8.setVariable("log-edit-comment-ring-index", null);
  if (truthy(e8.variable("git-commit-use-local-message-ring"))) {
    const key = magitToplevel() ?? String(e8.variable("default-directory"));
    if (!repositoryRings.has(key)) repositoryRings.set(key, new Ring());
    bufferRings.set(e8.currentBuffer(), repositoryRings.get(key)!);
  } else bufferRings.delete(e8.currentBuffer());
}

/** The message in the buffer, without its comments and what follows the cut line, or undefined if it is only whitespace, as git-commit-buffer-message. */
export function gitCommitBufferMessage(): string | undefined {
  const flush = commentStart();
  let str = e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax());
  const lines = str.split("\n");
  const cut = lines.findIndex((l) => new RegExp(`^${jsQuote(flush)} -+ >8 -+$`).test(l));
  const kept = (cut < 0 ? lines : [...lines.slice(0, cut), ""]).filter((l) => !l.startsWith(flush));
  str = kept.join("\n");
  if (!str.endsWith("\n")) str += "\n";
  if (/^[ \t\n\r]*$/.test(str)) return undefined;
  return str.replace(/^\n{2,}/, "\n").replace(/\n{2,}$/, "\n");
}

/** Saves the current message to the message history, as git-commit-save-message. */
export function gitCommitSaveMessage(): void {
  const message = gitCommitBufferMessage();
  if (message === undefined) {
    e8.message("Only whitespace and/or comments; message not saved");
    return;
  }
  const r = ring();
  const index = r.member(message);
  if (index !== undefined) r.remove(index);
  r.insert(message);
  e8.message("Message saved");
}

/** The comment index STRIDE elements from the current one, as log-edit-new-comment-index. */
function logEditNewCommentIndex(stride: number, len: number): number {
  const index = e8.variable("log-edit-comment-ring-index");
  const n = typeof index === "number" ? index + stride : stride > 0 ? stride - 1 : stride;
  return ((n % len) + len) % len;
}

/** Puts the message ARG back in the history in place of the buffer's, after saving that, as git-commit-prev-message. */
export function gitCommitPrevMessage(arg = 1): void {
  if (e8.bufferReadOnly()) e8.signal("buffer-read-only", e8.bufferName());
  const r = ring();
  let len = r.length;
  if (len <= 0) {
    e8.message("Empty comment ring");
    e8.ding();
    return;
  }
  // Unlike `log-edit-previous-comment' we save the current non-empty and
  // newly written comment, because otherwise it would be irreversibly lost.
  const message = gitCommitBufferMessage();
  if (message !== undefined && r.member(message) === undefined) {
    r.insert(message);
    arg++;
    len = r.length;
  }
  // Delete the message but not the instructions at the end.
  e8.gotoChar(e8.pointMin());
  const found = e8.reSearchForward(`^${regexpQuote(commentStart())}`, { noerror: true });
  const end = found !== undefined ? Math.max(e8.pointMin(), e8.point() - 2) : e8.pointMax();
  e8.deleteRegion(e8.pointMin(), end);
  e8.gotoChar(e8.pointMin());
  const index = logEditNewCommentIndex(arg, len);
  setLocal("log-edit-comment-ring-index", index);
  e8.message(`Comment ${index + 1}`);
  e8.insert(r.ref(index));
}

/** Searches the message history for STR, by STRIDE, as log-edit-comment-search-backward does with git-commit-prev-message. */
function searchMessages(input: string, stride: number): void {
  let str = input;
  if (str === "") str = String(e8.variable("log-edit-last-comment-match") ?? "");
  else e8.setVariable("log-edit-last-comment-match", str);
  const r = ring();
  const len = r.length;
  if (len === 0) throw new Error("Not found");
  const caseFold = truthy(e8.variable("case-fold-search"));
  let n = logEditNewCommentIndex(stride, len);
  for (;;) {
    if (n >= len || n < 0) throw new Error("Not found");
    if (e8.stringMatch(regexpQuote(str), r.ref(n), { caseFold }) !== undefined) break;
    n += stride;
  }
  setLocal("log-edit-comment-ring-index", n);
  gitCommitPrevMessage(0);
}

/** Searches backward through the message history for STRING, after saving the current message, as git-commit-search-message-backward. */
export const gitCommitSearchMessageBackward = (string: string): void => searchMessages(string, 1);
/** Searches forward through the message history for STRING, as git-commit-search-message-forward. */
export const gitCommitSearchMessageForward = (string: string): void => searchMessages(string, -1);

const readCommentSubstring = (): string => {
  const last = String(e8.variable("log-edit-last-comment-match") ?? "");
  return e8.readString(magitFormatPrompt("Comment substring", last), { default: last });
};

const commands = {
  saveMessage: e8.defineCommand({ name: "git-commit-save-message", doc: "Save current message to `log-edit-comment-ring'.", run: () => gitCommitSaveMessage() }),
  prevMessage: e8.defineCommand({
    name: "git-commit-prev-message",
    doc: "Cycle backward through message history, after saving current message.\nWith a numeric prefix ARG, go back ARG messages.",
    params: [{ name: "arg", kind: "count" }],
    run: (arg?: number) => gitCommitPrevMessage(arg ?? 1),
  }),
  nextMessage: e8.defineCommand({
    name: "git-commit-next-message",
    doc: "Cycle forward through message history, after saving current message.\nWith a numeric prefix ARG, go forward ARG messages.",
    params: [{ name: "arg", kind: "count" }],
    run: (arg?: number) => gitCommitPrevMessage(-(arg ?? 1)),
  }),
  searchBackward: e8.defineCommand({
    name: "git-commit-search-message-backward",
    doc: "Search backward through message history for a match for STRING.\nSave current message first.",
    run: () => gitCommitSearchMessageBackward(readCommentSubstring()),
  }),
  searchForward: e8.defineCommand({
    name: "git-commit-search-message-forward",
    doc: "Search forward through message history for a match for STRING.\nSave current message first.",
    run: () => gitCommitSearchMessageForward(readCommentSubstring()),
  }),
};

// Trailers.

/** Your name and email, or with PROMPT and a prefix argument someone else's read, as git-commit-get-ident. */
export function gitCommitGetIdent(prompt?: string): [string, string] {
  if (prompt !== undefined && prefixArgP()) return gitCommitReadIdent(prompt);
  const config = (key: string): string | undefined => {
    try {
      return magitGet(key);
    } catch (e) {
      e8.message(`Error running 'git config ${key}': ${String(e)}`);
      return undefined;
    }
  };
  const fullName = e8.variable("user-full-name");
  const name =
    e8.getenv("GIT_AUTHOR_NAME") ?? e8.getenv("GIT_COMMITTER_NAME") ?? config("user.name") ?? (typeof fullName === "string" && fullName !== "" ? fullName : undefined) ?? e8.readString("Name: ");
  const email = e8.getenv("GIT_AUTHOR_EMAIL") ?? e8.getenv("GIT_COMMITTER_EMAIL") ?? e8.getenv("EMAIL") ?? config("user.email") ?? e8.readString("Email: ");
  return [name, email];
}

/**
 * Reads a name and email, prompting with PROMPT, as git-commit-read-ident:
 * in one prompt, offering the past commit authors, as "NAME <EMAIL>".
 */
export function gitCommitReadIdent(prompt: string): [string, string] {
  const authors = [...new Set(magitGitLines("log", "-n9999", "--format=%aN <%ae>"))].sort();
  const str = magitCompletingRead(prompt, authors, { requireMatch: "any", history: "git-commit-read-ident-history" }) ?? "";
  const m = /^([^<]+) *<([^>]+)>$/.exec(str);
  if (!m) e8.userError("Invalid input");
  return [m[1].trim(), m[2].trim()];
}

/** The trailer lines, as the JavaScript regexp git-commit--trailer-regexp is: groups 1 and 2 a known trailer and its value, 3 to 5 another and ": " and its "NAME <EMAIL>". */
function trailerRegexp(): RegExp {
  const known = listOf("git-commit-trailers").map(jsQuote).join("|");
  return new RegExp(`^(?:(${known === "" ? "(?!)" : `(?:${known})`}:)( .*)|([-a-zA-Z]+)(: )([^<\\n]+? <[^>\\n]+>))`);
}

/** Inserts the trailer "TRAILER: VALUE" after the last trailer, or before the comments, as git-commit--insert-trailer. */
export function gitCommitInsertTrailer(trailer: string, value: string): void {
  e8.saveExcursion(() => {
    const string = `${trailer}: ${value}`;
    const c = commentStart();
    // Make sure we skip forward past any leading comments.
    e8.gotoChar(e8.pointMin());
    while (e8.point() < e8.pointMax() && e8.lookingAt(regexpQuote(c))) if (forwardLine(1) !== 0) break;
    const leadingCommentEnd = e8.point();
    e8.gotoChar(e8.pointMax());
    const re = trailerRegexp();
    let trailerLine: number | undefined;
    for (let line = e8.lineOf(e8.pointMax()); line >= e8.lineOf(e8.pointMin()); line--) {
      if (re.test(e8.lineText(line))) {
        trailerLine = line;
        break;
      }
    }
    if (trailerLine !== undefined) {
      // Look backwards for existing trailers.
      e8.gotoChar(e8.lineEnd(trailerLine));
      e8.insert(`\n${string}`);
      if (e8.point() < e8.pointMax() && e8.charAfter(e8.point()) !== "\n") e8.insert("\n");
    } else {
      // Or place the new trailer right before the first non-leading comments.
      for (let line = e8.lineOf(leadingCommentEnd); line <= e8.lineOf(e8.pointMax()); line++) {
        const ls = e8.lineStart(line);
        if (ls >= leadingCommentEnd && e8.lineText(line).startsWith(c)) {
          e8.gotoChar(ls);
          break;
        }
      }
      const p = e8.point();
      if (!(p - e8.pointMin() >= 2 && e8.bufferSubstringNoProperties(p - 2, p) === "\n\n")) e8.insert("\n");
      e8.insert(`${string}\n`);
    }
    if (!(e8.point() >= e8.pointMax() || e8.charAfter(e8.point()) === "\n")) e8.insert("\n");
  });
}

/** Inserts the trailer "TRAILER: NAME <EMAIL>", as git-commit--insert-ident-trailer. */
export const gitCommitInsertIdentTrailer = (trailer: string, name: string, email: string): void => gitCommitInsertTrailer(trailer, `${name} <${email}>`);
e8.defun("git-commit--insert-ident-trailer", gitCommitInsertIdentTrailer);
e8.defun("git-commit-insert-header", gitCommitInsertIdentTrailer);

/** The trailer commands: name, trailer, whether they are by yourself unless a prefix argument says otherwise (git-commit-get-ident) or read (git-commit-read-ident), doc. */
const trailerCommands: [string, string, boolean, string][] = [
  ["git-commit-ack", "Acked-by", true, "Insert a trailer acknowledging that you have looked at the commit."],
  ["git-commit-modified", "Modified-by", true, "Insert a trailer to signal that you have modified the commit."],
  ["git-commit-review", "Reviewed-by", true, "Insert a trailer acknowledging that you have reviewed the commit.\nWith a prefix argument, prompt for another person who performed a review."],
  ["git-commit-signoff", "Signed-off-by", true, "Insert a trailer to sign off the commit.\nWith a prefix argument, prompt for another person who signed off."],
  ["git-commit-test", "Tested-by", true, "Insert a trailer acknowledging that you have tested the commit.\nWith a prefix argument, prompt for another person who tested."],
  ["git-commit-cc", "Cc", false, "Insert a trailer mentioning someone who might be interested."],
  ["git-commit-reported", "Reported-by", false, "Insert a trailer mentioning the person who reported the issue."],
  ["git-commit-suggested", "Suggested-by", false, "Insert a trailer mentioning the person who suggested the change."],
  ["git-commit-co-authored", "Co-authored-by", false, "Insert a trailer mentioning the person who co-authored the commit."],
  ["git-commit-co-developed", "Co-developed-by", false, "Insert a trailer mentioning the person who co-developed the commit."],
];
const trailer: { [name: string]: e8.DefinedCommand } = {};
for (const [name, token, self, doc] of trailerCommands) {
  trailer[name] = e8.defineCommand({
    name,
    doc,
    run: () => {
      const [who, mail] = self ? gitCommitGetIdent(token) : gitCommitReadIdent(token);
      gitCommitInsertIdentTrailer(token, who, mail);
    },
  });
}

// The commands' functions, taking the name and email.
export const gitCommitAck = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Acked-by", name, mail);
export const gitCommitModified = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Modified-by", name, mail);
export const gitCommitReview = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Reviewed-by", name, mail);
export const gitCommitSignoff = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Signed-off-by", name, mail);
export const gitCommitTest = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Tested-by", name, mail);
export const gitCommitCc = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Cc", name, mail);
export const gitCommitReported = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Reported-by", name, mail);
export const gitCommitSuggested = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Suggested-by", name, mail);
export const gitCommitCoAuthored = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Co-authored-by", name, mail);
export const gitCommitCoDeveloped = (name: string, mail: string): void => gitCommitInsertIdentTrailer("Co-developed-by", name, mail);

export const gitCommitInsertTrailerMenu = transientDefinePrefix("git-commit-insert-trailer", {
  doc: "Insert a commit message trailer.\n\nSee also manpage git-interpret-trailer(1).  This command does not use that Git command, but the initial description still serves as a good introduction.",
  groups: [
    {
      class: "columns",
      items: [
        {
          description: () => (prefixArgP() ? "Insert ... by someone " : "Insert ... by yourself"),
          items: [
            ["a", "Ack", "git-commit-ack"],
            ["m", "Modified", "git-commit-modified"],
            ["r", "Reviewed", "git-commit-review"],
            ["s", "Signed-off", "git-commit-signoff"],
            ["t", "Tested", "git-commit-test"],
          ],
        },
        {
          description: "Insert ... by someone",
          items: [
            ["C-c", "Cc", "git-commit-cc"],
            ["C-r", "Reported", "git-commit-reported"],
            ["C-i", "Suggested", "git-commit-suggested"],
            ["C-a", "Co-authored", "git-commit-co-authored"],
            ["C-d", "Co-developed", "git-commit-co-developed"],
          ],
        },
      ],
    },
  ],
});
e8.defalias("git-commit-insert-pseudo-header", "git-commit-insert-trailer");

// Font-Lock.

/** A character's face as font-lock leaves it: a face, faces, or none. */
type Face = string | string[] | undefined;
/** How a keyword's face goes on text that has one, as font-lock's OVERRIDE: nil leaves text with any face alone, t replaces. */
type Override = "nil" | "t" | "append" | "prepend";

/** Puts FACE on FACES from S to E as font-lock-apply-highlight does with OVERRIDE. */
function applyFace(faces: Face[], s: number, e: number, face: string, override: Override): void {
  if (s >= e) return;
  if (override === "nil") {
    for (let i = s; i < e; i++) if (faces[i] !== undefined) return;
  }
  for (let i = s; i < e; i++) {
    const old = faces[i];
    if (override === "nil" || override === "t" || old === undefined) faces[i] = face;
    else {
      const list = typeof old === "string" ? [old] : old;
      faces[i] = override === "append" ? [...list, face] : [face, ...list];
    }
  }
}

/** Where each group of M starts, the groups following one another from the match's start. */
function groupStarts(m: RegExpExecArray): number[] {
  const starts: number[] = [m.index];
  let at = m.index;
  for (let i = 1; i < m.length; i++) {
    starts[i] = at;
    at += (m[i] ?? "").length;
  }
  return starts;
}
/** Puts FACE on group N of M, as a keyword's highlighter does; nothing if the group did not match, as LAXMATCH. */
function applyGroup(faces: Face[], m: RegExpExecArray, n: number, face: string, override: Override): void {
  if (m[n] === undefined) return;
  const s = groupStarts(m)[n];
  applyFace(faces, s, s + m[n].length, face, override);
}

/** The summary as git-commit-summary-regexp matches it: its line, the summary and overlong parts' ends in it, and whether the next line is a nonempty second line. */
interface Summary {
  line: number;
  /** Where the summary's part within git-commit-summary-max-length ends, in UTF-16 units of the line. */
  max: number;
  /** Where the line ends. */
  end: number;
  /** Whether line + 1 is a second line that is neither empty nor a comment. */
  secondLine: boolean;
}

/** Finds the summary as git-commit-summary-regexp does, after the leading empty lines and comments. */
function gitCommitSummary(): Summary | undefined {
  if (!truthy(e8.variable("git-commit-need-summary-line"))) return undefined;
  const c = commentStart();
  const first = e8.lineOf(e8.pointMin());
  const last = e8.lineOf(e8.pointMax());
  let line = first;
  // Leading empty lines and comments, each with its newline.
  while (line < last) {
    const t = e8.lineText(line);
    if (!(/^\s*$/.test(t) || t.startsWith(c))) break;
    line++;
  }
  const text = e8.lineText(line);
  const maxLength = Number(e8.variable("git-commit-summary-max-length") ?? 68);
  const head = /^.*/u.exec(text)![0];
  const chars = Array.from(head);
  const max = chars.length > maxLength ? chars.slice(0, maxLength).join("").length : head.length;
  const next = line < last ? e8.lineText(line + 1) : undefined;
  return { line, max, end: head.length, secondLine: next !== undefined && next !== "" && !next.startsWith(c) };
}

/** The lines that make up the summary construct, as git-commit-extend-region-summary-line finds it. */
const summaryEndLine = (s: Summary | undefined): number => (s === undefined ? -1 : s.secondLine ? s.line + 1 : s.line);

/** The keywords of git-commit-elisp-text-mode, prepended, as git-commit-elisp-text-mode-keywords. */
function elispTextKeywords(text: string, faces: Face[]): void {
  const symbol = /[`‘]((?:[\p{L}\p{N}_\-+*/<>=!?$%&:^~.@]|\\.)+)['’]/gu;
  for (let m = symbol.exec(text); m; m = symbol.exec(text)) applyGroup(faces, m, 1, "font-lock-constant-face", "prepend");
  const string = /"[^"]*"/g;
  for (let m = string.exec(text); m; m = string.exec(text)) applyFace(faces, m.index, m.index + m[0].length, "font-lock-string-face", "prepend");
}

/** The faces of LINE, whose text is TEXT, as git-commit-font-lock-keywords give them. */
function lineFaces(line: number, text: string, summary: Summary | undefined, trailers: RegExp, c: string): Face[] {
  const faces: Face[] = new Array(text.length).fill(undefined);
  const q = jsQuote(c);
  const exec = (re: RegExp) => re.exec(text);
  // Trailers.
  const t = exec(trailers);
  if (t) {
    applyGroup(faces, t, 1, "git-commit-trailer-token", "nil");
    applyGroup(faces, t, 2, "git-commit-trailer-value", "nil");
    applyGroup(faces, t, 3, "git-commit-trailer-token", "nil");
    applyGroup(faces, t, 5, "git-commit-trailer-value", "nil");
  }
  // Summary.
  const easterEggs: RegExpExecArray[] = [];
  if (truthy(e8.variable("git-commit-need-summary-line"))) {
    if (summary && summary.line === line) applyFace(faces, 0, summary.max, "git-commit-summary", "nil");
  } else {
    const egg = /(EASTER)( )(EGG)/g;
    for (let m = egg.exec(text); m; m = egg.exec(text)) {
      easterEggs.push(m);
      applyGroup(faces, m, 1, "git-commit-summary", "nil");
    }
  }
  // - Keyword [aka "text in brackets"] (overrides summary).
  const keyword = /\[[^\][]+?\]/g;
  for (let m = keyword.exec(text); m; m = keyword.exec(text)) applyFace(faces, m.index, m.index + m[0].length, "git-commit-keyword", "t");
  // - Non-empty second line (overrides summary and note).
  if (summary && summary.line === line) applyFace(faces, summary.max, summary.end, "git-commit-overlong-summary", "t");
  if (summary && summary.secondLine && summary.line + 1 === line) applyFace(faces, 0, text.length, "git-commit-nonempty-second-line", "t");
  for (const m of easterEggs) applyGroup(faces, m, 3, "git-commit-overlong-summary", "t");
  // Comments.
  if (text.startsWith(c)) {
    applyFace(faces, 0, text.length, "font-lock-comment-face", "append");
    let m: RegExpExecArray | null;
    if ((m = exec(new RegExp(`^(${q} On branch )(.*)`)))) applyGroup(faces, m, 2, "git-commit-comment-branch-local", "t");
    if ((m = exec(new RegExp(`^(${q} )(HEAD)( detached at)`)))) applyGroup(faces, m, 2, "git-commit-comment-detached", "t");
    const headings = listOf("git-commit-comment-headings").map(jsQuote).join("|");
    if (headings !== "" && (m = exec(new RegExp(`^(${q} )(${headings})`)))) applyGroup(faces, m, 2, "git-commit-comment-heading", "t");
    if ((m = exec(new RegExp(`^(${q}\\t)(?:([^:\\n]+)(:\\s+))?(.*)`)))) {
      applyGroup(faces, m, 2, "git-commit-comment-action", "t");
      applyGroup(faces, m, 4, "git-commit-comment-file", "t");
    }
  }
  // "commit HASH".
  let m = exec(/^commit [\p{L}\p{N}]+$/u);
  if (m) applyFace(faces, 0, text.length, "git-commit-trailer-value", "nil");
  // `git-commit-comment-headings' (but not in commented lines).
  const headings = listOf("git-commit-comment-headings").map(jsQuote).join("|");
  if (headings !== "" && (m = exec(new RegExp(`^(?:${headings})[ \\t]+.+$`)))) applyFace(faces, 0, text.length, "git-commit-trailer-value", "nil");
  // More comments.
  if (text.startsWith(c)) {
    const branch = String(e8.variable("git-commit--branch-name-regexp") ?? "()([^']*)");
    // Your branch is ahead of 'master' by 3 commits.
    // Your branch is behind 'master' by 2 commits, and can be fast-forwarded.
    if ((m = exec(new RegExp(`^(${q} Your branch is (?:ahead|behind) of ')${branch}(' by )([0-9]*)`)))) {
      applyGroup(faces, m, 2, "git-commit-comment-branch-local", "t");
      applyGroup(faces, m, 3, "git-commit-comment-branch-remote", "t");
      applyGroup(faces, m, 5, "bold", "t");
    }
    // Your branch is up to date with 'master'.
    // Your branch and 'master' have diverged,
    if ((m = exec(new RegExp(`^(${q} Your branch (?:is up[- ]to[- ]date with|and) ')${branch}`)))) {
      applyGroup(faces, m, 2, "git-commit-comment-branch-local", "t");
      applyGroup(faces, m, 3, "git-commit-comment-branch-remote", "t");
    }
    // and have 1 and 2 different commits each, respectively.
    if ((m = exec(new RegExp(`^(${q} and have )([0-9]*)( and )([0-9]*)( commits each)`)))) {
      applyGroup(faces, m, 2, "bold", "t");
      applyGroup(faces, m, 4, "bold", "t");
    }
  }
  if (e8.derivedModeP("git-commit-elisp-text-mode")) elispTextKeywords(text, faces);
  return faces;
}

/** The faces of LINE as text properties, from the start of its text to its end. */
function putLineFaces(line: number, text: string, faces: Face[]): void {
  const ls = e8.lineStart(line);
  e8.removeTextProperty(ls, e8.lineEnd(line), "face");
  // Positions count characters, JavaScript strings UTF-16 units.
  const wide = /[\uD800-\uDBFF]/.test(text);
  const pos = (i: number): number => ls + (wide ? Array.from(text.slice(0, i)).length : i);
  const same = (a: Face, b: Face) => a === b || (Array.isArray(a) && Array.isArray(b) && a.join(" ") === b.join(" "));
  let i = 0;
  while (i < faces.length) {
    let j = i + 1;
    while (j < faces.length && same(faces[j], faces[i])) j++;
    const f = faces[i];
    if (f !== undefined) e8.putTextProperty(pos(i), pos(j), "face", f);
    i = j;
  }
}

/** Highlights the lines from START to END, the summary's lines too when they are among them, as font-lock does with git-commit-font-lock-keywords. */
function gitCommitFontify(start: number, end: number): void {
  const summary = gitCommitSummary();
  let first = e8.lineOf(start);
  let last = e8.lineOf(Math.max(start, end - 1));
  // As git-commit-extend-region-summary-line: the summary is one construct.
  const summaryEnd = summaryEndLine(summary);
  if (first <= summaryEnd) {
    first = e8.lineOf(e8.pointMin());
    last = Math.max(last, summaryEnd);
  }
  const trailers = trailerRegexp();
  const c = commentStart();
  e8.withSilentModifications(() => {
    for (let line = first; line <= last; line++) {
      const text = e8.lineText(line);
      putLineFaces(line, text, lineFaces(line, text, summary, trailers, c));
    }
  });
}

/** Sets up the comment character and highlighting of a message, as git-commit-setup-font-lock. */
export function gitCommitSetupFontLock(): void {
  try {
    const parent = e8.syntaxTable();
    const table = `git-commit--${parent}`;
    e8.makeSyntaxTable(table, parent);
    for (const ch of new Set([commentStart().charAt(0), "#", '"', "'", "`"])) e8.modifySyntaxEntry(ch, ".", table);
    e8.setSyntaxTable(table);
    const c = magitGet("core.commentchar") ?? "#";
    setLocal("comment-start", c);
    setLocal("comment-start-skip", `^${regexpQuote(c)}+[ \t]*`);
    setLocal("comment-end", "");
    setLocal("comment-end-skip", "\n");
    setLocal("comment-use-syntax", null);
    // Font-Lock wants every submatch to succeed, so also match the empty string.
    const branches = e8.fileAccessibleDirectoryP(String(e8.variable("default-directory"))) ? magitListLocalBranchNames() : undefined;
    setLocal("git-commit--branch-name-regexp", branches ? `((?:${branches.map(jsQuote).join("|")})|)([^']+)` : "()([^']*)");
    e8.addHook("jit-lock-functions", gitCommitFontify, { local: true });
  } catch (e) {
    e8.message(`Error running git-commit-setup-font-lock: ${String(e)}`);
  }
}

// Setup.

const filenameMatches = (): boolean => {
  const file = e8.bufferFileName();
  return file !== undefined && e8.stringMatch(String(e8.variable("git-commit-filename-regexp")), file) !== undefined;
};
function gitCommitSetupFontLockInBuffer(): void {
  if (filenameMatches()) gitCommitSetupFontLock();
}
function gitCommitSetupCheckBuffer(): void {
  if (filenameMatches()) gitCommitSetup();
}
e8.defun("git-commit-setup-font-lock-in-buffer", gitCommitSetupFontLockInBuffer);
e8.defun("git-commit-setup-check-buffer", gitCommitSetupCheckBuffer);

/** The commit HEAD named when each message buffer was set up, to see when git has made the new one, and the repository. */
const previousHead = new PerBuffer<{ head: string | undefined; dir: string }>();

/** Makes the current buffer one to write a commit message in, as git-commit-setup. */
export function gitCommitSetup(): void {
  const cd = truthy(e8.variable("git-commit-cd-to-toplevel")) ? magitToplevel() : undefined;
  // Magit applies the repository's directory-local settings here as if
  // git-commit-mode were the major mode; E8 has no .dir-locals.el yet.
  const major = e8.variable("git-commit-major-mode");
  if (typeof major === "string" && major !== "" && e8.commandExists(major)) e8.call(major as e8.CommandName);
  if (cd) setLocal("default-directory", cd);
  // Below we instead explicitly show a message.
  setLocal("with-editor-show-usage", null);
  if (!truthy(e8.variable("with-editor-mode"))) e8.callWithPrefix(1, withEditorMode);
  addLocalHookName("with-editor-finish-query-functions", "git-commit-finish-query-functions");
  addLocalHookName("with-editor-pre-finish-hook", "git-commit-save-message");
  addLocalHookName("with-editor-pre-cancel-hook", "git-commit-save-message");
  const last = e8.lastCommand();
  if (!["magit-sequencer-continue", "magit-sequencer-skip", "magit-am-continue", "magit-am-skip", "magit-rebase-continue", "magit-rebase-skip"].includes(String(last))) {
    previousHead.set(e8.currentBuffer(), { head: magitRevParse("HEAD"), dir: String(e8.variable("default-directory")) });
  }
  setLocal("with-editor-cancel-message", "git-commit-cancel-message");
  gitCommitSetupFontLock();
  gitCommitPrepareMessageRing();
  if (e8.variable("save-place-mode") !== undefined) setLocal("save-place-mode", null);
  e8.letBind({ "git-commit-mode-hook": null }, () => e8.callWithPrefix(1, gitCommitMode));
  try {
    e8.runHooks("git-commit-setup-hook");
  } catch (e) {
    e8.message(`Error running git-commit-setup-hook: ${String(e)}`);
  }
  e8.setBufferModified(false);
  const format = e8.variable("git-commit-header-line-format");
  if (truthy(format)) setLocal("header-line-format", typeof format === "string" ? substituteCommandKeys(format) : (format ?? null));
  const usage = e8.variable("git-commit-usage-message");
  if (typeof usage === "string") setLocal("with-editor-usage-message", usage);
  e8.message(substituteCommandKeys(String(e8.variable("with-editor-usage-message") ?? "")));
}

/** Runs git-commit-post-finish-hook once HEAD is no longer PREVIOUS, as git-commit-run-post-finish-hook. */
function gitCommitRunPostFinishHook(previous: string | undefined, dir: string): void {
  if (listOf("git-commit-post-finish-hook").length === 0) return;
  const timeout = Number(e8.variable("git-commit-post-finish-hook-timeout") ?? 2);
  const deadline = Date.now() + timeout * 1000;
  e8.letBind({ "default-directory": dir }, () => {
    while (magitRevParse("HEAD") === previous && Date.now() < deadline) e8.acceptProcessOutput(undefined, 0.01);
    if (magitRevParse("HEAD") !== previous) e8.runHooks("git-commit-post-finish-hook");
    else e8.message(`No commit created after ${timeout} second.  Not running git-commit-post-finish-hook.`);
  });
}

// with-editor-post-finish-hook runs once the message's buffer is gone, so
// what it needs of the buffer is taken before.
e8.adviceAdd(
  "with-editor-finish",
  "around",
  (orig: (...args: unknown[]) => unknown, ...args: unknown[]) => {
    const pending = truthy(e8.variable("git-commit-mode")) ? previousHead.get(e8.currentBuffer()) : undefined;
    const result = orig(...args);
    if (pending) gitCommitRunPostFinishHook(pending.head, pending.dir);
    return result;
  },
  { name: "git-commit-post-finish", depth: 0 },
);

e8.defun("git-commit-finish-query-functions", (force: unknown) => e8.runHookWithArgsUntilFailure("git-commit-finish-query-functions", truthy(force as e8.Value)));

/**
 * Checks for violations of certain basic style conventions, as
 * git-commit-check-style-conventions: for each violation asks whether
 * to proceed anyway. Option git-commit-style-convention-checks says
 * which conventions are checked.
 */
export function gitCommitCheckStyleConventions(force: unknown): boolean {
  if (truthy(force as e8.Value)) return true;
  const checks = listOf("git-commit-style-convention-checks");
  if (!truthy(e8.variable("git-commit-need-summary-line"))) {
    // The summary regexp is then "\\(EASTER\\) \\(EGG\\)".
    const at = e8.bufferText().indexOf("EASTER EGG");
    if (at < 0) return true;
    return !checks.includes("overlong-summary-line") || e8.yOrNP("Summary line is too long.  Commit anyway? ");
  }
  const s = gitCommitSummary()!;
  const text = e8.lineText(s.line);
  // Just try; we don't know whether --allow-empty-message was used.
  if (s.max === 0) return true;
  return (
    (!checks.includes("overlong-summary-line") || s.max === text.length || e8.yOrNP("Summary line is too long.  Commit anyway? ")) &&
    (!checks.includes("non-empty-second-line") || !s.secondLine || e8.yOrNP("Second line is not empty.  Commit anyway? "))
  );
}
e8.defun("git-commit-check-style-conventions", gitCommitCheckStyleConventions);
e8.setDefault("git-commit-finish-query-functions", ["git-commit-check-style-conventions"]);

e8.defun("git-commit-cancel-message", () => {
  return `Commit canceled${localHookHas("with-editor-pre-cancel-hook", "git-commit-save-message") ? ".  Message saved to `log-edit-comment-ring'" : ""}`;
});

// The functions of git-commit-setup-hook.

/**
 * Separate initial empty line from initial comment, as
 * git-commit-ensure-comment-gap: if the buffer begins with an empty
 * line followed by a comment, insert an additional newline in between,
 * so that once the users start typing, the input isn't tacked to the
 * comment.
 */
export function gitCommitEnsureCommentGap(): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    if (e8.lookingAt(`\\\`\n${regexpQuote(commentStart())}`)) {
      e8.insert("\n");
      e8.gotoChar(e8.pointMin());
    }
  });
}
e8.defun("git-commit-ensure-comment-gap", gitCommitEnsureCommentGap);

/** Treat ChangeLog entries as unindented paragraphs, as git-commit-setup-changelog-support: as far as E8 has log-edit's filling and paragraph-start. */
e8.defun("git-commit-setup-changelog-support", () => {
  if (e8.fboundp("log-edit-fill-entry")) setLocal("fill-paragraph-function", "log-edit-fill-entry");
  setLocal("fill-indent-according-to-mode", true);
  const start = e8.variable("paragraph-start");
  if (typeof start === "string") setLocal("paragraph-start", `${start}\\|\\*\\|(`);
});

/** Unconditionally turn on Auto Fill mode, filling everywhere but in the summary line, as git-commit-turn-on-auto-fill. */
export function gitCommitTurnOnAutoFill(): void {
  e8.callWithPrefix(1, "auto-fill-mode" as e8.CommandName);
  setLocal("comment-auto-fill-only-comments", null);
  if (truthy(e8.variable("git-commit-need-summary-line"))) setLocal("auto-fill-function", "git-commit-auto-fill-except-summary");
}
e8.defun("git-commit-turn-on-auto-fill", gitCommitTurnOnAutoFill);
// A command, as E8 calls auto-fill-function as one.
e8.defineCommand({
  name: "git-commit-auto-fill-except-summary",
  doc: "Fill as do-auto-fill does, except on the first line, the summary.",
  run: () => {
    if (e8.lineBeginningPosition() !== e8.pointMin()) e8.call("do-auto-fill" as e8.CommandName);
  },
});

/** Turn on Orglink mode if it is available, as git-commit-turn-on-orglink. */
e8.defun("git-commit-turn-on-orglink", () => {
  if (!e8.derivedModeP("org-mode") && e8.fboundp("orglink-mode")) {
    setLocal("orglink-match-anywhere", true);
    e8.callWithPrefix(1, "orglink-mode" as e8.CommandName);
  }
});

/**
 * Unconditionally turn on Flyspell mode, as git-commit-turn-on-flyspell:
 * also check text that is already in the buffer, while avoiding to check
 * most text that Git will strip from the final message, such as the last
 * comment and anything below the cut line ("--- >8 ---").
 */
export function gitCommitTurnOnFlyspell(): void {
  e8.callWithPrefix(1, "flyspell-mode" as e8.CommandName);
  setLocal("flyspell-generic-check-word-predicate", "git-commit-flyspell-verify");
  const c = regexpQuote(commentStart());
  const end = e8.saveExcursion(() => {
    // The "cut line" is defined in "git/wt-status.c".  It appears in the
    // commit message when `commit.verbose' is set to true.
    e8.gotoChar(e8.pointMin());
    e8.gotoChar(e8.reSearchForward(`^${c} -\\{8,\\} >8 -\\{8,\\}$`, { noerror: true }) ?? e8.pointMax());
    const commentRe = `^\\(${c}\\|$\\)`;
    e8.gotoChar(e8.lineBeginningPosition());
    while (e8.point() > e8.pointMin() && e8.lookingAt(commentRe)) forwardLine(-1);
    if (!e8.lookingAt(commentRe)) forwardLine(1);
    return e8.point();
  });
  e8.call("flyspell-region" as e8.CommandName, e8.pointMin(), end);
}
e8.defun("git-commit-turn-on-flyspell", gitCommitTurnOnFlyspell);
e8.defun("git-commit-flyspell-verify", () => e8.charAfter(e8.lineBeginningPosition()) !== commentStart().charAt(0));

/** Fontifies the diff of a verbose commit message as diff-mode does, as git-commit-propertize-diff. */
export function gitCommitPropertizeDiff(): void {
  e8.saveExcursion(() => {
    e8.gotoChar(e8.pointMin());
    if (e8.reSearchForward("^diff --git", { noerror: true }) === undefined) return;
    const beg = e8.lineBeginningPosition();
    const text = e8.bufferSubstringNoProperties(beg, e8.pointMax());
    e8.deleteRegion(beg, e8.pointMax());
    const temp = e8.generateNewBufferName(" *git-commit-diff*");
    e8.getBufferCreate(temp);
    const fontified = e8.withCurrentBuffer(temp, () => {
      e8.insert(text);
      e8.call("diff-mode" as e8.CommandName);
      e8.call("font-lock-ensure" as e8.CommandName);
      return e8.bufferSubstring(e8.pointMin(), e8.pointMax());
    });
    e8.withCurrentBuffer(temp, () => e8.setBufferModified(false));
    e8.call("kill-buffer", temp);
    e8.gotoChar(beg);
    // The faces as font-lock-face, which the message's own highlighting leaves alone.
    let at = 0;
    const chars = Array.from(fontified.string);
    for (const [s, e, props] of fontified.properties) {
      if (s > at) e8.insert(chars.slice(at, s).join(""));
      const piece = chars.slice(s, e).join("");
      e8.insert(props.face !== undefined && props.face !== null ? e8.propertize(piece, { "font-lock-face": props.face }) : piece);
      at = e;
    }
    if (at < chars.length) e8.insert(chars.slice(at).join(""));
  });
}
e8.defun("git-commit-propertize-diff", gitCommitPropertizeDiff);

e8.setDefault(
  "git-commit-setup-hook",
  // bug-reference-mode is among Magit's, and runs once E8 has it.
  ["git-commit-ensure-comment-gap", "git-commit-save-message", "git-commit-setup-changelog-support", "git-commit-turn-on-auto-fill", "git-commit-propertize-diff", "bug-reference-mode"].filter(
    (f) => e8.fboundp(f) || e8.commandExists(f),
  ),
);

// Keymap.

e8.defineKeymap("git-commit-redundant-bindings", null);
for (const [key, command] of [
  ["C-c C-a", "git-commit-ack"],
  ["C-c M-i", "git-commit-suggested"],
  ["C-c C-m", "git-commit-modified"],
  // Emacs reads C-m as RET, E8 as a key of its own.
  ["C-c RET", "git-commit-modified"],
  ["C-c C-o", "git-commit-cc"],
  ["C-c C-p", "git-commit-reported"],
  ["C-c C-r", "git-commit-review"],
  ["C-c C-s", "git-commit-signoff"],
  ["C-c C-t", "git-commit-test"],
] as const)
  e8.defineKey("git-commit-redundant-bindings", key, trailer[command]);

/**
 * Auxiliary minor mode used when editing Git commit messages, as
 * git-commit-mode: it only sets up key bindings. Turned on by
 * git-commit-setup; git-commit-major-mode is the major mode.
 */
export const gitCommitMode = e8.defineMinorMode({
  name: "git-commit-mode",
  lighter: "",
  doc:
    "Auxiliary minor mode used when editing Git commit messages.\nThis mode is only responsible for setting up some key bindings.  Don't use it directly; instead enable `global-git-commit-mode'.  " +
    "Variable `git-commit-major-mode' controls which major-mode is used.",
  bindings: {
    "M-p": commands.prevMessage,
    "M-n": commands.nextMessage,
    "C-c M-p": commands.searchBackward,
    "C-c M-n": commands.searchForward,
    "C-c C-i": gitCommitInsertTrailerMenu,
    // Emacs reads C-i as TAB, E8 as a key of its own.
    "C-c TAB": gitCommitInsertTrailerMenu,
    "C-c M-s": commands.saveMessage,
    "C-c C-d": "magit-diff-while-committing" as e8.CommandName,
    // C-c C-w, magit-pop-revision-stack, is not in E8's Magit yet.
  },
});
e8.setKeymapParent("git-commit-mode-map", "git-commit-redundant-bindings");
// Magit's Commit menu, git-commit-mode-menu, is left out: E8 has no menu bar.

// Elisp Text Mode.

/** Highlights `symbols' and "strings" as git-commit-elisp-text-mode-keywords, where git-commit-mode does not already. */
function elispTextFontify(start: number, end: number): void {
  if (truthy(e8.variable("git-commit-mode"))) return;
  e8.withSilentModifications(() => {
    for (let line = e8.lineOf(start); line <= e8.lineOf(Math.max(start, end - 1)); line++) {
      const text = e8.lineText(line);
      const faces: Face[] = new Array(text.length).fill(undefined);
      elispTextKeywords(text, faces);
      putLineFaces(line, text, faces);
    }
  });
}

export const gitCommitElispTextMode = e8.defineMajorMode({
  name: "git-commit-elisp-text-mode",
  modeName: "ElText",
  parent: "text-mode",
  doc:
    "Major mode for editing commit messages of elisp projects.\nThis is intended for use as `git-commit-major-mode' for projects that expect `symbols' to look like this.  " +
    "I.e., like they look in Elisp doc-strings, including this one.  Unlike in doc-strings, \"strings\" also look different than the other text.",
  setup: () => e8.addHook("jit-lock-functions", elispTextFontify, { local: true }),
});

// Turned on as Magit loads it.
e8.setDefault("global-git-commit-mode", true);
e8.addHook("find-file-hook", gitCommitSetupCheckBuffer);
e8.addHook("after-change-major-mode-hook", gitCommitSetupFontLockInBuffer);
