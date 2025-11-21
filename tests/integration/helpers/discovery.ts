import { LogseqClient } from '../../../src/client.js';

export interface DiscoveredPage {
  name: string;
  id: number;
}

/**
 * Discover pages in the LogSeq graph
 * @param client - LogseqClient instance
 * @param limit - Maximum number of pages to return
 * @returns Array of discovered pages
 */
export async function discoverPages(
  client: LogseqClient,
  limit: number = 10
): Promise<DiscoveredPage[]> {
  try {
    // Use Editor.getAllPages instead of Datalog for more reliable results
    const result = await client.callAPI<any[]>('logseq.Editor.getAllPages');

    if (!result || result.length === 0) {
      return [];
    }

    return result
      .slice(0, limit)
      .map(p => ({
        name: p.name || p['original-name'] || p.originalName,
        id: p.id || p['db/id']
      }))
      .filter(p => p.name && p.id);
  } catch (error) {
    console.error(`Failed to discover pages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error; // Don't silently return [], fail the test
  }
}

/**
 * Discover journal pages in the LogSeq graph
 * @param client - LogseqClient instance
 * @param limit - Maximum number of pages to return
 * @returns Array of discovered journal pages
 */
export async function discoverJournalPages(
  client: LogseqClient,
  limit: number = 10
): Promise<DiscoveredPage[]> {
  try {
    // Get all pages and filter for journal pages
    const allPages = await client.callAPI<any[]>('logseq.Editor.getAllPages');

    if (!allPages || allPages.length === 0) {
      return [];
    }

    const journalPages = allPages.filter(p => p.journal || p['journal?']);

    return journalPages
      .slice(0, limit)
      .map(p => ({
        name: p.name || p['original-name'] || p.originalName,
        id: p.id || p['db/id']
      }))
      .filter(p => p.name && p.id);
  } catch (error) {
    console.error(`Failed to discover journal pages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error; // Don't silently return [], fail the test
  }
}

/**
 * Discover pages with links to other pages
 * Useful for testing relationship/graph traversal tools
 * @param client - LogseqClient instance
 * @param minLinks - Minimum number of outbound links required
 * @param limit - Maximum pages to check
 * @returns Array of pages with at least minLinks connections
 */
export async function discoverPagesWithLinks(
  client: LogseqClient,
  minLinks: number = 1,
  limit: number = 20
): Promise<DiscoveredPage[]> {
  const allPages = await discoverPages(client, limit);
  const pagesWithLinks: DiscoveredPage[] = [];

  for (const page of allPages) {
    try {
      // Get page blocks and count links
      const blocks = await client.callAPI<any[]>('logseq.Editor.getPageBlocksTree', [page.name]);

      if (!blocks) continue;

      let linkCount = 0;
      for (const block of blocks) {
        const content = block.content || '';
        const linkMatches = content.match(/\[\[([^\]]+)\]\]/g);
        if (linkMatches) {
          linkCount += linkMatches.length;
        }
      }

      if (linkCount >= minLinks) {
        pagesWithLinks.push(page);
      }
    } catch (error) {
      // Skip pages that can't be read
      continue;
    }
  }

  return pagesWithLinks;
}

/**
 * Discover blocks that contain hashtags
 * Useful for testing tag-based search and filtering
 * @param client - LogseqClient instance
 * @param limit - Maximum number of pages to check
 * @returns Array of pages that contain blocks with hashtags
 */
export async function discoverBlocksWithTags(
  client: LogseqClient,
  limit: number = 10
): Promise<Array<{ pageName: string; blockContent: string; tags: string[] }>> {
  const pages = await discoverPages(client, limit);
  const blocksWithTags: Array<{ pageName: string; blockContent: string; tags: string[] }> = [];

  for (const page of pages) {
    try {
      const blocks = await client.callAPI<any[]>('logseq.Editor.getPageBlocksTree', [page.name]);

      if (!blocks) continue;

      for (const block of blocks) {
        const content = block.content || '';
        const tagMatches = content.match(/#(\w+)/g);

        if (tagMatches && tagMatches.length > 0) {
          const tags = tagMatches.map(tag => tag.substring(1)); // Remove # prefix
          blocksWithTags.push({
            pageName: page.name,
            blockContent: content,
            tags
          });
        }
      }
    } catch (error) {
      continue;
    }
  }

  return blocksWithTags;
}
