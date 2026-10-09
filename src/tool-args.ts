import { z } from 'zod/v4';
import type { OutputFormat } from './utils/output-format.js';
import { DEFAULT_SLIM_RESULTS } from './utils/slim-entities.js';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_FANOUT, DEFAULT_MAX_NODES } from './tools/get-concept-network.js';
import {
  DEFAULT_MAX_DISTANCE,
  DEFAULT_RELATIONSHIP_LIMIT,
  MAX_RELATIONSHIP_LIMIT,
  RELATIONSHIP_TYPES,
} from './tools/search-by-relationship.js';
import { DEFAULT_MAX_SEARCH_RESULTS, DEFAULT_MAX_TOPICS, MAX_SEARCH_RESULTS } from './tools/get-context-for-query.js';
import { DATE_PRESETS } from './utils/date-presets.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from './tools/search-blocks.js';
import { DEFAULT_LIST_PAGES_LIMIT, DEFAULT_LIST_PAGES_OFFSET, MAX_LIST_PAGES_LIMIT } from './tools/list-pages.js';
import {
  DEFAULT_INCLUDE_TEMPORAL_CONTEXT,
  DEFAULT_MAX_BLOCKS,
  DEFAULT_MAX_REFERENCES,
  DEFAULT_MAX_RELATED_PAGES,
} from './tools/build-context.js';
import { DEFAULT_MAX_ENTRIES, GROUP_BY_PERIODS, MAX_ENTRIES } from './tools/get-concept-evolution.js';
import {
  DEFAULT_MAX_BLOCKS_PER_PAGE,
  DEFAULT_MAX_PAGES,
  MAX_BLOCKS_PER_PAGE,
  MAX_PAGES,
} from './tools/get-backlinks.js';
import { DEFAULT_PROPERTY_LIMIT, MAX_PROPERTY_LIMIT } from './tools/query-by-property.js';
import { DEFAULT_TOP_CONCEPTS_LIMIT } from './utils/top-concepts.js';
import { DEFAULT_DATE_RANGE_MAX_BLOCKS, MAX_DATE_RANGE_BLOCKS } from './tools/query-by-date-range.js';
import { MAX_LINK_TERMS, MAX_TEXT_CHARS } from './tools/check-links.js';

/**
 * Argument schemas of every tool, parsed with zod (#60).
 *
 * Each schema is both the parser (`parseArgs` in `src/utils/parse-args.ts`) and
 * the source of the tool's advertised `inputSchema` (`toInputSchema`), so the two
 * cannot drift. Descriptions and defaults are the advertised ones, word for word:
 * a change here changes tools/list and fails its snapshot.
 *
 * Canonical names only. Aliases (`name`, `page`, `uuid`) are folded in by
 * `resolveParamAliases` before parsing and never appear in a schema.
 */

/** Description of the `format` parameter (#43). */
const FORMAT_DESCRIPTION =
  'json (default), or markdown text. Markdown has block uuids only on search hits and with compact';

/** Description of the `resolve_refs` parameter (#18). */
const RESOLVE_REFS_DESCRIPTION =
  'Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)';

const OUTPUT_FORMAT_VALUES = ['json', 'markdown'] as const satisfies readonly OutputFormat[];

/** `format` (#43): absent means json. No advertised default. */
const formatArg = z.enum(OUTPUT_FORMAT_VALUES).optional().describe(FORMAT_DESCRIPTION);

/** Description of the `compact` parameter (#43). */
const COMPACT_DESCRIPTION = 'Block snippets and uuids, no bodies. Read one with logseq_get_block';

/** `compact` (#43): default false. */
const compactArg = z.boolean().default(false).describe(COMPACT_DESCRIPTION);

/** `resolve_refs` (#18): opt-in, default false. */
const resolveRefsArg = z.boolean().default(false).describe(RESOLVE_REFS_DESCRIPTION);

/**
 * `slim_results` (#42): slim unless the caller sends `false`. The tool functions
 * default to full output for direct callers, so the MCP default lives here.
 */
