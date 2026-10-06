# LogSeq MCP Tools Reference

Complete documentation for the LogSeq MCP tools organized by category. The server has 16 tools; `logseq_get_graph_info` (graph name and path) is the one not covered below.

## Tool Categories Overview

| Category | Tools | Purpose |
|----------|-------|---------|
| Basic Tools | 7 tools | Core search, retrieval, and property queries |
| Graph Traversal | 1 tool | Network visualization and relationship discovery |
| Semantic Search | 1 tool | Topic-based relationship queries |
| Context Building | 3 tools | Comprehensive multi-source context aggregation, and what the user is looking at |
| Temporal Query | 2 tools | Time-based analysis and journal queries |
| Linking | 1 tool | Checking a `[[link]]` pass before it is reported done |

## Basic Tools (7 tools)

### logseq_search_blocks

Full-text search across all blocks with optional semantic context.

**Parameters:**
- `query` (required): Search term or phrase
- `limit` (optional): Maximum results to return (default: 10, **recommend: 5**)
- `include_context` (optional): Include parent/child blocks for context (default: false, **keep false unless needed**)
- `include_content` (optional): `false` returns only per-day block counts and top-level snippets, without the blocks (default `true`)
- `slim_results` (optional): Slim blocks by default (uuid, content, pageName, marker, properties, tags, pageRefs; no numeric ids or page objects). Pass `false` for full entities

**Context cost:** ~200-500 tokens per result. With `include_context=true`: ~500-1000 per result.

**Use when:**
- Initial exploration ("what do I know about X?")
- Finding all mentions of a topic
- Needle searches ("find the X from Y")

**Example:**
```
logseq_search_blocks("React hooks", 5)
logseq_search_blocks("Nancy budget", 5)
```

---

### logseq_get_page

Get complete page content with all properties and blocks.

**Parameters:**
- `page_name` (required): Name of the page (case-insensitive)
- `include_children` (optional): Include nested child blocks (default: true)
- `format` (optional): `json` (default) or `markdown`. Markdown is plain text: page properties as `key:: value` lines, then blocks as tab-indented `- ` bullets with `((uuid))` refs kept, then a short footer for warnings and tips. About 80% smaller than JSON on a long page.

**Use when:**
- Deep dive into specific page
- Need full page structure
- Following up after search

**For a long page:** call `logseq_get_page_outline` first, then `logseq_get_block` on the blocks you pick.

**Example:**
```
logseq_get_page("React")
logseq_get_page("Project Alpha", include_children=true)
```

---

### logseq_get_page_outline

List a page's top-level blocks without their bodies: the shape of the page, to choose from.

**Parameters:**
- `page_name` (required): Page name, alias, or ISO date (`2025-01-01`) for a journal

**Returns:** `{ page, blocks: [{ uuid, snippet, childCount }], hasMore, warnings, totals }`. `snippet` is the first line, cut to 80 characters. `childCount` counts direct children only. Capped at 200 top-level blocks; a longer page gets an `outline_truncated` warning that names `logseq_get_page` for the rest.

**Cost:** 2 Datalog calls however long the page is. About 98% smaller than `get_page` with children on a long page.

**Use when:**
- A page is long and you need only parts of it
- Deciding which blocks to read

**Next:** `logseq_get_block(block_uuid, include_children=true)` on the blocks you picked.

**Example:**
```
logseq_get_page_outline("Project Alpha")  # → logseq_get_block(blocks[2].uuid, include_children=true)
```

---

### logseq_get_backlinks

Find all pages that reference a specific page.

**Parameters:**
- `page_name` (required): Name of the page to find backlinks for

**Use when:**
- Discovering connections
- Understanding how page is used
- Finding related context

**Example:**
```
logseq_get_backlinks("Machine Learning")
```

**Why critical:** Backlinks reveal hidden context and usage patterns.

---

### logseq_get_block

Get specific block by UUID with optional children.

**Parameters:**
- `block_uuid` (required): UUID of the block
- `include_children` (optional): Include nested child blocks (default: true)
- `format` (optional): `json` (default) or `markdown`, a `# Block ((uuid))` heading and the block with its children as bullets

**Use when:**
- Have UUID from search results
- Need specific block details
- Drilling down from search

