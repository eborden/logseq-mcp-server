import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity, SlimBlock, SlimPage } from '../types.js';
import { toSlimBlock, toSlimPage, buildPageNameMap, getPageNameFromBlock } from '../utils/slim-entities.js';

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

/**
 * Search for blocks containing a specific text query using Editor API
 * @param client - LogseqClient instance
 * @param query - Text to search for in block content
 * @param limit - Maximum number of results to return (default: 100)
 * @param includeContext - Include semantic context (page, references, tags)
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only)
 * @returns Array of BlockEntity or SlimBlock objects matching the query, or null if search fails
 */
export async function searchBlocks(
  client: LogseqClient,
  query: string,
  limit: number = 100,
  includeContext: boolean = false,
  slimResults: boolean = false
): Promise<SearchBlocksResult[] | SlimSearchBlocksResult[] | null> {
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

    // Get limited results
    let results = matches.slice(0, limit);

    // Build page maps for efficient lookups
    const pageIdMap = new Map<number, PageEntity>();
    const pageNameMapForSlim = buildPageNameMap(pages);
    for (const page of pages) {
      pageIdMap.set(page.id, page);
    }

    // Add context if requested
    if (includeContext) {
      const enrichedResults: SearchBlocksResult[] = [];

      for (const block of results) {
        const enriched: SearchBlocksResult = { ...block };

        if (block.page) {
          // Get page ID from block.page
          const pageRef = block.page as any;
          const pageId = pageRef.id || pageRef['db/id'];

          if (!pageId) {
            // If we don't have page ID, skip context for this block
            enrichedResults.push(enriched);
            continue;
          }

          // Look up page from our map
          const page = pageIdMap.get(pageId);

          if (!page) {
            // Page not found in map, skip context for this block
            enrichedResults.push(enriched);
            continue;
          }

          // Extract references from block content
          const refMatches = block.content.matchAll(/\[\[([^\]]+)\]\]/g);
          const references = Array.from(refMatches, m => m[1]);

          // Extract tags
          const tagMatches = block.content.matchAll(/#([^\s#]+)/g);
          const tags = Array.from(tagMatches, m => m[1]);

          enriched.context = {
            page,
            references,
            tags
          };
        }

        enrichedResults.push(enriched);
      }

      // Transform to slim if requested
      if (slimResults) {
        const slimResults: SlimSearchBlocksResult[] = enrichedResults.map(block => {
          const pageName = getPageNameFromBlock(block, pageNameMapForSlim);
          const slim = toSlimBlock(block, pageName) as SlimSearchBlocksResult;

          // Add slim context if present
          if (block.context) {
            slim.context = {
              page: toSlimPage(block.context.page),
              references: block.context.references,
              tags: block.context.tags
            };
          }

          return slim;
        });

        return slimResults;
      }

      return enrichedResults;
    }

    // No context - transform to slim if requested
    if (slimResults) {
      const slimResults: SlimSearchBlocksResult[] = results.map(block => {
        const pageName = getPageNameFromBlock(block, pageNameMapForSlim);
        return toSlimBlock(block, pageName) as SlimSearchBlocksResult;
      });

      return slimResults;
    }

    return results;
  } catch (error) {
    throw error;
  }
}
