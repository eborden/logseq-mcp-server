# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been published to npm yet, so there is no released version to compare against. `package.json` says 1.0.0; everything below ships in the first release. When the maintainer cuts it, rename "Unreleased" to that version and date.

## [Unreleased]

### Added

- **`format: "markdown"`** on `get_page`, `get_block`, `build_context`, `get_context_for_query` and `get_concept_network` (#43). The default stays `"json"`. Markdown is one plain text block: page properties, blocks as indented bullets with `((uuid))` refs kept, related pages and references grouped by source page, and a short footer for warnings, `hasMore` and tips. About 45-85% fewer bytes than the JSON. Page properties print as the page stores them (the pre-block text, with its `[[refs]]` and hyphenated keys), and keyword search hits end with `((uuid)) (in [[Page]])` so they can be followed up.
- **`compact`** on `build_context` and `get_context_for_query` (#43): block snippets (first line, 80 characters) and uuids instead of block bodies, in JSON and in Markdown. With `resolve_refs` on `build_context` the refs are not resolved, and a `resolve_refs_ignored_in_compact` warning says so.
- **`logseq_get_page_outline`** (#43): a page's top-level blocks as `{ uuid, snippet, childCount }`, in two Datalog calls. Read the blocks you pick with `get_block`. Resolves aliases, ISO dates and ambiguous names like the other page tools.
- **npm package.** `npx -y logseq-mcp-server` works: a `logseq-mcp-server` bin (the older `logseq-mcp` name stays), `files`, `engines` (Node 22.12 or newer), `prepublishOnly`, `repository` and `keywords`, plus an MIT `LICENSE` file. A manual `Publish to npm` GitHub workflow publishes with provenance (#46).
- **MCP prompts**: `weekly_summary`, `monthly_summary`, `continue_on`, `what_do_i_know` and `prioritize_tasks`. Each tells the model which tools to call and what limits to keep, and defers to the `logseq-skills` workflow when the host has it (#46).
- **MCP resources**: `logseq://guide` (the reading guide) and the `logseq://page/{name}` template (a page as Markdown text). Both are read-only (#46).
- **Claude Code plugin and marketplace manifests**, with the skills moved to a root `skills/` directory so a plugin can find them. Skills refer to tools by bare name so they work under any host prefix (#45).
- **`logseq_get_current_context`**: what the user has open in LogSeq right now (page, editing block, selected blocks). Read-only but not idempotent (#15).
- **`logseq_list_pages`**: list non-journal page names, optionally filtered, to learn the graph's vocabulary.
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

### Changed

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
- Link-following tools no longer miss references written under another name of the same page. With `alias:: Jordan Rivera` on `Jordan`, asking for either name now covers both: `get_backlinks`, `build_context` (and so `get_context_for_query`), `get_concept_evolution`, `get_concept_network`, `search_by_relationship` and `query_by_date_range` with a `search_term` that names the page. The result says which names it covered in `resolvedAliases` (in `meta` for `get_backlinks`, keyed by topic for `search_by_relationship`), absent for a page with no aliases. In `query_by_date_range` the other names match as whole words or by reference, so a short alias doesn't match inside a word; the term itself still matches anywhere, as before. Costs at most one extra Datalog query, and none for a page without aliases (#69).
- `search_by_relationship` with `connected-within` no longer reports two names of the same page (the same name twice, or a page and its alias) as connected. It returns no results and a `same_topic` warning, without walking the graph (#69).
- An alias shared by three or more names no longer reports the page's other stubs as competing candidates, so asking for any of its names resolves to the page that declares them (#69).
- `get_concept_network` labels each node's `depth` with its true distance from the root over the returned edges. On a capped network a direct neighbour the fanout cap dropped at depth 1 could come back at depth 2 through another page, while its edge to the root was still returned (#155).

### Removed

- The unused `node-fetch` dependency. The client uses the global `fetch`.

[Unreleased]: https://github.com/eborden/logseq-mcp-server/commits/main
