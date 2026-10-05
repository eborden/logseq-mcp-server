# Write tool results as minified JSON

## Context

Every tool result goes into the model's context window. The first handlers serialized results with `JSON.stringify(result, null, 2)`. Commit c8543fb (2026-01-23) removed that pretty-printing from every tool handler and from the error handler, "reducing token usage by 15-20% for large responses", and kept pretty-printing only in the development scripts, for debugging.

Issue #13 (section 1) and issue #42 later asked to "emit minified JSON" alongside slim output. PR #72 found nothing left to change ("every handler already used `JSON.stringify(result)` with no spacing argument") and added `src/index.minified.test.ts` (commit 095b63f) so it stays that way.

## Decision

Tool results are `JSON.stringify(result)` with no spacing argument, including error results and ambiguous-page results. Pretty output would need an opt-in parameter and an exemption in `src/index.minified.test.ts`. Development scripts may pretty-print.

## Consequences

- Results carry no layout whitespace, so the reader spends no tokens on it.
- Raw tool output is harder for a person to read. Inferred: nobody reads it raw except while debugging, and the scripts cover that.
- A handler that adds a spacing argument fails a test rather than a review.

## Status

accepted

Date: 2026-01-23

## Mechanical enforcement

- test: `src/index.minified.test.ts` (runs every tool through the MCP server, plus the error and ambiguous-page results, and fails on layout whitespace)
