import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';

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
 * Build comprehensive context for a topic
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

  // Get main page
  const mainPage = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [topicName]
  );

  if (mainPage === null) {
    throw new Error(`Page not found: ${topicName}`);
  }

  // Get direct blocks from the page
  const allBlocks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [topicName]
  );

  const directBlocks = (allBlocks || []).slice(0, maxBlocks);

  // Get related pages (outbound references) - pages this page links to
  const outboundRefs = await client.callAPI<PageEntity[]>(
    'logseq.Editor.getPageLinkedReferences',
    [topicName]
  );

  // Get backlinks (inbound references) - blocks/pages that link to this page
  const backlinks = await client.callAPI<[BlockEntity, PageEntity][] | null>(
    'logseq.Editor.getPageLinkedReferences',
    [topicName]
  );

  const relatedPages: TopicContext['relatedPages'] = [];
  const seenPageIds = new Set<number>([mainPage.id]);

  // Add outbound references
  for (const page of (outboundRefs || []).slice(0, Math.floor(maxRelatedPages / 2))) {
    if (!seenPageIds.has(page.id)) {
      seenPageIds.add(page.id);
      relatedPages.push({
        page,
        relationshipType: 'outbound'
      });
    }
  }

  // Add inbound references from unique pages
  const inboundPages = new Map<number, PageEntity>();
  if (backlinks) {
    for (const [block, page] of backlinks) {
      if (page && !seenPageIds.has(page.id)) {
        inboundPages.set(page.id, page);
      }
    }
  }

  for (const [_, page] of Array.from(inboundPages.entries()).slice(0, Math.floor(maxRelatedPages / 2))) {
    seenPageIds.add(page.id);
    relatedPages.push({
      page,
      relationshipType: 'inbound'
    });
  }

  // Get reference blocks (blocks that mention this topic)
  const references: TopicContext['references'] = [];
  if (backlinks) {
    for (const [block, sourcePage] of backlinks.slice(0, maxReferences)) {
      references.push({
        block,
        sourcePage
      });
    }
  }

  // Build temporal context for journal pages
  let temporalContext: TopicContext['temporalContext'] | undefined;

  if (includeTemporalContext && mainPage.journal) {
    temporalContext = {
      isJournal: true,
      date: mainPage.journalDay
    };

    // Get nearby dates (±3 days)
    if (mainPage.journalDay) {
      const nearbyDates: Array<{ date: number; pageName: string }> = [];
      const baseDate = mainPage.journalDay;

      for (let offset = -3; offset <= 3; offset++) {
        if (offset === 0) continue;

        // Simple date arithmetic (ignores month boundaries for simplicity)
        const nearDate = baseDate + offset;

        try {
          const nearPage = await client.callAPI<PageEntity | null>(
            'logseq.Editor.getPage',
            [nearDate.toString()]
          );

          if (nearPage) {
            nearbyDates.push({
              date: nearDate,
              pageName: nearPage.name
            });
          }
        } catch {
          // Page doesn't exist, skip
        }
      }

      temporalContext.nearbyDates = nearbyDates;
    }
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
