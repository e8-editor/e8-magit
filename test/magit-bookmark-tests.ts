// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of magit-bookmark.ts, after magit-bookmark.el: a Magit buffer's
// bookmark record names it as Magit does and records its arguments and
// hidden sections, and the record makes the buffer again.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitBookmarkName, magitHandleBookmark, magitMakeBookmark } from "magit-bookmark";
import { magitDiffSetupBuffer, magitRevisionSetupBuffer } from "magit-diff";
import { magitRootSection } from "magit-section";
import { git, gotoText, history, repo, status, withRepos } from "magit-test-helpers";

const repoName = (dir: string): string => e8.fileNameNondirectory(dir.replace(/\/$/, ""));

/** Kills the current buffer and makes it again from its bookmark; gives the record and the new buffer. */
function roundTrip(): [ReturnType<typeof magitMakeBookmark>, string] {
  const record = magitMakeBookmark();
  const name = e8.bufferName();
  e8.call("kill-buffer", name);
  should(!e8.bufferLiveP(e8.getBuffer(name)), "the buffer is gone");
  const buffer = magitHandleBookmark(record);
  shouldEqual(buffer, name);
  return [record, buffer];
}

ertDeftest("magit-bookmark-of-the-status-buffer-keeps-hidden-sections", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    shouldEqual(e8.variable("bookmark-make-record-function"), "magit--make-bookmark");
    shouldEqual(magitBookmarkName(), "magit-status");
    gotoText("Staged changes");
    e8.executeKbdMacro("TAB");
    const [record, buffer] = roundTrip();
    shouldEqual(record.mode, "magit-status-mode");
    shouldEqual(record.filename, dir);
    shouldEqual(record.defaults, ["magit-status"]);
    shouldEqual(record.handler, "magit--handle-bookmark");
    // The untracked files are hidden as they start, and staged ones as hidden here.
    const hidden = record["magit-hidden-sections"] as [string, unknown][];
    should(hidden.some(([t]) => t === "staged") && hidden.some(([t]) => t === "untracked") && !hidden.some(([t]) => t === "unstaged"), JSON.stringify(hidden));
    e8.withCurrentBuffer(buffer, () => {
      shouldEqual(String(e8.variable("major-mode")), "magit-status-mode");
      shouldEqual(e8.bufferName(), `magit: ${repoName(dir)}`);
      const sections = magitRootSection()!.children;
      shouldEqual(sections.find((c) => c.type === "staged")?.hidden, true);
      shouldEqual(sections.find((c) => c.type === "unstaged")?.hidden, false);
    });
  });
});

ertDeftest("magit-bookmark-of-a-log-records-its-revisions-and-files", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    e8.call("magit-log-current" as e8.CommandName);
    shouldEqual(magitBookmarkName(), "magit-log(main)");
    e8.setVariable("magit-buffer-log-files", ["two.txt"]);
    shouldEqual(magitBookmarkName(), "magit-log(main -- two.txt)");
    const [record, buffer] = roundTrip();
    shouldEqual(record["magit-buffer-revisions"], ["main"]);
    shouldEqual(record["magit-buffer-log-files"], ["two.txt"]);
    e8.withCurrentBuffer(buffer, () => {
      shouldEqual(String(e8.variable("major-mode")), "magit-log-mode");
      shouldEqual(e8.variable("magit-buffer-log-files"), ["two.txt"]);
      should(e8.bufferText().includes("Two") && !e8.bufferText().includes("Three"), e8.bufferText());
    });
  });
});

ertDeftest("magit-bookmark-of-diff-and-revision-buffers", () => {
  const dir = history();
  withRepos([dir], () => {
    status(dir);
    const head = git(dir, "rev-parse", "HEAD").trim();
    const revision = magitRevisionSetupBuffer("HEAD", [], []);
    e8.withCurrentBuffer(revision, () => {
      shouldEqual(magitBookmarkName(), `magit-revision(${git(dir, "rev-parse", "--short", "HEAD").trim()} Three)`);
      const [record, buffer] = roundTrip();
      shouldEqual(record["magit-buffer-revision-hash"], head);
      e8.withCurrentBuffer(buffer, () => should(e8.bufferText().includes("three.txt"), e8.bufferText()));
    });
    status(dir);
    const diff = magitDiffSetupBuffer("HEAD~2..HEAD", undefined, [], []);
    e8.withCurrentBuffer(diff, () => {
      shouldEqual(magitBookmarkName(), "magit-diff(HEAD~2..HEAD)");
      const [record, buffer] = roundTrip();
      should(String(record["magit-buffer-range-hashed"]).includes(".."), String(record["magit-buffer-range-hashed"]));
      e8.withCurrentBuffer(buffer, () => {
        shouldEqual(String(e8.variable("major-mode")), "magit-diff-mode");
        should(e8.bufferText().includes("two.txt") && e8.bufferText().includes("three.txt"), e8.bufferText());
      });
    });
  });
});

ertDeftest("magit-bookmark-is-refused-for-a-buffer-without-one", () => {
  const dir = repo();
  withRepos([dir], () => {
    status(dir);
    e8.executeKbdMacro("$");
    const process = e8.bufferList().find((b) => b.startsWith("magit-process"))!;
    let error = "";
    e8.withCurrentBuffer(process, () => {
      try {
        magitMakeBookmark();
      } catch (e) {
        error = String(e);
      }
    });
    should(error.includes("Bookmarking is not implemented for magit-process-mode buffers"), error);
  });
});
