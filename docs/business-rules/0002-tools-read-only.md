# Tools stay read-only

## Statement

Every tool is declared read-only (`readOnlyHint: true`) and never writes to the graph. Keep each tool's other hints accurate. Most are idempotent, but `logseq_get_current` reads the live editor state and is declared `idempotentHint: false`. Adding a tool that writes to the graph is a contract change that needs the maintainer's sign-off.

Every tool call can be repeated safely. The result depends only on LogSeq's state: the graph, or, for `logseq_get_current`, what is open in the editor. The server keeps no hidden progress, and it never writes. Paging is done with explicit `limit` and `offset` parameters.

[ADR-0038 (one-forward-only-cursor-for-paging)](../adr/0038-one-forward-only-cursor-for-paging.md) replaces them, in v2.0.0, with a `cursor` token the caller sends back, and lets the server keep a bounded snapshot cache so a later page costs no LogSeq call. The cache is an optimization, not progress: the result must not depend on it. A cursor call returns the same page while its snapshot lives, and after that the tool reads the page from LogSeq again and says so with a `cursor_stale` warning if the list moved (BR-0006). So a call with a cursor depends on LogSeq's state when its first page was read, and repeating it stays safe. The cursor lands with the cursor core task (#528) and each tool's migration PR. Until a tool has moved, the `limit` and `offset` sentence above is what it does.

## Rationale

MCP clients retry, and LLMs call the same tool twice. A read-only tool makes that harmless. A write tool would need idempotent design, explicit confirmation semantics and its own review. Introduced with the read-only annotations (#9) and restated as a hard rule in the foundations doc (#38).

## Mechanical enforcement

test: `tests/guards/tool-list.test.ts`
test: `rust/src/server.rs`
none-yet: #528 (the cursor core adds the tests that a cursor call is read-only and safe to repeat, and that a page rebuilt without its snapshot is correct)

The recorded `tools/list` test fails unless every tool sets `readOnlyHint: true` and a title, and pins the `destructiveHint`, `idempotentHint` and `openWorldHint` values of each tool. `tools_list_returns_every_tool_read_only` checks the same five things (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint` with its one exception, and the title) on the Rust server's own list, so the live list doesn't depend on the recorded file.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as read-only annotations on every tool. | #28 |
| 2026-10-05 | Restated as a hard rule and a re-runnable-calls principle in the foundations doc. | #38 |
| 2026-10-08 | Mechanical enforcement: the annotation tests of the TypeScript server are replaced by the guard over the recorded tool list and the Rust server's own test. Statement unchanged. The Rust test of the live list now checks every annotation, not only `readOnlyHint`. | #370 |
| 2026-10-12 | The tool name in the Statement follows the rename of `logseq_get_current_context` to `logseq_get_current` (ADR-0037). Nothing else changed. | #517 |
| 2026-10-14 | Statement: paging moves from `limit` and `offset` with no cursor to the cursor and snapshot cache decided by ADR-0038, and "the result depends only on LogSeq's state" gains the cursor call's case. Read-only, no hidden progress and safe repetition are unchanged. The implementation lands with the cursor core task and the tool PRs (#528); until then `limit` and `offset` is what the tools do. | #546 |
