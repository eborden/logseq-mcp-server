# LogSeq Context Builder Workflows

Detailed workflows for building comprehensive context from LogSeq knowledge graphs.

## Overview

Build comprehensive context from LogSeq knowledge graphs by searching blocks, following backlinks, and discovering connections. Core principle: **Start broad (search), then focus (get pages), then discover (the references of `explore_context`)**.

## Workflow 1: Research Assistant

**When:** User asks "what do I know about X?" or needs research context.

**4-Phase Approach:**

1. **Search** → `logseq_find_blocks(text=topic, limit=15)` - cast wide net
2. **Retrieve** → `logseq_get_page(relevant_pages, detail="full")` - get full content
3. **Discover** → `logseq_explore_context(page)` for each key page, in parallel - find connections
4. **Synthesize** → Present organized findings with sources

**Example:**
```
User: "What do I know about React hooks?"

1. logseq_find_blocks(text="React hooks", limit=15)
2. logseq_get_page("React", detail="full")
3. logseq_explore_context("React")
4. Synthesize: "You have detailed notes in [[React]] covering useState/useEffect.
   Referenced in [[Project Alpha]] and [[Interview Notes]]. Gap: error boundary hooks."
```

## Workflow 2: Task Prioritization

**When:** User asks about tasks, TODOs, what to work on, or managing their work.

**4-Step Process:**

### Step 1: Find All Tasks

Execute ALL of these to ensure comprehensive coverage:

```
logseq_find_blocks(text="TODO")
logseq_find_blocks(text="DOING")
logseq_find_blocks(property="status", value="todo")
logseq_find_blocks(property="status", value="doing")
logseq_find_blocks(property="status", value="in-progress")
logseq_find_blocks(property="priority", value="high")
logseq_find_blocks(text="SCHEDULED:")  # Get all scheduled tasks
```

**Why check multiple?** Users may use markers ("TODO"), properties (`status::doing`), or both. Check everything. A property value is an exact string, so `todo` does not find `TODO`; a scheduled task is found by its `SCHEDULED:` line, which is text and not a property.

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

1. **Query Scheduled** → `logseq_find_blocks(text="SCHEDULED:")` - find all scheduled tasks
2. **Check Blocked** → Search for "WAITING", "blocked by", or `status::blocked`
3. **Surface Old** → Present tasks scheduled >2 weeks ago with context

**Present:**
- Task content with original scheduled date
- Page/project context
- Suggestion: reschedule, archive, or revive

## Workflow 4: Page Context Building

**When:** User mentions specific page and needs full context.

**With explore_context:**

1. **Quick Context**: `logseq_explore_context(page)`
   - Gets page + blocks + related pages + references + temporal info
   - Single call replaces multiple queries

2. **Manual Context** (only to read a page whole):
   - Get full page: `logseq_get_page(name, detail="full")`
   - Get connections: the `references` of `logseq_explore_context(name)`
   - Extract linked pages from content

3. Synthesize: content summary + connections + usage patterns

## Workflow 5: Graph Exploration

**When:** User wants to explore knowledge network, find related concepts, or understand relationships.

**3-Phase Approach:**

### Phase 1: Visualize Network
```
logseq_explore_network(topic, max_depth=2)
```
- Returns nodes (pages) and edges (connections) in both link directions, each node with its distance from the topic and each edge with its reference counts
- Good for understanding topic centrality
- Identifies hub pages vs. leaf pages
- Capped at 50 pages and cut to 30,000 characters: read the `truncated` flag and the warnings before calling the map complete, and ask about a more specific page or lower `max_depth` for a smaller one
- To ask how two pages connect, pass the second as `to` (`logseq_explore_network(topic, to=other, max_depth=3)`): the result is the shortest path as nodes and edges, and the middle pages are the bridges. If there is none within `max_depth`, a `no_path_within` warning says how far the walk went

