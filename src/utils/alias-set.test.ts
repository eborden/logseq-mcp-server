import { describe, it, expect, vi } from 'vitest';
import {
  MAX_ALIAS_SET_SIZE,
  aliasIds,
  aliasNames,
  aliasSetWarnings,
  compareAliasNames,
  hasAliasLinks,
  hasAliases,
  resolveAliasSet,
  resolveAliasSetByName,
  resolveAliasSets,
  resolvedAliases,
  singleAliasSet
} from './alias-set.js';
import { LogseqClient } from '../client.js';
import { LogSeqTimeoutError } from '../errors.js';

// Synthetic fixture modelled on the issue: "Jordan" declares `alias:: Jordan Rivera`
const jordan = { id: 1, name: 'jordan', 'original-name': 'Jordan', alias: [{ id: 2 }] };
const jordanRivera = { id: 2, name: 'jordan rivera', 'original-name': 'Jordan Rivera', alias: [{ id: 1 }] };
const plainPage = { id: 9, name: 'alice', 'original-name': 'Alice' };

const member = (page: { id: number; name: string; 'original-name': string }) => ({
  id: page.id,
  name: page.name,
  'original-name': page['original-name']
});

function fakeClient(rows: unknown[] | (() => Promise<unknown[]>)) {
  const executeDatalogQuery = vi.fn(async () => (typeof rows === 'function' ? rows() : rows));
  return { client: { executeDatalogQuery } as unknown as LogseqClient, executeDatalogQuery };
}

describe('hasAliasLinks', () => {
  it('is true only for a page that carries :block/alias', () => {
    expect(hasAliasLinks(jordan)).toBe(true);
    expect(hasAliasLinks(plainPage)).toBe(false);
    expect(hasAliasLinks({ ...plainPage, alias: [] })).toBe(false);
    expect(hasAliasLinks(null)).toBe(false);
  });
});

