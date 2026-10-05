import { LogseqClient } from '../client.js';
import { PageEntity, ResolveRefsMeta } from '../types.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { requirePage, resolvedFrom, ResolvedFrom } from '../utils/resolve-page.js';
import { PageNotFoundError } from '../errors.js';

/**
 * Get a LogSeq page by name
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @param includeChildren - Whether to include child blocks/pages
 * @param options.resolveRefs - Resolve `((uuid))` refs and `{{embed}}`s in the child
 *   blocks (needs `includeChildren`): adds `resolvedContent` / `resolvedRefs` to blocks
 *   that hold one, plus `hasMore` / `warnings` on the result. Costs at most 2 extra
 *   Datalog queries; off by default, and then nothing changes.
 * @returns PageEntity. When the name was an alias, date or namespace leaf rather
 *   than an exact name, `resolvedFrom` says so.
 * @throws PageNotFoundError if no page matches (guidance with the closest names)
 * @throws AmbiguousPageError if several pages match (with the candidates)
 */
export async function getPage(
  client: LogseqClient,
  pageName: string,
  includeChildren: boolean,
  options: { resolveRefs?: boolean } = {}
): Promise<PageEntity & ResolveRefsMeta & ResolvedFrom> {
  // One Datalog query resolves exact names, aliases and ISO dates
  const resolved = await requirePage(client, pageName);
  const lookupName = resolved.lookupName;

  // Call the LogSeq API to get page metadata
  const entity = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [lookupName]
  );

  // The page vanished between the two calls
  if (entity === null) {
    throw new PageNotFoundError(pageName);
  }
  const result: PageEntity & ResolvedFrom = Object.assign(entity, resolvedFrom(pageName, resolved));

  // If includeChildren is requested, fetch the page blocks tree
  if (includeChildren) {
    const blocks = await client.callAPI<any[]>(
      'logseq.Editor.getPageBlocksTree',
      [lookupName]
    );

    // Add blocks as children to the result
    if (blocks && blocks.length > 0) {
      result.children = blocks;
    }
  }

  if (options.resolveRefs) {
    const { blocks, warnings } = await resolveBlockRefs(client, (result.children ?? []) as any[]);
    return {
      ...result,
      ...(result.children ? { children: blocks } : {}),
      ...buildResultMeta(warnings)
    };
  }

  return result;
}
