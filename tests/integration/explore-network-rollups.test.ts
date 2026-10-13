import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { exploreNetwork } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for the roll-up rule and the snippets of explore_network (#498), against the fixture graph.
 *
 * A roll-up page is a page that links more than 30 pages. `solo topic` is linked by three of them (`rollup 29`, `rollup 30`
 * and `rollup 31`, named by the pages each links) and links 12 pages of its own, so the three sit at, under and over the
 * threshold. See tests/fixtures/README.md, "Roll-up pages". Read-only.
 */

const topics = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `rollup topic ${String(from + i).padStart(2, '0')}`);

describe('explore_network: roll-up pages stay leaves, and edges can say why', () => {
  let client: LogseqClient;
  let apiCalls = 0;

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

  it('depth 1: the roll-up over the threshold ranks after the topical pages, and the two under it keep their rank', async () => {
    const { result, calls } = await counted(() => exploreNetwork(client, 'solo topic', 1));
    const names: string[] = result.nodes.map((n: { name: string }) => n.name);
    // 12 topical pages and 3 roll-ups fill the 15 of max_fanout: nothing is dropped
    expect(names).toHaveLength(16);
    expect(result).toMatchObject({ truncated: false, hasMore: false, warnings: [] });
    // `rollup 29` and `rollup 30` link `solo topic` in two blocks, so they lead the one-block topical pages as they always did
    expect(names.slice(0, 3)).toEqual(['solo topic', 'rollup 29', 'rollup 30']);
    // `rollup 31` links 31 pages: after every other page, whatever its two blocks
    expect(names[15]).toBe('rollup 31');
    expect(names.slice(3, 15).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `solo link ${String(i + 1).padStart(2, '0')}`));
    expect(calls).toBe(2);
  });

  it('a cap that bites drops the roll-up first', async () => {
    const result = await exploreNetwork(client, 'solo topic', 1, { maxFanout: 14 });
    const names: string[] = result.nodes.map((n: { name: string }) => n.name);
    expect(names).toHaveLength(15);
    expect(names).not.toContain('rollup 31');
    expect(names).toContain('rollup 30');
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((w: { code: string }) => w.code)).toEqual(['network_truncated']);
  });

  it('depth 2: a page at the threshold is walked through, one over it is shown and not, and the warning names it', async () => {
    const { result, calls } = await counted(() => exploreNetwork(client, 'solo topic', 2, { maxFanout: 100 }));
    const names: string[] = result.nodes.map((n: { name: string }) => n.name);
    // `rollup 29` links 28 topics and `rollup 30` links 29: both are walked through
    expect(names).toEqual(expect.arrayContaining(topics(1, 29)));
    // `rollup topic 30` is linked by `rollup 31` alone, which links 31 pages and is a leaf
    expect(names).not.toContain('rollup topic 30');
    expect(names).toHaveLength(45);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: 'hub_pages_not_expanded' });
    expect(result.warnings[0].message).toContain('rollup 31 (31 pages)');
    // the network already holds 44 other pages and the roll-up links 31: the server does not promise a page more
    expect(result.warnings[0].howToFetchAll).toBeUndefined();
    expect(result.hasMore).toBe(false);
    // the resolver, then one query per depth: the degrees ride in the same queries
    expect(calls).toBe(3);
  });

  it('a journal that links more than 30 pages is a leaf and no roll-up: no degree row, no warning', async () => {
    // `jun 17th, 2024` links the hub and 30 topics (31 pages). It is a journal, so the degree branches leave it out
    const result = await exploreNetwork(client, 'journal-topic-01', 2);
    expect(result.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['Jun 17th, 2024', 'journal-topic-01']);
    expect(result.warnings).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('expand_journals walks through the roll-up too', async () => {
    const result = await exploreNetwork(client, 'solo topic', 2, { maxFanout: 100, expandJournals: true });
    const names: string[] = result.nodes.map((n: { name: string }) => n.name);
    expect(names).toContain('rollup topic 30');
    expect(names).toHaveLength(46);
    expect(result.warnings).toEqual([]);
  });

  it('a roll-up that brings pages is offered, and walking through it does bring them', async () => {
    // hub central links 70 pages and is linked by `neighbour-out-01`; its own neighbours are reached only through it
    const leaf = await exploreNetwork(client, 'neighbour-out-01', 2);
    const leafNames: string[] = leaf.nodes.map((n: { name: string }) => n.name);
    expect(leafNames).toContain('hub central');
    expect(leafNames.some(name => name.startsWith('neighbour-in-'))).toBe(false);
    expect(leaf.nodes.find((n: { name: string }) => n.name === 'hub central').depth).toBe(1);
    expect(leaf.warnings.map((w: { code: string }) => w.code)).toEqual(['hub_pages_not_expanded']);
    expect(leaf.warnings[0].message).toContain('hub central (70 pages)');
    expect(leaf.warnings[0].howToFetchAll).toContain('expand_journals');
    expect(leaf.warnings[0].howToFetchAll).toMatch(/adds at least \d+ pages/);
    expect(leaf.hasMore).toBe(true);

    const walked = await exploreNetwork(client, 'neighbour-out-01', 2, { expandJournals: true });
    const walkedNames: string[] = walked.nodes.map((n: { name: string }) => n.name);
    expect(walkedNames.some(name => name.startsWith('neighbour-in-'))).toBe(true);
    expect(walked.nodes.length).toBeGreaterThan(leaf.nodes.length);
    expect(walked.warnings.map((w: { code: string }) => w.code)).not.toContain('hub_pages_not_expanded');
  });

  it('with_snippets puts the first line of a linking block on each edge of the root, in the same calls', async () => {
    const plain = await counted(() => exploreNetwork(client, 'solo topic', 2, { maxFanout: 100 }));
    const { result, calls } = await counted(() => exploreNetwork(client, 'solo topic', 2, { maxFanout: 100, withSnippets: true }));
    expect(calls).toBe(plain.calls);
    expect(plain.result.edges.every((edge: object) => !('snippet' in edge))).toBe(true);

    const root = result.nodes.find((n: { depth: number }) => n.depth === 0).id;
    const byName = (name: string) => result.nodes.find((n: { name: string }) => n.name === name).id;
    const edgeTo = (name: string) => result.edges.find((e: { from: number; to: number }) => e.from === root && e.to === byName(name));
    // a roll-up's two blocks that link `solo topic` are the same length, so the greater text breaks the tie
    expect(edgeTo('rollup 29').snippet).toBe('Row B on [[solo topic]]');
    expect(edgeTo('rollup 31').snippet).toBe('Row B on [[solo topic]]');
    // the root's own block that links a topical page is a long list of links: cut to 80 characters
    const list = edgeTo('solo link 01').snippet as string;
    expect(list.startsWith('Rows [[solo link 01]] [[solo link 02]]')).toBe(true);
    expect(list.length).toBeLessThanOrEqual(80);
    expect(list.endsWith('...')).toBe(true);
    // only the edges of the root have one: an edge between a roll-up and its topics does not
    const deeper = result.edges.filter((e: { from: number }) => e.from !== root);
    expect(deeper.length).toBeGreaterThan(0);
    expect(deeper.every((edge: object) => !('snippet' in edge))).toBe(true);
    // the nodes, and the number of edges, are the plain call's
    expect(result.nodes).toEqual(plain.result.nodes);
    expect(result.edges.length).toBe(plain.result.edges.length);
  });

  it('with_snippets and the roll-up rule also run through the grouped query of a page with an alias', async () => {
    // `project atlas` declares `alias:: atlas`, so depth 1 expands both names in one query
    const plain = await counted(() => exploreNetwork(client, 'project atlas', 1));
    const { result, calls } = await counted(() => exploreNetwork(client, 'project atlas', 1, { withSnippets: true }));
    expect(calls).toBe(plain.calls);
    expect(result.nodes).toEqual(plain.result.nodes);
    expect(result.resolvedAliases).toEqual(plain.result.resolvedAliases);
    const root = result.nodes.find((n: { depth: number }) => n.depth === 0).id;
    const ofRoot = result.edges.filter((e: { from: number }) => e.from === root);
    expect(ofRoot.length).toBeGreaterThan(0);
    // every page that links the root or is linked by it has a block with text
    expect(ofRoot.every((e: { snippet?: string }) => typeof e.snippet === 'string' && e.snippet.length > 0 && e.snippet.length <= 80)).toBe(true);
    expect(result.warnings).toEqual(plain.result.warnings);
  });
});
