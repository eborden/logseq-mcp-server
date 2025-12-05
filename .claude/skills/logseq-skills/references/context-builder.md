# LogSeq Context Builder Workflows

Detailed workflows for building comprehensive context from LogSeq knowledge graphs.

## Overview

Build comprehensive context from LogSeq knowledge graphs by searching blocks, following backlinks, and discovering connections. Core principle: **Start broad (search), then focus (get pages), then discover (backlinks)**.

## Workflow 1: Research Assistant

**When:** User asks "what do I know about X?" or needs research context.

**4-Phase Approach:**

1. **Search** → `logseq_search_blocks(topic, limit=15)` - cast wide net
2. **Retrieve** → `logseq_get_page(relevant_pages, includeChildren=true)` - get full content
3. **Discover** → `logseq_get_backlinks(key_pages)` - find connections
4. **Synthesize** → Present organized findings with sources

**Example:**
```
User: "What do I know about React hooks?"

1. logseq_search_blocks("React hooks", 15)
2. logseq_get_page("React", includeChildren=true)
3. logseq_get_backlinks("React")
4. Synthesize: "You have detailed notes in [[React]] covering useState/useEffect.
   Referenced in [[Project Alpha]] and [[Interview Notes]]. Gap: error boundary hooks."
```

## Workflow 2: Task Prioritization

**When:** User asks about tasks, TODOs, what to work on, or managing their work.

**4-Step Process:**

### Step 1: Find All Tasks

Execute ALL of these to ensure comprehensive coverage:

```
logseq_search_blocks("TODO")
logseq_search_blocks("DOING")
logseq_query_by_property("status", "todo")
logseq_query_by_property("status", "doing")
logseq_query_by_property("status", "in-progress")
logseq_query_by_property("priority", "high")
logseq_query_by_property("scheduled", "*")  # Get all scheduled tasks
```

**Why check multiple?** Users may use markers ("TODO"), properties (`status::doing`), or both. Check everything.

### Step 2: Categorize

Group by:
- **Status**: TODO, DOING, WAITING, etc.
- **Project/Page**: Which pages contain these tasks
- **Priority**: high/medium/low or A/B/C markers
- **Time**: Scheduled dates, deadlines

### Step 3: Identify Active Work

Extract tasks marked as:
- "DOING" in content
- `status::doing` or `status::in-progress` properties
- Recently scheduled (this week)

### Step 4: Present & Recommend

Structure:
```
CURRENTLY ACTIVE (DOING):
- List all in-progress work

HIGH PRIORITY (This Week):
- Deadlines/scheduled this week
- High priority markers

BY PROJECT:
- Group remaining TODOs by page/project

RECOMMENDATION:
- Complete active tasks before starting new ones
- Highlight urgent items
- Note any blockers or dependencies
```

**Example:**
```
User: "What should I work on today?"

Findings:
- 2 DOING tasks (auth implementation, blog draft)
- 3 high priority (tests, PR review, docs)
- 18 total TODOs across 5 projects

Recommend: Complete your 2 active tasks, then tackle the 3 high-priority items.
```

## Workflow 3: Stale Task Detection

**When:** User asks about old/forgotten tasks or wants backlog review.

**3-Step Process:**

1. **Query Scheduled** → `logseq_query_by_property("scheduled", "*")` - find all scheduled tasks
2. **Check Blocked** → Search for "WAITING", "blocked by", or `status::blocked`
3. **Surface Old** → Present tasks scheduled >2 weeks ago with context

**Present:**
- Task content with original scheduled date
- Page/project context
- Suggestion: reschedule, archive, or revive

## Workflow 4: Page Context Building

**When:** User mentions specific page and needs full context.

**Enhanced with build_context:**

1. **Quick Context**: `logseq_build_context(page_name)`
   - Gets page + blocks + related pages + references + temporal info
   - Single call replaces multiple queries

2. **Manual Context** (if build_context not available):
   - Get full page: `logseq_get_page(name, includeChildren=true)`
   - Get connections: `logseq_get_backlinks(name)`
   - Extract linked pages from content

3. Synthesize: content summary + connections + usage patterns

## Workflow 5: Graph Exploration

**When:** User wants to explore knowledge network, find related concepts, or understand relationships.

**3-Phase Approach:**

### Phase 1: Visualize Network
```
logseq_get_concept_network(topic, max_depth=2)
```
- Returns nodes (pages) and edges (connections)
- Good for understanding topic centrality
- Identifies hub pages vs. leaf pages
- Shows relationship type and distance

### Phase 2: Get Backlinks
```
logseq_get_backlinks(topic)
```
- Find pages that reference the topic
- Complements concept_network with detailed backlink context

### Phase 3: Present Insights
- **Core connections**: Pages at distance 1
- **Clusters**: Groups of highly connected pages
- **Bridges**: Pages connecting different clusters
- **Orphans**: Related pages with few connections

