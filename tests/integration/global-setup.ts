import { connectFixture } from './helpers/fixture-client.js';

/**
 * Global setup for `npm run test:integration` (#90). Runs once, before any suite, and stops the
 * whole run unless the LogSeq API serves the fixture graph. Every suite checks again in its own
 * `beforeAll` (a single file run with another config skips this), but a wrong graph or a stopped
 * instance then fails here once, with the instructions, instead of in every file.
 *
 * It does not start LogSeq. Launching a desktop app from a test command is slow (the instance
 * waits up to 90 seconds for indexing), macOS-only, and would restart it on every run; an instance
 * started by hand serves any number of runs. `HOW_TO_RUN` in the error says what to do.
 */
export default async function setup(): Promise<void> {
  await connectFixture();
}
