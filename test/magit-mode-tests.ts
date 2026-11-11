// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of Magit's buffers, after magit-mode.el and magit.el: the window
// layout each magit-display-buffer-function makes showing a status buffer
// then a diff buffer, magit-display-buffer-noselect, burying with each
// magit-bury-buffer-function, the refresh hooks and verbose refreshing,
// magit-info and magit-version.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitVersion } from "magit";
import { git, repo, typed, withRepos } from "magit-test-helpers";

/** The selected frame's windows: a buffer's name, or [side-by-side, first, second]. */
type Layout = string | [boolean, Layout, Layout];
function layout(): Layout {
  const node = (t: e8.WindowTreeNode): Layout => (!Array.isArray(t) ? (e8.windowBuffer(t) ?? "") : [t[0], node(t[2]), node(t[3])]);
  return node(e8.windowTree());
}
const selected = (): string => e8.windowBuffer(e8.selectedWindow()) ?? "";

/** Starts in *magit-test*, in DIR, in a window of its own, after splitting it as SPLIT says. */
function start(dir: string, split?: "below" | "right"): void {
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", "*magit-test*");
  e8.setVariable("default-directory", dir);
  // The window outlives earlier tests: it was not made for Magit here.
  e8.setWindowParameter(e8.selectedWindow(), "magit-dedicated", null);
  if (split) {
    e8.splitWindow(e8.selectedWindow(), split);
    e8.selectWindow(e8.windowList()[0]);
  }
}
const showStatus = () => e8.call("magit-status" as e8.CommandName);
const showDiff = () => e8.call("magit-diff-unstaged" as e8.CommandName);

ertDeftest("magit-display-buffer-traditional-shows-status-and-diff-in-other-windows", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
    showStatus();
    shouldEqual(layout(), [false, "*magit-test*", `magit: ${name}`]);
    shouldEqual(selected(), `magit: ${name}`);
    // The diff goes in the other window, as display-buffer chooses it.
    showDiff();
    shouldEqual(layout(), [false, `magit-diff: ${name}`, `magit: ${name}`]);
    shouldEqual(selected(), `magit-diff: ${name}`);
    // A log, from the diff, takes the diff's window.
    e8.call("magit-log-current" as e8.CommandName);
    shouldEqual(layout(), [false, `magit-log: ${name}`, `magit: ${name}`]);
  });
});

ertDeftest("magit-display-buffer-same-window-except-diff-v1-keeps-the-status-in-its-window", () => {
  const dir = repo();
  withRepos([dir], () =>
    e8.letBind({ "magit-display-buffer-function": "magit-display-buffer-same-window-except-diff-v1" }, () => {
      start(dir);
      const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
      showStatus();
      shouldEqual(layout(), `magit: ${name}`);
      showDiff();
      shouldEqual(layout(), [false, `magit: ${name}`, `magit-diff: ${name}`]);
      shouldEqual(selected(), `magit-diff: ${name}`);
    }),
  );
});

ertDeftest("magit-display-buffer-fullframe-status-v1-fills-the-frame-with-the-status", () => {
  const dir = repo();
  withRepos([dir], () =>
    e8.letBind({ "magit-display-buffer-function": "magit-display-buffer-fullframe-status-v1" }, () => {
      start(dir, "right");
      const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
      showStatus();
      shouldEqual(layout(), `magit: ${name}`);
      showDiff();
      shouldEqual(layout(), [false, `magit: ${name}`, `magit-diff: ${name}`]);
      shouldEqual(selected(), `magit-diff: ${name}`);
    }),
  );
});

ertDeftest("magit-display-buffer-fullframe-status-topleft-v1-puts-the-diff-above", () => {
  const dir = repo();
  withRepos([dir], () =>
    e8.letBind({ "magit-display-buffer-function": "magit-display-buffer-fullframe-status-topleft-v1" }, () => {
      start(dir, "below");
      const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
      showStatus();
      shouldEqual(layout(), `magit: ${name}`);
      showDiff();
      shouldEqual(layout(), [false, `magit-diff: ${name}`, `magit: ${name}`]);
      shouldEqual(selected(), `magit-diff: ${name}`);
      // Burying the diff deletes the window it was put in.
      e8.executeKbdMacro("q");
      shouldEqual(layout(), `magit: ${name}`);
      // A log goes in the selected window.
      e8.call("magit-log-current" as e8.CommandName);
      shouldEqual(layout(), `magit-log: ${name}`);
    }),
  );
});

