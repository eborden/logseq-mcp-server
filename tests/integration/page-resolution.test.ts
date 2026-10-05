import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { homedir } from 'os';
import { access } from 'fs/promises';
import { loadConfig } from '../../src/config.js';
import { LogseqClient } from '../../src/client.js';
import { getPage } from '../../src/tools/get-page.js';
import { getBacklinks, getBacklinksWithMeta } from '../../src/tools/get-backlinks.js';
import { buildContextForTopic } from '../../src/tools/build-context.js';
import { getContextForQuery } from '../../src/tools/get-context-for-query.js';
import { getConceptEvolution } from '../../src/tools/get-concept-evolution.js';
import { getConceptNetwork } from '../../src/tools/get-concept-network.js';
import { searchByRelationship } from '../../src/tools/search-by-relationship.js';
import { resolvePage } from '../../src/utils/resolve-page.js';
import { AmbiguousPageError, PageNotFoundError } from '../../src/errors.js';

/**
 * Integration tests for page-name resolution (#41).
 *
 * Read-only. Discovers a journal, an alias and a namespace leaf in whatever
 * graph is running, then checks structure only: kinds, match routes, call
 * counts, the shape of candidates and guidance. It never asserts on or prints
 * names or content from the graph; every assertion is on a boolean or a count,
 * so a failure cannot echo graph data.
 *
 * Requires LogSeq running with the HTTP API enabled, ~/.logseq-mcp/config.json,
 * and a graph with: a journal page that has content; a page that declares an
 * `alias::` nobody else declares; an alias declared by two or more pages; and a
 * namespace leaf name (`ns/leaf`) used under two or more namespaces, with no
 * page or alias of that exact name. See tests/integration/setup.md.
 */

const SETUP_HINT = 'See tests/integration/setup.md ("Page resolution data")';

