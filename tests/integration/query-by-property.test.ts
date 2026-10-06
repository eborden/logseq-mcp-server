import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { queryByProperty } from '../../src/tools/query-by-property.js';
import { InvalidParameterError } from '../../src/errors.js';
import { buildPageNameMap, toSlimBlock } from '../../src/utils/slim-entities.js';
import { BlockEntity, PageEntity } from '../../src/types.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * query_by_property: Datalog implementation vs the Editor API crawl it replaced.
 *
 * The crawl (getAllPages, then getPageBlocksTree per page, then a walk over
 * every block) lives here as the oracle, against the fixture graph. The cases
 * are the fixture's `property types` page and project pages, one per value
 * shape (tests/fixtures/README.md, "Properties"), each with the exact number of
 * blocks it matches. The crawl is ~260 calls on the fixture.
 */

class CountingClient extends LogseqClient {
  methods: string[] = [];
  async callAPI<T = any>(method: string, args: any[] = []): Promise<T> {
    this.methods.push(method);
    return super.callAPI<T>(method, args);
  }
}

/** The previous implementation's match rule. */
function oldRule(block: BlockEntity, key: string, value: string): boolean {
  return !!block.properties && key in block.properties && String(block.properties[key]) === value;
}

/**
 * The new rule: scalars match as before; a multi-value property matches on any
 * element. (The old rule also matched a multi-element set's comma-joined
 * string, which no longer matches.)
 */
function newRule(block: BlockEntity, key: string, value: string): boolean {
  const v = block.properties?.[key];
  if (Array.isArray(v)) return v.some(element => String(element) === value);
  return oldRule(block, key, value);
}

/** Property values are sets, so element order may differ between APIs. */
function normalizeProps(props: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    out[k] = Array.isArray(v) ? [...v].sort() : v;
  }
  return out;
}

const uuids = (blocks: Array<{ uuid: string }>) => blocks.map(b => b.uuid).sort();

interface Case {
  label: string;
  key: string;
  value: string;
  /** Blocks the query returns */
  count: number;
}

/** One case per value shape, with the number of blocks each matches in the fixture */
const CASES: Case[] = [
  { label: 'string', key: 'status', value: 'testing', count: 1 },
  { label: 'number', key: 'effort', value: '3', count: 1 },
  { label: 'decimal (stored as text)', key: 'ratio', value: '0.75', count: 1 },
  { label: 'boolean', key: 'reviewed', value: 'true', count: 1 },
  { label: 'boolean false', key: 'archived', value: 'false', count: 1 },
  // project atlas's page properties and a block on property types
  { label: 'one-element set', key: 'owner', value: 'Alice', count: 2 },
  { label: 'multi-element set, one element', key: 'participants', value: 'Bob', count: 1 },
  { label: 'comma-separated set (config.edn)', key: 'reviewers', value: 'Carol', count: 1 },
  { label: 'page property on three pages', key: 'type', value: 'project', count: 3 },
  { label: 'tag value', key: 'topic', value: 'planning', count: 1 },
];

