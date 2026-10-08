// Parity cases for logseq_get_block (#308, ADR-0025), without refs (those are in resolve-refs.ts).
// Every page, block and name here is made up (BR-0001). Each case lists the LogSeq calls the
// TypeScript server makes, in order, with the answer the stub gives; the result the server printed
// for it is in ../expected/.
import type { ParityCase } from '../harness.js';
import { editor, editorBlock, uuid } from '../ref-fixtures.js';

const GET_BLOCK = 'logseq.Editor.getBlock';
const block = (id: number, response: unknown, children = false) =>
  editor(GET_BLOCK, children ? [uuid(id), { includeChildren: true }] : [uuid(id)], response);

// Property keys that look like numbers come first in a JavaScript object, whatever order LogSeq sent them
const PROPERTIES = { status: 'doing', '2': 'two', owner: 'Alice', '10': 'ten', '1': 'one' };

export const getBlockCases: ParityCase[] = [
  {
    name: 'get_block: block without children',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101) },
    steps: [[block(101, editorBlock(101, 'Kickoff with [[Alice]] and [[Bob]]', { properties: PROPERTIES, children: [['uuid', uuid(102)]] }))]]
  },
  {
    name: 'get_block: block with children',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), include_children: true },
    steps: [
      [
        block(
          101,
          editorBlock(101, 'Milestones – café \u{1F680}\n- ship the importer', {
            children: [
              editorBlock(102, 'Alice owns the schema', { parent: 101, children: [editorBlock(104, 'Draft', { parent: 102 })] }),
              editorBlock(103, 'Bob owns the importer', { parent: 101, children: [] })
            ]
          }),
          true
        )
      ]
    ]
  },
  {
    name: 'get_block: uuid alias',
    tool: 'logseq_get_block',
    arguments: { uuid: uuid(101) },
    steps: [[block(101, editorBlock(101, 'Found by the alias'))]]
  },
  {
    name: 'get_block: uuid alias with the same value as block_uuid',
    tool: 'logseq_get_block',
    arguments: { uuid: uuid(101), block_uuid: uuid(101), include_children: false },
    steps: [[block(101, editorBlock(101, 'Both names, one value'))]]
  },
  {
    name: 'get_block: uuid alias with another value than block_uuid',
    tool: 'logseq_get_block',
    arguments: { uuid: uuid(102), block_uuid: uuid(101) },
    steps: []
  },
  {
    name: 'get_block: block not found',
    tool: 'logseq_get_block',
    arguments: { block_uuid: 'no such "block"' },
    steps: [[editor(GET_BLOCK, ['no such "block"'], null)]]
  },
  {
    name: 'get_block: resolve_refs on a block with no ref',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), resolve_refs: true },
    steps: [[block(101, editorBlock(101, 'No refs here, just ((not a uuid)) text'))]]
  },
  {
    name: 'get_block: block_uuid missing',
    tool: 'logseq_get_block',
    arguments: {},
    steps: []
  },
  {
    name: 'get_block: block_uuid is not a string',
    tool: 'logseq_get_block',
    arguments: { block_uuid: 42, include_children: 'yes' },
    steps: []
  },
  {
    name: 'get_block: include_children is not a boolean',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), include_children: 'yes', resolve_refs: 1 },
    steps: []
  },
  {
    name: 'get_block: resolve_refs is not a boolean',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), resolve_refs: [true] },
    steps: []
  },
  {
    name: 'get_block: format is not a known one',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101), format: 'xml' },
    steps: []
  },
  {
    name: 'get_block: a block that is not a block',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101) },
    steps: [[block(101, { id: 101, content: 'no uuid' })]],
    perturbed: { id: 101, uuid: 5 }
  },
  {
    name: 'get_block: a block with a mistyped field',
    tool: 'logseq_get_block',
    arguments: { block_uuid: uuid(101) },
    steps: [[block(101, { id: 101, uuid: uuid(101), content: 'x', page: { id: 'ten' } })]],
    perturbed: { id: 101, uuid: uuid(101), page: { id: false } }
  }
];
