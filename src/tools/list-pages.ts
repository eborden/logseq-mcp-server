import { LogseqClient } from '../client.js';
import { PageEntity, ResultMeta } from '../types.js';
import { buildResultMeta } from '../utils/result-meta.js';

/**
 * `hasMore` and `warnings` are present only when LogSeq returned no page list
 * (`null`), see {@link listPages}. A normal result, including a genuinely empty
 * graph, carries neither.
 */
export interface ListPagesResult extends Partial<Pick<ResultMeta, 'hasMore' | 'warnings'>> {
  pages: string[];
  total: number;
}

export async function listPages(
  client: LogseqClient,
  options: { nameContains?: string } = {}
): Promise<ListPagesResult> {
  const { nameContains } = options;

  const allPages = await client.callAPI<PageEntity[] | null>(
    'logseq.Editor.getAllPages'
  );

  // `null` is not `[]` (#64). An empty array is a graph with no pages. `null`
  // can mean no graph is open or LogSeq is re-indexing, so the empty list is
  // reported with a warning instead of passing for "none". `hasMore` stays
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
            'LogSeq returned no page list (no graph open, or the graph is re-indexing), ' +
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

  const pages = filtered
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(p => p.originalName || p.name);

  return { pages, total: pages.length };
}
