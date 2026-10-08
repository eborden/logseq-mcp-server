# Never cut results silently

## Statement

Never cut results silently. Every list-returning tool has a default cap and a maximum, and reports a cap that bites through `ResultMeta` (`src/types.ts`): `hasMore`, `warnings: [{ code, message, howToFetchAll? }]`, and `totals` where already known (no extra API call just to count). `hasMore` is true only when a warning's `howToFetchAll` names a parameter to raise and a value. Object results get these fields. A tool that returns a bare array keeps it as the first content block and sends `{ "meta": ... }` as a second one (`metaContent`).

The `warnings` entry is the truncation signal, not `hasMore`. A result cut at a hard maximum carries a warning with `hasMore: false`, and that warning must say the maximum was reached and that the rest can't be fetched in one call. The exception is a paging parameter, such as `offset`, that can fetch the rest. Then `hasMore` is true, the warning still says the maximum was reached, and `howToFetchAll` names that parameter and its value. Helpers live in `src/utils/result-meta.ts`.

## Rationale

The reader is an LLM that acts on what it is shown. A result silently cut at a cap looks complete and leads to wrong conclusions. Introduced with the shared `ResultMeta` convention (#40).

## Mechanical enforcement

test: `tests/integration/result-caps.test.ts`
test: `rust/src/truncation.rs`
test: `rust/src/meta.rs`
reviewer: Any new cap, limit or maximum on a tool result reports through `ResultMeta`.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #52 |
| 2026-10-06 | A cut at a hard maximum keeps `hasMore: true` when a paging parameter such as `offset` can fetch the rest, and `howToFetchAll` names it and its value. | #141 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the integration suite and the Rust crate's unit tests with the TypeScript server's removal. Statement unchanged. | #370 |
