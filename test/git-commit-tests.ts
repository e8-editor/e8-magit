// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of writing commit messages, after git-commit.el: the faces of a
// message, as Magit gives them, trailers, the message history across
// commits, and the style checks before finishing.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { gitCommitMessageRing } from "git-commit";
import { git, recordBuffer, repo, settle, status, testFile, typed, withRepos, write, type Recording } from "magit-test-helpers";

/** Visits DIR's .git/COMMIT_EDITMSG holding TEXT, as git-commit-setup sees it when git asks for a message. */
function visitMessage(dir: string, text: string): void {
  const file = e8.expandFileName(".git/COMMIT_EDITMSG", dir);
  e8.writeTextFile(file, text);
  e8.call("find-file", file);
}

/** Starts `c c` in DIR's status buffer and waits for the message buffer. */
function startCommit(dir: string): void {
  status(dir);
  e8.executeKbdMacro("c c");
  settle(() => e8.bufferName() === "COMMIT_EDITMSG");
  shouldEqual(e8.bufferName(), "COMMIT_EDITMSG");
}

/** Waits for git to be done with the message: its buffer gone and no process running. */
function settleCommit(): void {
  settle(() => !e8.bufferList().includes("COMMIT_EDITMSG") && !e8.processList().some((p) => e8.processLiveP(p)));
}

/** You, as git-commit-get-ident finds you in the tests' repositories. */
const self = (): string =>
  `${e8.getenv("GIT_AUTHOR_NAME") ?? e8.getenv("GIT_COMMITTER_NAME") ?? "Tester"} <${e8.getenv("GIT_AUTHOR_EMAIL") ?? e8.getenv("GIT_COMMITTER_EMAIL") ?? e8.getenv("EMAIL") ?? "t@example.com"}>`;

const TEMPLATE = "Summary\n\n# Please enter the commit message for your changes.\n#\n";

ertDeftest("git-commit-faces-are-magits", () => {
  const dir = repo();
  withRepos([dir], () => {
    visitMessage(dir, e8.readTextFile(testFile("oracle/git-commit-message.txt")));
    should(e8.variable("git-commit-mode") === true, "git-commit-mode is on");
    should(e8.derivedModeP("text-mode"), "the major mode is git-commit-major-mode's, text-mode");
    e8.call("font-lock-ensure");
    const want: Recording = JSON.parse(e8.readTextFile(testFile("oracle/git-commit-faces.json")));
    const got = recordBuffer();
    shouldEqual(got.text, want.text);
    shouldEqual(got.faces, want.faces);
  });
});

ertDeftest("git-commit-faces-follow-the-summary-as-it-is-typed", () => {
  const dir = repo();
  withRepos([dir], () => {
    visitMessage(dir, "\n# Please enter the commit message for your changes.\n#\n");
    // git-commit-ensure-comment-gap: the message is not typed onto the comment.
    shouldEqual(e8.bufferText(), "\n\n# Please enter the commit message for your changes.\n#\n");
    e8.gotoChar(0);
    e8.executeKbdMacro(typed("A summary"));
    e8.call("font-lock-ensure");
    shouldEqual(e8.getTextProperty(0, "face"), "git-commit-summary");
    e8.executeKbdMacro(`C-n ${typed("x")}`);
    e8.call("font-lock-ensure");
    shouldEqual(e8.getTextProperty(e8.lineStart(1), "face"), "git-commit-nonempty-second-line");
  });
});

ertDeftest("git-commit-trailers-are-inserted-after-the-message", () => {
  const dir = repo();
  withRepos([dir], () => {
    visitMessage(dir, TEMPLATE);
    e8.executeKbdMacro("C-c C-s");
    shouldEqual(e8.bufferText(), `Summary\n\nSigned-off-by: ${self()}\n\n# Please enter the commit message for your changes.\n#\n`);
    // The next goes after the last trailer.
    e8.executeKbdMacro("C-c C-a");
    shouldEqual(e8.bufferText(), `Summary\n\nSigned-off-by: ${self()}\nAcked-by: ${self()}\n\n# Please enter the commit message for your changes.\n#\n`);
    // Someone else's, read: with C-c C-o, and with a prefix argument for those that are yours.
    e8.executeKbdMacro(`C-c C-o ${typed("Some One <so@example.com>")} RET C-u C-c C-r ${typed("Re Viewer <rv@example.com>")} RET`);
    shouldEqual(
      e8.bufferText(),
      `Summary\n\nSigned-off-by: ${self()}\nAcked-by: ${self()}\nCc: Some One <so@example.com>\nReviewed-by: Re Viewer <rv@example.com>\n\n# Please enter the commit message for your changes.\n#\n`,
    );
    // The menu.
    e8.executeKbdMacro("C-c C-i t");
    should(e8.bufferText().includes(`Reviewed-by: Re Viewer <rv@example.com>\nTested-by: ${self()}\n\n#`), e8.bufferText());
    e8.call("font-lock-ensure");
    const at = e8.bufferText().indexOf("Cc:");
    shouldEqual(e8.getTextProperty(at, "face"), "git-commit-trailer-token");
    shouldEqual(e8.getTextProperty(at + 4, "face"), "git-commit-trailer-value");
  });
});

