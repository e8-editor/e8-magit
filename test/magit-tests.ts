// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit's tests, with ERT: the status buffer shows a repository as Magit
// 4.4 shows it in Emacs 30, its sections open and close as there, its menus
// are laid out as Magit's (test/menus.json, recorded from Emacs by
// test/record.el), and staging, unstaging, discarding, committing,
// branching, stashing, pushing and rebasing change the repository. Each
// test makes a git repository of its own in a temporary directory.
// `make test` runs them in e8 --batch, as CI does.

import { ertDeftest, should, shouldEqual } from "ert";
import { git, tempDir, write, read, init, repo, history, bare, status, withRepos, settle, visible, gotoText, typed, changes } from "magit-test-helpers";
import { magitGitVersionGe } from "magit-git";
import * as margins from "magit-margin";
import * as transient from "magit-transient";
import { magitListReleases, versionToList } from "magit-tag";
import { magitCloneInternal, magitCloneNameToUrl, magitCloneUrlToName } from "magit-clone";

// Loading magit runs no git: required here, outside a repository and with
// no git to run, as at startup anywhere. The test below checks what happened.
const loading = ((): { error?: string; messages: string[] } => {
  e8.setVariable("magit-git-executable", "no-such-git");
  const before = e8.messages().length;
  let error: string | undefined;
  try {
    e8.require("magit");
  } catch (e) {
    error = String(e);
  }
  const messages = e8.messages().slice(before);
  e8.setVariable("magit-git-executable", "git");
  return { error, messages };
})();

ertDeftest("magit-loading-runs-no-git", () => {
  shouldEqual(loading, { error: undefined, messages: [] });
});

const START = `Head:     main First commit

Untracked files (1)
Unstaged changes (1)
modified   a.txt

Staged changes (1)
modified   b.txt

Recent commits
`;

ertDeftest("magit-the-status-buffer-shows-what-magit-shows", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    shouldEqual(e8.bufferName(), `magit: ${e8.fileNameNondirectory(dir.replace(/\/$/, ""))}`);
    shouldEqual(visible(), [START, 3]);
    // As Emacs's Magit, key by key: TAB, n, TAB, n, n, TAB.
    e8.executeKbdMacro("TAB");
    const untracked = START.replace("Untracked files (1)\n", "Untracked files (1)\nc.txt\n\n");
    shouldEqual(visible(), [untracked, 3]);
    e8.executeKbdMacro("n");
    shouldEqual(visible(), [untracked, 4]);
    e8.executeKbdMacro("TAB");
    shouldEqual(visible(), [untracked, 4]);
    e8.executeKbdMacro("n");
    shouldEqual(visible()[1], 6);
    e8.executeKbdMacro("n");
    shouldEqual(visible()[1], 7);
    e8.executeKbdMacro("TAB");
    const expanded = untracked.replace("modified   a.txt\n", "modified   a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four\n");
    shouldEqual(visible(), [expanded, 7]);
  });
});

ertDeftest("magit-is-magit-status", () => {
  const dir = repo();
  withRepos([dir], () => {
    should(e8.commandNames().includes("magit"));
    e8.call("delete-other-windows");
    e8.call("switch-to-buffer", "*magit-test*");
    e8.setVariable("default-directory", dir);
    e8.call("magit" as e8.DefinedCommand);
    shouldEqual(e8.bufferName(), `magit: ${e8.fileNameNondirectory(dir.replace(/\/$/, ""))}`);
    shouldEqual(visible(), [START, 3]);
  });
});

ertDeftest("magit-staging-and-unstaging-files-and-hunks", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // s on the untracked file stages it.
    e8.executeKbdMacro("TAB n s");
    should(git(dir, "diff", "--cached", "--name-only").includes("c.txt"), "c.txt is staged");
    should(visible()[0].includes("Staged changes (2)"), "the status shows it staged");
    // s on a hunk stages just it.
    gotoText("modified   a.txt");
    e8.executeKbdMacro("TAB n s");
    shouldEqual(git(dir, "diff", "--name-only"), "");
    should(git(dir, "diff", "--cached").includes("+TWO"), "the hunk is staged");
    // u on the staged changes heading unstages them all.
    gotoText("Staged changes");
    e8.executeKbdMacro("u");
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "");
  });
});