ertDeftest("magit-display-buffer-fullcolumn-most-v1-takes-the-column", () => {
  const dir = repo();
  withRepos([dir], () =>
    e8.letBind({ "magit-display-buffer-function": "magit-display-buffer-fullcolumn-most-v1" }, () => {
      start(dir, "right");
      e8.splitWindow(e8.selectedWindow(), "below");
      const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
      shouldEqual(layout(), [true, [false, "*magit-test*", "*magit-test*"], "*magit-test*"]);
      showStatus();
      // The windows above and below go; the one beside stays.
      shouldEqual(layout(), [true, `magit: ${name}`, "*magit-test*"]);
      showDiff();
      shouldEqual(layout(), [true, `magit-diff: ${name}`, "*magit-test*"]);
      // From a log, a diff goes where display-buffer puts it, not taking the
      // column: in Emacs, the window that showed the diff before, which is
      // the log's here; E8 before 0.5.9 used the other window.
      e8.call("magit-log-current" as e8.CommandName);
      shouldEqual(layout(), [true, `magit-log: ${name}`, "*magit-test*"]);
      showDiff();
      shouldEqual(e8.windowList().length, 2);
      shouldEqual(selected(), `magit-diff: ${name}`);
    }),
  );
});

ertDeftest("magit-display-buffer-noselect-leaves-the-selected-window", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
    e8.letBind({ "magit-display-buffer-noselect": true }, showStatus);
    shouldEqual(layout(), [false, "*magit-test*", `magit: ${name}`]);
    shouldEqual(selected(), "*magit-test*");
  });
});

ertDeftest("magit-display-buffer-function-may-be-display-buffer-or-a-config's-function", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
    const shown: string[] = [];
    e8.letBind(
      {
        "magit-display-buffer-function": (buffer: string) => {
          shown.push(buffer);
          e8.call("switch-to-buffer", buffer);
          return e8.selectedWindow();
        },
      },
      showStatus,
    );
    shouldEqual(shown, [`magit: ${name}`]);
    shouldEqual(layout(), `magit: ${name}`);
    start(dir);
    e8.letBind({ "magit-display-buffer-function": "display-buffer" }, showStatus);
    shouldEqual(layout(), [false, "*magit-test*", `magit: ${name}`]);
    shouldEqual(selected(), `magit: ${name}`);
  });
});

ertDeftest("magit-mode-bury-buffer-quits-the-window-made-for-magit", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
    showStatus();
    showDiff();
    shouldEqual(layout(), [false, `magit-diff: ${name}`, `magit: ${name}`]);
    e8.executeKbdMacro("q");
    // The diff's window shows what it showed before, and the status is selected again.
    shouldEqual(layout(), [false, "*magit-test*", `magit: ${name}`]);
    shouldEqual(selected(), `magit: ${name}`);
    e8.executeKbdMacro("q");
    // The status was the last Magit buffer shown in a window made for Magit: it goes.
    shouldEqual(layout(), "*magit-test*");
    should(e8.bufferLiveP(e8.getBuffer(`magit: ${name}`)), "burying keeps the buffer");
    showStatus();
    e8.executeKbdMacro("C-u q");
    should(!e8.bufferLiveP(e8.getBuffer(`magit: ${name}`)), "with a prefix argument the buffer is killed");
  });
});

ertDeftest("magit-mode-bury-buffer-with-two-prefixes-kills-the-repository's-buffers", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
    showStatus();
    showDiff();
    e8.executeKbdMacro("C-u C-u q");
    for (const b of [`magit: ${name}`, `magit-diff: ${name}`]) should(!e8.bufferLiveP(e8.getBuffer(b)), `${b} is killed`);
  });
});

ertDeftest("magit-restore-window-configuration-puts-the-windows-back", () => {
  const dir = repo();
  withRepos([dir], () =>
    e8.letBind({ "magit-bury-buffer-function": "magit-restore-window-configuration", "magit-display-buffer-function": "magit-display-buffer-fullframe-status-v1" }, () => {
      start(dir, "right");
      e8.call("switch-to-buffer", "*Messages*");
      const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
      showStatus();
      shouldEqual(layout(), `magit: ${name}`);
      e8.executeKbdMacro("q");
      shouldEqual(layout(), [true, "*Messages*", "*magit-test*"]);
      shouldEqual(selected(), "*Messages*");
    }),
  );
});

