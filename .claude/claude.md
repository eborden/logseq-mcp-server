# LogSeq MCP Server - Technical Context

## Overview

This is an MCP (Model Context Protocol) server that provides Claude with 11 tools for querying LogSeq knowledge graphs. Built with TypeScript, it uses LogSeq's HTTP API and DataScript query engine to enable efficient graph traversal and context building.

**Key Stats:**
- 11 MCP tools for graph operations, search, and temporal queries
- 191 test cases (unit + integration + property-based)
- 70-88% API call reduction via Datalog optimization
- Direct Datalog implementation (simplified architecture as of Nov 2024)

**Architecture:**
```
Claude (via MCP) → HTTP API → LogSeq Desktop → DataScript Database
```

The server translates high-level queries (e.g., "get context for topic") into optimized Datalog queries that run against LogSeq's internal DataScript database.

## Why Datalog?

### Performance Gains
- **Before (HTTP):** Sequential API calls - O(n) calls for n entities
- **After (Datalog):** Multi-query BFS - O(maxDepth) calls regardless of graph size

**Concrete example (get-concept-network at depth=2):**
- HTTP: 10-25 API calls
- Datalog: 3 API calls
- **Reduction: 70-88%**

### Trade-offs
- **Pros:** Massive performance gains, expresses graph logic naturally, fewer round-trips
- **Cons:** More constraints than standard DataScript, requires workarounds for limitations
- **Decision:** Performance gains outweigh constraints for this use case

## Critical LogSeq Datalog Constraints

LogSeq's Datalog implementation (via `logseq.DB.datascriptQuery`) has significant limitations compared to standard DataScript. Understanding these constraints is essential for writing working queries.

### 1. No Parameterized Queries via HTTP API

LogSeq's HTTP API doesn't support the `:in` clause for passing parameters to Datalog queries.

**DON'T (doesn't work):**
```clojure
[:find (pull ?page [*])
 :in $ ?page-name    ; ← This doesn't work via logseq.DB.datascriptQuery
 :where
 [?page :block/name ?page-name]]
```

```typescript
// This will fail or return 0 results
const query = '[:find (pull ?page [*]) :in $ ?name :where [?page :block/name ?name]]';
await client.executeDatalogQuery(query, 'my-page');
```

**DO (embed parameters in query string):**
```typescript
// Pre-process parameters in TypeScript
const pageNameLower = pageName.toLowerCase();

// Embed directly in query string
const query = `[:find (pull ?page [*])
                :where
                [?page :block/name "${pageNameLower}"]]`;

await client.executeDatalogQuery(query);
```

**Why:** LogSeq's HTTP API wrapper for DataScript doesn't pass additional parameters to the query engine. Only the query string itself is processed.

**References:**
- Discovered in: commit c108174 "fix: implement case-insensitive page lookup"
- Test file: `test-simple-query.ts` demonstrated this limitation
- Working in: `src/datalog/queries.ts` (all query builders embed parameters)

---

### 2. clojure.string Functions Not Available

DataScript via LogSeq's HTTP API doesn't support Clojure standard library functions.

**DON'T (doesn't work):**
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

// Use pre-processed value in query
const query = `[:find (pull ?page [*])
                :where
                [?page :block/name "${pageNameLower}"]]`;
```

**Why:** LogSeq's DataScript implementation is sandboxed and doesn't include Clojure's standard library functions. Only core DataScript functions are available.

**References:**
- Discovered in: commit c108174 integration tests
- Attempted in: searchByRelationship (reverted)
- Pattern used throughout: `src/datalog/queries.ts` (all methods pre-lowercase)

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
const pageQuery = `[:find (pull ?page [*])
                    :where
                    [?page :block/name "${pageNameLower}"]]`;
const pageResults = await client.executeDatalogQuery(pageQuery);

if (!pageResults || pageResults.length === 0) {
  throw new Error(`Page not found: ${pageName}`);
}

// Query 2: Get blocks (may be empty array)
const blocksQuery = `[:find (pull ?block [*])
                      :where
                      [?page :block/name "${pageNameLower}"]
                      [?block :block/page ?page]]`;
const blockResults = await client.executeDatalogQuery(blocksQuery);

// Handle empty results gracefully
const blocks = (blockResults || []).map(r => r[0]);
```

**Why:** LogSeq's Datalog filters out nil values from results, making optional binding patterns impossible. The solution is to split into separate queries and handle empty arrays.

**References:**
- Discovered in: commit d6c3151 "fix: handle pages without blocks"
- Pattern used in: `src/tools/build-context.ts` (lines 59-78)
- Also used in: `src/tools/get-concept-network.ts` (BFS traversal)

