// SPDX-License-Identifier: GPL-3.0-or-later
//
// Files and blobs, after magit-files.el: visiting a file as it is at a
// revision or in the index (magit-find-file), stepping through the
// revisions of a blob (magit-blob-mode's n and p), updating the index
// from a buffer, the commands acting on the visited file or one read
// (stage, unstage, untrack, rename, delete, checkout), and the file
// dispatch menu (C-c M-g).
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { magitRegionValues, currentSection } from "magit-section";
import { truthy } from "subr";
import * as transientModule from "transient";
import { transientDefinePrefix } from "transient";
import { magitCompletingRead, magitConfirm } from "magit-base";
import {
  magitAnythingStagedP,
  magitBranchOrCommitAtPoint,
  magitCurrentFile,
  magitFileIgnoredP,
  magitFileRelativeName,
  magitFileTrackedP,
  magitGetCurrentBranch,
  magitGitdir,
  magitGitLines,
  magitGitRun,
  magitGitString,
  magitListFiles,
  magitListRefnames,
  magitReadBranchOrCommit,
  magitRevAbbrev,
  magitRevFormat,
  magitRevisionFiles,
  magitToplevel,
  magitToplevelOrError,
  magitUntrackedFiles,
} from "magit-git";
import { magitCallGit, magitRunGit } from "magit-process";
import { magitGetModeBuffer, magitRefresh } from "magit-mode";
import { magitAge } from "magit-margin";
import { magitWipCommitAfterApply, magitWipCommitBeforeChange } from "magit-wip";

e8.defineVariable({ name: "magit-find-file-hook", doc: "Hook run after visiting a blob with magit-find-file.", value: ["magit-blob-mode"] });
e8.defineVariable({ name: "magit-find-index-hook", doc: "Hook run after visiting a file's version in the index.", value: ["magit-blob-mode"] });
e8.defineVariable({ name: "magit-buffer-file-name", doc: "The file whose blob the buffer visits.", value: null });
e8.defineVariable({ name: "magit-buffer-refname", doc: "The revision as given, of the blob the buffer visits.", value: null });

const PSEUDO_REVS = ["{worktree}", "{index}"];

/** Reads a revision and a file in it, as magit-find-file-read-args. */
export function magitFindFileReadArgs(prompt: string): [string, string] {
  const rev = magitCompletingRead("Find file from revision", [...PSEUDO_REVS, ...magitListRefnames(undefined, true)], {
    requireMatch: "any",
    history: "magit-revision-history",
    def: magitBranchOrCommitAtPoint() ?? magitGetCurrentBranch(),
  })!;
  return [rev, magitReadFileFromRev(PSEUDO_REVS.includes(rev) ? "HEAD" : rev, prompt)];
}

/** FILE relative to DIR, as file-relative-name for a file under it. */
const fileRelativeName = (file: string, dir: string): string => {
  const d = e8.fileNameAsDirectory(dir);
  return file.startsWith(d) ? file.slice(d.length) : file;
};
/** The buffer visiting FILE, as find-buffer-visiting. */
const findBufferVisiting = (file: string): string | undefined =>
  e8.bufferList().find((b) => e8.withCurrentBuffer(b, () => e8.bufferFileName()) === file);

/** REV abbreviated if it is a full hash, as magit--abbrev-if-hash. */
const abbrevIfHash = (rev: string): string => (/^[0-9a-f]{40,}$/.test(rev) ? (magitRevAbbrev(rev) ?? rev) : rev);

/** The buffer of FILE at REV's name, as magit-get-revision-buffer. */
export const magitRevisionBufferName = (rev: string, file: string): string => `${file}.~${rev.replace(/\//g, "_")}~`;

/** Turns on the major mode auto-mode-alist gives FILE, as set-auto-mode. */
function setAutoMode(file: string): void {
  for (const entry of (e8.variable("auto-mode-alist") as unknown as [string, string][] | null) ?? []) {
    const [re, mode] = entry;
    if (typeof re === "string" && typeof mode === "string" && e8.stringMatch(re, file) !== undefined && e8.fboundp(mode)) return void e8.call(mode as e8.CommandName);
  }
}

