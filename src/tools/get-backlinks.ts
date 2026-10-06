import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity, PageLike, ResultMeta, ResultWarning } from '../types.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import {
  AliasSet,
  ResolvedAliases,
  aliasIds,
  aliasSetWarnings,
  hasAliases,
  resolveAliasSet,
  resolvedAliases
} from '../utils/alias-set.js';
import { camelizeBlock, camelizeKeys } from '../utils/block-tree.js';
import { requirePage, resolvedFromInfo, ResolvedFrom } from '../utils/resolve-page.js';
import { buildResultMeta, cappedTruncationWarning, INLINE_ITEMS, largeResultNote } from '../utils/result-meta.js';
import { callParsed, queryParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

/** Source pages kept when `maxPages` is absent. */
export const DEFAULT_MAX_PAGES = 20;

/**
 * Most source pages one call returns (#61). A larger `maxPages` is clamped to it,
 * and a cut at the maximum is a `pages_truncated` warning with no `howToFetchAll`.
 */
export const MAX_PAGES = 100;

/** Linking blocks kept per source page when `maxBlocksPerPage` is absent. */
export const DEFAULT_MAX_BLOCKS_PER_PAGE = 10;

/**
 * Most linking blocks one source page returns (#61). A larger value is clamped to it,
 * and a cut at the maximum is a `page_blocks_truncated` warning with no `howToFetchAll`.
 */
export const MAX_BLOCKS_PER_PAGE = 50;

/** Source pages named in a `page_blocks_truncated` message; the rest are counted. */
const MAX_NAMED_PAGES = 5;

export interface BacklinkCaps {
  /** Source pages kept (default 20), clamped to 0..`MAX_PAGES` and floored. */
  maxPages?: number;
  /** Linking blocks kept per source page (default 10), clamped to 0..`MAX_BLOCKS_PER_PAGE` and floored. */
  maxBlocksPerPage?: number;
}

const clampCap = (value: number, max: number) => Math.min(Math.max(0, Math.floor(value)), max);

/** `[sourcePage, linking blocks]`. The page can be `null`: the blocks then name it (`block.page`). */
export type Backlink = [PageLike | null, BlockEntity[]];

const blockCount = ([, blocks]: Backlink) => `${blocks.length} linking ${blocks.length === 1 ? 'block' : 'blocks'}`;

/** Plain character order, so the tie-break doesn't change with the machine's locale. */
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The name a source page ties on: `name` is lowercase, so case never decides. */
const blockPage = (blocks: BlockEntity[]) => blocks[0]?.page as { id?: number; name?: string } | undefined;
/** The name a warning shows: the page's, else its first block's page (a tuple can have no page), else a neutral label. */
const sourceName = ([page, blocks]: Backlink) => {
  const fromBlock = blockPage(blocks) as { id?: number; name?: string; originalName?: string } | undefined;
  return String(page?.originalName ?? page?.name ?? page?.id ?? fromBlock?.originalName ?? fromBlock?.name ?? fromBlock?.id ?? 'unknown page');
};
const rankName = ([page, blocks]: Backlink) => String(page?.name ?? blockPage(blocks)?.name ?? '');
const rankId = ([page, blocks]: Backlink) => Number(page?.id ?? blockPage(blocks)?.id ?? 0);

/**
 * Source pages ranked by how many blocks link the target, most first (#178). Ties break by
 * page name (lowercase, plain character order), then by page id, so the order is the same
 * on every run and on both paths: the Editor call's order is LogSeq's own and the alias
 * group's is by name, and neither says which pages link most. The blocks of each page keep
 * the order they came in (the fetch's), since every one of them links the target once and
 * there is no signal to rank them by. Pure and never mutates `results`; it uses counts
 * already in hand, so it costs no API call.
 */
export function rankBacklinks(results: Backlink[]): Backlink[] {
  return [...results].sort(
    (a, b) => b[1].length - a[1].length || compareText(rankName(a), rankName(b)) || rankId(a) - rankId(b)
  );
}

/**
 * The most source pages, from the top of the ranking, whose blocks still plausibly come
 * back inline (#196): the longest prefix of `results` that holds at most `INLINE_ITEMS.blocks`
 * blocks once each page is cut to `blockCap`. A page's cost is its linking blocks, so the
 * count of pages depends on the per-page cap. Pure.
 */
function pagesThatFit(results: Backlink[], blockCap: number): number {
  let blocks = 0;
  let pages = 0;
  for (const [, linking] of results) {
    blocks += Math.min(linking.length, blockCap);
    if (blocks > INLINE_ITEMS.blocks) break;
    pages++;
  }
  return pages;
}

/**
 * Rank `results` with {@link rankBacklinks}, then cut to `maxPages` source pages and
 * `maxBlocksPerPage` blocks each (#61), keeping the first of each in that order. The
 * ranking applies whether or not a cap bites, so the order is the same at every cap value
 * and a smaller cap is always a prefix of a larger one. Pure: it makes no call, so neither
 * the ranking nor the cut costs anything. A result that fits both caps comes back ranked,
 * with no warning and no totals.
 *
 * `totals` (every source page, every linking block, both before any cap) comes with a
 * cut only. `target` is the page's name, for the search advice in the pages warning.
 */
export function capBacklinks(
  fetched: Backlink[],
  target: string,
  { maxPages = DEFAULT_MAX_PAGES, maxBlocksPerPage = DEFAULT_MAX_BLOCKS_PER_PAGE }: BacklinkCaps = {}
): { results: Backlink[]; warnings: ResultWarning[]; totals?: Record<string, number> } {
  const pageCap = clampCap(maxPages, MAX_PAGES);
  const blockCap = clampCap(maxBlocksPerPage, MAX_BLOCKS_PER_PAGE);

  const results = rankBacklinks(fetched);
  const kept = results.slice(0, pageCap);
  const affected = kept.filter(([, blocks]) => blocks.length > blockCap);
  if (kept.length === results.length && affected.length === 0) return { results, warnings: [] };

  const warnings: ResultWarning[] = [];
  if (kept.length < results.length) {
    const warning = cappedTruncationWarning({
      what: 'source pages, ranked by linking blocks (most first, ties by page name)',
      shown: kept.length,
      total: results.length,
      param: 'max_pages',
      max: MAX_PAGES,
      narrower: `logseq_search_blocks with query "[[${target}]]" lists the blocks that write the link that way, on every page (not #tags or alias spellings).`,
      requested: maxPages,
      code: 'pages_truncated',
      inlineMax: pagesThatFit(results, blockCap)
    });
    // The counts are in hand, so say where the cut fell: the dropped pages link the target no more than this
    const edge = kept.length === 0 ? '' : ` The last page kept has ${blockCount(kept[kept.length - 1])}, the first dropped page has ${results[kept.length][1].length}.`;
    // Raising max_pages shows pages whose blocks may then be cut by the per-page cap
    warnings.push({ ...warning, message: `${warning.message}${edge} Blocks per page are capped separately by max_blocks_per_page.` });
  }
  if (affected.length > 0) warnings.push(pageBlocksTruncated(affected, blockCap, maxBlocksPerPage, kept));

  return {
    results: kept.map(([page, blocks]): Backlink => [page, blocks.length > blockCap ? blocks.slice(0, blockCap) : blocks]),
    warnings,
    totals: { pages: results.length, blocks: results.reduce((sum, [, blocks]) => sum + blocks.length, 0) }
  };
}

/**
 * The `page_blocks_truncated` warning: `affected` kept source pages hold more than `cap`
 * linking blocks. Raising the cap helps below the maximum, to the largest page's count
 * when that fits and to the maximum when it doesn't; at the maximum nothing can be raised,
 * so there is no `howToFetchAll` and `hasMore` stays false. Reading a source page whole
 * with `logseq_get_page` gets the blocks the cap dropped either way.
 */
function pageBlocksTruncated(affected: Backlink[], cap: number, requested: number, kept: Backlink[]): ResultWarning {
  const n = affected.length;
  const named = affected
    .slice(0, MAX_NAMED_PAGES)
    .map(backlink => `"${sourceName(backlink)}" (${backlink[1].length})`)
    .join(', ');
  const more = n > MAX_NAMED_PAGES ? ` and ${n - MAX_NAMED_PAGES} more` : '';
  const shown = `Showing the first ${cap} linking blocks of ${n} source ${n === 1 ? 'page' : 'pages'} with more: ${named}${more}.`;
  const readWhole = 'logseq_get_page with include_children reads a source page whole.';
  const largest = Math.max(...affected.map(([, blocks]) => blocks.length));

  if (cap >= MAX_BLOCKS_PER_PAGE) {
    const clamped = requested > MAX_BLOCKS_PER_PAGE ? ` (${requested} was asked for)` : '';
    return {
      code: 'page_blocks_truncated',
      message: `${shown} max_blocks_per_page is capped at its maximum of ${MAX_BLOCKS_PER_PAGE}${clamped}, so the rest can't be fetched in one call. ${readWhole}`
    };
  }
  // The blocks the raise would return across every kept page, to say when that may not come back inline (#196)
  const raiseTo = Math.min(largest, MAX_BLOCKS_PER_PAGE);
  const afterRaise = kept.reduce((sum, [, blocks]) => sum + Math.min(blocks.length, raiseTo), 0);
  const note = largeResultNote(afterRaise, INLINE_ITEMS.blocks);
  return {
    code: 'page_blocks_truncated',
    message: shown,
    howToFetchAll:
      largest <= MAX_BLOCKS_PER_PAGE
        ? `Set max_blocks_per_page to ${largest} (or higher) to get every block of these pages.${note}`
        : `Set max_blocks_per_page to ${MAX_BLOCKS_PER_PAGE} (the maximum) to get ${MAX_BLOCKS_PER_PAGE} per page.${note} ${readWhole}`
  };
}

/**
 * Get all pages/blocks that link to a specific page, under any of its names.
 * Aliases count: a reference written as `[[Jordan Rivera]]` is a backlink of
 * `Jordan` when one declares `alias::` for the other.
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @param caps - Source pages and blocks per page kept (#61), defaults 20 and 10; see {@link capBacklinks}
 * Source pages are ranked by their number of linking blocks, most first (#178).
 * @returns Array of tuples [PageLike | null, BlockEntity[]]
 * Note: LogSeq API returns [page, [block1, block2, ...]] per source page
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function getBacklinks(
  client: LogseqClient,
  pageName: string,
  caps: BacklinkCaps = {}
): Promise<Backlink[] | null> {
  return (await getBacklinksWithMeta(client, pageName, caps)).results;
}

/**
 * Same as {@link getBacklinks}, plus a meta for the second MCP content block.
 * Source pages come most-linking first (see {@link rankBacklinks}), before and after any cut.
 * The result is a bare array with no room for a field, so the meta carries:
 * - `resolvedFrom` when the name was an alias, date or namespace leaf rather
 *   than an exact name (which page the backlinks belong to);
 * - `resolvedAliases` when the page has aliases (every name whose references
 *   were included, original case);
 * - `warnings` and `totals` when `caps` cut the list (#61): `pages_truncated` and
 *   `page_blocks_truncated`, with every source page and linking block counted.
 * `meta` is null for an exact match on a page with no aliases that fits both caps,
 * so default output is unchanged.
 */
export async function getBacklinksWithMeta(
  client: LogseqClient,
  pageName: string,
  caps: BacklinkCaps = {}
): Promise<{
  results: Backlink[] | null;
  meta: (ResultMeta & ResolvedFrom & ResolvedAliases) | null;
}> {
  const resolved = await requirePage(client, pageName);
  const aliasSet = await resolveAliasSet(client, resolved.page);
  const fetched = await fetchBacklinks(client, resolved.lookupName, aliasSet);
  // The same cut for both paths, after the fetch: a null answer stays null (BR-0011)
  const capped = fetched && capBacklinks(fetched, resolved.lookupName, caps);
  const results = capped ? capped.results : fetched;
  const resolvedFrom = resolvedFromInfo(pageName, resolved);
  const warnings = [...aliasSetWarnings(aliasSet), ...(capped?.warnings ?? [])];
  if (!resolvedFrom && !hasAliases(aliasSet) && warnings.length === 0) return { results, meta: null };
  return {
    results,
    meta: {
      ...buildResultMeta(warnings, capped?.totals),
      ...(resolvedFrom && { resolvedFrom }),
      ...resolvedAliases(aliasSet)
    }
  };
}

/**
 * The backlinks call alone, for a caller that has already resolved the page
 * (so the name isn't resolved twice).
 *
 * Without `aliasSet`, or for a page with no aliases, this is the Editor API's
 * linked references of `resolvedName`, unchanged. For a page with aliases it is
 * one Datalog query over the ids of the whole group, shaped like that call's
 * result (camelCase entities, one `[page, blocks]` tuple per source page, and
 * the same page keys: `id`, `name`, `originalName`, plus `journalDay` on a
 * journal, as the tuple's page and as each block's `page`).
 */
export async function fetchBacklinks(
  client: LogseqClient,
  resolvedName: string,
  aliasSet?: AliasSet
): Promise<Backlink[] | null> {
  if (!aliasSet || !hasAliases(aliasSet)) {
    return callParsed(client, responses.linkedReferences, 'logseq.Editor.getPageLinkedReferences', [resolvedName]);
  }
  return fetchAliasedBacklinks(client, aliasSet);
}

/** Linked references of every page in the group, grouped by source page. */
async function fetchAliasedBacklinks(
  client: LogseqClient,
  aliasSet: AliasSet
): Promise<[PageEntity, BlockEntity[]][]> {
  const { query, inputs } = DatalogQueryBuilder.linkedReferencesOfPages(aliasIds(aliasSet));
  const rows = (await queryParsed(client, responses.nullableBlockRows, query, ...inputs)) || [];

  const byPage = new Map<number, { page: PageEntity; blocks: Map<number, BlockEntity> }>();
  for (const [row] of rows) {
    if (!row) continue;
    const block = camelizeBlock(row);
    if (block.page?.id === undefined) continue;
    let group = byPage.get(block.page.id);
    if (!group) {
      group = { page: camelizeKeys<PageEntity>(block.page), blocks: new Map() };
      byPage.set(group.page.id, group);
    }
    group.blocks.set(block.id, { ...block, page: group.page });
  }

  return [...byPage.values()]
    .sort((a, b) => String(a.page.name).localeCompare(String(b.page.name)) || a.page.id - b.page.id)
    .map(({ page, blocks }): [PageEntity, BlockEntity[]] => [
      page,
      [...blocks.values()].sort((a, b) => a.id - b.id)
    ]);
}
