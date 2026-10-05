# Bound every call, loop and result

## Context

Two problems came first, each fixed in its own tool:

- Issue #8: `LogseqClient.callAPI` called `fetch` with no timeout, so a hung LogSeq blocked a tool call forever. PR #26 added `AbortSignal.timeout(timeoutMs)` to every call, a configurable `timeoutMs` with a default of 30000 ms ("generous because Datalog and BFS queries on large graphs can be slow"), and `LogSeqTimeoutError`. The timeout is per call, so PR #26 notes that a tool making many calls is not capped as a whole.
- Issue #3: `get_concept_network` grew with the number of nodes, and journal pages link to almost everything. PR #25 added `maxNodes` (default 50, "a size an LLM can read as JSON"), a per-page fanout cap (default 15), journal pages as leaves and a `truncated` flag. CLAUDE.md records that an uncapped depth-2 walk from one hub reached ~550 nodes.

The foundations doc (PR #38) then made it general, as hard rule 5 and section 4.6. Its reason: "An unbounded call hangs the client. An unbounded result floods the model's context. You can't tell a slow dependency from a dead one, so you must choose when to give up." Issue #61 lists the tool results that are still unbounded.

## Decision

Every network call has a timeout: `callAPI` applies `timeoutMs` to each call. Because that bounds each call and not a whole tool, the number of calls is bounded too (see `datalog-over-editor-api`). Every loop over graph data has a cap. Every tool result has a size limit, with a default and a maximum. There is no unbounded `Promise.all` over input-sized collections.

A cap that cuts a result reports it (see `resultmeta-for-capped-results`).

## Consequences

- A stuck LogSeq surfaces as `LogSeqTimeoutError` after `timeoutMs` instead of a hung tool call.
- Results can be cut, so every cap needs a warning and a test for under, at and over the cap.
- Cap values are tuning decisions. Issue #61 notes that "a new default cap changes what existing callers receive, so each one is a behavior change".
- The code doesn't meet this everywhere yet: issue #61 tracks the unbounded results.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/client.test.ts` (the default and configured timeoutMs reach AbortSignal.timeout, including against a server that never answers)
- test: `src/tools/get-concept-network.test.ts` (maxNodes default and exact stop, truncation flag and warning)
- reviewer: A new loop over graph data has a cap, and a new tool result has a default and a maximum.
- none-yet: #61
