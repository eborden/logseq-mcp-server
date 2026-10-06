import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resolve } from 'path';
import { access } from 'fs/promises';
import { loadConfig, resolveConfigPath } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getBlock } from '../../src/tools/get-block.js';
import { getPage } from '../../src/tools/get-page.js';
import { resolveBlockRefs } from '../../src/utils/resolve-refs.js';
import { BlockEntity, ResolvedRef } from '../../src/types.js';

/**
 * Integration tests for resolve_refs (#18).
 *
 * Read-only. Discovers a block holding a `((uuid))` ref in whatever graph is
 * running, then checks structure only: statuses, shapes, call counts. It never
 * asserts on or prints content, page names or uuids from the graph; every
 * assertion is on a boolean so a failure cannot echo graph data.
 *
 * Requires LogSeq running with the HTTP API enabled, ~/.logseq-mcp/config.json,
 * and at least one block whose content holds a `((uuid))` block reference to a
 * block that still exists. See tests/integration/setup.md.
 */

const SETUP_HINT = 'See tests/integration/setup.md';
const STATUSES = ['ok', 'missing', 'depth_limit', 'cycle'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYNTHETIC_MISSING = '00000000-0000-4000-8000-000000000001';

/** Blocks whose content holds a strict `((uuid))` ref (a few, to find one whose target exists). */
const REF_BLOCKS_QUERY = `[:find (pull ?b [:db/id :block/uuid :block/content])
  :where
  [?b :block/content ?c]
  [(re-pattern "\\\\(\\\\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\\\)\\\\)") ?re]
  [(re-find ?re ?c)]]`;

const isRef = (r: unknown): r is ResolvedRef =>
  typeof r === 'object' && r !== null && STATUSES.includes((r as ResolvedRef).status);

describe('resolve_refs against a live graph', () => {
  let client: LogseqClient;
  /** A block holding a ref that resolves, as returned by getBlock with resolve_refs */
  let resolved: BlockEntity;
  let resolvedUuid: string;
  let okRef: ResolvedRef;

  beforeAll(async () => {
    const configPath = resolveConfigPath();
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

    const rows = (await client.executeDatalogQuery<Array<[{ uuid: string }]>>(REF_BLOCKS_QUERY)) ?? [];
    for (const [candidate] of rows.slice(0, 25)) {
      const block = await getBlock(client, candidate.uuid, false, { resolveRefs: true });
      const ok = (block.resolvedRefs ?? []).find(r => r.status === 'ok');
      if (ok) {
        resolved = block;
        resolvedUuid = candidate.uuid;
        okRef = ok;
        break;
      }
    }
    if (!resolved) {
      throw new Error(
        'No block with a ((uuid)) ref to an existing block was found in the graph. ' +
          `Add one to run these tests. ${SETUP_HINT}`
      );
    }
  });

  it('getBlock: keeps content, adds resolvedContent and well-formed resolvedRefs', async () => {
    const plain = await getBlock(client, resolvedUuid, false);
    expect(resolved.content === plain.content).toBe(true);
    expect(typeof resolved.resolvedContent).toBe('string');
    expect(resolved.resolvedContent !== resolved.content).toBe(true);
    expect(Array.isArray(resolved.resolvedRefs) && resolved.resolvedRefs.length > 0).toBe(true);
    expect(resolved.resolvedRefs!.every(isRef)).toBe(true);
    expect(resolved.resolvedRefs!.every(r => r.embed !== undefined || UUID_RE.test(r.uuid ?? ''))).toBe(true);
    expect(UUID_RE.test(okRef.uuid ?? '')).toBe(true);
    expect(typeof okRef.content).toBe('string');
    expect(okRef.page === null || typeof okRef.page === 'string').toBe(true);
    expect(Array.isArray(resolved.warnings)).toBe(true);
    expect(typeof resolved.hasMore).toBe('boolean');
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
      const total = spy.mock.calls.length;
      expect(total >= 2 && total <= 1 + 2).toBe(true);
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
    const block = await client.callAPI<any>('logseq.Editor.getBlock', [resolvedUuid]);
    const pageEntity = await client.callAPI<any>('logseq.Editor.getPage', [block.page.id]);
    const pageName: string = pageEntity.originalName ?? pageEntity.name;

    const page = await getPage(client, pageName, true, { resolveRefs: true });
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
    expect(found.resolvedRefs.every(isRef)).toBe(true);
    expect(Array.isArray(page.warnings)).toBe(true);
  });

  it('a uuid that does not exist comes back missing, in place, without erroring', async () => {
    const content = `gone ((${SYNTHETIC_MISSING}))`;
    const { blocks } = await resolveBlockRefs(client, [{ uuid: SYNTHETIC_MISSING.replace(/1$/, '2'), content }]);
    expect((blocks[0] as any).resolvedContent === content).toBe(true);
    expect((blocks[0] as any).resolvedRefs.map((r: ResolvedRef) => r.status)).toEqual(['missing']);
  });

  it('block and page embeds of real targets resolve in one batched query', async () => {
    const block = await client.callAPI<any>('logseq.Editor.getBlock', [okRef.uuid]);
    const pageEntity = await client.callAPI<any>('logseq.Editor.getPage', [block.page.id]);
    const pageName: string = pageEntity.originalName ?? pageEntity.name;

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
      expect(refs.every(r => r.status === 'ok' || r.status === 'depth_limit')).toBe(true);
      expect(Array.isArray(warnings) && warnings.every(w => typeof w.howToFetchAll === 'string')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
