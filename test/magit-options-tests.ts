// SPDX-License-Identifier: GPL-3.0-or-later
//
// The options of magit-base.el, magit-mode.el, magit-commit.el and
// magit-branch.el the port honours: how Magit asks, reads and names its
// buffers, the hooks around setting a buffer up, line numbers in Magit
// buffers, how committing asks to stage, shows the diff, keeps dates and
// selects the commit to fix up, and how branches are created, renamed,
// given their upstream and configured.

import { ertDeftest, should, shouldEqual } from "ert";
import { magitCompletingRead, magitConfirm } from "magit-base";
import { bare, git, gotoText, history, repo, settle, status, tempDir, typed, visible, withRepos, write } from "magit-test-helpers";

e8.require("magit");

/** Whether evaluating BODY signals an error whose message has TEXT. */
function signals(text: string, body: () => void): boolean {
  try {
    body();
  } catch (e) {
    return String(e).includes(text);
  }
  return false;
}

/** The text of the menu KEYS open, which C-g then closes. */
function menuText(keys: string): string {
  e8.executeKbdMacro(keys);
  const text = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
  e8.executeKbdMacro("C-g");
  return text;
}

/** Runs BODY, then waits for the git it starts to finish, so its end is not taken for a later command's. */
function awaitingGit(body: () => void): void {
  const before = e8.messages().length;
  body();
  settle(() => e8.messages().slice(before).some((m) => m === "Git finished" || m.startsWith("Git error")));
}

/** Cancels the commit message being written, and waits for git to give up, so its end is not taken for a later command's. */
function cancelCommit(): void {
  const before = e8.messages().length;
  e8.executeKbdMacro("C-c C-k");
  settle(() => e8.messages().slice(before).some((m) => m === "Git finished" || m.startsWith("Git error")));
}

// magit-base.el.

let confirmed: unknown;
e8.defineCommand({ name: "magit-test-confirm-drop", doc: "Ask as magit-stash-drop does before dropping stashes.", run: () => void (confirmed = magitConfirm("drop-stashes", "Drop it")) });
e8.defineCommand({ name: "magit-test-confirm-discard", doc: "Ask as Magit does before discarding.", run: () => void (confirmed = magitConfirm("discard", "Discard it")) });

ertDeftest("magit-slow-confirm-asks-yes-or-no-for-the-actions-it-names", () => {
  // drop-stashes is in the default: "y" is not an answer to yes-or-no-p.
  confirmed = undefined;
  e8.executeKbdMacro(`M-x ${typed("magit-test-confirm-drop")} RET y e s RET`);
  shouldEqual(confirmed, true);
  confirmed = undefined;
  e8.executeKbdMacro(`M-x ${typed("magit-test-confirm-discard")} RET y`);
  shouldEqual(confirmed, true);
  e8.letBind({ "magit-slow-confirm": true }, () => {
    confirmed = undefined;
    e8.executeKbdMacro(`M-x ${typed("magit-test-confirm-discard")} RET y e s RET`);
    shouldEqual(confirmed, true);
  });
  e8.letBind({ "magit-slow-confirm": [] }, () => {
    confirmed = undefined;
    e8.executeKbdMacro(`M-x ${typed("magit-test-confirm-drop")} RET y`);
    shouldEqual(confirmed, true);
  });
});

ertDeftest("magit-dwim-selection-takes-the-stash-at-point-or-asks", () => {
  const dir = repo();
  withRepos([dir], () => {
    git(dir, "stash", "-q");
    write(dir, "a.txt", "changed again\n");
    git(dir, "stash", "-q");
    status(dir);
    e8.call("magit-stash-list" as e8.CommandName);
    gotoText("stash@{0}");
    // magit-stash-drop asks about the stash at point, as its entry is ask.
    e8.executeKbdMacro(`M-x ${typed("magit-stash-drop")} RET y`);
    shouldEqual(git(dir, "stash", "list").trim().split("\n").length, 1);
    // With t it takes it without asking.
    e8.letBind({ "magit-dwim-selection": [["magit-stash-drop", null, true]] }, () => {
      gotoText("stash@{0}");
      e8.executeKbdMacro(`M-x ${typed("magit-stash-drop")} RET`);
    });
    shouldEqual(git(dir, "stash", "list"), "");
  });
});

ertDeftest("magit-completing-read-function-reads-for-magit", () => {
  let asked: string | undefined;
  e8.defun("magit-test-completing-read", (prompt: string, choices: string[]) => {
    asked = prompt;
    return choices[choices.length - 1];
  });
  e8.letBind({ "magit-completing-read-function": "magit-test-completing-read" }, () => {
    shouldEqual(magitCompletingRead("Pick", ["a", "b"], { def: "a" }), "b");
  });
  // Another function gets the prompt without the default, as magit-completing-read-default-prompt-predicate says.
  shouldEqual(asked, "Pick: ");
});

