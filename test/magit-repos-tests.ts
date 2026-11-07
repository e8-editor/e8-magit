// SPDX-License-Identifier: GPL-3.0-or-later
//
// magit-repos's tests, with ERT: the list of repositories with its
// columns, showing a repository's status from it, marking, fetching, the
// column functions, the names of repositories whose basenames clash, and
// magit-status reading a repository among them.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { git, history, init, tempDir, typed, withRepos, write } from "magit-test-helpers";
import {
  magitListReposUniquify,
  magitRepolistColumnBranch,
  magitRepolistColumnFlag,
  magitRepolistColumnFlags,
  magitRepolistColumnVersion,
  magitRepolistMarkedRepos,
  magitRepolistVersionLess,
  magitReposAlist,
} from "magit-repos";

/** Makes DIR a repository of one commit. */
function commitIn(dir: string, file = "a.txt"): void {
  e8.makeDirectory(dir, { parents: true });
  init(dir);
  write(dir, file, "a\n");
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", "First");
}

/** A directory holding the repositories alpha, nested/beta, and x/lib and y/lib, whose names clash. */
function tree(): string {
  const root = tempDir();
  for (const d of ["alpha", "nested/beta", "x/lib", "y/lib"]) commitIn(`${root}${d}/`);
  e8.makeDirectory(`${root}plain`, { parents: true });
  return root;
}

/** Runs BODY with magit-repository-directories naming ROOT to DEPTH. */
const listing = (root: string, depth: number, body: () => void): void => e8.letBind({ "magit-repository-directories": [[root, depth]] }, body);

/** The faces of a propertized string's characters, as [from, to, face] runs. */
const faces = (s: e8.PropertizedString | string | undefined): [number, number, e8.Value][] =>
  s instanceof e8.PropertizedString ? s.properties.map(([a, b, p]) => [a, b, p.face]) : [];

ertDeftest("magit-list-repositories-needs-repository-directories", () => {
  e8.letBind({ "magit-repository-directories": [] }, () => {
    let error = "";
    try {
      e8.call("magit-list-repositories" as e8.CommandName);
    } catch (e) {
      error = String(e);
    }
    should(error.includes("You need to customize `magit-repository-directories' before you can list repositories"), error);
  });
});

ertDeftest("magit-list-repositories-lists-each-repository-found", () => {
  const root = tree();
  withRepos([root], () =>
    listing(root, 2, () => {
      e8.call("magit-list-repositories" as e8.CommandName);
      shouldEqual(e8.bufferName(), "*Magit Repositories*");
      shouldEqual(String(e8.variable("major-mode")), "magit-repolist-mode");
      should(e8.derivedModeP("tabulated-list-mode"), "the list is a tabulated list");
      const lines = e8.bufferText().split("\n").filter((l) => l !== "");
      shouldEqual(lines.length, 4);
      // Sorted by path; the names whose basenames clash take their parents' names.
      const names = lines.map((l) => l.split(/ +/)[0]);
      shouldEqual(names, ["alpha", "beta", "lib\\x", "lib\\y"]);
      should(/^alpha +[0-9]{8}\.[0-9]{4}-g[0-9a-f]+ +.*alpha\/$/.test(lines[0]), `alpha's line: ${JSON.stringify(lines[0])}`);
      shouldEqual(e8.getTextProperty(e8.pointMin(), "tabulated-list-id"), `${root}alpha/`);
      should(!lines.some((l) => l.includes("plain")), "a directory that is no repository is left out");
    }),
  );
});

ertDeftest("magit-list-repositories-looks-only-as-deep-as-told", () => {
  const root = tree();
  withRepos([root], () => {
    listing(root, 1, () => shouldEqual(magitReposAlist().map(([n]) => n).sort(), ["alpha"]));
    listing(root, 0, () => shouldEqual(magitReposAlist(), []));
    e8.letBind({ "magit-repository-directories": [[`${root}alpha`, 0]] }, () => shouldEqual(magitReposAlist(), [["alpha", `${root}alpha/`]]));
  });
});

ertDeftest("magit-list-repos-uniquify-names-clashes-by-their-parents", () => {
  shouldEqual(
    magitListReposUniquify([
      ["foo", "/a/b/foo/"],
      ["bar", "/a/bar/"],
      ["foo", "/a/c/foo/"],
      ["foo", "/b/b/foo/"],
    ])
      .map(([n, d]) => `${n} ${d}`)
      .sort(),
    ["bar /a/bar/", "foo\\b\\a /a/b/foo/", "foo\\b\\b /b/b/foo/", "foo\\c /a/c/foo/"],
  );
});

