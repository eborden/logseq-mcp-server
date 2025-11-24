import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';

export interface ConceptNetworkResult {
  concept: string;
  nodes: Array<{
    id: number;
    name: string;
    depth: number;
  }>;
  edges: Array<{
    from: number;
    to: number;
    type: 'reference' | 'backlink';
  }>;
}

/**
 * Get network of pages related to a concept using Datalog queries
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
  const nodeMap = new Map<number, { id: number; name: string; depth: number }>();
  const edges: ConceptNetworkResult['edges'] = [];
  const visited = new Set<number>();

  // Query 0: Get root page only (case-insensitive via lowercased parameter)
  const rootQuery = DatalogQueryBuilder.conceptNetwork(conceptName, 0);
  const rootResults = await client.executeDatalogQuery<Array<[any]>>(rootQuery, conceptName.toLowerCase());

  if (!rootResults || rootResults.length === 0) {
    throw new Error(`Page not found: ${conceptName}`);
  }

  // Extract root page
  const rootPage = rootResults[0][0];
  const rootId = rootPage.id || rootPage['db/id'];
  const rootName = rootPage.name || rootPage['original-name'] || rootPage.originalName;

  if (!rootId || !rootName) {
    throw new Error(`Invalid root page data for: ${conceptName}`);
  }

  // Add root node at depth 0
  nodeMap.set(rootId, { id: rootId, name: rootName, depth: 0 });
  visited.add(rootId);

  // If maxDepth is 0, return early
  if (maxDepth === 0) {
    return {
      concept: conceptName,
      nodes: [nodeMap.get(rootId)!],
      edges: []
    };
  }

  // BFS: Process each depth level
  let currentFrontier = [rootId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (currentFrontier.length === 0) break;

    // Query N: Get pages connected to current frontier
    const query = DatalogQueryBuilder.getConnectedPages(currentFrontier);
    const results = await client.executeDatalogQuery<Array<[number, any, string]>>(query);

    if (!results || results.length === 0) {
      break; // No more connections
    }

    const nextFrontier: number[] = [];

    // Process connections
    for (const [sourceId, connectedPage, relType] of results) {
      if (!connectedPage) continue; // Skip null connected pages

      const connectedId = connectedPage.id || connectedPage['db/id'];
      const connectedName = connectedPage.name || connectedPage['original-name'] || connectedPage.originalName;

      if (!connectedId) continue; // Skip if no valid ID

      // Add edge
      if (relType === 'outbound') {
        edges.push({
          from: sourceId,
          to: connectedId,
          type: 'reference'
        });
      } else if (relType === 'inbound') {
        edges.push({
          from: connectedId,
          to: sourceId,
          type: 'backlink'
        });
      }

      // Add node if not visited
      if (!visited.has(connectedId)) {
        visited.add(connectedId);
        nodeMap.set(connectedId, { id: connectedId, name: connectedName, depth });
        nextFrontier.push(connectedId);
      }
    }

    currentFrontier = nextFrontier;
  }

  return {
    concept: conceptName,
    nodes: Array.from(nodeMap.values()),
    edges
  };
}
