# Cap the mutation job's cache-miss set and correct its audit claim

## Context

[ADR-0026 (mutation-testing-ratchet)](0026-mutation-testing-ratchet.md) is still the decision for mutation testing, the baseline and the ratchet. Two of its statements no longer match the `mutation` job. This ADR replaces them and leaves the rest of ADR-0026 in force. It was raised in #228, after #223 (PR #226) found the first statement could not hold.

1. **The cache-miss set.** ADR-0026 says a cache-miss run mutates every source file whose entry changed in `mutation-baseline.json`, and that it "never starts a cold full run on a PR". A re-baseline PR (a Stryker upgrade changes every entry, as does the first baseline) changes all of them, so the two promises clash: mutating every entry is a cold full run of 30 to 60 minutes in a job with a 10-minute timeout.
2. **The audit claim.** ADR-0026's vetting table says the added packages bring no new `npm audit` finding. They bring one: the dev-only `typed-rest-client` finding, which takes the count from 19 to 20. The maintainer accepted it on #210. It is a `devDependency` that is never shipped and, as the table already says, its HTTP client runs only in Stryker's `init` wizard and its optional dashboard reporter, neither of which `stryker run` uses with our reporters.

## Decision

**The cache-miss set is capped.** Past a small cap, `MAX_BASELINE_FILES` in `scripts/mutation-ci.ts` (8 when this was written), changed baseline entries are not mutated by a cache-miss PR run. It still mutates the changed source files plus the source files imported by changed tests, as before. Those two sets are not capped, as under ADR-0026. With `MAX_BASELINE_FILES` or fewer changed entries, the run behaves as ADR-0026 says: every changed entry is mutated. So ADR-0026's "plus every source file whose entry changed in `mutation-baseline.json`" becomes "plus those entries, when no more than `MAX_BASELINE_FILES` changed". The point is that a re-baseline no longer starts a cold full run. The value is a constant chosen as an estimate, from a cold file taking about 1 to 1.5 minutes on a loaded laptop, and it is to be checked against a measured cold run on a CI runner (#231 tracks the measurement and the retune).

- **The entries it left out are named, never silent.** The plan records them (`leftToWeekly`: changed entries in scope that still exist and that no changed source or test brought in anyway). The job summary says how many entries changed, that this run did not mutate the listed files, and lists them. The ratchet also emits a `::warning title=Mutation testing::` annotation, so a green check doesn't hide it, and a line in its own summary section. The text tells the author to run `mutation-weekly.yml` by hand on the PR's head commit (the SHA in "ref") before merging.
- **They wait for the weekly full run.** That run, which ADR-0026 already defines as the backstop, checks them against the baseline. The warning never fails the job, so a re-baseline PR goes green with its files unchecked until someone runs the weekly job. The advice to run it first is not enforced.
- **Nothing left to mutate is not a pass.** When the cap leaves an empty set, the mode is `empty` and the summary says nothing was checked. The ratchet still runs its base comparison (the `mutation-baseline-change` label check). It expects only the planned files in a targeted run, so the files left out are not "missing rows".

**One base commit per job.** The `mutation` job resolves `BASE_SHA` once: `HEAD^1` on a pull request (the base tip the checked-out merge commit was built on, so it holds when `main` moves after the PR event) and the event's `before` commit on a push. The plan reads the base's baseline at it. On a pull request the ratchet takes it as `--base`, a commit used as given, with no merge-base lookup, so the two can no longer disagree about what the PR changed. On a push the ratchet gets no `--base` and makes no base comparison, so the `before` commit feeds the plan only.

**The audit claim is corrected.** Stryker adds one `npm audit` finding, the dev-only `typed-rest-client` one, accepted on #210. Every other row of ADR-0026's vetting table stands.

Everything else in ADR-0026 stays as written: scope, tools, the baseline format and its rules, the blind-spot inputs, flakiness handling, pruning and the relationship to other rules.

## Consequences

- A re-baseline or first-baseline PR runs in minutes instead of failing its timeout, and still says which entries it did not check.
- The check for those entries moves from the PR to a manual run of the weekly job. If nobody runs it, a lowered score in one of them is found by the next scheduled weekly run, after the merge. The warning and the summary are the only prompt.
- A PR that changes just over the cap in baseline entries by hand, not as a re-baseline, is capped the same way. That is rare, and its files are named.
- The constant is an estimate, not a measured fit, and the ADR is worded around the constant, not its value. Retuning `MAX_BASELINE_FILES` after a measured cold run on a runner is a code change and doesn't contradict this ADR.
- ADR-0026 keeps its original statements, with its status line pointing here. A reader needs both documents.

## Status

accepted

Date: 2026-10-06

## Mechanical enforcement

- test: `src/mutation-ci.test.ts` (the cap boundary, the entries left out, the summary text and the one `BASE_SHA` shared by the plan and the ratchet)
- ci: `.github/workflows/ci.yml` (the `mutation` job)
