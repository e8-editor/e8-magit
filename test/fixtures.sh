#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# fixtures.sh NAME DIR: makes the repository NAME in DIR/repo, with any
# remote in DIR/origin.git, for e8-magit's tests and for test/record.el,
# which records what Magit shows of it. Every commit has a fixed author,
# committer and date, so its hash is the same wherever it is made, and
# no global or system git configuration is read.
set -eu
name=$1
dir=$2
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=t@example.com
n=0
tick() {
  n=$((n + 1))
  export GIT_AUTHOR_DATE="2026-01-01T12:$(printf %02d "$n"):00Z" GIT_COMMITTER_DATE="2026-01-01T12:$(printf %02d "$n"):00Z"
}
commit() {
  tick
  git commit -q -m "$1"
}
setup() {
  git init -q -b main "$1"
  cd "$1"
  git config user.name Tester
  git config user.email t@example.com
  git config commit.gpgsign false
  git config tag.gpgsign false
  git config core.autocrlf false
  git config advice.detachedHead false
  git config init.defaultBranch main
}
mkdir -p "$dir"
case $name in
basic)
  # One commit, a change unstaged, one staged, an untracked file, no upstream.
  setup "$dir/repo"
  printf 'one\ntwo\nthree\n' > a.txt
  printf 'keep\n' > b.txt
  git add .
  commit "First commit"
  printf 'one\nTWO\nthree\nfour\n' > a.txt
  printf 'new\n' > c.txt
  printf 'keep\nmore\n' > b.txt
  git add b.txt
  ;;
remote)
  # An upstream with commits unpushed and unpulled, a tag, two stashes
  # and another branch.
  git init -q --bare -b main "$dir/origin.git"
  setup "$dir/repo"
  git remote add origin ../origin.git
  printf 'one\n' > a.txt
  git add a.txt
  commit "First commit"
  tick
  git tag -a v0.1 -m "Version 0.1"
  printf 'one\ntwo\n' > a.txt
  git commit -q -am "Second commit" && tick
  printf 'b\n' > b.txt
  git add b.txt
  commit "Add b"
  git push -q -u origin main
  git branch feature
  # A commit on origin that is fetched but not pulled.
  git clone -q ../origin.git ../other
  (cd ../other && git config user.name Tester && git config user.email t@example.com && printf 'remote\n' > r.txt && git add r.txt && tick && git commit -q -m "Remote commit" && git push -q origin main)
  rm -rf ../other
  git fetch -q origin
  printf 'local\n' > l.txt
  git add l.txt
  commit "Local commit"
  printf 'stash one\n' >> a.txt
  tick
  git stash push -q -m "first stash"
  printf 'stash two\n' >> b.txt
  tick
  git stash push -q -m "second stash"
  printf 'one\ntwo\nthree\n' > a.txt
  ;;
rebase)
  # A rebase stopped on a conflict.
  setup "$dir/repo"
  printf 'one\ntwo\nthree\n' > a.txt
  git add a.txt
  commit "Base"
  git checkout -q -b topic
  printf 'one\nTOPIC\nthree\n' > a.txt
  git commit -q -am "Topic change" && tick
  printf 't\n' > t.txt
  git add t.txt
  commit "Topic file"
  git checkout -q main
  printf 'one\nMAIN\nthree\n' > a.txt
  git commit -q -am "Main change" && tick
  git checkout -q topic
  tick
  git rebase main >/dev/null 2>&1 || true
  ;;
merge)
  # A merge stopped on a conflict.
  setup "$dir/repo"
  printf 'one\ntwo\nthree\n' > a.txt
  printf 'b\n' > b.txt
  git add .
  commit "Base"
  git checkout -q -b topic
  printf 'one\nTOPIC\nthree\n' > a.txt
  printf 'b\ntopic\n' > b.txt
  git commit -q -am "Topic change" && tick
  git checkout -q main
  printf 'one\nMAIN\nthree\n' > a.txt
  git commit -q -am "Main change" && tick
  tick
  git merge topic >/dev/null 2>&1 || true
  ;;
renames)
  # A commit with a rename, a binary file and a deletion; in the
  # worktree a staged rename, an unstaged deletion and a changed binary.
  setup "$dir/repo"
  printf 'alpha\nbeta\ngamma\ndelta\n' > old.txt
  printf 'gone\n' > gone.txt
  printf 'keep\n' > keep.txt
  printf '\000\001\002' > bin.dat
  git add .
  commit "Base"
  git mv old.txt new.txt
  git rm -q gone.txt
  printf '\000\001\003' > bin.dat
  git add bin.dat
  commit "Rename, delete and change a binary"
  git mv keep.txt kept.txt
  rm new.txt
  printf '\000\001\004' > bin.dat
  ;;
history)
  # Three commits, each adding a file of its own.
  setup "$dir/repo"
  for f in One Two Three; do
    printf '%s\n' "$f" > "$f.txt"
    git add "$f.txt"
    commit "$f"
  done
  ;;
*)
  echo "fixtures.sh: no fixture $name" >&2
  exit 1
  ;;
esac