/** Fills the blob buffer from git again, as magit-revert-rev-file-buffer. */
export function magitRevertRevFileBuffer(): void {
  const refname = String(e8.variable("magit-buffer-refname"));
  const top = magitToplevel() ?? String(e8.variable("default-directory"));
  const file = fileRelativeName(String(e8.variable("magit-buffer-file-name")), top);
  const r = magitGitRun(["cat-file", "-p", refname === "{index}" ? `:${file}` : `${refname}:${file}`], { dir: top });
  e8.letBind({ "inhibit-read-only": true }, () => {
    e8.deleteRegion(e8.pointMin(), e8.pointMax());
    e8.insert(r.output);
  });
  // The major mode the file's name asks for, as normal-mode with
  // buffer-file-name bound; the mode clears the buffer's locals, so they
  // are set again after it, as Magit's are permanent.
  const locals = ["magit-buffer-revision", "magit-buffer-refname", "magit-buffer-file-name", "default-directory"].map((v) => [v, e8.variable(v)] as const);
  setAutoMode(String(e8.variable("magit-buffer-file-name")));
  for (const [v, value] of locals) {
    e8.makeLocalVariable(v);
    e8.setVariable(v, value ?? null);
  }
  e8.setVariable("buffer-read-only", true);
  e8.setBufferModified(false);
  e8.gotoChar(e8.pointMin());
}

/**
 * Reads FILE as it is at REV into a buffer, giving the buffer, as
 * magit-find-file-noselect: REV may be {worktree} for the file itself or
 * {index} for the index's version. With REVERT, or ask-revert after
 * asking, fills an existing buffer again.
 */
export function magitFindFileNoselect(revIn: string, file: string, revert: boolean | "ask-revert" = false): string {
  const topdir = magitToplevelOrError();
  const absolute = e8.fileNameAbsoluteP(file);
  const fileAbs = absolute ? file : e8.expandFileName(file, topdir);
  const fileRel = absolute ? fileRelativeName(file, topdir) : file;
  const defdir = e8.fileNameDirectory(fileAbs) ?? topdir;
  const rev = abbrevIfHash(revIn);
  if (rev === "{worktree}") return e8.findFileNoselect(fileAbs);
  const name = magitRevisionBufferName(rev, fileRel);
  e8.getBufferCreate(name);
  e8.withCurrentBuffer(name, () => {
    const fresh = !e8.variable("magit-buffer-file-name");
    if (fresh || (revert === "ask-revert" ? e8.yOrNP(`${name} already exists; revert it? `) : revert)) {
      for (const [v, value] of [
        ["magit-buffer-revision", rev],
        ["magit-buffer-refname", rev],
        ["magit-buffer-file-name", fileAbs],
      ] as const) {
        e8.makeLocalVariable(v);
        e8.setVariable(v, value);
      }
      e8.makeLocalVariable("default-directory");
      e8.setVariable("default-directory", e8.fileExistsP(defdir) ? defdir : topdir);
      magitRevertRevFileBuffer();
      for (const hook of ((e8.variable(rev === "{index}" ? "magit-find-index-hook" : "magit-find-file-hook") as string[] | null) ?? [])) {
        if (e8.fboundp(hook)) e8.call(hook as e8.CommandName);
      }
    }
  });
  return name;
}

/** Visits FILE at REV with SHOW, at the line and column point is on if this buffer is about the same file, as magit-find-file--internal. */
function findFileInternal(rev: string, file: string, show: (buffer: string) => void): string {
  const buf = magitFindFileNoselect(rev, file);
  let line: number | undefined;
  let col: number | undefined;
  const visited = magitFileRelativeName() ?? (e8.variable("magit-buffer-file-name") ? magitFileRelativeName(String(e8.variable("magit-buffer-file-name"))) : undefined);
  if (visited !== undefined) {
    // Magit moves the line by the diff between the revisions, with
    // magit-diff-visit--offset; the same line is kept here.
    if (visited === file) {
      line = e8.lineOf(e8.point()) + 1;
      col = e8.point() - e8.lineStart(e8.lineOf(e8.point()));
    }
  }
  show(buf);
  if (line !== undefined) {
    e8.withCurrentBuffer(buf, () => {
      const l = Math.min(line! - 1, e8.lineCount() - 1);
      e8.gotoChar(Math.min(e8.lineStart(l) + (col ?? 0), e8.lineEnd(l)));
    });
  }
  return buf;
}