describe('resolveAliasSets', () => {
  it('makes no API call for a page without aliases', async () => {
    const { client, executeDatalogQuery } = fakeClient([]);

    const set = await resolveAliasSet(client, plainPage);

    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(aliasIds(set)).toEqual([9]);
    expect(hasAliases(set)).toBe(false);
    expect(resolvedAliases(set)).toEqual({});
  });

  it('unions the page with its aliases in one query, the page asked about first', async () => {
    const { client, executeDatalogQuery } = fakeClient([
      [1, member(jordanRivera)],
      [1, member(jordan)]
    ]);

    const set = await resolveAliasSet(client, jordan);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(aliasIds(set)).toEqual([1, 2]);
    expect(aliasNames(set)).toEqual(['jordan', 'jordan rivera']);
    expect(resolvedAliases(set)).toEqual({ resolvedAliases: ['Jordan', 'Jordan Rivera'] });
  });

  it('gives the same members whichever name of the group is the start', async () => {
    const fromJordan = await resolveAliasSet(
      fakeClient([[1, member(jordan)], [1, member(jordanRivera)]]).client,
      jordan
    );
    const fromRivera = await resolveAliasSet(
      fakeClient([[2, member(jordan)], [2, member(jordanRivera)]]).client,
      jordanRivera
    );

    expect(aliasIds(fromJordan).sort()).toEqual(aliasIds(fromRivera).sort());
    expect(fromRivera.members[0].id).toBe(2);
  });

  it('orders the aliases by name and drops duplicate rows', async () => {
    const zed = { id: 5, name: 'zed', 'original-name': 'Zed' };
    const amy = { id: 4, name: 'amy', 'original-name': 'Amy' };
    const { client } = fakeClient([
      [1, member(zed)], [1, member(amy)], [1, member(zed)], [1, member(jordan)]
    ]);

    const set = await resolveAliasSet(client, jordan);

    expect(aliasNames(set)).toEqual(['jordan', 'amy', 'zed']);
  });

  it('terminates on an alias cycle: the rows are a finite set and the start is not repeated', async () => {
    // A -> B -> C -> A, reported from A with every page appearing once per path
    const b = { id: 2, name: 'b', 'original-name': 'B' };
    const c = { id: 3, name: 'c', 'original-name': 'C' };
    const a = { id: 1, name: 'a', 'original-name': 'A', alias: [{ id: 2 }, { id: 3 }] };
    const { client, executeDatalogQuery } = fakeClient([
      [1, member(a)], [1, member(b)], [1, member(c)], [1, member(a)], [1, member(b)]
    ]);

    const set = await resolveAliasSet(client, a);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(aliasIds(set)).toEqual([1, 2, 3]);
  });

  it('keeps the start page when the query reports no rows for a linked page', async () => {
    const { client } = fakeClient([]);

    const set = await resolveAliasSet(client, jordan);

    expect(aliasIds(set)).toEqual([1]);
    expect(hasAliases(set)).toBe(false);
  });

  it('answers several pages with one query and queries only the pages that have aliases', async () => {
    const { client, executeDatalogQuery } = fakeClient([
      [1, member(jordan)], [1, member(jordanRivera)]
    ]);

    const [a, b] = await resolveAliasSets(client, [jordan, plainPage]);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    const [query] = executeDatalogQuery.mock.calls[0] as unknown as [string];
    expect(query).toContain('[(ground [1]) [?start ...]]');
    expect(aliasIds(a)).toEqual([1, 2]);
    expect(aliasIds(b)).toEqual([9]);
  });

  it('queries a page once when it is passed twice', async () => {
    const { client, executeDatalogQuery } = fakeClient([[1, member(jordan)], [1, member(jordanRivera)]]);

    await resolveAliasSets(client, [jordan, jordan]);

    const [query] = executeDatalogQuery.mock.calls[0] as unknown as [string];
    expect(query).toContain('[(ground [1]) [?start ...]]');
  });

  it('cuts a group above the maximum, keeps the start and says so', async () => {
    const rows = Array.from({ length: MAX_ALIAS_SET_SIZE + 5 }, (_, i) => [
      1,
      { id: 100 + i, name: `n${String(i).padStart(3, '0')}`, 'original-name': `N${i}` }
    ]);
    const { client } = fakeClient(rows);

    const set = await resolveAliasSet(client, jordan);

    expect(set.members).toHaveLength(MAX_ALIAS_SET_SIZE);
    expect(set.members[0].id).toBe(1);
    expect(set.truncated).toBe(true);
    const [warning] = aliasSetWarnings(set);
    expect(warning.code).toBe('alias_set_truncated');
    expect(warning.howToFetchAll).toBeUndefined();
  });

  it('reports no warning for a group within the maximum', async () => {
    const set = await resolveAliasSet(fakeClient([[1, member(jordanRivera)]]).client, jordan);
    expect(aliasSetWarnings(set)).toEqual([]);
  });

  it('keeps the start page alone when LogSeq answers null for the query', async () => {
    const { client, executeDatalogQuery } = fakeClient(null as unknown as unknown[]);

    const set = await resolveAliasSet(client, jordan);

    expect(executeDatalogQuery).toHaveBeenCalledTimes(1);
    expect(aliasIds(set)).toEqual([1]);
  });

  it('skips a member row whose page carries no id', async () => {
    const ghost = { name: 'ghost', 'original-name': 'Ghost' };
    const { client } = fakeClient([[1, member(jordan)], [1, ghost], [1, member(jordanRivera)]]);

    const set = await resolveAliasSet(client, jordan);

    expect(set.members).toEqual([
      { id: 1, name: 'jordan', originalName: 'Jordan' },
      { id: 2, name: 'jordan rivera', originalName: 'Jordan Rivera' }
    ]);
  });

  it('makes no query for a page that has alias links but no id to start from', async () => {
    const ghost = { name: 'ghost', 'original-name': 'Ghost', alias: [{ id: 2 }] };
    const { client, executeDatalogQuery } = fakeClient([[1, member(jordan)]]);

    const sets = await resolveAliasSets(client, [ghost]);

    expect(executeDatalogQuery).not.toHaveBeenCalled();
    expect(sets).toEqual([{ members: [], truncated: false }]);
  });

  it('queries the pages that have an id and alias links when an id-less page comes first', async () => {
    const ghost = { name: 'ghost', 'original-name': 'Ghost', alias: [{ id: 3 }] };
    const { client, executeDatalogQuery } = fakeClient([[1, member(jordan)], [1, member(jordanRivera)]]);

    const [a, b] = await resolveAliasSets(client, [ghost, jordan]);

    const [query] = executeDatalogQuery.mock.calls[0] as unknown as [string];
    expect(query).toContain('[(ground [1]) [?start ...]]');
    expect(a.members).toEqual([]);
    expect(aliasIds(b)).toEqual([1, 2]);
  });

  it('breaks a tie between members of the same name by id, whatever the row order', async () => {
    const twin = (id: number) => ({ id, name: 'twin', 'original-name': 'Twin' });
    const { client } = fakeClient([[1, twin(8)], [1, twin(6)], [1, twin(7)]]);

    const set = await resolveAliasSet(client, jordan);

    expect(aliasIds(set)).toEqual([1, 6, 7, 8]);
  });

  it('keeps a group of exactly the maximum whole and untruncated', async () => {
    const others = Array.from({ length: MAX_ALIAS_SET_SIZE - 1 }, (_, i) => [
      1,
      { id: 100 + i, name: `n${String(i).padStart(3, '0')}`, 'original-name': `N${i}` }
    ]);
    const set = await resolveAliasSet(fakeClient(others).client, jordan);

    expect(set.members).toHaveLength(MAX_ALIAS_SET_SIZE);
    expect(set.truncated).toBe(false);
    expect(aliasSetWarnings(set)).toEqual([]);
  });

  it('cuts a group one page over the maximum, dropping the last by name', async () => {
    // Rows arrive last name first, and ids fall as names rise, so only the name sort decides what is cut
    const others = Array.from({ length: MAX_ALIAS_SET_SIZE }, (_, i) => [
      1,
      { id: 200 - i, name: `n${String(i).padStart(3, '0')}`, 'original-name': `N${i}` }
    ]).reverse();
    const set = await resolveAliasSet(fakeClient(others).client, jordan);

    expect(set.members).toHaveLength(MAX_ALIAS_SET_SIZE);
    expect(set.truncated).toBe(true);
    const names = aliasNames(set);
    expect(names).not.toContain(`n${String(MAX_ALIAS_SET_SIZE - 1).padStart(3, '0')}`);
    expect(names).toContain(`n${String(MAX_ALIAS_SET_SIZE - 2).padStart(3, '0')}`);
  });

  it('propagates an infrastructure error instead of reporting "no aliases"', async () => {
    const { client } = fakeClient(async () => {
      throw new LogSeqTimeoutError('http://127.0.0.1:12315', 30000);
    });

    await expect(resolveAliasSet(client, jordan)).rejects.toBeInstanceOf(LogSeqTimeoutError);
  });
});

