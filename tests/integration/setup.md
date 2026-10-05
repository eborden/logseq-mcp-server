# Integration Test Setup

This directory contains integration tests that require a live LogSeq instance with HTTP API enabled.

## Prerequisites

1. **LogSeq Installation**: Install LogSeq desktop application
2. **Test Graph**: Create or open a test graph in LogSeq
3. **Enable HTTP Server**:
   - Open LogSeq Settings
   - Navigate to Features → API
   - Enable "HTTP APIs server"
   - Note the server URL (default: `http://127.0.0.1:12315`)

4. **Generate Auth Token**:
   - In the same API settings page
   - Click "Generate token" or copy existing token
   - Save this token securely

5. **Configure Test Environment**:
   Create a config file at `~/.logseq-mcp/config.json`:
   ```json
   {
     "apiUrl": "http://127.0.0.1:12315",
     "authToken": "your-token-here"
   }
   ```
   Optional: add `"timeoutMs"` (positive number, default `30000`) to change the per-call timeout.
   Optional: add `"tips": false` (or set `LOGSEQ_MCP_TIPS=off`, which wins over the file) to drop the next-step hints from results. The variable accepts `on`/`true`/`1`/`yes` and `off`/`false`/`0`/`no`; any other value is a configuration error.

6. **Create Test Data**:
   In your LogSeq test graph, create the following pages:
   - A page named "Integration Test Page" with some content
   - A page with a property like `status:: testing`
   - Some blocks with searchable content

### Page resolution data

`page-resolution.test.ts` (#41) discovers its data in the running graph and asserts structure only. The graph needs:

- a journal page with at least one block;
- a page with `alias:: x` where no other page declares `x`;
- an alias declared by two or more pages (e.g. two pages that both say `alias:: x`);
- a namespace leaf used under two or more namespaces (`a/leaf`, `b/leaf`) with no page or alias named just `leaf`.

`output-format.test.ts` (#43) needs a page with a file and at least 3 blocks, a page referenced from elsewhere, a page with a property block (properties at the top of the page), and the same alias and journal data as page resolution. It asserts structure only.

### Alias data

`alias-sets.test.ts` (#69) needs a page with an `alias:: x` declared by that page alone, where at least one other block links `[[x]]`. It also needs one page with a file and no alias, for the unchanged case. It asserts that asking by `x` and by the declaring page's name covers the same blocks.

`temporal-queries.test.ts` also needs a page that exists but has no file, no blocks, no references and no aliases (a link target nobody links to any more), to check that `get_concept_evolution` returns an empty timeline for a page nothing mentions.

## Running Integration Tests

```bash
# Run all integration tests
npm run test:integration

# Run with watch mode (during development)
npm run test:integration -- --watch

# Run with verbose output
npm run test:integration -- --reporter=verbose
```

## Test Behavior

- Tests will **FAIL** (not skip) if LogSeq is not running or not configured
- Tests will **FAIL** (not skip) if required test data doesn't exist
- Tests verify actual API responses from LogSeq
- Tests are non-destructive (read-only operations)

### Why Tests Fail Instead of Skip

Integration tests must prove the system works correctly. A test that skips or passes without finding data proves nothing.

**Before:** Missing data → console.warn → test passes ✅ (false positive)
**After:** Missing data → test fails ❌ (honest failure)

If tests fail, follow the setup instructions to:
1. Start LogSeq with HTTP server enabled
2. Create required test data in your graph

## Troubleshooting

**Connection Refused Error:**
- Ensure LogSeq is running
- Check that HTTP server is enabled in settings
- Verify the API URL in your config

**Authentication Error (401, `LogSeqAuthError`):**
- Regenerate auth token in LogSeq settings
- Update token in config file
- Restart LogSeq after changing settings

**Timeout Error:**
- LogSeq is reachable but not answering; check it is not busy or stuck
- Raise `timeoutMs` in the config file if calls are legitimately slow

**Test Failures:**
- Verify test data exists in your graph
- Check LogSeq console for errors
- Ensure no other process is using port 12315
