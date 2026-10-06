import { LogseqClient } from '../client.js';
import { GraphInfo } from '../types.js';
import { callParsed } from '../utils/parse-response.js';
import { responses } from '../response-schemas.js';

/**
 * Get information about the current LogSeq graph
 * @param client - LogseqClient instance
 * @returns GraphInfo containing path, name, and url
 * @throws Error if graph info cannot be retrieved
 */
export async function getGraphInfo(
  client: LogseqClient
): Promise<GraphInfo> {
  // Call the LogSeq API to get current graph
  const result = await callParsed(client, responses.graphInfo, 'logseq.App.getCurrentGraph', []);

  // Check if graph info was retrieved
  if (result === null) {
    throw new Error('Failed to retrieve graph information');
  }

  return result;
}
