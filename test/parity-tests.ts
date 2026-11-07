// SPDX-License-Identifier: GPL-3.0-or-later
//
// The parity audit: every command, option, face and keymap binding that
// Magit's files define (test/parity.json, recorded from Emacs by
// test/record-parity.el) is in E8's port, but for the exceptions
// test/parity-exceptions.json lists, each with its reason, which the
// README repeats. An exception no longer needed fails too, so the list
// stays true. E8_PARITY_REPORT=1 prints what is missing.

import { ertDeftest, shouldEqual } from "ert";
import "magit";

interface Parity {
  commands: string[];
  options: [string, string][];
  faces: string[];
  keymaps: [string, [string, string][]][];
}
interface Exceptions {
  commands: { [name: string]: string };
  options: { [name: string]: string };
  faces: { [name: string]: string };
  /** "MAP KEY" → reason, or "MAP" for a whole keymap. */
  keys: { [mapAndKey: string]: string };
}

/** A file of the test directory, found along load-path as the menus' recording is. */
function testFile(name: string): string {
  const dirs = ((e8.variable("load-path") as string[] | null) ?? []).map(String);
  const file = dirs.map((d) => e8.expandFileName(`test/${name}`, d)).find((f) => e8.fileExistsP(f)) ?? dirs.map((d) => e8.expandFileName(name, d)).find((f) => e8.fileExistsP(f));
  if (!file) throw new Error(`${name} is not found along load-path`);
  return file;
}
const parity = (): Parity => JSON.parse(e8.readTextFile(testFile("parity.json")));
const exceptions = (): Exceptions => JSON.parse(e8.readTextFile(testFile("parity-exceptions.json")));

/** Of NAMES, those E8 lacks that are not excepted, and the exceptions no longer needed. */
function compare(names: string[], has: (name: string) => boolean, excepted: { [name: string]: string }, what: string): { missing: string[]; stale: string[] } {
  const missing = names.filter((n) => !has(n) && !(n in excepted));
  const stale = Object.keys(excepted).filter((n) => !names.includes(n) || has(n));
  if (e8.getenv("E8_PARITY_REPORT")) e8.message(`PARITY ${what}: ${missing.length} missing\n${missing.join("\n")}`);
  return { missing, stale };
}

ertDeftest("magit-parity-commands", () => {
  const r = compare(parity().commands, (n) => e8.commandExists(n), exceptions().commands, "commands");
  shouldEqual(r, { missing: [], stale: [] });
});

ertDeftest("magit-parity-options", () => {
  const r = compare(parity().options.map(([n]) => n), (n) => e8.defaultValue(n) !== undefined, exceptions().options, "options");
  shouldEqual(r, { missing: [], stale: [] });
});

ertDeftest("magit-parity-faces", () => {
  const r = compare(parity().faces, (n) => e8.facep(n), exceptions().faces, "faces");
  shouldEqual(r, { missing: [], stale: [] });
});

ertDeftest("magit-parity-keys", () => {
  const ex = exceptions().keys;
  const names: string[] = [];
  const bound = new Set<string>();
  for (const [map, keys] of parity().keymaps) {
    for (const [key, command] of keys) {
      const name = `${map} ${key}`;
      if (map in ex) continue;
      names.push(name);
      let found: unknown;
      try {
        found = e8.lookupKey(map, key);
      } catch {
        found = undefined;
      }
      if (found === command) bound.add(name);
    }
  }
  const mapsExcepted = Object.fromEntries(Object.entries(ex).filter(([k]) => k.includes(" ")));
  const r = compare(names, (n) => bound.has(n), mapsExcepted, "keys");
  shouldEqual(r, { missing: [], stale: [] });
});
