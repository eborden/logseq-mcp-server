# LogSeq Context Builder Recipes

Multi-step recipes for questions about the graph. Each is a numbered list of calls, written as JSON the way the tool takes it, with what to read in each result and the next call. The made-up pages (`project atlas`, `Alice`, `Bob`) stand for the user's own.

Core principle: **name the page, then explore it.** `logseq_explore_context` for a page you can name, `logseq_find_blocks` for words and properties, `logseq_explore_timeline` for time, `logseq_explore_network` for structure. Read `context-efficiency.md` first, and `results-and-limits.md` whenever a result carries `warnings`. Parameters and worked single calls are in `tools/get.md`, `find.md`, `explore.md` and `check.md`.

## Recipe 1: Recall a topic

**When:** "What do I know about X?", "what links to X?", research for a topic.

1. If you are not sure of the page name, look it up. Skip this when the user named the page.

```json tool=logseq_find_pages
{"text": "react"}
```

Read the names and aliases. A name with no page is a vocabulary miss, so search for the words instead (step 3) and say there is no page.

2. Explore the page. One call has its blocks, related pages and references, so don't add a search or a second look at the links.

```json tool=logseq_explore_context
{"page": "React", "max_blocks": 20}
```

Read `directBlocks` for what the page says, then `references` (ranked, with each `sourcePage`) for what the rest of the graph says. Check `warnings` and `totals` before you call the list complete. For more references, call again with the `references_offset` the warning names and `max_blocks` and `max_related_pages` at 0.

3. If the topic has no page, or the user asked about a phrase, search the words with a small limit.

```json tool=logseq_find_blocks
{"text": "error boundary", "limit": 5}
```

Read `totals.matches` for how many there are and each `pageName` for where. Next call: `logseq_explore_context` on the page that holds the most hits.

**Present:** the organized findings with sources as `[[page]]` links, the gaps ("no notes on error boundaries") and, for a long page, the outline first (`logseq_get_page` with `detail` `outline`, then `logseq_get_block`). For several topics, run step 2 once per page, in parallel.

## Recipe 2: Refresh on a person before a meeting

**When:** "I'm meeting Alice in ten minutes", "what's going on with the Atlas team".

1. Check the page exists and which names it answers to. Skip when you are sure.

```json tool=logseq_find_pages
{"names": ["Alice"]}
```

Read `names`: the page, or `null` with close suggestions. Use the page's own `name`.

2. Read the page and everything that links to it. These two calls are independent, so make them in parallel. Compact keeps the first one cheap.

```json tool=logseq_explore_context
{"page": "Alice", "max_blocks": 20, "max_references": 15, "compact": true}
```

```json tool=logseq_explore_timeline
{"page": "Alice", "last_n": 30, "top_concepts_limit": 5}
```

Read the snippets and `sourcePage` names of the first for standing context (role, projects, how they work). Read the timeline `entries` for the last 30 days, newest facts last, and `summary.topConcepts` for the projects that came up with them. With a period, blocks on non-journal pages are left out, which is why the first call is also needed.

3. Find what is still open with them.

```json tool=logseq_find_blocks
{"text": "TODO", "links_to": ["Alice"], "limit": 10}
```

Read each `content` and `pageName`. A task that mentions Alice only in plain words is not here: `links_to` matches links. Next call: `logseq_get_block` with a `uuid` and `include_children: true` for the context under a task.

**Present:** who they are in the graph, what happened lately, open items, what to ask or raise. Quote actual content with its source page.

## Recipe 3: The history of a decision

**When:** "How did we end up choosing X", "how has my thinking on X changed", "how did this project evolve".

1. Follow the page over time, grouped by month, to see when it was active.

```json tool=logseq_explore_timeline
{"page": "project atlas", "group_by": "month"}
```

Read `dateRange`, the entries in order (oldest first) and `summary.topConcepts`. Gaps between entries are periods with nothing said. Check `warnings`: `blocks_truncated` means later months are missing, and `howToFetchAll` names the call that continues.

2. Find the block where the decision was made.

```json tool=logseq_find_blocks
{"text": "decided", "links_to": ["project atlas"], "limit": 10}
```

Read the hits newest first. Words differ ("chose", "agreed", "going with"), and search is literal, so try the others if this is empty before you say it wasn't written down.

3. Read the discussion around the best hit.

```json tool=logseq_get_block
{"uuid": "0088f1a0-0000-4000-8000-000000000001", "include_children": true}
```

Read `content` and the nested `children`. A `((uuid))` in it is a quoted block: follow it with `logseq_get_block`, or repeat with `resolve_refs: true`.

**Present:** the timeline as phases, each with its dates and one quote, then the decision with its source and what came before it. Say where the notes stop.

## Recipe 4: Connect two projects

**When:** "How do the billing work and the onboarding redesign relate", "what do these two have in common".

1. Find the shortest path of links between the pages.

```json tool=logseq_explore_network
{"page": "billing", "to": "onboarding redesign", "max_depth": 3}
```

Read `hops` and the `nodes` in order: the pages in the middle are the bridges. If there are no nodes, read the `no_path_within` warning: one more hop may be offered (3 is the maximum), or the pages are not linked.

2. Read the blocks that make the link, for the bridge page or for blocks that link both ends.

```json tool=logseq_find_blocks
{"links_to": ["billing", "onboarding redesign"], "limit": 10}
```

Read each `content` and `pageName`: these are blocks that link both pages themselves. If it is empty, the connection runs through the bridge page, so read it:

```json tool=logseq_explore_context
{"page": "customer accounts", "max_blocks": 10, "max_references": 10}
```

3. For the shape around one end instead, map its neighbours.

```json tool=logseq_explore_network
{"page": "billing", "max_depth": 1, "format": "markdown"}
```

