# Page names resolve the same way in every tool

## Statement

Every tool that takes a page name must resolve it the same way: by exact name in any casing, by alias, by ISO date (`2025-01-01` finds that day's journal) and by namespace leaf. An alias leads to the page that declares it, never to the empty stub page of the same name, and an ISO date prefers the journal over a file-less stub with the same name.

A tool that resolved through an alias, ISO date or namespace leaf must say so: `resolvedFrom: { name, matchedBy, resolvedTo }` in the result, or in `meta` for a bare-array result such as `get_backlinks`. A name that matches more than one page is reported as ambiguous with its candidates (`AmbiguousPage`). A candidate list cut at its maximum of 10 adds a `candidates_truncated` warning and `totals.candidates`; `hasMore` stays false because no parameter fetches the rest. A page that does not exist is an error with guidance (`PageNotFound`), never an empty result, in every page-taking tool, including `get_backlinks`, `get_concept_evolution` and `search_by_relationship` (all relationship types, `connected-within` too).

## Rationale

`alias:: x` makes an empty stub page `x` plus `:block/alias` refs between the pages (stored both ways), so a lookup by exact name alone returns the stub. Results then look empty or incomplete without saying so, and the same name gives different answers in different tools. Some tools used to return empty results for a page that does not exist. Introduced in #41.

## Mechanical enforcement

One resolver serves every page-taking tool: `require_page` in `rust/src/resolve/mod.rs`. Tools call it, not a lookup of their own.

test: `rust/src/resolve/mod.rs`
test: `tests/integration/page-resolution.test.ts`
reviewer: A new page-taking tool resolves its page name with `require_page` (`rust/src/resolve/mod.rs`), not a lookup of its own.

Link-following tools are alias-aware too (#69, #92): references written under any name of a page's alias group count as references to that page. These tests pin it per tool:

test: `rust/tests/get_backlinks_calls.rs`
test: `rust/tests/context_calls.rs`
test: `rust/tests/concept_calls.rs`
test: `rust/tests/query_by_date_range_calls.rs`
test: `rust/tests/search_by_relationship_calls.rs`
test: `tests/integration/alias-sets.test.ts`

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #57 |
| 2026-10-08 | Mechanical enforcement: the resolver and the per-tool alias tests are the Rust crate's and the integration suite's, with the TypeScript server's removal. Statement unchanged. | #370 |
| 2026-10-08 | Statement: the TypeScript error names (`AmbiguousPageError`, `PageNotFoundError`) are the Rust crate's (`AmbiguousPage`, `PageNotFound`, `rust/src/errors.rs`). The rule is unchanged. | #372 |
