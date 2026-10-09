# `null` from an API call is not `[]`

## Statement

`null` from an API call is not `[]`. When `logseq.Editor.getAllPages` returns `null` (possibly no graph open or a re-index in progress; unconfirmed until the manual probes M1-M4 in `scripts/probe-constraints.ts` are run), `list_pages` returns the empty list plus a `pages_unavailable` warning, with `hasMore` false and no `howToFetchAll` (no parameter fetches a list that does not exist). A real `[]` carries no warning. Do the same for other tools that read `null` as "none".

## Rationale

An absent answer and an empty answer mean different things to the caller. Reporting `null` as a plain empty list looks like "your graph has no pages". Introduced in #64.

## Mechanical enforcement

test: `rust/tests/simple_tools_calls.rs`
test: `rust/tests/resolve_refs_calls.rs`
test: `rust/tests/query_by_date_range_calls.rs`
test: `rust/tests/current_context_calls.rs`
test: `rust/tests/get_page_block_calls.rs`
test: `rust/tests/page_resource_calls.rs`

The first pins the `pages_unavailable` warning for `null` and the absence of a warning for a real `[]`. The second pins the same split for `resolve_refs`: a `null` ref lookup gives a `refs_unavailable` warning and no `missing` refs, and a real `[]` still gives `missing`. The third pins it for `query_by_date_range`: a `null` journal-page answer gives a `journals_unavailable` warning, a `null` block answer gives `blocks_unavailable`, and a real `[]` gives neither. Other tools still read `null` as "none", copied from the TypeScript server and tagged `PARITY(#299)` (suspected TypeScript bugs, #301); their call-count tests in `rust/tests/` pin that current behaviour, to be flipped when it is fixed, and it is not an endorsement of the reading. The reviewer applies the rule to new code.
reviewer: A tool that maps a `null` API response to an empty result adds a warning that says the data was unavailable.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a pinned probe for `getAllPages` returning `null`. | #68 |
| 2026-10-05 | `pages_unavailable` warning added to `list_pages`. | #71 |
| 2026-10-07 | Mechanical enforcement: added a `test:` line for `resolve_refs` (`refs_unavailable` on a `null` lookup), and reworded the enforcement paragraph that describes the test lines ("Both pin" became "The first two pin ... The third pins ..."). The Statement is unchanged. | #265 |
| 2026-10-07 | Mechanical enforcement: added a `test:` line for `query_by_date_range` (`journals_unavailable` and `blocks_unavailable` on a `null` answer), and added a sentence describing it to the enforcement paragraph. The Statement is unchanged. | #284 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the Rust server's call-count tests with the TypeScript server's removal, and the paragraph that describes them was reworded to match. Statement unchanged. Reworded the last sentence so it doesn't read as endorsing `null` read as none. | #370 |
| 2026-10-08 | Mechanical enforcement: added a `test:` line for `get_current_context` (`page_names_unavailable` on a `null` page lookup, none on a real `[]`). Statement and paragraphs unchanged. | #405 |
| 2026-10-08 | Mechanical enforcement: added `test:` lines for `get_page` (a `null` block tree gives a `page_blocks_unavailable` warning, a real `[]` none) and for the page resource (the same warning as a footer). Additive only; the Statement and the paragraphs are unchanged. | #403 |
