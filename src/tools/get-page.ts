import { LogseqClient } from '../client.js';
import { PageEntity } from '../types.js';

/**
 * Get a LogSeq page by name
 * @param client - LogseqClient instance
 * @param pageName - Name of the page to retrieve
 * @param includeChildren - Whether to include child blocks/pages
 * @returns PageEntity
 * @throws Error if page not found
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
    throw new Error(`Page not found: ${pageName}`);
  }

  return result;
}
