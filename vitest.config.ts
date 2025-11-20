import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000, // 30s timeout for all tests (integration tests need time to scan graph)
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
