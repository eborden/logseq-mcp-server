# Mark capped results with one shared ResultMeta convention

## Context

Several tools cap their output: `build_context` (blocks, references, related pages), `search_blocks` (`limit`), `get_concept_network` (nodes and fanout), and the `connected-within` search. They used to cut results off silently with a `.slice` or a `break`. A model reading a capped list cannot tell "these are all the matches" from "these are the first 50 of 400", and so it reasons from an incomplete picture as if it were complete. Two tools had already invented their own signals (`warnings` in `get_context_for_query`, `truncated` in `get_concept_network`).

Issue #40 (part of #13) asked for one convention that aligns with those two existing signals (`warnings` from #10, `truncated` from #3), with real totals where they are cheap, and said: "Never report `has_more` without a way to continue: give an offset or limit hint." It also asked for the change to be additive. The implementation (commit 809dae0) took the limit hint: `howToFetchAll` names the parameter to raise and a value. No source records paging being weighed or rejected. The foundations doc (PR #38, section 4.5) leaves room for it: "If a tool needs paging, use explicit `limit` and `offset` parameters rather than a server-side cursor."

## Decision

Capped or partial results carry a `ResultMeta` (`src/types.ts`): `hasMore: boolean`, `warnings: [{ code, message, howToFetchAll? }]`, and optional `totals` with real counts.

- `hasMore` is derived from the warnings (`buildResultMeta`): it is true only when a warning carries `howToFetchAll`, the tool parameter to raise and a suggested value. We never report `hasMore` without a way to continue.
- `totals` come from data the tool already fetched. No tool makes an extra call for them.
- Object results carry the fields directly. Tools that return a bare array keep the array as the first MCP content block, unchanged, and add `{ "meta": ... }` as a second block (`metaContent`).
- Existing fields stay: `get_concept_network` keeps `truncated` and gains `hasMore` and `warnings` beside it.
- When a cap cannot be raised, the warning has no `howToFetchAll` and `hasMore` stays false. It points at a narrower request instead.
- Empty `hasMore: false` and `warnings: []` stay in slim output, because they are the positive signal that nothing was cut.

## Consequences

- A model can tell a complete result from a cut one, and knows which parameter to raise.
- Additive: no existing field or shape changed, so clients that ignore `meta` work as before.
- Clients that only read the first content block of an array result never see the warning. We accepted that and left the array block unchanged.
- Each new capped tool must add a cap warning and a test for under, at and over the cap. When nothing is cut, a result still carries `,"hasMore":false,"warnings":[]`, 30 characters by construction.
- A cap that cannot be raised leaves `hasMore` false even though results were cut. The warning is the only signal there.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/utils/result-meta.test.ts` (hasMore only with a way to continue)
- test: `src/truncation-meta.test.ts` (the array stays the first block and a meta block follows, through MCP)
- test: `src/index.slim-default.test.ts` (empty hasMore and warnings stay in slim output)
