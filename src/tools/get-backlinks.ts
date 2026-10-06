import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity, ResultMeta, ResultWarning } from '../types.js';
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
import { buildResultMeta, cappedTruncationWarning } from '../utils/result-meta.js';

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

type Backlink = [PageEntity, BlockEntity[]];

const sourceName = (page: PageEntity) => String(page.originalName ?? page.name ?? page.id);

/**
 * Cut `results` to `maxPages` source pages and `maxBlocksPerPage` blocks each (#61),
 * keeping the first of each in the order given, so the same rule holds for the Editor
 * call's order and for the alias group's (name, then id; blocks by id). Pure: it makes
 * no call, so the cut costs nothing, and it never reorders, so a result that fits both
 * caps comes back as it is, with no warning and no totals.
 *
 * `totals` (every source page, every linking block, both before any cap) comes with a
 * cut only. `target` is the page's name, for the search advice in the pages warning.
 */
export function capBacklinks(
  results: Backlink[],
  target: string,
  { maxPages = DEFAULT_MAX_PAGES, maxBlocksPerPage = DEFAULT_MAX_BLOCKS_PER_PAGE }: BacklinkCaps = {}
): { results: Backlink[]; warnings: ResultWarning[]; totals?: Record<string, number> } {
  const pageCap = clampCap(maxPages, MAX_PAGES);
  const blockCap = clampCap(maxBlocksPerPage, MAX_BLOCKS_PER_PAGE);

  const kept = results.slice(0, pageCap);
  const affected = kept.filter(([, blocks]) => blocks.length > blockCap);
  if (kept.length === results.length && affected.length === 0) return { results, warnings: [] };

  const warnings: ResultWarning[] = [];
  if (kept.length < results.length) {
    const last = kept.length > 0 ? `; the last one shown is "${sourceName(kept[kept.length - 1][0])}"` : '';
    warnings.push(
      cappedTruncationWarning({
        what: `source pages (the first ones listed${last})`,
        shown: kept.length,
        total: results.length,
        param: 'max_pages',
        max: MAX_PAGES,
        narrower: `logseq_search_blocks with query "[[${target}]]" lists the blocks that write the link that way, on every page (not #tags or alias spellings).`,
        requested: maxPages,
        code: 'pages_truncated'
      })
    );
  }
  if (affected.length > 0) warnings.push(pageBlocksTruncated(affected, blockCap, maxBlocksPerPage));

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
function pageBlocksTruncated(affected: Backlink[], cap: number, requested: number): ResultWarning {
  const n = affected.length;
  const named = affected
    .slice(0, MAX_NAMED_PAGES)
    .map(([page, blocks]) => `"${sourceName(page)}" (${blocks.length})`)
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
  return {
    code: 'page_blocks_truncated',
    message: shown,
    howToFetchAll:
      largest <= MAX_BLOCKS_PER_PAGE
        ? `Set max_blocks_per_page to ${largest} (or higher) to get every block of these pages.`
        : `Set max_blocks_per_page to ${MAX_BLOCKS_PER_PAGE} (the maximum) to get ${MAX_BLOCKS_PER_PAGE} per page. ${readWhole}`
  };
}

/**
 * Get all pages/blocks that link to a specific page, under any of its names.
 * Aliases count: a reference written as `[[Jordan Rivera]]` is a backlink of
 * `Jordan` when one declares `alias::` for the other.
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @param caps - Source pages and blocks per page kept (#61), defaults 20 and 10; see {@link capBacklinks}
 * @returns Array of tuples [PageEntity, BlockEntity[]]
 * Note: LogSeq API returns [page, [block1, block2, ...]] per source page
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function getBacklinks(
  client: LogseqClient,
  pageName: string,
  caps: BacklinkCaps = {}
): Promise<[PageEntity, BlockEntity[]][] | null> {
  return (await getBacklinksWithMeta(client, pageName, caps)).results;
}

/**
 * Same as {@link getBacklinks}, plus a meta for the second MCP content block.
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
  results: [PageEntity, BlockEntity[]][] | null;
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
): Promise<[PageEntity, BlockEntity[]][] | null> {
  if (!aliasSet || !hasAliases(aliasSet)) {
    return client.callAPI<[PageEntity, BlockEntity[]][] | null>(
      'logseq.Editor.getPageLinkedReferences',
      [resolvedName]
    );
  }
  return fetchAliasedBacklinks(client, aliasSet);
}

/** Linked references of every page in the group, grouped by source page. */
async function fetchAliasedBacklinks(
  client: LogseqClient,
  aliasSet: AliasSet
): Promise<[PageEntity, BlockEntity[]][]> {
  const { query, inputs } = DatalogQueryBuilder.linkedReferencesOfPages(aliasIds(aliasSet));
  const rows = (await client.executeDatalogQuery<Array<[any]>>(query, ...inputs)) || [];

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
    group.blocks.set(block.id, { ...block, page: group.page as any });
  }

  return [...byPage.values()]
    .sort((a, b) => String(a.page.name).localeCompare(String(b.page.name)) || a.page.id - b.page.id)
    .map(({ page, blocks }): [PageEntity, BlockEntity[]] => [
      page,
      [...blocks.values()].sort((a, b) => a.id - b.id)
    ]);
}
