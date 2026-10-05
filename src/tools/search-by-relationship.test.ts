import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchByRelationship } from './search-by-relationship.js';
import { LogseqClient } from '../client.js';
import { AmbiguousPageError, PageNotFoundError } from '../errors.js';

/**
 * A tiny stand-in for LogSeq's HTTP API. Pages and blocks are plain
 * fixtures; the fake answers the Datalog builders from the `:in` inputs it
 * receives (EDN-encoded, as the real client sends them) and from each
 * block's `refs`, never from its content. That is what the tool must rely
 * on, so a plain-text mention can only match if the tool wrongly goes back
 * to content matching.
 *
 * Link graph (page -> pages its blocks reference):
 *   project atlas -> alice
 *   bob           -> project atlas, alice
 *   carol         -> project atlas
 *   dave          -> carol
 */
interface FakeBlock {
  id: number;
  content: string;
  page: number;
  refs: number[]; // page ids this block references
}

const PAGES: Record<string, number> = {
  'project atlas': 1,
  alice: 2,
  bob: 3,
  carol: 4,
  dave: 5
};

const BLOCKS: FakeBlock[] = [
  // project atlas page
  { id: 10, content: 'Met with [[Alice]] today', page: 1, refs: [2] },
  { id: 11, content: 'Follow up with #alice', page: 1, refs: [2] },
  { id: 12, content: 'Tag form #[[Alice]] too', page: 1, refs: [2] },
  { id: 13, content: 'alice mentioned as plain text only', page: 1, refs: [] },
  { id: 14, content: 'unrelated note', page: 1, refs: [] },
  // bob page links to atlas and alice
  { id: 20, content: 'Pairing with [[Project Atlas]]', page: 3, refs: [1] },
  { id: 21, content: 'Lunch with [[Alice]]', page: 3, refs: [2] },
  // carol links to atlas and mentions bob only as plain text
  { id: 30, content: 'bob said hi', page: 4, refs: [] },
  { id: 31, content: 'Reviewing #project-atlas', page: 4, refs: [1] },
  // dave links to carol
  { id: 40, content: 'Notes on [[Carol]]', page: 5, refs: [4] }
];

function makeClient() {
  const client = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 't' });
  const calls: Array<{ method: string; args: any[] }> = [];

  vi.spyOn(client, 'callAPI').mockImplementation(async (method: string, args: any[] = []) => {
    calls.push({ method, args });
    if (method !== 'logseq.DB.datascriptQuery') return [] as any;

    const [query, ...raw] = args as [string, ...string[]];
    const names = raw.map(value => JSON.parse(value) as string);

    if (query.includes(':in $ ?page-name ?ref-name')) {
      const [pageName, refName] = names;
      return BLOCKS.filter(
        b => b.page === PAGES[pageName] && b.refs.includes(PAGES[refName])
      ).map(b => [b]) as any;
    }

    if (query.includes(':in $ ?a-name ?b-name')) {
      const [aName, bName] = names;
      const linkingPages = new Set(
        BLOCKS.filter(b => b.refs.includes(PAGES[bName])).map(b => b.page)
      );
      return BLOCKS.filter(
        b => linkingPages.has(b.page) && b.refs.includes(PAGES[aName])
      ).map(b => [b]) as any;
    }

    if (query.includes(':in $ ?n')) {
      const id = PAGES[names[0]];
      return (id ? [[{ id, name: names[0] }, 'name']] : []) as any;
    }

    // The namespace-leaf lookup, run when a name matched nothing
    if (query.includes(':in $ ?suffix')) return [] as any;

    if (query.includes('?neighbor')) {
      const ids = query.match(/ground \[([\d ]+)\]/)![1].split(' ').map(Number);
      const out = new Set<number>();
      for (const b of BLOCKS) {
        if (ids.includes(b.page)) b.refs.forEach(r => out.add(r));
        if (b.refs.some(r => ids.includes(r))) out.add(b.page);
      }
      return [...out].map(id => [id]) as any;
    }

    throw new Error(`unexpected query: ${query}`);
  });

  const datalogCalls = () => calls.filter(c => c.method === 'logseq.DB.datascriptQuery');
  const hopCalls = () => datalogCalls().filter(c => String(c.args[0]).includes('?neighbor'));
  const treeCalls = () => calls.filter(c => c.method === 'logseq.Editor.getPageBlocksTree');

  return { client, calls, datalogCalls, hopCalls, treeCalls };
}

