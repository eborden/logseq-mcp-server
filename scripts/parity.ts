// Golden-result harness (#124, ADR-0031, ADR-0032, kept by #356): run the Rust server against the stub LogSeq and
// compare its tools/list (by meaning, #292), its tool, prompt and resource results (byte for byte, except the closest
// names of a page-not-found message, which are held to rules, #335) and its LogSeq calls with the results recorded
// from the TypeScript server before it was retired (scripts/parity/expected). Synthetic fixtures only; it never
// contacts a real LogSeq.
//
//   npx tsx scripts/parity.ts                      # this checkout's debug build (cd rust && cargo build)
//   npx tsx scripts/parity.ts -- ./my-server --x   # any other server command
//   npx tsx scripts/parity.ts -- rust/target/debug/logseq-mcp-server
//                                                  # what CI does, and it compares the whole tools/list
//   npx tsx scripts/parity.ts --tested-tools-only -- ./my-server
//                                                  # for local use, a server with only some tools: tools/list is
//                                                  # compared for the tools the cases call, and the server must
//                                                  # list those and no others (CI doesn't use it since #316)
//   npx tsx scripts/parity.ts --real-clock -- rust/target/release/logseq-mcp-server
//                                                  # a server that reads the system clock (the Rust release build
//                                                  # ignores LOGSEQ_MCP_NOW): the cases that read today are left out
//   npx tsx scripts/parity.ts --record-from-rust   # record the expected results again, from the Rust debug build
//   npx tsx scripts/parity.ts --self-check         # passes as is, fails on every perturbed case, and on every wrong list of closest names
//
// The expected files are the golden results of the Rust server. They were recorded from the TypeScript server, and
// a re-record is a decision (#299 changes some on purpose), so --record-from-rust is guarded: it takes no command
// (this checkout's debug build only, which also honours the test clock), no --tested-tools-only, no --real-clock, and
// refuses to run when CI is set. It ships with a reviewed diff of the JSON.
//
// Exit code 0 when everything matches (for --self-check: when both halves behave), 1 otherwise.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CASE_GROUPS, allCases, expectedFileOf, type CaseGroup } from './parity/case-groups.js';
import { checkWrongLists, compareResult, perturbCases, runParity, type ParityReport, type ToolResult } from './parity/harness.js';
import { compareToolLists, type ProjectedTool } from './parity/tool-list-compare.js';
import { parseCommandLine } from './parity/command-line.js';
import { withoutClockCases } from './parity/clock-cases.js';
import { REPO_ROOT } from './parity/server-command.js';

/** The recorded tools/list, in the projection of scripts/parity/tool-list-projection.ts. */
export const EXPECTED_TOOL_LIST_FILE = join(REPO_ROOT, 'scripts', 'parity', 'expected', 'tool-list.json');

function print(label: string, report: ParityReport): void {
  if (report.failures.length === 0) {
    console.log(`${label}: ok`);
    return;
  }
  console.log(`${label}: ${report.failures.length} failure(s)`);
  for (const failure of report.failures) console.log(`- ${failure}`);
  if (report.stderr.trim()) console.log(`server stderr:\n${report.stderr.trim()}`);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
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

/** Each group's recorded results, merged: case names are unique across groups. */
async function readExpected(groups: readonly CaseGroup[]): Promise<Record<string, ToolResult>> {
  const merged: Record<string, ToolResult> = {};
  for (const group of groups) {
    const file = expectedFileOf(group);
    const expected = await readJson<Record<string, ToolResult>>(file);
    if (!expected) throw new Error(`no expected results at ${file}; record them with --record-from-rust`);
    Object.assign(merged, expected);
  }
  return merged;
}

async function main(): Promise<number> {
  const { mode, server, onlyTestedTools, realClock } = parseCommandLine(process.argv.slice(2));
  // The closest names are held to ADR-0032's rules, since the recorded lists are the TypeScript matcher's; the recorded set must exercise them
  const suggestions = { bySuggestionRules: true, requireSuggestionCases: true };
  const cases = realClock ? withoutClockCases(allCases()) : allCases();

  if (mode === 'record') {
    const report = await runParity({ server, cases, ...suggestions });
    print('record', report);
    if (report.failures.length > 0) return 1;
    for (const group of CASE_GROUPS) {
      const results = Object.fromEntries(group.cases.map(c => [c.name, report.results[c.name]]));
      printChanges(await readJson(expectedFileOf(group)), results);
    }
    const previousTools = await readJson<ProjectedTool[]>(EXPECTED_TOOL_LIST_FILE);
    const toolChanges = previousTools ? compareToolLists(previousTools, report.toolList ?? []) : ['no recorded tool list yet'];
    for (const line of toolChanges) console.log(`tools/list changed: ${line}`);
    for (const group of CASE_GROUPS) {
      const results = Object.fromEntries(group.cases.map(c => [c.name, report.results[c.name]]));
      await writeFile(expectedFileOf(group), `${JSON.stringify(results, null, 2)}\n`);
      console.log(`wrote ${Object.keys(results).length} results to ${expectedFileOf(group)}`);
    }
    await writeFile(EXPECTED_TOOL_LIST_FILE, `${JSON.stringify(report.toolList, null, 2)}\n`);
    console.log(`wrote ${report.toolList?.length ?? 0} tools to ${EXPECTED_TOOL_LIST_FILE}`);
    return 0;
  }

  const recorded = await readExpected(CASE_GROUPS);
  // A result recorded for a case that was left out (--real-clock) is not run, and would be reported as stray.
  const run = new Set(cases.map(c => c.name));
  const skipped = new Set(allCases().filter(c => !run.has(c.name)).map(c => c.name));
  const expected = Object.fromEntries(Object.entries(recorded).filter(([name]) => !skipped.has(name)));
  const expectedToolList = await readJson<ProjectedTool[]>(EXPECTED_TOOL_LIST_FILE);
  if (!expectedToolList) throw new Error(`no expected tool list at ${EXPECTED_TOOL_LIST_FILE}; record it with --record-from-rust`);
  if (mode === 'check') {
    const report = await runParity({ server, cases, expected, expectedToolList, onlyTestedTools, ...suggestions });
    print('parity', report);
    return report.failures.length === 0 ? 0 : 1;
  }
  if (mode === 'perturb') {
    const report = await runParity({ server, cases: perturbCases(cases), unperturbedCases: cases, expected, expectedToolList, onlyTestedTools, ...suggestions });
    print('parity with perturbed fixtures', report);
    return report.failures.length === 0 ? 0 : 1;
  }

  // self-check: the fixtures pass as they are, and every case with a LogSeq call fails once perturbed
  const clean = await runParity({ server, cases, expected, expectedToolList, onlyTestedTools, ...suggestions });
  print('self-check, fixtures as committed', clean);
  const perturbed = await runParity({ server, cases: perturbCases(cases), unperturbedCases: cases, expected, expectedToolList, onlyTestedTools, ...suggestions });
  const caught = cases.filter(c => c.steps.length > 0).map(c => ({
    name: c.name,
    failures: perturbed.failures.filter(f => f.startsWith(`[${c.tool}: ${c.name}]`))
  }));
  for (const { name, failures } of caught) {
    console.log(`self-check, perturbed "${name}": ${failures.length > 0 ? `caught (${failures.length} failure(s), first: ${failures[0].split('\n')[0]})` : 'NOT CAUGHT'}`);
  }
  const wrongLists = checkWrongLists(cases, expected);
  for (const line of wrongLists.lines) console.log(line);
  const ok = clean.failures.length === 0 && caught.every(c => c.failures.length > 0) && wrongLists.ok;
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
