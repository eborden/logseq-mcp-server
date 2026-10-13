# LogSeq MCP Tools Reference

Complete documentation for the LogSeq MCP tools organized by category. The server has 14 tools; `logseq_get_graph` (graph name and path) is the one not covered below.

## Tool Categories Overview

| Category | Tools | Purpose |
|----------|-------|---------|
| Basic Tools | 5 tools | Core search (blocks by text, property or period), retrieval, and page names |
| Graph Traversal | 1 tool | Network visualization and relationship discovery |
| Semantic Search | 1 tool | Topic-based relationship queries |
| Context Building | 3 tools | Comprehensive multi-source context aggregation, and what the user is looking at |
| Temporal Query | 2 tools | Time-based analysis and journal queries |
| Linking | 1 tool | Checking a `[[link]]` pass before it is reported done |

## Basic Tools (5 tools)

### logseq_find_blocks

Find blocks, newest first, by text, by a block property, by a period of journal days, or by any of them together. The filters AND together, and at least one is required: a call with none is refused as an invalid parameter.

**Parameters:**
- `text` (optional): Text to find in a block's content. A case-insensitive literal substring: regex characters are plain text, there are no synonyms or stems, and `port` finds "important". An empty `text` is no filter
- `property` and `value` (optional, together): Keep the blocks whose property holds the value. The key is as stored (`created-by`) or camelCase (`createdBy`); the value is an exact string (a number or boolean as its text: `3`, `true`), with no wildcard; a multi-value property matches on any one of its values. A page property comes back as a hit on the page's first block. A task's `SCHEDULED:` and `DEADLINE:` lines are not properties: find them with `text`
- `start_date` and `end_date` (together), `last_n` or `preset` (optional, exactly one way of choosing the period): Keep the blocks on journal pages in the period, and no block of any other page. `start_date` and `end_date` are YYYYMMDD, both days included; `last_n` is the last N **calendar days** ending today, today included (not the N most recent journals that exist, as for `query_by_date_range`); `preset` is `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year` or `year_to_date` (weeks run Monday to Sunday, in local time)
- `limit` (optional): Most blocks returned (default: **100**, max: **500**; a larger value is clamped to 500, not rejected). **Recommend a small `limit` such as 5 to explore**, since the default returns up to 100 blocks
- `offset` (optional): Matches to skip, newest first, to fetch the next page (default: 0). The list shifts if the graph changes between calls
- `include_context` (optional): Give each block a `context` with its page, `references` and `tags` (default: false, **keep false unless needed**). It costs one more call
- `slim_results` (optional): Slim blocks by default (uuid, content, pageName, marker, properties, tags, pageRefs; no numeric ids or page objects). Pass `false` for full entities, with LogSeq's own key spelling (`original-name`, `properties-order`)

**Context cost:** ~200-500 tokens per result. With `include_context=true`: ~500-1000 per result.

**Returns:** a bare array of blocks, flat (no `children`), newest first: highest block id, which is about the order LogSeq created them in, **not the date of the journal page**. The result always has a second content block, `{ "meta": { hasMore, warnings, totals } }`, where `totals.matches` is how many blocks matched before `offset` and `limit`, whether or not any were cut, so a `limit` of 5 on a graph with 180 matches tells you 180 without fetching them. The meta may also carry `tips`.

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

**A cut page:** a result holds at most 30,000 characters, and `detail` `full` has no block cap, so a page of a few hundred blocks passes it. The blocks are kept in page order (nested ones count) and the tail is left out, whole blocks only; a kept block that lost children carries `childrenTruncated: true`. The `result_size_truncated` warning says "Showing N of M blocks" and has no `howToFetchAll`, so `hasMore` stays false: no parameter pages a page. Read on with `detail` `outline` and then `logseq_get_block` (with `include_children`) on the blocks you pick. The same cut applies to `format` `markdown`, with the warning in its footer. A page under the size, and `detail` `page`, come back as they were.

**Example:**
```
logseq_get_page("React")
logseq_get_page("Project Alpha", detail="full")
```

**`detail` `outline`:** lists a page's top-level blocks without their bodies: the shape of the page, to choose from.

