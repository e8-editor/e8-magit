// SPDX-License-Identifier: GPL-3.0-or-later
//
// The git layer's tests (magit-git.ts): each question put to the remote
// fixture of test/fixtures.sh, whose hashes are fixed, and the refresh
// cache answering a question asked twice once.

import { ertDeftest, should, shouldEqual } from "ert";

import * as git from "magit-git";

e8.require("magit");

/** Runs BODY in fixture NAME's repository, then deletes it. */
function inFixture(name: string, body: () => void): void {
  const dirs = (e8.variable("load-path") as string[]) ?? [];
  const script = dirs.map((d) => e8.expandFileName("test/fixtures.sh", d)).find((f) => e8.fileExistsP(f))!;
  const dir = e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-git", { dir: true })));
  should(e8.callProcess(["sh", script, name, dir]).exit === 0);
  const old = e8.variable("default-directory");
  try {
    e8.setVariable("default-directory", `${dir}repo/`);
    body();
  } finally {
    e8.setVariable("default-directory", old ?? null);
    e8.deleteDirectory(dir, { recursive: true });
  }
}

ertDeftest("magit-git-branches-upstreams-and-remotes", () => {
  inFixture("remote", () => {
    shouldEqual(git.magitGetCurrentBranch(), "main");
    shouldEqual(git.magitGetUpstreamBranch(), "origin/main");
    shouldEqual(git.magitGetUpstreamRemote(), "origin");
    shouldEqual(git.magitGetRemote(), "origin");
    shouldEqual(git.magitListRemotes(), ["origin"]);
    shouldEqual(git.magitListLocalBranchNames(), ["feature", "main"]);
    shouldEqual(git.magitListRemoteBranchNames(), ["origin/main"]);
    shouldEqual(git.magitListBranchNames(), ["feature", "main", "origin/main"]);
    shouldEqual(git.magitLocalBranchP("feature"), "feature");
    shouldEqual(git.magitRemoteBranchP("origin/main"), "origin/main");
    shouldEqual(git.magitSplitBranchName("origin/main"), ["origin", "main"]);
    shouldEqual(git.magitSplitBranchName("feature"), [".", "feature"]);
    shouldEqual(git.magitPrimaryRemote(), "origin");
    shouldEqual(git.magitMainBranch(), "main");
    shouldEqual(git.magitGetPushRemote(), undefined);
    git.magitSet("origin", "remote.pushDefault");
    shouldEqual(git.magitGetPushRemote(), "origin");
    shouldEqual(git.magitGetPushBranch(), "origin/main");
    git.magitSet(undefined, "remote.pushDefault");
    shouldEqual(git.magitGet("remote.pushDefault"), undefined);
  });
});

ertDeftest("magit-git-revisions-tags-and-stashes", () => {
  inFixture("remote", () => {
    shouldEqual(git.magitRevParse("--short", "HEAD"), "e6b47a8");
    shouldEqual(git.magitRevAbbrev("HEAD"), "e6b47a8");
    shouldEqual(git.magitAbbrevLength(), 7);
    should(git.magitCommitP("HEAD") !== undefined);
    shouldEqual(git.magitCommitP("no-such-rev"), undefined);
    should(git.magitRevAncestorP("origin/main~1", "HEAD"));
    should(!git.magitRevAncestorP("origin/main", "HEAD"));
    shouldEqual(git.magitRevDiffCount("HEAD", "origin/main"), [1, 1]);
    shouldEqual(git.magitRevFormat("%s"), "Local commit");
    shouldEqual(git.magitListTags(), ["v0.1"]);
    shouldEqual(git.magitGetCurrentTag(), "v0.1");
    shouldEqual(git.magitGetCurrentTag(undefined, true), ["v0.1", 3]);
    shouldEqual(git.magitListStashes(), ["stash@{0}", "stash@{1}"]);
    shouldEqual(git.magitCommitParents("HEAD").length, 1);
    should(!git.magitMergeCommitP("HEAD"));
    shouldEqual(git.magitListBranchesPointingAt("HEAD~1"), ["feature"]);
    shouldEqual(git.magitSplitRange("HEAD~1..HEAD"), ["HEAD~1", "HEAD"]);
    shouldEqual(git.magitGetShortname("HEAD~1"), "feature");
  });
});

ertDeftest("magit-git-files-and-state", () => {
  inFixture("basic", () => {
    shouldEqual(git.magitUntrackedFiles(), ["c.txt"]);
    shouldEqual(git.magitUnstagedFiles(), ["a.txt"]);
    shouldEqual(git.magitStagedFiles(), ["b.txt"]);
    shouldEqual(git.magitModifiedFiles(), ["a.txt", "b.txt"]);
    shouldEqual(git.magitTrackedFiles(), ["a.txt", "b.txt"]);
    should(git.magitAnythingStagedP());
    should(git.magitAnythingUnstagedP());
    should(!git.magitAnythingUnmergedP());
    should(!git.magitRebaseInProgressP());
    should(git.magitInsideWorktreeP());
    should(!git.magitBareRepoP());
    shouldEqual(git.magitFileRelativeName(e8.expandFileName("a.txt", String(e8.variable("default-directory")))), "a.txt");
  });
  inFixture("rebase", () => {
    should(git.magitRebaseInProgressP());
    shouldEqual(git.magitUnmergedFiles(), ["a.txt"]);
    should(git.magitAnythingUnmergedP());
  });
  inFixture("merge", () => {
    should(git.magitMergeInProgressP());
    should(!git.magitRebaseInProgressP());
  });
});

ertDeftest("magit-git-ref-labels", () => {
  inFixture("remote", () => {
    // HEAD is main, which tracks origin/main; feature is elsewhere.
    const text = (rev: string) => {
      const d = git.magitGitString("log", "-1", "--format=%D", "--decorate=full", rev) ?? "";
      const l = git.magitFormatRefLabels(d);
      return typeof l === "string" ? l : l.string;
    };
    shouldEqual(text("HEAD"), "main");
    shouldEqual(text("origin/main"), "origin/main");
    shouldEqual(text("feature"), "feature");
  });
});

ertDeftest("magit-git-the-refresh-cache-asks-once", () => {
  inFixture("remote", () => {
    git.magitWithRefreshCache(() => {
      git.magitGetUpstreamBranch();
      git.magitGetUpstreamBranch();
      git.magitGet("branch.main.remote");
      git.magitGet("branch.main.merge");
    });
    const stats = git.magitRefreshCacheStats();
    should(stats.hits >= 2, `hits ${stats.hits}`);
    // Outside a refresh, nothing is cached: a change is seen at once.
    git.magitSet("x", "magit.test");
    shouldEqual(git.magitGet("magit.test"), "x");
    git.magitSet("y", "magit.test");
    shouldEqual(git.magitGet("magit.test"), "y");
  });
});

ertDeftest("magit-git-reading-a-branch-offers-magits-default", () => {
  inFixture("remote", () => {
    e8.unreadKeys("RET");
    shouldEqual(git.magitReadBranch("Checkout"), "main");
    e8.unreadKeys("f e a t u r e RET");
    shouldEqual(git.magitReadOtherBranch("Merge"), "feature");
  });
});
