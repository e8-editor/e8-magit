// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit-submodule's tests, with ERT: the submodule menu's layout, adding,
// registering, populating, updating, synchronizing, unpopulating and
// removing a module, the list of submodules, and the status buffer's
// module sections. Each test makes a superproject and a repository to add
// as its module in a temporary directory of its own.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { git, history, init, status, withRepos, settle, gotoText, typed, write } from "magit-test-helpers";
import "magit-submodule";
import { magitProcessLog } from "magit-process";

/** A directory holding a superproject, super, and a repository of two commits to add to it, lib. */
function project(): { root: string; superDir: string; lib: string } {
  const root = e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-test", { dir: true })));
  const superDir = e8.fileNameAsDirectory(`${root}super`);
  const lib = `${root}lib`;
  for (const dir of [superDir, e8.fileNameAsDirectory(lib)]) {
    e8.makeDirectory(dir, { parents: true });
    init(dir);
    git(dir, "config", "protocol.file.allow", "always");
  }
  for (const [file, msg] of [["one.txt", "One"], ["two.txt", "Two"]]) {
    write(lib, file, msg);
    git(lib, "add", file);
    git(lib, "commit", "-q", "-m", msg);
  }
  write(superDir, "a.txt", "a\n");
  git(superDir, "add", "a.txt");
  git(superDir, "commit", "-q", "-m", "First");
  return { root, superDir, lib };
}

/** Runs BODY with git allowed to clone local repositories for submodules, as `git -c protocol.file.allow=always`. */
function allowingFileProtocol(body: () => void): void {
  const global = ((e8.variable("magit-git-global-arguments") as string[] | null) ?? []).map(String);
  e8.letBind({ "magit-git-global-arguments": [...global, "-c", "protocol.file.allow=always"] }, body);
}

/** Runs M-x COMMAND, then the keys ANSWERS, each answer's text typed and ended with RET. */
function mx(command: string, ...answers: string[]): void {
  e8.executeKbdMacro([`M-x ${typed(command)} RET`, ...answers.map((a) => (a === "" ? "RET" : `${typed(a)} RET`))].join(" "));
}

/** Waits for the git processes Magit started in DIR to end. */
function idle(dir: string): void {
  const done = () => magitProcessLog(dir).every((e) => e.exit !== undefined);
  settle(done);
  should(done(), "git has finished");
}

/** Adds lib to super as the module lib, with M-x magit-submodule-add, and commits it. */
function addLib(superDir: string, lib: string): void {
  status(superDir);
  // The url, the path the url's name starts it with, and the name the path gives.
  mx("magit-submodule-add", lib, "", "");
  idle(superDir);
  should(e8.fileDirectoryP(`${superDir}.git/modules/lib`) && e8.fileExistsP(`${superDir}lib/.git`) && !e8.fileDirectoryP(`${superDir}lib/.git`), "the module is cloned and its gitdir absorbed into the superproject's");
  git(superDir, "commit", "-q", "-m", "Add lib");
}

ertDeftest("magit-submodule-the-menu-is-laid-out-as-magits", () => {
  const { root, superDir } = project();
  withRepos([root], () => {
    status(superDir);
    e8.call("magit-submodule" as e8.CommandName);
    const text = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    e8.executeKbdMacro("C-g");
    for (const line of [
      "Arguments",
      " -f Force (--force)",
      " -U Use upstream tip (--remote)",
      "One module actions",
      " a Add            git submodule add [--force]",
      " r Register       git submodule init",
      " k Remove",
      "Populated modules actions",
      " l List modules",
      " f Fetch modules",
    ])
      should(text.includes(line), `the menu has ${JSON.stringify(line)}:\n${text}`);
  });
});

ertDeftest("magit-submodule-add-adds-the-module-and-absorbs-its-gitdir", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      shouldEqual(git(superDir, "config", "-f", ".gitmodules", "--get", "submodule.lib.path").trim(), "lib");
      shouldEqual(git(superDir, "config", "-f", ".gitmodules", "--get", "submodule.lib.url").trim(), lib);
      shouldEqual(git(`${superDir}lib`, "log", "--format=%s").trim(), "Two\nOne");
    }),
  );
});

ertDeftest("magit-submodule-unpopulate-register-and-populate", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      // Unpopulate: deinit takes away the working tree and the url.
      mx("magit-submodule-unpopulate", "lib");
      idle(superDir);
      should(!e8.fileExistsP(`${superDir}lib/.git`), "the working tree is gone");
      shouldEqual(git(superDir, "config", "--get", "submodule.lib.url"), "");
      // Register: init puts the url back, still with no working tree.
      mx("magit-submodule-register", "lib");
      idle(superDir);
      shouldEqual(git(superDir, "config", "--get", "submodule.lib.url").trim(), lib);
      should(!e8.fileExistsP(`${superDir}lib/.git`), "registering does not populate");
      // Populate: update --init checks out the recorded commit.
      mx("magit-submodule-populate", "lib");
      idle(superDir);
      should(e8.fileExistsP(`${superDir}lib/two.txt`), "the module is populated");
      shouldEqual(git(`${superDir}lib`, "rev-parse", "HEAD"), git(lib, "rev-parse", "HEAD"));
    }),
  );
});

