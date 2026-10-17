// `npm run start-server`: runs the Temporal dev server in the foreground with a SQLite file under .temporal/
// (gitignored). Ctrl-C stops it; the history stays in the file.

import { loadServerConfig } from './config.ts';
import { startDevServer } from './dev-server.ts';

async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const server = await startDevServer(config);
  console.error(`temporal dev server listening on 127.0.0.1:${config.port}, db ${config.dbFilename}`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await server.teardown();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
