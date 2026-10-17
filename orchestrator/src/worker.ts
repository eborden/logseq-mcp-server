// The worker: runs the workflows and activities on one task queue. Start it with `npm run worker`.
// SIGINT and SIGTERM shut it down gracefully; a SIGKILL is a crash, which is what the crash test relies on.

import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities/hello.ts';
import { loadConfig } from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const connection = await NativeConnection.connect({ address: config.address });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities,
  });

  const shutdown = (): void => worker.shutdown();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.error(`worker polling ${config.address} namespace=${config.namespace} taskQueue=${config.taskQueue}`);
  try {
    await worker.run();
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
