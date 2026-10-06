import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent git worktrees live under .claude/worktrees/ and contain full copies of the test suite.
    // tests/integration/ runs only through vitest.integration.config.ts (`npm run test:integration`),
    // whose global setup checks for the fixture graph first (#90). `npm test` runs both.
    // .logseq-instance/ is the per-worktree LogSeq's scratch folder (profile, graph copy); anything
    // copied there, such as a test harness with its own src/, is not this checkout's tests.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.logseq-instance/**', 'tests/integration/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
