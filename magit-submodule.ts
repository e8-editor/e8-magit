// SPDX-License-Identifier: GPL-3.0-or-later
//
// Submodules, after magit-submodule.el: the submodule menu (o), adding,
// registering, populating, updating, synchronizing, unpopulating and
// removing modules, the status buffer's module sections, which
// magit-status-sections-hook leaves out unless added to it, and the list
// of a repository's populated submodules.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { truthy } from "subr";
import { fileRelativeName } from "files";
import { tabulatedListInitHeader, tabulatedListPrint } from "tabulated-list";
import { insertHeading, insertSection, magitCancelSection, magitInsertSectionBody, magitRegionValues, magitSectionDefineType } from "magit-section";
import { transientArgs, transientDefinePrefix } from "transient";
import { magitCompletingRead, magitConfirm, magitFormatTimeString, magitReadStringNs, prefixArgP } from "magit-base";
import {
  magitAnythingModifiedP,
  magitGet,
  magitGetCurrentBranch,
  magitGetPushBranch,
  magitGetUpstreamBranch,
  magitGitdir,
  magitGitLines,
  magitGitString,
  magitListLocalBranches,
  magitGitItems,
  magitListStashes,
  magitModuleAtPoint,
  magitRevDiffCount,
  magitRevFormat,
  magitSectionValueIf,
  magitToplevel,
  magitToplevelOrError,
  magitWithRefreshCache,
  magitListModulePaths,
} from "magit-git";
import { magitCallGit, magitGit, magitRunGitAsync, magitStartGitWith, type Proc } from "magit-process";
import { magitBufferName, magitDisplayBuffer, magitRefresh } from "magit-mode";
import { inserters } from "magit-diff";
import { magitLogWashSummary } from "magit-log";
import { magitStatusSetupBuffer } from "magit-status";
import { magitRepolistMode, magitRepolistRefresh, magitRepolistSetup1, type RepolistColumn, type RepolistSpec } from "magit-repos";

// Options.

e8.defineVariable({
  name: "magit-module-sections-hook",
  doc: "Hook run by magit-insert-modules.\n\nThat function isn't part of magit-status-sections-hook's default value, so you have to add it yourself for this hook to have any effect.",
  value: [
    "magit-insert-modules-overview",
    "magit-insert-modules-unpulled-from-upstream",
    "magit-insert-modules-unpulled-from-pushremote",
    "magit-insert-modules-unpushed-to-upstream",
    "magit-insert-modules-unpushed-to-pushremote",
  ],
});
e8.defineVariable({
  name: "magit-module-sections-nested",
  doc: "Whether magit-insert-modules wraps inserted sections.\n\nIf this is non-nil, then only a single top-level section is inserted.  If it is nil, then all sections listed in magit-module-sections-hook become top-level sections.",
  value: true,
});
e8.defineVariable({
  name: "magit-submodule-list-columns",
  doc:
    "List of columns displayed by magit-list-submodules.\n\nEach element has the form (HEADER WIDTH FORMAT PROPS).\n\n" +
    "HEADER is the string displayed in the header.  WIDTH is the width of the column.  FORMAT is a function that is called with one argument, the repository identification (usually its basename), and with default-directory bound to the toplevel of its working tree.  It has to return a string to be inserted or nil.  PROPS is an alist that supports the keys :right-align, :pad-right and :sort.\n\n" +
    "The :sort function has a weird interface described in the docstring of tabulated-list--get-sort.  Alternatively < and magit-repolist-version< can be used as those functions are automatically replaced with functions that satisfy the interface.  Set :sort to nil to inhibit sorting; if unspecified, then the column is sortable using the default sorter.\n\n" +
    'You may wish to display a range of numeric columns using just one character per column and without any padding between columns, in which case you should use an appropriate HEADER, set WIDTH to 1, and set :pad-right to 0.  "+" is substituted for numbers higher than 9.',
  value: [
    ["Path", 25, "magit-modulelist-column-path", []],
    ["Version", 25, "magit-repolist-column-version", [[":sort", "magit-repolist-version<"]]],
    ["Branch", 20, "magit-repolist-column-branch", []],
    ["B<P", 3, "magit-repolist-column-unpulled-from-pushremote", [[":right-align", true], [":sort", "<"]]],
    ["B<U", 3, "magit-repolist-column-unpulled-from-upstream", [[":right-align", true], [":sort", "<"]]],
    ["B>P", 3, "magit-repolist-column-unpushed-to-pushremote", [[":right-align", true], [":sort", "<"]]],
    ["B>U", 3, "magit-repolist-column-unpushed-to-upstream", [[":right-align", true], [":sort", "<"]]],
    ["S", 3, "magit-repolist-column-stashes", [[":right-align", true], [":sort", "<"]]],
    ["B", 3, "magit-repolist-column-branches", [[":right-align", true], [":sort", "<"]]],
  ],
});
e8.defineVariable({
  name: "magit-submodule-list-sort-key",
  doc: "Initial sort key for buffer created by magit-list-submodules.\nIf nil, no additional sorting is performed.  Otherwise, this should be a cons cell (NAME . FLIP).  NAME is a string matching one of the column names in magit-submodule-list-columns.  FLIP, if non-nil, means to invert the resulting sort.",
  value: ["Path", false],
});
e8.defineVariable({ name: "magit-submodule-list-format-path-functions", doc: "Functions that format a module's path for magit-modulelist-column-path, the first to give a string winning.", value: [] });
e8.defineVariable({
  name: "magit-submodule-remove-trash-gitdirs",
  doc: "Whether magit-submodule-remove offers to trash module gitdirs.\n\nIf this is nil, then that command does not offer to do so unless a prefix argument is used.  When this is t, then it does offer to do so even without a prefix argument.\n\nIn both cases the action still has to be confirmed unless that is disabled using the option magit-no-confirm.  Doing the latter and also setting this variable to t will lead to tears.",
  value: false,
});
e8.defineVariable({ name: "magit-modules-overview-align-numbers", doc: "Whether magit-insert-modules-overview puts a space before a description that starts with a digit, to line it up with v-prefixed ones.", value: true });

