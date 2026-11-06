# e8-magit

Git in a status buffer of sections, for [E8](https://github.com/e8-editor/e8): `C-x g` shows the repository, and single keys stage, unstage, discard, commit, branch, push, pull, rebase and stash, with Magit's menus. A port of [Magit](https://github.com/magit/magit) 4.4.0.

**This is a subset of Magit.** The status buffer, staging, committing, branching, pushing and pulling, the log, diffs, stashing and interactive rebasing work, and every menu shows what Magit's does; but blame, bisect, worktrees, submodules, subtrees, notes, ediff and applying patches are not there, and many of the log's and diff's options do nothing yet. [What works](#what-works) and [what is missing](#what-is-missing) below say which. Its versions start at v0.1.0.

## Installing

In `~/.config/e8/init.ts`:

```ts
e8.usePackage("e8-editor/e8-magit");
```

E8 installs it at its newest version tag into `repos/` beside `init.ts`, with [e8-magit-section](https://github.com/e8-editor/e8-magit-section) and [e8-with-editor](https://github.com/e8-editor/e8-with-editor), which it requires, records the commits in `e8-lock.json`, and requires it. `M-x package-vc-upgrade` brings it up to date. Pin a version with `{ rev: "v0.1.0" }`. It needs E8 0.3.1 or newer, and `git` on the PATH.

## Using it

`C-x g` (`magit-status`, or `M-x magit`) in a file or directory of a repository shows its status; outside one it offers to make one. `C-x M-g` opens the dispatch menu from anywhere. In Magit's buffers:

| Key | Does |
| --- | --- |
| `TAB`, `C-<tab>`, `<backtab>` | hide and show the section at point, cycle it, cycle them all |
| `n`, `p`, `M-n`, `M-p`, `^` | the next, previous, sibling and parent section |
| `1` to `4` | show the sections to that level |
| `s`, `u` | stage, unstage the file, hunk or section at point; with a region in a hunk, just its lines |
| `S`, `U` | stage all changes to tracked files (untracked ones too with `C-u`), unstage everything |
| `k` | discard the file, hunk or section at point, after asking; an untracked file is deleted |
| `RET` | visit the file at point, on the hunk's line, or show the commit or stash at point |
| `g`, `G` | refresh this buffer, or all of the repository's |
| `$` | the git commands run and their output |
| `q` | bury the buffer |
| `h`, `?` | the dispatch menu |
| `c`, `b`, `P`, `F`, `f`, `m`, `r`, `X`, `z`, `l`, `d` | the commit, branch, push, pull, fetch, merge, rebase, reset, stash, log and diff menus |

Commit messages are written in a `COMMIT_EDITMSG` buffer in `git-commit-mode`, and an interactive rebase's todo list in `git-rebase-mode`; `C-c C-c` finishes and `C-c C-k` gives up. git runs E8 as its editor for them through with-editor, so git's own template and hooks apply.

Variables: `magit-git-executable` (`"git"`), `magit-log-section-commit-count` (how many recent commits the status shows, 10), `magit-save-repository-buffers` (save the repository's file buffers before running git), `git-commit-summary-max-length` (68), and `magit-section-initial-visibility-alist` from e8-magit-section.

## What works

- **The status buffer**: the branch and its upstream (`Merge:` or `Rebase:`), push remote and tag; untracked files, unstaged and staged changes as diffs of files and hunks; stashes; the commits not pushed and not pulled; and the recent commits.
- **Applying**: `s`, `u` and `k` on a file, a hunk, the lines of a region in a hunk, or a whole section; `S` and `U`.
- **Commit** (`c`): commit, extend, amend, reword, fixup, squash, alter, augment, revise, and instant fixup and squash, with the commit's diff shown beside the message.
- **Branch** (`b`): checkout, create, spin off and spin out, rename, reset and delete, and the branch's and repository's configuration.
- **Push** (`P`), **pull** (`F`) and **fetch** (`f`): to and from the push remote, the upstream (set when there is none) or elsewhere, refspecs, matching branches and tags.
- **Merge** (`m`): merge, with or without editing the message or committing, absorb, preview, squash and dissolve.
- **Rebase** (`r`): onto the upstream, the push remote or elsewhere, a subset, interactively with the todo list in `git-rebase-mode`, to edit, reword or remove a commit, autosquash, and continue, skip, edit or abort one going on.
- **Reset** (`X`): mixed, soft, hard, keep, the index or the worktree only, a branch, or a file.
- **Stash** (`z`): both, the index, the worktree, or keeping the index; snapshots; apply, pop, drop, list, show, branch, and format a stash as a patch.
- **Log** (`l`): the current branch, another, the related branches, local or all branches, all references; reflogs; shortlog. `RET` shows a commit, with its diff.
- **Diff** (`d`): dwim, a range, two paths, unstaged, staged, the worktree, a commit, a stash.
- From the dispatch menu, cherry-pick, revert, tag, ignore, init, clone, run a git command, refs, cherries, add a remote and format patches, one command each.

## What is missing

- **Not there at all**: blame; bisect; worktrees; submodules; subtrees; notes; ediff; applying patches (`w`, git am); applying or reversing a change from elsewhere (`a`, `v`); and `magit-file-dispatch`. Their keys in the menus say so.
- **One command rather than a menu**: cherry-pick, revert, tag and remote, where Magit opens a menu of their own.
- **The log** is a line a commit, with no graph and no margin. The log menu's limiting, simplification and ordering options change which commits it lists; its formatting switches draw nothing, and showing diffs or diffstats in the log does not work.
- **Diff options** apply to a range, two paths and the worktree, not to the status buffer or dwim, staged and unstaged diffs; there is no word-diff, and no refining of hunks.
- **The status buffer** does not show a rebase or merge going on, or the files in conflict, though the rebase menu offers to continue one.
- **Push, pull and fetch** run without waiting and cannot ask for credentials: use an SSH agent or a credential helper.
- Only programs E8 starts can use E8 as their editor (see e8-with-editor).

## Credit

This is a port to E8 of [Magit](https://github.com/magit/magit) 4.4.0, by Marius Vollmer, Jonas Bernoulli and the [Magit contributors](https://github.com/magit/magit/blob/main/docs/AUTHORS.md), copyright The Magit Project Contributors, and distributed in NonGNU ELPA and MELPA, under the GNU General Public License version 3 or later. It is not the upstream authors' work as published, and they do not endorse it: report problems with the port here, not upstream.

## Developing

With an E8 on your PATH (a [release](https://github.com/e8-editor/e8/releases), or built from source), `git`, and TypeScript 5.8 or newer:

```bash
make test
make types
```

`make` clones e8-magit-section and e8-with-editor into `.e8/deps`. The tests in `test/magit-tests.ts` each make a git repository in a temporary directory and check what the status buffer shows, key by key, against what Magit 4.4.0 shows in Emacs 30; that staging, unstaging, discarding, committing, branching, stashing, pushing, an instant fixup, an interactive rebase and rewording change the repository as they should; and that each menu is laid out as Magit's. `test/menus.json` holds Magit's menus, recorded from Emacs by `test/record.el` (`emacs -Q --batch -l test/record.el`, with Magit installed by elpaca or `E8_ELPA_BUILDS` naming where its packages are built).

## Licence

GPL-3.0-or-later: see `LICENSE`.