ertDeftest("magit-staging-the-lines-of-a-region", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // Into a.txt's hunk: "-two" and "+TWO" are its 2nd and 3rd lines, "+four" its 5th.
    gotoText("modified   a.txt");
    e8.executeKbdMacro("TAB n");
    gotoText("-two");
    e8.setMark(e8.point());
    gotoText("+TWO");
    e8.gotoChar(e8.point() + 4);
    e8.activateMark();
    e8.executeKbdMacro("s");
    // Only TWO staged, four left unstaged.
    shouldEqual(changes(git(dir, "diff", "--cached", "--", "a.txt")), ["--- a/a.txt", "+++ b/a.txt", "-two", "+TWO"]);
    shouldEqual(changes(git(dir, "diff", "--", "a.txt")), ["--- a/a.txt", "+++ b/a.txt", "+four"]);
  });
});

ertDeftest("magit-committing-writes-the-message-in-a-buffer", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro("c c");
    // git writes the template and waits for its editor, E8.
    settle(() => e8.bufferName() === "COMMIT_EDITMSG");
    shouldEqual(e8.bufferName(), "COMMIT_EDITMSG");
    const template = e8.bufferText();
    // git-commit-ensure-comment-gap puts an empty line before the comments.
    should(template.startsWith("\n\n# Please enter the commit message for your changes."), template);
    should(template.includes("#\tmodified:   b.txt"), template);
    e8.executeKbdMacro(`${typed("More b")} C-c C-c`);
    settle(() => git(dir, "log", "-1", "--format=%s") === "More b\n");
    shouldEqual(git(dir, "log", "-1", "--format=%s"), "More b\n");
    settle(() => !visible()[0].includes("Staged changes"));
    should(e8.bufferName().startsWith("magit: "), "back in the status buffer");
    should(!visible()[0].includes("Staged changes"), "nothing is staged");
  });
});

ertDeftest("magit-discarding-asks-and-puts-the-file-back", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    gotoText("modified   a.txt");
    e8.executeKbdMacro("k y");
    shouldEqual(read(dir, "a.txt"), "one\ntwo\nthree\n");
  });
});

ertDeftest("magit-the-log-lists-the-commits", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // l l, but the log menu is too tall to show in batch's 24-line frame:
    // its command, with the menu's default arguments.
    e8.call("magit-log-current" as e8.DefinedCommand);
    const log = visible()[0];
    should(log.includes(" * main First commit"), log);
    // The author and age are in the right margin, as Magit's log shows them.
    const margins = e8
      .overlaysIn(e8.pointMin(), e8.pointMax())
      .map((o) => e8.overlayGet(o, "before-string"))
      .filter((b): b is e8.PropertizedString => b instanceof e8.PropertizedString)
      .map((b) => JSON.stringify(b.properties));
    should(margins.some((m) => m.includes("Tester")), JSON.stringify(margins));
    // magit-log-margin-width: the author 18 and a space, two digits, a space and the longest unit, "minutes", and a space.
    shouldEqual(e8.variable("right-margin-width"), 30);
    e8.executeKbdMacro("RET");
    const rev = visible()[0];
    should(rev.includes("Author:     Tester <t@example.com>") && rev.includes("new file   a.txt"), rev);
  });
});

ertDeftest("magit-the-upstream-stashes-and-unpushed-commits-show-as-in-magit", () => {
  const origin = bare();
  const dir = tempDir();
  withRepos([origin, dir], () => {
    git(dir, "clone", "-q", origin, ".");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "Tester");
    git(dir, "config", "commit.gpgsign", "false");
    write(dir, "a.txt", "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "Initial");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "branch", "-q", "--set-upstream-to=origin/main");
    write(dir, "a.txt", "one\ntwo\n");
    git(dir, "commit", "-qam", "Second");
    write(dir, "a.txt", "one\ntwo\nstashed\n");
    git(dir, "stash", "-q");
    write(dir, "a.txt", "x\n");
    const hash = git(dir, "rev-parse", "--short", "HEAD").trim();
    status(dir);
    shouldEqual(visible(), [
      `Head:     main Second\nMerge:    origin/main Initial\n\nUnstaged changes (1)\nmodified   a.txt\n\nStashes (1)\nUnmerged into origin/main (1)\n${hash} main Second\n\n`,
      4,
    ]);
  });
});

