# Context Building for LLMs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tools that gather comprehensive context about topics to help LLMs understand your full knowledge graph

**Architecture:** Create smart context aggregation that pulls relevant pages, blocks, and relationships for a given topic. Uses graph traversal + relevance scoring. Returns structured context optimized for LLM consumption.

**Tech Stack:** TypeScript, LogSeq Editor API, graph algorithms

---

## Task 1: Add build_context_for_topic tool

**Files:**
- Create: `src/tools/build-context.ts`
- Create: `src/tools/build-context.test.ts`
- Modify: `src/index.ts` (add import, schema, handler)

**Step 1: Write the failing test**

Create `src/tools/build-context.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildContextForTopic } from './build-context.js';
import { LogseqClient } from '../client.js';

describe('buildContextForTopic', () => {
  it('should gather comprehensive context for a topic', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock getPage
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Test Topic',
      properties: { type: 'concept' }
    });

    // Mock page blocks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 10,
        content: 'Main definition of [[Test Topic]]'
      },
      {
        id: 11,
        content: 'Related information'
      }
    ]);

    // Mock related pages
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Related Page 1' }
    ]);

    // Mock backlinks
    (mockClient.callAPI as any).mockResolvedValueOnce([
      {
        id: 20,
        content: 'References [[Test Topic]]',
        page: { id: 3, name: 'Referencing Page' }
      }
    ]);

    const result = await buildContextForTopic(mockClient, 'Test Topic');

    expect(result).toHaveProperty('topic', 'Test Topic');
    expect(result).toHaveProperty('mainPage');
    expect(result).toHaveProperty('directBlocks');
    expect(result).toHaveProperty('relatedPages');
    expect(result).toHaveProperty('references');
    expect(result).toHaveProperty('summary');
  });

  it('should limit context size', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Topic'
    });

    // Return many blocks
    const manyBlocks = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      content: `Block ${i}`
    }));

    (mockClient.callAPI as any).mockResolvedValueOnce(manyBlocks);
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await buildContextForTopic(
      mockClient,
      'Topic',
      { maxBlocks: 10 }
    );

    expect(result.directBlocks.length).toBeLessThanOrEqual(10);
  });

  it('should include temporal context for journal pages', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'nov 20th, 2025',
      journalDay: 20251120,
      'journal?': true
    });

    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await buildContextForTopic(mockClient, 'nov 20th, 2025');

    expect(result).toHaveProperty('temporalContext');
    expect(result.temporalContext).toHaveProperty('isJournal', true);
    expect(result.temporalContext).toHaveProperty('date', 20251120);
  });

  it('should handle missing page gracefully', async () => {
    const mockClient = {
      callAPI: vi.fn().mockResolvedValue(null)
    } as unknown as LogseqClient;

    await expect(buildContextForTopic(mockClient, 'NonExistent'))
      .rejects.toThrow('Page not found: NonExistent');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- build-context.test.ts`

Expected: FAIL with "Cannot find module './build-context.js'"

**Step 3: Write minimal implementation**

Create `src/tools/build-context.ts`:

