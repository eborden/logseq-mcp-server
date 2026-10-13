# LogSeq MCP Tools Reference

Complete documentation for the LogSeq MCP tools organized by category. The server has 12 tools; `logseq_get_graph` (graph name and path) is the one not covered below.

## Tool Categories Overview

| Category | Tools | Purpose |
|----------|-------|---------|
| Basic Tools | 4 tools | Core search (blocks by text, property or period), retrieval, and page names |
| Graph Exploration | 1 tool | How a page connects: the pages linked to it, or the shortest link path to a second page |
| Context Building | 2 tools | Comprehensive context for one page with its references, and what the user is looking at |
| Temporal Query | 2 tools | Time-based analysis and journal queries |
| Linking | 1 tool | Checking a `[[link]]` pass before it is reported done |

## Basic Tools (4 tools)

### logseq_find_blocks

Find blocks, newest first, by text, by the page they are on, by the pages they link to, by a block property, by a period of journal days, or by any of them together. The filters AND together, and at least one is required: a call with none is refused as an invalid parameter.

**Parameters:**
- `text` (optional): Text to find in a block's content. A case-insensitive literal substring: regex characters are plain text, there are no synonyms or stems, and `port` finds "important". An empty `text` is no filter
- `page` (optional): Keep the blocks written on this page. A page name (case-insensitive), an alias, or an ISO date (`2025-01-01`) for a journal, resolved like every page name; the blocks of every name of the page count, so `atlas` and `project atlas` give the same blocks when one is an alias of the other. A page that does not exist is an error with the closest names, and a name that matches several pages comes back as a list of candidates; no search is made in either case
- `links_to` (optional): A list of 1 to 5 pages; keep the blocks that link to **every one** of them. A block links to a page when its `[[link]]`, `#tag` or `#[[multi word tag]]` points at it, in any casing, under any name of the page (its aliases are followed), so a block that only says the name in plain words does not match: `text` "bob" finds those, `links_to` ["bob"] does not. Only the block's own links count, not links inherited from the blocks above it. Each name resolves like `page`
- `property` and `value` (optional, together): Keep the blocks whose property holds the value. The key is as stored (`created-by`) or camelCase (`createdBy`); the value is an exact string (a number or boolean as its text: `3`, `true`), with no wildcard; a multi-value property matches on any one of its values. A page property comes back as a hit on the page's first block. A task's `SCHEDULED:` and `DEADLINE:` lines are not properties: find them with `text`
- `start_date` and `end_date` (together), `last_n` or `preset` (optional, exactly one way of choosing the period): Keep the blocks on journal pages in the period, and no block of any other page. `start_date` and `end_date` are YYYYMMDD, both days included; `last_n` is the last N **calendar days** ending today, today included (not the N most recent journals that exist, as for `query_by_date_range`); `preset` is `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year` or `year_to_date` (weeks run Monday to Sunday, in local time)
- `limit` (optional): Most blocks returned (default: **100**, max: **500**; a larger value is clamped to 500, not rejected). **Recommend a small `limit` such as 5 to explore**, since the default returns up to 100 blocks
- `offset` (optional): Matches to skip, newest first, to fetch the next page (default: 0). The list shifts if the graph changes between calls
- `include_context` (optional): Give each block a `context` with its page, `references` and `tags` (default: false, **keep false unless needed**). It costs one more call
- `slim_results` (optional): Slim blocks by default (uuid, content, pageName, marker, properties, tags, pageRefs; no numeric ids or page objects). Pass `false` for full entities, with LogSeq's own key spelling (`original-name`, `properties-order`)

**Context cost:** ~200-500 tokens per result. With `include_context=true`: ~500-1000 per result.

**Returns:** a bare array of blocks, flat (no `children`), newest first: highest block id, which is about the order LogSeq created them in, **not the date of the journal page**. The result always has a second content block, `{ "meta": { hasMore, warnings, totals } }`, where `totals.matches` is how many blocks matched before `offset` and `limit`, whether or not any were cut, so a `limit` of 5 on a graph with 180 matches tells you 180 without fetching them. The meta may also carry `tips`. When `page` or `links_to` named a page, it comes first, before `hasMore`: `resolvedFrom` is a list with one `{ name, matchedBy, resolvedTo }` for each name that was an alias, a date or a namespace leaf and not the page's own name (absent when every name was exact), and `resolvedAliases` maps each page that has aliases to every name it was searched under, so you can say which names were covered (absent when none has aliases). An `alias_set_truncated` or `alias_lookup_unavailable` warning says some names of a page were not searched: say the result may be partial

**A cut result:** a result holds at most 30,000 characters, so either `limit` or that size can cut it, and each warning names the `offset` that reads on:
- `results_truncated`: more blocks match than `limit` keeps. The message says "Showing N of M matching blocks" (M counts the matches from `offset` on, and says "from offset K" when K is above 0). `howToFetchAll` leads with "Set offset to K for the next page." and then offers raising `limit` as the alternative, only to a value whose result fits 30,000 characters ("the most that fits"), so follow the offset. `hasMore` is true
- `result_size_truncated`: the blocks `limit` kept do not fit 30,000 characters, so the oldest are cut, whole blocks only. No parameter raises that size, and `include_context=true` and `slim_results=false` make each block bigger. `howToFetchAll` is "Set offset to K for the next page.", `hasMore` is true, and a single block over the size comes back alone
- `limit` already at 500 (or a larger value that was clamped, which the message names): the next page is still `offset`
- `search_unavailable`: LogSeq sent no answer, so the empty list is unknown, not "nothing matches". `hasMore` is false and there is no `totals`. Retry. `context_unavailable` says the same of the pages `include_context` asked for
- An `offset` at or past the last match is an empty page with `totals.matches` and no warning: it is not a miss

