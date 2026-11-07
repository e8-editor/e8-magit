// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of the commands the parity audit found missing (test/parity.json):
// shelving branches, orphan branches and magit-branch-or-checkout,
// dissolving a branch, fetching all remotes, pushing notes, reshelving and
// adding log stubs to a commit message, clearing and pushing stashes, the
// diff refresh, revision jump and margin menus, a buffer's history and
// lock, and the debugging and profiling commands.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitBranchOrCheckout, magitBranchOrphan, magitBranchShelve, magitBranchUnshelve, magitCommitAddLogInsert, magitCommitReshelve, magitFetchAllRemotes, magitMergeDissolve, magitPushNotesRef } from "magit";
import { magitDeleteShelvedBranch } from "magit-log";
import { magitStashClear } from "magit-stash";
import { magitRevisionJump, magitShowCommitRev } from "magit-diff";
import { magitGoBackward, magitGoForward } from "magit-mode";
import { magitGitString } from "magit-git";
import { magitThisProcess } from "magit-process";
import { bare, git, gotoText, history, repo, settle, status, typed, withRepos, write } from "magit-test-helpers";

const branches = (dir: string): string => git(dir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/shelved");
const today = (dir: string): string => git(dir, "log", "-1", "--format=%cs", "main").trim();
const mx = (command: string): void => e8.executeKbdMacro(`M-x ${typed(command)} RET`);

ertDeftest("magit-shelving-renames-a-branch-under-refs-shelved-and-back", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    git(dir, "branch", "topic");
    magitBranchShelve("topic");
    const shelved = `${today(dir)}-topic`;
    shouldEqual(branches(dir), `refs/heads/main\nrefs/shelved/${shelved}\n`);
    // The refs buffer lists it, and magit-branch-unshelve drops the date.
    magitBranchUnshelve(shelved);
    shouldEqual(branches(dir), "refs/heads/main\nrefs/heads/topic\n");
    magitBranchShelve("topic");
    magitDeleteShelvedBranch(shelved);
    shouldEqual(branches(dir), "refs/heads/main\n");
  });
});

ertDeftest("magit-unshelving-reads-the-shelved-branch", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    git(dir, "branch", "topic");
    magitBranchShelve("topic");
    e8.executeKbdMacro(`M-x ${typed("magit-branch-unshelve")} RET ${typed(`${today(dir)}-topic`)} RET`);
    shouldEqual(branches(dir), "refs/heads/main\nrefs/heads/topic\n");
  });
});

ertDeftest("magit-an-orphan-branch-has-no-commits-and-its-name-no-whitespace", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    magitBranchOrphan("lonely", "HEAD");
    shouldEqual(git(dir, "symbolic-ref", "--short", "HEAD"), "lonely\n");
    shouldEqual(git(dir, "rev-parse", "--verify", "-q", "HEAD"), "");
    git(dir, "checkout", "-q", "-f", "main");
    // magit-minibuffer-local-ns-map refuses the space typed in the name.
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-branch-orphan")} RET ${typed("main")} RET ${typed("new one")} RET`);
    shouldEqual(git(dir, "symbolic-ref", "--short", "HEAD"), "newone\n");
  });
});

ertDeftest("magit-branch-or-checkout-checks-out-a-branch-or-makes-one", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    git(dir, "branch", "other", "HEAD~");
    magitBranchOrCheckout("heads/other");
    shouldEqual(git(dir, "symbolic-ref", "--short", "HEAD"), "other\n");
    e8.executeKbdMacro(`M-x ${typed("magit-branch-or-checkout")} RET ${typed("fresh")} RET ${typed("main")} RET`);
    shouldEqual(git(dir, "symbolic-ref", "--short", "HEAD"), "fresh\n");
    shouldEqual(git(dir, "rev-parse", "fresh"), git(dir, "rev-parse", "main"));
  });
});

