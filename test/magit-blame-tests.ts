// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests of blaming, after magit-blame.el: the overlays each chunk of the
// blame fixture (test/fixtures.sh), by Alice, Bob and Carol, gets in each
// style, compared with what Magit put there (test/oracle/blame.json, as
// test/record.el records it), moving between chunks, blaming removals
// and in reverse, and quitting.

import { ertDeftest, should, shouldEqual } from "ert";
import "magit";
import { magitBlameAddition } from "magit-blame";
import { magitFindFileNoselect } from "magit-files";
import { git, settle, withRepos } from "magit-test-helpers";

/** A file of the package's tests, found along load-path. */
function testFile(name: string): string {
  const dirs = (e8.variable("load-path") as string[]) ?? [];
  const file = dirs.map((d) => e8.expandFileName(`test/${name}`, d)).find((f) => e8.fileExistsP(f));
  should(file !== undefined, `test/${name} is found along load-path`);
  return file!;
}

/** The blame fixture in a new directory; gives the repository. */
function blameRepo(): string {
  const dir = e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-blame", { dir: true })));
  const r = e8.callProcess(["sh", testFile("fixtures.sh"), "blame", dir]);
  should(r.exit === 0, `fixtures.sh blame: ${r.output}`);
  return `${dir}repo/`;
}

interface Shown {
  text: string;
  faces: string[];
}
interface Overlay {
  kind: string;
  line: number;
  before?: Shown | null;
  margin?: Shown | null;
  face?: string | null;
}
type Recording = { [k: string]: Overlay[] | number[] };

/** FACE as the recording names it: its name, or a list's names joined by spaces, or anonymous. */
function faceName(face: e8.Value | undefined): string | null {
  if (face === undefined || face === null) return null;
  if (typeof face === "string") return face;
  if (Array.isArray(face)) return typeof face[0] === "string" && face[0].startsWith(":") ? "anonymous" : face.map((f) => faceName(f) ?? "").filter((f) => f !== "").join(" ");
  return "anonymous";
}

/** S as text and font-lock-face runs, as record.el's mr-string. */
function shown(s: e8.Value | undefined): Shown | null {
  if (s === undefined || s === null) return null;
  const p = s instanceof e8.PropertizedString ? s : new e8.PropertizedString(String(s));
  const text = p.string;
  const faceAt = (i: number): string | null => faceName(p.properties.find(([a, b]) => a <= i && i < b)?.[2]["font-lock-face"]);
  const faces: string[] = [];
  for (let i = 0; i < text.length; ) {
    const f = faceAt(i);
    let j = i + 1;
    while (j < text.length && faceAt(j) === f) j++;
    if (f) faces.push(`${i}-${j} ${f}`);
    i = j;
  }
  return { text, faces };
}

