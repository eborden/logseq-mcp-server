import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';

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

  // Generate Datalog query (parameters embedded in query)
  const query = DatalogQueryBuilder.buildContext(topicName, {
    maxBlocks,
    maxRelatedPages,
    maxReferences
  });

  // Execute query - returns array of tuples [[page, block]]
  const results = await client.executeDatalogQuery<Array<[any, any]>>(query);

  // If no results, page doesn't exist
  if (!results || results.length === 0) {
    throw new Error(`Page not found: ${topicName}`);
  }

  // Extract unique main page
  const mainPage = results[0][0];

  // Extract unique blocks
  const blockMap = new Map();
  for (const [page, block] of results) {
    if (block && !blockMap.has(block.id)) {
      blockMap.set(block.id, block);
    }
  }

  const directBlocks = Array.from(blockMap.values()).slice(0, maxBlocks);

  // Query 2: Get related pages and backlinks using same pattern as get-concept-network
  const relatedPages: TopicContext['relatedPages'] = [];
  const references: TopicContext['references'] = [];

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
