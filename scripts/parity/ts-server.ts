// The command that runs the TypeScript server from source, the harness's default and its
// reference (#124). vite-node comes with vitest and runs the source as it is (tsx is not a
// dependency), so no build is needed.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerCommand } from './harness.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root, where the server runs and the snapshot lives. */
export const REPO_ROOT = join(here, '..', '..');

export const SNAPSHOT_FILE = join(REPO_ROOT, 'src', '__snapshots__', 'tool-list.test.ts.snap');

export function typescriptServer(): ServerCommand {
  const viteNode = createRequire(import.meta.url).resolve('vite-node/vite-node.mjs');
  return { command: process.execPath, args: [viteNode, join(here, 'run-ts-server.ts')], cwd: REPO_ROOT };
}
