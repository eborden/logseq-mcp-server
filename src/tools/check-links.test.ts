import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { checkLinks, checkProse, checkRefsPreserved, MAX_LINK_TERMS } from './check-links.js';
import { LogseqClient } from '../client.js';
import { InvalidParameterError, LogSeqNotRunningError } from '../errors.js';

/**
 * A page in a fake graph. `file: false` is a page LogSeq made for a link or an
 * alias, with no file. `aliases` are the page's own `alias::` values.
 */
interface FakePage {
  name: string;
  file?: boolean;
  aliases?: string[];
}

/**
 * A client whose one Datalog query answers `linkTargets` from `pages` the way
 * LogSeq does: an alias value is also a file-less page of that name, linked back
 * to the declaring page. Counts every call, so the tests can pin them.
 */
function fakeGraph(pages: FakePage[]) {
  type Entity = { id: number; name: string; 'original-name': string; file?: { id: number } };
  const entities = new Map<string, Entity>();
  const aliasOf = new Map<string, Entity[]>();
  let nextId = 1;
  const entity = (originalName: string, withFile: boolean): Entity => {
    const key = originalName.toLowerCase();
    let found = entities.get(key);
    if (!found) {
      found = { id: nextId++, name: key, 'original-name': originalName };
      entities.set(key, found);
    }
    if (withFile) found.file = { id: 1000 + found.id };
    return found;
  };
  for (const page of pages) entity(page.name, page.file !== false);
  for (const page of pages) {
    const declaring = entities.get(page.name.toLowerCase())!;
    for (const alias of page.aliases ?? []) {
      const target = entity(alias, false);
      aliasOf.set(target.name, [...(aliasOf.get(target.name) ?? []), declaring]);
      // Stored both ways, as LogSeq does
      aliasOf.set(declaring.name, [...(aliasOf.get(declaring.name) ?? []), target]);
    }
  }

  const executeDatalogQuery = vi.fn(async (query: string, names: string[]) => {
    expect(query).toContain(':in $ [?n ...]');
    return names.flatMap(n => {
      const rows: unknown[] = [];
      const exact = entities.get(n);
      if (exact) rows.push([exact, 'name', n]);
      for (const source of aliasOf.get(n) ?? []) rows.push([source, 'alias', n]);
      return rows;
    });
  });
  const callAPI = vi.fn(async () => {
    throw new Error('check_links makes no Editor calls');
  });
  return { client: { executeDatalogQuery, callAPI } as unknown as LogseqClient, executeDatalogQuery, callAPI };
}

// ---------------------------------------------------------------- the script's fixture

