import type { TopicContext } from '../tools/build-context.js';
import type { TopicQueryContext } from '../tools/get-context-for-query.js';
import { firstLineSnippet } from './snippet.js';

/**
 * `compact` JSON (#43): the same result with ids, titles and link targets, and no
 * block bodies. A block shrinks to `{ uuid, snippet }`, where the snippet is its
 * first line cut to 80 characters; the model reads only the blocks it picks, with
 * `logseq_get_block`. The markdown form of `compact` shows the same snippets.
 *
 * Supported by `build_context` and `get_context_for_query`, whose blocks are the
 * bulk of the output. Everything outside the blocks (`summary`, `totals`,
 * `warnings`, `hasMore`, `resolvedFrom`) is kept as it is.
 */

export interface CompactBlock {
  uuid: string;
  snippet: string;
}

export interface CompactPage {
  id?: number;
  name?: string;
  originalName?: string;
}

type Loose = Record<string, any>;

export function compactBlock(block: Loose): CompactBlock {
  return { uuid: block.uuid, snippet: firstLineSnippet(block.content) };
}

export function compactPage(page: Loose): CompactPage {
  const out: CompactPage = {};
  const id = page.id ?? page['db/id'];
  const originalName = page.originalName ?? page['original-name'];
  if (id !== undefined) out.id = id;
  if (page.name !== undefined) out.name = page.name;
  if (originalName !== undefined) out.originalName = originalName;
  return out;
}

export type CompactTopicContext<T extends TopicQueryContext = TopicContext> = Omit<
  T,
  'mainPage' | 'directBlocks' | 'relatedPages' | 'references'
> & {
  mainPage: CompactPage;
  directBlocks: CompactBlock[];
  relatedPages: Array<{ page: CompactPage; relationshipType: 'outbound' | 'inbound' }>;
  references: Array<{ block: CompactBlock; sourcePage: CompactPage }>;
};

/** A topic's context with block bodies replaced by snippets and pages by their names. */
export function compactTopicContext<T extends TopicQueryContext>(context: T): CompactTopicContext<T> {
  return {
    ...context,
    mainPage: compactPage(context.mainPage),
    directBlocks: context.directBlocks.map(compactBlock),
    relatedPages: context.relatedPages.map(r => ({ ...r, page: compactPage(r.page) })),
    references: context.references.map(r => ({ block: compactBlock(r.block), sourcePage: compactPage(r.sourcePage) })),
  };
}
