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