describe('resolveAliasSetByName', () => {
  it('returns the group of a page that has aliases, started from the named page', async () => {
    const { client, executeDatalogQuery } = fakeClient([
      [member(jordanRivera), member(jordan)],
      [member(jordanRivera), member(jordanRivera)]
    ]);

    const set = await resolveAliasSetByName(client, 'Jordan Rivera');

    expect(executeDatalogQuery).toHaveBeenCalledWith(expect.any(String), 'jordan rivera');
    expect(set && aliasNames(set)).toEqual(['jordan rivera', 'jordan']);
  });

  it('returns null when the text names no page', async () => {
    expect(await resolveAliasSetByName(fakeClient([]).client, 'migration')).toBeNull();
  });

  it('returns null when the query answers null', async () => {
    expect(await resolveAliasSetByName(fakeClient(null as unknown as unknown[]).client, 'migration')).toBeNull();
  });

  it('returns null when the rows hold only the start page (defensive: LogSeq never sends that alone)', async () => {
    // The start comes back as its own member only through an alias, so a self-row never arrives alone;
    // this pins that a group of one is null.
    const { client } = fakeClient([[member(jordanRivera), member(jordanRivera)]]);

    expect(await resolveAliasSetByName(client, 'Jordan Rivera')).toBeNull();
  });

  it('returns null when no row starts from a page with an id, even if a member has one', async () => {
    const ghost = { name: 'ghost', 'original-name': 'Ghost' };
    const { client } = fakeClient([[ghost, member(jordan)]]);

    expect(await resolveAliasSetByName(client, 'ghost')).toBeNull();
  });

  it('starts from the first row whose page has an id', async () => {
    const ghost = { name: 'ghost', 'original-name': 'Ghost' };
    const { client } = fakeClient([
      [ghost, member(jordan)],
      [member(jordanRivera), member(jordan)],
      [member(jordanRivera), member(jordanRivera)]
    ]);

    const set = await resolveAliasSetByName(client, 'Jordan Rivera');

    expect(set?.members.map(m => m.id)).toEqual([2, 1]);
  });

  it('leaves a member without an id out of the group', async () => {
    const ghost = { name: 'ghost', 'original-name': 'Ghost' };
    const { client } = fakeClient([
      [member(jordanRivera), ghost],
      [member(jordanRivera), member(jordan)]
    ]);

    const set = await resolveAliasSetByName(client, 'Jordan Rivera');

    expect(set?.members.map(m => m.id)).toEqual([2, 1]);
  });
});

