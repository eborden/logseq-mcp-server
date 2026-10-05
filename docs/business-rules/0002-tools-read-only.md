# Tools stay read-only

## Statement

Every tool is declared read-only (`readOnlyHint: true`) and never writes to the graph. Keep each tool's other hints accurate. Most are idempotent, but `logseq_get_current_context` reads the live editor state and is declared `idempotentHint: false`. Adding a tool that writes to the graph is a contract change that needs the maintainer's sign-off.

Every tool call can be repeated safely. The result depends only on LogSeq's state: the graph, or, for `logseq_get_current_context`, what is open in the editor. The server keeps no hidden progress and no cursor, and it never writes. If a tool needs paging, it uses explicit `limit` and `offset` parameters rather than a server-side cursor.

## Rationale

MCP clients retry, and LLMs call the same tool twice. A read-only tool makes that harmless. A write tool would need idempotent design, explicit confirmation semantics and its own review. Introduced with the read-only annotations (#9) and restated as a hard rule in the foundations doc (#38).

## Mechanical enforcement

test: `src/index.test.ts`

The `tool annotations` tests fail unless every registered tool sets `readOnlyHint: true` and a title, and pin the `destructiveHint`, `idempotentHint` and `openWorldHint` values of each tool.

## Changelog

| Date | Change | Issue/PR |
|---|---|---|
| 2026-10-05 | Introduced as read-only annotations on every tool. | #28 |
| 2026-10-05 | Restated as a hard rule and a re-runnable-calls principle in the foundations doc. | #38 |