/** The menus Magit 4.4 shows for each prefix key in the status buffer, as test/record.el recorded them from Emacs. */
function recordedMenus(): { [key: string]: string } {
  const dirs = (e8.variable("load-path") as string[]) ?? [];
  const file = dirs.map((d) => e8.expandFileName("test/menus.json", d)).find((f) => e8.fileExistsP(f));
  should(file !== undefined, "test/menus.json is found along load-path");
  return JSON.parse(e8.readTextFile(file!));
}

ertDeftest("magit-the-menus-show-as-magits-do", () => {
  const recorded = recordedMenus();
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    const failures: string[] = [];
    for (const [key, want] of Object.entries(recorded)) {
      // Batch's frame is 24 lines, too few for the tallest menus' windows
      // (l, d and h): transient lays out the menu and then cannot show it,
      // and is not left active. The menu's text is compared all the same.
      let tooTall = false;
      try {
        e8.executeKbdMacro(key);
      } catch (e) {
        if (!String(e).includes("Size of window too small")) throw e;
        tooTall = true;
      }
      const menu = e8.getBuffer(" *transient*");
      const shown = menu === undefined ? undefined : e8.withCurrentBuffer(menu, () => e8.bufferText());
      if (tooTall) e8.call("kill-buffer", " *transient*");
      else e8.executeKbdMacro("C-g");
      if (shown !== want) failures.push(`${key}:\n--- Emacs\n${want}\n--- E8\n${shown ?? ""}`);
    }
    shouldEqual(failures, [], `${failures.length} menus differ`);
  });
});

ertDeftest("magit-pushing-sets-the-upstream-and-pulling-fetches", () => {
  const origin = bare();
  const dir = repo();
  withRepos([origin, dir], () => {
    git(dir, "remote", "add", "origin", origin);
    status(dir);
    // P u asks for the upstream to set, as there is none.
    e8.executeKbdMacro(`P u ${typed("origin/main")} RET`);
    settle(() => git(origin, "log", "--oneline", "main").trim() !== "");
    shouldEqual(git(origin, "log", "-1", "--format=%s", "main"), "First commit\n");
    settle(() => git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}") === "origin/main\n");
    shouldEqual(git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}"), "origin/main\n");
    // The status shows the upstream once the push is done.
    settle(() => visible()[0].includes("Merge:    origin/main"));
    should(visible()[0].includes("Merge:    origin/main First commit"), visible()[0]);
  });
});

ertDeftest("magit-branching-and-stashing", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`b c RET ${typed("topic")} RET`);
    shouldEqual(git(dir, "branch", "--show-current"), "topic\n");
    should(visible()[0].startsWith("Head:     topic First commit"), visible()[0]);
    e8.executeKbdMacro("z z RET");
    shouldEqual(git(dir, "stash", "list").trim().split("\n").length, 1);
    shouldEqual(git(dir, "status", "--porcelain", "--untracked-files=no"), "");
    should(visible()[0].includes("Stashes (1)"), visible()[0]);
    e8.executeKbdMacro("z p RET");
    shouldEqual(git(dir, "stash", "list"), "");
    should(git(dir, "status", "--porcelain").includes(" M a.txt"), "a.txt is changed again");
  });
});

ertDeftest("magit-an-instant-fixup-goes-into-the-commit", () => {
  const dir = repo();
  withRepos([dir], () => {
    git(dir, "commit", "-q", "-m", "Second");
    status(dir);
    const first = git(dir, "rev-parse", "--short", "HEAD~").trim();
    // s stages the untracked c.txt, point's section; an instant fixup
    // always has its commit selected in a log, where . picks the first;
    // the fixup is folded into it: two commits still, c.txt in the first.
    e8.executeKbdMacro("s c F");
    shouldEqual(e8.variable("major-mode"), "magit-log-select-mode");
    gotoText(first);
    e8.executeKbdMacro(".");
    // Done once git's rebase has ended, not when the log first shows the
    // two commits: git may still be finishing it, and the repository is
    // deleted after the test.
    const rebasing = () => e8.fileExistsP(e8.expandFileName(".git/rebase-merge", dir));
    settle(() => !rebasing() && git(dir, "log", "--format=%s") === "Second\nFirst commit\n");
    shouldEqual(git(dir, "log", "--format=%s"), "Second\nFirst commit\n");
    shouldEqual(git(dir, "show", "HEAD~:c.txt"), "new\n");
  });
});

