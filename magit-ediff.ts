// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ediff support, after magit-ediff.el: comparing a file's versions in
// HEAD, the index and the working tree, a commit's or a stash's changes
// and a range's, staging by editing the index's version beside the
// others, and resolving conflicts by merging the two sides, with the
// ancestor, through E8's ediff. e runs magit-ediff-dwim, E the menu.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { ediffBuffersInternal, ediffMergeBuffers, ediffMergeBuffersWithAncestor } from "ediff";
import { currentSection, magitRootSection } from "magit-section";
import { transientDefinePrefix } from "transient";
import { truthy } from "subr";
import { magitCompletingRead, magitReadCharCase } from "magit-base";
import {
  magitAnythingUnmergedP,
  magitChangedFiles,
  magitCommitP,
  magitCurrentFile,
  magitGitdir,
  magitGitString,
  magitReadBranchOrCommit,
  magitReadStash,
  magitRenamedFiles,
  magitRevName,
  magitRevisionFiles,
  magitSplitRange,
  magitStagedFiles,
  magitToplevelOrError,
  magitTrackedFiles,
  magitUnstagedFiles,
} from "magit-git";
import { magitFindFileIndexNoselect, magitFindFileNoselect, magitGetRevisionBuffer, magitReadUnmergedFile, magitRevisionBufferName, magitReadFileChoice } from "magit-files";
import { magitDiffDwimTarget, magitDiffReadRangeOrCommit, magitDiffType } from "magit-diff";
import { magitStageFiles, smergeKeepN, smergeMatchConflict } from "magit-apply";
import { magitGitMergetool } from "magit-extras";
import { isWindow, type Win } from "magit-mode";

// Options

e8.defineHook(
  "magit-ediff-quit-hook",
  "Hooks to run after finishing Ediff, when that was invoked using Magit.\nThe hooks are run in the Ediff control buffer.  This is similar\nto `ediff-quit-hook' but takes the needs of Magit into account.\nThe `ediff-quit-hook' is ignored by Ediff sessions which were\ninvoked using Magit.",
);
e8.defineVariable({
  name: "magit-ediff-dwim-resolve-function",
  doc: "The function `magit-ediff-dwim' uses to resolve conflicts: magit-ediff-resolve-rest, magit-ediff-resolve-all or magit-git-mergetool.",
  value: "magit-ediff-resolve-rest",
});
e8.defineVariable({
  name: "magit-ediff-dwim-show-on-hunks",
  doc: "Whether `magit-ediff-dwim' runs show variants on hunks.\nIf non-nil, `magit-ediff-show-staged' or\n`magit-ediff-show-unstaged' are called based on what section the\nhunk is in.  Otherwise, `magit-ediff-dwim' runs\n`magit-ediff-stage' when point is on an uncommitted hunk.",
  value: false,
});
e8.defineVariable({
  name: "magit-ediff-show-stash-with-index",
  doc: "Whether `magit-ediff-show-stash' shows the state of the index.\n\nIf non-nil, use a third Ediff buffer to distinguish which changes\nin the stash were staged.  In cases where the stash contains no\nstaged changes, fall back to a two-buffer Ediff.\n\nMore specifically, a stash is a merge commit, stash@{N}, with\npotentially three parents.\n\n* stash@{N}^1 represents the `HEAD' commit at the time the stash\n  was created.\n\n* stash@{N}^2 records any changes that were staged when the stash\n  was made.\n\n* stash@{N}^3, if it exists, contains files that were untracked\n  when stashing.\n\nIf this option is non-nil, `magit-ediff-show-stash' will run\nEdiff on a file using three buffers: one for stash@{N}, another\nfor stash@{N}^1, and a third for stash@{N}^2.\n\nOtherwise, Ediff uses two buffers, comparing\nstash@{N}^1..stash@{N}.  Along with any unstaged changes, changes\nin the index commit, stash@{N}^2, will be shown in this\ncomparison unless they conflicted with changes in the working\ntree at the time of stashing.",
  value: true,
});
e8.defineVariable({
  name: "magit-ediff-use-indirect-buffers",
  doc: "Whether to use indirect buffers.\nEdiff already does a lot of buffer and file shuffling and I\nrecommend you do not further complicate that by enabling this.",
  value: false,
});

// Commands

/**
 * The window configuration to go back to when Ediff quits, as
 * magit-ediff-previous-winconf: bound while magit-ediff-quit-hook runs.
 * A window configuration is not a value a variable can hold in E8, so it
 * is kept here.
 */
let magitEdiffPreviousWinconf: e8.WindowConfiguration | undefined;

/** Runs magit-ediff-quit-hook with WINCONF as the configuration to go back to. */
function runQuitHook(winconf: e8.WindowConfiguration | undefined): void {
  const outer = magitEdiffPreviousWinconf;
  magitEdiffPreviousWinconf = winconf;
  try {
    e8.runHooks("magit-ediff-quit-hook");
  } finally {
    magitEdiffPreviousWinconf = outer;
  }
}

