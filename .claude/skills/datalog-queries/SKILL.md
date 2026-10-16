---
name: datalog-queries
description: 'Use when writing, changing or reviewing a Datalog query builder (`queries.rs`), a `ground_ids` or `:in` input, or when a LogSeq query returns 0 rows or errors.'
---

# Datalog queries

LogSeq's Datalog (`logseq.DB.datascriptQuery`) is not standard DataScript. Every query builder in `src/tools/<tool>/queries.rs` and `src/resolve/` follows the rules below. The reasons, the verified tables and the history are in [`docs/datalog.md`](../../../docs/datalog.md): read the constraint it cites before working around one.

## Where to look

- [`docs/datalog.md`](../../../docs/datalog.md): the seven constraints (each with its table and a "Verified" note), the four patterns (two-query, BFS, case-insensitive lookup, no crawls), the migration history and the lessons.
- `scripts/probe-constraints.ts`: read-only probes that reproduce each constraint. Run it against the fixture instance (`npx tsx scripts/logseq-instance.ts start` first); it never falls back to the personal config (BR-0001).
- `src/tools/explore_context/queries.rs`: working query builders to copy from. `src/tools/explore_context/mod.rs` shows the two-query pattern, `src/tools/explore_network/mod.rs` the batched BFS.
- `src/edn.rs`: `PageName`, `PageId`, `JournalDay`, `BlockUuid`, `DatalogInput`, `Query`, `ground_ids`, `ground_uuids`.

## A new query builder

- Write it in the tool's `queries.rs` as a function that returns a `Query { text, inputs }`.
- Take typed values (`PageName`, `PageId`, `JournalDay`, `BlockUuid`), not strings, so a page name is lowercased by construction and an id can only be a whole number.
- Bind strings with `:in` (`DatalogInput`); don't embed them in the query text. Embed ids only through `ground_ids` and uuids through `ground_uuids`.
- Don't use `clojure.string/lower-case`.
- Split queries when data might be empty (the page first, then its blocks); no `or-join` with `ground nil`.
- No `getAllPages` plus per-page crawls. Batch with `[(ground [id1 id2 id3]) [?id ...]]`, one query per depth for a walk.
- When a query returns 0 rows or an error, re-run `scripts/probe-constraints.ts` on the fixture and check the constraint it names before changing the query.

## Queries checklist

Quick reference checklist for future work. Constraint and pattern numbers are those of `docs/datalog.md`.

- [ ] Build page names as `PageName`, which lowercases them, before they reach a query
- [ ] Pass strings as `:in` inputs (`DatalogInput`), never embedded in the query text. `execute_datalog_query` EDN-encodes them (a bare string would be read as a symbol).
- [ ] Embed numeric IDs only through `ground_ids`, which takes `PageId`s
- [ ] Don't use `clojure.string/lower-case`. `includes?`, `starts-with?`, `re-pattern` and `re-find` work.
- [ ] Split queries when data might be empty (don't rely on or-join with ground nil)
- [ ] Send Datalog to `logseq.DB.datascriptQuery`. `logseq.DB.q` takes the simple query DSL and returns `null` for Datalog.
- [ ] Handle empty arrays from queries gracefully (an empty `Vec`; `null` is its own case)
- [ ] Page names in `:block/name` are lowercase, not original casing
- [ ] Use `[(ground [id1 id2 id3]) [?id ...]]` for batch queries
- [ ] Never crawl `getAllPages` + one call per page (Pattern 4)
- [ ] `:with` can't name a variable that's also aggregated in `:find` (error: `:find and :with should not use same variables`)
- [ ] Match `:block/uuid` with `#uuid "..."` literals via `ground_uuids`; strings never match (constraint 7)
- [ ] Remember: LogSeq Datalog ≠ Standard DataScript
