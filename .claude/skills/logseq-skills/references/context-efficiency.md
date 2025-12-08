# Context-Efficient LogSeq Queries

## The Problem

Each LogSeq query returns structured JSON with metadata. A single search with limit=30 and include_context=true can consume 10-20k tokens. Multiple overlapping searches compound the problem exponentially.

## Core Principles

### 1. Start Narrow, Expand If Needed

- Default: `limit=5`, `include_context=false`
- Only increase if results are insufficient
- Never start with limit > 10 for exploratory queries

**Red Flag:** If you're about to set limit=20 or higher, STOP and reconsider.

### 2. Clarify Recency Before Querying

If time scope is ambiguous (no explicit date/timeframe):
→ **ASK USER:** "Was this recent (last week or so) or could it be from any time?"
→ If recent: Use `query_by_date_range` with `search_term` filter
→ If any time: Use `search_blocks` with conservative limits (limit=5-10)

If user provides explicit timeframe ("this week", "in November", "recently"):
→ Use `query_by_date_range` directly, no need to ask

**Red Flag:** About to search without knowing timeframe? ASK FIRST.

### 3. Skip Context Unless Synthesizing

`include_context=true` adds page metadata, refs, tags to EVERY result.
→ Only use when you need to understand relationships
→ Default to `include_context=false`

### 4. One Query Beats Three Overlapping

- **DON'T:** search "nancy budget" AND "nancy spreadsheet" AND "budget document" in parallel
- **DO:** Single search "nancy budget" with limit=5, expand only if no results

**Red Flag:** Planning multiple searches with similar terms? Use ONE query first.

### 5. Trust High-Level Tools

`build_context` replaces manual aggregation chains. Don't follow it with:
- `search_blocks` (already searched)
- `get_backlinks` (already included)
- `get_page` (already retrieved)

Only add follow-up queries if `build_context` returns insufficient results.

## Decision Flowchart

```
Does the question have an EXPLICIT timeframe?
("this week", "in November", "today", "recently")
  │
  ├─ YES → query_by_date_range(search_term=keyword)
  │        DONE - don't add backup searches
  │
  └─ NO → Is the timeframe AMBIGUOUS?
          ("the X that Y sent", "where is the budget sheet")
            │
            ├─ YES → ASK USER about recency first
            │        → Recent: query_by_date_range
            │        → Any time: search_blocks(limit=5)
            │
            └─ NO → Is it a "what do I know about X" question?
                      │
                      ├─ YES → build_context(topic, max_blocks=20)
                      │        DONE - trust this tool
                      │
                      └─ NO → search_blocks(limit=5-10)
```

## Anti-Patterns

| Anti-Pattern | Token Cost | Better Approach | Token Cost |
|--------------|------------|-----------------|------------|
| `search_blocks(limit=30, include_context=true)` | 10-20k | `search_blocks(limit=5)` | 1-2k |
| Multiple parallel overlapping searches | 2-3x waste | Single targeted search | 1x |
| `build_context` + `search_blocks` + `get_backlinks` | 15-25k | `build_context` alone | 5-8k |
| "Backup" searches "just in case" | +5-10k each | Expand ONLY if needed | 0 |

## Common Rationalizations (Don't Fall For These)

| Excuse | Reality |
|--------|---------|
| "I want to be thorough" | Thoroughness = wasted context. Start narrow. |
| "What if the first search misses it?" | Try first search. Expand IF it fails. |
| "include_context gives better understanding" | It also costs 2-3x tokens. Only use when needed. |
| "Parallel searches are faster" | Parallel overlapping searches waste context. One query first. |
| "build_context might miss something" | It's comprehensive by design. Trust it. |

## Quick Reference

| Scenario | First Tool | Parameters | Ask User? |
|----------|------------|------------|-----------|
| "this week" / explicit time | `query_by_date_range` | search_term filter | No |
| "the X that Y sent" | - | - | YES - about recency |
| "what do I know about X" | `build_context` | max_blocks=20 | No |
| "find X" (general) | `search_blocks` | limit=5 | Maybe |