describe('searchByRelationship', () => {
  let ctx: ReturnType<typeof makeClient>;

  beforeEach(() => {
    ctx = makeClient();
  });

  describe('references', () => {
    it('sends lowercased names as EDN :in inputs in a single call', async () => {
      await searchByRelationship(ctx.client, 'Project Atlas', 'ALICE', 'references');

      // One resolve per topic, then the query itself
      expect(ctx.client.callAPI).toHaveBeenCalledTimes(3);
      const [method, args] = (ctx.client.callAPI as any).mock.calls[2];
      expect(method).toBe('logseq.DB.datascriptQuery');
      expect(args[0]).toContain(':in $ ?page-name ?ref-name');
      expect(args.slice(1)).toEqual(['"project atlas"', '"alice"']);
    });

    it('matches a mixed-case topicB', async () => {
      const result = await searchByRelationship(ctx.client, 'project atlas', 'aLiCe', 'references');

      expect(result.results.map(b => b.id).sort()).toEqual([10, 11, 12]);
    });

    it('matches both [[topic]] and #topic through refs', async () => {
      const result = await searchByRelationship(ctx.client, 'Project Atlas', 'Alice', 'references');
      const contents = result.results.map(b => b.content);

      expect(contents).toContain('Met with [[Alice]] today');
      expect(contents).toContain('Follow up with #alice');
      expect(contents).toContain('Tag form #[[Alice]] too');
    });

    it('does not match a topic that appears only as plain text', async () => {
      const result = await searchByRelationship(ctx.client, 'Project Atlas', 'Alice', 'references');

      expect(result.results.map(b => b.id)).not.toContain(13);
    });

    it('throws PageNotFoundError when topicA or topicB does not exist', async () => {
      await expect(searchByRelationship(ctx.client, 'nope', 'alice', 'references')).rejects.toThrow(PageNotFoundError);
      await expect(searchByRelationship(ctx.client, 'project atlas', 'nope', 'references')).rejects.toThrow(
        /No page "nope"/
      );
    });

    it('treats a null Datalog result as no matches', async () => {
      const original = (ctx.client.callAPI as any).getMockImplementation();
      vi.spyOn(ctx.client, 'callAPI').mockImplementation(async (method: string, args: any[] = []) =>
        String(args[0]).includes(':in $ ?page-name ?ref-name') ? (null as any) : original(method, args)
      );

      const result = await searchByRelationship(ctx.client, 'project atlas', 'alice', 'references');

      expect(result.results).toEqual([]);
    });

    it('resolves an alias and queries with the page that declares it', async () => {
      const aliasOf = vi.fn();
      const original = (ctx.client.callAPI as any).getMockImplementation();
      vi.spyOn(ctx.client, 'callAPI').mockImplementation(async (method: string, args: any[] = []) => {
        const query = String(args[0]);
        if (query.includes(':in $ ?n') && args[1] === '"atlas"') {
          return [[{ id: 1, name: 'project atlas' }, 'alias']] as any;
        }
        if (query.includes(':in $ ?page-name ?ref-name')) aliasOf(args.slice(1));
        return original(method, args);
      });

      const result = await searchByRelationship(ctx.client, 'Atlas', 'alice', 'references');

      expect(aliasOf).toHaveBeenCalledWith(['"project atlas"', '"alice"']);
      expect(result.results.map(b => b.id).sort()).toEqual([10, 11, 12]);
    });

    it('throws AmbiguousPageError when a topic matches several pages', async () => {
      const original = (ctx.client.callAPI as any).getMockImplementation();
      vi.spyOn(ctx.client, 'callAPI').mockImplementation(async (method: string, args: any[] = []) =>
        String(args[0]).includes(':in $ ?n') && args[1] === '"al"'
          ? ([
              [{ id: 2, name: 'alice' }, 'alias'],
              [{ id: 3, name: 'bob' }, 'alias']
            ] as any)
          : original(method, args)
      );

      await expect(searchByRelationship(ctx.client, 'Al', 'alice', 'references')).rejects.toThrow(AmbiguousPageError);
    });
  });

  describe.each(['in-pages-linking-to', 'referenced-by'] as const)('%s', type => {
    it('sends lowercased [topicA, topicB] as EDN :in inputs in a single call', async () => {
      await searchByRelationship(ctx.client, 'ALICE', 'Project Atlas', type);

      // One resolve per topic, then the query itself
      expect(ctx.client.callAPI).toHaveBeenCalledTimes(3);
      const [method, args] = (ctx.client.callAPI as any).mock.calls[2];
      expect(method).toBe('logseq.DB.datascriptQuery');
      expect(args[0]).toContain(':in $ ?a-name ?b-name');
      expect(args.slice(1)).toEqual(['"alice"', '"project atlas"']);
    });

    it('returns topicA blocks on pages that link to a mixed-case topicB', async () => {
      const result = await searchByRelationship(ctx.client, 'Alice', 'PROJECT atlas', type);

      // bob and carol link to atlas; only bob has a block referencing alice
      expect(result.results.map(b => b.id)).toEqual([21]);
      expect(result.relationshipType).toBe(type);
    });

    it('does not match pages that mention topicB only as plain text', async () => {
      // carol writes "bob" in plain text but never references it
      const result = await searchByRelationship(ctx.client, 'Project Atlas', 'Bob', type);

      expect(result.results).toEqual([]);
    });
  });

  describe('connected-within', () => {
    it('finds a direct link regardless of casing and returns both pages blocks', async () => {
      await searchByRelationship(ctx.client, 'PROJECT ATLAS', 'Alice', 'connected-within', 2);

      expect(ctx.treeCalls().map(c => c.args)).toEqual([['PROJECT ATLAS'], ['Alice']]);
    });

    it('uses one batched query per hop (2 lookups + 1 hop when topics are adjacent)', async () => {
      await searchByRelationship(ctx.client, 'project atlas', 'alice', 'connected-within', 3);

      expect(ctx.datalogCalls()).toHaveLength(3);
      expect(ctx.hopCalls()).toHaveLength(1);
      expect(ctx.hopCalls()[0].args).toHaveLength(1);
      expect(ctx.hopCalls()[0].args[0]).toContain('[(ground [1]) [?p ...]]');
    });

    it('reaches a two-hop topic only when maxDistance allows it', async () => {
      // alice -> project atlas -> carol
      await searchByRelationship(ctx.client, 'alice', 'carol', 'connected-within', 1);
      expect(ctx.treeCalls()).toHaveLength(0);

      await searchByRelationship(ctx.client, 'alice', 'carol', 'connected-within', 2);
      expect(ctx.treeCalls()).toHaveLength(2);
    });

    it('walks outward one frontier per hop and does not revisit pages', async () => {
      await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 3);

      // alice -> {atlas, bob} -> {carol} -> dave found on the third hop
      expect(ctx.hopCalls()).toHaveLength(3);
      expect(ctx.treeCalls()).toHaveLength(2);
      const frontiers = ctx.hopCalls().map(c => String(c.args[0]).match(/ground \[([\d ]+)\]/)![1]);
      expect(frontiers[0]).toBe('2');
      expect(new Set(frontiers[1].split(' '))).toEqual(new Set(['1', '3']));
      expect(frontiers[2]).toBe('4');
    });

    it('stops after maxDistance hops when topicB is unreachable', async () => {
      await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 2);

      expect(ctx.hopCalls()).toHaveLength(2);
      expect(ctx.treeCalls()).toHaveLength(0);
    });

    it('does no graph walk when maxDistance is 0', async () => {
      await searchByRelationship(ctx.client, 'alice', 'project atlas', 'connected-within', 0);

      expect(ctx.hopCalls()).toHaveLength(0);
      expect(ctx.treeCalls()).toHaveLength(0);
    });

    it('throws PageNotFoundError without walking when either page is missing', async () => {
      await expect(searchByRelationship(ctx.client, 'alice', 'nope', 'connected-within', 2)).rejects.toThrow(
        PageNotFoundError
      );
      expect(ctx.hopCalls()).toHaveLength(0);
    });
  });

  describe('truncation warnings (#40)', () => {
    it('has hasMore false and no warnings for the single-query types', async () => {
      const result = await searchByRelationship(ctx.client, 'Project Atlas', 'Alice', 'references');

      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('has no warning when the frontier is under the cap', async () => {
      const result = await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 3);

      expect(result.hasMore).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('has no warning when the frontier is exactly at the cap', async () => {
      // hop 2 frontier is {atlas, bob}: 2 pages
      const result = await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 2, { maxFrontier: 2 });

      expect(result.warnings).toEqual([]);
    });

    it('cuts an oversized frontier, lowest ids first, and warns when topicB is not found', async () => {
      const result = await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 2, { maxFrontier: 1 });

      const frontiers = ctx.hopCalls().map(c => String(c.args[0]).match(/ground \[([\d ]+)\]/)![1]);
      expect(frontiers).toEqual(['2', '1']);
      expect(result.results).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({ code: 'frontier_truncated' });
      expect(result.warnings[0].message).toContain('Hop 2 reached 2 pages; only 1 were expanded');
      expect(result.warnings[0].message).toContain('max_distance');
      // No parameter raises the cap, so it must not claim there is more to fetch
      expect(result.warnings[0].howToFetchAll).toBeUndefined();
      expect(result.hasMore).toBe(false);
    });

    it('does not warn when a connection is found despite the cut', async () => {
      const result = await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 3, { maxFrontier: 1 });

      expect(ctx.treeCalls()).toHaveLength(2); // connection found, so both pages were fetched
      expect(result.warnings).toEqual([]);
    });

    it('keeps the call count: the cap changes the ids per query, not the number of queries', async () => {
      await searchByRelationship(ctx.client, 'alice', 'dave', 'connected-within', 2, { maxFrontier: 1 });

      expect(ctx.hopCalls()).toHaveLength(2);
    });
  });
});
