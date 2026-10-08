# Embed string parameters directly in Datalog query text

## Context

The first Datalog query builders needed a page name inside the query. The usual way in Datalog is a parameter: `:in $ ?page-name`, with the value passed as an extra argument to `logseq.DB.datascriptQuery`.

What each source records:

- `df7503a:docs/datalog-debugging-summary.md` (added in commit df7503a, 2025-11-21) says only that "LogSeq's HTTP API doesn't support `:in` parameters in queries", and that the fix was to embed values in the query string. It doesn't say how `:in` was tried or what it returned. The same document records the wrong-API bug (`logseq.DB.q` returning `null`) fixed in that session.
- Commit c108174 (2025-11-24) tried `:in` again, passing lowercased page names as extra arguments to `datascriptQuery` unencoded, as bare strings. Commit d6c3151, the same day, removed those `:in` clauses and went back to names "embedded in queries". Neither message says why `:in` was dropped.
- CLAUDE.md, constraint 1, written later from probing (issue #12, PR #19), explains the failure: a bare string input is read as an EDN symbol and matches nothing. That is a retrospective reading, not something recorded at the time.

With `:in` ruled out, the remaining option was to build the value into the query string, for example `[?p :block/name "page-name"]`.

## Decision

We embed string parameters, such as page names, directly in the Datalog query text. Names are lowercased in TypeScript first, because LogSeq stores `:block/name` in lowercase and, as c108174 records, "LogSeq's DataScript doesn't support clojure.string/lower-case".

## Consequences

- Queries work with the API as then understood, and the early tools shipped.
- Any value containing a double quote produces a malformed query (`Unexpected EOF reading string`), and a crafted page name can rewrite the query. Issue #6 recorded this.
- The conclusion was drawn without a working encoding ever being tried. Later probing showed the failure was an encoding problem: LogSeq reads each extra input as EDN, so a bare string is read as a symbol and matches nothing. This ADR was replaced by [ADR-0013 (strings-bound-via-in-inputs)](0013-strings-bound-via-in-inputs.md) when that was found.

## Status

superseded by 0013-strings-bound-via-in-inputs

Date: 2026-10-05

## Mechanical enforcement

This decision no longer applies, and the code now does the opposite. The mechanism that keeps it from returning is the one that enforces its replacement.

- test: `rust/src/edn.rs` (a hostile name is quoted as one string, so it can't reach the query text)
- test: `rust/src/resolve/queries.rs` (the resolver's queries bind the lowercased name as an input)
- test: `rust/src/client.rs` (`sends_datalog_inputs_as_edn_after_the_query`: inputs are EDN-encoded by the client)
