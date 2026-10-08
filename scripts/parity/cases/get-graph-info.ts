// Parity cases for logseq_get_graph_info (#306, ADR-0025). Every path and name here is made up
// (BR-0001). Each case lists the LogSeq calls the TypeScript server makes, in order, with the answer
// the stub gives; the result the server printed for it is in ../expected/.
import type { CannedCall } from '../stub-logseq.js';
import type { ParityCase } from '../harness.js';

const GET_CURRENT_GRAPH = 'logseq.App.getCurrentGraph';

const graph = (response: unknown): CannedCall => ({ method: GET_CURRENT_GRAPH, args: [], response });

export const getGraphInfoCases: ParityCase[] = [
  {
    name: 'graph info',
    tool: 'logseq_get_graph_info',
    arguments: {},
    steps: [[graph({ url: 'logseq_local_/tmp/example-graph', name: 'example-graph', path: '/tmp/example-graph' })]]
  },
  {
    // The answer is the result as it came: a key LogSeq adds shows up, in LogSeq's order, and an
    // integer-like key is written first, as JavaScript writes it
    name: 'graph info with extra keys',
    tool: 'logseq_get_graph_info',
    arguments: { ignored: true },
    steps: [[graph({ path: '/tmp/example-graph', extra: { nested: [1, 2.5, null] }, name: 'example-graph', '7': 'seven' })]]
  },
  {
    name: 'graph info with no fields',
    tool: 'logseq_get_graph_info',
    arguments: {},
    steps: [[graph({})]]
  },
  {
    // `null` is no graph open, not a graph with no fields (BR-0011)
    name: 'no graph open',
    tool: 'logseq_get_graph_info',
    arguments: {},
    steps: [[graph(null)]]
  },
  {
    name: 'graph info in a shape the server cannot read',
    tool: 'logseq_get_graph_info',
    arguments: {},
    steps: [[graph({ name: 3 })]]
  },
  {
    name: 'graph info that is not an object',
    tool: 'logseq_get_graph_info',
    arguments: {},
    steps: [[graph([])]]
  },
  {
    // An error from LogSeq is an error result (BR-0003)
    name: 'LogSeq error for the graph',
    tool: 'logseq_get_graph_info',
    arguments: {},
    steps: [[graph({ error: 'MethodNotExist: logseq.App.getCurrentGraph' })]]
  }
];