/** The current buffer's blame overlays as the recording has them. */
function blameOverlays(): Overlay[] {
  const out: Overlay[] = [];
  for (const ov of e8.overlaysIn(e8.pointMin(), e8.pointMax())) {
    if (typeof e8.overlayGet(ov, "magit-blame-chunk") !== "number") continue;
    const line = e8.lineOf(e8.overlayStart(ov)!) + 1;
    const before = e8.overlayGet(ov, "before-string");
    if (e8.overlayGet(ov, "magit-blame-heading") === true) out.push({ kind: "heading", line, before: shown(before) });
    else if (typeof e8.overlayGet(ov, "magit-blame-margin") === "number") {
      const display = before instanceof e8.PropertizedString ? (before.properties[0]?.[2].display as e8.Value[] | undefined) : undefined;
      out.push({ kind: "margin", line, margin: display ? shown(display[1]) : null });
    } else if (e8.overlayGet(ov, "magit-blame-highlight") === true) out.push({ kind: "highlight", line, face: faceName(e8.overlayGet(ov, "font-lock-face")) });
    else out.push({ kind: "other", line });
  }
  return out.sort((a, b) => a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** The recording, its UTC dates as this E8 shows those times, in its own zone. */
function recording(): Recording {
  const text = e8.readTextFile(testFile("oracle/blame.json")).replace(/(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/g, (_m, y, mo, d, h, mi) => {
    const t = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
    const p = (n: number) => String(n).padStart(2, "0");
    return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  });
  return JSON.parse(text);
}

/** The margin style magit-blame-styles's docstring gives, as the recording added it. */
const marginStyle = ["margin", ["margin-format", [" %s%f", " %C %a", " %H"]], ["margin-width", 42], ["margin-face", "magit-blame-margin"], ["margin-body-face", ["magit-blame-dimmed"]]];
const withMarginStyle = (body: () => void): void => {
  const styles = e8.variable("magit-blame-styles") as e8.Value[];
  e8.letBind({ "magit-blame-styles": [...styles, marginStyle] }, body);
};
const waitForBlame = (): void => settle(() => e8.variable("magit-blame-process") === null);
/** Visits FILE, as find-file does. */
const visit = (file: string): void => void e8.call("switch-to-buffer", e8.findFileNoselect(file));

ertDeftest("magit-blame-shows-each-chunk-as-magit-does-in-each-style", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () =>
    withMarginStyle(() => {
      const want = recording();
      visit(`${repo}file.txt`);
      e8.call("magit-blame-addition" as e8.CommandName);
      waitForBlame();
      should(e8.variable("magit-blame-mode") === true, "magit-blame-mode is on");
      should(e8.variable("magit-blame-read-only-mode") === true, "the blamed buffer is read-only, with blame's keys");
      for (const style of ["headings", "highlight", "lines", "margin"]) {
        const got = blameOverlays();
        if (style === "lines") {
          // The separator's face is anonymous, its background the heading's.
          shouldEqual(JSON.stringify(got.map((o) => ({ ...o, before: o.before && { text: o.before.text } }))), JSON.stringify((want.lines as Overlay[]).map((o) => ({ ...o, before: o.before && { text: o.before.text } }))), style);
          should(got.filter((o) => o.kind === "heading").every((o) => o.before?.faces.join() === "0-2 anonymous"), "the separator has a face of its own");
        } else shouldEqual(JSON.stringify(got), JSON.stringify(want[style]), style);
        e8.executeKbdMacro("c");
      }
      shouldEqual(String((e8.variable("magit-blame--style") as e8.Value[])[0]), "headings", "c cycles back to the first style");
      shouldEqual(e8.variable("left-margin-width"), 0, "the margin goes with the margin style");
    }),
  );
});

ertDeftest("magit-blame-n-and-p-move-between-chunks", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => {
    const want = recording();
    visit(`${repo}file.txt`);
    magitBlameAddition(["-w"]);
    waitForBlame();
    e8.gotoChar(e8.pointMin());
    const starts: number[] = [];
    for (let last = -1; last !== e8.point(); ) {
      last = e8.point();
      e8.executeKbdMacro("n");
      if (e8.point() !== last) starts.push(e8.lineOf(e8.point()) + 1);
    }
    shouldEqual(starts, want["chunk-starts"]);
    e8.executeKbdMacro("p p");
    shouldEqual(e8.lineOf(e8.point()) + 1, 4, "p goes back to the chunk before");
    // N and P go to Alice's other chunk.
    e8.gotoChar(e8.pointMin());
    e8.executeKbdMacro("N");
    shouldEqual(e8.lineOf(e8.point()) + 1, 4, "N goes to the next chunk of the same commit");
    e8.executeKbdMacro("P");
    shouldEqual(e8.lineOf(e8.point()) + 1, 1, "P goes back");
    let error = "";
    try {
      e8.executeKbdMacro("P");
    } catch (e) {
      error = String(e);
    }
    should(error.includes("No more chunks from same commit"), error);
    // M-w copies the chunk's hash.
    e8.executeKbdMacro("M-w");
    shouldEqual(e8.currentKill(0), git(repo, "rev-parse", "HEAD~2").trim());
  });
});

ertDeftest("magit-blame-removal-and-reverse-blame-a-blob-as-magit-does", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => withMarginStyle(() => {
    const want = recording();
    const alice = git(repo, "rev-parse", "HEAD~2").trim();
    for (const [name, command] of [["removal", "magit-blame-removal"], ["reverse", "magit-blame-reverse"]]) {
      e8.call("switch-to-buffer", e8.letBind({ "default-directory": repo }, () => magitFindFileNoselect(alice, "file.txt")));
      e8.call(command as e8.CommandName);
      waitForBlame();
      shouldEqual(JSON.stringify(blameOverlays()), JSON.stringify(want[name]), name);
      e8.executeKbdMacro("q");
      shouldEqual(blameOverlays().length, 0, "q removes the overlays");
    }
  }));
});

