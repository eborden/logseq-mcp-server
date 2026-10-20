// Starts one IssueWorkflow run. `npm run run-issue -- --issue 123 [--base main] [--repo-dir <abs>] [--worktree-dir <abs>] [--wait] [--host-integration] [--executor local|remote] [--attempt <n>]`.
// An issue that already has a run (open or closed) is reported, not an error: see src/issue-client.ts. The workflow
// never merges and never moves an item to Ready or Backlog; the README says what it does.
//
// `--resume` (#747) starts a run at the gate of the issue's open PR instead, after a person has fixed it by hand: no claim, no
// session, no new PR. It reads the PR from GitHub, refuses with a fixed word when the issue does not fit, and takes only
// `--issue`, `--repo-dir`, `--wait` and `--host-integration` (README, "Resuming a stopped gate").

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { loadConfig } from './config.ts';
import { createGithubActivities } from './activities/github.ts';
import { loadGhConfig } from './gh-config.ts';
import { startIssueRun, startResumeRun } from './issue-client.ts';
import { issueWorkflowId } from './issue-types.ts';
import { buildResumeInput, buildRunInput } from './run-issue-input.ts';

type ParsedValues = {
  readonly issue?: string | undefined;
  readonly base?: string | undefined;
  readonly 'repo-dir': string;
  readonly 'worktree-dir'?: string | undefined;
  readonly wait: boolean;
  readonly 'host-integration': boolean;
  readonly executor?: string | undefined;
  readonly attempt?: string | undefined;
};

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { values } = parseArgs({
    options: {
      issue: { type: 'string' },
      base: { type: 'string' },
      // The default assumes you run this from orchestrator/, so the main checkout is one level up.
      'repo-dir': { type: 'string', default: resolve(process.cwd(), '..') },
      'worktree-dir': { type: 'string' },
      wait: { type: 'boolean', default: false },
      // Runs the host integration check at the gate and holds the gate until it passes (#648). Needs the `host` worker.
      'host-integration': { type: 'boolean', default: false },
      // Where the model sessions run (#671): `local` (the default) or `remote`. `remote` is not usable yet: the run stops for a person.
      executor: { type: 'string' },
      // The first attempt number of the remote implementer (#673): after a guard refusal, re-run with the next number to fire a fresh session.
      attempt: { type: 'string' },
      // Re-gates the issue's open PR after a hand fix (#747): no claim, no session, no new PR.
      resume: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.resume) {
    await resume(config, values);
    return;
  }
  const input = buildRunInput({
    issue: values.issue,
    base: values.base ?? 'main',
    repoDir: values['repo-dir'],
    worktreeDir: values['worktree-dir'],
    hostIntegration: values['host-integration'],
    executor: values.executor,
    attempt: values.attempt,
  });

  const connection = await Connection.connect({ address: config.address, connectTimeout: '10 seconds' });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    const outcome = await startIssueRun(client, config.taskQueue, input);
    console.log(JSON.stringify(outcome));
    if (outcome.status === 'started' && values.wait) {
      console.error(`workflow ${issueWorkflowId(input.issueNumber)} started; waiting for it`);
      console.log(JSON.stringify(await client.workflow.getHandle(outcome.workflowId, outcome.runId).result()));
    } else if (outcome.status === 'already_running') {
      console.error(`${outcome.workflowId} is already running; nothing was started`);
    } else if (outcome.status === 'already_finished') {
      console.error(`${outcome.workflowId} already ran and closed as ${outcome.closedAs}; nothing was started (README, "Recovering a stuck run")`);
    }
  } finally {
    await connection.close();
  }
}

/** `--resume`: the GitHub reads run here, with the same `gh` settings as the worker, and a refusal is answered before a run is started. */
async function resume(config: ReturnType<typeof loadConfig>, values: ParsedValues): Promise<void> {
  const input = buildResumeInput({
    issue: values.issue,
    repoDir: values['repo-dir'],
    hostIntegration: values['host-integration'],
    executor: values.executor,
    base: values.base,
    worktreeDir: values['worktree-dir'],
    attempt: values.attempt,
  });
  const github = createGithubActivities(loadGhConfig(process.env));
  const connection = await Connection.connect({ address: config.address, connectTimeout: '10 seconds' });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    const outcome = await startResumeRun(client, config.taskQueue, (issue) => github.resolveResume(issue), input);
    console.log(JSON.stringify(outcome));
    if (outcome.status === 'refused') {
      console.error(`resume refused (${outcome.reason}): nothing was started (README, "Resuming a stopped gate")`);
      process.exitCode = 1;
    } else if (outcome.status === 'started' && values.wait) {
      console.error(`workflow ${outcome.workflowId} started; waiting for it`);
      console.log(JSON.stringify(await client.workflow.getHandle(outcome.workflowId, outcome.runId).result()));
    } else if (outcome.status === 'already_running') {
      console.error(`${outcome.workflowId} is already running; nothing was started`);
    } else if (outcome.status === 'already_finished') {
      console.error(`${outcome.workflowId} already ran for this head and closed as ${outcome.closedAs}; nothing was started. A new head gets its own run (README, "Resuming a stopped gate")`);
    }
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
