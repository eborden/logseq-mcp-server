import { LogseqClient } from '../client.js';

/**
 * Get IDs of pages connected to a source page via references
 * Uses logseq.Editor.getPageLinkedReferences which returns pages that reference the source
 * @param client - LogseqClient instance
 * @param pageName - Name of the source page
 * @returns Array of page IDs that reference the source page (inbound connections)
 */
export async function getConnectedPageIds(
  client: LogseqClient,
  pageName: string
): Promise<number[]> {
  try {
    const backlinks = await client.callAPI<[any, any[]][] | null>(
      'logseq.Editor.getPageLinkedReferences',
      [pageName]
    );

    if (!backlinks || backlinks.length === 0) {
      return [];
    }

    // Extract unique page IDs from backlinks structure: [page, blocks[]]
    const pageIds = new Set<number>();
    for (const [sourcePage] of backlinks) {
      if (sourcePage) {
        const pageId = sourcePage.id || sourcePage['db/id'];
        if (pageId) {
          pageIds.add(pageId);
        }
      }
    }

    return Array.from(pageIds);
  } catch (error) {
    // No backlinks found
    return [];
  }
}
