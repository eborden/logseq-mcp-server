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
const NOT_FOUND = /^No page ("(?:[^"\\]|\\.)*")\.(?: Closest: (.*?)\.)? Try logseq_find_blocks/s;

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
      page: pageName,
      detail: includeChildren ? 'full' : undefined,
      resolve_refs: options?.resolveRefs,
    })
  ).value;
}

export async function getPageOutline(client: LogseqClient, pageName: string): Promise<Json> {
  return (await callTool(client, 'logseq_get_page', { page: pageName, detail: 'outline' })).value;
}

export async function getBlock(
  client: LogseqClient,
  blockUuid: string,
  includeChildren?: boolean,
  options?: { resolveRefs?: boolean }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_get_block', {
      uuid: blockUuid,
      include_children: includeChildren,
      resolve_refs: options?.resolveRefs,
    })
  ).value;
}

/** What `logseq_find_blocks` filters on (ADR-0037): at least one of text, a page, pages it links to, property with value, or a period. */
export interface BlockFilters {
  text?: string;
  page?: string;
  linksTo?: string[];
  property?: string;
  value?: string;
  startDate?: number;
  endDate?: number;
  lastN?: number;
  preset?: string;
}

/** How a `logseq_find_blocks` result is paged and shaped. */
export interface BlockPaging {
  limit?: number;
  includeContext?: boolean;
  slimResults?: boolean;
}

// A direct call defaulted to full results, the tool to slim (BR-0012), so each call says which
export async function findBlocksWithMeta(
  client: LogseqClient,
  filters: BlockFilters,
  paging: BlockPaging = {}
): Promise<{ results: Json; meta: Json }> {
  const { value, meta } = await callTool(client, 'logseq_find_blocks', {
    text: filters.text,
    page: filters.page,
    links_to: filters.linksTo,
    property: filters.property,
    value: filters.value,
    start_date: filters.startDate,
    end_date: filters.endDate,
    last_n: filters.lastN,
    preset: filters.preset,
    limit: paging.limit,
    include_context: paging.includeContext ?? false,
    slim_results: paging.slimResults ?? false,
  });
  return { results: value, meta };
}

export async function findBlocks(client: LogseqClient, filters: BlockFilters, paging: BlockPaging = {}): Promise<Json> {
  return (await findBlocksWithMeta(client, filters, paging)).results;
}

/**
 * The next page of a `logseq_find_blocks` result (ADR-0038): a call with the `nextCursor` of the page before and no other
 * argument. `others` is for a test that sends one beside it, which the tool refuses.
 */
export async function findBlocksNext(client: LogseqClient, cursor: string, others: Record<string, unknown> = {}): Promise<{ results: Json; meta: Json }> {
  const { value, meta } = await callTool(client, 'logseq_find_blocks', { cursor, ...others });
  return { results: value, meta };
}

/** The walk of `logseq_explore_network` without `to`: the pages linked to `page` as nodes and edges. */
export async function exploreNetwork(
  client: LogseqClient,
  page: string,
  maxDepth?: number,
  options: { maxNodes?: number; maxFanout?: number; expandJournals?: boolean; withSnippets?: boolean } = {}
): Promise<Json> {
  return (
    await callTool(client, 'logseq_explore_network', {
      page,
      max_depth: maxDepth,
      max_nodes: options.maxNodes,
      max_fanout: options.maxFanout,
      expand_journals: options.expandJournals,
      with_snippets: options.withSnippets,
    })
  ).value;
}

/** `logseq_explore_network` with `to`: the shortest path of links from `page` to `to`, as nodes and edges. */
export async function exploreNetworkPath(client: LogseqClient, page: string, to: string, maxDepth?: number): Promise<Json> {
  return (await callTool(client, 'logseq_explore_network', { page, to, max_depth: maxDepth })).value;
}

/** What `logseq_explore_context` takes beyond the page; each is the tool's parameter in camel case. */
export interface ExploreOptions {
  maxBlocks?: number;
  maxRelatedPages?: number;
  maxReferences?: number;
  referencesOffset?: number;
  includeTemporalContext?: boolean;
  resolveRefs?: boolean;
}

export async function exploreContext(client: LogseqClient, page: string, options?: ExploreOptions): Promise<Json> {
  return (
    await callTool(client, 'logseq_explore_context', {
      page,
      max_blocks: options?.maxBlocks,
      max_related_pages: options?.maxRelatedPages,
      max_references: options?.maxReferences,
      references_offset: options?.referencesOffset,
      include_temporal_context: options?.includeTemporalContext,
      resolve_refs: options?.resolveRefs,
    })
  ).value;
}

export interface TimelineQuery {
  page?: string;
  startDate?: number;
  endDate?: number;
  lastN?: number;
  preset?: string;
  groupBy?: string;
  slimResults?: boolean;
  includeContent?: boolean;
  topConceptsLimit?: number;
  resolveRefs?: boolean;
  maxBlocks?: number;
}

/** `now` fixes the server's clock (`LOGSEQ_MCP_NOW`), which only a debug build honours. */
export async function exploreTimeline(client: LogseqClient, options: TimelineQuery, now?: Date): Promise<Json> {
  return (
    await callTool(
      client,
      'logseq_explore_timeline',
      {
        page: options.page,
        start_date: options.startDate,
        end_date: options.endDate,
        last_n: options.lastN,
        preset: options.preset,
        group_by: options.groupBy,
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

export async function getGraphInfo(client: LogseqClient): Promise<Json> {
  return (await callTool(client, 'logseq_get_graph', {})).value;
}

export async function getCurrentContext(client: LogseqClient): Promise<Json> {
  return (await callTool(client, 'logseq_get_current', {})).value;
}

export async function findPages(
  client: LogseqClient,
  options?: {
    text?: string;
    names?: string[];
    property?: string;
    value?: string | number | boolean;
    limit?: number;
  }
): Promise<Json> {
  return (
    await callTool(client, 'logseq_find_pages', {
      text: options?.text,
      names: options?.names,
      property: options?.property,
      value: options?.value,
      limit: options?.limit,
    })
  ).value;
}

/**
 * The next page of a `logseq_find_pages` result (ADR-0038): a call with the `nextCursor` of the page before and no other
 * argument. `others` is for a test that sends one beside it, which the tool refuses.
 */
export async function findPagesNext(client: LogseqClient, cursor: string, others: Record<string, unknown> = {}): Promise<Json> {
  return (await callTool(client, 'logseq_find_pages', { cursor, ...others })).value;
}

export async function checkLinks(client: LogseqClient, before: string, after: string): Promise<Json> {
  return (await callTool(client, 'logseq_check_links', { before, after })).value;
}
