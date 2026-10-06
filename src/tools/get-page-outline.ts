import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import type { BlockEntity, ResultMeta, ResultWarning } from '../types.js';
import { orderSiblings } from '../utils/block-tree.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { entityId, pageDisplayName } from '../utils/entity-fields.js';
import { requirePage, resolvedFrom, ResolvedFrom } from '../utils/resolve-page.js';
import { firstLineSnippet } from '../utils/snippet.js';

/** Most top-level blocks one outline lists. A page with more is cut, and the result says so. */
export const MAX_OUTLINE_BLOCKS = 200;

/** One top-level block: enough to choose it, not to read it. */
export interface OutlineBlock {
  /** Pass to `logseq_get_block` to read the block */
  uuid: string;
  /** First line of the block, cut to 80 characters */
  snippet: string;
  /** Direct children only, not all descendants */
  childCount: number;
}

export interface PageOutline extends ResultMeta, ResolvedFrom {
  /** The page's name in its original casing */
  page: string;
  /** Top-level blocks in page order; empty for a page with no blocks */
  blocks: OutlineBlock[];
}

/** A pulled block row; `id` and `uuid` as the resolver's pulls return them. */
type PulledBlock = BlockEntity & { 'db/id'?: number };

const parentIdOf = (block: PulledBlock): number | undefined => {
  const parent = block.parent as unknown as { id?: number } | number | undefined;
  return typeof parent === 'number' ? parent : parent?.id;
};

/**
 * A page's outline: its top-level blocks with a first-line snippet and a child
 * count each, so a model can choose what to read with `logseq_get_block` instead
 * of loading a long page whole.
 *
 * Calls: 2 for an exact name, an alias or an ISO date (the page resolver, then one
 * Datalog query for the blocks). A namespace-leaf name adds the resolver's leaf
 * query; a missing page adds the suggestion lookup before it throws. Never one call
 * per block.
 *
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @returns The outline; when the name was an alias, date or namespace leaf rather
 *   than an exact name, `resolvedFrom` says so
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function getPageOutline(client: LogseqClient, pageName: string): Promise<PageOutline> {
  const resolved = await requirePage(client, pageName);
  const page = resolved.page;
  // The resolver pulls the page by :db/id, so it always has one (a mock without it fails in groundIds, as before)
  const pageId = entityId(page) as number;

  const { query, inputs } = DatalogQueryBuilder.pageOutlineBlocks(pageId);
  const rows = (await client.executeDatalogQuery<Array<[PulledBlock]>>(query, ...inputs)) || [];

  // Top-level blocks hang off the page; every other row is a child of one of them
  const top: PulledBlock[] = [];
  const childCount = new Map<number, number>();
  for (const [block] of rows) {
    if (block == null) continue;
    const parentId = parentIdOf(block);
    if (parentId === pageId) {
      top.push({ ...block, id: entityId(block) as number });
    } else if (parentId !== undefined) {
      childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
    }
  }

  const ordered = orderSiblings(top);
  const shown = ordered.slice(0, MAX_OUTLINE_BLOCKS);

  const warnings: ResultWarning[] = [];
  if (ordered.length > shown.length) {
    warnings.push({
      code: 'outline_truncated',
      message:
        `Showing the first ${shown.length} of ${ordered.length} top-level blocks. ` +
        'The outline has no way to page; read the rest with logseq_get_page and include_children.'
    });
  }

  return {
    page: pageDisplayName(page),
    ...resolvedFrom(pageName, resolved),
    blocks: shown.map(block => ({
      uuid: block.uuid,
      snippet: firstLineSnippet(block.content),
      childCount: childCount.get(block.id) ?? 0
    })),
    ...buildResultMeta(warnings, { blocks: ordered.length })
  };
}