/** The current buffer's directory. */
const defaultDirectory = (): string => String(e8.variable("default-directory") ?? ".");

/** Runs BODY in the repository's top directory, as magit-with-toplevel. */
const withToplevel = <T>(body: () => T): T => e8.letBind({ "default-directory": magitToplevelOrError() }, body);

export { magitListModulePaths };

/** Runs BODY with default-directory DIR. */
const inDirectory = <T>(dir: string, body: () => T): T => e8.letBind({ "default-directory": dir }, body);

// The menu.

/** The arguments of magit-submodule among FILTERS, as magit-submodule-arguments. */
export const magitSubmoduleArguments = (...filters: string[]): string[] => transientArgs("magit-submodule").filter((a) => filters.includes(a));

/**
 * A suffix's description with the arguments in brackets highlighted as
 * the menu has them, as magit--git-submodule-suffix formats it. E8's
 * transient gives no suffix the menu's value while it is shown, so the
 * arguments are those the menu started with.
 */
function gitSubmoduleDescription(text: string): () => e8.PropertizedString {
  return () => {
    const value = transientArgs("magit-submodule");
    const parts: (string | e8.PropertizedString)[] = [];
    let last = 0;
    for (const m of text.matchAll(/\[--[^\]]+\]/g)) {
      parts.push(text.slice(last, m.index));
      const args = m[0].slice(1, -1).split("|");
      parts.push(e8.propertize("[", { face: "transient-inactive-argument" }));
      args.forEach((arg, i) => {
        if (i > 0) parts.push(e8.propertize("|", { face: "transient-inactive-argument" }));
        parts.push(e8.propertize(arg, { face: value.includes(arg) ? "transient-argument" : "transient-inactive-argument" }));
      });
      parts.push(e8.propertize("]", { face: "transient-inactive-argument" }));
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return e8.concat(...parts);
  };
}

// Reading modules.

/** Whether MODULE has a working tree, as magit-module-worktree-p. */
export const magitModuleWorktreeP = (module: string): boolean => withToplevel(() => e8.fileExistsP(e8.expandFileName(".git", e8.expandFileName(module))));
/** Whether MODULE has no working tree, as magit-module-no-worktree-p. */
export const magitModuleNoWorktreeP = (module: string): boolean => !magitModuleWorktreeP(module);

/** A predicate on modules with the name Magit's messages give it. */
type ModulePredicate = { name: string; test: (module: string) => boolean };
const worktreeP: ModulePredicate = { name: "magit-module-worktree-p", test: magitModuleWorktreeP };
const noWorktreeP: ModulePredicate = { name: "magit-module-no-worktree-p", test: magitModuleNoWorktreeP };

/** Reads a submodule's path, those PREDICATE accepts, as magit-read-module-path. */
export function magitReadModulePath(prompt: string, predicate?: (module: string) => boolean): string {
  const modules = magitListModulePaths().filter((m) => !predicate || predicate(m));
  const at = magitModuleAtPoint();
  return magitCompletingRead(prompt, modules, { requireMatch: true, def: at && (!predicate || predicate(at)) ? at : undefined })!;
}

/**
 * The modules to act on, as magit-module-confirm: with a prefix argument
 * all of them, else those the region selects, PREDICATE accepts, each
 * confirmed when there is more than one, else one read with VERB.
 */
