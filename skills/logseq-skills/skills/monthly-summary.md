# LogSeq Monthly Summary

Generate a monthly summary by compressing the month's weekly summaries into month-altitude signals, each carrying an explicit trajectory against prior months.

**Routing:** this is for a whole month, built from the `Weekly *` pages. For a single week, use `skills/weekly-summary.md` (and write the weeklies first if they are missing).

**Read `references/summary-compression.md` first.** It holds the shared compression philosophy, emotional markers, output structure, formatting, and unresolved-item verification. This file covers only what is specific to the monthly cadence.

## Granularity Parameters

| | Value |
|---|---|
| Source | The month's `Weekly *` pages — a summary of summaries |
| Period | Calendar month |
| Output | `<graph>/pages/Monthly YYYY-MM.md` |
| Tags | `[[Monthly Summary]]` plus one `[[Weekly YYYY-MM-DD]]` link per constituent week |
| Source line | `source::` under the tags line: the month-shape query's roll-up (Step 6) |
| Gist label | `- **Month**: ...` |
| Lookback | Previous 1-2 `Monthly *` pages |

`<graph>` is the graph root; get it from `logseq_get_graph_info` (Step 0). Never hardcode it.

## What Makes Monthly Different

**Weekly compresses. Monthly diffs.**

A weekly summary reduces five days of journals to what mattered. A monthly summary reveals *trajectories* that are invisible at week altitude — month scale is where "vendor scoping" and "vendor estimate tripled" become recognizable as one story.

Flattening four weeklies into a list of what happened is the default failure mode of this workflow. It produces a page containing no information the weeklies did not already hold. Step 4 exists to prevent it and is not optional.

Two further consequences of the altitude shift:

- **Compression is far more aggressive.** Four weeklies carry up to 50 signals into a target of 10 and a 200-word ceiling. Expect to merge heavily; an item that earned its own weekly signal usually does not earn its own monthly one. See the budget table in the reference: monthly allows more words per signal than weekly (a trajectory takes more words than a fact) but fewer items.
- **Staleness becomes signal.** A TODO three days old is unremarkable. The same TODO carried across four consecutive weeks is itself worth stating.

## Workflow

### Step 0: Load the LogSeq Tools and Query the Month First

The journals are also files in `<graph>/journals/`, and reading files needs no setup, so a run drifts into `cat`, `head` and `cut` over them. Don't. The files lack what the query rolls up (`summary.topConcepts`, `totals`), and a file cut short with `head` or `cut` loses the end of a day without saying so. That is where meeting outcomes and hand-offs sit, and a monthly built on a cut file can get a trajectory wrong.

1. If the `logseq_*` tools are deferred (listed by name, schema not loaded) or missing from your tool list, load them now with your host's tool search. One search call is the whole cost.
2. Call `logseq_get_graph_info`. Its `path` is `<graph>`. Take the path from nowhere else, including a note, an earlier session or a CLAUDE.md.
3. Run Step 3's month-shape query as soon as Step 1 has the month's dates, before Step 2 and before Step 3 reads the weeklies. No shell command that lists or reads `<graph>` (`ls`, `cat`, `head`, `grep`) comes before that query has returned. The `date` command in Step 1 is fine.

A journal file is a fallback for a tool call that has failed, never for a tool you hadn't loaded. See "Reading the Period" in the reference.

### Step 1: Resolve the Month and Its Weeks

Confirm the current date and year first.

```bash
date "+%Y-%m-%d %A"
ls <graph>/pages/ | grep -E "Weekly YYYY-MM"
```

Calendar months do not align to work weeks. Handle the boundaries explicitly:

- A week straddling two months belongs to the month holding most of its days, but attribute its individual content to the correct month.
- **Trailing days are the common trap.** A month ending on a Monday or Tuesday leaves business days whose weekly page does not exist yet. State them as outstanding in the gist rather than silently omitting them — for example "through Fri Aug 28; Mon Aug 31 still outstanding".

### Step 2: Check for an Existing Summary

```bash
ls <graph>/pages/ | grep "Monthly YYYY-MM"
```

Update in place when one exists, the same as the weekly workflow.

### Step 3: Read the Constituent Weeklies and Prior Months

Read every `Weekly *` page in the month, plus the 1-2 most recent `Monthly *` pages for trajectory context.

**Read prior pages for trend CONTENT only, never for style.** Summaries written before the word budget existed run well over it, with multi-sentence bullets and em-dashes. They are not the target. The reference's Compression Rules outrank any precedent in the graph; if a prior summary and the budget disagree on length, the budget wins.

**Guard against lossy-of-lossy compression.** The weeklies are themselves compressed, so anything they dropped is invisible from here, and one weak weekly permanently distorts the month. Spot-check the raw journals for the month's highest-salience days — the ones the weeklies flagged with `**Milestone:**` or `**Frustration:**` — rather than trusting the summaries alone:

```
logseq_query_by_date_range(start_date=..., end_date=..., max_blocks=200)
```

Do the spot-check with this query, not with a `grep` over `journals/`. A `grep` returns only the lines you thought to search for, so it can miss the later entry that hands an item off and changes its trajectory. To look for one name or marker, pass it as `search_term`.

For the month's overall shape, `query_by_date_range` with `include_content=false`, `max_blocks=500` and `top_concepts_limit=20` returns `summary.topConcepts` (`[{ name, count, days }]`) and one snippet per top-level block, without the blocks. A concept with a high `days` ran through the month, which makes it a candidate for a trajectory in Step 4. Check any candidate against the weeklies, because the roll-up counts links and knows nothing about salience. Skip this when the field is absent.

