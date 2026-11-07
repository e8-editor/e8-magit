// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cloning, after magit-clone.el: magit-clone clones at once, or with a
// prefix argument shows the clone menu (regular, shallow, bare, mirror,
// sparse), reading a url, a name such as gh:owner/repo, a path, a local
// url or a bundle, and shows the new repository's status.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";
import * as transientModule from "transient";
import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingRead, magitReadStringNs, prefixArgP } from "magit-base";
import { magitGet, magitGetCurrentBranch } from "magit-git";
import { magitCallGit, magitStartGitWith } from "magit-process";
import { magitStatusSetupBuffer } from "magit-status";
import { magitRemoteUnsetHeadOf } from "magit-remote";

e8.defineVariable({ name: "magit-clone-set-remote-head", doc: "Whether cloning creates the symbolic-ref <remote>/HEAD.", value: false });
e8.defineVariable({ name: "magit-clone-set-remote.pushDefault", doc: "Whether to set the value of remote.pushDefault after cloning: t, ask, or nil.", value: "ask" });
e8.defineVariable({ name: "magit-clone-default-directory", doc: "Default directory to use when magit-clone reads destination: nil for default-directory, a directory, or a function of the url.", value: null });
e8.defineVariable({ name: "magit-clone-always-transient", doc: "Whether magit-clone always acts as a transient prefix command.", value: false });
e8.defineVariable({
  name: "magit-clone-name-alist",
  doc: "Alist mapping repository names to repository urls: each element (REGEXP HOSTNAME USER).",
  value: [
    ["\\`\\(?:github:\\|gh:\\)?\\([^:]+\\)\\'", "github.com", "github.user"],
    ["\\`\\(?:gitlab:\\|gl:\\)\\([^:]+\\)\\'", "gitlab.com", "gitlab.user"],
    ["\\`\\(?:sourcehut:\\|sh:\\)\\([^:]+\\)\\'", "git.sr.ht", "sourcehut.user"],
  ],
});
e8.defineVariable({
  name: "magit-clone-url-format",
  doc: "Format(s) used when turning repository names into urls: a string, or an alist of (HOSTNAME . FORMAT) with t the default; %h is the host and %n the name.",
  value: [["git.sr.ht", "git@%h:%n"], [true, "git@%h:%n.git"]],
});
e8.defineVariable({ name: "magit-post-clone-hook", doc: "Hook run after the repository has been successfully cloned.", value: null });

/** The repository's name in URL, as magit-clone--url-to-name. */
export const magitCloneUrlToName = (url: string): string | undefined => /([^/:]+?)(\/?\.git)?$/.exec(url)?.[1];

/** A url for REPO on HOST, owned by USER or the user a git variable names, as magit-clone--format-url. */
export function magitCloneFormatUrl(host: string, user: string, repo: string): string {
  const option = e8.variable("magit-clone-url-format") as unknown;
  let format: string | undefined;
  if (typeof option === "string") format = option;
  else if (Array.isArray(option)) format = ((option as [unknown, string][]).find(([h]) => h === host) ?? (option as [unknown, string][]).find(([h]) => h === true))?.[1];
  if (!format) e8.userError("Bogus `magit-clone-url-format' (bad type or missing default)");
  let name: string;
  if (repo.includes("/")) name = repo;
  else if (user.includes(".")) {
    const u = magitGet(user);
    if (!u) e8.userError(`Set ${user} or specify owner explicitly`);
    name = `${u}/${repo}`;
  } else name = `${user}/${repo}`;
  return format!.replace(/%h/g, host).replace(/%n/g, name);
}

/** The url a name such as gh:owner/repo stands for, as magit-clone--name-to-url. */
export function magitCloneNameToUrl(name: string): string {
  for (const [re, host, user] of (e8.variable("magit-clone-name-alist") as unknown as [string, string, string][]) ?? []) {
    if (e8.stringMatch(re, name) !== undefined) return magitCloneFormatUrl(host, user, e8.matchString(1, name)!);
  }
  return e8.userError("Not an url and no matching entry in `magit-clone-name-alist'");
}

/** Reads what to clone, as magit-clone-read-repository. */
export function magitCloneReadRepository(): string {
  const c = e8.readCharChoice("Clone from [u]rl or name, [p]ath, [l]ocal url, [b]undle ", "uplb");
  if (c === "u") {
    const str = magitReadStringNs("Clone from url or name");
    return /(:\/\/|@)/.test(str) ? str : magitCloneNameToUrl(str);
  }
  if (c === "p") return e8.expandFileName(e8.readFileName("Clone repository: ", { mustMatch: true } as never));
  if (c === "l") return `file://${e8.expandFileName(e8.readFileName("Clone repository: file://"))}`;
  return e8.expandFileName(e8.readFileName("Clone from bundle: "));
}

