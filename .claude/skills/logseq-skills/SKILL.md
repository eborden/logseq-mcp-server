---
name: logseq-skills
description: Use when user asks about tasks, research, notes, or references their LogSeq knowledge graph, or asks to add [[links]] or tag existing concepts in notes they already wrote - provides context building workflows, weekly and monthly summaries, concept linking with identity-safety rules, and comprehensive MCP tool guidance for querying personal knowledge bases
---

# LogSeq Skills

Comprehensive suite of workflows for querying and analyzing LogSeq knowledge graphs via MCP tools.

## When to Use

Use this skill when:
- User asks about their tasks, TODOs, or what to work on
- User asks "what do I know about X?" or needs research context
- User references their LogSeq notes or knowledge graph
- User wants to explore connections between concepts
- User asks for a weekly or monthly summary of journal entries
- User needs temporal analysis of their notes
- User asks to add `[[links]]` or tag existing concepts in notes they already wrote

## Available Resources

### Sub-Skills

**`skills/weekly-summary.md`** - Create structured weekly summaries from journal entries
- Trigger: "summarize my week", "weekly summary", "what did I do this week", "update last week's summary"
- Source: raw journal entries, Monday-Friday → `Weekly YYYY-MM-DD.md`
- Read this when user explicitly requests weekly summaries
- **Also read `references/summary-compression.md`**

**`skills/monthly-summary.md`** - Create structured monthly summaries from the month's weekly pages
- Trigger: "summarize my month", "monthly summary", "update the month", "update last month's summary"
- Source: the month's `Weekly *` pages → `Monthly YYYY-MM.md`
- Distinct from weekly: weekly compresses, monthly *diffs* against prior months to surface trajectories
- Read this when user explicitly requests monthly summaries
- **Also read `references/summary-compression.md`**

**`skills/concept-linking.md`** - Add `[[refs]]` to existing notes for concepts that already have pages
- Trigger: "add links to this block", "link the concepts in", "tag existing pages in these notes", "auto-link my journal"
- Source: a block ref `((uuid))`, page, or date range → the same file, brackets added and nothing else changed
- Batches genuine ambiguity into one question, proposes a diff, waits for confirmation
- Never creates pages; reports recurring unlinked terms instead
- Read this when user asks to link or tag concepts in notes they already wrote
- **Also read `references/link-resolution.md`**

### References

**`references/link-resolution.md`** - Resolution semantics and safety rules for adding `[[refs]]`
- How LogSeq matches refs (case-insensitive, alias-aware, never fuzzy) and substring bracketing
- The link / ask / skip decision table, and what counts as corroboration for a partial name
- Anti-patterns: rewording to force a match, expanding abbreviations, linking adjectival mentions
- **ALWAYS read this alongside `skills/concept-linking.md`**
- **Non-negotiable constraint:** a linking pass adds brackets and changes nothing else, capitalisation included. A lone candidate page is not evidence of identity; an uncorroborated partial name goes into the batched question rather than being linked or silently dropped. Validate with `scripts/check-link-safety.sh <before> <after> [graph-root] [page-list]` before reporting done.

**`references/summary-compression.md`** - Compression philosophy shared by all summary granularities
- Salience filtering, emotional markers, the hard word budget, merge-vs-drop
- Output structure, LogSeq formatting (tabs, `[[refs]]`, `((uuids))`), open-item verification
- Trend contextualization and a before/after compression example
- **ALWAYS read this alongside any `skills/*-summary.md` sub-skill**
- **Non-negotiable constraint, whether creating or updating:** signals are one line each (weekly 10-15 words / 150 total; monthly 12-18 words / 200 total), zero em-dashes. A bullet whose second sentence explains its first is the defect. A signal with no number is usually the one most worth keeping. Validate with `scripts/check-terseness.sh <file>` before reporting done.

### Scripts

**`scripts/check-terseness.sh`** - Mandatory validation gate for any summary
- Detects weekly vs monthly from the filename and applies that budget
- Reports per-signal word counts, totals, item count, em-dashes, two-sentence bullets, missing sections
- Exits non-zero on violation; rewrite and re-run rather than explaining the failure away

