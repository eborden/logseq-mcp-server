# Explore tools

You have a starting point, a page or a period, and want what surrounds it: what is said about it, how it connects, how it changed. An `explore` tool returns a structured result built for synthesis, bounded in characters as well as counts (`results-and-limits.md`). If the answer is a list of hits for criteria, it is `find` instead.

| Tool | Question it answers | Takes |
|------|---------------------|-------|
| `logseq_explore_context` | What do I know about this page, and what links to it? | `page`, caps, `resolve_refs`, `format`, `compact`, `cursor` |
| `logseq_explore_network` | How does this page connect to others, or to a second page? | `page`, `to`, `max_depth`, `max_nodes`, `max_fanout`, `expand_journals`, `with_snippets`, `format` |
| `logseq_explore_timeline` | What happened in a period, or how did this page change? | `page`, a period, `group_by`, `max_blocks`, `top_concepts_limit`, `include_content`, `slim_results`, `resolve_refs` |

Each tool takes one page (or one period) per call. For several pages, call the tool once per page, in parallel: each answer is smaller and is cut on its own. A question is not a page name, so pick the pages yourself; for the words of a question use `logseq_find_blocks`.

## logseq_explore_context

Explore one page in a single call: its blocks, the pages that link to it and the blocks that do (its references, most-linking source pages first). It is often the only tool you need for "what do I know about X".

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `page` | string, required unless `cursor` | | Page name, alias or ISO date. `name` and `page_name` are accepted for it, but send `page` |
| `max_blocks` | integer | 50 | Blocks of the page itself per page of the result. 20 is enough to orient. 0 leaves them out |
| `max_related_pages` | integer | 10 | Pages that link to it, per page of the result. 0 leaves them out |
| `max_references` | integer | 20 | Reference blocks (blocks elsewhere that link to the page), per page of the result |
| `include_temporal_context` | boolean | true | Adds `temporalContext` to the result: `{ isJournal: false }` for an ordinary page, `{ isJournal: true, date }` (YYYYMMDD) for a journal page. `false` leaves it out |
| `resolve_refs` | boolean | false | Adds `resolvedContent` and `resolvedRefs` for `((uuid))` refs and `{{embed}}`s in the blocks and references, two levels deep |
| `format` | `json`, `markdown` | `json` | `markdown` shows the blocks as a tree, related pages as links and references grouped by source page, about 75% smaller. Block uuids appear only with `compact` |
| `compact` | boolean | false | Each block becomes `{ uuid, snippet }` (first line, 80 characters). Read one in full with `logseq_get_block`. It skips `resolve_refs`, with a warning |
| `cursor` | string | | The `nextCursor` of the previous result, passed alone: the next page of the blocks, references and related pages. No other argument goes with it (they are in the token) |