**To count only:** pass a small `limit`. `totals.matches` is the count of every matching block.

**Use when:**
- Initial exploration ("what do I know about X?")
- Finding all mentions of a topic, or of a topic in a period ("where did I mention X last week")
- Blocks that link to a page, whatever the spelling of the link (`links_to`), alone or beside `text`: "what links to X", "blocks on Y that link X" (`page` with `links_to`), "blocks that link both X and Z" (two names in `links_to`)
- Needle searches ("find the X from Y")
- Structured data: tasks by status or priority (`property` and `value`), or by marker (`text` "TODO")

**Example:**
```json tool=logseq_find_blocks
{"text": "React hooks", "limit": 5}
```
```json tool=logseq_find_blocks
{"property": "status", "value": "doing"}
```
```json tool=logseq_find_blocks
{"text": "budget", "preset": "last_week", "limit": 10}
```
```json tool=logseq_find_blocks
{"text": "SCHEDULED:"}
```
```json tool=logseq_find_blocks
{"text": "importer", "limit": 20, "offset": 20}
```
```json tool=logseq_find_blocks
{"page": "project atlas", "links_to": ["alice"]}
```
```json tool=logseq_find_blocks
{"links_to": ["alice", "bob"], "preset": "last_month", "limit": 10}
```

---

### logseq_get_page

Get a page by name with its properties. Its blocks come only with `detail` `full`.

**Parameters:**
- `page` (required): Name of the page (case-insensitive), an alias, or an ISO date (`2025-01-01`) for a journal
- `detail` (optional): `page` (default: the page and its properties, no blocks), `full` (adds the nested child blocks) or `outline` (see below)
- `resolve_refs` (optional): Add `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s (depth 2; default: false). Refused with `detail` `outline`, which has no block bodies
- `format` (optional): `json` (default) or `markdown`; with `detail` `outline`, `json` or `toon`. Any other combination is refused with an error that names the valid ones. Markdown is plain text: page properties as `key:: value` lines, then blocks as tab-indented `- ` bullets with `((uuid))` refs kept, then a short footer for warnings and tips. About 80% smaller than JSON on a long page.

**Use when:**
- Deep dive into specific page
- Need full page structure (`detail` `full`)
- Following up after search

**For a long page:** call `logseq_get_page` with `detail` `outline` first, then `logseq_get_block` on the blocks you pick.

**A cut page:** a result holds at most 30,000 characters, and `detail` `full` has no block cap, so a page of a few hundred blocks passes it. The blocks are kept in page order (nested ones count) and the tail is left out, whole blocks only; a kept block that lost children carries `childrenTruncated: true`. The `result_size_truncated` warning says "Showing N of M blocks" and has no `howToFetchAll`, so `hasMore` stays false: no parameter pages a page. Read on with `detail` `outline` and then `logseq_get_block` (with `include_children`) on the blocks you pick. The same cut applies to `format` `markdown`, with the warning in its footer; Markdown writes no `childrenTruncated` marker, so its warning says the last blocks kept may have lost some of their children. A page under the size, and `detail` `page`, come back as they were.

**Example:**
```
logseq_get_page("React")
logseq_get_page("Project Alpha", detail="full")
```

**`detail` `outline`:** lists a page's top-level blocks without their bodies: the shape of the page, to choose from.

**Returns:** `{ page, blocks: [{ uuid, snippet, childCount }], hasMore, warnings, totals }`. `snippet` is the first line, cut to 80 characters. `childCount` counts direct children only. Capped at 200 top-level blocks; a longer page gets an `outline_truncated` warning that names `logseq_get_block` (by uuid) and `logseq_find_blocks` (by text) for the rest, since `detail` `full` is cut to 30,000 characters too. Two hundred first lines of 80 characters are about 31,000 characters in JSON, so an outline can also be cut to 30,000 characters (`result_size_truncated`, "Showing N of M top-level blocks", last blocks left out, no `howToFetchAll`); that warning replaces `outline_truncated`, and `format` `toon` is shorter and is measured as TOON.

**Cost:** 2 Datalog calls however long the page is. About 98% smaller than `get_page` with `detail` `full` on a long page.

**Use when:**
- A page is long and you need only parts of it
- Deciding which blocks to read

**Next:** `logseq_get_block(uuid, include_children=true)` on the blocks you picked.

**Example:**
```
logseq_get_page("Project Alpha", detail="outline")  # → logseq_get_block(blocks[2].uuid, include_children=true)
```

---
### logseq_get_block

Get specific block by UUID with optional children.

**Parameters:**
- `uuid` (required): UUID of the block
- `include_children` (optional): Include nested child blocks (default: **false**; without it the children come as unfetched references)
- `resolve_refs` (optional): Add `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s (depth 2; default: false)
- `format` (optional): `json` (default) or `markdown`, a `# Block ((uuid))` heading and the block with its children as bullets

