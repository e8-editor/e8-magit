// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bundles, after magit-bundle.el: creating a bundle of refs, creating one
// whose branch a tag tracks and updating it later, verifying a bundle
// and listing its heads.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { transientArgs, transientDefinePrefix } from "transient";
import { magitFileAtPoint, magitGetCurrentBranch, magitGitRun, magitReadBranch, magitReadTag, magitToplevelOrError } from "magit-git";
import { magitGit, magitProcessBuffer } from "magit-process";

/** Runs git bundle COMMAND on FILE, as magit-git-bundle. */
export const magitGitBundle = (command: string, file: string, refs: string[] = [], args: string[] = []): number => magitGit("bundle", command, e8.expandFileName(file), ...refs, ...args);

/** Reads several refnames separated by commas, as magit-completing-read-multiple. */
function readRefnames(prompt: string): string[] {
  const text = e8.readString(prompt);
  return text.split(",").map((r) => r.trim()).filter((r) => r !== "");
}

/** Reads an existing bundle file, defaulting to the file at point, as magit-bundle--read-file-name. */
function readBundleFile(prompt: string): string {
  const file = e8.readFileName(prompt, { default: magitFileAtPoint() });
  if (!e8.fileExistsP(file) || e8.fileDirectoryP(file)) e8.userError(`${file} is not a file`);
  return file;
}

/** Creates a bundle FILE of REFS with ARGS. */
export const magitBundleCreateFile = (file: string, refs: string[], args: string[]): number => magitGitBundle("create", file, refs, args);

/** The tracking tag's message: ";; git-bundle tracking" and an alist, as Magit writes it with pp-to-string. */
function trackingMessage(file: string, branch: string, refs: string[], args: string[]): string {
  const str = (s: string) => JSON.stringify(s);
  const list = (xs: string[]) => (xs.length === 0 ? "nil" : `(${xs.map(str).join(" ")})`);
  return `;; git-bundle tracking\n((file . ${str(file)})\n (branch . ${str(branch)})\n (refs . ${list(refs)})\n (args . ${list(args)}))\n`;
}

/** The alist of a tracking tag's MESSAGE, as Magit reads it back. */
function readTracking(message: string): { file?: string; branch?: string; refs: string[]; args: string[] } {
  const field = (name: string) => new RegExp(`\\(${name} \\. (nil|"(?:[^"\\\\]|\\\\.)*"|\\((?:"(?:[^"\\\\]|\\\\.)*"\\s*)*\\))\\)`).exec(message)?.[1];
  const strings = (v?: string): string[] => (v && v !== "nil" ? [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)) : []);
  return { file: strings(field("file"))[0], branch: strings(field("branch"))[0], refs: strings(field("refs")), args: strings(field("args")) };
}

/** Creates a bundle FILE of BRANCH and REFS and has TAG track it. */
export function magitBundleCreateTrackedFile(file: string, tag: string, branch: string, refs: string[], args: string[]): void {
  magitGitBundle("create", file, [branch, ...refs], args);
  magitGit("tag", "--force", tag, branch, "-m", trackingMessage(file, branch, refs, args));
}

/** Updates the bundle TAG tracks. */
export function magitBundleUpdateTrackedTag(tag: string): void {
  const msg = magitGitRun(["for-each-ref", "--format=%(contents)", `refs/tags/${tag}`]).output;
  const t = readTracking(msg);
  if (!t.file || !t.branch) e8.signal("error", `Tag ${tag} does not appear to track a bundle`);
  magitGitBundle("create", t.file!, [`${tag}..${t.branch}`, ...t.refs], t.args);
  magitGit("tag", "--force", tag, t.branch!, "-m", msg);
}

const createRegular = () => {
  const top = magitToplevelOrError();
  const file = e8.readFileName("Create bundle: ", { default: `${e8.fileNameNondirectory(e8.directoryFileName(top))}.bundle` });
  magitBundleCreateFile(file, readRefnames("Refnames (zero or more): "), transientArgs("magit-bundle-create"));
};

export const magitBundleCreateTracked = e8.defineCommand({
  name: "magit-bundle-create-tracked",
  doc: "Create and track a new bundle.",
  run: () => {
    const tag = magitReadTag("Track bundle using tag");
    const branch = magitReadBranch("Bundle branch");
    const refs = readRefnames("Additional refnames (zero or more): ");
    const file = e8.readFileName("File: ", { default: `${tag}.bundle` });
    magitBundleCreateTrackedFile(file, tag, branch, branch === magitGetCurrentBranch() ? ["HEAD", ...refs] : refs, transientArgs("magit-bundle-create"));
  },
});
export const magitBundleUpdateTracked = e8.defineCommand({
  name: "magit-bundle-update-tracked",
  doc: "Update a bundle that is being tracked using TAG.",
  run: () => magitBundleUpdateTrackedTag(magitReadTag("Update bundle tracked by tag")),
});
export const magitBundleVerify = e8.defineCommand({
  name: "magit-bundle-verify",
  doc: "Check whether FILE is valid and applies to the current repository.",
  run: () => {
    const file = readBundleFile("Verify bundle: ");
    magitProcessBuffer();
    magitGitBundle("verify", file);
  },
});
export const magitBundleListHeads = e8.defineCommand({
  name: "magit-bundle-list-heads",
  doc: "List the refs in FILE.",
  run: () => {
    const file = readBundleFile("List heads of bundle: ");
    magitProcessBuffer();
    magitGitBundle("list-heads", file);
  },
});

const readNumber = (prompt: string, initial?: string): string => e8.readString(prompt, { initial });
const readDate = (prompt: string, initial?: string): string => e8.readString(prompt, { initial });

export const magitBundleCreate = transientDefinePrefix("magit-bundle-create", {
  doc: "Create a bundle.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-a", "Include all refs", "--all"],
        ["-b", "Include branches", "--branches="],
        ["-t", "Include tags", "--tags="],
        ["-r", "Include remotes", "--remotes="],
        ["-g", "Include refs", "--glob="],
        ["-e", "Exclude refs", "--exclude="],
        ["-n", "Limit number of commits", "-n", { reader: readNumber }],
        ["=s", "Limit to commits since", "--since=", { reader: readDate }],
        ["=u", "Limit to commits until", "--until=", { reader: readDate }],
      ],
    },
    {
      description: "Actions",
      items: [
        ["c", "create regular bundle", e8.defineCommand({ name: "magit-bundle-create-regular", doc: "Create a regular bundle, of refs read.", run: createRegular })],
        ["t", "create tracked bundle", magitBundleCreateTracked],
        ["u", "update tracked bundle", magitBundleUpdateTracked],
      ],
    },
  ],
});

export const magitBundle = transientDefinePrefix("magit-bundle", {
  doc: "Create or verify Git bundles.",
  groups: [{ description: "Actions", items: [["c", "create", magitBundleCreate], ["v", "verify", magitBundleVerify], ["l", "list-heads", magitBundleListHeads]] }],
});

