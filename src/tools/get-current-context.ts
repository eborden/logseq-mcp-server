import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import { BlockEntity, PageEntity, SlimBlock, SlimPage } from '../types.js';
import { toSlimBlock, toSlimPage } from '../utils/slim-entities.js';

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
  const ref = block.page as any;
  const id = ref?.id ?? ref?.['db/id'];
  return typeof id === 'number' ? id : undefined;
}

function displayName(page: any): string {
  return page?.originalName || page?.['original-name'] || page?.name || '';
}

/**
 * `getCurrentPage` returns a block entity instead of a page when the user has
 * zoomed into a block.
 */
function isBlockEntity(entity: any): entity is BlockEntity {
  return entity != null && entity.name === undefined && typeof entity.uuid === 'string' && 'page' in entity;
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
    client.callAPI<PageEntity | BlockEntity | null>('logseq.Editor.getCurrentPage', []),
    client.callAPI<BlockEntity | null>('logseq.Editor.getCurrentBlock', []),
    client.callAPI<BlockEntity[] | null>('logseq.Editor.getSelectedBlocks', [])
  ]);

  const zoomedBlock = isBlockEntity(currentPage) ? currentPage : null;
  const pageEntity = currentPage && !zoomedBlock ? (currentPage as PageEntity) : null;

  const focused = currentBlock ?? zoomedBlock ?? null;
  const selectedBlocks = Array.isArray(selected) ? selected : [];
  const allBlocks = [...(focused ? [focused] : []), ...selectedBlocks];

  // Page names by id: the open page is already known; resolve the rest in one pull.
  const pageNames = new Map<number, string>();
  if (pageEntity) {
    pageNames.set(pageEntity.id, displayName(pageEntity));
  }

  const missingIds = [...new Set(
    allBlocks
      .map(pageIdOf)
      .filter((id): id is number => id !== undefined && !pageNames.has(id))
  )];

  if (missingIds.length > 0) {
    const { query, inputs } = DatalogQueryBuilder.getPagesByIds(missingIds);
    const rows = await client.executeDatalogQuery<any[][] | null>(query, ...inputs);
    for (const row of rows || []) {
      const pulled = row[0];
      const id = pulled?.['db/id'] ?? pulled?.id;
      if (typeof id === 'number') {
        pageNames.set(id, displayName(pulled));
      }
    }
  }

  const slim = (block: BlockEntity): SlimBlock => {
    const id = pageIdOf(block);
    return toSlimBlock(block, id !== undefined ? pageNames.get(id) ?? '' : '');
  };

  // Page: the open one, else the page of the block being looked at.
  let page: SlimPage | null = pageEntity ? toSlimPage(pageEntity) : null;
  if (!page && allBlocks.length > 0) {
    const id = pageIdOf(allBlocks[0]);
    const name = id !== undefined ? pageNames.get(id) : undefined;
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