const fixture = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../tests/fixtures/graph-linking/${path}`, import.meta.url)), 'utf8');

/**
 * `pages.txt` lists the pages as `logseq_list_pages` names them (#171), so an alias is not a line of its own;
 * the one alias the fixture's pages declare is added here (`Priya` has `alias:: Priya Raghavan`).
 */
function fixtureGraph() {
  const titles = fixture('pages.txt').split('\n').map(t => t.trim()).filter(Boolean);
  return fakeGraph(titles.map(name => (name === 'Priya' ? { name, aliases: ['Priya Raghavan'] } : { name })));
}

const baseline = fixture('journals/2024_03_11.md');

describe('checkLinks: the cases of check-link-safety.sh (tests/fixtures/graph-linking)', () => {
  it('passes the expected result: prose kept, brackets balanced, every ref resolves (script exit 0)', async () => {
    const { client, executeDatalogQuery } = fixtureGraph();

    const result = await checkLinks(client, baseline, fixture('expected/2024_03_11.md'));

    expect(result.ok).toBe(true);
    expect(result.prose).toEqual({ ok: true });
    expect(result.brackets).toEqual({ ok: true, opens: 5, closes: 5 });
    expect(result.refs).toEqual({
      ok: true,
      resolved: [
        { term: 'Beacon', page: 'Beacon', matchedBy: 'name' },
        { term: 'Devon', page: 'Devon', matchedBy: 'name' },
        // Case differs from the page title: still the same page
        { term: 'NorthWind', page: 'Northwind', matchedBy: 'name' },
        // The alias case: the full name reaches the page that declares it
        { term: 'Priya Raghavan', page: 'Priya', matchedBy: 'alias' },
        { term: 'Quarterly Planning', page: 'Quarterly Planning', matchedBy: 'name' },
      ],
      unresolved: [],
      ambiguous: [],
    });
    expect(result.refsPreserved).toEqual({ ok: true, removed: [] });
    // The script's report line: refs before 1, after 5, added 4
    expect(result.totals).toEqual({ refsBefore: 1, refsAfter: 5, terms: 5 });
    expect(result.hasMore).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('fails check 1 alone for negative/reworded.md (script exit 1)', async () => {
    const { client } = fixtureGraph();

    const result = await checkLinks(client, baseline, fixture('negative/reworded.md'));

    expect(result.ok).toBe(false);
    expect(result.prose.ok).toBe(false);
    // `structured logs` became `Structured Logging`: the first byte that differs is the `S`
    expect(result.prose.firstDifference).toMatchObject({ line: 8 });
    expect(result.prose.firstDifference!.before).toContain('structured logs before');
    expect(result.prose.firstDifference!.after).toContain('Structured Logging before');
    expect(result.brackets.ok).toBe(true);
    // The page exists, so check 3 passes: rewording is caught by check 1 alone
    expect(result.refs.ok).toBe(true);
    expect(result.refsPreserved.ok).toBe(true);
  });

  it('fails checks 1 and 3 for negative/invented-page.md (script exit 1)', async () => {
    const { client } = fixtureGraph();

    const result = await checkLinks(client, baseline, fixture('negative/invented-page.md'));

    expect(result.ok).toBe(false);
    expect(result.prose.ok).toBe(false);
    expect(result.refs.ok).toBe(false);
    expect(result.refs.unresolved).toEqual(['Retry Budget']);
  });

  it('fails check 3 alone for negative/unresolved-only.md (script exit 1)', async () => {
    const { client } = fixtureGraph();

    const result = await checkLinks(client, baseline, fixture('negative/unresolved-only.md'));

    expect(result.ok).toBe(false);
    expect(result.prose).toEqual({ ok: true });
    expect(result.brackets.ok).toBe(true);
    expect(result.refsPreserved.ok).toBe(true);
    expect(result.refs.ok).toBe(false);
    expect(result.refs.unresolved).toEqual(['retry budget']);
  });

  it('passes an unchanged note: linking nothing is safe, as the script says', async () => {
    const { client } = fixtureGraph();

    const result = await checkLinks(client, baseline, baseline);

    expect(result.ok).toBe(true);
    expect(result.totals).toEqual({ refsBefore: 1, refsAfter: 1, terms: 1 });
  });
});

// ---------------------------------------------------------------- the bare variant (#169)

const fixtureDir = fileURLToPath(new URL('../../tests/fixtures/graph-linking/', import.meta.url));
const pageFiles = (dir: string) => readdirSync(`${fixtureDir}${dir}`).filter(f => f.endsWith('.md'));
/** The bare graph's pages: the base `pages/`, with the same-named files of `variants/bare/pages/` replacing theirs. */
function bareGraphPages(): Map<string, string> {
  const pages = new Map<string, string>();
  for (const f of pageFiles('pages')) pages.set(f, fixture(`pages/${f}`));
  for (const f of pageFiles('variants/bare/pages')) pages.set(f, fixture(`variants/bare/pages/${f}`));
  return pages;
}

describe('checkLinks: the bare variant (tests/fixtures/graph-linking/variants/bare)', () => {
  it('only overrides pages that exist in the base graph, so no page is added or removed', () => {
    const base = pageFiles('pages');
    for (const f of pageFiles('variants/bare/pages')) expect(base).toContain(f);
    expect([...bareGraphPages().keys()].sort()).toEqual([...base].sort());
  });

  it('leaves nothing that ties the bare first name to the note: no other page mentions it, and its own page links nothing', () => {
    const pages = bareGraphPages();

    // Pinned exactly: any property, link or "Engineer on Atlas Squad" would tie him to the roster
    expect(
      pages.get('Devon.md')?.trim(),
      'variants/bare/pages/Devon.md must hold only "- Engineer." (nothing may tie Devon to a roster page)'
    ).toBe('- Engineer.');
    for (const [file, text] of pages) {
      if (file !== 'Devon.md') expect(text, `${file} mentions Devon`).not.toMatch(/devon/i);
      // A property value is a ref to that page in LogSeq, so a `key:: ...Atlas Squad...` line anywhere in the
      // graph would corroborate like a roster entry. The roster page itself has no such line.
      for (const line of text.split('\n')) {
        if (/^\s*(- )?[\w-]+::/.test(line) && /atlas squad/i.test(line)) {
          throw new Error(`${file} has a property that refs the roster page: ${line.trim()}`);
        }
      }
    }
    // The premise is an exact title match, so the page and its name in pages.txt stay
    expect(pages.has('Devon.md')).toBe(true);
    expect(fixture('pages.txt')).toMatch(/^Devon$/m);
  });

  it('passes its expected result: Devon is plain, the single-referent matches still link', async () => {
    const { client } = fixtureGraph();
    const expected = fixture('variants/bare/expected/2024_03_11.md');

    const result = await checkLinks(client, baseline, expected);

    expect(expected).toContain('; Devon took the rollback owner slot.');
    expect(result.ok).toBe(true);
    expect(result.refs).toEqual({
      ok: true,
      resolved: [
        { term: 'Beacon', page: 'Beacon', matchedBy: 'name' },
        { term: 'NorthWind', page: 'Northwind', matchedBy: 'name' },
        { term: 'Priya Raghavan', page: 'Priya', matchedBy: 'alias' },
        { term: 'Quarterly Planning', page: 'Quarterly Planning', matchedBy: 'name' },
      ],
      unresolved: [],
      ambiguous: [],
    });
    expect(result.totals).toEqual({ refsBefore: 1, refsAfter: 4, terms: 4 });
  });

  it('differs from the roster graph result in the Devon ref alone', () => {
    const roster = fixture('expected/2024_03_11.md');
    const bare = fixture('variants/bare/expected/2024_03_11.md');

    expect(roster.replace('[[Devon]]', 'Devon')).toBe(bare);
  });

  it('cannot tell the two graphs apart: the roster result also passes the gate, which does not judge identity', async () => {
    const { client } = fixtureGraph();

    const result = await checkLinks(client, baseline, fixture('expected/2024_03_11.md'));

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- check 1, prose

const people = () => fakeGraph([{ name: 'Alice' }, { name: 'Bob' }]);

describe('checkLinks: prose', () => {
  it('accepts brackets on a note that already had refs, by stripping both sides', async () => {
    const result = await checkLinks(people().client, '[[Alice]] met Bob', '[[Alice]] met [[Bob]]');
    expect(result.prose).toEqual({ ok: true });
  });

  it('treats a case change as a change (bracketing the page spelling, not the prose)', async () => {
    const result = await checkLinks(people().client, 'alice met Bob', '[[Alice]] met Bob');

    expect(result.prose).toEqual({
      ok: false,
      firstDifference: { line: 1, column: 1, before: 'alice met Bob', after: 'Alice met Bob' },
    });
  });

  it('reports the line and column of the first difference, on the texts with brackets removed', async () => {
    const result = await checkLinks(people().client, 'first line\nAlice met Bob today', 'first line\n[[Alice]] met [[Bob]] yesterday');

    expect(result.prose.firstDifference).toEqual({
      line: 2,
      column: 15,
      before: 'Alice met Bob today',
      after: 'Alice met Bob yesterday',
    });
  });

  it('flags dropped text, including at the end', async () => {
    const result = await checkLinks(people().client, 'Alice met Bob.', '[[Alice]] met [[Bob]]');
    expect(result.prose.firstDifference).toEqual({ line: 1, column: 14, before: 'Alice met Bob.', after: 'Alice met Bob' });
  });

  it('cuts long excerpts around the difference', async () => {
    const long = 'x'.repeat(200);
    const result = await checkLinks(people().client, `${long}A${long}`, `${long}B${long}`);

    const { before, after } = result.prose.firstDifference!;
    expect(before).toBe(`...${'x'.repeat(30)}A${'x'.repeat(49)}...`);
    expect(after).toBe(`...${'x'.repeat(30)}B${'x'.repeat(49)}...`);
  });

  it('counts columns in characters, not UTF-16 units, and never splits an emoji', async () => {
    const result = await checkLinks(people().client, '😀😀 Café 😀', '😀😀 Cafe 😀');

    expect(result.prose.firstDifference).toEqual({ line: 1, column: 7, before: '😀😀 Café 😀', after: '😀😀 Cafe 😀' });
  });

  it('points at a whole emoji when two emoji differ', async () => {
    const result = await checkLinks(people().client, 'a 😀', 'a 😁');
    expect(result.prose.firstDifference).toEqual({ line: 1, column: 3, before: 'a 😀', after: 'a 😁' });
  });

  it('fails an empty after against a non-empty before, with no LogSeq call', async () => {
    const { client, executeDatalogQuery } = people();

    const result = await checkLinks(client, 'Alice met Bob', '');

    expect(result.ok).toBe(false);
    expect(result.prose.firstDifference).toEqual({ line: 1, column: 1, before: 'Alice met Bob', after: '' });
    expect(result.brackets).toEqual({ ok: true, opens: 0, closes: 0 });
    expect(result.refs).toEqual({ ok: true, resolved: [], unresolved: [], ambiguous: [] });
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('passes two empty texts, with no LogSeq call', async () => {
    const { client, executeDatalogQuery } = people();

    const result = await checkLinks(client, '', '');

    expect(result.ok).toBe(true);
    expect(result.totals).toEqual({ refsBefore: 0, refsAfter: 0, terms: 0 });
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- check 2, brackets

describe('checkLinks: brackets', () => {
  it('fails unbalanced brackets and counts both sides', async () => {
    const result = await checkLinks(people().client, 'Alice met Bob', '[[Alice]] met [[Bob');

    expect(result.ok).toBe(false);
    expect(result.brackets).toEqual({ ok: false, opens: 2, closes: 1 });
  });

  it('fails a ref opened inside another, and says on which line', async () => {
    const result = await checkLinks(people().client, 'intro\nAlice met Bob', 'intro\n[[Alice met [[Bob]]]]');

    expect(result.ok).toBe(false);
    // Balanced (2 and 2), but nested
    expect(result.brackets).toEqual({
      ok: false,
      opens: 2,
      closes: 2,
      nested: { line: 2, excerpt: '[[Alice met [[Bob]]]]' },
    });
  });

  it('counts brackets as grep -o does: a run of three is one pair, not two', async () => {
    const result = await checkLinks(people().client, '[Alice]', '[[[Alice]]]');
    expect(result.brackets).toEqual({ ok: true, opens: 1, closes: 1 });
  });

  it('does not call it nesting when the second [[ is on another line, as the line-based script does', async () => {
    const result = await checkLinks(people().client, 'Alice\nBob', '[[Alice\n[[Bob]]');

    expect(result.brackets.nested).toBeUndefined();
    // Still unbalanced, which is what fails it
    expect(result.brackets).toMatchObject({ ok: false, opens: 2, closes: 1 });
  });
});

// ---------------------------------------------------------------- check 3, refs resolve

describe('checkLinks: refs resolve', () => {
  it('resolves an alias to the page that declares it', async () => {
    const { client } = fakeGraph([{ name: 'Project Atlas', aliases: ['atlas'] }]);

    const result = await checkLinks(client, 'about atlas', 'about [[atlas]]');

    expect(result.ok).toBe(true);
    expect(result.refs.resolved).toEqual([{ term: 'atlas', page: 'Project Atlas', matchedBy: 'alias' }]);
  });

  it('counts a file-less page as a page', async () => {
    const { client } = fakeGraph([{ name: 'my page', file: false }]);

    const result = await checkLinks(client, 'see my page', 'see [[my page]]');

    expect(result.ok).toBe(true);
    expect(result.refs.resolved).toEqual([{ term: 'my page', page: 'my page', matchedBy: 'name' }]);
  });

  it('matches unicode names case-insensitively', async () => {
    const { client } = fakeGraph([{ name: 'Café Société' }, { name: 'Ärger' }]);

    const result = await checkLinks(client, 'CAFÉ SOCIÉTÉ and ärger', '[[CAFÉ SOCIÉTÉ]] and [[ärger]]');

    expect(result.ok).toBe(true);
    expect(result.refs.resolved.map(r => r.page)).toEqual(['Café Société', 'Ärger']);
  });

  it('fails a new ref to an alias two pages declare, and lists both', async () => {
    const { client } = fakeGraph([
      { name: 'Project Borealis', aliases: ['roadmap'] },
      { name: 'Project Cascade', aliases: ['roadmap'] },
    ]);

    const result = await checkLinks(client, 'the roadmap', 'the [[roadmap]]');

    expect(result.ok).toBe(false);
    expect(result.refs).toEqual({
      ok: false,
      resolved: [],
      unresolved: [],
      ambiguous: [
        { term: 'roadmap', candidates: ['Project Borealis', 'Project Cascade'], totalCandidates: 2, preexisting: false },
      ],
    });
  });

  it('reports an ambiguous ref the note already had, without failing on it', async () => {
    const { client } = fakeGraph([
      { name: 'Project Borealis', aliases: ['roadmap'] },
      { name: 'Project Cascade', aliases: ['roadmap'] },
      { name: 'Alice' },
    ]);

    const result = await checkLinks(client, 'Alice and the [[roadmap]]', '[[Alice]] and the [[roadmap]]');

    expect(result.ok).toBe(true);
    expect(result.refs.ambiguous).toEqual([
      { term: 'roadmap', candidates: ['Project Borealis', 'Project Cascade'], totalCandidates: 2, preexisting: true },
    ]);
  });

  it('fails a new copy of an ambiguous ref the note already had: the new mention may mean the other page', async () => {
    const { client } = fakeGraph([
      { name: 'Project Borealis', aliases: ['roadmap'] },
      { name: 'Project Cascade', aliases: ['roadmap'] },
    ]);

    const result = await checkLinks(client, '[[roadmap]] and the Roadmap', '[[roadmap]] and the [[Roadmap]]');

    expect(result.ok).toBe(false);
    expect(result.refs.ok).toBe(false);
    // Copies are counted case-insensitively: [[Roadmap]] is a second ref to the same name
    expect(result.refs.ambiguous.map(a => [a.term, a.preexisting])).toEqual([
      ['Roadmap', false],
      ['roadmap', false],
    ]);
    expect(result.refsPreserved.ok).toBe(true);
  });

  it('warns when an ambiguous alias has more candidates than it lists', async () => {
    const { client } = fakeGraph(Array.from({ length: 12 }, (_, i) => ({ name: `p${String(i).padStart(2, '0')}`, aliases: ['x'] })));

    const result = await checkLinks(client, 'x', '[[x]]');

    expect(result.refs.ambiguous[0]).toMatchObject({ totalCandidates: 12 });
    expect(result.refs.ambiguous[0].candidates).toHaveLength(10);
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'candidates_truncated' })]);
    expect(result.hasMore).toBe(false);
  });

  it('keeps each spelling as written but asks LogSeq about each page once', async () => {
    const { client, executeDatalogQuery } = people();

    const result = await checkLinks(client, 'Alice, alice', '[[Alice]], [[alice]]');

    expect(result.refs.resolved).toEqual([
      { term: 'Alice', page: 'Alice', matchedBy: 'name' },
      { term: 'alice', page: 'Alice', matchedBy: 'name' },
    ]);
    expect(executeDatalogQuery.mock.calls[0][1]).toEqual(['alice']);
  });

  it('trims a term before resolving it, as LogSeq does (the script does not)', async () => {
    const { client, executeDatalogQuery } = people();

    const result = await checkLinks(client, 'met  Alice ', 'met [[ Alice ]]');

    expect(result.ok).toBe(true);
    expect(result.refs.resolved).toEqual([{ term: ' Alice ', page: 'Alice', matchedBy: 'name' }]);
    expect(executeDatalogQuery.mock.calls[0][1]).toEqual(['alice']);
  });

  it('treats a blank ref as unresolved without asking LogSeq about it', async () => {
    const { client, executeDatalogQuery } = people();

    const result = await checkLinks(client, 'a  b', 'a [[ ]] b');

    expect(result.refs.unresolved).toEqual([' ']);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('resolves N distinct terms in one query (no call per term)', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `page ${i}`);
    const { client, executeDatalogQuery, callAPI } = fakeGraph(names.map(name => ({ name })));
    const text = names.join(', ');

    const result = await checkLinks(client, text, names.map(n => `[[${n}]]`).join(', '));

    expect(result.ok).toBe(true);
    expect(result.refs.resolved).toHaveLength(40);
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(executeDatalogQuery.mock.calls[0][1]).toHaveLength(40);
    expect(callAPI).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_LINK_TERMS} distinct terms before any LogSeq call`, async () => {
    const { client, executeDatalogQuery } = people();
    const after = Array.from({ length: MAX_LINK_TERMS + 1 }, (_, i) => `[[t${i}]]`).join(' ');

    await expect(checkLinks(client, '', after)).rejects.toBeInstanceOf(InvalidParameterError);
    expect(executeDatalogQuery).not.toHaveBeenCalled();
  });

  it('fails closed with a warning when LogSeq answers null, instead of calling the refs missing', async () => {
    const executeDatalogQuery = vi.fn(async () => null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

    const result = await checkLinks(client, 'Alice', '[[Alice]]');

    expect(result.ok).toBe(false);
    expect(result.refs).toEqual({ ok: false, resolved: [], unresolved: [], ambiguous: [] });
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'refs_unchecked' })]);
  });

  it('lets a connection error through rather than report the refs as missing', async () => {
    const executeDatalogQuery = vi.fn(async () => {
      throw new LogSeqNotRunningError('http://localhost:12315');
    });
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

    await expect(checkLinks(client, 'Alice', '[[Alice]]')).rejects.toBeInstanceOf(LogSeqNotRunningError);
  });
});