export const magitFindFile = e8.defineCommand({
  name: "magit-find-file",
  doc: "View FILE from REV.  Switch to a buffer visiting blob REV:FILE, creating one if none already exists.  If prior to calling this command the current buffer and/or cursor position is about the same file, then go to the line and column corresponding to that location.",
  run: () => {
    const [rev, file] = magitFindFileReadArgs("Find file");
    findFileInternal(rev, file, (b) => e8.call("switch-to-buffer", b));
  },
});
export const magitFindFileOtherWindow = e8.defineCommand({
  name: "magit-find-file-other-window",
  doc: "View FILE from REV, in another window.",
  run: () => {
    const [rev, file] = magitFindFileReadArgs("Find file in other window");
    findFileInternal(rev, file, (b) => e8.call("switch-to-buffer-other-window", b));
  },
});
export const magitFindFileOtherFrame = e8.defineCommand({
  name: "magit-find-file-other-frame",
  doc: "View FILE from REV, in another frame.",
  run: () => {
    const [rev, file] = magitFindFileReadArgs("Find file in other frame");
    findFileInternal(rev, file, (b) => e8.call(e8.fboundp("switch-to-buffer-other-frame") ? "switch-to-buffer-other-frame" : "switch-to-buffer-other-window", b));
  },
});

/** Reads FILE from the index into a buffer, as magit-find-file-index-noselect. */
export const magitFindFileIndexNoselect = (file: string, revert: boolean | "ask-revert" = "ask-revert"): string => magitFindFileNoselect("{index}", file, revert);

export const magitUpdateIndex = e8.defineCommand({
  name: "magit-update-index",
  doc: "Update the index with the contents of the current buffer.  The current buffer has to be visiting a file in the index, which is done using magit-find-index-noselect.",
  run: () => {
    const fileAbs = String(e8.variable("magit-buffer-file-name") ?? "");
    const file = magitFileRelativeName(fileAbs) ?? fileAbs;
    if (e8.variable("magit-buffer-refname") !== "{index}") e8.userError(`${file} isn't visiting the index`);
    if (e8.yOrNP(`Update index with contents of ${e8.bufferName()}?`)) {
      const index = e8.expandFileName(`magit-update-index-${Date.now()}`, magitGitdir());
      magitWipCommitBeforeChange([file], " before un-/stage");
      try {
        e8.writeTextFile(index, e8.bufferText());
        const top = magitToplevelOrError();
        e8.letBind({ "default-directory": top }, () => {
          const mode = (magitGitString("ls-files", "-s", file) ?? "100644").slice(0, 6);
          const hash = magitGitString("hash-object", "-t", "blob", "-w", `--path=${file}`, "--", index);
          magitCallGit("update-index", "--cacheinfo", mode, hash, file);
        });
      } finally {
        if (e8.fileExistsP(index)) e8.deleteFile(index);
      }
      e8.setBufferModified(false);
      magitWipCommitAfterApply([file], " after un-/stage");
    } else e8.message("Abort");
    const status = magitGetModeBuffer("magit-status-mode");
    if (status) e8.withCurrentBuffer(status, () => magitRefresh());
  },
});

const findGitConfigFile = (name: string, prompt: string, show: string) =>
  e8.defineCommand({
    name,
    doc: `Edit a file located in the current repository's git directory${show === "find-file" ? "" : show === "find-file-other-window" ? ", in another window" : ", in another frame"}.`,
    run: () => {
      const file = e8.readFileName(prompt, { dir: magitGitdir() });
      e8.call((e8.fboundp(show) ? show : "find-file") as e8.CommandName, e8.expandFileName(file, magitGitdir()));
    },
  });
export const magitFindGitConfigFile = findGitConfigFile("magit-find-git-config-file", "Find file: ", "find-file");
export const magitFindGitConfigFileOtherWindow = findGitConfigFile("magit-find-git-config-file-other-window", "Find file in other window: ", "find-file-other-window");
export const magitFindGitConfigFileOtherFrame = findGitConfigFile("magit-find-git-config-file-other-frame", "Find file in other frame: ", "find-file-other-frame");

// Blob mode.

