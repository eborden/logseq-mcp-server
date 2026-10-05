import { LogseqClient } from '../client.js';
import { BlockEntity, PageResolvedFrom, ResultMeta, ResultWarning } from '../types.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { requirePage, resolvedFromInfo, ResolvedPage } from '../utils/resolve-page.js';
import { isInfrastructureError } from '../errors.js';

export type RelationshipType =
  | 'references' // Blocks about topicA that reference topicB
  | 'referenced-by' // Blocks about topicA in pages referenced by topicB
  | 'in-pages-linking-to' // Blocks about topicA in pages that link to topicB
  | 'connected-within'; // Topics connected within N hops

export interface SearchByRelationshipResult extends ResultMeta {
  query: {
    topicA: string;
    topicB: string;
    relationshipType: RelationshipType;
    maxDistance?: number;
  };
  relationshipType: RelationshipType;
  /**
   * Present when a topic was an alias, date or namespace leaf rather than an
   * exact name: says which page that topic stood for. Keyed by the topic that
   * was redirected; absent when both topics were exact names.
   */
  resolvedFrom?: { topicA?: PageResolvedFrom; topicB?: PageResolvedFrom };
  results: BlockEntity[];
}

/**
 * Most pages expanded in one `connected-within` hop. Journal pages link to
 * almost everything, so the frontier can grow into the thousands; each hop
 * embeds its ids in one query.
 */
export const DEFAULT_MAX_FRONTIER = 500;

export interface SearchByRelationshipOptions {
  /** Cap on pages expanded per `connected-within` hop (default 500) */
  maxFrontier?: number;
}

/** Unwrap `[[block], ...]` Datalog rows; a null result means no rows. */
function extractBlocks(rows: Array<[BlockEntity]> | null): BlockEntity[] {
  return (rows || []).map(row => row[0]).filter(block => block != null);
}

/**
 * Resolve both topics at once. The same name (ignoring case and surrounding
 * whitespace) is resolved once. When both fail, the error is deterministic:
 * a connection, timeout or auth error first, then topicA's, then topicB's,
 * whichever request happened to finish first.
 */
async function resolveTopics(
  client: LogseqClient,
  topicA: string,
  topicB: string
): Promise<[ResolvedPage, ResolvedPage]> {
  const sameName = topicA.trim().toLowerCase() === topicB.trim().toLowerCase();
  const [a, b] = await Promise.allSettled([
    requirePage(client, topicA),
    sameName ? Promise.resolve(undefined) : requirePage(client, topicB)
  ]);

  const failures = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const infrastructure = failures.find(r => isInfrastructureError(r.reason));
  if (infrastructure) throw infrastructure.reason;
  if (failures.length > 0) throw failures[0].reason;

  const resolvedA = (a as PromiseFulfilledResult<ResolvedPage>).value;
  return [resolvedA, sameName ? resolvedA : (b as PromiseFulfilledResult<ResolvedPage>).value];
}

/**
 * Search for blocks based on relationship between topics
 * @param client - LogseqClient instance
 * @param topicA - Primary topic to search for (page name, alias or ISO date)
 * @param topicB - Related topic that defines the relationship (page name, alias or ISO date)
 * @param relationshipType - Type of relationship to search
 * @param maxDistance - Maximum graph distance (for connected-within)
 * @param options - `maxFrontier`: cap on pages expanded per hop. When a hop is
 *   cut and the other topic is not found, a `frontier_truncated` warning says
 *   the "not connected" answer may be a false negative. A found connection is
 *   always real.
 * @returns SearchByRelationshipResult with matching blocks
 * @throws PageNotFoundError if a topic matches no page (guidance with the closest names)
 * @throws AmbiguousPageError if a topic matches several pages (with the candidates)
 */
