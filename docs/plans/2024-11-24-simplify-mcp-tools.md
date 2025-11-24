# Simplify MCP Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce LogSeq MCP server from 13 tools to 10-11 tools by removing redundant/incomplete implementations and optionally merging overlapping search tools.

**Architecture:** Two-phase approach - Phase 1 removes 2 redundant tools (low risk), Phase 2 merges 2 search tools into unified interface (medium risk, optional).

**Tech Stack:** TypeScript, Vitest, MCP SDK

---

## Phase 1: Remove Redundant Tools (Low Risk)

### Task 1: Remove get_entity_timeline Tool

**Rationale:** `get_entity_timeline` is a complete subset of `get_concept_evolution`. Users can call `get_concept_evolution` without groupBy parameter to get identical functionality.

**Files:**
- Delete: `src/tools/get-entity-timeline.ts`
- Delete: `src/tools/get-entity-timeline.test.ts`
- Modify: `src/index.ts:36` (remove tool handler)

**Step 1: Verify test coverage exists**

Run: `npx vitest run src/tools/get-entity-timeline.test.ts`
Expected: Tests pass (baseline)

**Step 2: Delete test file**

```bash
rm src/tools/get-entity-timeline.test.ts
```

**Step 3: Delete implementation file**

```bash
rm src/tools/get-entity-timeline.ts
```

**Step 4: Remove tool handler from index.ts**

In `src/index.ts`, remove:
- Import statement: `import { getEntityTimeline } from './tools/get-entity-timeline.js';`
- Tool handler case in server.setRequestHandler (around line 70-80)

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass (no dependencies on removed tool)

**Step 6: Build and verify**

Run: `npm run build`
Expected: Successful build with no errors

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove redundant get_entity_timeline tool

get_concept_evolution provides identical functionality when called
without groupBy parameter. Removing to reduce API surface.

Tools: 13 → 12"
```

---

### Task 2: Remove get_related_pages Tool

**Rationale:** `get_related_pages` has incomplete implementation (claims depth 1-3 support but only implements depth=1) and is fully replaced by `get_concept_network`.

**Files:**
- Delete: `src/tools/get-related-pages.ts`
- Delete: `src/tools/get-related-pages.test.ts`
- Modify: `src/index.ts:36` (remove tool handler)

**Step 1: Verify test coverage exists**

Run: `npx vitest run src/tools/get-related-pages.test.ts`
Expected: Tests pass (baseline)

**Step 2: Delete test file**

```bash
rm src/tools/get-related-pages.test.ts
```

**Step 3: Delete implementation file**

```bash
rm src/tools/get-related-pages.ts
```

**Step 4: Remove tool handler from index.ts**

In `src/index.ts`, remove:
- Import statement: `import { getRelatedPages } from './tools/get-related-pages.js';`
- Tool handler case in server.setRequestHandler

**Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass

**Step 6: Build and verify**

Run: `npm run build`
Expected: Successful build with no errors

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove incomplete get_related_pages tool

Tool claimed to support depth 1-3 but only implemented depth=1.
get_concept_network provides complete, correct implementation.
Users can call get_concept_network(page, 1) for equivalent results.

Tools: 12 → 11"
```

---

### Task 3: Update Documentation (Phase 1)

**Files:**
- Modify: `README.md` (update tool count)
- Modify: `.claude/CLAUDE.md:6` (fix tool count)

**Step 1: Update README.md**

Find and update tool count references:
- Change "18 tools" → "11 tools"
- Update any tool lists to remove deleted tools
- Add migration note if needed

**Step 2: Update CLAUDE.md**

Line 6 currently says "18 MCP tools". Update to:
```markdown
- 11 MCP tools for graph operations, search, and temporal queries
```

Add note in "Migration History" section:
```markdown
### Phase 5: Tool Simplification (Nov 24, 2024)
- Removed redundant get_entity_timeline (subset of get_concept_evolution)
- Removed incomplete get_related_pages (replaced by get_concept_network)
- Net: -2 tools, -195 lines
- **Result:** 13 → 11 tools (15% reduction)
```

**Step 3: Commit**

```bash
git add README.md .claude/CLAUDE.md
git commit -m "docs: update tool count after Phase 1 simplification

Updated documentation to reflect removal of 2 redundant tools.
Tool count: 13 → 11 (15% reduction, ~195 lines removed)"
```

---

## Phase 1 Complete: Verification Checklist

After completing Tasks 1-3:

- [ ] Tool count reduced: 13 → 11
- [ ] All tests passing: `npm test`
- [ ] Build successful: `npm run build`
- [ ] No broken imports or references
- [ ] Documentation updated with correct tool count
- [ ] Git history shows 3 clean commits