export const magitBuryBuffer = e8.defineCommand({
  name: "magit-bury-buffer",
  doc: "Bury the current buffer, or with a prefix argument kill it.",
  params: [{ name: "kill", kind: "prefix" }],
  run: (kill: e8.Value) => void (truthy(kill) ? e8.call("kill-buffer", e8.bufferName()) : e8.call("bury-buffer")),
});
export const magitBuryOrKillBuffer = e8.defineCommand({
  name: "magit-bury-or-kill-buffer",
  doc: "Bury the current buffer if displayed in multiple windows, else kill it.  With a prefix argument only bury the buffer even if it is only displayed in a single window.",
  params: [{ name: "bury", kind: "prefix" }],
  run: (bury: e8.Value) => {
    const shown = e8.windowList().filter((w) => e8.windowBuffer(w) === e8.bufferName()).length;
    if (truthy(bury) || shown > 1) e8.call("bury-buffer");
    else e8.call("kill-buffer", e8.bufferName());
  },
});
export const magitKillThisBuffer = e8.defineCommand({ name: "magit-kill-this-buffer", doc: "Kill the current buffer.", run: () => void e8.call("kill-buffer", e8.bufferName()) });

/** The revision and file of the blob before REV's, as magit-blob-ancestor. */
export function magitBlobAncestor(rev: string | undefined, file: string): [string, string] | undefined {
  if (rev === "{worktree}" && magitAnythingStagedP(file)) return ["{index}", file];
  if (rev === "{worktree}" || rev === "{index}") return [magitRevAbbrev("HEAD") ?? "HEAD", file];
  const top = magitToplevelOrError();
  const lines = e8.letBind({ "default-directory": top }, () => magitGitLines("log", "-2", "--format=%h", "--name-only", "--follow", rev ?? "HEAD", "--", file)).filter((l) => l !== "");
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i], lines[i + 1]]);
  return pairs[rev ? 1 : 0];
}

/** The revision and file of the blob after REV's, as magit-blob-successor. */
export function magitBlobSuccessor(rev: string, file: string): [string, string] | undefined {
  if (rev === "{worktree}") return undefined;
  if (rev === "{index}") return ["{worktree}", file];
  const top = magitToplevelOrError();
  const lines = e8.letBind({ "default-directory": top }, () => magitGitLines("log", "--format=%h", "--name-only", "--follow", "HEAD", "--", file)).filter((l) => l !== "");
  for (let i = 0; i + 2 < lines.length; i += 2) if (lines[i + 2] === rev) return [lines[i], lines[i + 1]];
  return [magitAnythingStagedP(file) ? "{index}" : "{worktree}", file];
}

/** The file the buffer visits or the blob's, relative to the top, as magit-buffer-file-name. */
const bufferFileName = (): string | undefined => {
  const f = e8.variable("magit-buffer-file-name") ?? e8.bufferFileName();
  return typeof f === "string" && f !== "" ? f : undefined;
};

/** Visits the blob REV:FILE, saying its commit's subject and age, as magit-blob-visit. */
function blobVisit(rev: string, file: string): void {
  findFileInternal(rev, file, (b) => e8.call("switch-to-buffer", b));
  if (!PSEUDO_REVS.includes(rev)) {
    const [count, unit] = magitAge(magitRevFormat("%ct", rev) ?? "0");
    e8.message(`${magitRevFormat("%s", rev)} (${count} ${unit} ago)`);
  }
}

export const magitBlobPrevious = e8.defineCommand({
  name: "magit-blob-previous",
  doc: "Visit the previous blob which modified the current file.",
  run: () => {
    const rev = String(e8.variable("magit-buffer-revision") ?? "") || "{worktree}";
    const fileAbs = bufferFileName();
    if (!fileAbs) e8.userError("Buffer isn't visiting a file or blob");
    const prev = magitBlobAncestor(rev, magitFileRelativeName(fileAbs!) ?? fileAbs!);
    if (!prev) e8.userError("You have reached the beginning of time");
    blobVisit(...prev!);
  },
});
export const magitBlobNext = e8.defineCommand({
  name: "magit-blob-next",
  doc: "Visit the next blob which modified the current file.",
  run: () => {
    const rev = String(e8.variable("magit-buffer-revision") ?? "") || "{worktree}";
    const fileAbs = bufferFileName();
    if (!fileAbs) e8.userError("Buffer isn't visiting a file or blob");
    const next = magitBlobSuccessor(rev, magitFileRelativeName(fileAbs!) ?? fileAbs!);
    if (!next) e8.userError("You have reached the end of time");
    blobVisit(...next!);
  },
});
export const magitBlobVisitFile = e8.defineCommand({
  name: "magit-blob-visit-file",
  doc: "View the file from the worktree corresponding to the current blob.  When visiting a blob or the version from the index, then go to the same location in the respective file in the working tree.",
  run: () => {
    const fileAbs = bufferFileName();
    const file = fileAbs ? magitFileRelativeName(fileAbs) : undefined;
    if (!file) e8.userError("Not visiting a blob");
    findFileInternal("{worktree}", file!, (b) => e8.call("switch-to-buffer", b));
  },
});

