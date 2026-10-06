import { LogseqClient } from '../client.js';
import { BlockEntity, PageResolvedFrom, ResultMeta, ResultWarning } from '../types.js';
import { buildResultMeta, cappedTruncationWarning, INLINE_ITEMS } from '../utils/result-meta.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { requirePage, resolvedFromInfo, ResolvedPage } from '../utils/resolve-page.js';
import { isInfrastructureError } from '../errors.js';
import { countBlocks, takeBlocks } from '../utils/block-budget.js';
import {
  aliasIds,
  aliasSetWarnings,
  hasAliases,
  resolveAliasSets,
  resolvedAliases
} from '../utils/alias-set.js';
import { callParsed, queryParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

export type RelationshipType =
  | 'references' // Blocks about topicA that reference topicB
  | 'referenced-by' // Blocks about topicA in pages referenced by topicB
  | 'in-pages-linking-to' // Blocks about topicA in pages that link to topicB
  | 'connected-within'; // Topics connected within N hops

/** Every {@link RelationshipType}, in the order `relationship_type` advertises them. */
export const RELATIONSHIP_TYPES = [
  'references',
  'referenced-by',
  'in-pages-linking-to',
  'connected-within',
] as const satisfies readonly RelationshipType[];

/**
 * Compile-time check that {@link RELATIONSHIP_TYPES} lists every {@link RelationshipType}.
 * `satisfies` only checks that each entry is valid. A member left out of the list
 * becomes the type argument here, which fails `extends never`, so tsc fails.
 */
type EveryMemberListed<Missing extends never> = Missing;
export type RelationshipTypesComplete = EveryMemberListed<
  Exclude<RelationshipType, (typeof RELATIONSHIP_TYPES)[number]>
>;

/** Hops `connected-within` walks when `max_distance` is absent. */
export const DEFAULT_MAX_DISTANCE = 2;

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
  /**
   * Present when a topic has aliases (#69): the original-case names whose
   * references were matched, keyed by topic. A topic without aliases is absent.
   */
  resolvedAliases?: { topicA?: string[]; topicB?: string[] };
  results: BlockEntity[];
}

/**
 * Most pages expanded in one `connected-within` hop. Journal pages link to
 * almost everything, so the frontier can grow into the thousands; each hop
 * embeds its ids in one query.
 */
export const DEFAULT_MAX_FRONTIER = 500;

/** Entries in `results` when `limit` is absent (#61). */
export const DEFAULT_RELATIONSHIP_LIMIT = 50;

/**
 * Most entries `results` holds, whatever `limit` asks for (#61). A cut at the maximum is a
 * `results_truncated` warning with no `howToFetchAll`, and `hasMore` stays false.
 */
export const MAX_RELATIONSHIP_LIMIT = 500;

/**
 * No parameter reaches past the cut: the topics and the type fix the query, and `max_distance`
 * only decides whether `connected-within` finds a connection, not how many blocks it returns.
 */
const NARROWER = 'No other parameter narrows this query.';

export interface SearchByRelationshipOptions {
  /** Cap on pages expanded per `connected-within` hop (default 500) */
  maxFrontier?: number;
  /**
   * Most entries in `results` (default 50), floored and clamped to 0..500. A cut is reported
   * as a `results_truncated` warning with `totals.blocks`, the count before the cut, in the
   * cap's unit: one per result for the Datalog types, every block of the two pages' trees,
   * nested ones included, for `connected-within` (#61, #183).
   */
  limit?: number;
}

/**
 * What the cut list holds, for the warning. The Datalog types return matching blocks in
 * LogSeq's order, which is not a ranking. `connected-within` has its own wording, below.
 */
const MATCHING_BLOCKS = 'matching blocks (the first ones listed, not ranked)';

/** What a cut `connected-within` kept from each topic's page tree, in blocks, nested ones included. */
interface TopicCounts {
  keptA: number;
  keptB: number;
  totalA: number;
  totalB: number;
  /** A kept block lost some of its children (it carries `childrenTruncated`) */
  partialBlock: boolean;
}

/**
 * `what` for a cut `connected-within`: the unit (every block of the two pages' trees, nested
 * ones too, in document order, topic A's page first), how many kept blocks came from each topic
 * and how many each page has, so a reader can see when topic B's blocks were dropped entirely,
 * and whether a kept block lost children. All of it is known from the two tree calls, so this
 * costs nothing.
 */
const connectedWithinEntries = ({ keptA, keptB, totalA, totalB, partialBlock }: TopicCounts) =>
  'blocks of the two pages, nested ones counted ' +
  `(kept ${keptA} from topic A and ${keptB} from topic B, of ${totalA} and ${totalB}; ` +
  "topic A's first, then topic B's" +
  (partialBlock ? '; a kept block shows fewer children than it has (childrenTruncated)' : '') +
  ')';

