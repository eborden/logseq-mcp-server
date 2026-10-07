import { describe, it, expect } from 'vitest';
import {
  blockSchema,
  editorPageSchema,
  pageLikeSchema,
  pulledPageSchema,
  responses,
} from './response-schemas.js';
import { parseResponse } from './utils/parse-response.js';
import { LogSeqResponseError } from './errors.js';

/**
 * The shapes below are what LogSeq 0.10.15 sends (checked against the fixture graph), with made-up
 * names and ids. The Editor API camelizes keys; a Datalog pull keeps LogSeq's own.
 */
const editorPage = {
  id: 90,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  'journal?': false,
  name: 'alice',
  originalName: 'Alice',
  uuid: '00000000-0000-4000-8000-000000000090',
  file: { id: 153 },
  properties: { role: 'designer' },
  propertiesTextValues: { role: 'designer' },
};

const pulledPage = {
  id: 90,
  'created-at': 1700000000000,
  'updated-at': 1700000001000,
  'journal?': false,
  name: 'alice',
  'original-name': 'Alice',
  uuid: '00000000-0000-4000-8000-000000000090',
  file: { id: 153 },
  properties: { role: 'designer' },
  'properties-text-values': { role: 'designer' },
};

const pulledBlock = {
  id: 155,
  uuid: '00000000-0000-4000-8000-000000000155',
  content: 'role:: designer\n\n',
  format: 'markdown',
  page: { id: 90 },
  parent: { id: 90 },
  left: { id: 90 },
  properties: { role: 'designer' },
  'properties-order': ['role'],
  'path-refs': [{ id: 90 }, { id: 154 }],
  refs: [{ id: 154 }],
  'pre-block?': true,
};

const editorBlock = {
  id: 155,
  uuid: '00000000-0000-4000-8000-000000000155',
  content: 'role:: designer\n\n',
  format: 'markdown',
  page: { id: 90 },
  parent: { id: 90 },
  left: { id: 90 },
  properties: { role: 'designer' },
  propertiesOrder: ['role'],
  pathRefs: [{ id: 90 }, { id: 154 }],
  refs: [{ id: 154 }],
  children: [],
  level: 1,
  'preBlock?': true,
};

const accepts = (schema: Parameters<typeof parseResponse>[0], value: unknown) => schema.safeParse(value).success;

