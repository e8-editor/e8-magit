// SPDX-License-Identifier: GPL-3.0-or-later
//
// The oracle: for each case in test/oracle/cases.json, makes the case's
// fixture (test/fixtures.sh), types the case's keys in its status buffer,
// and compares the buffer shown with what Magit 4.4.0 showed in Emacs 30,
// as test/record.el recorded it in test/oracle/NAME.json: the buffer's
// name, its visible text and point's line, and, for cases marked
// "faces", the faces of that text. A case marked "pending" is expected to
// differ still: the plan (docs/plan.md) names the step that ports it.
// E8_ORACLE_REPORT=1 prints, for every case, what differs.

import { ertDeftest, should, shouldEqual } from "ert";
import { recordBuffer, testFile, type Recording } from "magit-test-helpers";

e8.require("magit");

interface Case {
  name: string;
  fixture: string;
  keys: string;
  /** How much of the recording E8 matches: "faces", "text", or "pending". */
  e8?: "faces" | "text" | "pending";
}

/** Makes fixture NAME (test/fixtures.sh) in a new temporary directory; gives the directory, with a slash. */
export function fixture(name: string): string {
  const dir = e8.fileNameAsDirectory(e8.fileTruename(e8.makeTempFile("magit-oracle", { dir: true })));
  const r = e8.callProcess(["sh", testFile("fixtures.sh"), name, dir]);
  should(r.exit === 0, `fixtures.sh ${name}: ${r.output}`);
  return dir;
}

/** Runs BODY with a fixture's directory, then kills the buffers left in it and deletes it. */
export function withFixture(name: string, body: (repo: string) => void): void {
  const dir = fixture(name);
  try {
    body(`${dir}repo/`);
  } finally {
    for (const b of e8.bufferList()) {
      if (b.startsWith(" *Minibuf")) continue;
      const dd = e8.withCurrentBuffer(b, () => e8.variable("default-directory"));
      if (typeof dd === "string" && e8.fileTruename(dd).startsWith(dir.replace(/\/$/, ""))) {
        e8.withCurrentBuffer(b, () => e8.setBufferModified(false));
        e8.call("kill-buffer", b);
      }
    }
    e8.deleteDirectory(dir, { recursive: true });
  }
}

/** What differs between E8's buffer and the recording, at a case's level: nothing if they match. */
function differences(got: Recording, want: Recording, level: "faces" | "text"): string[] {
  const out: string[] = [];
  if (got.buffer !== want.buffer) out.push(`buffer ${JSON.stringify(got.buffer)}, Magit's ${JSON.stringify(want.buffer)}`);
  if (got.text !== want.text) out.push(`text:\n--- E8\n${got.text}--- Magit\n${want.text}---`);
  else if (got.point !== want.point) out.push(`point on line ${got.point}, Magit's ${want.point}`);
  if (level === "faces" && got.text === want.text) {
    const g = new Set(got.faces);
    const w = new Set(want.faces);
    const missing = want.faces.filter((f) => !g.has(f));
    const extra = got.faces.filter((f) => !w.has(f));
    if (missing.length > 0 || extra.length > 0) out.push(`faces: Magit's not in E8 ${JSON.stringify(missing)}, E8's not in Magit ${JSON.stringify(extra)}`);
  }
  return out;
}

/** Keys as Emacs's kbd reads them: a word that names no key is its characters, as "magit-log-current" after M-x. */
const kbd = (keys: string): string =>
  keys
    .split(" ")
    .filter((k) => k !== "")
    .map((k) => (/^(([CMSsHA]-)+.|<[^>]+>|RET|TAB|SPC|ESC|DEL|LFD|NUL|.)$/.test(k) ? k : Array.from(k).join(" ")))
    .join(" ");

/** Shows a case's buffer in E8: the fixture's status, then the case's keys. */
export function showCase(c: Case, repo: string): Recording {
  e8.call("delete-other-windows");
  e8.call("switch-to-buffer", "*magit-oracle*");
  e8.setVariable("default-directory", repo);
  e8.call("magit-status" as e8.DefinedCommand);
  if (c.keys !== "") e8.executeKbdMacro(kbd(c.keys));
  return e8.withCurrentBuffer(e8.windowBuffer()!, recordBuffer);
}

const cases: Case[] = JSON.parse(e8.readTextFile(testFile("oracle/cases.json")));
const report = e8.getenv("E8_ORACLE_REPORT") !== undefined;

for (const c of cases) {
  const level = c.e8 ?? "pending";
  ertDeftest(
    `magit-oracle-${c.name}`,
    () => {
      const want: Recording = JSON.parse(e8.readTextFile(testFile(`oracle/${c.name}.json`)));
      withFixture(c.fixture, (repo) => {
        let got: Recording;
        try {
          got = showCase(c, repo);
        } catch (e) {
          if (report) e8.message(`ORACLE ${c.name}: error ${String(e)}`);
          throw e;
        }
        const diffs = differences(got, want, level === "faces" ? "faces" : "text");
        if (report) {
          const text = differences(got, want, "text").length === 0;
          const faces = differences(got, want, "faces").length === 0;
          e8.message(`ORACLE ${c.name} [${level}]: ${faces ? "faces" : text ? "text" : "differs"}${faces ? "" : `\n${differences(got, want, "faces").join("\n")}`}`);
        }
        shouldEqual(diffs, []);
      });
    },
    { expectedResult: level === "pending" ? "failed" : "passed", doc: `E8 shows what Magit shows for oracle case ${c.name}.` },
  );
}
