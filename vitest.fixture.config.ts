import { defineConfig } from 'vitest/config';

// Integration tests that need the fixture graph (tests/fixtures/graph) and fail against any other.
// `npm run test:integration` leaves them out until #90 moves every suite to the fixture.
export default defineConfig({
  test: {
    include: ['tests/integration/fixture-only/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'node',
    globals: true,
  },
});
