import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { exploreNetwork, exploreNetworkNext } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';
import { InvalidParameterError } from './helpers/errors.js';
import type { Json } from './helpers/types.js';

/**
 * The cursor of explore_network (ADR-0038, #556) against the fixture graph: the walk runs to 500 pages and `max_nodes` is the
 * size of a page, so every page size reads the same walk, and a walk several times the budget is read to the end with every
 * page and every edge once. The hub (`hub central`, tests/fixtures/README.md) has 120 neighbours, 40 fringe pages behind them and
 * one journal. Read-only.
 */

const BUDGET_CHARS = 30_000;

/** The pages of a walk, read with the cursor of each until one has none. */
async function readToTheEnd(client: LogseqClient, page: string, maxDepth: number, options: Parameters<typeof exploreNetwork>[3]): Promise<Json[]> {
  const pages = [await exploreNetwork(client, page, maxDepth, options)];
  while (pages[pages.length - 1].nextCursor) {
    expect(pages.length).toBeLessThan(100);
    pages.push(await exploreNetworkNext(client, pages[pages.length - 1].nextCursor));
  }
  return pages;
}

const nodeKey = (node: Json): string => `${node.name}@${node.depth}`;
const edgeKey = (names: Map<number, string>, edge: Json): string => `${names.get(edge.from)}>${names.get(edge.to)}:${edge.outbound}/${edge.inbound}`;

describe('explore_network: the cursor reads the walk to the end', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  it('every page size reads the same walk: the same pages in the same order with the same depths, and every edge once', async () => {
    // depth 2 from the hub at the caps a client can ask for: 101 neighbours and the 40 fringe pages they reach
    const whole = await readToTheEnd(client, 'hub central', 2, { maxNodes: 500, maxFanout: 100 });
    const names = new Map<number, string>(whole.flatMap(page => page.nodes).map((node: Json) => [node.id, node.name]));
    const wholeNodes = whole.flatMap(page => page.nodes).map(nodeKey);
    const wholeEdges = whole.flatMap(page => page.edges).map(edge => edgeKey(names, edge)).sort();
    expect(wholeNodes).toHaveLength(141);
    expect(new Set(wholeNodes).size).toBe(141);
    expect(new Set(wholeEdges).size).toBe(wholeEdges.length);

    for (const maxNodes of [7, 50, 141]) {
      const pages = await readToTheEnd(client, 'hub central', 2, { maxNodes, maxFanout: 100 });
      expect(pages.flatMap(page => page.nodes).map(nodeKey), `max_nodes ${maxNodes}`).toEqual(wholeNodes);
      expect(pages.flatMap(page => page.edges).map(edge => edgeKey(names, edge)).sort(), `max_nodes ${maxNodes}`).toEqual(wholeEdges);
      expect(pages.every(page => page.nodes.length <= maxNodes)).toBe(true);
      // the walk's own rule, in every page
      expect(pages.every(page => page.truncated === true)).toBe(true);
    }
  });

  it('a page is cut to the budget and its cursor reads on, with the last page free of one', async () => {
    const pages = await readToTheEnd(client, 'hub central', 2, { maxNodes: 500, maxFanout: 100 });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages.slice(0, -1)) {
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(BUDGET_CHARS);
      expect(page).toMatchObject({ hasMore: true });
      expect(page.warnings.map((w: Json) => w.code)).toContain('result_size_truncated');
      const cut = page.warnings.find((w: Json) => w.code === 'result_size_truncated');
      expect(cut.howToFetchAll).toMatch(/^Pass nextCursor as cursor, with no other argument, to read the next page\./);
    }
    const last = pages[pages.length - 1];
    expect(last).toMatchObject({ hasMore: false });
    expect(last.nextCursor).toBeUndefined();
    // the depth labels never change between pages: the root first, then depth 1, then depth 2
    const depths = pages.flatMap(page => page.nodes).map((node: Json) => node.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });

  it('an edge between pages that are on different pages arrives with the later one', async () => {
    const pages = await readToTheEnd(client, 'hub central', 2, { maxNodes: 20, maxFanout: 100 });
    const seen = new Set<number>();
    for (const page of pages) {
      for (const node of page.nodes) seen.add(node.id);
      // every edge of a page ends on pages already sent or on the page itself
      for (const edge of page.edges) {
        expect(seen.has(edge.from) && seen.has(edge.to)).toBe(true);
      }
      // and at least one end is on the page
      const onPage = new Set(page.nodes.map((node: Json) => node.id));
      for (const edge of page.edges) expect(onPage.has(edge.from) || onPage.has(edge.to)).toBe(true);
    }
  });

  it('a hub reached by expand_journals is read to the end, and truncated stays true while a rule left pages out', async () => {
    // the journal links 30 topics and `hub central`; the fanout of 15 leaves some out
    const pages = await readToTheEnd(client, 'journal-topic-01', 2, { expandJournals: true, maxNodes: 5 });
    expect(pages.flatMap(page => page.nodes)).toHaveLength(17);
    expect(pages.every(page => page.truncated === true)).toBe(true);
    expect(pages[pages.length - 1].nextCursor).toBeUndefined();
    expect(pages.slice(0, -1).every(page => page.hasMore === true)).toBe(true);
  });

  it('a walk exactly at the page size has no cursor, and one page more has one', async () => {
    const fit = await exploreNetwork(client, 'journal-topic-01', 2, { expandJournals: true, maxFanout: 100, maxNodes: 32 });
    expect(fit.nodes).toHaveLength(32);
    expect(fit.nextCursor).toBeUndefined();
    expect(fit.hasMore).toBe(false);
    const over = await exploreNetwork(client, 'journal-topic-01', 2, { expandJournals: true, maxFanout: 100, maxNodes: 31 });
    expect(over.nodes).toHaveLength(31);
    expect(typeof over.nextCursor).toBe('string');
    expect(over.hasMore).toBe(true);
  });

  it('refuses a cursor beside any other argument, a token that is not one, and neither a page nor a cursor, as an invalid parameter', async () => {
    const first = await exploreNetwork(client, 'hub central', 2);
    const cursor = first.nextCursor as string;
    await expect(exploreNetworkNext(client, cursor, { page: 'hub central' })).rejects.toThrow(InvalidParameterError);
    await expect(exploreNetworkNext(client, cursor, { max_nodes: 10 })).rejects.toThrow(InvalidParameterError);
    await expect(exploreNetworkNext(client, cursor, { to: 'bob' })).rejects.toThrow(InvalidParameterError);
    await expect(exploreNetworkNext(client, 'not a cursor')).rejects.toThrow(InvalidParameterError);
    await expect(exploreNetwork(client, undefined as unknown as string, 1)).rejects.toThrow(InvalidParameterError);
  });
});