// magit-mode.el.

ertDeftest("magit-uniquify-buffer-names-tells-repositories-of-one-name-apart", () => {
  const top = tempDir();
  const one = e8.fileNameAsDirectory(e8.expandFileName("one/same", top));
  const two = e8.fileNameAsDirectory(e8.expandFileName("two/same", top));
  withRepos([top], () => {
    for (const d of [one, two]) {
      e8.makeDirectory(d, { parents: true });
      git(d, "init", "-q", "-b", "main");
    }
    status(one);
    shouldEqual(e8.bufferName(), "magit: same");
    status(two);
    shouldEqual(e8.bufferName(), "magit: same<two>");
    should(e8.bufferLiveP(e8.getBuffer("magit: same<one>")), "the first buffer is renamed");
    // Each repository keeps its buffer.
    status(one);
    shouldEqual(e8.bufferName(), "magit: same<one>");
  });
});

ertDeftest("magit-buffer-names-without-uniquify-or-from-another-function", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.letBind({ "magit-uniquify-buffer-names": false }, () => {
      status(dir);
      shouldEqual(e8.bufferName(), `*magit: ${e8.abbreviateFileName(dir)}*`);
      e8.call("kill-buffer", e8.bufferName());
    });
    e8.defun("magit-test-buffer-name", (mode: string) => `${mode} of ${e8.fileNameNondirectory(e8.directoryFileName(String(e8.variable("default-directory"))))}`);
    e8.letBind({ "magit-generate-buffer-name-function": "magit-test-buffer-name" }, () => {
      status(dir);
      shouldEqual(e8.bufferName(), `magit-status-mode of ${e8.fileNameNondirectory(e8.directoryFileName(dir))}`);
    });
  });
});

ertDeftest("magit-setup-buffer-hook-and-magit-post-create-buffer-hook-run-around-the-content", () => {
  const dir = repo();
  withRepos([dir], () => {
    const calls: string[] = [];
    e8.defun("magit-test-setup", () => void calls.push(`setup ${e8.bufferText() === "" ? "empty" : "full"}`));
    e8.defun("magit-test-created", () => void calls.push(`created ${e8.bufferText() === "" ? "empty" : "full"}`));
    e8.letBind({ "magit-setup-buffer-hook": ["magit-test-setup"], "magit-post-create-buffer-hook": ["magit-test-created"] }, () => {
      status(dir);
      status(dir);
    });
    shouldEqual(calls, ["setup empty", "created full", "setup full"]);
  });
});

ertDeftest("magit-setup-buffer-hook-saves-the-repositorys-buffers", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.call("find-file", e8.expandFileName("a.txt", dir));
    e8.insert("edited\n");
    status(dir);
    should(e8.readTextFile(e8.expandFileName("a.txt", dir)).startsWith("edited\n"), "a.txt is saved");
  });
});

ertDeftest("magit-section-disable-line-numbers-turns-off-global-line-numbers", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.call("global-display-line-numbers-mode");
    try {
      status(dir);
      should(!e8.variable("display-line-numbers-mode"), "no line numbers in the status buffer");
      e8.call("kill-buffer", e8.bufferName());
      e8.letBind({ "magit-section-disable-line-numbers": false }, () => status(dir));
      should(e8.variable("display-line-numbers-mode") === true, "line numbers in the status buffer");
    } finally {
      e8.call("global-display-line-numbers-mode");
    }
  });
});

// magit-commit.el.

/** A repository of three commits, with a change to one.txt neither staged nor committed. */
function unstaged(): string {
  const dir = history();
  write(dir, "one.txt", "One changed\n");
  return dir;
}

ertDeftest("magit-commit-ask-to-stage-says-what-committing-nothing-staged-does", () => {
  const dir = unstaged();
  withRepos([dir], () => {
    status(dir);
    e8.letBind({ "magit-commit-ask-to-stage": false }, () => should(signals("Nothing staged", () => e8.executeKbdMacro("c c")), "nothing staged is an error"));
    // verbose, the default, shows the unstaged changes while it asks; no commits nothing and buries the diff.
    e8.executeKbdMacro("c c n");
    shouldEqual(e8.variable("major-mode"), "magit-status-mode");
    should(e8.getBuffer("COMMIT_EDITMSG") === undefined, "no commit message is written");
    // stage commits everything without asking.
    e8.letBind({ "magit-commit-ask-to-stage": "stage" }, () => e8.executeKbdMacro("c c"));
    settle(() => e8.bufferName() === "COMMIT_EDITMSG");
    should(e8.bufferText().includes("Changes to be committed:\n#\tmodified:   one.txt"), e8.bufferText());
    cancelCommit();
  });
});

