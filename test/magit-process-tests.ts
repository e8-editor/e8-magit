// SPDX-License-Identifier: GPL-3.0-or-later
//
// The process layer's tests (magit-process.ts): a failing git command's
// report and its section in the process buffer, a command run in the
// background, and questions a program asks on its pseudo-terminal
// answered from the minibuffer or magit-process-find-password-functions.

import { ertDeftest, should, shouldEqual } from "ert";
import * as proc from "magit-process";

e8.require("magit");

/** Runs BODY in fixture NAME's repository, then deletes it and the buffers left in it. */
function inFixture(name: string, body: (repo: string) => void): void {
  const dirs = (e8.variable("load-path") as string[]) ?? [];
  const script = dirs.map((d) => e8.expandFileName("test/fixtures.sh", d)).find((f) => e8.fileExistsP(f))!;
  const dir = e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-process", { dir: true })));
  should(e8.callProcess(["sh", script, name, dir]).exit === 0);
  const repo = `${dir}repo/`;
  e8.discardInput();
  e8.call("switch-to-buffer", "*magit-process-test*");
  e8.setVariable("default-directory", repo);
  try {
    body(repo);
  } finally {
    // A prompt opened by a process's filter leaves the key that answered
    // it pending in E8; it is not for the next test.
    e8.discardInput();
    for (const b of e8.bufferList()) {
      const dd = e8.withCurrentBuffer(b, () => e8.variable("default-directory"));
      if (typeof dd === "string" && dd.startsWith(dir) && !b.startsWith(" ")) e8.call("kill-buffer", b);
    }
    e8.deleteDirectory(dir, { recursive: true });
  }
}

/** Waits for DONE, for up to twenty seconds, as a process runs. */
function settle(done: () => boolean): void {
  for (let i = 0; i < 400 && !done(); i++) e8.acceptProcessOutput(undefined, 0.05);
}

ertDeftest("magit-process-a-failing-command-says-why-and-is-logged", () => {
  inFixture("basic", (repo) => {
    e8.call("magit-status" as e8.DefinedCommand);
    const exit = proc.magitRunGit("checkout", "no-such-branch");
    should(exit !== 0);
    const last = e8.messages().at(-1) ?? "";
    should(last.startsWith("Git error: pathspec 'no-such-branch' did not match"), last);
    should(last.includes('Type $ to see "magit-process: repo" for details'), last);
    // The status buffer shows the error at its top, once, as magit-insert-error-header does.
    should(e8.withCurrentBuffer("magit: repo", () => e8.bufferText()).startsWith("GitError! pathspec 'no-such-branch' did not match any file(s) known to git  [Type `$' for details]\n"));
    const log = proc.magitProcessLog(repo);
    shouldEqual(log.at(-1)?.args.slice(-2), ["checkout", "no-such-branch"]);
    const name = proc.magitProcessBuffer(true);
    const text = e8.withCurrentBuffer(name, () => e8.bufferText());
    should(/^  1 git … checkout no-such-branch$/m.test(text), text);
    should(text.includes("error: pathspec 'no-such-branch'"), text);
    // A command that succeeds ends with 0, its section hidden.
    shouldEqual(proc.magitRunGit("branch", "new"), 0);
    should(/^  0 git … branch new$/m.test(e8.withCurrentBuffer(name, () => e8.bufferText())));
    should(!e8.withCurrentBuffer("magit: repo", () => e8.bufferText()).includes("GitError!"));
  });
});

ertDeftest("magit-process-a-background-command-is-logged-and-refreshes", () => {
  inFixture("basic", (repo) => {
    e8.call("magit-status" as e8.DefinedCommand);
    proc.magitRunGitAsync("commit", "-q", "-m", "Staged b");
    const entry = proc.magitProcessLog(repo).at(-1)!;
    shouldEqual(entry.exit, undefined);
    settle(() => entry.exit !== undefined);
    shouldEqual(entry.exit, 0);
    // The status buffer was refreshed: b.txt is no longer staged.
    should(!e8.withCurrentBuffer("magit: repo", () => e8.bufferText()).includes("Staged changes"));
  });
});

/** A program that asks QUESTION on its terminal and prints what it was told. */
const asker = (question: string): string[] => ["sh", "-c", `printf '%s' "${question}"; read answer; echo "got: $answer"`];

ertDeftest("magit-process-a-password-is-read-and-sent", () => {
  inFixture("basic", (repo) => {
    e8.unreadKeys("s e c r e t RET");
    const [program, ...args] = asker("Password for 'https://u@example.com': ");
    proc.magitStartProcess(program, args);
    const entry = proc.magitProcessLog(repo).at(-1)!;
    settle(() => entry.exit !== undefined);
    should(entry.output.includes("got: secret"), entry.output);
  });
});

