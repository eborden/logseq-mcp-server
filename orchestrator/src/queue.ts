// Manages the queue watcher's Schedule. `npm run queue -- create|pause|resume|delete [--cap N] [--every 5m]`
// (`create` also takes `--base`, `--repo-dir`, `--host-integration` and `--executor`, as `npm run run-issue` does, because
// each run the watcher starts is built from them). Nothing starts a schedule unless you run `create`. The schedule's
// overlap policy is skip. See src/queue-schedule.ts; the README ("The queue watcher") says what a tick does.

import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { loadConfig } from './config.ts';
import { changeQueueSchedule, createQueueSchedule, parseQueueArgs } from './queue-schedule.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { values, positionals } = parseArgs({
    options: {
      cap: { type: 'string' },
      every: { type: 'string' },
      base: { type: 'string' },
      'repo-dir': { type: 'string' },
      'host-integration': { type: 'boolean', default: false },
      executor: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const args = parseQueueArgs(positionals, {
    cap: values.cap,
    every: values.every,
    base: values.base,
    repoDir: values['repo-dir'],
    hostIntegration: values['host-integration'],
    executor: values.executor,
  });

  const connection = await Connection.connect({ address: config.address, connectTimeout: '10 seconds' });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    const outcome =
      args.command === 'create'
        ? await createQueueSchedule(client, config.taskQueue, args.input, args.everyMs)
        : await changeQueueSchedule(client, args.command);
    console.log(JSON.stringify(outcome));
    if (outcome.status === 'already_exists') {
      console.error(`${outcome.scheduleId} already exists; nothing was changed (delete it first to change its cap or interval)`);
    } else if (outcome.status === 'not_found') {
      console.error(`${outcome.scheduleId} does not exist; nothing was changed`);
    }
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
