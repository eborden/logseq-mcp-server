# Never cut results silently

## Statement

Never cut results silently. Every list-returning tool has a default cap and a maximum, and reports a cap that bites through `ResultMeta` (`rust/src/meta.rs`): `hasMore`, `warnings: [{ code, message, howToFetchAll? }]`, and `totals` where already known (no extra API call just to count). `hasMore` is true only when a warning's `howToFetchAll` names a parameter to raise and a value. Object results get these fields. A tool that returns a bare array keeps it as the first content block and sends `{ "meta": ... }` as a second one (for example `find_blocks`, `rust/src/tools/find_blocks/mod.rs`).

The `warnings` entry is the truncation signal, not `hasMore`. A result cut at a hard maximum carries a warning with `hasMore: false`, and that warning must say the maximum was reached and that the rest can't be fetched in one call. The exception is a paging parameter, such as `offset`, that can fetch the rest. Then `hasMore` is true, the warning still says the maximum was reached, and `howToFetchAll` names that parameter and its value. The warnings are built in `rust/src/truncation.rs`.

**The cursor ([ADR-0038 (one-forward-only-cursor-for-paging)](../adr/0038-one-forward-only-cursor-for-paging.md)).** From v2.0.0 a cut result can always be read to the end. Every tool that cuts a list takes an optional `cursor` and returns `nextCursor`, absent on the last page. `hasMore` is true exactly when `nextCursor` is present, and `howToFetchAll` says to pass it (a warning may add a cap raise as the other path, and the model chooses). A call with `cursor` takes no other argument. A page that is served again from LogSeq, because the server no longer holds the snapshot it was cut from, checks that the entry before its start is the last one sent. If it isn't, the page resumes after that entry, or at the same position if the entry is gone, and carries a `cursor_stale` warning: a gap or a repeat between pages is never silent. A result that is not a list the cursor reads (`explore_network` with `to`, `get_graph`, `get_current`, `check_links`) keeps its cut warning with no `howToFetchAll`. The cursor lands with the cursor core task (#528) and each tool's migration PR, which also remove the `offset` and raise wording above as each tool moves. Until a tool has moved, the paragraphs above are what it does.

## Rationale

The reader is an LLM that acts on what it is shown. A result silently cut at a cap looks complete and leads to wrong conclusions. Introduced with the shared `ResultMeta` convention (#40).

## Mechanical enforcement

test: `tests/integration/result-caps.test.ts`
test: `rust/src/truncation.rs`
test: `rust/src/meta.rs`
reviewer: Any new cap, limit or maximum on a tool result reports through `ResultMeta`, and a list a tool can cut is read on with `cursor`.
none-yet: #528 (the cursor core and each tool's migration add the tests: `hasMore` is true exactly when `nextCursor` is present, a cut list reads to the end by repeated calls, and a rebuilt page that finds the list changed carries `cursor_stale`)

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #52 |
| 2026-10-06 | A cut at a hard maximum keeps `hasMore: true` when a paging parameter such as `offset` can fetch the rest, and `howToFetchAll` names it and its value. | #141 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the integration suite and the Rust crate's unit tests with the TypeScript server's removal. Statement unchanged. | #370 |
| 2026-10-08 | Statement: the paths and helper names of the TypeScript server (`src/types.ts`, `metaContent`, `src/utils/result-meta.ts`) are the Rust crate's. The rule is unchanged. | #372 |
| 2026-10-13 | The example of a tool with a bare array and a second `meta` block is `find_blocks`, since `get_backlinks` went (ADR-0037). Nothing else changed. | #529 |
| 2026-10-14 | Adds the cursor paragraph decided by ADR-0038: a cut result is read to the end with `cursor` and `nextCursor`, `hasMore` is true exactly when `nextCursor` is present, and `cursor_stale` is a warning, never a silent gap. The `offset` and raise paragraphs stay what `main` does until each tool moves; the implementation lands with the cursor core task and the tool PRs (#528). | #546 |
