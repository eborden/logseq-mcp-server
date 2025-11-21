# Datalog Optimization Design

## Overview
Add Datalog query support to optimize performance of graph traversal, context building, and relationship search operations in the LogSeq MCP server.

## Design Validated
✅ Feature flag system for gradual migration
✅ Datalog query execution via `LogseqClient.executeDatalogQuery()`
✅ Query builder patterns for reusable Datalog templates

## Implementation Status

### Phase 1: Foundation (COMPLETED)
- [x] Add feature flags to `LogseqMCPConfig` type
- [x] Implement `loadConfig()` support for features field
- [x] Add `executeDatalogQuery()` method to `LogseqClient`
- [x] Create `src/datalog/queries.ts` with query builders
- [x] Tests for all foundation components

### Phase 2: Tool Implementations (IN PROGRESS)
- [ ] Rename existing `get-concept-network.ts` → `get-concept-network-http.ts`
- [ ] Implement `get-concept-network-datalog.ts`
- [ ] Create router `get-concept-network.ts` with feature flag logic
- [ ] Rename existing `build-context.ts` → `build-context-http.ts`
- [ ] Implement `build-context-datalog.ts`
- [ ] Create router `build-context.ts` with feature flag logic
- [ ] Rename existing `search-by-relationship.ts` → `search-by-relationship-http.ts`
- [ ] Implement `search-by-relationship-datalog.ts`
- [ ] Create router `search-by-relationship.ts` with feature flag logic

### Phase 3: Testing & Validation (PENDING)
- [ ] Create test data verification script (`scripts/verify-test-data.ts`)
- [ ] Write `TEST_DATA.md` documentation
- [ ] Implement `datalog-equivalence.test.ts` integration tests
- [ ] Create benchmark suite comparing HTTP vs Datalog performance
- [ ] Update `package.json` with verification and benchmark scripts

### Phase 4: Documentation (PENDING)
- [ ] Write migration guide for users
- [ ] Document Datalog query patterns
- [ ] Add troubleshooting guide

## Architecture

### Feature Flag Configuration
```json
{
  "apiUrl": "http://127.0.0.1:12315",
  "authToken": "...",
  "features": {
    "useDatalog": {
      "conceptNetwork": true,
      "buildContext": false,
      "searchByRelationship": false
    }
  }
}
```

### File Structure
```
src/
  datalog/
    queries.ts       - Datalog query builders
    helpers.ts       - Result transformers (TODO)
  tools/
    get-concept-network.ts          - Feature flag router
    get-concept-network-http.ts     - HTTP implementation
    get-concept-network-datalog.ts  - Datalog implementation
    [similar pattern for other tools]
```

### Tool Entry Point Pattern
```typescript
export async function getConceptNetwork(
  client: LogseqClient,
  conceptName: string,
  maxDepth: number = 2
): Promise<ConceptNetworkResult> {
  const useDatalog = client.config.features?.useDatalog;
  const toolEnabled = typeof useDatalog === 'object'
    ? useDatalog.conceptNetwork
    : useDatalog;

  if (toolEnabled) {
    return getConceptNetworkDatalog(client, conceptName, maxDepth);
  }

  return getConceptNetworkHTTP(client, conceptName, maxDepth);
}
```

## Performance Goals

| Operation | HTTP Calls | Datalog Calls | Target Speedup |
|-----------|------------|---------------|----------------|
| get-concept-network (depth=2) | 10+ | 1 | 5-10x |
| build-context | 5+ | 1 | 3-5x |
| search-by-relationship | 3-5 | 1 | 2-4x |

## Success Criteria

**Performance:**
- All operations meet or exceed target speedup
- Latency p50, p95, p99 all improved

**Correctness:**
- Equivalence tests pass: Datalog results match HTTP results
- No data loss or corruption
- Proper error handling

**Stability:**
- Error rate ≤ HTTP implementation
- No crashes or hangs
- Graceful degradation on malformed queries

## Rollout Plan

1. **Week 1-2:** Implement all three Datalog tools
2. **Week 2:** Run equivalence tests and benchmarks
3. **Week 3:** Enable `conceptNetwork` Datalog in production (monitor)
4. **Week 3-4:** Enable remaining tools if successful
5. **Week 4+:** Make Datalog default, remove feature flags after 2 weeks stable

## Test Data Requirements

Integration tests require:
- **Testing** page: 3+ blocks, links to 1+ pages, 1+ backlinks
- **TypeScript** page: 5+ blocks, links to 1+ pages, 1+ backlinks
- **Machine Learning** page: 5+ blocks, links to 2+ pages, 1+ backlinks

See `tests/integration/TEST_DATA.md` for setup guide.

Generated with [Claude Code](https://claude.com/claude-code)