/** Unwrap `[[block], ...]` Datalog rows; a null result means no rows. */
function extractBlocks(rows: ReadonlyArray<readonly [BlockEntity | null, ...unknown[]]> | null): BlockEntity[] {
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
 * @param options - `limit`: most entries in `results` (default 50, at most 500). `results` is
 *   cut to it after the query, so the cost in API calls is unchanged. The cut keeps the first
 *   entries in the order they come: LogSeq's own for the Datalog types, which is not a ranking.
 *   `connected-within` counts every block of the two pages' trees, nested ones too, in document
 *   order, topic A's page first, and cuts subtrees at the limit: a kept block that lost
 *   children has `childrenTruncated: true` (#183). The warning is merged with the others.
 *   `maxFrontier`: cap on pages expanded per hop. When a hop is
 *   cut and the other topic is not found, a `frontier_truncated` warning says
 *   the "not connected" answer may be a false negative. A found connection is
 *   always real. Two names of one page (the same name twice, or a page and its alias)
 *   are not a connection: no walk, no results and a `same_topic` warning.
 * @returns SearchByRelationshipResult with matching blocks. A topic with aliases matches
 *   references written under any of its names (`resolvedAliases` says which); this costs
 *   one extra query for both topics together, and none when neither has an alias.
 * @throws PageNotFoundError if a topic matches no page (guidance with the closest names)
 * @throws AmbiguousPageError if a topic matches several pages (with the candidates)
 */
export async function searchByRelationship(
  client: LogseqClient,
  topicA: string,
  topicB: string,
  relationshipType: RelationshipType,
  maxDistance: number = DEFAULT_MAX_DISTANCE,
  options: SearchByRelationshipOptions = {}
): Promise<SearchByRelationshipResult> {
  const { maxFrontier = DEFAULT_MAX_FRONTIER, limit = DEFAULT_RELATIONSHIP_LIMIT } = options;
  let results: BlockEntity[] = [];
  // Each topic's page tree, for a `connected-within` that found a connection
  let trees: { a: BlockEntity[]; b: BlockEntity[] } | null = null;
  const warnings: ResultWarning[] = [];

  // Resolve both topics first (exact name, alias or ISO date: one query each), in
  // parallel and, when both topics are the same name, once. A topic that matches no
  // page or several pages throws PageNotFoundError or AmbiguousPageError instead of
  // quietly returning nothing.
  const [resolvedA, resolvedB] = await resolveTopics(client, topicA, topicB);
  const nameA = resolvedA.lookupName;
  const nameB = resolvedB.lookupName;

  // The names each topic goes by (#69): one query for both, none when neither has an alias
  const [setA, setB] = await resolveAliasSets(client, [resolvedA.page, resolvedB.page]);
  const sameTopicPage = resolvedA.page?.id === resolvedB.page?.id;
  warnings.push(...aliasSetWarnings(setA, ...(sameTopicPage ? [] : [setB])));

  switch (relationshipType) {
    case 'references': {
      // Blocks on topicA's page whose :block/refs include topicB's page.
      // Matching on refs (not content) is case-insensitive and covers
      // [[link]], #tag, #[[multi word]] and uuid-style refs.
      const { query, inputs } =
        hasAliases(setA) || hasAliases(setB)
          ? DatalogQueryBuilder.blocksOnPagesReferencingIds(aliasIds(setA), aliasIds(setB))
          : DatalogQueryBuilder.blocksOnPageReferencing(nameA, nameB);
      results = extractBlocks(await queryParsed(client, responses.nullableBlockRows, query, ...inputs));
      break;
    }

    // Both types run the same query: blocks that reference topicA, on pages
    // that also hold a block referencing topicB. (`referenced-by` is
    // documented as "pages referenced by topicB" but has always implemented
    // this inbound reading; that mismatch is unchanged here.)
    case 'referenced-by':
    case 'in-pages-linking-to': {
      const { query, inputs } =
        hasAliases(setA) || hasAliases(setB)
          ? DatalogQueryBuilder.blocksReferencingInPagesLinkingIds(aliasIds(setA), aliasIds(setB))
          : DatalogQueryBuilder.blocksReferencingInPagesLinking(nameA, nameB);
      results = extractBlocks(await queryParsed(client, responses.nullableBlockRows, query, ...inputs));
      break;
    }

    case 'connected-within': {
      // The ids come from the resolved pages and their alias groups, so no further lookups
      // are needed. Every name of a topic counts as that topic: the walk starts from all of
      // A's names and ends at any of B's.
      const idA: number | undefined = resolvedA.page?.id;
      const idB: number | undefined = resolvedB.page?.id;
      const seedIds = idA === undefined ? [] : hasAliases(setA) ? aliasIds(setA) : [idA];

      if (idB !== undefined && seedIds.includes(idB)) {
        // Both topics are names of one page (the same name, or a page and its alias). There
        // is nothing to connect, and a walk would "find" the page again through its own
        // links (the `alias::` block refs the alias stub), so say so instead of walking.
        warnings.push({
          code: 'same_topic',
          message:
            `"${topicA}" and "${topicB}" are names of the same page, so connected-within has nothing to connect. ` +
            'Ask about two different pages.'
        });
      } else if (idA !== undefined && idB !== undefined) {
        const visited = new Set<number>(seedIds);
        // Any name of B ends the walk, except names B shares with A: the walk starts there,
        // so reaching them proves nothing. B's own page is never one of them (checked above).
        const targetIds = new Set(
          [idB, ...(hasAliases(setB) ? aliasIds(setB) : [])].filter(id => !visited.has(id))
        );
        // Level-synchronous BFS: one query per hop covers the whole frontier,
        // in both link directions, so the cost is O(maxDistance) calls.
        let frontier = seedIds;
        let found = false;
        let cutAtDepth: { depth: number; reached: number } | null = null;

        for (let depth = 1; depth <= maxDistance && frontier.length > 0 && !found; depth++) {
          if (frontier.length > maxFrontier) {
            // Deterministic cut: lowest ids (oldest pages) first
            cutAtDepth ??= { depth, reached: frontier.length };
            frontier = [...frontier].sort((a, b) => a - b).slice(0, maxFrontier);
          }
          const { query, inputs } = DatalogQueryBuilder.neighborPages(frontier);
          const rows = await queryParsed(client, responses.idRows, query, ...inputs);
          const neighborIds = (rows || []).map(row => row[0]);

          if (neighborIds.some(id => targetIds.has(id))) {
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
          const blocksA = await callParsed(client, responses.blocks, 'logseq.Editor.getPageBlocksTree', [nameA]);
          const blocksB = await callParsed(client, responses.blocks, 'logseq.Editor.getPageBlocksTree', [nameB]);

          trees = { a: blocksA || [], b: blocksB || [] };
          results = [...trees.a, ...trees.b];
        }
      }
      break;
    }
  }

  // Cut after the walk and the queries, so the cut costs no call. Its warning follows the others.
  const cap = Math.min(Math.max(0, Math.floor(limit)), MAX_RELATIONSHIP_LIMIT);
  let kept = results;
  let cut = false;
  let totalBlocks = results.length;
  if (trees) {
    // `connected-within` counts every block of the two trees, nested ones too, in document
    // order (topic A's page, then B's), so the result is bounded however deep the trees run
    // (#183). At or below the cap `results` goes out as it came, untouched.
    const totalA = countBlocks(trees.a);
    const totalB = countBlocks(trees.b);
    totalBlocks = totalA + totalB;
    if (totalBlocks > cap) {
      cut = true;
      // One budget over both trees, so the cut falls where one pass over A then B would put it
      const budget = { room: cap, partial: false };
      const keptA = takeBlocks(trees.a, budget);
      const keptB = takeBlocks(trees.b, budget);
      kept = [...keptA, ...keptB];
      const keptCountA = countBlocks(keptA);
      warnings.push(
        cappedTruncationWarning({
          what: connectedWithinEntries({
            keptA: keptCountA,
            keptB: cap - keptCountA,
            totalA,
            totalB,
            partialBlock: budget.partial
          }),
          shown: cap,
          total: totalBlocks,
          param: 'limit',
          max: MAX_RELATIONSHIP_LIMIT,
          narrower: NARROWER,
          requested: limit,
          inlineMax: INLINE_ITEMS.blocks
        })
      );
    }
  } else if (results.length > cap) {
    cut = true;
    kept = results.slice(0, cap);
    warnings.push(
      cappedTruncationWarning({
        what: MATCHING_BLOCKS,
        shown: kept.length,
        total: results.length,
        param: 'limit',
        max: MAX_RELATIONSHIP_LIMIT,
        narrower: NARROWER,
        requested: limit,
        inlineMax: INLINE_ITEMS.blocks
      })
    );
  }

  const fromA = resolvedFromInfo(topicA, resolvedA);
  const fromB = resolvedFromInfo(topicB, resolvedB);
  const aliasesA = resolvedAliases(setA).resolvedAliases;
  const aliasesB = resolvedAliases(setB).resolvedAliases;

  return {
    query: {
      topicA,
      topicB,
      relationshipType,
      maxDistance: relationshipType === 'connected-within' ? maxDistance : undefined
    },
    relationshipType,
    ...(fromA || fromB ? { resolvedFrom: { ...(fromA && { topicA: fromA }), ...(fromB && { topicB: fromB }) } } : {}),
    ...(aliasesA || aliasesB
      ? { resolvedAliases: { ...(aliasesA && { topicA: aliasesA }), ...(aliasesB && { topicB: aliasesB }) } }
      : {}),
    results: kept,
    ...buildResultMeta(warnings, cut ? { blocks: totalBlocks } : undefined)
  };
}