---

### 4. Use logseq.DB.datascriptQuery (not logseq.DB.q)

LogSeq provides multiple query methods, but only one works correctly via HTTP API.

**DON'T:**
```typescript
await client.callAPI('logseq.DB.q', [query]);  // Returns null
```

**DO:**
```typescript
await client.callAPI('logseq.DB.datascriptQuery', [query]);  // Works
```

**Why:** The `logseq.DB.q` method is designed for use within LogSeq's plugin system, not the HTTP API. It returns null when called via HTTP.

**References:**
- Implemented in: `src/client.ts` (line 75)
- Method name: `executeDatalogQuery()`

---

### 5. Page Names are Stored Lowercase in :block/name

LogSeq normalizes page names to lowercase in the `:block/name` attribute, but preserves original casing in `:block/original-name`.

**Schema:**
```
Page entity:
  :block/name          - Lowercase normalized name (e.g., "christy")
  :block/original-name - Original casing (e.g., "Christy")
  :db/id              - Numeric ID
```

**Best Practice for Case-Insensitive Lookup:**
```typescript
// Accept any casing from user
function getPage(pageName: string) {
  // Lowercase before embedding in query
  const pageNameLower = pageName.toLowerCase();

  return `[:find (pull ?page [*])
           :where
           [?page :block/name "${pageNameLower}"]]`;
}

// All these work correctly:
getPage('Christy')  // ✅ Finds "christy"
getPage('christy')  // ✅ Finds "christy"
getPage('CHRISTY')  // ✅ Finds "christy"
```

**Why:** This matches LogSeq's own behavior - the UI is case-insensitive because it lowercases before lookup.

**References:**
- Pattern established in: commit ff0c96d
- Used throughout: `src/datalog/queries.ts` (all query builders)
- Verified with: test-find-pages.ts (showed name: "christy", original-name: "Christy")

---

## Design Patterns

### Pattern 1: Two-Query Pattern for Optional Data

When related data might not exist (e.g., pages without blocks, pages without connections), split into separate queries rather than using complex or-join patterns.

**Implementation:**
```typescript
// Step 1: Get the main entity
const mainEntityQuery = DatalogQueryBuilder.getPage(pageName);
const mainResults = await client.executeDatalogQuery(mainEntityQuery);

if (!mainResults || mainResults.length === 0) {
  throw new Error(`Entity not found`);
}

const mainEntity = mainResults[0][0];

// Step 2: Get related data (may be empty)
const relatedQuery = DatalogQueryBuilder.getRelatedData(pageName);
const relatedResults = await client.executeDatalogQuery(relatedQuery);

// Handle empty results
const relatedData = (relatedResults || []).map(r => r[0]);
```

**Benefits:**
- Works with empty data (no or-join complexity)
- Clear separation of concerns
- Easy to debug and test
- Matches HTTP API pattern

**Used in:**
- `src/tools/build-context.ts:59-78` - page + blocks + connections
- `src/tools/get-concept-network.ts:34-95` - root + BFS traversal

---

### Pattern 2: Multi-Query BFS for Graph Traversal

Instead of recursive queries or N sequential API calls, use BFS with batched queries at each depth level.

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

**Performance:**
- Depth 2, 10 pages: HTTP = 25 calls, Datalog = 3 calls (88% reduction)
- Depth 2, 5 pages: HTTP = 10 calls, Datalog = 3 calls (70% reduction)

**Query Builder Pattern:**
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

**Used in:**
- `src/tools/get-concept-network.ts:67-95` - BFS graph traversal
- `src/datalog/queries.ts:52-88` - Query builder

---

### Pattern 3: Case-Insensitive Lookup

Always lowercase page names before embedding in queries to match LogSeq's normalization.

**Standard Pattern:**
```typescript
export function buildQuery(pageName: string) {
  const pageNameLower = pageName.toLowerCase();

  return `[:find (pull ?page [*])
           :where
           [?page :block/name "${pageNameLower}"]]`;
}
```

**Used everywhere:**
- `src/datalog/queries.ts:conceptNetwork()` - line 20
- `src/datalog/queries.ts:getPage()` - line 101
- `src/datalog/queries.ts:getPageBlocks()` - line 113
- `src/datalog/queries.ts:searchByRelationship()` - lines 128, 141

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

### Lessons Learned

1. **LogSeq's Datalog ≠ Standard DataScript**
   - Parameterized queries don't work
   - Clojure stdlib not available
   - or-join semantics differ

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

