import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';

export interface RelatedPagesResult {
  sourcePage: PageEntity;
  relatedPages: Array<{
    page: PageEntity;
    relationshipType: 'outbound-reference' | 'inbound-reference';
    distance: number;
  }>;
}

/**
 * Get pages related to a source page through references
 * @param client - LogseqClient instance
 * @param pageName - Name of the source page
 * @param depth - Maximum depth to traverse (default: 1)
 * @returns RelatedPagesResult with source page and related pages
 * @throws Error if page not found
 */
export async function getRelatedPages(
  client: LogseqClient,
  pageName: string,
  depth: number = 1
): Promise<RelatedPagesResult> {
  // Get the source page
  const sourcePage = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [pageName]
  );

  if (sourcePage === null) {
    throw new Error(`Page not found: ${pageName}`);
  }

  if (depth === 0) {
    return {
      sourcePage,
      relatedPages: []
    };
  }

  const relatedPages: RelatedPagesResult['relatedPages'] = [];
  const visited = new Set<number>([sourcePage.id]);

  // Get inbound references (pages that link to this page)
  // getPageLinkedReferences returns tuples of [BlockEntity, PageEntity]
  const backlinks = await client.callAPI<[BlockEntity, PageEntity][] | null>(
    'logseq.Editor.getPageLinkedReferences',
    [pageName]
  );

  for (const [block, page] of backlinks || []) {
    if (!visited.has(page.id)) {
      visited.add(page.id);
      relatedPages.push({
        page: page,
        relationshipType: 'inbound-reference',
        distance: 1
      });
    }
  }

  return {
    sourcePage,
    relatedPages
  };
}
