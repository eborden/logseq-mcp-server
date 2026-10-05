import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { BlockEntity, SlimBlock } from '../types.js';
import { toSlimBlock } from '../utils/slim-entities.js';
import { camelizeBlock, camelizeKeys } from '../utils/block-tree.js';

/** Page name used for slim output: original casing when known. */
function displayName(page: any): string {
  return page?.originalName || page?.name || '';
}

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
 * API calls: 1.
 *
 * @param client - LogseqClient instance
 * @param propertyName - Name of the property to query
 * @param propertyValue - Value to match for the property
 * @param slimResults - Return slim results (40-50% fewer tokens, essential data only)
 * @returns Array of BlockEntity or SlimBlock objects with matching property (empty if none), or null if the API returns a null response
 * @throws InvalidParameterError if the property name has characters other than letters, digits, "-" and "_"
 */
export async function queryByProperty(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string,
  slimResults: boolean = false
): Promise<BlockEntity[] | SlimBlock[] | null> {
  const { query, inputs } = DatalogQueryBuilder.blocksByProperty(propertyName, propertyValue);
  const rows = await client.executeDatalogQuery<BlockEntity[][] | null>(query, ...inputs);

  if (!rows) {
    return null;
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

  if (slimResults) {
    return matches.map(block => toSlimBlock(block, displayName(block.page)));
  }

  return matches;
}
