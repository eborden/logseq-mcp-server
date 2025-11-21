import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

export type RelationshipType =
  | 'references' // Blocks about topicA that reference topicB
  | 'referenced-by' // Blocks about topicA in pages referenced by topicB
  | 'in-pages-linking-to' // Blocks about topicA in pages that link to topicB
  | 'connected-within'; // Topics connected within N hops

export interface SearchByRelationshipResult {
  query: {
    topicA: string;
    topicB: string;
    relationshipType: RelationshipType;
    maxDistance?: number;
  };
  relationshipType: RelationshipType;
  results: BlockEntity[];
}

/**
 * Search for blocks based on relationship between topics
 * @param client - LogseqClient instance
 * @param topicA - Primary topic to search for
 * @param topicB - Related topic that defines the relationship
 * @param relationshipType - Type of relationship to search
 * @param maxDistance - Maximum graph distance (for connected-within)
 * @returns SearchByRelationshipResult with matching blocks
 */
export async function searchByRelationship(
  client: LogseqClient,
  topicA: string,
  topicB: string,
  relationshipType: RelationshipType,
  maxDistance: number = 2
): Promise<SearchByRelationshipResult> {
  let results: BlockEntity[] = [];

  switch (relationshipType) {
    case 'references': {
      // Find blocks that mention topicA and also reference topicB
      const blocksAboutA = await client.callAPI<BlockEntity[]>(
        'logseq.Editor.getPageBlocksTree',
        [topicA]
      );

      // Filter blocks that contain reference to topicB
      results = (blocksAboutA || []).filter(block => {
        const content = block.content || '';
        return (
          content.includes(`[[${topicB}]]`) ||
          content.includes(`#${topicB}`)
        );
      });
      break;
    }

    case 'referenced-by': {
      // Get pages that reference topicB (backlinks to topicB)
      const backlinks = await client.callAPI<[BlockEntity, PageEntity][]>(
        'logseq.Editor.getPageLinkedReferences',
        [topicB]
      );

      // Extract unique page names from backlinks
      const referencingPageNames = new Set<string>();
      for (const [block, page] of backlinks || []) {
        if (page && page.name) {
          referencingPageNames.add(page.name);
        }
      }

      // Get blocks about topicA from those pages
      for (const pageName of referencingPageNames) {
        const blocks = await client.callAPI<BlockEntity[]>(
          'logseq.Editor.getPageBlocksTree',
          [pageName]
        );

        const matchingBlocks = (blocks || []).filter(block => {
          const content = block.content || '';
          return (
            content.includes(`[[${topicA}]]`) ||
            content.includes(`#${topicA}`)
          );
        });

        results.push(...matchingBlocks);
      }
      break;
    }

    case 'in-pages-linking-to': {
      // Get pages that link to topicB using getPageLinkedReferences
      const backlinks = await client.callAPI<[BlockEntity, PageEntity][]>(
        'logseq.Editor.getPageLinkedReferences',
        [topicB]
      );

      // Extract unique page names from backlinks
      const linkingPageNames = new Set<string>();
      for (const [block, page] of backlinks || []) {
        if (page && page.name) {
          linkingPageNames.add(page.name);
        }
      }

      // Get blocks about topicA from those pages
      for (const pageName of linkingPageNames) {
        const blocks = await client.callAPI<BlockEntity[]>(
          'logseq.Editor.getPageBlocksTree',
          [pageName]
        );

        const matchingBlocks = (blocks || []).filter(block => {
          const content = block.content || '';
          return (
            content.includes(`[[${topicA}]]`) ||
            content.includes(`#${topicA}`)
          );
        });

        results.push(...matchingBlocks);
      }
      break;
    }

    case 'connected-within': {
      // Check if topicB is reachable from topicA within maxDistance hops
      const visited = new Set<string>();
      const queue: Array<{ pageName: string; depth: number }> = [];

      const rootPage = await client.callAPI<PageEntity | null>(
        'logseq.Editor.getPage',
        [topicA]
      );

      if (rootPage) {
        visited.add(rootPage.name);
        queue.push({ pageName: rootPage.name, depth: 0 });

        let found = false;

        while (queue.length > 0 && !found) {
          const current = queue.shift()!;

          if (current.depth >= maxDistance) {
            continue;
          }

          // Get blocks to extract outbound references
          const blocks = await client.callAPI<BlockEntity[]>(
            'logseq.Editor.getPageBlocksTree',
            [current.pageName]
          );

          // Extract page references from block content
          const pageRefRegex = /\[\[([^\]]+)\]\]/g;
          const referencedPageNames = new Set<string>();

          const extractRefs = (blocks: BlockEntity[]) => {
            for (const block of blocks) {
              if (block.content) {
                let match;
                while ((match = pageRefRegex.exec(block.content)) !== null) {
                  referencedPageNames.add(match[1]);
                }
              }
              if (block.children) {
                extractRefs(block.children);
              }
            }
          };

          extractRefs(blocks || []);

          // Check if we found topicB
          if (referencedPageNames.has(topicB)) {
            found = true;
            break;
          }

          // Add unvisited pages to queue
          for (const refName of referencedPageNames) {
            if (!visited.has(refName)) {
              visited.add(refName);
              queue.push({
                pageName: refName,
                depth: current.depth + 1
              });
            }
          }

          // Also check inbound references (backlinks)
          const backlinks = await client.callAPI<[BlockEntity, PageEntity][]>(
            'logseq.Editor.getPageLinkedReferences',
            [current.pageName]
          );

          for (const [block, page] of backlinks || []) {
            if (page.name === topicB) {
              found = true;
              break;
            }

            if (!visited.has(page.name)) {
              visited.add(page.name);
              queue.push({
                pageName: page.name,
                depth: current.depth + 1
              });
            }
          }
        }

        // If connected, return blocks from both topics
        if (found) {
          const blocksA = await client.callAPI<BlockEntity[]>(
            'logseq.Editor.getPageBlocksTree',
            [topicA]
          );
          const blocksB = await client.callAPI<BlockEntity[]>(
            'logseq.Editor.getPageBlocksTree',
            [topicB]
          );

          results = [...(blocksA || []), ...(blocksB || [])];
        }
      }
      break;
    }
  }

  return {
    query: {
      topicA,
      topicB,
      relationshipType,
      maxDistance: relationshipType === 'connected-within' ? maxDistance : undefined
    },
    relationshipType,
    results
  };
}