**A cut subtree:** with `include_children`, a block with a very large subtree is cut to 30,000 characters: the block, then its descendants in document order, whole blocks only, and a kept block that lost children carries `childrenTruncated: true`. The `result_size_truncated` warning has no `howToFetchAll` (no parameter pages a subtree); a marked block below the one you asked for can be read on its own by its uuid, which starts from it, but the children the block you asked for lost, and any block left out whole, can only be found by their text with `logseq_find_blocks` (reading the same block again returns the same cut). Without `include_children` the result is one block and is never cut.

**Use when:**
- Have UUID from search results
- Need specific block details
- Drilling down from search

**Example:**
```
logseq_get_block("abc123de-f456-7890-abcd-ef1234567890")
```

---

### logseq_find_pages

Find non-journal pages, A-Z, to discover graph vocabulary, to check which names exist, or to find pages by a page property. Each page carries its aliases. A large graph's list comes in pages. The filters AND together.

**Parameters:**
- `text` (optional): Filter pages whose name or alias contains this text (case-insensitive). The page comes back whole, with all its aliases, so searching an alias finds its page
- `names` (optional): 1 to 50 page names or aliases, each matched exactly (ignoring case), in one call whatever the number. Each name is answered with its page, or with `null` and the closest names. `null` means no page with that exact name or alias: a namespace leaf (`meetings` for `project/meetings`) or an ISO date answers `null` here, though `logseq_get_page` resolves it. Journals are not pages of this tool
- `property` and `value` (optional, together): Keep the pages whose page-level property holds the value. The key is as stored (`created-by`) or camelCase (`createdBy`); the value is an exact string (a number or boolean as its text: `3`, `true`); a multi-value property matches on any one of its values. Block properties are not matched (use `find_blocks` with `property` and `value`)
- `limit` (optional): Maximum pages per call (default: 200, max: 1000). Aliases take no slots
- `offset` (optional): Matching pages to skip, in name order, to fetch the next page (default: 0)

A server that doesn't page the list ignores `limit` and `offset` and returns every page.

**Returns:**
- `names`: present only when `names` was sent. One entry per name, in the order sent: `{ name, page }` with the page's own name, or `page: null` with `suggestions` (the closest page names) for a name no page has, or `candidates` (and `candidateCount` past ten) when several pages declare that alias. It answers against every non-journal page, whatever the other filters keep, so a name whose page another filter dropped still shows its page
- `pages`: Array of `{ name, aliases? }` sorted by `name`. `aliases` is the page's other names (original casing, sorted) and is left off when there are none. An alias is not a page of its own and is never listed alone, so a name declared by two pages shows under both
- `total`: Count of all matching pages (aliases not counted), including any not returned in this call
- `hasMore`, `warnings`: present only when something is missing. `pages_truncated` (with `hasMore: true`) means the list was cut. Its message says the rest can be paged through with `offset`, and `howToFetchAll` leads with the `offset` of the next page ("Set offset to 200 for the next page."), then offers raising `limit` as the alternative (with the large-result note when that raise passes about 800 pages), so follow the offset. A raise is offered only where the raised list fits 30,000 characters ("That is the most that fits" when only part of it does), otherwise the warning says no larger limit fits; the list at `limit=1000` of ordinary names can pass 30,000 characters, and then `result_size_truncated` ("Showing N of M pages", whole pages cut from the tail, in name order) replaces `pages_truncated` and its `howToFetchAll` is the `offset` of the next page. The `names` answers are never cut. Narrow with `text`, `names` or `property` to see fewer pages. `pages_unavailable` (with `pages: []`, `total: 0`, `hasMore: false`) means LogSeq sent no page list: the list is unknown, not empty, and no name is answered

**Context cost:** ~6-10 tokens per page: ~1.5-2k tokens for a 200-page call, up to ~8k tokens (30,000 characters, where a call is cut) for a 1000-page call. Use `text`, `names` or `property` when you only need a few

**Use when:**
- Starting a new conversation about the user's knowledge graph
- Search queries are returning empty results (vocabulary mismatch)
- User asks "what pages do I have about X?"
- You need to discover what topics/concepts exist before searching
- You need to know which of several names exist (`names`)
- You need the pages that carry a page property (`property` and `value`), such as `vendor:: acme`

**Example:**
```
logseq_find_pages(limit=1000)  # First 1000 non-journal pages; while hasMore, repeat with the offset the warning names
logseq_find_pages(text="project")  # Filter to pages containing "project"
logseq_find_pages(names=["Alice", "Bob", "Dave"])  # Which of these names are pages? Each is answered with its page or null
logseq_find_pages(property="status", value="active")  # Pages whose page property status is active
```

**Why critical:** Prevents wasted searches for compound phrases that don't match the graph's actual vocabulary. Call this FIRST when you don't know what pages exist.

---

## Graph Exploration Tools (1 tool)

### logseq_explore_network

How a page connects, as nodes (pages) and edges (links). Without `to` it maps the pages linked to `page`, in both link directions, up to `max_depth` hops. With `to` it finds the shortest path of links from `page` to a second page, and answers no path when there is none within `max_depth`. For the blocks of a page that link to another page, use `find_blocks` with `page` and `links_to`.

