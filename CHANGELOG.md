# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

1.0.0 was the first release, so its entry has no earlier release to compare against. The 2.0.0 entry is a hard cut and opens with a migration note.

## [2.0.0] - Unreleased

v2.0.0 is a hard cut with no deprecation window (ADR-0037). The 16 v1 tools become 10, each named `logseq_<type>_<object>` with a type of `get`, `find`, `explore` or `check`, and every page parameter is `page`. There are no known external callers of v1, so nothing is kept as an alias beyond the few named below. A caller of the tools (the `logseq-skills` plugin skills are already rewritten for v2) should read the migration note first. `rust/Cargo.toml`, `package.json` and the plugin manifests all read 2.0.0.

### Migration note: v1 to v2

**An old call does not always fail.** Unknown arguments are ignored in every tool (BR-0008), so a call that still sends a retired parameter is refused only when that leaves a required parameter missing. These three succeed silently with a different result:

- `logseq_get_page` with `include_children: true` succeeds (`page_name` is read as an alias of `page`) but returns the page **without its blocks and with no warning**. Use `detail: "full"`.
- `logseq_find_pages` with `name_contains` succeeds and returns the **unfiltered** list (the first 200 pages, with a `nextCursor` to read on). `name_contains` is now `text`.
- `logseq_explore_timeline` with `search_term` (or `concept_name`, or `max_entries`) succeeds when the call also has a period, as an **unfiltered period read** (the default 200 blocks, and no `max_entries` cap). With no period it is refused with `Invalid parameter 'page or period': none given`. A `search_term` that was free text is `logseq_find_blocks` with `text` and the same period (`start_date` with `end_date`, `last_n` or `preset`). A `search_term` that was a page name is `page`. This is the retired parameter most likely to be hit: a replay of old calls found that some now get a refusal or a smaller result, and that text-only mentions and nested children no longer come back in page mode.

A call that sends only a retired name for a required parameter (`topic_name`, `concept_name`, `topic_a`) is refused with `Invalid parameter 'page': missing`. A `logseq_find_blocks` call that sends `query`, or `property_key` with `property_value`, has no filter and is refused as such.

**Tools.** Every v1 tool and what replaces it:

| v1 tool | v2 replacement |
|---|---|
| `logseq_get_page` | `logseq_get_page` (`page_name` is now `page`; `include_children: true` is `detail: "full"`) |
| `logseq_get_page_outline` | `logseq_get_page` with `detail: "outline"` |
| `logseq_get_block` | `logseq_get_block` (`block_uuid` is now `uuid`) |
| `logseq_get_current_context` | `logseq_get_current` (renamed, no parameters) |
| `logseq_get_graph_info` | `logseq_get_graph` (renamed, no parameters) |
| `logseq_list_pages` | `logseq_find_pages` (`name_contains` is now `text`; adds `names`, `property` and `value`) |
| `logseq_search_blocks` | `logseq_find_blocks` with `text` |
| `logseq_query_by_property` | `logseq_find_blocks` with `property` and `value` |
| `logseq_search_by_relationship`, `references` | `logseq_find_blocks` with `page` (topic A) and `links_to` (topic B, up to 5 pages) |
| `logseq_search_by_relationship`, `connected-within` | `logseq_explore_network` with `to` (the path between the pages, not their blocks) |
| `logseq_search_by_relationship`, `referenced-by` and `in-pages-linking-to` | Dropped (see below) |
| `logseq_build_context` | `logseq_explore_context` |
| `logseq_get_backlinks` | `logseq_explore_context` with `max_blocks: 0` and `max_related_pages: 0` |
| `logseq_get_context_for_query` | Dropped. Call `logseq_explore_context` once per page (in parallel for several), and `logseq_find_blocks` for keywords |
| `logseq_get_concept_network` | `logseq_explore_network` |
| `logseq_get_concept_evolution` | `logseq_explore_timeline` with `page` |
| `logseq_query_by_date_range` | `logseq_explore_timeline` with a period |
| `logseq_check_links` | `logseq_check_links` (unchanged) |

