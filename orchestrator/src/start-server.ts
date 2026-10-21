// `npm run start-server`: runs the Temporal dev server in the foreground with a SQLite file under .temporal/
// (gitignored). Ctrl-C (SIGINT) or SIGTERM stops it cleanly; the history stays in the file.
//
// The process must stay up until a signal. Signal listeners do not keep Node's event loop alive, and the SDK
// runs the server through its native bridge, which does not hold the loop open either, so without the timer
// below Node would find nothing left to do, exit 0 and take the server down with it.

import { loadServerConfig } from './config.ts';
import { startDevServer } from './dev-server.ts';

// Longest delay setInterval accepts (a signed 32-bit number of milliseconds). The callback never needs to run.
const KEEP_ALIVE_MS = 2 ** 31 - 1;

async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const server = await startDevServer(config);
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);
  console.error(`temporal dev server listening on 127.0.0.1:${config.port}, db ${config.dbFilename}`);

  try {
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
  } finally {
    clearInterval(keepAlive);
  }
  await server.teardown();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
