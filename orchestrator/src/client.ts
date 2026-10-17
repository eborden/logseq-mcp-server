// Starts one helloWorkflow run and waits for it. `npm run run-hello [-- --name Alice --work-ms 10000]`.
// The workflow ID is derived from the run key, and the start is deliberately idempotent (the claim pattern the
// later tasks use with an issue number):
// - the same run key while a run is open attaches to that run (workflowIdConflictPolicy USE_EXISTING);
// - after a run failed, the key may start again (workflowIdReusePolicy ALLOW_DUPLICATE_FAILED_ONLY);
// - after a run completed, the start is refused by the server, and this script attaches to the finished run and
//   prints its result instead of running it a second time.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, Connection, WorkflowExecutionAlreadyStartedError, type WorkflowHandle } from '@temporalio/client';
import { loadConfig } from './config.ts';
import { parseHelloInput } from './hello-types.ts';
import type { HelloResult } from './hello-types.ts';
import { helloWorkflow } from './workflows/hello.ts';

const DEFAULT_WORK_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { values } = parseArgs({
    options: {
      name: { type: 'string', default: 'world' },
      'work-ms': { type: 'string', default: String(DEFAULT_WORK_MS) },
      'log-file': { type: 'string', default: join(tmpdir(), 'orchestrator-hello.log') },
      'run-key': { type: 'string', default: randomUUID() },
    },
    strict: true,
  });
  const input = parseHelloInput({
    name: values.name,
    logFile: values['log-file'],
    runKey: values['run-key'],
    workMs: Number(values['work-ms']),
  });

  const connection = await Connection.connect({ address: config.address, connectTimeout: '10 seconds' });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    const workflowId = `hello-${input.runKey}`;
    let handle: WorkflowHandle<typeof helloWorkflow>;
    try {
      handle = await client.workflow.start(helloWorkflow, {
        taskQueue: config.taskQueue,
        workflowId,
        args: [input],
        workflowExecutionTimeout: '10 minutes',
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
        throw error;
      }
      console.error(`${workflowId} already completed; reading its result instead of running it again`);
      handle = client.workflow.getHandle(workflowId);
    }
    console.error(`workflow ${handle.workflowId}; waiting for it (kill and restart the worker to try a crash)`);
    const result: HelloResult = await handle.result();
    console.log(JSON.stringify(result));
    const lines = (await readFile(input.logFile, 'utf8')).split('\n').filter((line) => line.startsWith(input.runKey));
    console.error(`lines for this run in ${input.logFile}:\n${lines.join('\n')}`);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