**Returns:** `{ page, blocks: [{ uuid, snippet, childCount }], hasMore, warnings, totals }`. `snippet` is the first line, cut to 80 characters. `childCount` counts direct children only. Capped at 200 top-level blocks; a longer page gets an `outline_truncated` warning that names `logseq_get_page` for the rest. Two hundred first lines of 80 characters are about 31,000 characters in JSON, so an outline can also be cut to 30,000 characters (`result_size_truncated`, "Showing N of M top-level blocks", last blocks left out, no `howToFetchAll`); that warning replaces `outline_truncated`, and `format` `toon` is shorter and is measured as TOON.

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
### logseq_get_backlinks

Find the pages that reference a specific page, with the blocks that do. Capped: the result can be a cut list.

**Parameters:**
- `page_name` (required): Name, alias or ISO date of the page to find backlinks for
- `max_pages` (optional): Most source pages returned (default: **20**, max: **100**)
- `max_blocks_per_page` (optional): Most linking blocks kept per source page (default: **10**, max: **50**)

A larger value of either is clamped to its maximum, not rejected. Both are whole numbers: a fraction is rejected.

**Returns:** a bare array of `[page, blocks]` pairs, one per source page, **ranked by the number of blocks that link the page, most first**, ties broken by lowercase page name and then page id. The order is the same on every run, with or without aliases, and applies to every result, not only a cut one: the first entry is the page that links the target most, so match pages by name, not by position. Each page's blocks stay in the order given (nothing ranks them). The cut at `max_pages` keeps the top of this ranking, so a page left out links the target no more than the last page kept (it can tie with it). The ranking counts linking blocks, not importance: a blocker can sit on a page with a single linking block. A second content block, `{ "meta": ... }`, follows when there is a cut, a resolved alias or ISO-date name (`resolvedFrom`), a page with aliases (`resolvedAliases`) or, with next-step tips on (the default), a tip. **The block being there doesn't mean a cut:** a stock server adds one with only `meta.tips` to any non-empty result, and with tips off an uncut exact name gets one block. The signal is `meta.warnings` and `meta.totals`.

**A cut result:** the meta holds `warnings`, `hasMore` and `totals: { pages, blocks }`, which count every source page and every linking block before either cap (only present with a cut):
- `pages_truncated`: "Showing N of M source pages, ranked by linking blocks (most first, ties by page name). The last page kept has X linking blocks, the first dropped page has Y. Blocks per page are capped separately by max_blocks_per_page." So the message says where the cut fell: every dropped page has Y linking blocks or fewer (with `max_pages` of 0 there is no kept page, so the "last page kept" sentence is left out). What to do next depends on M. M of 100 or fewer: `howToFetchAll` says to set `max_pages` to M. M above 100 and `max_pages` below 100: set it to 100 to get 100 of M, and the warning suggests `logseq_find_blocks` with `text` set to `[[page name]]` for the rest (it finds blocks that write the link that way, not `#tags` or alias spellings). `max_pages` already at 100: this warning has no `howToFetchAll`. A raise whose result would pass about 200 linking blocks (counting each page at `max_blocks_per_page`) adds the large-result note to `howToFetchAll` (see the caps paragraph under Best Practices). `hasMore` comes from all the warnings together, so it can still be true when a `page_blocks_truncated` below 50 has one, and then it doesn't mean raising `max_pages` helps
- `page_blocks_truncated`: some kept pages hold more than `max_blocks_per_page` linking blocks. It names up to 5 of those pages, in rank order, with their true block counts (and "N more"). The ranking uses those true counts, so the first page listed is the most-linking one even when the array shows only `max_blocks_per_page` of its blocks. Below 50, `howToFetchAll` says to set `max_blocks_per_page` to the largest count, or to 50 when a page holds more, with the same large-result note when the kept pages would then hold more than about 200 blocks. At 50 this warning has no `howToFetchAll` (and `hasMore` is false unless another warning has one); the way to read such a page whole is `logseq_get_page` with `include_children`
- Both can appear together. Raising `max_pages` shows pages whose blocks the per-page cap may then cut, so a second warning after a raise is expected. Only the pages kept are checked for the per-page cut

**Size:** measured on made-up blocks of one short line with few fields, a linking block is about 200 characters in the result. Real blocks carry more fields (page, parent, properties, refs), so read these as floors and the thresholds as upper bounds. So the defaults' worst case (20 pages of 10 blocks) is about 40,000 characters, and `max_pages=100` with `max_blocks_per_page=50` could be several times the 50,000 that Claude Code saves to a file (see `context-efficiency.md` section 7). Raise to the numbers the warnings name when `totals.blocks` is about 200 or fewer. Above that, raise `max_pages` to the number the warning names and leave `max_blocks_per_page` at 10, or read the one page you need with `logseq_get_page`.

