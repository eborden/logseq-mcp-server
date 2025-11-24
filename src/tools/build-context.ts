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

  // Query 3: Get related pages using same pattern as get-concept-network
  const relatedPages: TopicContext['relatedPages'] = [];

  // Get pages connected to main page (similar to concept network depth=1)
  if (mainPage.id) {
    try {
      const connectionsQuery = DatalogQueryBuilder.getConnectedPages([mainPage.id]);
      const connections = await client.executeDatalogQuery<Array<[number, any, string]>>(connectionsQuery);

      const seenPageIds = new Set<number>([mainPage.id]);

      if (connections && connections.length > 0) {
        for (const [sourceId, connectedPage, relType] of connections) {
          if (!connectedPage) continue;

          const connectedId = connectedPage.id || connectedPage['db/id'];
          if (!connectedId || seenPageIds.has(connectedId)) continue;

          seenPageIds.add(connectedId);

          // Add to related pages
          if (relatedPages.length < maxRelatedPages) {
            relatedPages.push({
              page: connectedPage,
              relationshipType: relType === 'outbound' ? 'outbound' : 'inbound'
            });
          }
        }
      }
    } catch (error) {
      // No connections found, continue with empty related pages
    }
  }

  // Query 4: Get reference blocks (blocks that mention this topic)
  const references: TopicContext['references'] = [];
  try {
    const backlinks = await getBacklinks(client, topicName);
    if (backlinks && backlinks.length > 0) {
      // Each backlink is [sourcePage, blocks[]]
      for (const [sourcePage, blocks] of backlinks) {
        for (const block of blocks) {
          if (references.length >= maxReferences) break;
          references.push({
            block,
            sourcePage
          });
        }
        if (references.length >= maxReferences) break;
      }
    }
  } catch (error) {
    // No backlinks found, continue with empty references
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
