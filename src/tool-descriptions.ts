/**
 * Enhanced tool descriptions for MCP best practices.
 * Each description includes:
 * - What the tool does
 * - When to use it (3-5 bullet points)
 * - Alternatives (2-3 related tools)
 */

export const TOOL_DESCRIPTIONS = {
  // Discovery Tools (use early in conversation)
  logseq_list_pages: `List all pages in the LogSeq graph to discover available topics and vocabulary.

**When to use:**
- At the start of a conversation to understand what concepts exist in the user's knowledge graph
- Before searching for content when you're unsure what pages are available
- To discover the naming conventions and vocabulary used in the graph
- When the user asks "what do you have information about?"

**Alternatives:**
- Use logseq_get_graph_info to get high-level graph metadata (path, name)
- Use logseq_search_blocks if you know specific keywords to search for
- Use logseq_get_page if you already know the exact page name`,

  logseq_get_graph_info: `Get information about the current LogSeq graph including filesystem path and name.

**When to use:**
- To understand the graph's location on disk
- When debugging path-related issues
- To provide context about which knowledge base is being accessed

**Alternatives:**
- Use logseq_list_pages to see what content exists in the graph
- Use logseq_build_context for comprehensive topic exploration`,

  // Content Retrieval Tools (when you know what you want)
  logseq_get_page: `Get a specific LogSeq page by name with optional child blocks.

**When to use:**
- When you know the exact page name and want its full content
- To retrieve a page and its immediate child blocks/pages
- After discovering page names via logseq_list_pages
- When the user references a specific page by name

**Alternatives:**
- Use logseq_search_blocks if you only know keywords, not the exact page name
- Use logseq_build_context for comprehensive topic exploration with related pages
- Use logseq_list_pages first if you're unsure what pages exist`,

  logseq_get_block: `Get a specific LogSeq block by UUID with optional child blocks.

**When to use:**
- When you have a block UUID from a previous query result
- To retrieve a specific block and its nested children
- When working with block-level granularity (not page-level)

**Alternatives:**
- Use logseq_get_page to retrieve an entire page instead of a single block
- Use logseq_search_blocks to find blocks by content when you don't have the UUID`,

  logseq_get_backlinks: `Get all pages and blocks that link to a specific page.

**When to use:**
- To find what content references a particular page
- To understand how a concept is used across the knowledge graph
- To discover related topics that explicitly mention the target page
- When the user asks "what links to this page?" or "where is this mentioned?"

**Alternatives:**
- Use logseq_get_concept_network for a visual network of relationships (both inbound and outbound)
- Use logseq_search_blocks to find content mentioning keywords (not just page links)
- Use logseq_build_context for comprehensive related pages (not just backlinks)`,

  // Search Tools (exploratory, when you don't know exactly what exists)
  logseq_search_blocks: `Search for blocks containing specific text across your LogSeq graph.

**When to use:**
- Finding content by keyword when you don't know which page it's on
- Discovering all mentions of a topic across pages
- Exploratory search before using more specific tools
- When the user asks "find all blocks about X"

**Alternatives:**
- Use logseq_list_pages first to discover what pages exist
- Use logseq_get_page if you know the exact page name
- Use logseq_build_context for comprehensive topic exploration with relationships
- Use logseq_query_by_property for structured property-based queries`,

  logseq_query_by_property: `Query blocks by a specific property name and value.

**When to use:**
- When searching for structured metadata (custom properties)
- To find blocks tagged with specific property values (e.g., status::done, type::project)
- When the user references custom properties in their query
- For precise property-based filtering

**Alternatives:**
- Use logseq_search_blocks for full-text content search (not property-based)
- Use logseq_query_by_date_range for temporal queries on journal entries`,

  logseq_query_by_date_range: `Query journal entries within a date range with optional search filter.

**When to use:**
- Searching journal entries by date (e.g., "what did I do last week?")
- Finding time-bound information in daily logs
- Temporal analysis of concepts over specific periods
- When the user mentions dates or time ranges

**Alternatives:**
- Use logseq_get_concept_evolution to track how a concept changes over time (includes analysis)
- Use logseq_search_blocks for non-temporal content search
- Use logseq_build_context with includeTemporalContext for journal page context`,

  // Context Building Tools (comprehensive exploration)
  logseq_build_context: `Build comprehensive context for a topic including related pages, blocks, and references.

**When to use:**
- Deep dive on a specific topic with full context
- When you need both the page content AND related pages
- To understand a concept holistically (direct content + connections)
- Before answering complex questions about a topic
- When the user asks to "research" or "explain" a topic

**Alternatives:**
- Use logseq_get_page for just the page content (no related pages)
- Use logseq_get_concept_network for visual network structure (less detailed content)
- Use logseq_get_context_for_query for natural language query interpretation`,

  logseq_get_context_for_query: `Get comprehensive context for a natural language query by extracting topics and gathering related information.

**When to use:**
- When the user asks a complex, multi-topic question
- To automatically identify relevant topics from natural language
- When queries include [[page references]] and #tags
- As a smart wrapper around multiple build_context calls

**Alternatives:**
- Use logseq_build_context if you already know the specific topic to explore
- Use logseq_search_blocks for simple keyword search without topic extraction
- Use logseq_list_pages + logseq_get_page for manual topic selection`,

  logseq_get_concept_network: `Get network of pages related to a concept with nodes and edges for visualization.

**When to use:**
- To visualize how pages are connected in the knowledge graph
- Understanding the relationship structure around a concept
- Finding connected pages up to N hops away
- When the user asks "show me how X relates to other topics"

**Alternatives:**
- Use logseq_build_context for detailed content with related pages (less structural)
- Use logseq_get_backlinks for simpler inbound link queries (no network structure)
- Use logseq_search_by_relationship for specific relationship patterns`,

  // Relationship Tools (complex, specific relationship patterns)
  logseq_search_by_relationship: `Search for blocks based on specific relationship patterns between topics.

**When to use:**
- Finding blocks about topic A that reference topic B (complex relationships)
- When you need precise control over relationship types (references, referenced-by, etc.)
- For advanced graph queries with specific relationship semantics
- When simpler tools like search_blocks are too broad

**Alternatives:**
- Use logseq_search_blocks for simple keyword search without relationship constraints
- Use logseq_get_concept_network for general relationship exploration (less precise)
- Use logseq_build_context for comprehensive topic context (automatic relationships)`,

  // Temporal Tools (time-based analysis)
  logseq_get_concept_evolution: `Track how a concept evolves over time through journal entries with temporal analysis.

**When to use:**
- Understanding how a concept changed over time (trend analysis)
- When the user asks "how has X evolved?" or "what's the history of Y?"
- Temporal analysis with grouping by day/week/month
- Discovering patterns in how concepts are discussed over time

**Alternatives:**
- Use logseq_query_by_date_range for simple date-based journal queries (no evolution analysis)
- Use logseq_build_context with includeTemporalContext for journal page context (no evolution tracking)
- Use logseq_search_blocks if you don't need temporal grouping`,
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
