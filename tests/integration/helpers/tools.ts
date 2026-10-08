import { afterAll } from 'vitest';
import type { LogseqClient } from '../../../src/client.js';
import {
  AmbiguousPageError,
  BlockNotFoundError,
  InvalidParameterError,
  PageNotFoundError,
} from '../../../src/errors.js';
import { buildContextForTopic as tsBuildContextForTopic } from '../../../src/tools/build-context.js';
import { checkLinks as tsCheckLinks } from '../../../src/tools/check-links.js';
import {
  getBacklinks as tsGetBacklinks,
  getBacklinksWithMeta as tsGetBacklinksWithMeta,
} from '../../../src/tools/get-backlinks.js';
import { getBlock as tsGetBlock } from '../../../src/tools/get-block.js';
import { getConceptEvolution as tsGetConceptEvolution } from '../../../src/tools/get-concept-evolution.js';
import {
  getConceptNetwork as tsGetConceptNetwork,
  MAX_FANOUT_LIMIT,
  MAX_NODES_LIMIT,
} from '../../../src/tools/get-concept-network.js';
import { getContextForQuery as tsGetContextForQuery } from '../../../src/tools/get-context-for-query.js';
import { getCurrentContext as tsGetCurrentContext } from '../../../src/tools/get-current-context.js';
import { getGraphInfo as tsGetGraphInfo } from '../../../src/tools/get-graph-info.js';
import { getPage as tsGetPage } from '../../../src/tools/get-page.js';
import { listPages as tsListPages } from '../../../src/tools/list-pages.js';
import { queryByDateRange as tsQueryByDateRange, queryJournals as tsQueryJournals } from '../../../src/tools/query-by-date-range.js';
import {
  queryByProperty as tsQueryByProperty,
  queryByPropertyWithMeta as tsQueryByPropertyWithMeta,
} from '../../../src/tools/query-by-property.js';
import {
  MAX_SEARCH_LIMIT,
  searchBlocks as tsSearchBlocks,
  searchBlocksWithMeta as tsSearchBlocksWithMeta,
} from '../../../src/tools/search-blocks.js';
import { searchByRelationship as tsSearchByRelationship } from '../../../src/tools/search-by-relationship.js';
import { closeSessions, isRust, rustSession } from './server-under-test.js';

/**
 * The tool functions the integration suites call (#352), with the signatures and results of the
 * ones in `src/tools/`. With the TypeScript server (the default) each one is the function itself.
 * With `LOGSEQ_MCP_SERVER=rust` each one calls the same tool through MCP on the Rust server and
 * returns what the TypeScript function would have: the first content block as JSON, with the
 * `meta` block of a bare-array tool read back as the second part. An error result becomes a thrown
 * error of the class the TypeScript function throws (the message is the server's own), and the
 * ambiguous-name result becomes an `AmbiguousPageError`.
 *
 * Each function maps its positional arguments to the tool's, and sends the default a direct call
 * has where the tool's default differs (`slim_results` is false for a direct call, true for the
 * tool: BR-0012). The `client` is only the route to LogSeq: see `server-under-test.ts`.
 *
 * What the Rust server cannot take through MCP stays on TypeScript in both modes: a limit that
 * only a direct call can lower (`searchBlocksWithMeta` with a `maxLimit`) or lift
 * (`getConceptNetwork` past the tool's `max_nodes` and `max_fanout`), and `maxFrontier` and
 * `hitPages`. `src/tools/*` internals such as the resolver have no tool, so a suite that tests them
 * runs them as before.
 */

afterAll(closeSessions);

type Json = any;

/** The tool's first content block as JSON, and its `meta` block when it sends one. */
interface ToolOutput {
  value: Json;
  meta: Json;
}

