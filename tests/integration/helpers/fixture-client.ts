import { access } from 'fs/promises';
import { loadConfig, resolveConfigPath } from '../../../src/config.js';
import { LogseqClient } from '../../../src/client.js';
import { LogseqMCPConfig } from '../../../src/types.js';
import { FixtureGraphError, requireFixtureGraph } from './fixture-graph.js';

/**
 * How every integration suite connects (#90): load the config, then `requireFixtureGraph`, so a
 * suite runs against tests/fixtures/graph or not at all. Exact assertions on the fixture would
 * fail confusingly, or pass by accident, against any other graph.
 *
 * `vitest.integration.config.ts` points `LOGSEQ_MCP_CONFIG` at this worktree's instance
 * (`.logseq-instance/config.json`) when one is running and the variable is unset, and its global
 * setup runs this once before any suite, so a wrong graph or a stopped instance fails the run
 * once, with these instructions, instead of in every file.
 */

export const HOW_TO_RUN =
  'Start this worktree\'s fixture instance with `npx tsx scripts/logseq-instance.ts start`, then run ' +
  '`npm run test:integration` (it finds .logseq-instance/config.json by itself), then ' +
  '`npx tsx scripts/logseq-instance.ts stop`. See "Running the integration tests" in tests/integration/setup.md.';

export interface FixtureConnection {
  client: LogseqClient;
  config: LogseqMCPConfig;
  configPath: string;
}

/**
 * Load the config and confirm the API serves the fixture graph.
 *
 * API calls: 1 Datalog query (the sentinel page).
 * @throws Error with HOW_TO_RUN when the config is missing or LogSeq cannot be reached, and
 *   FixtureGraphError when it serves another graph or another version of the fixture
 */
export async function connectFixture(): Promise<FixtureConnection> {
  const configPath = resolveConfigPath();
  try {
    await access(configPath);
  } catch {
    throw new Error(`Config file not found at ${configPath}. ${HOW_TO_RUN}`);
  }
  const config = await loadConfig(configPath);
  const client = new LogseqClient(config);
  try {
    await requireFixtureGraph(client);
  } catch (error) {
    if (error instanceof FixtureGraphError) throw error;
    // Connection refused, a bad token or a timeout. The URL is a local address, never a secret.
    // Only the cause's first line: LogSeqNotRunningError's own steps are about ~/.logseq-mcp/config.json.
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    throw new Error(`Cannot query the fixture graph at ${config.apiUrl} (${reason}).\n${HOW_TO_RUN}`, { cause: error });
  }
  return { client, config, configPath };
}

/** The journal days of the fixture's files (tests/fixtures/graph/journals/), oldest first. */
export const FIXTURE_JOURNAL_DAYS = [
  20240617, 20241231, 20250102, 20250106, 20250107, 20250108, 20250110, 20250113, 20250115, 20250203,
];

/** The last journal day the fixture's own files hold. Later days are journals LogSeq made. */
export const LAST_FIXTURE_JOURNAL_DAY = FIXTURE_JOURNAL_DAYS[FIXTURE_JOURNAL_DAYS.length - 1];

/**
 * Journal days in the graph that are not fixture files: today's journal, which LogSeq creates on
 * open (with one empty block) and whose date moves every day. Exact counts that span the present
 * add these rather than hard-coding them (tests/fixtures/README.md, "Files LogSeq writes").
 *
 * API calls: 1 Datalog query.
 */
export async function laterJournalDays(client: LogseqClient): Promise<number[]> {
  const rows = await client.executeDatalogQuery<Array<[number]>>(
    `[:find ?d :where [?p :block/name] [?p :block/journal-day ?d] [(> ?d ${LAST_FIXTURE_JOURNAL_DAY})]]`
  );
  return (rows ?? []).map(([day]) => day).sort((a, b) => a - b);
}

/**
 * Wrap `client.callAPI` so every call is recorded. Returns the list it appends to; reset it with
 * `calls.length = 0`. The original method stays reachable as `original` for setup queries that
 * must not count.
 */
export function recordCalls(client: LogseqClient): { calls: string[]; original: LogseqClient['callAPI'] } {
  const calls: string[] = [];
  const original = client.callAPI.bind(client) as LogseqClient['callAPI'];
  client.callAPI = (async (method: string, args?: any[]) => {
    calls.push(method);
    return original(method, args);
  }) as LogseqClient['callAPI'];
  return { calls, original };
}
