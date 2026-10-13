# `null` from an API call is not `[]`

## Statement

`null` from an API call is not `[]`. When `logseq.Editor.getAllPages` returns `null` (possibly no graph open or a re-index in progress; unconfirmed until the manual probes M1-M4 in `scripts/probe-constraints.ts` are run), `find_pages` returns the empty list plus a `pages_unavailable` warning, with `hasMore` false and no `howToFetchAll` (no parameter fetches a list that does not exist). A real `[]` carries no warning. Do the same for other tools that read `null` as "none".

## Rationale

An absent answer and an empty answer mean different things to the caller. Reporting `null` as a plain empty list looks like "your graph has no pages". Introduced in #64.

## Mechanical enforcement

test: `rust/tests/simple_tools_calls.rs`
test: `rust/tests/resolve_refs_calls.rs`
test: `rust/tests/query_by_date_range_calls.rs`
test: `rust/tests/get_page_outline_calls.rs`
test: `rust/tests/get_backlinks_calls.rs`
test: `rust/tests/current_context_calls.rs`
test: `rust/tests/get_page_block_calls.rs`
test: `rust/tests/page_resource_calls.rs`
test: `rust/tests/search_by_relationship_calls.rs`
test: `rust/tests/concept_calls.rs`
test: `rust/tests/context_calls.rs`
test: `rust/tests/check_links_calls.rs`
test: `rust/tests/find_pages_calls.rs`

What each test file pins on a `null` answer, and that a real `[]` carries no warning where one is tested beside it:

- `simple_tools_calls.rs`: `find_pages` gives `pages_unavailable`; `find_blocks` with `include_context` gives `context_unavailable` on a `null` page lookup.
- `resolve_refs_calls.rs`: a `null` ref lookup gives `refs_unavailable` and no `missing` refs; a real `[]` still gives `missing`.
- `query_by_date_range_calls.rs`: a `null` journal-page answer gives `journals_unavailable`, a `null` block answer `blocks_unavailable`.
- `get_page_outline_calls.rs`: `outline_unavailable` on a `null` outline answer; a `null` answer from the page resolver is an error that says LogSeq gave no answer, with no suggestions and no further call.
- `get_backlinks_calls.rs`: `backlinks_unavailable` (the list is always `[]` on a `null`) and `alias_lookup_unavailable`.
- `current_context_calls.rs`: `page_names_unavailable` on a `null` page lookup.
- `get_page_block_calls.rs` and `page_resource_calls.rs`: `page_blocks_unavailable` on a `null` block tree, as a warning on the page and a footer on the resource.
- `search_by_relationship_calls.rs`: `relationship_unavailable`, `hop_unavailable` and `page_blocks_unavailable`.
- `concept_calls.rs`: `links_unavailable` for `get_concept_network`; `page_blocks_unavailable`, `page_unavailable` and `mentions_unavailable` for `get_concept_evolution`.
- `context_calls.rs`: `page_blocks_unavailable`, `backlinks_unavailable`, `search_unavailable` and the `topic_unavailable` roll-up for `build_context` and `get_context_for_query`; a `null` resolver answer fails the whole call.
- `check_links_calls.rs`: `check_links` gives `refs_unchecked` on a `null` answer, never missing pages.
- `find_pages_calls.rs`: `find_pages` with `names` answers no name on a `null` page list (no `names` key beside `pages_unavailable`), so no name is reported as having no page.