const slimResultsArg = z
  .boolean()
  .default(DEFAULT_SLIM_RESULTS)
  .describe('Slim blocks (default). false returns full entities');

export const getPageArgs = z.object({
  page_name: z.string().describe('Page name, alias, or ISO date (2025-01-01) for a journal'),
  include_children: z.boolean().default(false).describe('Whether to include child blocks/pages'),
  resolve_refs: resolveRefsArg,
  format: formatArg,
});

export const getPageOutlineArgs = z.object({
  page_name: z.string().describe('Page name, alias, or ISO date (2025-01-01) for a journal'),
});

/**
 * Every count, limit, offset and depth parameter below is an integer with a minimum
 * (#293): 0 where 0 means something (no blocks, only the totals, the root alone, no
 * hops), 1 where it doesn't (`last_n`, `max_nodes`, `max_fanout`, `max_topics`). A fraction or a
 * smaller value is rejected by `parseArgs`. None has a schema maximum: the tools clamp a
 * larger value, and say so, as they always did (#61).
 *
 * `max_pages` and `max_blocks_per_page` (#61): the tool clamps them to 100 and 50.
 */
export const getBacklinksArgs = z.object({
  page_name: z.string().describe('Page to get backlinks for (name, alias or ISO date)'),
  max_pages: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_PAGES)
    .describe(`Max source pages (default: ${DEFAULT_MAX_PAGES}, max: ${MAX_PAGES})`),
  max_blocks_per_page: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_BLOCKS_PER_PAGE)
    .describe(`Max linking blocks per source page (default: ${DEFAULT_MAX_BLOCKS_PER_PAGE}, max: ${MAX_BLOCKS_PER_PAGE})`),
});

export const getBlockArgs = z.object({
  block_uuid: z.string().describe('UUID of the block to retrieve'),
  include_children: z.boolean().default(false).describe('Whether to include child blocks'),
  resolve_refs: resolveRefsArg,
  format: formatArg,
});

export const searchBlocksArgs = z.object({
  query: z.string().describe('Text to search for in block content'),
  // No advertised default: absent reaches the tool as undefined, and the tool uses 100.
  // The tool clamps it to 500 and reports a cut there (#61). 0 returns no blocks, with the totals.
  limit: z
    .int()
    .min(0)
    .optional()
    .describe(`Maximum number of results to return (default: ${DEFAULT_SEARCH_LIMIT}, max: ${MAX_SEARCH_LIMIT})`),
  include_context: z.boolean().default(false).describe('Include semantic context (page, references, tags)'),
  slim_results: slimResultsArg,
});

export const queryByPropertyArgs = z.object({
  property_key: z
    .string()
    .describe('Name of the property to query (letters, digits, "-" and "_"; createdAt and created-at are equivalent)'),
  // A number or boolean is matched as text, `String(value)` in the query builder, as it
  // always was: `3` and `"3"` find the same blocks. Declared so the schema says so.
  property_value: z
    .union([z.string(), z.number(), z.boolean()])
    .describe('Value to match for the property. For multi-value properties, matches if any one value equals it'),
  // The tool clamps it to 500 and reports the cut (#61)
  limit: z
    .int()
    .min(0)
    .default(DEFAULT_PROPERTY_LIMIT)
    .describe(`Max blocks to return (default: ${DEFAULT_PROPERTY_LIMIT}, max: ${MAX_PROPERTY_LIMIT})`),
  slim_results: slimResultsArg,
});

/**
 * The handler clamps `max_depth` to 3, `max_nodes` to 500 and `max_fanout` to 100. The
 * minimum of 1 is the floor the tool always applied to `max_nodes` and `max_fanout`.
 * A `max_depth` of 0 returns the root alone, as it always did (#293).
 */
