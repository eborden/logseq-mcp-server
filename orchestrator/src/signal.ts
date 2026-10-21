// Sends the maintainer's decision to a running IssueWorkflow (#631):
//   npm run signal -- <issue> approved|changes_requested [--message "<text>"] [--date YYYY-MM-DD]
// The arguments are parsed into the same typed payload the workflow parses again (src/approval-types.ts). The CLI
// refuses before it sends when the run is not open, so a decision is never sent to a run that cannot take it. It
// only signals: it does not merge, label or move anything. A duplicate is harmless: the run keeps the first decision.

import { parseArgs } from 'node:util';
import { Client, Connection } from '@temporalio/client';
import { InvalidDecisionError, maintainerDecisionSignal, parseSignalArgs } from './approval-types.ts';
import { loadConfig } from './config.ts';
import { issueWorkflowId } from './issue-types.ts';

/** The maintainer's own calendar date, not UTC: the decision comment records the date they decided on. */
function localDate(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const { values, positionals } = parseArgs({ options: { message: { type: 'string' }, date: { type: 'string' } }, allowPositionals: true, strict: true });
  const { args, payload } = parseSignalArgs(positionals, values.message, values.date ?? localDate(new Date()));
  const workflowId = issueWorkflowId(args.issue);

  const connection = await Connection.connect({ address: config.address, connectTimeout: '10 seconds' });
  try {
    const client = new Client({ connection, namespace: config.namespace });
    const handle = client.workflow.getHandle(workflowId);
    const status = (await handle.describe()).status.name;
    if (status !== 'RUNNING') {
      throw new InvalidDecisionError(`${workflowId} is not running (${status}): nothing was sent`);
    }
    await handle.signal(maintainerDecisionSignal, payload);
    console.log(JSON.stringify({ sent: true, workflowId, decision: payload.decision, at: payload.at }));
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