const withToplevel = <T>(body: () => T): T => e8.letBind({ "default-directory": magitToplevelOrError() }, body);
const live = (b: e8.Buffer | string | null | undefined): b is e8.Buffer | string => b !== null && b !== undefined && e8.bufferLiveP(e8.getBuffer(b));
const buf = (b: e8.BufferLike | null | undefined): e8.Buffer | undefined => (b === null || b === undefined ? undefined : e8.getBuffer(b));
/** The buffer visiting FILE, as get-file-buffer and find-buffer-visiting. */
const getFileBuffer = (file: string): e8.Buffer | undefined => {
  const abs = e8.expandFileName(file);
  const name = e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === abs);
  return name === undefined ? undefined : e8.getBuffer(name);
};
const findFileNoselect = (file: string): e8.Buffer => e8.getBuffer(e8.findFileNoselect(e8.expandFileName(file)))!;
const ctlVar = (name: string): e8.Value | undefined => e8.variable(name);

/**
 * How one of the buffers is had, as magit-ediff-buffers's (GET-BUFFER
 * CREATE-BUFFER): the buffer GET gives is used and kept, or else MAKE's
 * is, and killed when Ediff quits.
 */
export type BufferSpec = [get: () => e8.BufferLike | null | undefined, make: () => e8.BufferLike];

/**
 * Runs Ediff on two or three buffers, as magit-ediff-buffers, a wrapper
 * around ediff-buffers-internal.
 *
 * A, B and C have the form [GET-BUFFER, CREATE-BUFFER].  If GET-BUFFER
 * returns a buffer, then that buffer is used and it is not killed when
 * exiting Ediff.  Otherwise CREATE-BUFFER must return a buffer and that
 * is killed when exiting Ediff.
 *
 * If given, SETUP is called without arguments after Ediff is done setting
 * up buffers, and QUIT is put on ediff-quit-hook, called without
 * arguments.  If FILE is given, then perform a merge, whose result is put
 * in FILE.
 */
export function magitEdiffBuffers(
  a: BufferSpec,
  b: BufferSpec,
  c?: BufferSpec | null,
  setup?: (() => void) | null,
  quit?: (() => void) | null,
  file?: string | null,
): e8.Buffer {
  return withToplevel(() => {
    const conf = e8.currentWindowConfiguration();
    const specs = [a, b, c] as (BufferSpec | null | undefined)[];
    const got: (e8.Buffer | undefined)[] = [];
    const made: (e8.Buffer | undefined)[] = [];
    specs.forEach((spec, i) => {
      if (!spec) return;
      let g = buf(spec[0]());
      let m: e8.Buffer | undefined;
      if (g) {
        // This is an unfortunate complication that Magit added for the
        // benefit of one user: with indirect buffers, the buffer found
        // is shown through an indirect buffer, killed on quitting.
        if (truthy(e8.variable("magit-ediff-use-indirect-buffers"))) {
          m = e8.makeIndirectBuffer(g, e8.generateNewBufferName(g.name!), true);
          g = undefined;
        } else m = g;
      } else m = buf(spec[1]());
      got[i] = g;
      made[i] = m;
    });
    // For merge jobs Ediff switches buffer names around: the third
    // buffer is the ancestor (see ediff-setup).
    const vars = ["ediff-buffer-A", "ediff-buffer-B", file ? "ediff-ancestor-buffer" : "ediff-buffer-C"];
    const kill = () => {
      specs.forEach((spec, i) => {
        if (spec && !got[i]) e8.funcall("ediff-kill-buffer-carefully", ctlVar(vars[i]) ?? null);
      });
    };
    const hooks: e8.Value[] = [];
    if (setup) hooks.push(setup);
    hooks.push(() => {
      // We do not want to kill buffers that existed before Ediff was
      // invoked, so we cannot use Ediff's default quit functions.  Ediff
      // splits quitting across two hooks for merge jobs but we only ever
      // use one.
      e8.makeLocalVariable("ediff-quit-merge-hook");
      e8.setVariable("ediff-quit-merge-hook", null);
      e8.makeLocalVariable("ediff-quit-hook");
      e8.setVariable("ediff-quit-hook", [
        ...(quit ? [quit] : []),
        () => {
          kill();
          runQuitHook(conf);
        },
      ]);
    });
    const job = c ? (file ? "ediff-merge-buffers-with-ancestor" : "ediff-buffers3") : file ? "ediff-merge-buffers" : "ediff-buffers";
    return ediffBuffersInternal(made[0]!, made[1]!, c ? made[2]! : null, hooks, job, file ?? null);
  });
}

