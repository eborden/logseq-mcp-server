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

## Emotional Markers

| Marker | Apply to |
|--------|----------|
| `**Win:**` | Achievement that felt satisfying — milestone reached, breakthrough, completion |
| `**Frustration:**` | Persistent friction with no clear resolution path (not one-time issues) |
| `**Unusual:**` | Anomaly or deviation from normal patterns — unexpected stakeholder, surprise event |
| `**Milestone:**` | Significant progress marker — ship date, decision point, phase completion |

Leave routine items unmarked so they blend into the compressed list. Over-marking destroys the signal: if more than half of the items carry a marker, none of them mean anything.

## Compression Rules

- **Cap Signals at 10 items.** This is a hard ceiling, not a target. Hitting it forces prioritization; when more than ten candidates survive, abstract harder or merge related ones.
- **Abstract the routine**: "Completed financial paperwork" rather than "budget form + vendor requisition form".
- **Preserve reconstruction cues on the salient**: "**Frustration:** [[Project X]] alignment stuck - engineering wants A, PM wants B" beats "alignment issues". The cue is what makes the memory recoverable months later.
- **Use no theme scaffolding.** Keep a flat list. Themes emerge from links, not from headers.
- **Lead with a gist** (1-2 sentences): what this period was about overall.

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
4. **Tags line**: link only the constituent periods that actually had content.
5. **Partial periods**: state the boundary in the gist when the period is incomplete — for example "(through Thu Aug 27)". Remove the caveat when completing it later.

## Unresolved Items

Include only items that are genuinely still open. Verify current marker state rather than trusting a prior summary's list — items get completed without anyone updating the summary that referenced them, so a previous `## Unresolved` section is a *candidate* list, not an answer.

Verify against the journal source directly:

```bash
grep -nE "^\s*-\s+(TODO|DOING|NOW|LATER) " <journals>/<period-glob>.md
```

Also check whether an item's own text has expired. A TODO reading "token expires in 3 weeks", written five weeks ago, is no longer a pending task — it is a missed deadline. Surface these to the user rather than carrying them forward silently.

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

- **Week**: Platform migration sprint - mostly execution with persistent alignment friction
- ## Signals
	- **Win:** [[Alice]] promotion package complete and submitted
	- **Frustration:** [[Project X]] alignment still stuck - engineering wants approach A, PM wants B, no clear path forward
	- Completed [[Team Name]] budget and vendor paperwork
	- Shipped feature X to production
	- **Unusual:** [[Manager]] needed unblocking for [[Team Name]] (normally autonomous)
- ## Unresolved
	- ((abc123de-f456-7890-abcd-ef1234567890))
- ## Personal
	- [[Team Member]] shared personal news
```

5 signals (54% fewer), ~45 words (47% fewer), no scaffolding.

**What the compression did**: removed theme headers; added emotional markers; abstracted "budget form + vendor form" into "budget and vendor paperwork"; added a gist; kept the reconstruction cue ("engineering wants A, PM wants B"); reduced links to only the significant names.