export function magitModuleConfirm(verb: string, predicate?: ModulePredicate): string[] {
  return magitWithRefreshCache(() => {
    let modules: string[];
    if (prefixArgP()) {
      modules = magitListModulePaths();
      if (predicate) modules = modules.filter(predicate.test);
      if (modules.length === 0) e8.userError(predicate ? `No modules satisfying ${predicate.name} available` : "No modules available");
    } else {
      modules = ((magitRegionValues("module") as string[] | undefined) ?? []).filter((m) => typeof m === "string");
      if (modules.length > 0 && predicate) {
        modules = modules.filter(predicate.test);
        if (modules.length === 0) e8.userError(`No modules satisfying ${predicate.name} selected`);
      }
    }
    if (modules.length > 1 || prefixArgP()) return magitConfirm(true, undefined, `${verb} %d modules`, modules) as string[];
    return [magitReadModulePath(`${verb} module`, predicate?.test)];
  });
}

// One module actions.

/** Reads where to add the module from URL, relative to the top, as magit-submodule-read-path. */
export function magitSubmoduleReadPath(prompt: string, url: string): string {
  const m = /([^./]+)(\.git)?$/.exec(url);
  const answer = e8.readFileName(prompt, { initial: m ? defaultDirectory() + m[1] : undefined });
  return e8.directoryFileName(fileRelativeName(answer));
}

/** Reads a name for the module at PATH, as magit-submodule-read-name-for-path. */
export function magitSubmoduleReadNameForPath(path: string, preferShort = false): string {
  const p = e8.directoryFileName(fileRelativeName(path));
  const name = e8.fileNameNondirectory(p);
  const known = magitGitLines("config", "--list", "-f", ".gitmodules")
    .map((l) => {
      const [variable, value] = l.split("=");
      return value === p ? variable.split(".")[1] : undefined;
    })
    .filter((n): n is string => n !== undefined);
  return magitReadStringNs("Submodule name", undefined, "minibuffer-history", known[0] ?? (preferShort ? name : p));
}

/** Adds the repository at URL as a module at PATH named NAME, absorbing its gitdir once it is cloned, as magit-submodule-add-1. */
export function magitSubmoduleAdd1(url: string, path?: string, name?: string, args: string[] = []): Proc {
  return withToplevel(() => {
    const top = defaultDirectory();
    if (name && path) magitSubmoduleMaybeReuseGitdir(name, path);
    return magitStartGitWith(["submodule", "add", name ? ["--name", name] : undefined, args, "--", url, path], {
      then: (exit) => {
        if (exit !== 0) return;
        inDirectory(top, () => {
          magitCallGit("submodule", "absorbgitdirs", path);
          magitRefresh();
        });
      },
    });
  });
}

export const magitSubmoduleAdd = e8.defineCommand({
  name: "magit-submodule-add",
  doc: "Add the repository at URL as a module.\n\nOptional PATH is the path to the module relative to the root of the superproject.  If it is nil, then the path is determined based on the URL.  Optional NAME is the name of the module.  If it is nil, then PATH also becomes the name.",
  run: () => {
    const [url, path, name, args] = withToplevel(() => {
      const url = magitReadStringNs("Add submodule (remote url)");
      const path = magitSubmoduleReadPath("Add submodules at path: ", url);
      return [url, e8.directoryFileName(path), magitSubmoduleReadNameForPath(path), magitSubmoduleArguments("--force")] as const;
    });
    magitSubmoduleAdd1(url, path, name, args);
  },
});

// This command and the underlying "git submodule init" do NOT
// "initialize" modules.  They merely "register" modules in the
// super-projects $GIT_DIR/config file, the purpose of which is to
// allow users to change such values before actually initializing
// the modules.
export const magitSubmoduleRegister = e8.defineCommand({
  name: "magit-submodule-register",
  doc: "Register MODULES.\n\nWith a prefix argument act on all suitable modules.  Otherwise, if the region selects modules, then act on those.  Otherwise, if there is a module at point, then act on that.  Otherwise read a single module from the user.",
  run: () => {
    const modules = magitModuleConfirm("Register", noWorktreeP);
    withToplevel(() => magitRunGitAsync("submodule", "init", "--", modules));
  },
});

// This is the command that actually "initializes" modules.
// A module is initialized when it has a working directory,
// a gitlink, and a .gitmodules entry.
export const magitSubmodulePopulate = e8.defineCommand({
  name: "magit-submodule-populate",
  doc: "Create MODULES working directories, checking out the recorded commits.\n\nWith a prefix argument act on all suitable modules.  Otherwise, if the region selects modules, then act on those.  Otherwise, if there is a module at point, then act on that.  Otherwise read a single module from the user.",
  run: () => {
    const modules = magitModuleConfirm("Populate", noWorktreeP);
    const args = magitSubmoduleArguments("--recursive");
    withToplevel(() => magitRunGitAsync("submodule", "update", "--init", args, "--", modules));
  },
});

// Unlike `git-submodule's `update' command ours can only update
// "initialized" modules by checking out other commits but not
// "initialize" modules by creating the working directories.
// To do the latter we provide the "setup" command.
export const magitSubmoduleUpdate = e8.defineCommand({
  name: "magit-submodule-update",
  doc: "Update MODULES by checking out the recorded commits.\n\nWith a prefix argument act on all suitable modules.  Otherwise, if the region selects modules, then act on those.  Otherwise, if there is a module at point, then act on that.  Otherwise read a single module from the user.",
  run: () => {
    const modules = magitModuleConfirm("Update", worktreeP);
    const args = magitSubmoduleArguments("--force", "--remote", "--recursive", "--checkout", "--rebase", "--merge", "--no-fetch");
    withToplevel(() => magitRunGitAsync("submodule", "update", args, "--", modules));
  },
});