**Returns:** `page` (as you wrote it; `resolvedFrom` says when it was an alias, a date or a namespace leaf, on the first page only), `hasMore`, `nextCursor` (when `hasMore` is true), `warnings` and `totals` (`blocks`, `relatedPages`, `references`: the real counts before any cap), then `summary` (with `pageProperties`; first page only), `mainPage` (the page entity and its properties), `directBlocks`, `relatedPages` (each `{ page, relationshipType }`, once, in LogSeq's order, not ranked), `references` (each `{ block, sourcePage }`) and `temporalContext` (on every page, not only journals).

**References are ranked** by how many blocks on their source page link the page, most first, ties by lowercase page name. The first one listed is on the page that links the topic most, which answers "what connects to this" without raising anything. A page and its aliases count as one topic. The ranking counts linking blocks, not importance: a blocker can sit on a page with one linking block, so read on with the cursor only when the question needs every referrer.

**A busy page comes back a page at a time.** Each call returns up to `max_blocks` blocks, `max_references` references and `max_related_pages` related pages, cut to 30,000 characters from the tail (related pages first, then references, then blocks). While `hasMore` is true, call again with only the `nextCursor`: the next page continues each of the three lists where it stopped, a list that is read to its end is simply empty, and `max_blocks: 0` (or either of the other two) leaves a list out of every page. The warning may also offer a higher cap, as the other way: the cursor is usually cheaper.

**Cost:** 3 LogSeq calls (4 when the page has an alias), about 3k to 8k tokens at the defaults. It already includes the page's content and its references, so don't follow it with `logseq_get_page`, `logseq_find_blocks` or a second look at the links.

**Use when:** "what do I know about X", "what links to X", refreshing on a person or a project, any research that starts from a page. Without a page: `logseq_find_blocks` for the words, or `logseq_find_pages` for the name.

**Example 1.** "What do I know about Project Atlas?"

```json tool=logseq_explore_context
{"page": "project atlas", "max_blocks": 20}
```

Read `directBlocks` for what the page says, `references` for what the rest of the graph says about it (note each `sourcePage`) and `relatedPages` for the neighbours. Check `warnings` and `totals` before you call a count complete. Next call: `logseq_explore_context` on a related page that matters, or `logseq_get_block` on a block you want whole.

**Example 2.** "I meet Alice in ten minutes. Refresh me." A person page is a page like any other.

```json tool=logseq_explore_context
{"page": "Alice", "max_blocks": 20, "max_references": 15, "compact": true}
```

Read the `snippet` of each block and reference, and the `sourcePage` names: recent threads are on journal pages. Compact keeps this cheap when blocks are long. Next call: `logseq_explore_timeline` with `page` and `last_n` for what happened with Alice lately, and `logseq_get_block` on any snippet that needs its full text.

**Example 3.** "What else links to Project Atlas?" The first call returned `references_truncated` with `hasMore: true` and a `nextCursor`.

```json tool=logseq_explore_context
{"cursor": "<the nextCursor of the previous result>"}
```

Read the next references (and the blocks and related pages the first page did not hold). The ranking is the same on every page, so they join with nothing repeated. Pass nothing but the cursor: the arguments are in it. The last page has no `nextCursor`. Stop when the question is answered: only a blocker hunt or a count needs every referrer. To read only the references, start with `max_blocks` and `max_related_pages` at 0: the result then carries `blocks_truncated` and `related_pages_truncated` warnings for what you left out on purpose, so ignore those two and read `references_truncated`.

## logseq_explore_network

Explore how a page connects: the pages linked to it as nodes and edges, in both directions, up to `max_depth` hops, one edge per page pair with a reference count. With `to`, the shortest path of links from `page` to a second page.

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `page` | string, required | | Page to start from (name, alias or ISO date). `name` and `page_name` are accepted for it |
| `to` | string | | A second page. The result is then the shortest link path, not the network |
| `max_depth` | integer | 2 | Hops. 1 is the page's direct neighbours. Max 3 (a larger value is capped) |
| `max_nodes` | integer | 50 | Most pages, root included, max 500. Not with `to` |
| `max_fanout` | integer | 15 | Most new pages any one page may add, max 100. Not with `to` |
| `expand_journals` | boolean | false | Walk through journal pages and roll-up pages instead of treating them as leaves. A roll-up page is a page that links more than 30 pages, such as a generated weekly summary. They link to almost everything, so this can flood the network. Without it they are listed after every other page, so they don't crowd out topical neighbours, and their own links are not followed. Not with `to` |
| `with_snippets` | boolean | false | Adds to each edge of the root a `snippet`: the first line (80 characters) of one block that makes the link, as a hint of why two pages connect. No extra call, but the result is longer. Not with `to` |
| `format` | `json`, `markdown` | `json` | `markdown` groups pages by depth and writes one line per link (`A -> B (n)`), about 45% smaller |

Setting `max_nodes`, `max_fanout`, `expand_journals` or `with_snippets` together with `to` is refused as an invalid parameter.

**Returns the network:** `{ page, resolvedFrom?, resolvedAliases?, truncated, hasMore, warnings, nodes, edges }`. `nodes` are `{ id, name, depth }`, the root at depth 0. `edges` are one per pair of pages, `{ from, to, type, count, outbound, inbound }`: `from` is the page nearer the root, `outbound` counts blocks on `from` that link `to`, `inbound` blocks on `to` that link `from`. With `with_snippets`, an edge of the root also has a `snippet`, last. It is a hint, not a summary: a block's first line may not say why the pages are linked.

**Returns the path (with `to`):** `{ page, to, hops?, hasMore, warnings, nodes, edges }`. `nodes` are the pages of the path in order, from `page` to `to`. `hops` is the number of links and is there only when a path was found. With none, `nodes` and `edges` are empty and a warning says why. Every name of a page counts as that page, and among paths of one length the walk takes the one through pages that are not journals.

**It returns no blocks.** For the text of the links use `logseq_explore_context` (its `references`) or `logseq_find_blocks` with `page` and `links_to`.

**Cost:** 3 LogSeq calls for depth 2 (one more when the page has an alias). A path costs one resolver query per page, then one query per hop, ending at the first hop that reaches `to`: 3 calls for a page one link away.

**Use when:** hubs and leaves around a topic, how central it is, how two projects or people connect and through which pages (the middle nodes of a path are the bridges). Don't use it to read what pages say.

**Example 1.** "What is Project Atlas connected to, and why?"

```json tool=logseq_explore_network
{"page": "project atlas", "max_depth": 1, "with_snippets": true}
```

Read the `nodes` for the direct neighbours, each `edge` for its link counts (high counts are the closest ties) and its `snippet` for a hint of why the two pages are linked. Roll-up pages and journals are listed last and are not walked through. If `truncated` is true, see `warnings` for the cap that bit: a page with more than 15 neighbours hits the `max_fanout` default even at depth 1. Next call: `logseq_explore_network` again with `max_depth: 2` from the one neighbour you care about, or `logseq_explore_context` on it.

**Example 2.** "How do the billing work and the onboarding redesign connect?"

```json tool=logseq_explore_network
{"page": "billing", "to": "onboarding redesign", "max_depth": 3}
```

Read `hops` and the `nodes` in order: the pages in the middle are the bridges. Each `edge` has its link counts. Next call: `logseq_find_blocks` with `links_to` set to a bridge page and one end, to read the blocks that make the link.

**Example 3.** "How is the importer project related to Dave?" A short walk first, since a path usually is short.

```json tool=logseq_explore_network
{"page": "importer", "to": "Dave", "max_depth": 2}
```

If the result has no `nodes` and a `no_path_within` warning, read the warning, not the empty list: when it says one more hop could find a path, call again with `max_depth: 3` (the maximum). When it says the walk reached every page it could, the pages are not connected by links. `links_unavailable` is a failed lookup, not "no path": retry. `same_page` means the two names are one page. Pages that share words but no links are a `logseq_find_blocks` question.

## logseq_explore_timeline

Explore a page or a period over time: blocks by day (or week, or month), with `summary.topConcepts`. Give `page` (its blocks and the blocks linking to it, under any alias), a period, or both. A period leaves out blocks on non-journal pages.

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `page` | string | | The page to follow, with its aliases. Optional when a period is given |
| `start_date`, `end_date` | number `YYYYMMDD` | | A period, both days included, real dates from 1900 to 2100, the start not after the end. Give both or neither |
| `last_n` | integer, 1+ | | The last N **calendar days**, today included, whether or not each has a journal |
| `preset` | `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`, `year_to_date` | | A named period in local time, weeks Monday to Sunday |
| `group_by` | `day`, `week`, `month` | `day` | Joins days into one entry per period (`2025-W02`, `202501`) |
| `max_blocks` | integer | 200 | Most blocks across all entries, nested ones counted, max 1000. Page at 200 rather than raising it |
| `top_concepts_limit` | integer | 10 | Size of `summary.topConcepts`, the most-linked pages. 0 omits it |
| `include_content` | boolean | true | `false` returns per-day block counts and first-line snippets only |
| `slim_results` | boolean | true | `false` returns full entities |
| `resolve_refs` | boolean | false | Adds `resolvedContent` and `resolvedRefs` for refs and embeds |

At least one of `page` or a period is required, and a period is exactly one of `start_date` with `end_date`, `last_n` or `preset`.

**Returns:** `page`, `resolvedFrom`, `resolvedAliases`, `dateRange`, `hasMore`, `warnings`, `totals` (`{ blocks, days }`), `summary` (`totalDays`, `totalBlocks`, `topConcepts`) and `entries`. An entry is a day, `{ date: 20250106, pageName, blocks }`; with `group_by` week or month it is `{ period, blocks }`. Days run oldest first, except a period with no `page` and `last_n`, which lists the newest first. With a `page` and no period, blocks on non-journal pages come last in one entry with `date: null`. `summary` covers every block found even when `entries` stops early. `summary.topConcepts` of a page counts what the blocks linking to it also link (the page, its aliases, journal pages and built-in task tags are left out).

**Cost:** a period alone is 2 LogSeq calls whatever its length. A page is 4 (5 with an alias), and adding a period costs none. About 1k to 3k tokens for a week of a page's blocks.

**Use when:** "what happened this week or in November", "how did X change", "what was I doing with X lately". For a word inside a period, use `logseq_find_blocks` with `text` and the same period. `page` is a page name, not a word.

**Dates:** `start_date` and `end_date` are numbers in `YYYYMMDD`: `20251101` is November 1, 2025. No dashes or slashes.

**Example 1.** "What happened last week?"

```json tool=logseq_explore_timeline
{"preset": "last_week"}
```

Read `summary.topConcepts` first for the themes, then `entries` day by day (oldest first). Check `warnings`: `blocks_truncated` means days are missing from the end, and `howToFetchAll` names the `start_date` to continue from. A day with no journal page has no entry, so a missing day is not a day with nothing written. Next call: `logseq_explore_context` on a top concept, or the paging call the warning names.

**Example 2.** "How has my thinking on Rust changed this year?" A page, grouped by month.

```json tool=logseq_explore_timeline
{"page": "Rust", "group_by": "month", "start_date": 20250101, "end_date": 20251231}
```

Read each `{ period, blocks }` entry in order and watch for gaps. With a period, blocks on non-journal pages are left out: drop `start_date` and `end_date` to include the page's own blocks, which come last under `date: null`. Next call: `logseq_get_block` for a block you want to quote, or `logseq_find_blocks` with `text` and one quarter's dates to look closer.

**Example 3.** "How busy were the last two weeks?" Size a period cheaply with snippets only.

```json tool=logseq_explore_timeline
{"last_n": 14, "include_content": false, "max_blocks": 500}
```

Read `blockCount` and the first-line `snippets` per day and `summary.totalBlocks`. Next call: the same period with `include_content: true` and the default `max_blocks` for the days that matter, one `start_date` to `end_date` at a time.

**Example 4.** "What did Bob and I talk about this month?" A page and a period together: the days in the period where blocks link to the page.

```json tool=logseq_explore_timeline
{"page": "Bob", "preset": "this_month", "top_concepts_limit": 5}
```

Read the entries for the threads and `summary.topConcepts` for what else was in those blocks. Next call: `logseq_find_blocks` with `links_to` set to Bob and a `text` to narrow to one topic.