export const magitBlobMode = e8.defineMinorMode({
  name: "magit-blob-mode",
  doc: "Enable some Magit features in blob-visiting buffers.",
  bindings: {
    p: magitBlobPrevious,
    n: magitBlobNext,
    b: "magit-blame-addition" as e8.CommandName,
    r: "magit-blame-removal" as e8.CommandName,
    f: "magit-blame-reverse" as e8.CommandName,
    q: magitBuryOrKillBuffer,
  },
});

// File commands.

/** Runs BODY in the repository's top directory, as magit-with-toplevel. */
const withToplevel = <T>(body: () => T): T => e8.letBind({ "default-directory": magitToplevelOrError() }, body);

/** Stages FILES, relative to the top or absolute, all changes without, with ARG such as --force, as magit-stage-1. */
function magitStage1(arg: string | undefined, files: string[]): void {
  magitWipCommitBeforeChange(files, " before stage");
  magitRunGit("add", arg, files.length > 0 ? ["--", ...files] : ".");
  if (e8.fboundp("magit-turn-on-auto-revert-mode-if-desired") && e8.variable("magit-auto-revert-mode") === true) {
    for (const f of files) e8.funcall("magit-turn-on-auto-revert-mode-if-desired", e8.expandFileName(f));
  }
  magitWipCommitAfterApply(files, " after stage");
}

/** Stages FILES, as magit-stage-files; FORCE stages ignored ones too. */
export const magitStageFiles = (files: string[], force = false): void => withToplevel(() => magitStage1(force ? "--force" : undefined, files));

/** Unstages FILES, as magit-unstage-1. */
function magitUnstage1(files: string[]): void {
  magitWipCommitBeforeChange(files, " before unstage");
  if (!magitGitString("rev-parse", "--verify", "-q", "HEAD")) magitRunGit("rm", "--cached", "-q", "--", files);
  else magitRunGit("reset", "-q", "HEAD", "--", files);
  magitWipCommitAfterApply(files, " after unstage");
}

/** Unstages FILES, as magit-unstage-files. */
export const magitUnstageFiles = (files: string[]): void => withToplevel(() => magitUnstage1(files));

export const magitFileStage = e8.defineCommand({
  name: "magit-file-stage",
  doc: "Stage all changes to the file being visited in the current buffer.",
  run: () => {
    const file = e8.bufferFileName();
    if (!file) e8.userError("Not visiting a file");
    const force = magitFileIgnoredP(String(file)) ? (e8.yOrNP("Visited file is ignored; stage anyway?") ? "--force" : e8.userError("Abort")) : undefined;
    withToplevel(() => magitStage1(force, [magitFileRelativeName()!]));
  },
});
export const magitFileUnstage = e8.defineCommand({
  name: "magit-file-unstage",
  doc: "Unstage all changes to the file being visited in the current buffer.",
  run: () => {
    if (!e8.bufferFileName()) e8.userError("Not visiting a file");
    magitUnstageFiles([magitFileRelativeName()!]);
  },
});

/** Asks before acting on FILES, as magit-confirm-files. */
const confirmFiles = (action: string, files: string[], prompt: string): string[] => magitConfirm(action, `${prompt} %s`, `${prompt} %d files`, files) as string[];

