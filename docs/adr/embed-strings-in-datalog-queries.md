# Embed string parameters directly in Datalog query text

## Context

The first Datalog query builders needed a page name inside the query. The obvious way in Datalog is a parameter: `:in $ ?page-name`, with the value passed as an extra argument to `logseq.DB.datascriptQuery`. The first attempt passed the name as a bare string and the query returned zero rows (`docs/datalog-debugging-summary.md`, from commit df7503a). The conclusion drawn at the time was that LogSeq's HTTP API does not support `:in` parameters at all in the same debugging session that fixed a wrong-API bug (`logseq.DB.q` returning `null`).

With `:in` ruled out, the remaining option was to build the value into the query string, for example `[?p :block/name "page-name"]`.

## Decision

We embed string parameters, such as page names, directly in the Datalog query text. Names are lowercased in TypeScript first, because LogSeq stores `:block/name` in lowercase and `clojure.string/lower-case` was also believed to be unavailable.

## Consequences

- Queries work with the API as then understood, and the early tools shipped.
- Any value containing a double quote produces a malformed query (`Unexpected EOF reading string`), and a crafted page name can rewrite the query. Issue #6 recorded this.
- The conclusion was drawn from one failing case. Later probing showed the failure was an encoding problem: LogSeq reads each extra input as EDN, so a bare string is read as a symbol and matches nothing. This ADR was replaced by `strings-bound-via-in-inputs` when that was found.

## Status

superseded by strings-bound-via-in-inputs

Date: 2026-10-05

## Mechanical enforcement

This decision no longer applies, and the code now does the opposite. The mechanism that keeps it from returning is the one that enforces its replacement.

- test: `src/datalog/queries.test.ts` (hostile names stay out of the query text, so embedding fails the test)
- test: `src/client.test.ts` (inputs are EDN-encoded by the client)