No tool maps a `null` answer to an empty result without a warning: each gives one of these warnings or fails with an error (`get_block`, `get_graph`, the page resolver). `find_blocks` gives `search_unavailable` for any filter (the empty list, `hasMore` false, no `howToFetchAll`; #415, #491), pinned in `simple_tools_calls.rs`. It replaced `search_blocks` and `query_by_property`, which gave `search_unavailable` and `property_query_unavailable`. The reviewer applies the rule to new code.
reviewer: A tool that maps a `null` API response to an empty result adds a warning that says the data was unavailable.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as a pinned probe for `getAllPages` returning `null`. | #68 |
| 2026-10-05 | `pages_unavailable` warning added to `list_pages`. | #71 |
| 2026-10-07 | Mechanical enforcement: added a `test:` line for `resolve_refs` (`refs_unavailable` on a `null` lookup), and reworded the enforcement paragraph that describes the test lines ("Both pin" became "The first two pin ... The third pins ..."). The Statement is unchanged. | #265 |
| 2026-10-07 | Mechanical enforcement: added a `test:` line for `query_by_date_range` (`journals_unavailable` and `blocks_unavailable` on a `null` answer), and added a sentence describing it to the enforcement paragraph. The Statement is unchanged. | #284 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the Rust server's call-count tests with the TypeScript server's removal, and the paragraph that describes them was reworded to match. Statement unchanged. Reworded the last sentence so it doesn't read as endorsing `null` read as none. | #370 |
| 2026-10-08 | Mechanical enforcement: added `test:` lines for the page resolver (a `null` answer is an error that says LogSeq gave no answer, with no suggestions and no further call; `get_page_outline_calls.rs`) and for `get_backlinks` and the alias groups (`alias_lookup_unavailable`, and `backlinks_unavailable` with a list that is always `[]` on a `null`; `get_backlinks_calls.rs`, with the date-range alias case in the line already there). Additive only; no paragraph reworded. | #404 |
| 2026-10-08 | Mechanical enforcement: added a `test:` line for `get_current_context` (`page_names_unavailable` on a `null` page lookup, none on a real `[]`). Statement and paragraphs unchanged. | #405 |
| 2026-10-08 | Mechanical enforcement: added `test:` lines for `get_page` (a `null` block tree gives a `page_blocks_unavailable` warning, a real `[]` none) and for the page resource (the same warning as a footer). Additive only; the Statement and the paragraphs are unchanged. | #403 |
| 2026-10-08 | Mechanical enforcement: added a `test:` line for `search_by_relationship` (`relationship_unavailable`, `hop_unavailable` and `page_blocks_unavailable` on a `null` answer, and none on a real `[]`). Additive; no paragraph reworded. | #406 |
| 2026-10-08 | Mechanical enforcement: added a `test:` line for `get_concept_network` and `get_concept_evolution` (`links_unavailable` on a `null` connected-pages answer; `page_blocks_unavailable`, `page_unavailable` and `mentions_unavailable` on a `null` block tree, page or mentions answer, none on a real `[]`; `concept_calls.rs`). Additive only; the Statement and the paragraphs are unchanged. | #408 |
| 2026-10-08 | Mechanical enforcement: added a `test:` line for `build_context` and `get_context_for_query` (`page_blocks_unavailable`, `backlinks_unavailable`, `search_unavailable` and the `topic_unavailable` roll-up on a `null` answer, none on a real `[]`; a `null` resolver answer fails the whole call). Additive only; no paragraph reworded. | #410 |
| 2026-10-08 | Mechanical enforcement: reworded the paragraph that describes the test lines. It now names what each `test:` line pins (the lines added by #403 to #411), says no tool but two maps a `null` to an empty result without a warning, and names `search_blocks` and `query_by_property` as the two that still return the bare text `null` (#415) instead of "other tools still read `null` as none". Also added a `test:` line for `check_links` (`refs_unchecked` on a `null` answer; `check_links_calls.rs`), which is additive enforcement, and turned the paragraph into one bullet per test file. The Statement is unchanged. | #416 |
| 2026-10-09 | Mechanical enforcement: updated the one sentence of the enforcement paragraph that said `search_blocks` and `query_by_property` still return the bare text `null` (#415), which is false now that they give `search_unavailable` and `property_query_unavailable`. The maintainer's OK on #415 covers it. No other paragraph, bullet or `test:` line changed; the Statement is unchanged. | #448 |
| 2026-10-12 | The paragraph that lists the tools which answer a `null` with a warning or an error names `get_graph`, the new name of `get_graph_info` (ADR-0037). Nothing else changed. | #517 |
| 2026-10-12 | The statement and the enforcement paragraph name `find_pages`, the new name of `list_pages` (ADR-0037). Mechanical enforcement: added a `test:` line and a paragraph bullet for `find_pages` with `names` (a `null` page list answers no name). Nothing else changed. | #524 |
| 2026-10-12 | Mechanical enforcement: the paragraph that lists the tools which answer a `null` with a warning names `find_blocks`, which replaced `search_blocks` and `query_by_property` and gives the one code `search_unavailable` for every filter (`property_query_unavailable` is gone), and the `include_context` bullet of `simple_tools_calls.rs` names it too. Statement unchanged. | #525 |
