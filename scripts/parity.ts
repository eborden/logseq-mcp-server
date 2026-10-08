// Differential parity harness (#124, ADR-0025): run a server against the stub LogSeq and compare
// its tools/list, its logseq_get_page_outline results and its LogSeq calls with the TypeScript
// server's. Synthetic fixtures only; it never contacts a real LogSeq.
//
//   npx tsx scripts/parity.ts                      # the TypeScript server against its recorded results
//   npx tsx scripts/parity.ts -- ./my-server --x   # any other server command (the Rust one, #125)
//   npx tsx scripts/parity.ts --record             # re-record the expected results from the TypeScript server
//   npx tsx scripts/parity.ts --self-check         # passes as is, and fails on every perturbed case
//
// Only the TypeScript server records: the expected file is the reference other servers are judged
// against, so --record refuses a command after --. A re-record is done by hand when the TypeScript
// output changes on purpose, ships with a reviewed diff of the JSON, and never runs in CI.
//
// Exit code 0 when everything matches (for --self-check: when both halves behave), 1 otherwise.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPageOutlineCases } from './parity/cases/get-page-outline.js';
import { compareResult, perturbCases, runParity, type ParityReport, type ServerCommand, type ToolResult } from './parity/harness.js';
import { REPO_ROOT, SNAPSHOT_FILE, typescriptServer } from './parity/ts-server.js';

export const EXPECTED_FILE = join(REPO_ROOT, 'scripts', 'parity', 'expected', 'get-page-outline.json');

const USAGE =
  'usage: npx tsx scripts/parity.ts [--perturb | --self-check] [-- <server command> [args...]]\n' +
  '       npx tsx scripts/parity.ts --record   (TypeScript server only; review the JSON diff; never in CI)';

function parseCommandLine(argv: string[]): { mode: 'check' | 'record' | 'perturb' | 'self-check'; server: ServerCommand } {
  const dashes = argv.indexOf('--');
  const flags = dashes === -1 ? argv : argv.slice(0, dashes);
  const command = dashes === -1 ? [] : argv.slice(dashes + 1);
  const modes = flags.map(flag => {
    if (flag === '--record') return 'record' as const;
    if (flag === '--perturb') return 'perturb' as const;
    if (flag === '--self-check') return 'self-check' as const;
    throw new Error(`unknown flag ${flag}\n${USAGE}`);
  });
  if (modes.length > 1) throw new Error(`pick one mode\n${USAGE}`);
  if (dashes !== -1 && command.length === 0) throw new Error(`no server command after --\n${USAGE}`);
  if (modes[0] === 'record' && command.length > 0) {
    throw new Error(`--record runs the TypeScript server only: a candidate can't record its own reference\n${USAGE}`);
  }
  const server = command.length > 0 ? { command: command[0], args: command.slice(1) } : typescriptServer();
  return { mode: modes[0] ?? 'check', server };
}

function print(label: string, report: ParityReport): void {
  if (report.failures.length === 0) {
    console.log(`${label}: ok`);
    return;
  }
  console.log(`${label}: ${report.failures.length} failure(s)`);
  for (const failure of report.failures) console.log(`- ${failure}`);
  if (report.stderr.trim()) console.log(`server stderr:\n${report.stderr.trim()}`);
}

async function readExpected(): Promise<Record<string, ToolResult> | undefined> {
  try {
    return JSON.parse(await readFile(EXPECTED_FILE, 'utf8')) as Record<string, ToolResult>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** What a re-record changes in the expected file, case by case, before it is written. */
function printChanges(previous: Record<string, ToolResult> | undefined, next: Record<string, ToolResult>): void {
  if (!previous) {
    console.log('no expected file yet; every case is new');
    return;
  }
  let changed = 0;
  for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const before = previous[name];
    const after = next[name];
    const lines = !before ? ['new case'] : !after ? ['case removed'] : compareResult(before, after);
    if (lines.length === 0) continue;
    changed++;
    console.log(`changed: ${name}`);
    for (const line of lines) console.log(`  - ${line}`);
  }
  console.log(changed === 0 ? 'no case changed' : `${changed} case(s) changed; review the JSON diff before committing`);
}

async function main(): Promise<number> {
  const { mode, server } = parseCommandLine(process.argv.slice(2));
  const cases = getPageOutlineCases;
  const snapshotFile = SNAPSHOT_FILE;

  if (mode === 'record') {
    const report = await runParity({ server, cases, snapshotFile });
    print('record', report);
    if (report.failures.length > 0) return 1;
    printChanges(await readExpected(), report.results);
    await writeFile(EXPECTED_FILE, `${JSON.stringify(report.results, null, 2)}\n`);
    console.log(`wrote ${Object.keys(report.results).length} results to ${EXPECTED_FILE}`);
    return 0;
  }

  const expected = await readExpected();
  if (!expected) throw new Error(`no expected results at ${EXPECTED_FILE}; record them with --record`);
  if (mode === 'check') {
    const report = await runParity({ server, cases, expected, snapshotFile });
    print('parity', report);
    return report.failures.length === 0 ? 0 : 1;
  }
  if (mode === 'perturb') {
    const report = await runParity({ server, cases: perturbCases(cases), expected, snapshotFile });
    print('parity with perturbed fixtures', report);
    return report.failures.length === 0 ? 0 : 1;
  }

  // self-check: the fixtures pass as they are, and every case with a LogSeq call fails once perturbed
  const clean = await runParity({ server, cases, expected, snapshotFile });
  print('self-check, fixtures as committed', clean);
  const perturbed = await runParity({ server, cases: perturbCases(cases), expected, snapshotFile });
  const caught = cases.filter(c => c.steps.length > 0).map(c => ({
    name: c.name,
    failures: perturbed.failures.filter(f => f.startsWith(`[${c.tool}: ${c.name}]`))
  }));
  for (const { name, failures } of caught) {
    console.log(`self-check, perturbed "${name}": ${failures.length > 0 ? `caught (${failures.length} failure(s), first: ${failures[0].split('\n')[0]})` : 'NOT CAUGHT'}`);
  }
  const ok = clean.failures.length === 0 && caught.every(c => c.failures.length > 0);
  console.log(ok ? 'self-check: ok' : 'self-check: FAILED');
  return ok ? 0 : 1;
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
);
