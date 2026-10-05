/**
 * Count LogSeq HTTP API calls made by each tool against a live graph.
 * Evidence for the performance claims in CLAUDE.md.
 *
 * Usage: npx tsx scripts/measure-api-calls.ts [pageName]
 * Requires LogSeq running with the HTTP API enabled. Read-only.
 */
import { homedir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { getConceptNetwork } from '../src/tools/get-concept-network.js';
import { searchBlocks } from '../src/tools/search-blocks.js';
import { queryByDateRange } from '../src/tools/query-by-date-range.js';
import { queryByProperty } from '../src/tools/query-by-property.js';
import { buildContextForTopic } from '../src/tools/build-context.js';
import { getContextForQuery } from '../src/tools/get-context-for-query.js';

class CountingClient extends LogseqClient {
  calls = new Map<string, number>();
  async callAPI<T = any>(method: string, args: any[] = []): Promise<T> {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
    return super.callAPI<T>(method, args);
  }
  reset() {
    this.calls.clear();
  }
  total() {
    return [...this.calls.values()].reduce((a, b) => a + b, 0);
  }
}

function ymd(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

async function main() {
  const config = await loadConfig(join(homedir(), '.logseq-mcp', 'config.json'));
  const client = new CountingClient(config);

  const pages = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    '[:find (count ?p) . :where [?p :block/name]]'
  ]);
  let subject = process.argv[2];
  if (!subject) {
    // Most-referenced non-journal page: a realistic hub.
    const rows = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
      `[:find ?n ?b :where [?b :block/refs ?p] [?p :block/name ?n] [?p :block/file]]`
    ]);
    const counts = new Map<string, number>();
    for (const [n] of rows) counts.set(n, (counts.get(n) ?? 0) + 1);
    subject = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  console.log(`graph pages: ${pages}   subject: ${JSON.stringify(subject)}\n`);

  const end = new Date();
  const start = new Date(end.getTime() - 6 * 86400000);

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['get_concept_network depth=1', () => getConceptNetwork(client, subject, 1)],
    ['get_concept_network depth=2', () => getConceptNetwork(client, subject, 2)],
    ['build_context', () => buildContextForTopic(client, subject)],
    ['get_context_for_query (1 topic)', () => getContextForQuery(client, `what about [[${subject}]]?`)],
    ['search_blocks', () => searchBlocks(client, subject.slice(0, 4), 10)],
    ['query_by_date_range (7 days)', () => queryByDateRange(client, ymd(start), ymd(end))],
    ['query_by_property', () => queryByProperty(client, 'type', 'x')]
  ];

  for (const [label, run] of cases) {
    client.reset();
    const t0 = Date.now();
    const result: any = await run();
    const ms = Date.now() - t0;
    const nodes = result?.nodes ? ` nodes=${result.nodes.length}` : '';
    const byMethod = [...client.calls.entries()].map(([m, n]) => `${m.replace('logseq.', '')}=${n}`).join(' ');
    console.log(`${label.padEnd(30)} calls=${String(client.total()).padEnd(5)} ${ms}ms${nodes}   ${byMethod}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
