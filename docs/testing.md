# Testing

The Rust tests are unit tests beside the code (`#[cfg(test)]` in `src/`) and the integration tests in `tests/*.rs`: call-count tests against a mock LogSeq (`tests/common/mod.rs`), `no_stdout.rs`, `env_reads.rs` and `no_env_proxy.rs`, and the parity test. None of them contact LogSeq. The Node tooling has its own suites: `tests/guards` and `tests/rust-guards` (vitest) and `tests/integration` (against a fixture LogSeq). [development.md](development.md) has the commands. This page is the golden-result contract.

## Golden results

`cargo test --locked` runs the golden-result test. `tests/parity.rs` starts the binary cargo built, answers its LogSeq calls from a stub on a random local port, and holds it to the results recorded from the TypeScript server before it was retired (its last version reads with `git show 35fa2dd3:<path>`; [ADR-0025](adr/0025-rust-implementation-alongside-typescript.md)), in `tests/data/parity/`:

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

## Testing Philosophy

### Fixture Graph, Exact Assertions

The integration tests run against `tests/fixtures/graph/`, a small made-up graph in the repo (#86, #90), and nothing else. `connectFixture()` (`tests/integration/helpers/fixture-client.ts`) loads the config and calls `requireFixtureGraph`, and the run's global setup does it once first, so a run against any other graph fails loud. The suites are TypeScript (vitest) but test the Rust server: a tool function imported from `tests/integration/helpers/tools.ts` calls the built binary over MCP stdio (`tests/integration/setup.md`, "The server under test"). `tests/integration/setup.md` has the run steps; `tests/fixtures/README.md` says what each page is for and what it returns.

**Pattern:**
```typescript
beforeAll(async () => {
  ({ client } = await connectFixture());
});

it('returns every neighbour of a page under the caps', async () => {
  const result = await getConceptNetwork(client, 'bob', 1);

  expect(result.nodes.map(n => n.name).sort()).toEqual(BOB_NETWORK); // known fixture data
  expect(result).toMatchObject({ truncated: false, hasMore: false, warnings: [] });
});
```

- **Exact values from known pages**, never data discovered at run time. A test that needs new data adds it to the fixture and its README in the same PR.
- **Compute what drifts**: today's journal (LogSeq makes it on open; `laterJournalDays`), and page counts that include built-in pages. Use fixed date windows that end before 2026.
- **Caps that pick by `:db/id` order** are stable in count, not by name; the fixture README's hub section says which is which.
- **Invariants** that hold for any graph stay as property tests (`tests/integration/properties/`), run over a fixed list of fixture pages.
- **A known bug** is a plain `it` (or a plain Rust `#[test]`) that pins the current wrong value and names its issue, to be flipped with the fix. Not `it.fails` or `#[should_panic]`, which also pass when the body fails for another reason. Behavior copied from the TypeScript server that looks like a bug is tagged `// PARITY(#299)` in the crate and pinned the same way (see BR-0011).

**Test Categories:**
- **Rust tests** (`cargo test --locked`): unit tests beside the code (`#[cfg(test)]`: query builders, parsers, renderers, caps) and call-count tests in `tests/*_calls.rs`, which run a tool against a mock HTTP LogSeq (`tests/common/mod.rs`) and assert the exact calls and result. Also `tests/no_stdout.rs`, `env_reads.rs` and `no_env_proxy.rs`, which fail on a write to stdout, an environment read outside `env.rs` and a proxy picked up from the environment. They touch no LogSeq
- **Golden results** (`cargo test --test parity`, #371; CI runs them through `cargo test`, #375): every tool, prompt and resource result against the results recorded from the TypeScript server, the LogSeq calls (each matches a recorded call, at most the case's ceiling in `call-ceilings.json` are made, all are reads; order and grouping are not compared, ADR-0034), and `tools/list` by meaning (ADR-0031). A JSON tool result is compared by deep equality (key order ignored, array order kept, numbers by value) and has to be minified (ADR-0009); markdown, prompt messages, resource reads and the frame of a not-found message are byte for byte. Each starts the binary against a stub LogSeq, and proves it can fail (`tests/parity_self_check.rs`). The cases and their golden results are `tests/data/parity/*.json` and nowhere else (#379), and `PARITY_RECORD=1 cargo test --test parity_record -- --nocapture` records them (it rewrites a result only when it changed in meaning, and refuses to run in CI). Every comparison rule is in `tests/parity_support/compare.rs`, and `tests/parity_comparator.rs` and `parity_harness.rs` hold the comparator, the stub and the run to their own rules
- **Guard tests** (`npx vitest run tests/guards tests/rust-guards`): the repo's rules (docs format, templates, privacy, fixture, workflows, tool-list guardrails, the golden-files check). `tests/rust-guards` starts the Rust binary: the live `tools/list` against the size budget and description cap, a wrong-typed value sent to every parameter of every tool, and the version
- **Integration tests** (`npm run test:integration`, ~215 in 22 files as of Oct 2026, against the fixture graph in a live LogSeq): exact results of every tool, through the Rust server
- Note: `npm test` runs the guard tests, then `npm run test:integration`, so it needs the fixture instance running and the Rust debug build (it doesn't run `cargo test`: run that separately). The default vitest config leaves `tests/integration/` out.
- **Property tests**: Universal invariants, equivalence validation (`tests/integration/properties/`, and the crawl oracles in `find-blocks-property` and `temporal-queries`)

### Integration Test Requirements (Hard Failures)

Integration tests must fail loud on BOTH setup issues AND missing test data.

**Rules:**
1. **NO it.skipIf() for integration tests** - Tests must run or fail, never skip
2. **NO console.warn() in tests** - Silent warnings hide real failures
3. **REQUIRE prerequisites explicitly** - `connectFixture()` checks the config, the connection and the fixture graph
4. **Fail with helpful messages** - Point to setup.md for resolution steps

**Pattern:**
```typescript
// ❌ BAD: Silent skip/warn
beforeAll(async () => {
  try {
    await access(configPath);
  } catch {
    skipTests = true; // Silent skip - test suite passes without testing!
  }
});
it.skipIf(skipTests)('test', async () => { ... });

// ❌ BAD: Silent warn
const result = await findBlocks(client, { text: 'test' });
if (!result || result.length === 0) {
  console.warn('No data found'); // Test passes without proving anything!
  return;
}

// ✅ GOOD: Fail loud, and assert exactly what the fixture holds
beforeAll(async () => {
  ({ client } = await connectFixture()); // throws, pointing at setup.md, unless LogSeq serves the fixture
});

it('test', async () => {
  const result = await findBlocks(client, { text: 'importer' });
  expect(result).toHaveLength(11); // the fixture's 11 blocks that say "importer"
});
```

**Why:**
- Skipped tests provide false confidence
- Passing tests that found no data prove nothing
- Integration tests must test real integration
- Clear failures guide developers to fix actual problems
