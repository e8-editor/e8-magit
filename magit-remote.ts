// SPDX-License-Identifier: GPL-3.0-or-later
//
// Remotes, after magit-remote.el: the remote menu (M), with the current
// remote's variables, adding, renaming and removing a remote, pruning
// its stale branches and refspecs, setting its HEAD, unshallowing it,
// and the menu configuring a remote's variables.
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
import { magitConfirm, magitReadStringNs, prefixArgP } from "magit-base";
import {
  magitGet,
  magitGetAll,
  magitGetCurrentRemote,
  magitGetSomeRemote,
  magitGitLines,
  magitListRemoteBranches,
  magitReadOtherLocalBranch,
  magitReadRemote,
  magitReadRemoteBranch,
  magitRevParse,
  magitSet,
  magitSetAll,
  magitGitString,
  magitPrimaryRemote,
  magitBranchP,
  magitGetCurrentBranch,
} from "magit-git";
import { magitCallGit, magitGit, magitRunGit, magitRunGitAsync } from "magit-process";
import { magitRefresh } from "magit-mode";
import { magitGitVariable } from "magit-transient";

e8.defineVariable({
  name: "magit-remote-add-set-remote.pushDefault",
  doc: "Whether to set the value of remote.pushDefault after adding a remote: ask, ask-if-unset, nil, or a remote's name to set it to without asking.",
  value: "ask-if-unset",
});
e8.defineVariable({ name: "magit-remote-direct-configure", doc: "Whether the command magit-remote shows Git variables.", value: true });
e8.defineVariable({ name: "magit-prefer-push-default", doc: "Whether to prefer remote.pushDefault over per-branch variables.", value: false });

/** Reads a url, expanding ~, as magit-read-url. */
export function magitReadUrl(prompt: string, initialInput?: string): string {
  const url = magitReadStringNs(prompt, initialInput);
  return url.startsWith("~") ? e8.expandFileName(url) : url;
}

export const magitRemoteAdd = e8.defineCommand({
  name: "magit-remote-add",
  doc: "Add a remote named REMOTE and fetch it.",
  run: () => {
    const origin = magitGet("remote.origin.url");
    const remote = magitReadStringNs("Remote name");
    const m = origin ? /([^:/]+)\/[^/]+(\.git)?$/.exec(origin) : undefined;
    const initial = origin && m ? origin.slice(0, m.index) + remote + origin.slice(m.index + m[1].length) : undefined;
    const url = magitReadUrl("Remote url", initial);
    const args = transientArgs("magit-remote");
    const option = e8.variable("magit-remote-add-set-remote.pushDefault");
    const pushDefault = magitGet("remote.pushDefault");
    const set =
      (typeof option === "string" && option !== "ask" && option !== "ask-if-unset" && option === remote && pushDefault === undefined) ||
      ((option === "ask" || (option === "ask-if-unset" && pushDefault === undefined)) && e8.yOrNP(`Set \`remote.pushDefault' to "${remote}"? `));
    if (set) {
      magitCallGit("remote", "add", ...args, remote, url);
      magitSet(remote, "remote.pushDefault");
      magitRefresh();
    } else magitRunGitAsync("remote", "add", ...args, remote, url);
  },
});

/** Renames or unsets the push variables naming REMOTE, as magit-remote--cleanup-push-variables. */
function cleanupPushVariables(remote: string, newName?: string): void {
  if (magitGet("remote.pushDefault") === remote) magitSet(newName, "remote.pushDefault");
  for (const v of magitGitLines("config", "--name-only", "--get-regexp", "^branch\\.[^.]*\\.pushRemote", `^${remote}$`)) {
    magitCallGit("config", newName ? undefined : "--unset", v, newName);
  }
}

