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
 * Said wherever a warning suggests a call whose result may be large. The server can't know
 * the host's inline limit (Claude Code saves a tool result of about 50,000 characters or
 * more to a file and shows only its first 2 KB; `context-efficiency.md` section 7), so it
 * says the risk exists and doesn't name a size (#187, #196).
 */
export const LARGE_RESULT_NOTE =
  "A result this large may be saved to a file by the host instead of shown; the server can't tell.";

/**
 * Rough counts of items that still come back inline, for the `inlineMax` of a warning
 * (#196). They are estimates, not limits: sized so the result is about 30,000-45,000
 * characters for typical items, from made-up journals with about 100 characters per
 * block (a slim block with its page name is about 210 characters, a backlink reference
 * about 260, a related page about 80, a network node with its edge about 125; a listed
 * page is a name of about 35 characters, so even 1000 fit and `list_pages` needs no entry). Longer blocks come back larger, which is why the note says "may".
 * 200 blocks is the cap `context-efficiency.md` section 7 recommends for a date range.
 */
export const INLINE_ITEMS = {
  /** Blocks (search hits, property matches, mentions, relationship blocks, a page's blocks) */
  blocks: 200,
  /** Backlink references: a block plus the page it sits on */
  references: 150,
  /** Related pages: a page and its direction */
  relatedPages: 500,
  /** Concept network nodes, each with its edges */
  networkNodes: 200
} as const;

/**
 * ` <LARGE_RESULT_NOTE>` when a call that returns `items` items goes past `inlineMax`
 * (the most that plausibly come back inline), else an empty string. Undefined
 * `inlineMax` means the caller makes no claim, so no note.
 */
export function largeResultNote(items: number, inlineMax?: number): string {
  return inlineMax !== undefined && items > inlineMax ? ` ${LARGE_RESULT_NOTE}` : '';
}

/**
 * Warning for a list cut at `cap` out of `total` items.
 * `param` is the MCP tool parameter (snake_case) that raises the cap.
 * `inlineMax` (#196): the most items that plausibly come back inline. A `total` above it
 * adds the note that the host may save such a result to a file.
 */
export function truncationWarning(
  what: string,
  shown: number,
  total: number,
  param: string,
  code = 'results_truncated',
  inlineMax?: number
): ResultWarning {
  return {
    code,
    message: `Showing ${shown} of ${total} ${what}.`,
    howToFetchAll: `Set ${param} to ${total} (or higher) to get all ${total}.${largeResultNote(total, inlineMax)}`
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
   * The most items of this list that plausibly come back inline (#196), an
   * `INLINE_ITEMS` value. A raise this warning suggests that returns more than that adds
   * `LARGE_RESULT_NOTE`. Leave it out when the maximum is small enough to always fit.
   */
  inlineMax?: number;
  /**
   * Paging, for a tool that also takes an offset (e.g. `list_pages`): `param` is the
   * paging parameter (`offset`) and `next` says how to fetch the next page, such as "Set
   * offset to 1000 for the next page." Paging leads `howToFetchAll` in every branch with
   * a cut (the raise of the cap follows it, in place of `narrower`) and is the whole of it
   * at the maximum, so `hasMore` stays true there (BR-0006). The message says the rest
   * can be paged through. Leave it out for an unpaged cap, or when the next page would
   * not move (a cap of 0).
   */
  paging?: { param: string; next: string };
}

/**
 * Warning for a list cut at `shown` of `total` items, where `param` can't go
 * above `max` (#61). The suggested value never points past the maximum:
 *
 * - `total <= max`: raise `param` to `total`, as `truncationWarning` does. With `paging`,
 *   the next page comes first and the raise is the alternative.
 * - `shown < max < total`: raise `param` to `max` for more. `hasMore` stays true, and
 *   `howToFetchAll` adds `narrower` for the rest. With `paging` it leads with the next page.
 * - `shown >= max`: the maximum was reached. Without `paging`, no parameter fetches
 *   the rest, so there is no `howToFetchAll` and `hasMore` is false; the warning is
 *   the signal (BR-0006). With `paging` (a paged tool), the next page is the `howToFetchAll`.
 *
 * A raise that `inlineMax` says may not come back inline adds `LARGE_RESULT_NOTE` (#196).
 * The raise stays in `howToFetchAll`: it is still the call that gets those items.
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
  inlineMax,
  paging
}: CappedTruncation): ResultWarning {
  const pagedHint = paging ? ` Page through the rest with ${paging.param}.` : '';
  if (total <= max) {
    if (paging === undefined) return truncationWarning(what, shown, total, param, code, inlineMax);
    return {
      code,
      message: `Showing ${shown} of ${total} ${what}.${pagedHint}`,
      howToFetchAll:
        `${paging.next} Or set ${param} to ${total} (or higher) to get all ${total} in one call.` +
        largeResultNote(total, inlineMax)
    };
  }
  if (shown < max) {
    const note = largeResultNote(max, inlineMax);
    return {
      code,
      message: `Showing ${shown} of ${total} ${what}.${pagedHint}`,
      howToFetchAll: paging
        ? `${paging.next} Or set ${param} to ${max} (the maximum) to get ${max} of ${total} in one call.${note}`
        : `Set ${param} to ${max} (the maximum) to get ${max} of ${total}.${note} ${narrower}`
    };
  }
  const clamped = requested !== undefined && requested > max ? ` (${requested} was asked for)` : '';
  const capped = `Showing ${shown} of ${total} ${what}: ${param} is capped at its maximum of ${max}${clamped}`;
  if (paging !== undefined) return { code, message: `${capped}.${pagedHint}`, howToFetchAll: paging.next };
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