describe('page schemas', () => {
  it('reads an Editor API page and a pulled page, each in its own spelling', () => {
    expect(accepts(editorPageSchema, editorPage)).toBe(true);
    expect(accepts(pulledPageSchema, pulledPage)).toBe(true);
  });

  it('reads an Editor page that has no originalName (it is read with a fallback to name), but wants id and name', () => {
    const { originalName: _gone, ...withoutOriginalName } = editorPage;

    expect(accepts(editorPageSchema, withoutOriginalName)).toBe(true);
    expect(accepts(editorPageSchema, { id: 1, name: 'a whiteboard' })).toBe(true);
    expect(accepts(editorPageSchema, { name: 'a whiteboard' })).toBe(false);
    expect(accepts(editorPageSchema, { id: 1 })).toBe(false);
  });

  it('reads a page of either spelling, or a bare reference, as a PageLike', () => {
    expect(accepts(pageLikeSchema, editorPage)).toBe(true);
    expect(accepts(pageLikeSchema, pulledPage)).toBe(true);
    expect(accepts(pageLikeSchema, { id: 90 })).toBe(true);
  });

  it('reads a journal page with its journal day, in either spelling', () => {
    const editor = { ...editorPage, 'journal?': true, journalDay: 20250101 };
    const pulled = { ...pulledPage, 'journal?': true, 'journal-day': 20250101 };

    expect(accepts(editorPageSchema, editor)).toBe(true);
    expect(accepts(pulledPageSchema, pulled)).toBe(true);
  });

  it('reads a page pulled with db/id, the id as Datascript spells it', () => {
    expect(accepts(pulledPageSchema, { 'db/id': 5, name: 'bob', 'original-name': 'Bob' })).toBe(true);
  });

  it('does not want an id on a pulled page (the resolver keys one by name), but a given id is a number', () => {
    expect(accepts(pulledPageSchema, { name: 'bob', 'original-name': 'Bob' })).toBe(true);
    expect(accepts(pulledPageSchema, {})).toBe(true);
    expect(accepts(pulledPageSchema, { id: 'five' })).toBe(false);
  });

  it('reads a partial pull: only the attributes that were asked for', () => {
    expect(accepts(pulledPageSchema, { id: 5, name: 'bob' })).toBe(true);
    expect(accepts(pulledPageSchema, { id: 5 })).toBe(true);
  });

  describe('updated-at, which about 1 page in 10 lacks (#202)', () => {
    it('reads a pulled page without updated-at, and without created-at', () => {
      const { 'updated-at': _updated, ...withoutUpdated } = pulledPage;
      const { 'created-at': _created, ...withoutBoth } = withoutUpdated;

      expect(accepts(pulledPageSchema, withoutUpdated)).toBe(true);
      expect(accepts(pulledPageSchema, withoutBoth)).toBe(true);
    });

    it('reads an Editor API page without updatedAt, and without createdAt', () => {
      const { updatedAt: _updated, ...withoutUpdated } = editorPage;
      const { createdAt: _created, ...withoutBoth } = withoutUpdated;

      expect(accepts(editorPageSchema, withoutUpdated)).toBe(true);
      expect(accepts(editorPageSchema, withoutBoth)).toBe(true);
    });

    it('keeps updated-at when a page has it, and does not invent one when it has none', () => {
      const { 'updated-at': _updated, ...withoutUpdated } = pulledPage;

      expect(parseResponse(pulledPageSchema, pulledPage, 'm')).toHaveProperty('updated-at', 1700000001000);
      expect(parseResponse(pulledPageSchema, withoutUpdated, 'm')).not.toHaveProperty('updated-at');
    });

    it('rejects an updated-at that is not a number, rather than coercing it', () => {
      expect(accepts(pulledPageSchema, { ...pulledPage, 'updated-at': '1700000001000' })).toBe(false);
      expect(accepts(editorPageSchema, { ...editorPage, updatedAt: '1700000001000' })).toBe(false);
    });
  });

  it('rejects a field of the wrong type: a string id, a name that is a number, a flag that is a string', () => {
    expect(accepts(editorPageSchema, { ...editorPage, id: '90' })).toBe(false);
    expect(accepts(editorPageSchema, { ...editorPage, name: 90 })).toBe(false);
    expect(accepts(pulledPageSchema, { ...pulledPage, 'journal?': 'true' })).toBe(false);
    expect(accepts(pulledPageSchema, { ...pulledPage, file: 153 })).toBe(false);
  });
});