**Use when:**
- Discovering connections
- Understanding how page is used
- Finding related context

**Example:**
```
logseq_get_backlinks("Machine Learning")
```

**Why critical:** Backlinks reveal hidden context and usage patterns.

---

### logseq_get_block

Get specific block by UUID with optional children.

**Parameters:**
- `uuid` (required): UUID of the block
- `include_children` (optional): Include nested child blocks (default: **false**; without it the children come as unfetched references)
- `resolve_refs` (optional): Add `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s (depth 2; default: false)
- `format` (optional): `json` (default) or `markdown`, a `# Block ((uuid))` heading and the block with its children as bullets

**A cut subtree:** with `include_children`, a block with a very large subtree is cut to 30,000 characters: the block, then its descendants in document order, whole blocks only, and a kept block that lost children carries `childrenTruncated: true`. The `result_size_truncated` warning has no `howToFetchAll` (no parameter pages a subtree); read a block marked `childrenTruncated` on its own by its uuid, which starts from it. Without `include_children` the result is one block and is never cut.

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

## Graph Traversal Tools (1 tool)

### logseq_get_concept_network

Build graph network with nodes (pages) and edges (connections).

**Parameters:**
- `concept_name` (required): Root page name
- `max_depth` (optional): Maximum traversal depth (default: 2, max: 3)
- `format` (optional): `json` (default) or `markdown`: pages grouped by depth, then one line per link (`A -> B (n)`, `A <- B (n)` or `A <-> B (out/in)`). About 45% smaller.

**Returns:**
- `nodes`: Array of pages with depth information
- `edges`: Array of connections with relationship types (inbound/outbound)

**Use when:**
- Visualizing knowledge network
- Understanding topic centrality
- Finding hubs and clusters
- Discovering bridges between topics

**Example:**
```
logseq_get_concept_network("Machine Learning", max_depth=2)
```

**Performance:** Gets full network in one call (vs. N calls for N pages).

---

## Semantic Search Tools (1 tool)

### logseq_search_by_relationship

Find blocks based on topic relationships and connections.

**Parameters:**
- `topic_a` (required): First topic name
- `topic_b` (required): Second topic name
- `relationship_type` (required): Type of relationship to search
- `max_distance` (optional): Maximum hops between topics (default: 2)
- `limit` (optional): Most entries in `results` (default: **50**, max: **500**; a larger value is clamped to 500, not rejected). It changes only how many come back, not which are found, so `max_distance` is no way round it. For `connected-within` it counts every block of both pages' trees, **nested ones too**, topic A's page first; for the other types it counts one per matching block

**Returns:** one object, `{ query, relationshipType, results, hasMore, warnings, totals?, resolvedFrom?, resolvedAliases? }`. Unlike `find_blocks` and `get_backlinks`, the meta fields are **inside this first content block**; there is no second block. `hasMore` and `warnings` are always there (`warnings` may be empty), and `totals` is present only with a cut. A kept block that lost some of its children carries `childrenTruncated: true` (`connected-within` only, and only on a cut result).

**A cut result:** a `results_truncated` warning says "Showing N of M" and `totals: { blocks: M }` gives the count before the cut. The tool cuts after the query, keeping the first entries in the order they come, which is **not a ranking**:
- `references`, `referenced-by`, `in-pages-linking-to`: the entries are matching blocks in LogSeq's own order ("the first ones listed, not ranked")
- `connected-within`: the entries are the blocks of the two pages' trees, **nested ones counted**, in document order (a block, then its children, then its next sibling), topic A's page first and then topic B's. `limit` bounds the number of blocks in the result however deep the pages nest, and `totals.blocks` counts in the same unit. The warning reads: "Showing 50 of 168 blocks of the two pages, nested ones counted (kept 50 from topic A and 0 from topic B, of 120 and 48; topic A's first, then topic B's; a kept block shows fewer children than it has (childrenTruncated))". So it says how many of the kept blocks came from each topic and how many each page has, and a result that shows no block of topic B may just mean A's page filled the cap. The last clause appears only when a kept block lost children: that block keeps the first children that fit and has `childrenTruncated: true`, so a block with no `children` and no flag is a real leaf. A page with few top-level blocks and many nested ones is cut too; a result at or below `limit` comes back whole and unchanged

