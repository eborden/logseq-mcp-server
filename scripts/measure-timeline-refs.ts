/**
 * Size an `explore_timeline` call for a page at `top_concepts_limit` 10 (the default) and 0 (#533).
 *
 * With a limit above 0 the mentions query pulls each mention's refs, so the roll-up of `summary.topConcepts` needs no
 * further call. The call count is the same either way; this measures what the heavier LogSeq answer costs in bytes
 * (ADR-0011). It records no wall-clock time: bytes and calls are about the same on every run (db ids and uuids differ
 * between instance starts, so a size shifts by a few bytes), and a time needs a quiet machine.
 *
 * Usage: npx tsx scripts/measure-timeline-refs.ts [--rust-binary <path>] [page ...]
 *
 * The pages default to the hub fixture's `hub central`, which is the one page whose roll-up is empty: every mention of it
 * links only the hub, and the tool drops the page's own alias group before rolling up, so `summary.topConcepts` is `[]`
 * and the result differs by `,"topConcepts":[]` alone. Name a page whose mentions link other pages (a `fringe-NN`)
 * to see a roll-up and the cost of its refs; the output says how many concepts each result holds.
 *
 * It runs the Rust binary over MCP stdio against this
 * worktree's fixture instance only (`npx tsx scripts/logseq-instance.ts start`, or LOGSEQ_MCP_CONFIG): it never reads
 * ~/.logseq-mcp/config.json and refuses a config on port 12315 before any network call (BR-0001).
 *
 * Output per page and limit: the LogSeq calls the tool made, the bytes LogSeq answered with (before the binary parses
 * them) with each answer labelled by its method and, for a Datalog query, the start of its text (the mentions query is
 * the one whose pull has a `{:block/refs [...]}` part at limit 10 and none at 0), the bytes of the result,
 * `summary.totalBlocks` and the number of top concepts. Read-only.
 */
import { loadConfig } from './lib/logseq-api.js';
import { assertNotPersonalLogseq, resolveFixtureConfigPath } from '../tests/integration/helpers/instance-config.js';
import { parseServerFlags, startRustServer } from './measure-server.js';

const LIMITS = [10, 0] as const;

interface Sample {
  calls: number;
  answerBytes: number;
  answers: Array<{ label: string; bytes: number }>;
  concepts: unknown;
  resultBytes: number;
  blocks: unknown;
}

async function main() {
  const choice = parseServerFlags(process.argv.slice(2));
  const config = await loadConfig(resolveFixtureConfigPath());
  assertNotPersonalLogseq(config.apiUrl);
  const pages = choice.rest.length > 0 ? choice.rest : ['hub central'];

  const rust = await startRustServer(choice.rustBinary, config, true);
  const proxy = rust.proxy!;

  const one = async (page: string, limit: number): Promise<Sample> => {
    proxy.reset();
    const result = (await rust.mcp.callTool({ name: 'logseq_explore_timeline', arguments: { page, top_concepts_limit: limit } })) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    // The error text can quote a name, so only the fact of an error is kept
    if (result.isError) throw new Error('explore_timeline answered an error');
    const blocks = result.content ?? [];
    let total: unknown;
    let concepts: unknown;
    try {
      const summary = (JSON.parse(blocks[0]?.text ?? '') as { summary?: { totalBlocks?: unknown; topConcepts?: unknown } }).summary;
      total = summary?.totalBlocks;
      concepts = Array.isArray(summary?.topConcepts) ? summary.topConcepts.length : summary?.topConcepts;
    } catch {
      // not JSON: no count
    }
    return {
      calls: proxy.total(),
      answerBytes: proxy.answerBytes(),
      answers: proxy.answers(),
      resultBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text ?? ''), 0),
      blocks: total,
      concepts
    };
  };

  try {
    for (const [index, page] of pages.entries()) {
      console.log(`page ${index + 1} of ${pages.length}`);
      const rows = new Map<number, Sample>();
      for (const limit of LIMITS) {
        const sample = await one(page, limit);
        rows.set(limit, sample);
        console.log(`  top_concepts_limit ${String(limit).padEnd(2)} calls ${sample.calls}   logseq answer ${sample.answerBytes} B   result ${sample.resultBytes} B   blocks ${sample.blocks}   top concepts ${sample.concepts}`);
        for (const answer of sample.answers) console.log(`      ${String(answer.bytes).padStart(7)} B  ${answer.label}`);
      }
      const [withRefs, without] = LIMITS.map(limit => rows.get(limit)!);
      console.log(`  extra at limit 10: logseq answer ${withRefs.answerBytes - without.answerBytes} B (x${(withRefs.answerBytes / without.answerBytes).toFixed(2)}), result ${withRefs.resultBytes - without.resultBytes} B\n`);
    }
  } finally {
    await rust.close();
  }
}

main().catch((e: unknown) => {
  // The error class only. Never e.message: an MCP error carries the server's text, which can quote a page name.
  console.error(`measure-timeline-refs failed: ${e instanceof Error ? e.name : typeof e}`);
  process.exit(1);
});
