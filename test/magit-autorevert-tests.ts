// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of magit-autorevert.ts, after magit-autorevert.el:
// magit-auto-revert-mode turns auto-revert-mode on in buffers visiting
// tracked files, and the repository's unmodified buffers are reverted as
// soon as a git command Magit runs changes their files.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { gotoText, read, repo, status, withRepos, write } from "magit-test-helpers";

/** Runs BODY with magit-auto-revert-mode on, as it is outside batch. */
function withAutoRevert(body: () => void): void {
  e8.callWithPrefix(1, "magit-auto-revert-mode" as e8.CommandName);
  try {
    body();
  } finally {
    e8.callWithPrefix(0, "magit-auto-revert-mode" as e8.CommandName);
  }
}
const visit = (dir: string, file: string): string => e8.findFileNoselect(e8.expandFileName(file, dir));

ertDeftest("magit-auto-revert-mode-turns-auto-revert-on-for-tracked-files", () => {
  const dir = repo();
  withRepos([dir], () => {
    const a = visit(dir, "a.txt");
    withAutoRevert(() => {
      // Buffers already visiting files, and those visited after.
      shouldEqual(e8.withCurrentBuffer(a, () => e8.variable("auto-revert-mode")), true);
      const b = visit(dir, "b.txt");
      shouldEqual(e8.withCurrentBuffer(b, () => e8.variable("auto-revert-mode")), true);
      const c = visit(dir, "c.txt");
      should(e8.withCurrentBuffer(c, () => e8.variable("auto-revert-mode")) !== true, "not for an untracked file");
    });
    should(e8.withCurrentBuffer(a, () => e8.variable("auto-revert-mode")) !== true, "off again with the mode");
  });
});

ertDeftest("magit-auto-revert-reverts-buffers-after-git-changes-their-files", () => {
  const dir = repo();
  withRepos([dir], () => {
    withAutoRevert(() => {
      const a = visit(dir, "a.txt");
      const b = visit(dir, "b.txt");
      e8.withCurrentBuffer(b, () => {
        e8.gotoChar(e8.pointMax());
        e8.insert("unsaved\n");
      });
      status(dir);
      gotoText("modified   a.txt");
      // Discarding the change puts a.txt back, and its buffer follows at once.
      e8.letBind({ "magit-save-repository-buffers": false }, () => e8.executeKbdMacro("k y"));
      shouldEqual(read(dir, "a.txt"), "one\ntwo\nthree\n");
      shouldEqual(e8.withCurrentBuffer(a, () => e8.bufferText()), "one\ntwo\nthree\n");
      // A buffer with unsaved changes is left alone.
      write(dir, "b.txt", "changed on disk\n");
      e8.call("magit-refresh" as e8.CommandName);
      shouldEqual(e8.withCurrentBuffer(b, () => e8.bufferText()), "keep\nmore\nunsaved\n");
      e8.withCurrentBuffer(b, () => e8.setBufferModified(false));
    });
  });
});

ertDeftest("magit-auto-revert-leaves-buffers-alone-when-off", () => {
  const dir = repo();
  withRepos([dir], () => {
    const a = visit(dir, "a.txt");
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("k y");
    shouldEqual(read(dir, "a.txt"), "one\ntwo\nthree\n");
    shouldEqual(e8.withCurrentBuffer(a, () => e8.bufferText()), "one\nTWO\nthree\nfour\n");
  });
});