What the warning says next depends on M:
- M of 500 or fewer: `howToFetchAll` says to set `limit` to M (or higher), and that returns all M
- M above 500 and `limit` below 500: it says to set `limit` to 500 (the maximum) to get 500 of M, which is **500 of M, not all**. `hasMore` is true even so
- A raise past about 200 blocks adds "A result this large may be saved to a file by the host instead of shown; the server can't tell" to `howToFetchAll`: the raise still gets those blocks, but the result may not be shown to you, so prefer a narrower query when M is that large.
- `limit` already at 500 (or a larger value that was clamped, which the message names): no `howToFetchAll` and `hasMore` is false. No other parameter narrows the query ("No other parameter narrows this query"), so the warning is the signal that the list is partial; say so instead of reporting a count from it

Other warnings (`frontier_truncated`, `same_topic`) are separate and can appear alongside it; `warnings` holds them all.

**Size:** the entries are full blocks (there is no `slim_results` here), about 215 characters each when the content is one short line, so `limit=50` is about 11,000 characters, `limit=200` about 43,000, `limit=230` about 50,000 and `limit=500` over 100,000. Real blocks carry more fields, so read these as floors. Claude Code saves a result of about 50,000 characters or more to a file and shows the model only the first 2 KB (see `context-efficiency.md` section 7), so treat a `limit` above about 200 as likely to come back saved (rounded down for that reason). `connected-within` is the same size per block, nested ones included (about 33,000 characters for 168 blocks on made-up pages), so `limit` is also its size bound.

**Relationship Types:**

| Type | Description | Example |
|------|-------------|---------|
| `references` | Blocks about A that reference B | "React" blocks mentioning "TypeScript" |
| `referenced-by` | Blocks about A in pages referenced by B | "Testing" notes in pages linked from "Project" |
| `in-pages-linking-to` | Blocks about A in pages linking to B | "Architecture" blocks in pages linking to "Backend" |
| `connected-within` | Both pages' blocks, when a path of N hops or fewer links A and B (no path or distance is returned; find a bridge page with `get_concept_network`) | "TypeScript" and "GraphQL" linked within 3 hops |

**Use when:**
- Finding connections between topics
- Understanding relationships
- Semantic proximity queries

**Example:**
```
logseq_search_by_relationship("TypeScript", "GraphQL", "connected-within", max_distance=3)
logseq_search_by_relationship("React", "Testing", "references")
```

---

## Context Building Tools (3 tools)

### logseq_build_context

Gather comprehensive context for a topic in a single call. **This is often the only tool you need.**

**Parameters:**
- `topic_name` (required): Page name to build context for
- `max_blocks` (optional): Maximum blocks to return (default: 50, **recommend: 20**)
- `max_related_pages` (optional): Maximum related pages (default: 10)
- `max_references` (optional): Maximum reference blocks (default: 20)
- `format` (optional): `json` (default) or `markdown`. Markdown shows the blocks as a tree (no block uuids unless `compact`; page properties as stored), related pages as links, and references grouped by source page, with truncation warnings in a footer. About 75% smaller.
- `compact` (optional): Block snippets (first line, 80 characters) with their uuids instead of block bodies. In JSON each block becomes `{ uuid, snippet }`; `summary`, `totals`, `warnings` and `hasMore` are kept. Read the blocks you want with `logseq_get_block`. Worth it when blocks are long; for short blocks the uuids cost about as much as the text. Skips `resolve_refs`. With `resolve_refs: true` the refs are not resolved and a `resolve_refs_ignored_in_compact` warning says so; set `compact` to false for resolved text.

**Context cost:** ~3-8k tokens depending on limits. Still cheaper than manual aggregation.

**Returns:**
- Main page with properties
- Direct blocks from page
- Related pages (inbound + outbound links)
- Reference blocks mentioning the topic
- Temporal context (for journal pages)
- Summary statistics

**Use when:**
- Need complete picture of a topic
- "What do I know about X?" questions
- Deep dive into specific page

**Example:**
```
logseq_build_context("Q4 Planning", max_blocks=20)
```

**Performance:** Replaces 5+ separate queries with one call. **Don't add find_blocks or get_backlinks after this - it already includes that information.**

---

### logseq_get_context_for_query

Parse natural language query and build context automatically.

**Parameters:**
- `query` (required): Natural language question
- `max_topics` (optional): Maximum topics to extract (default: 5)
- `max_search_results` (optional): Maximum search results for a query with no explicit topics (default: 20, max: 100; a larger value is clamped and a cut is reported)
- `format` (optional): `json` (default) or `markdown` (each topic as a section; keyword search hits end with `((uuid)) (in [[Page]])` so you can follow them up)
- `compact` (optional): Block snippets and uuids instead of bodies, as for `build_context`