describe('singleAliasSet', () => {
  it('holds just the page, read from either key spelling', () => {
    expect(singleAliasSet({ 'db/id': 3, name: 'Bob', originalName: 'Bob' }).members).toEqual([
      { id: 3, name: 'bob', originalName: 'Bob' }
    ]);
  });

  it('holds nothing for a page without an id', () => {
    expect(singleAliasSet({ name: 'ghost', 'original-name': 'Ghost' })).toEqual({ members: [], truncated: false });
  });
});

describe('compareAliasNames', () => {
  const nfc = 'Café';
  const nfd = 'Café';

  it('breaks an en tie by code unit, with the same sign both ways', () => {
    expect(nfc.localeCompare(nfd, 'en')).toBe(0);
    expect(compareAliasNames(nfd, nfc)).toBeLessThan(0);
    expect(compareAliasNames(nfc, nfd)).toBeGreaterThan(0);
  });

  it('is 0 for identical names', () => {
    expect(compareAliasNames(nfc, nfc)).toBe(0);
    expect(compareAliasNames('Jordan', 'Jordan')).toBe(0);
  });

  it('orders pairs that en separates by en, not by code unit', () => {
    // Code-unit order puts 'B' (66) before 'b' (98); en puts 'b' first.
    expect(Math.sign(compareAliasNames('b', 'B'))).toBe(Math.sign('b'.localeCompare('B', 'en')));
    expect(compareAliasNames('b', 'B')).toBeLessThan(0);
    expect(compareAliasNames('B', 'b')).toBeGreaterThan(0);
    expect(compareAliasNames('Zed', 'amy')).toBeGreaterThan(0);
  });
});

