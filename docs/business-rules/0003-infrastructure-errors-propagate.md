# Infrastructure errors propagate; an error is never an empty result

## Statement

Don't turn errors into empty results. A dropped connection must not look like "no data". Re-throw infrastructure errors (`isInfrastructureError`: LogSeq not running, auth, timeout) and unexpected ones. Only an empty result is "none", and expected partial results go in a `warnings` field.

## Rationale

People and agents act on what they are shown. A result that says "no matches" when the query failed causes wrong decisions. Introduced in #10, and extended to the `get_page` path in #34.

## Mechanical enforcement

test: `rust/tests/get_page_block_calls.rs`
test: `rust/tests/get_backlinks_calls.rs`
test: `rust/tests/resolve_refs_calls.rs`
test: `rust/tests/context_calls.rs`
test: `rust/src/server.rs`

`rust/src/server.rs` pins that a failed call reaches the MCP caller as an `isError` result, and `tests/integration/auth-error.test.ts` pins that a rejected token reaches the caller with an actionable message, against a real LogSeq.
reviewer: A new `catch` re-throws infrastructure errors and never maps an error to an empty result. A `catch` that rethrows unchanged or swallows the error is a defect: either add context, convert to a typed error, or delete it.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced in `build_context` and `get_context_for_query`. | #29 |
| 2026-10-05 | Extended to `get_page` and its page lookups. | #35 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the Rust server's call-count tests and the integration suite with the TypeScript server's removal. Statement unchanged. | #370 |
