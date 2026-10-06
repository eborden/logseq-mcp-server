import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { BlockEntity, PageEntity, ResultMeta, SlimBlock, SlimPage } from '../types.js';
import { buildResultMeta, cappedTruncationWarning } from '../utils/result-meta.js';
import { toSlimBlock, toSlimPage } from '../utils/slim-entities.js';

/** Results returned when `limit` is absent. */
export const DEFAULT_SEARCH_LIMIT = 100;

/**
 * Most results one MCP call returns (#61). A larger `limit` is clamped to it,
 * like `max_nodes` on logseq_get_concept_network, and a cut at the maximum is
 * reported by a `results_truncated` warning with no `howToFetchAll`.
 */
export const MAX_SEARCH_LIMIT = 500;

/** How to reach matches past the maximum: no parameter fetches them. */
const NARROWER = 'Narrow the query to see the rest.';

export interface SearchBlocksResult extends BlockEntity {
  context?: {
    page: PageEntity;
    references: string[];
    tags: string[];
  };
}

export interface SlimSearchBlocksResult extends SlimBlock {
  /** `references` and `tags` are left out when empty */
  context?: {
    page: SlimPage;
    references?: string[];
    tags?: string[];
  };
}

/** Page name used for ordering and slim output: original casing when known. */
function displayName(page: any): string {
  return page?.['original-name'] || page?.originalName || page?.name || '';
}

/** Deterministic order: newest first (highest block id first). Ids are unique. */
function compareBlocks(a: BlockEntity, b: BlockEntity): number {
  return b.id - a.id;
}

/**
 * Convert a page pulled with `[*]` (kebab-case keys) into the camelCase
 * PageEntity shape that `getAllPages` returns and `toSlimPage` reads.
 */
function pulledPageToEntity(pulled: any): PageEntity {
  const {
    'original-name': originalName,
    'journal-day': journalDay,
    'created-at': createdAt,
    'updated-at': updatedAt,
    'properties-text-values': propertiesTextValues,
    ...rest
  } = pulled;

  const page: any = { ...rest };
  if (originalName !== undefined) {
    page.originalName = originalName;
    page['original-name'] = originalName;
  }
  if (journalDay !== undefined) page.journalDay = journalDay;
  if (createdAt !== undefined) page.createdAt = createdAt;
  if (updatedAt !== undefined) page.updatedAt = updatedAt;
  if (propertiesTextValues !== undefined) page.propertiesTextValues = propertiesTextValues;
  return page as PageEntity;
}

/**
 * Search for blocks containing a specific text query using one Datalog query
 *
 * Matching is a case-insensitive, literal substring match on block content,
 * done inside LogSeq (`re-pattern` / `re-find`). Results are sorted newest
 * first (highest block id), and cut to `limit` client-side because Datalog here has
 * no `:limit`. Blocks come back flat (no `children`).
 *
 * API calls: 1, or 2 with `includeContext` (one batched page lookup).
 *
 * Unlike `searchBlocksWithMeta`, `limit` has no maximum here: internal callers
 * (`get_context_for_query`'s keyword search) slice the results themselves.
 *
 * @param client - LogseqClient instance
 * @param query - Text to search for in block content
 * @param limit - Maximum number of results to return (default: 100)
 * @param includeContext - Include semantic context (page, references, tags)
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only). Direct calls default to full (false); the MCP handler defaults to slim through its argument schema (#42, #60)
 * @returns Array of BlockEntity or SlimBlock objects matching the query, or null if the API returns a null response (no matches is an empty array)
 */
export async function searchBlocks(
  client: LogseqClient,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  includeContext: boolean = false,
  slimResults: boolean = false
): Promise<SearchBlocksResult[] | SlimSearchBlocksResult[] | null> {
  return (await searchBlocksWithMeta(client, query, limit, includeContext, slimResults, Infinity)).results;
}

/**
 * Same search as `searchBlocks`, plus a ResultMeta (#40): `totals.matches` is
 * the number of matching blocks before `limit`, and a `results_truncated`
 * warning says what `limit` to use to get them all. No extra API call: the one
 * query already returns every match. `meta` is null when the API returned null.
 *
 * `limit` is clamped to `maxLimit` (default `MAX_SEARCH_LIMIT`, 500; #61). The
 * warning never suggests a value above it, and a cut at the maximum carries no
 * `howToFetchAll`, so `hasMore` is false there (BR-0006). Results within the
 * maximum are unchanged.
 */
export async function searchBlocksWithMeta(
  client: LogseqClient,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  includeContext: boolean = false,
  slimResults: boolean = false,
  maxLimit: number = MAX_SEARCH_LIMIT
): Promise<{ results: SearchBlocksResult[] | SlimSearchBlocksResult[] | null; meta: ResultMeta | null }> {
  const { query: datalog, inputs } = DatalogQueryBuilder.searchBlocks(query);
  const rows = await client.executeDatalogQuery<BlockEntity[][] | null>(datalog, ...inputs);

  if (!rows) {
    return { results: null, meta: null };
  }

  const matches: BlockEntity[] = rows
    .map(row => row[0])
    .filter(block => block && typeof block.content === 'string')
    .sort(compareBlocks);

  const results: SearchBlocksResult[] = matches.slice(0, Math.min(Math.max(0, limit), maxLimit));

  const meta = buildResultMeta(
    matches.length > results.length
      ? [cappedTruncationWarning('matching blocks', results.length, matches.length, 'limit', maxLimit, NARROWER, limit)]
      : [],
    { matches: matches.length }
  );

  // Full page entities for context, in one batched call (not one per block)
  const pageById = new Map<number, PageEntity>();
  if (includeContext && results.length > 0) {
    const pageIds = [...new Set(
      results
        .map(block => (block.page as any)?.id ?? (block.page as any)?.['db/id'])
        .filter((id): id is number => typeof id === 'number')
    )];

    if (pageIds.length > 0) {
      const { query: pagesQuery, inputs: pagesInputs } = DatalogQueryBuilder.getPagesByIds(pageIds);
      const pageRows = await client.executeDatalogQuery<any[][] | null>(pagesQuery, ...pagesInputs);
      for (const row of pageRows || []) {
        const page = pulledPageToEntity(row[0]);
        pageById.set(page.id, page);
      }
    }
  }

  const enriched: SearchBlocksResult[] = results.map(block => {
    const result: SearchBlocksResult = { ...block };

    if (includeContext) {
      const pageId = (block.page as any)?.id ?? (block.page as any)?.['db/id'];
      const page = pageById.get(pageId);

      // No page id, or page not found: skip context for this block
      if (page) {
        result.context = {
          page,
          references: Array.from(block.content.matchAll(/\[\[([^\]]+)\]\]/g), m => m[1]),
          tags: Array.from(block.content.matchAll(/#([^\s#]+)/g), m => m[1])
        };
      }
    }

    return result;
  });

  if (!slimResults) {
    return { results: enriched, meta };
  }

  const slimmed = enriched.map(block => {
    const slim = toSlimBlock(block, displayName(block.page)) as SlimSearchBlocksResult;

    if (block.context) {
      // Empty references / tags are left out (#42): the block is slim, so the lists add only bytes
      slim.context = {
        page: toSlimPage(block.context.page),
        ...(block.context.references.length > 0 && { references: block.context.references }),
        ...(block.context.tags.length > 0 && { tags: block.context.tags })
      };
    }

    return slim;
  });

  return { results: slimmed, meta };
}