**`scripts/check-link-safety.sh`** - Mandatory validation gate for any linking pass
- Usage: `check-link-safety.sh <before> <after> [graph-root] [page-list]`
- Asserts stripping all `[[ ]]` from before and after leaves them byte-identical, so the pass only added brackets
- Checks bracket balance, and resolvability against a `list_pages` listing (page *files* are a subset of pages, so without a listing that check only warns)
- Infers the graph root from the file path when not passed one
- Proves an edit was safe, never that the classification was right; a pass that links nothing passes every check
- Exits non-zero on violation; fix the edit and re-run rather than explaining the failure away

**`references/context-builder.md`** - Detailed workflows for context building and research
- 7 comprehensive workflows: research, tasks, stale detection, page context, graph exploration, temporal analysis, smart context building
- Performance tips, common pitfalls, example sessions
- Read this when user asks for research help, task management, or graph exploration

**`references/mcp-tools-reference.md`** - Complete MCP tool documentation
- All 13 LogSeq MCP tools with parameters and examples
- Tool comparison tables and selection guidance
- Read this when verifying tool syntax or discovering capabilities

**`references/context-efficiency.md`** - Context-efficient querying patterns
- Token cost awareness and conservative defaults
- Decision flowchart for tool selection
- Anti-patterns to avoid (parallel overlapping searches, high limits)
- **ALWAYS read this before making LogSeq queries**

## Quick Tool Selection

| User Request | Best Approach |
|--------------|---------------|
| "What should I work on?" | Load context-builder.md → Workflow 2 (Task Prioritization) |
| "Summarize my week" | Load skills/weekly-summary.md + references/summary-compression.md |
| "Summarize my month" | Load skills/monthly-summary.md + references/summary-compression.md |
| "Add links to this block" | Load skills/concept-linking.md + references/link-resolution.md |
| "What do I know about X?" | Load context-builder.md → Workflow 1 (Research Assistant) |
| "Show connections to X" | Load context-builder.md → Workflow 5 (Graph Exploration) |
| "What pages exist?" | Use `logseq_list_pages` for vocabulary discovery |
| "How did X evolve over time?" | Load context-builder.md → Workflow 6 (Temporal Analysis) |
| "Need tool syntax" | Load mcp-tools-reference.md |

## Loading Instructions

**For research, tasks, or graph queries:**
- Read `references/context-builder.md` for detailed workflow guidance
- Optionally read `references/mcp-tools-reference.md` for tool syntax

**For summaries (weekly, monthly, or any future granularity):**
- Read `references/summary-compression.md` for the shared compression philosophy and formatting
- Read the matching sub-skill for cadence specifics: `skills/weekly-summary.md` or `skills/monthly-summary.md`
- Optionally read `references/mcp-tools-reference.md` for tool syntax
- Adding a new granularity (quarterly, annual) means adding one sub-skill; the compression rules are inherited from the reference

**For linking concepts in existing notes:**
- Read `references/link-resolution.md` for resolution semantics and the link/ask/skip decision table
- Read `skills/concept-linking.md` for the workflow
- The fixture at `tests/fixtures/graph-linking/` is the worked example and the regression suite

**For tool verification:**
- Read `references/mcp-tools-reference.md` for parameters and examples

## Core Principles

1. **Start narrow, expand if needed** - Default limit=5, include_context=false; expand only when needed
2. **Clarify recency for ambiguous queries** - Ask user "Was this recent?" before querying when timeframe unclear
3. **Leverage bidirectional links** - Backlinks reveal hidden context
4. **Multiple indicators** - Check both markers (TODO) and properties (status::doing)
5. **Synthesize, don't dump** - Provide context and recommendations, not raw data
6. **Read-only assistance** - Never modify LogSeq structure without explicit request
7. **Discover before searching** - Call `list_pages` when you don't know the graph vocabulary

**CRITICAL:** Read `references/context-efficiency.md` before making LogSeq queries to avoid context waste.

## Tool Categories

**Basic Tools (6):** search_blocks, get_page, get_backlinks, get_block, query_by_property, list_pages
**Graph Traversal (1):** get_concept_network
**Semantic Search (1):** search_by_relationship
**Context Building (2):** build_context, get_context_for_query
**Temporal Query (2):** query_by_date_range, get_concept_evolution

Load `references/mcp-tools-reference.md` for complete tool documentation.
