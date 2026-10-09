# Summary Compression

Shared compression philosophy and formatting rules for every LogSeq summary granularity (weekly, monthly, and any future quarterly/annual). Load this alongside the granularity-specific sub-skill in `skills/`.

Cadence-specific concerns — input source, date math, lookback depth, altitude — live in the sub-skill, not here. Everything in this file applies at every granularity.

## Core Model: Memory Consolidation

Summaries simulate memory consolidation. Filter for salience and abstract aggressively rather than enumerating what happened. A summary that lists every event has done no work — the compression *is* the value.

## Salience Filtering

1. **Identify emotional peaks** — what felt surprising, frustrating, or satisfying. These signal what survives compression.
2. **Abstract patterns** — group similar events instead of enumerating them. "Three budget conversations" rather than each one.
3. **Highlight anomalies** — what deviated from routine: unusual stakeholder involvement, unexpected blockers, surprise breakthroughs.
4. **Keep connections sparse** — use `[[links]]` only for significant people and topics. Links are retrieval cues, not a complete index.
5. **Keep the unreconstructible.** The highest-value rule here, and the easiest to violate while technically holding the word budget.
   - A signal carrying no number is usually the one most worth keeping: a read on how a person operates, a boundary that had to be restated, a judgment call, a relationship shift.
   - Quantified facts are recoverable forever from Jira, email, finance decks, and git. A read like "[[Manager]] goes quiet when a decision is still open, so bring a recommendation and not a blank question" exists nowhere but these notes. Losing it loses it permanently.
   - **When the budget forces a cut, cut a quantified fact before you cut a people read or a boundary call.** Ticket counts and dollar figures can be looked up; judgment cannot.
   - "The thing plus the number or the stake" does not mean every signal needs a metric. For a people read, the read itself IS the stake.

## Emotional Markers

| Marker | Apply to |
|--------|----------|
| `**Win:**` | Achievement that felt satisfying — milestone reached, breakthrough, completion |
| `**Frustration:**` | Persistent friction with no clear resolution path (not one-time issues) |
| `**Unusual:**` | Anomaly or deviation from normal patterns — unexpected stakeholder, surprise event |
| `**Milestone:**` | Significant progress marker — ship date, decision point, phase completion |

Leave routine items unmarked so they blend into the compressed list. Over-marking destroys the signal: if more than half of the items carry a marker, none of them mean anything.

## Compression Rules

**HARD BUDGET, not aspirational.** A summary over budget gets rejected as chatty; this is the single most common way the workflow fails.

| Constraint | Weekly | Monthly |
|------------|--------|---------|
| Words per signal | 10-15 target, 20 max | 12-18 target, 22 max |
| Total words in Signals | 150 | 200 |
| Sentences per signal | 1 (a second only if it carries the stake, never to explain the first) | same |
| Items in Signals | 12 target, 14 max | 10 target, 12 max |
| Gist | 2 sentences max | 2 sentences max |
| Em-dashes | zero, anywhere in the file | zero |

Monthly gets more words per signal because a trajectory takes more words to state than a fact does. It gets fewer items because four weeks of signals must merge.

- **Every signal is: the thing, plus the number or the stake. Then stop.**
- **Cut the read-through.** If a clause explains why the fact matters, delete it. The reader lived the period and only needs the pointer.
- **Abstract the routine**: "Completed financial paperwork" rather than "budget form + vendor requisition form".
- **Keep the reconstruction cue, drop the commentary.** "engineering wants A, PM wants B" is the cue and earns its words. "no clear path forward" is commentary and does not.
- **Use no theme scaffolding.** Keep a flat list. Themes emerge from links, not from headers.
- **Lead with a gist**: what this period was about overall.
- **Never weld two unrelated facts onto one line to lower the item count.** That is padding in disguise and it destroys the retrieval cue for both facts. The word budget is the real gate; the item count only warns.

**THE failure mode to watch:** a bullet that is two full sentences where the second explains the first.

- BAD (23 words, second sentence is read-through): `Vendor evaluation is finally moving: [[Alice]] narrowed the field from twelve tools to three finalists. The criteria weighted support quality over raw features.`
- GOOD (12 words, same retrieval value): `Vendor shortlist: twelve tools to three ([[Alice]]); criteria weight support over features.`

**Examples in these skill files must be synthetic.** Use the placeholder vocabulary ([[Alice]], [[Project X]], [[Team Name]], [[Manager]], [[Vendor]]) and invented numbers. Never copy a bullet, person, vendor, metric, or dated filename out of the graph or a real summary into a skill file: these files are version-controlled and may be shared or published, while the journal is private.

### Merging Versus Dropping

When over the cap, prefer merging to dropping — two thin signals about the same underlying thing usually combine into one strong signal. Drop an item only when it is genuinely low-substance at the current altitude, or when it already appears in `## Unresolved`. Never state the same open item in both sections.

## Output Structure

Every summary page carries these sections in this order. `## Unresolved` and `## Personal` are **mandatory even when empty** — an omitted section reads as "never checked", while an empty one reads as "checked, nothing found".

