# Context-Efficient LogSeq Queries

## The Problem

Each LogSeq query returns structured JSON with metadata. A single search with limit=30 and include_context=true can consume 10-20k tokens. Multiple overlapping searches compound the problem exponentially.

## Core Principles

### 1. Start Narrow, Expand If Needed

- Start with `limit=5` and `include_context=false` (the tool's own `limit` default is 100)
- Only increase if results are insufficient
- Never start with limit > 10 for exploratory queries

**Red Flag:** If you're about to set limit=20 or higher on an exploratory `find_blocks` call, STOP and reconsider. A cap raise that a truncation warning names, for a question that needs every result, is a different case: see the paging table in `results-and-limits.md`.

### 2. Discover Vocabulary Before Guessing

If you don't know what pages exist in the user's graph:
→ **Call `logseq_find_pages` FIRST** before searching. With a term in mind, `text` is much cheaper, and `names` checks several exact names in one call. For the whole list, set `limit` to 1000, and while `hasMore` is true call again with the `offset` the warning names
→ Review page names, and each page's aliases, to understand the vocabulary
→ Then search using terms that actually exist

**Red Flag:** About to search for a compound phrase like "engineering experiment"? Check if those pages exist first with `find_pages`.

### 3. Clarify Recency Before Querying

If time scope is ambiguous (no explicit date/timeframe):
→ **ASK USER:** "Was this recent (last week or so) or could it be from any time?"
→ If recent: Use `find_blocks` with `text` and a period (`preset`, `last_n` or dates) for a flat, newest-first list of the matching blocks, or `explore_timeline` with the period alone for the days as they happened
→ If any time: Use `find_blocks` with conservative limits (limit=5-10)

If user provides explicit timeframe ("this week", "in November", "recently"):
→ Use `find_blocks` with `text` and the period (or `explore_timeline` for the period alone) directly, no need to ask

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

`explore_context` replaces manual aggregation chains. Don't follow it with:
- `find_blocks` (already searched)
- a separate look at what links to the page (its `references` are included, ranked, with `references_offset` for the rest)
- `get_page` (already retrieved)

Only add follow-up queries if `explore_context` returns insufficient results. For several pages, call it once per page, in parallel, rather than once for all.

#### 7. Keep Date-Range Results Small Enough to Be Shown

A host may not hand a large tool result to the model. Claude Code saves a result of about 50,000 characters or more to a file and shows the model only the first 2 KB, with the path. A result that is larger still can come back as an error that names the file. Either way the model gets no `summary`, `totals` or `warnings`, which sit at the end of the JSON, so a cut result looks like a complete one. Reading the file in slices pulls the whole result into context anyway. Other hosts have their own limits, and Claude Code's may be configurable, so plan for the smaller one.

Since the character budget (#485), the server cuts each of these tools to 30,000 characters itself and says so with a `result_size_truncated` warning (`results-and-limits.md`), so a result is shown in whole. The sizes below are the uncut ones: they are why the cap in blocks is the handle to page by, and why 200 leaves room for long blocks.

Measured through Claude Code (October 2026) on made-up journals: a result of about 49,000 characters came back inline, and results of about 54,000 and more were saved to a file. The sizes below are from the same journals (about 100 characters of content per block, child blocks nested, no marker or properties).

| Call | Size on those journals | Under the limit |
|------|------------------------|-----------------|
| `explore_timeline`, `max_blocks=100` | ~16,000 chars | yes |
| `explore_timeline`, `max_blocks=200` | ~31,000 chars (about 155 per block) | yes, up to about 250 chars per block as returned (about 200 of content) |
| `explore_timeline`, `max_blocks=300` | ~46,000 chars | borderline: inline here, saved for longer blocks |
| `explore_timeline`, `max_blocks=1000` | ~150,000 chars, or ~86,000 for very short blocks | no, saved to a file |
| `explore_timeline`, `include_content=false`, `max_blocks=500` | ~43,000 chars (a snippet is at most 80 characters) | yes on typical page names |
| `explore_timeline`, `max_blocks=1`, `top_concepts_limit=0` | ~1,000 chars | yes |

What to do:

- **Page small.** For a period's journals use `max_blocks=200` and follow the `blocks_truncated` warning's `start_date` until a result has no warning. Don't raise the cap to avoid a second call. A block's size is unknown before the call, so the cap in blocks is the only handle, and 200 leaves room for long blocks.
- **Use `include_content=false` for shape.** Its size is bounded by the cap and not by block length (at most 80 characters per snippet, plus page names in `topConcepts`), so `max_blocks=500` is shown on typical page names. `summary.totalBlocks` there counts top-level blocks.
- **Size a range cheaply.** `max_blocks=1` with `top_concepts_limit=0` costs about 1,000 characters, and its `blocks_truncated` warning carries `totals.blocks` (nested blocks) and `totals.days` for the whole range. A range with no warning had 1 block or fewer.
- **If a result is saved to a file anyway** (the message says "Output too large" or "exceeds maximum allowed tokens" and names a file), don't open it. Repeat the call with a lower `max_blocks` (halve it) or one day per call. A single day that is still saved can't be read whole: read it in pieces with `find_blocks` (`start_date` and `end_date` set to that day, a `text` per name, person or marker you are after, with `limit` and `offset`) and say that part of the day went unread. A day-sized call at `max_blocks=500` is often too big too: about 75,000 characters on the journals above.

## Decision Flowchart

```
Do you know what pages exist in the graph?
  │
  ├─ NO → logseq_find_pages first (text, names, or limit 1000 and follow offset while hasMore)
  │        → Then continue with search using known vocabulary
  │
  └─ YES → [Continue below]

Does the question have an EXPLICIT timeframe?
("this week", "in November", "today", "recently")
  │
  ├─ YES → find_blocks(text=keyword, period)
  │        DONE - don't add backup searches
  │
  └─ NO → Is the timeframe AMBIGUOUS?
          ("the X that Y sent", "where is the budget sheet")
            │
            ├─ YES → ASK USER about recency first
            │        → Recent: find_blocks(text, period)
            │        → Any time: find_blocks(text, limit=5)
            │
            └─ NO → Is it a "what do I know about X" question?
                      │
                      ├─ YES → explore_context(page, max_blocks=20)
                      │        DONE - trust this tool
                      │
                      └─ NO → find_blocks(text, limit=5-10)
```

## Anti-Patterns

| Anti-Pattern | Token Cost | Better Approach | Token Cost |
|--------------|------------|-----------------|------------|
| `find_blocks(text, limit=30, include_context=true)` | 10-20k | `find_blocks(text, limit=5)` | 1-2k |
| Multiple parallel overlapping searches | 2-3x waste | Single targeted search | 1x |
| `explore_context` + `find_blocks` + a second look at the links | 15-25k | `explore_context` alone | 5-8k |
| "Backup" searches "just in case" | +5-10k each | Expand ONLY if needed | 0 |
| Searching for compound phrases blindly | wasted turns | `find_pages` → targeted search | 1 extra call |

## Common Rationalizations (Don't Fall For These)

| Excuse | Reality |
|--------|---------|
| "I want to be thorough" | Thoroughness = wasted context. Start narrow. |
| "What if the first search misses it?" | Try first search. Expand IF it fails. |
| "include_context gives better understanding" | It also costs 2-3x tokens. Only use when needed. |
| "Parallel searches are faster" | Parallel overlapping searches waste context. One query first. |
| "explore_context might miss something" | It's comprehensive by design. Trust it. |

## Quick Reference

| Scenario | First Tool | Parameters | Ask User? |
|----------|------------|------------|-----------|
| "this week" / explicit time | `find_blocks` (a word) or `explore_timeline` (the period) | text and a period | No |
| "how did page X change" | `explore_timeline` | page=X, group_by | No |
| "the X that Y sent" | - | - | YES - about recency |
| "what do I know about X" | `explore_context` | max_blocks=20 | No |
| "what pages do I have" | `find_pages` | text filter | No |
| searching blind | `find_pages` | - | No - call first |
| "find X" (general) | `find_blocks` | text, limit=5 | Maybe |
