import { vi } from 'vitest';
import type { LogseqClient } from '../../src/client.js';

/**
 * An in-memory stand-in for the part of LogSeq that `DatalogQueryBuilder.refTargets`
 * queries, for unit tests of ref and embed resolution. It reads the uuid lists and
 * page names back out of the query text and inputs, so a test that passes proves
 * the right things were asked for, not just that some call was made.
 *
 * All names and uuids in tests using this are made up.
 */

export interface FakeBlockDef {
  uuid: string;
  content: string;
  page: string;
  /** uuid of the parent block; omit for a top-level block */
  parent?: string;
}

export interface FakeGraphDef {
  /** Page names (original casing) */
  pages: string[];
  /** Blocks in document order: siblings keep this order */
  blocks: FakeBlockDef[];
  /**
   * uuids that no block has but LogSeq made a placeholder entity for (#138): a row with
   * only `id`, `uuid` and content `id:: <uuid>`, and no page, parent or left
   */
  placeholders?: string[];
}

export function uuidN(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function fakeRefGraph(def: FakeGraphDef) {
  const pageId = (name: string) => 1000 + def.pages.findIndex(p => p.toLowerCase() === name.toLowerCase());
  const blockId = (uuid: string) => 1 + def.blocks.findIndex(b => b.uuid === uuid);
  const pageRef = (name: string) => ({ id: pageId(name), name: name.toLowerCase(), 'original-name': name });

  const blockRow = (b: FakeBlockDef) => {
    const siblings = def.blocks.filter(s => s.page === b.page && s.parent === b.parent);
    const index = siblings.indexOf(b);
    const parentId = b.parent ? blockId(b.parent) : pageId(b.page);
    return {
      id: blockId(b.uuid),
      uuid: b.uuid,
      content: b.content,
      left: { id: index === 0 ? parentId : blockId(siblings[index - 1].uuid) },
      parent: { id: parentId },
      page: pageRef(b.page)
    };
  };
  const pageRow = (name: string) => ({
    id: pageId(name),
    uuid: `page-${name.toLowerCase()}`,
    name: name.toLowerCase(),
    'original-name': name
  });

  const descendants = (uuid: string, levels: number): FakeBlockDef[] =>
    levels === 0
      ? []
      : def.blocks
          .filter(b => b.parent === uuid)
          .flatMap(child => [child, ...descendants(child.uuid, levels - 1)]);

  const groundList = (query: string, variable: string): string[] => {
    const match = query.match(new RegExp(`\\[\\(ground \\[([^\\]]*)\\]\\) \\[\\${variable} \\.\\.\\.\\]\\]`));
    return match ? Array.from(match[1].matchAll(/#uuid "([^"]+)"/g), m => m[1]) : [];
  };

  const queries: string[] = [];
  const executeDatalogQuery = vi.fn(async (query: string, ...inputs: unknown[]) => {
    queries.push(query);
    // The client EDN-encodes inputs; the fake is called before that, with raw values.
    const names = ((inputs[0] as string[] | undefined) ?? []).map(n => n.toLowerCase());
    const rows = new Map<number, unknown>();

    for (const uuid of groundList(query, '?u')) {
      const b = def.blocks.find(x => x.uuid === uuid);
      if (b) rows.set(blockId(b.uuid), blockRow(b));
      const p = (def.placeholders ?? []).indexOf(uuid);
      if (p >= 0) rows.set(5000 + p, { id: 5000 + p, uuid, content: `id:: ${uuid}` });
    }
    for (const uuid of groundList(query, '?ru')) {
      for (const b of descendants(uuid, 3)) rows.set(blockId(b.uuid), blockRow(b));
    }
    for (const name of names) {
      const page = def.pages.find(p => p.toLowerCase() === name);
      if (!page) continue;
      rows.set(pageId(page), pageRow(page));
      for (const b of def.blocks.filter(x => x.page === page && x.parent === undefined)) {
        rows.set(blockId(b.uuid), blockRow(b));
      }
    }
    return [...rows.values()].map(row => [row]);
  });

  const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;
  return { client, queries, executeDatalogQuery };
}
