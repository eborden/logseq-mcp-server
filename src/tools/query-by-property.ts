import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

/**
 * Query blocks by a specific property name and value
 * @param client - LogseqClient instance
 * @param propertyName - Name of the property to query
 * @param propertyValue - Value to match for the property
 * @returns Array of BlockEntity objects with matching property, or null if query fails
 */
export async function queryByProperty(
  client: LogseqClient,
  propertyName: string,
  propertyValue: string
): Promise<BlockEntity[] | null> {
  // Construct Datalog query for property matching
  const datalogQuery = `[:find (pull ?b [*]) :where [?b :block/properties ?props] [(get ?props :${propertyName}) ?val] [(= ?val "${propertyValue}")]]`;

  const result = await client.callAPI<BlockEntity[] | null>(
    'logseq.DB.q',
    [datalogQuery]
  );

  return result;
}