const isoOf = (day: number) => {
  const s = String(day);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

describe('page resolution against a live graph', () => {
  let client: LogseqClient;
  let queries = 0;
  let apiCalls = 0;

  /** A journal day with content, and the id of its page */
  let journal: { day: number; pageId: number };
  /** An alias stub declared by exactly one page, and that page's name */
  let unique: { stub: string; source: string };
  /** An alias stub declared by several pages */
  let shared: { stub: string; sources: number };
  /** A namespace leaf used under several namespaces, nothing else of that name */
  let leaf: { name: string; pages: number };
  /** Any page with a file (an exact-name hit) */
  let exact: string;

  const countedCalls = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> => {
    const before = apiCalls;
    const result = await run();
    return { result, calls: apiCalls - before };
  };

  beforeAll(async () => {
    const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
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

    // Count every API call the tools under test make
    const original = client.callAPI.bind(client);
    client.callAPI = (async (method: string, args?: any[]) => {
      apiCalls++;
      if (method === 'logseq.DB.datascriptQuery') queries++;
      return original(method, args);
    }) as typeof client.callAPI;

    const raw = (q: string) => original<any[]>('logseq.DB.datascriptQuery', [q]);

    // Journal with content
    const days = await raw(
      `[:find ?d ?p :where [?p :block/name] [?p :block/journal-day ?d] [?b :block/page ?p]]`
    );
    expect(days.length, `No journal page with content found. ${SETUP_HINT}`).toBeGreaterThan(0);
    const [day, pageId] = days[days.length >> 1];
    journal = { day, pageId };

    // Alias stubs and how many pages declare each
    const sourcesByStub = new Map<string, string[]>();
    const aliasRows = await raw(
      `[:find ?n ?sn :where [?a :block/name ?n] (not [?a :block/file]) [?p :block/alias ?a] [?p :block/name ?sn]]`
    );
    for (const [stub, source] of aliasRows) {
      sourcesByStub.set(stub, [...(sourcesByStub.get(stub) ?? []), source]);
    }
    const stubs = [...sourcesByStub.entries()];
    const one = stubs.find(([, sources]) => sources.length === 1);
    const many = stubs.find(([, sources]) => sources.length > 1);
    expect(one !== undefined, `No page with an alias that only it declares. ${SETUP_HINT}`).toBe(true);
    expect(many !== undefined, `No alias declared by two or more pages. ${SETUP_HINT}`).toBe(true);
    unique = { stub: one![0], source: one![1][0] };
    shared = { stub: many![0], sources: many![1].length };

    // A namespace leaf shared by several pages, with no page or alias of that name
    const nsRows = await raw(`[:find ?n :where [?p :block/namespace ?x] [?p :block/name ?n]]`);
    const leaves = new Map<string, number>();
    for (const [name] of nsRows) {
      const l = String(name).split('/').pop()!;
      leaves.set(l, (leaves.get(l) ?? 0) + 1);
    }
    const taken = new Set<string>(
      (await raw(`[:find ?n :where [?p :block/name ?n]]`)).map(([n]) => String(n))
    );
    const sharedLeaf = [...leaves.entries()].find(([l, count]) => count > 1 && !taken.has(l));
    expect(sharedLeaf !== undefined, `No namespace leaf used under two or more namespaces. ${SETUP_HINT}`).toBe(true);
    leaf = { name: sharedLeaf![0], pages: sharedLeaf![1] };

    // An ordinary page with a file
    const withFile = await raw(`[:find ?n :where [?p :block/name ?n] [?p :block/file] (not [?p :block/journal? true])]`);
    expect(withFile.length, `No page with a file found. ${SETUP_HINT}`).toBeGreaterThan(0);
    exact = withFile[0][0];
  });

  it('resolves an exact name with one query and no extra calls', async () => {
    const { result, calls } = await countedCalls(() => resolvePage(client, exact.toUpperCase()));

    expect(result.kind === 'found').toBe(true);
    expect(result.kind === 'found' && result.matchedBy === 'name').toBe(true);
    expect(calls).toBe(1);
  });

  describe('ISO dates', () => {
    it('resolves an ISO date to the journal page by journal-day, in one query', async () => {
      const { result, calls } = await countedCalls(() => resolvePage(client, isoOf(journal.day)));

      expect(result.kind === 'found').toBe(true);
      if (result.kind !== 'found') return;
      expect(result.matchedBy).toBe('journal-date');
      expect(result.page.id === journal.pageId).toBe(true);
      expect(calls).toBe(1);
    });

    it('returns the journal page from get_page, saying how it was found', async () => {
      const page = await getPage(client, isoOf(journal.day), false);

      expect(page.journalDay === journal.day).toBe(true);
      expect(page.resolvedFrom?.matchedBy).toBe('journal-date');
    });

    it('builds context and backlinks for an ISO date', async () => {
      const context = await buildContextForTopic(client, isoOf(journal.day));
      const backlinks = await getBacklinks(client, isoOf(journal.day));

      expect(context.mainPage.id === journal.pageId).toBe(true);
      expect(context.resolvedFrom?.matchedBy).toBe('journal-date');
      expect(Array.isArray(backlinks ?? [])).toBe(true);
    });

    it('reports a date with no journal as not found without a page-list call', async () => {
      const { result, calls } = await countedCalls(() => resolvePage(client, '1999-01-01'));

      expect(result.kind).toBe('not_found');
      expect(calls).toBe(1);
    });
  });

  describe('aliases', () => {
    it('resolves an alias declared by one page to that page, in one query', async () => {
      const { result, calls } = await countedCalls(() => resolvePage(client, unique.stub));

      expect(result.kind === 'found').toBe(true);
      if (result.kind !== 'found') return;
      expect(result.matchedBy).toBe('alias');
      expect(result.name === unique.source).toBe(true);
      expect(calls).toBe(1);
    });

    it('returns the declaring page from get_page and build_context', async () => {
      const page = await getPage(client, unique.stub, false);
      const context = await buildContextForTopic(client, unique.stub);

      expect(page.name === unique.source).toBe(true);
      expect(page.resolvedFrom?.matchedBy).toBe('alias');
      expect(context.mainPage.name === unique.source).toBe(true);
      expect(context.resolvedFrom?.matchedBy).toBe('alias');
    });

    it('returns candidates, not a guess, for an alias declared by several pages', async () => {
      const { result, calls } = await countedCalls(() => resolvePage(client, shared.stub));

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.totalCandidates).toBe(shared.sources);
      expect(result.candidates.length).toBe(Math.min(shared.sources, 10));
      for (const c of result.candidates) {
        expect(typeof c.name === 'string' && c.name.length > 0).toBe(true);
        expect(typeof c.originalName === 'string' && c.originalName.length > 0).toBe(true);
        expect(c.matchedBy).toBe('alias');
        expect(typeof c.reason === 'string' && c.reason.length > 0).toBe(true);
      }
      expect(calls).toBe(1);
    });

    it('throws AmbiguousPageError from get_page and get_backlinks without picking a page', async () => {
      await expect(getPage(client, shared.stub, false)).rejects.toBeInstanceOf(AmbiguousPageError);
      await expect(getBacklinks(client, shared.stub)).rejects.toBeInstanceOf(AmbiguousPageError);
    });

    it('skips an ambiguous topic in get_context_for_query with an ambiguous_page warning', async () => {
      const result = await getContextForQuery(client, `about [[${shared.stub}]]`);
      const warning = result.warnings.find(w => w.code === 'ambiguous_page');

      expect(warning !== undefined).toBe(true);
      expect(warning?.candidates?.length).toBeGreaterThan(1);
      expect(result.contexts).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('namespace leaves', () => {
    it('returns candidates for a leaf used under several namespaces, in two queries', async () => {
      const { result, calls } = await countedCalls(() => resolvePage(client, leaf.name));

      expect(result.kind).toBe('ambiguous');
      if (result.kind !== 'ambiguous') return;
      expect(result.totalCandidates).toBe(leaf.pages);
      expect(result.candidates.every(c => c.matchedBy === 'namespace-leaf')).toBe(true);
      expect(calls).toBe(2);
    });
  });

  describe('the tools that changed behaviour in #41', () => {
    const MISSING = 'no such page 41 integration probe';

    it('get_concept_evolution, get_concept_network and get_backlinks throw guidance for a missing page', async () => {
      for (const run of [
        () => getConceptEvolution(client, MISSING),
        () => getConceptNetwork(client, MISSING, 1),
        () => getBacklinks(client, MISSING)
      ]) {
        const error = await run().catch(e => e);
        expect(error instanceof PageNotFoundError).toBe(true);
      }
    });

    it('search_by_relationship throws for a missing topic in either position, for every relationship type', async () => {
      for (const type of ['references', 'in-pages-linking-to', 'connected-within'] as const) {
        expect(await searchByRelationship(client, MISSING, exact, type).catch(e => e)).toBeInstanceOf(PageNotFoundError);
        expect(await searchByRelationship(client, exact, MISSING, type).catch(e => e)).toBeInstanceOf(PageNotFoundError);
      }
    });

    it('get_concept_evolution, get_concept_network and search_by_relationship return candidates for a shared alias', async () => {
      const errors = [
        await getConceptEvolution(client, shared.stub).catch(e => e),
        await getConceptNetwork(client, shared.stub, 1).catch(e => e),
        await searchByRelationship(client, shared.stub, exact, 'references').catch(e => e),
        await searchByRelationship(client, exact, shared.stub, 'references').catch(e => e)
      ];
      for (const error of errors) {
        expect(error instanceof AmbiguousPageError).toBe(true);
        expect(error.totalCandidates).toBe(shared.sources);
      }
    });

    it('get_backlinks, get_concept_evolution and search_by_relationship say which page an alias stood for', async () => {
      const { meta } = await getBacklinksWithMeta(client, unique.stub);
      const evolution = await getConceptEvolution(client, unique.stub);
      const relationship = await searchByRelationship(client, unique.stub, exact, 'references');

      expect(meta?.resolvedFrom?.matchedBy).toBe('alias');
      expect(meta?.resolvedFrom?.resolvedTo.toLowerCase() === unique.source).toBe(true);
      expect(evolution.resolvedFrom?.matchedBy).toBe('alias');
      expect(relationship.resolvedFrom?.topicA?.matchedBy).toBe('alias');
      expect(relationship.resolvedFrom?.topicB).toBeUndefined();
    });

    it('get_page costs one call for an exact name of a page with a file', async () => {
      const { result, calls } = await countedCalls(() => getPage(client, exact, false));

      expect(result.resolvedFrom).toBeUndefined();
      expect(calls).toBe(1);
    });
  });

  describe('not found', () => {
    it('returns guidance: no page, then the tools to try', async () => {
      const error = await getPage(client, 'no such page 41 integration probe', false).catch(e => e);

      expect(error instanceof PageNotFoundError).toBe(true);
      const message = String(error.message);
      expect(message.startsWith('No page "no such page 41 integration probe".')).toBe(true);
      expect(message.includes('logseq_search_blocks')).toBe(true);
      expect(message.includes('logseq_list_pages')).toBe(true);
      expect(Array.isArray(error.suggestions) && error.suggestions.length <= 3).toBe(true);
    });

    it('costs the first lookup, two queries and one getAllPages call on the not-found path', async () => {
      const { calls } = await countedCalls(() => getPage(client, 'no such page 41 probe', false).catch(() => null));

      // Editor.getPage (null) + resolve + namespace-leaf (Datalog) + getAllPages for suggestions
      expect(calls).toBe(4);
    });
  });

  it('made Datalog queries for its lookups', () => {
    expect(queries).toBeGreaterThan(0);
  });
});
