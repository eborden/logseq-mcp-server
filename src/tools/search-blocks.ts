import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

/**
 * Search for blocks containing a specific text query using Editor API
 * @param client - LogseqClient instance
 * @param query - Text to search for in block content
 * @param limit - Maximum number of results to return (default: 100)
 * @returns Array of BlockEntity objects matching the query, or null if search fails
 */
export async function searchBlocks(
  client: LogseqClient,
  query: string,
  limit: number = 100
): Promise<BlockEntity[] | null> {
  try {
    // Get all pages
    const pages = await client.callAPI<PageEntity[] | null>(
      'logseq.Editor.getAllPages'
    );

    if (!pages) {
      return null;
    }

    const matches: BlockEntity[] = [];
    const queryLower = query.toLowerCase();

    // Helper function to recursively search blocks
    function searchBlocksRecursive(blocks: BlockEntity[], pageName: string): boolean {
      for (const block of blocks) {
        // Check if we've reached the limit
        if (matches.length >= limit) {
          return true; // Signal to stop searching
        }

        // Check if block content matches query (case-insensitive)
        if (block.content && block.content.toLowerCase().includes(queryLower)) {
          matches.push(block);
        }

        // Recursively search children
        if (block.children && block.children.length > 0) {
          const shouldStop = searchBlocksRecursive(block.children, pageName);
          if (shouldStop) {
            return true;
          }
        }
      }
      return false;
    }

    // Search blocks in each page
    for (const page of pages) {
      // Check if we've reached the limit
      if (matches.length >= limit) {
        break;
      }

      // Get page blocks tree
      const blocks = await client.callAPI<BlockEntity[] | null>(
        'logseq.Editor.getPageBlocksTree',
        [page.name]
      );

      if (blocks && blocks.length > 0) {
        const shouldStop = searchBlocksRecursive(blocks, page.name);
        if (shouldStop) {
          break;
        }
      }
    }

    // Return limited results
    return matches.slice(0, limit);
  } catch (error) {
    throw error;
  }
}
