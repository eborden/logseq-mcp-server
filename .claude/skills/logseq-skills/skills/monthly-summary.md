# LogSeq Monthly Summary

Generate a monthly summary by compressing the month's weekly summaries into month-altitude signals, each carrying an explicit trajectory against prior months.

**Read `references/summary-compression.md` first.** It holds the shared compression philosophy, emotional markers, output structure, formatting, and unresolved-item verification. This file covers only what is specific to the monthly cadence.

## Granularity Parameters

| | Value |
|---|---|
| Source | The month's `Weekly *` pages — a summary of summaries |
| Period | Calendar month |
| Output | `~/Documents/Logs/pages/Monthly YYYY-MM.md` |
| Tags | `[[Monthly Summary]]` plus one `[[Weekly YYYY-MM-DD]]` link per constituent week |
| Gist label | `- **Month**: ...` |
| Lookback | Previous 1-2 `Monthly *` pages |

## What Makes Monthly Different

**Weekly compresses. Monthly diffs.**

A weekly summary reduces five days of journals to what mattered. A monthly summary reveals *trajectories* that are invisible at week altitude — month scale is where "vendor scoping" and "vendor estimate tripled" become recognizable as one story.

Flattening four weeklies into a list of what happened is the default failure mode of this workflow. It produces a page containing no information the weeklies did not already hold. Step 4 exists to prevent it and is not optional.

Two further consequences of the altitude shift:

- **Compression is far more aggressive.** Four weeklies carry up to 40 signals into a cap that is still 10. Expect to merge heavily; an item that earned its own weekly signal usually does not earn its own monthly one.
- **Staleness becomes signal.** A TODO three days old is unremarkable. The same TODO carried across four consecutive weeks is itself worth stating.

## Workflow

### Step 1: Resolve the Month and Its Weeks

Confirm the current date and year first.

```bash
date "+%Y-%m-%d %A"
ls ~/Documents/Logs/pages/ | grep -E "Weekly YYYY-MM"
```

Calendar months do not align to work weeks. Handle the boundaries explicitly:

- A week straddling two months belongs to the month holding most of its days, but attribute its individual content to the correct month.
- **Trailing days are the common trap.** A month ending on a Monday or Tuesday leaves business days whose weekly page does not exist yet. State them as outstanding in the gist rather than silently omitting them — for example "through Fri Aug 28; Mon Aug 31 still outstanding".

### Step 2: Check for an Existing Summary

```bash
ls ~/Documents/Logs/pages/ | grep "Monthly YYYY-MM"
```

Update in place when one exists, the same as the weekly workflow.

### Step 3: Read the Constituent Weeklies and Prior Months

Read every `Weekly *` page in the month, plus the 1-2 most recent `Monthly *` pages for trajectory context.

**Guard against lossy-of-lossy compression.** The weeklies are themselves compressed, so anything they dropped is invisible from here, and one weak weekly permanently distorts the month. Spot-check the raw journals for the month's highest-salience days — the ones the weeklies flagged with `**Milestone:**` or `**Frustration:**` — rather than trusting the summaries alone:

```
mcp__logseq__logseq_query_by_date_range(start_date=..., end_date=..., slim_results=true)
```

### Step 4: Diff Against Prior Months

For each candidate signal, determine its trajectory and state the delta in the signal text itself:

- Did it appear in a prior month? → escalating, improving, or unchanged
- Has it resolved? → say so explicitly, or drop it
- Is it genuinely new? → flag it as a first occurrence

A candidate that cannot be given a trajectory is usually a weekly-altitude detail that should be merged or dropped.

Good: "The Afixt engagement went from scoping in July to a 3x remediation estimate by Aug 28, with the audit still unfinished."

Weak: "Afixt accessibility remediation is expensive."

### Step 5: Verify Open Items Across the Whole Month

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " ~/Documents/Logs/journals/YYYY_MM_*.md
```

Carry forward only genuinely open items. Apply the expired-text check from the reference with extra care at this altitude — a TODO carrying a deadline in its own words has usually come due within a month.

### Step 6: Write and Verify the Page

Apply the shared output structure, then verify:

```bash
awk '/^- ## Signals/{f=1;next}/^- ## Unresolved/{f=0}f&&/^\t- /{c++}END{print c}' <file>
grep -c $'^\t' <file>
grep -n "^- ##" <file>
```

Signal count must be 10 or fewer, indentation must be tabs, all three sections must be present, and every signal must carry a trajectory or a clear reason it is new.