export const magitFileUntrack = e8.defineCommand({
  name: "magit-file-untrack",
  doc: "Untrack the selected FILES or one file read in the minibuffer.  With a prefix argument FORCE do so even when the files have staged as well as unstaged changes.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.Value) => {
    const region = (magitRegionValues("file", true) as string[] | undefined) ?? [];
    let files: string[];
    if (region.length > 0) {
      if (!magitFileTrackedP(region[0])) e8.userError("Already untracked");
      files = confirmFiles("untrack", region, "Untrack");
    } else files = [magitReadTrackedFile("Untrack file")];
    withToplevel(() => magitRunGit("rm", "--cached", truthy(force) ? "--force" : undefined, "--", ...files));
  },
});
export const magitFileRename = e8.defineCommand({
  name: "magit-file-rename",
  doc: "Rename or move FILE to NEWNAME.  NEWNAME may be a file or directory name.  If FILE isn't tracked in Git, fallback to using rename-file.",
  run: () => {
    const rel = magitReadFile("Rename file");
    const file = e8.expandFileName(rel, magitToplevel());
    const newname = e8.expandFileName(e8.readFileName(`Move ${rel} to destination: `, { dir: e8.fileNameDirectory(file) }));
    const oldbuf = findBufferVisiting(file);
    const dstdir = e8.fileNameDirectory(newname) ?? "/";
    const dstfile = newname.endsWith("/") ? newname + e8.fileNameNondirectory(file) : newname;
    if (oldbuf && e8.withCurrentBuffer(oldbuf, () => e8.bufferModified())) e8.userError(`Save ${file} before moving it`);
    if (e8.fileExistsP(dstfile)) e8.userError(`${dstfile} already exists`);
    if (!e8.fileExistsP(dstdir)) e8.userError(`Destination directory ${dstdir} does not exist`);
    if (magitFileTrackedP(file)) magitCallGit("mv", file, newname);
    else e8.renameFile(file, newname);
    if (oldbuf) e8.withCurrentBuffer(oldbuf, () => e8.setVisitedFileName(dstfile));
    magitRefresh();
  },
});
export const magitFileDelete = e8.defineCommand({
  name: "magit-file-delete",
  doc: "Delete the selected FILES or one file read in the minibuffer.  With a prefix argument FORCE do so even when the files have uncommitted changes.  When the files aren't being tracked in Git, then fallback to using delete-file.",
  params: [{ name: "force", kind: "prefix" }],
  run: (force: e8.Value) => {
    const region = (magitRegionValues("file", true) as string[] | undefined) ?? [];
    const files = region.length > 0 ? confirmFiles("delete", region, "Delete") : [magitReadFile("Delete file")];
    if (magitFileTrackedP(files[0])) withToplevel(() => magitCallGit("rm", truthy(force) ? "--force" : undefined, "--", ...files));
    else {
      const top = magitToplevelOrError();
      for (const f of files) e8.deleteFile(e8.expandFileName(f, top));
    }
    magitRefresh();
  },
});
export const magitFileCheckout = e8.defineCommand({
  name: "magit-file-checkout",
  doc: "Checkout FILE from REV.",
  run: () => {
    const rev = magitReadBranchOrCommit("Checkout from revision", (e8.variable("magit-buffer-revision") as string | null) ?? undefined);
    const file = magitReadFileFromRev(rev, "Checkout file", undefined, true);
    withToplevel(() => magitRunGit("checkout", rev, "--", file));
  },
});

// Reading files.

/** The directories in REV, as magit-revision-directories. */
const revisionDirectories = (rev: string): string[] => magitGitLines("ls-tree", "-d", "-r", "--name-only", rev);

/** Reads a file in REV, as magit-read-file-from-rev. */
export function magitReadFileFromRev(rev: string, prompt: string, def?: string, includeDirs = false): string {
  let files = magitRevisionFiles(rev);
  if (includeDirs) files = [...files, ...revisionDirectories(rev)].sort();
  const d = def ?? magitCurrentFile();
  return magitCompletingRead(prompt, files, { requireMatch: true, history: "magit-read-file-hist", def: d && files.includes(d) ? d : undefined })!;
}

/** Reads a file of the repository, tracked or, unless TRACKED-ONLY, untracked, as magit-read-file. */
export function magitReadFile(prompt: string, trackedOnly = false): string {
  return withToplevel(() => {
    const choices = [...magitListFiles(), ...(trackedOnly ? [] : magitUntrackedFiles())];
    const s = currentSection();
    const atPoint = s && (s.type === "file" || s.type === "module") ? (typeof s.value === "string" ? s.value : (s.value as { file?: string })?.file) : magitFileRelativeName(undefined);
    return magitCompletingRead(prompt, choices, { requireMatch: true, def: atPoint && choices.includes(atPoint) ? atPoint : undefined })!;
  });
}
/** Reads a tracked file, as magit-read-tracked-file. */
export const magitReadTrackedFile = (prompt: string): string => magitReadFile(prompt, true);

/** Reads one of the files with unresolved conflicts, as magit-read-unmerged-file. */
export function magitReadUnmergedFile(prompt?: string): string {
  const current = magitCurrentFile();
  const unmerged = magitGitLines("diff-files", "--name-only", "--diff-filter=U");
  if (unmerged.length === 0) e8.userError("There are no unresolved conflicts");
  return magitCompletingRead(prompt ?? "Resolve file", unmerged, { requireMatch: true, def: current && unmerged.includes(current) ? current : undefined })!;
}

