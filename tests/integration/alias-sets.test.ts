import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getBacklinksWithMeta } from '../../src/tools/get-backlinks.js';
import { buildContextForTopic } from '../../src/tools/build-context.js';
import { getConceptEvolution } from '../../src/tools/get-concept-evolution.js';
import { getConceptNetwork } from '../../src/tools/get-concept-network.js';
import { searchByRelationship } from '../../src/tools/search-by-relationship.js';
import { queryJournals } from '../../src/tools/query-by-date-range.js';

/**
 * Integration tests for alias-aware link following (#69).
 *
 * Read-only. Finds a page that declares an alias (`alias:: x`) whose stub
 * `x` is referenced by at least one block, then asks each link-following tool
 * for the page by its canonical name and by the alias, and checks that both
 * calls cover the same blocks. Asserts structure only (booleans and counts);
 * it never prints or asserts on a name or block content from the graph.
 *
 * Requires LogSeq running with the HTTP API enabled, ~/.logseq-mcp/config.json,
 * and a page with an `alias::` whose alias is linked from some other block.
 * See tests/integration/setup.md ("Alias data").
 */

const SETUP_HINT = 'See tests/integration/setup.md ("Alias data")';

const sameSet = (a: Set<unknown>, b: Set<unknown>) => a.size === b.size && [...a].every(x => b.has(x));

