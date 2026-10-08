import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../scripts/lib/logseq-api.js';
import { buildContextForTopic, getBacklinks, getBacklinksWithMeta, getConceptEvolution, getConceptNetwork, getContextForQuery, getPage, getPageOutline, searchByRelationship } from './helpers/tools.js';
import { AmbiguousPageError, PageNotFoundError } from './helpers/errors.js';
import { connectFixture, recordCalls } from './helpers/fixture-client.js';

/**
 * Integration tests for page-name resolution (#41), against the fixture graph.
 *
 * Read-only. The resolver has no tool of its own, so its cases run through `get_page_outline`, which costs the
 * resolver's calls plus one query for the blocks when the page is found (CLAUDE.md, "Current Implementation
 * Status"); an ambiguous or missing name costs the resolver's calls alone. The cases are fixture pages (tests/fixtures/README.md, "Page resolution and
 * aliases"): the journal Jan 6th, 2025; `atlas`, the alias only `project atlas` declares;
 * `roadmap`, declared by `project borealis` and `project cascade`; the namespace leaf `notes`,
 * used once, and `meetings`, used under two namespaces; and `Bob`, a page with a file.
 */

const JOURNAL = { day: 20250106, iso: '2025-01-06', name: 'jan 6th, 2025' };
const UNIQUE = { stub: 'atlas', source: 'project atlas' };
const SHARED = { stub: 'roadmap', sources: ['project borealis', 'project cascade'] };
const LEAF = { name: 'meetings', pages: ['project atlas/meetings', 'project borealis/meetings'] };
const UNIQUE_LEAF = { name: 'notes', page: 'project atlas/notes' };
const EXACT = 'bob';

