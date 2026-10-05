# Query the graph with batched Datalog, not per-entity Editor API calls

## Context

The first version of the server used only `logseq.Editor.*` methods. Those return one entity per call, so graph traversal, search and date-range tools cost O(n) HTTP calls for n pages or journal days. Measured on a ~2k-page graph (see CLAUDE.md, "Current Implementation Status"), the old shapes were roughly: ~120 calls for a depth-2 concept network from a hub page, ~130 calls for a text search (about 2k when nothing matched), one call per journal day for a date range, and ~2k calls for a property query. Each call is a local HTTP round trip into a desktop app, and a slow tool is a tool a model stops using.

The alternative was to keep the Editor API and add caching or parallelism. That bounds latency but not call count, and it still has to fetch every page to filter it. LogSeq also exposes `logseq.DB.datascriptQuery`, which runs a Datalog query over the whole DataScript database in one call. Its dialect is narrower than standard DataScript (see CLAUDE.md, "Critical LogSeq Datalog Constraints"), which is a real cost.

History: the move happened in waves. The design in `docs/plans/2025-11-21-datalog-optimization-design.md` first targeted graph traversal and context building (commits df7503a and ff0c96d). An early attempt on 2025-11-20 had gone the other way for `search_blocks` and `query_by_property` (commits 75c5b1f and 39cf948), because `logseq.DB.q`, which was being called with Datalog, returns `null`. That was a wrong-API bug, not a Datalog limit, and was fixed on 2025-11-25 (commit 5dd421c). The remaining crawling tools followed in issues #3, #4, #5 and #33.

## Decision

We run graph traversal, search, date-range and property queries as batched Datalog through `logseq.DB.datascriptQuery`. The number of calls depends on the number of traversal levels or query stages, not on the size of the graph: a breadth-first walk costs at most `maxDepth + 1` calls. Query text lives in `DatalogQueryBuilder` (`src/datalog/queries.ts`).

We keep `logseq.Editor.*` for single lookups where one call is already the minimum, for example `get_page`, `get_block` and linked references.

We never loop over `getAllPages` and then make one call per page.

## Consequences

- A depth-2 concept network from a hub dropped from ~120 calls to 3, a text search from ~130 (or ~2k) to 1, a date range from 1 plus one per day to 2, and a property query from ~2k to 1.
- We work inside LogSeq's Datalog dialect: no `clojure.string/lower-case`, quirky `or-join`, `:in` inputs that need EDN encoding, and results that silently drop `nil` rows. Each of these has cost debugging time. `scripts/probe-constraints.ts` re-checks them after a LogSeq upgrade.
- Query logic moves out of readable TypeScript into query strings, so each builder needs its own unit tests, and shape differences between pulled maps and Editor API entities need explicit conversion.
- Result ordering that used to follow `getAllPages` order now has to be defined by us (for example newest first).

## Status

accepted

Date: 2025-11-21

## Mechanical enforcement

Call-count tests pin the batching, so a crawl that reappears fails a test.

- test: `src/tools/get-concept-network.test.ts` (asserts at most `maxDepth + 1` calls however wide the graph is)
- test: `src/tools/search-blocks.test.ts` (asserts one call per search)
- test: `src/tools/query-by-property.test.ts` (asserts one query)
- test: `src/tools/query-by-date-range.test.ts` (asserts two queries)