**Example:**
```
logseq_get_block("abc123de-f456-7890-abcd-ef1234567890")
```

---

### logseq_query_by_property

Find blocks by property key/value pairs.

**Parameters:**
- `property_key` (required): Property name (e.g., "status", "priority")
- `property_value` (required): Property value (e.g., "doing", "high")
- `slim_results` (optional): Slim blocks by default (uuid, content, pageName, marker, properties, tags, pageRefs; no numeric ids or page objects). Pass `false` for full entities

**Use when:**
- Structured data queries
- Finding tasks by status/priority
- Property-based filtering

**Example:**
```
logseq_query_by_property("status", "doing")
logseq_query_by_property("priority", "high")
logseq_query_by_property("scheduled", "*")  # All scheduled items
```

**Note:** Use with wildcard `"*"` to find all blocks with that property.

---

### logseq_list_pages

List non-journal page names, A-Z, to discover graph vocabulary. A large graph's list comes in pages.

**Parameters:**
- `name_contains` (optional): Filter page names containing this text (case-insensitive)
- `limit` (optional): Maximum names per call (default: 200, max: 1000)
- `offset` (optional): Matching pages to skip, in name order, to fetch the next page (default: 0)

A server that doesn't page the list ignores `limit` and `offset` and returns every page.

**Returns:**
- `pages`: Sorted array of page names (strings)
- `total`: Count of all matching pages, including any not returned in this call
- `hasMore`, `warnings`: present only when something is missing. `pages_truncated` (with `hasMore: true`) means the list was cut, and names the `offset` of the next page. `pages_unavailable` (with `pages: []`, `total: 0`, `hasMore: false`) means LogSeq sent no page list: the list is unknown, not empty

**Context cost:** ~4-8 tokens per name: ~1-2k tokens for a 200-name page, ~4-8k for a 1000-name page. Use `name_contains` when you only need a few

**Use when:**
- Starting a new conversation about the user's knowledge graph
- Search queries are returning empty results (vocabulary mismatch)
- User asks "what pages do I have about X?"
- You need to discover what topics/concepts exist before searching

**Example:**
```
logseq_list_pages(limit=1000)  # First 1000 non-journal pages; while hasMore, repeat with the offset the warning names
logseq_list_pages(name_contains="project")  # Filter to pages containing "project"
```

**Why critical:** Prevents wasted searches for compound phrases that don't match the graph's actual vocabulary. Call this FIRST when you don't know what pages exist.

---

## Graph Traversal Tools (1 tool)

### logseq_get_concept_network

Build graph network with nodes (pages) and edges (connections).

**Parameters:**
- `concept_name` (required): Root page name
- `max_depth` (optional): Maximum traversal depth (default: 2, max: 3)
- `format` (optional): `json` (default) or `markdown`: pages grouped by depth, then one line per link (`A -> B (n)`, `A <- B (n)` or `A <-> B (out/in)`). About 45% smaller.

**Returns:**
- `nodes`: Array of pages with depth information
- `edges`: Array of connections with relationship types (inbound/outbound)

**Use when:**
- Visualizing knowledge network
- Understanding topic centrality
- Finding hubs and clusters
- Discovering bridges between topics

**Example:**
```
logseq_get_concept_network("Machine Learning", max_depth=2)
```

**Performance:** Gets full network in one call (vs. N calls for N pages).

---

## Semantic Search Tools (1 tool)

### logseq_search_by_relationship

Find blocks based on topic relationships and connections.

**Parameters:**
- `topic_a` (required): First topic name
- `topic_b` (required): Second topic name
- `relationship_type` (required): Type of relationship to search
- `max_distance` (optional): Maximum hops between topics (default: 2)

**Relationship Types:**

| Type | Description | Example |
|------|-------------|---------|
| `references` | Blocks about A that reference B | "React" blocks mentioning "TypeScript" |
| `referenced-by` | Blocks about A in pages referenced by B | "Testing" notes in pages linked from "Project" |
| `in-pages-linking-to` | Blocks about A in pages linking to B | "Architecture" blocks in pages linking to "Backend" |
| `connected-within` | A and B connected within N hops | "TypeScript" and "GraphQL" connected via "API Development" |

**Use when:**
- Finding connections between topics
- Understanding relationships
- Semantic proximity queries

