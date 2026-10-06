# Parse external input at the boundary

## Context

The foundations doc (PR #38) set this as hard rule 3 and section 4.2. External input means MCP tool arguments, LogSeq API responses, the config file and anything read from disk. Its reason: "Checks that don't produce a typed result get skipped, duplicated or drift apart. Parsing first means bad input fails before any work is done." Section 4.11 adds that arguments from the model are untrusted: "A page name or search string may contain quotes, regex characters or very long text."

The code didn't meet it when it was written. The audit in issue #58 found tool arguments cast (`args?.x as T`, about 41 places) rather than parsed, and `loadConfig` parsing into `any`. Some parsing already existed: `timeoutMs` validated in the config (PR #26), `InvalidParameterError` for conflicting parameter aliases (issue #44), and string inputs bound with `:in` rather than embedded in query text ([ADR-0013 (strings-bound-via-in-inputs)](0013-strings-bound-via-in-inputs.md)).

## Decision

We parse external input into a typed value once, at the edge, before doing any work. Invalid input fails early with a clear error. A parser is strict about the fields it reads and tolerant of fields it doesn't (foundations, section 4.2).

## Consequences

- Handlers work on typed values, and bad input fails before any API call.
- The parser and a tool's `inputSchema` should come from one definition so they can't drift (section 4.2).
- The gap is real and tracked: #60 for tool arguments, #62 for `callAPI` responses and #63 for the config file. Until they land, new code follows the rule and old code may not.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

Partial coverage today comes from the `InvalidParameterError` tests in `src/index.aliases.test.ts` and `src/tools/query-by-property.test.ts`, and the config tests in `src/config.test.ts`. None of them checks that every input is parsed.

Tool arguments are covered since #60. `src/index.args.guard.test.ts` sends a wrong-typed value for every parameter in tools/list, so a new tool or parameter is covered without editing the test. It requires an error naming the parameter, with no LogSeq call. It also keeps raw `args` reads out of `src/index.ts`. LogSeq responses (#62) and the config file (#63) are not covered yet.

- reviewer: New code that reads tool arguments, LogSeq responses, config or disk content parses them into a typed value before any work.
- test: `src/index.args.guard.test.ts`
