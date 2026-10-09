# Merge the Rust cutover into main with one merge commit, as a one-time exception to ADR-0021

## Context

[ADR-0021 (rebase-merge-to-main)](0021-rebase-merge-to-main.md) says PRs merge by rebase so each atomic commit lands on `main` as written, and GitHub holds that: `allow_rebase_merge` is on, `allow_merge_commit` and `allow_squash_merge` are off, and the "Protect Main" ruleset (id 24517935) has `deletion`, `non_fast_forward` and `required_linear_history` with no bypass actors.

The cutover (#354) brings `feature/rust-spike` into `main`. Its issue says to use "the method ADR-0021 allows. Check whether a merge commit is needed and ask the maintainer." Measured on 2026-10-09:

- `origin/main` is 840e97f. It is one commit past the merge base 87720b4: a README-only change (#417).
- `origin/feature/rust-spike` is 87b471e, 535 commits past the base: 479 non-merge commits and 56 merge commits.
- A simulated rebase stopped at replay commit 147 of 479, with conflicts in `rust/README.md` and `rust/src/server.rs`. It stopped again at a modify/delete conflict on the commit that deleted `scripts/parity`. Those are conflicts the branch already resolved, in its own merge commits, which a rebase drops.
- A rebase-merge would drop the 56 merge commits and the conflict resolutions in them, and rewrite 479 commit ids. Reviews, PR descriptions, ADRs and issues cite those ids.
- A merge of the two tips has one conflict, in `README.md`, where `main`'s one commit and the branch's rewrite of the same file meet.

The maintainer was asked on 2026-10-09 how to merge and said "Go with your gut". That settles the method, not this record: an ADR needs the maintainer's explicit approval before merge (CLAUDE.md, "ADRs and business rules"), and ADR-0021 is accepted and immutable apart from status and enforcement. So the exception gets its own ADR instead of a reworded ADR-0021.

ADR-0021 is not superseded. It is right for every ordinary PR: small, atomic, reviewed commits that replay cleanly. This is not an ordinary PR. It is one merge of a long-lived branch whose history is itself the record of a port, and it happens once.

## Decision

We merge `feature/rust-spike` into `main` with a single merge commit, for this cutover only.

1. **Prepare the branch.** Before the cutover, `origin/main` is merged into `feature/rust-spike` with a plain `git merge`, as the branch's 56 earlier merge commits were. The `README.md` conflict is resolved there, where it is reviewed. The cutover merge then has no conflict, and its tree is exactly the reviewed tip of `feature/rust-spike`.
2. **Change two settings, for the merge only.** The maintainer sets `allow_merge_commit` on in the repository settings and turns `required_linear_history` off in ruleset 24517935. `allow_squash_merge`, `deletion` and `non_fast_forward` stay as they are. The maintainer does this, never a session: sessions don't touch repository settings or rulesets, and don't run `gh api` PATCH or PUT calls.
3. **Merge.** The maintainer merges the cutover PR (`feature/rust-spike` into `main`) with "Create a merge commit". No other PR merges while the settings are relaxed, so the exception cannot be used by accident.
4. **Restore immediately.** Straight after the merge the maintainer sets `allow_merge_commit` off and `required_linear_history` on, then reads both back (`gh api repos/eborden/logseq-mcp-server` and `gh api repos/eborden/logseq-mcp-server/rulesets/24517935`) to confirm the settings in ADR-0021's Mechanical enforcement hold again.
5. **Scope.** This exception covers that one merge. Every later PR merges by rebase, under ADR-0021 as written. A second long-lived branch needs its own ADR.

The usual gates still apply to the cutover PR: CI green, a reviewer-subagent review on the head commit with no unresolved thread, the CLAUDE.md verification list, and the maintainer's explicit OK to merge.

## Consequences

- The 479 atomic commits, the 56 merge commits with their conflict resolutions, and every commit id cited so far reach `main` unchanged. Nothing is replayed, so no conflict is resolved a second time by hand without review.
- `main` is non-linear at that one merge. The commits of `feature/rust-spike` are reachable through the merge commit's second parent. `git log --first-parent main` shows the cutover as one entry; plain `git log` shows the whole port.
- `git bisect` still works and still lands on one atomic commit, since the branch's commits are atomic. A bisect that crosses the cutover walks the branch's own 535 commits, merges included, and may stop on a merge commit whose first-parent diff is large. `git bisect --first-parent` treats the cutover as one step, which is the right first pass.
- `git blame` keeps the original authors and messages, which a squash would replace.
- To undo the cutover, `git revert -m 1 <merge-commit>` makes a commit that restores the tree `main` had before the merge, with `main` as parent 1. Merging `feature/rust-spike` again afterwards first needs that revert reverted, or git treats the branch's commits as already merged and brings nothing. Revert on `main`, never rewrite it: `non_fast_forward` forbids the force-push anyway.
- ADR-0021's Context says "Nothing in the repository stops a merge commit", and its Mechanical enforcement says `main` cannot be given a merge commit. Both describe the rule and the settings, and both are true again once step 4 is done. This ADR doesn't edit them.
- For the length of steps 2 to 4 the platform doesn't enforce ADR-0021. The cost is the maintainer's attention for that window, plus the rule that nothing else merges during it.

Alternatives considered:

- **Squash** into one commit. The settings change is the same size as a merge commit's, and it needs one set of conflict resolutions instead of 535 commits'. It loses the 479 atomic commits and breaks `blame` and `bisect` across the whole port, which is the opposite of ADR-0021's aim, so we rejected it.
- **A hand-linearized rebase** onto `main`. It keeps a linear history and needs no settings change. The replay fails at commit 147 and again at a modify/delete conflict, drops the 56 merge commits and their resolutions, rewrites 479 ids, and has every conflict resolved by hand with nobody reviewing the result at the size of the diff. We rejected it for the risk it adds to a change this large.
- **A cherry-pick series.** Same replay conflicts as the rebase, plus an order someone has to choose, and the same lost merges and rewritten ids. We rejected it for the same reasons.

## Status

proposed

Date: 2026-10-09

## Mechanical enforcement

Nothing in the repository can enforce a one-time change to repository settings, because the settings are configuration on GitHub, not files, and the window is minutes long.

- reviewer: Before the cutover merge, the reviewer checks that the cutover PR's tree equals the head of `feature/rust-spike` after `origin/main` was merged into it, and that no other PR is open for merge. After it, the maintainer reads back `allow_merge_commit` off, `allow_squash_merge` off, `allow_rebase_merge` on and ruleset 24517935 with `required_linear_history`, `deletion` and `non_fast_forward` and no bypass actors, and says so on the PR. A later PR that touches merge policy checks those settings again, as ADR-0021 requires.

A guard that reads the repository settings and the ruleset after the restore, and fails when `allow_merge_commit` is on or `required_linear_history` is missing, is a candidate follow-up. It needs a token that can read rulesets, which CI doesn't have today, so it isn't filed as a commitment here.