Read the lines for the neighbours and link counts: high counts are the closest ties. A neighbour that is a hub is a bridge candidate.

**Present:** the path as `[[A]] -> [[bridge]] -> [[B]]` with the reference counts, what each link says (quote the block), and what the bridge page is for. When there is no path, say they are not linked and offer a word search.

## Recipe 5: Plan the week

**When:** "What should I work on?", "help me plan my week", any request about tasks.

1. Find the tasks. Users mark them with markers (`TODO`), with properties (`status:: doing`), or both, and a property value is an exact string, so check each way. These calls ask different questions, so make them together.

```json tool=logseq_find_blocks
{"text": "DOING", "limit": 20}
```

```json tool=logseq_find_blocks
{"text": "TODO", "limit": 30}
```

```json tool=logseq_find_blocks
{"property": "status", "value": "doing", "limit": 20}
```

```json tool=logseq_find_blocks
{"property": "priority", "value": "high", "limit": 20}
```

Read `marker`, `content` and `pageName` of each hit, and `totals.matches` for how many exist beyond the limit. `text` is a case-insensitive substring, so `DOING` also hits ordinary prose: trust `marker`, not the match. A `SCHEDULED:` or `DEADLINE:` line is text, not a property, so find those with `text`:

```json tool=logseq_find_blocks
{"text": "SCHEDULED:", "limit": 30}
```

2. Group what you found by status (DOING, TODO, WAITING), by page (project) and by date. Check `warnings`: a cut list means there are more tasks than you read, so say so.

3. Get the context of the busiest project before recommending.

```json tool=logseq_explore_context
{"page": "project atlas", "max_blocks": 20}
```

**Present:**

```
CURRENTLY ACTIVE (DOING): the in-progress work
HIGH PRIORITY (this week): deadlines, scheduled items, priority markers
BY PROJECT: the remaining TODOs grouped by page
RECOMMENDATION: finish active tasks first, name the urgent ones, note blockers
```

## Recipe 6: Find stale work

**When:** "What have I forgotten?", backlog review, old or blocked tasks.

1. Find tasks from an older period. Journals carry a date, so a period of last spring finds what was written then and is still marked open.

```json tool=logseq_find_blocks
{"text": "TODO", "start_date": 20250101, "end_date": 20250331, "limit": 30}
```

Read `content`, `pageName` and `totals.matches`. A TODO in an old journal may have been finished elsewhere: check the page before calling it stale.

2. Find what is blocked or waiting.

```json tool=logseq_find_blocks
{"text": "WAITING", "limit": 20}
```

```json tool=logseq_find_blocks
{"property": "status", "value": "blocked", "limit": 20}
```

3. For the old items that matter, read the page to see whether the work moved on.

```json tool=logseq_explore_timeline
{"page": "project atlas", "last_n": 60, "include_content": false}
```

Read the day counts and snippets: a page with recent activity is not abandoned.

**Present:** each stale task with its original date and page, and a suggestion (reschedule, archive or revive).

## Recipe 7: Who owns it, or which pages have a property

**When:** "Who owns the importer?", "which vendors do we use", any ask for the value of a property or the pages that carry one.

1. Pages that carry a page property (`owner:: Alice` at the top of a page):

```json tool=logseq_find_pages
{"property": "owner", "value": "Alice"}
```

Read `pages` and `total`. If it is empty, the property may be on a block and not on the page, so try blocks:

```json tool=logseq_find_blocks
{"property": "owner", "value": "Alice", "limit": 10}
```

2. For the value of a property on a page you can name, read the page. Page properties are in its properties.

```json tool=logseq_get_page
{"page": "importer"}
```

Read the properties of the page. Next call: `logseq_explore_context` when the answer needs more than the property.

**Present:** the owner and where the fact is written (page, block). If two sources disagree, say so.

## Core Guidelines

### Do

- **Name the page, then explore it** (`logseq_explore_context`), one page per call, in parallel for several
- **Follow references**: they reveal context the page itself doesn't hold
- **Quote actual content** with its source page, and use `[[double brackets]]` for page references
- **Surface unexpected connections** and patterns
- **Be honest about gaps** ("you don't have notes on X"), and read `warnings` before you say it
- **Check several status indicators** for tasks (markers and properties)

### Don't

- Assume page structure without checking
- Search once and stop when results are poor: check the vocabulary with `logseq_find_pages`, then retry
- Return raw uuids without context
- Suggest creating pages unless asked
- Modify LogSeq structure (these tools are read-only)

## Common Pitfalls

| Pitfall | Fix |
|---------|-----|
| Missing tasks | Check markers (`text`) and properties (`property` with `value`) |
| Incomplete context | `logseq_explore_context` on the page |
| Poor search results | Check the vocabulary with `logseq_find_pages`, and remember search is literal |
| A period with no results | A period keeps only journal pages. Use `page` on `logseq_explore_timeline` for non-journal blocks |
| Date arguments refused | `start_date` and `end_date` are numbers in YYYYMMDD with no separators, and both are needed |
| Lost connections | `logseq_explore_network`, with `to` for how two pages connect |
| Reporting a cut list as complete | Read `warnings` and `totals` (`results-and-limits.md`) |
| A `((uuid))` left unread | `logseq_get_block`, or `resolve_refs: true` on the call |

## Summary

1. **Choose by type**: `get` when you name it, `find` for criteria, `explore` for what surrounds it, `check` before writing
2. **One high-level call before several small ones**: `logseq_explore_context` replaces a chain of searches
3. **Multi-indicator task queries**: markers and properties
4. **Synthesis over raw data**: context and recommendations, with sources
5. **Read-only**: you are helping the user use their own notes, not imposing structure

For the parameters of each tool, see `tools/get.md`, `tools/find.md`, `tools/explore.md` and `tools/check.md`.