describe('resolvedAliases', () => {
  it('sorts names that differ only in accents the same way whatever order they arrive in', () => {
    const accented = { id: 1, name: 'café', originalName: 'Café' };
    const plain = { id: 2, name: 'cafe', originalName: 'Cafe' };
    const set = { members: [accented, plain], truncated: false };

    expect(resolvedAliases(set)).toEqual({ resolvedAliases: ['Cafe', 'Café'] });
    expect(resolvedAliases({ members: [plain, accented], truncated: false })).toEqual({
      resolvedAliases: ['Cafe', 'Café']
    });
  });

  it('orders ties, accent variants and case variants in one fixed order whatever order they arrive in', () => {
    const names = ['Zed', 'côte', 'Amy-b', 'CAFÉ', 'coté', 'Cafe', 'amy b', 'café', 'Amy', 'CAFE', 'cafe', 'Café', 'amy'];
    const expected = ['amy', 'Amy', 'amy b', 'Amy-b', 'cafe', 'Cafe', 'CAFE', 'café', 'Café', 'CAFÉ', 'coté', 'côte', 'Zed'];
    const setOf = (originalNames: string[]) => ({
      members: originalNames.map((originalName, i) => ({ id: i + 1, name: originalName.toLowerCase(), originalName })),
      truncated: false
    });

    expect(resolvedAliases(setOf(names))).toEqual({ resolvedAliases: expected });
    expect(resolvedAliases(setOf([...names].reverse()))).toEqual({ resolvedAliases: expected });
    expect(resolvedAliases(setOf([...expected].reverse()))).toEqual({ resolvedAliases: expected });
  });

  it('orders names that collate equal under en the same way whatever order they arrive in', () => {
    // Each pair is two distinct strings that `en` collation treats as equal, so
    // only the code-unit tie-break fixes their order.
    const nfc = 'Caf\u00e9';
    const nfd = 'Cafe\u0301';
    const softHyphen = 'Jor\u00addan';
    const joiner = 'Jor\u200ddan';
    const plain = 'Jordan';
    const pairs = [
      [nfc, nfd],
      [plain, softHyphen],
      [plain, joiner]
    ];
    const setOf = (originalNames: string[]) => ({
      members: originalNames.map((originalName, i) => ({ id: i + 1, name: originalName.toLowerCase(), originalName })),
      truncated: false
    });

    for (const [a, b] of pairs) {
      expect(a.localeCompare(b, 'en')).toBe(0);
      expect(a).not.toBe(b);
      expect(resolvedAliases(setOf([a, b]))).toEqual(resolvedAliases(setOf([b, a])));
    }
    expect(resolvedAliases(setOf([nfd, nfc]))).toEqual({ resolvedAliases: [nfd, nfc] });
    expect(resolvedAliases(setOf([softHyphen, plain, joiner]))).toEqual(
      resolvedAliases(setOf([joiner, softHyphen, plain]))
    );
  });

  it('compares every pair in the en locale, so the order does not depend on the process locale', () => {
    // A test cannot change the default locale of a running process, so check
    // the comparator's calls: each one must name `en` itself.
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare');
    try {
      const set = {
        members: ['côte', 'coté', 'Café', 'Cafe'].map((originalName, i) => ({
          id: i + 1,
          name: originalName.toLowerCase(),
          originalName
        })),
        truncated: false
      };

      resolvedAliases(set);

      expect(localeCompare).toHaveBeenCalled();
      for (const call of localeCompare.mock.calls) expect(call[1]).toBe('en');
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('does not reorder the set it reads', () => {
    const set = {
      members: [
        { id: 1, name: 'zed', originalName: 'Zed' },
        { id: 2, name: 'amy', originalName: 'Amy' }
      ],
      truncated: false
    };

    expect(resolvedAliases(set)).toEqual({ resolvedAliases: ['Amy', 'Zed'] });
    expect(aliasNames(set)).toEqual(['zed', 'amy']);
  });
});

describe('aliasSetWarnings', () => {
  const member1 = { id: 1, name: 'jordan', originalName: 'Jordan' };

  it('says which page the cut group belongs to and what was kept', () => {
    const [warning] = aliasSetWarnings({ members: [member1], truncated: true });

    expect(warning).toEqual({
      code: 'alias_set_truncated',
      message:
        'The alias group of "Jordan" has more than 50 pages; ' +
        'only the page itself and 49 aliases were used, so references written under ' +
        'the other names are missing. The maximum cannot be raised.'
    });
  });

  it('gives one warning per cut set and none for the others', () => {
    const other = { id: 5, name: 'alice', originalName: 'Alice' };

    const warnings = aliasSetWarnings(
      { members: [member1], truncated: true },
      { members: [other], truncated: false },
      { members: [other], truncated: true }
    );

    expect(warnings.map(w => w.message.match(/"([^"]*)"/)?.[1])).toEqual(['Jordan', 'Alice']);
  });

  it('names no page when a cut set somehow holds none, rather than printing "undefined"', () => {
    const [warning] = aliasSetWarnings({ members: [], truncated: true });

    expect(warning.message).toMatch(/^The alias group of "" has more than 50 pages;/);
  });
});
