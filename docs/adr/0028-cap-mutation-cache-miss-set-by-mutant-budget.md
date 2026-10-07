# Cap the mutation job's cache-miss set by an estimated mutant budget

## Context

[ADR-0027 (cap-mutation-cache-miss-set)](0027-cap-mutation-cache-miss-set.md) capped the cache-miss `mutation` job by a count of files: past `MAX_BASELINE_FILES` changed baseline entries, none of them were mutated. It left two sets uncapped, the changed sources and the files the changed tests import. Files differ a lot in size, so a count bounds the run only for the baseline entries. A PR that changes a few large sources, or tests that import them, can still pass the 10-minute timeout of [ADR-0026 (mutation-testing-ratchet)](0026-mutation-testing-ratchet.md). #231 measured the sizes on the CI runner and the maintainer asked for the limit to be closed (#239).

## Decision

**The whole cache-miss set is bounded by an estimated mutant count, `MUTANT_BUDGET` in `scripts/mutation-ci.ts`.** This replaces ADR-0027's cap, and `MAX_BASELINE_FILES` is removed.

- **Priority.** The plan lists the files in three groups: the changed sources, then the files the changed tests import, then the changed baseline entries. Each group is sorted by path and a file counts once, in the highest group that names it. The run walks that list and takes each file whose estimated mutants still fit the budget (first-fit). A file that doesn't fit is skipped and the walk goes on, so a smaller file after it can still be taken, and a higher group always has the first claim. A PR that fits is mutated as before.
- **The estimate.** The plan reads per-file mutant counts from the incremental file the job restored (`stryker-incremental.json`). On a cache miss its results are not reused, since the targeted step deletes it, but its counts size the run. So the plan step reads it first, and the workflow keeps that order. A file with no count (no cache restored, or a file added since) is sized at `FALLBACK_MUTANTS`, the largest file #231 measured, so an unknown file can't make the estimate low.
- **The constants.** `MUTANT_BUDGET` keeps the time spare that ADR-0027's cap of 3 files left in its worst case, now for any mix of files. It is the timeout less the job's overhead and the targeted run's dry run, less that spare, at the slowest per-mutant rate #231 measured. The arithmetic and the measurements are in the comment on the constant, which is where a retune is made.
- **What is left out is named, never silent.** Every file that didn't fit goes to `leftToWeekly`, with its group. The job summary says how many files did not fit, lists them by group, and says which files were sized by the fallback. The ratchet's `::warning` annotation and summary line count them by group and tell the author to run `mutation-weekly.yml` on the PR's head commit before merging. An empty set is `empty`, not a pass.
- **A changed source left out fails the ratchet.** A changed source that no mutation run checked on its own PR would pass unchecked, so the ratchet fails it unless a successful `mutation-weekly.yml` run has checked the PR's head commit. The proof is the report artifact the weekly job uploads, named `mutation-report-` and the commit it checked out (`git rev-parse HEAD` after its checkout of the `ref` input). A run's `head_sha` and title can't be the proof: `head_sha` is the branch a run was started from, and a title can hold any text, while the artifact name is built from what was mutated. The ratchet asks the Actions API for artifacts of exactly that name, needs one that has not expired, and reads the run that uploaded it, which must be a successful run of `mutation-weekly.yml` (an artifact doesn't say which workflow made it). The job needs `actions: read` besides its `contents: read`, and nothing else. With no such run the failure names the files and says to run `mutation-weekly.yml` on the head SHA and then re-run the job, which turns green once that run has succeeded. When the only artifact has expired, it says so. A look-up that fails is a failure too, and the gate applies on a pull request only (a push to main keeps the warning). A file imported by a changed test, or a baseline entry, that is left out stays the warning and doesn't fail the job, so a re-baseline goes green. Before merge the merger runs the weekly workflow on the head commit (CLAUDE.md, "Verification before merge").

Everything else in ADR-0027 stands: one base commit per job, the audit-claim correction, and the weekly run as the backstop. ADR-0026 stays as written apart from what ADR-0027 already replaced.

## Consequences

- No cache-miss PR run is estimated past the budget, whatever it changes. A re-baseline still runs in minutes and now mutates the files that fit, not none.
- With no cache restored every file takes the fallback, so a PR gets as many files as fit that size (two at the time of writing). A new large file is sized the same way, so an under-count is not the risk.
- The counts come from `main`'s results. A PR that grows a file by much can run over its estimate, and the spare time is what absorbs it.
- A PR whose changed sources pass the budget is red until someone has run the weekly workflow on its head commit, which can take as long as a full run (about 20 to 30 minutes). That is the price of never leaving a changed source unchecked, and a re-run of the mutation job after it clears the check. A left-out test import or baseline entry is still advice, not a gate: green with the files unchecked until the weekly run.
- The gate depends on the weekly job's artifact: its name `mutation-report-<sha>` and its retention (`WEEKLY_ARTIFACT_RETENTION_DAYS`). A PR that outlives that retention after its weekly run has to repeat the run, and the failure says so. A weekly run for a head commit must have been started with the full SHA in `ref`, or from the PR's branch with it empty.
- The constants are estimates from five cold runs. Retuning `MUTANT_BUDGET` or `FALLBACK_MUTANTS` after a new measurement is a code change and doesn't contradict this ADR.

## Status

proposed

Date: 2026-10-07

## Mechanical enforcement

- test: `src/mutation-ci.test.ts` (the budget boundary, the priority order, first-fit, the fallback for a file with no count, the counts read from a Stryker-shaped incremental file, the summary text, and the workflow order: restore, then plan, then the step that deletes the file, and the one `BASE_SHA` shared by the plan and the ratchet)
- test: `src/mutation-ratchet.test.ts` (the warning and summary line for files left to the weekly run, by group, and the changed-source gate: no artifact, a run started from the PR branch with another ref, a ref that only contains the SHA, an expired artifact, an artifact from another workflow, a failed run, a successful run on the head, a failed look-up, and only baseline or test-import left-outs)
- ci: `.github/workflows/ci.yml` (the `mutation` job and its `actions: read`)
- ci: `.github/workflows/mutation-weekly.yml` (the report artifact `mutation-report-<sha>`, named from the checked-out commit, and its retention, which the gate relies on; `src/mutation-ci.test.ts` pins both)
