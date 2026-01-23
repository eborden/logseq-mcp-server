# LogSeq Weekly Summary

Generate weekly summaries from LogSeq journal entries, organizing key accomplishments, risks/watch items, open items, and notes into a structured summary page that links back to the source journal days.

## Workflow

### Step 1: Determine the Date Range

Identify the work week to summarize:
- Work weeks run Monday through Friday
- If the user specifies "last week," calculate the previous Monday-Friday range
- If the user says "this week," use the current week's Monday through today (or Friday if complete)
- The Monday date becomes the identifier for the weekly summary file

### Step 1.5: Pre-Flight Validation

**MANDATORY CHECKS - Do not proceed without completing ALL:**

1. **Verify current year**
   - Check system date or ask user to confirm the year
   - Common error: Using wrong year in date calculations (e.g., using 2025 when it's 2026)

2. **Search for unresolved items**
   - Query TODO markers: `logseq_query_by_property(property_key="marker", property_value="TODO", slim_results=true)`
   - Search DOING items: `logseq_search_blocks(query="DOING", slim_results=true, limit=10)`
   - Filter results to only items from the current week's date range

3. **Load previous context (MANDATORY)**
   - List weekly summaries: `logseq_list_pages(name_contains="Weekly")`
   - Read 2-3 most recent weekly summaries to understand:
     - Ongoing situations (personnel, budget, initiatives)
     - Trend trajectories (escalating, improving, stable)
     - Carry-over concerns

**If any check is skipped, STOP and complete it before proceeding.**

### Step 2: Query LogSeq Journal Entries

Use the `mcp__logseq__logseq_query_by_date_range` tool to fetch journal entries:
- `start_date`: Monday in YYYYMMDD format (e.g., 20260120)
- `end_date`: Friday in YYYYMMDD format (e.g., 20260123)
- `slim_results`: true (reduces token usage by 40-50%)

**Token efficiency note:** Always use `slim_results=true` unless user explicitly requests full context.

### Step 3: Compress and Select Content

**Brain-like compression**: Simulate memory consolidation by filtering for salience and using abstraction.

**Salience Filtering Process:**

1. **Identify emotional peaks** - What felt surprising, frustrating, or satisfying?
   - Use emotional markers: **Win:**, **Frustration:**, **Unusual:**, **Milestone:**
   - These signal what survived the "compression" process

2. **Abstract patterns** - Group similar events instead of enumerating
   - Example: "3 budget conversations" NOT listing each one
   - Example: "Multiple [[Project X]] alignment attempts" NOT detailing each meeting

3. **Highlight anomalies** - What was unusual for a normal week?
   - Unusual stakeholder involvement
   - Unexpected blockers or breakthroughs
   - Deviations from routine

4. **Sparse connections** - Only mention `[[people]]`/`[[topics]]` when significant
   - Not exhaustive tagging
   - Links are retrieval cues, not complete index

**Compression Rules:**
- **Max 10 items in Signals** (forces prioritization - if more, abstract harder)
- **Abstraction for routine**: "Completed financial paperwork" vs. listing forms
- **Context for salient**: "**Frustration:** [[Project X]] alignment stuck - engineering wants A, PM wants B"
- **No theme scaffolding** - flat list, themes emerge from links
- **Week gist** (1-2 sentences) - What was this week about overall?

**Contextualization with Previous Weeks:**

When compressing signals, consider trend context from previous summaries (loaded in Step 1.5):
- **Escalating situations**: Topic that was minor concern now critical (e.g., "Technical debt now blocking feature delivery" vs. previous "considering refactor")
- **Trend changes**: Direction shifts (e.g., "Team velocity improving after tooling changes" vs. previous "multiple sprint misses")
- **First occurrences**: Novel events worth flagging (e.g., "**Unusual:** First customer escalation in 6 months")
- **Continuing themes**: Persistent topics across weeks (e.g., "Hiring still stalled - third week waiting on approvals")

This context transforms raw signals into meaningful narrative progression.

**When to use emotional markers:**
- **Win:** Achievement that felt satisfying (milestone reached, breakthrough, completion)
- **Frustration:** Persistent friction with no clear resolution path (not one-time issues)
- **Unusual:** Anomaly or deviation from normal patterns (unexpected stakeholder, surprise event)
- **Milestone:** Significant progress marker (ship date, decision point, phase completion)
- Don't use markers for routine items - let them blend into the compressed list

**Output Categories:**

1. **Week Gist** (1-2 sentences) - Overall theme
2. **Signals** (max 10 items) - Salient events with reconstruction cues
3. **Unresolved** (block refs) - `((uuid))` for open TODOs from Pre-Flight checks
4. **Personal** (if any) - Non-work items worth remembering

**Finding Unresolved Items:**
- Include TODOs/DOING items from Pre-Flight checks (Step 1.5)
- Only include items that are ACTUALLY unresolved (check DONE status)
- Use block UUIDs `((uuid))` format for proper linking
- If none exist, leave section present but empty (don't omit section)

### Step 4: Create the Summary Page

Write the summary to LogSeq pages directory using the naming convention:

**File path**: `~/Documents/Logs/pages/Weekly YYYY-MM-DD.md`
- YYYY-MM-DD is the Monday of the work week

**File structure**:
```markdown
tags:: [[Weekly Summary]], [[Mon Xth, 2026]], [[Tue Xth, 2026]], [[Wed Xth, 2026]], [[Thu Xth, 2026]], [[Fri Xth, 2026]]

- **Week**: [1-2 sentence gist of what this week was about]
- ## Signals
	- **Win:** [Achievement that felt satisfying]
	- **Frustration:** [Persistent friction with reconstruction context]
	- **Unusual:** [Anomaly or surprise]
	- [Routine items compressed]
	- [Max 10 items total - prioritize ruthlessly]
- ## Unresolved
	- ((block-uuid-1))
	- ((block-uuid-2))
	- [Leave empty if no unresolved items, but section is MANDATORY]
- ## Personal
	- [If any non-work items]
```

### Formatting Guidelines

1. **Tags line**: Include only days that had content in the date range
2. **Week gist**: Capture overall theme in 1-2 sentences (e.g., "Platform migration sprint with persistent alignment friction")
3. **Emotional markers**: Use **Win:**, **Frustration:**, **Unusual:** to signal salience
4. **Page references**: Use `[[Double Brackets]]` ONLY for significant people/topics
   - Sparse connections, not exhaustive tagging
   - Links are retrieval cues for graph traversal
5. **Block references**: Use `((uuid))` syntax for open TODOs
   - Link directly to source
   - Avoid duplicate/stale TODO items
6. **Indentation**: Use tabs for LogSeq-compatible outliner format
7. **Abstraction**: Group similar events ("Completed financial paperwork" not "budget + vendor form")
8. **Reconstruction cues**: Salient items get context, routine gets compressed

### Example: Before vs. After Compression

**BEFORE (verbose with theme scaffolding):**
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
**Stats**: 11 items, ~85 words, 3 theme headers

**AFTER (compressed with salience):**
```markdown
tags:: [[Weekly Summary]], [[Dec 1st, 2026]], [[Dec 2nd, 2026]], [[Dec 3rd, 2026]], [[Dec 4th, 2026]], [[Dec 5th, 2026]]

- **Week**: Platform migration sprint - mostly execution with persistent alignment friction
- ## Signals
	- **Win:** [[Alice]] promotion package complete and submitted
	- **Frustration:** [[Project X]] alignment still stuck - engineering wants approach A, PM wants B, no clear path forward
	- Completed [[Team Name]] budget and vendor paperwork
	- Shipped feature X to production
	- **Unusual:** [[Manager]] needed unblocking for [[Team Name]] (normally autonomous)
- ## Unresolved
	- ((abc123de-f456-7890-abcd-ef1234567890))
	- ((def456gh-i789-0123-defg-hi4567890123))
- ## Personal
	- [[Team Member]] shared exciting personal news
```
**Stats**: 5 signal items (54% reduction), ~45 words (47% reduction), no theme scaffolding

**Compression achieved**:
- Removed theme headers (Leadership, Budget, Projects)
- Added emotional markers (Win, Frustration, Unusual)
- Abstracted "budget + vendor form" → "budget and vendor paperwork"
- Added week gist for overall context
- Kept reconstruction cues ("engineering wants A, PM wants B")
- Sparse connections (only significant people/topics)

Note: Block references `((uuid))` render as actual TODO content in LogSeq and stay linked to source.
