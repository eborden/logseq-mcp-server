# Cap the mutation job's cache-miss set by an estimated mutant budget

## Context

[ADR-0027 (cap-mutation-cache-miss-set)](0027-cap-mutation-cache-miss-set.md) capped the cache-miss `mutation` job by a count of files: past `MAX_BASELINE_FILES` changed baseline entries, none of them were mutated. It left two sets uncapped, the changed sources and the files the changed tests import. Files differ a lot in size, so a count bounds the run only for the baseline entries. A PR that changes a few large sources, or tests that import them, can still pass the 10-minute timeout of [ADR-0026 (mutation-testing-ratchet)](0026-mutation-testing-ratchet.md). #231 measured the sizes on the CI runner and the maintainer asked for the limit to be closed (#239).

## Decision

**The whole cache-miss set is bounded by an estimated mutant count, `MUTANT_BUDGET` in `scripts/mutation-ci.ts`.** This replaces ADR-0027's cap, and `MAX_BASELINE_FILES` is removed.

- **Priority.** The plan lists the files in three groups: the changed sources, then the files the changed tests import, then the changed baseline entries. Each group is sorted by path and a file counts once, in the highest group that names it. The run takes files from the front of that list while their estimated mutants fit the budget. The first file that doesn't fit ends the set, so what is mutated is a prefix of the priority order. A PR that fits is mutated as before.
- **The estimate.** The plan reads per-file mutant counts from the incremental file the job restored (`stryker-incremental.json`). On a cache miss its results are not reused, since the targeted step deletes it, but its counts size the run. So the plan step reads it first, and the workflow keeps that order. A file with no count (no cache restored, or a file added since) is sized at `FALLBACK_MUTANTS`, the largest file #231 measured, so an unknown file can't make the estimate low.
- **The constants.** `MUTANT_BUDGET` keeps the time spare that ADR-0027's cap of 3 files left in its worst case, now for any mix of files. It is the timeout less the job's overhead and the targeted run's dry run, less that spare, at the slowest per-mutant rate #231 measured. The arithmetic and the measurements are in the comment on the constant, which is where a retune is made.
- **What is left out is named, never silent.** Every file that didn't fit goes to `leftToWeekly`, with its group. The job summary says how many files did not fit, lists them by group, and says which files were sized by the fallback. The ratchet's `::warning` annotation and summary line count them by group and tell the author to run `mutation-weekly.yml` on the PR's head commit before merging. As in ADR-0027, the warning never fails the job, and an empty set is `empty`, not a pass.
- **A changed source can now go unchecked on its own PR.** That is weaker than ADR-0027, which always mutated changed sources, and it is the cost of a bound on the run. The weekly full run still covers the file. Failing loudly instead was raised on #239 and is a change to this ADR.

Everything else in ADR-0027 stands: one base commit per job, the audit-claim correction, and the weekly run as the backstop. ADR-0026 stays as written apart from what ADR-0027 already replaced.

## Consequences

- No cache-miss PR run is estimated past the budget, whatever it changes. A re-baseline still runs in minutes and now mutates the files that fit, not none.
- With no cache restored every file takes the fallback, so a PR gets as many files as fit that size (two at the time of writing). A new large file is sized the same way, so an under-count is not the risk.
- The counts come from `main`'s results. A PR that grows a file by much can run over its estimate, and the spare time is what absorbs it.
- A PR whose changed sources pass the budget is green with the files after the cut unchecked until the weekly run, which is advice, not a gate.
- The constants are estimates from five cold runs. Retuning `MUTANT_BUDGET` or `FALLBACK_MUTANTS` after a new measurement is a code change and doesn't contradict this ADR.

## Status

proposed

Date: 2026-10-07

## Mechanical enforcement

- test: `src/mutation-ci.test.ts` (the budget boundary, the priority order, the prefix rule, the fallback for a file with no count, the counts read from a Stryker-shaped incremental file, the summary text, and the workflow order: restore, then plan, then the step that deletes the file, and the one `BASE_SHA` shared by the plan and the ratchet)
- test: `src/mutation-ratchet.test.ts` (the warning and summary line for files left to the weekly run, by group)
- ci: `.github/workflows/ci.yml` (the `mutation` job)