```markdown
tags:: [[<Granularity> Summary]], <constituent page links; weekly day links in the graph's journal title format>
summary-source:: query_by_date_range YYYYMMDD-YYYYMMDD; days N; blocks N; top <name> <count>/<days> | <name> <count>/<days>

- **<Period>**: [1-2 sentence gist]
- ## Signals
	- **Win:** [salient item, with reconstruction cue]
	- [routine item, compressed]
- ## Unresolved
	- ((block-uuid))
- ## Personal
	- [non-work items worth remembering, if any]
```

The `summary-source::` line records the roll-up (`summary.totalDays`, `summary.totalBlocks`, the first five `summary.topConcepts`) of the `logseq_query_by_date_range` call the page was built from. It has no `[[brackets]]`, so it adds no links to the graph. The top concepts are `name count/days` entries separated by ` | `, so a name may hold `/` or `,`. `top none` means the query returned no `topConcepts`. On an update in place, replace the page's existing `summary-source::` line with this run's roll-up. The sub-skill says which call to copy it from.

## Formatting

1. **Indent with tabs.** LogSeq's outliner requires tabs; spaces break nesting silently.
2. **Page refs**: `[[Double Brackets]]`, for significant people and topics only.
3. **Block refs**: `((uuid))` for open items. These render live content and stay linked to source. Never paste TODO text into a summary — a copy goes stale without any visible sign.
4. **Tags line**: link only the constituent periods that actually had content. Weekly day links are the journal pages' own titles, written in the graph's journal title format (see "Journal Day Links" below), never in a format you picked. Monthly links constituent weeks as `[[Weekly YYYY-MM-DD]]`, which are page names and not journal titles, so they do not follow that format. Omit periods with no content rather than linking an empty page.
5. **Partial periods**: state the boundary in the gist when the period is incomplete — for example "(through Thu Aug 27)". Remove the caveat when completing it later.

## Journal Day Links

A journal page's title comes from the graph's `:journal/page-title-format`, so every link to a journal day must be spelled that way. A link in any other format is a plain page with a date-like name. LogSeq does not map the text to the journal day, so it creates an empty stub page next to the real journal and the link points at the stub.

**Find the format once per run, before writing the Tags line:**

1. Read `<graph>/logseq/config.edn` (`<graph>` from `logseq_get_graph_info`, Step 0) and find the `:journal/page-title-format` key, for example `:journal/page-title-format "yyyy-MM-dd"`. Read only that file and that key.
2. If the file has no such key, use LogSeq's default, `MMM do, yyyy`.
3. If the file cannot be read (missing, no permission, no file access in this host), ask the user for the format, or for one journal page's title to copy. Don't guess.

Then format **every** day link you write with that format, from the day's real date. Don't mix formats within a page, and don't copy the shape of a link from an older summary (it may predate the format or the graph's change of it). `:journal/file-name-format` is a different key (the file name under `journals/`); don't use it for links.

How a link looks for a few formats, with made-up days (Tuesday 2026-09-01 and Wednesday 2026-09-02):