ertDeftest("magit-process-find-password-functions-answer-for-a-host", () => {
  inFixture("basic", (repo) => {
    e8.defun("magit-test-password", (host: string) => (host === "u@example.com" ? "from-function" : undefined));
    e8.letBind({ "magit-process-find-password-functions": ["magit-test-password"] }, () => {
      const [program, ...args] = asker("Password for 'https://u@example.com': ");
      proc.magitStartProcess(program, args);
      const entry = proc.magitProcessLog(repo).at(-1)!;
      settle(() => entry.exit !== undefined);
      should(entry.output.includes("got: from-function"), entry.output);
    });
  });
});

ertDeftest("magit-process-a-username-and-yes-or-no-are-asked", () => {
  inFixture("basic", (repo) => {
    e8.unreadKeys("C-a C-k m e RET");
    const [program, ...args] = asker("Username for 'https://example.com': ");
    proc.magitStartProcess(program, args);
    const entry = proc.magitProcessLog(repo).at(-1)!;
    settle(() => entry.exit !== undefined);
    should(entry.output.includes("got: me"), entry.output);
    e8.unreadKeys("y e s RET");
    const [p2, ...a2] = asker("Are you sure you want to continue connecting (yes/no)? ");
    proc.magitStartProcess(p2, a2);
    const second = proc.magitProcessLog(repo).at(-1)!;
    settle(() => second.exit !== undefined);
    should(second.output.includes("got: yes"), second.output);
  });
});

ertDeftest("magit-process-the-mode-line-shows-the-command-and-its-error", () => {
  inFixture("basic", (repo) => {
    e8.call("magit-status" as e8.DefinedCommand);
    const modeLine = () => e8.withCurrentBuffer("magit: repo", () => e8.variable("mode-line-process"));
    // Starting git shows it in the mode line, as magit-process-set-mode-line.
    proc.magitProcessSetModeLine("/bin/sh", ["-c", "true"], repo);
    shouldEqual(String(modeLine()), " sh -c");
    // A failing command keeps its error in the mode line, its first lines the tooltip.
    e8.letBind({ "magit-process-error-tooltip-max-lines": 1 }, () => proc.magitRunGit("checkout", "no-such-branch"));
    const error = modeLine() as e8.PropertizedString;
    shouldEqual(String(error), " git checkout");
    const props = error.properties.find(([from]) => from === 1)![2];
    shouldEqual(props["font-lock-face"], "magit-mode-line-process-error");
    shouldEqual(props["help-echo"], "error: pathspec 'no-such-branch' did not match any file(s) known to git\n\nmouse-1: Show process buffer");
    // It stays through the refresh after the command, and goes with the next command's refresh.
    e8.runHooks("pre-command-hook");
    e8.withCurrentBuffer("magit: repo", () => e8.call("magit-refresh" as e8.DefinedCommand));
    shouldEqual(modeLine(), null);
    // A command that succeeds takes the command off the mode line.
    shouldEqual(proc.magitRunGit("branch", "new"), 0);
    shouldEqual(modeLine(), null);
    // Without magit-process-display-mode-line-error, an error is not kept.
    e8.letBind({ "magit-process-display-mode-line-error": false }, () => proc.magitRunGit("checkout", "no-such-branch"));
    shouldEqual(modeLine(), null);
  });
});

ertDeftest("magit-process-timestamps-and-colors-in-the-process-buffer", () => {
  inFixture("basic", (repo) => {
    e8.call("magit-status" as e8.DefinedCommand);
    const colored = ["sh", "-c", "printf '\\033[31mred\\033[0m plain\\n'"];
    // Without magit-process-apply-ansi-colors the escapes are left as they are.
    proc.magitCallProcess(colored[0], colored.slice(1));
    const name = proc.magitProcessBuffer(true);
    should(e8.withCurrentBuffer(name, () => e8.bufferText()).includes("\x1b[31mred"));
    e8.letBind({ "magit-process-apply-ansi-colors": true, "magit-process-timestamp-format": "%Y" }, () => {
      proc.magitCallProcess(colored[0], colored.slice(1));
      const text = e8.withCurrentBuffer(name, () => e8.bufferText());
      // The heading has the time the command started, as magit-process-timestamp-format formats it.
      should(new RegExp(`^  0 ${new Date().getFullYear()} sh -c `, "m").test(text), text);
      should(text.includes("\nred plain\n"), text);
      const at = e8.withCurrentBuffer(name, () => e8.bufferText().lastIndexOf("red plain") + e8.pointMin());
      const face = e8.withCurrentBuffer(name, () => e8.getTextProperty(at, "face") ?? e8.getTextProperty(at, "font-lock-face"));
      should(JSON.stringify(face).includes("ansi-color-red"), JSON.stringify(face));
    });
    void repo;
  });
});
