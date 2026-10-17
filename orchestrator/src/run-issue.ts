// Starts one IssueWorkflow run. `npm run run-issue -- --issue 123 [--base main] [--repo-dir <abs>] [--worktree-dir <abs>] [--wait]`.
// An issue that already has a run (open or closed) is reported, not an error: see src/issue-client.ts. The workflow
// never merges and never moves an item to Ready or Backlog; the README says what it does.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { loadConfig } from './config.ts';
import { startIssueRun } from './issue-client.ts';
import { issueWorkflowId, parseIssueWorkflowInput } from './issue-types.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { values } = parseArgs({
    options: {
      issue: { type: 'string' },
      base: { type: 'string', default: 'main' },
      // The default assumes you run this from orchestrator/, so the main checkout is one level up.
      'repo-dir': { type: 'string', default: resolve(process.cwd(), '..') },
      'worktree-dir': { type: 'string' },
      wait: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const issueNumber = Number(values.issue);
  const repoDir = resolve(values['repo-dir']);
  const input = parseIssueWorkflowInput({
    issueNumber,
    repoDir,
    worktreeDir: resolve(values['worktree-dir'] ?? `${repoDir}/.claude/worktrees/issue-${issueNumber}`),
    base: values.base,
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