/** The name of the branch REV is the tip of, local or remote, as magit-name-branch. */
function magitNameBranch(rev: string): string | undefined {
  const local = magitRevName(rev, "refs/heads/*");
  if (local && !/[~^]/.test(local)) return local;
  const remote = magitRevName(rev, "refs/remotes/*");
  if (remote && !/[~^]/.test(remote)) return remote.slice(8);
  return undefined;
}

/** FILE's name in REV, potentially renamed between REV and OTHER-REV, as magit--rev-file-name. */
function magitRevFileName(file: string, rev: string, otherRev: string): string | undefined {
  if (magitRevisionFiles(rev).includes(file)) return file;
  return magitRenamedFiles(rev, otherRev).find(([, to]) => to === file)?.[0];
}

/** A name for a file that does not exist yet, starting with PREFIX, as make-temp-name. */
function makeTempName(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (;;) {
    let name = prefix;
    for (let i = 0; i < 6; i++) name += chars[Math.floor(Math.random() * chars.length)];
    if (!e8.fileExistsP(name)) return name;
  }
}

/**
 * Resolves all conflicts in FILE using Ediff, as magit-ediff-resolve-all:
 * the merge of HEAD's version and the other side's, with their merge base
 * as the ancestor, is put in FILE, the file Git left moved to FILE.ORIG.
 */
export function magitEdiffResolveAll(file: string): e8.Buffer {
  return withToplevel(() => {
    const dir = magitGitdir()!;
    const revA = magitNameBranch("HEAD") ?? magitCommitP("HEAD")!;
    const revB0 = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].find((f) => e8.fileExistsP(e8.expandFileName(f, dir)));
    if (revB0 === undefined) e8.userError("No merge, cherry-pick or revert is in progress");
    const revB = magitNameBranch(revB0!) ?? magitCommitP(revB0!)!;
    const revC = magitCommitP(magitGitString("merge-base", revA, revB) ?? "");
    const fileA = magitRevFileName(file, revA, revB);
    const fileB = magitRevFileName(file, revB, revA);
    const fileC = revC === undefined ? undefined : (magitRevFileName(file, revC, revA) ?? magitRevFileName(file, revC, revB));
    // Ediff assumes that the FILE where it is going to store the merge
    // result does not exist yet, so move the existing file out of the
    // way.  If a buffer visits FILE, then we have to kill that upfront.
    const visiting = getFileBuffer(file);
    if (visiting) {
      if (e8.withCurrentBuffer(visiting, () => e8.bufferModified()) && !e8.yOrNP(`Save buffer ${visiting.name} (cannot continue otherwise)? `)) {
        e8.userError("Abort");
      }
      e8.call("kill-buffer", visiting.name!);
    }
    const orig = `${file}.ORIG`;
    if (e8.fileExistsP(orig)) e8.renameFile(orig, makeTempName(`${orig}_`));
    e8.renameFile(file, orig);
    const setup = () => {
      // Use the same conflict marker style as Git uses.
      e8.makeLocalVariable("ediff-combination-pattern");
      e8.setVariable("ediff-combination-pattern", ["<<<<<<< HEAD", e8.intern("A"), `||||||| ${revC}`, e8.intern("Ancestor"), "=======", e8.intern("B"), `>>>>>>> ${revB}`]);
    };
    const quit = () => {
      // For merge jobs Ediff switches buffer names around.  At this point
      // `ediff-buffer-C' no longer refer to the ancestor buffer but to
      // the merge result buffer.  See (if ediff-merge-job ...) in
      // `ediff-setup'.
      const c = buf(ctlVar("ediff-buffer-C") as e8.Buffer | null);
      if (live(c)) {
        e8.withCurrentBuffer(c, () => {
          e8.call("save-buffer");
          const conflicted = e8.saveExcursion(() => {
            e8.gotoChar(e8.pointMin());
            return e8.reSearchForward("^<<<<<<< ", { noerror: true }) !== undefined;
          });
          if (!conflicted) magitStageFiles([file]);
        });
      }
    };
    const spec = (rev: string, f: string): BufferSpec => [() => magitGetRevisionBuffer(rev, f), () => magitFindFileNoselect(rev, f)];
    if (fileC !== undefined) return magitEdiffBuffers(spec(revA, fileA!), spec(revB, fileB!), spec(revC!, fileC), setup, quit, file);
    return magitEdiffBuffers(spec(revA, fileA!), spec(revB, fileB!), null, setup, quit, file);
  });
}

// What smerge-ediff does, which magit-ediff-resolve-rest calls: E8 has
// no smerge-mode, so the part of it Magit needs is here.

/** The control buffer's buffer the conflicts were in, and the windows before, as smerge-ediff-buf and smerge-ediff-windows. */
const smergeSessions = new Map<string, { buf: e8.Buffer; windows: e8.WindowConfiguration }>();

