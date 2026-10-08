# Ratchet per-file mutation scores on the Rust crate with cargo-mutants

## Context

[ADR-0026 (mutation-testing-ratchet)](0026-mutation-testing-ratchet.md) ratchets per-file mutation scores on the TypeScript unit suite with Stryker, and [ADR-0027 (cap-mutation-cache-miss-set)](0027-cap-mutation-cache-miss-set.md) to [ADR-0030 (nightly-check-resets-a-stale-mutation-cache)](0030-nightly-check-resets-a-stale-mutation-cache.md) tuned its CI job: a cap on the cache-miss set, then a mutant budget, then a plan taken from the PR's own diff, then a nightly reset of a stale cache. The Rust crate (`rust/`, [ADR-0025 (rust-implementation-alongside-typescript)](0025-rust-implementation-alongside-typescript.md)) has no mutation testing. #349 decided Go on 2026-10-08, so Rust becomes the only server on `feature/rust-spike` and #356 retires the TypeScript server and the Stryker job with it. The Rust port's safety net is its tests (unit tests, the parity cases, and the integration suite run against it on the fixture instance, #352), and nothing measures how strong they are. Proposed in #351. The issue's other option, relying on the parity cases and unit tests alone, costs nothing and measures nothing.

**Nothing in this ADR was run locally.** The maintainer's rule is no heavy local CPU, so there is no spike like ADR-0026's. The numbers below come from the tool's documentation, crates.io, and the CI step timings of the Rust job on 2026-10-08 (warm cache: debug build about 7 s, `cargo test` about 13 s). Every constant is set from a CI measurement in #364, and a measurement that contradicts an assumption here stops that work (foundations section 0).

### Dependency vetting (foundations 4.10)

Checked on 2026-10-08 against the crates.io and GitHub APIs and the tool's documentation at mutants.rs.

| Check | `cargo-mutants` 27.1.0 |
|---|---|
| Maintenance | One owner (sourcefrog, the project's author), first published 2021-10, 7 releases in the last 12 months, latest 2026-06-02, about 306k recent downloads, 1,326 GitHub stars, repository pushed 2026-10-01, not archived, no release yanked |
| Licence | MIT. It is a build tool installed in CI. It is not in `Cargo.toml` or `Cargo.lock`, is not linked into the server and is never shipped, so it doesn't touch the licence of the binary ([ADR-0023 (mit-license)](0023-mit-license.md)) |
| Compatibility | Declares `rust-version` 1.88, which is the toolchain `rust/rust-toolchain.toml` pins |
| Size | 49 declared dependencies (40 normal), all in the tool's own tree |
| Install scripts, network use | Not checked. The first task (#364) repeats the checks on the tool's lockfile and install path and records them, as ADR-0026's tooling PR did |

Caveat: that is metadata and documentation, not an audit of the tool's code. Installing a prebuilt binary through a third-party action would be a second dependency to vet. #364 pins whatever it installs by exact version, or by commit SHA for an action.

### How cargo-mutants differs from Stryker

These facts decide what carries over from ADR-0026 to ADR-0030. The first four are from the tool's documentation.

- **It mutates function bodies and operators, not literals.** It replaces a function's body with a guessed value, swaps binary operators, deletes unary operators, deletes match arms (when a wildcard arm exists), sets match guards to `true` and `false`, and deletes struct-literal fields that have a base expression. It doesn't mutate string literals or constants. The 301 string-literal survivors that ADR-0026 had to reason about, the `StringLiteral` mutator and `ignoreStatic` have no counterpart.
- **An outcome is caught, missed, unviable (it doesn't compile) or timeout.** There is no "no coverage" status: uncovered code is a missed mutant. Exit code 2 means some mutant was missed and 3 means a timeout. Neither is a broken run. 4 means the unmutated tests already fail, 5 and 6 mean `--in-diff` was given a diff that doesn't match the tree or isn't one, and 70 is an internal error.
- **It has no incremental file.** `--iterate` skips mutants caught in an earlier run, and its documentation calls it "a heuristic" that assumes new changes won't reduce coverage. A gate can't rest on that, since a deleted or weakened test is exactly what a ratchet is for. So there is no results cache, which removes the blind-spot inputs, the cache keys and the restore and save rules of ADR-0026 and ADR-0028, and the stale-cache problem that ADR-0029 and ADR-0030 worked around.
- **`--in-diff <diff>` mutates only what overlaps the diff's changed lines in source under test**, and a diff that only touches tests generates nothing. Its documentation warns that an edit in one place can leave another place or file poorly tested.
- **Each mutant costs a rebuild and a test run**, where Stryker's `perTest` coverage runs a few tests per mutant in one process. By the step timings above a mutant is on the order of 20 s, and the crate has about 1,300 `fn` items with their tests, so a cold run over the whole crate is thousands of mutants: hours, likely past one job's 6-hour limit. That is an estimate. A PR job of 20 minutes holds on the order of a hundred mutants at `--jobs 2`. This is the main reason the PR job below works on the PR's changed code and not on whole files.
- **`--jobs` is a different knob from Stryker's `concurrency`.** Each job has its own target directory, `cargo build` and `cargo test` already use many threads, and the documentation advises starting at 2 or 3 and warns that a non-hermetic suite flakes under parallelism. Several of the crate's integration tests bind a local port for a stub LogSeq.

## Decision

We adopt mutation testing on the Rust crate with `cargo-mutants`, and a per-file ratchet in CI. It is introduced in two steps, as ADR-0026 did: an informational job first, then a committed baseline and enforcement (both in #364), with a three-run flakiness experiment in between.

**Tool and scope.**
- `cargo-mutants` 27.1.0, installed in CI only, pinned to an exact version. An upgrade can change the mutator set and so every score, so it is its own PR and it re-baselines.
- Its configuration is `rust/.cargo/mutants.toml`. The mutated scope is every file under `rust/src` that has mutants, with no exclusions to start. ADR-0026 left out type declarations, schema declarations, wiring and text constants because Stryker mutated them as noise. `cargo-mutants` doesn't mutate any of those. Adding an exclusion, or editing the `exclude_re` list or the scope later, is treated like lowering a score (below).
- The tests are whatever `cargo test --locked` runs on the debug profile, which is also the only profile where the test clock `LOGSEQ_MCP_NOW` works. The TypeScript parity harness is not part of a mutant's run: it needs Node and a build outside cargo, and #356 turns the recorded parity results into golden tests that `cargo test` then runs. Tests that scan source text or check a policy, not behaviour, may be skipped with `additional_cargo_test_args`, by the same test as ADR-0026: only if measurement shows they cost time or flake, and each one is named in the config.
- The score is caught and timed-out mutants over caught, timed-out and missed ones. Unviable mutants count for nothing, and ignored ones are out of both numerator and denominator. A timeout counts as caught, as in ADR-0026 (`cargo-mutants` times a mutant out at 5 times the baseline test time, 20 s at least).

**Baseline.**
- `rust/mutation-baseline.json`, a separate file from the TypeScript `mutation-baseline.json`, so both ratchets coexist and #356 can delete the old one without touching this one. It holds the tool version and, per file, `"rust/src/x.rs": { "score": 91.3, "ignores": 2 }`, one line per file in sorted order.
- Carried over from ADR-0026 unchanged: the score is rounded down to one decimal; raising is by hand from the full run's report (or the lower of two runs) and never from CI; lowering is a decision that needs the `mutation-baseline-change` label and the maintainer's OK, as does an edit to the scope or the ignore list; a baseline entry with no row in the report, and a file with mutants and no entry, both fail; a new file must reach 80% and gets its entry in the same PR; an `Ignored` mutant needs a written reason and raises `ignores`.
- **Ignores are `exclude_re` entries in `rust/.cargo/mutants.toml`, each preceded by a `# reason:` comment.** `ignores` is the number of mutants the entries remove from the file, found by listing mutants with and without them (`--list` parses the source and builds nothing). An entry that matches no mutant, as after a rename, fails the check, and a file whose mutants reappear fails by score, so a stale ignore is loud. The in-source `#[mutants::skip]` attribute is easier to see at the site, which the tool's documentation prefers, but as far as we know it needs a small crate in the shipped crate's dependencies. #364 confirms that, and adding it is a separate vetting and decision.

**Where it runs.**
- **Quiet by construction.** One CI job, never a shard matrix. `--jobs` at most 2 (`MUTANT_JOBS`, set from the first measurement, 1 if load makes timeouts). A superseded PR run is cancelled. There is no push trigger, because there is no cache to save and a PR run already tests the merge with its base. Nobody runs `cargo mutants` on a developer machine, agents included: its only local use is `--list`. A one-file score on demand is a by-hand run of the full workflow with a `files` input.
- **The PR job** is its own workflow, `.github/workflows/rust-mutation.yml`, on `pull_request` for `rust/**` and the workflow file. It is not a job in `rust.yml`, which also triggers on parity inputs that don't change a mutation score and keeps the Rust build job's concurrency and timeout apart from this one's. `timeout-minutes: 20` to start. The existing `ci.yml` and its guards are untouched.
- **The plan comes from the PR's own diff** against the PR base (ADR-0029), in three groups, each sorted by path:
  1. **Changed sources**, mutated with `--in-diff`: only the mutants overlapping the PR's changed lines. A new file is all changed lines, so it is measured whole.
  2. **Edited or deleted tests.** Rust tests have no import graph the job can read, so no test maps to the mutants it kills. These are named in the summary and left to the scheduled run, as ADR-0029 left a changed test's imports. A test the PR adds is ignored, since a new test can only add kills.
  3. **Changed baseline entries**, mutated whole with `--file`, so a raise is checked against the whole file.
- **The gate.** For group 1, the score of the mutants in the changed code must be at least the file's baseline entry, or 80% and a new entry for a new file. For group 3, the whole-file score must be at least the entry. A file below it is re-run once from a fresh directory, and the check fails only if it is still below. A plan with no mutants says so and is not a pass.
- **The budget** (ADR-0028). The plan counts mutants exactly with `cargo mutants --list` over the same selection, so there is no cached count and no `FALLBACK_MUTANTS`. `MUTANT_BUDGET` is the timeout, less the job's overhead (the install, the baseline build and test run that `cargo-mutants` always does first) and a spare, times `MUTANT_JOBS`, over the slowest seconds per mutant measured. The arithmetic lives in a comment on the constant. The run walks the groups in the order above and takes each file whose mutants still fit (first-fit). A file that doesn't fit is skipped and the walk goes on. Everything left out is named, with its group, in the job summary and an annotation.
- **A changed source left out fails the ratchet** until a by-hand run of `rust-mutation-full.yml` on the PR's head commit has measured it (ADR-0028). A left-out baseline entry or edited test is a warning only, covered by the scheduled run (ADR-0029), so a re-baseline goes green. The proof changes from ADR-0028: that run took a whole cold run's time on any commit, but here the by-hand run takes the left-out files as an input and runs them with the long timeout. Its artifact, `rust-mutation-report-<sha>`, lists the files it measured, and the ratchet accepts it only if it lists every left-out changed source. The look-up is the same API call, with `actions: read` and nothing else.

**Scheduled full runs.**
- `rust-mutation-full.yml` runs on a schedule and by hand. It mutates whole files, uploads the report and fails when a file is below its baseline. It never blocks a PR, and it is the backstop for what the PR job can't see: a deleted or weakened test, an edit that weakens another region (the `--in-diff` caveat), and a score that moved because of load.
- **Slices.** If the measured cold run doesn't fit one job, the scheduled run is split into `FULL_RUN_SLICES` slices of whole files balanced by their mutant counts, one per night, so every file is measured at least once a week. With one slice it is a weekly run. The nightly trigger exists only for that.
- **ADR-0030's nightly check does not carry over.** It resets a stale incremental cache. With no cache there is nothing to go stale and nothing to dispatch: the scheduled run is a plain cron. The `RECENT_RUN_HOURS` guard, the caches API read and the fail-closed rules have no counterpart.

**Flakiness** (carried from ADR-0026). Before the check enforces anything, the full job runs three times by hand against one commit with nothing else running. The per-file spread, in mutants and not points, sets the tolerance (strict if every file is within one mutant), and the initial baseline is the lowest of the three, rounded down. A tolerance other than strict amends this ADR, which needs the maintainer's OK. The risk to watch is specific to this tool: two mutants in flight run the crate's port-binding tests at once, and a timeout caused by load counts as caught.

**Relationship to ADR-0026 to ADR-0030.** This ADR doesn't supersede them. Superseding records a reversal, and they are not reversed: while the TypeScript server exists they bind its Stryker job, and `src/mutation-ci.test.ts` and the workflows still enforce them. [ADR-0025 (rust-implementation-alongside-typescript)](0025-rust-implementation-alongside-typescript.md) Decision 3 already says what to do with an ADR about one toolchain: it applies to that toolchain only, and the other toolchain's equivalent gets its own ADR, "a scope reading, not a supersession". This is that ADR for Rust. ADR-0026 to ADR-0028 are already superseded, so only ADR-0029 and ADR-0030 are in force. **#356 retires them**: in the PR that deletes the Stryker job and its scripts, it sets ADR-0029 and ADR-0030 to `deprecated` (status only, no rewording), and follows the README's rule for citing a file that has since been deleted wherever their enforcement lines name one. Removing enforcement needs the maintainer's OK there, as #356 already notes. This ADR is self-contained, so it reads the same whether those two end up `deprecated` or `superseded by` this one, and the maintainer may prefer the latter on #356.

## Consequences

- The Rust crate gets a number per file for how well its tests catch changes, and a list of which changes they miss, before the TypeScript ratchet goes away. CI gains a PR job of up to 20 minutes that runs beside the build job, and a scheduled run of hours.
- A PR that adds or changes Rust code must test that code at least as well as its file's baseline. It is stricter on new code than ADR-0026's whole-file ratio, and blind to the rest of the file until the scheduled run: a PR that weakens a test can merge and be caught up to a week later (or a slice cycle). ADR-0029 accepted that for tests, and this ADR accepts it for the same reason.
- The PR job doesn't compare the whole-file score, except for a changed baseline entry. A file's score can therefore fall below its entry by a merge, and the failure shows on the scheduled run, not on the PR.
- A changed source that exceeds the budget fails until a by-hand run. With the budget near a hundred mutants that could be common, which is the situation ADR-0029 described for the TypeScript job (the weekly run became a step of almost every PR). If the first measurement shows it, #364 stops and comments, and the fix is a decision, not a constant: a smaller `--in-diff` selection, or a larger job.
- The plan and ratchet are a new Cargo package, outside `rust/src` and the server's dependency tree. They can't stay TypeScript, whose tests live in `src/` and are removed by #356, and Node is in the Rust job today only for the parity harness. They add a small package to maintain and a lockfile of their own.
- There is no results cache, so a re-run recomputes what it measured before. That is the cost of a sound gate, and it also removes a class of failure (a stale or poisoned cache).
- `cargo-mutants` mutates no literals and no constants, so model-facing prose and text constants are not measured by it. The golden and parity tests are what pin them.
- The tool adds nothing to the shipped binary, and no dependency to `Cargo.toml`.
- Until #364's second PR lands there is no gate, and this ADR's enforcement is a promise.

## Status

proposed

Date: 2026-10-08

## Mechanical enforcement

- none-yet: #364 (the tool, the plan and the informational jobs, then the baseline and the gate)
- none-yet: #364 (a test of the plan and ratchet package that pins the budget, the priority order, the score formula and the exit-code handling)
- none-yet: #364 (the workflows `rust-mutation.yml` and `rust-mutation-full.yml`, their permissions and `--jobs` cap)
- reviewer: #356 sets ADR-0029 and ADR-0030 to `deprecated` in the PR that retires the Stryker job, with the maintainer's OK