**Example:**
```
logseq_search_by_relationship("TypeScript", "GraphQL", "connected-within", max_distance=3)
logseq_search_by_relationship("React", "Testing", "references")
```

---

## Context Building Tools (3 tools)

### logseq_build_context

Gather comprehensive context for a topic in a single call. **This is often the only tool you need.**

**Parameters:**
- `topic_name` (required): Page name to build context for
- `max_blocks` (optional): Maximum blocks to return (default: 50, **recommend: 20**)
- `max_related_pages` (optional): Maximum related pages (default: 10)
- `max_references` (optional): Maximum reference blocks (default: 20)
- `format` (optional): `json` (default) or `markdown`. Markdown shows the blocks as a tree (no block uuids unless `compact`; page properties as stored), related pages as links, and references grouped by source page, with truncation warnings in a footer. About 75% smaller.
- `compact` (optional): Block snippets (first line, 80 characters) with their uuids instead of block bodies. In JSON each block becomes `{ uuid, snippet }`; `summary`, `totals`, `warnings` and `hasMore` are kept. Read the blocks you want with `logseq_get_block`. Worth it when blocks are long; for short blocks the uuids cost about as much as the text. Skips `resolve_refs`. With `resolve_refs: true` the refs are not resolved and a `resolve_refs_ignored_in_compact` warning says so; set `compact` to false for resolved text.

**Context cost:** ~3-8k tokens depending on limits. Still cheaper than manual aggregation.

**Returns:**
- Main page with properties
- Direct blocks from page
- Related pages (inbound + outbound links)
- Reference blocks mentioning the topic
- Temporal context (for journal pages)
- Summary statistics

**Use when:**
- Need complete picture of a topic
- "What do I know about X?" questions
- Deep dive into specific page

**Example:**
```
logseq_build_context("Q4 Planning", max_blocks=20)
```

**Performance:** Replaces 5+ separate queries with one call. **Don't add search_blocks or get_backlinks after this - it already includes that information.**

---

### logseq_get_context_for_query

Parse natural language query and build context automatically.

**Parameters:**
- `query` (required): Natural language question
- `max_topics` (optional): Maximum topics to extract (default: 3)
- `max_search_results` (optional): Maximum search results per topic (default: 10)
- `format` (optional): `json` (default) or `markdown` (each topic as a section; keyword search hits end with `((uuid)) (in [[Page]])` so you can follow them up)
- `compact` (optional): Block snippets and uuids instead of bodies, as for `build_context`

**How it works:**
1. Extracts topics from `[[page references]]` and `#tags`
2. Builds context for each topic using `build_context`
3. Returns aggregated results

**Use when:**
- Natural language questions
- Multi-topic queries
- User asks complex questions

**Example:**
```
logseq_get_context_for_query("What did I write about [[Project X]] in [[Team Meeting]]?")
logseq_get_context_for_query("Show me notes on #react and #typescript")
```

---

### logseq_get_current_context

Get what the user is looking at in LogSeq right now: the open page, the block being edited, and any selected blocks.

**Parameters:** none

**Use when:**
- The user says "this page", "this block" or "what I'm looking at" without naming it
- Before `build_context` or `get_page`, to resolve which page "this" means

**Returns:** `{ page, focusedBlock?, selectedBlocks? }`. When no page is open, `page` is `null` with a message. The result reflects live UI state, so calling it twice can give different answers.

**Example:**
```
logseq_get_current_context()  # → then logseq_build_context(page.originalName)
```

---

## Temporal Query Tools (2 tools)

### logseq_query_by_date_range

Query journal entries within a date range. **Preferred tool for time-bounded questions.**

**Parameters:**
- `start_date` (required): Start date in YYYYMMDD format (e.g., 20251101)
- `end_date` (required): End date in YYYYMMDD format (e.g., 20251130)
- `search_term` (optional): Filter blocks containing this term
- `top_concepts_limit` (optional): Size of `summary.topConcepts`, the pages linked most in the range as `{ name, count, days }` (default 10, 0 omits it)
- `slim_results` (optional): Slim blocks by default (uuid, content, pageName, marker, properties, tags, pageRefs; no numeric ids or page objects). Pass `false` for full entities. Entries carry `pageName`, so their blocks don't repeat it
- `max_blocks` (optional): Most blocks returned across all days (default 200, max 1000; a larger value is clamped). Nested blocks count, except with `include_content=false`, where only the top-level blocks (the snippets) count. The oldest days are kept first, and `last_n` keeps the newest first. Pass `1000` for a work week or a month of journals

