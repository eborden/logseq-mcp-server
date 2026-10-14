# Results and Limits

How to read what a tool sends back: warnings, `hasMore`, paging, the 30,000-character budget and the limits a host puts on top. It holds for every tool, so the per-type files (`tools/get.md`, `find.md`, `explore.md`, `check.md`) only say what to pass.

## The rule

A tool never cuts a result silently. If a list was capped, cut to fit the budget or only partly read, the result says so in `warnings`. **Read `warnings` before you say a list is complete, a count is exact or something doesn't exist.**

- `warnings` is a list of `{ code, message, howToFetchAll? }`. It is empty (or absent) when nothing was cut
- `hasMore: true` means a parameter can read on, and `howToFetchAll` names it ("Set offset to 100 for the next page."). Follow it
- `hasMore: false` with a warning means no parameter reads on. The message says why and how to narrow the request. Say the answer is partial
- `totals` holds the real counts before any cut, so a small `limit` is also the cheap way to count
- A warning ending in `_unavailable` means LogSeq sent no answer for that part. The empty list is unknown, not "nothing matches". Retry before you report a miss

## Where the meta is

| Tool | Where `hasMore`, `warnings` and `totals` are |
|------|----------------------------------------------|
| `logseq_find_blocks` | The second content block, `{ "meta": { hasMore, warnings, totals } }`, always there. The first block is the bare array of hits. `totals.matches` counts every match, skipped and cut ones included |
| every other tool | The result object itself, `hasMore` and `warnings` first. `logseq_find_pages` and `logseq_get_current` carry them only when something is missing |
| markdown output | A footer after `---` |

A trailing `{ "meta": { "tips": [...] } }` block may name a next call with ready arguments. Tips are advisory: ignore one that doesn't help, and never read a tip as a sign that a result was cut. Only `warnings` says that.

## Paging

Each list pages in its own unit. Every call below keeps the other arguments the same.

