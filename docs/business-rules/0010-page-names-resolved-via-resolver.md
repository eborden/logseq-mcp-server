# Page names resolve the same way in every tool

## Statement

Every tool that takes a page name must resolve it the same way: by exact name in any casing, by alias, by ISO date (`2025-01-01` finds that day's journal) and by namespace leaf. An alias leads to the page that declares it, never to the empty stub page of the same name, and an ISO date prefers the journal over a file-less stub with the same name.

A tool that resolved through an alias, ISO date or namespace leaf must say so: `resolvedFrom: { name, matchedBy, resolvedTo }` in the result, or in `meta` for a bare-array result such as `find_blocks` (a tool that takes several names shapes it for them: `find_blocks` lists one such entry for each name that resolved this way, and `explore_network` with `to` keys them `page` and `to`). A name that matches more than one page is reported as ambiguous with its candidates (`AmbiguousPage`). A candidate list cut at its maximum of 10 adds a `candidates_truncated` warning and `totals.candidates`; `hasMore` stays false because no parameter fetches the rest. A page that does not exist is an error with guidance (`PageNotFound`), never an empty result, in every page-taking tool, including `explore_context`, `get_concept_evolution`, `explore_network` (its `page` and its `to`) and `find_blocks` (its `page` and every page of `links_to`).

## Rationale

`alias:: x` makes an empty stub page `x` plus `:block/alias` refs between the pages (stored both ways), so a lookup by exact name alone returns the stub. Results then look empty or incomplete without saying so, and the same name gives different answers in different tools. Some tools used to return empty results for a page that does not exist. Introduced in #41.

## Mechanical enforcement

One resolver serves every page-taking tool: `require_page` in `rust/src/resolve/mod.rs`. Tools call it, not a lookup of their own.

test: `rust/src/resolve/mod.rs`
test: `tests/integration/page-resolution.test.ts`
reviewer: A new page-taking tool resolves its page name with `require_page` (`rust/src/resolve/mod.rs`), not a lookup of its own.

Link-following tools are alias-aware too (#69, #92): references written under any name of a page's alias group count as references to that page. These tests pin it per tool:

test: `rust/tests/context_calls.rs`
test: `rust/tests/concept_calls.rs`
test: `rust/tests/query_by_date_range_calls.rs`
test: `rust/tests/network_path_calls.rs`
test: `rust/tests/find_blocks_calls.rs`
test: `tests/integration/alias-sets.test.ts`

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #57 |
| 2026-10-08 | Mechanical enforcement: the resolver and the per-tool alias tests are the Rust crate's and the integration suite's, with the TypeScript server's removal. Statement unchanged. | #370 |
| 2026-10-08 | Statement: the TypeScript error names (`AmbiguousPageError`, `PageNotFoundError`) are the Rust crate's (`AmbiguousPage`, `PageNotFound`, `rust/src/errors.rs`). The rule is unchanged. | #372 |
| 2026-10-12 | Statement: `search_by_relationship` has one relationship type, `connected-within`, since the `references` mode became `find_blocks` with `page` and `links_to`, and `find_blocks` is named beside it, with a list of `resolvedFrom` entries in its `meta` (ADR-0037). Mechanical enforcement: added a `test:` line for `find_blocks_calls.rs` (a name that is an alias says which page it stood for, a missing or ambiguous page is the error and makes no search, a name given twice is resolved once). The rule itself is unchanged. | #527 |
| 2026-10-13 | Statement and enforcement: `explore_context` replaces `get_backlinks` (ADR-0037), so the statement names it for the missing-page error and `find_blocks` alone for a bare-array result; the `get_backlinks_calls.rs` line is dropped, its resolver cases are in `context_calls.rs`, already listed. The rule is unchanged. | #529 |
| 2026-10-13 | Statement and enforcement: `explore_network` with `to` replaces `search_by_relationship` (ADR-0037), so the statement says it keys `resolvedFrom` by `page` and `to` and names it for the missing-page error, and the `search_by_relationship_calls.rs` line is `network_path_calls.rs`, which pins the same cases (a name given twice resolved once, a missing page on either side, an alias and the page it names as one page). The rule is unchanged. | #530 |
