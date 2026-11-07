// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of bundles, after magit-bundle.el.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitBundleCreateFile, magitBundleCreateTrackedFile, magitBundleUpdateTrackedTag } from "magit-bundle";
import { git, history, status, withRepos, write } from "magit-test-helpers";

ertDeftest("magit-bundles-are-created-tracked-and-updated", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    magitBundleCreateFile(`${dir}all.bundle`, [], ["--all"]);
    should(git(dir, "bundle", "verify", `${dir}all.bundle`).includes("okay"), "the bundle verifies");
    magitBundleCreateTrackedFile(`${dir}main.bundle`, "bundled", "main", [], []);
    shouldEqual(git(dir, "rev-parse", "bundled^{commit}"), git(dir, "rev-parse", "main"));
    should(git(dir, "tag", "-n9", "bundled").includes(";; git-bundle tracking"), "the tag says what it tracks");
    write(dir, "four.txt", "Four");
    git(dir, "add", "four.txt");
    git(dir, "commit", "-q", "-m", "Four");
    magitBundleUpdateTrackedTag("bundled");
    shouldEqual(git(dir, "rev-parse", "bundled^{commit}"), git(dir, "rev-parse", "main"));
    // The update bundles only what came after the tag.
    should(git(dir, "bundle", "list-heads", `${dir}main.bundle`).includes("refs/heads/main"), "the update bundles main");
  });
});

ertDeftest("magit-the-bundle-menu-shows-magits-actions", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.call("magit-bundle" as e8.CommandName);
    const menu = e8.withCurrentBuffer(" *transient*", () => e8.bufferText());
    shouldEqual(menu, "Actions\n c create\n v verify\n l list-heads\n");
    e8.executeKbdMacro("C-g");
  });
});
