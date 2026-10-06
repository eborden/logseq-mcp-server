import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

// Integration tests run against the fixture graph only (#90): tests/integration/global-setup.ts
// and every suite's beforeAll call requireFixtureGraph and fail loud against any other graph.
//
// With LOGSEQ_MCP_CONFIG unset, use this worktree's own instance when one is running
// (`npx tsx scripts/logseq-instance.ts start` writes .logseq-instance/config.json and `stop`
// deletes it), so a run never falls back to ~/.logseq-mcp/config.json while an instance is up.
// Set here, in the main process, so the global setup and every test worker see it.
const instanceConfig = join(dirname(fileURLToPath(import.meta.url)), '.logseq-instance', 'config.json');
if (!process.env.LOGSEQ_MCP_CONFIG?.trim() && existsSync(instanceConfig)) {
  process.env.LOGSEQ_MCP_CONFIG = instanceConfig;
}

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