/** The text after the first marker REGEXP matches, as smerge--get-marker: DEFAULT=TEXT, or DEFAULT. */
function smergeGetMarker(regexp: RegExp, def: string): string {
  const m = regexp.exec(e8.bufferSubstringNoProperties(e8.pointMin(), e8.pointMax()));
  return m && m[1] !== "" ? `${def}=${m[1]}` : def;
}

/** The next conflict after point, point moved to its end, as smerge-find-conflict. */
function smergeFindConflict(): ReturnType<typeof smergeMatchConflict> | undefined {
  const at = e8.reSearchForward("^<<<<<<< ", { noerror: true });
  if (at === undefined) return undefined;
  return smergeMatchConflict(at);
}

/** A new buffer named NAME with BUF's text, each conflict replaced as KEEP says, in MODE, as smerge-ediff makes them. */
function smergeBuffer(name: string, from: e8.Buffer, mode: e8.Value | undefined, keep: (c: ReturnType<typeof smergeMatchConflict>) => void): e8.Buffer {
  const b = e8.getBufferCreate(e8.generateNewBufferName(name));
  e8.withCurrentBuffer(b, () => {
    e8.insertBufferSubstring(from);
    e8.gotoChar(e8.pointMin());
    for (let c = smergeFindConflict(); c; c = smergeFindConflict()) {
      keep(c);
      e8.gotoChar(Math.min(c.start, e8.pointMax()));
    }
    e8.setBufferModified(false);
    if (typeof mode === "string" && mode !== "fundamental-mode" && e8.commandExists(mode)) e8.call(mode as e8.CommandName);
  });
  return b;
}

/**
 * Invokes ediff to resolve the conflicts in the current buffer, as
 * smerge-ediff: a merge of the upper and lower versions of each, with the
 * base as ancestor if any has one. Returns the control buffer.
 */
function smergeEdiff(): e8.Buffer {
  const from = e8.getBuffer(e8.bufferName())!;
  const mode = e8.variable("major-mode");
  const config = e8.currentWindowConfiguration();
  const filename = e8.fileNameNondirectory(e8.bufferFileName() ?? "-");
  const upper = smergeBuffer(`*${filename} ${smergeGetMarker(/^<<<<<<< (.*)\n/m, "UPPER")}*`, from, mode, (c) => smergeKeepN(c, 1));
  const lower = smergeBuffer(`*${filename} ${smergeGetMarker(/^>>>>>>> (.*)\n/m, "LOWER")}*`, from, mode, (c) => smergeKeepN(c, 3));
  let hasBase = false;
  e8.withCurrentBuffer(from, () =>
    e8.saveExcursion(() => {
      e8.gotoChar(e8.pointMin());
      for (let c = smergeFindConflict(); c && !hasBase; c = smergeFindConflict()) hasBase = c.versions[2] !== undefined;
    }),
  );
  let control: e8.Buffer;
  if (hasBase) {
    const base = smergeBuffer(`*${filename} ${smergeGetMarker(/^\|\|\|\|\|\|\| (.*)\n/m, "BASE")}*`, from, mode, (c) => {
      if (c.versions[2]) smergeKeepN(c, 2);
      else e8.deleteRegion(c.start, c.end);
    });
    control = ediffMergeBuffersWithAncestor(upper, lower, base);
  } else {
    control = ediffMergeBuffers(upper, lower);
  }
  // Ediff is now set up, and we are in the control buffer.
  smergeSessions.set(control.name!, { buf: from, windows: config });
  e8.message("Please resolve conflicts now; exit ediff when done");
  return control;
}

/**
 * Resolves outstanding conflicts in FILE using Ediff, as
 * magit-ediff-resolve-rest: the conflicts left in the file, as smerge-ediff
 * finds them, merged, the result put back in the file when Ediff quits.
 */
export function magitEdiffResolveRest(file: string): e8.Buffer {
  return withToplevel(() => {
    const control = e8.withCurrentBuffer(findFileNoselect(file), () => smergeEdiff());
    e8.withCurrentBuffer(control, () => {
      e8.makeLocalVariable("ediff-quit-hook");
      e8.setVariable("ediff-quit-hook", [
        () => {
          const bufC = buf(ctlVar("ediff-buffer-C") as e8.Buffer | null);
          const smerge = smergeSessions.get(e8.bufferName());
          smergeSessions.delete(e8.bufferName());
          if (smerge && live(smerge.buf)) {
            e8.withCurrentBuffer(smerge.buf, () => {
              if (e8.yesOrNoP(`Conflict resolution finished; save ${e8.bufferFileName()}? `)) {
                e8.deleteRegion(e8.pointMin(), e8.pointMax());
                if (live(bufC)) e8.insertBufferSubstring(bufC);
                e8.call("save-buffer");
              }
            });
          }
          for (const v of ["ediff-buffer-A", "ediff-buffer-B", "ediff-buffer-C", "ediff-ancestor-buffer"]) {
            const b = buf(ctlVar(v) as e8.Buffer | null);
            if (live(b)) e8.call("kill-buffer", b.name!);
          }
          runQuitHook(smerge?.windows);
        },
      ]);
    });
    return control;
  });
}