ertDeftest("magit-repolist-status-shows-the-repository-at-point", () => {
  const root = tree();
  withRepos([root], () =>
    listing(root, 2, () => {
      e8.call("magit-list-repositories" as e8.CommandName);
      e8.executeKbdMacro("C-n RET");
      shouldEqual(e8.bufferName(), "magit: beta");
      shouldEqual(String(e8.variable("major-mode")), "magit-status-mode");
    }),
  );
});

ertDeftest("magit-repolist-mark-and-unmark-tag-lines", () => {
  const root = tree();
  withRepos([root], () =>
    listing(root, 2, () => {
      e8.call("magit-list-repositories" as e8.CommandName);
      shouldEqual(e8.variable("tabulated-list-padding"), 0);
      e8.executeKbdMacro("m");
      shouldEqual(e8.variable("tabulated-list-padding"), 2);
      shouldEqual(e8.lineOf(e8.point()), 1);
      e8.executeKbdMacro("C-n m");
      shouldEqual(e8.bufferText().split("\n")[0].slice(0, 7), "* alpha");
      shouldEqual(e8.bufferText().split("\n")[2].slice(0, 6), "* lib\\");
      shouldEqual(magitRepolistMarkedRepos("*"), [`${root}x/lib/`, `${root}alpha/`]);
      shouldEqual(magitRepolistMarkedRepos(), [["*", `${root}x/lib/`], ["*", `${root}alpha/`]]);
      e8.executeKbdMacro("M-< u");
      shouldEqual(e8.bufferText().split("\n")[0].slice(0, 7), "  alpha");
      shouldEqual(magitRepolistMarkedRepos("*"), [`${root}x/lib/`]);
    }),
  );
});

