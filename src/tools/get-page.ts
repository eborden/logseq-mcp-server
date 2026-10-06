import { LogseqClient } from '../client.js';
import { PageEntity, ResolveRefsMeta } from '../types.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { requirePage, resolvedFrom, ResolvedFrom } from '../utils/resolve-page.js';
import { PageNotFoundError } from '../errors.js';
import { callParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

/**
 * Get a LogSeq page by name
 * @param client - LogseqClient instance
 * @param pageName - Page name, alias, or ISO date (`2025-01-01`) of a journal
 * @param includeChildren - Whether to include child blocks/pages
 * @param options.resolveRefs - Resolve `((uuid))` refs and `{{embed}}`s in the child
 *   blocks (needs `includeChildren`): adds `resolvedContent` / `resolvedRefs` to blocks
 *   that hold one, plus `hasMore` / `warnings` on the result. Costs at most 2 extra
 *   Datalog queries; off by default, and then nothing changes.
 *   Cost: 1 API call for an exact name of a page that has a file (the common case). An alias,
 *   ISO date, namespace leaf, file-less stub or missing page adds 1 resolver query (2 for a miss
 *   with no leaf, plus the suggestion lookup).
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
  // Fast path (1 API call): the Editor API finds an exact name, in any casing. A page
  // with a file is a real page that keeps its name, so no resolution can change the
  // answer. Aliases, dates and namespace leaves come back null here; a stub (no
  // file) may be an alias target or have a journal behind it, so both go to the resolver.
  const lookup = pageName.trim();
  const direct = await callParsed(client, responses.editorPage, 'logseq.Editor.getPage', [lookup]);

  let entity: PageEntity | null = direct;
  let lookupName = lookup;
  let from: ResolvedFrom = {};
  if (direct == null || direct.file == null) {
    const resolved = await requirePage(client, pageName);
    lookupName = resolved.lookupName;
    from = resolvedFrom(pageName, resolved);
    // An exact match is the page already fetched; anything else needs its own fetch
    entity = resolved.matchedBy === 'name' && direct != null
      ? direct
      : await callParsed(client, responses.editorPage, 'logseq.Editor.getPage', [lookupName]);
  }

  // The page vanished between the two calls
  if (entity === null) {
    throw new PageNotFoundError(pageName);
  }
  const result: PageEntity & ResolvedFrom = Object.assign(entity, from);

  // If includeChildren is requested, fetch the page blocks tree
  if (includeChildren) {
    const blocks = await callParsed(client, responses.blocks, 'logseq.Editor.getPageBlocksTree', [lookupName]);

    // Add blocks as children to the result
    if (blocks && blocks.length > 0) {
      result.children = blocks;
    }
  }

  if (options.resolveRefs) {
    const { blocks, warnings } = await resolveBlockRefs(client, result.children ?? []);
    return {
      ...result,
      ...(result.children ? { children: blocks } : {}),
      ...buildResultMeta(warnings)
    };
  }

  return result;
}