/**
 * Stages and unstages changes to FILE using Ediff, as magit-ediff-stage:
 * HEAD's version, the index's, which can be edited, and the file. FILE has
 * to be relative to the top directory of the repository.
 */
export function magitEdiffStage(file: string): e8.Buffer {
  return withToplevel(() => {
    const bufA = magitGetRevisionBuffer("HEAD", file);
    const bufB = magitGetRevisionBuffer("{index}", file);
    const lockB = bufB !== undefined && e8.bufferLocalValue("buffer-read-only", bufB) === true;
    const bufC = getFileBuffer(file);
    // Use the same encoding for all three buffers or we may end up
    // changing the file in an unintended way: E8's are all UTF-8.
    const bufCStar = bufC ?? findFileNoselect(file);
    const bufAStar = e8.getBuffer(magitFindFileNoselect("HEAD", file, true))!;
    const bufBStar = e8.getBuffer(magitFindFileIndexNoselect(file, true))!;
    e8.withCurrentBuffer(bufBStar, () => e8.setReadOnly(false));
    return magitEdiffBuffers([() => bufA, () => bufAStar], [() => bufB, () => bufBStar], [() => bufC, () => bufCStar], null, () => {
      const b = buf(ctlVar("ediff-buffer-B") as e8.Buffer | null);
      if (live(b)) {
        if (lockB && live(bufB)) e8.withCurrentBuffer(bufB, () => e8.setReadOnly(true));
        if (e8.withCurrentBuffer(b, () => e8.bufferModified())) e8.withCurrentBuffer(b, () => e8.call("magit-update-index" as e8.CommandName));
      }
      const c = buf(ctlVar("ediff-buffer-C") as e8.Buffer | null);
      if (live(c) && e8.withCurrentBuffer(c, () => e8.bufferModified())) {
        e8.withCurrentBuffer(c, () => {
          if (e8.yOrNP(`Save file ${e8.bufferFileName()}? `)) e8.call("save-buffer");
        });
      }
    });
  });
}

/**
 * Compares REVA:FILEA with REVB:FILEB using Ediff, as magit-ediff-compare.
 * FILEA and FILEB have to be relative to the top directory of the
 * repository.  If REVA or REVB is undefined, then this stands for the
 * working tree state.
 */
export function magitEdiffCompare(revA: string | undefined, revB: string | undefined, fileA: string, fileB: string): e8.Buffer {
  const spec = (rev: string | undefined, file: string): BufferSpec =>
    rev ? [() => magitGetRevisionBuffer(rev, file), () => magitFindFileNoselect(rev, file)] : [() => getFileBuffer(file), () => findFileNoselect(file)];
  return magitEdiffBuffers(spec(revA, fileA), spec(revB, fileB));
}

/** The two revisions of ARG or a range or commit read, as magit-ediff-compare--read-revisions. */
function magitEdiffCompareReadRevisions(arg?: string): [string, string | undefined] {
  const input = arg ?? magitDiffReadRangeOrCommit("Compare range or commit");
  const range = magitSplitRange(input);
  return range ? [range[0], range[1]] : [input, undefined];
}

/**
 * Reads a file in REVB, and returns it and the corresponding file in REVA,
 * as magit-ediff-read-files: [FILEA, FILEB]. When FILEB is given, it is
 * used as REVB's file instead of prompting for it.
 */
export function magitEdiffReadFiles(revA: string, revB: string | undefined, fileB?: string): [string, string] {
  if (!(fileB && revB && magitRevisionFiles(revB).includes(fileB))) {
    const logArgs = e8.variable("magit-buffer-log-args");
    const followed =
      fileB &&
      truthy(e8.variable("magit-buffer-log-files")) &&
      String(e8.variable("major-mode")) === "magit-log-mode" &&
      Array.isArray(logArgs) &&
      logArgs.includes("--follow") &&
      revB
        ? magitRenamedFiles(revB, String(magitRootSection()?.children[0]?.value ?? "")).find(([from]) => from === fileB)?.[1]
        : undefined;
    fileB =
      followed ??
      magitReadFileChoice(
        `File to compare between ${revA} and ${revB ?? "the working tree"}`,
        magitChangedFiles(revA, revB),
        `No changed files between ${revA} and ${revB ?? "the working tree"}`,
      );
  }
  const fileA =
    (magitRevisionFiles(revA).includes(fileB!) ? fileB : undefined) ??
    (revB ? magitRenamedFiles(revB, revA).find(([from]) => from === fileB)?.[1] : undefined) ??
    magitReadFileChoice(
      `File in ${revA} to compare with ${fileB} in ${revB ?? "the working tree"}`,
      revB ? magitChangedFiles(revB, revA) : magitChangedFiles(revA),
      `No files have changed between ${revA} and ${revB}`,
    );
  return [fileA, fileB!];
}