/** Goes to the line of the commit HASH in the current Magit buffer. */
function gotoCommit(hash: string): void {
  // Recent commits starts collapsed, as in Magit: TAB on its heading shows them.
  const heading = e8.bufferText().indexOf("Recent commits");
  should(heading >= 0, e8.bufferText());
  e8.gotoChar(e8.pointMin() + heading);
  e8.executeKbdMacro("TAB");
  const at = e8.bufferText().indexOf(`\n${hash} `);
  should(at >= 0, `${hash} not shown`);
  e8.gotoChar(e8.pointMin() + at + 1);
}

ertDeftest("magit-an-interactive-rebase-edits-the-todo-list-in-e8", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    const first = git(dir, "rev-parse", "--short", "HEAD~2").trim();
    // On the commit in Recent commits, as Magit rebases from the commit at point.
    gotoCommit(first);
    e8.executeKbdMacro("r i");
    settle(() => e8.bufferName() === "git-rebase-todo");
    shouldEqual(e8.bufferName(), "git-rebase-todo");
    const todo = e8.bufferText();
    // Newer git writes the subjects as comments: pick 1234567 # One.
    should(todo.startsWith(`pick ${first} `) && todo.split("\n")[0].endsWith("One") && todo.includes(" Three\n"), todo);
    // Fold Two into One, and leave Three out.
    e8.executeKbdMacro("n f d C-c C-c");
    // Done once git has finished the rebase, not when the log first shows
    // One alone, as it does after the pick and before the fixup.
    const done = () => !e8.fileExistsP(e8.expandFileName(".git/rebase-merge", dir)) && git(dir, "log", "--format=%s") === "One\n";
    settle(done);
    shouldEqual(git(dir, "log", "--format=%s"), "One\n");
    shouldEqual(git(dir, "show", "--name-only", "--format=", "HEAD"), "one.txt\ntwo.txt\n");
  });
});

ertDeftest("magit-rewording-a-commit-writes-its-message-again", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    const second = git(dir, "rev-parse", "--short", "HEAD~").trim();
    gotoCommit(second);
    e8.executeKbdMacro("r w");
    settle(() => e8.bufferName() === "COMMIT_EDITMSG");
    shouldEqual(e8.bufferName(), "COMMIT_EDITMSG");
    e8.executeKbdMacro(`C-k ${typed("Second")} C-c C-c`);
    settle(() => git(dir, "log", "--format=%s") === "Three\nSecond\nOne\n");
    shouldEqual(git(dir, "log", "--format=%s"), "Three\nSecond\nOne\n");
  });
});

// The sequencer, after magit-sequence.el: cherry-picking, reverting,
// applying patches, and the rebase todo list's own mode.

const subjects = (dir: string, rev = "HEAD"): string => git(dir, "log", "--format=%s", rev);
const short = (dir: string, rev: string): string => git(dir, "rev-parse", "--short", rev).trim();

ertDeftest("magit-cherry-picking-copies-a-commit-here", () => {
  const dir = history();
  withRepos([dir], () => {
    const three = short(dir, "HEAD");
    git(dir, "checkout", "-q", "-b", "side", "HEAD~2");
    status(dir);
    e8.executeKbdMacro(`A A ${typed(three)} RET`);
    settle(() => subjects(dir) === "Three\nOne\n");
    shouldEqual(subjects(dir), "Three\nOne\n");
  });
});

