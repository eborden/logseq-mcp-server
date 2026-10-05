import { ResultMeta, ResultWarning } from '../types.js';

/**
 * Build a ResultMeta. `hasMore` is derived from the warnings: it is true when
 * any warning offers a way to fetch the rest, so it can't be set without one.
 */
export function buildResultMeta(
  warnings: ResultWarning[],
  totals?: Record<string, number>
): ResultMeta {
  const meta: ResultMeta = {
    hasMore: warnings.some(w => w.howToFetchAll !== undefined),
    warnings
  };
  if (totals) meta.totals = totals;
  return meta;
}

/**
 * Warning for a list cut at `cap` out of `total` items.
 * `param` is the MCP tool parameter (snake_case) that raises the cap.
 */
export function truncationWarning(
  what: string,
  shown: number,
  total: number,
  param: string,
  code = 'results_truncated'
): ResultWarning {
  return {
    code,
    message: `Showing ${shown} of ${total} ${what}.`,
    howToFetchAll: `Set ${param} to ${total} (or higher) to get all ${total}.`
  };
}

/**
 * Extra MCP content blocks that carry `meta` for a tool whose result is a bare
 * array. The array stays the first block, unchanged; `{ "meta": ... }` follows
 * as a second block. Empty when there is no meta (e.g. a null API response).
 *
 * `tips` (#44) ride in the same block as `meta.tips`. Tools whose result is an
 * object, or has no meta at all, get a block holding only `{ "meta": { "tips": [...] } }`.
 * With neither meta nor tips there is no extra block.
 */
export function metaContent(
  meta: ResultMeta | Pick<ResultMeta, 'tips'> | null,
  tips: readonly string[] = []
): Array<{ type: 'text'; text: string }> {
  const merged = tips.length > 0 ? { ...meta, tips: [...tips] } : meta;
  return merged ? [{ type: 'text', text: JSON.stringify({ meta: merged }) }] : [];
}
