import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_RELATIONSHIP_LIMIT,
  MAX_RELATIONSHIP_LIMIT,
  RelationshipType,
  searchByRelationship
} from './search-by-relationship.js';
import { LogseqClient } from '../client.js';
import { MAX_ALIAS_SET_SIZE } from '../utils/alias-set.js';

/**
 * The cap on logseq_search_by_relationship (#61): `limit`, default 50, at most 500, on
 * `results` for every relationship type. The result is an object, so the cut is reported
 * in its own `warnings`, `hasMore` and `totals`. All data is made up.
 *
 * The fake answers the resolver, the alias-group query and the `connected-within` hop,
 * and treats any other Datalog query as the data query, which returns `n` blocks with
 * ascending ids. "Alice" (9) and "Bob" (10) have no aliases; "Jordan" (1) does.
 */

const file = { id: 900 };
const alice = { id: 9, name: 'alice', 'original-name': 'Alice', file };
const bob = { id: 10, name: 'bob', 'original-name': 'Bob', file };
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', file, alias: [{ id: 2 }] };
const PAGES: Record<string, any> = { alice, bob, jordan };

const member = (id: number, name: string) => ({ id, name: name.toLowerCase(), 'original-name': name });

interface FakeOptions {
  /** Blocks the data query returns, ids 1..n in this order */
  n?: number;
  /** Top-level blocks of topic A's page tree and of topic B's, for connected-within */
  treeA?: number;
  treeB?: number;
  /** Pages in Jordan's alias group besides Jordan itself */
  aliasStubs?: number;
}

function fakeClient({ n = 0, treeA = 0, treeB = 0, aliasStubs = 1 }: FakeOptions = {}) {
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    if (query.includes(':in $ ?n')) return [[PAGES[inputs[0] as string], 'name']];
    if (query.includes('?start')) {
      return [
        [1, member(1, 'Jordan')],
        ...Array.from({ length: aliasStubs }, (_, i) => [1, member(100 + i, `Jordan stub ${String(i).padStart(2, '0')}`)])
      ];
    }
    if (query.includes('?p ...')) return [[10]];
    return Array.from({ length: n }, (_, i) => [{ id: i + 1, content: `Block ${i + 1}` }]);
  });
  const callAPI = vi.fn(async (method: string, args: unknown[]) => {
    if (method !== 'logseq.Editor.getPageBlocksTree') return [];
    const side = String(args[0]).toLowerCase() === 'bob' ? 'B' : 'A';
    const count = side === 'A' ? treeA : treeB;
    return Array.from({ length: count }, (_, i) => ({ id: (side === 'A' ? 1000 : 2000) + i, content: `${side} ${i + 1}` }));
  });
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

type Path = 'plain' | 'aliased';

/** One row per relationship type. `topicA` is Jordan on the alias path, which takes the alias-group query (#69). */
const CASES: Array<{ type: RelationshipType; make: (n: number) => FakeOptions; what: RegExp }> = [
  { type: 'references', make: n => ({ n }), what: /matching blocks \(the first ones listed, not ranked\)/ },
  { type: 'referenced-by', make: n => ({ n }), what: /matching blocks \(the first ones listed, not ranked\)/ },
  { type: 'in-pages-linking-to', make: n => ({ n }), what: /matching blocks \(the first ones listed, not ranked\)/ },
  // n top-level blocks in all: topic A's page first
  { type: 'connected-within', make: n => ({ treeA: Math.ceil(n / 2), treeB: Math.floor(n / 2) }), what: /top-level blocks of the two pages/ }
];

const run = (
  type: RelationshipType,
  path: Path,
  options: FakeOptions,
  limit?: number
) => {
  const fake = fakeClient({ ...options, aliasStubs: options.aliasStubs ?? 1 });
  const promise = searchByRelationship(
    fake.client,
    path === 'aliased' ? 'Jordan' : 'Alice',
    'Bob',
    type,
    2,
    limit === undefined ? {} : { limit }
  );
  return promise.then(result => ({ result, ...fake }));
};

const ids = (result: { results: Array<{ id: number }> }) => result.results.map(block => block.id);

