/**
 * Print the size of tool output, slim (default) vs full (`slim_results: false`).
 * Evidence for the size claims in the slim-by-default PR (#42).
 *
 * Calls go through the real MCP server (in memory), so the output is what a client
 * receives: every content block, minified JSON, tips and meta included.
 *
 * Prints labels and byte counts only. It never prints block content or page names,
 * so the output is safe to read, but quote it as approximate percentages and not verbatim.
 *
 * Usage: npx tsx scripts/measure-output-size.ts [pageName]
 * Requires LogSeq running with the HTTP API enabled. Read-only.
 */
import { homedir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { createServer } from '../src/index.js';

type Args = Record<string, unknown>;

/** Bytes of everything a client would receive for one call. */
async function sizeOf(mcp: Client, name: string, args: Args): Promise<number> {
  const result = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text.slice(0, 80)}`);
  return result.content.reduce((sum, block) => sum + Buffer.byteLength(block.text, 'utf8'), 0);
}

const pct = (slim: number, full: number) => (full === 0 ? '  n/a' : `${(((full - slim) / full) * 100).toFixed(0).padStart(4)}%`);

async function main() {
  const config = await loadConfig(join(homedir(), '.logseq-mcp', 'config.json'));
  const logseq = new LogseqClient(config);

  // Most-referenced non-journal page: a realistic hub (same pick as measure-api-calls.ts)
  const refRows = await logseq.callAPI<Array<[string, number]>>('logseq.DB.datascriptQuery', [
    `[:find ?n ?b :where [?b :block/refs ?p] [?p :block/name ?n] [?p :block/file]]`
  ]);
  const counts = new Map<string, number>();
  for (const [n] of refRows) counts.set(n, (counts.get(n) ?? 0) + 1);
  const subject = process.argv[2] ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // A property key/value that exists, so query_by_property has something to return
  const propRows = await logseq.callAPI<Array<[{ properties?: Record<string, unknown> }]>>('logseq.DB.datascriptQuery', [
    `[:find (pull ?b [:block/properties]) :where [?b :block/properties]]`
  ]);
  const pairCounts = new Map<string, number>();
  for (const [row] of propRows ?? []) {
    for (const [k, v] of Object.entries(row?.properties ?? {})) {
      if (typeof v === 'string' && v.length > 0 && /^[A-Za-z0-9_-]+$/.test(k)) {
        const pair = JSON.stringify([k, v]);
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
    }
  }
  const topPair = [...pairCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const [propKey, propValue] = topPair ? (JSON.parse(topPair[0]) as [string, string]) : [undefined, undefined];

  const server = createServer(logseq, { tips: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'measure-output-size', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  const slimCases: Array<[string, string, Args]> = [
    ['search_blocks (limit 50)', 'logseq_search_blocks', { query: subject.slice(0, 4), limit: 50 }],
    ['search_blocks include_context (limit 50)', 'logseq_search_blocks', { query: subject.slice(0, 4), limit: 50, include_context: true }],
    ['query_by_date_range last_n 7', 'logseq_query_by_date_range', { last_n: 7 }],
    ...(propKey
      ? ([['query_by_property', 'logseq_query_by_property', { property_key: propKey, property_value: propValue }]] as Array<[string, string, Args]>)
      : [])
  ];
  // These have no slim_results parameter, so slim vs full does not apply. Sizes only.
  const plainCases: Array<[string, string, Args]> = [
    ['get_page include_children', 'logseq_get_page', { page_name: subject, include_children: true }],
    ['build_context', 'logseq_build_context', { topic_name: subject }]
  ];

  console.log(`${'case'.padEnd(42)} ${'full'.padStart(9)} ${'slim'.padStart(9)}  saved`);
  for (const [label, tool, args] of slimCases) {
    const full = await sizeOf(mcp, tool, { ...args, slim_results: false });
    const slim = await sizeOf(mcp, tool, args);
    console.log(`${label.padEnd(42)} ${String(full).padStart(9)} ${String(slim).padStart(9)}  ${pct(slim, full)}`);
  }
  console.log('\nno slim_results parameter (size in bytes):');
  for (const [label, tool, args] of plainCases) {
    console.log(`${label.padEnd(42)} ${String(await sizeOf(mcp, tool, args)).padStart(9)}`);
  }
  await mcp.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
