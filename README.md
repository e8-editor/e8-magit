# e8-magit

Git in a status buffer of sections, for [E8](https://github.com/e8-editor/e8): `C-x g` shows the repository, and single keys stage, unstage, discard, commit, branch, push, pull, rebase and stash, with Magit's menus. A port of [Magit](https://github.com/magit/magit) 4.4.0.

**This is a subset of Magit.** The status buffer, staging, committing, branching, pushing and pulling, the log, diffs, stashing and interactive rebasing work, and every menu shows what Magit's does; but blame and ediff are not there, and many of the log's and diff's options do nothing yet. [What works](#what-works) and [what is missing](#what-is-missing) below say which, and [docs/plan.md](docs/plan.md) is the plan for porting the rest, step by step. Its versions start at v0.1.0.

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
| `A`, `V`, `w` | the cherry-pick, revert and apply-patches (git am) menus |
| `t`, `M`, `!`, `C`, `I`, `Q` | the tag, remote and run menus, clone, init, and a git command |
| `y`, `i`, `T`, `W`, `B`, `Z`, `o`, `O` | the references buffer, and the gitignore, notes, patch, bisect, worktree, submodule and subtree menus |

Commit messages are written in a `COMMIT_EDITMSG` buffer in `git-commit-mode`, and an interactive rebase's todo list in `git-rebase-mode`; `C-c C-c` finishes and `C-c C-k` gives up. git runs E8 as its editor for them through with-editor, so git's own template and hooks apply.

Variables: `magit-git-executable` (`"git"`), `magit-log-section-commit-count` (how many recent commits the status shows, 10), `magit-save-repository-buffers` (save the repository's file buffers before running git), `git-commit-summary-max-length` (68), and `magit-section-initial-visibility-alist` from e8-magit-section.

## What works

- **The status buffer**: the branch and its upstream (`Merge:` or `Rebase:`), push remote and tag; untracked files, unstaged and staged changes as diffs of files and hunks; stashes; the commits not pushed and not pulled; and the recent commits.
- **Applying**: `s`, `u` and `k` on a file, a hunk, the lines of a region in a hunk, or a whole section; `S` and `U`.
- **Commit** (`c`): commit, extend, amend, reword, fixup, squash, alter, augment, revise, and instant fixup and squash, with the commit's diff shown beside the message.
- **Branch** (`b`): checkout, create, spin off and spin out, rename, reset and delete, and the branch's and repository's configuration.
- **Push** (`P`), **pull** (`F`) and **fetch** (`f`): to and from the push remote, the upstream (set when there is none) or elsewhere, refspecs, matching branches and tags.
- **Merge** (`m`): merge, with or without editing the message or committing, absorb, preview, squash and dissolve.
- **Rebase** (`r`): onto the upstream, the push remote or elsewhere, a subset, interactively, to edit, reword or remove a commit, or autosquash, from the commit at point or one selected in a log, asking before rewriting published commits, and continue, skip, edit or abort one going on.
- **The todo list** in `git-rebase-mode`, as git-rebase.el's: `c`, `r`, `e`, `s`, `S`, `f`, `F` and `d` set the action of the line or the region's lines, `k` comments a line out or in, `M-p` and `M-n` move lines, `x`, `l`, `t`, `u`, `M M`, `b`, `z` and `y` add exec, label, reset, update-ref, merge, break, noop and pick lines, `RET` and `SPC` show the commit, and the instructions name these keys.
- **Cherry-pick** (`A`): pick or apply commits here, harvest them from another branch, donate them to one, or spin them out or off to a new branch; **revert** (`V`) with or without committing; **apply patches** (`w`) from files or a maildir; and continue, skip or abort a sequence going on.
- **Reset** (`X`): mixed, soft, hard, keep, the index or the worktree only, a branch, or a file.
- **Stash** (`z`): both, the index, the worktree, or keeping the index; snapshots; apply, pop, drop, list, show, branch, and format a stash as a patch.
- **Log** (`l`): the current branch, HEAD, another, the related branches, local or all branches, all references, matching branches or tags, a file's history, a definition's trace, a commit's merge; reflogs; shortlog; cherries. Each commit has its graph, refs and summary, and its author and age in the margin (`L` to toggle, cycle or detail it); `+`, `-` and `=` change the limit; with `++header`, `--patch` or `--stat` the commit's header or diff. `RET` shows a commit.
- **The status buffer** as Magit's: the headers (an error, the diff filter, Head, Merge or Rebase, Push, the tags), a merge, rebase, git am, cherry-pick, revert or bisect going on, untracked files, unstaged and staged changes, stashes, and the commits unpushed, unpulled or recent, each section a function in `magit-status-sections-hook`; `j` jumps to a section.
- **Diff** (`d`): dwim, a range, two paths, unstaged, staged, the worktree, a commit, a stash, each with a diffstat; `+`, `-` and `0` change the context, `j` jumps between the diffstat and the diff, `SPC` and `DEL` show the commit at point or scroll it, and with `magit-diff-refine-hunk` the words that changed are marked. The revision buffer shows a commit's refs, author, parents, the branches it is merged into and contained in, the tags around it, its message and notes, and a tag's message; the stash buffer a stash's unstaged, staged and untracked changes. `RET` on a hunk visits its line in the work tree or the blob.
- **Tags** (`t`): create one, a release tag named from the release commit or the last release, delete, and prune those that differ from a remote's.
- **Remotes** (`M`): the current remote's url, fetch, pushurl, push and tagOpt variables, set in the menu; add (offering `remote.pushDefault`), rename and remove (the push variables follow), prune stale branches and refspecs, unshallow, configure another remote, and update the default branch.
- **Clone** (`C`, or `C-u C` for the menu: regular, shallow, bare, mirror, sparse), from a url, a name such as `gh:owner/repo`, a path, a local url or a bundle; **init** (`I`); and **run** (`!`: a git or shell command, in the repository or the working directory, gitk, git gui, git mergetool).
- **References** (`y`, `C-u y` for the menu): the local branches with their upstreams and how far ahead and behind, each remote's branches and the tags, each expanding to the commits the focused ref lacks.
- **Ignoring** (`i`): at the top, in a subdirectory, privately or for all repositories; skip-worktree and assume-unchanged. **Notes** (`T`): edit, remove, merge and prune, and the notes refs. **Patches** (`W`): create with git format-patch and its options, apply, save a diff. **Bisect** (`B`): start, good, bad, mark, skip, run a script, reset, with the bisect sections in the status buffer.
- **Worktrees** (`Z`): check out, branch, move, delete, visit, and their sections. **Submodules** (`o`): add, register, populate, update, synchronize, unpopulate, remove, list, and the module sections. **Subtrees** (`O`): import (add, merge, pull) and export (push, split).
- **Files** (`C-c M-g` in a file's buffer): stage, unstage, untrack, rename, delete and check out the file, diff, log and trace it, and visit it at a revision (`magit-find-file`), in the index, or step through its revisions with `n` and `p` in `magit-blob-mode`; `magit-update-index` writes the index's version back; `K` and `R` untrack and rename in Magit buffers.
- From the dispatch menu, cherries, one command.
- **Dired** (magit-dired.el): `M-TAB` in Magit's buffers, and `C-x C-j` in the status buffer, lists the directory of the file at point in Dired with point on it (`magit-dired-jump`); `&` on a file or hunk runs a shell command on its file in the background (`magit-do-async-shell-command`); in Dired, `magit-dired-stage`, `magit-dired-unstage` and `magit-dired-log` act on the marked files (`C-c M-g s`, `u`, `l` there), and `magit-dired-am-apply-patches` applies them with git am.
- **Reverting buffers** (magit-autorevert.el): `magit-auto-revert-mode`, on unless E8 runs in batch or `global-auto-revert-mode` is on, turns on `auto-revert-mode` in buffers visiting tracked files, and the repository's unmodified buffers whose files git changed are reverted as each git command Magit runs ends (`magit-auto-revert-buffers` on `magit-post-refresh-hook`, as `magit-auto-revert-immediately` says).
- **Work-in-progress refs** (magit-wip.el): `magit-wip-mode` commits snapshots of the index and the worktree to `refs/wip/index/refs/heads/BRANCH` and `refs/wip/wtree/refs/heads/BRANCH` after a tracked file is saved, before and after staging, unstaging, discarding and resetting, and before a file is first saved, through the four modes it turns on, which can be used alone; `z r` (`magit-wip-commit`) commits on demand; `magit-wip-log-current` and `magit-wip-log` show a branch with its wip refs, `l i` and `l w` (shown while a wip mode is on) the wip refs alone; `magit-wip-purge` deletes those whose branch is gone.
- **Extras** (magit-extras.el): `C-w` (`magit-copy-section-value`) copies the value of the section at point, a commit's, branch's or tag's revision going on the revision stack too (with a prefix argument, a branch's name; with a region in a hunk, only its added or removed lines); `M-w` (`magit-copy-buffer-revision`) the revision the buffer shows; `C-c C-w` in a commit message (`magit-pop-revision-stack`) inserts the last revision saved, as `magit-pop-revision-stack-format` says. `magit-abort-dwim` aborts the merge, rebase, git am, cherry-pick, revert or bisect going on; `magit-reshelve-since` (`r t` at level 6) changes the dates of the commits since one selected; `magit-clean` removes untracked files; `magit-project-status` is `m` in `C-x p` and `C-x p p`; `magit-run-git-gui-blame`; `magit-display-repository-buffer` and `magit-switch-to-repository-buffer`; and in Magit's buffers `next-line`, `previous-line` and `back-to-indentation` are Magit's, selecting one line of a hunk with the first shifted move.

## What is missing

- **Not there at all**: blame; ediff; applying or reversing a change from elsewhere (`a`, `v`). Their keys in the menus say so.
- Suffixes Magit puts above level 4 (signing, `--exec`, a rebase's strategy, some of clone's) are left out of the menus until E8's transient has levels (E8 0.5).
- Only programs E8 starts can use E8 as their editor (see e8-with-editor).
- E8 has no file notification, so a buffer whose file git changes outside Magit, from a shell say, is reverted only after `auto-revert-interval` seconds, or when Magit next runs git or refreshes; Magit's reverting after its own commands works as with notification.
- With `magit-wip-merge-branch`, a commit made in `COMMIT_EDITMSG` is not followed by a wip commit (`magit-wip-maybe-add-commit-hook`), and saving several buffers before git runs makes a wip commit for each, not one for all.
- `magit-generate-changelog` and `magit-add-change-log-entry` (`C-x a`, `C-x 4 a` on a hunk): E8 has no add-log.el or `diff-add-log-current-defuns` for them to build on.

## Credit

This is a port to E8 of [Magit](https://github.com/magit/magit) 4.4.0, by Marius Vollmer, Jonas Bernoulli and the [Magit contributors](https://github.com/magit/magit/blob/main/docs/AUTHORS.md), copyright The Magit Project Contributors, and distributed in NonGNU ELPA and MELPA, under the GNU General Public License version 3 or later. It is not the upstream authors' work as published, and they do not endorse it: report problems with the port here, not upstream.

## Developing

With an E8 on your PATH (a [release](https://github.com/e8-editor/e8/releases), or built from source), `git`, and TypeScript 5.8 or newer:

```bash
make test
make types
```

`make` clones e8-magit-section and e8-with-editor into `.e8/deps`. The tests in `test/magit-tests.ts` each make a git repository in a temporary directory and check what the status buffer shows, key by key, against what Magit 4.4.0 shows in Emacs 30; that staging, unstaging, discarding, committing, branching, stashing, pushing, an instant fixup, an interactive rebase, rewording, cherry-picking, spinning off, reverting, applying a patch, tags, remotes, cloning, init and running git change the repository as they should; and that each menu is laid out as Magit's. `test/oracle/` holds what Magit shows for each case in `test/oracle/cases.json`, a fixture repository made by `test/fixtures.sh` and keys typed in its status buffer, and `test/oracle-tests.ts` types the same keys in E8 and compares the buffer's name, text, point and faces; a case marked `pending` is one the [plan](docs/plan.md) has yet to port, and `E8_ORACLE_REPORT=1 make test` prints what differs. `test/menus.json` holds Magit's menus. Both are recorded from Emacs by `test/record.el` (`make oracle`, or `E8_ORACLE_ONLY=NAME make oracle` for the cases whose names have NAME, with Magit installed by elpaca or `E8_ELPA_BUILDS` naming where its packages are built).

## Licence

GPL-3.0-or-later: see `LICENSE`.