ertDeftest("magit-dissolving-merges-the-current-branch-and-deletes-it", () => {
  const dir = history();
  withRepos([dir], () => {
    git(dir, "checkout", "-q", "-b", "topic");
    write(dir, "four.txt", "Four");
    git(dir, "add", "four.txt");
    git(dir, "commit", "-q", "-m", "Four");
    status(dir);
    magitMergeDissolve("main");
    shouldEqual(git(dir, "symbolic-ref", "--short", "HEAD"), "main\n");
    shouldEqual(git(dir, "log", "-1", "--format=%s", "main"), "Four\n");
    shouldEqual(branches(dir), "refs/heads/main\n");
  });
});

ertDeftest("magit-fetching-all-remotes-and-pruning", () => {
  const origin = bare();
  const dir = history();
  withRepos([origin, dir], () => {
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "origin", "main", "main:gone");
    git(dir, "fetch", "-q", "origin");
    git(origin, "branch", "-D", "gone");
    status(dir);
    magitFetchAllRemotes(false);
    settle(() => magitThisProcess()?.exit !== undefined);
    should(git(dir, "branch", "-r").includes("origin/gone"), "without pruning the branch stays");
    magitFetchAllRemotes(true);
    settle(() => magitThisProcess()?.exit !== undefined);
    should(!git(dir, "branch", "-r").includes("origin/gone"), "pruning deletes the branch");
  });
});

ertDeftest("magit-pushing-a-notes-ref", () => {
  const origin = bare();
  const dir = history();
  withRepos([origin, dir], () => {
    git(dir, "remote", "add", "origin", origin);
    git(dir, "notes", "add", "-m", "A note", "HEAD");
    status(dir);
    magitPushNotesRef("refs/notes/commits", "origin");
    settle(() => magitThisProcess()?.exit !== undefined);
    shouldEqual(git(origin, "log", "-1", "--format=%B", "refs/notes/commits"), "Notes added by 'git notes add'\n\n");
  });
});

ertDeftest("magit-reshelving-changes-the-dates-of-the-last-commit", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    magitCommitReshelve("2020-01-02 03:04:05 +0000", true);
    settle(() => git(dir, "log", "-1", "--format=%ci").startsWith("2020"));
    shouldEqual(git(dir, "log", "-1", "--format=%ci|%ai|%s"), "2020-01-02 03:04:05 +0000|2020-01-02 03:04:05 +0000|Three\n");
    magitCommitReshelve("2021-01-02 03:04:05 +0000", false);
    settle(() => git(dir, "log", "-1", "--format=%ci").startsWith("2021"));
    shouldEqual(git(dir, "log", "-1", "--format=%ci|%ai"), "2021-01-02 03:04:05 +0000|2020-01-02 03:04:05 +0000\n");
  });
});

ertDeftest("magit-commit-add-log-insert-adds-stubs-before-the-comments", () => {
  e8.getBufferCreate("*magit-add-log*");
  e8.withCurrentBuffer("*magit-add-log*", () => {
    e8.setVariable("comment-start", "#");
    e8.insert("Summary\n\n# Please enter the commit message\n");
  });
  magitCommitAddLogInsert("*magit-add-log*", "a.txt");
  magitCommitAddLogInsert("*magit-add-log*", "b.txt", "main");
  magitCommitAddLogInsert("*magit-add-log*", "b.txt", "helper");
  magitCommitAddLogInsert("*magit-add-log*", "b.txt", "helper");
  shouldEqual(e8.withCurrentBuffer("*magit-add-log*", () => e8.bufferText()), "Summary\n\n* a.txt: \n* b.txt (main): \n(helper): \n\n# Please enter the commit message\n");
  e8.call("kill-buffer", "*magit-add-log*");
});

ertDeftest("magit-absorbing-modules-needs-modified-modules", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    let error = "";
    try {
      mx("magit-commit-absorb-modules");
    } catch (e) {
      error = String(e);
    }
    should(error.includes("There are no modified modules that could be absorbed"), error);
  });
});

