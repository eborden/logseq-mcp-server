import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { getBacklinks } from './get-backlinks.js';

export interface ContextOptions {
  maxBlocks?: number;
  maxRelatedPages?: number;
  maxReferences?: number;
  includeTemporalContext?: boolean;
}

export interface TopicContext {
  topic: string;
  mainPage: PageEntity;
  directBlocks: BlockEntity[];
  relatedPages: Array<{
    page: PageEntity;
    relationshipType: 'outbound' | 'inbound';
  }>;
  references: Array<{
    block: BlockEntity;
    sourcePage: PageEntity;
  }>;
  temporalContext?: {
    isJournal: boolean;
    date?: number;
    nearbyDates?: Array<{
      date: number;
      pageName: string;
    }>;
  };
  summary: {
    totalBlocks: number;
    totalRelatedPages: number;
    totalReferences: number;
    pageProperties: Record<string, any>;
  };
}

/**
 * Build comprehensive context for a topic using Datalog queries
 * @param client - LogseqClient instance
 * @param topicName - Name of the topic
 * @param options - Options for context building
 * @returns TopicContext with all relevant information
 */
export async function buildContextForTopic(
  client: LogseqClient,
  topicName: string,
  options: ContextOptions = {}
): Promise<TopicContext> {
  const {
    maxBlocks = 50,
    maxRelatedPages = 10,
    maxReferences = 20,
    includeTemporalContext = true
  } = options;

  // Query 1: Get the main page (case-insensitive)
  const pageQuery = DatalogQueryBuilder.getPage(topicName);
  const pageResults = await client.executeDatalogQuery<Array<[any]>>(pageQuery);

  // If no results, page doesn't exist
  if (!pageResults || pageResults.length === 0) {
    throw new Error(`Page not found: ${topicName}`);
  }

  const mainPage = pageResults[0][0];

  // Query 2: Get blocks for the page (may be empty)
  const blocksQuery = DatalogQueryBuilder.getPageBlocks(topicName);
  const blockResults = await client.executeDatalogQuery<Array<[any]>>(blocksQuery);

  // Extract blocks (empty array if no blocks exist)
  const directBlocks = (blockResults || [])
    .map(result => result[0])
    .filter(block => block != null)
    .slice(0, maxBlocks);

  // Query 3: Get reference blocks and derive related pages
  // Use HTTP API (getBacklinks) which correctly handles LogSeq's reference structure
  const references: TopicContext['references'] = [];
  const relatedPages: TopicContext['relatedPages'] = [];
  const seenPageIds = new Set<number>();

  try {
    const backlinks = await getBacklinks(client, topicName);
    if (backlinks && backlinks.length > 0) {
      // Each backlink is [sourcePage, blocks[]]
      // Note: sourcePage can be null for journal page entries
      for (const [sourcePage, blocks] of backlinks) {
        // For each block, extract the actual source page
        for (const block of blocks) {
          if (references.length >= maxReferences && relatedPages.length >= maxRelatedPages) break;

          // Source page is either the tuple's first element or block.page
          const actualSourcePage = sourcePage || block.page;
          if (!actualSourcePage) continue;

          const sourcePageId = actualSourcePage.id || actualSourcePage['db/id'];

          // Add source page to related pages (inbound connection)
          if (sourcePageId && !seenPageIds.has(sourcePageId) && relatedPages.length < maxRelatedPages) {
            seenPageIds.add(sourcePageId);
            relatedPages.push({
              page: actualSourcePage,
              relationshipType: 'inbound'
            });
          }

          // Add block to references
          if (references.length < maxReferences) {
            references.push({
              block,
              sourcePage: actualSourcePage
            });
          }
        }
        if (references.length >= maxReferences && relatedPages.length >= maxRelatedPages) break;
      }
    }
  } catch (error) {
    // No backlinks found, continue with empty references and related pages
  }

  // Build temporal context if requested
  let temporalContext: TopicContext['temporalContext'] | undefined;
  if (includeTemporalContext && mainPage.journal) {
    temporalContext = {
      isJournal: true,
      date: mainPage.journalDay || mainPage['journal-day']
    };
  } else if (includeTemporalContext) {
    temporalContext = {
      isJournal: false
    };
  }

  // Build summary
  const summary = {
    totalBlocks: directBlocks.length,
    totalRelatedPages: relatedPages.length,
    totalReferences: references.length,
    pageProperties: mainPage.properties || {}
  };

  return {
    topic: topicName,
    mainPage,
    directBlocks,
    relatedPages,
    references,
    temporalContext,
    summary
  };
}