export const getConceptNetworkArgs = z.object({
  concept_name: z.string().describe('Root concept (page name, alias or ISO date)'),
  max_depth: z.int().min(0).default(DEFAULT_MAX_DEPTH).describe('Maximum depth to traverse (default: 2, max: 3)'),
  max_nodes: z
    .int()
    .min(1)
    .default(DEFAULT_MAX_NODES)
    .describe('Maximum pages in the network, root included (default: 50, max: 500)'),
  max_fanout: z
    .int()
    .min(1)
    .default(DEFAULT_MAX_FANOUT)
    .describe('Maximum new pages any one page may add (default: 15, max: 100)'),
  expand_journals: z
    .boolean()
    .default(false)
    .describe(
      'Expand through journal pages instead of treating them as leaves (default: false). Journal pages link to almost everything, so this can flood the network.'
    ),
  format: formatArg,
});

export const searchByRelationshipArgs = z.object({
  topic_a: z.string().describe('Primary topic to search for (page name, alias or ISO date)'),
  topic_b: z.string().describe('Related topic that defines the relationship (page name, alias or ISO date)'),
  relationship_type: z
    .enum(RELATIONSHIP_TYPES)
    .describe(
      'Type of relationship: references (blocks about A that reference B), referenced-by (blocks about A in pages referenced by B), in-pages-linking-to (blocks about A in pages linking to B), connected-within (topics connected within N hops)'
    ),
  // No clamp. 0 walks no hops and finds no connection, as it always did (#293)
  max_distance: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_DISTANCE)
    .describe('Maximum graph distance for connected-within (default: 2)'),
  // The tool clamps it to 500 and reports the cut (#61)
  limit: z
    .int()
    .min(0)
    .default(DEFAULT_RELATIONSHIP_LIMIT)
    .describe(
      `Max results (default: ${DEFAULT_RELATIONSHIP_LIMIT}, max: ${MAX_RELATIONSHIP_LIMIT}). connected-within counts every block of both pages, nested ones too, topic A's first; a block that lost children has childrenTruncated`
    ),
});

export const getContextForQueryArgs = z.object({
  query: z.string().describe('Natural language query (can include [[page references]] and #tags)'),
  // The tool slices with max_topics (0 used to keep no topic at all, #293), and clamps
  // max_search_results to 100, reporting a cut there (#61).
  max_topics: z
    .int()
    .min(1)
    .default(DEFAULT_MAX_TOPICS)
    .describe('Maximum number of topics to extract context for (default: 5)'),
  max_search_results: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_SEARCH_RESULTS)
    .describe(
      `Maximum number of search results for queries without explicit topics (default: ${DEFAULT_MAX_SEARCH_RESULTS}, max: ${MAX_SEARCH_RESULTS})`
    ),
  format: formatArg,
  compact: compactArg,
});

/**
 * No clamps: the tool slices with the three caps, so 0 keeps none of that kind (a
 * negative cap, which used to cut from the end, is rejected, #293).
 * `resolve_refs` is skipped under `compact`, with a warning, by the handler.
 */
export const buildContextArgs = z.object({
  topic_name: z.string().describe('Topic to build context for (page name, alias or ISO date)'),
  max_blocks: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_BLOCKS)
    .describe('Maximum number of blocks to include (default: 50)'),
  max_related_pages: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_RELATED_PAGES)
    .describe('Maximum number of related pages to include (default: 10)'),
  max_references: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_REFERENCES)
    .describe('Maximum number of reference blocks to include (default: 20)'),
  include_temporal_context: z
    .boolean()
    .default(DEFAULT_INCLUDE_TEMPORAL_CONTEXT)
    .describe('Include temporal context for journal pages (default: true)'),
  resolve_refs: resolveRefsArg,
  format: formatArg,
  compact: compactArg,
});

/**
 * Types and the counts' minimums are checked here. Which selection was given (exactly
 * one of start_date + end_date, last_n or preset) and the YYYYMMDD format are checked
 * by `queryJournals`, which also repeats last_n >= 1 and a whole top_concepts_limit >= 0
 * for direct callers. `max_blocks` (#61): the tool clamps it to 1000. Dates stay plain
 * numbers: they are checked as YYYYMMDD, not counted.
 */