```typescript
import { LogseqClient } from '../client.js';
import { PageEntity, BlockEntity } from '../types.js';

export interface ContextOptions {
  maxBlocks?: number;
  maxRelatedPages?: number;
  maxReferences?: number;
  includeTemporalContext?: boolean;
}

export interface TopicContext {
  topic: string;
  mainPage: PageEntity;
  directBlocks: BlockEntity[];
  relatedPages: Array<{
    page: PageEntity;
    relationshipType: 'outbound' | 'inbound';
  }>;
  references: Array<{
    block: BlockEntity;
    sourcePage: PageEntity;
  }>;
  temporalContext?: {
    isJournal: boolean;
    date?: number;
    nearbyDates?: Array<{
      date: number;
      pageName: string;
    }>;
  };
  summary: {
    totalBlocks: number;
    totalRelatedPages: number;
    totalReferences: number;
    pageProperties: Record<string, any>;
  };
}

/**
 * Build comprehensive context for a topic
 * @param client - LogseqClient instance
 * @param topicName - Name of the topic
 * @param options - Options for context building
 * @returns TopicContext with all relevant information
 */
export async function buildContextForTopic(
  client: LogseqClient,
  topicName: string,
  options: ContextOptions = {}
): Promise<TopicContext> {
  const {
    maxBlocks = 50,
    maxRelatedPages = 10,
    maxReferences = 20,
    includeTemporalContext = true
  } = options;

  // Get main page
  const mainPage = await client.callAPI<PageEntity | null>(
    'logseq.Editor.getPage',
    [topicName]
  );

  if (mainPage === null) {
    throw new Error(`Page not found: ${topicName}`);
  }

  // Get direct blocks from the page
  const allBlocks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [topicName]
  );

  const directBlocks = (allBlocks || []).slice(0, maxBlocks);

  // Get related pages (outbound references)
  const outboundRefs = await client.callAPI<PageEntity[]>(
    'logseq.Editor.getPageLinkedReferences',
    [topicName]
  );

  // Get backlinks (inbound references)
  const backlinks = await client.callAPI<BlockEntity[]>(
    'logseq.Editor.getPageBlocksTree',
    [topicName]
  );

  const relatedPages: TopicContext['relatedPages'] = [];
  const seenPageIds = new Set<number>([mainPage.id]);

  // Add outbound references
  for (const page of (outboundRefs || []).slice(0, maxRelatedPages / 2)) {
    if (!seenPageIds.has(page.id)) {
      seenPageIds.add(page.id);
      relatedPages.push({
        page,
        relationshipType: 'outbound'
      });
    }
  }

  // Add inbound references from unique pages
  const inboundPages = new Map<number, PageEntity>();
  for (const block of backlinks || []) {
    if (block.page && !seenPageIds.has(block.page.id)) {
      inboundPages.set(block.page.id, block.page);
    }
  }

  for (const [_, page] of Array.from(inboundPages.entries()).slice(0, maxRelatedPages / 2)) {
    seenPageIds.add(page.id);
    relatedPages.push({
      page,
      relationshipType: 'inbound'
    });
  }

  // Get reference blocks (blocks that mention this topic)
  const references: TopicContext['references'] = [];
  for (const block of (backlinks || []).slice(0, maxReferences)) {
    if (block.page) {
      references.push({
        block,
        sourcePage: block.page
      });
    }
  }

  // Build temporal context for journal pages
  let temporalContext: TopicContext['temporalContext'] | undefined;

  if (includeTemporalContext && mainPage['journal?']) {
    temporalContext = {
      isJournal: true,
      date: mainPage.journalDay
    };

    // Get nearby dates (±3 days)
    if (mainPage.journalDay) {
      const nearbyDates: Array<{ date: number; pageName: string }> = [];
      const baseDate = mainPage.journalDay;

      for (let offset = -3; offset <= 3; offset++) {
        if (offset === 0) continue;

        // Simple date arithmetic (ignores month boundaries for simplicity)
        const nearDate = baseDate + offset;

        try {
          const nearPage = await client.callAPI<PageEntity | null>(
            'logseq.Editor.getPage',
            [nearDate.toString()]
          );

          if (nearPage) {
            nearbyDates.push({
              date: nearDate,
              pageName: nearPage.name
            });
          }
        } catch {
          // Page doesn't exist, skip
        }
      }

      temporalContext.nearbyDates = nearbyDates;
    }
  } else if (includeTemporalContext) {
    temporalContext = {
      isJournal: false
    };
  }

  // Build summary
  const summary = {
    totalBlocks: directBlocks.length,
    totalRelatedPages: relatedPages.length,
    totalReferences: references.length,
    pageProperties: mainPage.properties || {}
  };

  return {
    topic: topicName,
    mainPage,
    directBlocks,
    relatedPages,
    references,
    temporalContext,
    summary
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- build-context.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { buildContextForTopic } from './tools/build-context.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_build_context',
    description: 'Build comprehensive context for a topic including related pages, blocks, and references',
    inputSchema: {
      type: 'object',
      properties: {
        topic_name: {
          type: 'string',
          description: 'Name of the topic to build context for',
        },
        max_blocks: {
          type: 'number',
          description: 'Maximum number of blocks to include (default: 50)',
          default: 50,
        },
        max_related_pages: {
          type: 'number',
          description: 'Maximum number of related pages to include (default: 10)',
          default: 10,
        },
        max_references: {
          type: 'number',
          description: 'Maximum number of reference blocks to include (default: 20)',
          default: 20,
        },
        include_temporal_context: {
          type: 'boolean',
          description: 'Include temporal context for journal pages (default: true)',
          default: true,
        },
      },
      required: ['topic_name'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_build_context': {
          const topicName = args?.topic_name as string;
          const options = {
            maxBlocks: args?.max_blocks as number | undefined,
            maxRelatedPages: args?.max_related_pages as number | undefined,
            maxReferences: args?.max_references as number | undefined,
            includeTemporalContext: args?.include_temporal_context as boolean | undefined
          };
          const result = await buildContextForTopic(client, topicName, options);
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
git add src/tools/build-context.ts src/tools/build-context.test.ts src/index.ts
git commit -m "feat: add build_context tool for LLM context gathering"
```

