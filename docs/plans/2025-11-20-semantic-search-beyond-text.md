# Semantic Search Beyond Text Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add relationship-aware search that understands page connections, not just text matches

**Architecture:** Enhance existing search_blocks with semantic understanding. Add search_by_relationship to find blocks based on graph context (e.g., "blocks about X that reference Y"). Uses graph traversal + text filtering.

**Tech Stack:** TypeScript, LogSeq Editor API, existing search patterns

---

## Task 1: Add search_by_relationship tool

**Files:**
- Create: `src/tools/search-by-relationship.ts`
- Create: `src/tools/search-by-relationship.test.ts`
- Modify: `src/index.ts` (add import, schema, handler)

**Step 1: Write the failing test**

Create `src/tools/search-by-relationship.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { searchByRelationship } from './search-by-relationship.js';
import { LogseqClient } from '../client.js';

describe('searchByRelationship', () => {
  it('should find blocks about topic that reference another page', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search for topic
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Discussion about [[Topic]] and [[RelatedPage]]',
        refs: [{ id: 10, name: 'Topic' }, { id: 20, name: 'RelatedPage' }]
      },
      {
        id: 2,
        content: 'Just about [[Topic]]',
        refs: [{ id: 10, name: 'Topic' }]
      }
    ]);

    const result = await searchByRelationship(
      mockClient,
      'Topic',
      'RelatedPage',
      'references'
    );

    expect(result).toHaveProperty('query');
    expect(result).toHaveProperty('results');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(1);
  });

  it('should find blocks in pages that have backlinks to target', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getting pages that link to target
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { page: { id: 100, name: 'Linking Page 1' } },
      { page: { id: 101, name: 'Linking Page 2' } }
    ]);

    // Mock getting blocks from those pages about topic
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 3,
        content: 'About [[Topic]]',
        page: { id: 100 }
      }
    ]);

    const result = await searchByRelationship(
      mockClient,
      'Topic',
      'TargetPage',
      'in-pages-linking-to'
    );

    expect(result.results).toHaveLength(1);
    expect(result.relationshipType).toBe('in-pages-linking-to');
  });

  it('should handle no results gracefully', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await searchByRelationship(
      mockClient,
      'NonExistent',
      'AlsoNonExistent',
      'references'
    );

    expect(result.results).toHaveLength(0);
  });

  it('should support connected-within relationship', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getting network around topicA
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'TopicA'
    });

    // Mock related pages
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Related1' },
      { id: 3, name: 'TopicB' }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    const result = await searchByRelationship(
      mockClient,
      'TopicA',
      'TopicB',
      'connected-within',
      2
    );

    expect(result.relationshipType).toBe('connected-within');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- search-by-relationship.test.ts`

Expected: FAIL with "Cannot find module './search-by-relationship.js'"

**Step 3: Write minimal implementation**

Create `src/tools/search-by-relationship.ts`:

