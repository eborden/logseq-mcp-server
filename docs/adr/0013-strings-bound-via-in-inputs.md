# Bind Datalog string parameters with :in inputs

## Context

[ADR-0006 (embed-strings-in-datalog-queries)](0006-embed-strings-in-datalog-queries.md) put page names inside the query text. That broke on any name containing a double quote (`Unexpected EOF reading string`), and a crafted name could rewrite the query (issue #6). It rested on the belief that LogSeq's HTTP API cannot take `:in` parameters.

Probing a live graph (`scripts/probe-constraints.ts`, issue #12, PR #19) showed that belief was wrong. `:in` works, but LogSeq reads every input after the query string as EDN. A bare string such as `my page` is read as a symbol and matches nothing, which CLAUDE.md constraint 1 later took to explain the earlier failure. A JSON string literal such as `"my page"` is also a valid EDN string literal, so `JSON.stringify(value)` produces an input LogSeq reads as a string, including for quotes, backslashes and newlines.

Issue #6 asked for the fix. Inferred, not recorded as an option weighed: the alternative was to keep embedding strings and escape them. That works with `JSON.stringify`, but leaves values in query text, where one missed call site reintroduces the hole. The foundations doc (PR #38, section 4.11) adds the threat model: arguments from the model are untrusted, and a page name or search string may contain quotes, regex characters or very long text.

## Decision

We bind string parameters with `:in` inputs (commit 3ec3c32). `LogseqClient.executeDatalogQuery(query, ...inputs)` sends each input as `JSON.stringify(value)`, and every `DatalogQueryBuilder` method returns `{ query, inputs }` with raw values. Callers pass raw values and never `JSON.stringify` an input themselves, so there is no double encoding. Page names are lowercased in TypeScript, in the builders, before they are passed.

Two kinds of value are still embedded, each only through a builder that validates it first:

- Numeric ids, in `ground` vectors, because collection `:in` inputs were never probed (3ec3c32). They go through `DatalogQueryBuilder.groundIds`, which throws unless every id passes `Number.isInteger`.
- Block uuids, because `:block/uuid` holds UUID values and no string input matches it (CLAUDE.md, constraint 7). They go through `DatalogQueryBuilder.groundUuids` (issue #18, commit 61f6ad3), which throws unless every uuid matches the strict 8-4-4-4-12 hex pattern before any text is built.

If a string literal must ever be embedded, it goes through `JSON.stringify(value)`.

Where a string must be used inside a regex, we escape metacharacters first (`escapeRegex`, issue #4) and pass the pattern as an input too.

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

- test: `src/client.test.ts` (exact arguments sent to callAPI for strings with quotes, backslashes and newlines)
- test: `src/datalog/queries.test.ts` (the query builders keep hostile names out of the query text, and groundIds rejects non-integers)
- test: `tests/integration/datalog-inputs.test.ts` (runs hostile names and groundIds against a live graph)
- test: `src/datalog/queries.refs.test.ts` (groundUuids rejects malformed uuids before building any text)
- test: `src/utils/escape-regex.test.ts`
- reviewer: A new DatalogQueryBuilder method returns { query, inputs } and binds strings with :in.
