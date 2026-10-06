/**
 * Count LogSeq HTTP API calls made by each tool against a live graph.
 * Evidence for the performance claims in CLAUDE.md.
 *
 * Usage: npx tsx scripts/measure-api-calls.ts [pageName]
 * Requires LogSeq running with the HTTP API enabled. Read-only.
 */
import { loadConfig, resolveConfigPath } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { getConceptNetwork } from '../src/tools/get-concept-network.js';
import { searchBlocks } from '../src/tools/search-blocks.js';
import { queryByDateRange } from '../src/tools/query-by-date-range.js';
import { queryByProperty } from '../src/tools/query-by-property.js';
import { buildContextForTopic } from '../src/tools/build-context.js';
import { getContextForQuery } from '../src/tools/get-context-for-query.js';
import { getCurrentContext } from '../src/tools/get-current-context.js';
import { getBlock } from '../src/tools/get-block.js';
import { getPage } from '../src/tools/get-page.js';
import { getPageOutline } from '../src/tools/get-page-outline.js';
import { queryJournals } from '../src/tools/query-by-date-range.js';
import { getBacklinks } from '../src/tools/get-backlinks.js';
import { getConceptEvolution } from '../src/tools/get-concept-evolution.js';
import { searchByRelationship } from '../src/tools/search-by-relationship.js';
import { checkLinks } from '../src/tools/check-links.js';

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

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['get_concept_network depth=1', () => getConceptNetwork(client, subject, 1)],
    ['get_concept_network depth=2', () => getConceptNetwork(client, subject, 2)],
    ['build_context', () => buildContextForTopic(client, subject)],
    ['get_context_for_query (1 topic)', () => getContextForQuery(client, `what about [[${subject}]]?`)],
    ['search_blocks', () => searchBlocks(client, subject.slice(0, 4), 10)],
    ['query_by_date_range (7 days)', () => queryByDateRange(client, ymd(start), ymd(end))],
    ['query_by_property', () => queryByProperty(client, 'type', 'x')],
    ['get_current_context', () => getCurrentContext(client)],
    ['build_context resolve_refs', () => buildContextForTopic(client, subject, { resolveRefs: true })],
    ['query_by_date_range 7d resolve_refs', () =>
      queryJournals(client, { startDate: ymd(start), endDate: ymd(end), resolveRefs: true })],
    ['get_page', () => getPage(client, subject, false)],
    ['get_page_outline', () => getPageOutline(client, subject)],
    ['get_backlinks', () => getBacklinks(client, subject)],
    ['get_concept_evolution', () => getConceptEvolution(client, subject)],
    ['search_by_relationship references', () => searchByRelationship(client, subject, otherSubject, 'references')],
    ['search_by_relationship references (same topic twice)', () => searchByRelationship(client, subject, subject, 'references')],
    ['search_by_relationship connected-within', () => searchByRelationship(client, subject, otherSubject, 'connected-within', 1)],
    ['get_page (not found)', () => getPage(client, 'no such page 41 probe', false).catch(e => e.name)],
    // Real pages, an alias when the graph has one, and a made-up term, all in one text
    ['check_links (4 terms)', () => {
      const terms = [subject, otherSubject, uniqueAlias ?? 'no such page 146 probe a', 'no such page 146 probe b'];
      return checkLinks(client, terms.join(', '), terms.map(t => `[[${t}]]`).join(', '));
    }],
    ...(uniqueAlias
      ? ([
          ['build_context (alias)', () => buildContextForTopic(client, uniqueAlias)],
          ['get_page (alias)', () => getPage(client, uniqueAlias, false)],
          ['get_page_outline (alias)', () => getPageOutline(client, uniqueAlias)]
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
    ...(sharedAlias
      ? ([['get_page (shared alias)', () => getPage(client, sharedAlias, false).catch(e => e.name)]] as Array<
          [string, () => Promise<unknown>]
        >)
      : []),
    ...(aliased
      ? ([
          ['get_backlinks (aliased page)', () => getBacklinks(client, aliased)],
          ['build_context (aliased page)', () => buildContextForTopic(client, aliased)],
          ['get_concept_evolution (aliased page)', () => getConceptEvolution(client, aliased)],
          ['get_concept_network depth=1 (aliased page)', () => getConceptNetwork(client, aliased, 1)],
          ['get_concept_network depth=2 (aliased page)', () => getConceptNetwork(client, aliased, 2)],
          ['search_by_relationship references (aliased topic)', () => searchByRelationship(client, aliased, otherSubject, 'references')],
          ['search_by_relationship connected-within (aliased topic)', () => searchByRelationship(client, aliased, otherSubject, 'connected-within', 1)],
          ['query_by_date_range 7d search_term (aliased page)', () =>
            queryJournals(client, { startDate: ymd(start), endDate: ymd(end), searchTerm: aliased })]
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
    ...(isoDay
      ? ([
          ['get_page (ISO date)', () => getPage(client, isoDay, false)],
          ['get_page_outline (ISO date)', () => getPageOutline(client, isoDay)],
          ['build_context (ISO date)', () => buildContextForTopic(client, isoDay)]
        ] as Array<[string, () => Promise<unknown>]>)
      : []),
    ...(refBlock && refPage
      ? ([
          ['get_block (ref block)', () => getBlock(client, refBlock, false)],
          ['get_block resolve_refs', () => getBlock(client, refBlock, false, { resolveRefs: true })],
          ['get_page children', () => getPage(client, refPage, true)],
          ['get_page children resolve_refs', () => getPage(client, refPage, true, { resolveRefs: true })]
        ] as Array<[string, () => Promise<unknown>]>)
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
