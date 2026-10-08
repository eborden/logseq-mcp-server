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
// refuses to run when CI is set. It writes a file only when a case or a tool changed in meaning (the closest names of a
// missing page by the ADR-0032 rules, `tools/list` by `compareToolLists`), and keeps the recorded bytes of every entry that
// did not, so its diff is the change and not the Rust schema's spelling. It ships with a reviewed diff of the JSON.
//
// Exit code 0 when everything matches (for --self-check: when both halves behave), 1 otherwise.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CASE_GROUPS, allCases, expectedFileOf, type CaseGroup } from './parity/case-groups.js';
import { checkWrongLists, compareResultBySuggestionRules, perturbCases, runParity, type ParityCase, type ParityReport, type ToolResult } from './parity/harness.js';
import { candidatesOf } from './parity/suggestion-rules.js';
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

/**
 * What a re-record changes in a group's expected file, case by case, before it is written. Returns the results to
 * write, or undefined when nothing changed: a case whose result is the same by `compareResult` keeps its recorded
 * bytes, so a re-record's diff holds changes of meaning and nothing else (#356).
 */
function printChanges(
  previous: Record<string, ToolResult> | undefined,
  next: Record<string, ToolResult>,
  cases: readonly ParityCase[]
): Record<string, ToolResult> | undefined {
  if (!previous) {
    console.log('no expected file yet; every case is new');
    return next;
  }
  let changed = 0;
  const toWrite: Record<string, ToolResult> = {};
  for (const name of Object.keys(next)) {
    const before = previous[name];
    // The closest names of a missing page are held to the rules of ADR-0032, not to bytes: a list the rules accept is no change
    const candidates = candidatesOf(cases.find(c => c.name === name)?.steps ?? []);
    const lines = !before ? ['new case'] : compareResultBySuggestionRules(before, next[name], candidates);
    toWrite[name] = lines.length === 0 ? before : next[name];
    if (lines.length === 0) continue;
    changed++;
    console.log(`changed: ${name}`);
    for (const line of lines) console.log(`  - ${line}`);
  }
  for (const name of Object.keys(previous)) {
    if (name in next) continue;
    changed++;
    console.log(`changed: ${name}\n  - case removed`);
  }
  console.log(changed === 0 ? 'no case changed; the file is left as it is' : `${changed} case(s) changed; review the JSON diff before committing`);
  return changed === 0 ? undefined : toWrite;
}

/** The recorded tool list with the entries that changed in meaning replaced, so unchanged ones keep their bytes. */
function mergeToolLists(previous: ProjectedTool[], next: ProjectedTool[]): ProjectedTool[] {
  return next.map(tool => {
    const before = previous.find(candidate => candidate.name === tool.name);
    return before && compareToolLists([before], [tool]).length === 0 ? before : tool;
  });
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
    // A file is written only when something in it changed in meaning (#356), so a re-record's diff is never the Rust
    // schema's spelling or key order over hundreds of lines; an entry that is the same by meaning keeps its bytes.
    const writes: Array<{ file: string; value: unknown; what: string }> = [];
    for (const group of CASE_GROUPS) {
      const results = Object.fromEntries(group.cases.map(c => [c.name, report.results[c.name]]));
      const toWrite = printChanges(await readJson(expectedFileOf(group)), results, group.cases);
      if (toWrite) writes.push({ file: expectedFileOf(group), value: toWrite, what: `${Object.keys(toWrite).length} results` });
    }
    const previousTools = await readJson<ProjectedTool[]>(EXPECTED_TOOL_LIST_FILE);
    const toolChanges = previousTools ? compareToolLists(previousTools, report.toolList ?? []) : ['no recorded tool list yet'];
    for (const line of toolChanges) console.log(`tools/list changed: ${line}`);
    if (toolChanges.length === 0) console.log('tools/list: no change in meaning; the file is left as it is');
    else {
      const merged = previousTools ? mergeToolLists(previousTools, report.toolList ?? []) : (report.toolList ?? []);
      writes.push({ file: EXPECTED_TOOL_LIST_FILE, value: merged, what: `${merged.length} tools` });
    }
    for (const { file, value, what } of writes) {
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
      console.log(`wrote ${what} to ${file}`);
    }
    if (writes.length === 0) console.log('nothing to write');
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