ertDeftest("magit-spinning-off-moves-commits-to-a-new-branch", () => {
  const dir = history();
  withRepos([dir], () => {
    const three = short(dir, "HEAD");
    status(dir);
    // The last commit goes to topic, made from main's parent; main loses it.
    e8.executeKbdMacro(`A s ${typed(three)} RET ${typed("HEAD~1")} RET ${typed("topic")} RET`);
    settle(() => subjects(dir, "main") === "Two\nOne\n" && git(dir, "branch", "--show-current") === "topic\n");
    shouldEqual(subjects(dir, "main"), "Two\nOne\n");
    shouldEqual(subjects(dir, "topic"), "Three\nTwo\nOne\n");
    shouldEqual(git(dir, "branch", "--show-current"), "topic\n");
  });
});

ertDeftest("magit-reverting-commits-the-reversion", () => {
  const dir = history();
  withRepos([dir], () => {
    const two = short(dir, "HEAD~");
    status(dir);
    // --edit is on at first, as in Magit: the message is written in E8.
    e8.executeKbdMacro(`V V ${typed(two)} RET`);
    settle(() => e8.bufferName() === "COMMIT_EDITMSG");
    shouldEqual(e8.bufferName(), "COMMIT_EDITMSG");
    e8.executeKbdMacro("C-c C-c");
    settle(() => subjects(dir).startsWith("Revert"));
    shouldEqual(subjects(dir).split("\n")[0], 'Revert "Two"');
    should(!e8.fileExistsP(e8.expandFileName("two.txt", dir)), "two.txt is gone");
  });
});

ertDeftest("magit-applying-a-patch-by-email", () => {
  const dir = history();
  withRepos([dir], () => {
    const patch = git(dir, "format-patch", "-1", "HEAD", "-o", e8.expandFileName(".git/patches", dir)).trim();
    git(dir, "reset", "-q", "--hard", "HEAD~");
    status(dir);
    e8.executeKbdMacro(`w w ${typed(patch)} RET`);
    settle(() => subjects(dir) === "Three\nTwo\nOne\n");
    shouldEqual(subjects(dir), "Three\nTwo\nOne\n");
  });
});

ertDeftest("magit-sequencer-commands-say-when-nothing-is-in-progress", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    for (const [command, message] of [
      ["magit-sequencer-continue", "No cherry-pick or revert in progress"],
      ["magit-am-skip", "Not applying any patches"],
      ["magit-rebase-continue", "No rebase in progress"],
    ]) {
      let error = "";
      try {
        e8.call(command as e8.CommandName);
      } catch (e) {
        error = String(e);
      }
      should(error.includes(message), `${command}: ${error}`);
    }
  });
});

/** A todo list in git-rebase-mode, in a repository's git directory. */
function todoBuffer(dir: string, text: string): void {
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", "git-rebase-todo");
  e8.setVariable("default-directory", `${dir}/`);
  e8.letBind({ "inhibit-read-only": true }, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insert(text);
  });
  e8.gotoChar(e8.pointMin());
  e8.call("git-rebase-mode" as e8.CommandName);
  e8.gotoChar(e8.pointMin());
}

const TODO = `pick 1111111 One
pick 2222222 Two
pick 3333333 Three

# Rebase 0000000..3333333 onto 0000000 (3 commands)
#
# Commands:
# p, pick <commit> = use commit
# r, reword <commit> = use commit, but edit the commit message
# e, edit <commit> = use commit, but stop for amending
# s, squash <commit> = use commit, but meld into previous commit
# f, fixup [-C | -c] <commit> = like "squash" but keep only the previous
#                    commit's log message, unless -C is used, in which case
#                    keep only this commit's message; -c is same as -C but
#                    opens the editor
# x, exec <command> = run command (the rest of the line) using shell
# b, break = stop here (continue rebase later with 'git rebase --continue')
# d, drop <commit> = remove commit
# l, label <label> = label current HEAD with a name
# t, reset <label> = reset HEAD to a label
# m, merge [-C <commit> | -c <commit>] <label> [# <oneline>]
#         create a merge commit using the original merge commit's
#         message (or the oneline, if no original merge commit was
#         specified); use -c <commit> to reword the commit message
# u, update-ref <ref> = track a placeholder for the <ref> to be updated
#                       to this position in the new commits. The <ref> is
#                       updated at the end of the rebase
#
# These lines can be re-ordered; they are executed from top to bottom.
`;

