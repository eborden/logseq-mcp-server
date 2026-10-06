import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent git worktrees live under .claude/worktrees/ and contain full copies of the test suite
    // tests/integration/fixture-only/ needs the fixture graph: `npm run test:integration:fixture` (#90)
    exclude: [...configDefaults.exclude, '**/.claude/**', 'tests/integration/fixture-only/**'],
    testTimeout: 30000, // 30s timeout for all tests (integration tests need time to scan graph)
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