/** A directory holding origin, a bare repository, and clone, which tracks it, one commit behind once origin has moved. */
function behind(): { root: string; clone: string } {
  const root = tempDir();
  const origin = `${root}origin/`;
  e8.makeDirectory(origin, { parents: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  const work = `${root}work/`;
  commitIn(work);
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", origin, `${root}clone`);
  const clone = `${root}clone/`;
  write(work, "b.txt", "b\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-q", "-m", "Second");
  git(work, "push", "-q", "origin", "main");
  return { root, clone };
}

ertDeftest("magit-repolist-fetch-fetches-the-marked-repositories", () => {
  const { root, clone } = behind();
  withRepos([root], () =>
    e8.letBind({ "magit-repository-directories": [[clone, 0]] }, () => {
      e8.call("magit-list-repositories" as e8.CommandName);
      const line = () => e8.bufferText().split("\n")[0];
      should(/^ *clone .* 0 +0 /.test(line()), `nothing to pull before the fetch: ${JSON.stringify(line())}`);
      e8.executeKbdMacro("m f");
      should(/ 1 +0 /.test(line()), `one commit to pull after it: ${JSON.stringify(line())}`);
      shouldEqual(git(clone, "rev-parse", "origin/main"), git(`${root}origin/`, "rev-parse", "main"));
      shouldEqual(e8.messages().at(-1), `(1/1) Fetching in ${clone}...done`);
    }),
  );
});

ertDeftest("magit-repolist-fetch-asks-before-fetching-every-repository", () => {
  const { root, clone } = behind();
  withRepos([root], () =>
    e8.letBind({ "magit-repository-directories": [[clone, 0], [`${root}work`, 0]] }, () => {
      e8.call("magit-list-repositories" as e8.CommandName);
      let error = "";
      try {
        e8.executeKbdMacro("f n");
      } catch (e) {
        error = String(e);
      }
      should(error.includes("Quit"), `answering no quits: ${error}`);
      shouldEqual(git(clone, "rev-parse", "origin/main"), git(clone, "rev-parse", "main"));
      e8.executeKbdMacro("f y");
      shouldEqual(git(clone, "rev-parse", "origin/main"), git(`${root}origin/`, "rev-parse", "main"));
      shouldEqual(e8.messages().at(-1), `(2/2) Fetching in ${root}work/...done`);
    }),
  );
});

ertDeftest("magit-repolist-column-version-describes-head", () => {
  const dir = history();
  withRepos([dir], () =>
    e8.letBind({ "default-directory": dir }, () => {
      const date = magitRepolistColumnVersion();
      should(/^ [0-9]{8}\.[0-9]{4}-g[0-9a-f]+$/.test(String(date)), `without tags, the date: ${String(date)}`);
      git(dir, "tag", "v1.0", "HEAD~");
      const v = magitRepolistColumnVersion()!;
      should(/^v1\.0-1-g[0-9a-f]+$/.test(String(v)), String(v));
      const hashEnd = String(v).length;
      shouldEqual(faces(v), [[0, 1, "shadow"], [4, 5, "shadow"], [5, 6, "bold"], [6, hashEnd, "shadow"]]);
      write(dir, "one.txt", "changed");
      const dirty = magitRepolistColumnVersion()!;
      should(String(dirty).endsWith("-dirty"), String(dirty));
      shouldEqual(faces(dirty).at(-1), [6, String(dirty).length, "error"]);
      git(dir, "checkout", "-q", "--", ".");
      git(dir, "tag", "v2.0");
      shouldEqual(String(magitRepolistColumnVersion()), "v2.0");
      git(dir, "commit", "-q", "--allow-empty", "-m", "Resume development");
      shouldEqual(String(magitRepolistColumnVersion()), "v2.0+");
    }),
  );
});

ertDeftest("magit-repolist-version<-compares-the-dotted-numbers", () => {
  should(magitRepolistVersionLess("v1.2", "v1.10"));
  should(!magitRepolistVersionLess("v1.10", "v1.2"));
  should(!magitRepolistVersionLess("1.0", "1.0"));
  should(magitRepolistVersionLess("none", "none"), "neither has a version");
  should(!magitRepolistVersionLess("none", "1.0"));
  should(magitRepolistVersionLess("1.0", "none"));
});

ertDeftest("magit-repolist-columns-of-branches-flags-and-counts", () => {
  const dir = history();
  withRepos([dir], () =>
    e8.letBind({ "default-directory": dir }, () => {
      shouldEqual(faces(magitRepolistColumnBranch() as e8.PropertizedString), [[0, 4, "shadow"]]);
      git(dir, "checkout", "-q", "-b", "topic");
      shouldEqual(magitRepolistColumnBranch(), "topic");
      shouldEqual(magitRepolistColumnFlag(), undefined);
      shouldEqual(magitRepolistColumnFlags(), "   ");
      write(dir, "new.txt", "new");
      write(dir, "one.txt", "changed");
      shouldEqual(magitRepolistColumnFlag(), "N");
      shouldEqual(magitRepolistColumnFlags(), "NU ");
      git(dir, "add", "one.txt");
      shouldEqual(magitRepolistColumnFlags(), "N S");
      const spec = [[":width", 3]] as [string, e8.Value][];
      shouldEqual(String(e8.funcall("magit-repolist-column-branches", spec)), "2");
      shouldEqual(faces(e8.funcall("magit-repolist-column-branches", spec) as e8.PropertizedString), [[0, 1, "bold"]]);
      shouldEqual(faces(e8.funcall("magit-repolist-column-stashes", spec) as e8.PropertizedString), [[0, 1, "shadow"]]);
      shouldEqual(String(e8.funcall("magit-repolist-column-ident", [[":id", "name"]])), "name");
      shouldEqual(e8.funcall("magit-repolist-column-upstream", spec) ?? null, null);
    }),
  );
});

ertDeftest("magit-status-with-a-prefix-reads-a-listed-repository", () => {
  const root = tree();
  withRepos([root], () =>
    listing(root, 2, () => {
      e8.call("switch-to-buffer", "*magit-test*");
      e8.setVariable("default-directory", `${root}alpha/`);
      e8.executeKbdMacro(`C-u M-x ${typed("magit-status")} RET ${typed("lib\\y")} RET`);
      shouldEqual(e8.bufferName(), "magit: lib");
      shouldEqual(e8.variable("default-directory"), `${root}y/lib/`);
    }),
  );
});

ertDeftest("magit-repolist-find-file-other-frame-visits-the-file-in-each-marked-repository", () => {
  const root = tree();
  withRepos([root], () =>
    listing(root, 2, () => {
      e8.call("magit-list-repositories" as e8.CommandName);
      const frames = e8.frameList().length;
      e8.executeKbdMacro(`m m 5 ${typed("a.txt")} RET`);
      try {
        shouldEqual(e8.frameList().length, frames + 2);
        for (const d of ["alpha", "nested/beta"]) {
          const visiting = e8.bufferList().some((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === `${root}${d}/a.txt`);
          should(visiting, `a.txt of ${d} is visited`);
        }
      } finally {
        while (e8.frameList().length > frames) e8.call("delete-frame");
      }
    }),
  );
});
