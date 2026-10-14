/**
 * Count LogSeq HTTP API calls made by each tool of the Rust server against a live graph.
 * Evidence for the performance claims in CLAUDE.md.
 *
 * Usage: npx tsx scripts/measure-api-calls.ts [--server rust] [--rust-binary <path>] [pageName]
 *
 * It runs the Rust binary over MCP stdio (`--server rust`, the only server since the TypeScript one was retired,
 * #356; the default binary is rust/target/release/logseq-mcp-server) and counts its LogSeq calls with a
 * forwarding proxy (scripts/measure-server.ts, #353). The setup queries that pick the subject pages go straight
 * to LogSeq. With no LOGSEQ_MCP_CONFIG it reads the real graph on purpose, and its output has real page names:
 * never paste it.
 *
 * Requires LogSeq running with the HTTP API enabled. Read-only.
 */
import { loadConfig, LogseqClient, resolveConfigPath } from './lib/logseq-api.js';
import { parseServerFlags, startRustServer } from './measure-server.js';

type Args = Record<string, unknown>;
/** label, MCP tool and arguments */
type Case = [label: string, tool: string, args: Args];

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
  const choice = parseServerFlags(process.argv.slice(2));
  // LOGSEQ_MCP_CONFIG if set (e.g. the fixture instance), else ~/.logseq-mcp/config.json
  const config = await loadConfig(resolveConfigPath());
  const client = new CountingClient(config);

  const pages = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    '[:find (count ?p) . :where [?p :block/name]]'
  ]);
  // Most-referenced non-journal pages: realistic hubs.
  const refRowsByName = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?n ?b :where [?b :block/refs ?p] [?p :block/name ?n] [?p :block/file]]`
  ]);
  const counts = new Map<string, number>();
  for (const [n] of refRowsByName) counts.set(n, (counts.get(n) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const subject = choice.rest[0] ?? ranked[0];
  // A second page for the two-topic tool, so the "same topic" shortcut doesn't hide its cost
  const otherSubject = ranked.find(n => n !== subject.toLowerCase()) ?? subject;
  console.log(`server: rust   graph pages: ${pages}   subject: ${JSON.stringify(subject)}\n`);

  // A block that holds a ((uuid)) ref, for the resolve_refs cases (skipped if none)
  const refRows = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find (pull ?b [:block/uuid]) (pull ?p [:block/original-name]) :where
      [?b :block/content ?c] [?b :block/page ?p]
      [(re-pattern "\\\\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\\\)\\\\)") ?re]
      [(re-find ?re ?c)]]`
  ]);
  const refBlock = refRows?.[0]?.[0]?.uuid as string | undefined;
  const refPage = refRows?.[0]?.[1]?.['original-name'] as string | undefined;

  // Page-name resolution (#41): an alias with one source page, an alias shared by
  // several pages, and a journal day. The names stay in memory; only labels are printed.
  const aliasRows = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?n (count ?p) :where [?p :block/alias ?a] [?a :block/name ?n] (not [?a :block/file])]`
  ]);
  const uniqueAlias = aliasRows?.find(([, count]) => count === 1)?.[0] as string | undefined;
  const sharedAlias = aliasRows?.find(([, count]) => count > 1)?.[0] as string | undefined;
  const journalDays = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?d :where [?p :block/name] [?p :block/journal-day ?d] [?b :block/page ?p]]`
  ]);
  const someDay = journalDays?.[journalDays.length >> 1]?.[0] as number | undefined;
  const isoDay = someDay ? `${String(someDay).slice(0, 4)}-${String(someDay).slice(4, 6)}-${String(someDay).slice(6, 8)}` : undefined;

  // A page that declares an alias another block links (#69), by its own name, to see the
  // cost of the alias group on the link-following tools. Absent when the graph has none.
  const groupRows = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?pn ?an :where [?p :block/alias ?a] [?p :block/file] (not [?a :block/file]) [?p :block/name ?pn] [?a :block/name ?an] [?b :block/refs ?a]]`
  ]);
  const aliased = groupRows?.[0]?.[0] as string | undefined;

  const end = new Date();
  const start = new Date(end.getTime() - 6 * 86400000);

  const checkLinksArgs = () => {
    const terms = [subject, otherSubject, uniqueAlias ?? 'no such page 146 probe a', 'no such page 146 probe b'];
    return { before: terms.join(', '), after: terms.map(t => `[[${t}]]`).join(', ') };
  };
  const dr = { start_date: ymd(start), end_date: ymd(end) };
  const cases: Case[] = [
    ['explore_network depth=1', 'logseq_explore_network', { page: subject, max_depth: 1 }],
    ['explore_network depth=2', 'logseq_explore_network', { page: subject, max_depth: 2 }],
    ['explore_context', 'logseq_explore_context', { page: subject }],
    ['explore_context (references_offset)', 'logseq_explore_context', { page: subject, max_references: 10, references_offset: 10 }],
    ['find_blocks (text)', 'logseq_find_blocks', { text: subject.slice(0, 4), limit: 10 }],
    ['find_blocks (text + 7-day period)', 'logseq_find_blocks', { text: subject.slice(0, 4), ...dr, limit: 10 }],
    ['find_blocks (period alone, last_n 7)', 'logseq_find_blocks', { last_n: 7, limit: 10 }],
    ['explore_timeline (7 days)', 'logseq_explore_timeline', dr],
    ['explore_timeline (last_n 7)', 'logseq_explore_timeline', { last_n: 7 }],
    ['explore_timeline (7 days, group_by week)', 'logseq_explore_timeline', { ...dr, group_by: 'week' }],
    ['find_blocks (property)', 'logseq_find_blocks', { property: 'type', value: 'x' }],
    ['find_blocks (text + property + period)', 'logseq_find_blocks', { text: subject.slice(0, 4), property: 'type', value: 'x', ...dr }],
    ['get_current', 'logseq_get_current', {}],
    ['explore_context resolve_refs', 'logseq_explore_context', { page: subject, resolve_refs: true }],
    ['explore_timeline 7d resolve_refs', 'logseq_explore_timeline', { ...dr, resolve_refs: true }],
    ['get_page', 'logseq_get_page', { page: subject }],
    ['get_page (outline)', 'logseq_get_page', { page: subject, detail: 'outline' }],
    ['explore_timeline (page)', 'logseq_explore_timeline', { page: subject }],
    ['explore_timeline (page, 7-day period)', 'logseq_explore_timeline', { page: subject, ...dr }],
    ['find_blocks (page + links_to)', 'logseq_find_blocks', { page: subject, links_to: [otherSubject], limit: 10 }],
    ['find_blocks (page + links_to, same page twice)', 'logseq_find_blocks', { page: subject, links_to: [subject], limit: 10 }],
    ['find_blocks (links_to, 2 pages)', 'logseq_find_blocks', { links_to: [subject, otherSubject], limit: 10 }],
    ['find_blocks (page + links_to + text + 7-day period)', 'logseq_find_blocks', { page: subject, links_to: [otherSubject], text: subject.slice(0, 4), ...dr, limit: 10 }],
    ['explore_network (to a second page, depth 1)', 'logseq_explore_network', { page: subject, to: otherSubject, max_depth: 1 }],
    ['explore_network (to a second page, depth 2)', 'logseq_explore_network', { page: subject, to: otherSubject, max_depth: 2 }],
    ['find_pages', 'logseq_find_pages', { limit: 50 }],
    ['find_pages (text)', 'logseq_find_pages', { text: subject.slice(0, 4), limit: 50 }],
    ['find_pages (1 name)', 'logseq_find_pages', { names: [subject] }],
    ['find_pages (50 names, 49 missing)', 'logseq_find_pages', { names: [subject, ...Array.from({ length: 49 }, (_, i) => `no such page 490 probe ${i}`)] }],
    ['find_pages (property)', 'logseq_find_pages', { property: 'type', value: 'x' }],
    ['get_graph', 'logseq_get_graph', {}],
    ['get_page (not found)', 'logseq_get_page', { page: 'no such page 41 probe' }],
    // Real pages, an alias when the graph has one, and a made-up term, all in one text
    ['check_links (4 terms)', 'logseq_check_links', checkLinksArgs()],
    ...(uniqueAlias
      ? ([
          ['explore_context (alias)', 'logseq_explore_context', { page: uniqueAlias }],
          ['get_page (alias)', 'logseq_get_page', { page: uniqueAlias }],
          ['get_page (outline, alias)', 'logseq_get_page', { page: uniqueAlias, detail: 'outline' }]
        ] as Case[])
      : []),
    ...(sharedAlias
      ? ([['get_page (shared alias)', 'logseq_get_page', { page: sharedAlias }]] as Case[])
      : []),
    ...(aliased
      ? ([
          ['explore_context (aliased page)', 'logseq_explore_context', { page: aliased }],
          ['explore_context (aliased page, references_offset)', 'logseq_explore_context', { page: aliased, max_references: 10, references_offset: 10 }],
          ['explore_timeline (aliased page)', 'logseq_explore_timeline', { page: aliased }],
          ['explore_network depth=1 (aliased page)', 'logseq_explore_network', { page: aliased, max_depth: 1 }],
          ['explore_network depth=2 (aliased page)', 'logseq_explore_network', { page: aliased, max_depth: 2 }],
          ['find_blocks (page + links_to, aliased page)', 'logseq_find_blocks', { page: aliased, links_to: [otherSubject], limit: 10 }],
          ['explore_network (to a second page, aliased page, depth 1)', 'logseq_explore_network', { page: aliased, to: otherSubject, max_depth: 1 }],
          ['explore_timeline (aliased page, 7-day period)', 'logseq_explore_timeline', { page: aliased, ...dr }]
        ] as Case[])
      : []),
    ...(isoDay
      ? ([
          ['get_page (ISO date)', 'logseq_get_page', { page: isoDay }],
          ['get_page (outline, ISO date)', 'logseq_get_page', { page: isoDay, detail: 'outline' }],
          ['explore_context (ISO date)', 'logseq_explore_context', { page: isoDay }]
        ] as Case[])
      : []),
    ...(refBlock && refPage
      ? ([
          ['get_block (ref block)', 'logseq_get_block', { uuid: refBlock, include_children: false }],
          ['get_block resolve_refs', 'logseq_get_block', { uuid: refBlock, include_children: false, resolve_refs: true }],
          ['get_page children', 'logseq_get_page', { page: refPage, detail: 'full' }],
          ['get_page children resolve_refs', 'logseq_get_page', { page: refPage, detail: 'full', resolve_refs: true }]
        ] as Case[])
      : [])
  ];

  // The Rust binary over MCP stdio, its LogSeq calls counted by the forwarding proxy
  const rust = await startRustServer(choice.rustBinary, config, true);
  const proxy = rust.proxy!;

  try {
    for (const [label, tool, args] of cases) {
      proxy.reset();
      const t0 = Date.now();
      let flag = '';
      let nodes = '';
      // The error text can quote a page name, so only the fact of an error is kept
      const result = (await rust.mcp.callTool({ name: tool, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
      if (result.isError) flag = ' isError';
      else {
        try {
          const parsed = JSON.parse(result.content?.[0]?.text ?? '');
          if (Array.isArray(parsed?.nodes)) nodes = ` nodes=${parsed.nodes.length}`;
        } catch {
          // markdown or a non-JSON block: no node count
        }
      }
      const ms = Date.now() - t0;
      const byMethod = [...proxy.calls.entries()].map(([m, n]) => `${m.replace('logseq.', '')}=${n}`).join(' ');
      console.log(`${label.padEnd(30)} calls=${String(proxy.total()).padEnd(5)} ${ms}ms${nodes}${flag}   ${byMethod}`);
    }

    // ADR-0038 (#550, #551): a list read in pages, counted in calls and bytes. Page 1 makes the tool's calls. A later page
    // with its cursor in the same server reads the snapshot page 1 kept (a hit: no call). The same cursor in a second
    // server, which holds no snapshot, makes page 1's calls again (a miss). Bytes are the characters of the content
    // blocks the call sent. `find_blocks` carries its `nextCursor` in the second content block (the meta), `find_pages`
    // in its one object.
    const sent = (result: { content?: Array<{ text?: string }> }) => (result.content ?? []).reduce((total, block) => total + (block.text ?? '').length, 0);
    type Paged = { tool: string; label: string; args: Args; cursorOf: (result: { content?: Array<{ text?: string }> }) => string | undefined };
    const cursorIn = (block: number, path: (value: any) => string | undefined) => (result: { content?: Array<{ text?: string }> }) => {
      try {
        return path(JSON.parse(result.content?.[block]?.text ?? ''));
      } catch {
        return undefined;
      }
    };
    const read = async (server: typeof rust, label: string, tool: string, args: Args, cursorOf: Paged['cursorOf']) => {
      server.proxy!.reset();
      const result = (await server.mcp.callTool({ name: tool, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
      const byMethod = [...server.proxy!.calls.entries()].map(([m, n]) => `${m.replace('logseq.', '')}=${n}`).join(' ');
      console.log(`${label.padEnd(30)} calls=${String(server.proxy!.total()).padEnd(5)} bytes=${sent(result)}${result.isError ? ' isError' : ''}   ${byMethod}`);
      return cursorOf(result);
    };
    const paged: Paged[] = [
      { tool: 'logseq_find_blocks', label: 'find_blocks (500', args: { text: subject.slice(0, 1), limit: 500 }, cursorOf: cursorIn(1, (value) => value?.meta?.nextCursor) },
      { tool: 'logseq_find_pages', label: 'find_pages (1000', args: { limit: 1000 }, cursorOf: cursorIn(0, (value) => value?.nextCursor) },
    ];
    const another = await startRustServer(choice.rustBinary, config, true);
    try {
      for (const { tool, label, args, cursorOf } of paged) {
        const name = tool.replace('logseq_', '');
        const cursor = await read(rust, `${label}, page 1)`, tool, args, cursorOf);
        if (cursor) {
          await read(rust, `${name} (cursor, a hit)`, tool, { cursor }, cursorOf);
          await read(another, `${name} (cursor, a miss)`, tool, { cursor }, cursorOf);
        } else {
          console.log(`${label}, page 1)`.padEnd(30) + ' no nextCursor: this call has no second page on this graph');
        }
      }
    } finally {
      await another.close();
    }
  } finally {
    await rust.close();
  }
}

main().catch((e: unknown) => {
  // The error class only. Never print e.message, e.stack or the error object: an MCP error
  // carries the server's text, which can quote a page name from the graph.
  console.error(`measure-api-calls failed: ${e instanceof Error ? e.name : typeof e}`);
  process.exit(1);
});
