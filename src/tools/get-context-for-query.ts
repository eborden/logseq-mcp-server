import { LogseqClient } from '../client.js';
import { BlockEntity, ResultWarning } from '../types.js';
import { buildContextForTopic, TopicContext } from './build-context.js';
import { AmbiguousPageError, PageNotFoundError } from '../errors.js';
import type { PageCandidate } from '../types.js';

/**
 * A non-fatal problem that made the result partial. Connection, timeout, auth
 * and unexpected errors are never warnings: they propagate.
 */
export interface QueryWarning extends ResultWarning {
  code: 'topic_not_found' | 'topic_truncated' | 'topics_truncated' | 'ambiguous_page' | 'candidates_truncated';
  /** The extracted topic the warning is about (absent when it concerns all topics) */
  topic?: string;
  /** For `ambiguous_page`: the pages the topic could mean (the topic was skipped) */
  candidates?: PageCandidate[];
  /** For `ambiguous_page`: how many pages matched; more than `candidates.length` when the list was cut */
  totalCandidates?: number;
}

/**
 * A topic's context as returned here. The nested `hasMore` / `warnings` /
 * `totals` of `buildContextForTopic` are not repeated: its advice names
 * `logseq_build_context` parameters, so it is rolled up into `warnings` below.
 */
export type TopicQueryContext = Omit<TopicContext, 'hasMore' | 'warnings' | 'totals'>;

export interface QueryContext {
  query: string;
  extractedTopics: string[];
  contexts: TopicQueryContext[];
  searchResults?: BlockEntity[];
  /** Always present; empty when nothing was skipped or cut */
  warnings: QueryWarning[];
  /** True when a warning says how to fetch what was cut */
  hasMore: boolean;
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
    /**
     * Add each keyword hit's page (`context.page`) in one extra batched query. For
     * output that names the page of a hit, such as Markdown (#43); JSON leaves it off.
     */
    hitPages?: boolean;
  } = {}
): Promise<QueryContext> {
  const { maxTopics = 5, maxSearchResults = 20, hitPages = false } = options;

  // Extract topics from query
  const extractedTopics = extractTopicsFromQuery(query);

  // Build context for each extracted topic
  const contexts: TopicQueryContext[] = [];
  const warnings: QueryWarning[] = [];

  if (extractedTopics.length > maxTopics) {
    warnings.push({
      code: 'topics_truncated',
      message: `Found ${extractedTopics.length} topics; only the first ${maxTopics} were used.`,
      howToFetchAll: `Set max_topics to ${extractedTopics.length} (or higher) to use all of them.`
    });
  }

  for (const topic of extractedTopics.slice(0, maxTopics)) {
    try {
      const context = await buildContextForTopic(client, topic, {
        maxBlocks: 10,
        maxRelatedPages: 5,
        maxReferences: 10
      });
      const { hasMore: _hasMore, warnings: _warnings, totals, ...topicContext } = context;
      contexts.push(topicContext);

      if (context.hasMore) {
        warnings.push({
          code: 'topic_truncated',
          topic,
          message:
            `Context for "${topic}" is capped: showing ${context.directBlocks.length}/${totals.blocks} blocks, ` +
            `${context.references.length}/${totals.references} references, ` +
            `${context.relatedPages.length}/${totals.relatedPages} related pages.`,
          howToFetchAll:
            `Call logseq_build_context with topic_name ${JSON.stringify(topic)} and raise ` +
            `max_blocks (${totals.blocks}), max_references (${totals.references}) and ` +
            `max_related_pages (${totals.relatedPages}).`
        });
      }
    } catch (error) {
      // A missing topic page is an expected partial result: skip it and say so.
      // Everything else (connection, timeout, auth, unexpected) propagates.
      if (error instanceof PageNotFoundError) {
        warnings.push({
          code: 'topic_not_found',
          topic,
          message: `No page found for topic "${topic}"; it was skipped.`
        });
        continue;
      }
      // An ambiguous topic is skipped the same way, but its candidates are kept
      // so the caller can retry logseq_build_context with the one it means.
      if (error instanceof AmbiguousPageError) {
        warnings.push({
          code: 'ambiguous_page',
          message: error.message,
          topic,
          candidates: error.candidates,
          totalCandidates: error.totalCandidates
        });
        // A cut list is reported by a warning, not by hasMore: no parameter fetches the rest
        if (error.truncationNote) {
          warnings.push({ code: 'candidates_truncated', topic, message: error.truncationNote });
        }
        continue;
      }
      throw error;
    }
  }

  // If no explicit topics, do a text search
  let searchResults: import('./search-blocks.js').SearchBlocksResult[] | undefined;

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

    // Search for blocks containing keywords using searchBlocks
    // Note: logseq.DB.q doesn't work via HTTP API, need to use HTTP methods
    if (keywords.length > 0) {
      // Import searchBlocks dynamically to search for keywords
      const { searchBlocks } = await import('./search-blocks.js');

      // Search for first keyword and filter results manually.
      // The search is the only data source on this path, so any failure
      // propagates: an empty result must mean "nothing matched".
      // Note: slimResults=false returns SearchBlocksResult[]
      const blocks = await searchBlocks(client, keywords[0], maxSearchResults * 3, hitPages, false);

      // A null response is a genuine "no matches"
      searchResults = (blocks || []).filter(block => {
        // Filter to blocks that contain all keywords
        const contentLower = block.content.toLowerCase();
        return keywords.every(k => contentLower.includes(k));
      }).slice(0, maxSearchResults) as import('./search-blocks.js').SearchBlocksResult[];
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
    warnings,
    hasMore: warnings.some(w => w.howToFetchAll !== undefined),
    summary: {
      totalTopics: contexts.length,
      totalBlocks,
      totalPages
    }
  };
}
