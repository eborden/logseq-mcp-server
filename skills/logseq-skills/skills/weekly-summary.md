# LogSeq Weekly Summary

Generate a weekly summary from journal entries, compressed to salient signals and linked back to the source journal days.

**Routing:** this is for one Monday-Friday week, built from raw journals. For a month, or trends across weeks, use `skills/monthly-summary.md`. To add `[[links]]` to a note, use `skills/concept-linking.md`.

**Read `references/summary-compression.md` first.** It holds the salience filtering, emotional markers, compression rules, output structure, formatting, unresolved-item verification, and trend contextualization shared by all granularities. This file covers only what is specific to the weekly cadence.

## Granularity Parameters

| | Value |
|---|---|
| Source | Journal entries (raw) |
| Period | Monday through Friday |
| Output | `<graph>/pages/Weekly YYYY-MM-DD.md` (the Monday date) |
| Tags | `[[Weekly Summary]]` plus one link per journal day with content |
| Gist label | `- **Week**: ...` |
| Lookback | Previous 2-3 `Weekly *` pages |

`<graph>` is the graph root; get it from `logseq_get_graph_info`. Never hardcode it.

## Workflow

### Step 1: Resolve the Date Range

Work weeks run Monday through Friday. Confirm the current date and year before calculating — using the wrong year is the most common failure in this workflow.

```bash
date "+%Y-%m-%d %A"
```

- "this week" → the current Monday through today (or Friday when the week is complete)
- "last week" → the previous Monday through Friday
- Monday's date identifies the output file

When the week is incomplete, note the boundary in the gist per the partial-period rule in the reference.

### Step 2: Check for an Existing Summary

```bash
ls <graph>/pages/ | grep "Weekly YYYY-MM"
```

A file for the target Monday often already exists, because mid-week runs produce partial summaries. **Update it rather than starting fresh.** Read the existing file to preserve signals already captured from earlier days, and drop the partial caveat once the week is complete.

### Step 3: Load Prior Context (Mandatory)

Read the 2-3 most recent `Weekly *` pages to pick up ongoing situations, trend trajectories, and carry-over concerns, then apply the trend contextualization section of the reference.

**Read them for trend CONTENT only, never for style.** Pages written before the word budget existed run well over it, with multi-sentence bullets and em-dashes. They are not the target. The reference's Compression Rules outrank any precedent in the graph; if a prior summary and the budget disagree on length, the budget wins.

### Step 4: Fetch the Week's Journals

```
logseq_query_by_date_range(
  start_date=<Monday YYYYMMDD>,
  end_date=<Friday YYYYMMDD>,
  max_blocks=200
)
```

Results are slim by default, which cuts 40-50% of tokens; don't pass `slim_results=false`. Slim blocks keep `uuid`, `content`, `marker` and `properties`, which is all this skill reads. This call returns the week's blocks including their markers, so a separate TODO search against the graph is redundant.

**Keep `max_blocks` at 200 and read the week in pages.** The host may not show a large result: Claude Code saves a tool result of about 50,000 characters or more to a file and shows only its first 2 KB, which leaves out the `summary` and `warnings` at the end. At 1000 blocks a dense week passes that limit (see `references/context-efficiency.md`), so the cap stays at 200, which stays under the limit for blocks up to about 250 characters. A busy week holds more, and the cap keeps the oldest days first, so continue until you reach Friday:

1. If the result has a `blocks_truncated` warning, call again with the same `end_date` and `max_blocks`, and the `start_date` the warning gives. That is the first day not shown, or the day the cut fell inside, which repeats its kept blocks, so read it from the start. Repeat until a result has no warning. A week takes at most a handful of calls.
2. If the warning says the first day alone fills the cap, that day holds more than 200 blocks. Query it by itself with `max_blocks=300`. If it still says the day fills the cap, or comes back saved, don't go higher: the warning's advice to raise `max_blocks` doesn't know the host's limit, and a bigger cap can pass it. Read that day in pieces with a `search_term`, one call per thing you are after, such as a name from `summary.topConcepts`, a person, or `TODO`. Say in the gist that part of that day went unread.
3. If a result comes back saved to a file instead of shown (the host says the output is too large and names a file), don't open the file. Repeat the call with `max_blocks=100`, or one day per call. If a day still comes back saved, read it with a `search_term` as in step 2.

Say in the gist when you could not read some part of the week, rather than summarizing as if you had. A kept block with `childrenTruncated: true` shows only some of its children; fetch it with `get_block` and `include_children` if they matter. `totals` (`{ blocks, days }`) is range-wide: what the whole range held before the cut, not what one block lost. `summary` covers every block in the range on every page.

When the result has `summary.topConcepts` (`[{ name, count, days }]`, the pages linked most that week), start there. A concept with a high `days` came up all week and a high `count` with `days` of 1 was one busy day. Use it to pick which threads to read closely in the blocks; it is a starting point, not the salience filter. Pass `top_concepts_limit` to change the default of 10. Skip it when the field is absent.

### Step 5: Verify Open Items

Confirm which TODOs remain genuinely open, and check for expired item text, per the Unresolved Items section of the reference:

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " <graph>/journals/YYYY_MM_*.md
```

### Step 6: Write and Verify the Page

Apply the compression rules and output structure from the reference, then verify the result:

```bash
awk '/^- ## Signals/{f=1;next}/^- ## Unresolved/{f=0}f&&/^\t- /{c++}END{print c}' <file>
grep -c $'^\t' <file>
grep -n "^- ##" <file>
```

Signal count must be 10 or fewer, indentation must be tabs, and all three sections must be present.