export const magitRemoteRename = e8.defineCommand({
  name: "magit-remote-rename",
  doc: "Rename the remote named OLD to NEW.",
  run: () => {
    const old = magitReadRemote("Rename remote");
    const name = magitReadStringNs(`Rename ${old} to`);
    if (old === name) return;
    magitCallGit("remote", "rename", old, name);
    cleanupPushVariables(old, name);
    magitRefresh();
  },
});
export const magitRemoteRemove = e8.defineCommand({
  name: "magit-remote-remove",
  doc: "Delete the remote named REMOTE.",
  run: () => {
    const remote = magitReadRemote("Delete remote");
    magitCallGit("remote", "rm", remote);
    cleanupPushVariables(remote);
    magitRefresh();
  },
});
export const magitRemotePrune = e8.defineCommand({
  name: "magit-remote-prune",
  doc: "Remove stale remote-tracking branches for REMOTE.",
  run: () => void magitRunGitAsync("remote", "prune", magitReadRemote("Prune stale branches of remote")),
});

/** The refs REMOTE has, as magit-remote-list-refs. */
export const magitRemoteListRefs = (remote: string): string[] => magitGitLines("ls-remote", remote).filter((l) => !l.endsWith("^{}")).map((l) => l.slice(41));

/** A refspec's glob as a JavaScript regexp, * matching anything, as Magit's replace-match of "\\*" with ".*". */
const globRe = (glob: string): RegExp => new RegExp(glob.replace(/\*/, ".*"));

