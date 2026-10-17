// Starts one helloWorkflow run and waits for it. `npm run run-hello [-- --name Alice --work-ms 10000]`.
// The workflow ID is derived from the run key, so starting the same run key twice joins the same run instead of
// starting a second one (the claim pattern the later tasks use with an issue number).

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
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
    const handle = await client.workflow.start(helloWorkflow, {
      taskQueue: config.taskQueue,
      workflowId: `hello-${input.runKey}`,
      args: [input],
      workflowExecutionTimeout: '10 minutes',
    });
    console.error(`started workflow ${handle.workflowId}; waiting for it (kill and restart the worker to try a crash)`);
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