describe('page resolution against the fixture graph', () => {
  let client: LogseqClient;
  let calls: string[];
  let journalPageId: number;

  const countedCalls = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: number }> => {
    const before = calls.length;
    const result = await run();
    return { result, calls: calls.length - before };
  };

  beforeAll(async () => {
    ({ client } = await connectFixture());
    const rows = await client.executeDatalogQuery<Array<[number]>>(
      '[:find ?p :in $ ?n :where [?p :block/name ?n]]', JOURNAL.name
    );
    journalPageId = rows[0][0];
    // Count every API call the tools under test make
    ({ calls } = recordCalls(client));
  });

  it('resolves an exact name with one query and no extra calls', async () => {
    const { result, calls } = await countedCalls(() => getPageOutline(client, EXACT.toUpperCase()));

    expect(result.page).toBe('Bob');
    expect(result.resolvedFrom).toBeUndefined();
    // The resolver's one query, then the outline's
    expect(calls).toBe(2);
  });

  describe('ISO dates', () => {
    it('resolves an ISO date to the journal page by journal-day, in one query', async () => {
      const { result, calls } = await countedCalls(() => getPageOutline(client, JOURNAL.iso));

      expect(result.resolvedFrom).toEqual({ name: JOURNAL.iso, matchedBy: 'journal-date', resolvedTo: 'Jan 6th, 2025' });
      expect(calls).toBe(2);
    });

    it('returns the journal page from get_page, saying how it was found', async () => {
      const page = await getPage(client, JOURNAL.iso, false);

      expect(page.journalDay).toBe(JOURNAL.day);
      expect(page.resolvedFrom).toEqual({ name: JOURNAL.iso, matchedBy: 'journal-date', resolvedTo: 'Jan 6th, 2025' });
    });

    it('builds context and backlinks for an ISO date', async () => {
      const context = await buildContextForTopic(client, JOURNAL.iso);
      const backlinks = await getBacklinks(client, JOURNAL.iso);

      expect(context.mainPage.id).toBe(journalPageId);
      expect(context.resolvedFrom?.matchedBy).toBe('journal-date');
      // Nothing links that journal
      expect(backlinks ?? []).toEqual([]);
    });

    it('reports a date with no journal as not found without a page-list call', async () => {
      const { result, calls } = await countedCalls(() => getPageOutline(client, '1999-01-01').catch(e => e));

      expect(result).toBeInstanceOf(PageNotFoundError);
      expect(calls).toBe(1);
    });
  });

  describe('aliases', () => {
    it('resolves an alias declared by one page to that page, in one query', async () => {
      const { result, calls } = await countedCalls(() => getPageOutline(client, UNIQUE.stub));

      expect(result.page).toBe('project atlas');
      expect(result.resolvedFrom).toEqual({ name: UNIQUE.stub, matchedBy: 'alias', resolvedTo: UNIQUE.source });
      expect(calls).toBe(2);
    });

    it('returns the declaring page from get_page and build_context', async () => {
      const page = await getPage(client, UNIQUE.stub, false);
      const context = await buildContextForTopic(client, UNIQUE.stub);

      expect(page.name).toBe(UNIQUE.source);
      expect(page.resolvedFrom).toEqual({ name: UNIQUE.stub, matchedBy: 'alias', resolvedTo: UNIQUE.source });
      expect(context.mainPage.name).toBe(UNIQUE.source);
      expect(context.resolvedFrom?.matchedBy).toBe('alias');
    });

    it('returns candidates, not a guess, for an alias declared by several pages', async () => {
      const { result, calls } = await countedCalls(() => getPageOutline(client, SHARED.stub).catch(e => e));

      expect(result).toBeInstanceOf(AmbiguousPageError);
      const error = result as AmbiguousPageError;
      expect(error.totalCandidates).toBe(2);
      expect(error.candidates.map(c => c.name).sort()).toEqual(SHARED.sources);
      expect(error.candidates.map(c => c.originalName).sort()).toEqual(SHARED.sources);
      for (const c of error.candidates) {
        expect(c.matchedBy).toBe('alias');
        expect(typeof c.reason === 'string' && c.reason.length > 0).toBe(true);
      }
      // The resolver's one query, and no outline query: there is no page to outline
      expect(calls).toBe(1);
    });

    it('throws AmbiguousPageError from get_page and get_backlinks without picking a page', async () => {
      await expect(getPage(client, SHARED.stub, false)).rejects.toBeInstanceOf(AmbiguousPageError);
      await expect(getBacklinks(client, SHARED.stub)).rejects.toBeInstanceOf(AmbiguousPageError);
    });

    it('skips an ambiguous topic in get_context_for_query with an ambiguous_page warning', async () => {
      const result = await getContextForQuery(client, `about [[${SHARED.stub}]]`);
      const warning = result.warnings.find(w => w.code === 'ambiguous_page');

      expect(warning?.candidates?.map(c => c.name).sort()).toEqual(SHARED.sources);
      expect(result.contexts).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('namespace leaves', () => {
    it('returns candidates for a leaf used under several namespaces, in two queries', async () => {
      const { result, calls } = await countedCalls(() => getPageOutline(client, LEAF.name).catch(e => e));

      expect(result).toBeInstanceOf(AmbiguousPageError);
      const error = result as AmbiguousPageError;
      expect(error.totalCandidates).toBe(2);
      expect(error.candidates.map(c => c.name).sort()).toEqual(LEAF.pages);
      expect(error.candidates.every(c => c.matchedBy === 'namespace-leaf')).toBe(true);
      expect(calls).toBe(2);
    });

    it('resolves a leaf used once to its page, in two queries', async () => {
      const { result, calls } = await countedCalls(() => getPageOutline(client, UNIQUE_LEAF.name));

      expect(result.page).toBe('project atlas/notes');
      expect(result.resolvedFrom).toMatchObject({ name: UNIQUE_LEAF.name, matchedBy: 'namespace-leaf', resolvedTo: UNIQUE_LEAF.page });
      // The resolver's two queries, then the outline's
      expect(calls).toBe(3);
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
        expect(await searchByRelationship(client, MISSING, EXACT, type).catch(e => e)).toBeInstanceOf(PageNotFoundError);
        expect(await searchByRelationship(client, EXACT, MISSING, type).catch(e => e)).toBeInstanceOf(PageNotFoundError);
      }
    });

    it('get_concept_evolution, get_concept_network and search_by_relationship return candidates for a shared alias', async () => {
      const errors = [
        await getConceptEvolution(client, SHARED.stub).catch(e => e),
        await getConceptNetwork(client, SHARED.stub, 1).catch(e => e),
        await searchByRelationship(client, SHARED.stub, EXACT, 'references').catch(e => e),
        await searchByRelationship(client, EXACT, SHARED.stub, 'references').catch(e => e)
      ];
      for (const error of errors) {
        expect(error instanceof AmbiguousPageError).toBe(true);
        expect(error.totalCandidates).toBe(2);
      }
    });

    it('get_backlinks, get_concept_evolution and search_by_relationship say which page an alias stood for', async () => {
      const { meta } = await getBacklinksWithMeta(client, UNIQUE.stub);
      const evolution = await getConceptEvolution(client, UNIQUE.stub);
      const relationship = await searchByRelationship(client, UNIQUE.stub, EXACT, 'references');

      expect(meta?.resolvedFrom).toEqual({ name: UNIQUE.stub, matchedBy: 'alias', resolvedTo: UNIQUE.source });
      expect(evolution.resolvedFrom?.matchedBy).toBe('alias');
      expect(relationship.resolvedFrom?.topicA?.matchedBy).toBe('alias');
      expect(relationship.resolvedFrom?.topicB).toBeUndefined();
      // `Let [[Bob]] review the room names` and `... tell [[Bob]].` on project atlas
      expect(relationship.results).toHaveLength(2);
    });

    it('get_page costs one call for an exact name of a page with a file', async () => {
      const { result, calls } = await countedCalls(() => getPage(client, EXACT, false));

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

    it('suggests close page names for a typo', async () => {
      // A fuzzy match needs every letter of the name in order, so a dropped letter matches
      const error = await getPage(client, 'projet atlas', false).catch(e => e);

      expect(error instanceof PageNotFoundError).toBe(true);
      expect(error.suggestions).toEqual(['project atlas', 'project atlas/notes', 'project atlas/meetings']);
    });

    it('costs the first lookup, two queries and one getAllPages call on the not-found path', async () => {
      const { calls } = await countedCalls(() => getPage(client, 'no such page 41 probe', false).catch(() => null));

      // Editor.getPage (null) + resolve + namespace-leaf (Datalog) + getAllPages for suggestions
      expect(calls).toBe(4);
    });
  });

  it('made Datalog queries for its lookups', () => {
    expect(calls.filter(method => method === 'logseq.DB.datascriptQuery').length).toBeGreaterThan(0);
  });
});
