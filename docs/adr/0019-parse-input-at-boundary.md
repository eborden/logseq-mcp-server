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

Tool arguments are parsed into a typed value in one place per tool. In Rust, each tool's input schema is generated from the type its arguments are parsed into (`rust/src/tool.rs`), so the two can't drift, and the parser rejects a wrong-typed value with an error that names the parameter before any LogSeq call (`rust/src/args.rs`). LogSeq's answers are parsed into typed values at the boundary and a mismatch is a `ResponseError`, never "no data" (`rust/src/wire.rs`), and the config file is parsed once (`rust/src/config.rs`). The TypeScript guard that read `src/index.ts` for raw uses of `args` went with the TypeScript server (#356).

- reviewer: New code that reads tool arguments, LogSeq responses, config or disk content parses them into a typed value before any work.
- test: `rust/src/tool.rs` (the schema comes from the type that parses the arguments, parsing ignores unknown fields, treats null as absent and never coerces)
- test: `rust/src/args.rs` (a wrong-typed value is refused with a message that names the parameter)
- test: `rust/tests/get_page_block_calls.rs` (a bad argument is refused before any call)
