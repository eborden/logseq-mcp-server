import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { exploreNetwork } from './helpers/tools.js';
import { connectFixture } from './helpers/fixture-client.js';
import { PAGE1_CASES, projectPage1, type Page1 } from './helpers/network-page1.js';

/**
 * The first page of explore_network equals what the capped walk returned before the cursor (#556, ADR-0038): the same nodes in
 * the same order with the same depths, and the same edges between them. Recorded from the walk as it was, on the hub fixture
 * (`helpers/network-page1.ts` says what is kept). Read-only.
 */

const here = dirname(fileURLToPath(import.meta.url));
const recorded: Record<string, Page1> = JSON.parse(readFileSync(join(here, 'data', 'explore-network-page1.json'), 'utf8'));

describe('explore_network: the first page is the result the capped walk gave', () => {
  let client: LogseqClient;

  beforeAll(async () => {
    ({ client } = await connectFixture());
  });

  it('records every case', () => {
    expect(Object.keys(recorded).sort()).toEqual(PAGE1_CASES.map(c => c.name).sort());
  });

  for (const { name, page, maxDepth, sizeCut, ...caps } of PAGE1_CASES) {
    it(`${name}: the same nodes, depths and edges`, async () => {
      const got = projectPage1(await exploreNetwork(client, page, maxDepth, caps));
      const want = recorded[name];
      if (!sizeCut) {
        expect(got.nodes).toEqual(want.nodes);
        expect(got.edges).toEqual(want.edges);
        return;
      }
      // Cut to the budget: a prefix of the old pages, at most a few fewer, with the edges among the pages it holds
      expect(got.nodes).toEqual(want.nodes.slice(0, got.nodes.length));
      expect(want.nodes.length - got.nodes.length).toBeLessThanOrEqual(3);
      const kept = new Set(got.nodes.map(([node]) => node));
      expect(got.edges).toEqual(want.edges.filter(([from, to]) => kept.has(from) && kept.has(to)));
    });
  }
});
