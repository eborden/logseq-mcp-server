import { LogseqClient } from '../client.js';
import { PageLike, BlockEntity, ResultMeta, ResultWarning } from '../types.js';
import { blockPageId, entityId, journalDayOf, journalFlag } from '../utils/entity-fields.js';
import { buildResultMeta, truncationWarning } from '../utils/result-meta.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { fetchBacklinks } from './get-backlinks.js';
import {
  ResolvedAliases,
  aliasIds,
  aliasSetWarnings,
  hasAliases,
  resolveAliasSet,
  resolvedAliases
} from '../utils/alias-set.js';
import { requirePage, resolvedFrom, ResolvedFrom } from '../utils/resolve-page.js';

/** Defaults of {@link ContextOptions}, also advertised by `logseq_build_context` (#60). */
export const DEFAULT_MAX_BLOCKS = 50;
export const DEFAULT_MAX_RELATED_PAGES = 10;
export const DEFAULT_MAX_REFERENCES = 20;
export const DEFAULT_INCLUDE_TEMPORAL_CONTEXT = true;

export interface ContextOptions {
  maxBlocks?: number;
  maxRelatedPages?: number;
  maxReferences?: number;
  includeTemporalContext?: boolean;
  /**
   * Resolve `((uuid))` refs and `{{embed}}`s in `directBlocks` and the reference
   * blocks (adds `resolvedContent` / `resolvedRefs`; `content` is unchanged).
   * At most 2 extra Datalog queries, none when no block has a ref. Default false.
   */
  resolveRefs?: boolean;
}

export interface TopicContext extends Omit<ResultMeta, 'totals'>, ResolvedFrom, ResolvedAliases {
  topic: string;
  mainPage: PageLike;
  directBlocks: BlockEntity[];
  relatedPages: Array<{
    page: PageLike;
    relationshipType: 'outbound' | 'inbound';
  }>;
  references: Array<{
    block: BlockEntity;
    sourcePage: PageLike;
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
    pageProperties: Record<string, unknown>;
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
 * @param topicName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @param options - Options for context building
 * @returns TopicContext with all relevant information
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function buildContextForTopic(
  client: LogseqClient,
  topicName: string,
  options: ContextOptions = {}
): Promise<TopicContext> {
  const {
    maxBlocks = DEFAULT_MAX_BLOCKS,
    maxRelatedPages = DEFAULT_MAX_RELATED_PAGES,
    maxReferences = DEFAULT_MAX_REFERENCES,
    includeTemporalContext = DEFAULT_INCLUDE_TEMPORAL_CONTEXT,
    resolveRefs = false
  } = options;

  // Query 1: Resolve the main page (exact name, alias or ISO date, in one query).
  // Throws PageNotFoundError (with suggestions) or AmbiguousPageError (with candidates).
  const resolved = await requirePage(client, topicName);
  const mainPage = resolved.page;
  const lookupName = resolved.lookupName;

  // The names this page goes by (#69): a page with no `alias::` costs no call here
  const aliasSet = await resolveAliasSet(client, mainPage);
  const aliased = hasAliases(aliasSet);

  // Query 2: Get blocks for the page, or for every page of its alias group (may be empty)
  const blocks = aliased
    ? DatalogQueryBuilder.getBlocksOnPages(aliasIds(aliasSet))
    : DatalogQueryBuilder.getPageBlocks(lookupName);
  const blockResults = await client.executeDatalogQuery<Array<[BlockEntity]> | null>(blocks.query, ...blocks.inputs);

  // Extract blocks (empty array if no blocks exist). For an alias group the
  // page asked about comes first, so a cap keeps its own blocks before the aliases'.
  const fetchedBlocks = (blockResults || [])
    .map(result => result[0])
    .filter(block => block != null);
  const mainPageId = entityId(mainPage);
  const allBlocks = aliased
    ? [
        ...fetchedBlocks.filter(block => blockPageId(block) === mainPageId),
        ...fetchedBlocks.filter(block => blockPageId(block) !== mainPageId)
      ]
    : fetchedBlocks;
  let directBlocks = allBlocks.slice(0, maxBlocks);

  // Query 3: Get reference blocks and derive related pages
  // Use HTTP API (getBacklinks) which correctly handles LogSeq's reference structure
  const allReferences: TopicContext['references'] = [];
  const allRelatedPages: TopicContext['relatedPages'] = [];
  const seenPageIds = new Set<number>();

  // null or [] means the page has no backlinks. A thrown error (connection,
  // timeout, auth, unexpected) must propagate rather than look like "none".
  const backlinks = await fetchBacklinks(client, lookupName, aliasSet);
  if (backlinks && backlinks.length > 0) {
    // Each backlink is [sourcePage, blocks[]]
    // Note: sourcePage can be null for journal page entries
    for (const [sourcePage, blocks] of backlinks) {
      // For each block, extract the actual source page
      for (const block of blocks) {
        // Source page is either the tuple's first element or block.page
        const actualSourcePage = sourcePage || block.page;
        if (!actualSourcePage) continue;

        const sourcePageId = entityId(actualSourcePage);

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
  let references = allReferences.slice(0, maxReferences);
  const relatedPages = allRelatedPages.slice(0, maxRelatedPages);

  const totals = {
    blocks: allBlocks.length,
    relatedPages: allRelatedPages.length,
    references: allReferences.length
  };

  const warnings: ResultWarning[] = [...aliasSetWarnings(aliasSet)];
  if (totals.blocks > directBlocks.length) {
    warnings.push(truncationWarning('blocks', directBlocks.length, totals.blocks, 'max_blocks', 'blocks_truncated'));
  }
  if (totals.references > references.length) {
    warnings.push(truncationWarning('references', references.length, totals.references, 'max_references', 'references_truncated'));
  }
  if (totals.relatedPages > relatedPages.length) {
    warnings.push(truncationWarning('related pages', relatedPages.length, totals.relatedPages, 'max_related_pages', 'related_pages_truncated'));
  }

  // Opt-in (#18): one resolver pass over the blocks that are actually returned
  if (resolveRefs) {
    const resolved = await resolveBlockRefs(client, [
      ...directBlocks,
      ...references.map(reference => reference.block)
    ]);
    const direct = resolved.blocks.slice(0, directBlocks.length);
    const referenced = resolved.blocks.slice(directBlocks.length);
    directBlocks = direct;
    references = references.map((reference, i) => ({ ...reference, block: referenced[i] }));
    warnings.push(...resolved.warnings);
  }

  // Build temporal context if requested. The page is a Datalog pull (`journal?`, `journal-day`),
  // and the readers accept the Editor API's spelling too (#152).
  let temporalContext: TopicContext['temporalContext'] | undefined;
  if (includeTemporalContext) {
    temporalContext = journalFlag(mainPage) === true
      ? { isJournal: true, date: journalDayOf(mainPage) }
      : { isJournal: false };
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
    ...resolvedFrom(topicName, resolved),
    ...resolvedAliases(aliasSet),
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
