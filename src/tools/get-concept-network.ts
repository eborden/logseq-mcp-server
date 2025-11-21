import { LogseqClient } from '../client.js';
import { ConceptNetworkResult, getConceptNetworkHTTP } from './get-concept-network-http.js';
import { getConceptNetworkDatalog } from './get-concept-network-datalog.js';

/**
 * Get network of pages related to a concept
 * Routes to HTTP or Datalog implementation based on feature flag
 * @param client - LogseqClient instance
 * @param conceptName - Name of the root concept
 * @param maxDepth - Maximum depth to traverse (default: 2, max: 3)
 * @returns ConceptNetworkResult with nodes and edges
 */
export async function getConceptNetwork(
  client: LogseqClient,
  conceptName: string,
  maxDepth: number = 2
): Promise<ConceptNetworkResult> {
  const useDatalog = client.config.features?.useDatalog;

  // Check if Datalog is enabled (either globally or for this specific tool)
  const toolEnabled = typeof useDatalog === 'object'
    ? useDatalog.conceptNetwork
    : useDatalog;

  if (toolEnabled) {
    return getConceptNetworkDatalog(client, conceptName, maxDepth);
  }

  return getConceptNetworkHTTP(client, conceptName, maxDepth);
}

// Re-export the result type for convenience
export type { ConceptNetworkResult };
