import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { exploreContext, exploreNetworkPath, findBlocksWithMeta, exploreTimeline, exploreNetwork } from './helpers/tools.js';
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

  it('explore_context: the alias and the canonical name return the same references, from at most 4 calls', async () => {
    const byName = await counted(() => exploreContext(client, target.canonical, { maxReferences: 100, maxRelatedPages: 100 }));
    const byAlias = await counted(() => exploreContext(client, target.alias, { maxReferences: 100, maxRelatedPages: 100 }));

    const ids = (r: typeof byName.result) => new Set(r.references.map(reference => reference.block.id));
    // 24 blocks on 14 pages link project atlas or atlas
    expect(ids(byName.result).size).toBe(24);
    expect(byName.result.relatedPages).toHaveLength(14);
    expect(sameSet(ids(byName.result), ids(byAlias.result))).toBe(true);
    expect(byName.result.references.map(reference => reference.block.id)).toEqual(byAlias.result.references.map(reference => reference.block.id));
    expect(byName.result.resolvedAliases).toEqual(ALIAS_GROUP);
    expect(byAlias.result.resolvedAliases).toEqual(byName.result.resolvedAliases);
    expect(byName.calls <= 4 && byAlias.calls <= 4).toBe(true); // resolver, alias group, blocks, references
  });

  it('explore_context includes every block that references the alias page itself', async () => {
    const { references } = await exploreContext(client, target.canonical, { maxReferences: 100 });
    const found = new Set(references.map(reference => reference.block.id));
    const direct = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
      `[:find ?b :where [?a :block/name ${JSON.stringify(target.alias)}] [?b :block/refs ?a] [?b :block/page ?pg] (not [?pg :block/alias ?a])]`
    ]);
    // A block on the alias stub's own declaring page is not a backlink; every other referencing block is.
    // The two journal blocks that link [[atlas]]: without them the check below proves nothing.
    expect(direct).toHaveLength(target.aliasRefs);
    const missing = direct.filter(([id]) => !found.has(id)).length;
    expect(missing).toBe(0);
  });

  it('explore_context: a source page carries the same keys as the Editor call gives it', async () => {
    const { references } = await exploreContext(client, target.canonical, { maxReferences: 100 });
    const keysOf = (page: object) => Object.keys(page).sort().join(',');
    const editorKeys = new Map<number, string>();
    for (const name of [target.canonical, target.alias]) {
      const tuples = (await client.callAPI<any[]>('logseq.Editor.getPageLinkedReferences', [name])) ?? [];
      for (const [page] of tuples) if (page?.id !== undefined) editorKeys.set(page.id, keysOf(page));
    }

    const sharedPages = new Map<number, object>();
    for (const reference of references) if (editorKeys.has(reference.sourcePage.id)) sharedPages.set(reference.sourcePage.id, reference.sourcePage);
    expect(sharedPages.size).toBe(14);
    const mismatched = [...sharedPages].filter(([id, page]) => keysOf(page) !== editorKeys.get(id)).length;
    expect(mismatched).toBe(0);
  });

  it('explore_network with to: a page and its alias are the same page, and no path is walked', async () => {
    const { result, calls } = await counted(() => exploreNetworkPath(client, target.canonical, target.alias, 2));

    expect(result.nodes).toEqual([]);
    expect(result.warnings.map(w => w.code)).toEqual(['same_page']);
    expect(calls).toBeLessThanOrEqual(3); // resolvers and the alias group, no hop query
  });

  it('explore_timeline with a page: either name yields the same block set, including alias-only blocks', async () => {
    const byName = await counted(() => exploreTimeline(client, { page: target.canonical }));
    const byAlias = await counted(() => exploreTimeline(client, { page: target.alias }));

    const ids = (r: typeof byName.result) => new Set(r.entries.flatMap(t => t.blocks.map(b => b.id)));
    expect(sameSet(ids(byName.result), ids(byAlias.result))).toBe(true);
    expect(ids(byName.result).size).toBe(22);
    // 12 on journal days, 10 with no day
    expect(byName.result.summary).toMatchObject({ totalBlocks: 22 });
    expect(byName.result.entries.filter(t => t.date === null).flatMap(t => t.blocks)).toHaveLength(10);
    expect(byName.result.resolvedAliases).toEqual(ALIAS_GROUP);
    expect(byName.calls <= 5 && byAlias.calls <= 5).toBe(true);
  });

  it('explore_context: either name yields the same references and blocks', async () => {
    const byName = await exploreContext(client, target.canonical);
    const byAlias = await exploreContext(client, target.alias);

    const refIds = (c: typeof byName) => new Set(c.references.map(r => r.block.id));
    expect(sameSet(refIds(byName), refIds(byAlias))).toBe(true);
    expect(byName.totals).toEqual(byAlias.totals);
    expect(byName.totals).toEqual({ blocks: 8, relatedPages: 14, references: 24 });
    expect(byAlias.resolvedAliases).toEqual(byName.resolvedAliases);
  });

  it('explore_network: either name yields the same network, with the alias folded into the root', async () => {
    const byName = await exploreNetwork(client, target.canonical, 1);
    const byAlias = await exploreNetwork(client, target.alias, 1);

    expect(sameSet(new Set(byName.nodes.map(n => n.id)), new Set(byAlias.nodes.map(n => n.id)))).toBe(true);
    expect(byName.edges).toEqual(byAlias.edges);
    // one node for the whole group: the root, and no second node for an alias
    expect(byName.nodes.filter(n => n.depth === 0)).toHaveLength(1);
    expect(byName.resolvedAliases).toEqual(ALIAS_GROUP);
    const rootNames = new Set(byName.resolvedAliases!.map(n => n.toLowerCase()));
    expect(byName.nodes.filter(n => rootNames.has(n.name.toLowerCase()))).toHaveLength(1);
  });

  it('find_blocks: links_to either name of a page yields the same blocks, and says which names it covered', async () => {
    const range = { limit: 500 };
    const byName = await findBlocksWithMeta(client, { linksTo: [target.canonical] }, range);
    const byAlias = await findBlocksWithMeta(client, { linksTo: [target.alias] }, range);
    const context = await exploreContext(client, target.canonical, { maxReferences: 100 });

    const ids = (blocks: Array<{ id?: unknown }>) => new Set<number>(blocks.map(b => Number(b.id)));
    expect(sameSet(ids(byName.results), ids(byAlias.results))).toBe(true);
    // 19 blocks link project atlas or atlas directly. 17 are among the 24 backlinks (the other 7 sit under a linking
    // block and link only through it), and 2 are on project atlas itself, which are no backlinks of it
    const listed = ids(context.references.map(reference => reference.block));
    expect(byName.results).toHaveLength(19);
    const own = byName.results.filter(b => !listed.has(Number(b.id)));
    expect(own).toHaveLength(2);
    expect(own.every(b => (b.page as { name?: string }).name === target.canonical)).toBe(true);
    expect(byName.meta.totals).toEqual({ matches: 19 });
    // each call says which names its page was searched under, and a name that was an alias says which page it stood for
    expect(Object.values(byName.meta.resolvedAliases)).toEqual([ALIAS_GROUP]);
    expect(byAlias.meta.resolvedAliases).toEqual(byName.meta.resolvedAliases);
    expect(byName.meta.resolvedFrom).toBeUndefined();
    expect(byAlias.meta.resolvedFrom).toEqual([{ name: target.alias, matchedBy: 'alias', resolvedTo: target.canonical }]);
  });

  it('find_blocks: page covers the blocks written on either name of it, and links_to the links to either name', async () => {
    const onPage = await findBlocksWithMeta(client, { page: target.alias }, { limit: 500 });
    const onCanonical = await findBlocksWithMeta(client, { page: target.canonical }, { limit: 500 });
    expect(onPage.results.map(b => b.id)).toEqual(onCanonical.results.map(b => b.id));
    expect(onPage.meta.resolvedAliases).toEqual(onCanonical.meta.resolvedAliases);

    const both = await findBlocksWithMeta(client, { page: target.canonical, linksTo: [plain] }, { limit: 500 });
    const byAlias = await findBlocksWithMeta(client, { page: target.alias, linksTo: [plain] }, { limit: 500 });
    expect(both.results.length).toBeGreaterThan(0);
    expect(byAlias.results.map(b => b.id)).toEqual(both.results.map(b => b.id));
    // Bob has no aliases: he is not in resolvedAliases
    expect(Object.keys(both.meta.resolvedAliases)).toHaveLength(1);
  });

  it('explore_timeline with a page and a period: either name yields the same blocks on the journal days', async () => {
    const range = { startDate: 20000101, endDate: 21001231 };
    const byName: any = await exploreTimeline(client, { ...range, page: target.canonical });
    const byAlias: any = await exploreTimeline(client, { ...range, page: target.alias });

    const blocks = (r: any) => new Set<number>(r.entries.flatMap((e: any) => e.blocks.map((b: any) => b.id)));
    // the 12 blocks on journal days; the 10 on other pages have no day in the period
    expect(blocks(byName).size).toBe(12);
    expect(sameSet(blocks(byName), blocks(byAlias))).toBe(true);
    expect(byName.entries.every((e: any) => e.date !== null)).toBe(true);
    expect(byName.resolvedAliases).toEqual(byAlias.resolvedAliases);
    expect(byName.resolvedAliases).toEqual(ALIAS_GROUP);
  });

  it('a page with no aliases is unchanged: no resolvedAliases, no extra calls', async () => {
    const context = await counted(() => exploreContext(client, plain));
    expect('resolvedAliases' in context.result).toBe(false);
    expect(context.calls).toBeLessThanOrEqual(3); // resolver, blocks, references

    const timeline = await exploreTimeline(client, { page: plain });
    expect('resolvedAliases' in timeline).toBe(false);
  });
});
