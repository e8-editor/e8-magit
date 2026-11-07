// SPDX-License-Identifier: GPL-3.0-or-later
//
// Additional functionality for Magit, after magit-extras.el: so far,
// launching gitk and git gui in the repository.
//
// Copyright (C) 2008-2025 The Magit Project Contributors
// Copyright (C) 2026 The E8 contributors
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.

import { magitGitExecutable, magitToplevelOrError } from "magit-git";

e8.defineVariable({ name: "magit-gitk-executable", doc: "The Gitk executable.", value: "gitk" });

/** PROGRAM's file along exec-path, as executable-find. */
function executableFind(program: string): string | undefined {
  if (program.includes("/")) return e8.fileExecutableP(program) ? program : undefined;
  const path = (e8.variable("exec-path") as string[] | null) ?? (e8.getenv("PATH") ?? "").split(":");
  return path.map((d) => e8.expandFileName(program, d)).find((f) => e8.fileExecutableP(f));
}

/** Starts PROGRAM with ARGS in the repository, not waiting for it, as magit-process-file with destination 0. */
function launch(program: string, args: string[], directory = String(e8.variable("default-directory"))): void {
  if (!executableFind(program)) e8.userError(`Searching for program: No such file or directory, ${program}`);
  e8.makeProcess({ name: e8.fileNameNondirectory(program), command: [program, ...args], directory });
}

export const magitRunGitGui = e8.defineCommand({ name: "magit-run-git-gui", doc: "Run git gui for the current git repository.", run: () => launch(magitGitExecutable(), ["gui"], magitToplevelOrError()) });
const gitk = (): string => String(e8.variable("magit-gitk-executable") ?? "gitk");
export const magitRunGitk = e8.defineCommand({ name: "magit-run-gitk", doc: "Run gitk in the current repository.", run: () => launch(gitk(), []) });
export const magitRunGitkBranches = e8.defineCommand({ name: "magit-run-gitk-branches", doc: "Run gitk --branches in the current repository.", run: () => launch(gitk(), ["--branches"]) });
export const magitRunGitkAll = e8.defineCommand({ name: "magit-run-gitk-all", doc: "Run gitk --all in the current repository.", run: () => launch(gitk(), ["--all"]) });
export const magitGitMergetool = e8.defineCommand({ name: "magit-git-mergetool", doc: "Resolve conflicts with git mergetool --gui.", run: () => launch(magitGitExecutable(), ["mergetool", "--gui"], magitToplevelOrError()) });
