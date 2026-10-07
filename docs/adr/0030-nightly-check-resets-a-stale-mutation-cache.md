# Reset a stale mutation cache with a nightly check that dispatches at most one weekly run a night

## Context

[ADR-0029 (mutation-cache-miss-plan-uses-the-prs-own-diff)](0029-mutation-cache-miss-plan-uses-the-prs-own-diff.md) leaves cache saving as it was: only a push to `main` on the incremental path, or a weekly run on `main`, saves the incremental file. After a blind-spot change lands on `main` (for example a new non-TypeScript file under `src/`, as with #249), every push takes the cache-miss path and can't save, and every PR plans against the old cache until the Monday weekly run. Left-over test imports and baseline entries go unchecked for up to a week (ADR-0029, Consequences).

A per-push trigger (dispatch a weekly run from the push that finds the cache stale) would reset it soonest, but every push after the blind-spot change finds the same stale cache, so it could start one 20 to 40 minute run per push. The maintainer asked on #279 (2026-10-07) how to keep that from "running tons of those jobs" and chose a nightly check.

## Decision

We add `.github/workflows/mutation-nightly.yml`, which runs once a day (05:47 UTC, after the Monday weekly run starts) and dispatches `mutation-weekly.yml` on `main` only when the cache is stale. ADR-0029 stands as written: this adds a way to reset the cache and changes nothing in the plan, the budget or the ratchet.

- **Stale means the next push can't save.** The newest saved `mutation-incremental-*` cache on `main` (the one a PR's `restore-keys` falls back to) is stale when none is saved, when its commit is not in `main`'s history, or when `main` differs from its commit in a blind-spot input. That is the tree diff the PR plan reads (`git diff --name-only --no-renames <cache> HEAD`), so a blind-spot change that `main` reverted since leaves the cache current, as it does for the plan. The classification is `isBlindSpot` in `scripts/mutation-ci.ts`, the same one the PR plan uses, so there is one file list. The decision is `nightlyDecision` there, a pure function.
- **A ceiling set by `RECENT_RUN_HOURS`.** Even with a stale cache, nothing is dispatched while a `mutation-weekly.yml` run on `main` is queued or in progress, or when one started in the last 20 hours (`RECENT_RUN_HOURS`). The scheduled check runs every 24 hours, so on the schedule alone that is at most one dispatched run a night, and a failed reset is retried the next night. The real bound is one dispatched run per 20 hours: the check can also be started by hand, and a by-hand run 20 hours after the last weekly run can dispatch, so two runs can land on one calendar day. A `concurrency` group queues a second check behind a running one, but it is not a hard guarantee against a double dispatch: `gh workflow run` returns before the new run is listed, so a check that starts right after another dispatched may not see that run yet.
- **Fail closed.** A caches or runs response without its `actions_caches` or `workflow_runs` array throws, so the check job fails and nothing is dispatched. Read as empty, it would lift the ceiling on every night the fault recurred.
- **Least privilege.** The check job has `contents: read` and `actions: read` (the caches and runs APIs). Only the dispatch job writes, with `actions: write` and nothing else, and its one command is `gh workflow run mutation-weekly.yml --ref main`.

## Consequences

- Most nights the cache is current and nothing runs. After a blind-spot change, the cache is reset by the next night's run instead of the next Monday's, so PRs take the cache-miss path for about a day.
- At most one extra full run (20 to 40 minutes of runner time) per 20 hours, and only after a blind-spot change or a failed reset. A Sunday reset and the Monday weekly run can both happen within a day, and so can a by-hand check and a scheduled one.
- Any `mutation-weekly.yml` run on `main` in the last 20 hours holds the check back, including a by-hand run on a PR's commit, which is dispatched from `main` and listed under it. The reset then waits a night. We accept that, since it errs towards fewer runs.
- A run with no readable start time counts as recent, for the same reason.
- The check reads the cache list through the Actions API, so the decision depends on GitHub's cache retention: a cache evicted for disuse reads as none saved, and the check dispatches a run to save one.

## Status

proposed

Date: 2026-10-07

## Mechanical enforcement

- test: `src/mutation-ci.test.ts` (`nightlyDecision`: a current cache gives no dispatch, a stale one does, an in-flight or recent run gives none; and the workflow tests pin `.github/workflows/mutation-nightly.yml`'s schedule, permissions and dispatch target)
- ci: `.github/workflows/mutation-nightly.yml`
