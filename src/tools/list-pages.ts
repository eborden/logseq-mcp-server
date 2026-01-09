import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';

export interface ListPagesResult {
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

  if (!allPages) {
    return { pages: [], total: 0 };
  }

  // Filter out journals
  let filtered = allPages.filter(p => !(p.journal || p['journal?']));

  // Filter by name if specified (case-insensitive)
  if (nameContains) {
    const lower = nameContains.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(lower));
  }

  const pages = filtered
    .map(p => p.name)
    .sort((a, b) => a.localeCompare(b));

  return { pages, total: pages.length };
}
