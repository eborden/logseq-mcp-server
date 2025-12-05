# LogSeq Weekly Summary

Generate weekly summaries from LogSeq journal entries, organizing key accomplishments, risks/watch items, open items, and notes into a structured summary page that links back to the source journal days.

## Workflow

### Step 1: Determine the Date Range

Identify the work week to summarize:
- Work weeks run Monday through Friday
- If the user specifies "last week," calculate the previous Monday-Friday range
- If the user says "this week," use the current week's Monday through today (or Friday if complete)
- The Monday date becomes the identifier for the weekly summary file

### Step 2: Query LogSeq Journal Entries

Use the `mcp__logseq__logseq_query_by_date_range` tool to fetch journal entries:
- `start_date`: Monday in YYYYMMDD format (e.g., 20251201)
- `end_date`: Friday in YYYYMMDD format (e.g., 20251205)

### Step 3: Analyze and Categorize Content

Review the journal entries and organize into categories:

**Key Accomplishments** - Group by theme:
- Leadership & People (people decisions, org changes, promotions)
- Projects & Initiatives (technical work, deliverables)
- Budget & Operations (financial, contractor, vendor work)
- Communication (presentations, meetings, announcements)
- Any other relevant themes based on content

**Risks & Watch Items** - Extract:
- Friction points between teams or stakeholders
- Blockers or dependencies that need attention
- Issues that were noted but not yet resolved
- Items requiring follow-up with others to unblock progress

**Open Items** - Extract:
- TODO items that remain incomplete (check marker is still "TODO", not "DONE")
- Items with deadlines that are approaching or past due
- Reference the original block using `((block-uuid))` syntax instead of duplicating the TODO text
- This keeps the summary linked to the source and avoids stale duplicates
- Use `mcp__logseq__logseq_get_block` to verify TODO status if uncertain

**Personal Notes** - Include:
- Non-work items worth remembering
- Team member personal updates
- Celebrations or milestones

### Step 4: Create the Summary Page

Write the summary to LogSeq pages directory using the naming convention:

**File path**: `~/Documents/Logs/pages/Weekly YYYY-MM-DD.md`
- YYYY-MM-DD is the Monday of the work week

**File structure**:
```markdown
tags:: [[Mon Xth, 2025]], [[Tue Xth, 2025]], [[Wed Xth, 2025]], [[Thu Xth, 2025]], [[Fri Xth, 2025]]

- ## Key Accomplishments
	- ### [Theme 1]
		- Accomplishment with [[Person]] or [[Topic]] references
		- Another accomplishment
	- ### [Theme 2]
		- Items grouped by theme
- ## Risks & Watch Items
	- Friction point between [[Team A]] and [[Team B]] on approach
	- Dependency on [[Person]] to unblock progress
- ## Open Items
	- ((block-uuid-here))
	- ((another-block-uuid))
- ## Personal Note
	- Notable personal items
```

### Formatting Guidelines

1. **Tags line**: Include only days that had content in the date range
2. **Page references**: Use `[[Double Brackets]]` for:
   - People names (e.g., `[[Alice]]`, `[[Bob]]`)
   - Projects/topics (e.g., `[[Project Alpha]]`, `[[Platform Migration]]`)
   - Other LogSeq pages that exist
3. **Block references**: Use `((uuid))` syntax for open TODOs to:
   - Link directly to the source block
   - Keep the summary in sync with the original
   - Avoid duplicate/stale TODO items
4. **Indentation**: Use tabs for LogSeq-compatible outliner format
5. **DONE items**: Convert to past-tense accomplishments (don't include DONE marker or block reference)
6. **Risks section**: Include when friction, blockers, or watch items are noted in journal entries

### Example Output

```markdown
tags:: [[Dec 1st, 2025]], [[Dec 2nd, 2025]], [[Dec 3rd, 2025]], [[Dec 4th, 2025]], [[Dec 5th, 2025]]

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
	- [[Person A]] reporting friction - [[Person B]] wants [[Project X]] to work differently instead of adapting [[Project Y]]
	- Still need to check in with [[Manager]] to unblock [[Team Name]]
	- [[Team A]] driving [[Initiative]] creates friction for [[Team B]]
- ## Open Items
	- ((abc123de-f456-7890-abcd-ef1234567890))
	- ((def456gh-i789-0123-defg-hi4567890123))
- ## Personal Note
	- [[Team Member]] shared exciting personal news
```

Note: The block references `((uuid))` will render as the actual TODO content in LogSeq and stay linked to the original journal entry.
