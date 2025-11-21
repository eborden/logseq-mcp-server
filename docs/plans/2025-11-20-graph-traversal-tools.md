# Graph Traversal Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add three MCP tools for graph-based navigation: get_related_pages, get_entity_timeline, and get_concept_network

**Architecture:** Build on existing tool patterns. Each tool leverages LogSeq Editor API to traverse page references, backlinks, and block relationships. Uses BFS/DFS for network discovery with cycle detection.

**Tech Stack:** TypeScript, LogSeq Editor API, existing MCP SDK patterns

---

## Task 1: Add get_related_pages tool

**Files:**
- Create: `src/tools/get-related-pages.ts`
- Create: `src/tools/get-related-pages.test.ts`
- Modify: `src/index.ts:14-18` (add import)
- Modify: `src/index.ts:21-110` (add tool schema)
- Modify: `src/index.ts:139-238` (add handler case)

**Step 1: Write the failing test**

Create `src/tools/get-related-pages.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getRelatedPages } from './get-related-pages.js';
import { LogseqClient } from '../client.js';

describe('getRelatedPages', () => {
  it('should return pages connected through references', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage call
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Test Page',
      originalName: 'Test Page'
    });

    // Mock getting page references
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Related Page 1' },
      { id: 3, name: 'Related Page 2' }
    ]);

    // Mock getting backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { page: { id: 4, name: 'Backlink Page' } }
    ]);

    const result = await getRelatedPages(mockClient, 'Test Page', 1);

    expect(result).toHaveProperty('sourcePage');
    expect(result).toHaveProperty('relatedPages');
    expect(result.relatedPages).toHaveLength(3);
  });

  it('should limit depth of traversal', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue({
      id: 1,
      name: 'Test Page'
    });

    const result = await getRelatedPages(mockClient, 'Test Page', 0);

    expect(result.relatedPages).toHaveLength(0);
  });

  it('should handle page not found', async () => {
    const mockClient = {
      callAPI: vi.fn().mockResolvedValue(null)
    } as unknown as LogseqClient;

    await expect(getRelatedPages(mockClient, 'Missing Page', 1))
      .rejects.toThrow('Page not found: Missing Page');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- get-related-pages.test.ts`

Expected: FAIL with "Cannot find module './get-related-pages.js'"

**Step 3: Write minimal implementation**

Create `src/tools/get-related-pages.ts`:

```typescript
import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';

export interface RelatedPagesResult {
  sourcePage: PageEntity;
  relatedPages: Array<{
    page: PageEntity;
    relationshipType: 'outbound-reference' | 'inbound-reference';
    distance: number;
  }>;
}

/**
 * Get pages related to a source page through references
 * @param client - LogseqClient instance
 * @param pageName - Name of the source page
 * @param depth - Maximum depth to traverse (default: 1)
 * @returns RelatedPagesResult with source page and related pages
 * @throws Error if page not found
 */
export async function getRelatedPages(
  client: LogseqClient,
  pageName: string,
  depth: number = 1
): Promise<RelatedPagesResult> {
  // Get the source page
  const sourcePage = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [pageName]
  );

  if (sourcePage === null) {
    throw new Error(`Page not found: ${pageName}`);
  }

  if (depth === 0) {
    return {
      sourcePage,
      relatedPages: []
    };
  }

  const relatedPages: RelatedPagesResult['relatedPages'] = [];
  const visited = new Set<number>([sourcePage.id]);

  // Get outbound references (pages this page links to)
  const pageRefs = await client.callAPI<PageEntity[]>(
    'logseq.Editor.getPageLinkedReferences',
    [pageName]
  );

  for (const ref of pageRefs || []) {
    if (!visited.has(ref.id)) {
      visited.add(ref.id);
      relatedPages.push({
        page: ref,
        relationshipType: 'outbound-reference',
        distance: 1
      });
    }
  }

  // Get inbound references (pages that link to this page)
  const backlinks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [pageName]
  );

  for (const block of backlinks || []) {
    if (block.page && !visited.has(block.page.id)) {
      visited.add(block.page.id);
      relatedPages.push({
        page: block.page,
        relationshipType: 'inbound-reference',
        distance: 1
      });
    }
  }

  return {
    sourcePage,
    relatedPages
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- get-related-pages.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Modify `src/index.ts`:

Add import at line 18:
```typescript
import { getRelatedPages } from './tools/get-related-pages.js';
```

Add tool schema in TOOLS array after line 109:
```typescript
  {
    name: 'logseq_get_related_pages',
    description: 'Get pages related to a source page through references and backlinks',
    inputSchema: {
      type: 'object',
      properties: {
        page_name: {
          type: 'string',
          description: 'Name of the source page',
        },
        depth: {
          type: 'number',
          description: 'Maximum depth to traverse (default: 1, max: 3)',
          default: 1,
        },
      },
      required: ['page_name'],
    },
  },
