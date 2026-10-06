import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { BlockEntity, ResultMeta, SlimBlock } from '../types.js';
import { blocksInlineMax, buildResultMeta, cappedTruncationWarning } from '../utils/result-meta.js';
import { toSlimBlock } from '../utils/slim-entities.js';
import { camelizeBlock, camelizeKeys } from '../utils/block-tree.js';
import { pageDisplayName } from '../utils/entity-fields.js';

/** Blocks returned when `limit` is absent. */
export const DEFAULT_PROPERTY_LIMIT = 100;

/**
 * Most blocks one call returns (#61). A larger `limit` is clamped to it, and a cut at
 * the maximum is a `results_truncated` warning with no `howToFetchAll`.
 */
export const MAX_PROPERTY_LIMIT = 500;

/** The query takes only a key and an exact value, so nothing narrows it further. */
const NARROWER = 'No other parameter narrows this query.';

/**
 * Query blocks by a specific property name and value using one Datalog query
 *
 * Matching is done inside LogSeq against `:block/properties`:
 * - The property name may be written as stored (`created-at`) or as the Editor
 *   API returns it (`createdAt`); matching is on the normalized key.
 * - Scalars (string, number, boolean) match when `String(value) === propertyValue`.
 * - Multi-value properties (sets) match when any element equals `propertyValue`.
 *   Previously only the comma-joined string matched (`"a,b"`).
 *
 * Blocks come back flat, without `children` or `level` (the old crawl returned
 * tree nodes). Results are sorted by page id, then block id. Keys are
 * camelCase like the Editor API, and `page` carries `id`, `name` and
 * `originalName`.
 *
 * Blocks are cut to `limit` (default 100, at most 500) after the sort, so the cut keeps
 * the first ones in that order, which is not a ranking (#61). `queryByPropertyWithMeta`
 * reports the cut; this function returns the array alone.
 *
 * API calls: 1.
 *
 * @param client - LogseqClient instance
 * @param propertyName - Name of the property to query
 * @param propertyValue - Value to match for the property; a number or boolean is compared as `String(value)`
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only). Direct calls default to full (false); the MCP handler defaults to slim through its argument schema (#42, #60)
 * @param limit - Most blocks returned (default 100), floored and clamped to 0..500
 * @returns Array of BlockEntity or SlimBlock objects with matching property (empty if none), or null if the API returns a null response
 * @throws InvalidParameterError if the property name has characters other than letters, digits, "-" and "_"
 */
export async function queryByProperty(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string | number | boolean,
  slimResults: boolean = false,
  limit: number = DEFAULT_PROPERTY_LIMIT
): Promise<BlockEntity[] | SlimBlock[] | null> {
  return (await queryByPropertyWithMeta(client, propertyName, propertyValue, slimResults, limit)).results;
}

/**
 * Same query as `queryByProperty`, plus a ResultMeta (#61) when `limit` cut the list:
 * a `results_truncated` warning and `totals.matches`, the number of matching blocks
 * before the cut (known from the one query, so no extra call). `meta` is null when
 * everything fits, so output below the cap is unchanged, and when the API returned null.
 *
 * The warning never suggests a `limit` above 500. A cut at the maximum carries no
 * `howToFetchAll`, so `hasMore` is false there (BR-0006).
 */
export async function queryByPropertyWithMeta(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string | number | boolean,
  slimResults: boolean = false,
  limit: number = DEFAULT_PROPERTY_LIMIT
): Promise<{ results: BlockEntity[] | SlimBlock[] | null; meta: ResultMeta | null }> {
  const { query, inputs } = DatalogQueryBuilder.blocksByProperty(propertyName, propertyValue);
  const rows = await client.executeDatalogQuery<BlockEntity[][] | null>(query, ...inputs);

  if (!rows) {
    return { results: null, meta: null };
  }

  const matches: BlockEntity[] = rows
    .map(row => row[0])
    .filter(Boolean)
    .map(pulled => {
      const block = camelizeBlock(pulled);
      if (block.page && typeof block.page === 'object') {
        block.page = camelizeKeys(block.page);
      }
      return block;
    })
    .sort((a, b) => (a.page?.id ?? 0) - (b.page?.id ?? 0) || a.id - b.id);

  const kept = matches.slice(0, Math.min(Math.max(0, Math.floor(limit)), MAX_PROPERTY_LIMIT));
  const meta =
    kept.length < matches.length
      ? buildResultMeta(
          [
            cappedTruncationWarning({
              // Page id then block id is a stable order but no ranking, and no parameter resumes from it
              what: 'matching blocks (the first ones listed, not ranked)',
              shown: kept.length,
              total: matches.length,
              param: 'limit',
              max: MAX_PROPERTY_LIMIT,
              narrower: NARROWER,
              requested: limit,
              inlineMax: blocksInlineMax({ slim: slimResults })
            })
          ],
          { matches: matches.length }
        )
      : null;

  return { results: slimResults ? kept.map(block => toSlimBlock(block, pageDisplayName(block.page))) : kept, meta };
}