describe('query_by_property: Datalog vs Editor API crawl', () => {
  let client: CountingClient;
  let pages: PageEntity[];
  let crawled: BlockEntity[]; // every block in the graph, flattened, with children intact
  let withProps: BlockEntity[];
  let cases: Case[];

  beforeAll(async () => {
    const { config } = await connectFixture();
    client = new CountingClient(config);

    pages = (await client.callAPI<PageEntity[] | null>('logseq.Editor.getAllPages')) ?? [];
    crawled = [];
    const walk = (blocks: BlockEntity[]) => {
      for (const block of blocks) {
        crawled.push(block);
        if (block.children?.length) walk(block.children);
      }
    };
    for (const page of pages) {
      const tree = await client.callAPI<BlockEntity[] | null>('logseq.Editor.getPageBlocksTree', [page.name]);
      if (tree) walk(tree);
    }
    withProps = crawled.filter(b => b.properties && Object.keys(b.properties).length > 0);

    cases = CASES;
  }, 180_000);

  it('finds each case in exactly the expected number of blocks', async () => {
    for (const { label, key, value, count } of cases) {
      expect(await queryByProperty(client, key, value), label).toHaveLength(count);
    }
  });

  it('matches set elements with their original casing only', async () => {
    expect(await queryByProperty(client, 'owner', 'alice')).toEqual([]);
    expect(await queryByProperty(client, 'participants', 'bob')).toEqual([]);
  });

  it('keeps a value with commas whole when config.edn does not split its key', async () => {
    const result = await queryByProperty(client, 'summary', 'ships after review, then Alice and Bob sign off');
    expect(result).toHaveLength(1);
  });

  it('matches exactly the blocks the crawl finds, plus any-element matches on multi-value properties', async () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const { label, key, value } of cases) {
      const result = (await queryByProperty(client, key, value)) as BlockEntity[];

      const expected = withProps.filter(b => newRule(b, key, value));
      expect(expected.length, `${label}: the crawl found nothing to compare`).toBeGreaterThan(0);
      expect(uuids(result), label).toEqual(uuids(expected));

      // Nothing the old implementation returned is lost (these values are not comma-joined sets)
      const old = withProps.filter(b => oldRule(b, key, value));
      expect(uuids(result), label).toEqual(expect.arrayContaining(uuids(old)));
    }
  });

  it('no longer matches the comma-joined form of a multi-element set (documented change)', async () => {
    const queryable = /^[a-z0-9][a-z0-9_-]*$/i;
    const found = withProps
      .flatMap(b => Object.entries<any>(b.properties!).map(([key, v]) => ({ b, key, v })))
      .find(({ key, v }) => queryable.test(key) && key === 'participants' && Array.isArray(v) && v.length > 1);
    expect(found, 'property types lost its participants:: [[Alice]], [[Bob]] block').toBeDefined();
    const joined = found!.v.join(',');

    const result = (await queryByProperty(client, found!.key, joined)) as BlockEntity[];

    expect(withProps.filter(b => oldRule(b, found!.key, joined)).length).toBeGreaterThan(0); // the old rule matched
    expect(uuids(result)).toEqual(uuids(withProps.filter(b => newRule(b, found!.key, joined))));
    expect(result.map(b => b.uuid)).not.toContain(found!.b.uuid);
  });

  it('an any-element match exists where the old rule would have missed it', async () => {
    const multi = cases.find(c => c.label === 'multi-element set, one element');
    const { key, value } = multi!;

    const result = (await queryByProperty(client, key, value)) as BlockEntity[];
    const oldMatches = withProps.filter(b => oldRule(b, key, value));

    expect(result.length).toBeGreaterThan(oldMatches.length);
  });

  it('returns blocks in the Editor API shape, minus children and level', async () => {
    for (const { label, key, value } of cases) {
      const result = (await queryByProperty(client, key, value)) as BlockEntity[];
      const byUuid = new Map(crawled.map(b => [b.uuid, b]));

      for (const block of result.slice(0, 25)) {
        const old = byUuid.get(block.uuid)!;
        expect(old, `${label}: block missing from crawl`).toBeDefined();

        // Same keys, except the tree-only ones the Datalog result doesn't have
        const missing = Object.keys(old).filter(k => !(k in block));
        expect(missing.sort(), label).toEqual(
          Object.keys(old).filter(k => k === 'children' || k === 'level').sort()
        );
        expect(Object.keys(block).filter(k => !(k in old)), label).toEqual([]);

        expect(block.content).toBe(old.content);
        expect(block.id).toBe(old.id);
        expect(block.format).toBe(old.format);
        expect(block.marker).toBe(old.marker);
        expect(block.parent).toEqual(old.parent);
        expect(block.left).toEqual(old.left);
        expect(normalizeProps(block.properties)).toEqual(normalizeProps(old.properties));
        expect(block.propertiesOrder).toEqual(old.propertiesOrder);
        expect(block.page?.id).toBe(old.page?.id);
        expect(block).not.toHaveProperty('children');
      }
    }
  });

  it('includes the page name and original name', async () => {
    const { key, value } = cases[0];
    const nameById = buildPageNameMap(pages);
    const result = (await queryByProperty(client, key, value)) as any[];

    for (const block of result.slice(0, 25)) {
      expect(block.page.originalName).toBe(nameById.get(block.page.id));
      expect(typeof block.page.name).toBe('string');
    }
  });

  it('slim results match the slim form of the crawled blocks (without children)', async () => {
    const nameById = buildPageNameMap(pages);
    const byUuid = new Map(crawled.map(b => [b.uuid, b]));

    for (const { label, key, value } of cases) {
      const slim = (await queryByProperty(client, key, value, true)) as any[];
      expect(slim.length, label).toBeGreaterThan(0);

      for (const block of slim.slice(0, 25)) {
        const old = byUuid.get(block.uuid)!;
        const expected: any = toSlimBlock({ ...old, children: [] }, nameById.get(old.page?.id!) ?? '');
        expect(block.pageName, label).toBe(expected.pageName);
        expect(block.content, label).toBe(expected.content);
        expect(block.marker, label).toBe(expected.marker);
        expect(block.tags, label).toEqual(expected.tags);
        expect(block.pageRefs, label).toEqual(expected.pageRefs);
        expect(normalizeProps(block.properties), label).toEqual(normalizeProps(expected.properties));
        expect(block).not.toHaveProperty('id');
        expect(block).not.toHaveProperty('page');
        expect(block).not.toHaveProperty('children');
      }
    }
  });

  it('accepts the stored dashed key and the camelCase key the Editor API returns', async () => {
    // `created-by:: Bob` on a block, and `created-by:: Alice` in the page properties
    const crawledKeys = new Set(withProps.flatMap(b => Object.keys(b.properties!)));
    expect(crawledKeys.has('createdBy'), 'the Editor API camelCases created-by').toBe(true);

    for (const value of ['Bob', 'Alice']) {
      const a = (await queryByProperty(client, 'createdBy', value)) as BlockEntity[];
      const b = (await queryByProperty(client, 'created-by', value)) as BlockEntity[];

      expect(a, value).toHaveLength(1);
      expect(uuids(b), value).toEqual(uuids(a));
    }
  });

  it('returns an empty array, not null, for a property that does not exist', async () => {
    expect(await queryByProperty(client, 'nonexistentproperty12345', 'neverexists')).toEqual([]);
    expect(await queryByProperty(client, 'nonexistentproperty12345', 'neverexists', true)).toEqual([]);
  });

  it('returns an empty array for a value no block has', async () => {
    const { key } = cases[0];
    expect(await queryByProperty(client, key, 'no-block-has-this-value-12345')).toEqual([]);
  });

  it('rejects a property name that is not letters, digits, "-" and "_"', async () => {
    await expect(queryByProperty(client, 'bad name', 'x')).rejects.toThrow(InvalidParameterError);
    await expect(queryByProperty(client, 'a"]', 'x')).rejects.toThrow(InvalidParameterError);
  });

  it('treats a value with quotes and brackets as plain data', async () => {
    const { key } = cases[0];
    expect(await queryByProperty(client, key, 'x"]] [?b :block/uuid "')).toEqual([]);
  });

  it('makes one API call, a datascriptQuery', async () => {
    for (const { key, value } of cases) {
      client.methods = [];
      await queryByProperty(client, key, value, true);
      expect(client.methods).toEqual(['logseq.DB.datascriptQuery']);
    }
  });
});
