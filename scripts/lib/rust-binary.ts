import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * The server the integration suites and the measure scripts exercise: the Rust server (`rust/`), the only one since the TypeScript
 * server was retired (#356). Kept apart from `server-under-test.ts` so the global setup can use it without
 * loading the test framework.
 */

export const RUST_BINARY_ENV = 'LOGSEQ_MCP_RUST_BIN';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Rust server binary: `LOGSEQ_MCP_RUST_BIN`, else the debug build in this checkout. */
export function rustBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[RUST_BINARY_ENV]?.trim();
  return named || join(repoRoot, 'rust', 'target', 'debug', 'logseq-mcp-server');
}

/** Fails, with the build command, when the Rust binary is missing. */
export function requireRustBinary(): void {
  const binary = rustBinaryPath();
  if (!existsSync(binary)) {
    throw new Error(
      `There is no server binary at ${binary}.\n` +
        `Build it with \`cd rust && cargo build\`, or name another with ${RUST_BINARY_ENV}.`
    );
  }
}
