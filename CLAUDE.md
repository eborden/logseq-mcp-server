# LogSeq MCP Server - Technical Context

## Privacy: Never Commit Details From the Personal Graph

The LogSeq instance this server is developed against is the maintainer's **personal** graph. Integration tests, probes and scripts read real data from it. None of that data may leave the machine through this repo or its GitHub project.

**Never put any of the following in committed files** (code, tests, fixtures, docs, skills, CLAUDE.md), **commit messages, GitHub issues, PR descriptions or comments:**
- Page names, journal titles, tags or property values from the graph
- Block content, quotes or paraphrases of what the graph says
- People's names (journals mention real colleagues, friends and family)
- Dates of specific journal entries, or anything that reveals what happened on a given day
- Raw output from `scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts` or integration-test runs. Their output includes real page names.

**Do instead:**
- Use made-up examples: `"Alice"`, `"Bob"`, `"my page"`, `"project atlas"`, `"20250101"`.
- Report measurements as approximate aggregates without names: "~2k-page graph", "a hub page with ~100 neighbours", "~120 API calls".
- When a test needs data shaped like the real graph, write a synthetic fixture. Don't copy an entity.
- Before committing or posting anything, grep the diff and text for names you saw in tool output during the session.

**Already in git history:** older commits contain a few real page names that have since been replaced with fictional ones. Removing them would require rewriting history, which is the maintainer's call, not something to do on your own.

---

## Overview

This is an MCP (Model Context Protocol) server that provides Claude with 14 tools for querying LogSeq knowledge graphs. Built with TypeScript, it uses LogSeq's HTTP API and DataScript query engine to enable efficient graph traversal and context building.

**Key Stats:**
- 14 MCP tools for graph operations, search, and temporal queries
- Unit tests (`npx vitest run src`) plus integration tests against a live graph (`npm run test:integration`). `npm test` runs both.
- Mostly Datalog: graph traversal, search and date-range queries run as batched Datalog. A few single lookups use `logseq.Editor.*` (see "Current Implementation Status" below)

**Architecture:**
```
Claude (via MCP) → HTTP API → LogSeq Desktop → DataScript Database
```

The server translates high-level queries (e.g., "get context for topic") into calls against LogSeq's HTTP API: Datalog queries via `logseq.DB.datascriptQuery` where implemented, and `logseq.Editor.*` methods elsewhere.

## Why Datalog?

### Performance Goal
- **Editor API:** Sequential API calls - O(n) calls for n entities
- **Datalog:** Batched queries - O(maxDepth) calls regardless of graph size

### Current Implementation Status

Traversal, search and date-range tools now run as batched Datalog queries. `logseq.Editor.*` is still used for single lookups: `get_page`, `get_block`, `get_backlinks`, linked references in `build_context`, the fuzzy-match page list on "not found", and the two block fetches after `connected-within` finds a match. No tool crawls the graph any more.

Measured with `npx tsx scripts/measure-api-calls.ts` (Oct 2026, ~2k-page graph, hub page with ~100 direct neighbours):

