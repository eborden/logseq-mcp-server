# Bind Datalog string parameters with :in inputs

## Context

`embed-strings-in-datalog-queries` put page names inside the query text. That broke on any name containing a double quote (`Unexpected EOF reading string`), and a crafted name could rewrite the query (issue #6). It rested on the belief that LogSeq's HTTP API cannot take `:in` parameters.

Probing a live graph (`scripts/probe-constraints.ts`, issue #12) showed that belief was wrong. `:in` works, but LogSeq reads every input after the query string as EDN. A bare string such as `my page` is read as a symbol and matches nothing, which is the "0 rows" the first attempt saw. A JSON string literal such as `"my page"` is also a valid EDN string literal, so `JSON.stringify(value)` produces an input LogSeq reads as a string, including for quotes, backslashes and newlines.

The alternative was to keep embedding strings and escape them. That works with `JSON.stringify`, but leaves values in query text, where one missed call site reintroduces the hole.

## Decision

We bind string parameters with `:in` inputs. `LogseqClient.executeDatalogQuery(query, ...inputs)` sends each input as `JSON.stringify(value)`, and every `DatalogQueryBuilder` method returns `{ query, inputs }` with raw values. Callers pass raw values and never encode them, so there is no double encoding. Lowercasing still happens in TypeScript, in the builders.

Numeric ids are still embedded, in `ground` vectors, because collection `:in` inputs were never probed. They go through `DatalogQueryBuilder.groundIds`, which throws unless every id passes `Number.isInteger`.

Where a string must be used inside a regex, we escape metacharacters first and pass the pattern as an input too.

## Consequences

- Hostile or odd page names (quotes, backslashes, newlines) are data, not query text. Nothing to inject into.
- The query and its parameters travel together as one `DatalogQuery` value and cannot drift apart.
- Builders cannot return a bare string, so callers change from `execute(query)` to `execute(query, ...inputs)`, and mocks assert both.
- A caller who passes a pre-encoded string gets double encoding and a silent miss. The rule lives in CLAUDE.md and in the client tests.
- The wrong earlier conclusion cost real time. We now probe before declaring an API feature unsupported.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/client.test.ts` (exact arguments sent to `callAPI` for strings with quotes, backslashes and newlines)
- test: `src/datalog/queries.test.ts` (the query builders keep hostile names out of the query text)
- test: `tests/integration/datalog-inputs.test.ts` (runs hostile names and `groundIds` against a live graph)
