import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';
import { requirePage } from '../utils/resolve-page.js';

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
  const { lookupName } = await requirePage(client, pageName);
  return fetchBacklinks(client, lookupName);
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