### Phase 2: Get the References
```
logseq_explore_context(topic, max_blocks=0, max_related_pages=0)
```
- Find the pages that reference the topic, with the blocks that do (the `references`)
- Complements the network with detailed backlink context
- Keep the defaults (20 references): they cover "what connects to this". More come back with `references_truncated` in the warnings, with `totals.references` giving the real count, and `references_offset` reads the next page (the warning's `howToFetchAll` names the offset). Say the list is partial. The references come ranked by the blocks on their source page that link the topic, most first (ties by name), so the 20 kept are on the pages that link the topic most and the first one listed is the top referrer, which answers "what connects to this" without raising anything. A page left out links the topic no more than the last one kept, but a ranking by count says nothing about which block matters, so a blocker can sit on a page with one linking block. Read on with `references_offset` only when the question needs every referrer (a blocker hunt); each later page can pass `max_blocks=0` and `max_related_pages=0`. The result is cut to 30,000 characters whole; the warning then names the offset to read on from

### Phase 3: Present Insights
- **Core connections**: Pages at distance 1
- **Clusters**: Groups of highly connected pages
- **Bridges**: Pages connecting different clusters
- **Orphans**: Related pages with few connections

**Example:**
```
User: "Show me everything connected to [[Machine Learning]]"

1. logseq_explore_network("Machine Learning", max_depth=2)
   → 23 nodes, 47 edges

2. logseq_explore_context("Machine Learning", max_blocks=0, max_related_pages=0)
   → 15 pages with references

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
logseq_explore_timeline(start_date=..., end_date=...)   # or last_n, or preset
```
- Use YYYYMMDD format (20251101 = Nov 1, 2025)
- To filter a period by a word, use `logseq_find_blocks` with `text` and the same period
- Returns entries sorted chronologically

**For Concept Evolution:**
```
logseq_explore_timeline(page=..., group_by=...)   # a period (both dates) is optional
```
- Tracks how concept appears over time
- Supports grouping: 'day', 'week', 'month'
- Shows temporal patterns and gaps
- Sorted chronologically
- Distinguishes journal vs. non-journal pages (a period leaves the non-journal ones out)

**Example:**
```
User: "How has my thinking on [[Rust]] evolved this year?"

1. logseq_explore_timeline(page="Rust", start_date=20250101, end_date=20251231, group_by="month")
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

**Several topics:**
```
logseq_explore_context("Project X")
logseq_explore_context("Team Meeting")
```
- Pick the pages from the question yourself, and call once per page, in parallel
- Each answer is smaller and is cut on its own; for the words of a question that name no page, use `find_blocks`

**Deep Dives:**
```
logseq_explore_context(topic, max_blocks=50, max_related_pages=10)
```
- Main page with properties
- Direct blocks from page
- Related pages (the pages that link to it)
- Reference blocks mentioning the topic, most-linking pages first, paged with `references_offset`
- Temporal context (for journal pages)
- Summary statistics

**Example:**
```
User: "Give me full context on [[Q4 Planning]]"

1. logseq_explore_context("Q4 Planning", max_blocks=50, max_related_pages=15)
   → Comprehensive aggregation

2. Present:
   "Q4 PLANNING CONTEXT:

    MAIN PAGE:
    - 23 blocks (goals, milestones, retrospective)
    - Properties: quarter::4, year::2025, status::active

    RELATED PAGES (15 of 15, the pages that link to it)

    REFERENCES (14), most-linking pages first:
    - [[Weekly Standup]] (7 linking blocks)
    - [[Engineering Notes]] (4 linking blocks)
    - [[Leadership Meeting]] (3 linking blocks)

    TEMPORAL CONTEXT:
    - Not a journal page (a journal page reports its date)

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
| Incomplete context | Use `explore_context` |
| Poor search results | Pick the pages and call `explore_context` for each, or use `find_blocks` for the words |
| Date queries unclear | Use `explore_timeline` with YYYYMMDD format |
| Lost connections | Use `explore_network` with max_depth=2, or with `to` for how two pages connect |
| Manual aggregation | Use `explore_context` instead of multiple queries |
| Shallow exploration | Use `explore_network` to see the pages around a page |
| Time patterns unclear | Use `explore_timeline` with `page` and `group_by` |

## Performance Tips

### Smart Tool Selection:

**Single-call solutions (fastest):**
- `explore_context` - Replaces 5+ separate queries; one call per page, in parallel for several
- `explore_network` - The pages around a page, or the shortest path to a second one, in one call

**Multi-call workflows (when needed):**
- Broad exploration: `find_blocks` → `get_page` → `explore_context`
- Specific deep-dive: `get_page` → `get_related_pages`
- Structured data: `find_blocks` with `property` and `value` for precise matches

**Limit parameters:**
- Use `max_blocks`, `max_related_pages` to control response size
- Use `depth` and `max_depth` carefully (depth=1 usually sufficient)
- Use `limit` on find_blocks to avoid overwhelming results

**Best practices:**
- Prefer `explore_context` over manual aggregation, and one call per page over several searches
- Use `find_blocks` with `page` and `links_to` instead of filtering results manually, and `explore_network` with `to` to ask how two pages connect, and through which pages

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

1. logseq_explore_network("TypeScript", to="GraphQL", max_depth=3)
   → The shortest path, as nodes and edges: [[TypeScript]], [[API Development]], [[GraphQL]]
     (2 hops, each edge with its reference counts). With no path within 3 hops the result
     says `no_path_within` and names the depth reached

2. logseq_explore_network("TypeScript", max_depth=2)
   → Network analysis: 15 nodes including [[GraphQL]], 28 edges

3. logseq_explore_context("TypeScript", max_blocks=0, max_related_pages=0)
   → 12 pages with references

4. Present:
   "CONNECTION FOUND (2 hops):
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

1. logseq_explore_timeline(page="Testing", start_date=20250101, end_date=20251231, group_by="month")
   → 67 mentions across 11 months

2. logseq_find_blocks(text="testing", start_date=20250101, end_date=20250331)
   → Q1 entries

3. logseq_find_blocks(text="testing", start_date=20251001, end_date=20251231)
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

1. **Smart tool selection** - Use single-call solutions when available (explore_context)
2. **Graph traversal** - Leverage bidirectional links (get_related_pages, explore_network)
3. **Temporal analysis** - Track concept evolution and patterns over time
4. **Relationship search** - Find how two pages connect, as a path of links
5. **Multi-indicator task queries** (markers + properties)
6. **Synthesis over raw data** (context + recommendations)
7. **User system respect** (read-only, no structural changes)

Remember: You're helping the user leverage their own knowledge, not imposing structure.

For complete tool documentation, see `mcp-tools-reference.md`.
