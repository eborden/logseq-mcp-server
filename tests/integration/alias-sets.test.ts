import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { getBacklinksWithMeta } from '../../src/tools/get-backlinks.js';
import { buildContextForTopic } from '../../src/tools/build-context.js';
import { getConceptEvolution } from '../../src/tools/get-concept-evolution.js';
import { getConceptNetwork } from '../../src/tools/get-concept-network.js';
import { searchByRelationship } from '../../src/tools/search-by-relationship.js';
import { queryJournals } from '../../src/tools/query-by-date-range.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for alias-aware link following (#69), against the fixture graph.
 *
 * Read-only. `project atlas` declares `alias:: atlas`, which no other page declares, and two
 * journal blocks link `[[atlas]]` (Jan 2nd and Jan 7th, 2025). Each link-following tool is asked
 * for the page by its canonical name and by the alias, and both calls must cover the same blocks.
 * `Bob` is a page with a file and no alias, for the unchanged case.
 */

const sameSet = (a: Set<unknown>, b: Set<unknown>) => a.size === b.size && [...a].every(x => b.has(x));

const ALIAS_GROUP = ['atlas', 'project atlas'];

describe('alias-aware link following against the fixture graph', () => {
  let client: LogseqClient;
  let apiCalls = 0;
  const target = { canonical: 'project atlas', alias: 'atlas', aliasRefs: 2 };
  const plain = 'bob';

  const counted = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> => {
    const before = apiCalls;
    const result = await run();
    return { result, calls: apiCalls - before };
  };

  beforeAll(async () => {
    ({ client } = await connectFixture());
    const original = client.callAPI.bind(client);
    client.callAPI = (async (method: string, args?: any[]) => {
      apiCalls++;
      return original(method, args);
    }) as typeof client.callAPI;
  });

  it('get_backlinks: the alias and the canonical name return the same blocks, from at most 3 calls', async () => {
    const byName = await counted(() => getBacklinksWithMeta(client, target.canonical));
    const byAlias = await counted(() => getBacklinksWithMeta(client, target.alias));

    const ids = (r: typeof byName.result) =>
      new Set((r.results ?? []).flatMap(([, blocks]) => blocks.map(b => b.id)));
    // 24 blocks on 14 pages link project atlas or atlas
    expect(ids(byName.result).size).toBe(24);
    expect(byName.result.results).toHaveLength(14);
    expect(sameSet(ids(byName.result), ids(byAlias.result))).toBe(true);
    expect(byName.result.meta?.resolvedAliases).toEqual(ALIAS_GROUP);
    expect(byAlias.result.meta?.resolvedAliases).toEqual(byName.result.meta?.resolvedAliases);
    expect(byName.calls <= 3 && byAlias.calls <= 3).toBe(true); // resolver, alias group, references
  });

  it('get_backlinks includes every block that references the alias page itself', async () => {
    const { results } = await getBacklinksWithMeta(client, target.canonical);
    const found = new Set((results ?? []).flatMap(([, blocks]) => blocks.map(b => b.id)));
    const direct = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
      `[:find ?b :where [?a :block/name ${JSON.stringify(target.alias)}] [?b :block/refs ?a] [?b :block/page ?pg] (not [?pg :block/alias ?a])]`
    ]);
    // A block on the alias stub's own declaring page is not a backlink; every other referencing block is.
    // The two journal blocks that link [[atlas]]: without them the check below proves nothing.
    expect(direct).toHaveLength(target.aliasRefs);
    const missing = direct.filter(([id]) => !found.has(id)).length;
    expect(missing).toBe(0);
  });

  it('get_backlinks: a source page carries the same keys as the Editor call gives it', async () => {
    const { results } = await getBacklinksWithMeta(client, target.canonical);
    const keysOf = (page: object) => Object.keys(page).sort().join(',');
    const editorKeys = new Map<number, string>();
    for (const name of [target.canonical, target.alias]) {
      const tuples = (await client.callAPI<any[]>('logseq.Editor.getPageLinkedReferences', [name])) ?? [];
      for (const [page] of tuples) if (page?.id !== undefined) editorKeys.set(page.id, keysOf(page));
    }

    const shared = (results ?? []).filter(([page]) => editorKeys.has(page!.id!));
    expect(shared).toHaveLength(14);
    const mismatched = shared.filter(([page, blocks]) =>
      keysOf(page!) !== editorKeys.get(page!.id!) || blocks.some(b => keysOf(b.page as object) !== keysOf(page!))
    ).length;
    expect(mismatched).toBe(0);
  });

  it('search_by_relationship: connected-within reports a page and its alias as the same topic', async () => {
    const { result, calls } = await counted(() =>
      searchByRelationship(client, target.canonical, target.alias, 'connected-within', 2)
    );

    expect(result.results).toEqual([]);
    expect(result.warnings.map(w => w.code)).toEqual(['same_topic']);
    expect(calls).toBeLessThanOrEqual(3); // resolvers and the alias group, no hop query
  });

  it('get_concept_evolution: either name yields the same block set, including alias-only blocks', async () => {
    const byName = await counted(() => getConceptEvolution(client, target.canonical));
    const byAlias = await counted(() => getConceptEvolution(client, target.alias));

    const ids = (r: typeof byName.result) => new Set(r.timeline.flatMap(t => t.blocks.map(b => b.id)));
    expect(sameSet(ids(byName.result), ids(byAlias.result))).toBe(true);
    expect(ids(byName.result).size).toBe(22);
    expect(byName.result.summary).toMatchObject({ totalMentions: 22, journalMentions: 12, nonJournalMentions: 10 });
    expect(byName.result.resolvedAliases).toEqual(ALIAS_GROUP);
    expect(byName.calls <= 5 && byAlias.calls <= 5).toBe(true);
  });

  it('build_context: either name yields the same references and blocks', async () => {
    const byName = await buildContextForTopic(client, target.canonical);
    const byAlias = await buildContextForTopic(client, target.alias);

    const refIds = (c: typeof byName) => new Set(c.references.map(r => r.block.id));
    expect(sameSet(refIds(byName), refIds(byAlias))).toBe(true);
    expect(byName.totals).toEqual(byAlias.totals);
    expect(byName.totals).toEqual({ blocks: 8, relatedPages: 14, references: 24 });
    expect(byAlias.resolvedAliases).toEqual(byName.resolvedAliases);
  });

  it('get_concept_network: either name yields the same network, with the alias folded into the root', async () => {
    const byName = await getConceptNetwork(client, target.canonical, 1);
    const byAlias = await getConceptNetwork(client, target.alias, 1);

    expect(sameSet(new Set(byName.nodes.map(n => n.id)), new Set(byAlias.nodes.map(n => n.id)))).toBe(true);
    expect(byName.edges).toEqual(byAlias.edges);
    // one node for the whole group: the root, and no second node for an alias
    expect(byName.nodes.filter(n => n.depth === 0)).toHaveLength(1);
    expect(byName.resolvedAliases).toEqual(ALIAS_GROUP);
    const rootNames = new Set(byName.resolvedAliases!.map(n => n.toLowerCase()));
    expect(byName.nodes.filter(n => rootNames.has(n.name.toLowerCase()))).toHaveLength(1);
  });

  it('search_by_relationship: either name of a topic yields the same blocks', async () => {
    const byName = await searchByRelationship(client, target.canonical, plain, 'in-pages-linking-to');
    const byAlias = await searchByRelationship(client, target.alias, plain, 'in-pages-linking-to');

    expect(sameSet(new Set(byName.results.map(b => b.id)), new Set(byAlias.results.map(b => b.id)))).toBe(true);
    expect(byName.results).toHaveLength(9);
    expect(byAlias.resolvedAliases?.topicA).toEqual(byName.resolvedAliases?.topicA);
    expect(byName.resolvedAliases?.topicA).toEqual(ALIAS_GROUP);
    expect(byName.resolvedAliases?.topicB).toBeUndefined();
  });

  it('query_by_date_range: a search_term naming either name matches the same blocks, bar in-word hits of the term', async () => {
    const range = { startDate: 20000101, endDate: 21001231 };
    const byName: any = await queryJournals(client, { ...range, searchTerm: target.canonical });
    const byAlias: any = await queryJournals(client, { ...range, searchTerm: target.alias });

    const blocks = (r: any) => new Map<number, string>(
      r.entries.flatMap((e: any) => e.blocks.map((b: any) => [b.id, String(b.content ?? '').toLowerCase()]))
    );
    const [nameBlocks, aliasBlocks] = [blocks(byName), blocks(byAlias)];
    // The term itself also matches inside a word, as any term does; the group's other names
    // match as whole words or refs only. So a block only one call finds holds that call's term.
    const onlyIn = (a: Map<number, string>, b: Map<number, string>, term: string) =>
      [...a].filter(([id]) => !b.has(id)).filter(([, content]) => !content.includes(term.toLowerCase())).length;
    expect(nameBlocks.size).toBe(10);
    expect(byName.entries.map((e: any) => e.date)).toEqual(
      [20241231, 20250102, 20250106, 20250107, 20250108, 20250113, 20250115]
    );
    expect(onlyIn(nameBlocks, aliasBlocks, target.canonical)).toBe(0);
    expect(onlyIn(aliasBlocks, nameBlocks, target.alias)).toBe(0);
    expect(byName.resolvedAliases).toEqual(byAlias.resolvedAliases);
    expect(byName.resolvedAliases).toEqual(ALIAS_GROUP);
  });

  it('a page with no aliases is unchanged: no resolvedAliases, no extra calls', async () => {
    const backlinks = await counted(() => getBacklinksWithMeta(client, plain));
    expect(backlinks.result.meta).toBeNull();
    expect(backlinks.calls).toBeLessThanOrEqual(2); // resolver (none for an exact page with a file) + references

    const evolution = await getConceptEvolution(client, plain);
    expect('resolvedAliases' in evolution).toBe(false);
  });
});
