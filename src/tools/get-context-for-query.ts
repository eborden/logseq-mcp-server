import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';
import { buildContextForTopic, TopicContext } from './build-context.js';

export interface QueryContext {
  query: string;
  extractedTopics: string[];
  contexts: TopicContext[];
  searchResults?: BlockEntity[];
  summary: {
    totalTopics: number;
    totalBlocks: number;
    totalPages: number;
  };
}

/**
 * Extract page references and tags from query text
 * @param query - Query string
 * @returns Array of extracted topic names
 */
function extractTopicsFromQuery(query: string): string[] {
  const topics: string[] = [];

  // Extract [[page references]]
  const pageRefMatches = query.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const match of pageRefMatches) {
    topics.push(match[1]);
  }

  // Extract #tags
  const tagMatches = query.matchAll(/#([^\s#]+)/g);
  for (const match of tagMatches) {
    topics.push(match[1]);
  }

  return [...new Set(topics)]; // Deduplicate
}

/**
 * Get context for a natural language query
 * @param client - LogseqClient instance
 * @param query - Natural language query
 * @param options - Options for context gathering
 * @returns QueryContext with all relevant information
 */
export async function getContextForQuery(
  client: LogseqClient,
  query: string,
  options: {
    maxTopics?: number;
    maxSearchResults?: number;
  } = {}
): Promise<QueryContext> {
  const { maxTopics = 5, maxSearchResults = 20 } = options;

  // Extract topics from query
  const extractedTopics = extractTopicsFromQuery(query);

  // Build context for each extracted topic
  const contexts: TopicContext[] = [];

  for (const topic of extractedTopics.slice(0, maxTopics)) {
    try {
      const context = await buildContextForTopic(client, topic, {
        maxBlocks: 10,
        maxRelatedPages: 5,
        maxReferences: 10
      });
      contexts.push(context);
    } catch (error) {
      // Topic page doesn't exist, skip
      console.error(`Failed to build context for ${topic}:`, error);
    }
  }

  // If no explicit topics, do a text search
  let searchResults: BlockEntity[] | undefined;

  if (extractedTopics.length === 0) {
    // Extract keywords from query (simple approach: remove common words)
    const commonWords = new Set([
      'what', 'when', 'where', 'who', 'why', 'how',
      'the', 'a', 'an', 'is', 'are', 'was', 'were',
      'do', 'does', 'did', 'can', 'could', 'should',
      'would', 'in', 'on', 'at', 'to', 'for', 'of',
      'with', 'about', 'by'
    ]);

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 3 && !commonWords.has(word))
      .slice(0, 3);

    // Search for blocks containing keywords
    if (keywords.length > 0) {
      try {
        const blocks = await client.callAPI<BlockEntity[]>(
          'logseq.DB.q',
          [`(and ${keywords.map(k => `(block-content "${k}")`).join(' ')})`]
        );

        searchResults = (blocks || []).slice(0, maxSearchResults);
      } catch (error) {
        // Search failed, continue without results
        searchResults = [];
      }
    }
  }

  // Build summary
  const totalBlocks = contexts.reduce(
    (sum, ctx) => sum + ctx.directBlocks.length,
    0
  ) + (searchResults?.length || 0);

  const totalPages = new Set(
    contexts.flatMap(ctx => [
      ctx.mainPage.id,
      ...ctx.relatedPages.map(rp => rp.page.id)
    ])
  ).size;

  return {
    query,
    extractedTopics,
    contexts,
    searchResults,
    summary: {
      totalTopics: contexts.length,
      totalBlocks,
      totalPages
    }
  };
}
