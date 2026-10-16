---
name: add-tool
description: 'Use when adding a new MCP tool, or changing a tool''s name, description or input schema (queries, `mod.rs`, wire types, call-count and parity tests, tool-list guardrails, measure script).'
---

# Add a tool

Two rules stay in CLAUDE.md whether or not this skill loads: every tool is read-only (BR-0002), and a change to the recorded `tools/list` or the goldens needs the maintainer's OK and the `golden-change` label.

Checklist for new Datalog-based tools. Each tool is a directory in `src/tools/<tool>/`:

1. **Queries** - In `queries.rs`, functions that return a `Query { text, inputs }`
   - Take typed values (`PageName`, `PageId`, `JournalDay`, `BlockUuid`), not strings, so a page name is lowercased by construction and an id can only be a whole number
   - Bind strings with `:in` (`DatalogInput`); don't embed them in the query text. Embed ids only through `ground_ids` and uuids through `ground_uuids`
   - Don't use `clojure.string/lower-case`
   - No `getAllPages` + per-page crawls

2. **Tool Implementation** - `mod.rs` holds `NAME`, `definition` and `call`; register the tool in `src/tools/mod.rs` (`list` and `call`). Follow two-query pattern if data is optional
   - Query 1: Main entity (fail if not found). Resolve a page name with `require_page`, never a lookup of your own
   - Query 2+: Related data (handle empty results)
   - Read each LogSeq response through a wire type in the tool's `wire.rs` (add one when the shape is new), and propagate errors with `?`
   - A cap reports `ResultMeta` (BR-0006) and a tip is advisory (BR-0009)

3. **Tests** - Write Rust tests: unit tests beside the code, and a call-count test in `tests/<tool>_calls.rs` against the mock LogSeq (`tests/common/mod.rs`)
   - Test happy path with data
   - Test empty results (no blocks, no connections)
   - Test case-insensitive lookup
   - Test a bad argument and an infrastructure error (the error reaches the caller, never an empty result)

4. **Integration Test** - Add to `tests/integration/`
   - Connect with `connectFixture()` and assert exact results on fixture pages; add a function for the tool to `tests/integration/helpers/tools.ts`, and fixture data (and its README rows) if the tool needs a case the fixture lacks
   - Fail loud, never skip (see "Integration Test Requirements" in [`docs/testing.md`](../../../docs/testing.md))

5. **Contract and documentation** - The tool's `definition`
   - Give the tool `read_only_annotations("Title")` (`tests/guards/tool-list.test.ts` and `src/server.rs` fail without it). Every tool is read-only: [BR-0002 (tools-read-only)](../../../docs/business-rules/0002-tools-read-only.md)
   - Generate the `inputSchema` from the argument type with `input_schema`, and parse the arguments into that type with `parse_args` (`src/args.rs`) before the first LogSeq call. `tests/rust-guards/tool-arguments.test.ts` sends a wrong-typed value to every parameter and checks it fails
   - Write the description with a "Can't find" line (ADR-0015), and add the tool's cases to the parity data (a new `tests/data/parity/<tool>.json`, recorded with `PARITY_RECORD=1`). A new tool changes `tests/data/parity/tool-list.json` and adds golden results and call ceilings (`call-ceilings.json`, recorded with the cases), which the `golden-files` job fails until the maintainer has OKed them and added the `golden-change` label (see "Verification before merge" in CLAUDE.md)

6. **Measure** - Add the tool to `scripts/measure-api-calls.ts` and record its call count in the table in `docs/performance.md`

7. **Tool-list guardrails** - `tests/guards/tool-list.test.ts` checks the recorded `tools/list`, and `tests/rust-guards/tool-list-live.test.ts` the server's own (`tests/data/parity/tool-list.json`; `cargo test --test parity` holds the Rust server's list to it by meaning, so a change to a tool's name, description or schema is a change to that file, re-recorded with `PARITY_RECORD=1`) ([ADR-0016 (tool-list-size-guardrails)](../../../docs/adr/0016-tool-list-size-guardrails.md))
   - Size budget: `TOOL_LIST_BUDGET_CHARS` in `tests/guards/tool-list-limits.ts` (~15% headroom over the size measured when it was added). If your tool or parameters push past it, trim first. If the growth is worth it, raise the constant and justify it in the PR description.
   - Description cap: 400 characters per tool. A new tool gets no allowance. Existing long descriptions are listed in `DESCRIPTION_ALLOWANCES` and may shrink but not grow. Delete an entry once its tool fits the cap.
   - Recorded list: any change to a name, title, annotation, description or input schema fails the parity test. Review the diff of `tests/data/parity/tool-list.json` before you accept it.

## Key files

**Key files:**
- `src/tools/explore_context/queries.rs` - Query builders: typed inputs, `:in` binding and `ground_ids` (study this for patterns)
- `src/tools/explore_context/mod.rs` - Example of two-query pattern
- `src/tools/explore_network/mod.rs` - Example of multi-query BFS
- `tests/concept_calls.rs` - Example of a call-count test against the mock LogSeq
- `tests/integration/properties/graph-properties.test.ts` - Property-based testing examples
