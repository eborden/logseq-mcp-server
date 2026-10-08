import { afterAll } from 'vitest';
import type { LogseqClient } from '../../../scripts/lib/logseq-api.js';
import { AmbiguousPageError, BlockNotFoundError, InvalidParameterError, PageNotFoundError } from './errors.js';
import type { Json } from './types.js';
import { closeSessions, rustSession } from './server-under-test.js';

/**
 * The tools as functions, for the integration suites (#352, #356). Each calls the tool through MCP on the Rust
 * server and returns what its result holds: the first content block as JSON, with the `meta` block of a
 * bare-array tool read back as the second part. An error result becomes a thrown error of the class in
 * `./errors.ts` (the message is the server's own), and the ambiguous-name result becomes an `AmbiguousPageError`.
 *
 * Each function maps its positional arguments to the tool's, and sends the default a direct call had in the
 * TypeScript server where the tool's differs (`slim_results` is false here, true for the tool: BR-0012), so the
 * suites that read full entities keep reading them. The `client` is only the route to LogSeq: see
 * `server-under-test.ts`.
 */

afterAll(closeSessions);

/** The tool's first content block as JSON, and its `meta` block when it sends one. */
interface ToolOutput {
  value: Json;
  meta: Json;
}

/** The tool's arguments: the ones given. A number JSON can't carry (`Infinity`) would arrive as null, so it is an error here. */
const compact = <T extends Record<string, unknown>>(args: T): Record<string, unknown> => {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`${key} is ${value}, which a tool argument can't be.`);
    }
  }
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
};

/** The server's words for a page that wasn't found, split into the name and the closest names. */
const NOT_FOUND = /^No page ("(?:[^"\\]|\\.)*")\.(?: Closest: (.*?)\.)? Try logseq_search_blocks/s;

/** The error a tool's error message stands for. */
function errorFor(message: string): Error {
  if (message.startsWith('No page "')) {
    const found = message.match(NOT_FOUND);
    if (!found) throw new Error(`Unrecognised "no page" message: ${message}`);
    const [, quoted, closest] = found;
    return new PageNotFoundError(JSON.parse(quoted) as string, closest ? closest.split(', ') : [], message);
  }
  const block = message.match(/^Block not found: "(.*)"\n\nTip: /s);
  if (block) return new BlockNotFoundError(block[1], message);
  if (message.startsWith("Invalid parameter '")) return new InvalidParameterError(message);
  return new Error(message);
}

/** The `AmbiguousPageError` for the ambiguous-name result, which a tool returns instead of failing. */
function ambiguousError(value: Json): AmbiguousPageError {
  if (typeof value.pageName !== 'string' || typeof value.totalCandidates !== 'number') {
    throw new Error(`The ambiguous-name result is not the shape the suites read: ${JSON.stringify(value).slice(0, 200)}`);
  }
  return new AmbiguousPageError(value.pageName, value.candidates, value.totalCandidates, value);
}

async function callTool(client: LogseqClient, name: string, args: Record<string, unknown>, now?: Date): Promise<ToolOutput> {
  const mcp = await rustSession(client, { tips: false, now });
  const result = (await mcp.callTool({ name, arguments: compact(args) }, undefined, { timeout: 170_000 })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const first = result.content[0]?.text ?? '';
  if (result.isError) throw errorFor((JSON.parse(first) as { error: string }).error);
  const value = JSON.parse(first) as Json;
  if (value && value.ambiguous === true && Array.isArray(value.candidates)) {
    throw ambiguousError(value);
  }
  const second = result.content[1]?.text;
  return { value, meta: second === undefined ? null : (JSON.parse(second) as { meta: Json }).meta };
}

export async function getPage(
  client: LogseqClient,
  pageName: string,
  includeChildren?: boolean,
  options?: { resolveRefs?: boolean }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_get_page', {
      page_name: pageName,
      include_children: includeChildren,
      resolve_refs: options?.resolveRefs,
    })
  ).value;
}

export async function getPageOutline(client: LogseqClient, pageName: string): Promise<Json> {
  return (await callTool(client, 'logseq_get_page_outline', { page_name: pageName })).value;
}

export async function getBacklinksWithMeta(
  client: LogseqClient,
  pageName: string,
  caps?: { maxPages?: number; maxBlocksPerPage?: number }
): Promise<{ results: Json; meta: Json }> {
  const { value, meta } = await callTool(client, 'logseq_get_backlinks', {
    page_name: pageName,
    max_pages: caps?.maxPages,
    max_blocks_per_page: caps?.maxBlocksPerPage,
  });
  return { results: value, meta };
}

export async function getBacklinks(
  client: LogseqClient,
  pageName: string,
  caps?: { maxPages?: number; maxBlocksPerPage?: number }
): Promise<Json> {
  return (await getBacklinksWithMeta(client, pageName, caps)).results;
}

export async function getBlock(
  client: LogseqClient,
  blockUuid: string,
  includeChildren?: boolean,
  options?: { resolveRefs?: boolean }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_get_block', {
      block_uuid: blockUuid,
      include_children: includeChildren,
      resolve_refs: options?.resolveRefs,
    })
  ).value;
}