**How it works:**
1. Extracts topics from `[[page references]]` and `#tags`
2. Builds context for each topic using `build_context`
3. Returns aggregated results

**A cut result:** the whole result holds at most 30,000 characters, not each topic. Five topics at their caps, or up to 100 keyword hits, can pass it. Entries are cut from the tail, whole: a topic's blocks, then references, then related pages, topic after topic (so the last topics lose theirs first), or for a query with no topic the oldest hits. The `result_size_truncated` warning says how many entries each topic kept (`"Atlas" 4 of 25`) and has no `howToFetchAll`; read a topic on its own with `logseq_build_context`. A `topic_truncated` warning then counts what the topic shows now. The `search_results_truncated` warning offers a larger `max_search_results` only when that many hits fit 30,000 characters ("That is the most that fits"), and after a size cut it gives way to `result_size_truncated`. A result under the size is as it was.

**Use when:**
- Natural language questions
- Multi-topic queries
- User asks complex questions

**Example:**
```
logseq_get_context_for_query("What did I write about [[Project X]] in [[Team Meeting]]?")
logseq_get_context_for_query("Show me notes on #react and #typescript")
```

---

### logseq_get_current

Get what the user is looking at in LogSeq right now: the open page, the block being edited, and any selected blocks.

**Parameters:** none

**Use when:**
- The user says "this page", "this block" or "what I'm looking at" without naming it
- Before `build_context` or `get_page`, to resolve which page "this" means

**Returns:** `{ page, focusedBlock?, selectedBlocks? }`. When no page is open, `page` is `null` with a message. The result reflects live UI state, so calling it twice can give different answers. A selection of a few hundred blocks (a whole page) is cut to 30,000 characters: the first selected blocks stay, whole, and a `result_size_truncated` warning says "Showing N of M selected blocks" with no `howToFetchAll`. Select fewer blocks, or read the page with `logseq_get_page`.

**Example:**
```
logseq_get_current()  # → then logseq_build_context(page.originalName)
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

**A cut result:** `timeline` is cut to `max_entries` mentions, oldest first with undated (non-journal) mentions last, so the cut drops undated mentions first and then the newest dated ones. The meta fields are inside the result object (no second block, as for `search_by_relationship`): `warnings` and `hasMore` appear when a warning applies, and `totals: { mentions }`, the count before the cut, only with a cut. The `entries_truncated` warning says "Showing N of M mentions (oldest first, undated last; the timeline ends at <day>)", and what it says next:
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
| "What do I know about X?" | `build_context` or `get_context_for_query` |
| "Show me everything connected to X" | `get_concept_network` + `get_backlinks` |
| "How did X evolve over time?" | `get_concept_evolution` |
| "What was I doing last week?" | `query_by_date_range` |
| "Find blocks about A that mention B" | `search_by_relationship` |
| "What are my TODOs?" | `find_blocks` (`text` "TODO", and `property` `status`) |
| "When did I mention X?" | `get_concept_evolution` (without grouping) |
| "Get full details on page X" | `build_context` or `get_page` |

### By Question Type

**Initial exploration:**
- `find_blocks` (broad text search)
- `get_context_for_query` (natural language queries)

**Structured queries:**
- `find_blocks` with `property` and `value` (tasks, status, priorities)
- `find_blocks` with a period (blocks from the last days or a named period)
- `query_by_date_range` (journal entries by date)

**Deep dives:**
- `get_page` with `detail="full"` (full page content)
- `build_context` (comprehensive topic context)

**Discovering connections:**
- `get_backlinks` (pages linking to this one)
- `get_concept_network` (full network visualization)

**Relationship-based search:**
- `search_by_relationship` (find blocks based on topic relationships)

**Time-based analysis:**
- `get_concept_evolution` (track concept over time)
- `query_by_date_range` (journal queries)

**Specific blocks:**
- `get_block` (when you have a UUID)

---

## Performance Comparison

### Single-Call Solutions (Fastest)

**`build_context`:**
- Replaces 5+ separate queries
- One API call for complete context
- Best for deep dives

**`get_context_for_query`:**
- Handles natural language automatically
- Extracts topics and builds context
- Best for complex questions

**`get_concept_network`:**
- Full graph in one call
- Shows all connections at once
- Best for visualization

### Multi-Call Workflows (When Needed)

**Broad exploration:**
```
find_blocks → get_page → get_backlinks
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
| `find_blocks` | `limit` (100, 500), `offset` | `results_truncated`, `result_size_truncated` | second content block, always (`totals.matches` even when uncut) | newest first (highest block id) |
| `get_backlinks` | `max_pages` (20, 100), `max_blocks_per_page` (10, 50) | `pages_truncated`, `page_blocks_truncated` | second content block, when cut, resolved by alias or date, or with a tip; `totals.pages`, `totals.blocks` only with a cut | ranked by linking blocks, most first (ties by page name) |
| `search_by_relationship` | `limit` (50, 500) | `results_truncated` | the result object itself; `totals.blocks` | first listed, not ranked; `connected-within`: document order over both pages' blocks, nested ones counted, topic A's page first |
| `get_concept_evolution` | `max_entries` (100, 500) | `entries_truncated` | the result object itself; `totals.mentions` only with a cut | oldest first, undated mentions last |
| `query_by_date_range` | `max_blocks` (200, 1000) | `blocks_truncated` | the result object itself; `totals.blocks`, `totals.days` | oldest day first |