**Phase 1 Result:** 15% reduction in API surface, ~195 lines removed, zero functional loss.

---

## Phase 2: Merge Search Tools (Optional, Medium Risk)

### Task 4: Create Unified query-blocks Tool

**Rationale:** `search_blocks` and `query_by_property` share 80% of their code (both iterate all pages/blocks with different filters). Merging into single tool with `query_type` parameter eliminates duplication.

**Files:**
- Create: `src/tools/query-blocks.ts`
- Create: `src/tools/query-blocks.test.ts`

**Step 1: Write failing test for content queries**

Create `src/tools/query-blocks.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { queryBlocks } from './query-blocks.js';
import type { LogseqClient } from '../client.js';

describe('queryBlocks', () => {
  let mockClient: LogseqClient;

  beforeEach(() => {
    mockClient = {
      getPage: vi.fn(),
      getAllPages: vi.fn(),
    } as any;
  });

  describe('content queries', () => {
    it('should search block content with query_type=content', async () => {
      vi.mocked(mockClient.getAllPages).mockResolvedValue([
        { name: 'page1', uuid: 'uuid1' }
      ]);
      vi.mocked(mockClient.getPage).mockResolvedValue({
        name: 'page1',
        'journal?': false,
        properties: {},
        blocks: [
          { content: 'test content here', uuid: 'block1' }
        ]
      });

      const result = await queryBlocks(
        mockClient,
        'content',
        'test content'
      );

      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].content).toContain('test content');
    });
  });

  describe('property queries', () => {
    it('should search block properties with query_type=property', async () => {
      vi.mocked(mockClient.getAllPages).mockResolvedValue([
        { name: 'page1', uuid: 'uuid1' }
      ]);
      vi.mocked(mockClient.getPage).mockResolvedValue({
        name: 'page1',
        'journal?': false,
        properties: {},
        blocks: [
          {
            content: 'block with property',
            uuid: 'block1',
            properties: { status: 'done' }
          }
        ]
      });

      const result = await queryBlocks(
        mockClient,
        'property',
        'done',
        { propertyKey: 'status' }
      );

      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0].properties?.status).toBe('done');
    });

    it('should require propertyKey for property queries', async () => {
      await expect(
        queryBlocks(mockClient, 'property', 'value')
      ).rejects.toThrow('propertyKey is required');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/query-blocks.test.ts`
Expected: FAIL with "Cannot find module './query-blocks.js'"

**Step 3: Write minimal implementation**

Create `src/tools/query-blocks.ts`:

```typescript
import type { LogseqClient } from '../client.js';

export interface QueryBlocksOptions {
  propertyKey?: string;
  limit?: number;
  includeContext?: boolean;
}

export interface QueryBlocksResult {
  blocks: Array<{
    content: string;
    uuid: string;
    page?: string;
    properties?: Record<string, any>;
    tags?: string[];
    references?: string[];
  }>;
  totalMatches: number;
}

export async function queryBlocks(
  client: LogseqClient,
  queryType: 'content' | 'property',
  queryValue: string,
  options: QueryBlocksOptions = {}
): Promise<QueryBlocksResult> {
  const { propertyKey, limit, includeContext = false } = options;

  // Validate property queries require propertyKey
  if (queryType === 'property' && !propertyKey) {
    throw new Error('propertyKey is required for property queries');
  }

  const allPages = await client.getAllPages();
  const matchingBlocks: QueryBlocksResult['blocks'] = [];

  // Iterate through all pages and their blocks
  for (const pageInfo of allPages) {
    const page = await client.getPage(pageInfo.name, { includeChildren: true });
    if (!page?.blocks) continue;

    // Recursively search blocks
    const searchBlocks = (blocks: any[], pageName: string) => {
      for (const block of blocks) {
        let matches = false;

        if (queryType === 'content') {
          // Content search: case-insensitive substring match
          matches = block.content?.toLowerCase().includes(queryValue.toLowerCase());
        } else if (queryType === 'property') {
          // Property search: exact match on property value
          const propValue = block.properties?.[propertyKey!];
          matches = propValue !== undefined &&
                   String(propValue).toLowerCase() === queryValue.toLowerCase();
        }

        if (matches) {
          const blockData: any = {
            content: block.content,
            uuid: block.uuid,
            page: pageName,
          };

          // Include context if requested
          if (includeContext) {
            blockData.properties = block.properties || {};
            blockData.tags = extractTags(block.content);
            blockData.references = extractReferences(block.content);
          }

          matchingBlocks.push(blockData);

          // Check limit
          if (limit && matchingBlocks.length >= limit) {
            return;
          }
        }

        // Recurse into child blocks
        if (block.children) {
          searchBlocks(block.children, pageName);
        }
      }
    };

    searchBlocks(page.blocks, page.name);

    if (limit && matchingBlocks.length >= limit) {
      break;
    }
  }

  return {
    blocks: matchingBlocks,
    totalMatches: matchingBlocks.length,
  };
}

// Helper: Extract #tags from content
function extractTags(content: string): string[] {
  const tagRegex = /#([a-zA-Z0-9_-]+)/g;
  const tags: string[] = [];
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    tags.push(match[1]);
  }
  return tags;
}

// Helper: Extract [[page references]] from content
function extractReferences(content: string): string[] {
  const refRegex = /\[\[([^\]]+)\]\]/g;
  const refs: string[] = [];
  let match;
  while ((match = refRegex.exec(content)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/query-blocks.test.ts`