**Parameters:**
- `page` (required): Page to start from (name, alias or ISO date)
- `to` (optional): A second page. The result is then the shortest path from `page` to it, and not the network
- `max_depth` (optional): Maximum hops (default: 2, max: 3; a larger value is capped at 3)
- `max_nodes` (optional): Most pages in the network, the root included (default: 50, max: 500; a larger value is clamped)
- `max_fanout` (optional): Most new pages any one page may add (default: 15, max: 100; a larger value is clamped)
- `expand_journals` (optional): Walk through journal pages instead of treating them as leaves (default: false). Journal pages link to almost everything, so this can flood the network
- `format` (optional): `json` (default) or `markdown`. The network is its pages grouped by depth, then one line per link (`A -> B (n)`, `A <- B (n)` or `A <-> B (out/in)`), about 45% smaller. The path is the chain of pages, then one line per link
- `max_nodes`, `max_fanout` and `expand_journals` size the network, so a call with `to` that sets one is refused as an invalid parameter

**Returns the network (no `to`):** `{ page, resolvedFrom?, resolvedAliases?, truncated, hasMore, warnings, nodes, edges }`. `nodes` are `{ id, name, depth }` with the root at depth 0 and `depth` the fewest hops from it along the returned edges. `edges` are one per pair of pages, `{ from, to, type, count, outbound, inbound }`: `from` is the page nearer the root, `outbound` counts the blocks on `from` that link `to`, `inbound` the blocks on `to` that link `from`, `count` is both, and `type` is `reference` when `from` links `to` at all and `backlink` when only `to` links `from`.

**Returns the path (with `to`):** `{ page, to, resolvedFrom?, resolvedAliases?, hops?, hasMore, warnings, nodes, edges }`. `nodes` are the pages of the path in order, from `page` to `to`, with `depth` 0, 1, 2 and so on, and `edges` the links between consecutive pages, each as above with `from` the earlier page. `hops` is the number of links and is there only when a path was found. With no path, `nodes` and `edges` are empty and a warning says why. `resolvedFrom` and `resolvedAliases` are keyed `page` and `to`, each present only for a name that was an alias, date or namespace leaf, or a page that has aliases. Every name of a page counts as that page, so the path starts from all the names of `page` and ends at any name of `to`. The walk goes through journal pages like any other page, and among paths of the same length takes the one through pages that are not journals, then the one with more references.

**Warnings:**
- `network_truncated` (the network): the caps dropped pages. `howToFetchAll` names a raise of `max_nodes` or `max_fanout`, and only when the larger network is estimated to fit the 30,000-character result. Otherwise the warning says what was cut and how to narrow the walk (lower `max_depth`, or start from a more specific page), and `hasMore` is false. At the maximums it says so
- `result_size_truncated` (the network): the result was cut to 30,000 characters, the deepest pages first and the root always kept. No parameter raises this limit, so narrow the walk. `truncated` is true and `network_truncated`, if there is one, no longer offers a raise
- `no_path_within` (the path): no path within the depth reached. When one more hop could find one, `howToFetchAll` says to set `max_depth` one higher (up to 3). When the walk reached every page it could, or `max_depth` is at its maximum of 3 (a larger request is capped, and the message says so), nothing reads on and `hasMore` is false
- `same_page` (the path): the two names are one page (the same name twice, or a page and its alias), so there is no walk
- `frontier_truncated` (the path): a hop reached more than 500 pages and expanded only the lowest ids, so "no path" may be a false negative, and a path found after that hop is real but a shorter one may exist (a path found at that hop is as short as any)
- `links_unavailable`: LogSeq gave no answer for a hop, so the walk stopped there. It is not "no path" and not "no links": retry

**Use when:**
- Seeing the pages around a page: hubs and leaves, how central the topic is
- Asking how two pages connect, and through which pages
- Discovering bridge pages: they are the middle nodes of the path

**Examples:**
```json tool=logseq_explore_network
{ "page": "Machine Learning", "max_depth": 2 }
```
```json tool=logseq_explore_network
{ "page": "TypeScript", "to": "GraphQL", "max_depth": 3 }
```

**Performance:** The network costs the page's resolver query, one alias query when the page has an alias link, and one query per hop (3 calls for depth 2). The path costs the resolver query for each page (run together), one alias query for both pages when either has an alias link, and one query per hop, ending at the first hop that reaches `to`: 3 calls for a page one link away. It reads no page, so it returns no blocks: use `explore_context` or `find_blocks` with `links_to` for the blocks that link the pages.

---

## Context Building Tools (2 tools)

### logseq_explore_context

Explore one page in a single call: its blocks, the pages that link to it, and the blocks that do (its references, most-linking pages first). **This is often the only tool you need.**

