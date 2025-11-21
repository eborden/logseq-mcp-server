import { LogseqClient } from '../client.js';
import { TopicContext, ContextOptions } from './build-context-http.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';

/**
 * Build comprehensive context for a topic (Datalog implementation)
 * @param client - LogseqClient instance
 * @param topicName - Name of the topic
 * @param options - Options for context building
 * @returns TopicContext with all relevant information
 */
export async function buildContextForTopicDatalog(
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

  // Related pages would require a separate query or be extracted from block references
  const relatedPages: TopicContext['relatedPages'] = [];

  // Build references (simplified - blocks that mention this topic from other pages)
  const references: TopicContext['references'] = [];

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
