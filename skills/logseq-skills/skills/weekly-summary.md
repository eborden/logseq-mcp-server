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
| Source line | `source::` under the tags line: the period query's roll-up (Step 6) |
| Gist label | `- **Week**: ...` |
| Lookback | Previous 2-3 `Weekly *` pages |

`<graph>` is the graph root; get it from `logseq_get_graph_info` (Step 0). Never hardcode it.

## Workflow

### Step 0: Load the LogSeq Tools and Query the Period First

The journals are also files in `<graph>/journals/`, and reading files needs no setup, so a run drifts into `cat`, `head` and `grep` over them. Don't. The files lack what the query rolls up (`summary.topConcepts`, `totals`), and a file cut short with `head` or `cut` loses the end of a day without saying so, which is where meeting outcomes and hand-offs sit.

1. If the `logseq_*` tools are deferred (listed by name, schema not loaded) or missing from your tool list, load them now with your host's tool search. One search call is the whole cost.
2. Call `logseq_get_graph_info`. Its `path` is `<graph>`. Take the path from nowhere else, including a note, an earlier session or a CLAUDE.md.
3. Run Step 4's period query as soon as Step 1 has the dates, before Steps 2 and 3. No shell command that lists or reads `<graph>` (`ls`, `cat`, `head`, `grep`) comes before that query has returned. The `date` command in Step 1 is fine.

A journal file is a fallback for a tool call that has failed, never for a tool you hadn't loaded. See "Reading the Period" in the reference.

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

**Keep `max_blocks` at 200 and read the week in pages.** The host may not show a large result: Claude Code saves a tool result of about 50,000 characters or more to a file and shows only its first 2 KB, which leaves out the `summary` and `warnings` at the end. At 1000 blocks a dense week passes that limit (see `references/context-efficiency.md`), so the cap stays at 200, which stays under the limit for blocks of up to about 200 characters of content (about 250 as returned). A busy week holds more, and the cap keeps the oldest days first, so continue until you reach Friday:

1. If the result has a `blocks_truncated` warning, call again with the same `end_date` and `max_blocks`, and the `start_date` the warning gives. That is the first day not shown, or the day the cut fell inside, which repeats its kept blocks, so read it from the start. Repeat until a result has no warning. The warning also says to set `max_blocks` to 1000. Don't: it doesn't know the host's limit, and 1000 is the call that gets saved. Take only its `start_date`. A dense week can take 10 or more calls, because each day over 200 blocks costs a paged call and a one-day call (step 2). That is the workflow working, not a loop.
2. If the warning says the first day alone fills the cap, that day holds more than 200 blocks. Query it alone, with `start_date` and `end_date` both that day and `max_blocks=300`, then continue paging from the next day with `max_blocks=200`. If the one-day call still says the day fills the cap, or comes back saved, don't go higher. Read that day in pieces with a `search_term`, one call per thing you are after, such as a name from `summary.topConcepts`, a person, or `TODO`, then continue paging from the next day. Say in the gist that part of that day went unread.
3. If a result comes back saved to a file instead of shown (the host says the output is too large and names a file), don't open the file. Repeat the call with `max_blocks=100`, or one day per call. If a day still comes back saved, read it with a `search_term` as in step 2.

Say in the gist when you could not read some part of the week, rather than summarizing as if you had. A kept block with `childrenTruncated: true` shows only some of its children; fetch it with `get_block` and `include_children` if they matter. `totals` (`{ blocks, days }`) is range-wide: what the whole range held before the cut, not what one block lost. The first page's `summary` covers the whole week, even where its entries stop early. A later page's covers only from its `start_date`, so take the week's `topConcepts` from the first page.

Keep three things from the first page's `summary` for Step 6: `totalDays`, `totalBlocks`, and the first five `topConcepts`. They are the roll-up the page records, and the gate checks for them.

When the result has `summary.topConcepts` (`[{ name, count, days }]`, the pages linked most that week), start there. A concept with a high `days` came up all week and a high `count` with `days` of 1 was one busy day. Use it to pick which threads to read closely in the blocks; it is a starting point, not the salience filter. Pass `top_concepts_limit` to change the default of 10. Skip it when the field is absent.

### Step 5: Verify Open Items

Confirm which TODOs remain genuinely open, and check for expired item text, per the Unresolved Items section of the reference:

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " <graph>/journals/YYYY_MM_*.md
```

This `grep` reads marker state only. It doesn't replace Step 4: it can't tell you what the week held, and it shows nothing of a day that has no open item.

### Step 6: Write and Verify the Page

Apply the compression rules and output structure from the reference. Under the tags line, add the roll-up from Step 4:

```
source:: query_by_date_range 20250106-20250110; days 5; blocks 250; top Project Atlas 12/4, Alice 9/2
```

The range is the Monday and Friday you queried. `days` and `blocks` are `summary.totalDays` and `summary.totalBlocks` from the first page, and `top` is the first five `summary.topConcepts` as `name count/days` (`top none` when the field is absent). Write no `[[brackets]]` in it. Then verify the result:

```bash
awk '/^- ## Signals/{f=1;next}/^- ## Unresolved/{f=0}f&&/^\t- /{c++}END{print c}' <file>
grep -c $'^\t' <file>
grep -n "^- ##" <file>
```

Signal count must be 10 or fewer, indentation must be tabs, and all three sections must be present.

Then run the gate, which also checks the `source::` line:

```bash
<skill-dir>/scripts/check-terseness.sh "<graph>/pages/Weekly YYYY-MM-DD.md"
```

A page with no `source::` line fails: it was not built from the period query. Don't write the line without having run the query, and don't invent the numbers. If a tool call failed, say so in the gist, write `source:: files; <the error>` and pass `--allow-files` to the gate.
