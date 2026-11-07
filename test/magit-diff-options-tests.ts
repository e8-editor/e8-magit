// SPDX-License-Identifier: GPL-3.0-or-later
//
// The options of magit-diff.el, magit-log.el and magit-mode.el the port
// honours: how files are formatted, tabs drawn and indentation marked in
// diffs, whether a removed line visits the previous blob, diffs kept
// collapsed after the expansion threshold, the summary filled and the
// message washed in revision buffers, a log's files kept on --follow,
// the function a definition is traced with, labels from trailers, and
// whose arguments commands and menus reuse.

import { ertDeftest, should, shouldEqual } from "ert";
import { magitDiffArguments, magitDiffOnRemovedLineP, magitDiffPrefixValue, magitDiffSetupBuffer, magitShowCommitArguments, magitShowCommitRev } from "magit-diff";
import { magitLogGetValue, magitLogSetupBuffer } from "magit-log";
import { git, gotoText, history, repo, status, withRepos, write } from "magit-test-helpers";

e8.require("magit");

/** The lines of the current buffer. */
const lines = (): string[] => e8.bufferText().split("\n");

ertDeftest("magit-format-file-function-formats-each-kind-of-file-line", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.defun("magit-test-format-file", (kind: string, file: string, face: string, st?: string | null) => e8.propertize(`[${kind}] ${st ? `${st} ` : ""}${file}`, { "font-lock-face": face }));
    e8.letBind({ "magit-format-file-function": "magit-test-format-file" }, () => {
      status(dir);
      gotoText("Untracked files");
      e8.executeKbdMacro("TAB");
      should(lines().includes("[list] c.txt"), e8.bufferText());
      should(lines().includes("[diff] modified a.txt"), e8.bufferText());
      magitDiffSetupBuffer(undefined, undefined, ["--stat", "--no-ext-diff"], [], "unstaged");
      should(lines().some((l) => l.startsWith("[stat] a.txt")), e8.bufferText());
    });
  });
});

ertDeftest("magit-diff-tabs-take-the-width-of-the-files-buffer", () => {
  const dir = repo();
  withRepos([dir], () => {
    write(dir, "a.txt", "one\n\tTWO\nthree\n");
    const tabDisplay = (): unknown => {
      gotoText("+\tTWO");
      return e8.getTextProperty(e8.point() + 1, "display");
    };
    const space = (w: number) => [e8.intern("space"), e8.intern(":width"), w];
    status(dir);
    // Without adjusting, the Magit buffer's own tab-width.
    magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff"], [], "unstaged");
    shouldEqual(tabDisplay(), space(Number(e8.variable("tab-width"))));
    e8.withCurrentBuffer(e8.findFileNoselect(e8.expandFileName("a.txt", dir)), () => {
      e8.makeLocalVariable("tab-width");
      e8.setVariable("tab-width", 4);
    });
    e8.letBind({ "magit-diff-adjust-tab-width": true }, () => {
      magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff"], [], "unstaged");
      e8.call("magit-refresh" as e8.CommandName);
      shouldEqual(tabDisplay(), space(4));
    });
  });
});

ertDeftest("magit-diff-highlight-indentation-marks-the-wrong-indentation", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    write(dir, "a.txt", "one\n\tTWO\n        three\n");
    const old = e8.defaultValue("magit-diff-highlight-indentation") ?? null;
    const marked = (): string[] =>
      e8
        .overlaysIn(e8.pointMin(), e8.pointMax())
        .filter((o) => e8.overlayGet(o, "face") === "magit-diff-whitespace-warning")
        .map((o) => JSON.stringify(e8.bufferSubstringNoProperties(e8.overlayStart(o)!, e8.overlayEnd(o)!)));
    try {
      e8.setDefault("magit-diff-highlight-indentation", [[".", "tabs"]]);
      magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff"], [], "unstaged");
      shouldEqual(marked(), [JSON.stringify("\t")]);
      e8.call("kill-buffer", e8.bufferName());
      e8.setDefault("magit-diff-highlight-indentation", [[".", 4]]);
      magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff"], [], "unstaged");
      shouldEqual(marked(), [JSON.stringify("        ")]);
    } finally {
      e8.setDefault("magit-diff-highlight-indentation", old);
    }
  });
});

ertDeftest("magit-diff-visit-previous-blob-says-whether-a-removed-line-goes-back", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff"], [], "unstaged");
    gotoText("-two");
    should(magitDiffOnRemovedLineP());
    e8.letBind({ "magit-diff-visit-previous-blob": false }, () => should(!magitDiffOnRemovedLineP()));
    gotoText("+TWO");
    should(!magitDiffOnRemovedLineP());
  });
});

ertDeftest("magit-diff-expansion-threshold-keeps-late-diffs-collapsed", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    const old = e8.defaultValue("magit--refresh-start-time") ?? null;
    try {
      e8.setDefault("magit--refresh-start-time", Date.now() / 1000);
      e8.letBind({ "magit-diff-expansion-threshold": -1 }, () => magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff"], [], "unstaged"));
      should(!e8.bufferText().split("\n").some((l) => l.startsWith("+")) || e8.invisibleP(e8.pointMin() + e8.bufferText().indexOf("+four")), "the hunks are hidden");
    } finally {
      e8.setDefault("magit--refresh-start-time", old);
    }
  });
});

