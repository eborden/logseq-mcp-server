// Parity cases for the ref resolver behind `resolve_refs` (#308, BR-0007, ADR-0025), driven through
// logseq_get_block. Every page, block and name here is made up (BR-0001). Each case lists the
// LogSeq calls the TypeScript server makes, in order, with the answer the stub gives; the result
// the server printed for it is in ../expected/.
//
// The root block is fetched with getBlock; then each nesting level makes one query. A query that
// has no answer here is a call the TypeScript server must not make (the stub fails any call it
// has no answer for), which is how the cases pin "refs hidden by a cap are not looked up".
import type { CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';
import {
  ATLAS,
  HEX_UUID,
  editor,
  editorBlock,
  pageRow,
  placeholder,
  refQuery,
  target,
  uuid,
  type PageSpec
} from '../ref-fixtures.js';

const GET_BLOCK = 'logseq.Editor.getBlock';
const ROOT = uuid(1);

/** A case that reads the block `root` with its refs resolved. `levels` is each level's calls. */
function refCase(
  name: string,
  root: unknown,
  levels: CannedCall[],
  options: { includeChildren?: boolean; perturbed?: unknown } = {}
): ParityCase {
  const { includeChildren = false, perturbed } = options;
  const fetch = editor(GET_BLOCK, includeChildren ? [ROOT, { includeChildren: true }] : [ROOT], root);
  return {
    name: `refs: ${name}`,
    tool: 'logseq_get_block',
    arguments: { block_uuid: ROOT, resolve_refs: true, ...(includeChildren ? { include_children: true } : {}) },
    steps: [[fetch], ...levels.map(call => [call])],
    ...(perturbed === undefined ? {} : { perturbed })
  };
}

const rootBlock = (content: string) => editorBlock(1, content);
const ref = (n: number) => `((${uuid(n)}))`;
const embed = (n: number) => `{{embed ${ref(n)}}}`;

const LOOP: PageSpec = { id: 60, name: 'loop', originalName: 'Loop' };

/** `count` children of block `parent`, in page order, each hanging off the one before. */
const children = (parent: number, firstId: number, count: number, content: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => target(firstId + i, content(i), { parent, left: i === 0 ? parent : firstId + i - 1 }));

/** `count` top-level blocks of the page `page`, in page order. */
const topBlocks = (page: PageSpec, firstId: number, count: number, content: (i: number) => string) =>
  children(page.id, firstId, count, content);

export const resolveRefsCases: ParityCase[] = [
  refCase(
    'ref ok, id line stripped, uppercase uuid, repeated ref',
    rootBlock(`See ${ref(2)} and ((${HEX_UUID.toUpperCase()})) and ${ref(2)} again`),
    [
      refQuery({ blocks: [uuid(2), HEX_UUID] }, [
        target(2, `Bob owns the importer\nid:: ${uuid(2)}`),
        target(3, 'Alice owns the schema', { uuid: HEX_UUID })
      ])
    ]
  ),
  refCase('chain stops at the depth limit', rootBlock(`go ${ref(2)}`), [
    refQuery({ blocks: [uuid(2)] }, [target(2, `mid ${ref(3)}`)]),
    refQuery({ blocks: [uuid(3)] }, [target(3, `end ${ref(4)}`)])
  ]),
  refCase('ref cycle', rootBlock(ref(2)), [
    refQuery({ blocks: [uuid(2)] }, [target(2, `back ${ref(1)}`)]),
    refQuery({ blocks: [uuid(1)] }, [target(1, ref(2))])
  ]),
  refCase(
    'missing, placeholder and malformed uuids',
    rootBlock(`${ref(2)} ${ref(3)} ((not-a-uuid)) ((00000000-0000-4000-8000-00000000000))`),
    [refQuery({ blocks: [uuid(2), uuid(3)] }, [placeholder(9, uuid(3))])],
    { perturbed: [target(2, 'a real block after all')] }
  ),
  refCase('an empty answer is missing', rootBlock(ref(2)), [refQuery({ blocks: [uuid(2)] }, [])]),
  refCase(
    'a null answer leaves refs and embeds unavailable',
    rootBlock(`${ref(2)} ${embed(3)} {{embed [[ Atlas Notes ]]}}`),
    [refQuery({ blocks: [uuid(2), uuid(3)], descendants: [uuid(3)], pages: ['atlas notes'] }, null)]
  ),
  refCase('a null answer at the second level', rootBlock(ref(2)), [
    refQuery({ blocks: [uuid(2)] }, [target(2, `then ${ref(3)}`)]),
    refQuery({ blocks: [uuid(3)] }, null)
  ]),
  refCase('a ref to a page entity shows its name', rootBlock(ref(2)), [
    refQuery({ blocks: [uuid(2)] }, [[{ id: ATLAS.id, uuid: uuid(2), name: ATLAS.name, 'original-name': ATLAS.originalName }]])
  ]),
  refCase(
    'block embed with three levels of descendants and a ref inside',
    rootBlock(embed(2)),
    [
      refQuery({ blocks: [uuid(2)], descendants: [uuid(2)] }, [
        target(7, 'Fourth level, never shown', { parent: 6, left: 6 }),
        target(4, `Child B, see ${ref(9)}`, { parent: 2, left: 3 }),
        target(6, 'Great-grandchild', { parent: 5, left: 5 }),
        target(2, 'Embedded'),
        target(5, 'Grandchild', { parent: 3, left: 3 }),
        target(3, 'Child A', { parent: 2, left: 2 })
      ]),
      refQuery({ blocks: [uuid(9)] }, [target(9, 'The ref inside the embed')])
    ]
  ),
  refCase('block embed cut at the embed limit, hidden refs not looked up, then a depth limit', rootBlock(embed(2)), [
    refQuery({ blocks: [uuid(2)], descendants: [uuid(2)] }, [
      target(2, 'Embedded'),
      // twenty-four children: the embed shows the first nineteen of them. The third holds a ref that is
      // looked up, the twenty-second one that is not
      ...children(2, 100, 24, i => (i === 2 ? `Child ${i + 1} ${ref(9)}` : i === 21 ? `Child ${i + 1} ${ref(8)}` : `Child ${i + 1}`)).reverse()
    ]),
    refQuery({ blocks: [uuid(9)] }, [target(9, `Nine ${ref(10)}`)])
  ]),
  refCase(
    'block embed of a missing block and of a placeholder',
    rootBlock(`${embed(2)} ${embed(3)}`),
    [refQuery({ blocks: [uuid(2), uuid(3)], descendants: [uuid(2), uuid(3)] }, [placeholder(9, uuid(3))])],
    { perturbed: [target(2, 'a real block after all')] }
  ),
  refCase('one block as a ref and as an embed', rootBlock(`${ref(2)} ${embed(2)}`), [
    refQuery({ blocks: [uuid(2)], descendants: [uuid(2)] }, [target(2, 'Shared'), target(3, 'Its child', { parent: 2 })])
  ]),
  refCase('an embed of a block already fetched as a ref asks again for its descendants', rootBlock(`${ref(2)} ${ref(3)}`), [
    refQuery({ blocks: [uuid(2), uuid(3)] }, [target(2, embed(3)), target(3, 'Three')]),
    refQuery({ blocks: [uuid(3)], descendants: [uuid(3)] }, [target(3, 'Three'), target(4, 'Under three', { parent: 3 })])
  ]),
  refCase('page embed with a ref in one of its blocks', rootBlock('{{embed [[Project Atlas]]}}'), [
    refQuery({ pages: ['project atlas'] }, [
      target(13, `Third ${ref(9)}`, { parent: ATLAS.id, left: 12 }),
      pageRow(ATLAS),
      target(11, 'First', { parent: ATLAS.id, left: ATLAS.id }),
      target(12, 'Second', { parent: ATLAS.id, left: 11 })
    ]),
    refQuery({ blocks: [uuid(9)] }, [target(9, 'The ref inside the page')])
  ]),
  refCase('page embed cut at the embed limit', rootBlock('{{embed [[PROJECT ATLAS]]}}'), [
    refQuery({ pages: ['project atlas'] }, [pageRow(ATLAS), ...topBlocks(ATLAS, 200, 22, i => `Top-level block ${i + 1}`)])
  ]),
  refCase('page embed of a page that does not exist', rootBlock('{{embed [[ Nowhere ]]}}'), [refQuery({ pages: ['nowhere'] }, [])]),
  refCase('a page that embeds itself', rootBlock('{{embed [[Loop]]}}'), [
    refQuery({ pages: ['loop'] }, [pageRow(LOOP), target(61, 'again {{embed [[loop]]}}', { parent: LOOP.id })])
  ]),
  refCase(
    'refs in the children of a block are resolved in one batch',
    {
      ...editorBlock(1, 'Parent', {
        children: [
          editorBlock(2, `child ${ref(7)}`, { parent: 1 }),
          editorBlock(3, 'plain', { parent: 1 }),
          editorBlock(4, `{{embed [[Project Atlas]]}} and ${ref(7)}`, { parent: 1 })
        ]
      })
    },
    [
      refQuery({ blocks: [uuid(7)], pages: ['project atlas'] }, [
        target(7, 'Seven'),
        pageRow(ATLAS),
        target(11, 'First', { parent: ATLAS.id, left: ATLAS.id })
      ])
    ],
    { includeChildren: true }
  ),
  refCase(
    'unfetched children become objects keyed by position',
    { ...editorBlock(1, `see ${ref(2)}`, { children: [['uuid', uuid(5)], ['uuid', uuid(6)]] }) },
    [refQuery({ blocks: [uuid(2)] }, [target(2, 'Two')])]
  ),
  refCase(
    'an answer that is not a target is an error',
    rootBlock(ref(2)),
    [refQuery({ blocks: [uuid(2)] }, [[{ uuid: uuid(2), content: 'no id' }]])],
    { perturbed: [[{ id: 'two' }]] }
  )
];