// A direct call defaulted to full results, the tool to slim (BR-0012), so each call says which
export async function searchBlocksWithMeta(
  client: LogseqClient,
  query: string,
  limit?: number,
  includeContext?: boolean,
  slimResults?: boolean
): Promise<{ results: Json; meta: Json }> {
  const { value, meta } = await callTool(client, 'logseq_search_blocks', {
    query,
    limit,
    include_context: includeContext ?? false,
    slim_results: slimResults ?? false,
  });
  return { results: value, meta };
}

export async function searchBlocks(
  client: LogseqClient,
  query: string,
  limit?: number,
  includeContext?: boolean,
  slimResults?: boolean
): Promise<Json> {
  return (await searchBlocksWithMeta(client, query, limit, includeContext, slimResults)).results;
}

export async function queryByPropertyWithMeta(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string,
  slimResults?: boolean,
  limit?: number
): Promise<{ results: Json; meta: Json }> {
  const { value, meta } = await callTool(client, 'logseq_query_by_property', {
    property_key: propertyName,
    property_value: propertyValue,
    slim_results: slimResults ?? false,
    limit,
  });
  return { results: value, meta };
}

export async function queryByProperty(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string,
  slimResults?: boolean,
  limit?: number
): Promise<Json> {
  return (await queryByPropertyWithMeta(client, propertyName, propertyValue, slimResults, limit)).results;
}

export async function getConceptNetwork(
  client: LogseqClient,
  conceptName: string,
  maxDepth?: number,
  options: { maxNodes?: number; maxFanout?: number; expandJournals?: boolean } = {}
): Promise<Json> {
  return (
    await callTool(client, 'logseq_get_concept_network', {
      concept_name: conceptName,
      max_depth: maxDepth,
      max_nodes: options.maxNodes,
      max_fanout: options.maxFanout,
      expand_journals: options.expandJournals,
    })
  ).value;
}

export async function searchByRelationship(
  client: LogseqClient,
  topicA: string,
  topicB: string,
  relationshipType: 'references' | 'in-pages-linking-to' | 'connected-within',
  maxDistance?: number,
  options: { limit?: number } = {}
): Promise<Json> {
  return (
    await callTool(client, 'logseq_search_by_relationship', {
      topic_a: topicA,
      topic_b: topicB,
      relationship_type: relationshipType,
      max_distance: maxDistance,
      limit: options.limit,
    })
  ).value;
}

export async function buildContextForTopic(
  client: LogseqClient,
  topicName: string,
  options?: {
    maxBlocks?: number;
    maxRelatedPages?: number;
    maxReferences?: number;
    includeTemporalContext?: boolean;
    resolveRefs?: boolean;
  }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_build_context', {
      topic_name: topicName,
      max_blocks: options?.maxBlocks,
      max_related_pages: options?.maxRelatedPages,
      max_references: options?.maxReferences,
      include_temporal_context: options?.includeTemporalContext,
      resolve_refs: options?.resolveRefs,
    })
  ).value;
}

export async function getContextForQuery(
  client: LogseqClient,
  query: string,
  options: { maxTopics?: number; maxSearchResults?: number } = {}
): Promise<Json> {
  return (
    await callTool(client, 'logseq_get_context_for_query', {
      query,
      max_topics: options.maxTopics,
      max_search_results: options.maxSearchResults,
    })
  ).value;
}

export interface JournalQuery {
  startDate?: number;
  endDate?: number;
  lastN?: number;
  preset?: string;
  searchTerm?: string;
  slimResults?: boolean;
  includeContent?: boolean;
  topConceptsLimit?: number;
  resolveRefs?: boolean;
  maxBlocks?: number;
}

/** `now` fixes the server's clock (`LOGSEQ_MCP_NOW`), which only a debug build honours. */
export async function queryJournals(client: LogseqClient, options: JournalQuery, now?: Date): Promise<Json> {
  return (
    await callTool(
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
    )
  ).value;
}

export async function queryByDateRange(
  client: LogseqClient,
  startDate: number,
  endDate: number,
  searchTerm?: string,
  slimResults?: boolean
): Promise<Json> {
  return queryJournals(client, { startDate, endDate, searchTerm, slimResults });
}

export async function getConceptEvolution(
  client: LogseqClient,
  conceptName: string,
  options?: { startDate?: number; endDate?: number; groupBy?: string; maxEntries?: number }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_get_concept_evolution', {
      concept_name: conceptName,
      start_date: options?.startDate,
      end_date: options?.endDate,
      group_by: options?.groupBy,
      max_entries: options?.maxEntries,
    })
  ).value;
}

export async function getGraphInfo(client: LogseqClient): Promise<Json> {
  return (await callTool(client, 'logseq_get_graph_info', {})).value;
}

export async function getCurrentContext(client: LogseqClient): Promise<Json> {
  return (await callTool(client, 'logseq_get_current_context', {})).value;
}

export async function listPages(
  client: LogseqClient,
  options?: { nameContains?: string; limit?: number; offset?: number }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_list_pages', {
      name_contains: options?.nameContains,
      limit: options?.limit,
      offset: options?.offset,
    })
  ).value;
}

export async function checkLinks(client: LogseqClient, before: string, after: string): Promise<Json> {
  return (await callTool(client, 'logseq_check_links', { before, after })).value;
}
