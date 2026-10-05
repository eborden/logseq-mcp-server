# Infrastructure errors propagate; an error is never an empty result

## Statement

Don't turn errors into empty results. A dropped connection must not look like "no data". Re-throw infrastructure errors (`isInfrastructureError`: LogSeq not running, auth, timeout) and unexpected ones. Only an empty result is "none", and expected partial results go in a `warnings` field.

## Rationale

People and agents act on what they are shown. A result that says "no matches" when the query failed causes wrong decisions. Introduced in #10, and extended to the `get_page` path in #34.

## Mechanical enforcement

test: `src/tools/get-page.test.ts`
test: `src/utils/resolve-page.test.ts`
test: `src/utils/resolve-refs.test.ts`
test: `src/tools/build-context.test.ts`
test: `src/index.test.ts`

`src/index.test.ts` pins that auth, timeout and not-running errors reach the MCP caller as `isError` results with an actionable message.
reviewer: A new `catch` re-throws infrastructure errors and never maps an error to an empty result. A `catch` that rethrows unchanged or swallows the error is a defect: either add context, convert to a typed error, or delete it.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced in `build_context` and `get_context_for_query`. | #29 |
| 2026-10-05 | Extended to `get_page` and its page lookups. | #35 |