**A cut result:** when the range holds more than `max_blocks`, the result keeps the first blocks and says so:
- A `blocks_truncated` warning gives what was kept out of how many (in `totals: { blocks, days }`, range-wide and counted in the same unit as the cap) and where the entries end (`the entries end at <day>`), then says which `start_date` to continue from: the first day not shown, or, when the cut fell inside a day, that day itself (it repeats its kept blocks). If the first day alone fills the cap, it says to raise `max_blocks`. Below the maximum it also gives `howToFetchAll` (set `max_blocks` higher). At the maximum of 1000 the warning has no `howToFetchAll`, and a day holding more than 1000 blocks can't be fetched whole by any call
- A kept block that lost some children has `childrenTruncated: true`: the children shown are not all of them, so fetch the block with `get_block` and `include_children` if they matter
- `summary` (`totalDays`, `totalBlocks`, `topConcepts`) still covers every block found, so it describes the whole range even when `entries` stops early. `summary.totalBlocks` counts top-level blocks, while `totals.blocks` counts in the cap's unit (nested blocks too), so the two differ and neither is an error. `dateRange` stays the range you asked for
- Below the cap none of this appears and the output is unchanged

**Context cost:** ~1-3k tokens for a week's worth of filtered results. Much cheaper than broad search_blocks.

**Use when:**
- User says "this week", "recently", "in November", etc.
- Journal entry queries
- Time-bounded searches

**Example:**
```
logseq_query_by_date_range(20251201, 20251208, "Alice")  # This week's Alice mentions
logseq_query_by_date_range(20251101, 20251130, "testing")  # November mentions of "testing"
```

**Date Format:** Always use YYYYMMDD (20251101 = November 1, 2025)

**IMPORTANT:** If timeframe is ambiguous ("the X that Y sent"), ASK USER about recency before choosing between this tool and search_blocks.

---

### logseq_get_concept_evolution

Track how a concept appears and evolves over time.

**Parameters:**
- `concept_name` (required): Page or topic name
- `start_date` (optional): Start date in YYYYMMDD format
- `end_date` (optional): End date in YYYYMMDD format
- `group_by` (optional): Grouping level: 'day', 'week', 'month'

**Returns:**
- Timeline of mentions
- Temporal patterns and gaps
- Journal vs. non-journal distinction
- Chronologically sorted

**Use when:**
- "How did X evolve over time?"
- Tracking concept development
- Finding temporal patterns

**Example:**
```
logseq_get_concept_evolution("Rust", 20250101, 20251231, group_by='month')
logseq_get_concept_evolution("Machine Learning")  # All time
```

**Benefits:** See learning progression, identify gaps, understand engagement patterns.

---

## Linking Tools (1 tool)

### logseq_check_links

The gate for a `[[link]]` pass (`skills/concept-linking.md`, step 8). Read-only: it compares two texts and looks the refs up in the graph.

**Parameters:**
- `before` (required): The text before linking, at most 50,000 characters
- `after` (required): The same text with `[[brackets]]` added, at most 50,000 characters and 500 distinct terms

**Returns:**
- `ok`: True only when all four checks pass
- `prose`: `{ ok, firstDifference? }`. Stripping `[[ ]]` from both texts leaves them identical. `firstDifference` gives the line, column and an excerpt of each side
- `brackets`: `{ ok, opens, closes, nested? }`. Balanced, and no `[[` opened inside another
- `refs`: `{ ok, resolved, unresolved, ambiguous }`. Every `[[term]]` in `after` names exactly one page or alias, file-less pages included. An alias several pages declare is `ambiguous`; one the note already had, with no copy added, is reported but doesn't fail
- `refsPreserved`: `{ ok, removed }`. Every ref in `before` is still a ref in `after`, as many times
- `hasMore`, `warnings`, `totals` (`refsBefore`, `refsAfter`, `terms`). A `refs_unchecked` warning means LogSeq gave no answer, so no ref was checked

