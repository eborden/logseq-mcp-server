import { describe, it, expect } from 'vitest';
import type { PageLike } from '../types.js';
import {
  blockPageId,
  entityId,
  journalDayOf,
  journalFlag,
  originalNameOf,
  pageDisplayName,
  pageName,
} from './entity-fields.js';

/**
 * The readers replaced the `a ?? b ?? c` chains the tools carried (#62). The `legacy*` functions
 * below are those chains, copied as they were, and the tables run both over every shape
 * LogSeq sends: the Editor API's camelCase, a pull's kebab-case, and a bare id. Where the
 * chains disagreed with each other, only on a value LogSeq never sends (an empty name), the
 * test says which and pins what the reader does.
 */

const camel: PageLike = { id: 7, name: 'alice', originalName: 'Alice', 'journal?': false };
const kebab: PageLike = { id: 7, name: 'alice', 'original-name': 'Alice', 'journal?': false };
const explicitPull: PageLike = { 'db/id': 7, name: 'alice', 'original-name': 'Alice' };
const journalCamel: PageLike = { id: 8, name: 'jan 1st, 2025', originalName: 'Jan 1st, 2025', 'journal?': true, journalDay: 20250101 };
const journalPull: PageLike = { id: 8, name: 'jan 1st, 2025', 'original-name': 'Jan 1st, 2025', 'journal?': true, 'journal-day': 20250101 };
const nameOnly: PageLike = { id: 9, name: 'stub' };
const bareId: PageLike = { id: 10 };

const shapes: Array<[string, PageLike | null | undefined]> = [
  ['camelCase page', camel],
  ['kebab-case pull', kebab],
  ['pull naming :db/id', explicitPull],
  ['camelCase journal', journalCamel],
  ['pulled journal', journalPull],
  ['page with a name only', nameOnly],
  ['bare id', bareId],
  ['empty object', {}],
  ['null', null],
  ['undefined', undefined],
];

// The chains as the tools had them, one per site (page `p` may be missing)
const legacyDisplayName: Record<string, (p: any) => unknown> = {
  'slim-entities, get-current-context, query-date-range': p => p?.originalName || p?.['original-name'] || p?.name || '',
  'search-blocks, get-concept-network': p => p?.['original-name'] || p?.originalName || p?.name || '',
};
const legacyIdChains: Record<string, (p: any) => unknown> = {
  'search-blocks, resolve-page, alias-set, build-context': p => p?.id ?? p?.['db/id'],
  'get-current-context': p => p?.['db/id'] ?? p?.id,
  'slim-entities, top-concepts, build-context (||)': p => p?.id || p?.['db/id'],
};

describe('entityId', () => {
  it('reads id, else db/id, whichever spelling the source used', () => {
    expect(entityId({ id: 3 })).toBe(3);
    expect(entityId({ 'db/id': 4 })).toBe(4);
    expect(entityId({ id: 3, 'db/id': 3 })).toBe(3);
  });

  it('lets a zero id fall through to db/id, as the || chains did; LogSeq never issues id 0', () => {
    expect(entityId({ id: 0, 'db/id': 1 })).toBe(1);
  });

  it('is undefined for nothing, an empty object or a missing entity', () => {
    expect(entityId({})).toBeUndefined();
    expect(entityId(null)).toBeUndefined();
    expect(entityId(undefined)).toBeUndefined();
  });

  it.each(shapes)('gives what every old chain gave on a %s', (_label, page) => {
    for (const [site, legacy] of Object.entries(legacyIdChains)) {
      expect(entityId(page), site).toEqual(legacy(page));
    }
  });
});

describe('blockPageId', () => {
  it('reads the page id of a block whose page is a bare reference, in either spelling', () => {
    expect(blockPageId({ page: { id: 5 } })).toBe(5);
    expect(blockPageId({ page: { 'db/id': 6 } })).toBe(6);
  });

  it('reads it from a page the pull nested with its names', () => {
    expect(blockPageId({ page: { id: 5, name: 'alice', 'original-name': 'Alice' } })).toBe(5);
  });

  it('is undefined for a block with no page, which a pull that skips :block/page returns', () => {
    expect(blockPageId({})).toBeUndefined();
    expect(blockPageId({ page: {} })).toBeUndefined();
  });
});

describe('pageName', () => {
  it('is the lowercased name', () => {
    expect(pageName({ name: 'Alice' })).toBe('alice');
    expect(pageName(camel)).toBe('alice');
  });

  it('is empty for a page without a name, or no page', () => {
    expect(pageName(bareId)).toBe('');
    expect(pageName(null)).toBe('');
    expect(pageName(undefined)).toBe('');
  });

  it.each(shapes)('matches resolve-page and alias-set on a %s', (_label, page) => {
    const legacy = (p: any) => String(p?.name ?? '').toLowerCase();
    expect(pageName(page)).toBe(legacy(page));
  });
});

