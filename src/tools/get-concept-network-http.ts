import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';

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
 * Get network of pages related to a concept (HTTP implementation)
 * @param client - LogseqClient instance
 * @param conceptName - Name of the root concept
 * @param maxDepth - Maximum depth to traverse (default: 2, max: 3)
 * @returns ConceptNetworkResult with nodes and edges
 */
export async function getConceptNetworkHTTP(
  client: LogseqClient,
  conceptName: string,
  maxDepth: number = 2
): Promise<ConceptNetworkResult> {
  const nodes: ConceptNetworkResult['nodes'] = [];
  const edges: ConceptNetworkResult['edges'] = [];
  const visited = new Set<number>();
  const queue: Array<{ pageId: number; pageName: string; depth: number }> = [];

  // Get root concept page
  const rootPage = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [conceptName]
  );

  if (rootPage === null) {
    throw new Error(`Page not found: ${conceptName}`);
  }

  // Add root node
  nodes.push({
    id: rootPage.id,
    name: rootPage.name,
    depth: 0
  });
  visited.add(rootPage.id);
  queue.push({ pageId: rootPage.id, pageName: rootPage.name, depth: 0 });

  // BFS traversal
  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth >= maxDepth) {
      continue;
    }

    // Get outbound references
    try {
      const refs = await client.callAPI<PageEntity[]>(
        'logseq.Editor.getPageLinkedReferences',
        [current.pageName]
      );

      for (const ref of refs || []) {
        // Add edge
        edges.push({
          from: current.pageId,
          to: ref.id,
          type: 'reference'
        });

        // Add node if not visited
        if (!visited.has(ref.id)) {
          visited.add(ref.id);
          nodes.push({
            id: ref.id,
            name: ref.name,
            depth: current.depth + 1
          });
          queue.push({
            pageId: ref.id,
            pageName: ref.name,
            depth: current.depth + 1
          });
        }
      }
    } catch (error) {
      // Continue on error (page might not have references)
    }

    // Get inbound references (backlinks)
    try {
      const backlinks = await client.callAPI<BlockEntity[]>(
        'logseq.Editor.getPageBlocksTree',
        [current.pageName]
      );

      for (const block of backlinks || []) {
        const page = block.page as PageEntity | undefined;
        if (page && page.id !== current.pageId) {
          // Add edge
          edges.push({
            from: page.id,
            to: current.pageId,
            type: 'backlink'
          });

          // Add node if not visited
          if (!visited.has(page.id)) {
            visited.add(page.id);
            nodes.push({
              id: page.id,
              name: page.name,
              depth: current.depth + 1
            });
            queue.push({
              pageId: page.id,
              pageName: page.name,
              depth: current.depth + 1
            });
          }
        }
      }
    } catch (error) {
      // Continue on error
    }
  }

  return {
    concept: conceptName,
    nodes,
    edges
  };
}
