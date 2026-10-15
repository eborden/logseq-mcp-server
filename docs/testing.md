# Testing

The Rust tests are unit tests beside the code (`#[cfg(test)]` in `src/`) and the integration tests in `tests/*.rs`: call-count tests against a mock LogSeq (`tests/common/mod.rs`), `no_stdout.rs`, `env_reads.rs` and `no_env_proxy.rs`, and the parity test. None of them contact LogSeq. The Node tooling has its own suites: `tests/guards` and `tests/rust-guards` (vitest) and `tests/integration` (against a fixture LogSeq). [development.md](development.md) has the commands. This page is the golden-result contract.

## Golden results

`cargo test --locked` runs the golden-result test. `tests/parity.rs` starts the binary cargo built, answers its LogSeq calls from a stub on a random local port, and holds it to the results recorded from the TypeScript server before it was retired, in `tests/data/parity/`:

- Each result: a JSON tool result by deep equality (key order ignored, array order kept, numbers by value) and then minified; markdown, prompts, resources and the frame of a page-not-found message byte for byte; the closest names of a page-not-found message by the rules of ADR-0034 Decision 4 (below).
- The LogSeq calls, by a bounded count and an effect, not by text or order (below).
- `tools/list`, by meaning (ADR-0034 Decision 3).

`tests/parity_self_check.rs` runs the cases again with the last answer of each changed and requires every case with a LogSeq call to fail, again with every ceiling one lower, and the closest-name rules to catch every kind of wrong list. `tests/parity_comparator.rs` and `tests/parity_harness.rs` hold the comparator, the stub and the run to their own rules. Every comparison rule is in `tests/parity_support/compare.rs`: `compare_results` judges a result, and `same_tool_text` and `same_text` are the only places that decide whether two texts match. Fixtures are made up (BR-0001).

The cases and their golden results live in `tests/data/parity/*.json` and nowhere else. A group file holds its cases, one to a line: the stub answers, the MCP request, the recorded calls (as `steps`) and, under `expected`, the golden result. `tool-list.json` is the recorded `tools/list`, `clock-cases.json` lists the cases that read today's date, and `call-ceilings.json` holds each case's call ceiling. A recorded result is the tool contract: a change to one needs the maintainer's explicit OK, recorded on the pull request, and the `golden-change` label that the `golden-files` job of `ci.yml` looks for ([CLAUDE.md](../CLAUDE.md), "Verification before merge").

To add or change a case, edit its line, leave out `expected` for a case that has none yet, and record it:

```bash
PARITY_RECORD=1 cargo test --test parity_record -- --nocapture
```

The recorder runs every case against the stub with the debug build and rewrites only what changed in meaning. A case with no `expected` takes its result. One whose result differs from the recorded one, by the comparison the test uses, takes the new one. One that is the same by meaning keeps the bytes recorded for it, so the diff is the change and not the spelling of the server's output. The tool list is done the same way, tool by tool. It refuses to run when `CI` is set or in a release build, and writes nothing when a case's LogSeq calls are wrong or the closest names would break the rules of ADR-0034 Decision 4.

Code that exists only to match the TypeScript server's exact bytes or quirks carries a comment `// PARITY(#299): <what it copies>`, with the reason it can go. `grep -rn 'PARITY(#299)' src` lists them. Real safeguards (the 200-block cap, BR-0011, the page resolver) are not tagged.

## LogSeq calls: a count and an effect

What a tool asks LogSeq is not part of its contract, so long as the asking is bounded and right (ADR-0034 Decision 5). For each case `compare_calls` (`tests/parity_support/compare.rs`) and the stub (`tests/parity_support/stub.rs`) hold the server to this:

- Every call the server makes matches a recorded call in method, query text (layout ignored) and inputs. A call that matches none fails the case, whatever the server does with the error, so a best-effort path that swallows it still fails. A query asked twice is matched to its recorded answers in the recorded order, and a call asked more often than it was recorded has no answer left.
- At most the case's ceiling of calls are made (ADR-0011). A recorded call the server never makes is not a failure by itself, but a run of the cases as committed that makes **fewer** calls than the ceiling fails until the ceiling is lowered, so a saved call can't be spent again later without asking.
- Every recorded call is a read, and so is every call made (BR-0002, `is_read_method`).
- The order of the calls, their grouping into the `steps` of a case and whether they ran at once are not compared.

The ceiling is in `tests/data/parity/call-ceilings.json`, a case name to a number, apart from the fixtures, so adding or rewriting a fixture can't raise it. It starts at the number of calls the case records, and no ceiling may exceed that number. A PR that makes fewer calls lowers it: the recorder (above) does it for every case that made fewer calls than its ceiling, and the failure for a ceiling above the calls made names that command. Lowering needs no OK. **Raising a ceiling, or adding one, needs the maintainer's explicit OK**, and the second step of the `golden-files` job fails a PR that does either unless it carries the `golden-change` label, which only the maintainer adds. The recorder never raises one.

### Re-recording a call

For a leaner query, a merged or narrowed call, a removed shim. ADR-0034 allows it when no golden result changes, the case's call count stays within its ceiling, every call is a read and the new query is right on real LogSeq:

1. Edit the call in the case's line of `tests/data/parity/<group>.json`: its `method`, `args` (the query text and its inputs) and the `response` the stub gives. Derive the new `response` from the answers it replaces (a merged call answers with the union of the old answers, a narrowed one with a subset), not from what the server happens to need, and show that derivation in the PR.
2. Run `cargo test --locked --test parity --test parity_self_check`. It must pass with no `expected` edited and no ceiling raised. If the case now makes fewer calls, the run fails with "under the case's ceiling": lower the ceiling with the recorder or by hand.
3. Run the integration suite against the worktree's fixture graph, which shows that the query is right on LogSeq (the parity answers are made up, so the parity test can't): `npx tsx scripts/logseq-instance.ts start`, then `npm run test:integration`, then `npx tsx scripts/logseq-instance.ts stop`.
4. In the PR, say that no golden changed and no ceiling was raised, and show the derivation. A reviewer reads it against the diff.

## The clock

The test runs the server in one time zone (`America/New_York`) with one instant as "now" (`LOGSEQ_MCP_NOW`, 2025-03-12T03:30Z, which is still the evening of the 11th there): a result that depends on today's date (`last_n`, a preset) is then the same on every day, and a server that reads the date in UTC fails.

The release binary (`cargo build --release --locked`) ignores `LOGSEQ_MCP_NOW`, so it reads the real date and can't match the recorded results that depend on today (`last_n`, a preset, a weekly or monthly prompt for "this week"). Under `--release` those cases leave the run: `clock-cases.json` lists them, and `tests/parity_harness.rs` checks that it names exactly the cases whose result moves with the clock. CI runs the others against the release build after it, on `main` and on a manual run:

```bash
cargo test --release --locked --test parity --test parity_self_check
```

## Closest names

The closest names after `Closest:` in a page-not-found message are not compared byte for byte (ADR-0034 Decision 4, `tests/parity_support/suggestion_rules.rs`). The test checks the message frame, that the list is one to three distinct page names, that exact and prefix matches come first, that every name covers every word typed, and that there are as many as there are to list, up to three. It fails when the recorded cases lack one the ADR requires.