**Example:**
```
User: "Show me everything connected to [[Machine Learning]]"

1. logseq_get_concept_network("Machine Learning", max_depth=2)
   → 23 nodes, 47 edges

2. logseq_get_backlinks("Machine Learning")
   → 15 pages with backlinks

3. Present:
   "CORE CONNECTIONS (depth 1):
    - [[Neural Networks]] (referenced in 8 places)
    - [[Python]] (used in all ML projects)
    - [[Transformers]] (recent deep dive)

    CONNECTED TOPICS (depth 2):
    - [[NLP]] → via [[Transformers]]
    - [[Computer Vision]] → via [[Neural Networks]]
    - [[Data Science]] → via [[Python]]

    NETWORK INSIGHTS:
    - [[Machine Learning]] is a hub (23 connections)
    - Most activity in [[Neural Networks]] cluster
    - [[Transformers]] is bridge to [[NLP]]"
```

## Workflow 6: Temporal Analysis

**When:** User asks about time-based patterns, concept evolution, or "what was I thinking about X?"

**For Journal Queries:**
```
logseq_query_by_date_range(start_date, end_date, search_term?)
```
- Use YYYYMMDD format (20251101 = Nov 1, 2025)
- Optional search term filters blocks
- Returns entries sorted chronologically

**For Concept Evolution:**
```
logseq_get_concept_evolution(concept, start_date?, end_date?, group_by?)
```
- Tracks how concept appears over time
- Supports grouping: 'day', 'week', 'month'
- Shows temporal patterns and gaps
- Sorted chronologically
- Distinguishes journal vs. non-journal pages

**Example:**
```
User: "How has my thinking on [[Rust]] evolved this year?"

1. logseq_get_concept_evolution("Rust", 20250101, 20251231, group_by='month')
   → Timeline with monthly grouping

2. Present:
   "RUST EVOLUTION (2025):

    Jan-Feb: Initial learning phase
    - 12 mentions (basics, ownership, borrowing)

    Mar-May: Active project work
    - 34 mentions (async, tokio, production issues)

    Jun-Aug: Deep dive period
    - 28 mentions (unsafe, FFI, optimization)

    Sep-Nov: Maintenance
    - 8 mentions (updates, refactoring)

    PATTERN: Intense learning → Active development → Maintenance
    GAP: No mentions in September (vacation?)"
```

## Workflow 7: Smart Context Building

**When:** User asks complex questions requiring comprehensive context from multiple sources.

**Simple Queries:**
```
logseq_get_context_for_query("What did I write about [[Project X]] in [[Team Meeting]]?")
```
- Automatically extracts topics from [[references]] and #tags
- Builds context for each topic
- Returns aggregated results

**Deep Dives:**
```
logseq_build_context(topic, max_blocks=50, max_related_pages=10)
```
- Main page with properties
- Direct blocks from page
- Related pages (inbound + outbound)
- Reference blocks mentioning the topic
- Temporal context (for journal pages)
- Summary statistics

**Example:**
```
User: "Give me full context on [[Q4 Planning]]"

1. logseq_build_context("Q4 Planning", max_blocks=50, max_related_pages=15)
   → Comprehensive aggregation

2. Present:
   "Q4 PLANNING CONTEXT:

    MAIN PAGE:
    - 23 blocks (goals, milestones, retrospective)
    - Properties: quarter::4, year::2025, status::active

    RELATED PAGES (15):
    Outbound references:
    - [[Product Roadmap]] (planning source)
    - [[Team Capacity]] (resource planning)
    - [[Budget 2025]] (financial planning)

    Inbound references:
    - [[Weekly Standup]] (7 mentions)
    - [[Engineering Notes]] (4 mentions)
    - [[Leadership Meeting]] (3 mentions)

    TEMPORAL CONTEXT:
    - Created: Oct 15, 2025
    - Most recent: Nov 20, 2025
    - Nearby dates: Oct 14-15, Oct 16-17 (planning session)

    SUMMARY:
    - 23 direct blocks
    - 15 related pages
    - 14 reference blocks
    - Active planning document"
```

## Core Guidelines

### Do ✅

- **Search first** to understand the landscape
- **Follow backlinks** aggressively (crucial for context)
- **Quote actual content** with proper source attribution
- **Use [[double brackets]]** for page references
- **Surface unexpected connections** and patterns
- **Be honest about gaps** ("you don't have notes on X")
- **Check multiple status indicators** for tasks (TODO, DOING, status::, etc.)

### Don't ❌

- Assume page structure without checking
- Ignore backlinks (they reveal hidden context)
- Search only once (iterate if results are poor)
- Return raw UUIDs without context
- Suggest creating pages unless asked
- Make changes to LogSeq structure (read-only assistance)

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Missing tasks | Check BOTH markers and properties |
| Incomplete context | Use `build_context` or get backlinks |
| Poor search results | Use `get_context_for_query` for natural language |
| Date queries unclear | Use `query_by_date_range` with YYYYMMDD format |
| Lost connections | Use `get_concept_network` with max_depth=2 |
| Manual aggregation | Use `build_context` instead of multiple queries |
| Shallow exploration | Use `get_concept_network` to see full graph |
| Time patterns unclear | Use `get_concept_evolution` with grouping |

