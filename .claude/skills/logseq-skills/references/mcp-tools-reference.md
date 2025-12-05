# LogSeq MCP Tools Reference

Complete documentation for all 11 LogSeq MCP tools organized by category.

## Tool Categories Overview

| Category | Tools | Purpose |
|----------|-------|---------|
| Basic Tools | 5 tools | Core search, retrieval, and property queries |
| Graph Traversal | 1 tool | Network visualization and relationship discovery |
| Semantic Search | 1 tool | Topic-based relationship queries |
| Context Building | 2 tools | Comprehensive multi-source context aggregation |
| Temporal Query | 2 tools | Time-based analysis and journal queries |

## Basic Tools (5 tools)

### logseq_search_blocks

Full-text search across all blocks with optional semantic context.

**Parameters:**
- `query` (required): Search term or phrase
- `limit` (optional): Maximum results to return (default: 10)
- `include_context` (optional): Include parent/child blocks for context (default: false)

**Use when:**
- Initial exploration ("what do I know about X?")
- Finding all mentions of a topic
- Casting wide net before focusing

**Example:**
```
logseq_search_blocks("React hooks", 15)
logseq_search_blocks("TODO", 50, include_context=true)
```

---

### logseq_get_page

Get complete page content with all properties and blocks.

**Parameters:**
- `page_name` (required): Name of the page (case-insensitive)
- `include_children` (optional): Include nested child blocks (default: true)

**Use when:**
- Deep dive into specific page
- Need full page structure
- Following up after search

**Example:**
```
logseq_get_page("React")
logseq_get_page("Project Alpha", include_children=true)
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

## Graph Traversal Tools (1 tool)

### logseq_get_concept_network

Build graph network with nodes (pages) and edges (connections).

**Parameters:**
- `concept_name` (required): Root page name
- `max_depth` (optional): Maximum traversal depth (default: 2, max: 3)

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

## Context Building Tools (2 tools)

### logseq_build_context

Gather comprehensive context for a topic in a single call.

**Parameters:**
- `topic_name` (required): Page name to build context for
- `max_blocks` (optional): Maximum blocks to return (default: 50)
- `max_related_pages` (optional): Maximum related pages (default: 10)
- `max_references` (optional): Maximum reference blocks (default: 20)

**Returns:**
- Main page with properties
- Direct blocks from page
- Related pages (inbound + outbound links)
- Reference blocks mentioning the topic
- Temporal context (for journal pages)
- Summary statistics

**Use when:**
- Need complete picture of a topic
- Single-call context gathering
- Deep dive into specific page

**Example:**
```
logseq_build_context("Q4 Planning")
logseq_build_context("React", max_blocks=100, max_related_pages=15)
```

**Performance:** Replaces 5+ separate queries with one call.

---

### logseq_get_context_for_query

Parse natural language query and build context automatically.

**Parameters:**
- `query` (required): Natural language question
- `max_topics` (optional): Maximum topics to extract (default: 3)
- `max_search_results` (optional): Maximum search results per topic (default: 10)

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

## Temporal Query Tools (2 tools)

### logseq_query_by_date_range

Query journal entries within a date range.

**Parameters:**
- `start_date` (required): Start date in YYYYMMDD format (e.g., 20251101)
- `end_date` (required): End date in YYYYMMDD format (e.g., 20251130)
- `search_term` (optional): Filter blocks containing this term

**Use when:**
- Journal entry queries
- "What was I doing last week?"
- Time-bounded searches

**Example:**
```
logseq_query_by_date_range(20251201, 20251205)  # Dec 1-5, 2025
logseq_query_by_date_range(20251101, 20251130, "testing")  # November mentions of "testing"
```

**Date Format:** Always use YYYYMMDD (20251101 = November 1, 2025)

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

## Tool Selection Guide

### By Use Case

| Use Case | Best Tool(s) |
|----------|-------------|
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

11 MCP tools organized into 5 categories:

1. **Basic Tools (5)** - Core search, retrieval, property queries
2. **Graph Traversal (1)** - Network visualization
3. **Semantic Search (1)** - Relationship-based queries
4. **Context Building (2)** - Comprehensive aggregation
5. **Temporal Query (2)** - Time-based analysis

**Key principle:** Start with high-level tools (`build_context`, `get_context_for_query`) and drill down with specific tools only when needed.
