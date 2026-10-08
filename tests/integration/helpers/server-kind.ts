import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Which server the integration suites exercise (#352), read from the environment. Kept apart from
 * `server-under-test.ts` so the global setup can use it without loading the test framework.
 */

export const SERVER_ENV = 'LOGSEQ_MCP_SERVER';
export const RUST_BINARY_ENV = 'LOGSEQ_MCP_RUST_BIN';
export const USAGE_ENV = 'LOGSEQ_MCP_SERVER_USAGE';

export type ServerKind = 'ts' | 'rust';

export function serverKind(env: NodeJS.ProcessEnv = process.env): ServerKind {
  const value = env[SERVER_ENV]?.trim().toLowerCase();
  if (!value || value === 'ts' || value === 'typescript') return 'ts';
  if (value === 'rust') return 'rust';
  throw new Error(`${SERVER_ENV} must be "ts" or "rust", got ${JSON.stringify(env[SERVER_ENV])}.`);
}

export const isRust = (): boolean => serverKind() === 'rust';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The Rust server binary: `LOGSEQ_MCP_RUST_BIN`, else the debug build in this checkout. */
export function rustBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  const named = env[RUST_BINARY_ENV]?.trim();
  return named || join(repoRoot, 'rust', 'target', 'debug', 'logseq-mcp-server');
}

/** Fails, with the build command, when Rust is selected and its binary is missing. */
export function requireRustBinary(): void {
  const binary = rustBinaryPath();
  if (!existsSync(binary)) {
    throw new Error(
      `${SERVER_ENV}=rust, but there is no server binary at ${binary}.\n` +
        `Build it with \`cd rust && cargo build\`, or name another with ${RUST_BINARY_ENV}.`
    );
  }
}

