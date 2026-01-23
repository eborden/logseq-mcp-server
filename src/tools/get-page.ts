import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';
import { PageNotFoundError } from '../errors.js';
import Fuzzysort from 'fuzzysort';

/**
 * Get a LogSeq page by name
 * @param client - LogseqClient instance
 * @param pageName - Name of the page to retrieve
 * @param includeChildren - Whether to include child blocks/pages
 * @returns PageEntity
 * @throws PageNotFoundError if page not found (with fuzzy match suggestions)
 */
export async function getPage(
  client: LogseqClient,
  pageName: string,
  includeChildren: boolean
): Promise<PageEntity> {
  // Build arguments for API call
  const args: any[] = [pageName];

  // Add options if includeChildren is true
  if (includeChildren) {
    args.push({ includeChildren: true });
  }

  // Call the LogSeq API
  const result = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    args
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
      // If we can't get suggestions, just throw error without them
      if (error instanceof PageNotFoundError) {
        throw error;
      }
    }

    throw new PageNotFoundError(pageName);
  }

  return result;
}
