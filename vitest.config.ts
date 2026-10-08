import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The repo's own guard tests (#356): tests/guards needs nothing but Node, and tests/rust-guards starts the Rust
    // debug build (`cd rust && cargo build`), as the parity harness does. The server's own tests are Rust's
    // (`cd rust && cargo test`). tests/integration/ runs only through vitest.integration.config.ts
    // (`npm run test:integration`), whose global setup checks for the fixture graph first (#90).
    include: ['tests/guards/**/*.test.ts', 'tests/rust-guards/**/*.test.ts'],
    // Agent worktrees live under .claude/worktrees/ and contain full copies of the test suite.
    // .logseq-instance/ is the per-worktree LogSeq's scratch folder (profile, graph copy); anything
    // copied there is not this checkout's tests.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.logseq-instance/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
