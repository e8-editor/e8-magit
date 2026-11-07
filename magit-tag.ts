// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tags, after magit-tag.el: the tag menu (t), creating a tag, a release
// tag named after the last, deleting tags and pruning those that differ
// from a remote's.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { magitRegionValues } from "magit-section";
import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingRead, magitConfirm, prefixArgP } from "magit-base";
import { magitGitLines, magitListTags, magitReadBranchOrCommit, magitReadRemote, magitReadTag, magitRevFormat, magitToplevel } from "magit-git";
import { magitCallGit, magitRunGit, magitRunGitAsync, magitStartGitWith } from "magit-process";
import { magitReadGpgSigningKey } from "magit-transient";

e8.defineVariable({
  name: "magit-release-tag-regexp",
  doc: "Regexp used by magit-tag-release to parse release tags.  The first submatch must match the prefix, if any.  The second submatch must match the version string.",
  value: "\\`\\(?1:\\(?:v\\(?:ersion\\)?\\|r\\(?:elease\\)?\\)[-_/]?\\)?\\(?2:[0-9]+\\(?:\\.[0-9]+\\)*\\(?:-[a-zA-Z0-9-]+\\(?:\\.[a-zA-Z0-9-]+\\)*\\)?\\)\\'",
});
e8.defineVariable({ name: "magit-release-commit-regexp", doc: "Regexp used by magit-tag-release to parse release commit messages.  The first submatch must match the version string.", value: "\\`Release version \\(.+\\)\\'" });

const tagArgs = (): string[] => transientArgs("magit-tag");

export const magitTagCreate = e8.defineCommand({
  name: "magit-tag-create",
  doc: "Create a new tag with the given NAME at COMMIT.  With a prefix argument annotate the tag.\n\n(git tag [--annotate] NAME REV)",
  run: () => {
    const name = magitCompletingRead("Create tag", magitListTags()) ?? e8.userError("No name given");
    const commit = magitReadBranchOrCommit("Place tag on");
    const args = tagArgs();
    if (prefixArgP() && !args.includes("--annotate")) args.push("--annotate");
    startWithEditor(["tag", ...args, name, commit]);
  },
});

/** Runs git with E8 as its editor, as magit-run-git-with-editor, calling THEN when it ends. */
const startWithEditor = (args: (string | undefined)[], then?: (exit: number) => void): string => magitStartGitWith(args, { editor: true, then });

export const magitTagDelete = e8.defineCommand({
  name: "magit-tag-delete",
  doc: "Delete one or more tags.  If the region marks multiple tags (and nothing else), then offer to delete those, otherwise prompt for a single tag to be deleted, defaulting to the tag at point.\n\n(git tag -d TAGS)",
  run: () => {
    const region = (magitRegionValues("tag", true) as string[] | undefined) ?? [];
    const tags = region.length > 0 ? (magitConfirm(true, undefined, "Delete %d tags", region) as string[]) : [magitReadTag("Delete tag")];
    magitRunGit("tag", "-d", ...tags);
  },
});

/** Asks, giving whether the answer was yes, as magit-confirm with noabort. */
function confirmNoabort(prompt: string, promptN: string, items: string[]): boolean {
  if (items.length === 0) return false;
  const q = items.length === 1 ? prompt.replace("%s", items[0]) : promptN.replace("%d", String(items.length));
  return e8.yOrNP(`${q}? `);
}

/** The tags REMOTE has, as magit-remote-list-tags. */
export const magitRemoteListTags = (remote: string): string[] =>
  magitGitLines("ls-remote", "--tags", remote).filter((l) => !l.endsWith("^{}")).map((l) => l.slice(51));

export const magitTagPrune = e8.defineCommand({
  name: "magit-tag-prune",
  doc: "Offer to delete tags missing locally from REMOTE, and vice versa.",
  run: () => {
    const remote = magitReadRemote("Prune tags using remote");
    const tags = magitListTags();
    e8.message("Determining remote tags...");
    const rtagsAll = magitRemoteListTags(remote);
    e8.message("Determining remote tags...done");
    let ltags = tags.filter((t) => !rtagsAll.includes(t));
    let rtags = rtagsAll.filter((t) => !tags.includes(t));
    if (ltags.length === 0 && rtags.length === 0) e8.message("Same tags exist locally and remotely");
    if (!confirmNoabort("Delete %s locally", "Delete %d tags locally", ltags)) ltags = [];
    if (!confirmNoabort("Delete %s from remote", "Delete %d tags from remote", rtags)) rtags = [];
    if (ltags.length > 0) magitCallGit("tag", "-d", ...ltags);
    if (rtags.length > 0) magitRunGitAsync("push", remote, ...rtags.map((t) => `:${t}`));
  },
});