/** Shows staged changes to FILE using Ediff, as magit-ediff-show-staged. */
export function magitEdiffShowStaged(file: string): e8.Buffer {
  return magitEdiffBuffers(
    [() => magitGetRevisionBuffer("HEAD", file), () => magitFindFileNoselect("HEAD", file)],
    [() => e8.getBuffer(magitRevisionBufferName("{index}", file)), () => magitFindFileIndexNoselect(file, true)],
  );
}

/** Shows unstaged changes to FILE using Ediff, as magit-ediff-show-unstaged. */
export function magitEdiffShowUnstaged(file: string): e8.Buffer {
  return magitEdiffBuffers([() => e8.getBuffer(magitRevisionBufferName("{index}", file)), () => magitFindFileIndexNoselect(file, true)], [() => getFileBuffer(file), () => findFileNoselect(file)]);
}

/** Shows changes between HEAD and the working tree in FILE using Ediff, as magit-ediff-show-working-tree. */
export function magitEdiffShowWorkingTree(file: string): e8.Buffer {
  return magitEdiffBuffers([() => magitGetRevisionBuffer("HEAD", file), () => magitFindFileNoselect("HEAD", file)], [() => getFileBuffer(file), () => findFileNoselect(file)]);
}

/** Shows changes introduced by COMMIT using Ediff, as magit-ediff-show-commit. */
export function magitEdiffShowCommit(commit: string): e8.Buffer {
  const revA = `${commit}^`;
  const revB = commit;
  return magitEdiffCompare(revA, revB, ...magitEdiffReadFiles(revA, revB, currentFileRelative()));
}

/**
 * Shows changes introduced by STASH using Ediff, as magit-ediff-show-stash:
 * magit-ediff-show-stash-with-index says whether a three-buffer Ediff is
 * used to distinguish the changes in the stash that were staged.
 */
export function magitEdiffShowStash(stash: string): e8.Buffer {
  const revA = `${stash}^1`;
  const revB = `${stash}^2`;
  const revC = stash;
  const [fileA, fileC] = magitEdiffReadFiles(revA, revC);
  const fileB = fileC;
  if (truthy(e8.variable("magit-ediff-show-stash-with-index")) && magitChangedFiles(revB, revA).includes(fileA)) {
    const spec = (rev: string, f: string): BufferSpec => [() => magitGetRevisionBuffer(rev, f), () => magitFindFileNoselect(rev, f)];
    return magitEdiffBuffers(spec(revA, fileA), spec(revB, fileB), spec(revC, fileC));
  }
  return magitEdiffCompare(revA, revC, fileA, fileC);
}

/** The current file relative to the top directory, as magit-current-file gives it. */
function currentFileRelative(): string | undefined {
  const file = magitCurrentFile();
  if (file === undefined || !e8.fileNameAbsoluteP(file)) return file;
  const top = e8.fileNameAsDirectory(magitToplevelOrError());
  return file.startsWith(top) ? file.slice(top.length) : file;
}

// The interactive commands, each reading its arguments as Magit's
// interactive specs do and calling the function above.

