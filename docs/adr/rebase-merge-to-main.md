# Merge pull requests by rebase to keep atomic commits on main

## Context

Work is done by agents and by the maintainer in small, atomic commits: one logical change each, so history stays easy to read, bisect and revert (the maintainer's commit practice, recorded in the Development Workflow section of CLAUDE.md, commit 9429497). Each PR is a stack of such commits, usually with a review pass in between.

GitHub offers three merge methods. A merge commit adds a merge node and keeps the commits, but makes `main` non-linear. Squash flattens a whole PR into one commit, which throws away the atomic history that was the point of writing it. Rebase keeps each commit and keeps `main` linear.

When this was written, repository settings permitted all three methods, so the choice is held by convention rather than by GitHub.

## Decision

We merge PRs by rebase, so each atomic commit lands on `main` as written. The branch is deleted on merge. Authors rebase their own feature branches onto `main` before merge, and that includes force-pushing their own branch. The maintainer merges by default.

## Consequences

- `main` is linear, and `git bisect` and `git revert` work on single logical changes.
- Commit messages must be written for `main`: a "fix typo" or "wip" commit survives unless the author cleans it up before merge.
- Rebasing rewrites commit ids on the branch, so a review that pinned a head commit has to be redone after a rebase.
- Nothing in the repository stops a merge commit or a squash. Following the policy depends on the person pressing the button.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- reviewer: Before merging, check that the merge method is "Rebase and merge", and that the PR's commits are atomic with clear messages.
