# Plan the mutation cache-miss run from the PR's own diff, and ask for a weekly run only for a left-out changed source

## Context

[ADR-0028 (cap-mutation-cache-miss-set-by-mutant-budget)](0028-cap-mutation-cache-miss-set-by-mutant-budget.md) caps the cache-miss `mutation` job by `MUTANT_BUDGET`, fails a changed source it left out until a weekly run covers it, and leaves a left-out test import or baseline entry as a `::warning`. It also tells the author, in the annotation and the summary, to run `mutation-weekly.yml` on the PR's head commit before merging, and CLAUDE.md ("Verification before merge") made that a step for every warning.

In practice the weekly run became a step of almost every PR. Four PRs in a row (#266, #270, #271 and #274, each of one source file, one new test file, or eight baseline raises) all took the cache-miss path and overflowed the budget, and each needed a 20 to 30 minute weekly run before merge. The maintainer's view on #277 is that the weekly run is a weekly run, not an every-PR run. The cause, from those jobs' plans (aggregates only):

- The restored incremental file was 14 to 18 commits behind `main`. A blind-spot change on `main` (a child-process helper under `src/`) was the first push after it, so that push took the cache-miss path and could not save, and so did every push after it. Every PR then restored the same old file through `restore-keys`.
- The plan diffed against the commit the cache was saved from, so every source and test that `main` changed since went into the PR's own set. A PR that changed one source or one test file was planned for 6 to 9 files and 898 to 1,265 estimated mutants, and left 1 to 6 files over the 1,280 budget.
- A new test file that imports eight modules also put all eight in the set, though a new test can only kill more mutants, never fewer.

ADR-0026 says the cache-miss set is the files the PR changed. ADR-0028 doesn't say against what. This ADR does, and narrows when a weekly run is needed before merge.

## Decision

This ADR replaces ADR-0028's plan inputs and its advice to the author, and ADR-0028 is marked superseded by it, as ADR-0027 was by ADR-0028. Everything else in ADR-0028 stands: the budget, the three groups, first-fit order, the fallback size, the constants and the rule that a left-out changed source fails the ratchet until a weekly run on the head commit has succeeded.

- **The files come from the PR's own diff.** The long diff, against the commit the restored cache was saved from, still decides whether the cache can be trusted (a blind-spot input among its changes sends the job down the cache-miss path). The files to mutate (changed sources, the imports of changed tests, changed baseline entries, deleted tests read from the old commit) come from the diff against the PR base, the commit `BASE_SHA` names. What `main` changed since the cache was saved was checked on its own PR. With no usable PR base, or a cache saved from the base itself, the two diffs are one.
- **A test file the PR adds does not pick files by its imports.** A new test can only add kills, so it can't lower a score. A test the PR edits or deletes still does. A baseline entry that the new test raises is still in the set, so the raise is checked. The job summary names the added tests.
- **A weekly run before merge is asked for only when a changed source was left out.** The `::warning` annotation and the ratchet's summary line say "run it on the head commit before merging" only when a changed source is among the files left over, which is the case that fails the job. For a test import or a baseline entry left over they say that the scheduled weekly run covers it and no run is needed. CLAUDE.md ("Verification before merge") says the same. The job still fails on a changed source until a weekly run on the head commit has succeeded.

## Consequences

- Replaying the plans of #266, #270, #271 and #274 through the new plan leaves 0 files over the budget in all four (from 1, 2, 4 and 6), with 46, 513, 1,166 and 1,166 estimated mutants. None needs a weekly run.
- Until a weekly run resets the cache, a PR still takes the cache-miss path (the blind-spot change is still between the cache and `HEAD`). It now mutates its own files only, which is the smaller and faster run.
- A test import or baseline entry that is left over is unchecked until the scheduled weekly run (Mondays), and a score that fell is found after the merge. That was already so for a PR whose author skipped the run. A changed source can't be left unchecked: it still fails.
- A PR that edits a large test still pulls its imports into the set and can leave some of them over the budget. They are a warning, not a gate.
- The saved cache is still not advanced by a push to `main` that takes the cache-miss path. After a blind-spot change lands, it waits for the weekly run (or a by-hand run on `main`). This ADR doesn't change that.

## Status

proposed

Date: 2026-10-07

## Mechanical enforcement

- test: `src/mutation-ci.test.ts` (the files come from the diff against the PR base while a blind spot comes from the long diff, a new test's imports are not mutated while an edited test's are, the raise a new test comes with is, a left-out changed source is still in `leftToWeeklyByGroup`, and the summary asks for a weekly run before merging only for a changed source)
- test: `src/mutation-ratchet.test.ts` (the annotation and summary line ask for a weekly run before merging only when a changed source is among the files left over)
- ci: `.github/workflows/ci.yml` (the `mutation` job)