**Parameters:**
- `page` (required): Name, alias or ISO date of the page. `name` and `page_name` are accepted for it
- `max_blocks` (optional): Maximum blocks to return (default: 50, **recommend: 20**)
- `max_related_pages` (optional): Maximum related pages (default: 10)
- `max_references` (optional): Maximum reference blocks (default: 20)
- `references_offset` (optional): Reference blocks to skip, to read the next page of them (default: 0). The ranking is the same on every call, so the pages join with nothing skipped or repeated; it shifts if the graph changes between calls
- `include_temporal_context` (optional): Add `temporalContext` for a journal page (default: true)
- `resolve_refs` (optional): Add `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s in the blocks and the references returned
- `format` (optional): `json` (default) or `markdown`. Markdown shows the blocks as a tree (no block uuids unless `compact`; page properties as stored), related pages as links, and references grouped by source page, with truncation warnings in a footer. About 75% smaller.
- `compact` (optional): Block snippets (first line, 80 characters) with their uuids instead of block bodies. In JSON each block becomes `{ uuid, snippet }`; `summary`, `totals`, `warnings` and `hasMore` are kept. Read the blocks you want with `logseq_get_block`. Worth it when blocks are long; for short blocks the uuids cost about as much as the text. Skips `resolve_refs`. With `resolve_refs: true` the refs are not resolved and a `resolve_refs_ignored_in_compact` warning says so; set `compact` to false for resolved text.

**Context cost:** ~3-8k tokens depending on limits. Still cheaper than manual aggregation.

**Returns:**
- `page`: the name you asked for, as you wrote it (`resolvedFrom` says when it was an alias, a date or a namespace leaf)
- Main page with properties
- Direct blocks from page (`directBlocks`)
- Related pages (`relatedPages`): the pages that link to it, each once, in the order LogSeq gave them (not ranked)
- Reference blocks that link to it (`references`, each `{ block, sourcePage }`), **ranked by the number of blocks on their source page that link the page, most first**, ties broken by lowercase page name and then page id, so the blocks of one source page sit together and the first is on the page that links the topic most. The order is the same on every run, with or without aliases. A page and its aliases count as one topic. The ranking counts linking blocks, not importance: a blocker can sit on a page with a single linking block
- Temporal context (for journal pages)
- Summary statistics (`summary`) and the real counts before any cap (`totals`: `blocks`, `relatedPages`, `references`)

**A cut result:** `hasMore`, `warnings` and `totals` come first in the result. The caps cut each list from its end, and the whole result holds at most 30,000 characters:
- `blocks_truncated`, `related_pages_truncated`: "Showing N of M ...". Blocks and related pages have no offset. `blocks_truncated`'s `howToFetchAll` says to raise `max_blocks` to M, and the raised result is not measured, so it can come back cut by `result_size_truncated`. `related_pages_truncated`'s says to raise `max_related_pages` to M only when the context with every related page kept fits 30,000 characters, and never after a size cut; otherwise it has no `howToFetchAll` and `hasMore` does not count it, so the pages left out can't be fetched in one call
- `references_truncated`: "Showing N of M references" (M counts the references from `references_offset` on, and says "from offset K" when K is above 0). `howToFetchAll` leads with "Set references_offset to K for the next page." and offers raising `max_references` as the alternative. A later page can pass `max_blocks: 0` and `max_related_pages: 0` to leave out what it already read. An offset at or past the last reference is an empty page and no warning: it is not a miss
- `result_size_truncated`: the lists the caps kept do not fit 30,000 characters, so entries are cut whole from the tail: related pages first, then the last references, then blocks. The message says how many of each were kept. When it dropped references and no block, `howToFetchAll` names the `references_offset` that reads on from the last one kept; when the blocks left no room for any reference, it says to lower `max_blocks`. A count cap's own warning for a list that this cut went further into gives way to this one. `compact` shortens each block, so more fit
- `backlinks_unavailable`, `page_blocks_unavailable`: LogSeq sent no answer for that part, so the empty list is unknown, not "nothing links here". `hasMore` stays false for these. Retry

**Several pages:** call it once per page, in parallel, rather than looking for one call that merges them: each answer is smaller and is cut on its own. A question is not a page name, so pick the pages yourself; for the words of a question use `find_blocks`.

**Use when:**
- Need complete picture of a topic
- "What do I know about X?" and "what links to X?" questions
- Deep dive into specific page

**Example:**
```json tool=logseq_explore_context
{"page": "Q4 Planning", "max_blocks": 20}
```

The next page of references, without the blocks again:
```json tool=logseq_explore_context
{"page": "Q4 Planning", "max_blocks": 0, "max_related_pages": 0, "references_offset": 20}
```

**Performance:** Replaces 5+ separate queries with one call. **Don't add find_blocks or a second look at the links after this - it already includes that information.**

---

### logseq_get_current

Get what the user is looking at in LogSeq right now: the open page, the block being edited, and any selected blocks.

**Parameters:** none

**Use when:**
- The user says "this page", "this block" or "what I'm looking at" without naming it
- Before `explore_context` or `get_page`, to resolve which page "this" means

**Returns:** `{ page, focusedBlock?, selectedBlocks? }`. When no page is open, `page` is `null` with a message. The result reflects live UI state, so calling it twice can give different answers. A selection of a few hundred blocks (a whole page) is cut to 30,000 characters: the first selected blocks stay, whole, and a `result_size_truncated` warning says "Showing N of M selected blocks" with no `howToFetchAll`. Select fewer blocks, or read the page with `logseq_get_page`.

**Example:**
```
logseq_get_current()  # → then logseq_explore_context(page.originalName)
```

---

## Temporal Query Tools (2 tools)

### logseq_query_by_date_range

Query journal entries within a date range. **Preferred tool for time-bounded questions.**

**Parameters:**
- `start_date` (required): Start date in YYYYMMDD format (e.g., 20251101)
- `end_date` (required): End date in YYYYMMDD format (e.g., 20251130)
- `search_term` (optional): Filter blocks containing this term
- `top_concepts_limit` (optional): Size of `summary.topConcepts`, the pages linked most in the range as `{ name, count, days }` (default 10, 0 omits it)
- `include_content` (optional): `false` returns only per-day block counts and top-level snippets, without the blocks (default `true`)
- `slim_results` (optional): Slim blocks by default (uuid, content, pageName, marker, properties, tags, pageRefs; no numeric ids or page objects). Pass `false` for full entities. Entries carry `pageName`, so their blocks don't repeat it
- `max_blocks` (optional): Most blocks returned across all days (default 200, max 1000; a larger value is clamped). Nested blocks count, except with `include_content=false`, where only the top-level blocks (the snippets) count. The oldest days are kept first, and `last_n` keeps the newest first. **Page at the default of 200 rather than raising it:** a result of about 50,000 characters or more is saved to a file by Claude Code and the model loses `summary`, `totals` and `warnings`, and a dense week at 1000 is about 150,000 characters (sizes and what to do: `context-efficiency.md` section 7)

**A cut result:** when the range holds more than `max_blocks`, the result keeps the first blocks and says so:
- A `blocks_truncated` warning gives what was kept out of how many (in `totals: { blocks, days }`, range-wide and counted in the same unit as the cap) and where the entries end (`the entries end at <day>`), then `howToFetchAll` leads with a paging call: again with the same `end_date` and `max_blocks` and the `start_date` of the first day not shown, or, when the cut fell inside a day, that day itself (it repeats its kept blocks). It never suggests raising `max_blocks` for a range of days, so there is nothing to ignore. `hasMore` stays true at the maximum of 1000 too, as long as a paged call reaches more. Two cases say something else. If the first day alone fills the cap, the warning names that day's block count and says to query the day alone at it, with a note that the result may be saved to a file and the advice to read the day in pieces with a `search_term` if it is. A day holding more than 1000 blocks can't be fetched whole by any call: the warning pages past it, or, with no later day, suggests `max_blocks` 1000 for that day (with the note) below the maximum and has no `howToFetchAll` at it, so `hasMore` is false there. Any `max_blocks` raise the warning does suggest (a cap of 0, or a last day over 1000 at a lower cap) carries the same note. Page with the warning's `start_date` at 200, and for a day too big to read whole use a lower cap or a `search_term` (`context-efficiency.md` section 7; the summary skills spell out the steps)
- A kept block that lost some children has `childrenTruncated: true`: the children shown are not all of them, so fetch the block with `get_block` and `include_children` if they matter
- `summary` (`totalDays`, `totalBlocks`, `topConcepts`) still covers every block found, so it describes the whole range even when `entries` stops early. `summary.totalBlocks` counts top-level blocks, while `totals.blocks` counts in the cap's unit (nested blocks too), so the two differ and neither is an error. `dateRange` stays the range you asked for
- Below the cap none of this appears and the output is unchanged

**Context cost:** ~1-3k tokens for a week's worth of filtered results. Much cheaper than a broad `find_blocks`.

**Use when:**
- User says "this week", "recently", "in November", etc.
- Journal entry queries
- Time-bounded searches

**Example:**
```
logseq_query_by_date_range(20251201, 20251208, "Alice")  # This week's Alice mentions
logseq_query_by_date_range(20251101, 20251130, "testing")  # November mentions of "testing"
```

**Date Format:** Always use YYYYMMDD (20251101 = November 1, 2025)

**IMPORTANT:** If timeframe is ambiguous ("the X that Y sent"), ASK USER about recency before choosing between this tool and `find_blocks` with a period.

---

### logseq_get_concept_evolution

Track how a concept appears and evolves over time.

**Parameters:**
- `concept_name` (required): Page or topic name
- `start_date` (optional): Start date in YYYYMMDD format
- `end_date` (optional): End date in YYYYMMDD format
- `group_by` (optional): Grouping level: 'day', 'week', 'month'
- `max_entries` (optional): Most mentions kept in `timeline` (default: **100**, max: **500**; a larger value is clamped to 500, not rejected; a fraction is rejected). Dates narrow only dated mentions: a mention on a non-journal page has no date and passes every `start_date` and `end_date`, so no date range reaches it

**Returns:**
- Timeline of mentions
- Temporal patterns and gaps
- Journal vs. non-journal distinction
- Chronologically sorted

**A cut result:** `timeline` is cut to `max_entries` mentions, oldest first with undated (non-journal) mentions last, so the cut drops undated mentions first and then the newest dated ones. The meta fields are inside the result object (no second block, as for `explore_network`): `warnings` and `hasMore` appear when a warning applies, and `totals: { mentions }`, the count before the cut, only with a cut. The `entries_truncated` warning says "Showing N of M mentions (oldest first, undated last; the timeline ends at <day>)", and what it says next:
- M of 500 or fewer: `howToFetchAll` says to set `max_entries` to M (or higher)
- M above 500 and `max_entries` below 500: set it to 500 (the maximum) to get 500 of M, not all
- A raise past about 200 mentions adds a large-result note to `howToFetchAll` ("A result this large may be saved to a file by the host instead of shown; the server can't tell")
- `max_entries` already at 500: no `howToFetchAll`, so the warning is the signal that the list is partial
- It also says what the dates can reach: when the cut fell among dated mentions it names the `start_date` to continue from (that day repeats its kept blocks); when it fell among the undated ones, narrowing the dates can't reach the rest
- `summary` (`totalMentions` and the rest) still counts every mention found, so it can exceed what `timeline` holds, and `groupedTimeline` is built from the kept mentions only

**Use when:**
- "How did X evolve over time?"
- Tracking concept development
- Finding temporal patterns

**Example:**
```
logseq_get_concept_evolution("Rust", 20250101, 20251231, group_by='month')
logseq_get_concept_evolution("Machine Learning")  # All time
```

**Benefits:** See learning progression, identify gaps, understand engagement patterns.

---

## Linking Tools (1 tool)

### logseq_check_links

The gate for a `[[link]]` pass (`skills/concept-linking.md`, step 8). Read-only: it compares two texts and looks the refs up in the graph.

**Parameters:**
- `before` (required): The text before linking, at most 50,000 characters
- `after` (required): The same text with `[[brackets]]` added, at most 50,000 characters and 500 distinct terms

**Returns:**
- `ok`: True only when all four checks pass
- `prose`: `{ ok, firstDifference? }`. Stripping `[[ ]]` from both texts leaves them identical. `firstDifference` gives the line, column and an excerpt of each side
- `brackets`: `{ ok, opens, closes, nested? }`. Balanced, and no `[[` opened inside another
- `refs`: `{ ok, resolved, unresolved, ambiguous }`. Every `[[term]]` in `after` names exactly one page or alias, file-less pages included. An alias several pages declare is `ambiguous`; one the note already had, with no copy added, is reported but doesn't fail
- `refsPreserved`: `{ ok, removed }`. Every ref in `before` is still a ref in `after`, as many times
- `hasMore`, `warnings`, `totals` (`refsBefore`, `refsAfter`, `terms`). A `refs_unchecked` warning means LogSeq gave no answer, so no ref was checked

**A cut result:** 500 distinct terms that all resolve are about 40,000 characters, so the result is cut to 30,000. Only `refs.resolved` is cut, last terms first (they sort by term): `ok`, `unresolved`, `ambiguous` and `refsPreserved` never are, since a gate that drops a failure to fit a limit is not a gate. A `result_size_truncated` warning says "Showing N of M resolved refs" and has no `howToFetchAll`; check the text in parts to see every resolved ref.

**Context cost:** ~100-500 tokens, depending on how many refs the text holds

**Use when:**
- A linking pass has been applied and is about to be reported done

**Example:**
```
logseq_check_links(before="- met Alice about project atlas", after="- met [[Alice]] about [[project atlas]]")
```

**Can't find:** a link to the wrong page, or a name split across a ref (`[[Kofi]] Mensah`). Both pass every check.

---

## Tool Selection Guide

### By Use Case

| Use Case | Best Tool(s) |
|----------|-------------|
| "What pages do I have?" | `find_pages` |
| "What do I know about X?" | `explore_context` (once per page) |
| "Show me everything connected to X" | `explore_network` + `explore_context` |
| "How did X evolve over time?" | `get_concept_evolution` |
| "What was I doing last week?" | `query_by_date_range` |
| "Find blocks about A that link B" | `find_blocks` (`page` A with `links_to` B) |
| "How are A and B connected?" | `explore_network` (`page` A, `to` B) |
| "What are my TODOs?" | `find_blocks` (`text` "TODO", and `property` `status`) |
| "When did I mention X?" | `get_concept_evolution` (without grouping) |
| "What links to X?" | `explore_context` (its `references`) |
| "Get full details on page X" | `explore_context` or `get_page` |

### By Question Type

**Initial exploration:**
- `find_blocks` (broad text search)

**Structured queries:**
- `find_blocks` with `property` and `value` (tasks, status, priorities)
- `find_blocks` with a period (blocks from the last days or a named period)
- `query_by_date_range` (journal entries by date)

**Deep dives:**
- `get_page` with `detail="full"` (full page content)
- `explore_context` (comprehensive context for one page)

**Discovering connections:**
- `explore_context` (pages linking to this one, and the blocks that do)
- `explore_network` (the pages around a page, as nodes and edges)

**Relationship-based search:**
- `find_blocks` with `page` and `links_to` (blocks on a page that link other pages, or blocks that link every one of 1 to 5 pages)
- `explore_network` with `to` (the shortest path of links between two pages, if there is one within N hops)

**Time-based analysis:**
- `get_concept_evolution` (track concept over time)
- `query_by_date_range` (journal queries)

**Specific blocks:**
- `get_block` (when you have a UUID)

---

## Performance Comparison

### Single-Call Solutions (Fastest)

**`explore_context`:**
- Replaces 5+ separate queries
- One call for complete context, with the references ranked and paged
- Best for deep dives, one page per call

**`explore_network`:**
- The pages around a page, or the path to a second one, in one call
- Shows all connections at once, within its caps
- Best for visualization

### Multi-Call Workflows (When Needed)

**Broad exploration:**
```
find_blocks → get_page → explore_context
```

**Specific deep-dive:**
```
get_page → get_related_pages
```

**Structured data:**
```
find_blocks with property and value (for precise matches)
```

---

## Best Practices

### Limit Parameters

- Use `max_blocks`, `max_related_pages` to control response size
- Use `depth` and `max_depth` carefully (depth=1 usually sufficient)
- Use `limit` on `find_blocks` to avoid overwhelming results, and `offset` to read on

**Caps that cut a result:** these tools keep the first results in an order (see the last column) and say so. Each caps at a maximum, clamps a larger value instead of rejecting it, and reports a cut with a warning. Read the warning before you report a count or a list as complete.

| Tool | Parameter (default, max) | Warning code | Where the meta is | Order of what is kept |
|------|--------------------------|--------------|-------------------|-----------------------|
| `find_blocks` (with `page` and `links_to` too) | `limit` (100, 500), `offset` | `results_truncated`, `result_size_truncated` | second content block, always (`totals.matches` even when uncut) | newest first (highest block id) |
| `explore_context` | `max_blocks` (50), `max_related_pages` (10), `max_references` (20, no maximum), `references_offset` | `blocks_truncated`, `related_pages_truncated`, `references_truncated`, `result_size_truncated` | the result object itself; `totals.blocks`, `totals.relatedPages`, `totals.references` | blocks in page order; references ranked by linking blocks, most first (ties by page name), paged with `references_offset`; related pages in LogSeq's order |
| `explore_network` (the network) | `max_nodes` (50, 500), `max_fanout` (15, 100), `max_depth` (2, 3) | `network_truncated`, `result_size_truncated` | the result object itself; `truncated` | the pages nearest the root; the deepest are cut first, and the root is always kept |
| `get_concept_evolution` | `max_entries` (100, 500) | `entries_truncated` | the result object itself; `totals.mentions` only with a cut | oldest first, undated mentions last |
| `query_by_date_range` | `max_blocks` (200, 1000) | `blocks_truncated` | the result object itself; `totals.blocks`, `totals.days` | oldest day first |

The warning's `howToFetchAll` never points past a maximum. At the maximum there is no `howToFetchAll`, `hasMore` is false and the warning is the only signal, so say the list is partial. The exceptions are the tools that page: `query_by_date_range` leads with a call from the day where the entries end, and `find_pages`, `find_blocks` and the references of `explore_context` with their `offset` and `references_offset`, so `hasMore` stays true at their maximum. Below it, a total above the maximum gets "set it to the maximum to get N of M", which is a bigger cut list, not all of them. A raise whose result may be too large to be shown carries the note "A result this large may be saved to a file by the host instead of shown; the server can't tell." That note is a hedge, not a size: it appears when the suggested value is past about 200 blocks (150 references, 500 related pages, 200 network nodes, 800 listed pages, or the pages whose blocks add up to 200). Those are sized from slim blocks with no context. `find_blocks` scales the block estimate when a hit comes back larger, and offers a raise only up to what fits its 30,000-character result: about 120 hits with `include_context=true`, about 125 with `slim_results=false`, about 65 with both. `explore_context` and `get_concept_evolution` use the slim estimate whatever their other options, so with long blocks the note can come later than the real limit. It means the raise is still the call that gets those items, but a narrower query may be shown where the raise is saved. `explore_network` is the one that measures its result: it offers a raise of `max_nodes` or `max_fanout` only when the larger network is estimated to fit 30,000 characters, and says how to narrow the walk otherwise.

**Size:** Claude Code saves a tool result of about 50,000 characters or more to a file and shows the model only the first 2 KB (`context-efficiency.md` section 7). The tools that return lists or trees (`find_blocks`, `find_pages`, `get_page`, `get_block` with `include_children`, `get_concept_evolution`, `explore_network`, `query_by_date_range`, `explore_context`, `get_current` and `check_links`) cut a result to 30,000 characters first, whole entries from the tail, and say so with a `result_size_truncated` warning. A result passes 30,000 characters only when one entry does (a lone oversized block is returned whole) or when the part that is never cut does (the `find_pages` `names` answers, the `check_links` failures, the open page and focused block of `get_current`), and the warning then says even those are over that size. A `limit` at the maximum is usually cut, so narrow the query or lower the cap rather than raising it.

### Tool Priority

1. Prefer `explore_context` over manual aggregation, and one call per page over several searches
2. Use `find_blocks` with `page` and `links_to` instead of filtering results manually
3. Use `explore_network` for the pages around a page, or the path between two (not sequential backlink queries)

### Common Patterns

**Task queries:** Use BOTH `find_blocks(text="TODO")` (markers) AND `find_blocks(property="status", value="todo")` (properties)

**Research:** Start with `find_blocks`, then `get_page`, then `explore_context`

**Graph exploration:** Use `explore_network` + `explore_context` together

**Temporal analysis:** Use `get_concept_evolution` with grouping for patterns

---

## Date Format Reference

All temporal queries use **YYYYMMDD format:**

| Date | Format |
|------|--------|
| January 1, 2025 | 20250101 |
| November 24, 2025 | 20251124 |
| December 31, 2025 | 20251231 |

**No dashes, slashes, or other separators.**

---

## Summary

12 MCP tools. The 11 below are organized into 6 categories; `logseq_get_graph` (graph name and path) is the 12th:

1. **Basic Tools (4)** - Core search (text, property, period), retrieval, page names
2. **Graph Traversal (1)** - Network visualization
3. **Semantic Search (1)** - Relationship-based queries
4. **Context Building (2)** - Comprehensive context for one page and current UI context
5. **Temporal Query (2)** - Time-based analysis
6. **Linking (1)** - Checking a link pass

**Key principle:** Start with the high-level tool (`explore_context`) and drill down with specific tools only when needed.
