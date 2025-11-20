import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

/**
 * Get all pages/blocks that link to a specific page
 * @param client - LogseqClient instance
 * @param pageName - Name of the page to get backlinks for
 * @returns Array of tuples [BlockEntity, PageEntity] or null if page doesn't exist
 */
export async function getBacklinks(
  client: LogseqClient,
  pageName: string
): Promise<[BlockEntity, PageEntity][] | null> {
  const result = await client.callAPI<[BlockEntity, PageEntity][] | null>(
    'logseq.Editor.getPageLinkedReferences',
    [pageName]
  );

  return result;
}