export const magitSubmoduleSynchronize = e8.defineCommand({
  name: "magit-submodule-synchronize",
  doc: "Synchronize url configuration of MODULES.\n\nWith a prefix argument act on all suitable modules.  Otherwise, if the region selects modules, then act on those.  Otherwise, if there is a module at point, then act on that.  Otherwise read a single module from the user.",
  run: () => {
    const modules = magitModuleConfirm("Synchronize", worktreeP);
    const args = magitSubmoduleArguments("--recursive");
    withToplevel(() => magitRunGitAsync("submodule", "sync", args, "--", modules));
  },
});

// Even when a submodule is "uninitialized" (it has no worktree)
// the super-project's $GIT_DIR/config may never-the-less set the
// module's url.  This may happen if you `deinit' and then `init'
// to register (NOT initialize).  Because the purpose of `deinit'
// is to remove the working directory AND to remove the url, this
// command does not limit itself to modules that have no working
// directory.
export const magitSubmoduleUnpopulate = e8.defineCommand({
  name: "magit-submodule-unpopulate",
  doc: "Remove working directories of MODULES.\n\nWith a prefix argument act on all suitable modules.  Otherwise, if the region selects modules, then act on those.  Otherwise, if there is a module at point, then act on that.  Otherwise read a single module from the user.",
  run: () => {
    const modules = magitModuleConfirm("Unpopulate");
    const args = magitSubmoduleArguments("--force");
    withToplevel(() => magitRunGitAsync("submodule", "deinit", args, "--", modules));
  },
});

/** Whether magit-no-confirm says not to confirm ACTION. */
function noConfirm(action: string): boolean {
  const v = e8.variable("magit-no-confirm");
  return v === true || (Array.isArray(v) && v.some((x) => String(x) === action));
}

/** Asks about ITEMS, giving whether the answer was yes, as magit-confirm with NOABORT. */
function confirmNoabort(action: string, prompt: string, promptN: string, items: string[]): boolean {
  if (noConfirm(action)) return true;
  const q = items.length === 1 ? prompt.replace("%s", items[0]) : promptN.replace("%d", String(items.length));
  return e8.yOrNP(`${q}? `);
}

/** Removes MODULES, as magit-submodule-remove does once it has read them. */
export function magitSubmoduleRemove1(modulesIn: string[], args: string[], trashGitdirsIn: boolean): void {
  let modules = modulesIn;
  const trashGitdirs = trashGitdirsIn || truthy(e8.variable("magit-submodule-remove-trash-gitdirs"));
  withToplevel(() => {
    const modified = modules.filter((module) =>
      inDirectory(e8.fileNameAsDirectory(e8.expandFileName(module)), () => {
        const dir = defaultDirectory();
        return e8.fileDirectoryP(dir) && e8.directoryFiles(dir).filter((f) => f !== "." && f !== "..").length > 0 && magitAnythingModifiedP();
      }),
    );
    if (modified.length > 0) {
      if (args.includes("--force")) {
        if (confirmNoabort("remove-dirty-modules", "Remove dirty module %s", "Remove %d dirty modules", modified)) {
          for (const module of modified) inDirectory(e8.fileNameAsDirectory(e8.expandFileName(module)), () => magitGit("stash", "push", "-m", "backup before removal of this module"));
        } else modules = modules.filter((m) => !modified.includes(m));
      } else {
        if (modified.length > 1) e8.message(`Omitting ${modified.length} modules with uncommitted changes: ${modified.join(", ")}`);
        else e8.message(`Omitting module ${modified[0]}, it has uncommitted changes`);
        modules = modules.filter((m) => !modified.includes(m));
      }
    }
    if (modules.length === 0) return;
    const alist = trashGitdirs ? magitGitLines("submodule", "foreach", "-q", 'printf "$sm_path\\0$name\\n"').map((l) => l.split("\0")) : [];
    magitGit("submodule", "absorbgitdirs", "--", modules);
    magitGit("submodule", "deinit", args, "--", modules);
    magitGit("rm", args, "--", modules);
    if (trashGitdirs && confirmNoabort("trash-module-gitdirs", "Trash gitdir of module %s", "Trash gitdirs of %d modules", modules)) {
      for (const module of modules) {
        const name = alist.find((e) => e[0] === module)?.[1];
        // Disregard if magit-delete-by-moving-to-trash is nil.  Not doing
        // so would be too dangerous.
        if (name) e8.deleteDirectory(e8.expandFileName(`modules/${name}`, magitGitdir()), { recursive: true, trash: true });
        else e8.signal("error", `BUG: Weird module name and/or path for ${module}`);
      }
    }
    magitRefresh();
  });
}