/** Version strings' parts as numbers, alpha, beta and rc below zero, as version-to-list with magit-tag-version-regexp-alist. */
export function versionToList(ver: string): number[] {
  const out: number[] = [];
  for (const m of ver.matchAll(/(\d+)|([^\d.]+)/g)) {
    if (m[1] !== undefined) {
      out.push(Number(m[1]));
      continue;
    }
    const sep = m[2];
    if (/^[-._+ ]?snapshot\.?$/i.test(sep) || /^[-._+]$/.test(sep) || /^[-._+ ]?(cvs|git|bzr|svn|hg|darcs)\.?$/i.test(sep) || /^[-._+ ]?unknown\.?$/i.test(sep)) out.push(-4);
    else if (/^[-._+ ]?alpha\.?$/i.test(sep)) out.push(-3);
    else if (/^[-._+ ]?beta\.?$/i.test(sep)) out.push(-2);
    else if (/^[-._+ ]?(pre|rc)\.?$/i.test(sep)) out.push(-1);
    else throw new Error(`Invalid version syntax: '${ver}'`);
  }
  return out;
}

/** Whether version list A is below B, as version-list-<. */
function versionListLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The release tag regexp's match of TAG, [prefix, version], or undefined. */
function matchRelease(tag: string): [string | undefined, string] | undefined {
  const re = String(e8.variable("magit-release-tag-regexp"));
  if (e8.stringMatch(re, tag) === undefined) return undefined;
  return [e8.matchString(1, tag), e8.matchString(2, tag)!];
}

/** The releases, highest first, each [version, tag, message], as magit--list-releases. */
export function magitListReleases(): [string, string, string][] {
  const releases: [number[], string, string, string][] = [];
  for (const line of magitGitLines("tag", "-n")) {
    const m = / +/.exec(line);
    if (!m) continue;
    const tag = line.slice(0, m.index);
    const msg = line.slice(m.index + m[0].length);
    const release = matchRelease(tag);
    if (!release) continue;
    try {
      releases.push([versionToList(release[1]), release[1], tag, msg]);
    } catch {
      // A tag whose version cannot be compared is not a release.
    }
  }
  releases.sort((a, b) => (versionListLess(a[0], b[0]) ? 1 : versionListLess(b[0], a[0]) ? -1 : 0));
  return releases.map(([, v, t, m]) => [v, t, m]);
}

export const magitTagRelease = e8.defineCommand({
  name: "magit-tag-release",
  doc: "Create a release tag for HEAD.  Assume that release tags match magit-release-tag-regexp.  If HEAD's message matches magit-release-commit-regexp, then base the tag on the version string specified by that.  Otherwise prompt for the name of the new tag using the highest existing tag as initial input.",
  run: () => {
    const args = tagArgs();
    const [pver, ptag, pmsg] = magitListReleases()[0] ?? [];
    const msg = magitRevFormat("%s") ?? "";
    const commitRe = String(e8.variable("magit-release-commit-regexp"));
    const ver0 = e8.stringMatch(commitRe, msg) !== undefined ? e8.matchString(1, msg) : undefined;
    let tag: string;
    if (!ptag) {
      // Have the user review the message of the first release tag.
      if (!args.includes("--edit")) args.push("--edit");
      tag = e8.readString("Create first release tag: ", { initial: ver0 && /^[0-9]/.test(ver0) ? `v${ver0}` : ver0 });
    } else if (ver0) tag = `${matchRelease(ptag)?.[0] ?? ""}${ver0}`;
    else tag = e8.readString(`Create release tag (previous was ${ptag}): `, { initial: ptag });
    const ver = matchRelease(tag)?.[1];
    let message: string | undefined;
    if (args.some((a) => /^--(annotate|local-user|sign)/.test(a))) {
      if (pver && pmsg && ver && pmsg.includes(pver)) message = pmsg.replace(pver, ver);
      else if (ptag && pmsg && pmsg.includes(ptag)) message = pmsg.replace(ptag, tag);
      else message = `${e8.capitalize(e8.fileNameNondirectory(e8.directoryFileName(magitToplevel() ?? "")))} ${ver}`;
    }
    startWithEditor(["tag", ...args, ...(message ? ["-m", message] : []), tag], () => {
      if (e8.fboundp("magit-show-refs")) e8.call("magit-show-refs" as e8.CommandName);
    });
  },
});

export const magitTag = transientDefinePrefix("magit-tag", {
  doc: "Create or delete a tag.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-f", "Force", "--force"],
        ["-e", "Edit message", "--edit"],
        ["-a", "Annotate", "--annotate"],
        ["-s", "Sign", "--sign"],
        ["-u", "Sign as", "--local-user=", { reader: (prompt: string, initial?: string) => magitReadGpgSigningKey(prompt, initial) }],
      ],
    },
    {
      class: "columns",
      items: [
        { description: "Create", items: [["t", "tag", magitTagCreate], ["r", "release", magitTagRelease]] },
        { description: "Do", items: [["k", "delete", magitTagDelete], ["p", "prune", magitTagPrune]] },
      ],
    },
  ],
});