ertDeftest("magit-submodule-update-checks-out-the-recorded-commit", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      const recorded = git(lib, "rev-parse", "HEAD");
      git(`${superDir}lib`, "checkout", "-q", "HEAD~1");
      should(git(`${superDir}lib`, "rev-parse", "HEAD") !== recorded, "the module is elsewhere");
      mx("magit-submodule-update", "lib");
      idle(superDir);
      shouldEqual(git(`${superDir}lib`, "rev-parse", "HEAD"), recorded);
    }),
  );
});

ertDeftest("magit-submodule-synchronize-takes-the-url-from-gitmodules", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      const other = `${root}elsewhere`;
      git(superDir, "config", "-f", ".gitmodules", "submodule.lib.url", other);
      mx("magit-submodule-synchronize", "lib");
      idle(superDir);
      shouldEqual(git(superDir, "config", "--get", "submodule.lib.url").trim(), other);
      shouldEqual(git(`${superDir}lib`, "config", "--get", "remote.origin.url").trim(), other);
    }),
  );
});

ertDeftest("magit-submodule-remove-removes-the-module", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      mx("magit-submodule-remove", "lib");
      should(!e8.fileExistsP(`${superDir}lib`), "the working tree is gone");
      shouldEqual(git(superDir, "config", "-f", ".gitmodules", "--get-regexp", "submodule"), "");
      shouldEqual(git(superDir, "status", "--porcelain").split("\n").filter((l) => l !== "").sort(), ["D  lib", "M  .gitmodules"]);
      // The gitdir is kept, without a prefix argument.
      should(e8.fileDirectoryP(`${superDir}.git/modules/lib`), "the module's gitdir is kept");
    }),
  );
});

ertDeftest("magit-submodule-remove-omits-a-dirty-module", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      write(`${superDir}lib`, "one.txt", "changed");
      mx("magit-submodule-remove", "lib");
      shouldEqual(e8.messages().at(-1), "Omitting module lib, it has uncommitted changes");
      should(e8.fileExistsP(`${superDir}lib/one.txt`), "the dirty module is kept");
    }),
  );
});

ertDeftest("magit-list-submodules-lists-the-populated-modules", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      e8.call("magit-list-submodules" as e8.CommandName);
      shouldEqual(e8.bufferName(), `magit-submodule-list: super`);
      shouldEqual(String(e8.variable("major-mode")), "magit-submodule-list-mode");
      const line = e8.bufferText().split("\n")[0];
      should(/^lib +[0-9]{8}\.[0-9]{4}-g[0-9a-f]+ +main\b/.test(line), `the line is lib's path, version and branch: ${JSON.stringify(line)}`);
      shouldEqual(e8.getTextProperty(e8.pointMin(), "tabulated-list-id"), `${superDir}lib/`);
    }),
  );
});

ertDeftest("magit-insert-modules-shows-the-overview-and-unpushed-commits", () => {
  const { root, superDir, lib } = project();
  withRepos([root], () =>
    allowingFileProtocol(() => {
      addLib(superDir, lib);
      write(`${superDir}lib`, "three.txt", "Three");
      git(`${superDir}lib`, "add", "three.txt");
      git(`${superDir}lib`, "commit", "-q", "-m", "Three");
      e8.letBind({ "magit-status-sections-hook": ["magit-insert-modules"] }, () => {
        status(superDir);
        shouldEqual(e8.bufferText(), "Modules (1)\n");
        gotoText("Modules");
        e8.executeKbdMacro("TAB");
        const text = e8.bufferText();
        should(text.includes("Modules overview (1)\n"), `the overview's heading: ${text}`);
        should(text.includes("Modules unmerged into @{upstream} (1)\n"), `the unpushed modules' heading: ${text}`);
        should(text.includes("lib (1)\n"), `lib's unpushed commit count: ${text}`);
        should(/^[0-9a-f]+ Three$/m.test(text), `lib's unpushed commit: ${text}`);
        should(!text.includes("unpulled"), `no module has unpulled commits: ${text}`);
        gotoText("Modules overview");
        e8.executeKbdMacro("TAB");
        should(/^lib main {22}[0-9a-f]{7,}$/m.test(e8.bufferText()), `the overview's line: ${e8.bufferText()}`);
      });
    }),
  );
});

ertDeftest("magit-insert-modules-inserts-nothing-without-modules", () => {
  const dir = history();
  withRepos([dir], () => {
    e8.letBind({ "magit-status-sections-hook": ["magit-insert-modules"] }, () => {
      status(dir);
      shouldEqual(e8.bufferText(), "");
    });
  });
});