export const magitSubmoduleRemove = e8.defineCommand({
  name: "magit-submodule-remove",
  doc:
    "Unregister MODULES and remove their working directories.\n\n" +
    "For safety reasons, do not remove the gitdirs and if a module has uncommitted changes, then do not remove it at all.  If a module's gitdir is located inside the working directory, then move it into the gitdir of the superproject first.\n\n" +
    'With the "--force" argument offer to remove dirty working directories and with a prefix argument offer to delete gitdirs.  Both actions are very dangerous and have to be confirmed.  There are additional safety precautions in place, so you might be able to recover from making a mistake here, but don\'t count on it.',
  run: () => {
    const region = ((magitRegionValues("module", true) as string[] | undefined) ?? []).filter((m) => typeof m === "string");
    const modules = region.length > 0 ? (magitConfirm("remove-modules", undefined, "Remove %d modules", region) as string[]) : [magitReadModulePath("Remove module")];
    magitSubmoduleRemove1(modules, magitSubmoduleArguments("--force"), prefixArgP());
  },
});

export const magitListSubmodules = e8.defineCommand({
  name: "magit-list-submodules",
  doc: "Display a list of the current repository's populated submodules.",
  run: () => void magitSubmoduleListSetup(e8.variable("magit-submodule-list-columns") as unknown as RepolistColumn[]),
});

export const magitSubmodule = transientDefinePrefix("magit-submodule", {
  doc: "Act on a submodule.",
  groups: [
    {
      description: "Arguments",
      items: [
        ["-f", "Force", "--force"],
        ["-r", "Recursive", "--recursive"],
        ["-N", "Do not fetch", "--no-fetch"],
        ["-C", "Checkout tip", "--checkout"],
        ["-R", "Rebase onto tip", "--rebase"],
        ["-M", "Merge tip", "--merge"],
        ["-U", "Use upstream tip", "--remote"],
      ],
    },
    {
      description: "One module actions",
      items: [
        ["a", gitSubmoduleDescription("Add            git submodule add [--force]"), magitSubmoduleAdd],
        ["r", "Register       git submodule init", magitSubmoduleRegister],
        ["p", gitSubmoduleDescription("Populate       git submodule update --init [--recursive]"), magitSubmodulePopulate],
        ["u", gitSubmoduleDescription("Update         git submodule update [--force] [--no-fetch]\n                     [--remote] [--recursive] [--checkout|--rebase|--merge]"), magitSubmoduleUpdate],
        ["s", gitSubmoduleDescription("Synchronize    git submodule sync [--recursive]"), magitSubmoduleSynchronize],
        ["d", gitSubmoduleDescription("Unpopulate     git submodule deinit [--force]"), magitSubmoduleUnpopulate],
        ["k", "Remove", magitSubmoduleRemove],
      ],
    },
    {
      description: "Populated modules actions",
      items: [
        ["l", "List modules", magitListSubmodules],
        ["f", "Fetch modules", "magit-fetch-modules"],
      ],
    },
  ],
});

// Sections.

/** Inserts submodule sections, as magit-insert-modules: those magit-module-sections-hook names, in a Modules section of their own if magit-module-sections-nested. */
export function magitInsertModules(): void {
  const modules = magitListModulePaths();
  if (modules.length === 0) return;
  if (truthy(e8.variable("magit-module-sections-nested"))) {
    insertSection("modules", null, true, () => {
      insertHeading(e8.concat(e8.propertize("Modules", { "font-lock-face": "magit-section-heading" }), ` (${modules.length})`));
      magitInsertSectionBody(insertModules);
    }, "magit-insert-modules");
  } else insertModules();
}

/** Runs magit-module-sections-hook, as magit--insert-modules. */
function insertModules(): void {
  for (const fn of (e8.variable("magit-module-sections-hook") as unknown[] | null) ?? []) {
    if (typeof fn === "string" && inserters.has(fn)) inserters.get(fn)!();
    else if (typeof fn === "string" && e8.fboundp(fn)) e8.funcall(fn);
    else if (typeof fn === "function") (fn as () => void)();
  }
}

/**
 * Inserts sections for all modules, as magit-insert-modules-overview.
 * For each section insert the path and the output of `git describe --tags',
 * or, failing that, the abbreviated HEAD commit hash.
 */
export function magitInsertModulesOverview(): void {
  const modules = magitListModulePaths();
  if (modules.length === 0) return;
  insertSection("modules", null, true, () => {
    insertHeading(e8.concat(e8.propertize("Modules overview", { "font-lock-face": "magit-section-heading" }), ` (${modules.length})`));
    magitInsertSectionBody(insertModulesOverview);
  }, "magit-insert-modules-overview");
}

