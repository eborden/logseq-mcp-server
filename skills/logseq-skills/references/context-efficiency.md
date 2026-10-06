# Context-Efficient LogSeq Queries

## The Problem

Each LogSeq query returns structured JSON with metadata. A single search with limit=30 and include_context=true can consume 10-20k tokens. Multiple overlapping searches compound the problem exponentially.

## Core Principles

### 1. Start Narrow, Expand If Needed

- Default: `limit=5`, `include_context=false`
- Only increase if results are insufficient
- Never start with limit > 10 for exploratory queries

**Red Flag:** If you're about to set limit=20 or higher, STOP and reconsider.

### 2. Discover Vocabulary Before Guessing

If you don't know what pages exist in the user's graph:
→ **Call `logseq_list_pages(limit=1000)` FIRST** before searching. While `hasMore` is true, call again with the `offset` the warning names. With a term in mind, `name_contains` is much cheaper
→ Review page names, and each page's aliases, to understand the vocabulary
→ Then search using terms that actually exist

**Red Flag:** About to search for a compound phrase like "engineering experiment"? Check if those pages exist first with `list_pages`.

### 3. Clarify Recency Before Querying

If time scope is ambiguous (no explicit date/timeframe):
→ **ASK USER:** "Was this recent (last week or so) or could it be from any time?"
→ If recent: Use `query_by_date_range` with `search_term` filter
→ If any time: Use `search_blocks` with conservative limits (limit=5-10)

If user provides explicit timeframe ("this week", "in November", "recently"):
→ Use `query_by_date_range` directly, no need to ask

**Red Flag:** About to search without knowing timeframe? ASK FIRST.

### 4. Skip Context Unless Synthesizing

`include_context=true` adds page metadata, refs, tags to EVERY result.
→ Only use when you need to understand relationships
→ Default to `include_context=false`

### 5. One Query Beats Three Overlapping

- **DON'T:** search "nancy budget" AND "nancy spreadsheet" AND "budget document" in parallel
- **DO:** Single search "nancy budget" with limit=5, expand only if no results

**Red Flag:** Planning multiple searches with similar terms? Use ONE query first.

### 6. Trust High-Level Tools

`build_context` replaces manual aggregation chains. Don't follow it with:
- `search_blocks` (already searched)
- `get_backlinks` (already included)
- `get_page` (already retrieved)

Only add follow-up queries if `build_context` returns insufficient results.

### 7. Keep Date-Range Results Small Enough to Be Shown

A host may not hand a large tool result to the model. Claude Code saves a result of about 50,000 characters or more to a file and shows the model only the first 2 KB, with the path. A result that is larger still can come back as an error that names the file. Either way the model gets no `summary`, `totals` or `warnings`, which sit at the end of the JSON, so a cut result looks like a complete one. Reading the file in slices pulls the whole result into context anyway. Other hosts have their own limits, and Claude Code's may be configurable, so plan for the smaller one.

Measured through Claude Code (October 2026) on made-up journals: a result of about 49,000 characters came back inline, and results of about 54,000 and more were saved to a file. The sizes below are from the same journals (about 100 characters of content per block, child blocks nested, no marker or properties).

| Call | Size on those journals | Under the limit |
|------|------------------------|-----------------|
| `query_by_date_range`, `max_blocks=100` | ~16,000 chars | yes |
| `query_by_date_range`, `max_blocks=200` | ~31,000 chars (about 155 per block) | yes, up to about 250 chars per block as returned (about 200 of content) |
| `query_by_date_range`, `max_blocks=300` | ~46,000 chars | borderline: inline here, saved for longer blocks |
| `query_by_date_range`, `max_blocks=1000` | ~150,000 chars, or ~86,000 for very short blocks | no, saved to a file |
| `query_by_date_range`, `include_content=false`, `max_blocks=500` | ~43,000 chars (a snippet is at most 80 characters) | yes on typical page names |
| `query_by_date_range`, `max_blocks=1`, `top_concepts_limit=0` | ~1,000 chars | yes |

What to do:

- **Page small.** For a period's journals use `max_blocks=200` and follow the `blocks_truncated` warning's `start_date` until a result has no warning. Don't raise the cap to avoid a second call. A block's size is unknown before the call, so the cap in blocks is the only handle, and 200 leaves room for long blocks.
- **Use `include_content=false` for shape.** Its size is bounded by the cap and not by block length (at most 80 characters per snippet, plus page names in `topConcepts`), so `max_blocks=500` is shown on typical page names. `summary.totalBlocks` there counts top-level blocks.
- **Size a range cheaply.** `max_blocks=1` with `top_concepts_limit=0` costs about 1,000 characters, and its `blocks_truncated` warning carries `totals.blocks` (nested blocks) and `totals.days` for the whole range. A range with no warning had 1 block or fewer.
- **If a result is saved to a file anyway** (the message says "Output too large" or "exceeds maximum allowed tokens" and names a file), don't open it. Repeat the call with a lower `max_blocks` (halve it) or one day per call. A single day that is still saved can't be read whole: read it in pieces with a `search_term` (one call per name, person or marker you are after) and say that part of the day went unread. A day-sized call at `max_blocks=500` is often too big too: about 75,000 characters on the journals above.

## Decision Flowchart

```
Do you know what pages exist in the graph?
  │
  ├─ NO → logseq_list_pages(limit=1000) first (follow offset while hasMore)
  │        → Then continue with search using known vocabulary
  │
  └─ YES → [Continue below]

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
| Searching for compound phrases blindly | wasted turns | `list_pages` → targeted search | 1 extra call |

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
| "what pages do I have" | `list_pages` | name_contains filter | No |
| searching blind | `list_pages` | - | No - call first |
| "find X" (general) | `search_blocks` | limit=5 | Maybe |
