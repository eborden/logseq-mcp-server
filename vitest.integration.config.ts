import { configDefaults, defineConfig } from 'vitest/config';
import { CONFIG_PATH_ENV, instanceConfigPath } from './tests/integration/helpers/instance-config.js';
import { existsSync } from 'fs';

// Integration tests run against the fixture graph only (#90): tests/integration/global-setup.ts
// and every suite's beforeAll call connectFixture, which uses LOGSEQ_MCP_CONFIG or this worktree's
// .logseq-instance/config.json, never ~/.logseq-mcp/config.json, refuses a config on port 12315
// before any network call, and fails loud against any graph but the fixture.
//
// With LOGSEQ_MCP_CONFIG unset, point it at the instance config when an instance is running
// (`npx tsx scripts/logseq-instance.ts start` writes it and `stop` deletes it). Set here, in the
// main process, so the global setup and every test worker see the same path, including suites
// that start the MCP server.
const instanceConfig = instanceConfigPath();
if (!process.env[CONFIG_PATH_ENV]?.trim() && existsSync(instanceConfig)) {
  process.env[CONFIG_PATH_ENV] = instanceConfig;
}

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Never a copy under the instance's scratch folder (profile, graph copy)
    exclude: [...configDefaults.exclude, '**/.logseq-instance/**'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