## Performance Tips

### Smart Tool Selection:

**Single-call solutions (fastest):**
- `build_context` - Replaces 5+ separate queries
- `get_context_for_query` - Handles natural language automatically
- `get_concept_network` - Full graph in one call

**Multi-call workflows (when needed):**
- Broad exploration: `search_blocks` → `get_page` → `get_backlinks`
- Specific deep-dive: `get_page` → `get_related_pages`
- Structured data: `query_by_property` for precise matches

**Limit parameters:**
- Use `max_blocks`, `max_related_pages` to control response size
- Use `depth` and `max_depth` carefully (depth=1 usually sufficient)
- Use `limit` on search_blocks to avoid overwhelming results

**Best practices:**
- Prefer `build_context` over manual aggregation
- Prefer `get_context_for_query` over multiple searches
- Use relationship search instead of filtering results manually

## Example Complete Sessions

### Session 1: Weekly Planning

```
User: "Help me plan my week"

1. Find all tasks (6 queries: TODO, DOING, status properties)
   → 2 DOING, 18 TODO, 4 high priority

2. Check deadlines
   → 3 tasks due this week

3. Present:
   "CURRENTLY ACTIVE:
    - [[Client Project]]: Payment integration (DOING)
    - [[Blog]]: Testing patterns article (DOING)

    HIGH PRIORITY (This Week):
    - PR review (deadline: Thu)
    - Talk abstract (deadline: Fri)
    - Onboarding docs (priority::high)

    PROJECTS NEEDING ATTENTION:
    - [[Client Project]]: 6 TODOs (2 scheduled this week)
    - [[Open Source]]: 4 TODOs (1 high priority)
    - [[Learning]]: 3 TODOs (no deadlines)

    RECOMMENDATION: Complete active tasks first, then high-priority deadlines."

4. Ask: "Want to dive deeper into any project?"
```

### Session 2: Knowledge Graph Exploration

```
User: "What's the relationship between my notes on [[TypeScript]] and [[GraphQL]]?"

1. logseq_search_by_relationship("TypeScript", "GraphQL", "connected-within", max_distance=3)
   → Found connection at distance 2

2. logseq_get_concept_network("TypeScript", max_depth=2)
   → Network analysis: 15 nodes including [[GraphQL]], 28 edges

3. logseq_get_backlinks("TypeScript")
   → 12 pages with backlinks

4. Present:
   "CONNECTION FOUND (Distance 2):
    [[TypeScript]] → [[API Development]] → [[GraphQL]]

    SHARED CONTEXT:
    - Both referenced in [[API Development]] (8 mentions)
    - Both tagged in [[Backend Architecture]]
    - Co-occur in 3 project pages

    RELATIONSHIP INSIGHTS:
    - GraphQL types written in TypeScript
    - Type safety mentioned in both contexts
    - [[API Development]] is the bridge concept

    RECOMMENDATION: Review [[API Development]] to see how you use them together."
```

### Session 3: Temporal Analysis

```
User: "How has my approach to testing changed this year?"

1. logseq_get_concept_evolution("Testing", 20250101, 20251231, group_by='month')
   → 67 mentions across 11 months

2. logseq_query_by_date_range(20250101, 20250331, "testing")
   → Q1 entries

3. logseq_query_by_date_range(20251001, 20251231, "testing")
   → Q4 entries (current)

4. Present:
   "TESTING EVOLUTION (2025):

    Q1 (Jan-Mar): Learning phase
    - 18 mentions: Unit testing basics, TDD introduction
    - Focus: Jest, Vitest setup

    Q2 (Apr-Jun): Adoption
    - 24 mentions: Integration tests, test architecture
    - Focus: Testing strategies, mocking

    Q3 (Jul-Sep): Mastery
    - 15 mentions: Advanced patterns, performance testing
    - Focus: Property-based testing, benchmarks

    Q4 (Oct-Nov): Teaching
    - 10 mentions: Testing guides, team workshops
    - Focus: Documentation, mentoring

    KEY SHIFTS:
    - From learning → practicing → teaching
    - From unit focus → integration + E2E
    - Added property-based testing in Q3

    CURRENT STATE: You're now teaching testing patterns to others."
```

## Summary

Effective LogSeq knowledge graph queries through:

1. **Smart tool selection** - Use single-call solutions when available (build_context, get_context_for_query)
2. **Graph traversal** - Leverage bidirectional links (get_related_pages, get_concept_network)
3. **Temporal analysis** - Track concept evolution and patterns over time
4. **Relationship search** - Find connections between topics semantically
5. **Multi-indicator task queries** (markers + properties)
6. **Synthesis over raw data** (context + recommendations)
7. **User system respect** (read-only, no structural changes)

Remember: You're helping the user leverage their own knowledge, not imposing structure.

For complete tool documentation, see `mcp-tools-reference.md`.
