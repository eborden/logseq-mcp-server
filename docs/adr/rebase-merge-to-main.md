# Merge pull requests by rebase to keep atomic commits on main

## Context

Work is done by agents and by the maintainer in small, atomic commits. CLAUDE.md's PR conventions, added in commit 9429497, say: "Atomic commits" and "Rebase-merge so the atomic commits stay on `main`. Delete the branch on merge." Foundations hard rule 9 (PR #38) puts the branch handling inside the workflow: "Rebasing and force-pushing your own feature branch, and deleting it on merge, are part of that workflow."

Inferred, not recorded as a comparison anyone made: GitHub offers three merge methods. A merge commit keeps the commits but makes `main` non-linear. Squash flattens a PR into one commit and loses the atomic history. Rebase keeps each commit and keeps `main` linear, which is the stated aim.

When this was written, the repository allowed all three merge methods and `delete_branch_on_merge` was off, so both halves of the policy are held by convention rather than by GitHub.

## Decision

We merge PRs by rebase, so each atomic commit lands on `main` as written, and delete the branch on merge (CLAUDE.md, PR conventions). Authors may rebase and force-push their own feature branches (foundations, hard rule 9). The maintainer merges by default (CLAUDE.md, merge policy).

## Consequences

- `main` is linear, and `git bisect` and `git revert` work on single logical changes.
- Commit messages must be written for `main`: a "fix typo" or "wip" commit survives unless the author cleans it up before merge.
- Rebasing rewrites commit ids on the branch, so a review that pinned a head commit has to be redone after a rebase.
- Nothing in the repository stops a merge commit or a squash, or deletes the branch. Following the policy depends on the person pressing the button.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

Repository settings could hold this (allow only rebase merges, delete branches on merge, or enable the existing "Protect Main" ruleset, which is disabled). Changing them is the maintainer's call, tracked in #96. Until then the person merging is the only check.

- reviewer: The PR's commits are atomic with clear messages, so a rebase-merge puts readable commits on main. Whoever merges picks "Rebase and merge".
- none-yet: #96
