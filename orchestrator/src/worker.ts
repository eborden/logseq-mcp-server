// The worker: runs the workflows and activities on one task queue. Start it with `npm run worker`.
// SIGINT and SIGTERM shut it down gracefully; a SIGKILL is a crash, which is what the crash test relies on.
//
// Activities registered: `hello` (the engine check of #626, kept on purpose: `npm run run-hello` and the crash test
// use it), `runClaudeSession` (#627), the GitHub activities (#628, #635, #629), `guardBranch` and `pushBranch` (the only push) `runImplementerSession` (#629), and the review activities (#630: a fresh reviewer, a fixer, the posting of their output).
// With the six `REMOTE_ROUTINE_*` variables set, `runRemoteSession` (#672) is registered too; without them it is not.
// With `HOST_TASK_QUEUE` set, a second worker in this process polls the `host` queue and registers only
// `runHostIntegration` (#647), one activity at a time. Without it the worker is exactly as before.
// Their settings are read once here, from the environment, and a bad value stops the worker before it polls.

import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createBranchActivities } from './activities/branch.ts';
import { createClaudeSessionActivities } from './activities/claude-session.ts';
import { createGithubActivities, createRemoteGithubReads } from './activities/github.ts';
import * as hello from './activities/hello.ts';
import { createImplementerActivities } from './activities/implementer.ts';
import { createReviewActivities } from './activities/review.ts';
import { createRemoteSessionActivities } from './activities/remote-session.ts';
import { createHostIntegrationActivities } from './activities/host-integration.ts';
import { loadClaudeConfig, loadConfig, loadHostConfig, loadRemoteConfig } from './config.ts';
import { loadGhConfig } from './gh-config.ts';
import { createRoutineFireClient } from './routine-fire.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const claudeConfig = loadClaudeConfig(process.env);
  const ghConfig = loadGhConfig(process.env);
  const hostConfig = loadHostConfig(process.env);
  // Parsed once, here: the tokens exist nowhere else. With none of the variables set the worker is exactly as before.
  const remoteConfig = loadRemoteConfig(process.env);
  const claude = createClaudeSessionActivities(claudeConfig);
  const github = createGithubActivities(ghConfig);
  const branches = createBranchActivities();
  const implementer = createImplementerActivities({
    readIssue: github.readIssue,
    runClaudeSession: claude.runClaudeSession,
    repo: ghConfig.repo,
  });
  const review = createReviewActivities({
    readIssue: github.readIssue,
    listReviewThreads: github.listReviewThreads,
    replyToThread: github.replyToThread,
    postReview: github.postReview,
    repo: ghConfig.repo,
    claude: claudeConfig,
  });

  const remote =
    remoteConfig === undefined
      ? {}
      : createRemoteSessionActivities({
          repoDir: remoteConfig.repoDir ?? process.cwd(),
          routines: remoteConfig.routines,
          fire: createRoutineFireClient({ tokens: remoteConfig.tokens }),
          github: createRemoteGithubReads(ghConfig),
        });

  const connection = await NativeConnection.connect({ address: config.address });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities: { ...hello, ...claude, ...github, ...branches, ...implementer, ...review, ...remote },
  });

  // The host worker runs one activity at a time: the host's LogSeq serves one suite, and `stop` must finish before the next start.
  const hostWorker =
    hostConfig === undefined
      ? undefined
      : await Worker.create({
          connection,
          namespace: config.namespace,
          taskQueue: hostConfig.taskQueue,
          activities: createHostIntegrationActivities({ repoDir: hostConfig.repoDir ?? process.cwd() }),
          maxConcurrentActivityTaskExecutions: 1,
        }).catch(async (error: unknown) => {
          // The default worker was created but never started, so it holds no poller and needs no shutdown (shutdown() only
          // works on a running worker). Close the connection, and let this error be the one reported, not a failed close.
          try {
            await connection.close();
          } catch {
            // The Worker.create error below is the one to report.
          }
          throw error;
        });

  const shutdown = (): void => {
    worker.shutdown();
    hostWorker?.shutdown();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.error(`worker polling ${config.address} namespace=${config.namespace} taskQueue=${config.taskQueue}`);
  if (hostConfig !== undefined) {
    console.error(`host worker polling taskQueue=${hostConfig.taskQueue} (one activity at a time)`);
  }
  try {
    await Promise.all([worker.run(), hostWorker?.run()]);
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
