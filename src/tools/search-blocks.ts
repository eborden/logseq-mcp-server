import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

/**
 * Search for blocks containing a specific text query
 * @param client - LogseqClient instance
 * @param query - Text to search for in block content
 * @returns Array of BlockEntity objects matching the query, or null if search fails
 */
export async function searchBlocks(
  client: LogseqClient,
  query: string
): Promise<BlockEntity[] | null> {
  // Construct Datalog query for text search
  const datalogQuery = `[:find (pull ?b [*]) :where [?b :block/content ?content] [(clojure.string/includes? ?content "${query}")]]`;

  const result = await client.callAPI<BlockEntity[] | null>(
    'logseq.DB.q',
    [datalogQuery]
  );

  return result;
}
