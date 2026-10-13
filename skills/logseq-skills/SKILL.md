---
name: logseq-skills
description: 'Query and organize a LogSeq knowledge graph with the logseq_* MCP tools: build topic context, find tasks, write weekly and monthly journal summaries, and add [[links]] to notes already written. Use when the user says "what do I know about X", "what should I work on", "summarize my week", "summarize my month", "add links to this block", "link the concepts in", or refers to their LogSeq notes, journal or graph. Routing: one week of journals goes to weekly-summary, trends across the weeks of a month go to monthly-summary, brackets on existing notes go to concept-linking. Read-only except for explicit summary and linking requests.'
---

# LogSeq Skills

Workflows for querying and analyzing a LogSeq knowledge graph through its MCP tools. The ten tools come in four types, named in their tool names: `get`, `find`, `explore` and `check`.

**Tool names:** this skill refers to tools by their bare names (`logseq_get_page`). Your host may show them with a prefix, such as `mcp__logseq__logseq_get_page` (manual MCP config) or `mcp__plugin_logseq_logseq__logseq_get_page` (plugin install). Call whichever form your tool list shows.

**Paths:** `scripts/` and `references/` are relative to the directory holding this SKILL.md (`<skill-dir>` in the commands below). Resolve it from where you loaded this file; don't assume an install location.

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
- How LogSeq matches refs (case-insensitive, alias-aware, never fuzzy), substring bracketing, which direction of a prose/title mismatch is bracketable at all, and why the text left outside the brackets decides whether bracketing is safe
- The link / ask / skip decision table, and what counts as corroboration for a partial name
- Anti-patterns: rewording to force a match, fragmenting a proper noun, expanding abbreviations, linking adjectival mentions
- **ALWAYS read this alongside `skills/concept-linking.md`**
- **Non-negotiable constraint:** a linking pass adds brackets and changes nothing else, capitalisation included. A lone candidate page is not evidence of identity; an uncorroborated partial name goes into the batched question rather than being linked or silently dropped. Identity and bracketability are separate questions, and settling the first does not settle the second: a short form sitting inside a page title cannot be bracketed at all, and a page title sitting inside a longer proper noun (`[[Kofi]] Mensah`) must not be, because it fragments the name past what the gate can see. Both want an `alias::` on the target page with the owner's consent, never an expansion of the prose. Validate with `logseq_check_links` (`before` and `after`) before reporting done, and never remove a ref the note already had to make it pass.

**`references/summary-compression.md`** - Compression philosophy shared by all summary granularities
- Salience filtering, emotional markers, the hard word budget, merge-vs-drop
- Output structure, LogSeq formatting (tabs, `[[refs]]`, `((uuids))`), open-item verification
- Reading the period: the query first, journal files only after a tool call has failed
- Journal day links: written in the graph's `:journal/page-title-format` (read from `<graph>/logseq/config.edn`), never a hardcoded format
- Trend contextualization and a before/after compression example
- **ALWAYS read this alongside any `skills/*-summary.md` sub-skill**
- **Non-negotiable constraint, whether creating or updating:** signals are one line each (weekly 10-15 words / 150 total; monthly 12-18 words / 200 total), zero em-dashes. A bullet whose second sentence explains its first is the defect. A signal with no number is usually the one most worth keeping. Validate with `scripts/check-terseness.sh <file>` before reporting done.

### Scripts

**`scripts/check-terseness.sh`** - Mandatory validation gate for any summary
- Detects weekly vs monthly from the filename and applies that budget
- Reports per-signal word counts, totals, item count, em-dashes, two-sentence bullets, missing sections
- Checks the page's `summary-source::` line, the roll-up of the `logseq_explore_timeline` call it was built from. A page with none fails, so a summary built from journal files alone doesn't pass
- Exits non-zero on violation; rewrite and re-run rather than explaining the failure away

### Gates

**`logseq_check_links`** (arguments `before` and `after`) - Mandatory validation gate for any linking pass (a server tool, not a script)
- Checks that stripping all `[[ ]]` from before and after leaves them identical, so the pass only added brackets
- Checks bracket balance, that every ref resolves to exactly one page or alias (resolved in the graph, file-less pages included), and that every ref in before is still in after
- Proves an edit was safe, never that the classification was right; a pass that links nothing passes every check
- `ok` is false on any violation; fix the edit and re-run rather than explaining the failure away

### Other References

**`references/context-builder.md`** - Multi-step recipes for questions about the graph
- Recall a topic, refresh on a person before a meeting, the history of a decision, connect two projects, plan the week, find stale work
- Each recipe is a numbered list of JSON calls, what to read in each result and the next call
- Read this when the user asks for research help, task management, or graph exploration

**`references/tools/`** - One file per tool type, every tool with its parameters and worked examples
- `get.md`: `logseq_get_page`, `logseq_get_block`, `logseq_get_current`, `logseq_get_graph`
- `find.md`: `logseq_find_blocks`, `logseq_find_pages`
- `explore.md`: `logseq_explore_context`, `logseq_explore_network`, `logseq_explore_timeline`
- `check.md`: `logseq_check_links`
- Read the file for the type you are about to call when you need exact parameter names, or a worked call to copy

**`references/results-and-limits.md`** - How to read what comes back
- `warnings`, `hasMore` and `howToFetchAll`, paging, the 30,000-character budget and host limits, with every warning code by tool
- **Read it before you report a count, a list or a miss as complete**

**`references/context-efficiency.md`** - Context-efficient querying patterns
- Token cost awareness and conservative defaults
- Decision flowchart for tool selection
- Anti-patterns to avoid (parallel overlapping searches, high limits)
- **ALWAYS read this before making LogSeq queries**

