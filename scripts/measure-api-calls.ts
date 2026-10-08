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
    ['get_concept_network depth=1', 'logseq_get_concept_network', { concept_name: subject, max_depth: 1 }],
    ['get_concept_network depth=2', 'logseq_get_concept_network', { concept_name: subject, max_depth: 2 }],
    ['build_context', 'logseq_build_context', { topic_name: subject }],
    ['get_context_for_query (1 topic)', 'logseq_get_context_for_query', { query: `what about [[${subject}]]?` }],
    ['search_blocks', 'logseq_search_blocks', { query: subject.slice(0, 4), limit: 10 }],
    ['query_by_date_range (7 days)', 'logseq_query_by_date_range', dr],
    ['query_by_property', 'logseq_query_by_property', { property_key: 'type', property_value: 'x' }],
    ['get_current_context', 'logseq_get_current_context', {}],
    ['build_context resolve_refs', 'logseq_build_context', { topic_name: subject, resolve_refs: true }],
    ['query_by_date_range 7d resolve_refs', 'logseq_query_by_date_range', { ...dr, resolve_refs: true }],
    ['get_page', 'logseq_get_page', { page_name: subject, include_children: false }],
    ['get_page_outline', 'logseq_get_page_outline', { page_name: subject }],
    ['get_backlinks', 'logseq_get_backlinks', { page_name: subject }],
    ['get_concept_evolution', 'logseq_get_concept_evolution', { concept_name: subject }],
    ['search_by_relationship references', 'logseq_search_by_relationship', { topic_a: subject, topic_b: otherSubject, relationship_type: 'references' }],
    ['search_by_relationship references (same topic twice)', 'logseq_search_by_relationship', { topic_a: subject, topic_b: subject, relationship_type: 'references' }],
    ['search_by_relationship connected-within', 'logseq_search_by_relationship', { topic_a: subject, topic_b: otherSubject, relationship_type: 'connected-within', max_distance: 1 }],
    ['list_pages', 'logseq_list_pages', { limit: 50 }],
    ['get_graph_info', 'logseq_get_graph_info', {}],
    ['get_page (not found)', 'logseq_get_page', { page_name: 'no such page 41 probe', include_children: false }],
    // Real pages, an alias when the graph has one, and a made-up term, all in one text
    ['check_links (4 terms)', 'logseq_check_links', checkLinksArgs()],
    ...(uniqueAlias
      ? ([
          ['build_context (alias)', 'logseq_build_context', { topic_name: uniqueAlias }],
          ['get_page (alias)', 'logseq_get_page', { page_name: uniqueAlias, include_children: false }],
          ['get_page_outline (alias)', 'logseq_get_page_outline', { page_name: uniqueAlias }]
        ] as Case[])
      : []),
    ...(sharedAlias
      ? ([['get_page (shared alias)', 'logseq_get_page', { page_name: sharedAlias, include_children: false }]] as Case[])
      : []),
    ...(aliased
      ? ([
          ['get_backlinks (aliased page)', 'logseq_get_backlinks', { page_name: aliased }],
          ['build_context (aliased page)', 'logseq_build_context', { topic_name: aliased }],
          ['get_concept_evolution (aliased page)', 'logseq_get_concept_evolution', { concept_name: aliased }],
          ['get_concept_network depth=1 (aliased page)', 'logseq_get_concept_network', { concept_name: aliased, max_depth: 1 }],
          ['get_concept_network depth=2 (aliased page)', 'logseq_get_concept_network', { concept_name: aliased, max_depth: 2 }],
          ['search_by_relationship references (aliased topic)', 'logseq_search_by_relationship', { topic_a: aliased, topic_b: otherSubject, relationship_type: 'references' }],
          ['search_by_relationship connected-within (aliased topic)', 'logseq_search_by_relationship', { topic_a: aliased, topic_b: otherSubject, relationship_type: 'connected-within', max_distance: 1 }],
          ['query_by_date_range 7d search_term (aliased page)', 'logseq_query_by_date_range', { ...dr, search_term: aliased }]
        ] as Case[])
      : []),
    ...(isoDay
      ? ([
          ['get_page (ISO date)', 'logseq_get_page', { page_name: isoDay, include_children: false }],
          ['get_page_outline (ISO date)', 'logseq_get_page_outline', { page_name: isoDay }],
          ['build_context (ISO date)', 'logseq_build_context', { topic_name: isoDay }]
        ] as Case[])
      : []),
    ...(refBlock && refPage
      ? ([
          ['get_block (ref block)', 'logseq_get_block', { block_uuid: refBlock, include_children: false }],
          ['get_block resolve_refs', 'logseq_get_block', { block_uuid: refBlock, include_children: false, resolve_refs: true }],
          ['get_page children', 'logseq_get_page', { page_name: refPage, include_children: true }],
          ['get_page children resolve_refs', 'logseq_get_page', { page_name: refPage, include_children: true, resolve_refs: true }]
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