describe.each(['plain', 'aliased'] as const)('searchByRelationship caps, %s path', path => {
  it('uses a default of 50 and a maximum of 500', () => {
    expect(DEFAULT_RELATIONSHIP_LIMIT).toBe(50);
    expect(MAX_RELATIONSHIP_LIMIT).toBe(500);
  });

  describe.each(CASES)('$type', ({ type, make, what }) => {
    it('takes the alias-group query only on the aliased path', async () => {
      const { executeDatalogQuery } = await run(type, path, make(3));

      expect(executeDatalogQuery.mock.calls.some(([q]) => (q as string).includes('?start'))).toBe(path === 'aliased');
    });

    describe('below the cap', () => {
      it('returns every result with no cap warning and no totals, the default included', async () => {
        const { result } = await run(type, path, make(49));

        expect(result.results).toHaveLength(49);
        expect(result.warnings.filter(w => w.code === 'results_truncated')).toEqual([]);
        expect(result.totals).toBeUndefined();
        expect(result.hasMore).toBe(false);
      });

      it('returns an explicit limit above the count whole', async () => {
        const { result } = await run(type, path, make(7), 300);

        expect(result.results).toHaveLength(7);
        expect(result.warnings.filter(w => w.code === 'results_truncated')).toEqual([]);
        expect(result.totals).toBeUndefined();
      });
    });

    describe('at the cap', () => {
      it('returns exactly 50 results with no cap warning at the default', async () => {
        const { result } = await run(type, path, make(50));

        expect(result.results).toHaveLength(50);
        expect(result.warnings.filter(w => w.code === 'results_truncated')).toEqual([]);
        expect(result.totals).toBeUndefined();
        expect(result.hasMore).toBe(false);
      });

      it('returns exactly 500 results with no cap warning at the maximum', async () => {
        const { result } = await run(type, path, make(500), 500);

        expect(result.results).toHaveLength(500);
        expect(result.warnings.filter(w => w.code === 'results_truncated')).toEqual([]);
        expect(result.totals).toBeUndefined();
      });
    });

    describe('above the cap', () => {
      it('cuts to 50 by default and says how to get all of them', async () => {
        const { result } = await run(type, path, make(130));

        expect(result.results).toHaveLength(50);
        expect(result.hasMore).toBe(true);
        expect(result.totals).toEqual({ blocks: 130 });
        const [warning] = result.warnings.filter(w => w.code === 'results_truncated');
        expect(warning.message).toMatch(/^Showing 50 of 130 /);
        expect(warning.message).toMatch(what);
        expect(warning.howToFetchAll).toBe('Set limit to 130 (or higher) to get all 130.');
      });

      it('cuts to the limit asked for', async () => {
        const { result } = await run(type, path, make(12), 5);

        expect(result.results).toHaveLength(5);
        expect(result.totals).toEqual({ blocks: 12 });
        expect(result.warnings.at(-1)?.howToFetchAll).toBe('Set limit to 12 (or higher) to get all 12.');
      });

      it('keeps the first results in the order they came', async () => {
        const full = await run(type, path, make(12), 500);
        const { result } = await run(type, path, make(12), 4);

        expect(ids(result)).toEqual(ids(full.result).slice(0, 4));
      });

      it('offers the maximum, and nothing above it, when the results pass 500', async () => {
        const { result } = await run(type, path, make(700), 200);

        expect(result.results).toHaveLength(200);
        expect(result.hasMore).toBe(true);
        expect(result.totals).toEqual({ blocks: 700 });
        const [warning] = result.warnings.filter(w => w.code === 'results_truncated');
        expect(warning.howToFetchAll).toBe(
          'Set limit to 500 (the maximum) to get 500 of 700. No other parameter narrows this query.'
        );
        expect(warning.howToFetchAll).not.toContain('to 700');
      });
    });

    describe('at the maximum', () => {
      it('says the maximum was reached, with no howToFetchAll and hasMore false', async () => {
        const { result } = await run(type, path, make(600), 500);

        expect(result.results).toHaveLength(500);
        expect(result.hasMore).toBe(false);
        expect(result.totals).toEqual({ blocks: 600 });
        const [warning] = result.warnings.filter(w => w.code === 'results_truncated');
        expect(warning.message).toMatch(/^Showing 500 of 600 /);
        expect(warning.message).toContain("limit is capped at its maximum of 500, so the rest can't be fetched in one call.");
        expect(warning.message).toContain('No other parameter narrows this query.');
        expect(warning).not.toHaveProperty('howToFetchAll');
      });

      it('clamps a limit above 500 and says what was asked for', async () => {
        const { result } = await run(type, path, make(501), 5000);

        expect(result.results).toHaveLength(500);
        expect(result.hasMore).toBe(false);
        const [warning] = result.warnings.filter(w => w.code === 'results_truncated');
        expect(warning.message).toContain('capped at its maximum of 500 (5000 was asked for)');
        expect(warning).not.toHaveProperty('howToFetchAll');
      });

      it('returns 500 results and no cap warning when exactly 500 exist and a larger limit is asked for', async () => {
        const { result } = await run(type, path, make(500), 5000);

        expect(result.results).toHaveLength(500);
        expect(result.warnings.filter(w => w.code === 'results_truncated')).toEqual([]);
        expect(result.totals).toBeUndefined();
      });
    });

    describe('odd limits', () => {
      it('returns no results for a limit of 0 or below, and says so', async () => {
        for (const limit of [0, -4]) {
          const { result } = await run(type, path, make(4), limit);

          expect(result.results).toEqual([]);
          expect(result.totals).toEqual({ blocks: 4 });
          const [warning] = result.warnings.filter(w => w.code === 'results_truncated');
          expect(warning.message).toMatch(/^Showing 0 of 4 /);
          expect(warning.howToFetchAll).toBe('Set limit to 4 (or higher) to get all 4.');
        }
      });

      it('floors a fractional limit', async () => {
        const { result } = await run(type, path, make(10), 2.9);

        expect(result.results).toHaveLength(2);
      });
    });

    describe('cost', () => {
      it('makes the same API calls cut or not', async () => {
        const whole = await run(type, path, make(120), 500);
        const cut = await run(type, path, make(120), 5);

        expect(cut.executeDatalogQuery).toHaveBeenCalledTimes(whole.executeDatalogQuery.mock.calls.length);
        expect(cut.callAPI).toHaveBeenCalledTimes(whole.callAPI.mock.calls.length);
      });
    });
  });
});

