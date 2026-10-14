/**
 * Size an `explore_timeline` call for a page at `top_concepts_limit` 10 (the default) and 0 (#533).
 *
 * With a limit above 0 the mentions query pulls each mention's refs, so the roll-up of `summary.topConcepts` needs no
 * further call. The call count is the same either way; this measures what the heavier LogSeq answer costs in bytes
 * (ADR-0011). It records no wall-clock time: bytes and calls are the same on every run, and a time needs a quiet machine.
 *
 * Usage: npx tsx scripts/measure-timeline-refs.ts [--rust-binary <path>] [page ...]
 *
 * The pages default to the hub fixture's `hub central`. It runs the Rust binary over MCP stdio against this
 * worktree's fixture instance only (`npx tsx scripts/logseq-instance.ts start`, or LOGSEQ_MCP_CONFIG): it never reads
 * ~/.logseq-mcp/config.json and refuses a config on port 12315 before any network call (BR-0001).
 *
 * Output per page and limit: the LogSeq calls the tool made, the bytes LogSeq answered with (before the binary parses
 * them), the bytes of the result and the number of blocks in the result's totals. Read-only.
 */
import { loadConfig } from './lib/logseq-api.js';
import { assertNotPersonalLogseq, resolveFixtureConfigPath } from '../tests/integration/helpers/instance-config.js';
import { parseServerFlags, startRustServer } from './measure-server.js';

const LIMITS = [10, 0] as const;

interface Sample {
  calls: number;
  answerBytes: number;
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
    try {
      total = (JSON.parse(blocks[0]?.text ?? '') as { totals?: { blocks?: unknown } }).totals?.blocks;
    } catch {
      // not JSON: no count
    }
    return {
      calls: proxy.total(),
      answerBytes: proxy.answerBytes(),
      resultBytes: blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text ?? ''), 0),
      blocks: total
    };
  };

  try {
    for (const [index, page] of pages.entries()) {
      console.log(`page ${index + 1} of ${pages.length}`);
      const rows = new Map<number, Sample>();
      for (const limit of LIMITS) {
        const sample = await one(page, limit);
        rows.set(limit, sample);
        console.log(`  top_concepts_limit ${String(limit).padEnd(2)} calls ${sample.calls}   logseq answer ${sample.answerBytes} B   result ${sample.resultBytes} B   blocks ${sample.blocks}`);
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
