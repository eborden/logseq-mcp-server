// The worker: runs the workflows and activities on one task queue. Start it with `npm run worker`.
// SIGINT and SIGTERM shut it down gracefully; a SIGKILL is a crash, which is what the crash test relies on.
//
// Activities registered: `hello` (the engine check of #626, kept on purpose: `npm run run-hello` and the crash test
// use it), `runClaudeSession` (#627), the GitHub activities (#628, #635, #629), `guardBranch` and `pushBranch` (the only push) and `runImplementerSession` (#629).
// Their settings are read once here, from the environment, and a bad value stops the worker before it polls.

import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createBranchActivities } from './activities/branch.ts';
import { createClaudeSessionActivities } from './activities/claude-session.ts';
import { createGithubActivities } from './activities/github.ts';
import * as hello from './activities/hello.ts';
import { createImplementerActivities } from './activities/implementer.ts';
import { loadClaudeConfig, loadConfig } from './config.ts';
import { loadGhConfig } from './gh-config.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const claudeConfig = loadClaudeConfig(process.env);
  const ghConfig = loadGhConfig(process.env);
  const claude = createClaudeSessionActivities(claudeConfig);
  const github = createGithubActivities(ghConfig);
  const branches = createBranchActivities();
  const implementer = createImplementerActivities({
    readIssue: github.readIssue,
    runClaudeSession: claude.runClaudeSession,
    repo: ghConfig.repo,
  });

  const connection = await NativeConnection.connect({ address: config.address });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities: { ...hello, ...claude, ...github, ...branches, ...implementer },
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
