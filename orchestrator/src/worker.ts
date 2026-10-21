// The worker: runs the workflows and activities on one task queue. Start it with `npm run worker`.
// SIGINT and SIGTERM shut it down gracefully; a SIGKILL is a crash, which is what the crash test relies on.
//
// Activities registered: `hello` (the engine check of #626, kept on purpose: `npm run run-hello` and the crash test
// use it), `runClaudeSession` (#627), the GitHub activities (#628, #635, #629), `guardBranch` and `pushBranch` (the only push) `runImplementerSession` (#629), and the review activities (#630: a fresh reviewer, a fixer, the posting of their output).
// With the six `REMOTE_ROUTINE_*` variables set, `runRemoteSession` (#672) and `runRemoteImplementerSession` (#673) are registered too; without them they are not.
// `listRunningIssues` and `startQueuedRun` (#723) are the queue watcher's, and use a Temporal client connection of the worker's own.
// With `HOST_TASK_QUEUE` set, a second worker in this process polls the `host` queue and registers only
// `runHostIntegration` (#647), one activity at a time. Without it the worker is exactly as before.
// Their settings are read once here, from the environment, and a bad value stops the worker before it polls.

import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createBranchActivities } from './activities/branch.ts';
import { createClaudeSessionActivities } from './activities/claude-session.ts';
import { createGithubActivities, createRemoteGithubReads } from './activities/github.ts';
import * as hello from './activities/hello.ts';
import { createImplementerActivities, createRemoteImplementerActivities } from './activities/implementer.ts';
import { createQueueActivities } from './activities/queue.ts';
import { createReviewActivities } from './activities/review.ts';
import { createRemoteSessionActivities } from './activities/remote-session.ts';
import type { RemoteSessionActivities } from './activities/remote-session.ts';
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
  const remote: Partial<RemoteSessionActivities> =
    remoteConfig === undefined
      ? {}
      : createRemoteSessionActivities({
          repoDir: remoteConfig.repoDir ?? process.cwd(),
          routines: remoteConfig.routines,
          fire: createRoutineFireClient({ tokens: remoteConfig.tokens }),
          github: createRemoteGithubReads(ghConfig),
        });
  // The remote implementer (#673) runs only when the remote session activity does.
  const remoteImplementer =
    remote.runRemoteSession === undefined
      ? {}
      : createRemoteImplementerActivities({ readIssue: github.readIssue, runRemoteSession: remote.runRemoteSession, repo: ghConfig.repo });
  const review = createReviewActivities({
    readIssue: github.readIssue,
    listReviewThreads: github.listReviewThreads,
    replyToThread: github.replyToThread,
    postReview: github.postReview,
    addReviewThread: github.addReviewThread,
    repo: ghConfig.repo,
    claude: claudeConfig,
    // The remote reviewer (#674) runs only when the remote session activity does.
    ...(remote.runRemoteSession === undefined
      ? {}
      : { remote: { runRemoteSession: remote.runRemoteSession, listFindingsCandidates: github.listFindingsCandidates, minimizeComment: github.minimizeComment } }),
  });

  const connection = await NativeConnection.connect({ address: config.address });
  // The queue watcher's two Temporal activities (#723) need a client: the worker's own connection cannot start or list workflows.
  const clientConnection = await Connection.connect({ address: config.address, connectTimeout: '10 seconds' }).catch(async (error: unknown) => {
    await closeBoth(connection, undefined);
    throw error;
  });
  const queue = createQueueActivities({ client: new Client({ connection: clientConnection, namespace: config.namespace }), taskQueue: config.taskQueue });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities: { ...hello, ...claude, ...github, ...branches, ...implementer, ...review, ...remote, ...remoteImplementer, ...queue },
  }).catch(async (error: unknown) => {
    // A bundle or config error lands here. Close both connections and let this error be the one reported.
    await closeBoth(connection, clientConnection);
    throw error;
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
          // works on a running worker). Close both connections, and let this error be the one reported, not a failed close.
          await closeBoth(connection, clientConnection);
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
    await closeBoth(connection, clientConnection);
  }
}

/**
 * Closes the worker's connection and the queue watcher's client connection (#723), each in its own attempt: a close that throws
 * is logged and cannot skip the other, and cannot replace the error the caller is already reporting. `client` is absent only
 * while the client connection is being made.
 */
async function closeBoth(native: NativeConnection, client: Connection | undefined): Promise<void> {
  const results = await Promise.allSettled([native.close(), client?.close()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error(`closing a connection failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