ertDeftest("git-commit-trailers-go-before-the-comments-of-an-empty-message", () => {
  const dir = repo();
  withRepos([dir], () => {
    visitMessage(dir, "\n# Please enter the commit message for your changes.\n#\n");
    e8.executeKbdMacro("C-c C-s");
    shouldEqual(e8.bufferText(), `\n\nSigned-off-by: ${self()}\n\n# Please enter the commit message for your changes.\n#\n`);
  });
});

ertDeftest("git-commit-messages-come-back-with-m-p-and-m-n", () => {
  const dir = repo();
  const old = e8.defaultValue("git-commit-use-local-message-ring");
  // The repository's own ring, so other tests' messages are not in it.
  e8.setDefault("git-commit-use-local-message-ring", true);
  try {
    withRepos([dir], () => {
      startCommit(dir);
      e8.executeKbdMacro(`${typed("Canceled message")} C-c C-k`);
      settleCommit();
      shouldEqual(git(dir, "log", "--format=%s"), "First commit\n");
      should(e8.messages().includes("Commit canceled.  Message saved to `log-edit-comment-ring'"), e8.messages().slice(-5).join("\n"));
      startCommit(dir);
      shouldEqual(gitCommitMessageRing(), ["Canceled message\n"]);
      e8.executeKbdMacro("M-p");
      should(e8.bufferText().startsWith("Canceled message\n\n# Please enter the commit message"), e8.bufferText());
      e8.executeKbdMacro("C-c C-c");
      settle(() => git(dir, "log", "-1", "--format=%s") === "Canceled message\n");
      shouldEqual(git(dir, "log", "-1", "--format=%s"), "Canceled message\n");
      settleCommit();
      // The next commit's message: the one written is saved before going back.
      write(dir, "c.txt", "newer\n");
      git(dir, "add", "c.txt");
      startCommit(dir);
      e8.executeKbdMacro(`${typed("Newer")} M-p`);
      should(e8.bufferText().startsWith("Canceled message\n\n#"), e8.bufferText());
      e8.executeKbdMacro("M-n");
      should(e8.bufferText().startsWith("Newer\n\n#"), e8.bufferText());
      shouldEqual(gitCommitMessageRing(), ["Newer\n", "Canceled message\n"]);
      e8.executeKbdMacro(`C-c M-p ${typed("canc")} RET`);
      should(e8.bufferText().startsWith("Canceled message\n\n#"), e8.bufferText());
      e8.executeKbdMacro("C-c C-k");
      settleCommit();
    });
  } finally {
    e8.setDefault("git-commit-use-local-message-ring", old ?? false);
  }
});

ertDeftest("git-commit-finishing-asks-about-the-style", () => {
  const dir = repo();
  const old = e8.defaultValue("git-commit-style-convention-checks");
  e8.setDefault("git-commit-style-convention-checks", ["non-empty-second-line", "overlong-summary-line"]);
  try {
    withRepos([dir], () => {
      startCommit(dir);
      const long = "A summary that is longer than the sixty-eight characters allowed for it";
      e8.executeKbdMacro(`${typed(long)} RET ${typed("second")}`);
      const text = e8.bufferText();
      // Yes to the long summary, no to the second line: no commit. Had
      // only one been asked, y would have committed, or n been typed.
      e8.executeKbdMacro("C-c C-c y n");
      shouldEqual(e8.bufferName(), "COMMIT_EDITMSG");
      shouldEqual(e8.bufferText(), text);
      shouldEqual(git(dir, "log", "--format=%s"), "First commit\n");
      // With a prefix argument it finishes without asking.
      e8.executeKbdMacro("C-u C-c C-c");
      settle(() => git(dir, "log", "-1", "--format=%B") === `${long}\nsecond\n\n`);
      shouldEqual(git(dir, "log", "-1", "--format=%B"), `${long}\nsecond\n\n`);
      settleCommit();
    });
  } finally {
    e8.setDefault("git-commit-style-convention-checks", old ?? ["non-empty-second-line"]);
  }
});

ertDeftest("git-commit-post-finish-hook-runs-once-the-commit-is-made", () => {
  const dir = repo();
  let ran: string | undefined;
  const hook = () => {
    ran = git(dir, "log", "-1", "--format=%s");
  };
  e8.addHook("git-commit-post-finish-hook", hook);
  try {
    withRepos([dir], () => {
      startCommit(dir);
      e8.executeKbdMacro(`${typed("Hooked")} C-c C-c`);
      settleCommit();
      shouldEqual(ran, "Hooked\n");
    });
  } finally {
    e8.removeHook("git-commit-post-finish-hook", hook);
  }
});
