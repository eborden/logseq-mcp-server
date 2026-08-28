# LogSeq Weekly Summary

Generate a weekly summary from journal entries, compressed to salient signals and linked back to the source journal days.

**Read `references/summary-compression.md` first.** It holds the salience filtering, emotional markers, compression rules, output structure, formatting, unresolved-item verification, and trend contextualization shared by all granularities. This file covers only what is specific to the weekly cadence.

## Granularity Parameters

| | Value |
|---|---|
| Source | Journal entries (raw) |
| Period | Monday through Friday |
| Output | `~/Documents/Logs/pages/Weekly YYYY-MM-DD.md` (the Monday date) |
| Tags | `[[Weekly Summary]]` plus one link per journal day with content |
| Gist label | `- **Week**: ...` |
| Lookback | Previous 2-3 `Weekly *` pages |

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
ls ~/Documents/Logs/pages/ | grep "Weekly YYYY-MM"
```

A file for the target Monday often already exists, because mid-week runs produce partial summaries. **Update it rather than starting fresh.** Read the existing file to preserve signals already captured from earlier days, and drop the partial caveat once the week is complete.

### Step 3: Load Prior Context (Mandatory)

Read the 2-3 most recent `Weekly *` pages to pick up ongoing situations, trend trajectories, and carry-over concerns, then apply the trend contextualization section of the reference.

### Step 4: Fetch the Week's Journals

```
mcp__logseq__logseq_query_by_date_range(
  start_date=<Monday YYYYMMDD>,
  end_date=<Friday YYYYMMDD>,
  slim_results=true
)
```

Always pass `slim_results=true`; it cuts 40-50% of tokens. This single call returns the week's blocks including their markers, so a separate TODO search against the graph is redundant.

### Step 5: Verify Open Items

Confirm which TODOs remain genuinely open, and check for expired item text, per the Unresolved Items section of the reference:

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " ~/Documents/Logs/journals/YYYY_MM_*.md
```

### Step 6: Write and Verify the Page

Apply the compression rules and output structure from the reference, then verify the result:

```bash
awk '/^- ## Signals/{f=1;next}/^- ## Unresolved/{f=0}f&&/^\t- /{c++}END{print c}' <file>
grep -c $'^\t' <file>
grep -n "^- ##" <file>
```

Signal count must be 10 or fewer, indentation must be tabs, and all three sections must be present.