---

## Task 2: Add get_context_for_query tool

**Files:**
- Create: `src/tools/get-context-for-query.ts`
- Create: `src/tools/get-context-for-query.test.ts`
- Modify: `src/index.ts` (add import, schema, handler)

**Step 1: Write the failing test**

Create `src/tools/get-context-for-query.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { getContextForQuery } from './get-context-for-query.js';
import { LogseqClient } from '../client.js';

describe('getContextForQuery', () => {
  it('should extract topics from query and build context', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search for topics mentioned in query
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 1, name: 'Project X', properties: {} }
    ]);

    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 2, name: 'Team Meeting', properties: {} }
    ]);

    // Mock blocks for each topic
    (mockClient.callAPI as any).mockResolvedValue([
      { id: 10, content: 'Relevant block' }
    ]);

    const result = await getContextForQuery(
      mockClient,
      'What did we discuss about [[Project X]] in the [[Team Meeting]]?'
    );

    expect(result).toHaveProperty('query');
    expect(result).toHaveProperty('extractedTopics');
    expect(result.extractedTopics).toContain('Project X');
    expect(result.extractedTopics).toContain('Team Meeting');
    expect(result).toHaveProperty('contexts');
    expect(result.contexts).toHaveLength(2);
  });

  it('should handle queries with no explicit topics', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock search results
    (mockClient.callAPI as any).mockResolvedValueOnce([
      { id: 1, content: 'Block about databases', page: { name: 'Tech' } }
    ]);

    const result = await getContextForQuery(
      mockClient,
      'How do databases work?'
    );

    expect(result.extractedTopics.length).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('searchResults');
  });

  it('should combine multiple topic contexts efficiently', async () => {
    const mockClient = {
      callAPI: vi.fn()
    } as unknown as LogseqClient;

    // Mock topic pages
    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 1,
      name: 'Topic A'
    });

    (mockClient.callAPI as any).mockResolvedValueOnce({
      id: 2,
      name: 'Topic B'
    });

    // Mock blocks
    (mockClient.callAPI as any).mockResolvedValue([]);

    const result = await getContextForQuery(
      mockClient,
      'Compare [[Topic A]] and [[Topic B]]'
    );

    expect(result.contexts.length).toBe(2);
    expect(result.extractedTopics).toEqual(['Topic A', 'Topic B']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- get-context-for-query.test.ts`

Expected: FAIL with "Cannot find module './get-context-for-query.js'"

**Step 3: Write minimal implementation**

Create `src/tools/get-context-for-query.ts`:

```typescript
import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';
import { buildContextForTopic, TopicContext } from './build-context.js';

export interface QueryContext {
  query: string;
  extractedTopics: string[];
  contexts: TopicContext[];
  searchResults?: BlockEntity[];
  summary: {
    totalTopics: number;
    totalBlocks: number;
    totalPages: number;
  };
}

/**
 * Extract page references from query text
 * @param query - Query string
 * @returns Array of extracted topic names
 */
function extractTopicsFromQuery(query: string): string[] {
  const topics: string[] = [];

  // Extract [[page references]]
  const pageRefMatches = query.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const match of pageRefMatches) {
    topics.push(match[1]);
  }

  // Extract #tags
  const tagMatches = query.matchAll(/#([^\s#]+)/g);
  for (const match of tagMatches) {
    topics.push(match[1]);
  }

  return [...new Set(topics)]; // Deduplicate
}

/**
 * Get context for a natural language query
 * @param client - LogseqClient instance
 * @param query - Natural language query
 * @param options - Options for context gathering
 * @returns QueryContext with all relevant information
 */
export async function getContextForQuery(
  client: LogseqClient,
  query: string,
  options: {
    maxTopics?: number;
    maxSearchResults?: number;
  } = {}
): Promise<QueryContext> {
  const { maxTopics = 5, maxSearchResults = 20 } = options;

  // Extract topics from query
  const extractedTopics = extractTopicsFromQuery(query);

  // Build context for each extracted topic
  const contexts: TopicContext[] = [];

  for (const topic of extractedTopics.slice(0, maxTopics)) {
    try {
      const context = await buildContextForTopic(client, topic, {
        maxBlocks: 10,
        maxRelatedPages: 5,
        maxReferences: 10
      });
      contexts.push(context);
    } catch (error) {
      // Topic page doesn't exist, skip
      console.error(`Failed to build context for ${topic}:`, error);
    }
  }

  // If no explicit topics, do a text search
  let searchResults: BlockEntity[] | undefined;

  if (extractedTopics.length === 0) {
    // Extract keywords from query (simple approach: remove common words)
    const commonWords = new Set([
      'what', 'when', 'where', 'who', 'why', 'how',
      'the', 'a', 'an', 'is', 'are', 'was', 'were',
      'do', 'does', 'did', 'can', 'could', 'should',
      'would', 'in', 'on', 'at', 'to', 'for', 'of',
      'with', 'about', 'by'
    ]);

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 3 && !commonWords.has(word))
      .slice(0, 3);

    // Search for blocks containing keywords
    if (keywords.length > 0) {
      try {
        const blocks = await client.callAPI<BlockEntity[]>(
          'logseq.DB.q',
          [`(and ${keywords.map(k => `(block-content "${k}")`).join(' ')})`]
        );

        searchResults = (blocks || []).slice(0, maxSearchResults);
      } catch (error) {
        // Search failed, continue without results
        searchResults = [];
      }
    }
  }

  // Build summary
  const totalBlocks = contexts.reduce(
    (sum, ctx) => sum + ctx.directBlocks.length,
    0
  ) + (searchResults?.length || 0);

  const totalPages = new Set(
    contexts.flatMap(ctx => [
      ctx.mainPage.id,
      ...ctx.relatedPages.map(rp => rp.page.id)
    ])
  ).size;

  return {
    query,
    extractedTopics,
    contexts,
    searchResults,
    summary: {
      totalTopics: contexts.length,
      totalBlocks,
      totalPages
    }
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- get-context-for-query.test.ts`

