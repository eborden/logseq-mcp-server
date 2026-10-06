import { LogseqClient } from '../client.js';
import { PageEntity, ResultMeta, ResultWarning } from '../types.js';
import { journalFlag } from '../utils/entity-fields.js';
import { buildResultMeta, cappedTruncationWarning, INLINE_ITEMS } from '../utils/result-meta.js';
import { callParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

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
  pages: ListedPage[];
  /** Every matching canonical page, before `offset` and `limit`. An alias is not a page of its own and adds nothing */
  total: number;
}

/**
 * One page of the list (#171). `aliases` holds the other names of the page
 * (`alias::`), in original casing and name order, and is absent when there are
 * none, so a page without aliases costs no more than its name.
 */
export interface ListedPage {
  name: string;
  aliases?: string[];
}

export interface ListPagesOptions {
  nameContains?: string;
  /** Pages to return, clamped to 0..`MAX_LIST_PAGES_LIMIT` and floored */
  limit?: number;
  /** Matching pages to skip first, in name order, floored at 0 */
  offset?: number;
}

/** Name order that is a total order, see {@link listPages}. */
const byName = (a: PageEntity, b: PageEntity): number =>
  a.name.localeCompare(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const displayName = (page: PageEntity): string => page.originalName || page.name;

/** A listed page with the entities behind it, kept until the filter and the window are applied. */
interface Entry {
  page: PageEntity;
  aliases: PageEntity[];
}

/**
 * Fold alias links into the page list (#171), from the `alias` ids that
 * `getAllPages` already carries on every entity, so it costs no call.
 *
 * Which page is canonical follows the resolver (`declaringPages` in
 * `resolve-page.ts`): a page with a file wrote the `alias::` line, so it is
 * canonical, and the file-less stubs LogSeq made for its alias names nest
 * under it. LogSeq links an alias group of three or more as a clique (every
 * stub links every other), but the declaring page links all of them, so a
 * stub's canonical pages are the file-backed pages it links to directly.
 *
 * - Two file-backed pages that declare the same name (an ambiguous alias, which
 *   the resolver refuses to pick between) each list that name, so the name
 *   shows up under both and `total` counts both pages.
 * - A page with a file never nests under another, even when one declares the
 *   other as an alias: the resolver keeps the name of a real page for itself.
 * - A stub that links no file-backed page has nothing to nest under and
 *   stays a top-level page, as it did before.
 *
 * Links are read in both directions, in case a LogSeq version stores one.
 *
 * This relies on `getAllPages` entities carrying `alias` and `file`, which holds
 * on LogSeq 0.10.15. If an upgrade dropped or renamed either key nothing would
 * fail: every alias would stay a top-level page, as before #171, and a graph
 * with no aliases looks the same, so the tool can't warn. The check is
 * `probeListPagesNesting` in `scripts/probe-constraints.ts`: re-run it after a
 * LogSeq upgrade, on a graph that has aliases. The fixture integration test
 * (`tests/integration/list-pages-aliases.test.ts`) pins the behaviour in CI.
 */
function nestAliases(pages: PageEntity[]): Entry[] {
  const byId = new Map(pages.map(page => [page.id, page]));
  const neighbours = new Map<number, Set<number>>();
  const link = (from: number, to: number) => {
    if (from === to || !byId.has(to)) return;
    if (!neighbours.has(from)) neighbours.set(from, new Set());
    neighbours.get(from)!.add(to);
  };
  for (const page of pages) {
    for (const target of page.alias ?? []) {
      link(page.id, target.id);
      link(target.id, page.id);
    }
  }

  const written = (page: PageEntity) => page.file != null;
  const entries: Entry[] = [];
  for (const page of pages) {
    const linked = [...(neighbours.get(page.id) ?? [])].map(id => byId.get(id)!);
    if (written(page)) {
      entries.push({ page, aliases: linked.filter(other => !written(other)).sort(byName) });
    } else if (!linked.some(written)) {
      entries.push({ page, aliases: [] });
    }
  }
  return entries;
}

/**
 * Non-journal pages in name order, `offset` pages in, at most `limit` of
 * them (#61). Each page carries its aliases (`alias::`), which are not pages of
 * their own and use no `limit` slots (#171). `name_contains` matches the page's
 * name or any alias, and returns the page with all its aliases. `total` counts
 * every matching page, whatever `offset` and `limit` are. When pages remain after the ones returned, a `pages_truncated` warning
 * says how to get them: raise `limit` when that fits under the maximum, and
 * set `offset` to the next page in any case, so `hasMore` is true. One API call
 * whatever the values: `getAllPages` returns every page, and the window is cut
 * here, and the aliases come from the same response.
 */
export async function listPages(
  client: LogseqClient,
  options: ListPagesOptions = {}
): Promise<ListPagesResult> {
  const { nameContains } = options;
  const requested = Math.floor(options.limit ?? DEFAULT_LIST_PAGES_LIMIT);
  const limit = Math.min(Math.max(0, requested), MAX_LIST_PAGES_LIMIT);
  const offset = Math.max(0, Math.floor(options.offset ?? DEFAULT_LIST_PAGES_OFFSET));

  const allPages = await callParsed(client, responses.editorPages, 'logseq.Editor.getAllPages');

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

  // Journals are not listed, and take no part in alias groups
  let entries = nestAliases(allPages.filter(p => !journalFlag(p)));

  // Filter by name if specified (case-insensitive): the page's own name or any alias
  if (nameContains) {
    const lower = nameContains.toLowerCase();
    entries = entries.filter(
      ({ page, aliases }) =>
        page.name.toLowerCase().includes(lower) || aliases.some(alias => alias.name.toLowerCase().includes(lower))
    );
  }

  // A total order, so pages stay put across calls: localeCompare is 0 for some
  // distinct names (NFC vs NFD, a zero-width space), and getAllPages order is
  // not guaranteed, so a tie could put one name on two pages and drop the other
  const listed: ListedPage[] = entries
    .sort((a, b) => byName(a.page, b.page))
    .map(({ page, aliases }) =>
      aliases.length > 0
        ? { name: displayName(page), aliases: aliases.map(displayName) }
        : { name: displayName(page) }
    );

  const total = listed.length;
  const pages = listed.slice(offset, offset + limit);
  if (offset + pages.length >= total) return { pages, total };

  return { pages, total, ...buildResultMeta([pagesTruncated(pages.length, total, offset, requested)]) };
}

/**
 * The `pages_truncated` warning for `shown` pages from `offset` of `total`.
 * Counted from `offset`, so "get all N" means the N pages from there on. Paging
 * leads (#196): `howToFetchAll` starts with the next offset whenever there is one,
 * and raising `limit` is the alternative, with the large-result note when that raise passes
 * `INLINE_ITEMS.pages` (800): an entry is 12 characters of JSON plus the name, so 1000 pages
 * of 35-character names are about 47,000 characters, near the host's limit, and aliases add
 * more. With limit 0 there is no next offset, because it would not move, so only raising
 * limit is suggested.
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
    inlineMax: INLINE_ITEMS.pages,
    paging: shown > 0 ? { param: 'offset', next: `Set offset to ${offset + shown} for the next page.` } : undefined,
  });
}
