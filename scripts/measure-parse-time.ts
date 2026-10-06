/**
 * Time the response schemas (src/response-schemas.ts) on large synthetic results (#202).
 *
 * Every LogSeq response is checked with `parseResponse` before a tool reads it, so this is the
 * latency that check adds. It builds made-up blocks and pages in the shapes LogSeq sends (a pull
 * with kebab-case keys, the Editor API with camelCase), and prints how long one check takes next
 * to `JSON.parse` of the same payload, which the client pays anyway, and the size of the payload.
 *
 * No LogSeq needed, and no graph data: everything is generated. Prints sizes and milliseconds only.
 *
 * Usage: npx tsx scripts/measure-parse-time.ts
 */
import { performance } from 'node:perf_hooks';
import { responses } from '../src/response-schemas.js';
import { parseResponse } from '../src/utils/parse-response.js';

const REPEATS = 15;

function pulledBlock(i: number) {
  return {
    properties: i % 3 === 0 ? { status: 'active', 'a-key': ['x', 'y'] } : {},
    'pre-block?': false,
    parent: { id: 100 + (i % 50) },
    id: i,
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    'path-refs': [{ id: 100 + (i % 50) }, { id: 7 }, { id: 9 }],
    content: `Block ${i} with a [[link]] and some words to make the text a realistic length for a note.`,
    'properties-order': i % 3 === 0 ? ['status', 'a-key'] : [],
    'properties-text-values': {},
    page: { id: 100 + (i % 50) },
    left: { id: i - 1 },
    'invalid-properties': [],
    format: 'markdown',
    refs: [{ id: 7 }, { id: 9 }],
  };
}

function pulledPage(i: number) {
  return {
    id: i,
    'created-at': 1700000000000 + i,
    'updated-at': 1700000000000 + i,
    'journal?': i % 5 === 0,
    name: `page ${i}`,
    'original-name': `Page ${i}`,
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    file: { id: 500000 + i },
    properties: {},
  };
}

function editorPage(i: number) {
  return {
    id: i,
    createdAt: 1700000000000 + i,
    updatedAt: 1700000000000 + i,
    'journal?': i % 5 === 0,
    name: `page ${i}`,
    originalName: `Page ${i}`,
    uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    file: { id: 500000 + i },
  };
}

/** Median of `REPEATS` timings of `fn`, in milliseconds, after one warm-up run. */
function median(fn: () => void): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}

function measure(label: string, schema: Parameters<typeof parseResponse>[0], rows: unknown[]) {
  const json = JSON.stringify(rows);
  const parseMs = median(() => parseResponse(schema, rows, 'measure'));
  const jsonMs = median(() => JSON.parse(json));
  console.error(
    `${label.padEnd(28)} ${String(rows.length).padStart(6)} rows  ${(json.length / 1024 / 1024).toFixed(1).padStart(5)} MB` +
      `  check ${parseMs.toFixed(1).padStart(6)} ms  JSON.parse ${jsonMs.toFixed(1).padStart(6)} ms  ` +
      `(${(parseMs / jsonMs).toFixed(2)}x)  ${((parseMs * 1000) / rows.length).toFixed(2)} us/row`
  );
}

for (const n of [1_000, 5_000, 20_000]) {
  measure('blocks, one pull per row', responses.blockRows, Array.from({ length: n }, (_, i) => [pulledBlock(i + 1)]));
}
for (const n of [2_000, 20_000]) {
  measure('pages, Editor getAllPages', responses.editorPages, Array.from({ length: n }, (_, i) => editorPage(i + 1)));
  measure('pages, one pull per row', responses.pageRows, Array.from({ length: n }, (_, i) => [pulledPage(i + 1)]));
}