describe('block schema', () => {
  it('reads a block in the Editor API spelling and in a pull', () => {
    expect(accepts(blockSchema, editorBlock)).toBe(true);
    expect(accepts(blockSchema, pulledBlock)).toBe(true);
  });

  it('reads a block whose page is a whole page, as a nested pull gives it', () => {
    expect(accepts(blockSchema, { ...pulledBlock, page: pulledPage })).toBe(true);
    expect(accepts(blockSchema, { ...pulledBlock, page: { id: 90, name: 'alice', 'original-name': 'Alice', 'journal-day': 20250101 } })).toBe(true);
  });

  it('reads a block pulled with only some attributes (the outline pulls no page)', () => {
    const { page: _page, ...withoutPage } = pulledBlock;

    expect(accepts(blockSchema, withoutPage)).toBe(true);
  });

  it('reads refs as bare ids or as nested pages (the journal query pulls them as maps)', () => {
    expect(accepts(blockSchema, { ...pulledBlock, refs: [{ id: 1 }] })).toBe(true);
    expect(accepts(blockSchema, { ...pulledBlock, refs: [{ id: 1, name: 'a', 'original-name': 'A', 'journal?': true, 'journal-day': 20250101 }] })).toBe(true);
  });

  it('does not look inside children, which are unfetched ["uuid", "<id>"] tuples without includeChildren', () => {
    expect(accepts(blockSchema, { ...editorBlock, children: [['uuid', '123']] })).toBe(true);
  });

  it('wants id and uuid, which the code reads with no fallback', () => {
    for (const key of ['id', 'uuid'] as const) {
      const { [key]: _gone, ...without } = pulledBlock;
      expect(accepts(blockSchema, without), key).toBe(false);
    }
  });

  it('reads a block with no content: a pull omits the key, and the tools read it with a fallback', () => {
    const { content: _gone, ...without } = pulledBlock;

    expect(accepts(blockSchema, without)).toBe(true);
  });

  it('reads a reference with no id, or with only db/id, as the code does with ?.id', () => {
    expect(accepts(blockSchema, { ...pulledBlock, parent: {}, left: { 'db/id': 3 } })).toBe(true);
    expect(accepts(blockSchema, { ...pulledBlock, parent: { id: 'x' } })).toBe(false);
  });

  it('rejects a block with content that is not text', () => {
    expect(accepts(blockSchema, { ...pulledBlock, content: 42 })).toBe(false);
    expect(accepts(blockSchema, { ...pulledBlock, content: null })).toBe(false);
  });
});

describe('a tolerant reader: keys the schemas do not name', () => {
  it('accepts, and keeps, a key LogSeq adds in a newer version', () => {
    const newer = { ...pulledPage, 'some-new-attribute': { nested: [1, 2, 3] } };

    const parsed = parseResponse(pulledPageSchema, newer, 'm');

    expect(parsed).toBe(newer);
    expect(parsed).toHaveProperty('some-new-attribute');
  });

  it('keeps every key of a block that no tool reads, in the order LogSeq sent them', () => {
    const parsed = parseResponse(blockSchema, pulledBlock, 'm');

    expect(Object.keys(parsed)).toEqual(Object.keys(pulledBlock));
  });

  it('accepts a property map holding anything, since the keys and values are the user\'s', () => {
    const properties = { 'a-key': ['x', 'y'], count: 3, done: false, nested: { deep: null } };

    expect(accepts(blockSchema, { ...pulledBlock, properties })).toBe(true);
    expect(accepts(pulledPageSchema, { ...pulledPage, properties })).toBe(true);
  });
});

describe('null is not [] (BR-0011)', () => {
  it('lets a call that may answer null answer null, and gives null back as null', () => {
    expect(parseResponse(responses.editorPage, null, 'm')).toBeNull();
    expect(parseResponse(responses.editorPages, null, 'm')).toBeNull();
    expect(parseResponse(responses.block, null, 'm')).toBeNull();
    expect(parseResponse(responses.blocks, null, 'm')).toBeNull();
    expect(parseResponse(responses.blockRows, null, 'm')).toBeNull();
    expect(parseResponse(responses.linkedReferences, null, 'm')).toBeNull();
  });

  it('gives an empty list back as an empty list, not null', () => {
    expect(parseResponse(responses.editorPages, [], 'm')).toEqual([]);
    expect(parseResponse(responses.blockRows, [], 'm')).toEqual([]);
    expect(parseResponse(responses.blocks, [], 'm')).toEqual([]);
  });

  it('does not take [] for a page, or null for a list of blocks inside a row', () => {
    expect(accepts(responses.editorPage, [])).toBe(false);
    expect(accepts(responses.blockRows, [[null]])).toBe(false);
    expect(accepts(responses.nullableBlockRows, [[null]])).toBe(true);
  });

  it('does not take undefined for null: LogSeq answers JSON, which has no undefined', () => {
    expect(accepts(responses.editorPage, undefined)).toBe(false);
    expect(accepts(responses.editorPages, undefined)).toBe(false);
    expect(accepts(responses.blockRows, undefined)).toBe(false);
  });
});

