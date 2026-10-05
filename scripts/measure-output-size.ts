/**
 * Print the size of tool output, slim (default) vs full (`slim_results: false`).
 * Evidence for the size claims in the slim-by-default PR (#42).
 *
 * Calls go through the real MCP server (in memory), so the output is what a client
 * receives: every content block, minified JSON, tips and meta included.
 *
 * Prints labels and byte counts only. It never prints block content or page names,
 * and failures print only the error class (and the tool name for an isError result),
 * never the message text, so the output is safe to read. Quote it as approximate
 * percentages and not verbatim.
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
  // Never include the tool's error text: it can quote a page name from the graph
  if (result.isError) throw new Error(`${name} returned isError`);
  return result.content.reduce((sum, block) => sum + Buffer.byteLength(block.text, 'utf8'), 0);
}

/** First content block of one call, parsed as JSON. Used only to find a block uuid; never printed. */
async function jsonOf(mcp: Client, name: string, args: Args): Promise<any> {
  const result = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  if (result.isError) throw new Error(`${name} returned isError`);
  return JSON.parse(result.content[0].text);
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

  // format: "markdown" (#43) against the default JSON, and compact against full. Bytes only.
  const outline = await jsonOf(mcp, 'logseq_get_page_outline', { page_name: subject });
  const pick = (outline.blocks as Array<{ uuid: string; childCount: number }>).find(b => b.childCount > 0) ?? outline.blocks[0];
  const formatCases: Array<[string, string, Args]> = [
    ['get_page include_children', 'logseq_get_page', { page_name: subject, include_children: true }],
    ...(pick ? ([['get_block include_children', 'logseq_get_block', { block_uuid: pick.uuid, include_children: true }]] as Array<[string, string, Args]>) : []),
    ['build_context', 'logseq_build_context', { topic_name: subject }],
    ['build_context (compact)', 'logseq_build_context', { topic_name: subject, compact: true }],
    ['get_context_for_query', 'logseq_get_context_for_query', { query: `what about [[${subject}]]?` }],
    ['get_concept_network depth 2', 'logseq_get_concept_network', { concept_name: subject, max_depth: 2 }]
  ];
  console.log(`\n${'format: markdown vs json (bytes)'.padEnd(42)} ${'json'.padStart(9)} ${'markdown'.padStart(9)}  saved`);
  for (const [label, tool, args] of formatCases) {
    const json = await sizeOf(mcp, tool, args);
    const markdown = await sizeOf(mcp, tool, { ...args, format: 'markdown' });
    console.log(`${label.padEnd(42)} ${String(json).padStart(9)} ${String(markdown).padStart(9)}  ${pct(markdown, json)}`);
  }

  // The page with the most blocks: where an outline or a Markdown page matters most
  const sizeRows = await logseq.callAPI<Array<[string, number]>>('logseq.DB.datascriptQuery', [
    `[:find ?n (count ?b) :where [?b :block/page ?p] [?p :block/name ?n] [?p :block/file]]`
  ]);
  const biggest = [...sizeRows].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (biggest) {
    const pageJson = await sizeOf(mcp, 'logseq_get_page', { page_name: biggest, include_children: true });
    const pageMarkdown = await sizeOf(mcp, 'logseq_get_page', { page_name: biggest, include_children: true, format: 'markdown' });
    const outlineJson = await sizeOf(mcp, 'logseq_get_page_outline', { page_name: biggest });
    const contextJson = await sizeOf(mcp, 'logseq_build_context', { topic_name: biggest });
    const contextMarkdown = await sizeOf(mcp, 'logseq_build_context', { topic_name: biggest, format: 'markdown' });
    const contextCompact = await sizeOf(mcp, 'logseq_build_context', { topic_name: biggest, compact: true });
    console.log(`\n${'largest page (bytes)'.padEnd(42)} ${'json'.padStart(9)} ${'other'.padStart(9)}  saved`);
    console.log(`${'get_page children: markdown'.padEnd(42)} ${String(pageJson).padStart(9)} ${String(pageMarkdown).padStart(9)}  ${pct(pageMarkdown, pageJson)}`);
    console.log(`${'get_page children: outline'.padEnd(42)} ${String(pageJson).padStart(9)} ${String(outlineJson).padStart(9)}  ${pct(outlineJson, pageJson)}`);
    console.log(`${'build_context: markdown'.padEnd(42)} ${String(contextJson).padStart(9)} ${String(contextMarkdown).padStart(9)}  ${pct(contextMarkdown, contextJson)}`);
    console.log(`${'build_context: compact json'.padEnd(42)} ${String(contextJson).padStart(9)} ${String(contextCompact).padStart(9)}  ${pct(contextCompact, contextJson)}`);
  }
  await mcp.close();
}

main().catch((e: unknown) => {
  // Error class and our own label only. Never print e.message, e.stack or the
  // error object: they can carry page names or block content from the graph.
  const kind = e instanceof Error ? e.name : typeof e;
  const ours = e instanceof Error && /^logseq_\w+ returned isError$/.test(e.message) ? ` (${e.message})` : '';
  console.error(`measure-output-size failed: ${kind}${ours}`);
  process.exit(1);
});
