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
import { magitGitVersionGe } from "magit-git";

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

// Repositories.

/** Runs git in DIR and gives its output, or "" if it fails, as its error goes to the output too. */
function git(dir: string, ...args: string[]): string {
  const r = e8.callProcess(["git", ...args], { directory: dir });
  return r.exit === 0 ? r.output : "";
}

/** A new empty directory, its true name ending in a slash, as git rev-parse --show-toplevel names it. */
function tempDir(): string {
  return e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-test", { dir: true })));
}

const write = (dir: string, file: string, text: string): void => e8.writeTextFile(e8.expandFileName(file, dir), text);
const read = (dir: string, file: string): string => e8.readTextFile(e8.expandFileName(file, dir));

/** Makes DIR a repository with a committer, its branch main. */
function init(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "commit.gpgsign", "false");
}

/**
 * The repository Emacs's Magit was shown: one commit, a change to a.txt
 * unstaged, one to b.txt staged, and c.txt untracked.
 */
function repo(): string {
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
function history(): string {
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
function bare(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

/** Shows DIR's status, as M-x magit-status there does. */
function status(dir: string): void {
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", "*magit-test*");
  e8.setVariable("default-directory", dir);
  e8.call("magit-status" as e8.DefinedCommand);
}

/**
 * Runs BODY with the repositories DIRS made for it, then kills the buffers
 * left in them and deletes them.
 */
function withRepos(dirs: string[], body: () => void): void {
  try {
    body();
  } finally {
    for (const b of e8.bufferList()) {
      if (b.startsWith(" *Minibuf")) continue;
      const dd = e8.withCurrentBuffer(b, () => e8.variable("default-directory"));
      if (b === "*magit-test*" || (typeof dd === "string" && dirs.some((d) => e8.fileTruename(dd).startsWith(d.replace(/\/$/, ""))))) {
        e8.withCurrentBuffer(b, () => e8.setBufferModified(false));
        e8.call("kill-buffer", b);
      }
    }
    for (const d of dirs) e8.deleteDirectory(d, { recursive: true });
  }
}

/** Waits for DONE, as a push, pull, commit or rebase Magit runs without waiting ends, for up to twenty seconds. */
function settle(done: () => boolean): void {
  for (let i = 0; i < 400 && !done(); i++) e8.acceptProcessOutput(undefined, 0.05);
}

/** The status buffer's text as it shows, hidden sections left out, and point's line counting from 1. */
function visible(): [string, number] {
  const hidden = e8.overlaysIn(e8.pointMin(), e8.pointMax()).filter((o) => e8.overlayGet(o, "invisible") === true);
  let out = "";
  for (let p = e8.pointMin(); p < e8.pointMax(); p++) {
    if (!hidden.some((o) => (e8.overlayStart(o) ?? 0) <= p && p < (e8.overlayEnd(o) ?? 0))) out += e8.charAfter(p);
  }
  return [out, e8.lineOf(e8.point()) + 1];
}

/** Moves point to where TEXT starts in the buffer. */
function gotoText(text: string): void {
  const at = e8.bufferText().indexOf(text);
  should(at >= 0, `the buffer has ${JSON.stringify(text)}`);
  e8.gotoChar(e8.pointMin() + at);
}

/** The keys that type TEXT. */
const typed = (text: string): string => Array.from(text, (c) => (c === " " ? "SPC" : c)).join(" ");

/** The lines of a diff that add or remove, headers included. */
const changes = (diff: string): string[] => diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));

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
    should(template.startsWith("\n# Please enter the commit message for your changes."), template);
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
    // s stages the untracked c.txt, point's section; the fixup is folded
    // into the first commit: two commits still, c.txt in the first.
    e8.executeKbdMacro(`s c F ${typed(first)} RET`);
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
