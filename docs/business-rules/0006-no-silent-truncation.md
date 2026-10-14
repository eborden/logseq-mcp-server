# Never cut results silently

## Statement

Never cut results silently. Every list-returning tool has a default cap and a maximum, and reports a cap that bites through `ResultMeta` (`rust/src/meta.rs`): `hasMore`, `warnings: [{ code, message, howToFetchAll? }]`, and `totals` where already known (no extra API call just to count). `hasMore` is true only when a warning's `howToFetchAll` names a parameter to raise and a value. Object results get these fields. A tool that returns a bare array keeps it as the first content block and sends `{ "meta": ... }` as a second one (for example `find_blocks`, `rust/src/tools/find_blocks/mod.rs`).

The `warnings` entry is the truncation signal, not `hasMore`. A result cut at a hard maximum carries a warning with `hasMore: false`, and that warning must say the maximum was reached and that the rest can't be fetched in one call. The exception is a paging parameter, such as `offset`, that can fetch the rest. Then `hasMore` is true, the warning still says the maximum was reached, and `howToFetchAll` names that parameter and its value. The warnings are built in `rust/src/truncation.rs`.

**The cursor ([ADR-0038 (one-forward-only-cursor-for-paging)](../adr/0038-one-forward-only-cursor-for-paging.md)).** From v2.0.0, once the cursor core task (#528) and each tool's migration have landed, a cut list can always be read to the end. Every tool that cuts a list takes an optional `cursor` and returns `nextCursor`, absent on the last page. `hasMore` is true exactly when `nextCursor` is present, and `howToFetchAll` says to pass it (a warning may add a cap raise as the other path, and the model chooses). A call with `cursor` takes no other argument. A page that is served again from LogSeq, because the server no longer holds the snapshot it was cut from, checks that the entry before its start is the last one sent. If it isn't, the page resumes after that entry, or at the same position if the entry is gone, and carries a `cursor_stale` warning: a gap or a repeat between pages is never silent. A result that is not a list the cursor reads (`explore_network` with `to`, `get_graph`, `get_current`, `check_links`) keeps its cut warning with no `howToFetchAll`. The cursor lands with the cursor core task (#528) and each tool's migration PR, which also remove the `offset` and raise wording above as each tool moves. Until a tool has moved, the paragraphs above are what it does.

## Rationale

The reader is an LLM that acts on what it is shown. A result silently cut at a cap looks complete and leads to wrong conclusions. Introduced with the shared `ResultMeta` convention (#40).

## Mechanical enforcement

test: `tests/integration/result-caps.test.ts`
test: `rust/src/truncation.rs`
test: `rust/src/meta.rs`
reviewer: Any new cap, limit or maximum on a tool result reports through `ResultMeta`.
reviewer: A tool that has moved to the cursor pages every list it can cut with `cursor` and `nextCursor`.
test: `rust/tests/find_blocks_cursor_calls.rs` (`find_blocks`, the first tool on the cursor: `hasMore` is true exactly when `nextCursor` is present, a cut list reads to the end by repeated calls, and a rebuilt page that finds the list changed carries `cursor_stale`)
test: `rust/src/paging.rs` (the anchor check and the `cursor_stale` warning)
test: `rust/tests/find_pages_cursor_calls.rs` (`find_pages`, the second tool on the cursor: the same promises, and a page added or removed before the position is neither a gap nor a repeat)
test: `rust/tests/get_page_block_cursor_calls.rs` (`get_page` with `detail: "full"` and `get_block` with `include_children`, the third and fourth tools on the cursor: the same promises, every block of a tree several times the budget exactly once in document order, and a page that starts inside a subtree names the blocks it sits under; `hasMore` is true exactly when `nextCursor` is present, except for the `refs_depth_limit` warning of `resolve_refs`, which offers its own way (`get_block` on the refs) and keeps `hasMore` true with no cursor, as before the cursor)
test: `rust/tests/context_cursor_calls.rs` (`explore_context`, the fifth tool on the cursor: the same promises over its three lists, each exactly once and ending on its own page; `hasMore` is true exactly when `nextCursor` is present, except for the `refs_depth_limit` offer of `resolve_refs`; and a list left out with a page size of 0 never makes a cursor)
test: `rust/tests/timeline_cursor_calls.rs` (`explore_timeline`, another tool on the cursor: the same promises, every block of a list several times the budget exactly once in order, a day cut between two pages on both pages with the same date, and a page size of 0 offers its raise alone with `hasMore` false)
none-yet: #556 (`explore_network` moves to the cursor with the same tests of its own list)

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced. | #52 |
| 2026-10-06 | A cut at a hard maximum keeps `hasMore: true` when a paging parameter such as `offset` can fetch the rest, and `howToFetchAll` names it and its value. | #141 |
| 2026-10-08 | Mechanical enforcement: the tests moved to the integration suite and the Rust crate's unit tests with the TypeScript server's removal. Statement unchanged. | #370 |
| 2026-10-08 | Statement: the paths and helper names of the TypeScript server (`src/types.ts`, `metaContent`, `src/utils/result-meta.ts`) are the Rust crate's. The rule is unchanged. | #372 |
| 2026-10-13 | The example of a tool with a bare array and a second `meta` block is `find_blocks`, since `get_backlinks` went (ADR-0037). Nothing else changed. | #529 |
| 2026-10-14 | Adds the cursor paragraph decided by ADR-0038: a cut result is read to the end with `cursor` and `nextCursor`, `hasMore` is true exactly when `nextCursor` is present, and `cursor_stale` is a warning, never a silent gap. The `offset` and raise paragraphs stay what `main` does until each tool moves; the implementation lands with the cursor core task and the tool PRs (#528). | #546 |
| 2026-10-14 | Mechanical enforcement: the cursor tests of `find_blocks`, the first tool on the cursor, replace the `none-yet: #528` line; the remaining `none-yet` points at the next tool's migration. Additive; the Statement is unchanged. | #560 |
| 2026-10-14 | Mechanical enforcement: the cursor tests of `find_pages`, the second tool on the cursor, replace the `none-yet: #551` line; the remaining `none-yet` points at the next tool's migration. Additive; the Statement is unchanged. | #564 |
| 2026-10-14 | Mechanical enforcement: the cursor tests of `get_page` with `detail: "full"` and `get_block` with `include_children`, the third and fourth tools on the cursor, replace the `none-yet: #552` line and name the one exception to `hasMore` being true exactly when `nextCursor` is present (the `refs_depth_limit` warning of `resolve_refs`); the remaining `none-yet` points at the next tool's migration. Additive; the Statement is unchanged. | #565 |
| 2026-10-14 | Mechanical enforcement: the cursor tests of `explore_context`, the fifth tool on the cursor, replace the `none-yet: #553` line; the remaining `none-yet` points at the next tools' migrations. Additive; the Statement is unchanged. | #568 |
| 2026-10-14 | Mechanical enforcement: the cursor tests of `explore_timeline`, another tool on the cursor, are added beside the others, and the `none-yet` line now names only `explore_network`. Additive; the Statement is unchanged. | #566 |
