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

The repository settings and the "Protect Main" ruleset hold this at the platform level, applied on 2026-10-05 (#96). They are configuration on GitHub, not files in the repo, so no `ci:` or `test:` line can name them and the guard does not check them:

- Merge methods: only rebase merges are allowed (`allow_rebase_merge` on, `allow_merge_commit` and `allow_squash_merge` off), so a merge commit or a squash cannot be pressed.
- Branch cleanup: `delete_branch_on_merge` is on, so a merged PR's branch is deleted.
- The "Protect Main" ruleset is active on the default branch with `deletion`, `non_fast_forward` and `required_linear_history`, and has no bypass actors. `main` cannot be deleted, force-pushed or given a merge commit.

Changing these settings is the maintainer's call. If someone relaxes them, nothing in the repo notices, so the reviewer checks them again when a PR touches merge policy.

- reviewer: The PR's commits are atomic with clear messages, so a rebase-merge puts readable commits on main. Whoever merges picks "Rebase and merge", and the reviewer confirms the repository still allows only rebase merges and the "Protect Main" ruleset is active.