export const queryByDateRangeArgs = z.object({
  start_date: z.number().optional().describe('Start date in YYYYMMDD format (e.g., 20251115). Needs end_date'),
  end_date: z.number().optional().describe('End date in YYYYMMDD format (e.g., 20251120). Needs start_date'),
  last_n: z.int().min(1).optional().describe('The N most recent journals that exist (whole number, 1+), newest first'),
  preset: z.enum(DATE_PRESETS).optional().describe('Named period in local time; weeks run Monday to Sunday'),
  search_term: z.string().optional().describe('Optional search term to filter blocks'),
  slim_results: slimResultsArg,
  include_content: z
    .boolean()
    .default(true)
    .describe('false returns only per-day block counts and top-level snippets'),
  top_concepts_limit: z
    .int()
    .min(0)
    .default(DEFAULT_TOP_CONCEPTS_LIMIT)
    .describe('Entries in summary.topConcepts, the most-linked pages (default 10). 0 omits it'),
  resolve_refs: resolveRefsArg,
  max_blocks: z
    .int()
    .min(0)
    .default(DEFAULT_DATE_RANGE_MAX_BLOCKS)
    .describe(
      `Max blocks across all days, nested ones counted (top-level with include_content false), default ${DEFAULT_DATE_RANGE_MAX_BLOCKS}, max ${MAX_DATE_RANGE_BLOCKS}`
    ),
});

/**
 * The tool does no range checks on the dates: 0 or an absent date is no bound, and
 * any other number is compared with each block's YYYYMMDD day. `max_entries` (#61):
 * the tool clamps it to 500.
 */
export const getConceptEvolutionArgs = z.object({
  concept_name: z.string().describe('Concept to track (page name, alias or ISO date)'),
  start_date: z.number().optional().describe('Optional start date in YYYYMMDD format'),
  end_date: z.number().optional().describe('Optional end date in YYYYMMDD format'),
  group_by: z.enum(GROUP_BY_PERIODS).optional().describe('Optional grouping period'),
  max_entries: z
    .int()
    .min(0)
    .default(DEFAULT_MAX_ENTRIES)
    .describe(`Max mentions, oldest first (default: ${DEFAULT_MAX_ENTRIES}, max: ${MAX_ENTRIES})`),
});

/**
 * An empty `name_contains` is no filter, as the tool always read it. `limit` and
 * `offset` (#61): the tool clamps `limit` to 1000; a `limit` of 0 returns only the total.
 */
export const listPagesArgs = z.object({
  name_contains: z.string().optional().describe('Filter pages whose name or alias contains this text (case-insensitive)'),
  limit: z
    .int()
    .min(0)
    .default(DEFAULT_LIST_PAGES_LIMIT)
    .describe(`Max pages (default: ${DEFAULT_LIST_PAGES_LIMIT}, max: ${MAX_LIST_PAGES_LIMIT})`),
  offset: z
    .int()
    .min(0)
    .default(DEFAULT_LIST_PAGES_OFFSET)
    .describe('Pages to skip, in name order; shifts if the graph changes'),
});

/**
 * No parameters. Parsed anyway, so these handlers read no raw arguments either and
 * their inputSchema comes from a schema like every other tool's. Any field is ignored.
 */
export const getGraphInfoArgs = z.object({});
export const getCurrentContextArgs = z.object({});

/**
 * Both texts are required and capped at MAX_TEXT_CHARS (50,000 characters, about
 * 12k tokens each), so the input stays bounded (ADR-0011). An empty string is a
 * text, not a missing one. The cap on distinct terms (MAX_LINK_TERMS) is checked
 * by `checkLinks`, before any LogSeq call.
 *
 * Units: zod's `.max` counts UTF-16 code units (`string.length`), while the
 * advertised JSON Schema `maxLength` counts code points. Text outside the Basic
 * Multilingual Plane (emoji) takes two units per character, so about 25,000 emoji
 * pass a validating client and are then rejected here, with a clear error and no
 * LogSeq call. Deliberate: the cap bounds memory, which UTF-16 units measure. A
 * test at the cap must use one-unit characters (pinned in index.check-links.test.ts).
 */
export const checkLinksArgs = z.object({
  before: z.string().max(MAX_TEXT_CHARS).describe('Text before linking'),
  after: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe(`before plus [[links]], at most ${MAX_LINK_TERMS} distinct terms`),
});
