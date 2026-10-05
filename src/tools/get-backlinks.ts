import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity, ResultMeta } from '../types.js';
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
import { buildResultMeta } from '../utils/result-meta.js';

/**
 * Get all pages/blocks that link to a specific page, under any of its names.
 * Aliases count: a reference written as `[[Jordan Rivera]]` is a backlink of
 * `Jordan` when one declares `alias::` for the other.
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @returns Array of tuples [PageEntity, BlockEntity[]]
 * Note: LogSeq API returns [page, [block1, block2, ...]] per source page
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function getBacklinks(
  client: LogseqClient,
  pageName: string
): Promise<[PageEntity, BlockEntity[]][] | null> {
  return (await getBacklinksWithMeta(client, pageName)).results;
}

/**
 * Same as {@link getBacklinks}, plus a meta for the second MCP content block.
 * The result is a bare array with no room for a field, so the meta carries:
 * - `resolvedFrom` when the name was an alias, date or namespace leaf rather
 *   than an exact name (which page the backlinks belong to);
 * - `resolvedAliases` when the page has aliases (every name whose references
 *   were included, original case).
 * `meta` is null for an exact match on a page with no aliases, so default
 * output is unchanged.
 */
export async function getBacklinksWithMeta(
  client: LogseqClient,
  pageName: string
): Promise<{
  results: [PageEntity, BlockEntity[]][] | null;
  meta: (ResultMeta & ResolvedFrom & ResolvedAliases) | null;
}> {
  const resolved = await requirePage(client, pageName);
  const aliasSet = await resolveAliasSet(client, resolved.page);
  const results = await fetchBacklinks(client, resolved.lookupName, aliasSet);
  const resolvedFrom = resolvedFromInfo(pageName, resolved);
  const warnings = aliasSetWarnings(aliasSet);
  if (!resolvedFrom && !hasAliases(aliasSet) && warnings.length === 0) return { results, meta: null };
  return {
    results,
    meta: {
      ...buildResultMeta(warnings),
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
