import { LogseqClient } from '../client.js';
import { PageEntity, ResultMeta, ResultWarning } from '../types.js';
import { buildResultMeta, cappedTruncationWarning } from '../utils/result-meta.js';

/** Pages returned when `limit` is absent (#61). */
export const DEFAULT_LIST_PAGES_LIMIT = 200;

/**
 * Most pages one MCP call returns (#61). A larger `limit` is clamped to it, as
 * `limit` on logseq_search_blocks is. `offset` reaches the pages past it, so a
 * cut at the maximum still has a `howToFetchAll` (the next offset).
 */
export const MAX_LIST_PAGES_LIMIT = 1000;

/** Pages skipped when `offset` is absent. */
export const DEFAULT_LIST_PAGES_OFFSET = 0;

/**
 * `hasMore` and `warnings` are present only when LogSeq returned no page list
 * (`null`) or `limit` cut the list, see {@link listPages}. A result that holds
 * every matching page from `offset` on, including a genuinely empty graph,
 * carries neither.
 */
export interface ListPagesResult extends Partial<Pick<ResultMeta, 'hasMore' | 'warnings'>> {
  pages: string[];
  /** Every matching page, before `offset` and `limit` */
  total: number;
}

export interface ListPagesOptions {
  nameContains?: string;
  /** Pages to return, clamped to 0..`MAX_LIST_PAGES_LIMIT` and floored */
  limit?: number;
  /** Matching pages to skip first, in name order, floored at 0 */
  offset?: number;
}

/**
 * Non-journal page names in name order, `offset` pages in, at most `limit` of
 * them (#61). `total` counts every matching page, whatever `offset` and `limit`
 * are. When pages remain after the ones returned, a `pages_truncated` warning
 * says how to get them: raise `limit` when that fits under the maximum, and
 * set `offset` to the next page in any case, so `hasMore` is true. One API call
 * whatever the values: `getAllPages` returns every page, and the window is cut
 * here.
 */
export async function listPages(
  client: LogseqClient,
  options: ListPagesOptions = {}
): Promise<ListPagesResult> {
  const { nameContains } = options;
  const requested = Math.floor(options.limit ?? DEFAULT_LIST_PAGES_LIMIT);
  const limit = Math.min(Math.max(0, requested), MAX_LIST_PAGES_LIMIT);
  const offset = Math.max(0, Math.floor(options.offset ?? DEFAULT_LIST_PAGES_OFFSET));

  const allPages = await client.callAPI<PageEntity[] | null>(
    'logseq.Editor.getAllPages'
  );

  // `null` is not `[]` (#64). An empty array is a graph with no pages. `null`
  // may mean no graph is open or LogSeq is re-indexing (unconfirmed until the
  // manual probes M1-M4 in scripts/probe-constraints.ts are run), so the empty
  // list is reported with a warning instead of passing for "none". `hasMore` stays
  // false: no parameter fetches a page list that does not exist, so the
  // warning has no `howToFetchAll` (the retry advice is in the message).
  if (!allPages) {
    return {
      pages: [],
      total: 0,
      ...buildResultMeta([
        {
          code: 'pages_unavailable',
          message:
            'LogSeq returned no page list (possibly no graph open or a re-index in progress), ' +
            'so the empty list may not mean the graph is empty. ' +
            'Retry in a moment, or call logseq_get_graph_info to check which graph is open.',
        },
      ]),
    };
  }

  // Filter out journals
  let filtered = allPages.filter(p => !(p.journal || p['journal?']));

  // Filter by name if specified (case-insensitive)
  if (nameContains) {
    const lower = nameContains.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(lower));
  }

  // A total order, so pages stay put across calls: localeCompare is 0 for some
  // distinct names (NFC vs NFD, a zero-width space), and getAllPages order is
  // not guaranteed, so a tie could put one name on two pages and drop the other
  const names = filtered
    .sort((a, b) => a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(p => p.originalName || p.name);

  const total = names.length;
  const pages = names.slice(offset, offset + limit);
  if (offset + pages.length >= total) return { pages, total };

  return { pages, total, ...buildResultMeta([pagesTruncated(pages.length, total, offset, requested)]) };
}

/**
 * The `pages_truncated` warning for `shown` pages from `offset` of `total`.
 * Counted from `offset`, so "get all N" means the N pages from there on. The
 * helper offers the next offset (`next`) whenever there is one; with limit 0
 * there is none, because the offset would not move, so only raising limit is
 * suggested.
 */
function pagesTruncated(shown: number, total: number, offset: number, requested: number): ResultWarning {
  return cappedTruncationWarning({
    what: offset > 0 ? `pages from offset ${offset}` : 'pages',
    shown,
    total: total - offset,
    param: 'limit',
    max: MAX_LIST_PAGES_LIMIT,
    narrower: 'Narrow name_contains to see the rest.',
    requested,
    code: 'pages_truncated',
    next: shown > 0 ? `Set offset to ${offset + shown} for the next page.` : undefined,
  });
}
