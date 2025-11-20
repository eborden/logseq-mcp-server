---
name: logseq-context-builder
description: Use when user asks about tasks, research, notes, or references their LogSeq knowledge graph - builds comprehensive context from disparate blocks via bidirectional links, searches for TODO/DOING tasks, and synthesizes information from the user's personal knowledge base
---

# LogSeq Context Builder

## Overview

Build comprehensive context from LogSeq knowledge graphs by searching blocks, following backlinks, and discovering connections. Core principle: **Start broad (search), then focus (get pages), then discover (backlinks)**.

## When to Use

**Use when:**
- User asks about their tasks, TODOs, or what to work on
- User asks "what do I know about X?"
- User references their LogSeq notes or knowledge graph
- User wants to find stale or forgotten tasks

**Don't use when:**
- Question doesn't relate to their LogSeq graph
- User asks about general knowledge (not their personal notes)

## Available MCP Tools

Quick reference for the 5 LogSeq tools:

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `logseq_search_blocks` | Full-text search across graph | query, limit (default: 10) |
| `logseq_get_page` | Get complete page content | page_name, include_children |
| `logseq_get_backlinks` | Find all references to a page | page_name |
| `logseq_get_block` | Get specific block by UUID | block_uuid, include_children |
| `logseq_query_by_property` | Find blocks by property value | property_key, property_value |

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

1. Get full page: `logseq_get_page(name, includeChildren=true)`
2. Get connections: `logseq_get_backlinks(name)`
3. Extract linked pages from content
4. Synthesize: content summary + connections + usage patterns

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

## Tool Selection Guide

**For initial exploration:**
- Start with `logseq_search_blocks` (broad coverage)

**For structured queries:**
- Use `logseq_query_by_property` (tasks, status, priorities)

**For deep dives:**
- Use `logseq_get_page` with `includeChildren=true` (full content)

**For discovering connections:**
- Use `logseq_get_backlinks` (see how concepts are used)

**For specific blocks:**
- Use `logseq_get_block` when you have a UUID

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Missing tasks | Check BOTH markers and properties |
| Incomplete context | Always get backlinks for key pages |
| Poor search results | Try broader terms, iterate |
| Date queries unclear | Query all, filter in analysis |
| Lost connections | Follow backlinks 1-2 hops deep |

## Performance Tips

- **Broad exploration**: Search → Get specific pages
- **Specific deep-dive**: Get page first → Backlinks
- **Structured data**: Property queries
- **Limit recursion**: Don't follow every link (ask user first)

## Example Complete Session

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

## Summary

This skill teaches effective LogSeq knowledge graph queries through:

1. **Search-first strategy** for broad understanding
2. **Backlink discovery** for hidden connections
3. **Multi-indicator task queries** (markers + properties)
4. **Synthesis over raw data** (context + recommendations)
5. **User system respect** (read-only, no structural changes)

Remember: You're helping the user leverage their own knowledge, not imposing structure.