// ---------------------------------------------------------------- check 4, refs preserved

describe('checkLinks: refs preserved (a tightening over the script)', () => {
  it('fails when a ref is removed, which the prose check alone passes', async () => {
    const result = await checkLinks(people().client, '[[Alice]] met Bob', 'Alice met [[Bob]]');

    // Stripped, both read "Alice met Bob": the script would pass this
    expect(result.prose).toEqual({ ok: true });
    expect(result.refsPreserved).toEqual({ ok: false, removed: [{ term: 'Alice', before: 1, after: 0 }] });
    expect(result.ok).toBe(false);
  });

  it('fails when one copy of a duplicated ref is removed', async () => {
    const result = await checkLinks(people().client, '[[Alice]] met [[Alice]]', '[[Alice]] met Alice');

    expect(result.refsPreserved).toEqual({ ok: false, removed: [{ term: 'Alice', before: 2, after: 1 }] });
    expect(result.ok).toBe(false);
  });

  it('passes when the refs stay but move between mentions', async () => {
    const result = await checkLinks(
      people().client,
      '[[Alice]] met Bob, then Alice met [[Bob]]',
      'Alice met [[Bob]], then [[Alice]] met Bob'
    );

    expect(result.refsPreserved).toEqual({ ok: true, removed: [] });
    expect(result.ok).toBe(true);
  });

  it('ignores the order of refs: the same refs in another order are all kept', () => {
    expect(checkRefsPreserved('[[Alice]] then [[Bob]]', '[[Bob]] then [[Alice]]')).toEqual({ ok: true, removed: [] });
  });

  it('counts refs by page name, so a ref moved to a mention spelled in another case is kept', async () => {
    const result = await checkLinks(people().client, '[[alice]] met Alice', 'alice met [[Alice]]');

    expect(result.prose).toEqual({ ok: true });
    expect(result.refsPreserved).toEqual({ ok: true, removed: [] });
    expect(result.ok).toBe(true);
  });

  it('reports a removed ref by its first spelling in before, counting every casing', () => {
    expect(checkRefsPreserved('[[Alice]] and [[ALICE]]', '[[alice]] and ALICE')).toEqual({
      ok: false,
      removed: [{ term: 'Alice', before: 2, after: 1 }],
    });
  });

  it('still fails a ref respelled in place, through the prose check', async () => {
    const result = await checkLinks(people().client, '[[Alice]]', '[[alice]]');

    expect(result.refsPreserved).toEqual({ ok: true, removed: [] });
    expect(result.prose.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------- excerpts, order and limits

describe('checkProse: the excerpt around the first difference', () => {
  it('stops at the end of the line when more lines follow', () => {
    const result = checkProse('cat sat\nnext line', 'cat hat\nnext line');

    expect(result.firstDifference).toEqual({ line: 1, column: 5, before: 'cat sat', after: 'cat hat' });
  });

  it('keeps the whole line when the difference is the newline that ends it', () => {
    // Index 3 is the `\n` in before: the excerpt is the line that newline ends, not the one after it
    const result = checkProse('abc\ndef', 'abc');

    expect(result.firstDifference).toEqual({ line: 1, column: 4, before: 'abc', after: 'abc' });
  });

  it('starts the excerpt at the line start when the difference is on a later line', () => {
    const result = checkProse('one\ntwo three', 'one\ntwo THREE');

    expect(result.firstDifference).toEqual({ line: 2, column: 5, before: 'two three', after: 'two THREE' });
  });

  it('adds no ellipsis to a stretch before the difference of exactly 30 characters', () => {
    const lead = 'x'.repeat(30);
    const result = checkProse(`${lead}A`, `${lead}B`);

    expect(result.firstDifference).toEqual({ line: 1, column: 31, before: `${lead}A`, after: `${lead}B` });
  });

  it('cuts at 31 characters before the difference, keeping 30 behind an ellipsis', () => {
    const result = checkProse(`${'x'.repeat(31)}A`, `${'x'.repeat(31)}B`);

    expect(result.firstDifference).toMatchObject({ before: `...${'x'.repeat(30)}A`, after: `...${'x'.repeat(30)}B` });
  });

  it('adds no ellipsis to a stretch from the difference on of exactly 50 characters', () => {
    const tail = 'y'.repeat(49);
    const result = checkProse(`A${tail}`, `B${tail}`);

    expect(result.firstDifference).toMatchObject({ before: `A${tail}`, after: `B${tail}` });
  });

  it('cuts at 51 characters from the difference on, keeping 50 before an ellipsis', () => {
    const tail = 'y'.repeat(50);
    const result = checkProse(`A${tail}`, `B${tail}`);

    expect(result.firstDifference).toMatchObject({ before: `A${tail.slice(1)}...`, after: `B${tail.slice(1)}...` });
  });
});

describe('checkRefsPreserved: the order of removed refs', () => {
  it('lists removed refs sorted by term, whatever order before had them in', () => {
    const result = checkRefsPreserved('[[Bob]] [[Carol]] [[Alice]]', 'Bob Carol Alice');

    expect(result.removed.map(r => r.term)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('sorts by UTF-16 code unit, so a capital comes before a lowercase letter', () => {
    const result = checkRefsPreserved('[[alice]] [[Bob]]', 'alice Bob');

    expect(result.removed.map(r => r.term)).toEqual(['Bob', 'alice']);
  });
});

describe('checkLinks: the order of terms', () => {
  it('checks and lists the terms sorted, whatever order after has them in', async () => {
    const { client, executeDatalogQuery } = fakeGraph([{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }]);

    const result = await checkLinks(client, 'Bob Carol Alice', '[[Bob]] [[Carol]] [[Alice]]');

    expect(result.refs.resolved.map(r => r.term)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(executeDatalogQuery.mock.calls[0][1]).toEqual(['alice', 'bob', 'carol']);
  });

  it('sorts by UTF-16 code unit, so a capital comes before a lowercase letter', async () => {
    const { client, executeDatalogQuery } = fakeGraph([{ name: 'Bob' }, { name: 'alice' }]);

    const result = await checkLinks(client, 'alice Bob', '[[alice]] [[Bob]]');

    expect(result.refs.resolved.map(r => r.term)).toEqual(['Bob', 'alice']);
    expect(executeDatalogQuery.mock.calls[0][1]).toEqual(['bob', 'alice']);
  });

  it('lists unresolved terms sorted too', async () => {
    const { client } = fakeGraph([]);

    const result = await checkLinks(client, 'zed amy kim', '[[zed]] [[amy]] [[kim]]');

    expect(result.refs.unresolved).toEqual(['amy', 'kim', 'zed']);
  });

  it('sorts a long list that was written in a scrambled order', async () => {
    const names = Array.from({ length: 70 }, (_, i) => `page ${String(i).padStart(2, '0')}`);
    const { client, executeDatalogQuery } = fakeGraph(names.map(name => ({ name })));
    // 29 is coprime to 70, so this visits every name once, out of order
    const scrambled = names.map((_, i) => names[(i * 29) % 70]);

    const result = await checkLinks(client, scrambled.join(' '), scrambled.map(n => `[[${n}]]`).join(' '));

    expect(result.refs.resolved.map(r => r.term)).toEqual(names);
    expect(executeDatalogQuery.mock.calls[0][1]).toEqual(names);
  });
});

describe('checkLinks: the term limit and its message', () => {
  it(`accepts exactly ${MAX_LINK_TERMS} distinct terms`, async () => {
    const names = Array.from({ length: MAX_LINK_TERMS }, (_, i) => `t${i}`);
    const { client, executeDatalogQuery } = fakeGraph(names.map(name => ({ name })));

    const result = await checkLinks(client, names.join(' '), names.map(n => `[[${n}]]`).join(' '));

    expect(result.ok).toBe(true);
    expect(result.totals).toMatchObject({ terms: MAX_LINK_TERMS });
    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
  });

  it('says which parameter is over, by how many distinct terms, and the limit', async () => {
    const { client } = people();
    const after = Array.from({ length: MAX_LINK_TERMS + 1 }, (_, i) => `[[t${i}]]`).join(' ');

    const error = await checkLinks(client, '', after).catch(e => e);

    expect(error).toBeInstanceOf(InvalidParameterError);
    expect(error.message).toContain("'after'");
    expect(error.message).toContain(`${MAX_LINK_TERMS + 1} distinct [[terms]]`);
    expect(error.message).toContain(`at most ${MAX_LINK_TERMS} distinct [[terms]]`);
  });
});

describe('checkLinks: warnings', () => {
  it('warns of nothing when an ambiguous alias lists every candidate', async () => {
    const { client } = fakeGraph([
      { name: 'Project Borealis', aliases: ['roadmap'] },
      { name: 'Project Cascade', aliases: ['roadmap'] },
    ]);

    const result = await checkLinks(client, 'the roadmap', 'the [[roadmap]]');

    expect(result.refs.ambiguous[0]).toMatchObject({ totalCandidates: 2 });
    expect(result.refs.ambiguous[0].candidates).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('names the term, the total and the number listed when a candidate list is cut', async () => {
    const { client } = fakeGraph(Array.from({ length: 12 }, (_, i) => ({ name: `p${String(i).padStart(2, '0')}`, aliases: ['x'] })));

    const result = await checkLinks(client, 'x', '[[x]]');

    // How many the resolver lists is its cap, not this tool's: read it from the result
    const { candidates, totalCandidates } = result.refs.ambiguous[0];
    expect(candidates.length).toBeLessThan(totalCandidates);
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings;
    expect(warning.code).toBe('candidates_truncated');
    expect(warning.message).toContain(`[[x]] is an alias of ${totalCandidates} pages. Showing ${candidates.length}`);
    expect(warning.message).toContain('the rest');
  });

  it('says how many terms went unchecked, and that this is not the same as missing pages', async () => {
    const executeDatalogQuery = vi.fn(async () => null);
    const client = { executeDatalogQuery, callAPI: vi.fn() } as unknown as LogseqClient;

    const result = await checkLinks(client, 'Alice Bob', '[[Alice]] [[Bob]]');

    const [warning] = result.warnings;
    expect(warning.message).toContain('no answer for the 2 [[terms]]');
    expect(warning.message).toContain('not the same as missing pages');
  });
});