const todoLines = (n: number): string[] => e8.bufferText().split("\n").slice(0, n);

ertDeftest("git-rebase-mode-sets-actions-moves-and-comments-lines", () => {
  const dir = history();
  withRepos([dir], () => {
    todoBuffer(dir, TODO);
    shouldEqual(e8.variable("major-mode"), "git-rebase-mode");
    // r rewords and moves on, f fixes up, k comments the third line out and back in.
    // Magit writes the subject as a comment, as git 2.50 and later do.
    const c = magitGitVersionGe("2.50.0") ? "# " : "";
    e8.executeKbdMacro("r f");
    shouldEqual(todoLines(3), [`reword 1111111 ${c}One`, `fixup 2222222 ${c}Two`, "pick 3333333 Three"]);
    e8.executeKbdMacro("k");
    shouldEqual(todoLines(3)[2], "# pick 3333333 Three");
    e8.executeKbdMacro("p k");
    shouldEqual(todoLines(3)[2], "pick 3333333 Three");
    // M-p moves the line at point up, M-n down.
    e8.gotoChar(e8.pointMin());
    e8.executeKbdMacro("n M-p");
    shouldEqual(todoLines(3), [`fixup 2222222 ${c}Two`, `reword 1111111 ${c}One`, "pick 3333333 Three"]);
    e8.executeKbdMacro("M-n");
    shouldEqual(todoLines(3), [`reword 1111111 ${c}One`, `fixup 2222222 ${c}Two`, "pick 3333333 Three"]);
    // x adds a command to run after the line at point; b a break.
    e8.gotoChar(e8.pointMin());
    e8.executeKbdMacro(`x ${typed("make test")} RET`);
    shouldEqual(todoLines(3), [`reword 1111111 ${c}One`, "exec make test", `fixup 2222222 ${c}Two`]);
    e8.executeKbdMacro("b");
    shouldEqual(todoLines(4)[2], "break");
  });
});

ertDeftest("git-rebase-mode-shows-its-own-keys-in-the-instructions", () => {
  const dir = history();
  withRepos([dir], () => {
    todoBuffer(dir, TODO);
    const text = e8.bufferText();
    should(text.includes("# C-c C-c  tell Git to make it happen\n"), text);
    should(text.includes("# c        pick <commit> = use commit\n"), text);
    should(text.includes("# M-p      move the commit at point up\n"), text);
    should(!text.includes("# p, pick"), text);
    should(!e8.bufferModified(), "showing the keys leaves the buffer unmodified");
  });
});

// The menus that were one command: tags, remotes, cloning, init and run.

ertDeftest("magit-tags-are-created-released-and-deleted", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`t t ${typed("v1.0.0")} RET RET`);
    settle(() => git(dir, "tag") === "v1.0.0\n");
    shouldEqual(git(dir, "tag"), "v1.0.0\n");
    // A release commit's message names the version the release tag takes.
    write(dir, "four.txt", "Four");
    git(dir, "add", "four.txt");
    git(dir, "commit", "-q", "-m", "Release version 1.1.0");
    e8.executeKbdMacro("t r");
    settle(() => git(dir, "tag").includes("v1.1.0"));
    shouldEqual(git(dir, "tag"), "v1.0.0\nv1.1.0\n");
    status(dir);
    e8.executeKbdMacro(`t k ${typed("v1.0.0")} RET`);
    shouldEqual(git(dir, "tag"), "v1.1.0\n");
  });
});

ertDeftest("magit-releases-are-ordered-by-version", () => {
  const dir = history();
  withRepos([dir], () => {
    for (const t of ["v1.9.0", "v1.10.0", "v1.10.0-rc1", "v0.1", "not-a-release"]) git(dir, "tag", t);
    status(dir);
    shouldEqual(
      magitListReleases().map(([, tag]) => tag),
      ["v1.10.0", "v1.10.0-rc1", "v1.9.0", "v0.1"],
    );
    should(versionToList("1.2-rc3").join(",") === "1,2,-1,3", versionToList("1.2-rc3").join(","));
  });
});