/** The modules' lines, as magit--insert-modules-overview. */
function insertModulesOverview(): void {
  withToplevel(() => {
    const modules = magitListModulePaths();
    const width = e8.windowSize()?.width ?? 80;
    const pathWidth = Math.min(Math.max(...modules.map((m) => m.length)), Math.floor(width / 2));
    const branchWidth = Math.min(25, Math.floor(width / 3));
    const pad = (s: string, w: number) => `${s.padEnd(w)} `;
    for (const module of modules) {
      inDirectory(e8.fileNameAsDirectory(e8.expandFileName(module)), () => {
        insertSection("module", module, true, () => {
          e8.insert(e8.propertize(pad(module, pathWidth), { "font-lock-face": "magit-diff-file-heading" }));
          if (!e8.fileExistsP(e8.expandFileName(".git"))) e8.insert("(unpopulated)");
          else {
            const branch = magitGetCurrentBranch();
            e8.insert(branch ? e8.propertize(pad(branch, branchWidth), { "font-lock-face": "magit-branch-local" }) : e8.concat(e8.propertize("(detached)", { "font-lock-face": "warning" }), " ".repeat(Math.max(0, branchWidth - 10) + 1)));
            const desc = magitGitString("describe", "--tags");
            const abbrev = desc ? undefined : magitRevFormat("%h");
            if (desc) {
              if (truthy(e8.variable("magit-modules-overview-align-numbers")) && /^[0-9]/.test(desc)) e8.insert(" ");
              e8.insert(e8.propertize(desc, { "font-lock-face": "magit-tag" }));
            } else if (abbrev) e8.insert(e8.propertize(abbrev, { "font-lock-face": "magit-hash" }));
          }
          e8.insert("\n");
        });
      });
    }
  });
  e8.insert("\n");
}

/** Inserts sections for modules that haven't been pulled from the upstream, as magit-insert-modules-unpulled-from-upstream. These sections can be expanded to show the respective commits. */
export const magitInsertModulesUnpulledFromUpstream = (): void => insertModulesLogs("Modules unpulled from @{upstream}", "modules-unpulled-from-upstream", "HEAD..@{upstream}");
/** Inserts sections for modules that haven't been pulled from the push-remote, as magit-insert-modules-unpulled-from-pushremote. These sections can be expanded to show the respective commits. */
export const magitInsertModulesUnpulledFromPushremote = (): void => insertModulesLogs("Modules unpulled from @{push}", "modules-unpulled-from-pushremote", "HEAD..@{push}");
/** Inserts sections for modules that haven't been pushed to the upstream, as magit-insert-modules-unpushed-to-upstream. These sections can be expanded to show the respective commits. */
export const magitInsertModulesUnpushedToUpstream = (): void => insertModulesLogs("Modules unmerged into @{upstream}", "modules-unpushed-to-upstream", "@{upstream}..HEAD");
/** Inserts sections for modules that haven't been pushed to the push-remote, as magit-insert-modules-unpushed-to-pushremote. These sections can be expanded to show the respective commits. */
export const magitInsertModulesUnpushedToPushremote = (): void => insertModulesLogs("Modules unpushed to @{push}", "modules-unpushed-to-pushremote", "@{push}..HEAD");

/** Whether submodules are ignored, by the buffer's diff arguments or diff.ignoreSubmodules, as magit-ignore-submodules-p. */
export function magitIgnoreSubmodulesP(returnArgument = false): string | undefined {
  const arg = ((e8.variable("magit-buffer-diff-args") as string[] | null) ?? []).find((a) => typeof a === "string" && a.startsWith("--ignore-submodules"));
  if (arg) return arg;
  const v = magitGet("diff.ignoreSubmodules");
  return v === undefined ? undefined : returnArgument ? `--ignore-submodules=${v}` : `diff.ignoreSubmodules=${v}`;
}

/** As magit-log-module-re: an optional side, a hash and the message. */
const logModuleRe = /^(?:([<>]) )?([0-9a-fA-F]+) (.*)$/;

/** Inserts a section of TYPE with HEADING listing each module's commits in RANGE, as magit--insert-modules-logs. */
function insertModulesLogs(heading: string, type: string, range: string): void {
  if (magitIgnoreSubmodulesP()) return;
  const modules = magitListModulePaths();
  if (modules.length === 0) return;
  const top = magitToplevel() ?? defaultDirectory();
  insertSection(type, null, true, () => {
    const m = /^(.+) ([^ ]+)$/.exec(heading)!;
    insertHeading(e8.propertize(m[1], { "font-lock-face": "magit-section-heading" }), " ", e8.propertize(m[2], { "font-lock-face": "magit-branch-remote" }), ":");
    for (const module of modules) {
      const dir = e8.fileNameAsDirectory(e8.expandFileName(module, top));
      if (!e8.fileExistsP(e8.expandFileName(".git", dir))) continue;
      const lines = inDirectory(dir, () => magitGitLines("-c", "push.default=current", "log", "--oneline", range));
      if (lines.length === 0) continue;
      insertSection("module", module, true, () => {
        insertHeading(lines.length, e8.propertize(module, { "font-lock-face": "magit-diff-file-heading" }));
        for (const line of lines) {
          const lm = logModuleRe.exec(line);
          if (!lm) continue;
          const [, , rev, msg] = lm;
          insertSection("module-commit", rev, true, () => {
            e8.insert(e8.concat(e8.propertize(rev, { "font-lock-face": "magit-hash" }), " ", magitLogWashSummary(msg), "\n"));
          });
        }
      });
    }
    magitCancelSection(true);
    e8.insert("\n");
  }, `magit-insert-${type}`);
}

