import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

export interface EntityTimelineResult {
  entity: string;
  timeline: Array<{
    date: number | null; // journalDay format (YYYYMMDD) or null for non-journal
    block: BlockEntity;
  }>;
}

/**
 * Get timeline of blocks mentioning an entity
 * @param client - LogseqClient instance
 * @param entityName - Name of the entity (page name)
 * @param startDate - Optional start date (YYYYMMDD format)
 * @param endDate - Optional end date (YYYYMMDD format)
 * @returns EntityTimelineResult with blocks sorted by date
 */
export async function getEntityTimeline(
  client: LogseqClient,
  entityName: string,
  startDate?: number,
  endDate?: number
): Promise<EntityTimelineResult> {
  // Search for blocks containing the entity reference
  const searchQuery = `[[${entityName}]]`;
  const blocks = await client.callAPI<BlockEntity[]>(
    'logseq.DB.q',
    [`(page-property :title "${entityName}")`]
  );

  // Also get blocks that reference this page
  const referencingBlocks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [entityName]
  );

  // Combine and deduplicate blocks
  const allBlocks = [...(blocks || []), ...(referencingBlocks || [])];
  const uniqueBlocks = Array.from(
    new Map(allBlocks.map(b => [b.id, b])).values()
  );

  // Build timeline entries
  let timeline = uniqueBlocks
    .map(block => {
      // Type guard to check if page has journalDay property
      const page = block.page as PageEntity | undefined;
      return {
        date: page?.journalDay || null,
        block
      };
    })
    .filter(entry => {
      // Filter by date range if specified
      if (entry.date === null) return true; // Keep non-journal entries
      if (startDate && entry.date < startDate) return false;
      if (endDate && entry.date > endDate) return false;
      return true;
    });

  // Sort by date (earliest first, nulls last)
  timeline.sort((a, b) => {
    if (a.date === null && b.date === null) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date - b.date;
  });

  return {
    entity: entityName,
    timeline
  };
}
