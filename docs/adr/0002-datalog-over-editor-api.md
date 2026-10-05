# Query the graph with batched Datalog, not per-entity Editor API calls

## Context

The first tools (2025-11-20) mixed two APIs. `search_blocks` and `query_by_property` were written against `logseq.DB.q` with a Datalog query (commits 33da3ac and f57f8cf), and were rewritten the same day to crawl the graph with `logseq.Editor.getAllPages` plus `getPageBlocksTree` (commits 75c5b1f and 39cf948). Those commits say only "replace Datalog with stable Editor API"; they don't record why. The traversal tools used `logseq.Editor.*` calls, one per page.

Editor calls return one entity per call, so a crawl costs O(n) HTTP calls for n pages or journal days. Measured on a ~2k-page graph (CLAUDE.md, "Current Implementation Status"), the old shapes were roughly: ~120 calls for a depth-2 concept network from a hub page (issue #3), ~130 calls for a text search and about 2k when nothing matched (issue #4), one call per journal day for a date range (issue #5), and ~2k calls taking ~10s for a property query (issue #33). The foundations doc (PR #38, section 4.6) classes a per-page crawl like that as a bounded-resources bug, not a style issue.

LogSeq also exposes `logseq.DB.datascriptQuery`, which runs a Datalog query over the whole DataScript database in one call. Its dialect is narrower than standard DataScript (CLAUDE.md, "Critical LogSeq Datalog Constraints"). Inferred, not recorded: the obvious alternative was to keep the Editor API and add caching or parallelism, which bounds latency but not call count, and still fetches every page to filter it.

History. The decision was made for traversal and context building first, then extended:

- 2025-11-21: the design in `docs/plans/2025-11-21-datalog-optimization-design.md` and commits df7503a and ff0c96d moved `get_concept_network` and `build_context` to batched Datalog. The same work found that `logseq.DB.q` returns `null` for Datalog and switched the client to `logseq.DB.datascriptQuery` (`docs/datalog-debugging-summary.md`, from df7503a).
- 2025-11-24: commit 4cd7321 moved `get_concept_network`'s connection lookup back to one `getPageLinkedReferences` call per page, after an `or-join` query returned nothing for pages with no matches in one branch. That is the per-frontier crawl issue #3 later describes.
- 2025-11-25: commit 5dd421c replaced the remaining `logseq.DB.q` calls in `get_concept_evolution` and `get_context_for_query`.
- 2026-10-05: the crawling tools were converted: `get_concept_network` to batched BFS (issue #3, commit c77c99b), `search_blocks` (issue #4, commit 4dd713d), `query_by_date_range` (issue #5, commit ea75b75) and `query_by_property`, the last crawling tool (issue #33, commit e8c85bb).

The Status date is the start of the decision. The search, date-range and property parts date from 2026-10-05.

## Decision

We run graph traversal, search, date-range and property queries as batched Datalog through `logseq.DB.datascriptQuery`. The number of calls depends on the number of traversal levels or query stages, not on the size of the graph: a breadth-first walk costs at most `maxDepth + 1` calls. Query text lives in `DatalogQueryBuilder` (`src/datalog/queries.ts`).

We never call `logseq.Editor.getAllPages` and then make one call per page. We filter inside the query (`includes?`, `re-find`, `get`, `contains?`) or batch ids with `[(ground [ids...]) [?id ...]]`.

We keep `logseq.Editor.*` for single lookups where one call is already the minimum, for example `get_page`, `get_block` and linked references.

## Consequences

- A depth-2 concept network from a hub dropped from ~120 calls to 3, a text search from ~130 (or ~2k) to 1, a date range from 1 plus one per day to 2, and a property query from ~2k to 1.
- We work inside LogSeq's Datalog dialect: no `clojure.string/lower-case`, quirky `or-join`, `:in` inputs that need EDN encoding, and results that silently drop `nil` rows. Each of these cost debugging time, and 4cd7321 shows one of them reversing the decision for a while. `scripts/probe-constraints.ts` re-checks them after a LogSeq upgrade.
- Query logic moves out of readable TypeScript into query strings, so each builder needs its own unit tests, and shape differences between pulled maps and Editor API entities need explicit conversion.
- Result ordering that used to follow `getAllPages` order now has to be defined by us (for example newest first, commit 9842b34).

## Status

accepted

Date: 2025-11-21

## Mechanical enforcement

Call-count tests pin the batching, so a crawl that reappears fails a test.

- test: `src/tools/get-concept-network.test.ts` (one query per depth, so at most maxDepth + 1 calls however wide the graph is)
- test: `src/tools/search-blocks.test.ts` (one call per search, and never getAllPages or getPageBlocksTree)
- test: `src/tools/query-by-property.test.ts` (one query)
- test: `src/tools/query-by-date-range.test.ts` (two queries)
- reviewer: A new tool makes a bounded number of API calls and never loops a call over graph entities.