```

Add handler case in switch statement after line 221:
```typescript
        case 'logseq_get_related_pages': {
          const pageName = args?.page_name as string;
          const depth = Math.min((args?.depth as number) ?? 1, 3);
          const result = await getRelatedPages(client, pageName, depth);
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

Also add the same case in the duplicate handler starting at line 266.

**Step 6: Run tests to verify integration**

Run: `npm test`

Expected: All tests PASS

**Step 7: Build and verify compilation**

Run: `npm run build`

Expected: Build succeeds with no errors

**Step 8: Commit**

```bash
git add src/tools/get-related-pages.ts src/tools/get-related-pages.test.ts src/index.ts
git commit -m "feat: add get_related_pages tool for graph traversal"
```

---

## Task 2: Add get_entity_timeline tool

**Files:**
- Create: `src/tools/get-entity-timeline.ts`
- Create: `src/tools/get-entity-timeline.test.ts`
- Modify: `src/index.ts:19` (add import)
- Modify: `src/index.ts` (add tool schema and handler)

**Step 1: Write the failing test**

Create `src/tools/get-entity-timeline.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getEntityTimeline } from './get-entity-timeline.js';
import { LogseqClient } from '../client.js';

describe('getEntityTimeline', () => {
  it('should return blocks mentioning entity sorted by date', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search results
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Mention of [[Entity]]',
        page: { journalDay: 20251120, name: 'nov 20th, 2025' }
      },
      {
        id: 2,
        content: 'Earlier mention of [[Entity]]',
        page: { journalDay: 20251110, name: 'nov 10th, 2025' }
      }
    ]);

    const result = await getEntityTimeline(mockClient, 'Entity');

    expect(result).toHaveProperty('entity', 'Entity');
    expect(result).toHaveProperty('timeline');
    expect(result.timeline).toHaveLength(2);
    expect(result.timeline[0].date).toBe(20251110); // Earlier date first
    expect(result.timeline[1].date).toBe(20251120);
  });

  it('should filter by date range', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Recent mention',
        page: { journalDay: 20251120 }
      },
      {
        id: 2,
        content: 'Old mention',
        page: { journalDay: 20230101 }
      }
    ]);

    const result = await getEntityTimeline(
      mockClient,
      'Entity',
      20251101,
      20251231
    );

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBe(20251120);
  });

  it('should handle non-journal pages', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 1,
        content: 'Mention in regular page',
        page: { name: 'Regular Page', 'journal?': false }
      }
    ]);

    const result = await getEntityTimeline(mockClient, 'Entity');

    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0].date).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- get-entity-timeline.test.ts`

Expected: FAIL with "Cannot find module './get-entity-timeline.js'"

**Step 3: Write minimal implementation**

Create `src/tools/get-entity-timeline.ts`:

```typescript
import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

export interface EntityTimelineResult {
  entity: string;
  timeline: Array<{
    date: number | null; // journalDay format (YYYYMMDD) or null for non-journal
    block: BlockEntity;
  }>;
}

/**
 * Get timeline of blocks mentioning an entity
 * @param client - LogseqClient instance
 * @param entityName - Name of the entity (page name)
 * @param startDate - Optional start date (YYYYMMDD format)
 * @param endDate - Optional end date (YYYYMMDD format)
 * @returns EntityTimelineResult with blocks sorted by date
 */
export async function getEntityTimeline(
  client: LogseqClient,
  entityName: string,
  startDate?: number,
  endDate?: number
): Promise<EntityTimelineResult> {
  // Search for blocks containing the entity reference
  const searchQuery = `[[${entityName}]]`;
  const blocks = await client.callAPI<BlockEntity[]>(
    'logseq.DB.q',
    [`(page-property :title "${entityName}")`]
  );

  // Also get blocks that reference this page
  const referencingBlocks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [entityName]
  );

  // Combine and deduplicate blocks
  const allBlocks = [...(blocks || []), ...(referencingBlocks || [])];
  const uniqueBlocks = Array.from(
    new Map(allBlocks.map(b => [b.id, b])).values()
  );

  // Build timeline entries
  let timeline = uniqueBlocks
    .map(block => ({
      date: block.page?.journalDay || null,
      block
    }))
    .filter(entry => {
      // Filter by date range if specified
      if (entry.date === null) return true; // Keep non-journal entries
      if (startDate && entry.date < startDate) return false;
      if (endDate && entry.date > endDate) return false;
      return true;
    });

  // Sort by date (earliest first, nulls last)
  timeline.sort((a, b) => {
    if (a.date === null && b.date === null) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date - b.date;
  });

  return {
    entity: entityName,
    timeline
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- get-entity-timeline.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { getEntityTimeline } from './tools/get-entity-timeline.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_get_entity_timeline',
    description: 'Get timeline of blocks mentioning an entity, sorted chronologically',
    inputSchema: {
      type: 'object',
      properties: {
        entity_name: {
          type: 'string',
          description: 'Name of the entity (page name)',
        },
        start_date: {
          type: 'number',
          description: 'Optional start date in YYYYMMDD format',
        },
        end_date: {
          type: 'number',
          description: 'Optional end date in YYYYMMDD format',
        },
      },
      required: ['entity_name'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_get_entity_timeline': {
          const entityName = args?.entity_name as string;
          const startDate = args?.start_date as number | undefined;
          const endDate = args?.end_date as number | undefined;
          const result = await getEntityTimeline(
            client,
            entityName,
            startDate,
            endDate
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
git add src/tools/get-entity-timeline.ts src/tools/get-entity-timeline.test.ts src/index.ts
git commit -m "feat: add get_entity_timeline tool for temporal tracking"
```

---

## Task 3: Add get_concept_network tool

**Files:**
- Create: `src/tools/get-concept-network.ts`
- Create: `src/tools/get-concept-network.test.ts`
- Modify: `src/index.ts` (add import, schema, handler)

**Step 1: Write the failing test**

Create `src/tools/get-concept-network.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getConceptNetwork } from './get-concept-network.js';
import { LogseqClient } from '../client.js';

describe('getConceptNetwork', () => {
  it('should return network of pages related to concept', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage for root concept
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Concept',
      originalName: 'Concept'
    });

    // Mock references
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Related 1' },
      { id: 3, name: 'Related 2' }
    ]);

    // Mock backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { page: { id: 4, name: 'Backlink 1' } }
    ]);

    const result = await getConceptNetwork(mockClient, 'Concept', 2);

    expect(result).toHaveProperty('concept', 'Concept');
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('should respect max depth', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValue({
      id: 1,
      name: 'Concept'
    });

    const result = await getConceptNetwork(mockClient, 'Concept', 0);

    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('should detect cycles and not infinite loop', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Root page
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Page A'
    });

    // Page A references Page B
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Page B' }
    ]);
    (mockClient.callAPI as any).mockResolvedValueOnce([]);

    // Page B references Page A (cycle!)
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 2,
      name: 'Page B'
    });
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 1, name: 'Page A' }
    ]);

    const result = await getConceptNetwork(mockClient, 'Page A', 3);

    expect(result.nodes).toHaveLength(2);
    expect(result.edges.some(e => e.from === 1 && e.to === 2)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- get-concept-network.test.ts`

Expected: FAIL with "Cannot find module './get-concept-network.js'"

**Step 3: Write minimal implementation**

Create `src/tools/get-concept-network.ts`:

```typescript
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
 * Get network of pages related to a concept
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
        if (block.page && block.page.id !== current.pageId) {
          // Add edge
          edges.push({
            from: block.page.id,
            to: current.pageId,
            type: 'backlink'
          });

          // Add node if not visited
          if (!visited.has(block.page.id)) {
            visited.add(block.page.id);
            nodes.push({
              id: block.page.id,
              name: block.page.name,
              depth: current.depth + 1
            });
            queue.push({
              pageId: block.page.id,
              pageName: block.page.name,
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
```

**Step 4: Run test to verify it passes**

Run: `npm test -- get-concept-network.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { getConceptNetwork } from './tools/get-concept-network.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_get_concept_network',
    description: 'Get network of pages related to a concept with nodes and edges',
    inputSchema: {
      type: 'object',
      properties: {
        concept_name: {
          type: 'string',
          description: 'Name of the root concept',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum depth to traverse (default: 2, max: 3)',
          default: 2,
        },
      },
      required: ['concept_name'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_get_concept_network': {
          const conceptName = args?.concept_name as string;
          const maxDepth = Math.min((args?.max_depth as number) ?? 2, 3);
          const result = await getConceptNetwork(client, conceptName, maxDepth);
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
git add src/tools/get-concept-network.ts src/tools/get-concept-network.test.ts src/index.ts
git commit -m "feat: add get_concept_network tool for graph visualization"
```

---

## Task 4: Integration testing

**Files:**
- Create: `tests/integration/graph-tools.test.ts`

**Step 1: Write integration tests**

Create `tests/integration/graph-tools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createServer } from '../../src/index.js';
import { LogseqClient } from '../../src/client.js';

describe('Graph Tools Integration', () => {
  // These tests require a running LogSeq instance
  // Skip if LOGSEQ_TEST_API_URL is not set

  const shouldRun = !!process.env.LOGSEQ_TEST_API_URL;

  it.skipIf(!shouldRun)('get_related_pages returns connected pages', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    // Test with a known page (adjust based on your test graph)
    const { getRelatedPages } = await import('../../src/tools/get-related-pages.js');
    const result = await getRelatedPages(client, 'Test Page', 1);

    expect(result).toHaveProperty('sourcePage');
    expect(result).toHaveProperty('relatedPages');
    expect(Array.isArray(result.relatedPages)).toBe(true);
  });

  it.skipIf(!shouldRun)('get_entity_timeline returns chronological blocks', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { getEntityTimeline } = await import('../../src/tools/get-entity-timeline.js');
    const result = await getEntityTimeline(client, 'Test Entity');

    expect(result).toHaveProperty('entity');
    expect(result).toHaveProperty('timeline');
    expect(Array.isArray(result.timeline)).toBe(true);
  });

  it.skipIf(!shouldRun)('get_concept_network builds graph structure', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { getConceptNetwork } = await import('../../src/tools/get-concept-network.js');
    const result = await getConceptNetwork(client, 'Test Concept', 2);

    expect(result).toHaveProperty('concept');
    expect(result).toHaveProperty('nodes');
    expect(result).toHaveProperty('edges');
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });
});
```

**Step 2: Run integration tests**

Run: `npm run test:integration`

Expected: Tests skip if no LogSeq instance, or PASS if configured

**Step 3: Commit**

```bash
git add tests/integration/graph-tools.test.ts
git commit -m "test: add integration tests for graph tools"
```

---

## Execution Complete

All graph traversal tools implemented:
- ✅ `get_related_pages` - Find pages connected through references
- ✅ `get_entity_timeline` - Track concept evolution over time
- ✅ `get_concept_network` - Build knowledge graph structure

**Next steps:**
1. Test with real LogSeq instance
2. Consider adding graph visualization helpers
3. Optimize performance for large graphs (pagination, caching)