ertDeftest("magit-commit-show-diff-shows-what-is-committed", () => {
  const dir = repo();
  withRepos([dir], () => {
    const diff = (): string | undefined => e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.variable("major-mode")) === "magit-diff-mode");
    status(dir);
    // Set, not bound: the diff is shown when git has the message edited, after the command.
    e8.setVariable("magit-commit-show-diff", false);
    try {
      e8.executeKbdMacro("c c");
      settle(() => e8.bufferName() === "COMMIT_EDITMSG");
      shouldEqual(diff(), undefined);
      cancelCommit();
    } finally {
      e8.setVariable("magit-commit-show-diff", true);
    }
    status(dir);
    e8.executeKbdMacro("c c");
    settle(() => e8.bufferName() === "COMMIT_EDITMSG");
    should(diff() !== undefined, "the staged changes are shown");
    shouldEqual(e8.withCurrentBuffer(diff()!, () => e8.variable("magit-buffer-typearg")), "--cached");
    cancelCommit();
  });
});

/** Commits staged changes in DIR, its committer date that of 2001. */
function commitIn2001(dir: string, message: string): void {
  e8.callProcess(["env", "GIT_COMMITTER_DATE=2001-02-03T04:05:06", "git", "commit", "-q", "-m", message], { directory: dir });
}

ertDeftest("magit-commit-extend-override-date-says-whether-extending-dates-the-commit", () => {
  const dir = unstaged();
  withRepos([dir], () => {
    git(dir, "add", "one.txt");
    commitIn2001(dir, "Old");
    const year = (): string => git(dir, "log", "-1", "--format=%cd", "--date=format:%Y").trim();
    status(dir);
    write(dir, "two.txt", "Two changed\n");
    git(dir, "add", "two.txt");
    awaitingGit(() => e8.letBind({ "magit-commit-extend-override-date": false }, () => e8.executeKbdMacro("c e")));
    shouldEqual(year(), "2001");
    shouldEqual(git(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["one.txt", "two.txt"]);
    write(dir, "three.txt", "Three changed\n");
    git(dir, "add", "three.txt");
    awaitingGit(() => e8.executeKbdMacro("c e"));
    should(year() !== "2001", "the committer date is now");
  });
});

ertDeftest("magit-post-commit-hook-runs-after-a-commit-made-without-a-message", () => {
  const dir = unstaged();
  withRepos([dir], () => {
    let ran = 0;
    const hook = () => void ran++;
    e8.addHook("magit-post-commit-hook", hook);
    try {
      git(dir, "add", "one.txt");
      status(dir);
      awaitingGit(() => e8.executeKbdMacro("c e"));
      settle(() => ran > 0);
      shouldEqual(ran, 1);
    } finally {
      e8.removeHook("magit-post-commit-hook", hook);
    }
  });
});

ertDeftest("magit-commit-squash-confirm-says-whether-the-commit-at-point-is-taken", () => {
  const dir = unstaged();
  withRepos([dir], () => {
    git(dir, "add", "one.txt");
    const two = git(dir, "rev-parse", "--short", "HEAD~").trim();
    const atTwo = (): void => {
      gotoText("Recent commits");
      if (!visible()[0].includes(`\n${two} `)) e8.executeKbdMacro("TAB");
      gotoText(`${two} `);
    };
    status(dir);
    atTwo();
    // By default the commit is selected in a log, where point starts on the commit at point.
    e8.executeKbdMacro("c f");
    shouldEqual(e8.variable("major-mode"), "magit-log-select-mode");
    should(e8.bufferText().split("\n")[e8.lineOf(e8.point())].includes(two), "point is on the commit");
    awaitingGit(() => e8.executeKbdMacro("."));
    shouldEqual(git(dir, "log", "-1", "--format=%s"), "fixup! Two\n");
    // With nil the commit at point is taken at once.
    write(dir, "one.txt", "One changed again\n");
    git(dir, "add", "one.txt");
    status(dir);
    atTwo();
    awaitingGit(() => e8.letBind({ "magit-commit-squash-confirm": false }, () => e8.executeKbdMacro("c s")));
    shouldEqual(git(dir, "log", "-1", "--format=%s"), "squash! Two\n");
  });
});

// magit-branch.el.

ertDeftest("magit-branch-read-upstream-first-says-what-is-read-first", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.letBind({ "magit-branch-read-upstream-first": false }, () => e8.executeKbdMacro(`b c ${typed("topic")} RET RET`));
    shouldEqual(git(dir, "branch", "--show-current"), "topic\n");
    // fallback: what is not a revision is the name, and the start is read next.
    e8.letBind({ "magit-branch-read-upstream-first": "fallback" }, () => e8.executeKbdMacro(`b n ${typed("other")} RET ${typed("main")} RET`));
    shouldEqual(git(dir, "rev-parse", "other"), git(dir, "rev-parse", "main"));
  });
});