**Keep each call small enough to be shown, and keep each to its job.** The host may not show a large result: Claude Code saves a tool result of about 50,000 characters or more to a file and shows only its first 2 KB, which leaves out the `summary` and `warnings` at the end (see `references/context-efficiency.md`). So the caps are not 1000.

- **The month-shape call** (`include_content=false`) covers the whole month with `max_blocks=500`. With `include_content=false` the cap counts top-level blocks, and a snippet is at most 80 characters, so 500 snippets are bounded by the cap and not by block length: about 45,000 characters on typical page names. The default of 200 keeps the oldest days first and a month usually exceeds it. The first page's `summary` (`topConcepts`, `totalDays`, `totalBlocks`) covers the whole month, even where its snippets stop early. A later page's covers only from its `start_date`, so read the month's `topConcepts` and their `days` from the first page, and don't build a trajectory from a later page's.
- **The spot-check call** (with content) covers the flagged days: one day, or a narrow range around it, with `max_blocks=200`. A month-wide content query returns only the oldest days at that cap, so it is the exception.

Read in pages. A `blocks_truncated` warning on either call means the entries stopped at the day it names (`the entries end at <day>`). Call again with the same `end_date`, `include_content` and `max_blocks`, and the `start_date` the warning gives. The warning also says to set `max_blocks` to 1000. Don't: it doesn't know the host's limit, and 1000 is the call that gets saved. Take only its `start_date`. The `start_date` is the first day not shown, or the day the cut fell inside (that day repeats its kept blocks, so read it from the start). Repeat until a result has no warning, or until you have what the step needs. Where the weeklies are missing for the days after a cut you stopped at, say in the gist that they weren't read.

- If the warning says the first day alone fills the cap, that day holds more than the cap. Query it alone, with `start_date` and `end_date` both that day and `max_blocks=300` (content) or `500` (`include_content=false`), then continue paging from the next day with the original cap. If the one-day call still says the day fills the cap, or comes back saved, don't go higher. Read that day in pieces with a `search_term`, one call per thing you are after, such as a name from `summary.topConcepts`, a person, or `TODO`, then continue paging from the next day. Say in the gist that part of that day went unread.
- If a result comes back saved to a file instead of shown (the host says the output is too large and names a file), don't open the file. Repeat the call with `max_blocks=100`, or one day per call. If a day still comes back saved, read it with a `search_term` as in the line above.

A kept block with `childrenTruncated: true` shows only some of its children; fetch it with `get_block` and `include_children` if they matter. `totals` (`{ blocks, days }`) is range-wide: what the whole range held before the cut, not what one block lost.

Keep three things from the month-shape call's first page `summary` for Step 6: `totalDays`, `totalBlocks`, and the first five `topConcepts`. They are the roll-up the page records, and the gate checks for them. If you skipped the month-shape call, make it now: the spot-check call alone doesn't cover the month.

### Step 4: Diff Against Prior Months

For each candidate signal, determine its trajectory and state the delta in the signal text itself:

- Did it appear in a prior month? → escalating, improving, or unchanged
- Has it resolved? → say so explicitly, or drop it
- Is it genuinely new? → flag it as a first occurrence

A candidate that cannot be given a trajectory is usually a weekly-altitude detail that should be merged or dropped.

Good: "The [[Vendor]] engagement went from scoping in April to a 3x estimate by Jun 28, with the audit still unfinished." (21 words, carries a trajectory)

Weak: "[[Vendor]] remediation is expensive." (no trajectory, no delta, no date)

The `(N words)` note is a teaching aid. Do not write it into a real summary.

### Step 5: Verify Open Items Across the Whole Month

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " <graph>/journals/YYYY_MM_*.md
```

This `grep` reads marker state only. It doesn't replace the Step 3 queries: it can't tell you what the month held, and it shows nothing of a day that has no open item.

Carry forward only genuinely open items. Apply the expired-text check from the reference with extra care at this altitude — a TODO carrying a deadline in its own words has usually come due within a month.

### Step 6: Write and Verify the Page

Apply the shared output structure. Under the tags line, add the roll-up from Step 3:

```
source:: query_by_date_range 20250101-20250131; days 22; blocks 330; top Project Atlas 14/9, Alice 9/6
```

The range is the whole month you queried. `days` and `blocks` are `summary.totalDays` and `summary.totalBlocks` from the month-shape call's first page, and `top` is the first five `summary.topConcepts` as `name count/days` (`top none` when the field is absent). Write no `[[brackets]]` in it. Then run the mandatory gate:

```bash
<skill-dir>/scripts/check-terseness.sh "<graph>/pages/Monthly YYYY-MM.md"
```

It detects the monthly granularity from the filename and applies the monthly budget (12-18 words per signal, 200 words total, 10 items target / 12 max, zero em-dashes). A non-zero exit means rewrite and re-run. The gate also fails a page with no `source::` line: it was not built from the month-shape query. Don't write the line without having run the query, and don't invent the numbers. If a tool call failed, say so in the gist, write `source:: files; <the error>` and pass `--allow-files` to the gate.

The gate cannot check two things, so check them by eye: all three sections present with tab indentation, and **every signal carries a trajectory or an explicit reason it is new**. A monthly signal with no delta is a weekly-altitude detail that should have been merged or dropped.