ertDeftest("magit-clearing-and-pushing-stashes", () => {
  const dir = repo();
  withRepos([dir], () => {
    git(dir, "stash", "-q");
    status(dir);
    gotoText("Stashes");
    // k on the stashes section is magit-stash-clear, after asking.
    e8.executeKbdMacro("k y");
    shouldEqual(git(dir, "stash", "list"), "");
    // The push menu stashes the changes with git stash push.
    write(dir, "a.txt", "changed\n");
    e8.executeKbdMacro(`M-x ${typed("magit-stash-push")} RET P`);
    shouldEqual(git(dir, "stash", "list").split("\n").filter((l) => l).length, 1);
    shouldEqual(git(dir, "status", "--porcelain"), "?? c.txt\n");
  });
});

ertDeftest("magit-diff-refresh-changes-the-buffers-diff-arguments", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    mx("magit-diff-unstaged");
    const diff = e8.windowList().map((w) => e8.windowBuffer(w)!).find((b) => b.startsWith("magit-diff"))!;
    e8.call("switch-to-buffer", diff);
    e8.call("delete-other-windows");
    shouldEqual(String(e8.variable("major-mode")), "magit-diff-mode");
    // An E8 before 0.5 cannot show a menu taller than batch's frame: it
    // lays it out, then fails, leaving no menu active. E8 0.5 fits it to
    // the frame and leaves it active, for C-g to quit.
    let tooTall = false;
    try {
      e8.executeKbdMacro("D");
    } catch (e) {
      should(String(e).includes("Size of window too small"), String(e));
      tooTall = true;
    }
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    should(["Limit arguments", "Refresh", "buffer and set defaults", "hunk refinement", "buffer lock", "switch range type"].every((t) => menu.includes(t)), menu);
    if (tooTall) e8.call("kill-buffer", " *transient*");
    else e8.executeKbdMacro("C-g");
    // Its g takes the menu's arguments, which start as the buffer's.
    e8.makeLocalVariable("magit-buffer-diff-args");
    e8.setVariable("magit-buffer-diff-args", ["--ignore-all-space", "--no-ext-diff"]);
    e8.letBind({ "transient-current-command": "magit-diff-refresh" }, () => e8.call("magit-diff-refresh--buffer" as e8.CommandName));
    shouldEqual(e8.variable("magit-buffer-diff-args"), ["--ignore-all-space", "--no-ext-diff"]);
  });
});

ertDeftest("magit-revision-jump-and-the-buffers-history", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-show-commit")} RET ${typed("HEAD")} RET`);
    const buffer = e8.windowList().map((w) => e8.windowBuffer(w)!).find((b) => b.startsWith("magit-revision"))!;
    e8.call("switch-to-buffer", buffer);
    magitRevisionJump(false);
    shouldEqual(e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), e8.lineEndPosition()).trim(), "1 file changed, 1 insertion(+)");
    e8.executeKbdMacro("j m");
    shouldEqual(e8.bufferSubstringNoProperties(e8.lineBeginningPosition(), e8.lineEndPosition()), "Three");
    // Showing another commit in the buffer keeps the first in its history.
    magitShowCommitRev("HEAD~");
    e8.call("switch-to-buffer", buffer);
    should(e8.bufferText().includes("[back]"), e8.bufferText());
    e8.executeKbdMacro("C-c C-b");
    shouldEqual(e8.variable("magit-buffer-revision"), "HEAD");
    should(e8.bufferText().includes("[forward]"), e8.bufferText());
    magitGoForward();
    shouldEqual(e8.variable("magit-buffer-revision"), "HEAD~");
    magitGoBackward();
    let error = "";
    try {
      magitGoBackward();
    } catch (e) {
      error = String(e);
    }
    should(error.includes("No previous entry in buffer's history"), error);
  });
});

