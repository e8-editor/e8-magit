// SPDX-License-Identifier: GPL-3.0-or-later
//
// What e8-magit's tests share: repositories made for a test, running
// git in them, showing their status, and waiting for git to finish.

import { should } from "ert";

// Repositories.

/** Runs git in DIR and gives its output, or "" if it fails, as its error goes to the output too. */
export function git(dir: string, ...args: string[]): string {
  const r = e8.callProcess(["git", ...args], { directory: dir });
  return r.exit === 0 ? r.output : "";
}

/** A new empty directory, its true name ending in a slash, as git rev-parse --show-toplevel names it. */
export function tempDir(): string {
  return e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-test", { dir: true })));
}

export const write = (dir: string, file: string, text: string): void => e8.writeTextFile(e8.expandFileName(file, dir), text);
export const read = (dir: string, file: string): string => e8.readTextFile(e8.expandFileName(file, dir));

/** Makes DIR a repository with a committer, its branch main. */
export function init(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
}

/**
 * The repository Emacs's Magit was shown: one commit, a change to a.txt
 * unstaged, one to b.txt staged, and c.txt untracked.
 */
export function repo(): string {
  const dir = tempDir();
  init(dir);
  write(dir, "a.txt", "one\ntwo\nthree\n");
  write(dir, "b.txt", "keep\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "First commit");
  write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
  write(dir, "c.txt", "new\n");
  write(dir, "b.txt", "keep\nmore\n");
  git(dir, "add", "b.txt");
  return dir;
}

/** A repository of three commits, each adding a file of its own. */
export function history(): string {
  const dir = tempDir();
  init(dir);
  for (const [file, msg] of [["one.txt", "One"], ["two.txt", "Two"], ["three.txt", "Three"]]) {
    write(dir, file, msg);
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", msg);
  }
  return dir;
}

/** A bare repository, for pushing to. */
export function bare(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

/** Shows DIR's status, as M-x magit-status there does. */
export function status(dir: string): void {
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", "*magit-test*");
  e8.setVariable("default-directory", dir);
  e8.call("magit-status" as e8.DefinedCommand);
}

/**
 * Runs BODY with the repositories DIRS made for it, then kills the buffers
 * left in them and deletes them.
 */
export function withRepos(dirs: string[], body: () => void): void {
  try {
    body();
  } finally {
    for (const b of e8.bufferList()) {
      if (b.startsWith(" *Minibuf")) continue;
      const dd = e8.withCurrentBuffer(b, () => e8.bufferFileName() ?? e8.variable("default-directory"));
      if (b === "*magit-test*" || (typeof dd === "string" && dirs.some((d) => e8.fileTruename(dd).startsWith(d.replace(/\/$/, ""))))) {
        e8.withCurrentBuffer(b, () => e8.setBufferModified(false));
        e8.call("kill-buffer", b);
      }
    }
    for (const d of dirs) e8.deleteDirectory(d, { recursive: true });
  }
}

/** Waits for DONE, as a push, pull, commit or rebase Magit runs without waiting ends, for up to twenty seconds. */
export function settle(done: () => boolean): void {
  for (let i = 0; i < 400 && !done(); i++) e8.acceptProcessOutput(undefined, 0.05);
}

/** The status buffer's text as it shows, hidden sections left out, and point's line counting from 1. */
export function visible(): [string, number] {
  const hidden = e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "invisible") === true);
  let out = "";
  for (let p = e8.pointMin(); p < e8.pointMax(); p++) {
    if (!hidden.some((o) => (e8.overlayStart(o) ?? 0) <= p && p < (e8.overlayEnd(o) ?? 0))) out += e8.charAfter(p);
  }
  return [out, e8.lineOf(e8.point()) + 1];
}

/** Moves point to where TEXT starts in the buffer. */
export function gotoText(text: string): void {
  const at = e8.bufferText().indexOf(text);
  should(at >= 0, `the buffer has ${JSON.stringify(text)}`);
  e8.gotoChar(e8.pointMin() + at);
}

/** The keys that type TEXT. */
export const typed = (text: string): string => Array.from(text, (c) => (c === " " ? "SPC" : c)).join(" ");

/** The lines of a diff that add or remove, headers included. */
export const changes = (diff: string): string[] => diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));