export const magitEdiffResolveAllCommand = e8.defineCommand({
  name: "magit-ediff-resolve-all",
  doc: "Resolve all conflicts in the FILE at point using Ediff.\n\nIf there is no file at point or if it doesn't have any unmerged\nchanges, then prompt for a file.\n\nSee info node `(magit) Ediffing' for more information about this\nand alternative commands.",
  run: () => void magitEdiffResolveAll(magitReadUnmergedFile()),
});
export const magitEdiffResolveRestCommand = e8.defineCommand({
  name: "magit-ediff-resolve-rest",
  doc: "Resolve outstanding conflicts in the FILE at point using Ediff.\n\nIf there is no file at point or if it doesn't have any unmerged\nchanges, then prompt for a file.\n\nSee info node `(magit) Ediffing' for more information about this\nand alternative commands.",
  run: () => void magitEdiffResolveRest(magitReadUnmergedFile()),
});
export const magitEdiffStageCommand = e8.defineCommand({
  name: "magit-ediff-stage",
  doc: "Stage and unstage changes to FILE using Ediff.\nFILE has to be relative to the top directory of the repository.",
  run: () => {
    const files = magitTrackedFiles();
    const current = currentFileRelative();
    magitEdiffStage(magitCompletingRead("Selectively stage file", files, { requireMatch: true, def: current && files.includes(current) ? current : undefined })!);
  },
});
export const magitEdiffCompareCommand = e8.defineCommand({
  name: "magit-ediff-compare",
  doc: "Compare REVA:FILEA with REVB:FILEB using Ediff.\n\nFILEA and FILEB have to be relative to the top directory of the\nrepository.  If REVA or REVB is nil, then this stands for the\nworking tree state.\n\nIf the region is active, use the revisions on the first and last\nline of the region.  With a prefix argument, instead of diffing\nthe revisions, choose a revision to view changes along, starting\nat the common ancestor of both revisions (i.e., use a \"...\"\nrange).",
  run: () => {
    const [revA, revB] = magitEdiffCompareReadRevisions();
    magitEdiffCompare(revA, revB, ...magitEdiffReadFiles(revA, revB));
  },
});
export const magitEdiffShowStagedCommand = e8.defineCommand({
  name: "magit-ediff-show-staged",
  doc: "Show staged changes using Ediff.\n\nThis only allows looking at the changes; to stage, unstage,\nand discard changes using Ediff, use `magit-ediff-stage'.\n\nFILE must be relative to the top directory of the repository.",
  run: () => void magitEdiffShowStaged(magitReadFileChoice("Show staged changes for file", magitStagedFiles(), "No staged files")),
});
export const magitEdiffShowUnstagedCommand = e8.defineCommand({
  name: "magit-ediff-show-unstaged",
  doc: "Show unstaged changes using Ediff.\n\nThis only allows looking at the changes; to stage, unstage,\nand discard changes using Ediff, use `magit-ediff-stage'.\n\nFILE must be relative to the top directory of the repository.",
  run: () => void magitEdiffShowUnstaged(magitReadFileChoice("Show unstaged changes for file", magitUnstagedFiles(), "No unstaged files")),
});
export const magitEdiffShowWorkingTreeCommand = e8.defineCommand({
  name: "magit-ediff-show-working-tree",
  doc: "Show changes between `HEAD' and working tree using Ediff.\nFILE must be relative to the top directory of the repository.",
  run: () => void magitEdiffShowWorkingTree(magitReadFileChoice("Show changes in file", magitChangedFiles("HEAD"), "No changed files")),
});
export const magitEdiffShowCommitCommand = e8.defineCommand({
  name: "magit-ediff-show-commit",
  doc: "Show changes introduced by COMMIT using Ediff.",
  run: () => void magitEdiffShowCommit(magitReadBranchOrCommit("Revision")),
});
export const magitEdiffShowStashCommand = e8.defineCommand({
  name: "magit-ediff-show-stash",
  doc: "Show changes introduced by STASH using Ediff.\n`magit-ediff-show-stash-with-index' controls whether a\nthree-buffer Ediff is used in order to distinguish changes in the\nstash that were staged.",
  run: () => void magitEdiffShowStash(magitReadStash("Stash")),
});

/** The functions a file can be given to, of the commands magit-ediff-dwim chooses between. */
const WITH_FILE: Record<string, (file: string) => unknown> = {
  "magit-ediff-resolve-rest": magitEdiffResolveRest,
  "magit-ediff-resolve-all": magitEdiffResolveAll,
  "magit-ediff-stage": magitEdiffStage,
  "magit-ediff-show-unstaged": magitEdiffShowUnstaged,
  "magit-ediff-show-staged": magitEdiffShowStaged,
};

/**
 * Compares, stages, or resolves using Ediff, guessing what file, and what
 * commit or range, as magit-ediff-dwim.
 */
export function magitEdiffDwim(): void {
  const s = currentSection();
  if (s?.type === "hunk" && s.parent) {
    e8.saveExcursion(() => {
      e8.gotoChar(s.parent!.start);
      magitEdiffDwim();
    });
    return;
  }
  const range = magitDiffDwimTarget();
  const file = currentFileRelative();
  const showOnHunks = truthy(e8.variable("magit-ediff-dwim-show-on-hunks"));
  let command: string | undefined;
  let revA: string | undefined;
  let revB: string | undefined;
  if (!showOnHunks && (range === "unstaged" || range === "staged")) {
    command = magitAnythingUnmergedP() ? String(e8.variable("magit-ediff-dwim-resolve-function")) : "magit-ediff-stage";
  } else if (range === "unstaged") command = "magit-ediff-show-unstaged";
  else if (range === "staged") command = "magit-ediff-show-staged";
  else if (Array.isArray(range) && range[0] === "commit") {
    command = "magit-ediff-show-commit";
    revB = range[1];
  } else if (Array.isArray(range) && range[0] === "stash") {
    command = "magit-ediff-show-stash";
    revB = range[1];
  } else if (typeof range === "string" && range !== "unmerged" && range !== "undefined") {
    [revA, revB] = magitEdiffCompareReadRevisions(range);
    command = "magit-ediff-compare";
  } else if (String(e8.variable("major-mode")) === "magit-diff-mode") {
    const type = magitDiffType();
    if (type === "committed") [revA, revB] = magitEdiffCompareReadRevisions(String(e8.variable("magit-buffer-range")));
    else if (!showOnHunks) command = "magit-ediff-stage";
    else if (type === "unstaged") command = "magit-ediff-show-unstaged";
    else if (type === "staged") command = "magit-ediff-show-staged";
  }
  if (!command) {
    const chosen = magitReadCharCase("Failed to read your mind; do you want to ", true, [
      ["c", "[c]ommit", "magit-ediff-show-commit"],
      ["r", "[r]ange", "magit-ediff-compare"],
      ["s", "[s]tage", "magit-ediff-stage"],
      ["m", "[m] resolve remaining conflicts", "magit-ediff-resolve-rest"],
      ["M", "[M] resolve all conflicts", "magit-ediff-resolve-all"],
    ]);
    e8.call(chosen as e8.CommandName);
  } else if (command === "magit-ediff-compare") magitEdiffCompare(revA, revB, ...magitEdiffReadFiles(revA!, revB, file));
  else if (command === "magit-ediff-show-commit") magitEdiffShowCommit(revB!);
  else if (command === "magit-ediff-show-stash") magitEdiffShowStash(revB!);
  else if (file) {
    const fn = WITH_FILE[command];
    if (fn) fn(file);
    else if (command === "magit-git-mergetool") e8.call(magitGitMergetool);
    else e8.funcall(command, file);
  } else e8.call(command as e8.CommandName);
}