The warning's `howToFetchAll` never points past a maximum. At the maximum there is no `howToFetchAll`, `hasMore` is false and the warning is the only signal, so say the list is partial. The exceptions are the tools that page: `query_by_date_range` leads with a call from the day where the entries end, and `find_pages` and `find_blocks` with their `offset`, so `hasMore` stays true at their maximum. Below it, a total above the maximum gets "set it to the maximum to get N of M", which is a bigger cut list, not all of them. A raise whose result may be too large to be shown carries the note "A result this large may be saved to a file by the host instead of shown; the server can't tell." That note is a hedge, not a size: it appears when the suggested value is past about 200 blocks (150 backlink references, 500 related pages, 200 network nodes, 800 listed pages, or the pages whose blocks add up to 200). Those are sized from slim blocks with no context. `find_blocks` scales the block estimate when a hit comes back larger, and offers a raise only up to what fits its 30,000-character result: about 120 hits with `include_context=true`, about 125 with `slim_results=false`, about 65 with both. `build_context`, `get_concept_evolution` and `search_by_relationship` use the slim estimate whatever their other options, so with long blocks the note can come later than the real limit. It means the raise is still the call that gets those items, but a narrower query may be shown where the raise is saved.

**Size:** Claude Code saves a tool result of about 50,000 characters or more to a file and shows the model only the first 2 KB (`context-efficiency.md` section 7). The tools that return lists or trees (`find_blocks`, `find_pages`, `get_page`, `get_block` with `include_children`, `get_backlinks`, `get_concept_evolution`, `get_concept_network`, `query_by_date_range`, `search_by_relationship`, `build_context`, `get_context_for_query`, `get_current` and `check_links`) cut a result to 30,000 characters first, whole entries from the tail, and say so with a `result_size_truncated` warning. A result passes 30,000 characters only when one entry does (a lone oversized block is returned whole) or when the part that is never cut does (the `find_pages` `names` answers, the `check_links` failures, the open page and focused block of `get_current`), and the warning then says even those are over that size. A `limit` at the maximum is usually cut, so narrow the query or lower the cap rather than raising it.

### Tool Priority

1. Prefer `build_context` over manual aggregation
2. Prefer `get_context_for_query` over multiple searches
3. Use `search_by_relationship` instead of filtering results manually
4. Use `get_concept_network` for full graph (not sequential backlink queries)

### Common Patterns

**Task queries:** Use BOTH `find_blocks(text="TODO")` (markers) AND `find_blocks(property="status", value="todo")` (properties)

**Research:** Start with `find_blocks`, then `get_page`, then `get_backlinks`

**Graph exploration:** Use `get_concept_network` + `get_backlinks` together

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

15 MCP tools. The 14 below are organized into 6 categories; `logseq_get_graph` (graph name and path) is the 15th:

1. **Basic Tools (5)** - Core search (text, property, period), retrieval, page names
2. **Graph Traversal (1)** - Network visualization
3. **Semantic Search (1)** - Relationship-based queries
4. **Context Building (3)** - Comprehensive aggregation and current UI context
5. **Temporal Query (2)** - Time-based analysis
6. **Linking (1)** - Checking a link pass

**Key principle:** Start with high-level tools (`build_context`, `get_context_for_query`) and drill down with specific tools only when needed.
