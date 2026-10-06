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

/** Arguments of `cappedTruncationWarning`. */
export interface CappedTruncation {
  /** What the list holds, plural: "matching blocks" */
  what: string;
  /** Items returned */
  shown: number;
  /** Items there were before the cap */
  total: number;
  /** The MCP tool parameter (snake_case) that sets the cap, e.g. `limit` */
  param: string;
  /** The parameter's hard maximum */
  max: number;
  /**
   * How to reach items past the maximum without paging, e.g. "Narrow the query to
   * see the rest." Left out when `next` is given, since paging reaches them.
   */
  narrower: string;
  /** The caller's value, named in the message when it was above `max` */
  requested?: number;
  /** Defaults to `results_truncated` */
  code?: string;
  /**
   * Paging hook, for a tool that also takes an offset (e.g. `list_pages`): how to
   * fetch the next page, such as "Set offset to 1000 for the next page." Every
   * branch with a cut offers it in `howToFetchAll`: after the advice to raise
   * `param` below the maximum (in place of `narrower`), and on its own at the
   * maximum, so `hasMore` stays true there (BR-0006). Leave it out for an
   * unpaged cap, or when the next page would not move (a cap of 0).
   */
  next?: string;
}

/**
 * Warning for a list cut at `shown` of `total` items, where `param` can't go
 * above `max` (#61). The suggested value never points past the maximum:
 *
 * - `total <= max`: the same warning as `truncationWarning` (raise `param` to `total`),
 *   followed by `next` when given.
 * - `shown < max < total`: raise `param` to `max` for more. `hasMore` stays true,
 *   and `howToFetchAll` adds `next` when given, else `narrower` for the rest.
 * - `shown >= max`: the maximum was reached. Without `next`, no parameter fetches
 *   the rest, so there is no `howToFetchAll` and `hasMore` is false; the warning is
 *   the signal (BR-0006). With `next` (a paged tool), `next` is the `howToFetchAll`.
 */
export function cappedTruncationWarning({
  what,
  shown,
  total,
  param,
  max,
  narrower,
  requested,
  code = 'results_truncated',
  next
}: CappedTruncation): ResultWarning {
  if (total <= max) {
    const warning = truncationWarning(what, shown, total, param, code);
    return next === undefined ? warning : { ...warning, howToFetchAll: `${warning.howToFetchAll} ${next}` };
  }
  if (shown < max) {
    return {
      code,
      message: `Showing ${shown} of ${total} ${what}.`,
      howToFetchAll: `Set ${param} to ${max} (the maximum) to get ${max} of ${total}. ${next ?? narrower}`
    };
  }
  const clamped = requested !== undefined && requested > max ? ` (${requested} was asked for)` : '';
  const capped = `Showing ${shown} of ${total} ${what}: ${param} is capped at its maximum of ${max}${clamped}`;
  if (next !== undefined) return { code, message: `${capped}.`, howToFetchAll: next };
  return { code, message: `${capped}, so the rest can't be fetched in one call. ${narrower}` };
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
