import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity, ResultMeta } from '../types.js';
import { requirePage, resolvedFromInfo, ResolvedFrom } from '../utils/resolve-page.js';
import { buildResultMeta } from '../utils/result-meta.js';

/**
 * Get all pages/blocks that link to a specific page
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @returns Array of tuples [PageEntity, BlockEntity[]]
 * Note: LogSeq API returns [page, [block1, block2, ...]] per source page
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function getBacklinks(
  client: LogseqClient,
  pageName: string
): Promise<[PageEntity, BlockEntity[]][] | null> {
  return (await getBacklinksWithMeta(client, pageName)).results;
}

/**
 * Same as {@link getBacklinks}, plus a meta for the second MCP content block.
 * The result is a bare array with no room for a field, so when the name was an
 * alias, date or namespace leaf rather than an exact name, `meta.resolvedFrom`
 * says which page the backlinks belong to. `meta` is null for an exact match,
 * so default output is unchanged.
 */
export async function getBacklinksWithMeta(
  client: LogseqClient,
  pageName: string
): Promise<{ results: [PageEntity, BlockEntity[]][] | null; meta: (ResultMeta & ResolvedFrom) | null }> {
  const resolved = await requirePage(client, pageName);
  const results = await fetchBacklinks(client, resolved.lookupName);
  const resolvedFrom = resolvedFromInfo(pageName, resolved);
  return { results, meta: resolvedFrom ? { ...buildResultMeta([]), resolvedFrom } : null };
}

/**
 * The backlinks call alone, for a caller that has already resolved the page
 * (so the name isn't resolved twice).
 */
export async function fetchBacklinks(
  client: LogseqClient,
  resolvedName: string
): Promise<[PageEntity, BlockEntity[]][] | null> {
  return client.callAPI<[PageEntity, BlockEntity[]][] | null>(
    'logseq.Editor.getPageLinkedReferences',
    [resolvedName]
  );
}