## The Four Tool Types

A type is chosen by what you already have, and it is the second word of the tool name (`logseq_<type>_<object>`).

| Type | You have | Tools | Returns |
|------|----------|-------|---------|
| `get` | The thing: a page name, a block uuid, "the page that's open" | `logseq_get_page`, `logseq_get_block`, `logseq_get_current`, `logseq_get_graph` | That one thing, or not-found with the closest names. Never a list |
| `find` | Criteria, not the thing | `logseq_find_blocks`, `logseq_find_pages` | A flat list, paged with `limit` and `offset` |
| `explore` | A starting point, and you want what surrounds it | `logseq_explore_context`, `logseq_explore_network`, `logseq_explore_timeline` | A structured result for synthesis: what is said about it, how it connects, how it changed |
| `check` | A change you are about to write | `logseq_check_links` | A verdict. Read-only |

Boundary test: if the answer is a list of hits, use `find`. If it is what something is, where it stands, how it connects or how it changed, use `explore`: `find` answers "which blocks", not "what is going on with this".

Every tool is read-only. Load `references/tools/<type>.md` for the parameters and worked examples of a type.

## Quick Tool Selection

| The job | Call | Read more |
|---------|------|-----------|
| Recall a topic ("what do I know about X") | `logseq_explore_context` with `page` and `max_blocks: 20`. One call per page, in parallel for several | `context-builder.md`, recipe 1 |
| Refresh on a person or project before a meeting | `logseq_explore_context` on the page, then `logseq_explore_timeline` with `page` and `last_n` | `context-builder.md`, recipe 2 |
| What happened in a period | `logseq_explore_timeline` with `preset`, `last_n` or `start_date` and `end_date` | `tools/explore.md` |
| How something changed over time, or the history of a decision | `logseq_explore_timeline` with `page` and `group_by` | `context-builder.md`, recipe 3 |
| How two things connect | `logseq_explore_network` with `page` and `to` | `context-builder.md`, recipe 4 |
| Who owns something, or which pages or blocks have a property | `logseq_find_pages` with `property` and `value` for page properties, `logseq_find_blocks` for block properties | `context-builder.md`, recipe 7 |
| A word or phrase, or blocks that link to pages (a list of hits) | `logseq_find_blocks` with `text` or `links_to` | `tools/find.md` |
| Where something stands, what part it plays, what is written about it | `logseq_explore_context` on the page, not a list of blocks | `tools/explore.md` |
| What to work on, tasks, stale work | `logseq_find_blocks` for markers and properties | `context-builder.md`, recipes 5 and 6 |
| Unsure of a page name (you were given none) | `logseq_find_pages` with `text` or `names` | `tools/find.md` |
| "This page" or "what I'm looking at" | `logseq_get_current`, then `logseq_explore_context` on its page | `tools/get.md` |
| A page you can name, or a long one | `logseq_get_page` (`detail` `outline` first for a long one), then `logseq_get_block` | `tools/get.md` |
| Before writing links into notes | `logseq_check_links` (the gate), after the `skills/concept-linking.md` workflow | `tools/check.md` |
| Summarize my week or month | `skills/weekly-summary.md` or `skills/monthly-summary.md` with `references/summary-compression.md` | the sub-skills |

## Loading Instructions

**For research, tasks, or graph queries:**
- Read `references/context-efficiency.md` first, then the recipe in `references/context-builder.md`
- Read `references/tools/<type>.md` for exact parameters and a worked call
- Read `references/results-and-limits.md` when a result carries `warnings`

**For summaries (weekly, monthly, or any future granularity):**
- Read `references/summary-compression.md` for the shared compression philosophy and formatting
- Read the matching sub-skill for cadence specifics: `skills/weekly-summary.md` or `skills/monthly-summary.md`
- Optionally read `references/tools/explore.md` for `logseq_explore_timeline`
- **Query before files.** Step 0 of each sub-skill loads the LogSeq tools (search for them if they're deferred), calls `logseq_get_graph`, and runs the period query before any shell command that reads the graph. The journals are also files on disk, but they are the fallback for a tool call that has failed, never a shortcut past loading the tools
- The open-items `grep` over `journals/` checks marker state only. It doesn't replace the period query
- Adding a new granularity (quarterly, annual) means adding one sub-skill; the compression rules are inherited from the reference

**For linking concepts in existing notes:**
- Read `references/link-resolution.md` for resolution semantics and the link/ask/skip decision table
- Read `skills/concept-linking.md` for the workflow
- The fixture at `tests/fixtures/graph-linking/` is the worked example and the regression suite

**For tool verification:**
- Read `references/tools/<type>.md` for parameters and examples, and `references/results-and-limits.md` for caps and warnings

## Core Principles

1. **Start narrow, expand if needed** - Start `logseq_find_blocks` with `limit` 5 and `include_context` false; expand only when needed
2. **Clarify recency for ambiguous queries** - Ask user "Was this recent?" before querying when timeframe unclear
3. **Leverage bidirectional links** - Backlinks reveal hidden context
4. **Multiple indicators** - Check both markers (TODO) and properties (status::doing)
5. **Synthesize, don't dump** - Provide context and recommendations, not raw data
6. **Read-only assistance** - Never modify LogSeq structure without explicit request
7. **Name the page, then call it** - When the question names a page, call the tool that answers it with that name: names resolve in any case, by alias and by ISO date, and a miss comes back as an error that says where to look. Use `logseq_find_pages` only when you have no name, or a call says there is no such page
8. **Read the warnings** - A result with `warnings` was cut or is partial. Say so before you call a list complete or something missing

**CRITICAL:** Read `references/context-efficiency.md` before making LogSeq queries to avoid context waste.
