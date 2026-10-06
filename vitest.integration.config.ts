import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Fixture-only suites run with `npm run test:integration:fixture` (vitest.fixture.config.ts) until #90
    exclude: [...configDefaults.exclude, 'tests/integration/fixture-only/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