ertDeftest("magit-remotes-are-added-renamed-and-removed", () => {
  const dir = history();
  const other = bare();
  withRepos([dir, other], () => {
    status(dir);
    // -f fetches after adding; y sets remote.pushDefault to the new remote.
    e8.executeKbdMacro(`M a ${typed("mirror")} RET ${typed(other)} RET y`);
    shouldEqual(git(dir, "remote"), "mirror\n");
    shouldEqual(git(dir, "config", "remote.pushDefault"), "mirror\n");
    git(dir, "config", "branch.main.pushRemote", "mirror");
    e8.executeKbdMacro(`M r ${typed("mirror")} RET ${typed("backup")} RET`);
    shouldEqual(git(dir, "remote"), "backup\n");
    // The push variables naming the remote follow it.
    shouldEqual(git(dir, "config", "remote.pushDefault"), "backup\n");
    shouldEqual(git(dir, "config", "branch.main.pushRemote"), "backup\n");
    e8.executeKbdMacro(`M k ${typed("backup")} RET`);
    shouldEqual(git(dir, "remote"), "");
    shouldEqual(git(dir, "config", "--get-regexp", "pushRemote|pushDefault").trim(), "");
  });
});

ertDeftest("magit-the-remote-menu-shows-and-sets-the-remotes-variables", () => {
  const dir = history();
  const other = bare();
  withRepos([dir, other], () => {
    git(dir, "remote", "add", "origin", other);
    status(dir);
    e8.executeKbdMacro("M");
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    should(menu.startsWith(`Variables\n u remote.origin.url ${other}\n U remote.origin.fetch +refs/heads/*:refs/remotes/origin/*\n s remote.origin.pushurl unset\n S remote.origin.push unset\n O remote.origin.tagOpt [--no-tags|--tags]\n`), menu);
    // O cycles tagOpt through its choices, staying in the menu.
    e8.executeKbdMacro("O");
    shouldEqual(git(dir, "config", "remote.origin.tagOpt"), "--no-tags\n");
    e8.executeKbdMacro("O O");
    shouldEqual(git(dir, "config", "remote.origin.tagOpt"), "");
    e8.executeKbdMacro("C-g");
  });
});

ertDeftest("magit-clone-names-become-urls", () => {
  shouldEqual(magitCloneUrlToName("git@github.com:magit/magit.git"), "magit");
  shouldEqual(magitCloneUrlToName("https://example.com/a/b"), "b");
  shouldEqual(magitCloneNameToUrl("gh:magit/magit"), "git@github.com:magit/magit.git");
  shouldEqual(magitCloneNameToUrl("sh:~sircmpwn/scdoc"), "git@git.sr.ht:~sircmpwn/scdoc");
});

ertDeftest("magit-cloning-shows-the-new-repositorys-status", () => {
  const dir = history();
  const target = tempDir();
  withRepos([dir, target], () => {
    status(dir);
    e8.letBind({ "magit-clone-set-remote.pushDefault": null }, () => magitCloneInternal(dir, `${target}copy`, []));
    const shown = () => e8.windowBuffer(e8.selectedWindow());
    settle(() => shown() === "magit: copy");
    shouldEqual(shown(), "magit: copy");
    shouldEqual(git(`${target}copy`, "log", "--format=%s"), "Three\nTwo\nOne\n");
    // As magit-clone-set-remote-head is nil, origin/HEAD is not kept.
    shouldEqual(git(`${target}copy`, "branch", "-r"), "  origin/main\n");
  });
});

ertDeftest("magit-init-makes-a-repository-and-shows-it", () => {
  const dir = tempDir();
  withRepos([dir], () => {
    e8.call("delete-other-windows");
    e8.call("switch-to-buffer", "*magit-test*");
    e8.setVariable("default-directory", dir);
    e8.executeKbdMacro(`M-x ${typed("magit-init")} RET ${typed("new")} RET`);
    should(e8.fileDirectoryP(`${dir}new/.git`), "a repository is made");
    shouldEqual(e8.bufferName(), "magit: new");
  });
});

ertDeftest("magit-git-command-runs-git-in-a-shell", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    // Q reads the command with "git " already typed.
    e8.executeKbdMacro(`Q ${typed("tag from-q")} RET`);
    settle(() => git(dir, "tag") === "from-q\n");
    shouldEqual(git(dir, "tag"), "from-q\n");
  });
});

