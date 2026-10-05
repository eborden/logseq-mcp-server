import { LogseqClient } from '../client.js';
import { PageEntity, ResolveRefsMeta } from '../types.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { PageNotFoundError, isInfrastructureError } from '../errors.js';
import Fuzzysort from 'fuzzysort';

/**
 * Get a LogSeq page by name
 * @param client - LogseqClient instance
 * @param pageName - Name of the page to retrieve
 * @param includeChildren - Whether to include child blocks/pages
 * @param options.resolveRefs - Resolve `((uuid))` refs and `{{embed}}`s in the child
 *   blocks (needs `includeChildren`): adds `resolvedContent` / `resolvedRefs` to blocks
 *   that hold one, plus `hasMore` / `warnings` on the result. Costs at most 2 extra
 *   Datalog queries; off by default, and then nothing changes.
 * @returns PageEntity
 * @throws PageNotFoundError if page not found (with fuzzy match suggestions)
 */
export async function getPage(
  client: LogseqClient,
  pageName: string,
  includeChildren: boolean,
  options: { resolveRefs?: boolean } = {}
): Promise<PageEntity & ResolveRefsMeta> {
  // Call the LogSeq API to get page metadata
  const result = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [pageName]
  );

  // Check if page was found
  if (result === null) {
    // Get fuzzy match suggestions
    try {
      const allPages = await client.callAPI<PageEntity[]>('logseq.Editor.getAllPages', []);
      if (allPages && allPages.length > 0) {
        const matches = Fuzzysort.go(pageName, allPages, {
          key: 'originalName',
          limit: 3,
          threshold: -10000 // Be lenient with matching
        });
        const suggestions = matches.map(m => m.obj.originalName);
        throw new PageNotFoundError(pageName, suggestions);
      }
    } catch (error) {
      if (error instanceof PageNotFoundError || isInfrastructureError(error)) {
        throw error;
      }
      // Suggestions are best-effort: fall through to a plain PageNotFoundError
    }

    throw new PageNotFoundError(pageName);
  }

  // If includeChildren is requested, fetch the page blocks tree
  if (includeChildren) {
    const blocks = await client.callAPI<any[]>(
      'logseq.Editor.getPageBlocksTree',
      [pageName]
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