for (const [name, fn] of [
  ["magit-insert-modules", magitInsertModules],
  ["magit-insert-modules-overview", magitInsertModulesOverview],
  ["magit-insert-modules-unpulled-from-upstream", magitInsertModulesUnpulledFromUpstream],
  ["magit-insert-modules-unpulled-from-pushremote", magitInsertModulesUnpulledFromPushremote],
  ["magit-insert-modules-unpushed-to-upstream", magitInsertModulesUnpushedToUpstream],
  ["magit-insert-modules-unpushed-to-pushremote", magitInsertModulesUnpushedToPushremote],
] as const)
  inserters.set(name, fn);

/** Visits DIRECTORY: its status, or, for the repository's own top, the containing directory in Dired, as magit-diff-visit-directory. */
function visitDirectory(directory: string, otherWindow: boolean): void {
  if (magitToplevel(directory) === magitToplevel()) {
    inDirectory(e8.fileNameDirectory(e8.directoryFileName(directory)) ?? directory, () => e8.call("dired-jump"));
    return;
  }
  // Magit shows the status in another window for OTHER-WINDOW with
  // display-buffer-overriding-action, which E8 does not have: there the
  // status buffer is shown as magit-display-buffer-function says.
  void otherWindow;
  magitStatusSetupBuffer(e8.fileNameAsDirectory(directory));
}

/** Visits MODULE's status, offering to populate it first, as magit-submodule-visit does once it has read it. */
export function magitSubmoduleVisit1(module: string, otherWindow = false): void {
  withToplevel(() => {
    const path = e8.expandFileName(module);
    if (e8.fileExistsP(e8.expandFileName(".git", path))) visitDirectory(path, otherWindow);
    else if (e8.yOrNP(`Initialize submodule '${module}' first?`)) {
      magitStartGitWith(["submodule", "update", "--init", "--", module], {
        then: (exit) => {
          if (exit === 0) visitDirectory(path, otherWindow);
        },
      });
    } else if (e8.fileExistsP(path)) inDirectory(e8.fileNameAsDirectory(path), () => e8.call("dired-jump"));
  });
}

export const magitSubmoduleVisit = e8.defineCommand({
  name: "magit-submodule-visit",
  doc: "Visit MODULE by calling magit-status on it.\nOffer to initialize MODULE if it's not checked out yet.\nWith a prefix argument, visit in another window.",
  run: () => {
    const at = magitSectionValueIf("module");
    magitSubmoduleVisit1(typeof at === "string" ? at : magitReadModulePath("Visit module"), prefixArgP());
  },
});

/** The keys of modules sections, as magit-modules-section-map. */
e8.defineKeymap("magit-modules-section-map", null);
e8.remapCommand("magit-modules-section-map", "magit-visit-thing" as e8.CommandName, "magit-list-submodules" as e8.CommandName);
magitSectionDefineType("modules", { keymap: "magit-modules-section-map" });

/** The keys of module sections, as magit-module-section-map. */
e8.defineKeymap("magit-module-section-map", null);
e8.defineKey("magit-module-section-map", "C-j", "magit-submodule-visit" as e8.CommandName);
e8.defineKey("magit-module-section-map", "C-<return>", "magit-submodule-visit" as e8.CommandName);
e8.remapCommand("magit-module-section-map", "magit-unstage-files" as e8.CommandName, "magit-unstage" as e8.CommandName);
e8.remapCommand("magit-module-section-map", "magit-stage-files" as e8.CommandName, "magit-stage" as e8.CommandName);
e8.remapCommand("magit-module-section-map", "magit-visit-thing" as e8.CommandName, "magit-submodule-visit" as e8.CommandName);
magitSectionDefineType("module", { keymap: "magit-module-section-map" });

// The list.
//
// The list of modules is a repository list of magit-repos.ts, with the
// columns of magit-submodule-list-columns.

/** Defines NAME as FN unless it already is, so a config's definition wins. */
const defunOnce = (name: string, fn: (...args: any[]) => unknown): void => {
  if (!e8.fboundp(name)) e8.defun(name, fn);
};

defunOnce("magit-modulelist-column-path", (spec: RepolistSpec) => {
  const path = String(spec.find((e) => e[0] === ":path")?.[1]);
  for (const fn of (e8.variable("magit-submodule-list-format-path-functions") as unknown[] | null) ?? []) {
    const r = e8.funcall(fn as string, path);
    if (truthy(r)) return r;
  }
  return path;
});