| Tool | Cap (default, max) | Read on with | Order of what is kept |
|------|--------------------|--------------|-----------------------|
| `logseq_find_blocks` | `limit` (100, 500) | `cursor` (the `nextCursor` of the result, passed alone) | newest first (highest block id, about creation order, not the journal's date) |
| `logseq_find_pages` | `limit` (200, 1000) | `cursor` (the `nextCursor` of the result, passed alone) | A to Z by name |
| `logseq_explore_context` | `max_blocks` (50), `max_related_pages` (10), `max_references` (20) | `references_offset` for the references. Blocks and related pages have no offset | blocks in page order; references ranked by how many blocks on their source page link the topic, most first, ties by page name; related pages in LogSeq's order |
| `logseq_explore_network` | `max_nodes` (50, 500), `max_fanout` (15, 100), `max_depth` (2, 3) | a higher cap, when the warning offers one | the pages nearest the root; the deepest are cut first and the root is always kept |
| `logseq_explore_timeline` | `max_blocks` (200, 1000), nested blocks counted | the `start_date` the warning names | oldest day first, except `last_n` with no `page`, which is newest first; with a `page`, blocks on non-journal pages come last |
| `logseq_get_page` with `detail` `outline` | 200 top-level blocks | `logseq_get_block` on a uuid, or `logseq_find_blocks` with `text` | page order |
| `logseq_get_page` with `detail` `full`, `logseq_get_block` with `include_children` | none, only the budget | `cursor` (the `nextCursor` of the result, passed alone) | document order, nested blocks counted |
| `logseq_check_links` | 500 distinct terms in `after` | nothing: check the text in parts | `refs.resolved` only, by term |

A larger value than a maximum is clamped, not rejected, and the warning says so. At a maximum there is no `howToFetchAll`, unless the tool pages (`cursor`, `references_offset`, a date), in which case `hasMore` stays true.

`references_offset` reads a list that shifts if the graph changes between calls, so a long walk can repeat or skip a hit. A `find_blocks`, `find_pages`, `get_page` (`detail` `full`) or `get_block` cursor reads the list its first call saw for up to a minute, then reads again from the last entry it sent, and says `cursor_stale` if the list moved.

When a warning offers a raise ("set `limit` to 250"), `find_blocks` and `find_pages` offer it beside the cursor without measuring it: a raised page that is too large is cut again and carries a cursor of its own. The `explore_*` raises (`max_blocks`, `max_related_pages`, `max_nodes`, `max_fanout`) are still offered only when the raised result is estimated to fit the budget below. Following the `nextCursor` is usually cheaper than the raise. A raise may carry the note "A result this large may be saved to a file by the host instead of shown; the server can't tell": see Host limits.

## The character budget

`find_blocks`, `find_pages`, `get_page`, `get_block` (with `include_children`), `get_current`, `explore_context`, `explore_network`, `explore_timeline` and `check_links` cut a result to **30,000 characters**, after the count caps. The cut:

- drops whole entries from the tail (a hit, a page, a block, the deepest network pages), never text inside one. A single entry over the budget comes back alone
- says so with a `result_size_truncated` warning, "Showing N of M ...", and costs no extra LogSeq call
- has no parameter that raises it. `include_context`, `slim_results: false` and `resolve_refs` make each entry bigger, so fewer fit
- leaves a result under the budget exactly as it was
- never drops a failure: `check_links` cuts only `refs.resolved`, never `ok`, `unresolved`, `ambiguous` or `refsPreserved`, and `find_pages` never cuts its `names` answers

Whether `hasMore` is true after a size cut depends on the tool. `find_blocks` and `find_pages` return a `nextCursor`, so it is true. `explore_context` names a `references_offset` when it dropped only references. `explore_timeline` names the call that reads on from the cut. `get_page` and `get_block` have no way to page a tree, so `hasMore` stays false and the warning names the outline and `logseq_get_block`. `explore_network` says to narrow the walk.

## Warning codes by tool

A code that sits on several tools means the same thing on each. `*_unavailable` codes mean LogSeq gave no answer: retry, never read it as empty.

| Tool | Code | What it means and what to do |
|------|------|-------------------------------|
| `find_blocks` | `results_truncated` | More blocks match than `limit` keeps. "Showing 1-N of M". Pass the `nextCursor` alone |
| | `result_size_truncated` | The blocks `limit` kept don't fit the budget, so the oldest are cut. Pass the `nextCursor` alone |
| | `search_unavailable`, `context_unavailable` | No answer from LogSeq for the search, or for the pages `include_context` asked for |
| | `alias_set_truncated`, `alias_lookup_unavailable` | Some names of a page were not searched. The result may be partial |
| `find_pages` | `pages_truncated` | The list was cut at `limit`. Pass the `nextCursor` alone |
| | `result_size_truncated` | Whole pages cut from the tail, in name order. Pass the `nextCursor` alone |
| | `pages_unavailable` | LogSeq sent no page list: the list is unknown, not empty, and no name was answered |
| `get_page` | `result_size_truncated` | `detail` `full`: blocks past the budget were left out, a kept block that lost children has `childrenTruncated: true`. Pass the `nextCursor` alone: the next page starts with those children, each naming in `ancestors` the blocks it sits under. `detail` `outline`: top-level blocks cut. No `howToFetchAll` |
| | `outline_unavailable` | `detail` `outline`: LogSeq sent no answer for the page's blocks, so an empty outline may not mean the page has no blocks. Retry |
| | `page_blocks_unavailable` | `detail` `full`: no answer for the block tree, so the page comes back without its blocks. Retry |
| | `outline_truncated` | An outline holds at most 200 top-level blocks. Read the rest with `logseq_get_block` or `logseq_find_blocks` |
| `get_block` | `result_size_truncated` | With `include_children`, a very large subtree was cut. Pass the `nextCursor` alone: the next page is `{ uuid, continued: true, children }` |
| `get_current` | `page_names_unavailable` | The pages of the focused or selected blocks couldn't be looked up. With `page: null` it is not "no page is open". Retry |
| | `result_size_truncated` | A selection of a few hundred blocks was cut. Select fewer, or read the page with `logseq_get_page` |
| `explore_context` | `blocks_truncated`, `related_pages_truncated`, `references_truncated` | A count cap bit. For references, follow `references_offset`. `howToFetchAll` for blocks and related pages is a raise, offered only when it is estimated to fit |
| | `result_size_truncated` | The lists the caps kept don't fit: related pages go first, then the last references, then blocks |
| | `backlinks_unavailable`, `page_blocks_unavailable` | No answer for that part. Not "nothing links here" |
| | `blocks_truncated`, `related_pages_truncated` with `max_blocks` or `max_related_pages` set to 0 | Expected: the lists you turned off are reported as cut, with `hasMore: true`. Read `references_truncated` instead |
| | `resolve_refs_ignored_in_compact` | `compact` skips `resolve_refs`. Set `compact` false to get resolved text |
| `explore_network` | `network_truncated` | The caps dropped pages. A raise of `max_nodes` or `max_fanout` is named only when the larger network fits. Otherwise lower `max_depth` or start from a more specific page |
| | `hub_pages_not_expanded` | Roll-up pages (pages that link more than 30 pages) were shown as leaves while depth was left, so what they link is not in the network. The message names them. `howToFetchAll` says to set `expand_journals`, only when it is estimated to fit. Otherwise start from the roll-up page itself and read its links |
| | `result_size_truncated` | The network was cut deepest first. Narrow the walk |
| | `no_path_within` | With `to`: no path within the depth reached. One more hop is offered when it could find one |
| | `same_page` | With `to`: the two names are one page (a page and its alias) |
| | `frontier_truncated` | With `to`: a hop reached more than 500 pages and expanded only some, so "no path" may be a false negative |
| | `links_unavailable` | LogSeq gave no answer for a hop. It is not "no path" and not "no links" |
| `explore_timeline` | `blocks_truncated` | More blocks than `max_blocks`. `howToFetchAll` leads with a paging call from the first day not shown. If one day fills the cap, it offers that day alone, only when it fits |
| | `result_size_truncated` | Whole blocks dropped from the tail. After a size cut the paging call names where to read on |
| | `journals_unavailable`, `blocks_unavailable`, `page_blocks_unavailable`, `page_unavailable`, `mentions_unavailable` | LogSeq answered null for that part: the result is partial, never empty |
| | `alias_set_truncated`, `alias_lookup_unavailable` | Not every alias is covered |
| `check_links` | `result_size_truncated` | Only `refs.resolved` was cut |
| | `candidates_truncated` | An alias several pages declare lists only the most pages it can. The term is still ambiguous: ask which page was meant |
| | `refs_unchecked` | LogSeq gave no answer, so no ref was checked. Don't report the pass as clean |

A tool that takes `resolve_refs` can add three more warnings. `refs_depth_limit`: refs more than two levels deep were left as written, and `howToFetchAll` says to read them with `logseq_get_block`. `refs_unavailable`: LogSeq gave no answer for some refs, so they stay unresolved and this is not "missing": retry. `embed_truncated`: an embed shows only part of what it embeds, and `howToFetchAll` names the call for the rest.

An ambiguous page name is not an error: the result is `{ ambiguous: true, candidates, ... }` with an `ambiguous_page` warning. Pick a candidate by its exact `name` and call again. A `candidates_truncated` warning beside it says the list holds only the most the tool lists, and the rest can't be fetched in one call: name the page more exactly.

## Host limits

A host can limit a tool result below the server's own. Claude Code saves a result of about 50,000 characters or more to a file and shows the model only the first 2 KB with the file's path. The model then loses `summary`, `totals` and `warnings`, which sit at the end, so a cut result looks complete. The 30,000-character budget keeps these tools under that line, so a result is shown in whole. Two things can still push past it:

- one entry larger than the budget, which comes back whole
- a part that is never cut (the `check_links` failures, the `find_pages` `names` answers)

If a result comes back saved to a file ("Output too large", a file path), don't open the file. Repeat the call with half the cap, or one day per call. `context-efficiency.md` section 7 has measured sizes for `explore_timeline` and what to do when a single day is too big.

Other hosts have their own limits. When a result is cut by the host and not by the server, no `warnings` arrive: treat a tool error that names a size or a file as the signal, and ask for less.
