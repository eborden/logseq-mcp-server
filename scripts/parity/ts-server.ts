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

/** A command that runs one of the TypeScript files in this folder from source. */
export function viteNodeCommand(file: string): ServerCommand {
  // #259: vite-node is a transitive dependency of vitest 3 that vitest 4 drops; move this launcher with it
  const viteNode = createRequire(import.meta.url).resolve('vite-node/vite-node.mjs');
  return { command: process.execPath, args: [viteNode, join(here, file)], cwd: REPO_ROOT };
}

/** The TypeScript server, the harness's reference. */
export const typescriptServer = (): ServerCommand => viteNodeCommand('run-ts-server.ts');