**Parameters.** Every renamed or removed parameter. A parameter that is not listed is unchanged. The only aliases are `name` and `page_name` for `page` (on `get_page`, `explore_context` and `explore_network`) and `block_uuid` for `uuid` (on `get_block`). There are no `topic`, `concept` or `property_name` aliases, and the find tools and `explore_timeline` take none, since nothing is required on them.

| v1 tool and parameter | v2 tool and parameter |
|---|---|
| `get_page` `page_name` | `get_page` `page` |
| `get_page` `include_children` | `get_page` `detail: "full"` (`detail` is `page`, the default, `full` or `outline`) |
| `get_page_outline` `page_name` | `get_page` `page` with `detail: "outline"` |
| `get_page_outline` `format` (`json`, `toon`) | `get_page` `format` with `detail: "outline"` (`toon` only for the outline, `markdown` only for `page` and `full`; a mismatch is an `InvalidParameter`, and so is `resolve_refs` with the outline) |
| `get_block` `block_uuid` | `get_block` `uuid` |
| `list_pages` `name_contains` | `find_pages` `text` |
| `list_pages` `offset` | `find_pages` `cursor` (see Paging; `limit` stays as the page size) |
| `search_blocks` `query` | `find_blocks` `text` |
| `query_by_property` `property_key` | `find_blocks` `property` |
| `query_by_property` `property_value` | `find_blocks` `value` |
| `search_by_relationship` `topic_a` | `find_blocks` `page` (for `references`), or `explore_network` `page` (for `connected-within`) |
| `search_by_relationship` `topic_b` | `find_blocks` `links_to` (a list of 1 to 5 pages), or `explore_network` `to` |
| `search_by_relationship` `relationship_type` | Gone. The mode is the tool |
| `search_by_relationship` `max_distance` | `explore_network` `max_depth` (at most 3 with `to`; v1 had no cap) |
| `search_by_relationship` `limit` | `find_blocks` `limit` (default 100, v1 was 50), or gone with `explore_network` `to` |
| `build_context` `topic_name` | `explore_context` `page` |
| `get_backlinks` `page_name` | `explore_context` `page` |
| `get_backlinks` `max_pages` and `max_blocks_per_page` | `explore_context` `max_references` (references per page) and `cursor` for the rest (`max_pages: P, max_blocks_per_page: B` is about `max_references: P*B`; the ranking keeps a page's blocks together, so a page-by-page cap has no exact equal) |
| `get_context_for_query` `query`, `max_topics`, `max_search_results` | Gone with the tool |
| `get_concept_network` `concept_name` | `explore_network` `page` |
| `get_concept_evolution` `concept_name` | `explore_timeline` `page` |
| `get_concept_evolution` `max_entries` | `explore_timeline` `max_blocks` (default 200, v1 was 100; nested blocks count) |
| `get_concept_evolution` `start_date` or `end_date` alone | `explore_timeline` needs both, or `last_n`, or `preset`. A lone bound, or a bound of 0, is refused |
| `query_by_date_range` `search_term` | `find_blocks` `text` with the same period, or `explore_timeline` `page` |

**Behaviour changes in parameters that kept their name.**

- `last_n` (on `explore_timeline` and `find_blocks`) is the last N calendar days ending today, in no call of its own. In v1 `query_by_date_range` took the N most recent journals that exist. A daily journal sees no difference; a journal with gaps returns fewer than N days. Presets and explicit dates are unchanged.
- With a `page` and a period, `explore_timeline` leaves out blocks on non-journal pages, which have no day in the period. With a `page` and no period they come last, in an entry with `date: null`.
- `find_blocks` with an empty `text` and no other filter is refused (v1 `search_blocks` with `query: ""` matched every block). Beside another filter an empty `text` is ignored. Whitespace is text.
- `explore_network` with `to` refuses `max_nodes`, `max_fanout`, `expand_journals` and `with_snippets` instead of ignoring them.

**Paging.** One forward-only cursor pages every cut list (ADR-0038). It replaces the `offset` and `references_offset` parameters, which v1 had on `list_pages` and v2 briefly had on `find_blocks`, `find_pages` and `explore_context`.

- **Which tools.** `find_blocks`, `find_pages`, `get_page` (`detail` `full` and `outline`), `get_block` (with `include_children`), `explore_context`, `explore_timeline` and `explore_network` (the walk, not `to`) take an optional `cursor` and return `nextCursor` in the meta, right after `hasMore`, absent on the last page. `hasMore` is true exactly when `nextCursor` is present, with one exception: a `refs_depth_limit` warning from `resolve_refs` can still set it. `get_graph`, `get_current`, `check_links` and `explore_network` with `to` are not paged.
- **`offset` and `references_offset` are gone, and a stale one is ignored.** A caller that still sends `offset` (or `references_offset`) gets page 1 every time, so a loop that pages by offset reads the same page again and never ends. Page with `cursor`: pass the `nextCursor` of the previous result.
- **A call with a `cursor` takes no other argument.** The arguments are in the token, and any other argument (`limit`, `page`, `format`) is refused by name with `InvalidParameter` before any LogSeq call. So `page` (`get_page`, `explore_context`, `explore_network`) and `uuid` (`get_block`) are optional in the schema, which is the exception to BR-0008's "the canonical parameter stays required". A call with neither the name nor a `cursor` is refused. A token of another tool, an unknown version or text that is no token is refused too.
- **Page size.** `limit` (`find_blocks`, `find_pages`; max 500 and 1,000), `max_blocks` (`explore_timeline`, and the blocks of `explore_context`), `max_references` and `max_related_pages` (the other two lists of `explore_context`, each per page), and `max_nodes` (`explore_network`, whose walk now runs to 500 pages and is read a page at a time). `get_page` `full` and `get_block` have no page size, only the 30,000-character budget, and the outline pages by 200 top-level blocks. `limit: 0` shows nothing and has no cursor.
- **Snapshots.** The first call keeps its whole result in a per-process cache for at most 1 minute from when it was made (reading a page does not extend it), so a later page costs 0 LogSeq calls and reads from the same version of the graph as the pages before it. After a minute, a restart, an eviction or a result too large to keep (over about 630 KiB of JSON), the tool rebuilds the list with page 1's calls and resumes after the last entry sent. If the list moved in between it says so with a `cursor_stale` warning, and never repeats or skips silently. A cursor past the end is an empty page with `cursor_stale`.
- **What a continuation page leaves out.** `resolvedFrom`, `resolvedAliases` and the `names` answers of `find_pages` ride on page 1 only (`explore_timeline` keeps `page`, `resolvedFrom`, `resolvedAliases` and `dateRange` on every page). `explore_timeline` also leaves out `summary` and its tip after page 1; `explore_context` keeps its `summary`. Completeness warnings (an alias lookup that was cut, a part LogSeq did not answer) repeat on every page.
- **Trees and timelines are cut in whole blocks.** A page of `get_page` `full`, `get_block` or `explore_timeline` that starts inside a subtree lists its blocks at the top, each carrying `ancestors` (`[{ uuid, snippet }]`, outermost first); a block whose later children are on the next page has `childrenTruncated: true`. A later page of a `get_block` result is `{ uuid, continued: true, children }`. A day cut between two timeline pages appears on both with the same `date`. In Markdown, a page starting mid-subtree has an `[under: A > B]` line.
- **Cap raises sit beside the cursor.** `howToFetchAll` leads with the cursor and may offer the raise of a cap as the alternative: `limit` (`find_blocks`, `find_pages`), `max_references` and `max_related_pages` (`explore_context`) on page 1 only, and `max_fanout` and `expand_journals` (`explore_network`) with the walk's own warnings. `explore_timeline` offers only `max_blocks` above 0 when it was 0. A raise is not measured against the budget, since a larger result is simply paged, and it never sets `hasMore` by itself. The v1 and early v2 date paging of a cut timeline (a new `start_date`) is gone, as are the "No parameter raises the size limit" lines on the tools that page.
- **`explore_network`.** `max_nodes` is now the size of a page, not a cap on the walk. Page 1 holds the same pages, depths and edges as the capped walk of before, and each edge is sent once, on the page that holds its later end. `network_truncated` now means only that a rule (`max_fanout`, the 500-page limit) left pages out, and `truncated` still says so; a page cut by `max_nodes` or by the budget is `pages_truncated` or `result_size_truncated` with the cursor. At `max_fanout` 100 and `max_depth` 3 the walk can make one more query than the capped walk did (never more than 2 plus `max_depth`).

**Dropped capabilities.**

- **Multi-topic context.** `get_context_for_query` is gone, with its topic extraction from a question, `max_topics` and `max_search_results`. Make one `explore_context` call per page (they run in parallel and give smaller answers), and use `find_blocks` with `text` for keywords.
- **The `referenced-by` and `in-pages-linking-to` modes** of `search_by_relationship`. Nothing replaces them.
- **The blocks of two pages in one call** (`connected-within`). `explore_network` with `to` returns the path as nodes and edges. For the blocks, call `explore_context` or `find_blocks` with `page` and `links_to`.
- **Page-by-page backlink caps** (`max_pages`, `max_blocks_per_page`): see the parameter table.
- **The whole-word match of a page's other alias names** that `search_term` did on a page name. `explore_timeline` with `page` matches blocks that link the page under any alias.

**Result shape changes.**

- **Character budget (new on every list tool).** `explore_context`, `explore_network`, `explore_timeline`, `find_blocks`, `find_pages`, `get_page` (`full` and `outline`), `get_block` with `include_children`, `get_current` and `check_links` (its resolved refs only) cut their main list from the tail, whole entries only, to at most 30,000 characters (ADR-0011), after the count caps. The cut is a `result_size_truncated` warning, and `hasMore` is true where a call can read on (the warning names the call). A result under the budget is unchanged. v1 results of 50,000 to 110,000 characters, which a host may save to a file instead of showing, are now cut. There is no parameter to raise the budget.
- **`find_pages`.** When `names` is sent the result gains a `names` key, first: one entry per name in the order sent, `{ name, page }`, or `page: null` with `suggestions` (closest names) or `candidates` (several pages declare the alias). Names are answered over every non-journal page, whatever the other filters keep. A name matches by exact name or alias only: an ISO date or a namespace leaf, which `get_page` resolves, answers `null` here.
- **`find_blocks`, from `query_by_property`.** Blocks and pages carry LogSeq's own key spelling (`created-at`, `properties-order`, `original-name`) where v1 camelCased them (`createdAt`, `propertiesOrder`, `originalName`). Results are newest first by block id (v1 was page id, then block id, ascending). The warning `property_query_unavailable` is now `search_unavailable`.
- **`find_blocks`, from `search_by_relationship` `references`.** Blocks are slim by default and newest first (v1 kept LogSeq's order), with `totals.matches` and a `resolvedFrom` list, and no `query` or `relationshipType` echo.
- **`explore_context`, from `build_context`.** The result key `topic` is `page`. The references are the same set, now ranked most-linking source page first, and paged with `cursor` together with the blocks and related pages.
- **`explore_context`, from `get_backlinks`.** The result is no longer a bare `[page, blocks]` array with a trailing `meta` block. `references` is a flat list of `{ block, sourcePage }` (the blocks of one page sit together), and `hasMore`, `warnings` and `totals` come first. `max_blocks: 0` leaves the blocks out of the result, but the page's blocks are still read.
- **`explore_network`, from `get_concept_network`.** The first result key `concept` is `page`. The `network_truncated` advice is worded differently, and offers a raise of `max_nodes` or `max_fanout` only when the raised network is estimated to fit the budget. A page that links more than 30 pages (a roll-up page) is a leaf that ranks after every other page, as journals do, and is named in a `hub_pages_not_expanded` warning; `expand_journals` now covers both.
- **`explore_network` with `to`, from `search_by_relationship` `connected-within`.** The result is the path: `{ page, to, resolvedFrom?, resolvedAliases?, hops?, hasMore, warnings, nodes, edges }`, with `nodes` in path order and `depth` 0 to `hops`. `resolvedFrom` and `resolvedAliases` are keyed `page` and `to`, not `topicA` and `topicB`. Warnings: `same_topic` is `same_page`, `hop_unavailable` is `links_unavailable`, `page_blocks_unavailable` is gone, `frontier_truncated` is kept, and `no_path_within` is new (a miss was an empty `results`).
- **`explore_timeline`, from `query_by_date_range`.** `dateRange`, `entries`, `summary` (`totalDays`, `totalBlocks`, `topConcepts`), `totals`, `hasMore` and `warnings` are as they were, with the key order of BR-0013. `summary.searchTerm` and the `search_term` alias warnings are gone.
- **`explore_timeline`, from `get_concept_evolution`.** `concept` is `page`. `timeline[{ date, blocks }]` is `entries` (the same days, now with `pageName`; the blocks on non-journal pages are an entry with `date: null`, last). `groupedTimeline` is gone: `group_by` week or month makes the entries `{ period, blocks }` instead of adding a copy of every block. `summary.totalMentions` is `summary.totalBlocks`, `journalMentions` is the dated entries, `nonJournalMentions` is the `date: null` entry's blocks, and `summary.dateRange { earliest, latest }` is the top-level `dateRange { start, end }`. `totals.mentions` is `totals.blocks`, and `entries_truncated` is `blocks_truncated`. Blocks are slim by default (BR-0012); `slim_results: false` returns full entities as before. `summary.topConcepts` is new for a page: it counts the pages that the blocks linking to it also link, not the links inside the page's own blocks.

### Added

- **`logseq_find_pages`** takes `names` (1 to 50 exact names or aliases, each answered with its page or `null` plus the closest names) and `property` with `value` (a page property). Both ride on the one `getAllPages` call.
- **`logseq_find_blocks`** takes `page` (the blocks on a page and its aliases), `links_to` (blocks that link every one of 1 to 5 pages), and a period (`start_date` with `end_date`, `last_n` or `preset`). The filters AND in one query.
- **`logseq_explore_network`** takes `to` (the shortest link path to a second page) and `with_snippets` (the first line of one linking block on each edge of the root).
- **`cursor` and `nextCursor`** on every tool that cuts a list (see Paging above), so a result of any size can be read to the end.
- **`logseq_explore_timeline`** takes `page` with or without a period, and `group_by` for both.
- **Four tool types.** `get` (you name it), `find` (criteria in, hits out), `explore` (what it is, how it connects, how it changed) and `check` (before writing). Parameter names come from one vocabulary that guard tests hold.

### Changed

- The server instructions route by the four types, with one line for each second-brain question. The prompts and the guide resource name the v2 tools.
- The `logseq-skills` skills are rewritten for v2: a reference for each tool type with JSON examples that a guard test checks against the recorded tool list, and second-brain recipes.
- The README documents the `uvx logseq-mcp-server` install. The 1.0.0 wheels (macOS arm64 and x86_64, Linux x86_64) are on PyPI and carry the same binary as the GitHub Release. There is no Windows or Linux arm64 wheel (ADR-0036).
- The tool-list size budget (`TOOL_LIST_BUDGET_CHARS`) is lowered to the measured size of the 10 tools plus about 15% (ADR-0016).

### Removed

- The tools that were merged or renamed into the v2 tools: see the table above. Nothing keeps the v1 names.

## [1.0.0] - 2026-10-09

### Changed (server runtime)

- **The server is now the Rust binary** (ADR-0035, ADR-0036). It is released as native binaries on GitHub Releases for macOS (Apple silicon and Intel) and Linux x86_64, each listed in `SHA256SUMS` and attested with build provenance. The Claude Code plugin starts it through a small shell launcher that downloads the binary for the plugin's own version and checks it against `SHA256SUMS` before it runs. There is no Windows or Linux arm64 binary yet. There is no npm channel: the name `logseq-mcp-server` on npm is not this project, so `npx logseq-mcp-server` runs someone else's package and must not be used. To build from a clone instead, run `cd rust && cargo build --release --locked`. Entries below that mention the npm package, `npx` or the TypeScript server are kept as history.

### Added

- **Release workflow and PyPI wheels** (ADR-0035, ADR-0036). A manual `release.yml` builds the three binaries, runs the parity and unit tests against each, writes `SHA256SUMS` and the licence notices, builds the three PyPI wheels from the gated binaries, attests the binaries and the wheels and drafts the GitHub Release. A manual `pypi.yml` checks those wheels again against the public release and uploads them to PyPI by trusted publishing, behind a `pypi` environment that needs the maintainer's approval. Both run only by hand, from `main`, with a dry run by default.

- **`format: "markdown"`** on `get_page`, `get_block`, `build_context`, `get_context_for_query` and `get_concept_network` (#43). The default stays `"json"`. Markdown is one plain text block: page properties, blocks as indented bullets with `((uuid))` refs kept, related pages and references grouped by source page, and a short footer for warnings, `hasMore` and tips. About 45-85% fewer bytes than the JSON. Page properties print as the page stores them (the pre-block text, with its `[[refs]]` and hyphenated keys), and keyword search hits end with `((uuid)) (in [[Page]])` so they can be followed up.
- **`compact`** on `build_context` and `get_context_for_query` (#43): block snippets (first line, 80 characters) and uuids instead of block bodies, in JSON and in Markdown. With `resolve_refs` on `build_context` the refs are not resolved, and a `resolve_refs_ignored_in_compact` warning says so.
- **`logseq_get_page_outline`** (#43): a page's top-level blocks as `{ uuid, snippet, childCount }`, in two Datalog calls. Read the blocks you pick with `get_block`. Resolves aliases, ISO dates and ambiguous names like the other page tools.
- **npm package.** (Superseded: there is no npm package, see the server runtime note above. Do not run `npx logseq-mcp-server`: that name on npm is another project's package, not this one.) As first written: a `logseq-mcp-server` bin (the older `logseq-mcp` name stays), `files`, `engines` (Node 22.12 or newer), `prepublishOnly`, `repository` and `keywords`, plus an MIT `LICENSE` file. A manual `Publish to npm` GitHub workflow publishes with provenance (#46).
- **MCP prompts**: `weekly_summary`, `monthly_summary`, `continue_on`, `what_do_i_know` and `prioritize_tasks`. Each tells the model which tools to call and what limits to keep, and defers to the `logseq-skills` workflow when the host has it (#46).
- **MCP resources**: `logseq://guide` (the reading guide) and the `logseq://page/{name}` template (a page as Markdown text). Both are read-only (#46).
- **Claude Code plugin and marketplace manifests**, with the skills moved to a root `skills/` directory so a plugin can find them. Skills refer to tools by bare name so they work under any host prefix (#45).
- **`logseq_get_current_context`**: what the user has open in LogSeq right now (page, editing block, selected blocks). Read-only but not idempotent (#15).
- **`logseq_list_pages`**: list non-journal pages as `{ name, aliases? }`, optionally filtered by name or alias, to learn the graph's vocabulary.
- **Page name resolution** in every page-taking tool: exact name, alias, ISO date (`2025-01-01`) for a journal, and namespace leaf. An ambiguous name returns its candidates, a missing page returns guidance with the closest names, and `resolvedFrom` says when a name was resolved indirectly (#41).
- **`query_by_date_range` options**: `last_n`, named `preset` ranges (`last_week`, `this_month` and so on) and `include_content`. Results carry a `summary.topConcepts` roll-up of the most-linked pages in the range (#16, #17).
- **`resolve_refs`** on `get_page`, `get_block`, `build_context` and `query_by_date_range`: opt-in `resolvedContent` and `resolvedRefs` for `((uuid))` block refs and `{{embed}}`s, with depth and cycle handling (#18).
- **Truncation reporting.** Any capped result reports `hasMore`, `warnings` (naming the parameter to raise) and `totals`, so a cut is never silent (#40).
- **Guidance for the model.** Server `instructions` in the `initialize` response, "Can't find" lines in every tool description, skippable next-step tips in `meta.tips` (off with `"tips": false` or `LOGSEQ_MCP_TIPS=off`), and best-effort parameter aliases (#44).
- **Read-only tool annotations** on every tool, and tests that guard them.
- **Tool-list guardrails**: a size budget, a per-description length cap and a snapshot of `tools/list`, so growth in what each session pays for shows up in review (#39).
- **Concept network caps** `max_nodes` and `max_fanout`, and an `expand_journals` switch, exposed as tool parameters.
- **`logseq-skills`**: weekly and monthly summary workflows with a word-budget gate, concept linking with a link-safety gate, and research and task workflows.
- **Probe and measure scripts** (`scripts/probe-constraints.ts`, `scripts/measure-api-calls.ts`) for checking LogSeq's Datalog behavior and per-tool API call counts against a live graph.

### Changed (breaking)

- **`logseq_list_pages` nests aliases under their canonical page** (#171). `pages` was `string[]`; it is now `{ name, aliases? }[]`. Consumers that read `pages` as strings must read `.name` instead (`pages.map(p => p.name)`); `aliases` is the page's other names (original casing, sorted) and is absent when it has none. An alias is no longer a top-level entry, so `total` counts canonical pages only. `name_contains` also matches aliases, case-insensitively, and returns the canonical page with its full alias list, so searching an alias still finds its page. Paging is unchanged (filter, sort by canonical name, then `offset` and `limit`), and aliases take no `limit` slots. A page is canonical when it has a file, as in the page resolver: the stub pages LogSeq makes for `alias::` names nest under it, and a name that two pages with files both declare is listed under both. Still one API call. Each entry is about 9 characters longer than a bare name string (the `{"name":""}` wrapper), so a 1000-page listing grows by about 9k characters. The `logseq-skills` concept-linking steps read the new shape.
- **`logseq_get_backlinks` returns source pages most-linking first** (#178). The array used to list source pages in LogSeq's own order (unsorted) on a page without aliases, and by page name on a page with aliases. It now sorts them by the number of blocks that link the target, descending, with ties broken by lowercase page name (plain character order) and then page id, so the order is the same on every run and on both paths. This applies to every result, not only a cut one: a client that took the first entry, or the entry at a position, now gets the page that links most. Match pages by name or id instead of by position. The blocks inside each page keep their order. The cut at `max_pages` (default 20, max 100) takes the top of this ranking, and the `pages_truncated` warning says so and gives the block counts at the cut (`The last page kept has 2 linking blocks, the first dropped page has 1`). The result's shape, the parameters and the number of API calls are unchanged; the ranking uses counts already fetched. `build_context` and `get_context_for_query` are unchanged and keep their own order.

### Changed

- The `query_by_date_range` `blocks_truncated` warning now leads with paging (#187): `howToFetchAll` says to call again with `start_date` set to the day the entries end at (or the day after), the same `end_date` and the same `max_blocks`, instead of suggesting `max_blocks` 1000, which a host may save to a file instead of showing. Where paging can't move, the advice is to read one day alone at that day's block count (when one day fills the cap and fits the maximum), or to raise `max_blocks`: for a cap of 0, and for a last day over the maximum when the cap is below it. Those suggestions say a large result may not be shown. A cut at the maximum keeps `hasMore` true whenever a paged call can reach more. `hasMore` is false, with no `howToFetchAll`, only when the last day holds more than the maximum and the cap is already at it.
- **Cut-list warnings now lead with paging, and say when a raise may not be shown** (#196, after #187). The `logseq_list_pages` `pages_truncated` warning now leads `howToFetchAll` with the next `offset`, then offers raising `limit` as the alternative ("Set offset to 200 for the next page. Or set limit to 1000 (the maximum) to get 1000 of 1500 in one call.", plus the large-result note past 800 pages), and its message says the rest can be paged through with `offset`. `hasMore` is unchanged: it was already true in every cut, including at the maximum. The raise advice in `howToFetchAll` of `build_context` (`max_blocks`, `max_references`), `search_blocks`, `query_by_property`, `search_by_relationship`, `get_concept_evolution`, `get_backlinks` (`max_pages`, `max_blocks_per_page`) and `get_concept_network` (`max_nodes`) is unchanged, but adds "A result this large may be saved to a file by the host instead of shown; the server can't tell." when the suggested value is past an estimate of what comes back inline (200 slim blocks, fewer for `search_blocks` with `include_context` or `slim_results: false`, 150 references, 500 related pages, 200 network nodes, 800 listed pages, or the pages whose blocks add up to 200). Results below a cap, and warnings at or below those estimates, are unchanged.
- `search_by_relationship` with `connected-within` now counts `limit` in blocks of the two pages' trees, nested ones included, in document order (topic A's page first), instead of top-level blocks only (#183). A page whose blocks have many children used to return all of them past the cap; now the result holds at most `limit` blocks (default 50, at most 500) and cuts subtrees at the limit. A kept block that lost children carries `childrenTruncated: true` (additive: the field appears only on a cut), and `totals.blocks` and the `results_truncated` warning count in the same unit. A result at or below the cap is unchanged. The other relationship types still count one per matching block.
- Minimum Node is now 22.12 (`engines.node` is `>=22.12.0`). Node 18 and 20 are past end of life, and 22.12 is the floor of the dev toolchain (vite 7). CI tests on Node 22 and 24.
- `serverInfo.version` in `initialize` is now read from `package.json`. It was a hard-coded `1.0.0` (#46).
- Graph traversal, search and date-range tools run as batched Datalog queries instead of one API call per page. `get_concept_network` at depth 2 went from over a hundred calls to three, `search_blocks` to one, and `query_by_date_range` to two regardless of range length.
- **Slim output is the default** for `search_blocks`, `query_by_date_range` and `query_by_property` (and `get_current_context`). Pass `slim_results: false` to get full output. Slim blocks drop empty fields, and `pageName` is left off children and off blocks inside a date-range entry, which already carries it. The prompts and skills no longer pass `slim_results` (#42).
- `query_by_property` runs as one Datalog query instead of crawling every page.
- `get_page` looks up an exact name first and resolves only when that finds no real page.
- `get_concept_network` is a capped breadth-first search: journal pages are leaves unless `expand_journals` is set, and `truncated` is set whenever a cap bites.
- Strings reach LogSeq as EDN-encoded `:in` inputs rather than being embedded in query text.
- Tool descriptions were rewritten to fit a 400-character cap.
- The `logseq://page/{name}` resource now renders through the shared Markdown renderer and starts with the page's properties (#43).
- Tools are consolidated at 15 (an earlier redundant timeline tool and an incomplete related-pages tool were removed).

### Fixed

- Infrastructure errors (LogSeq down, a bad token, a timeout) are no longer reported as "page not found" or as empty results in `get_page`, `build_context` and `get_context_for_query`. Partial results are returned with `warnings`.
- Page lookups are case-insensitive, and pages with no blocks return an empty page rather than nothing.
- A journal page is no longer matched twice when a block LogSeq created on it carries `:block/journal-day` (the journal queries now require a page name). A scheduled or deadline date does not add it (#140).
- Property names from Datalog are camelCased the same way the Editor API returns them.
- `LOGSEQ_MCP_TIPS` rejects an unrecognised value at startup instead of leaving tips on.
- `build_context` reports a journal page as `temporalContext: { isJournal: true, date }`, with `date` a `YYYYMMDD` number. It read the Editor API's field names from a Datalog pull, so every journal page came back as `{ isJournal: false }` with no date (#152).
- Link-following tools no longer miss references written under another name of the same page. With `alias:: Jordan Rivera` on `Jordan`, asking for either name now covers both: `get_backlinks`, `build_context` (and so `get_context_for_query`), `get_concept_evolution`, `get_concept_network`, `search_by_relationship` and `query_by_date_range` with a `search_term` that names the page. The result says which names it covered in `resolvedAliases` (in `meta` for `get_backlinks`, keyed by topic for `search_by_relationship`), absent for a page with no aliases. In `query_by_date_range` the other names match as whole words or by reference, so a short alias doesn't match inside a word; the term itself still matches anywhere, as before. Costs at most one extra Datalog query, and none for a page without aliases (#69).
- `search_by_relationship` with `connected-within` no longer reports two names of the same page (the same name twice, or a page and its alias) as connected. It returns no results and a `same_topic` warning, without walking the graph (#69).
- An alias shared by three or more names no longer reports the page's other stubs as competing candidates, so asking for any of its names resolves to the page that declares them (#69).
- `get_concept_network` labels each node's `depth` with its true distance from the root over the returned edges. On a capped network a direct neighbour the fanout cap dropped at depth 1 could come back at depth 2 through another page, while its edge to the root was still returned (#155).

### Removed

- The unused `node-fetch` dependency. The client uses the global `fetch`.

[2.0.0]: https://github.com/eborden/logseq-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/eborden/logseq-mcp-server/releases/tag/v1.0.0