export const magitEdiffDwimCommand = e8.defineCommand({
  name: "magit-ediff-dwim",
  doc: "Compare, stage, or resolve using Ediff.\nThis command tries to guess what file, and what commit or range\nthe user wants to compare, stage, or resolve using Ediff.  It\nmight only be able to guess either the file, or range or commit,\nin which case the user is asked about the other.  It might not\nalways guess right, in which case the appropriate `magit-ediff-*'\ncommand has to be used explicitly.  If it cannot read the user's\nmind at all, then it asks the user for a command to run.",
  run: () => magitEdiffDwim(),
});

export const magitEdiff = transientDefinePrefix("magit-ediff", {
  doc: "Show differences using the Ediff package.",
  groups: [
    {
      description: "Ediff",
      items: [
        { items: [["E", "Dwim", magitEdiffDwimCommand], ["s", "Stage", magitEdiffStageCommand]] },
        { items: [["m", "Resolve rest", magitEdiffResolveRestCommand], ["M", "Resolve all conflicts", magitEdiffResolveAllCommand], ["t", "Resolve using mergetool", magitGitMergetool]] },
        { items: [["u", "Show unstaged", magitEdiffShowUnstagedCommand], ["i", "Show staged", magitEdiffShowStagedCommand], ["w", "Show worktree", magitEdiffShowWorkingTreeCommand]] },
        { items: [["c", "Show commit", magitEdiffShowCommitCommand], ["r", "Show range", magitEdiffCompareCommand], ["z", "Show stash", magitEdiffShowStashCommand]] },
      ],
    },
  ],
});

/** Kills Ediff's own buffers and the control panel's window, as magit-ediff-cleanup-auxiliary-buffers. */
export function magitEdiffCleanupAuxiliaryBuffers(): void {
  const ctlBuf = ctlVar("ediff-control-buffer") as e8.Buffer | null;
  const ctlWin = live(ctlBuf) ? (e8.funcall("ediff-get-visible-buffer-window", ctlBuf) as Win | null) : null;
  for (const v of ["ediff-diff-buffer", "ediff-custom-diff-buffer", "ediff-fine-diff-buffer", "ediff-tmp-buffer", "ediff-error-buffer", "ediff-msg-buffer", "ediff-debug-buffer"]) {
    e8.funcall("ediff-kill-buffer-carefully", ctlVar(v) ?? null);
  }
  // E8 has no control frame: the control panel is in a window.
  if (isWindow(ctlWin) && e8.windowList().includes(ctlWin) && e8.windowList().length > 1) e8.deleteWindow(ctlWin);
  e8.funcall("ediff-kill-buffer-carefully", ctlBuf ?? null);
}

/** Puts the windows back as they were before Ediff, as magit-ediff-restore-previous-winconf. */
export function magitEdiffRestorePreviousWinconf(): void {
  if (magitEdiffPreviousWinconf !== undefined) e8.setWindowConfiguration(magitEdiffPreviousWinconf);
}

e8.defun("magit-ediff-cleanup-auxiliary-buffers", magitEdiffCleanupAuxiliaryBuffers);
e8.defun("magit-ediff-restore-previous-winconf", magitEdiffRestorePreviousWinconf);
e8.addHook("magit-ediff-quit-hook", magitEdiffRestorePreviousWinconf);
e8.addHook("magit-ediff-quit-hook", magitEdiffCleanupAuxiliaryBuffers);