export const magitSubmoduleListMode = e8.defineMajorMode({
  name: "magit-submodule-list-mode",
  modeName: "Modules",
  parent: magitRepolistMode,
  doc: "Major mode for browsing a list of Git submodules.",
  setup: () => {
    e8.removeHook("tabulated-list-revert-hook", magitRepolistRefresh, { local: true });
    e8.addHook("tabulated-list-revert-hook", magitSubmoduleListRefresh, { local: true });
  },
});

/** Each list buffer's predicate on modules, as magit-submodule-list-predicate. */
const predicates = new Map<string, (module: string) => boolean>();

/** Shows the list of submodules with COLUMNS, those PREDICATE accepts, as magit-submodule-list-setup. */
export function magitSubmoduleListSetup(columns: RepolistColumn[], predicate?: (module: string) => boolean): string {
  const top = magitToplevelOrError();
  const name = magitBufferName("magit-submodule-list-mode", top);
  e8.getBufferCreate(name);
  magitDisplayBuffer(name);
  e8.withCurrentBuffer(name, () => {
    e8.call(magitSubmoduleListMode);
    e8.makeLocalVariable("default-directory");
    e8.setVariable("default-directory", top);
    e8.makeLocalVariable("magit-repolist-columns");
    e8.setVariable("magit-repolist-columns", columns as unknown as e8.Value);
    e8.makeLocalVariable("magit-repolist-sort-key");
    e8.setVariable("magit-repolist-sort-key", e8.variable("magit-submodule-list-sort-key") ?? null);
    if (predicate) predicates.set(name, predicate);
    else predicates.delete(name);
    magitRepolistSetup1();
    magitSubmoduleListRefresh();
  });
  return name;
}

/** Lists the populated modules afresh, as magit-submodule-list-refresh. */
export function magitSubmoduleListRefresh(): void {
  const columns = (e8.variable("magit-repolist-columns") as unknown as RepolistColumn[] | null) ?? [];
  const predicate = predicates.get(e8.bufferName());
  const top = defaultDirectory();
  const entries: e8.Value[] = [];
  for (const module of inDirectory(top, magitListModulePaths)) {
    const dir = e8.fileNameAsDirectory(e8.expandFileName(module, top));
    inDirectory(dir, () => {
      if (!e8.fileExistsP(e8.expandFileName(".git")) || (predicate && !predicate(module))) return;
      entries.push([
        dir,
        columns.map(([title, width, fn, props]) => {
          const r = e8.funcall(fn as string, [[":path", module], [":title", title], [":width", width], ...(props ?? [])]);
          return truthy(r) ? (r as e8.Value) : "";
        }),
      ]);
    });
  }
  e8.setVariable("tabulated-list-entries", entries);
  e8.message("Listing submodules...");
  tabulatedListInitHeader();
  tabulatedListPrint(true);
  e8.message("Listing submodules...done");
}

// Utilities.

/** Offers to reuse, rename or trash the gitdir a module NAME had, if PATH has no working tree, as magit-submodule--maybe-reuse-gitdir. */
function magitSubmoduleMaybeReuseGitdir(name: string, path: string): void {
  const gitdir = e8.expandFileName(`modules/${name}`, magitGitdir());
  if (!e8.fileExistsP(gitdir) || e8.fileExistsP(path)) return;
  const choice = e8.readCharChoice(
    `${gitdir} already exists.\n` +
      "Type [u] to use the existing gitdir and create the working tree\n" +
      "     [r] to rename the existing gitdir and clone again\n" +
      "     [t] to trash the existing gitdir and clone again\n" +
      "   [C-g] to abort ",
    "urt",
  );
  if (choice === "u") magitSubmoduleRestoreWorktree(e8.expandFileName(path), gitdir);
  else if (choice === "r") e8.renameFile(gitdir, `${gitdir}-${magitFormatTimeString("%F-%T", Date.now() / 1000)}`);
  else if (choice === "t") e8.deleteDirectory(gitdir, { recursive: true, trash: true });
}

/** Makes WORKTREE again from the module's GITDIR, as magit-submodule--restore-worktree. */
function magitSubmoduleRestoreWorktree(worktree: string, gitdir: string): void {
  e8.makeDirectory(worktree, { parents: true });
  e8.writeTextFile(e8.expandFileName(".git", worktree), `gitdir: ${fileRelativeName(gitdir, worktree)}\n`);
  inDirectory(e8.fileNameAsDirectory(worktree), () => magitCallGit("reset", "--hard", "HEAD", "--"));
}

// The button keys tabulated-list-mode-map has in Emacs, from button-buffer-map, which E8's lacks.
for (const [key, command] of [
  ["TAB", "forward-button"],
  ["<backtab>", "backward-button"],
  ["C-M-i", "backward-button"],
] as const)
  e8.defineKey("magit-submodule-list-mode-map", key, command as e8.CommandName);
