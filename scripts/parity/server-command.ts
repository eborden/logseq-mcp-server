// The command that runs the Rust server, the harness's default (#124, #356), and the command that runs one of the
// stand-in servers in this folder. vite-node comes with vitest and runs the TypeScript file as it is (tsx is not
// a dependency), so no build is needed for the stand-ins.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerCommand } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root, where the server runs. */
export const REPO_ROOT = join(here, '..', '..');

/**
 * This checkout's debug build, `cd rust && cargo build`. Debug, because the harness fixes the clock with
 * `LOGSEQ_MCP_NOW` and a release build ignores it (rust/src/env.rs); the release binary is run with `--real-clock`.
 */
export const RUST_DEBUG_BINARY = join(REPO_ROOT, 'rust', 'target', 'debug', 'logseq-mcp-server');

/** A command that runs one of the TypeScript files in this folder from source. */
export function viteNodeCommand(file: string): ServerCommand {
  // #259: vite-node is a transitive dependency of vitest 3 that vitest 4 drops; move this launcher with it
  const viteNode = createRequire(import.meta.url).resolve('vite-node/vite-node.mjs');
  return { command: process.execPath, args: [viteNode, join(here, file)], cwd: REPO_ROOT };
}

/** The Rust server, the harness's default. */
export const rustServer = (): ServerCommand => ({ command: RUST_DEBUG_BINARY, args: [], cwd: REPO_ROOT });