```typescript
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
      // Get pages that topicB references
      const referencedPages = await client.callAPI<PageEntity[]>(
        'logseq.Editor.getPageLinkedReferences',
        [topicB]
      );

      // Get blocks about topicA from those pages
      for (const page of referencedPages || []) {
        const blocks = await client.callAPI<BlockEntity[]>(
          'logseq.Editor.getPageBlocksTree',
          [page.name]
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
      // Get pages that link to topicB
      const backlinks = await client.callAPI<BlockEntity[]>(
        'logseq.Editor.getPageBlocksTree',
        [topicB]
      );

      const linkingPageIds = new Set<number>();
      for (const block of backlinks || []) {
        if (block.page) {
          linkingPageIds.add(block.page.id);
        }
      }

      // Get blocks about topicA from those pages
      for (const block of backlinks || []) {
        if (block.page && linkingPageIds.has(block.page.id)) {
          const content = block.content || '';
          if (
            content.includes(`[[${topicA}]]`) ||
            content.includes(`#${topicA}`)
          ) {
            results.push(block);
          }
        }
      }
      break;
    }

    case 'connected-within': {
      // Check if topicB is reachable from topicA within maxDistance hops
      const visited = new Set<number>();
      const queue: Array<{ pageId: number; pageName: string; depth: number }> = [];

      const rootPage = await client.callAPI<PageEntity | null>(
        'logseq.Editor.getPage',
        [topicA]
      );

      if (rootPage) {
        visited.add(rootPage.id);
        queue.push({ pageId: rootPage.id, pageName: rootPage.name, depth: 0 });

        let found = false;

        while (queue.length > 0 && !found) {
          const current = queue.shift()!;

          if (current.depth >= maxDistance) {
            continue;
          }

          // Check outbound references
          const refs = await client.callAPI<PageEntity[]>(
            'logseq.Editor.getPageLinkedReferences',
            [current.pageName]
          );

          for (const ref of refs || []) {
            if (ref.name === topicB) {
              found = true;
              break;
            }

            if (!visited.has(ref.id)) {
              visited.add(ref.id);
              queue.push({
                pageId: ref.id,
                pageName: ref.name,
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
```

**Step 4: Run test to verify it passes**

Run: `npm test -- search-by-relationship.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { searchByRelationship } from './tools/search-by-relationship.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_search_by_relationship',
    description: 'Search for blocks based on relationship between topics (e.g., blocks about X that reference Y)',
    inputSchema: {
      type: 'object',
      properties: {
        topic_a: {
          type: 'string',
          description: 'Primary topic to search for',
        },
        topic_b: {
          type: 'string',
          description: 'Related topic that defines the relationship',
        },
        relationship_type: {
          type: 'string',
          enum: ['references', 'referenced-by', 'in-pages-linking-to', 'connected-within'],
          description: 'Type of relationship: references (blocks about A that reference B), referenced-by (blocks about A in pages referenced by B), in-pages-linking-to (blocks about A in pages linking to B), connected-within (topics connected within N hops)',
        },
        max_distance: {
          type: 'number',
          description: 'Maximum graph distance for connected-within (default: 2)',
          default: 2,
        },
      },
      required: ['topic_a', 'topic_b', 'relationship_type'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_search_by_relationship': {
          const topicA = args?.topic_a as string;
          const topicB = args?.topic_b as string;
          const relationshipType = args?.relationship_type as any;
          const maxDistance = (args?.max_distance as number) ?? 2;
          const result = await searchByRelationship(
            client,
            topicA,
            topicB,
            relationshipType,
            maxDistance
          );
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
```

(Add same case to duplicate handler)

**Step 6: Run all tests**

Run: `npm test`

Expected: All tests PASS

**Step 7: Build**

Run: `npm run build`

Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/tools/search-by-relationship.ts src/tools/search-by-relationship.test.ts src/index.ts
git commit -m "feat: add search_by_relationship for semantic search"
```

---

## Task 2: Enhance search_blocks with semantic context

**Files:**
- Modify: `src/tools/search-blocks.ts`
- Modify: `src/tools/search-blocks.test.ts`
- Modify: `src/index.ts` (update schema)

**Step 1: Write failing test for enhanced search**

Add to `src/tools/search-blocks.test.ts`:

```typescript
  it('should include relationship context when requested', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Test block with [[PageA]]',
        refs: [{ id: 10, name: 'PageA' }],
        page: { id: 100, name: 'Container Page' }
      }
    ]);

    // Mock getting page context
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 100,
      name: 'Container Page',
      properties: { tags: 'important' }
    });

    const result = await searchBlocks(
      mockClient,
      'Test',
      undefined,
      true // includeContext
    );

    expect(result[0]).toHaveProperty('context');
    expect(result[0].context).toHaveProperty('page');
    expect(result[0].context).toHaveProperty('references');
  });
```

**Step 2: Run test to verify it fails**

Run: `npm test -- search-blocks.test.ts`

Expected: FAIL - enhanced search not implemented

**Step 3: Enhance searchBlocks implementation**

Modify `src/tools/search-blocks.ts`:

```typescript
import { LogseqClient } from '../client.js';
import { BlockEntity, PageEntity } from '../types.js';

export interface SearchBlocksResult extends BlockEntity {
  context?: {
    page: PageEntity;
    references: string[];
    tags: string[];
  };
}

/**
 * Search for blocks containing specific text
 * @param client - LogseqClient instance
 * @param query - Text to search for
 * @param limit - Optional limit on results
 * @param includeContext - Include semantic context (page, references, tags)
 * @returns Array of matching blocks with optional context
 */
export async function searchBlocks(
  client: LogseqClient,
  query: string,
  limit?: number,
  includeContext: boolean = false
): Promise<SearchBlocksResult[]> {
  // Use LogSeq's search API
  const blocks = await client.callAPI<BlockEntity[]>(
    'logseq.DB.q',
    [`(and (block-content "${query}"))`]
  );

  let results = blocks || [];

  // Apply limit if specified
  if (limit) {
    results = results.slice(0, limit);
  }

  // Add context if requested
  if (includeContext) {
    const enrichedResults: SearchBlocksResult[] = [];

    for (const block of results) {
      const enriched: SearchBlocksResult = { ...block };

      if (block.page) {
        // Get full page details
        const page = await client.callAPI<PageEntity>(
          'logseq.Editor.getPage',
          [block.page.name]
        );

        // Extract references from block content
        const refMatches = block.content.matchAll(/\[\[([^\]]+)\]\]/g);
        const references = Array.from(refMatches, m => m[1]);

        // Extract tags
        const tagMatches = block.content.matchAll(/#([^\s#]+)/g);
        const tags = Array.from(tagMatches, m => m[1]);

        enriched.context = {
          page,
          references,
          tags
        };
      }

      enrichedResults.push(enriched);
    }

    return enrichedResults;
  }

  return results;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- search-blocks.test.ts`

Expected: PASS

**Step 5: Update MCP tool schema**

Modify tool schema in `src/index.ts`:

```typescript
  {
    name: 'logseq_search_blocks',
    description: 'Search for blocks containing specific text with optional semantic context',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to search for in block content',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (optional)',
        },
        include_context: {
          type: 'boolean',
          description: 'Include semantic context (page, references, tags)',
          default: false,
        },
      },
      required: ['query'],
    },
  },
```

Update handler:
```typescript
        case 'logseq_search_blocks': {
          const query = args?.query as string;
          const limit = args?.limit as number | undefined;
          const includeContext = (args?.include_context as boolean) ?? false;
          let result = await searchBlocks(client, query, limit, includeContext);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
```

(Update duplicate handler too)

**Step 6: Run all tests**

Run: `npm test`

Expected: All tests PASS

**Step 7: Build**

Run: `npm run build`

Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/tools/search-blocks.ts src/tools/search-blocks.test.ts src/index.ts
git commit -m "feat: enhance search_blocks with semantic context"
```

---

## Task 3: Integration testing

**Files:**
- Create: `tests/integration/semantic-search.test.ts`

**Step 1: Write integration tests**

Create `tests/integration/semantic-search.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LogseqClient } from '../../src/client.js';

describe('Semantic Search Integration', () => {
  const shouldRun = !!process.env.LOGSEQ_TEST_API_URL;

  it.skipIf(!shouldRun)('search_by_relationship finds related content', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { searchByRelationship } = await import(
      '../../src/tools/search-by-relationship.js'
    );

    const result = await searchByRelationship(
      client,
      'Test Topic',
      'Related Topic',
      'references'
    );

    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
  });

  it.skipIf(!shouldRun)('enhanced search_blocks includes context', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { searchBlocks } = await import('../../src/tools/search-blocks.js');

    const results = await searchBlocks(client, 'test', 5, true);

    if (results.length > 0) {
      expect(results[0]).toHaveProperty('context');
    }
  });
});
```

**Step 2: Run integration tests**

Run: `npm run test:integration`

Expected: Tests skip or PASS if configured

**Step 3: Commit**

```bash
git add tests/integration/semantic-search.test.ts
git commit -m "test: add integration tests for semantic search"
```

---

## Execution Complete

Semantic search capabilities added:
- ✅ `search_by_relationship` - Find blocks based on topic relationships
- ✅ Enhanced `search_blocks` - Include semantic context (page, refs, tags)
- ✅ Support for multiple relationship types

**Next steps:**
1. Add fuzzy matching for better search
2. Implement search result ranking by relevance
3. Add filters by date, page properties, or tags
