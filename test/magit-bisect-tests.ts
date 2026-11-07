// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of bisecting, after magit-bisect.el: starting, marking commits
// good and bad until git names the first bad one, running a script, and
// resetting.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitBisectTerms } from "magit-bisect";
import { git, history, settle, status, typed, withRepos } from "magit-test-helpers";

const bisecting = (dir: string): boolean => e8.fileExistsP(e8.expandFileName(".git/BISECT_START", dir));

ertDeftest("magit-bisect-finds-the-first-bad-commit", () => {
  const dir = history();
  withRepos([dir], () => {
    const [three, two, one] = git(dir, "log", "--format=%h").trim().split("\n");
    status(dir);
    e8.executeKbdMacro(`B B ${typed(three)} RET ${typed(one)} RET`);
    settle(() => bisecting(dir) && git(dir, "rev-parse", "--short", "HEAD").trim() === two);
    should(bisecting(dir), "bisecting");
    shouldEqual(magitBisectTerms(), ["bad", "good"]);
    // Two is the only commit left to test; marking it bad names it.
    e8.executeKbdMacro("B B");
    settle(() => e8.readTextFile(e8.expandFileName(".git/BISECT_CMD_OUTPUT", dir)).includes("is the first bad commit"));
    should(e8.readTextFile(e8.expandFileName(".git/BISECT_CMD_OUTPUT", dir)).includes(`${two}`), "two is the first bad commit");
    e8.executeKbdMacro("B r y");
    should(!bisecting(dir), "the bisect is reset");
    should(!e8.fileExistsP(e8.expandFileName(".git/BISECT_CMD_OUTPUT", dir)), "its output is deleted");
  });
});

ertDeftest("magit-bisect-run-starts-and-runs-a-script", () => {
  const dir = history();
  withRepos([dir], () => {
    const [three, two, one] = git(dir, "log", "--format=%h").trim().split("\n");
    status(dir);
    // two.txt came with Two: the script fails once it is there.
    e8.executeKbdMacro(`B s ${typed(three)} RET ${typed(one)} RET ${typed("test ! -e two.txt")} RET`);
    const out = () => (e8.fileExistsP(e8.expandFileName(".git/BISECT_CMD_OUTPUT", dir)) ? e8.readTextFile(e8.expandFileName(".git/BISECT_CMD_OUTPUT", dir)) : "");
    settle(() => out().includes("is the first bad commit"));
    should(out().includes(two), out());
  });
});

ertDeftest("magit-bisect-commands-need-a-bisect", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    let error = "";
    try {
      e8.call("magit-bisect-skip" as e8.CommandName);
    } catch (e) {
      error = String(e);
    }
    should(error.includes("Not bisecting"), error);
  });
});