describe('originalNameOf', () => {
  it('reads originalName or original-name, and nothing else', () => {
    expect(originalNameOf(camel)).toBe('Alice');
    expect(originalNameOf(kebab)).toBe('Alice');
    expect(originalNameOf(nameOnly)).toBeUndefined();
  });

  it('counts an empty name as missing, so the other spelling is read', () => {
    expect(originalNameOf({ originalName: '' })).toBeUndefined();
    expect(originalNameOf({ originalName: '', 'original-name': 'Alice' })).toBe('Alice');
    expect(originalNameOf({ 'original-name': '', originalName: 'Alice' })).toBe('Alice');
  });

  it.each(shapes)('matches compact.ts on a %s', (_label, page) => {
    const legacy = (p: any) => p?.originalName ?? p?.['original-name'];
    expect(originalNameOf(page)).toEqual(legacy(page));
  });
});

describe('pageDisplayName', () => {
  it('is the original-case name, else the name, else empty', () => {
    expect(pageDisplayName(camel)).toBe('Alice');
    expect(pageDisplayName(kebab)).toBe('Alice');
    expect(pageDisplayName(nameOnly)).toBe('stub');
    expect(pageDisplayName(bareId)).toBe('');
    expect(pageDisplayName(null)).toBe('');
  });

  it.each(shapes)('gives what the || chains gave on a %s', (_label, page) => {
    for (const [site, legacy] of Object.entries(legacyDisplayName)) {
      expect(pageDisplayName(page), site).toEqual(legacy(page));
    }
  });

  it.each(shapes)('gives what the ?? chain of resolve-page and alias-set gave on a %s', (_label, page) => {
    const legacy = (p: any) => p?.['original-name'] ?? p?.originalName ?? p?.name ?? '';
    expect(pageDisplayName(page)).toEqual(legacy(page));
  });

  // The one place the old chains disagreed with each other, and the reader sides with the || chains
  // (an empty original name counts as missing). LogSeq never sends an empty original name.
  it('falls back to the name for an empty original name, where resolve-page used to return empty', () => {
    expect(pageDisplayName({ originalName: '', name: 'alice' })).toBe('alice');
    expect(pageDisplayName({ 'original-name': '', name: 'alice' })).toBe('alice');
  });
});

describe('journalFlag', () => {
  it('reads journal? as the API sends it, and journal as the plugin typings name it', () => {
    expect(journalFlag({ 'journal?': true })).toBe(true);
    expect(journalFlag({ journal: true })).toBe(true);
    expect(journalFlag({ 'journal?': false })).toBe(false);
  });

  it('is undefined when the page says nothing, and false does not fall through to journal', () => {
    expect(journalFlag({})).toBeUndefined();
    expect(journalFlag(null)).toBeUndefined();
    expect(journalFlag({ 'journal?': false, journal: true })).toBe(false);
  });

  it.each(shapes)('keeps the strict check build-context made on a %s', (_label, page) => {
    const legacy = (p: any) => (p?.['journal?'] ?? p?.journal) === true;
    expect(journalFlag(page) === true).toBe(legacy(page));
  });

  it.each(shapes)('keeps the truthy checks of slim-entities and list-pages on a %s', (_label, page) => {
    const legacySlim = (p: any) => !!(p?.['journal?'] || p?.journal);
    const legacyList = (p: any) => !!(p?.journal || p?.['journal?']);
    expect(!!journalFlag(page)).toBe(legacySlim(page));
    expect(!!journalFlag(page)).toBe(legacyList(page));
  });
});

describe('journalDayOf', () => {
  it('reads journalDay or journal-day', () => {
    expect(journalDayOf(journalCamel)).toBe(20250101);
    expect(journalDayOf(journalPull)).toBe(20250101);
    expect(journalDayOf(camel)).toBeUndefined();
    expect(journalDayOf(undefined)).toBeUndefined();
  });

  it.each(shapes)('gives what the old chains gave on a %s', (_label, page) => {
    const legacyEvolution = (p: any) => p?.journalDay || p?.['journal-day'];
    const legacyContext = (p: any) => p?.['journal-day'] ?? p?.journalDay;
    expect(journalDayOf(page)).toEqual(legacyEvolution(page));
    expect(journalDayOf(page)).toEqual(legacyContext(page));
  });
});
