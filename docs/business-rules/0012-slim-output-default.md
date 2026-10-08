# Slim output is the default

## Statement

`search_blocks`, `query_by_property` and `query_by_date_range` take `slim_results`, default `true`. Only an explicit `false` returns full entities.

Slim blocks leave out empty fields: a blank `pageName`, properties with no value (`false` and `0` stay), empty `context.references` and `context.tags`. `uuid` and `content` always stay. Children never carry `pageName`, and neither do blocks inside a date-range entry (the entry has it). `hasMore`, `warnings` and `totals` in meta stay even when empty, because `hasMore: false` is the "nothing was cut" signal (#40). `get_page`, `get_block`, `build_context` and the rest have no slim mode.

## Rationale

Full entities carry fields the model never uses, and they fill its finite context window. Dropping the `hasMore: false` signal would make "nothing was cut" indistinguishable from "unknown". Introduced in #42.

The default lives in the `slim_results` argument schema in `src/tool-args.ts`, which defaults it to `DEFAULT_SLIM_RESULTS` (`src/utils/slim-entities.ts`); the handlers pass the parsed boolean on. The tool functions themselves still default to full, so internal callers (for example `get_context_for_query`'s keyword search) are unchanged.

## Mechanical enforcement

test: `tests/integration/slim-default.test.ts` (omitted means slim, false means full)
test: `rust/src/slim.rs`

The parity step of CI holds the `slim_results` schema default (`default: true`) of every tool to the recorded `tools/list`.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #72 |
| 2026-10-06 | The default is described as living in the `slim_results` schema (`DEFAULT_SLIM_RESULTS`), not in `wantsSlim`, which is deleted. No change to the rule. | #121 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the integration suite and the Rust crate with the TypeScript server's removal. Statement unchanged. | #370 |