export const magitRemotePruneRefspecs = e8.defineCommand({
  name: "magit-remote-prune-refspecs",
  doc: "Remove stale refspecs for REMOTE.  A refspec is stale if there no longer exists at least one branch on the remote that would be fetched due to that refspec.  If only stale refspecs remain, then offer to either delete the remote or to replace the stale refspecs with the default refspec.",
  run: () => {
    const remote = magitReadRemote("Prune refspecs of remote");
    const trackingRefs = magitListRemoteBranches(remote).map((b) => `refs/remotes/${b}`);
    const remoteRefs = magitRemoteListRefs(remote);
    const variable = `remote.${remote}.fetch`;
    const refspecs = magitGetAll(variable);
    const stale: [string, string[]][] = [];
    for (const refspec of refspecs) {
      const m = /^(\+)?([^:]+):(.*)$/.exec(refspec);
      if (!m) continue;
      const [, , theirs, ours] = m;
      const live = theirs.includes("*") ? remoteRefs.some((r) => globRe(theirs).test(r)) : remoteRefs.includes(theirs);
      if (live) continue;
      const refs = ours.includes("*") ? trackingRefs.filter((r) => globRe(ours).test(r)) : trackingRefs.filter((r) => r === ours).slice(0, 1);
      stale.unshift([refspec, refs]);
    }
    if (stale.length === 0) return void e8.message(`No stale refspecs for remote "${remote}"`);
    if (stale.length === refspecs.length) {
      const c = e8.readCharChoice(`All of ${remote}'s refspecs are stale.  replace with [d]efault refspec, [r]emove remote, [a]abort `, "dra");
      if (c === "d") magitSetAll([`+refs/heads/*:refs/remotes/${remote}/*`], variable);
      else if (c === "r") magitCallGit("remote", "rm", remote);
      else e8.userError("Abort");
    } else {
      if (stale.length === 1) {
        const [refspec, refs] = stale[0];
        magitConfirm("prune-stale-refspecs", `Prune stale refspec ${refspec} and branch %s`, `Prune stale refspec ${refspec} and %d branches`, refs);
      } else {
        const branches = stale.reduce((n, [, refs]) => n + refs.length, 0);
        magitConfirm("prune-stale-refspecs", undefined, `Prune %d stale refspecs and ${branches} branches`, stale.map(([r, refs]) => `${r}\n${refs.map((x) => `  ${x}`).join("\n")}`));
      }
      for (const [refspec, refs] of stale) {
        magitCallGit("config", "--unset", variable, refspec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (refs.length > 1) e8.message(`Deleting ${refs.length} branches`);
        for (const ref of refs) {
          if (refs.length === 1) e8.message(`Deleting branch ${ref} (was ${magitRevParse("--short", ref)})`);
          magitCallGit("update-ref", "-d", ref);
        }
      }
    }
    magitRefresh();
  },
});
export const magitRemoteSetHead = e8.defineCommand({
  name: "magit-remote-set-head",
  doc: "Set the local representation of REMOTE's default branch.  Query REMOTE and set the symbolic-ref refs/remotes/<remote>/HEAD accordingly.  With a prefix argument query for the branch to be used.",
  run: () => {
    const remote = magitReadRemote("Set HEAD for remote");
    const branch = prefixArgP() ? magitReadRemoteBranch(`Set ${remote}/HEAD to`, remote, undefined, undefined, true) : undefined;
    magitRunGit("remote", "set-head", remote, branch ?? "--auto");
  },
});
export const magitRemoteUnsetHead = e8.defineCommand({
  name: "magit-remote-unset-head",
  doc: "Unset the local representation of REMOTE's default branch.  Delete the symbolic-ref refs/remotes/<remote>/HEAD.",
  run: () => void magitRunGit("remote", "set-head", magitReadRemote("Unset HEAD for remote"), "--delete"),
});
/** Removes refs/remotes/REMOTE/HEAD without refreshing, for magit-clone. */
export const magitRemoteUnsetHeadOf = (remote: string): number => magitCallGit("remote", "set-head", remote, "--delete");

/** The primary remote's default branch, [remote, branch], after fetching if UPDATE, as magit--get-default-branch. */
export function magitGetDefaultBranch(update = false): [string | undefined, string | undefined] {
  const remote = magitPrimaryRemote();
  if (update) {
    if (!remote) e8.userError("Cannot determine primary remote");
    e8.message("Determining default branch...");
    magitGit("fetch", "--prune");
    magitGit("remote", "set-head", "--auto", remote);
    e8.message("Determining default branch...done");
  }
  const branch = remote ? magitGitString("symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`) : undefined;
  if (update && !branch) e8.userError("Cannot determine new default branch");
  return [remote, branch?.slice((remote?.length ?? -1) + 1)];
}

/** Renames OLDNAME to NEWNAME and points the branches following the old at the new, as magit--set-default-branch. */
export function magitSetDefaultBranch(newname: string, oldname: string): void {
  const remote = magitPrimaryRemote() ?? e8.userError("Cannot determine primary remote");
  const branches = magitGitLines("for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:short)").map((l) => l.split("\t"));
  const old = branches.find((b) => b[0] === oldname);
  if (old && !branches.some((b) => b[0] === newname)) {
    magitCallGit("branch", "-m", oldname, newname);
    old[0] = newname;
  }
  for (const [name, upstream] of branches) {
    if (upstream === `${remote}/${oldname}`) magitCallGit("branch", `--set-upstream-to=${remote}/${newname}`, name);
  }
}

export const magitUpdateDefaultBranch = e8.defineCommand({
  name: "magit-update-default-branch",
  doc: "Update name of the default branch after upstream changed it.",
  run: () => {
    let [, oldname] = magitGetDefaultBranch();
    const [remote, newname] = magitGetDefaultBranch(true);
    if (oldname === newname) {
      oldname = e8.readString(
        `Name of default branch is still \`${oldname}', but the upstreams of some local branches might need updating.\nName of upstream branches to replace with \`${newname}': `,
      );
      magitSetDefaultBranch(newname!, oldname);
      magitRefresh();
      return;
    }
    oldname ??= magitReadOtherLocalBranch(`Name of old default branch to be renamed to \`${newname}'`, newname, "master");
    if (!e8.yOrNP(`Default branch changed from \`${oldname}' to \`${newname}' on ${remote}.  Do the same locally? `)) e8.userError("Abort");
    magitSetDefaultBranch(newname!, oldname);
    magitRefresh();
  },
});

export const magitRemoteUnshallow = e8.defineCommand({
  name: "magit-remote-unshallow",
  doc: "Convert a shallow remote into a full one.  If only a single refspec is set and it does not contain a wildcard, then also offer to replace it with the standard refspec.",
  run: () => {
    const remote = magitGetCurrentRemote() ?? magitReadRemote("Delete remote");
    const refspecs = magitGetAll("remote", remote, "fetch");
    const standard = `+refs/heads/*:refs/remotes/${remote}/*`;
    if (refspecs.length === 1 && !refspecs[0].includes("*") && e8.yesOrNoP(`Also replace refspec ${refspecs[0]} with ${standard}? `)) magitSet(standard, "remote", remote, "fetch");
    magitRunGitAsync("fetch", "--unshallow", remote);
  },
});

/** The remote the configure menu sets variables of, as its transient scope. */
let configureScope: string | undefined;
const remoteScope = (): string | undefined => configureScope ?? magitGetCurrentRemote();

/** The remote variables' infixes for remote SCOPE, as magit-remote.<remote>.url and its kin. */
const remoteVariables = (scope: () => string | undefined) => [
  magitGitVariable("u", () => `remote.${scope()}.url`, { kind: "urls", remote: scope }),
  magitGitVariable("U", () => `remote.${scope()}.fetch`, { multiValue: true }),
  magitGitVariable("s", () => `remote.${scope()}.pushurl`, { kind: "urls", remote: scope, seturlArg: "--push" }),
  magitGitVariable("S", () => `remote.${scope()}.push`),
  magitGitVariable("O", () => `remote.${scope()}.tagOpt`, { kind: "choices", choices: ["--no-tags", "--tags"] }),
];

export const magitRemoteConfigureMenu = transientDefinePrefix("magit-remote-configure", {
  doc: "Configure a remote.",
  groups: [
    {
      description: () => e8.concat(e8.propertize("Configure ", { face: "transient-heading" }), e8.propertize(remoteScope() ?? "", { face: "magit-branch-remote" })),
      items: remoteVariables(remoteScope),
    },
  ],
});
/** C in the remote menu: reads the remote to configure, unless there is a current one, then shows the menu. */
const magitRemoteConfigure = e8.defineCommand({
  name: "magit-remote-configure-read",
  doc: "Configure a remote, read in the minibuffer.",
  run: () => {
    configureScope = magitReadRemote("Configure remote");
    try {
      e8.call(magitRemoteConfigureMenu);
    } finally {
      configureScope = undefined;
    }
  },
});

export const magitRemote = transientDefinePrefix("magit-remote", {
  doc: "Add, configure or remove a remote.",
  value: ["-f"],
  groups: [
    { description: "Variables", if: () => truthy(e8.variable("magit-remote-direct-configure")) && magitGetCurrentRemote() !== undefined, items: remoteVariables(magitGetCurrentRemote) },
    { description: "Arguments for add", items: [["-f", "Fetch after add", "-f"]] },
    {
      description: "Actions",
      class: "columns",
      items: [
        { items: [["a", "Add", magitRemoteAdd], ["r", "Rename", magitRemoteRename], ["k", "Remove", magitRemoteRemove]] },
        { items: [["C", "Configure...", magitRemoteConfigure], ["p", "Prune stale branches", magitRemotePrune], ["P", "Prune stale refspecs", magitRemotePruneRefspecs], ["z", "Unshallow remote", magitRemoteUnshallow, { level: 7, if: () => "transientPrefixLevel" in transientModule }]] },
        { items: [["d u", "Update default branch", magitUpdateDefaultBranch, { inaptIfNot: magitGetSomeRemote }]] },
      ],
    },
  ],
});


/** The variable a push remote is set in, bold, as magit--push-remote-variable. */
export function magitPushRemoteVariable(branch?: string, short = false): e8.PropertizedString {
  const b = branch ?? magitGetCurrentBranch();
  const name = !b || truthy(e8.variable("magit-prefer-push-default")) ? (short ? "pushDefault" : "remote.pushDefault") : short ? "pushRemote" : `branch.${b}.pushRemote`;
  return e8.propertize(name, { face: "bold" });
}
