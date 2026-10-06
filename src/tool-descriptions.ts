/**
 * Tool descriptions for MCP clients. Every session pays for these in context, so
 * each one stays within 400 characters (see src/tool-list.test.ts) and has:
 * - what the tool does,
 * - when to use it,
 * - "Can't find": what it will not return, and where to go instead (#44),
 * - alternatives or next steps where they are not obvious.
 * Detail that only matters after a call belongs in parameter descriptions or tool output.
 */

export const TOOL_DESCRIPTIONS = {
  // Discovery Tools (use early in conversation)
  logseq_list_pages: `List non-journal page names, filtered by name_contains (substring, not fuzzy).

**Use when:** unsure which pages exist or what the user calls something.
**Can't find:** journals (logseq_query_by_date_range), block text (logseq_search_blocks), or past 200 names (use offset). Warning pages_unavailable: list unknown, not empty.
**Next:** logseq_get_page.`,

  logseq_get_current_context: `Get what the user is looking at in LogSeq right now: the open page, the block being edited, and any selected blocks.

**Use when:** the user says "this page", "this block" or "what I'm looking at" without naming it. Then pass the page name to logseq_build_context or logseq_get_page.

**Can't find:** anything not open right now. Returns page: null with a message when no page is open.`,

  logseq_get_graph_info: `Get the connected graph's name and filesystem path.

**Use when:** confirming which graph is attached or debugging paths.
**Can't find:** anything about content. See logseq_list_pages and logseq_build_context.`,

  // Content Retrieval Tools (when you know what you want)
  logseq_get_page: `Get a page by name (case-insensitive). With include_children, also its blocks.

**Use when:** you know the page name.
**Can't find:** pages by keyword (logseq_search_blocks, logseq_list_pages) or what links here (logseq_get_backlinks).
**Alternatives:** logseq_build_context adds related pages and references; logseq_get_page_outline for a long page.`,

  logseq_get_page_outline: `List a page's top-level blocks: uuid, the first line (80 characters) and the number of children. Cheaper than logseq_get_page for a long page.

**Use when:** you need a page's shape before reading parts of it. Read the blocks you pick with logseq_get_block.
**Can't find:** nested blocks below the first level, or block text past the first line (logseq_get_block, logseq_get_page).`,

  logseq_get_block: `Get one block by UUID, optionally with its children. UUIDs come from other results and from ((uuid)) refs in content.

**Can't find:** blocks by text (logseq_search_blocks) or by numeric id. For a whole page use logseq_get_page.`,

  logseq_get_backlinks: `List the pages and blocks that link to a page with [[page]] or #tag. Capped by max_pages and max_blocks_per_page: check meta.

**Use when:** "what links to X?" or "where is X used?"
**Can't find:** plain-text mentions with no link (logseq_search_blocks), outbound links (logseq_get_concept_network), or over 100 pages.
**Alternatives:** logseq_build_context for the page plus related pages.`,

  // Search Tools (exploratory, when you don't know exactly what exists)
  logseq_search_blocks: `Case-insensitive literal substring search over block content, newest first, capped by limit (max 500). Check hasMore and warnings.

**Can't find:** synonyms, stems or related words (try variants), blocks by property (logseq_query_by_property), link structure (logseq_search_by_relationship), or over 500 matches in one call (narrow the query).
**Next:** logseq_build_context on a result's page.`,

  logseq_query_by_property: `Find blocks whose property equals a value (e.g. status::done). Capped by limit (max 500): check meta.

**Matching:** key as stored (created-at) or camelCase; values are exact strings ("42", "true"); a multi-value property matches if any one value equals it. Flat list with page name, no children.
**Can't find:** partial values, ranges, or over 500 matches. For text use logseq_search_blocks.`,

  logseq_query_by_date_range: `Query journal entries by start_date + end_date, last_n journals, or a preset (give exactly one), with optional search.

**Use when:** "what did I do last week?" or catching up. summary.topConcepts shows what a period was about.
**Can't find:** non-journal pages, days with no journal, or blocks past 200 (max_blocks, max 1000).
**Alternatives:** logseq_get_concept_evolution, logseq_search_blocks.`,

  // Context Building Tools (comprehensive exploration)
  logseq_build_context: `Everything on one topic in a call: the page's blocks, related pages, and linked references.

**Use when:** researching or explaining a topic that has a page.
**Can't find:** topics with no page (use logseq_search_blocks), or anything past the caps (see hasMore and warnings).
**Alternatives:** logseq_get_page (content only), logseq_get_concept_network (structure only).`,

  logseq_get_context_for_query: `Context for a natural-language question. Takes [[page]] and #tag topics from the query, else searches its first 3 words over 3 letters (max 100 hits), and builds context for each.

**Can't find:** meaning, or over 100 keyword hits (put specific words first). Topics come from links, tags or literal words, so put page names in [[brackets]].
**Alternatives:** logseq_build_context for one known topic.`,

  logseq_get_concept_network: `Map pages linked to a concept as nodes and edges, in both link directions, up to max_depth hops. One edge per page pair, with a reference count.

**Caps:** 50 pages, 15 new per page; journal pages are shown but not expanded. If truncated is true, raise max_nodes/max_fanout or set expand_journals.
**Can't find:** unlinked pages, or what pages say (logseq_build_context).`,

  // Relationship Tools (complex, specific relationship patterns)
  logseq_search_by_relationship: `Find blocks tied to topic A by a link to topic B: references, referenced-by, in-pages-linking-to, or connected-within N hops. Both topics must be pages.

**Can't find:** relationships that exist only as plain text. Matching is on [[links]] and #tags, not words.
**Alternatives:** logseq_search_blocks (keywords), logseq_get_concept_network (overview).`,

  // Temporal Tools (time-based analysis)
  logseq_get_concept_evolution: `Track a concept over time: blocks on its page and blocks linking to it, grouped by day, week or month, with optional date bounds.

**Use when:** "how has X evolved?" or "what's the history of Y?"
**Can't find:** unlinked plain-text mentions (logseq_search_blocks), topics with no page, or dated mentions past 500 (narrow dates).
**Alternatives:** logseq_query_by_date_range for plain journal queries.`,

  // Editing gates (check a change before it is reported done)
  logseq_check_links: `Check a [[link]] pass. ok is true only if after strips back to before, brackets balance and don't nest, every ref in before is kept, and each [[term]] names exactly one page or alias.

**Can't find:** a link to the wrong page, or a name split across a ref.`,
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