ertDeftest("magit-pull-or-fetch-adds-fetch-suffixes-to-the-pull-menu", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    const menu = (): string => {
      e8.executeKbdMacro("F");
      const text = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
      e8.executeKbdMacro("C-g");
      return text;
    };
    let text = menu();
    should(text.startsWith("Arguments"), text);
    should(!text.includes("Fetch from"), text);
    e8.letBind({ "magit-pull-or-fetch": true }, () => (text = menu()));
    should(text.startsWith("Pull arguments"), text);
    for (const line of ["Fetch from", " f remotes", " F remotes and prune", "Fetch", " o another branch", " s explicit refspec", " m submodules"]) should(text.includes(line), `the menu has ${JSON.stringify(line)}:\n${text}`);
  });
});

ertDeftest("magit-define-global-key-bindings-adds-the-set-it-names", () => {
  shouldEqual(e8.lookupKey("global-map", "C-x g"), "magit-status");
  shouldEqual(e8.lookupKey("global-map", "C-x M-g"), "magit-dispatch");
  shouldEqual(e8.lookupKey("global-map", "C-c M-g"), "magit-file-dispatch");
  try {
    // The recommended set's keys are added only where the commands are not bound already.
    e8.letBind({ "magit-define-global-key-bindings": "recommended" }, () => e8.funcall("magit-maybe-define-global-key-bindings"));
    shouldEqual(e8.lookupKey("global-map", "C-c g"), undefined);
    e8.bindKey("C-x M-g", null);
    e8.letBind({ "magit-define-global-key-bindings": "recommended" }, () => e8.funcall("magit-maybe-define-global-key-bindings"));
    shouldEqual(e8.lookupKey("global-map", "C-c g"), "magit-dispatch");
    // nil adds none, even with FORCE.
    e8.bindKey("C-c g", null);
    e8.letBind({ "magit-define-global-key-bindings": null }, () => e8.funcall("magit-maybe-define-global-key-bindings", true));
    shouldEqual(e8.lookupKey("global-map", "C-c g"), undefined);
  } finally {
    e8.bindKey("C-c g", null);
    e8.bindKey("C-x M-g", "magit-dispatch" as e8.CommandName);
  }
});

ertDeftest("magit-ellipsis-truncates-the-author-in-the-margin", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.call("magit-log-current" as e8.CommandName);
    const author = "Someone With A Very Long Name";
    const margin = (): string => String(margins.magitLogFormatAuthorMargin(author, Date.now() / 1000)).slice(0, 19);
    shouldEqual(margin(), "Someone With A Ve… ");
    e8.letBind({ "magit-ellipsis": [["margin", [null, ">>"]], [true, ["…", "..."]]] }, () => shouldEqual(margin(), "Someone With A V>> "));
  });
});

ertDeftest("magit-openpgp-default-signing-key-is-used-without-asking", () => {
  const keys = ["AAAA1111", "BBBB2222"];
  const output = "sec:u:255:22:1111:1::::::scESC:::\nfpr:::::::::AAAA1111:\nssb:u:255:18:9999:1::::::e:::\nfpr:::::::::CCCC9999:\nsec:u:255:22:2222:1::::::scESC:::\nfpr:::::::::BBBB2222:\nsec:u:255:22:3333:1::::::e:::\nfpr:::::::::DDDD3333:\n";
  shouldEqual(transient.magitGpgSigningKeys(output), keys);
  // The only key that can sign is used without asking.
  shouldEqual(transient.magitReadGpgSigningKey("Sign as: ", undefined, ["AAAA1111"]), "AAAA1111");
  e8.letBind({ "magit-openpgp-default-signing-key": "BBBB2222" }, () => shouldEqual(transient.magitReadGpgSigningKey("Sign as: ", undefined, keys), "BBBB2222"));
  // Otherwise one is read.
  e8.unreadKeys("A A A A 1 1 1 1 RET");
  shouldEqual(transient.magitReadGpgSigningKey("Sign as: ", undefined, keys), "AAAA1111");
});