Expected: PASS

**Step 5: Register tool in MCP server**

Add import in `src/index.ts`:
```typescript
import { getContextForQuery } from './tools/get-context-for-query.js';
```

Add tool schema:
```typescript
  {
    name: 'logseq_get_context_for_query',
    description: 'Get comprehensive context for a natural language query by extracting topics and gathering related information',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query (can include [[page references]] and #tags)',
        },
        max_topics: {
          type: 'number',
          description: 'Maximum number of topics to extract context for (default: 5)',
          default: 5,
        },
        max_search_results: {
          type: 'number',
          description: 'Maximum number of search results for queries without explicit topics (default: 20)',
          default: 20,
        },
      },
      required: ['query'],
    },
  },
```

Add handler case:
```typescript
        case 'logseq_get_context_for_query': {
          const query = args?.query as string;
          const options = {
            maxTopics: args?.max_topics as number | undefined,
            maxSearchResults: args?.max_search_results as number | undefined
          };
          const result = await getContextForQuery(client, query, options);
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
git add src/tools/get-context-for-query.ts src/tools/get-context-for-query.test.ts src/index.ts
git commit -m "feat: add get_context_for_query for natural language queries"
```

---

## Task 3: Integration testing

**Files:**
- Create: `tests/integration/context-building.test.ts`

**Step 1: Write integration tests**

Create `tests/integration/context-building.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LogseqClient } from '../../src/client.js';

describe('Context Building Integration', () => {
  const shouldRun = !!process.env.LOGSEQ_TEST_API_URL;

  it.skipIf(!shouldRun)('build_context gathers comprehensive topic info', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { buildContextForTopic } = await import(
      '../../src/tools/build-context.js'
    );

    const result = await buildContextForTopic(client, 'Test Topic');

    expect(result).toHaveProperty('mainPage');
    expect(result).toHaveProperty('directBlocks');
    expect(result).toHaveProperty('relatedPages');
    expect(result).toHaveProperty('summary');
  });

  it.skipIf(!shouldRun)('get_context_for_query extracts topics correctly', async () => {
    const client = new LogseqClient({
      apiUrl: process.env.LOGSEQ_TEST_API_URL!,
      authToken: process.env.LOGSEQ_TEST_TOKEN!
    });

    const { getContextForQuery } = await import(
      '../../src/tools/get-context-for-query.js'
    );

    const result = await getContextForQuery(
      client,
      'What did I write about [[Testing]]?'
    );

    expect(result.extractedTopics).toContain('Testing');
    expect(result).toHaveProperty('contexts');
    expect(result).toHaveProperty('summary');
  });
});
```

**Step 2: Run integration tests**

Run: `npm run test:integration`

Expected: Tests skip or PASS if configured

**Step 3: Commit**

```bash
git add tests/integration/context-building.test.ts
git commit -m "test: add integration tests for context building"
```

---

## Execution Complete

Context building tools implemented:
- ✅ `build_context` - Gather comprehensive context for a topic
- ✅ `get_context_for_query` - Extract topics and build context from natural language
- ✅ Smart topic extraction from queries
- ✅ Configurable context limits

**Next steps:**
1. Add context caching for performance
2. Implement relevance scoring for context prioritization
3. Add context summarization for very large knowledge graphs
