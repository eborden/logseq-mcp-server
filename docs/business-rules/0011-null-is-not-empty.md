# `null` from an API call is not `[]`

## Statement

`null` from an API call is not `[]`. When `logseq.Editor.getAllPages` returns `null` (possibly no graph open or a re-index in progress; unconfirmed until the manual probes M1-M4 in `scripts/probe-constraints.ts` are run), `list_pages` returns the empty list plus a `pages_unavailable` warning, with `hasMore` false and no `howToFetchAll` (no parameter fetches a list that does not exist). A real `[]` carries no warning. Do the same for other tools that read `null` as "none".

## Rationale

An absent answer and an empty answer mean different things to the caller. Reporting `null` as a plain empty list looks like "your graph has no pages". Introduced in #64.

## Mechanical enforcement

test: `rust/tests/simple_tools_calls.rs`
test: `rust/tests/resolve_refs_calls.rs`
test: `rust/tests/query_by_date_range_calls.rs`

The first pins the `pages_unavailable` warning for `null` and the absence of a warning for a real `[]`. The second pins the same split for `resolve_refs`: a `null` ref lookup gives a `refs_unavailable` warning and no `missing` refs, and a real `[]` still gives `missing`. The third pins it for `query_by_date_range`: a `null` journal-page answer gives a `journals_unavailable` warning, a `null` block answer gives `blocks_unavailable`, and a real `[]` gives neither. Other tools that read `null` as "none" have call-count tests in `rust/tests/` that pin it too; the reviewer applies the rule to new ones.
reviewer: A tool that maps a `null` API response to an empty result adds a warning that says the data was unavailable.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a pinned probe for `getAllPages` returning `null`. | #68 |
| 2026-10-05 | `pages_unavailable` warning added to `list_pages`. | #71 |
| 2026-10-07 | Mechanical enforcement: added a `test:` line for `resolve_refs` (`refs_unavailable` on a `null` lookup), and reworded the enforcement paragraph that describes the test lines ("Both pin" became "The first two pin ... The third pins ..."). The Statement is unchanged. | #265 |
| 2026-10-07 | Mechanical enforcement: added a `test:` line for `query_by_date_range` (`journals_unavailable` and `blocks_unavailable` on a `null` answer), and added a sentence describing it to the enforcement paragraph. The Statement is unchanged. | #284 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the Rust server's call-count tests with the TypeScript server's removal, and the paragraph that describes them was reworded to match. Statement unchanged. | #369 |