describe('responses', () => {
  it('reads getPageLinkedReferences: [sourcePage, blocks] per page, the page in either spelling or null', () => {
    const rows = [[editorPage, [editorBlock]], [pulledPage, [editorBlock]], [null, [editorBlock]]];

    expect(accepts(responses.linkedReferences, rows)).toBe(true);
  });

  it('reads getCurrentPage as a page or as the block the user zoomed into', () => {
    expect(accepts(responses.pageOrBlock, editorPage)).toBe(true);
    expect(accepts(responses.pageOrBlock, editorBlock)).toBe(true);
    expect(accepts(responses.pageOrBlock, null)).toBe(true);
    expect(accepts(responses.pageOrBlock, 'a string')).toBe(false);
  });

  it('says where a getCurrentPage answer is wrong, for a page and for a block, never what the value was', () => {
    const secret = 'a-private-page-name';
    const badPage = catchError(() => parseResponse(responses.pageOrBlock, { ...editorPage, id: secret }, 'logseq.Editor.getCurrentPage'));
    const badBlock = catchError(() => parseResponse(responses.pageOrBlock, { ...editorBlock, uuid: 7, content: secret }, 'logseq.Editor.getCurrentPage'));

    expect(badPage.path).toBe('id');
    expect(badBlock.path).toBe('uuid');
    expect(badPage.message + badBlock.message).not.toContain(secret);
    expect(catchError(() => parseResponse(responses.pageOrBlock, 'text', 'logseq.Editor.getCurrentPage')).path).toBe('(response)');
  });

  it('reads getCurrentGraph', () => {
    expect(accepts(responses.graphInfo, { url: 'logseq_local_/tmp/my-graph', name: 'my-graph', path: '/tmp/my-graph' })).toBe(true);
    expect(accepts(responses.graphInfo, { name: 'my-graph' })).toBe(true); // nothing reads the graph's fields
    expect(accepts(responses.graphInfo, { name: 7 })).toBe(false);
  });

  it('reads the resolver rows: [page, via], with via absent for an exact name', () => {
    expect(accepts(responses.resolverRows, [[pulledPage, 'name'], [pulledPage, 'alias'], [pulledPage]])).toBe(true);
    expect(accepts(responses.resolverRows, [['not a page', 'name']])).toBe(false);
  });

  it('reads the concept network rows: seven cells, a direction that is outbound or inbound', () => {
    const row = [1, 2, 'bob', 'Bob', false, 'outbound', 3];

    expect(accepts(responses.connectedRows, [row])).toBe(true);
    expect(accepts(responses.connectedRows, [[1, 2, 'bob', 'Bob', false, 'sideways', 3]])).toBe(false);
    expect(accepts(responses.connectedRows, [[1, 2, 'bob', 'Bob', 'no', 'inbound', 3]])).toBe(false);
  });

  it('reads the names only, for suggestions, from a page list that carries more', () => {
    expect(accepts(responses.pageNames, [editorPage, { originalName: 'Bob' }])).toBe(true);
    expect(accepts(responses.pageNames, [{ name: 'bob' }])).toBe(true); // no original name: nothing to match
    expect(accepts(responses.pageNames, [{ originalName: 7 }])).toBe(false);
  });
});

