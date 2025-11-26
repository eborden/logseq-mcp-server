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

6. **Create Test Data**:
   In your LogSeq test graph, create the following pages:
   - A page named "Integration Test Page" with some content
   - A page with a property like `status:: testing`
   - Some blocks with searchable content

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

**Authentication Error (401):**
- Regenerate auth token in LogSeq settings
- Update token in config file
- Restart LogSeq after changing settings

**Test Failures:**
- Verify test data exists in your graph
- Check LogSeq console for errors
- Ensure no other process is using port 12315
