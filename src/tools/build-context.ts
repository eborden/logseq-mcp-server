import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity, ResultMeta, ResultWarning } from '../types.js';
import { buildResultMeta, truncationWarning } from '../utils/result-meta.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { getBacklinks } from './get-backlinks.js';
import { PageNotFoundError, isInfrastructureError } from '../errors.js';
import Fuzzysort from 'fuzzysort';

export interface ContextOptions {
  maxBlocks?: number;
  maxRelatedPages?: number;
  maxReferences?: number;
  includeTemporalContext?: boolean;
}

export interface TopicContext extends Omit<ResultMeta, 'totals'> {
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
  /**
   * Real counts before `maxBlocks` / `maxReferences` / `maxRelatedPages` were
   * applied (the `summary` totals count what is returned).
   */
  totals: {
    blocks: number;
    relatedPages: number;
    references: number;
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
  const page = DatalogQueryBuilder.getPage(topicName);
  const pageResults = await client.executeDatalogQuery<Array<[any]>>(page.query, ...page.inputs);

  // If no results, page doesn't exist - provide fuzzy match suggestions
  if (!pageResults || pageResults.length === 0) {
    // Get fuzzy match suggestions
    try {
      const allPages = await client.callAPI<PageEntity[]>('logseq.Editor.getAllPages', []);
      if (allPages && allPages.length > 0) {
        const matches = Fuzzysort.go(topicName, allPages, {
          key: 'originalName',
          limit: 3,
          threshold: -10000
        });
        const suggestions = matches.map(m => m.obj.originalName);
        throw new PageNotFoundError(topicName, suggestions);
      }
    } catch (error) {
      if (error instanceof PageNotFoundError || isInfrastructureError(error)) {
        throw error;
      }
      // Suggestions are best-effort: fall through to a plain PageNotFoundError
    }

    throw new PageNotFoundError(topicName);
  }

  const mainPage = pageResults[0][0];

  // Query 2: Get blocks for the page (may be empty)
  const blocks = DatalogQueryBuilder.getPageBlocks(topicName);
  const blockResults = await client.executeDatalogQuery<Array<[any]>>(blocks.query, ...blocks.inputs);

  // Extract blocks (empty array if no blocks exist)
  const allBlocks = (blockResults || [])
    .map(result => result[0])
    .filter(block => block != null);
  const directBlocks = allBlocks.slice(0, maxBlocks);

  // Query 3: Get reference blocks and derive related pages
  // Use HTTP API (getBacklinks) which correctly handles LogSeq's reference structure
  const allReferences: TopicContext['references'] = [];
  const allRelatedPages: TopicContext['relatedPages'] = [];
  const seenPageIds = new Set<number>();

  // null or [] means the page has no backlinks. A thrown error (connection,
  // timeout, auth, unexpected) must propagate rather than look like "none".
  const backlinks = await getBacklinks(client, topicName);
  if (backlinks && backlinks.length > 0) {
    // Each backlink is [sourcePage, blocks[]]
    // Note: sourcePage can be null for journal page entries
    for (const [sourcePage, blocks] of backlinks) {
      // For each block, extract the actual source page
      for (const block of blocks) {
        // Source page is either the tuple's first element or block.page
        const actualSourcePage = sourcePage || block.page;
        if (!actualSourcePage) continue;

        const sourcePageId = actualSourcePage.id || actualSourcePage['db/id'];

        // Add source page to related pages (inbound connection)
        if (sourcePageId && !seenPageIds.has(sourcePageId)) {
          seenPageIds.add(sourcePageId);
          allRelatedPages.push({
            page: actualSourcePage,
            relationshipType: 'inbound'
          });
        }

        allReferences.push({
          block,
          sourcePage: actualSourcePage
        });
      }
    }
  }

  // Everything is already in memory, so the totals cost no extra API call.
  const references = allReferences.slice(0, maxReferences);
  const relatedPages = allRelatedPages.slice(0, maxRelatedPages);

  const totals = {
    blocks: allBlocks.length,
    relatedPages: allRelatedPages.length,
    references: allReferences.length
  };

  const warnings: ResultWarning[] = [];
  if (totals.blocks > directBlocks.length) {
    warnings.push(truncationWarning('blocks', directBlocks.length, totals.blocks, 'max_blocks', 'blocks_truncated'));
  }
  if (totals.references > references.length) {
    warnings.push(truncationWarning('references', references.length, totals.references, 'max_references', 'references_truncated'));
  }
  if (totals.relatedPages > relatedPages.length) {
    warnings.push(truncationWarning('related pages', relatedPages.length, totals.relatedPages, 'max_related_pages', 'related_pages_truncated'));
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
    summary,
    ...buildResultMeta(warnings),
    totals
  };
}