describe('alias-aware link following against a live graph', () => {
  let client: LogseqClient;
  let apiCalls = 0;
  /** Canonical page name, its alias, and how many blocks reference the alias */
  let target: { canonical: string; alias: string; aliasRefs: number };
  /** A page with a file and no alias link */
  let plain: string;

  const counted = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> => {
    const before = apiCalls;
    const result = await run();
    return { result, calls: apiCalls - before };
  };

  beforeAll(async () => {
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
    try {
      await access(configPath);
    } catch {
      throw new Error(`Config file not found at ~/.logseq-mcp/config.json. ${SETUP_HINT}`);
    }
    client = new LogseqClient(await loadConfig(configPath));
    try {
      await client.callAPI('logseq.App.getCurrentGraph');
    } catch (error) {
      throw new Error(
        `Cannot connect to LogSeq HTTP API: ${error instanceof Error ? error.message : 'Unknown error'}\n${SETUP_HINT}`
      );
    }
    const original = client.callAPI.bind(client);
    client.callAPI = (async (method: string, args?: any[]) => {
      apiCalls++;
      return original(method, args);
    }) as typeof client.callAPI;

    const raw = (q: string) => original<any[]>('logseq.DB.datascriptQuery', [q]);
    // Aliases declared by exactly one page (a shared alias is ambiguous for the resolver) that other blocks link
    const declared = await raw(
      `[:find ?pn ?an :where [?p :block/alias ?a] [?p :block/file] (not [?a :block/file]) [?p :block/name ?pn] [?a :block/name ?an]]`
    );
    const sources = new Map<string, string[]>();
    for (const [pn, an] of declared) sources.set(an, [...(sources.get(an) ?? []), pn]);
    const refCounts = new Map<string, number>(
      (await raw(`[:find ?an (count ?b) :where [?p :block/alias ?a] (not [?a :block/file]) [?a :block/name ?an] [?b :block/refs ?a]]`)).map(
        ([an, n]) => [an, n]
      )
    );
    const pick = [...sources.entries()].find(([an, pages]) => pages.length === 1 && (refCounts.get(an) ?? 0) > 0);
    expect(pick !== undefined, `No page with an alias that only it declares and other blocks link. ${SETUP_HINT}`).toBe(true);
    target = { canonical: pick![1][0], alias: pick![0], aliasRefs: refCounts.get(pick![0])! };

    const plains = await raw(
      `[:find ?n :where [?p :block/name ?n] [?p :block/file] (not [?p :block/alias ?x]) (not [?p :block/journal? true])]`
    );
    expect(plains.length, `No page with a file and no alias. ${SETUP_HINT}`).toBeGreaterThan(0);
    plain = plains[0][0];
  });

  it('get_backlinks: the alias and the canonical name return the same blocks, from at most 3 calls', async () => {
    const byName = await counted(() => getBacklinksWithMeta(client, target.canonical));
    const byAlias = await counted(() => getBacklinksWithMeta(client, target.alias));

    const ids = (r: typeof byName.result) =>
      new Set((r.results ?? []).flatMap(([, blocks]) => blocks.map(b => b.id)));
    expect(ids(byName.result).size).toBeGreaterThan(0);
    expect(sameSet(ids(byName.result), ids(byAlias.result))).toBe(true);
    expect((byName.result.meta?.resolvedAliases?.length ?? 0) >= 2).toBe(true);
    expect(byAlias.result.meta?.resolvedAliases).toEqual(byName.result.meta?.resolvedAliases);
    expect(byName.calls <= 3 && byAlias.calls <= 3).toBe(true); // resolver, alias group, references
  });

  it('get_backlinks includes every block that references the alias page itself', async () => {
    const { results } = await getBacklinksWithMeta(client, target.canonical);
    const found = new Set((results ?? []).flatMap(([, blocks]) => blocks.map(b => b.id)));
    const direct = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
      `[:find ?b :where [?a :block/name ${JSON.stringify(target.alias)}] [?b :block/refs ?a] [?b :block/page ?pg] (not [?pg :block/alias ?a])]`
    ]);
    // A block on the alias stub's own declaring page is not a backlink; every other referencing block is
    const missing = direct.filter(([id]) => !found.has(id)).length;
    expect(missing).toBe(0);
  });

  it('get_concept_evolution: either name yields the same block set, including alias-only blocks', async () => {
    const byName = await counted(() => getConceptEvolution(client, target.canonical));
    const byAlias = await counted(() => getConceptEvolution(client, target.alias));

    const ids = (r: typeof byName.result) => new Set(r.timeline.flatMap(t => t.blocks.map(b => b.id)));
    expect(sameSet(ids(byName.result), ids(byAlias.result))).toBe(true);
    expect(ids(byName.result).size).toBeGreaterThanOrEqual(target.aliasRefs);
    expect((byName.result.resolvedAliases?.length ?? 0) >= 2).toBe(true);
    expect(byName.calls <= 5 && byAlias.calls <= 5).toBe(true);
  });

  it('build_context: either name yields the same references and blocks', async () => {
    const byName = await buildContextForTopic(client, target.canonical);
    const byAlias = await buildContextForTopic(client, target.alias);

    const refIds = (c: typeof byName) => new Set(c.references.map(r => r.block.id));
    expect(sameSet(refIds(byName), refIds(byAlias))).toBe(true);
    expect(byName.totals).toEqual(byAlias.totals);
    expect(byAlias.resolvedAliases).toEqual(byName.resolvedAliases);
  });

  it('get_concept_network: either name yields the same network, with the alias folded into the root', async () => {
    const byName = await getConceptNetwork(client, target.canonical, 1);
    const byAlias = await getConceptNetwork(client, target.alias, 1);

    expect(sameSet(new Set(byName.nodes.map(n => n.id)), new Set(byAlias.nodes.map(n => n.id)))).toBe(true);
    expect(byName.edges).toEqual(byAlias.edges);
    // one node for the whole group: the root, and no second node for an alias
    expect(byName.nodes.filter(n => n.depth === 0)).toHaveLength(1);
    expect((byName.resolvedAliases?.length ?? 0) >= 2).toBe(true);
    const rootNames = new Set(byName.resolvedAliases!.map(n => n.toLowerCase()));
    expect(byName.nodes.filter(n => rootNames.has(n.name.toLowerCase()))).toHaveLength(1);
  });

  it('search_by_relationship: either name of a topic yields the same blocks', async () => {
    const byName = await searchByRelationship(client, target.canonical, plain, 'in-pages-linking-to');
    const byAlias = await searchByRelationship(client, target.alias, plain, 'in-pages-linking-to');

    expect(sameSet(new Set(byName.results.map(b => b.id)), new Set(byAlias.results.map(b => b.id)))).toBe(true);
    expect(byAlias.resolvedAliases?.topicA).toEqual(byName.resolvedAliases?.topicA);
    expect((byName.resolvedAliases?.topicA?.length ?? 0) >= 2).toBe(true);
    expect(byName.resolvedAliases?.topicB).toBeUndefined();
  });

  it('query_by_date_range: a search_term naming either name matches the same blocks', async () => {
    const range = { startDate: 20000101, endDate: 21001231 };
    const byName: any = await queryJournals(client, { ...range, searchTerm: target.canonical });
    const byAlias: any = await queryJournals(client, { ...range, searchTerm: target.alias });

    const ids = (r: any) =>
      new Set(r.entries.flatMap((e: any) => e.blocks.map((b: any) => b.id)));
    expect(sameSet(ids(byName), ids(byAlias))).toBe(true);
    expect(byName.resolvedAliases).toEqual(byAlias.resolvedAliases);
    expect((byName.resolvedAliases?.length ?? 0) >= 2).toBe(true);
  });

  it('a page with no aliases is unchanged: no resolvedAliases, no extra calls', async () => {
    const backlinks = await counted(() => getBacklinksWithMeta(client, plain));
    expect(backlinks.result.meta).toBeNull();
    expect(backlinks.calls).toBeLessThanOrEqual(2); // resolver (none for an exact page with a file) + references

    const evolution = await getConceptEvolution(client, plain);
    expect('resolvedAliases' in evolution).toBe(false);
  });
});
