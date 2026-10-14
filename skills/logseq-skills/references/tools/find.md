# Find tools

You have criteria, not the thing: a word, a property value, a period, a page it links to. A `find` tool returns a flat list of blocks or pages, newest first for blocks and A to Z for pages, paged with `limit` and `offset`, with a `totals` count and `warnings`. If the answer is what something is, how it connects or how it changed, it is an `explore` question instead.

| Tool | Finds | Filters (all AND together) |
|------|-------|----------------------------|
| `logseq_find_blocks` | blocks | `text`, `page`, `links_to`, `property` with `value`, a period |
| `logseq_find_pages` | non-journal pages, each with its aliases | `text`, `names`, `property` with `value` |

Search is literal: there are no synonyms or stems, and a miss means the words are not in the graph, not that the idea isn't. When a search comes back empty, look up the vocabulary with `logseq_find_pages` before you guess again.

## logseq_find_blocks

Find blocks, newest first. At least one filter is required (a call with none is refused as an invalid parameter), and the filters AND together.

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `text` | string | | A case-insensitive literal substring of the block's content. Regex characters are plain text; `port` finds "important". An empty `text` is no filter |
| `page` | string | | Only blocks written on this page (name, alias or ISO date), under every name of the page. A page that doesn't exist is an error with the closest names, and no search is made |
| `links_to` | 1 to 5 strings | | Only blocks that link to **every one** of these pages, under any of their names (aliases followed). `[[x]]`, `#x` and `#[[multi word]]` count, plain text does not. Links inherited from parent blocks don't count |
| `property` | string | | A block property key, as stored (`created-by`) or camelCase. Needs `value` |
| `value` | string, number or boolean | | The exact value. No wildcards. A multi-value property matches on any one value. Needs `property` |
| `start_date`, `end_date` | number `YYYYMMDD` | | A period of journal days, both included. Give both or neither |
| `last_n` | integer, 1+ | | The last N **calendar days**, today included, whether or not each has a journal |
| `preset` | `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`, `year_to_date` | | A named period in local time, weeks Monday to Sunday |
| `limit` | integer | 100 | Page size: most blocks returned in one call, max 500 (a larger value is clamped). Use a small one such as 5 to look around |
| `cursor` | string | | The `nextCursor` of the previous result, to read the next page. Pass it alone: the arguments are in the token, and any other argument is refused |
| `include_context` | boolean | false | Adds each block's page, references and tags. One more call, and bigger blocks |
| `slim_results` | boolean | true | Slim blocks: `uuid`, `content`, `pageName`, `marker`, `properties`, `tags`, `pageRefs`. `false` returns full entities |

A period is exactly one of `start_date` with `end_date`, `last_n` or `preset`, and it keeps only blocks on journal pages in that period.

**Returns:** a bare array of flat blocks (no `children`), newest first by block id, which is about creation order and not the journal's date. A second content block holds `{ "meta": { hasMore, nextCursor, warnings, totals } }`: `totals.matches` counts every match before `limit`, so a `limit` of 5 on 180 matches still tells you 180, and `nextCursor` is there while `hasMore` is true. When `page` or `links_to` named a page, `resolvedFrom` and `resolvedAliases` come first in the meta and say which names were searched. Cuts: `results-and-limits.md` (`results_truncated`, `result_size_truncated`, `search_unavailable`).

**Use when:** keywords ("where did I mention X"), a topic in a period, blocks that link to pages, tasks or any block property. A task marker is text (`text` `TODO`), a `status::` is a property, and a `SCHEDULED:` line is text and not a property, so check what the user uses.

**Example 1.** "Where did I mention the importer?" Look around first.

```json tool=logseq_find_blocks
{"text": "importer", "limit": 5}
```

Read `totals.matches` for how many there are and each `pageName` for where they live. If the five hits are the answer, stop. If `hasMore` is true and you need more, call again with the `nextCursor` and nothing else. If the best hits point at a page, `logseq_explore_context` on that page is the next call.

**Example 2.** "What did Alice and Bob decide about the budget last week?" Blocks that link both people, in a period, with a word.

```json tool=logseq_find_blocks
{"text": "budget", "links_to": ["Alice", "Bob"], "preset": "last_week", "limit": 10}
```

Read `content` of each hit. A block that only says "alice" in plain words is not here: `links_to` matches links. An empty list with no warning means no block links both; try one name at a time before saying so. Next call: `logseq_get_block` with a hit's `uuid` and `include_children: true` for the discussion under it.

