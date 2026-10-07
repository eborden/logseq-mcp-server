import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { BlockEntity, PageEntity, SlimBlock, SlimPage } from '../types.js';
import { blockPageId, entityId, pageDisplayName } from '../utils/entity-fields.js';
import { toSlimBlock, toSlimPage } from '../utils/slim-entities.js';
import { callParsed, queryParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

/**
 * What the user is looking at in LogSeq right now.
 *
 * `page` is `null` when nothing is open (for example the All Pages view); in that
 * case `message` says so. This is a normal result, not an error.
 */
export interface CurrentContext {
  page: SlimPage | null;
  message?: string;
  focusedBlock?: SlimBlock;
  selectedBlocks?: SlimBlock[];
}

export const NO_PAGE_OPEN_MESSAGE =
  'No page is open in LogSeq (for example the All Pages view is showing).';

/** Blocks arrive with `page` as a bare `{id}` (or `{'db/id'}` from Datalog). */
function pageIdOf(block: BlockEntity): number | undefined {
  return blockPageId(block);
}

/**
 * `getCurrentPage` returns a block entity instead of a page when the user has
 * zoomed into a block.
 */
function isBlockEntity(entity: PageEntity | BlockEntity | null): entity is BlockEntity {
  return entity != null && !('name' in entity && entity.name !== undefined) && typeof entity.uuid === 'string' && 'page' in entity;
}

/**
 * Without `includeChildren`, the Editor API returns a block's `children` as
 * unfetched `["uuid", "<id>"]` tuples rather than block entities. Keep only real
 * block entities so slimming doesn't choke on them; fetch children with
 * logseq_get_block when they are needed.
 */
function withFetchedChildren(block: BlockEntity): BlockEntity {
  if (!Array.isArray(block.children)) {
    return block;
  }
  const { children, ...rest } = block;
  const fetched = (children as unknown[]).filter(
    (child): child is BlockEntity =>
      typeof child === 'object' && child !== null && !Array.isArray(child) &&
      typeof (child as BlockEntity).content === 'string'
  );
  return { ...rest, children: fetched.map(withFetchedChildren) };
}

/**
 * Get the page, focused block and selected blocks the user currently has open.
 *
 * Makes three Editor calls (`getCurrentPage`, `getCurrentBlock`, `getSelectedBlocks`)
 * and, only when a block's page is not already known, one Datalog pull by `:db/id`
 * to resolve the bare page ids. Never fetches all pages. Errors propagate.
 *
 * @param client - LogseqClient instance
 * @returns CurrentContext (`page: null` plus a message when nothing is open)
 */
export async function getCurrentContext(client: LogseqClient): Promise<CurrentContext> {
  const [currentPage, currentBlock, selected] = await Promise.all([
    callParsed(client, responses.pageOrBlock, 'logseq.Editor.getCurrentPage', []),
    callParsed(client, responses.block, 'logseq.Editor.getCurrentBlock', []),
    callParsed(client, responses.blocks, 'logseq.Editor.getSelectedBlocks', [])
  ]);

  const zoomedBlock = isBlockEntity(currentPage) ? currentPage : null;
  const pageEntity = currentPage && !zoomedBlock ? (currentPage as PageEntity) : null;

  const focused = currentBlock ?? zoomedBlock ?? null;
  const selectedBlocks = Array.isArray(selected) ? selected : [];
  const allBlocks = [...(focused ? [focused] : []), ...selectedBlocks];

  // Page names by id: the open page is already known; resolve the rest in one pull.
  // Keyed `number | undefined` so a block with no page can look itself up: the pull loop below
  // never stores `undefined`, so that lookup always misses.
  const pageNames = new Map<number | undefined, string>();
  if (pageEntity) {
    pageNames.set(pageEntity.id, pageDisplayName(pageEntity));
  }

  const missingIds = [...new Set(
    allBlocks
      .map(pageIdOf)
      .filter((id): id is number => id !== undefined && !pageNames.has(id))
  )];

  if (missingIds.length > 0) {
    const { query, inputs } = DatalogQueryBuilder.getPagesByIds(missingIds);
    const rows = await queryParsed(client, responses.nullablePageRows, query, ...inputs);
    for (const row of rows || []) {
      const pulled = row[0];
      const id = entityId(pulled);
      if (typeof id === 'number') {
        pageNames.set(id, pageDisplayName(pulled));
      }
    }
  }

  const slim = (block: BlockEntity): SlimBlock =>
    toSlimBlock(withFetchedChildren(block), pageNames.get(pageIdOf(block)) ?? '');

  // Page: the open one, else the page of the block being looked at.
  let page: SlimPage | null = pageEntity ? toSlimPage(pageEntity) : null;
  if (!page && allBlocks.length > 0) {
    const name = pageNames.get(pageIdOf(allBlocks[0]));
    if (name) {
      page = { name: name.toLowerCase(), originalName: name };
    }
  }

  const result: CurrentContext = { page };
  if (!page) {
    result.message = NO_PAGE_OPEN_MESSAGE;
  }
  if (focused) {
    result.focusedBlock = slim(focused);
  }
  if (selectedBlocks.length > 0) {
    result.selectedBlocks = selectedBlocks.map(slim);
  }
  return result;
}