| Tool | API calls | Time | Notes |
|---|---|---|---|
| `build_context` | 3 | ~0.2s | 2 Datalog + 1 linked refs |
| `get_context_for_query` (1 topic) | 3 | ~0.1s | Delegates to `build_context` |
| `get_concept_network` depth=1 | 2 | ~0.1s | Default caps: 16 nodes |
| `get_concept_network` depth=2 | 3 | ~0.2s | One batched query per depth, both directions. Default caps: 50 nodes. Was ~120 calls (#3) |
| `search_blocks` | 1 | ~0.1s | One case-insensitive regex query. Was ~130 calls, or ~2k for a search with no match (#4) |
| `query_by_date_range` (7 days) | 2 | ~0.2s | Journal pages + blocks, tree rebuilt in TypeScript. Same at 30 or 90 days. Was 1 + journal days (#5) |
| `search_by_relationship` | 1 | | `references` / `in-pages-linking-to`. `connected-within` is O(maxDistance) (#7) |
| `query_by_property` | 1 | ~0.02s | One query over `:block/properties`, page name inline. Blocks are flat (no `children`). Was ~2k calls, ~10s (#33) |
| `resolve_refs: true` on `get_block`, `get_page` (with children), `build_context`, `query_by_date_range` | +0 to +2 | ~0.03-0.1s | Opt-in (#18). One batched query per nesting level, depth 2: +1 when the refs point at plain blocks, +2 when those hold refs of their own, +0 when nothing in the result has a ref. Same cost for 1 day or 30. Off: calls and output unchanged |
| `get_current_context` | 3-4 | ~0.01s | 3 Editor calls (`getCurrentPage`, `getCurrentBlock`, `getSelectedBlocks`) + 1 Datalog pull by `:db/id` only when a block's page isn't the open page (#15) |

Re-run the script after changing any of these tools, and update this table.

### Trade-offs
- **Pros:** Massive performance gains, expresses graph logic naturally, fewer round-trips
- **Cons:** More constraints than standard DataScript, requires workarounds for limitations
- **Decision:** Performance gains outweigh constraints for this use case

## Critical LogSeq Datalog Constraints

LogSeq's Datalog implementation (via `logseq.DB.datascriptQuery`) has significant limitations compared to standard DataScript. Understanding these constraints is essential for writing working queries.

Every constraint below marked **Verified** is reproduced by `npx tsx scripts/probe-constraints.ts` (read-only, needs a running LogSeq). Re-run it after LogSeq upgrades.

### 1. `:in` Parameters Need EDN-Encoded Inputs

`:in` works, but LogSeq reads every input passed after the query string as EDN. A bare string is read as a **symbol**, so it matches nothing.

| Call | Rows |
|---|---|
| `datascriptQuery(query-with-embedded-literal)` | 1 |
| `datascriptQuery(query-with-:in, "my page")` (bare string) | **0** |
| `datascriptQuery(query-with-:in, "\"my page\"")` (EDN-quoted) | 1 |

**Verified.** The "0 results" recorded in commit c108174 matches the bare-string case: the original example passed `'my-page'` unquoted.

**Current practice:** string parameters go through `:in`. `LogseqClient.executeDatalogQuery(query, ...inputs)` sends each input as `JSON.stringify(value)` (a JSON string literal is also a valid EDN string literal), and every `DatalogQueryBuilder` method returns `{ query, inputs }`:
```typescript
const { query, inputs } = DatalogQueryBuilder.getPage(pageName); // inputs: [pageName.toLowerCase()]
await client.executeDatalogQuery(query, ...inputs);
// query: [:find (pull ?page [*]) :in $ ?page-name :where [?page :block/name ?page-name]]
```

Pass raw values as inputs. The client does the EDN encoding, so never `JSON.stringify` an input yourself (it would be encoded twice). See constraint 6 for what is still embedded.

---

### 2. Most clojure.string Functions Work; `lower-case` Does Not

| Function | Result |
|---|---|
| `clojure.string/lower-case` | **Error:** `Unknown function 'clojure.string/lower-case` |
| `clojure.string/starts-with?` | Works |
| `clojure.string/includes?` | Works, including on `:block/content` |
| `re-pattern` + `re-find`, e.g. `"(?i)foo"` | Works (case-insensitive matching) |

**Verified.** Lowercase in TypeScript before passing the name to the query. Use `includes?` or `re-find` to filter content inside a query instead of fetching every page's blocks.

**DON'T (lower-case doesn't work):**
```clojure
[:find (pull ?page [*])
 :in $ ?page-name
 :where
 [(clojure.string/lower-case ?page-name) ?page-name-lower]  ; ← Error: "Unknown function"
 [?page :block/name ?page-name-lower]]
```

**Error message:**
```
LogSeq API error: Unknown function 'clojure.string/lower-case in [(clojure.string/lower-case ?page-name) ?page-name-lower]
```

**DO (process in TypeScript):**
```typescript
// Pre-process in TypeScript
const pageNameLower = pageName.toLowerCase();

// Pass the pre-processed value as an :in input
const query = `[:find (pull ?page [*])
                :in $ ?page-name
                :where
                [?page :block/name ?page-name]]`;
await client.executeDatalogQuery(query, pageNameLower);
```

**Why:** LogSeq's DataScript exposes only some of `clojure.string`. `lower-case` is missing, while `includes?`, `starts-with?`, `re-pattern` and `re-find` are present.

**References:**
- Discovered in: commit c108174 integration tests
- Probe: `scripts/probe-constraints.ts`

---

### 3. or-join with ground nil Fails for Optional Bindings

The pattern `(or-join [?x ?y] ... [(ground nil) ?y])` doesn't work as expected for creating optional bindings.

**DON'T (returns 0 results for pages without blocks):**
```clojure
[:find (pull ?page [*]) (pull ?block [*])
 :where
 [?page :block/name "my-page"]

 ;; Attempt to make ?block optional
 (or-join [?page ?block]
   [?block :block/page ?page]
   [(ground nil) ?block])]  ; ← Doesn't work as expected
```

**Problem:** When a page has no blocks:
1. `[?block :block/page ?page]` fails
2. Fallback `[(ground nil) ?block]` binds `?block` to `nil`
3. `(pull ?block [*])` on `nil` returns `nil`
4. LogSeq filters out result rows containing `nil`
5. **Result:** Query returns 0 results (should return page with no blocks)

**DO (split into separate queries):**
```typescript
// Query 1: Get the page (always succeeds if page exists)
const page = DatalogQueryBuilder.getPage(pageName);
const pageResults = await client.executeDatalogQuery(page.query, ...page.inputs);

if (!pageResults || pageResults.length === 0) {
  throw new Error(`Page not found: ${pageName}`);
}

// Query 2: Get blocks (may be empty array)
const blocksQuery = DatalogQueryBuilder.getPageBlocks(pageName);
const blockResults = await client.executeDatalogQuery(blocksQuery.query, ...blocksQuery.inputs);

// Handle empty results gracefully
const blocks = (blockResults || []).map(r => r[0]);
```

**Why:** LogSeq's Datalog filters out nil values from results, making optional binding patterns impossible. The solution is to split into separate queries and handle empty arrays.

**References:**
- Discovered in: commit d6c3151 "fix: handle pages without blocks"
- Pattern used in: `buildContextForTopic` in `src/tools/build-context.ts` (page query, then blocks query)
- Empty pages are common: in a journal-heavy graph, most non-journal pages may have no file at all (they exist only as link targets)

---

### 4. Datalog Goes to logseq.DB.datascriptQuery; logseq.DB.q Takes the Simple Query DSL

`logseq.DB.q` is LogSeq's *simple query* engine (the `{{query ...}}` language), not a Datalog endpoint.

| Call | Result |
|---|---|
| `DB.q` with a Datalog string | `null` |
| `DB.q` with `(task TODO)` | 30 blocks |
| `DB.q` with `[[page name]]` | 10 blocks |
| `datascriptQuery` with Datalog | Works |

**Verified.**

**DO:**
```typescript
await client.callAPI('logseq.DB.datascriptQuery', [datalogQuery]);
```

**Don't** treat a `null` from `DB.q` as "no results". It usually means the wrong dialect was sent.

**References:**
- Implemented in: `executeDatalogQuery()` in `src/client.ts`

---

### 5. Page Names are Stored Lowercase in :block/name

LogSeq normalizes page names to lowercase in the `:block/name` attribute, but preserves original casing in `:block/original-name`.

**Schema:**
```
Page entity:
  :block/name          - Lowercase normalized name (e.g., "alice")
  :block/original-name - Original casing (e.g., "Alice")
  :db/id              - Numeric ID
```

**Best Practice for Case-Insensitive Lookup:**
```typescript
// Accept any casing from user
function getPage(pageName: string) {
  // Lowercase before passing it as an :in input
  const pageNameLower = pageName.toLowerCase();

  return {
    query: `[:find (pull ?page [*])
             :in $ ?page-name
             :where
             [?page :block/name ?page-name]]`,
    inputs: [pageNameLower]
  };
}

// All these work correctly:
getPage('Alice')  // ✅ Finds "alice"
getPage('alice')  // ✅ Finds "alice"
getPage('ALICE')  // ✅ Finds "alice"
```

**Why:** This matches LogSeq's own behavior - the UI is case-insensitive because it lowercases before lookup.

**References:**
- Pattern established in: commit ff0c96d
- Used throughout: `src/datalog/queries.ts` (all query builders)

---

### 6. Don't Embed Strings; Escape Anything You Must

Embedding a string that contains `"` in the query text produces a malformed query:

```
[?p :block/name "foo "bar"]   →  LogSeq API error: Unexpected EOF reading string starting ""]].
```

**Verified.** `JSON.stringify(value)` produces a valid EDN string literal for quotes, backslashes and newlines, and the escaped form runs correctly.

**DO:** pass strings as `:in` inputs (constraint 1). The client does the escaping, and the value is never part of the query text, so there is nothing to inject into. All of `src/datalog/queries.ts` works this way.

- Numeric IDs are still embedded, in `ground` vectors, because collection `:in` inputs are unprobed. Build them with `DatalogQueryBuilder.groundIds(ids)`, which throws unless every id passes `Number.isInteger`. Bind the ids straight to the entity variable (`groundIds(ids, '?p')` followed by a pattern on `?p`). `[?p :db/id ?id]` matches nothing, and a query whose only clause is the `ground` binding errors.
- If you ever must embed a string literal, use `JSON.stringify(value)`. A string used inside `re-pattern` also needs regex metacharacters escaped first (#4).

---

### 7. `:block/uuid` Holds UUID Values, Not Strings

`:block/uuid` is a UUID type. A string never matches it, whatever the binding form:

| Call | Rows |
|---|---|
| `[(ground ["<uuid>"]) [?u ...]] [?b :block/uuid ?u]` | **0** |
| `[(ground [#uuid "<uuid>"]) [?u ...]] [?b :block/uuid ?u]` | 1 |
| `[(ground [#uuid "<known>" #uuid "<absent>"]) [?u ...]] ...` | 1 (absent ones just have no row) |
| `:in $ [?u ...]` with a JSON string collection | **0** |
| `[(uuid ?s) ?u]` | **Error:** `Unknown function 'uuid` |

**Verified** (`scripts/probe-constraints.ts`). The sketch in #18 used plain strings and would match nothing.

**Current practice:** `DatalogQueryBuilder.groundUuids(uuids, '?u')` embeds `#uuid "..."` literals. It throws unless every uuid matches the strict 8-4-4-4-12 hex pattern first, and that pattern rules out quotes, brackets and whitespace, so nothing can escape the literal. Page names for embeds still go through `:in $ [?n ...]` (a string collection works for names), with the or-join head `[?e ?n]`. Block uuids come back from pulls as plain strings. See `DatalogQueryBuilder.refTargets` and `src/utils/resolve-refs.ts`.

---

## Design Patterns

### Pattern 1: Two-Query Pattern for Optional Data

When related data might not exist (e.g., pages without blocks, pages without connections), split into separate queries rather than using complex or-join patterns.

**Implementation:**
```typescript
// Step 1: Get the main entity
const mainEntity = DatalogQueryBuilder.getPage(pageName);
const mainResults = await client.executeDatalogQuery(mainEntity.query, ...mainEntity.inputs);

if (!mainResults || mainResults.length === 0) {
  throw new Error(`Entity not found`);
}

const entity = mainResults[0][0];

// Step 2: Get related data (may be empty)
const related = DatalogQueryBuilder.getRelatedData(pageName);
const relatedResults = await client.executeDatalogQuery(related.query, ...related.inputs);

// Handle empty results
const relatedData = (relatedResults || []).map(r => r[0]);
```

**Benefits:**
- Works with empty data (no or-join complexity)
- Clear separation of concerns
- Easy to debug and test
- Matches HTTP API pattern

**Used in:**
- `buildContextForTopic` in `src/tools/build-context.ts`: page query, blocks query, then linked references via `getPageLinkedReferences`

---

### Pattern 2: Multi-Query BFS for Graph Traversal

Instead of recursive queries or N sequential API calls, use BFS with batched queries at each depth level.

> **Implemented in `get-concept-network.ts` (#3).** Caps matter: journal pages link to almost everything, and an uncapped depth-2 walk from one hub reached ~550 nodes once outbound links were followed. Defaults are `maxNodes` 50 (root included) and `maxFanout` 15 new pages per page. Journal pages are leaves unless `expandJournals` is set, and `truncated: true` is set whenever a cap bites. MCP clients set them with `max_nodes` (≤ 500), `max_fanout` (≤ 100) and `expand_journals` on `logseq_get_concept_network`.

**Traditional Approach (Inefficient):**
```typescript
// For each page, get connections one at a time
for (const page of pages) {
  const connections = await getConnections(page);  // N calls
}
```

**Datalog BFS Approach (Efficient):**
```typescript
let currentFrontier = [rootId];

for (let depth = 1; depth <= maxDepth; depth++) {
  // Query ALL pages at current depth in ONE call
  const query = DatalogQueryBuilder.getConnectedPages(currentFrontier);
  const results = await client.executeDatalogQuery(query);

  // Process results for next depth
  currentFrontier = extractNewPages(results);
}
```

**Performance:** at most maxDepth + 1 calls, asserted by a unit test. Depth 2 from a hub with ~100 neighbours takes 3 calls, down from ~120.

**Query Builder Pattern (simplified):**
```typescript
static getConnectedPages(pageIds: number[]): string {
  return `[:find (pull ?source [*]) (pull ?connected [*]) ?rel-type
           :where
           [(ground [${pageIds.join(' ')}]) [?source-id ...]]
           [?source :db/id ?source-id]

           (or-join [?source ?connected ?rel-type]
             ;; Outbound: blocks on source page that reference other pages
             (and [?block :block/page ?source]
                  [?block :block/refs ?connected]
                  [?connected :block/name]
                  [(ground "outbound") ?rel-type])

             ;; Inbound: blocks on other pages that reference source
             (and [?block :block/refs ?source]
                  [?block :block/page ?connected]
                  [?connected :block/name]
                  [(ground "inbound") ?rel-type]))]`;
}
```

**Real implementation:** `DatalogQueryBuilder.connectedPages` and `getConceptNetwork`. Frontier ids are bound with `groundIds` directly to the entity variable (see constraint 6), and each page pair gets one edge with a reference count.

---

### Pattern 3: Case-Insensitive Lookup

Always lowercase page names before passing them to queries to match LogSeq's normalization.

**Standard Pattern:**
```typescript
export function buildQuery(pageName: string): DatalogQuery {
  const pageNameLower = pageName.toLowerCase();

  return {
    query: `[:find (pull ?page [*])
             :in $ ?page-name
             :where
             [?page :block/name ?page-name]]`,
    inputs: [pageNameLower]
  };
}
```

**Used in:** `conceptNetwork()`, `getPage()`, `getPageBlocks()` and `getBlocksReferencingPage()` in `src/datalog/queries.ts`.

**Also case-insensitive:** `search_by_relationship` matches `:block/refs` against lowercased names (#7), and `search_blocks` uses a `(?i)` regex (#4).

---

### Pattern 4: No Per-Page Crawls

Never call `logseq.Editor.getAllPages` and then make one call per page. On a ~2k-page graph, `query_by_property` used to make ~2k calls (one per page) and take ~10s this way (#33).

Use one Datalog query, filtering in the query with `includes?` / `re-find` / `get` / `contains?`, or batched queries with `[(ground [ids...]) [?id ...]]`. No tool crawls any more.

---

## Migration History

### Phase 1: HTTP-Only Implementation (Initial)
- Sequential API calls using `logseq.Editor.*` methods
- Simple but slow (N API calls for N entities)

### Phase 2: Dual Implementation with Feature Flags (Nov 21, 2024)
- Added Datalog implementations alongside HTTP
- Feature flags for gradual rollout per tool
- Property-based equivalence testing (18 tests)
- **Commits:** df7503a "feat: add Datalog optimization with property-based testing"

### Phase 3: Datalog-Only Simplification (Nov 21, 2024)
- Removed feature flag architecture
- Removed HTTP implementations
- Embedded Datalog directly in tools
- Net: -1,110 lines of code
- **Commits:** 37fe0d6 "refactor: simplify to direct Datalog implementation"

### Phase 4: Bug Fixes (Nov 24, 2024)
- Fixed case-sensitivity issues
- Fixed empty page handling
- **Commits:**
  - c108174 "fix: implement case-insensitive page lookup" (reverted)
  - d6c3151 "fix: handle pages without blocks by splitting into separate queries"

### Phase 5: Tool Simplification (Nov 24, 2024)
- Removed redundant get_entity_timeline (subset of get_concept_evolution)
- Removed incomplete get_related_pages (replaced by get_concept_network)
- Net: -2 tools, -195 lines
- **Result:** 13 → 11 tools (15% reduction)
- **Commits:**
  - 9642558 "refactor: remove redundant get_entity_timeline tool"
  - 34a699a "refactor: remove incomplete get_related_pages tool"
- Later work added tools back. There are 14 registered in `src/index.ts` today.

### Phase 6: Comparison With Other PKM MCP Servers (Oct 2026)
- Reviewed 11 LogSeq, Obsidian, Roam, Notion, Tana and Basic Memory MCP servers
- Probed the Datalog constraints and measured API calls against a live graph (`scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`), which corrected constraints 1, 2 and 4
- Roadmap tracked in GitHub issues #3–#18

### Lessons Learned

1. **LogSeq's Datalog ≠ Standard DataScript**
   - `:in` inputs must be EDN-encoded (bare strings become symbols)
   - Only part of `clojure.string` is available (`lower-case` is missing)
   - or-join semantics differ
   - Probe before concluding something "doesn't work": the original conclusions on `:in` and `clojure.string` were over-generalized from a single failing case

2. **Simple is Better**
   - Multiple simple queries > One complex query
   - Explicit > Clever (no fancy or-join tricks)
   - Two queries that always work > One query that sometimes works

3. **Test with Real Data**
   - Property-based tests discovered edge cases
   - Empty pages revealed or-join limitations
   - Case sensitivity found through integration testing

4. **Feature Flags Added Complexity**
   - Maintained dual implementations
   - Eventually removed in favor of simplicity
   - Direct Datalog is cleaner and easier to maintain

---

## Common Gotchas

Quick reference checklist for future work:

**Queries**
- [ ] Pre-lowercase page names before passing them to queries
- [ ] Pass strings as `:in` inputs, never embedded in the query text. Pass raw values: `executeDatalogQuery` EDN-encodes them (a bare string would be read as a symbol).
- [ ] Embed numeric IDs only through `DatalogQueryBuilder.groundIds`, which checks `Number.isInteger`
- [ ] Don't use `clojure.string/lower-case`. `includes?`, `starts-with?`, `re-pattern` and `re-find` work.
- [ ] Split queries when data might be empty (don't rely on or-join with ground nil)
- [ ] Send Datalog to `logseq.DB.datascriptQuery`. `logseq.DB.q` takes the simple query DSL and returns `null` for Datalog.
- [ ] Handle empty arrays from queries gracefully (`(results || [])`)
- [ ] Page names in `:block/name` are lowercase, not original casing
- [ ] Use `[(ground [id1 id2 id3]) [?id ...]]` for batch queries
- [ ] Never crawl `getAllPages` + one call per page (Pattern 4)
- [ ] `:with` can't name a variable that's also aggregated in `:find` (error: `:find and :with should not use same variables`)
- [ ] Match `:block/uuid` with `#uuid "..."` literals via `groundUuids`; strings never match (constraint 7)
- [ ] Remember: LogSeq Datalog ≠ Standard DataScript

**Data shapes** (verified by `scripts/probe-constraints.ts`)
- [ ] `:block/journal-day` is an integer `YYYYMMDD` (e.g. `20260422`). Parse its digits; never pass it to `new Date()`.
- [ ] Blocks with a scheduled/deadline date also carry `:block/journal-day`. A query for journal pages must require `[?page :block/name]`, or those blocks match as duplicate "pages" for the same day.
- [ ] `logseq.Editor.getBlock` returns `page` and `parent` as bare `{id}` objects. Resolve them; don't expect names.
- [ ] `:block/path-refs` includes refs inherited from ancestor blocks. Use it for "anything under a block tagged X".
- [ ] A nested pull works on refs: `(pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}])` returns each ref as a page map in the same call (`query_by_date_range` uses it for `topConcepts`). A ref to a block (`((uuid))`) has no `name`, and journal pages carry `journal?` true and `journal-day`.
- [ ] `:block/updated-at` is missing on some pages (roughly 1 in 10 pages lacked it in testing). Use `get-else` with a default.
- [ ] Many pages are empty link targets with no blocks or file. Test with them.
- [ ] `:block/properties` is a map keyed by **keywords**, lowercase and dashed. `[(get ?props ?key) ?v]` needs a keyword: a string key, or a string `:in` input, matches nothing. Build it with `[(keyword ?key) ?kw]` from a string `:in` input. The Editor API returns the same keys camelCase.
- [ ] A property value is a string, number or boolean, or an array (a set) for multi-value properties and page refs. `(str ?v)` of a set is `#{...}`, so match scalars with `str` and set elements with `contains?`. `string?`, `coll?`, `seq` and `clojure.string/join` are unavailable.
- [ ] Page entities and their first (pre-)block both carry `:block/properties`. Require `[?b :block/page]` to get blocks only.

**HTTP API behaviour** (verified)
- [ ] An unknown method returns **HTTP 200** with body `{"error": "MethodNotExist: ..."}`. Always check the body; `client.ts` does.
- [ ] A bad token returns HTTP 401. `client.ts` maps it to `LogSeqAuthError` (the message never contains the token).
- [ ] A hung request is aborted after `timeoutMs` (config field, default 30000, applied per `callAPI` call) and surfaces as `LogSeqTimeoutError`.
- [ ] `logseq.Editor.getEditingBlockSelection` doesn't exist. Use `getSelectedBlocks`, which returns `null` when nothing is selected.
- [ ] Without `includeChildren`, Editor API blocks carry `children` as unfetched `["uuid", "<id>"]` tuples, not block entities. `getCurrentPage` can return `null` while `getCurrentBlock` returns a block, or return a block when zoomed in. `get_current_context` handles all three.

**Tool behaviour**
- [ ] Don't turn errors into empty results. A dropped connection must not look like "no data" (#10). Re-throw infrastructure errors (`isInfrastructureError`) and unexpected ones; only an empty result is "none", and expected partial results go in a `warnings` field.
- [ ] Never cut results silently (#40). Any cap reports `ResultMeta` (`src/types.ts`): `hasMore` (true only when a warning's `howToFetchAll` names the parameter to raise and a value), `warnings: [{ code, message, howToFetchAll? }]`, and `totals` where already known (no extra API call just to count). Object results get these fields; a tool that returns a bare array keeps it as the first content block and sends `{ "meta": ... }` as a second one (`metaContent`). Helpers: `src/utils/result-meta.ts`.
- [ ] `resolve_refs` (#18) is opt-in and non-lossy: `content` never changes; a block holding a `((uuid))` ref or `{{embed}}` gains `resolvedContent` and `resolvedRefs: [{ uuid?, embed?, content, page, status }]` (`ok`, `missing`, `depth_limit`, `cycle`; unresolved refs stay as written), and the result gains `hasMore`/`warnings` (embed caps, depth limit). Slim blocks carry the same fields. One resolver, `resolveBlockRefs` in `src/utils/resolve-refs.ts`: one Datalog query per nesting level, `seen` tracked per path (siblings that share a target both resolve). Off means unchanged calls and output; a new tool that returns blocks should call the resolver rather than add its own.
- [ ] Never write to stdout (`console.log`). It's the MCP stdio channel; log with `console.error`.

---

## Testing Philosophy

### Property-Based Testing
Tests work with ANY LogSeq graph without requiring specific test data.

**Pattern:**
```typescript
// Discover pages dynamically
const pages = await discoverPages(client, 5);

// Test universal properties
for (const page of pages) {
  const result = await getConceptNetwork(client, page.name, 2);

  // Property: All nodes should have IDs
  expect(result.nodes.every(n => n.id)).toBe(true);

  // Property: Root node always at depth 0
  expect(result.nodes.find(n => n.depth === 0)).toBeDefined();
}
```

**Benefits:**
- No test data setup required
- Tests real-world scenarios
- Discovers edge cases (empty pages, special characters)
- Works across different LogSeq databases

**Test Categories:**
- **Unit tests** (`npx vitest run src`, 181 as of Oct 2026): Query builders, data transformations, mocked clients
- **Integration tests** (`npm run test:integration`, 60 as of Oct 2026, with real LogSeq): API connectivity, actual graph queries
- Note: `npm test` runs **both** suites (the default vitest config doesn't exclude `tests/integration/`), so it needs a running LogSeq
- **Property tests**: Universal invariants, equivalence validation

### Integration Test Requirements (Hard Failures)

Integration tests must fail loud on BOTH setup issues AND missing test data.

**Rules:**
1. **NO it.skipIf() for integration tests** - Tests must run or fail, never skip
2. **NO console.warn() in tests** - Silent warnings hide real failures
3. **REQUIRE prerequisites explicitly** - Config file, LogSeq connection, test data
4. **Fail with helpful messages** - Point to setup.md for resolution steps

**Pattern:**
```typescript
// ❌ BAD: Silent skip/warn
beforeAll(async () => {
  try {
    await access(configPath);
  } catch {
    skipTests = true; // Silent skip - test suite passes without testing!
  }
});
it.skipIf(skipTests)('test', async () => { ... });

// ❌ BAD: Silent warn
const result = await searchBlocks(client, 'test');
if (!result || result.length === 0) {
  console.warn('No data found'); // Test passes without proving anything!
  return;
}

// ✅ GOOD: Fail loud with clear message
beforeAll(async () => {
  try {
    await access(configPath);
  } catch {
    throw new Error(
      'Config file not found at ~/.logseq-mcp/config.json. ' +
      'See tests/integration/setup.md for setup instructions.'
    );
  }
});

it('test', async () => {
  const result = await searchBlocks(client, 'test');
  expect(result).toBeDefined();
  expect(result.length).toBeGreaterThan(0,
    'No pages found. Create test data in LogSeq graph. ' +
    'See tests/integration/setup.md'
  );
});
```

**Why:**
- Skipped tests provide false confidence
- Passing tests that found no data prove nothing
- Integration tests must test real integration
- Clear failures guide developers to fix actual problems

---

## Performance Benchmarks

Measured numbers are in "Current Implementation Status" under "Why Datalog?". Regenerate them with:

```bash
npx tsx scripts/measure-api-calls.ts            # picks the most-referenced page
npx tsx scripts/measure-api-calls.ts "my page"  # or a specific page
```

The earlier figures here (3 calls for `get_concept_network` at depth 2, 7 for `get_context_for_query`) came from 5-10 page test graphs and don't reflect the current code.

---

## Code Organization

```
src/
├── client.ts                      - LogseqClient with HTTP + Datalog methods
├── datalog/
│   └── queries.ts                 - DatalogQueryBuilder with all query templates
├── tools/
│   ├── build-context.ts           - Two-query pattern (page + blocks)
│   ├── get-concept-network.ts     - Batched BFS with caps (Pattern 2)
│   ├── search-by-relationship.ts  - Relationship search
│   └── [10 other tools]
└── types.ts                       - TypeScript interfaces

tests/
├── integration/                   - Tests against real LogSeq
│   └── properties/                - Property-based tests
└── [unit test files]              - Mocked tests (co-located in src/)

scripts/
├── probe-constraints.ts           - Verifies the Datalog/API constraints against a live graph
└── measure-api-calls.ts           - Counts API calls per tool against a live graph

skills/logseq-skills/              - Claude Code skills (SKILL.md, skills/, references/, scripts/); symlinked from .claude/skills/
.claude-plugin/                    - plugin.json + marketplace.json (server declared inline in plugin.json)
```

**Key files:**
- `src/datalog/queries.ts` - All Datalog query builders (study this for patterns)
- `src/tools/build-context.ts` - Example of two-query pattern
- `src/tools/get-concept-network.ts` - Example of multi-query BFS
- `tests/integration/properties/graph-properties.test.ts` - Property-based testing examples

---

## Useful Commands

```bash
# Run all tests (unit + integration; integration needs a running LogSeq)
npm test

# Run unit tests only
npx vitest run src

# Run specific test file
npx vitest run src/tools/build-context.test.ts

# Build the project
npm run build

# Test against real LogSeq (requires running instance)
npm run test:integration

# Verify Datalog/API constraints against the live graph (read-only)
npx tsx scripts/probe-constraints.ts

# Count API calls per tool against the live graph (read-only)
npx tsx scripts/measure-api-calls.ts

# Debug Datalog query
npx tsx scripts/test-datalog-query.ts
```

---

## When Adding New Tools

Checklist for new Datalog-based tools:

1. **Query Builder** - Add static method to `DatalogQueryBuilder`
   - Pre-lowercase any page name parameters
   - Return `{ query, inputs }` and bind strings with `:in`; don't embed them in the query text
   - Don't use `clojure.string/lower-case`
   - No `getAllPages` + per-page crawls

2. **Tool Implementation** - Follow two-query pattern if data is optional
   - Query 1: Main entity (fail if not found)
   - Query 2+: Related data (handle empty results)

3. **Tests** - Write unit tests with mocks
   - Test happy path with data
   - Test empty results (no blocks, no connections)
   - Test case-insensitive lookup

4. **Integration Test** - Add to `tests/integration/`
   - Use property-based testing if possible
   - Fail loud if no real data is available (never skip; see Integration Test Requirements)

5. **Documentation** - Update MCP tool handler in `src/index.ts`
   - Give the tool `annotations: readOnlyAnnotations('Title')` (a guard test in `src/index.test.ts` fails without it)

6. **Measure** - Add the tool to `scripts/measure-api-calls.ts` and record its call count in "Current Implementation Status"

7. **Tool-list guardrails** - `src/tool-list.test.ts` checks the `tools/list` payload
   - Size budget: `TOOL_LIST_BUDGET_CHARS` (~15% headroom over the size measured when it was added). If your tool or parameters push past it, trim first. If the growth is worth it, raise the constant and justify it in the PR description.
   - Description cap: 400 characters per tool. A new tool gets no allowance. Existing long descriptions are listed in `DESCRIPTION_ALLOWANCES` and may shrink but not grow. Delete an entry once its tool fits the cap.
   - Snapshot: any change to a name, title, annotation, description or input schema fails the snapshot test. Review the diff, then run `npx vitest run src/tool-list.test.ts -u` and commit `src/__snapshots__/tool-list.test.ts.snap`.

---

## References

- **LogSeq HTTP API:** http://127.0.0.1:12315/api (default)
- **DataScript Docs:** https://github.com/tonsky/datascript (note: LogSeq subset only)
- **Migration Docs:** `docs/datalog-performance-complete.md`
- **Example Scripts:** `scripts/test-datalog-query.ts`
- **MCP Spec:** https://github.com/modelcontextprotocol

---

## Summary

Datalog is how this project gets its performance gains (see "Current Implementation Status"), and LogSeq's Datalog needs careful handling. The key is to:

1. **Bind strings with `:in`** (`executeDatalogQuery` EDN-encodes the inputs); never embed them in the query text
2. **Lowercase in TypeScript** (`clojure.string/lower-case` is unavailable; `includes?` / `re-find` work)
3. **Split queries** for optional data (no or-join with ground nil)
4. **Always lowercase** page names before queries
5. **Handle empty results** gracefully, but never turn errors into empty results
6. **Batch, don't crawl**: one query or `ground`-batched queries, never one call per page

When a constraint seems to block you, re-run `scripts/probe-constraints.ts` before working around it.

When in doubt, look at `src/datalog/queries.ts` for working patterns and `src/tools/build-context.ts` or `src/tools/get-concept-network.ts` for implementation examples.
