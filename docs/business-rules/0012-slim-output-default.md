# Slim output is the default

## Statement

`search_blocks`, `query_by_property` and `query_by_date_range` take `slim_results`, default `true`. Only an explicit `false` returns full entities.

Slim blocks leave out empty fields: a blank `pageName`, properties with no value (`false` and `0` stay), empty `context.references` and `context.tags`. `uuid` and `content` always stay. Children never carry `pageName`, and neither do blocks inside a date-range entry (the entry has it). `hasMore`, `warnings` and `totals` in meta stay even when empty, because `hasMore: false` is the "nothing was cut" signal (#40). `get_page`, `get_block`, `build_context` and the rest have no slim mode.

## Rationale

Full entities carry fields the model never uses, and they fill its finite context window. Dropping the `hasMore: false` signal would make "nothing was cut" indistinguishable from "unknown". Introduced in #42.

The default lives in `DEFAULT_SLIM_RESULTS` (`rust/src/slim.rs`): each tool that takes `slim_results` reads the argument with it as the default and advertises `default: true` in its schema. Internal callers are unchanged: `get_context_for_query`'s keyword search reads full blocks itself (`full_blocks_with_context`).

## Mechanical enforcement

test: `tests/integration/slim-default.test.ts` (omitted means slim, false means full)
test: `rust/src/slim.rs`
test: `tests/guards/tool-list.test.ts`
test: `rust/tests/parity.rs`

`tests/guards/tool-list.test.ts` asserts that every `slim_results` parameter of the recorded `tools/list` advertises `default: true`, and the parity test (`rust/tests/parity.rs`, run by `cargo test`) holds the server's schema to that list.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #72 |
| 2026-10-06 | The default is described as living in the `slim_results` schema (`DEFAULT_SLIM_RESULTS`), not in `wantsSlim`, which is deleted. No change to the rule. | #121 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the integration suite and the Rust crate with the TypeScript server's removal. Statement unchanged. Added the recorded-list assertion for the `slim_results` default. | #370 |
| 2026-10-08 | Rationale only: where the default lives is the Rust crate's (`DEFAULT_SLIM_RESULTS` in `rust/src/slim.rs`, read by each tool's `slim_results` argument) and not the TypeScript argument schema. Statement unchanged. | #372 |
| 2026-10-08 | Mechanical enforcement: the parity check of the server's schema against the recorded `tools/list` is `rust/tests/parity.rs` (`cargo test`), no longer a Node CI step. Added it as a `test:` line. Statement unchanged. | #376 |