- [ ] Pre-lowercase page names before embedding in queries
- [ ] Don't use `:in` clause or parameterized queries
- [ ] Don't use `clojure.string/*` or other Clojure stdlib functions
- [ ] Split queries when data might be empty (don't rely on or-join with ground nil)
- [ ] Use `logseq.DB.datascriptQuery` (not `logseq.DB.q`)
- [ ] Handle empty arrays from queries gracefully (`(results || [])`)
- [ ] Page names in `:block/name` are lowercase, not original casing
- [ ] Use `[(ground [id1 id2 id3]) [?id ...]]` for batch queries
- [ ] Test with pages that have no blocks/connections
- [ ] Remember: LogSeq Datalog ≠ Standard DataScript

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
- **Unit tests** (182 tests): Query builders, data transformations, mocked clients
- **Integration tests** (with real LogSeq): API connectivity, actual graph queries
- **Property tests**: Universal invariants, equivalence validation

---

## Performance Benchmarks

### get-concept-network (Depth=2)
- **HTTP:** 10-25 API calls
- **Datalog:** 3 API calls
- **Reduction:** 70-88%

### build-context
- **HTTP:** 4-11 API calls
- **Datalog:** 3 API calls (page, blocks, connections)
- **Reduction:** 50-73%

### Typical Query (get-context-for-query with 2 topics)
- **HTTP:** ~18 API calls
- **Datalog:** 7 API calls (1 page + 1 blocks + 1 connections per topic + 1 search)
- **Reduction:** ~61%

**Calculation basis:** Measured on typical LogSeq graphs with 5-10 pages and depth=2 traversal.

---

## Code Organization

```
src/
├── client.ts                      - LogseqClient with HTTP + Datalog methods
├── datalog/
│   └── queries.ts                 - DatalogQueryBuilder with all query templates
├── tools/
│   ├── build-context.ts           - Two-query pattern (page + blocks)
│   ├── get-concept-network.ts     - Multi-query BFS pattern
│   ├── search-by-relationship.ts  - Relationship search
│   └── [13 other tools]
└── types.ts                       - TypeScript interfaces

tests/
├── integration/                   - Tests against real LogSeq
│   └── properties/                - Property-based tests
└── [unit test files]              - Mocked tests
```

**Key files:**
- `src/datalog/queries.ts` - All Datalog query builders (study this for patterns)
- `src/tools/build-context.ts` - Example of two-query pattern
- `src/tools/get-concept-network.ts` - Example of multi-query BFS
- `tests/integration/properties/graph-properties.test.ts` - Property-based testing examples

---

## Useful Commands

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run src/tools/build-context.test.ts

# Build the project
npm run build

# Test against real LogSeq (requires running instance)
npx vitest run tests/integration/

# Debug Datalog query
npx tsx scripts/test-datalog-query.ts
```

---

## When Adding New Tools

Checklist for new Datalog-based tools:

1. **Query Builder** - Add static method to `DatalogQueryBuilder`
   - Pre-lowercase any page name parameters
   - Embed parameters directly in query string
   - Don't use `:in` clause or Clojure functions

2. **Tool Implementation** - Follow two-query pattern if data is optional
   - Query 1: Main entity (fail if not found)
   - Query 2+: Related data (handle empty results)

3. **Tests** - Write unit tests with mocks
   - Test happy path with data
   - Test empty results (no blocks, no connections)
   - Test case-insensitive lookup

4. **Integration Test** - Add to `tests/integration/`
   - Use property-based testing if possible
   - Skip if no real data available

5. **Documentation** - Update MCP tool handler in `src/index.ts`

---

## References

- **LogSeq HTTP API:** http://127.0.0.1:12315/api (default)
- **DataScript Docs:** https://github.com/tonsky/datascript (note: LogSeq subset only)
- **Migration Docs:** `docs/datalog-performance-complete.md`
- **Example Scripts:** `scripts/test-datalog-query.ts`
- **MCP Spec:** https://github.com/modelcontextprotocol

---

## Summary

This project achieves significant performance gains through Datalog optimization, but requires careful handling of LogSeq's Datalog limitations. The key is to:

1. **Embed parameters** directly in query strings (no `:in` clause)
2. **Pre-process** strings in TypeScript (no Clojure functions)
3. **Split queries** for optional data (no or-join with ground nil)
4. **Always lowercase** page names before queries
5. **Handle empty results** gracefully

When in doubt, look at `src/datalog/queries.ts` for working patterns and `src/tools/build-context.ts` or `src/tools/get-concept-network.ts` for implementation examples.
