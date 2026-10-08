// Parity cases for the resources that aren't a page (#316, #46, ADR-0025): `resources/list`, the reading
// guide at `logseq://guide` and a URI the server doesn't know. The guide is the server instructions plus an
// index of the tools and prompts, so it is held byte for byte to what the TypeScript server prints: a tool
// whose description drifts, or a prompt renamed, fails here. None of them calls LogSeq. The page resource
// and the template list are in page-resource.ts.
import type { ParityCase } from '../harness.js';

const TOOL = 'resource logseq://guide';

const read = (label: string, uri: string): ParityCase => ({
  name: `resources: ${label}`,
  tool: TOOL,
  arguments: {},
  readResource: uri,
  steps: []
});

export const resourcesCases: ParityCase[] = [
  { name: 'resources: the list', tool: 'resources/list', arguments: {}, listResources: true, steps: [] },
  read('the guide', 'logseq://guide'),
  read('an unknown scheme', 'http://example.com/guide'),
  read('an unknown name', 'logseq://nope'),
  read('the guide with a path after it', 'logseq://guide/extra'),
  read('the guide in capitals', 'logseq://GUIDE'),
  read('the page prefix without its slash', 'logseq://page'),
  read('an empty URI', ''),
  read('a URI with a quote and a newline in it', 'logseq://say "hi"\nthere')
];
