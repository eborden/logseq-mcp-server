import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

/**
 * Get all pages/blocks that link to a specific page
 * @param client - LogseqClient instance
 * @param pageName - Name of the page to get backlinks for
 * @returns Array of tuples [PageEntity, BlockEntity[]] or null if page doesn't exist
 * Note: LogSeq API returns [page, [block1, block2, ...]] per source page
 */
export async function getBacklinks(
  client: LogseqClient,
  pageName: string
): Promise<[PageEntity, BlockEntity[]][] | null> {
  const result = await client.callAPI<[PageEntity, BlockEntity[]][] | null>(
    'logseq.Editor.getPageLinkedReferences',
    [pageName]
  );

  return result;
}