Expected: All tests PASS

**Step 5: Add integration test**

Add to test file:

```typescript
describe('integration', () => {
  it('should handle empty results gracefully', async () => {
    vi.mocked(mockClient.getAllPages).mockResolvedValue([]);

    const result = await queryBlocks(mockClient, 'content', 'nonexistent');

    expect(result.blocks).toHaveLength(0);
    expect(result.totalMatches).toBe(0);
  });

  it('should respect limit parameter', async () => {
    vi.mocked(mockClient.getAllPages).mockResolvedValue([
      { name: 'page1', uuid: 'uuid1' }
    ]);
    vi.mocked(mockClient.getPage).mockResolvedValue({
      name: 'page1',
      'journal?': false,
      properties: {},
      blocks: [
        { content: 'match 1', uuid: 'b1' },
        { content: 'match 2', uuid: 'b2' },
        { content: 'match 3', uuid: 'b3' },
      ]
    });

    const result = await queryBlocks(
      mockClient,
      'content',
      'match',
      { limit: 2 }
    );

    expect(result.blocks).toHaveLength(2);
  });
});
```

Run: `npx vitest run src/tools/query-blocks.test.ts`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/tools/query-blocks.ts src/tools/query-blocks.test.ts
git commit -m "feat: add unified query-blocks tool

Combines search_blocks and query_by_property functionality into
single tool with query_type parameter. Eliminates code duplication.

Supports:
- query_type: 'content' | 'property'
- Optional: limit, includeContext, propertyKey"
```

---

### Task 5: Add query-blocks to MCP Server

**Files:**
- Modify: `src/index.ts:36` (add tool handler)

**Step 1: Add import**

In `src/index.ts`, add:
```typescript
import { queryBlocks } from './tools/query-blocks.js';
```

**Step 2: Add tool handler**

In `server.setRequestHandler`, add case:

```typescript
case 'logseq_query_blocks': {
  const queryType = String(args.query_type);
  const queryValue = String(args.query_value);

  if (queryType !== 'content' && queryType !== 'property') {
    return {
      content: [{
        type: 'text',
        text: `Invalid query_type: ${queryType}. Must be 'content' or 'property'.`
      }],
      isError: true
    };
  }

  const options: any = {};
  if (args.property_key) options.propertyKey = String(args.property_key);
  if (args.limit) options.limit = Number(args.limit);
  if (args.include_context) options.includeContext = Boolean(args.include_context);

  const result = await queryBlocks(client, queryType as any, queryValue, options);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2)
    }]
  };
}
```

**Step 3: Add tool definition**

In `server.setRequestHandler` tools list, add:

```typescript
{
  name: 'logseq_query_blocks',
  description: 'Search for blocks by content or property value',
  inputSchema: {
    type: 'object',
    properties: {
      query_type: {
        type: 'string',
        enum: ['content', 'property'],
        description: 'Type of query: "content" searches block text, "property" searches block properties'
      },
      query_value: {
        type: 'string',
        description: 'Value to search for (text content or property value)'
      },
      property_key: {
        type: 'string',
        description: 'Property key to search (required when query_type=property)'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (optional)'
      },
      include_context: {
        type: 'boolean',
        description: 'Include semantic context (page, references, tags) in results (default: false)'
      }
    },
    required: ['query_type', 'query_value']
  }
}
```

**Step 4: Test build**

Run: `npm run build`
Expected: Successful build

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: register query-blocks tool in MCP server

Added tool handler and definition for unified query-blocks tool."
```

---

### Task 6: Remove search-blocks Tool