describe('a property map is an object, and nothing else', () => {
  it('rejects properties that are an array, null, text or a number, on a page and on a block', () => {
    for (const bad of [[], ['role'], null, 'role:: designer', 7, true]) {
      expect(accepts(pulledPageSchema, { ...pulledPage, properties: bad }), JSON.stringify(bad)).toBe(false);
      expect(accepts(editorPageSchema, { ...editorPage, properties: bad }), JSON.stringify(bad)).toBe(false);
      expect(accepts(blockSchema, { ...pulledBlock, properties: bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts an empty map, since a page or block with no properties has one', () => {
    expect(accepts(pulledPageSchema, { ...pulledPage, properties: {} })).toBe(true);
    expect(accepts(blockSchema, { ...pulledBlock, properties: {} })).toBe(true);
  });

  it('checks the text-values map of a pulled page the same way', () => {
    expect(accepts(pulledPageSchema, { ...pulledPage, 'properties-text-values': [] })).toBe(false);
    expect(accepts(pulledPageSchema, { ...pulledPage, 'properties-text-values': null })).toBe(false);
    expect(accepts(pulledPageSchema, { ...pulledPage, 'properties-text-values': { role: 'designer' } })).toBe(true);
  });

  it('says what was expected, naming the field and not the value', () => {
    const error = catchError(() => parseResponse(blockSchema, { ...pulledBlock, properties: ['a-private-value'] }, 'm'));

    expect(error.path).toBe('properties');
    expect(error.problem).toBe('expected an object');
    expect(error.message).not.toContain('a-private-value');
  });
});

describe('outline rows', () => {
  const outlineBlock = { id: 5, uuid: '00000000-0000-4000-8000-000000000005', content: 'a block', left: { id: 4 }, parent: { id: 3 } };

  it('reads a block with an id, or with only db/id, which an older LogSeq sends', () => {
    const { id: _id, ...withoutId } = outlineBlock;

    expect(accepts(responses.outlineRows, [[outlineBlock]])).toBe(true);
    expect(accepts(responses.outlineRows, [[{ ...withoutId, 'db/id': 5 }]])).toBe(true);
    expect(accepts(responses.outlineRows, [[{ ...outlineBlock, 'db/id': 5 }]])).toBe(true);
  });

  it('rejects a block with neither id nor db/id, and says so', () => {
    const { id: _id, ...withoutId } = outlineBlock;

    expect(accepts(responses.outlineRows, [[withoutId]])).toBe(false);
    const error = catchError(() => parseResponse(responses.outlineRows, [[withoutId]], 'logseq.DB.datascriptQuery'));
    expect(error.path).toBe('[0][0]');
    expect(error.problem).toBe('a block needs an id');
  });

  it('wants a uuid, and reads a missing content, a bare-number parent and no left', () => {
    const { uuid: _uuid, ...withoutUuid } = outlineBlock;
    const { content: _content, left: _left, ...bare } = outlineBlock;

    expect(accepts(responses.outlineRows, [[withoutUuid]])).toBe(false);
    expect(accepts(responses.outlineRows, [[bare]])).toBe(true);
    expect(accepts(responses.outlineRows, [[{ ...outlineBlock, parent: 3 }]])).toBe(true);
    expect(accepts(responses.outlineRows, [[{ ...outlineBlock, parent: 'three' }]])).toBe(false);
  });

  it('skips a null cell, and does not take null for the rows as a row', () => {
    expect(accepts(responses.outlineRows, [[null]])).toBe(true);
    expect(accepts(responses.outlineRows, null)).toBe(true);
    expect(accepts(responses.outlineRows, [null])).toBe(false);
  });
});

describe('getCurrentPage: page or block, told apart by its name', () => {
  it('takes an object with no name for a block, and one with a name for a page', () => {
    expect(accepts(responses.pageOrBlock, editorBlock)).toBe(true);
    expect(accepts(responses.pageOrBlock, editorPage)).toBe(true);
    // a bare page (id and name, no uuid) is a good page but would be a bad block
    expect(accepts(responses.pageOrBlock, { id: 1, name: 'alice' })).toBe(true);
    // a named object with no id is a bad page (and a bad block too)
    expect(accepts(responses.pageOrBlock, { name: 'alice' })).toBe(false);
    // a block with no name is checked as a block, so one with no uuid is a bad block
    const { uuid: _uuid, ...blockWithoutUuid } = editorBlock;
    expect(accepts(responses.pageOrBlock, blockWithoutUuid)).toBe(false);
  });

  it('checks an object whose name key is undefined as a block, not a page', () => {
    // JSON has no undefined, but the test the tool applies is `name !== undefined`
    expect(accepts(responses.pageOrBlock, { ...editorBlock, name: undefined })).toBe(true);
    expect(accepts(responses.pageOrBlock, { id: 1, uuid: 'u', name: undefined })).toBe(true);
  });

  it('checks a named object as a page even when it is a valid block', () => {
    const blockWithBadName = { ...editorBlock, name: 7 };

    // as a block this passes (name is not a block field); as a page the name must be text
    expect(accepts(blockSchema, blockWithBadName)).toBe(true);
    const error = catchError(() => parseResponse(responses.pageOrBlock, blockWithBadName, 'logseq.Editor.getCurrentPage'));
    expect(error.path).toBe('name');
    expect(error.problem).toMatch(/expected string/);
  });

  it('checks a named object with no id as a bad page, whatever else it carries', () => {
    expect(accepts(responses.pageOrBlock, { ...editorBlock, id: undefined, name: 'alice' })).toBe(false);
    const error = catchError(() => parseResponse(responses.pageOrBlock, { uuid: 'u', content: 'x', name: 'alice' }, 'm'));
    expect(error.path).toBe('id');
  });

  it('rejects an array, text, a number and a boolean as a whole, saying an object was expected', () => {
    for (const bad of [[], [editorBlock], 'text', 7, true]) {
      const error = catchError(() => parseResponse(responses.pageOrBlock, bad, 'logseq.Editor.getCurrentPage'));

      expect(error.path, JSON.stringify(bad)).toBe('(response)');
      expect(error.problem, JSON.stringify(bad)).toBe('expected an object');
    }
  });

  it('reports the first problem with its own message and path, for a page and for a block', () => {
    const badPage = catchError(() => parseResponse(responses.pageOrBlock, { ...editorPage, id: 'ninety' }, 'm'));
    const badBlock = catchError(() => parseResponse(responses.pageOrBlock, { ...editorBlock, content: 7 }, 'm'));

    expect(badPage.path).toBe('id');
    expect(badPage.problem).toMatch(/expected number/);
    expect(badBlock.path).toBe('content');
    expect(badBlock.problem).toMatch(/expected string/);
  });
});

describe('what a failure says', () => {
  it('names the method, where in the answer it went wrong, and what was expected', () => {
    const answer = [{ ...editorPage }, { ...editorPage, id: 'ninety' }];

    const error = catchError(() => parseResponse(responses.editorPages, answer, 'logseq.Editor.getAllPages'));

    expect(error).toBeInstanceOf(LogSeqResponseError);
    expect(error.method).toBe('logseq.Editor.getAllPages');
    expect(error.path).toBe('[1].id');
    expect(error.problem).toMatch(/expected number/);
    expect(error.message).toContain('logseq.Editor.getAllPages');
    expect(error.message).toContain('[1].id');
  });

  it('never repeats a value from the response: it is the user\'s graph', () => {
    const secret = 'a-private-page-name';
    const error = catchError(() =>
      parseResponse(responses.editorPages, [{ ...editorPage, name: 4, originalName: secret, uuid: secret }], 'logseq.Editor.getAllPages')
    );

    expect(error.message).not.toContain(secret);
  });

  it('says "(response)" when the answer as a whole is the wrong kind', () => {
    const error = catchError(() => parseResponse(responses.editorPage, 'not a page', 'logseq.Editor.getPage'));

    expect(error.path).toBe('(response)');
  });

  it('reports the first problem only, and does not mention keys the schema never looks at', () => {
    const error = catchError(() => parseResponse(blockSchema, { ...pulledBlock, content: 7, 'unrelated-key': 1 }, 'm'));

    expect(error.path).toBe('content');
    expect(error.message).not.toContain('unrelated-key');
  });
});

function catchError(fn: () => unknown): LogSeqResponseError {
  try {
    fn();
  } catch (error) {
    return error as LogSeqResponseError;
  }
  throw new Error('expected the call to throw');
}