**Example 3.** "What am I working on?" Task state lives in markers, properties, or both.

```json tool=logseq_find_blocks
{"property": "status", "value": "doing"}
```

Read `marker` and `content`. A property value is an exact string, so `doing` does not find `DOING`, and a TODO marker needs its own call:

```json tool=logseq_find_blocks
{"text": "DOING", "limit": 20}
```

Read the hits beside the first call, and group by `pageName`. The weekly planning recipe in `context-builder.md` puts these together.

**Example 4.** "What did I write on the project atlas page that mentions Carol?" Scope to a page, then a link.

```json tool=logseq_find_blocks
{"page": "project atlas", "links_to": ["Carol"]}
```

Read the hits: they are blocks on that page that link Carol. To see how the two pages connect beyond this, use `logseq_explore_network` with `to`.

**Example 5.** "Give me the next page of the importer hits." The previous call returned `hasMore: true` and a `nextCursor`.

```json tool=logseq_find_blocks
{"cursor": "<the nextCursor of the previous result>"}
```

Read the next hits. Send the cursor alone (the search and its `limit` are in it), and stop as soon as you have enough: each page costs context.

## logseq_find_pages

Find non-journal pages, A to Z, each as `{ name, aliases? }`. Use it to learn the graph's vocabulary, to check which names exist, or to find pages by a page property. Journals are not pages of this tool (use `logseq_explore_timeline`).

| Parameter | Type | Default | What it does |
|-----------|------|---------|--------------|
| `text` | string | | Pages whose name or an alias contains this text, any case. The page comes back whole with all its aliases, so searching an alias finds its page |
| `names` | 1 to 50 strings | | Page names or aliases to look up exactly, ignoring case, in one call. Each is answered with its page, or with `null` and the closest names |
| `property` | string | | A **page** property key (`vendor`, `created-by`). Needs `value`. Block properties are not matched: use `logseq_find_blocks` |
| `value` | string, number or boolean | | The exact value of the property. A multi-value property matches on any one value. Needs `property` |
| `limit` | integer | 200 | Most pages per call, max 1000 |
| `offset` | integer | 0 | Matching pages to skip, in name order |
| `format` | `json`, `toon` | `json` | `toon` writes the list's keys once. A list of pages with aliases saves little |

**Returns:** `{ pages: [{ name, aliases? }], total, names?, hasMore?, warnings? }`. `total` counts every matching page, aliases excluded, including those not returned. `names` is there only when `names` was sent: one `{ name, page }` per name in the order sent, with `page: null` and `suggestions` (the closest page names) when no page has that exact name or alias, or `candidates` when several pages declare that alias. `null` means no page with that exact name: a namespace leaf (`meetings` for `project/meetings`) or an ISO date answers `null` here, though `logseq_get_page` resolves both. `pages_unavailable` means the list is unknown, not empty.

**Cost:** about 6 to 10 tokens a page, so a 200-page call is about 2k tokens and a 1000-page call up to 8k. Prefer `text`, `names` or `property` when you want a few.

**Example 1.** "What pages do I have about migrations?" Check the vocabulary before you search blocks.

```json tool=logseq_find_pages
{"text": "migration"}
```

Read `pages`: the names and aliases that exist. Use those names, not your guess, in the next call: `logseq_explore_context` on the best page, or `logseq_find_blocks` with `links_to`.

**Example 2.** "Do I have pages for Alice, Bob and Dave?" One call answers all three.

```json tool=logseq_find_pages
{"names": ["Alice", "Bob", "Dave"]}
```

Read `names`: each entry has its `page`, or `null` with `suggestions`. A `null` with a close suggestion is usually a spelling, so ask or use the suggestion. Next call: `logseq_explore_context` for each page that exists, in parallel.

**Example 3.** "Which of my pages are vendors?" A page property, not a block property.

```json tool=logseq_find_pages
{"property": "type", "value": "vendor"}
```

Read `pages` and `total`. Next call: one `logseq_explore_context` per vendor page you need to read. If the pages you expect are missing, the property may be on a block and not on the page: try `logseq_find_blocks` with the same `property` and `value`.

**Example 4.** "List the first part of my graph's pages." Only when you truly need the whole vocabulary.

```json tool=logseq_find_pages
{"limit": 1000, "format": "toon"}
```

Read `pages`. While `hasMore` is true, call again with the `offset` the warning names. A large graph's list is several calls and a lot of context, so use `text` or `names` first.