/** A repository whose main is pushed to origin, and origin's feature, fetched. */
function withOrigin(body: (dir: string, origin: string) => void): void {
  const origin = bare();
  const dir = history();
  withRepos([origin, dir], () => {
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-q", "-u", "origin", "main", "main:feature");
    git(dir, "fetch", "-q", "origin");
    body(dir, origin);
  });
}

ertDeftest("magit-branch-adjust-remote-upstream-alist-picks-the-upstream", () => {
  withOrigin((dir) => {
    status(dir);
    e8.letBind({ "magit-branch-adjust-remote-upstream-alist": [["main", "feature"]] }, () => e8.executeKbdMacro(`b n ${typed("origin/feature")} RET RET`));
    shouldEqual(git(dir, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim(), "main");
  });
});

ertDeftest("magit-branch-prefer-remote-upstream-uses-the-branchs-upstream", () => {
  withOrigin((dir) => {
    git(dir, "config", "branch.autoSetupMerge", "always");
    git(dir, "branch", "-q", "--set-upstream-to=origin/main", "main");
    status(dir);
    e8.letBind({ "magit-branch-prefer-remote-upstream": ["main"] }, () => e8.executeKbdMacro(`b n ${typed("main")} RET ${typed("topic")} RET`));
    shouldEqual(git(dir, "rev-parse", "--abbrev-ref", "topic@{upstream}").trim(), "origin/main");
    e8.executeKbdMacro(`b n ${typed("main")} RET ${typed("plain")} RET`);
    shouldEqual(git(dir, "rev-parse", "--abbrev-ref", "plain@{upstream}").trim(), "main");
  });
});

ertDeftest("magit-branch-rename-push-target-says-whether-the-push-target-is-renamed", () => {
  withOrigin((dir) => {
    git(dir, "branch", "topic");
    git(dir, "push", "-q", "origin", "topic");
    git(dir, "config", "remote.pushDefault", "origin");
    git(dir, "fetch", "-q", "origin");
    const remoteHeads = (): string[] => git(dir, "ls-remote", "--heads", "origin").trim().split("\n").map((l) => l.replace(/^.*refs\/heads\//, ""));
    status(dir);
    // local-only leaves the branch on the push remote alone.
    e8.letBind({ "magit-branch-rename-push-target": "local-only" }, () => e8.executeKbdMacro(`b m ${typed("topic")} RET ${typed("topic2")} RET`));
    shouldEqual(remoteHeads(), ["feature", "main", "topic"]);
    // t, the default, offers to rename it there too.
    git(dir, "branch", "-m", "topic2", "topic");
    e8.executeKbdMacro(`b m ${typed("topic")} RET ${typed("topic2")} RET y`);
    shouldEqual(remoteHeads(), ["feature", "main", "topic2"]);
  });
});

ertDeftest("magit-branch-direct-configure-says-whether-the-branch-menu-shows-variables", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    let text = menuText("b");
    should(text.startsWith("Configure main"), text);
    should(text.includes("Configure repository defaults"), text);
    e8.letBind({ "magit-branch-direct-configure": false }, () => {
      text = menuText("b");
      should(!text.includes("Configure main") && !text.includes("Configure repository defaults"), text);
      // C configures the current branch, its menu as magit-branch-configure's.
      e8.executeKbdMacro("b C");
      text = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
      e8.executeKbdMacro("C-g");
    });
    should(text.startsWith("Configure main"), text);
    should(text.includes("Configure branch creation"), text);
  });
});

ertDeftest("magit-diff-and-log-buffer-file-locked-give-the-file-a-buffer-of-its-own", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.call("magit-diff-unstaged" as e8.CommandName);
    const unlocked = e8.bufferName();
    e8.call("find-file", e8.expandFileName("a.txt", dir));
    e8.call("magit-diff-buffer-file" as e8.CommandName);
    shouldEqual(e8.bufferName(), `magit-diff(main -- a.txt): ${e8.fileNameNondirectory(e8.directoryFileName(dir))}`);
    shouldEqual(e8.variable("magit-buffer-locked-p"), true);
    should(e8.bufferLiveP(e8.getBuffer(unlocked)), "the unlocked diff buffer is left alone");
    e8.call("find-file", e8.expandFileName("a.txt", dir));
    e8.call("magit-log-buffer-file" as e8.CommandName);
    shouldEqual(e8.bufferName(), `magit-log(main -- a.txt): ${e8.fileNameNondirectory(e8.directoryFileName(dir))}`);
    // Without the options, the one diff buffer is reused.
    e8.call("find-file", e8.expandFileName("a.txt", dir));
    e8.letBind({ "magit-diff-buffer-file-locked": false }, () => e8.call("magit-diff-buffer-file" as e8.CommandName));
    shouldEqual(e8.bufferName(), unlocked);
  });
});
