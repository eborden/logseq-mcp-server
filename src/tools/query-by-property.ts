import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity, SlimBlock } from '../types.js';
import { toSlimBlock, buildPageNameMap, getPageNameFromBlock } from '../utils/slim-entities.js';

/**
 * Query blocks by a specific property name and value using Editor API
 * @param client - LogseqClient instance
 * @param propertyName - Name of the property to query
 * @param propertyValue - Value to match for the property
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only)
 * @returns Array of BlockEntity or SlimBlock objects with matching property, or null if query fails
 */
export async function queryByProperty(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string,
  slimResults: boolean = false
): Promise<BlockEntity[] | SlimBlock[] | null> {
  try {
    // Get all pages
    const pages = await client.callAPI<PageEntity[] | null>(
      'logseq.Editor.getAllPages'
    );

    if (!pages) {
      return null;
    }

    const matches: BlockEntity[] = [];

    // Helper function to recursively search blocks for property matches
    function searchBlocksRecursive(blocks: BlockEntity[]): void {
      for (const block of blocks) {
        // Check if block has properties and the property key exists
        if (block.properties && propertyName in block.properties) {
          // Exact match comparison (convert both to strings for comparison)
          const blockValue = block.properties[propertyName];
          if (String(blockValue) === propertyValue) {
            matches.push(block);
          }
        }

        // Recursively search children
        if (block.children && block.children.length > 0) {
          searchBlocksRecursive(block.children);
        }
      }
    }

    // Search blocks in each page
    for (const page of pages) {
      // Get page blocks tree
      const blocks = await client.callAPI<BlockEntity[] | null>(
        'logseq.Editor.getPageBlocksTree',
        [page.name]
      );

      if (blocks && blocks.length > 0) {
        searchBlocksRecursive(blocks);
      }
    }

    // Return slim results if requested
    if (slimResults) {
      const pageNameMap = buildPageNameMap(pages);
      const slimMatches = matches.map(block => {
        const pageName = getPageNameFromBlock(block, pageNameMap);
        return toSlimBlock(block, pageName);
      });
      return slimMatches;
    }

    return matches;
  } catch (error) {
    throw error;
  }
}