/** Reads one of FILES, or gives the only one, as magit-read-file-choice. */
export function magitReadFileChoice(prompt: string, files: string[], error?: string, def?: string): string {
  if (files.length === 0) e8.userError(error ?? "No file choices");
  if (files.length === 1) return files[0];
  const d = def ?? magitCurrentFile();
  return magitCompletingRead(prompt, files, { requireMatch: true, history: "magit-read-file-hist", def: d && files.includes(d) ? d : undefined })!;
}

/** Reads a file changed in REV-OR-RANGE, as magit-read-changed-file. */
export const magitReadChangedFile = (revOrRange: string, prompt: string, def?: string): string =>
  magitReadFileChoice(prompt, magitGitLines("diff", "--name-only", revOrRange.includes("..") ? revOrRange : `${revOrRange}^!`), `No file changed in ${revOrRange}`, def);

// The file dispatch menu.

const hasLevels = "transientPrefixLevel" in transientModule;
const lvl = (level: number, options: object = {}) => ({ ...options, level, ...(hasLevels || level <= 4 ? {} : { if: () => false }) });
const visiting = (): boolean => magitFileRelativeName() !== undefined;
const dired = (): boolean => String(e8.variable("major-mode")) === "dired-mode";

export const magitFileDispatch = transientDefinePrefix("magit-file-dispatch", {
  doc: "Invoke a Magit command that acts on the visited file.  When invoked outside a file-visiting buffer, then fall back to the menu of commands that act on files read.",
  groups: [
    {
      if: visiting,
      class: "columns",
      items: [
        {
          description: "File actions",
          items: [
            ["  s", "Stage", magitFileStage, { if: () => !dired() }],
            ["  s", "Stage", "magit-dired-stage", { if: dired }],
            ["  u", "Unstage", magitFileUnstage, { if: () => !dired() }],
            ["  u", "Unstage", "magit-dired-unstage", { if: dired }],
            [", x", "Untrack", magitFileUntrack],
            [", r", "Rename", magitFileRename],
            [", k", "Delete", magitFileDelete],
            [", c", "Checkout", magitFileCheckout],
          ],
        },
        { description: "Inspect", items: [["D", "Diff...", "magit-diff"], ["d", "Diff", "magit-diff-buffer-file"]] },
        {
          description: "",
          items: [
            ["L", "Log...", "magit-log"],
            ["l", "Log", "magit-log-buffer-file", { if: () => !dired() }],
            ["l", "Log", "magit-dired-log", { if: dired }],
            ["t", "Trace", "magit-log-trace-definition"],
            ["M", "Merged", "magit-log-merged", lvl(7)],
          ],
        },
        {
          description: "",
          items: [
            ["B", "Blame...", "magit-blame"],
            ["b", "Blame", "magit-blame-addition"],
            ["r", "...removal", "magit-blame-removal"],
            ["f", "...reverse", "magit-blame-reverse"],
            ["m", "Blame echo", "magit-blame-echo"],
            ["q", "Quit blame", "magit-blame-quit"],
          ],
        },
        {
          description: "Navigate",
          items: [
            ["p", "Prev blob", magitBlobPrevious],
            ["n", "Next blob", magitBlobNext],
            ["v", "Goto blob", magitFindFile],
            ["V", "Goto file", magitBlobVisitFile],
            ["g", "Goto status", "magit-status-here"],
            ["G", "Goto magit", "magit-display-repository-buffer"],
          ],
        },
        { description: "More actions", items: [["c", "Commit", "magit-commit"], ["e", "Edit line", "magit-edit-line-commit"]] },
      ],
    },
    {
      ifNot: visiting,
      class: "columns",
      items: [
        {
          description: "File actions",
          items: [
            ["s", "Stage", "magit-stage-files"],
            ["u", "Unstage", "magit-unstage-files"],
            ["x", "Untrack", magitFileUntrack],
            ["r", "Rename", magitFileRename],
            ["k", "Delete", magitFileDelete],
            ["c", "Checkout", magitFileCheckout],
          ],
        },
        { description: "Navigate", items: [["g", "Goto status", "magit-status-here", { if: () => String(e8.variable("major-mode")) !== "magit-status-mode" }], ["G", "Goto magit", "magit-display-repository-buffer"]] },
      ],
    },
  ],
});