ertDeftest("magit-refresh-runs-its-hooks-around-refreshing", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    showStatus();
    const ran: string[] = [];
    const pre = () => ran.push(`pre ${String(e8.variable("major-mode"))}`);
    const post = () => ran.push("post");
    const buffer = () => ran.push(`buffer ${e8.bufferName()}`);
    e8.addHook("magit-pre-refresh-hook", pre);
    e8.addHook("magit-post-refresh-hook", post);
    e8.addHook("magit-refresh-buffer-hook", buffer);
    try {
      e8.executeKbdMacro("g");
    } finally {
      e8.removeHook("magit-pre-refresh-hook", pre);
      e8.removeHook("magit-post-refresh-hook", post);
      e8.removeHook("magit-refresh-buffer-hook", buffer);
    }
    shouldEqual(ran, ["pre magit-status-mode", `buffer ${e8.bufferName()}`, "post"]);
  });
});

ertDeftest("magit-refresh-verbose-says-how-long-refreshing-took", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    showStatus();
    const before = e8.messages().length;
    e8.executeKbdMacro(`M-x ${typed("magit-toggle-verbose-refresh")} RET`);
    shouldEqual(e8.messages().at(-1), "Enabled verbose refreshing");
    try {
      e8.executeKbdMacro("g");
    } finally {
      e8.setVariable("magit-refresh-verbose", false);
    }
    const said = e8.messages().slice(before);
    should(said.includes("Refreshing magit..."), said.join("\n"));
    should(said.includes(`Refreshing buffer \`${e8.bufferName()}'...`), said.join("\n"));
    should(said.some((m) => /^Refreshing buffer `.*'\.\.\.done \([0-9]+\.[0-9]{3}s\)$/.test(m)), said.join("\n"));
    should(said.includes("Running magit-pre-refresh-hook..."), said.join("\n"));
    should(said.some((m) => /^Running magit-post-refresh-hook\.\.\.done \([0-9]+\.[0-9]{3}s\)$/.test(m)), said.join("\n"));
    should(said.some((m) => /^Refreshing magit\.\.\.done \([0-9]+\.[0-9]{3}s, cached [0-9]+\/[0-9]+ \([0-9]+%\)\)$/.test(m)), said.join("\n"));
    e8.executeKbdMacro(`M-x ${typed("magit-toggle-verbose-refresh")} RET`);
    shouldEqual(e8.messages().at(-1), "Enabled verbose refreshing");
    e8.executeKbdMacro(`M-x ${typed("magit-toggle-verbose-refresh")} RET`);
    shouldEqual(e8.messages().at(-1), "Disabled verbose refreshing");
  });
});

ertDeftest("magit-refresh-status-buffer-nil-leaves-the-status-alone", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    showStatus();
    showDiff();
    const name = e8.fileNameNondirectory(e8.directoryFileName(dir));
    git(dir, "add", "c.txt");
    e8.letBind({ "magit-refresh-status-buffer": false }, () => e8.executeKbdMacro("g"));
    should(e8.withCurrentBuffer(`magit: ${name}`, () => e8.bufferText()).includes("Untracked files"), "the status is not refreshed");
    e8.executeKbdMacro("g");
    should(!e8.withCurrentBuffer(`magit: ${name}`, () => e8.bufferText()).includes("Untracked files"), "now it is");
  });
});

ertDeftest("magit-info-says-where-the-manual-is", () => {
  const dir = repo();
  withRepos([dir], () => {
    start(dir);
    showStatus();
    // h h, magit-dispatch's Help, runs it too; batch's frame is too short to show that menu.
    e8.executeKbdMacro(`M-x ${typed("magit-info")} RET`);
    shouldEqual(e8.messages().at(-1), "The Magit manual is at https://magit.vc/manual/magit/");
  });
});

ertDeftest("magit-version-describes-the-package's-repository", () => {
  const path = (e8.variable("load-path") as string[]).map((d) => e8.fileNameAsDirectory(e8.expandFileName(d)));
  const dir = path.find((d) => e8.fileExistsP(`${d}magit.ts`))!;
  const described = e8.callProcess(["git", "describe", "--tags", "--dirty", "--always"], { directory: dir }).output.trim();
  shouldEqual(magitVersion(), described);
  e8.executeKbdMacro(`M-x ${typed("magit-version")} RET`);
  const said = e8.messages().at(-1)!;
  should(said.startsWith(`Magit ${described}, Git `), said);
  should(said.includes(`, E8 ${String(e8.variable("e8-version"))}, `), said);
  shouldEqual(e8.currentKill(), said);
  e8.call("switch-to-buffer", "*magit-version-test*");
  try {
    e8.executeKbdMacro(`C-u M-x ${typed("magit-version")} RET`);
    shouldEqual(e8.bufferText(), said);
  } finally {
    e8.call("kill-buffer", "*magit-version-test*");
  }
});
