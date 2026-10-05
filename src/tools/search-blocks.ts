import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { BlockEntity, PageEntity, SlimBlock, SlimPage } from '../types.js';
import { toSlimBlock, toSlimPage } from '../utils/slim-entities.js';

export interface SearchBlocksResult extends BlockEntity {
  context?: {
    page: PageEntity;
    references: string[];
    tags: string[];
  };
}

export interface SlimSearchBlocksResult extends SlimBlock {
  context?: {
    page: SlimPage;
    references: string[];
    tags: string[];
  };
}

/** Page name used for ordering and slim output: original casing when known. */
function displayName(page: any): string {
  return page?.['original-name'] || page?.originalName || page?.name || '';
}

/** Page name for ordering: lowercase, code-point order so it is locale-independent. */
function sortKey(page: any): string {
  return String(page?.name || displayName(page)).toLowerCase();
}

/** Deterministic order: page name, then block id (document order within a page). */
function compareBlocks(a: BlockEntity, b: BlockEntity): number {
  const pa = sortKey(a.page);
  const pb = sortKey(b.page);
  if (pa !== pb) {
    return pa < pb ? -1 : 1;
  }
  return a.id - b.id;
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
 * done inside LogSeq (`re-pattern` / `re-find`). Results are sorted by page
 * name, then block id, and cut to `limit` client-side because Datalog here has
 * no `:limit`. Blocks come back flat (no `children`).
 *
 * API calls: 1, or 2 with `includeContext` (one batched page lookup).
 *
 * @param client - LogseqClient instance
 * @param query - Text to search for in block content
 * @param limit - Maximum number of results to return (default: 100)
 * @param includeContext - Include semantic context (page, references, tags)
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only)
 * @returns Array of BlockEntity or SlimBlock objects matching the query, or null if the API returns a null response (no matches is an empty array)
 */
export async function searchBlocks(
  client: LogseqClient,
  query: string,
  limit: number = 100,
  includeContext: boolean = false,
  slimResults: boolean = false
): Promise<SearchBlocksResult[] | SlimSearchBlocksResult[] | null> {
  const { query: datalog, inputs } = DatalogQueryBuilder.searchBlocks(query);
  const rows = await client.executeDatalogQuery<BlockEntity[][] | null>(datalog, ...inputs);

  if (!rows) {
    return null;
  }

  const matches: BlockEntity[] = rows
    .map(row => row[0])
    .filter(block => block && typeof block.content === 'string')
    .sort(compareBlocks);

  const results: SearchBlocksResult[] = matches.slice(0, Math.max(0, limit));

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
    return enriched;
  }

  return enriched.map(block => {
    const slim = toSlimBlock(block, displayName(block.page)) as SlimSearchBlocksResult;

    if (block.context) {
      slim.context = {
        page: toSlimPage(block.context.page),
        references: block.context.references,
        tags: block.context.tags
      };
    }

    return slim;
  });
}