/** The repository, the directory to clone to and the menu's arguments, as magit-clone-read-args. */
export function magitCloneReadArgs(): [string, string, string[]] {
  const repo = magitCloneReadRepository();
  const option = e8.variable("magit-clone-default-directory");
  const dir = typeof option === "string" ? option : truthy(option) ? String(e8.funcall(option as never, repo)) : undefined;
  const name = magitCloneUrlToName(repo);
  const target = e8.readFileName("Clone to: ", { dir, default: name ? e8.expandFileName(name, dir ?? String(e8.variable("default-directory"))) : undefined });
  return [repo, target, transientArgs("magit-clone")];
}

/** Clones REPOSITORY into DIRECTORY with ARGS, then shows its status, as magit-clone-internal. */
export function magitCloneInternal(repository: string, directoryIn: string, args: string[], sparse = false): void {
  const checkout = !["--bare", "--mirror"].includes(args[0]);
  const remote = args.find((a) => a.startsWith("--origin="))?.slice(9) ?? magitGet("clone.defaultRemote") ?? "origin";
  const option = e8.variable("magit-clone-set-remote.pushDefault");
  const setPushDefault = checkout && (option === true || option === "t" || (truthy(option) && e8.yOrNP(`Set \`remote.pushDefault' to "${remote}"? `)));
  e8.runHooks("magit-credential-hook");
  let directory = e8.fileNameAsDirectory(e8.expandFileName(directoryIn));
  if (e8.fileExistsP(directory)) {
    if (!e8.fileDirectoryP(directory)) e8.userError(`${directory} already exists and is not a directory`);
    if (e8.directoryFiles(directory).filter((f) => f !== "." && f !== "..").length > 0) {
      const name = magitCloneUrlToName(repository);
      const inside = name ? e8.fileNameAsDirectory(e8.expandFileName(name, directory)) : undefined;
      if (!inside || e8.fileExistsP(inside)) e8.userError(`${directory} already exists`);
      directory = inside!;
    }
  }
  const from = e8.currentBuffer();
  magitStartGitWith(["clone", ...args, "--", repository, directory.replace(/\/$/, "")], {
    then: (exit) => {
      if (exit !== 0) return;
      e8.letBind({ "default-directory": directory }, () => {
        if (checkout) {
          if (setPushDefault) magitCallGit("config", "remote.pushDefault", remote);
          if (!truthy(e8.variable("magit-clone-set-remote-head"))) magitRemoteUnsetHeadOf(remote);
        }
        if (sparse && checkout) {
          magitCallGit("sparse-checkout", "init", "--cone");
          magitCallGit("checkout", magitGetCurrentBranch());
        }
        e8.runHooks("magit-post-clone-hook");
      });
      const show = () => magitStatusSetupBuffer(directory);
      if (e8.bufferLiveP(e8.getBuffer(from))) e8.withCurrentBuffer(from, show);
      else show();
    },
  });
}

/** Reads a directory, as transient-read-directory. */
const readDirectory = (prompt: string, initial?: string): string => e8.expandFileName(e8.readFileName(prompt, { initial }));
/** Reads an existing directory, as transient-read-existing-directory. */
const readExistingDirectory = (prompt: string, initial?: string): string => {
  const dir = readDirectory(prompt, initial);
  if (!e8.fileDirectoryP(dir)) e8.userError(`${dir} is not a directory`);
  return dir;
};

const cloneCommand = (name: string, doc: string, extra: () => string[], sparse = false) =>
  e8.defineCommand({
    name,
    doc,
    run: () => {
      const [repo, dir, args] = magitCloneReadArgs();
      magitCloneInternal(repo, dir, [...extra(), ...args], sparse);
    },
  });

/** Reads a number, as read-number. */
function readNumber(prompt: string, def: number): number {
  const text = e8.readString(`${prompt.replace(/: $/, "")} (default ${def}): `).trim();
  return text === "" ? def : Number(text);
}