ertDeftest("magit-blame-quit-removes-the-overlays-and-restores-the-buffer", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => {
    visit(`${repo}file.txt`);
    should(!e8.bufferReadOnly(), "the file starts writable");
    magitBlameAddition([]);
    waitForBlame();
    should(blameOverlays().length > 0, "blaming made overlays");
    should(e8.bufferReadOnly(), "blaming makes it read-only");
    e8.executeKbdMacro("q");
    shouldEqual(blameOverlays().length, 0);
    should(e8.variable("magit-blame-mode") !== true, "magit-blame-mode is off");
    should(e8.variable("magit-blame-read-only-mode") !== true, "its keys are gone");
    should(!e8.bufferReadOnly(), "the file is writable again");
  });
});

ertDeftest("magit-blame-mode-off-kills-the-running-blame", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => {
    visit(`${repo}file.txt`);
    magitBlameAddition([]);
    const process = e8.variable("magit-blame-process") as ReturnType<typeof e8.makeProcess> | null;
    should(process !== null && e8.processLiveP(process), "blaming runs git");
    e8.callWithPrefix(-1, "magit-blame-mode" as e8.CommandName);
    should(!e8.processLiveP(process!), "turning blaming off kills it");
    shouldEqual(e8.variable("magit-blame-process"), null);
  });
});

ertDeftest("magit-blame-echo-says-each-chunks-summary", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => {
    visit(`${repo}file.txt`);
    e8.call("magit-blame-echo" as e8.CommandName);
    waitForBlame();
    should(!e8.bufferReadOnly(), "blame echo leaves the buffer writable");
    shouldEqual(String((e8.variable("magit-blame--style") as e8.Value[])[0]), "lines");
    e8.gotoChar(e8.lineStart(1));
    e8.runHooks("post-command-hook");
    shouldEqual(e8.messages().at(-1), '"Bob edits"');
  });
});

ertDeftest("magit-blame-b-in-a-blamed-buffer-blames-the-revision-before-the-chunk", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => {
    visit(`${repo}file.txt`);
    magitBlameAddition([]);
    waitForBlame();
    // On Bob's chunk, b visits the blob before Bob's commit, blamed.
    e8.gotoChar(e8.lineStart(1));
    e8.executeKbdMacro("b");
    waitForBlame();
    const alice = git(repo, "rev-parse", "--short", "HEAD~2").trim();
    shouldEqual(e8.bufferName(), `file.txt.~${alice}~`);
    should(e8.variable("magit-blame-recursive-p") === true, "the blob was made by blaming recursively");
    shouldEqual(e8.lineOf(e8.point()) + 1, 2, "point is on the chunk's line");
    const headings = blameOverlays().filter((o) => o.kind === "heading");
    shouldEqual(headings.length, 1, "Alice wrote all of it");
    e8.executeKbdMacro("q");
    should(e8.bufferName() !== `file.txt.~${alice}~`, "q kills a buffer blamed recursively");
  });
});

ertDeftest("magit-edit-line-commit-stops-a-rebase-at-the-lines-commit", () => {
  const repo = blameRepo();
  withRepos([repo.replace(/repo\/$/, "")], () => {
    visit(`${repo}file.txt`);
    const bob = git(repo, "rev-parse", "HEAD~1").trim();
    // Without blaming, the line's commit comes from git blame -L.
    e8.gotoChar(e8.lineStart(2));
    e8.call("magit-edit-line-commit" as e8.CommandName);
    settle(() => e8.fileExistsP(`${repo}.git/rebase-merge/done`) && git(repo, "rev-parse", "HEAD").trim() === bob);
    shouldEqual(git(repo, "rev-parse", "HEAD").trim(), bob, "the rebase stopped at Bob's commit");
    git(repo, "rebase", "--abort");
  });
});
