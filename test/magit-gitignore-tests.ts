// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit-gitignore's tests, with ERT: rules go to the top-level .gitignore,
// one in a subdirectory, $GIT_DIR/info/exclude or core.excludesFile, the
// rule read defaulting to the file at point, and files are marked to
// skip the worktree or to be assumed unchanged, and unmarked.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { git, tempDir, write, read, repo, history, status, withRepos, gotoText, typed } from "magit-test-helpers";
import { magitGitignoreOnSystem, magitGitignoreWrite } from "magit-gitignore";

ertDeftest("magit-gitignore-in-topdir-adds-the-rule-and-stages-the-file", () => {
  const dir = repo();
  withRepos([dir], () => {
    write(dir, ".gitignore", "*.o");
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-gitignore-in-topdir")} RET ${typed("*.log")} RET`);
    shouldEqual(read(dir, ".gitignore"), "*.o\n*.log\n");
    should(git(dir, "diff", "--cached", "--name-only").split("\n").includes(".gitignore"), "the .gitignore is staged");
  });
});

ertDeftest("magit-gitignore-in-subdir-adds-the-rule-in-that-directory", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.makeDirectory(`${dir}sub`);
    write(dir, "sub/x.tmp", "x\n");
    status(dir);
    // The directory prompt starts in the repository, where status is.
    e8.executeKbdMacro(`M-x ${typed("magit-gitignore-in-subdir")} RET ${typed("*.tmp")} RET ${typed("sub")} RET`);
    shouldEqual(read(dir, "sub/.gitignore"), "*.tmp\n");
    should(git(dir, "diff", "--cached", "--name-only").split("\n").includes("sub/.gitignore"), "sub/.gitignore is staged");
    shouldEqual(git(dir, "status", "--porcelain", "--", "sub/x.tmp"), "");
  });
});

ertDeftest("magit-gitignore-in-gitdir-defaults-to-the-file-at-point", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    // The untracked section starts folded.
    gotoText("Untracked files");
    e8.executeKbdMacro("TAB");
    gotoText("c.txt");
    e8.executeKbdMacro(`M-x ${typed("magit-gitignore-in-gitdir")} RET RET`);
    should(read(dir, ".git/info/exclude").endsWith("\n/c.txt\n"), read(dir, ".git/info/exclude"));
    should(!git(dir, "status", "--porcelain").includes("c.txt"), "c.txt is ignored");
    shouldEqual(git(dir, "diff", "--cached", "--name-only"), "b.txt\n");
  });
});

ertDeftest("magit-gitignore-on-system-writes-core-excludesfile", () => {
  const dir = repo();
  const other = tempDir();
  withRepos([dir, other], () => {
    const file = `${other}ignore/global`;
    git(dir, "config", "core.excludesFile", file);
    status(dir);
    magitGitignoreOnSystem("*.c");
    shouldEqual(read(other, "ignore/global"), "*.c\n");
  });
});

ertDeftest("magit-gitignore-doubles-backslashes-and-ends-the-last-line", () => {
  const dir = tempDir();
  withRepos([dir], () => {
    write(dir, "rules", "a");
    magitGitignoreWrite("\\#x\\\\y", `${dir}rules`);
    shouldEqual(read(dir, "rules"), "a\n\\\\#x\\\\\\\\y\n");
  });
});

ertDeftest("magit-gitignore-offers-extensions-as-patterns", () => {
  const dir = repo();
  withRepos([dir], () => {
    e8.makeDirectory(`${dir}logs`);
    write(dir, "logs/a.log", "x\n");
    write(dir, "logs/b.log", "y\n");
    write(dir, "top.log", "z\n");
    status(dir);
    // Untracked files are offered as themselves and by extension, in
    // their directory and anywhere; completion finishes the pattern.
    e8.executeKbdMacro(`M-x ${typed("magit-gitignore-in-gitdir")} RET ${typed("/logs/*.l")} TAB RET`);
    should(read(dir, ".git/info/exclude").endsWith("\n/logs/*.log\n"), read(dir, ".git/info/exclude"));
    should(!git(dir, "status", "--porcelain", "--untracked-files=all").includes("logs/"), "logs' files are ignored");
    should(git(dir, "status", "--porcelain").includes("top.log"), "top.log is not");
  });
});

ertDeftest("magit-skip-worktree-and-no-skip-worktree", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-skip-worktree")} RET ${typed("two.txt")} RET`);
    should(git(dir, "ls-files", "-t").split("\n").includes("S two.txt"), git(dir, "ls-files", "-t"));
    // The only file skipped is not asked for.
    e8.executeKbdMacro(`M-x ${typed("magit-no-skip-worktree")} RET`);
    should(!git(dir, "ls-files", "-t").includes("S "), git(dir, "ls-files", "-t"));
  });
});

ertDeftest("magit-assume-unchanged-and-no-assume-unchanged", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-assume-unchanged")} RET ${typed("one.txt")} RET`);
    should(git(dir, "ls-files", "-v").split("\n").includes("h one.txt"), git(dir, "ls-files", "-v"));
    write(dir, "one.txt", "changed\n");
    shouldEqual(git(dir, "status", "--porcelain"), "");
    e8.executeKbdMacro(`M-x ${typed("magit-no-assume-unchanged")} RET`);
    shouldEqual(git(dir, "status", "--porcelain"), " M one.txt\n");
  });
});

ertDeftest("magit-gitignore-menu-shows-the-system-file-when-set", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro(`M-x ${typed("magit-gitignore")} RET`);
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    e8.executeKbdMacro("C-g");
    should(menu.includes("t shared at toplevel (.gitignore)"), menu);
    should(menu.includes("p privately (.git/info/exclude)"), menu);
    git(dir, "config", "core.excludesFile", "/nowhere/ignore");
    e8.executeKbdMacro(`M-x ${typed("magit-gitignore")} RET`);
    const menu2 = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    e8.executeKbdMacro(`${typed("p")} ${typed("*.x")} RET`);
    should(menu2.includes("g privately for all repositories (/nowhere/ignore)"), menu2);
    should(read(dir, ".git/info/exclude").endsWith("\n*.x\n"), "p ran magit-gitignore-in-gitdir");
  });
});
