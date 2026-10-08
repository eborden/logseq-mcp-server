/**
 * Count LogSeq HTTP API calls made by each tool of the Rust server against a live graph.
 * Evidence for the performance claims in CLAUDE.md.
 *
 * Usage: npx tsx scripts/measure-api-calls.ts [pageName]
 * Requires LogSeq running with the HTTP API enabled, and the Rust debug build (`cd rust && cargo build`). Read-only.
 *
 * The server is started with a config that points at a small forwarder in this process, which makes each call
 * through a counting client (scripts/lib/rust-server.ts), so the counts are the server's own calls. With no
 * LOGSEQ_MCP_CONFIG it reads the real graph on purpose, and its output has real page names: never paste it.
 */
import { loadConfig, LogseqClient, resolveConfigPath } from './lib/logseq-api.js';
import { closeSessions, rustSession } from './lib/rust-server.js';

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
  const subject = process.argv[2] ?? ranked[0];
  // A second page for the two-topic tool, so the "same topic" shortcut doesn't hide its cost
  const otherSubject = ranked.find(n => n !== subject.toLowerCase()) ?? subject;
  console.log(`graph pages: ${pages}   subject: ${JSON.stringify(subject)}\n`);

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

  /** One tool call through the Rust server, as a client makes it: its result's first block as JSON, `isError` or not. */
  const mcp = await rustSession(client, { tips: false });
  const tool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = (await mcp.callTool({ name: `logseq_${name}`, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const first = result.content[0]?.text ?? '';
    try {
      const parsed: any = JSON.parse(first);
      // The one-word outcome of an error result, as the old script printed an error's name
      return result.isError ? { error: true } : parsed;
    } catch {
      return first;
    }
  };
  type Case = [string, () => Promise<unknown>];

  const cases: Case[] = [
    ['get_concept_network depth=1', () => tool('get_concept_network', { concept_name: subject, max_depth: 1 })],
    ['get_concept_network depth=2', () => tool('get_concept_network', { concept_name: subject, max_depth: 2 })],
    ['build_context', () => tool('build_context', { topic_name: subject })],
    ['get_context_for_query (1 topic)', () => tool('get_context_for_query', { query: `what about [[${subject}]]?` })],
    ['search_blocks', () => tool('search_blocks', { query: subject.slice(0, 4), limit: 10 })],
    ['query_by_date_range (7 days)', () => tool('query_by_date_range', { start_date: ymd(start), end_date: ymd(end) })],
    ['query_by_property', () => tool('query_by_property', { property_key: 'type', property_value: 'x' })],
    ['get_current_context', () => tool('get_current_context', {})],
    ['build_context resolve_refs', () => tool('build_context', { topic_name: subject, resolve_refs: true })],
    ['query_by_date_range 7d resolve_refs', () => tool('query_by_date_range', { start_date: ymd(start), end_date: ymd(end), resolve_refs: true })],
    ['get_page', () => tool('get_page', { page_name: subject, include_children: false })],
    ['get_page_outline', () => tool('get_page_outline', { page_name: subject })],
    ['get_backlinks', () => tool('get_backlinks', { page_name: subject })],
    ['get_concept_evolution', () => tool('get_concept_evolution', { concept_name: subject })],
    ['search_by_relationship references', () => tool('search_by_relationship', { topic_a: subject, topic_b: otherSubject, relationship_type: 'references' })],
    ['search_by_relationship references (same topic twice)', () => tool('search_by_relationship', { topic_a: subject, topic_b: subject, relationship_type: 'references' })],
    ['search_by_relationship connected-within', () => tool('search_by_relationship', { topic_a: subject, topic_b: otherSubject, relationship_type: 'connected-within', max_distance: 1 })],
    ['get_page (not found)', () => tool('get_page', { page_name: 'no such page 41 probe', include_children: false })],
    // Real pages, an alias when the graph has one, and a made-up term, all in one text
    ['check_links (4 terms)', () => {
      const terms = [subject, otherSubject, uniqueAlias ?? 'no such page 146 probe a', 'no such page 146 probe b'];
      return tool('check_links', { before: terms.join(', '), after: terms.map(t => `[[${t}]]`).join(', ') });
    }],
    ...(uniqueAlias
      ? ([
          ['build_context (alias)', () => tool('build_context', { topic_name: uniqueAlias })],
          ['get_page (alias)', () => tool('get_page', { page_name: uniqueAlias, include_children: false })],
          ['get_page_outline (alias)', () => tool('get_page_outline', { page_name: uniqueAlias })]
        ] as Case[])
      : []),
    ...(sharedAlias ? ([['get_page (shared alias)', () => tool('get_page', { page_name: sharedAlias, include_children: false })]] as Case[]) : []),
    ...(aliased
      ? ([
          ['get_backlinks (aliased page)', () => tool('get_backlinks', { page_name: aliased })],
          ['build_context (aliased page)', () => tool('build_context', { topic_name: aliased })],
          ['get_concept_evolution (aliased page)', () => tool('get_concept_evolution', { concept_name: aliased })],
          ['get_concept_network depth=1 (aliased page)', () => tool('get_concept_network', { concept_name: aliased, max_depth: 1 })],
          ['get_concept_network depth=2 (aliased page)', () => tool('get_concept_network', { concept_name: aliased, max_depth: 2 })],
          ['search_by_relationship references (aliased topic)', () => tool('search_by_relationship', { topic_a: aliased, topic_b: otherSubject, relationship_type: 'references' })],
          ['search_by_relationship connected-within (aliased topic)', () => tool('search_by_relationship', { topic_a: aliased, topic_b: otherSubject, relationship_type: 'connected-within', max_distance: 1 })],
          ['query_by_date_range 7d search_term (aliased page)', () => tool('query_by_date_range', { start_date: ymd(start), end_date: ymd(end), search_term: aliased })]
        ] as Case[])
      : []),
    ...(isoDay
      ? ([
          ['get_page (ISO date)', () => tool('get_page', { page_name: isoDay, include_children: false })],
          ['get_page_outline (ISO date)', () => tool('get_page_outline', { page_name: isoDay })],
          ['build_context (ISO date)', () => tool('build_context', { topic_name: isoDay })]
        ] as Case[])
      : []),
    ...(refBlock && refPage
      ? ([
          ['get_block (ref block)', () => tool('get_block', { block_uuid: refBlock, include_children: false })],
          ['get_block resolve_refs', () => tool('get_block', { block_uuid: refBlock, include_children: false, resolve_refs: true })],
          ['get_page children', () => tool('get_page', { page_name: refPage, include_children: true })],
          ['get_page children resolve_refs', () => tool('get_page', { page_name: refPage, include_children: true, resolve_refs: true })]
        ] as Case[])
      : [])
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
  await closeSessions();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
