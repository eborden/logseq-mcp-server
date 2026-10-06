import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent git worktrees live under .claude/worktrees/ and contain full copies of the test suite.
    // tests/integration/ runs only through vitest.integration.config.ts (`npm run test:integration`),
    // whose global setup checks for the fixture graph first (#90). `npm test` runs both.
    exclude: [...configDefaults.exclude, '**/.claude/**', 'tests/integration/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