ertDeftest("magit-locking-a-buffer-to-its-value", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-show-commit")} RET ${typed("HEAD")} RET`);
    const unlocked = e8.windowList().map((w) => e8.windowBuffer(w)!).find((b) => b.startsWith("magit-revision"))!;
    e8.call("switch-to-buffer", unlocked);
    mx("magit-toggle-buffer-lock");
    const locked = e8.bufferName();
    should(locked.startsWith("magit-revision(HEAD): "), locked);
    should(truthyLocked(), "the buffer is locked");
    // Another commit gets a buffer of its own; unlocking the first kills it for that one.
    magitShowCommitRev("HEAD~");
    should(e8.getBuffer(unlocked) !== undefined, "an unlocked buffer is made");
    e8.call("switch-to-buffer", locked);
    mx("magit-toggle-buffer-lock");
    shouldEqual(e8.bufferName(), unlocked);
    shouldEqual(e8.getBuffer(locked), undefined);
    // A status buffer cannot be locked.
    status(dir);
    let error = "";
    try {
      mx("magit-toggle-buffer-lock");
    } catch (e) {
      error = String(e);
    }
    should(error.includes("Buffer has no value it could be locked to"), error);
  });
});
const truthyLocked = (): boolean => e8.variable("magit-buffer-locked-p") === true;

ertDeftest("magit-saving-the-repositorys-buffers", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.call("find-file", `${dir}a.txt`);
    e8.insert("edited\n");
    status(dir);
    e8.executeKbdMacro(`C-u M-x ${typed("magit-save-repository-buffers")} RET`);
    should(e8.readTextFile(`${dir}a.txt`).startsWith("edited\n"), "a.txt is saved");
  });
});

ertDeftest("magit-the-thing-at-point-placeholders-say-there-is-no-thing", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    for (const [key, message] of [
      ["C-c C-e", "There is no thing at point that could be edited"],
      ["C-c C-o", "There is no thing at point that could be browsed"],
      ["C-c C-w", "There is no thing at point that we know how to copy"],
    ]) {
      let error = "";
      try {
        e8.executeKbdMacro(key);
      } catch (e) {
        error = String(e);
      }
      should(error.includes(message), `${key}: ${error}`);
    }
  });
});

ertDeftest("magit-debugging-git-and-recording-subprocesses", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    mx("magit-toggle-subprocess-record");
    magitGitString("rev-parse", "HEAD");
    mx("magit-toggle-subprocess-record");
    const record = e8.withCurrentBuffer(" *magit-process-file record*", () => e8.bufferText());
    should(/\d\d:\d\d:\d\d .* \$ git .*rev-parse HEAD/.test(record), record);
    // With magit-git-debug, a failing git whose output Magit wanted goes in the process buffer.
    mx("magit-toggle-git-debug");
    magitGitString("rev-parse", "no-such-rev");
    mx("magit-toggle-git-debug");
    e8.call("magit-process-buffer" as e8.CommandName);
    should(e8.bufferText().includes("rev-parse no-such-rev"), e8.bufferText());
    mx("magit-debug-git-executable");
    const info = e8.withCurrentBuffer("*magit-git-executable*", () => e8.bufferText());
    should(info.includes('magit-git-executable: "git"') && info.includes("exec-path: ("), info);
    e8.call("kill-buffer", "*magit-git-executable*");
  });
});

ertDeftest("magit-profiling-times-the-git-magit-runs", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    mx("magit-profile-refresh-buffer");
    const results = e8.withCurrentBuffer("*ELP Profiling Results*", () => e8.bufferText());
    should(results.startsWith("Function Name") && /\ngit \S+ +\d+ /.test(results), results);
    mx("magit-toggle-profiling");
    mx("magit-refresh-buffer");
    mx("magit-toggle-profiling");
    should(/\ngit /.test(e8.withCurrentBuffer("*ELP Profiling Results*", () => e8.bufferText())), "the profile is shown");
    e8.call("kill-buffer", "*ELP Profiling Results*");
    mx("magit-zap-caches");
  });
});

ertDeftest("magit-emacs-Q-command-gives-a-command-line-loading-only-magit", () => {
  mx("magit-emacs-Q-command");
  const cmd = String(e8.currentKill(0));
  should(/ -q -L \S+ .*-l \S+magit\.ts$/.test(cmd), cmd);
});

ertDeftest("magit-margin-settings-menu", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro("y");
    e8.executeKbdMacro("L");
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    should(menu.includes("Toggle visibility") && menu.includes("Change verbosity"), menu);
    e8.executeKbdMacro("C-g");
  });
});
