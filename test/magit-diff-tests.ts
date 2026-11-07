// SPDX-License-Identifier: GPL-3.0-or-later
//
// The diff layer's tests (magit-diff.ts), for what the oracle does not
// record: refining a hunk word by word, visiting the line a hunk shows in
// the work tree or a blob, and the diff type of each kind of section.

import { ertDeftest, should, shouldEqual } from "ert";
import { magitDiffType, magitDiffWashDiffs } from "magit-diff";
import { currentSection, insertRoot } from "magit-section";

e8.require("magit");

/** Runs BODY in fixture NAME's repository, then deletes it and the buffers left in it. */
function inFixture(name: string, body: (repo: string) => void): void {
  const dirs = (e8.variable("load-path") as string[]) ?? [];
  const script = dirs.map((d) => e8.expandFileName("test/fixtures.sh", d)).find((f) => e8.fileExistsP(f))!;
  const dir = e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-diff", { dir: true })));
  should(e8.callProcess(["sh", script, name, dir]).exit === 0);
  const repo = `${dir}repo/`;
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", "*magit-diff-test*");
  e8.setVariable("default-directory", repo);
  try {
    body(repo);
  } finally {
    for (const b of e8.bufferList()) {
      const dd = e8.withCurrentBuffer(b, () => e8.variable("default-directory"));
      if (typeof dd === "string" && dd.startsWith(dir) && !b.startsWith(" *Minibuf")) {
        e8.withCurrentBuffer(b, () => e8.setBufferModified(false));
        e8.call("kill-buffer", b);
      }
    }
    e8.deleteDirectory(dir, { recursive: true });
  }
}

/** Runs COMMAND with M-x, then the keys of ANSWER if given, as typed. */
const mx = (command: string, answer?: string): void =>
  e8.executeKbdMacro(`M-x ${Array.from(command).join(" ")} RET${answer !== undefined ? ` ${Array.from(answer).join(" ")} RET` : ""}`);

/** Moves point to TEXT. */
function gotoText(text: string): void {
  const at = e8.bufferText().indexOf(text);
  should(at >= 0, `the buffer has ${JSON.stringify(text)}`);
  e8.gotoChar(e8.pointMin() + at);
}

ertDeftest("magit-diff-refining-marks-the-words-that-changed", () => {
  inFixture("basic", () => {
    e8.letBind({ "magit-diff-refine-hunk": "all" }, () => mx("magit-diff-unstaged"));
    const fine = e8
      .overlaysIn(e8.pointMin(), e8.pointMax())
      .filter((o) => e8.overlayGet(o, "diff-mode") === "fine")
      .map((o) => [e8.bufferSubstringNoProperties(e8.overlayStart(o)!, e8.overlayEnd(o)!), e8.overlayGet(o, "face")]);
    shouldEqual(fine, [
      ["two", "magit-diff-refine-removed"],
      ["TWO", "magit-diff-refine-added"],
    ]);
  });
});

ertDeftest("magit-diff-visiting-a-hunk-goes-to-its-line", () => {
  inFixture("basic", (repo) => {
    mx("magit-diff-unstaged");
    gotoText("+four");
    e8.executeKbdMacro("RET");
    shouldEqual([e8.bufferFileName(), e8.lineOf(e8.point()) + 1], [`${repo}a.txt`, 4]);
  });
  inFixture("history", () => {
    mx("magit-show-commit", "HEAD~");
    gotoText("+Two");
    e8.executeKbdMacro("RET");
    // A committed change visits the blob it is in.
    shouldEqual([e8.bufferName(), e8.bufferText(), e8.variable("magit-buffer-refname")], ["Two.txt.~HEAD~~", "Two\n", "HEAD~"]);
  });
});

ertDeftest("magit-diff-the-type-of-each-kind-of-section", () => {
  inFixture("basic", () => {
    e8.call("magit-status" as e8.DefinedCommand);
    gotoText("Unstaged changes");
    shouldEqual(magitDiffType(), "unstaged");
    gotoText("Staged changes");
    shouldEqual(magitDiffType(), "staged");
    e8.executeKbdMacro("n");
    shouldEqual([currentSection()?.type, magitDiffType()], ["file", "staged"]);
    mx("magit-diff-staged");
    shouldEqual(magitDiffType(), "staged");
    mx("magit-show-commit", "HEAD");
    shouldEqual(magitDiffType(), "committed");
  });
});

ertDeftest("magit-diff-washing-a-combined-diff-and-a-binary-file", () => {
  e8.call("switch-to-buffer", "*magit-wash-test*");
  const out = [
    "diff --cc a.txt",
    "index 1,2..3",
    "--- a.txt",
    "+++ a.txt",
    "@@@ -1,1 -1,1 +1,1 @@@",
    "- one",
    " -uno",
    "++ein",
    "diff --git bin.dat bin.dat",
    "index 1..2 100644",
    "Binary files bin.dat and bin.dat differ",
    "",
  ].join("\n");
  e8.letBind({ "inhibit-read-only": true }, () => insertRoot("test", () => magitDiffWashDiffs(out, [])));
  shouldEqual(e8.bufferText(), "unmerged   a.txt\n@@@ -1,1 -1,1 +1,1 @@@\n- one\n -uno\n++ein\nmodified   bin.dat (binary)\n\n");
  e8.call("kill-buffer", "*magit-wash-test*");
});
