// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of files and blobs, after magit-files.el: visiting a file at a
// revision and in the index, stepping through a blob's revisions, and
// the commands acting on files.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitBlobAncestor, magitBlobSuccessor, magitFindFileNoselect } from "magit-files";
import { git, history, init, read, settle, status, tempDir, typed, withRepos, write } from "magit-test-helpers";

/** A repository whose a.txt is one, then two, then three. */
function versions(): string {
  const dir = tempDir();
  init(dir);
  for (const v of ["one", "two", "three"]) {
    write(dir, "a.txt", `${v}\n`);
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", `A ${v}`);
  }
  return dir;
}
const hash = (dir: string, rev: string): string => git(dir, "rev-parse", "--short", rev).trim();

ertDeftest("magit-find-file-shows-a-file-at-a-revision", () => {
  const dir = versions();
  withRepos([dir], () => {
    status(dir);
    const first = hash(dir, "HEAD~2");
    e8.executeKbdMacro(`M-x ${typed("magit-find-file")} RET ${typed(first)} RET ${typed("a.txt")} RET`);
    shouldEqual(e8.bufferName(), `a.txt.~${first}~`);
    shouldEqual(e8.bufferText(), "one\n");
    should(e8.variable("buffer-read-only") === true, "a blob is read-only");
    should(e8.variable("magit-blob-mode") === true, "magit-blob-mode is on");
    // n goes to the next revision's blob, p back.
    e8.executeKbdMacro("n");
    shouldEqual(e8.bufferText(), "two\n");
    e8.executeKbdMacro("p");
    shouldEqual(e8.bufferText(), "one\n");
    let error = "";
    try {
      e8.executeKbdMacro("p");
    } catch (e) {
      error = String(e);
    }
    should(error.includes("You have reached the beginning of time"), error);
  });
});

ertDeftest("magit-blob-ancestors-and-successors-include-the-index-and-worktree", () => {
  const dir = versions();
  withRepos([dir], () => {
    status(dir);
    write(dir, "a.txt", "four\n");
    git(dir, "add", "a.txt");
    const head = hash(dir, "HEAD");
    shouldEqual(magitBlobAncestor("{worktree}", "a.txt"), ["{index}", "a.txt"]);
    shouldEqual(magitBlobAncestor("{index}", "a.txt"), [head, "a.txt"]);
    shouldEqual(magitBlobAncestor(head, "a.txt"), [hash(dir, "HEAD~"), "a.txt"]);
    shouldEqual(magitBlobSuccessor(head, "a.txt"), ["{index}", "a.txt"]);
    shouldEqual(magitBlobSuccessor(hash(dir, "HEAD~"), "a.txt"), [head, "a.txt"]);
    shouldEqual(magitBlobSuccessor("{index}", "a.txt"), ["{worktree}", "a.txt"]);
  });
});

ertDeftest("magit-update-index-writes-the-buffer-into-the-index", () => {
  const dir = versions();
  withRepos([dir], () => {
    status(dir);
    const buf = magitFindFileNoselect("{index}", "a.txt");
    e8.call("switch-to-buffer", buf);
    shouldEqual(e8.bufferText(), "three\n");
    e8.letBind({ "inhibit-read-only": true }, () => {
      e8.gotoChar(e8.pointMax());
      e8.insert("staged only\n");
    });
    e8.executeKbdMacro(`M-x ${typed("magit-update-index")} RET y`);
    shouldEqual(git(dir, "show", ":a.txt"), "three\nstaged only\n");
    shouldEqual(read(dir, "a.txt"), "three\n");
  });
});

ertDeftest("magit-file-commands-untrack-rename-delete-and-checkout", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-file-untrack")} RET ${typed("one.txt")} RET`);
    shouldEqual(git(dir, "status", "--porcelain"), "D  one.txt\n?? one.txt\n");
    git(dir, "reset", "-q", "--hard");
    e8.executeKbdMacro(`M-x ${typed("magit-file-rename")} RET ${typed("two.txt")} RET C-a C-k ${typed(`${dir}deux.txt`)} RET`);
    shouldEqual(git(dir, "status", "--porcelain"), "R  two.txt -> deux.txt\n");
    git(dir, "reset", "-q", "--hard");
    e8.executeKbdMacro(`M-x ${typed("magit-file-delete")} RET ${typed("three.txt")} RET`);
    shouldEqual(git(dir, "status", "--porcelain"), "D  three.txt\n");
    git(dir, "reset", "-q", "--hard");
    write(dir, "one.txt", "changed");
    e8.executeKbdMacro(`M-x ${typed("magit-file-checkout")} RET ${typed("HEAD")} RET ${typed("one.txt")} RET`);
    settle(() => read(dir, "one.txt") === "One");
    shouldEqual(read(dir, "one.txt"), "One");
  });
});

ertDeftest("magit-file-stage-and-unstage-act-on-the-visited-file", () => {
  const dir = history();
  withRepos([dir], () => {
    write(dir, "one.txt", "changed");
    e8.call("switch-to-buffer", e8.findFileNoselect(`${dir}one.txt`));
    e8.call("magit-file-stage" as e8.CommandName);
    shouldEqual(git(dir, "status", "--porcelain"), "M  one.txt\n");
    e8.call("magit-file-unstage" as e8.CommandName);
    shouldEqual(git(dir, "status", "--porcelain"), " M one.txt\n");
    e8.setBufferModified(false);
  });
});

ertDeftest("magit-file-dispatch-shows-the-visited-files-actions", () => {
  const dir = history();
  withRepos([dir], () => {
    e8.call("switch-to-buffer", e8.findFileNoselect(`${dir}one.txt`));
    e8.executeKbdMacro("C-c M-g");
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    should(menu.startsWith("File actions"), menu);
    should(menu.includes(", r Rename") && menu.includes("p Prev blob"), menu);
    e8.executeKbdMacro("C-g");
  });
});
