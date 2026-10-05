import { z } from 'zod/v4';
import type { OutputFormat } from './utils/output-format.js';
import { DEFAULT_SLIM_RESULTS } from './utils/slim-entities.js';
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_FANOUT, DEFAULT_MAX_NODES } from './tools/get-concept-network.js';
import { DEFAULT_MAX_DISTANCE, RELATIONSHIP_TYPES } from './tools/search-by-relationship.js';

/**
 * Argument schemas of the tools whose arguments are parsed with zod (#60).
 *
 * Each schema is both the parser (`parseArgs` in `src/utils/parse-args.ts`) and
 * the source of the tool's advertised `inputSchema` (`toInputSchema`), so the two
 * cannot drift. Descriptions and defaults are the advertised ones, word for word:
 * a change here changes tools/list and fails its snapshot.
 *
 * Canonical names only. Aliases (`name`, `page`, `uuid`) are folded in by
 * `resolveParamAliases` before parsing and never appear in a schema.
 */

/** Description of the `format` parameter, shared with the tools not yet converted. */
export const FORMAT_DESCRIPTION =
  'json (default), or markdown text. Markdown has block uuids only on search hits and with compact';

/** Description of the `resolve_refs` parameter (#18), shared with the tools not yet converted. */
export const RESOLVE_REFS_DESCRIPTION =
  'Add resolvedContent/resolvedRefs for ((uuid)) refs and {{embed}}s (depth 2)';

const OUTPUT_FORMAT_VALUES = ['json', 'markdown'] as const satisfies readonly OutputFormat[];

/** `format` (#43): absent means json, as `parseFormat` reads it. No advertised default. */
const formatArg = z.enum(OUTPUT_FORMAT_VALUES).optional().describe(FORMAT_DESCRIPTION);

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

export const getBacklinksArgs = z.object({
  page_name: z.string().describe('Page to get backlinks for (name, alias or ISO date)'),
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
  // No clamp either: a negative limit returns no blocks, as it always did.
  limit: z.number().optional().describe('Maximum number of results to return (optional)'),
  include_context: z.boolean().default(false).describe('Include semantic context (page, references, tags)'),
  slim_results: slimResultsArg,
});

export const queryByPropertyArgs = z.object({
  property_key: z
    .string()
    .describe('Name of the property to query (letters, digits, "-" and "_"; createdAt and created-at are equivalent)'),
  property_value: z
    .string()
    .describe('Value to match for the property. For multi-value properties, matches if any one value equals it'),
  slim_results: slimResultsArg,
});

/**
 * Numbers are plain `z.number()`: NaN and ±Infinity are rejected, but negative and
 * fractional values pass to the handler, which clamps them as it always did
 * (`max_depth` <= 3, `max_nodes` <= 500, `max_fanout` <= 100; the tool floors
 * `max_nodes` and `max_fanout` at 1). `.int()` or `.min()` would also change the
 * advertised schema (`integer`, `minimum`).
 */
export const getConceptNetworkArgs = z.object({
  concept_name: z.string().describe('Root concept (page name, alias or ISO date)'),
  max_depth: z.number().default(DEFAULT_MAX_DEPTH).describe('Maximum depth to traverse (default: 2, max: 3)'),
  max_nodes: z
    .number()
    .default(DEFAULT_MAX_NODES)
    .describe('Maximum pages in the network, root included (default: 50, max: 500)'),
  max_fanout: z
    .number()
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
  // No clamp: a negative distance walks no hops, as it always did
  max_distance: z
    .number()
    .default(DEFAULT_MAX_DISTANCE)
    .describe('Maximum graph distance for connected-within (default: 2)'),
});
