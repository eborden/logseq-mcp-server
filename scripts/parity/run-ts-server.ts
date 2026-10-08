// Starts the TypeScript server from source, for the parity harness (#124). src/index.ts runs
// main() only when it is the process's entry point, and under vite-node it isn't (argv[1] is
// vite-node itself), so this file calls it.
//
// It also honours LOGSEQ_MCP_NOW, the way the Rust server does (#311): the harness fixes the instant
// the tools read as "now", so a result that depends on today's date (`last_n`, a preset) is the same on
// every day. The server code is untouched. `Date` is replaced before it runs by a class that reads
// that instant when made with no arguments, and is the real `Date` for any other use.
import { main } from '../../src/index.js';

function fixNow(value: string): void {
  const now = Number(value);
  if (!Number.isSafeInteger(now)) throw new Error(`LOGSEQ_MCP_NOW must be a whole number of milliseconds, got ${JSON.stringify(value)}`);
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now);
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now(): number {
      return now;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
}

const fixed = process.env.LOGSEQ_MCP_NOW?.trim();
if (fixed) fixNow(fixed);

void main();
