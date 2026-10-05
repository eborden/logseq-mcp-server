import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent git worktrees live under .claude/worktrees/ and contain full copies of the test suite
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    testTimeout: 30000, // 30s timeout for all tests (integration tests need time to scan graph)
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