/** The tool's arguments: the ones given. A number JSON can't carry (`Infinity`) would arrive as null, so it is an error here. */
const compact = <T extends Record<string, unknown>>(args: T): Record<string, unknown> => {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${key} is ${value}, which a tool argument can't be; keep the direct call on TypeScript (see this file's header).`);
    }
  }
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
};

/** The error a TypeScript function throws for a tool's error message, with the message the server sent. */
function errorFor(message: string): Error {
  const make = <E extends Error>(prototype: object, extra: Record<string, unknown> = {}): E => {
    const error = new Error(message);
    Object.setPrototypeOf(error, prototype);
    error.name = (prototype as { constructor: { name: string } }).constructor.name;
    return Object.assign(error, extra) as E;
  };
  if (message.startsWith('No page "')) {
    const closest = message.match(/^No page ".*?"\. Closest: (.*)\. Try logseq_search_blocks/s)?.[1];
    return make(PageNotFoundError.prototype, { suggestions: closest ? closest.split(', ') : [] });
  }
  if (message.startsWith('Block not found: ')) return make(BlockNotFoundError.prototype);
  if (message.startsWith("Invalid parameter '")) return make(InvalidParameterError.prototype);
  return new Error(message);
}

async function callTool(
  client: LogseqClient,
  name: string,
  args: Record<string, unknown>,
  now?: Date
): Promise<ToolOutput> {
  const mcp = await rustSession(client, { tips: false, now });
  const result = (await mcp.callTool({ name, arguments: compact(args) }, undefined, { timeout: 170_000 })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const first = result.content[0]?.text ?? '';
  if (result.isError) throw errorFor((JSON.parse(first) as { error: string }).error);
  const value = JSON.parse(first) as Json;
  if (value && value.ambiguous === true && Array.isArray(value.candidates)) {
    throw new AmbiguousPageError(value.pageName, value.candidates, value.totalCandidates);
  }
  const second = result.content[1]?.text;
  return { value, meta: second === undefined ? null : (JSON.parse(second) as { meta: Json }).meta };
}

/** A function that is the TypeScript one, or in Rust mode the one given. */
function either<F extends (...args: any[]) => Promise<any>>(ts: F, rust: (...args: Parameters<F>) => Promise<unknown>): F {
  return ((...args: Parameters<F>) => (isRust() ? rust(...args) : ts(...args))) as F;
}

export const getPage = either(tsGetPage, async (client, pageName, includeChildren, options) =>
  (await callTool(client, 'logseq_get_page', {
    page_name: pageName,
    include_children: includeChildren,
    resolve_refs: options?.resolveRefs,
  })).value
);

export const getBacklinksWithMeta = either(tsGetBacklinksWithMeta, async (client, pageName, caps) => {
  const { value, meta } = await callTool(client, 'logseq_get_backlinks', {
    page_name: pageName,
    max_pages: caps?.maxPages,
    max_blocks_per_page: caps?.maxBlocksPerPage,
  });
  return { results: value, meta };
});

export const getBacklinks = either(tsGetBacklinks, async (client, pageName, caps) =>
  (await getBacklinksWithMeta(client, pageName, caps)).results
);

export const getBlock = either(tsGetBlock, async (client, blockUuid, includeChildren, options) =>
  (await callTool(client, 'logseq_get_block', {
    block_uuid: blockUuid,
    include_children: includeChildren,
    resolve_refs: options?.resolveRefs,
  })).value
);

// A direct call defaults to full results, the tool to slim (BR-0012), so each call says which
const searchBlocksOverMcp = async (
  client: LogseqClient,
  query: string,
  limit?: number,
  includeContext?: boolean,
  slimResults?: boolean
): Promise<ToolOutput> =>
  callTool(client, 'logseq_search_blocks', {
    query,
    limit,
    include_context: includeContext ?? false,
    slim_results: slimResults ?? false,
  });

export const searchBlocksWithMeta = ((
  client: LogseqClient,
  query: string,
  limit?: number,
  includeContext?: boolean,
  slimResults?: boolean,
  maxLimit?: number
) => {
  // The tool's maximum is fixed; only a direct call can lower it (the cut at the maximum, result-caps)
  if (!isRust() || (maxLimit !== undefined && maxLimit !== MAX_SEARCH_LIMIT)) {
    return tsSearchBlocksWithMeta(client, query, limit, includeContext, slimResults as false, maxLimit);
  }
  return searchBlocksOverMcp(client, query, limit, includeContext, slimResults).then(({ value, meta }) => ({
    results: value,
    meta,
  }));
}) as typeof tsSearchBlocksWithMeta;

export const searchBlocks = ((
  client: LogseqClient,
  query: string,
  limit?: number,
  includeContext?: boolean,
  slimResults?: boolean
) =>
  isRust()
    ? searchBlocksOverMcp(client, query, limit, includeContext, slimResults).then(({ value }) => value)
    : tsSearchBlocks(client, query, limit, includeContext, slimResults as false)) as typeof tsSearchBlocks;

export const queryByPropertyWithMeta = either(
  tsQueryByPropertyWithMeta,
  async (client, propertyName, propertyValue, slimResults, limit) => {
    const { value, meta } = await callTool(client, 'logseq_query_by_property', {
      property_key: propertyName,
      property_value: propertyValue,
      slim_results: slimResults ?? false,
      limit,
    });
    return { results: value, meta };
  }
);

export const queryByProperty = either(tsQueryByProperty, async (client, propertyName, propertyValue, slimResults, limit) =>
  (await queryByPropertyWithMeta(client, propertyName, propertyValue, slimResults, limit)).results
);

export const getConceptNetwork = ((
  client: LogseqClient,
  conceptName: string,
  maxDepth?: number,
  options: Parameters<typeof tsGetConceptNetwork>[3] = {}
) => {
  // The tool caps `max_nodes` and `max_fanout`; only a direct call can lift them (the walk with no fanout cap)
  const { maxNodes, maxFanout } = options;
  const beyondTool = (value: number | undefined, max: number) => value !== undefined && !(value <= max);
  if (!isRust() || beyondTool(maxNodes, MAX_NODES_LIMIT) || beyondTool(maxFanout, MAX_FANOUT_LIMIT)) {
    return tsGetConceptNetwork(client, conceptName, maxDepth, options);
  }
  return callTool(client, 'logseq_get_concept_network', {
    concept_name: conceptName,
    max_depth: maxDepth,
    max_nodes: maxNodes,
    max_fanout: maxFanout,
    expand_journals: options.expandJournals,
  }).then(({ value }) => value);
}) as typeof tsGetConceptNetwork;

export const searchByRelationship = ((
  client: LogseqClient,
  topicA: string,
  topicB: string,
  relationshipType: Parameters<typeof tsSearchByRelationship>[3],
  maxDistance?: number,
  options: Parameters<typeof tsSearchByRelationship>[5] = {}
) => {
  if (!isRust() || options.maxFrontier !== undefined) {
    return tsSearchByRelationship(client, topicA, topicB, relationshipType, maxDistance, options);
  }
  return callTool(client, 'logseq_search_by_relationship', {
    topic_a: topicA,
    topic_b: topicB,
    relationship_type: relationshipType,
    max_distance: maxDistance,
    limit: options.limit,
  }).then(({ value }) => value);
}) as typeof tsSearchByRelationship;

export const buildContextForTopic = either(tsBuildContextForTopic, async (client, topicName, options) =>
  (await callTool(client, 'logseq_build_context', {
    topic_name: topicName,
    max_blocks: options?.maxBlocks,
    max_related_pages: options?.maxRelatedPages,
    max_references: options?.maxReferences,
    include_temporal_context: options?.includeTemporalContext,
    resolve_refs: options?.resolveRefs,
  })).value
);

export const getContextForQuery = ((
  client: LogseqClient,
  query: string,
  options: Parameters<typeof tsGetContextForQuery>[2] = {}
) => {
  // `hitPages` names the page of each hit for Markdown; the JSON tool leaves it off
  if (!isRust() || options.hitPages) return tsGetContextForQuery(client, query, options);
  return callTool(client, 'logseq_get_context_for_query', {
    query,
    max_topics: options.maxTopics,
    max_search_results: options.maxSearchResults,
  }).then(({ value }) => value);
}) as typeof tsGetContextForQuery;

export const queryJournals = either(tsQueryJournals, async (client, options, now) =>
  (await callTool(
    client,
    'logseq_query_by_date_range',
    {
      start_date: options.startDate,
      end_date: options.endDate,
      last_n: options.lastN,
      preset: options.preset,
      search_term: options.searchTerm,
      slim_results: options.slimResults ?? false,
      include_content: options.includeContent,
      top_concepts_limit: options.topConceptsLimit,
      resolve_refs: options.resolveRefs,
      max_blocks: options.maxBlocks,
    },
    now
  )).value
);

export const queryByDateRange = either(tsQueryByDateRange, async (client, startDate, endDate, searchTerm, slimResults) =>
  queryJournals(client, { startDate, endDate, searchTerm, slimResults })
);

export const getConceptEvolution = either(tsGetConceptEvolution, async (client, conceptName, options) =>
  (await callTool(client, 'logseq_get_concept_evolution', {
    concept_name: conceptName,
    start_date: options?.startDate,
    end_date: options?.endDate,
    group_by: options?.groupBy,
    max_entries: options?.maxEntries,
  })).value
);

export const getGraphInfo = either(tsGetGraphInfo, async client => (await callTool(client, 'logseq_get_graph_info', {})).value);

export const getCurrentContext = either(
  tsGetCurrentContext,
  async client => (await callTool(client, 'logseq_get_current_context', {})).value
);

export const listPages = either(tsListPages, async (client, options) =>
  (await callTool(client, 'logseq_list_pages', {
    name_contains: options?.nameContains,
    limit: options?.limit,
    offset: options?.offset,
  })).value
);

export const checkLinks = either(tsCheckLinks, async (client, before, after) =>
  (await callTool(client, 'logseq_check_links', { before, after })).value
);