export const magitCloneRegular = cloneCommand("magit-clone-regular", "Create a clone of REPOSITORY in DIRECTORY.  Then show the status buffer for the new repository.", () => []);
export const magitCloneShallow = e8.defineCommand({
  name: "magit-clone-shallow",
  doc: "Create a shallow clone of REPOSITORY in DIRECTORY.  Then show the status buffer for the new repository.  With a prefix argument read the DEPTH of the clone; otherwise use 1.",
  run: () => {
    const [repo, dir, args] = magitCloneReadArgs();
    const depth = prefixArgP() ? readNumber("Depth: ", 1) : 1;
    magitCloneInternal(repo, dir, [`--depth=${depth}`, ...args]);
  },
});
export const magitCloneShallowSince = e8.defineCommand({
  name: "magit-clone-shallow-since",
  doc: "Create a shallow clone of REPOSITORY in DIRECTORY, excluding commits before DATE, which is read from the user.",
  run: () => {
    const [repo, dir, args] = magitCloneReadArgs();
    const date = e8.readString("Exclude commits before: ");
    magitCloneInternal(repo, dir, [`--shallow-since=${date}`, ...args]);
  },
});
export const magitCloneShallowExclude = e8.defineCommand({
  name: "magit-clone-shallow-exclude",
  doc: "Create a shallow clone of REPOSITORY in DIRECTORY, excluding commits reachable from EXCLUDE, a branch or tag read from the user.",
  run: () => {
    const [repo, dir, args] = magitCloneReadArgs();
    const exclude = e8.readString("Exclude commits reachable from: ");
    magitCloneInternal(repo, dir, [`--shallow-exclude=${exclude}`, ...args]);
  },
});
export const magitCloneBare = cloneCommand("magit-clone-bare", "Create a bare clone of REPOSITORY in DIRECTORY.  Then show the status buffer for the new repository.", () => ["--bare"]);
export const magitCloneMirror = cloneCommand("magit-clone-mirror", "Create a mirror of REPOSITORY in DIRECTORY.  Then show the status buffer for the new repository.", () => ["--mirror"]);
export const magitCloneSparse = cloneCommand("magit-clone-sparse", "Clone REPOSITORY into DIRECTORY and create a sparse checkout.", () => ["--no-checkout"], true);

/** Hidden in a transient without levels when LEVEL is above the default 4, as Magit shows the menu at first. */
const hasLevels = "transientPrefixLevel" in transientModule;
const lvl = (level: number, options: object = {}) => ({ ...options, level, ...(hasLevels || level <= 4 ? {} : { if: () => false }) });

export const magitCloneMenu = transientDefinePrefix("magit-clone-menu", {
  doc: "Clone a repository.",
  groups: [
    {
      description: "Fetch arguments",
      items: [
        ["-B", "Clone a single branch", "--single-branch"],
        ["-n", "Do not clone tags", "--no-tags"],
        ["-S", "Clones submodules", "--recurse-submodules", lvl(6)],
        ["-l", "Do not optimize", "--no-local", lvl(7)],
      ],
    },
    {
      description: "Setup arguments",
      items: [
        ["-o", "Set name of remote", "--origin="],
        ["-b", "Set HEAD branch", "--branch="],
        ["-f", "Filter some objects", "--filter=", lvl(7, { reader: (prompt: string, initial?: string) => magitCompletingRead(prompt, ["blob:none", "tree:0"], { initialInput: initial }) ?? "" })],
        ["-g", "Separate git directory", "--separate-git-dir=", lvl(7, { reader: readDirectory })],
        ["-t", "Use template directory", "--template=", lvl(6, { reader: readExistingDirectory })],
      ],
    },
    { description: "Local sharing arguments", items: [["-s", "Share objects", "--shared", lvl(7)], ["-h", "Do not use hardlinks", "--no-hardlinks"]] },
    {
      description: "Clone",
      items: [
        ["C", "regular", magitCloneRegular],
        ["s", "shallow", magitCloneShallow],
        ["d", "shallow since date", magitCloneShallowSince, lvl(7)],
        ["e", "shallow excluding", magitCloneShallowExclude, lvl(7)],
        [">", "sparse checkout", magitCloneSparse, lvl(6)],
        ["b", "bare", magitCloneBare],
        ["m", "mirror", magitCloneMirror],
      ],
    },
  ],
});

export const magitClone = e8.defineCommand({
  name: "magit-clone",
  doc: "Clone a repository.  With a prefix argument, or if magit-clone-always-transient is non-nil, show the menu of ways to clone; otherwise clone regularly.",
  run: () => {
    if (prefixArgP() || truthy(e8.variable("magit-clone-always-transient"))) e8.call(magitCloneMenu);
    else e8.call(magitCloneRegular);
  },
});