describe('searchByRelationship caps, what each type counts', () => {
  it('connected-within counts top-level blocks and leaves a kept block its children', async () => {
    const { client, callAPI } = fakeClient();
    callAPI.mockImplementation(async (_method: string, args: unknown[]) =>
      String(args[0]).toLowerCase() === 'bob'
        ? [{ id: 2000, content: 'B 1', children: [{ id: 2001 }] }]
        : [
            { id: 1000, content: 'A 1', children: [{ id: 1001 }, { id: 1002 }, { id: 1003 }] },
            { id: 1004, content: 'A 2' },
            { id: 1005, content: 'A 3' }
          ]
    );

    const result = await searchByRelationship(client, 'Alice', 'Bob', 'connected-within', 2, { limit: 1 });

    expect(result.results).toHaveLength(1);
    expect((result.results[0] as { children?: unknown[] }).children).toHaveLength(3);
    expect(result.totals).toEqual({ blocks: 4 });
    const warning = result.warnings.find(w => w.code === 'results_truncated')!;
    expect(warning.message).toBe(
      "Showing 1 of 4 top-level blocks of the two pages (kept 1 from topic A and 0 from topic B, of 3 and 1; topic A's first, then topic B's; a kept block keeps all its children, which are not counted)."
    );
  });

  it('connected-within says how many kept blocks came from each topic, including when topic B drops out', async () => {
    const fromEach = async (limit: number) => {
      const { result } = await run('connected-within', 'plain', { treeA: 8, treeB: 5 }, limit);
      return result.warnings.find(w => w.code === 'results_truncated')!.message;
    };

    // Below A's count: only A's blocks, B is gone
    expect(await fromEach(5)).toContain('kept 5 from topic A and 0 from topic B, of 8 and 5');
    // Exactly A's count: still no B
    expect(await fromEach(8)).toContain('kept 8 from topic A and 0 from topic B, of 8 and 5');
    // Past A's count: B is trimmed, not gone
    expect(await fromEach(10)).toContain('kept 8 from topic A and 2 from topic B, of 8 and 5');
    const { result } = await run('connected-within', 'plain', { treeA: 8, treeB: 5 }, 5);
    expect(result.results.every(block => block.id < 2000)).toBe(true);
  });

  it('the Datalog types give no per-topic counts, and connected-within gives none when nothing was cut', async () => {
    const references = await run('references', 'plain', { n: 80 });
    expect(references.result.warnings[0].message).not.toContain('from topic A');

    const whole = await run('connected-within', 'plain', { treeA: 8, treeB: 5 }, 13);
    expect(whole.result.warnings).toEqual([]);
  });

  it('connected-within caps nothing when the pages are not connected', async () => {
    const fake = fakeClient({ treeA: 9, treeB: 9 });
    fake.executeDatalogQuery.mockImplementation(async (query: string, ...inputs: unknown[]) => {
      if (query.includes(':in $ ?n')) return [[PAGES[inputs[0] as string], 'name']];
      return []; // the hop finds no neighbour
    });

    const result = await searchByRelationship(fake.client, 'Alice', 'Bob', 'connected-within', 2, { limit: 1 });

    expect(result.results).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.totals).toBeUndefined();
  });

  it('an empty answer carries no cap warning for any type', async () => {
    for (const { type } of CASES) {
      const { result } = await run(type, 'plain', { n: 0 }, 0);

      expect(result.results).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });
});

describe('searchByRelationship caps, merged with the other meta', () => {
  it('adds the cap warning after the alias warning and keeps resolvedAliases', async () => {
    // Jordan's group is one page over the limit, so its alias_set_truncated warning fires too
    const { result } = await run('references', 'aliased', { n: 80, aliasStubs: MAX_ALIAS_SET_SIZE + 1 });

    expect(result.warnings.map(w => w.code)).toEqual(['alias_set_truncated', 'results_truncated']);
    expect(result.results).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(result.resolvedAliases?.topicA).toHaveLength(MAX_ALIAS_SET_SIZE);
    expect(result.warnings[0]).not.toHaveProperty('howToFetchAll');
  });

  it('hasMore is false at the maximum even next to another warning', async () => {
    const { result } = await run('in-pages-linking-to', 'aliased', { n: 600, aliasStubs: MAX_ALIAS_SET_SIZE + 1 }, 500);

    expect(result.warnings.map(w => w.code)).toEqual(['alias_set_truncated', 'results_truncated']);
    expect(result.hasMore).toBe(false);
  });

  it('the shape below the cap is the shape before the cap existed', async () => {
    const { result } = await run('references', 'plain', { n: 3 });

    expect(Object.keys(result).sort()).toEqual(
      ['hasMore', 'query', 'relationshipType', 'results', 'warnings'].sort()
    );
    expect(result.warnings).toEqual([]);
  });
});