ertDeftest("magit-revision-buffers-fill-the-summary-and-wash-the-message", () => {
  const dir = history();
  withRepos([dir], () => {
    write(dir, "four.txt", "Four");
    git(dir, "add", "four.txt");
    git(dir, "commit", "-q", "-m", "squash! a summary line [that] is much too long to read\n\nThe body [stays].");
    status(dir);
    e8.letBind({ "magit-revision-fill-summary-line": 20 }, () => magitShowCommitRev("HEAD"));
    should(e8.bufferText().includes("squash! a summary\nline [that] is much\ntoo long to read\n"), e8.bufferText());
    gotoText("squash!");
    shouldEqual(e8.getTextProperty(e8.point(), "font-lock-face"), ["magit-keyword-squash", "magit-diff-revision-summary"]);
    gotoText("[stays]");
    shouldEqual(e8.getTextProperty(e8.point(), "font-lock-face"), "magit-keyword");
    // The hook's functions run narrowed to the message, from its start.
    e8.defun("magit-test-wash", () => e8.putTextProperty(e8.pointMin(), e8.pointMax(), "magit-test-washed", e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMin() + 7)));
    e8.letBind({ "magit-revision-wash-message-hook": ["magit-test-wash"] }, () => e8.call("magit-refresh" as e8.CommandName));
    gotoText("The body");
    shouldEqual(e8.getTextProperty(e8.point(), "magit-test-washed"), "squash!");
    shouldEqual(e8.getTextProperty(e8.point() + 9, "font-lock-face"), undefined);
  });
});

ertDeftest("magit-revision-filter-files-on-follow-keeps-the-logs-files", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    magitLogSetupBuffer(["main"], ["-n256", "--follow"], ["two.txt"]);
    shouldEqual(magitShowCommitArguments()[1], []);
    e8.letBind({ "magit-revision-filter-files-on-follow": true }, () => shouldEqual(magitShowCommitArguments()[1], ["two.txt"]));
    magitLogSetupBuffer(["main"], ["-n256"], ["two.txt"]);
    shouldEqual(magitShowCommitArguments()[1], ["two.txt"]);
  });
});

ertDeftest("magit-log-trace-definition-function-names-the-function", () => {
  const dir = history();
  withRepos([dir], () => {
    write(dir, "f.c", "int main(void)\n{\n  return 0;\n}\n");
    git(dir, "add", "f.c");
    git(dir, "commit", "-q", "-m", "Main");
    e8.call("find-file", e8.expandFileName("f.c", dir));
    e8.defun("magit-test-which-function", () => "main");
    e8.letBind({ "magit-log-trace-definition-function": "magit-test-which-function" }, () => e8.call("magit-log-trace-definition" as e8.DefinedCommand));
    shouldEqual(e8.variable("major-mode"), "magit-log-mode");
    should((e8.variable("magit-buffer-log-args") as string[]).includes("-L:main:f.c"), JSON.stringify(e8.variable("magit-buffer-log-args")));
  });
});

ertDeftest("magit-log-trailer-labels-label-commits-from-their-trailers", () => {
  const dir = history();
  withRepos([dir], () => {
    write(dir, "four.txt", "Four");
    git(dir, "add", "four.txt");
    git(dir, "commit", "-q", "-m", "Four\n\nFixes: #12\nSigned-off-by: T <t@example.com>");
    status(dir);
    e8.defun("magit-test-trailer-labels", (trailers: string[][]) => trailers.map(([k, v]) => `${k}=${v}`).join(";"));
    e8.letBind({ "magit-log-trailer-labels": ["magit-test-trailer-labels", "key=Fixes"] }, () => magitLogSetupBuffer(["main"], ["-n256"], []));
    should(lines().some((l) => / Fixes=#12 Four$/.test(l)), e8.bufferText());
    should(lines().some((l) => / Three$/.test(l) && !l.includes("=")), e8.bufferText());
  });
});

ertDeftest("magit-use-buffer-arguments-reuse-a-buffers-arguments", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    const statusBuffer = e8.bufferName();
    const diff = magitDiffSetupBuffer(undefined, undefined, ["--no-ext-diff", "-w"], [], "unstaged");
    const log = magitLogSetupBuffer(["main"], ["-n10", "--decorate"], []);
    e8.call("switch-to-buffer", statusBuffer);
    e8.call("delete-other-windows");
    e8.call("split-window-below");
    e8.call("switch-to-buffer", diff);
    e8.call("other-window");
    // A diff buffer shown in the frame lends its arguments, as selected says; a log buffer not shown does not.
    shouldEqual(magitDiffArguments()[0], ["--no-ext-diff", "-w"]);
    shouldEqual(magitLogGetValue("magit-log-mode", "direct")[0], ["--graph", "-n256", "--decorate"]);
    shouldEqual(magitLogGetValue("magit-log-mode", "always")[0], ["-n10", "--decorate"]);
    e8.letBind({ "magit-direct-use-buffer-arguments": "never" }, () => shouldEqual(magitDiffArguments()[0], ["--stat", "--no-ext-diff"]));
    e8.letBind({ "magit-prefix-use-buffer-arguments": "current" }, () => shouldEqual(magitDiffPrefixValue(), ["--stat", "--no-ext-diff"]));
    shouldEqual(magitDiffPrefixValue(), ["--no-ext-diff", "-w"]);
    void log;
  });
});