| `:journal/page-title-format` | Link for 2026-09-01 | Link for 2026-09-02 |
|---|---|---|
| `MMM do, yyyy` (LogSeq's default) | `[[Sep 1st, 2026]]` | `[[Sep 2nd, 2026]]` |
| `yyyy-MM-dd` | `[[2026-09-01]]` | `[[2026-09-02]]` |
| `EEE, MM/dd/yyyy` | `[[Tue, 09/01/2026]]` | `[[Wed, 09/02/2026]]` |
| `dd-MM-yyyy` (numeric, day first) | `[[01-09-2026]]` | `[[02-09-2026]]` |
| `EEEE, MMMM do, yyyy` | `[[Tuesday, September 1st, 2026]]` | `[[Wednesday, September 2nd, 2026]]` |

Letters follow LogSeq's formatter: `yyyy` year, `MM` two-digit month, `MMM` short month name, `MMMM` full month name, `dd` two-digit day, `do` day with an English ordinal (1st, 2nd, 3rd, 4th, 11th, 22nd), `E` or `EEE` short weekday name, `EEEE` full weekday name. Anything else in the string (commas, spaces, hyphens, slashes) is copied as written.

A format with a slash, as in `EEE, MM/dd/yyyy` above, also has a cost: LogSeq reads `/` in a page title as a namespace separator, so each link makes namespace parent pages (here `Tue, 09`) appear. That is the graph's own format, and the links stay correct. Mention it to the user if they ask why such pages exist. A link written in the wrong format makes a stub page, which the user has to delete by hand, because these tools cannot delete pages.

## Reading the Period: Query First, Files Only After a Failure

Build every summary from `logseq_query_by_date_range`, after loading the tools and calling `logseq_get_graph_info` (Step 0 of the sub-skill). A journal file is a fallback for a tool call that has actually failed: you made the call and it returned an error, or the server wouldn't connect. These are not failures: the tool is deferred and needs a search to load, a search took a call, or files looked easier. Load the tool.

If a call did fail:

- **Say so.** Put the error in the gist, write `summary-source:: files; <the error>` where the roll-up line goes, and pass `--allow-files` to the gate.
- **Read each file of the period whole, oldest first.** Don't truncate with `head`, `head -c`, `cut` or `tail`. The end of a day is where meeting outcomes and hand-offs sit, and a cut file loses them without a sign. A file too large for one read is read in line ranges (`sed -n '1,200p'`, then the next range) until its last line.
- **Say what you couldn't read.** A day you skipped or read in part is named in the gist.

## Unresolved Items

Include only items that are genuinely still open. Verify current marker state rather than trusting a prior summary's list — items get completed without anyone updating the summary that referenced them, so a previous `## Unresolved` section is a *candidate* list, not an answer.

Verify against the journal source directly:

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " <journals>/<period-glob>.md
```

This `grep` reads marker state only. It doesn't replace the period query and can't tell you what the period held.

**Check past the end of the period before calling anything unresolved.** An item raised on the last Thursday of the period may have been closed the following Monday. Read the journals between the end of the period and today, and drop anything since marked DONE. A summary that lists closed work as open is worse than one that omits it.

Block UUIDs come from the `id::` property on the block, or from the blocks the period query returned.

Also check whether an item's own text has expired. A TODO reading "token expires in 3 weeks", written five weeks ago, is no longer a pending task — it is a missed deadline. Surface these to the user rather than carrying them forward silently.

## Validation (MANDATORY)

Do not report a summary complete until the gate passes:

```bash
<skill-dir>/scripts/check-terseness.sh <summary path>
```

The granularity is detected from the filename (`Weekly *` or `Monthly *`) and the matching budget above is applied. The script reports per-signal word counts, the Signals total, item count, em-dashes, and two-sentence bullets, and exits non-zero on a budget violation. It also checks the `summary-source::` line: a page without the roll-up of a period query fails, and so does one whose range isn't the page's week or month. `--allow-files` accepts `summary-source:: files; <error>`, for a run where a tool call failed.

**If it fails, rewrite the offending bullets and re-run.** Do not hand over a failing summary and do not explain away a violation. The two legitimate fixes are deleting the explanatory clause (almost always right) and merging two genuinely related signals. This applies when UPDATING a summary as much as when creating one: adding late-period signals to an existing page is where the budget usually breaks.

## Trend Contextualization

Raw signals become narrative when placed against prior periods. Read the previous 2-3 summaries at the same granularity, then classify each candidate signal:

- **Escalating** — a minor concern is now critical: "Technical debt now blocking delivery" against a prior "considering a refactor"
- **Trend change** — direction shifted: "Velocity improving after the tooling change" against a prior "multiple sprint misses"
- **First occurrence** — novel enough to flag: "**Unusual:** First customer escalation in six months"
- **Continuing** — persistent across periods: "Hiring still stalled - third period waiting on approvals"

State the delta explicitly in the signal text. "Vendor estimate tripled since scoping last month" carries information that "vendor estimate is high" does not.

## Example: Before and After

**BEFORE** — verbose, theme scaffolding, no salience:

```markdown
- ## Key Accomplishments
	- ### Leadership & People
		- Completed [[Alice]] promotion package to Senior Engineer
		- Finalized team restructuring with [[Manager Name]]
	- ### Budget & Operations
		- Finalized [[Team Name]] [[budget]] for next quarter
		- Completed vendor requisition form
	- ### Projects & Initiatives
		- Delivered architecture presentation for [[Project Name]]
		- Shipped feature X to production
- ## Risks & Watch Items
	- [[Person A]] reporting friction - [[Person B]] wants [[Project X]] to work differently
	- Still need to check in with [[Manager]] to unblock [[Team Name]]
```

11 items, ~85 words, 3 theme headers.

**AFTER** — compressed with salience. The day links show LogSeq's default title format (`MMM do, yyyy`) only; write them in the graph's own format ("Journal Day Links"):

```markdown
tags:: [[Weekly Summary]], [[Dec 1st, 2026]], [[Dec 2nd, 2026]], [[Dec 3rd, 2026]]

- **Week**: Platform migration sprint. Mostly execution with persistent alignment friction.
- ## Signals
	- **Win:** [[Alice]] promotion package submitted.
	- **Frustration:** [[Project X]] stuck third week; engineering wants A, PM wants B.
	- Completed [[Team Name]] budget and vendor paperwork.
	- Shipped feature X to production.
	- **Unusual:** [[Manager]] needed unblocking on [[Team Name]], normally autonomous.
- ## Unresolved
	- ((abc123de-f456-7890-abcd-ef1234567890))
- ## Personal
	- [[Team Member]] shared personal news
```

5 signals (54% fewer), 39 words (within the 150 weekly budget), no scaffolding.

**What the compression did**: removed theme headers; added emotional markers; abstracted "budget form + vendor form" into "budget and vendor paperwork"; added a gist; kept the reconstruction cue ("engineering wants A, PM wants B") while dropping the "no clear path forward" commentary; reduced links to only the significant names.