**Context cost:** ~100-500 tokens, depending on how many refs the text holds

**Use when:**
- A linking pass has been applied and is about to be reported done

**Example:**
```
logseq_check_links(before="- met Alice about project atlas", after="- met [[Alice]] about [[project atlas]]")
```

**Can't find:** a link to the wrong page, or a name split across a ref (`[[Kofi]] Mensah`). Both pass every check.

---

## Tool Selection Guide

### By Use Case

| Use Case | Best Tool(s) |
|----------|-------------|
| "What pages do I have?" | `list_pages` |
| "What do I know about X?" | `build_context` or `get_context_for_query` |
| "Show me everything connected to X" | `get_concept_network` + `get_backlinks` |
| "How did X evolve over time?" | `get_concept_evolution` |
| "What was I doing last week?" | `query_by_date_range` |
| "Find blocks about A that mention B" | `search_by_relationship` |
| "What are my TODOs?" | `search_blocks` + `query_by_property` |
| "When did I mention X?" | `get_concept_evolution` (without grouping) |
| "Get full details on page X" | `build_context` or `get_page` |

### By Question Type

**Initial exploration:**
- `search_blocks` (broad text search)
- `get_context_for_query` (natural language queries)

**Structured queries:**
- `query_by_property` (tasks, status, priorities)
- `query_by_date_range` (journal entries by date)

**Deep dives:**
- `get_page` with `includeChildren=true` (full page content)
- `build_context` (comprehensive topic context)

**Discovering connections:**
- `get_backlinks` (pages linking to this one)
- `get_concept_network` (full network visualization)

**Relationship-based search:**
- `search_by_relationship` (find blocks based on topic relationships)

**Time-based analysis:**
- `get_concept_evolution` (track concept over time)
- `query_by_date_range` (journal queries)

**Specific blocks:**
- `get_block` (when you have a UUID)

---

## Performance Comparison

### Single-Call Solutions (Fastest)

**`build_context`:**
- Replaces 5+ separate queries
- One API call for complete context
- Best for deep dives

**`get_context_for_query`:**
- Handles natural language automatically
- Extracts topics and builds context
- Best for complex questions

**`get_concept_network`:**
- Full graph in one call
- Shows all connections at once
- Best for visualization

### Multi-Call Workflows (When Needed)

**Broad exploration:**
```
search_blocks → get_page → get_backlinks
```

**Specific deep-dive:**
```
get_page → get_related_pages
```

**Structured data:**
```
query_by_property (for precise matches)
```

---

## Best Practices

### Limit Parameters

- Use `max_blocks`, `max_related_pages` to control response size
- Use `depth` and `max_depth` carefully (depth=1 usually sufficient)
- Use `limit` on `search_blocks` to avoid overwhelming results

### Tool Priority

1. Prefer `build_context` over manual aggregation
2. Prefer `get_context_for_query` over multiple searches
3. Use `search_by_relationship` instead of filtering results manually
4. Use `get_concept_network` for full graph (not sequential backlink queries)

### Common Patterns

**Task queries:** Use BOTH `search_blocks("TODO")` AND `query_by_property("status", "todo")`

**Research:** Start with `search_blocks`, then `get_page`, then `get_backlinks`

**Graph exploration:** Use `get_concept_network` + `get_backlinks` together

**Temporal analysis:** Use `get_concept_evolution` with grouping for patterns

---

## Date Format Reference

All temporal queries use **YYYYMMDD format:**

| Date | Format |
|------|--------|
| January 1, 2025 | 20250101 |
| November 24, 2025 | 20251124 |
| December 31, 2025 | 20251231 |

**No dashes, slashes, or other separators.**

---

## Summary

16 MCP tools. The 15 below are organized into 6 categories; `logseq_get_graph_info` (graph name and path) is the 16th:

1. **Basic Tools (7)** - Core search, retrieval, page outline, property queries
2. **Graph Traversal (1)** - Network visualization
3. **Semantic Search (1)** - Relationship-based queries
4. **Context Building (3)** - Comprehensive aggregation and current UI context
5. **Temporal Query (2)** - Time-based analysis
6. **Linking (1)** - Checking a link pass

**Key principle:** Start with high-level tools (`build_context`, `get_context_for_query`) and drill down with specific tools only when needed.
