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
tags:: [[<Granularity> Summary]], <constituent page links>

- **<Period>**: [1-2 sentence gist]
- ## Signals
	- **Win:** [salient item, with reconstruction cue]
	- [routine item, compressed]
- ## Unresolved
	- ((block-uuid))
- ## Personal
	- [non-work items worth remembering, if any]
```

## Formatting

1. **Indent with tabs.** LogSeq's outliner requires tabs; spaces break nesting silently.
2. **Page refs**: `[[Double Brackets]]`, for significant people and topics only.
3. **Block refs**: `((uuid))` for open items. These render live content and stay linked to source. Never paste TODO text into a summary — a copy goes stale without any visible sign.
4. **Tags line**: link only the constituent periods that actually had content. Weekly day links use an English ordinal with a three-letter month: `[[Sep 1st, 2026]]`, `[[Sep 2nd, 2026]]`, `[[Sep 3rd, 2026]]`, `[[Sep 8th, 2026]]`, `[[Sep 22nd, 2026]]`. Monthly links constituent weeks as `[[Weekly YYYY-MM-DD]]`. Omit periods with no content rather than linking an empty page.
5. **Partial periods**: state the boundary in the gist when the period is incomplete — for example "(through Thu Aug 27)". Remove the caveat when completing it later.

## Unresolved Items

Include only items that are genuinely still open. Verify current marker state rather than trusting a prior summary's list — items get completed without anyone updating the summary that referenced them, so a previous `## Unresolved` section is a *candidate* list, not an answer.

Verify against the journal source directly:

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " <journals>/<period-glob>.md
```

**Check past the end of the period before calling anything unresolved.** An item raised on the last Thursday of the period may have been closed the following Monday. Read the journals between the end of the period and today, and drop anything since marked DONE. A summary that lists closed work as open is worse than one that omits it.

If the MCP tools are unavailable, scan the journal files directly for `TODO`/`DOING`/`DONE` markers; block UUIDs come from the `id::` property on the block.

Also check whether an item's own text has expired. A TODO reading "token expires in 3 weeks", written five weeks ago, is no longer a pending task — it is a missed deadline. Surface these to the user rather than carrying them forward silently.

## Validation (MANDATORY)

Do not report a summary complete until the gate passes:

```bash
~/.claude/skills/logseq-skills/scripts/check-terseness.sh <summary path>
```

The granularity is detected from the filename (`Weekly *` or `Monthly *`) and the matching budget above is applied. The script reports per-signal word counts, the Signals total, item count, em-dashes, and two-sentence bullets, and exits non-zero on a budget violation.

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

**AFTER** — compressed with salience:

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