export async function searchByRelationship(
  client: LogseqClient,
  topicA: string,
  topicB: string,
  relationshipType: RelationshipType,
  maxDistance: number = 2,
  options: SearchByRelationshipOptions = {}
): Promise<SearchByRelationshipResult> {
  const { maxFrontier = DEFAULT_MAX_FRONTIER } = options;
  let results: BlockEntity[] = [];
  const warnings: ResultWarning[] = [];

  // Resolve both topics first (exact name, alias or ISO date: one query each), in
  // parallel and, when both topics are the same name, once. A topic that matches no
  // page or several pages throws PageNotFoundError or AmbiguousPageError instead of
  // quietly returning nothing.
  const [resolvedA, resolvedB] = await resolveTopics(client, topicA, topicB);
  const nameA = resolvedA.lookupName;
  const nameB = resolvedB.lookupName;

  switch (relationshipType) {
    case 'references': {
      // Blocks on topicA's page whose :block/refs include topicB's page.
      // Matching on refs (not content) is case-insensitive and covers
      // [[link]], #tag, #[[multi word]] and uuid-style refs.
      const { query, inputs } = DatalogQueryBuilder.blocksOnPageReferencing(nameA, nameB);
      results = extractBlocks(await client.executeDatalogQuery<Array<[BlockEntity]>>(query, ...inputs));
      break;
    }

    // Both types run the same query: blocks that reference topicA, on pages
    // that also hold a block referencing topicB. (`referenced-by` is
    // documented as "pages referenced by topicB" but has always implemented
    // this inbound reading; that mismatch is unchanged here.)
    case 'referenced-by':
    case 'in-pages-linking-to': {
      const { query, inputs } = DatalogQueryBuilder.blocksReferencingInPagesLinking(nameA, nameB);
      results = extractBlocks(await client.executeDatalogQuery<Array<[BlockEntity]>>(query, ...inputs));
      break;
    }

    case 'connected-within': {
      // The ids come from the resolved pages, so no further lookups are needed
      const idA: number | undefined = resolvedA.page?.id;
      const idB: number | undefined = resolvedB.page?.id;

      if (idA !== undefined && idB !== undefined) {
        // Level-synchronous BFS: one query per hop covers the whole frontier,
        // in both link directions, so the cost is O(maxDistance) calls.
        const visited = new Set<number>([idA]);
        let frontier = [idA];
        let found = false;
        let cutAtDepth: { depth: number; reached: number } | null = null;

        for (let depth = 1; depth <= maxDistance && frontier.length > 0 && !found; depth++) {
          if (frontier.length > maxFrontier) {
            // Deterministic cut: lowest ids (oldest pages) first
            cutAtDepth ??= { depth, reached: frontier.length };
            frontier = [...frontier].sort((a, b) => a - b).slice(0, maxFrontier);
          }
          const { query, inputs } = DatalogQueryBuilder.neighborPages(frontier);
          const rows = await client.executeDatalogQuery<Array<[number]>>(query, ...inputs);
          const neighborIds = (rows || []).map(row => row[0]);

          if (neighborIds.includes(idB)) {
            found = true;
            break;
          }

          frontier = [];
          for (const id of neighborIds) {
            if (!visited.has(id)) {
              visited.add(id);
              frontier.push(id);
            }
          }
        }

        if (!found && cutAtDepth) {
          warnings.push({
            code: 'frontier_truncated',
            message:
              `Hop ${cutAtDepth.depth} reached ${cutAtDepth.reached} pages; only ${maxFrontier} were expanded, ` +
              'so "not connected" may be a false negative. Try a smaller max_distance or more specific topics.'
          });
        }

        // If connected, return blocks from both topics
        if (found) {
          const blocksA = await client.callAPI<BlockEntity[]>(
            'logseq.Editor.getPageBlocksTree',
            [nameA]
          );
          const blocksB = await client.callAPI<BlockEntity[]>(
            'logseq.Editor.getPageBlocksTree',
            [nameB]
          );

          results = [...(blocksA || []), ...(blocksB || [])];
        }
      }
      break;
    }
  }

  const fromA = resolvedFromInfo(topicA, resolvedA);
  const fromB = resolvedFromInfo(topicB, resolvedB);

  return {
    query: {
      topicA,
      topicB,
      relationshipType,
      maxDistance: relationshipType === 'connected-within' ? maxDistance : undefined
    },
    relationshipType,
    ...(fromA || fromB ? { resolvedFrom: { ...(fromA && { topicA: fromA }), ...(fromB && { topicB: fromB }) } } : {}),
    results,
    ...buildResultMeta(warnings)
  };
}
