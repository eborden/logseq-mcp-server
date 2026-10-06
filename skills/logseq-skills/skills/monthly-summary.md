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
| Gist label | `- **Month**: ...` |
| Lookback | Previous 1-2 `Monthly *` pages |

`<graph>` is the graph root; get it from `logseq_get_graph_info`. Never hardcode it.

## What Makes Monthly Different

**Weekly compresses. Monthly diffs.**

A weekly summary reduces five days of journals to what mattered. A monthly summary reveals *trajectories* that are invisible at week altitude — month scale is where "vendor scoping" and "vendor estimate tripled" become recognizable as one story.

Flattening four weeklies into a list of what happened is the default failure mode of this workflow. It produces a page containing no information the weeklies did not already hold. Step 4 exists to prevent it and is not optional.

Two further consequences of the altitude shift:

- **Compression is far more aggressive.** Four weeklies carry up to 50 signals into a target of 10 and a 200-word ceiling. Expect to merge heavily; an item that earned its own weekly signal usually does not earn its own monthly one. See the budget table in the reference: monthly allows more words per signal than weekly (a trajectory takes more words than a fact) but fewer items.
- **Staleness becomes signal.** A TODO three days old is unremarkable. The same TODO carried across four consecutive weeks is itself worth stating.

## Workflow

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
logseq_query_by_date_range(start_date=..., end_date=..., max_blocks=1000)
```

For the month's overall shape, `query_by_date_range` with `include_content=false` and `top_concepts_limit=20` returns `summary.topConcepts` (`[{ name, count, days }]`) without the blocks. A concept with a high `days` ran through the month, which makes it a candidate for a trajectory in Step 4. Check any candidate against the weeklies, because the roll-up counts links and knows nothing about salience. Skip this when the field is absent.

**Pass `max_blocks=1000` on both calls, and keep each one to its job.**

- **The month-shape call** (`include_content=false`) covers the whole month. The default of 200 keeps the oldest days first, and with `include_content=false` the cap counts top-level blocks, which a month usually exceeds, so without `max_blocks=1000` the snippets stop weeks early. Even at 1000 they can stop early in a very busy month, while `summary` (`topConcepts`, `totalDays`, `totalBlocks`) still covers every block in the month.
- **The spot-check call** (with content) should cover the flagged days: one day, or a narrow range around it, not the month. At 1000 a month-wide content query can return up to 1000 blocks, so it is the exception. The cap is then rarely reached, and `max_blocks=1000` is there so a busy day or a few days are never cut.

A `blocks_truncated` warning on either call means the entries stopped at the day it names (`the entries end at <day>`). Follow the warning's own advice: it gives the `start_date` to continue from, which is the first day not shown, or the day the cut fell inside (that day repeats its kept blocks, so read it from the start). Where the weeklies are missing for the days after the cut, say in the gist that they weren't read. A kept block with `childrenTruncated: true` shows only some of its children; fetch it with `get_block` and `include_children` if they matter. `totals` (`{ blocks, days }`) is range-wide: what the whole range held before the cut, not what one block lost.

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

Carry forward only genuinely open items. Apply the expired-text check from the reference with extra care at this altitude — a TODO carrying a deadline in its own words has usually come due within a month.

### Step 6: Write and Verify the Page

Apply the shared output structure, then run the mandatory gate:

```bash
<skill-dir>/scripts/check-terseness.sh "<graph>/pages/Monthly YYYY-MM.md"
```

It detects the monthly granularity from the filename and applies the monthly budget (12-18 words per signal, 200 words total, 10 items target / 12 max, zero em-dashes). A non-zero exit means rewrite and re-run.

The gate cannot check two things, so check them by eye: all three sections present with tab indentation, and **every signal carries a trajectory or an explicit reason it is new**. A monthly signal with no delta is a weekly-altitude detail that should have been merged or dropped.
