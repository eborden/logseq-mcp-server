import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { getBlock } from '../../src/tools/get-block.js';
import { getPage } from '../../src/tools/get-page.js';
import { resolveBlockRefs } from '../../src/utils/resolve-refs.js';
import { BlockEntity, ResolvedRef } from '../../src/types.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * Integration tests for resolve_refs (#18), against the fixture graph.
 *
 * Read-only. The page `block refs` (tests/fixtures/graph/pages/block refs.md) pins a uuid on
 * every target: `...02` is a plain block, `...03` a ref to it, `...04` a ref to `...03`, and so
 * on (tests/fixtures/README.md, "Block refs and embeds"). Refs and embeds of blocks that do not
 * exist are in fixture-only/resolve-refs-missing.test.ts.
 */

const STATUSES = ['ok', 'missing', 'depth_limit', 'cycle'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYNTHETIC_MISSING = '00000000-0000-4000-8000-000000000001';
const PAGE = 'block refs';
const uuid = (nn: string) => `0088f1a0-0000-4000-8000-0000000000${nn}`;
/** A plain ref to `...02` */
const PLAIN_REF = uuid('03');
const TARGET = uuid('02');

const isRef = (r: unknown): r is ResolvedRef =>
  typeof r === 'object' && r !== null && STATUSES.includes((r as ResolvedRef).status);

describe('resolve_refs against the fixture graph', () => {
  let client: LogseqClient;
  /** A block holding a ref that resolves, as returned by getBlock with resolve_refs */
  let resolved: BlockEntity;
  let resolvedUuid: string;
  let okRef: ResolvedRef;

  beforeAll(async () => {
    ({ client } = await connectFixture());
    resolvedUuid = PLAIN_REF;
    resolved = await getBlock(client, resolvedUuid, false, { resolveRefs: true });
    okRef = resolved.resolvedRefs![0];
  });

  it('getBlock: keeps content, adds resolvedContent and well-formed resolvedRefs', async () => {
    const plain = await getBlock(client, resolvedUuid, false);
    expect(resolved.content === plain.content).toBe(true);
    expect(typeof resolved.resolvedContent).toBe('string');
    expect(resolved.resolvedContent !== resolved.content).toBe(true);
    expect(Array.isArray(resolved.resolvedRefs) && resolved.resolvedRefs.length > 0).toBe(true);
    expect(resolved.resolvedRefs!.every(isRef)).toBe(true);
    expect(resolved.resolvedRefs!.every(r => r.embed !== undefined || UUID_RE.test(r.uuid ?? ''))).toBe(true);
    expect(resolved.resolvedRefs).toEqual([
      { uuid: TARGET, content: 'A block that other blocks point at: the importer reads one sheet per floor.', page: PAGE, status: 'ok' },
    ]);
    expect(resolved.resolvedContent!.split('\n')[0]).toBe(
      'A plain ref to it: A block that other blocks point at: the importer reads one sheet per floor.'
    );
    expect((resolved as { warnings?: unknown }).warnings).toEqual([]);
    expect((resolved as { hasMore?: unknown }).hasMore).toBe(false);
  });

  it('getBlock: off by default, the output has none of the new fields', async () => {
    const plain = await getBlock(client, resolvedUuid, false);
    const keys = Object.keys(plain);
    expect(['resolvedContent', 'resolvedRefs', 'warnings', 'hasMore'].some(k => keys.includes(k))).toBe(false);
  });

  it('getBlock: resolving costs at most depth (2) extra Datalog calls on top of the one fetch', async () => {
    const spy = vi.spyOn(client, 'callAPI');
    try {
      await getBlock(client, resolvedUuid, false, { resolveRefs: true });
      // The fetch, then one query for `...02`, which holds no refs of its own
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('getBlock: without resolve_refs makes exactly the one fetch', async () => {
    const spy = vi.spyOn(client, 'callAPI');
    try {
      await getBlock(client, resolvedUuid, false);
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('getPage with children: annotates the same block inside its page tree', async () => {
    const page = await getPage(client, PAGE, true, { resolveRefs: true });
    const find = (blocks: any[]): any | undefined => {
      for (const b of blocks) {
        if (b.uuid === resolvedUuid) return b;
        const inner = find(b.children ?? []);
        if (inner) return inner;
      }
      return undefined;
    };
    const found = find(page.children ?? []);
    expect(found !== undefined).toBe(true);
    expect(typeof found.resolvedContent).toBe('string');
    expect(found.resolvedRefs).toEqual(resolved.resolvedRefs);
    // The ref three levels deep stops at the default depth of 2
    expect(page.warnings!.map(w => w.code)).toEqual(['refs_depth_limit']);
    expect(page.hasMore).toBe(true);
  });

  it('a uuid that does not exist comes back missing, in place, without erroring', async () => {
    const content = `gone ((${SYNTHETIC_MISSING}))`;
    const { blocks } = await resolveBlockRefs(client, [{ uuid: SYNTHETIC_MISSING.replace(/1$/, '2'), content }]);
    expect((blocks[0] as any).resolvedContent === content).toBe(true);
    expect((blocks[0] as any).resolvedRefs.map((r: ResolvedRef) => r.status)).toEqual(['missing']);
  });

  it('block and page embeds of real targets resolve in one batched query', async () => {
    // A page embed resolves to the page's blocks; Bob's hold no refs, so nothing nests further
    const pageName = 'Bob';
    const spy = vi.spyOn(client, 'callAPI');
    try {
      const { blocks, warnings } = await resolveBlockRefs(
        client,
        [{ uuid: SYNTHETIC_MISSING.replace(/1$/, '3'), content: `{{embed ((${okRef.uuid}))}} {{embed [[${pageName}]]}}` }],
        { maxDepth: 1 }
      );
      expect(spy.mock.calls.length).toBe(1);
      const refs: ResolvedRef[] = (blocks[0] as any).resolvedRefs;
      expect(refs.map(r => r.embed).sort()).toEqual(['block', 'page']);
      expect(refs.map(r => [r.embed, r.status, r.page])).toEqual([['block', 'ok', PAGE], ['page', 'ok', 'Bob']]);
      expect(warnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('resolves every case on the page as tests/fixtures/README.md lists it', async () => {
    const page = await getPage(client, PAGE, true, { resolveRefs: true });
    const flat = (blocks: any[]): any[] => blocks.flatMap(b => [b, ...flat(b.children ?? [])]);
    const byStart = (start: string) => {
      const found = flat(page.children ?? []).filter(b => b.content.startsWith(start));
      expect(found, start).toHaveLength(1);
      return (found[0].resolvedRefs ?? []).map((r: ResolvedRef) => [r.embed ?? r.uuid, r.status]);
    };

    expect(byStart('A block that other blocks point at')).toEqual([]);
    expect(byStart('A ref to a block on another page')).toEqual([[uuid('01'), 'ok']]);
    expect(byStart('A ref to a ref, two levels')).toEqual([[uuid('03'), 'ok'], [uuid('02'), 'ok']]);
    expect(byStart('A ref three levels deep')).toEqual([
      [uuid('04'), 'ok'], [uuid('03'), 'ok'], [uuid('02'), 'depth_limit'],
    ]);
    // Siblings that share a target both resolve: seen is tracked per path
    expect(byStart('First sibling')).toEqual([[TARGET, 'ok']]);
    expect(byStart('Second sibling')).toEqual([[TARGET, 'ok']]);
    expect(byStart('A block embed')).toEqual([['block', 'ok']]);
    expect(byStart('A page embed')).toEqual([['page', 'ok']]);
    expect(byStart('Ref cycle, first half')).toEqual([[uuid('11'), 'ok'], [uuid('10'), 'cycle']]);
    expect(byStart('Embed cycle, first half')).toEqual([['block', 'ok'], ['block', 'cycle']]);
  });
});