**Files:**
- Delete: `src/tools/search-blocks.ts`
- Delete: `src/tools/search-blocks.test.ts`
- Modify: `src/index.ts` (remove handler)

**Step 1: Remove from index.ts**

Remove:
- Import: `import { searchBlocks } from './tools/search-blocks.js';`
- Tool handler case for 'logseq_search_blocks'
- Tool definition in tools list

**Step 2: Delete files**

```bash
rm src/tools/search-blocks.ts src/tools/search-blocks.test.ts
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Build**

Run: `npm run build`
Expected: Successful build

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove search-blocks (replaced by query-blocks)

Functionality moved to query-blocks with query_type='content'.

Tools: 11 → 10"
```

---

### Task 7: Remove query-by-property Tool

**Files:**
- Delete: `src/tools/query-by-property.ts`
- Delete: `src/tools/query-by-property.test.ts`
- Modify: `src/index.ts` (remove handler)

**Step 1: Remove from index.ts**

Remove:
- Import: `import { queryByProperty } from './tools/query-by-property.js';`
- Tool handler case for 'logseq_query_by_property'
- Tool definition in tools list

**Step 2: Delete files**

```bash
rm src/tools/query-by-property.ts src/tools/query-by-property.test.ts
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Build**

Run: `npm run build`
Expected: Successful build

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove query-by-property (replaced by query-blocks)

Functionality moved to query-blocks with query_type='property'.

Tools: 10 → 10 (consolidation complete)"
```

---

### Task 8: Update Documentation (Phase 2)

**Files:**
- Modify: `README.md`
- Modify: `.claude/CLAUDE.md`

**Step 1: Update README.md**

Update tool count and descriptions:
- Change "11 tools" → "10 tools"
- Replace search_blocks and query_by_property with query_blocks
- Add migration guide for existing users

**Step 2: Update CLAUDE.md**

Update line 6:
```markdown
- 10 MCP tools for graph operations, search, and temporal queries
```

Update migration history:
```markdown
### Phase 6: Search Tool Consolidation (Nov 24, 2024)
- Merged search_blocks + query_by_property → query_blocks
- Eliminated code duplication (~40 lines shared iteration logic)
- Net: -1 tool, cleaner unified API
- **Result:** 11 → 10 tools (23% total reduction from original 13)
```

Add migration guide section:
```markdown
## Migration Guide: Phase 2 Search Tools

### Before (search_blocks)
```typescript
const result = await searchBlocks(client, 'my query', { limit: 10 });
```

### After (query_blocks)
```typescript
const result = await queryBlocks(client, 'content', 'my query', { limit: 10 });
```

### Before (query_by_property)
```typescript
const result = await queryByProperty(client, 'status', 'done');
```

### After (query_blocks)
```typescript
const result = await queryBlocks(client, 'property', 'done', { propertyKey: 'status' });
```
```

**Step 3: Commit**

```bash
git add README.md .claude/CLAUDE.md
git commit -m "docs: update for Phase 2 search tool consolidation

Updated documentation and added migration guide for query-blocks.
Tool count: 13 → 10 (23% total reduction)"
```

---

## Phase 2 Complete: Verification Checklist

After completing Tasks 4-8:

- [ ] Tool count reduced: 11 → 10
- [ ] query-blocks handles both content and property searches
- [ ] All tests passing: `npm test`
- [ ] Build successful: `npm run build`
- [ ] No broken imports or references
- [ ] Documentation updated with migration guide
- [ ] Git history shows clean, atomic commits

**Phase 2 Result:** 23% total reduction (13 → 10 tools), ~235 lines removed, code duplication eliminated.

---

## Final Verification

Run complete test suite:

```bash
# All unit tests
npm test

# Build
npm run build

# Integration tests (requires running LogSeq)
npx vitest run tests/integration/
```

**Success criteria:**
- ✅ All tests pass
- ✅ Build succeeds with no errors
- ✅ Tool count: 13 → 11 (Phase 1) or 13 → 10 (Phase 2)
- ✅ No functional regressions
- ✅ Documentation accurate

---

## Rollback Plan

If issues arise:

**Phase 2 rollback:**
```bash
git revert HEAD~5  # Revert last 5 commits (Tasks 4-8)
npm test && npm run build
```

**Phase 1 rollback:**
```bash
git revert HEAD~3  # Revert last 3 commits (Tasks 1-3)
npm test && npm run build
```

---

## Next Steps After Completion

1. **Test with real LogSeq instance** - Verify tools work in production
2. **Update MCP marketplace listing** (if applicable)
3. **Monitor for user feedback** on merged tools
4. **Consider Phase 3** (future): Simplify get_context_for_query
